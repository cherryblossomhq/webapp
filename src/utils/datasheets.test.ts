import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  completeText: vi.fn(),
  proxyFetch: vi.fn(),
}));

vi.mock("./chatTransport", () => ({
  completeText: dependencies.completeText,
}));

vi.mock("./proxy-fetch", () => ({
  proxyFetch: dependencies.proxyFetch,
}));

import {
  fetchAndSummarize,
  listCachedDatasheets,
  parseDatasheetExtraction,
  renderForModel,
} from "./datasheets";

const GROUNDED_JSON = JSON.stringify({
  vin_min: "2.7 V",
  vin_max: "5.5 V",
  iout_max: "1 A",
  topology: "linear charger",
  pinout: "1 TEMP, 2 PROG, 3 GND",
  key_features: "Programmable charge current",
  typical_apps: "Single-cell Li-ion charging",
  gotchas: "Requires thermal layout care",
  evidence: [
    {
      field: "vin_min",
      value: "2.7 V",
      page: 3,
      section: "Recommended operating conditions",
      confidence: "high",
    },
    {
      field: "vin_max",
      value: "5.5 V",
      page: 3,
      section: "Recommended operating conditions",
      confidence: "high",
    },
    {
      field: "topology",
      value: "linear charger",
      page: 1,
      section: "Features",
      confidence: "medium",
    },
    {
      field: "pinout",
      value: "1 TEMP, 2 PROG, 3 GND",
      page: 2,
      confidence: "high",
    },
  ],
});

describe("datasheet evidence", () => {
  beforeEach(() => {
    localStorage.clear();
    dependencies.completeText.mockReset();
    dependencies.proxyFetch.mockReset();
  });

  it("uses the plan-compatible extraction model supplied by the chat loop", async () => {
    const auth = {
      token: "workos-token",
      url: "https://example.test/api/v1/chat/completions",
    };
    const model = "anthropic/claude-haiku-4.5";
    dependencies.proxyFetch
      .mockResolvedValueOnce(
        Response.json({
          result: {
            lists: {
              lcsc: [
                {
                  uuid: "part-uuid",
                  dataStr: {
                    head: {
                      c_para: {
                        "Supplier Part": "C16581",
                        Datasheet: "https://datasheet.lcsc.com/tp4056.pdf",
                      },
                    },
                  },
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      );
    dependencies.completeText.mockResolvedValue(GROUNDED_JSON);

    await fetchAndSummarize(auth, model, "C16581", "TP4056");

    expect(dependencies.completeText).toHaveBeenCalledWith(
      expect.objectContaining({ auth, model })
    );
  });

  it("keeps only fields backed by valid document evidence", () => {
    const summary = parseDatasheetExtraction(
      `Here is the result: ${GROUNDED_JSON}`,
      "C16581",
      "TP4056",
      "datasheet_pdf"
    );
    expect(summary).toMatchObject({
      schema_version: 2,
      vin_min: "2.7 V",
      vin_max: "5.5 V",
      topology: "linear charger",
      pinout: "1 TEMP, 2 PROG, 3 GND",
      source_kind: "datasheet_pdf",
    });
    expect(summary.iout_max).toBeUndefined();
    expect(summary.gotchas).toBeUndefined();
    expect(summary.evidence).toHaveLength(4);
  });

  it("rejects a claim when same-field evidence contradicts its value", () => {
    const summary = parseDatasheetExtraction(
      JSON.stringify({
        vin_max: "5.5 V",
        topology: "linear charger",
        evidence: [
          {
            field: "vin_max",
            value: "12 V",
            page: 3,
            confidence: "high",
          },
          {
            field: "topology",
            value: "switching regulator",
            page: 1,
            confidence: "high",
          },
        ],
      }),
      "C16581",
      "TP4056",
      "datasheet_pdf"
    );

    expect(summary.vin_max).toBeUndefined();
    expect(summary.topology).toBeUndefined();
    expect(summary.summary_line).toBe("datasheet summary cached");
  });

  it("retains the cited evidence value when normalized values agree", () => {
    const summary = parseDatasheetExtraction(
      JSON.stringify({
        vin_max: " 5.5V ",
        topology: "LINEAR   CHARGER",
        evidence: [
          {
            field: "vin_max",
            value: "5.5 V",
            page: 3,
            confidence: "high",
          },
          {
            field: "topology",
            value: "linear charger",
            section: "Features",
            confidence: "medium",
          },
        ],
      }),
      "C16581",
      "TP4056",
      "datasheet_pdf"
    );

    expect(summary.vin_max).toBe("5.5 V");
    expect(summary.topology).toBe("linear charger");
    expect(summary.summary_line).toBe("linear charger · V_in up to 5.5 V");
  });

  it("discards every claimed specification when no PDF was available", () => {
    const summary = parseDatasheetExtraction(
      GROUNDED_JSON,
      "C16581",
      "TP4056",
      "identifier_only"
    );
    expect(summary.vin_min).toBeUndefined();
    expect(summary.pinout).toBeUndefined();
    expect(summary.evidence).toEqual([]);
    expect(summary.summary_line).toBe("datasheet summary cached");
  });

  it("rejects malformed model output", () => {
    expect(() =>
      parseDatasheetExtraction("not json", "C1", undefined, "datasheet_pdf")
    ).toThrow(/no JSON object/);
  });

  it("renders evidence locations and confidence for the design model", () => {
    const summary = parseDatasheetExtraction(
      GROUNDED_JSON,
      "C16581",
      "TP4056",
      "datasheet_pdf"
    );
    summary.source_url = "https://example.com/tp4056.pdf";
    const rendered = renderForModel(summary);
    expect(rendered).toContain("Evidence:");
    expect(rendered).toContain("vin_max: 5.5 V (p. 3, Recommended operating conditions; high confidence)");
    expect(rendered).toContain("Source: https://example.com/tp4056.pdf");
  });

  it("surfaces cached evidence in dynamic-context summaries", () => {
    const summary = parseDatasheetExtraction(
      GROUNDED_JSON,
      "C16581",
      "TP4056",
      "datasheet_pdf"
    );
    summary.source_url = "https://example.com/tp4056.pdf";
    localStorage.setItem(
      "cherryblossom:datasheet:v2:C16581",
      JSON.stringify(summary)
    );
    expect(listCachedDatasheets(["TP4056"])).toEqual([
      expect.objectContaining({
        name: "TP4056",
        sourceUrl: "https://example.com/tp4056.pdf",
        evidence: expect.arrayContaining([
          expect.stringContaining("vin_max=5.5 V (p. 3"),
        ]),
      }),
    ]);
  });
});
