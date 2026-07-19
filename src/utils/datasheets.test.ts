import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  completeText: vi.fn(),
}));

vi.mock("./proxy-fetch", () => ({ proxyFetch: mocks.proxyFetch }));
vi.mock("./chatTransport", () => ({ completeText: mocks.completeText }));

import {
  fetchAndSummarize,
  listCachedDatasheets,
  renderForModel,
  type DatasheetSummary,
} from "./datasheets";

const auth = { token: "workos-token", url: "https://managed.test/chat" };
const cacheKey = (id: string) => `cherryblossom:datasheet:${id}`;

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

afterEach(() => {
  localStorage.clear();
  mocks.proxyFetch.mockReset();
  mocks.completeText.mockReset();
});

describe("datasheet summaries", () => {
  it("normalizes the LCSC id and returns a cached summary without network work", async () => {
    const cached: DatasheetSummary = {
      lcsc_id: "C123",
      mpn: "REG123",
      topology: "LDO",
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
    mocks.completeText.mockResolvedValue(
      'Here is the result: {"vin_min":"2.7 V","vin_max":"5.5 V","iout_max":"1 A","topology":"LDO","pinout":"1=IN, 2=GND, 3=OUT","gotchas":null}'
    );

    const summary = await fetchAndSummarize(auth, "helper-model", "c123", "REG123");

    expect(summary).toMatchObject({
      lcsc_id: "C123",
      mpn: "REG123",
      vin_min: "2.7 V",
      vin_max: "5.5 V",
      iout_max: "1 A",
      topology: "LDO",
      source_url: sourceUrl,
      summary_line: "LDO · V_in 2.7 V–5.5 V · I_out ≤ 1 A",
    });
    const completionArgs = mocks.completeText.mock.calls[0][0];
    expect(completionArgs).toMatchObject({
      auth,
      model: "helper-model",
      maxTokens: 1024,
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

  it("uses the detail endpoint and falls back to metadata-only extraction when the PDF fails", async () => {
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
    mocks.completeText.mockResolvedValue('{"topology":"temperature sensor"}');

    const summary = await fetchAndSummarize(auth, "helper", "C456");

    expect(mocks.proxyFetch.mock.calls[1][0]).toContain(
      "/api/components/detail-1?"
    );
    expect(summary).toMatchObject({
      lcsc_id: "C456",
      topology: "temperature sensor",
      source_url: sourceUrl,
    });
    const content = mocks.completeText.mock.calls[0][0].messages[0].content;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text" });
  });

  it("surfaces malformed helper output and does not poison the cache", async () => {
    mocks.proxyFetch.mockRejectedValue(new Error("EasyEDA offline"));
    mocks.completeText.mockResolvedValue("No structured result available");

    await expect(fetchAndSummarize(auth, "helper", "C789")).rejects.toThrow(
      "Datasheet helper returned no JSON object"
    );
    expect(localStorage.getItem(cacheKey("C789"))).toBeNull();
  });

  it("renders model context and matches cached parts by LCSC id or MPN", () => {
    const summary: DatasheetSummary = {
      lcsc_id: "C123",
      mpn: "REG123",
      topology: "buck",
      vin_max: "24 V",
      gotchas: "Requires an inductor",
      source_url: "https://lcsc.com/reg123.pdf",
      summary_line: "buck · V_in up to 24 V",
    };
    localStorage.setItem(cacheKey("C123"), JSON.stringify(summary));
    localStorage.setItem(cacheKey("BROKEN"), "not json");

    expect(listCachedDatasheets(["C123", "U_REG123", "OTHER"])).toEqual([
      { name: "C123", summary: summary.summary_line },
      { name: "U_REG123", summary: summary.summary_line },
    ]);
    expect(renderForModel(summary)).toContain("- Gotchas: Requires an inductor");
    expect(renderForModel(summary)).toContain("Source: https://lcsc.com/reg123.pdf");
  });
});
