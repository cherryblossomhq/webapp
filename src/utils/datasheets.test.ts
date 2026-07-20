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
  type DatasheetSummary,
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

const mocks = dependencies;
const auth = { token: "workos-token", url: "https://managed.test/chat" };
const cacheKey = (id: string) => `cherryblossom:datasheet:v2:${id}`;

function searchResponse(options: {
  lcscId: string;
  uuid?: string;
  datasheet?: string;
}) {
  return Response.json({
    result: {
      lists: {
        lcsc: [
          {
            uuid: options.uuid ?? "uuid-1",
            dataStr: {
              head: {
                c_para: {
                  "Supplier Part": options.lcscId,
                  ...(options.datasheet ? { Datasheet: options.datasheet } : {}),
                },
              },
            },
          },
        ],
      },
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  mocks.proxyFetch.mockReset();
  mocks.completeText.mockReset();
});

describe("datasheet summaries", () => {
  it("normalizes the LCSC id and returns a cached summary without network work", async () => {
    const cached: DatasheetSummary = {
      schema_version: 2,
      lcsc_id: "C123",
      mpn: "REG123",
      topology: "LDO",
      source_kind: "datasheet_pdf",
      evidence: [],
      summary_line: "LDO · V_in up to 5.5 V",
    };
    localStorage.setItem(cacheKey("C123"), JSON.stringify(cached));

    await expect(fetchAndSummarize(auth, "helper", " 123 ")).resolves.toEqual(
      cached
    );
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it("downloads a discovered PDF, parses model JSON, and caches the result", async () => {
    const sourceUrl = "https://datasheet.lcsc.com/szlcsc/REG123.pdf";
    mocks.proxyFetch
      .mockResolvedValueOnce(
        searchResponse({ lcscId: "C123", datasheet: sourceUrl })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/pdf" },
        })
      );
    mocks.completeText.mockResolvedValue(JSON.stringify({
      vin_min: "2.7 V",
      vin_max: "5.5 V",
      iout_max: "1 A",
      topology: "LDO",
      pinout: "1=IN, 2=GND, 3=OUT",
      gotchas: null,
      evidence: [
        { field: "vin_min", value: "2.7 V", page: 3, confidence: "high" },
        { field: "vin_max", value: "5.5 V", page: 3, confidence: "high" },
        { field: "iout_max", value: "1 A", page: 3, confidence: "high" },
        { field: "topology", value: "LDO", page: 1, confidence: "high" },
        { field: "pinout", value: "1=IN, 2=GND, 3=OUT", page: 2, confidence: "high" },
      ],
    }));

    const summary = await fetchAndSummarize(
      auth,
      "helper-model",
      "c123",
      "REG123",
      "trace-uuid"
    );

    expect(summary).toMatchObject({
      lcsc_id: "C123",
      mpn: "REG123",
      schema_version: 2,
      vin_min: "2.7 V",
      vin_max: "5.5 V",
      iout_max: "1 A",
      topology: "LDO",
      source_url: sourceUrl,
      source_kind: "datasheet_pdf",
      summary_line: "LDO · V_in 2.7 V–5.5 V · I_out ≤ 1 A",
    });
    const completionArgs = mocks.completeText.mock.calls[0][0];
    expect(completionArgs).toMatchObject({
      auth,
      model: "helper-model",
      maxTokens: 1800,
      traceId: "trace-uuid",
    });
    expect(completionArgs.messages[0].content[0]).toMatchObject({
      type: "file",
      file: {
        filename: "C123-datasheet.pdf",
        file_data: "data:application/pdf;base64,AQID",
      },
    });
    expect(JSON.parse(localStorage.getItem(cacheKey("C123"))!)).toEqual(summary);
  });

  it("uses the detail endpoint and returns an unverified identifier-only summary when the PDF fails", async () => {
    const sourceUrl = "https://datasheet.lcsc.com/detail.pdf";
    mocks.proxyFetch
      .mockResolvedValueOnce(searchResponse({ lcscId: "C456", uuid: "detail-1" }))
      .mockResolvedValueOnce(
        Response.json({
          result: {
            dataStr: { head: { c_para: { Datasheet: sourceUrl } } },
          },
        })
      )
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    const summary = await fetchAndSummarize(auth, "helper", "C456");

    expect(mocks.proxyFetch.mock.calls[1][0]).toContain(
      "/api/components/detail-1?"
    );
    expect(summary).toMatchObject({
      schema_version: 2,
      lcsc_id: "C456",
      source_url: sourceUrl,
      source_kind: "identifier_only",
      evidence: [],
      summary_line: "datasheet unavailable; electrical limits are unverified",
    });
    expect(summary.topology).toBeUndefined();
    expect(mocks.completeText).not.toHaveBeenCalled();
  });

  it("surfaces malformed helper output and does not poison the cache", async () => {
    const sourceUrl = "https://datasheet.lcsc.com/bad-helper.pdf";
    mocks.proxyFetch
      .mockResolvedValueOnce(
        searchResponse({ lcscId: "C789", datasheet: sourceUrl })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/pdf" },
        })
      );
    mocks.completeText.mockResolvedValue("No structured result available");

    await expect(fetchAndSummarize(auth, "helper", "C789")).rejects.toThrow(
      "Datasheet helper returned no JSON object"
    );
    expect(localStorage.getItem(cacheKey("C789"))).toBeNull();
  });

  it("renders model context and matches cached parts by LCSC id or MPN", () => {
    const summary: DatasheetSummary = {
      schema_version: 2,
      lcsc_id: "C123",
      mpn: "REG123",
      topology: "buck",
      vin_max: "24 V",
      gotchas: "Requires an inductor",
      source_url: "https://lcsc.com/reg123.pdf",
      source_kind: "datasheet_pdf",
      evidence: [
        { field: "topology", value: "buck", page: 1, confidence: "high" },
        { field: "vin_max", value: "24 V", page: 3, confidence: "high" },
        { field: "gotchas", value: "Requires an inductor", page: 5, confidence: "medium" },
      ],
      summary_line: "buck · V_in up to 24 V",
    };
    localStorage.setItem(cacheKey("C123"), JSON.stringify(summary));
    localStorage.setItem(cacheKey("BROKEN"), "not json");

    expect(listCachedDatasheets(["C123", "U_REG123", "OTHER"])).toEqual([
      expect.objectContaining({ name: "C123", summary: summary.summary_line }),
      expect.objectContaining({ name: "U_REG123", summary: summary.summary_line }),
    ]);
    expect(renderForModel(summary)).toContain("- Gotchas: Requires an inductor");
    expect(renderForModel(summary)).toContain("Source: https://lcsc.com/reg123.pdf");
  });
});
