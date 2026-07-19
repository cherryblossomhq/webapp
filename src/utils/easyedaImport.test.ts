import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  convert: vi.fn(),
}));

vi.mock("./proxy-fetch", () => ({ proxyFetch: mocks.proxyFetch }));
vi.mock("easyeda", () => ({ convertRawEasyEdaToTs: mocks.convert }));

import { fetchComponentDef } from "./easyedaImport";

function searchResponse(
  entries: Array<{ uuid: string; supplierPart?: string }>,
  success = true
) {
  return Response.json({
    success,
    result: {
      lists: {
        lcsc: entries.map(({ uuid, supplierPart }) => ({
          uuid,
          dataStr: {
            head: {
              c_para: supplierPart ? { "Supplier Part": supplierPart } : {},
            },
          },
        })),
      },
    },
  });
}

afterEach(() => {
  mocks.proxyFetch.mockReset();
  mocks.convert.mockReset();
});

describe("fetchComponentDef", () => {
  it("selects the exact LCSC search hit and converts its detail payload", async () => {
    const rawComponent = { uuid: "right", shape: "raw-easyeda" };
    mocks.proxyFetch
      .mockResolvedValueOnce(
        searchResponse([
          { uuid: "wrong", supplierPart: "C999" },
          { uuid: "right", supplierPart: "C123" },
        ])
      )
      .mockResolvedValueOnce(Response.json({ result: rawComponent }));
    mocks.convert.mockResolvedValue(
      "export const ExactPart = (props) => <chip {...props} />"
    );

    await expect(fetchComponentDef("C123")).resolves.toEqual({
      componentName: "ExactPart",
      lcscId: "C123",
      rawTsx: "export const ExactPart = (props) => <chip {...props} />",
    });
    expect(mocks.proxyFetch.mock.calls[1][0]).toContain(
      "/api/components/right?"
    );
    expect(mocks.convert).toHaveBeenCalledWith({ rawEasy: rawComponent });
  });

  it("falls back to the first search hit and a deterministic component name", async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce(searchResponse([{ uuid: "first" }]))
      .mockResolvedValueOnce(Response.json({ result: { uuid: "first" } }));
    mocks.convert.mockResolvedValue("const anonymous = <chip />");

    await expect(fetchComponentDef("C456")).resolves.toMatchObject({
      componentName: "C_456",
      lcscId: "C456",
    });
  });

  it("reports search transport and not-found failures", async () => {
    mocks.proxyFetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(fetchComponentDef("C1")).rejects.toThrow(
      "EasyEDA search failed (503)"
    );

    mocks.proxyFetch.mockResolvedValueOnce(searchResponse([], false));
    await expect(fetchComponentDef("C2")).rejects.toThrow(
      "Component C2 not found on EasyEDA"
    );
  });

  it("rejects a failed or empty component detail response", async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce(searchResponse([{ uuid: "one" }]))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(fetchComponentDef("C3")).rejects.toThrow(
      "EasyEDA component fetch failed (404)"
    );

    mocks.proxyFetch
      .mockResolvedValueOnce(searchResponse([{ uuid: "two" }]))
      .mockResolvedValueOnce(Response.json({}));
    await expect(fetchComponentDef("C4")).rejects.toThrow(
      "EasyEDA component response was empty"
    );
  });
});
