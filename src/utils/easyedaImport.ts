import { proxyFetch } from "./proxy-fetch";

type EasyedaModule = {
  convertRawEasyEdaToTs?: (args: { rawEasy: unknown }) => Promise<string>;
  convertRawEasyToTsx?: (args: { rawEasy: unknown }) => Promise<string>;
};

let easyedaPromise: Promise<EasyedaModule> | null = null;

async function loadEasyeda(): Promise<EasyedaModule> {
  if (easyedaPromise) return easyedaPromise;
  easyedaPromise = (async () => {
    try {
      return (await import("easyeda")) as unknown as EasyedaModule;
    } catch (err) {
      easyedaPromise = null;
      throw err;
    }
  })();
  return easyedaPromise;
}

// easyeda.com doesn't send CORS headers, so both calls go through the
// same-origin /api/proxy endpoint (see proxy-fetch.ts).
async function fetchEasyEDAComponentViaProxy(lcscId: string): Promise<unknown> {
  const searchResp = await proxyFetch("https://easyeda.com/api/components/search", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
    },
    body:
      `type=3&doctype%5B%5D=2&uid=0819f05c4eef4c71ace90d822a990e87` +
      `&returnListStyle=classifyarr&wd=${encodeURIComponent(lcscId)}&version=6.4.7`,
  });
  if (!searchResp.ok)
    throw new Error(`EasyEDA search failed (${searchResp.status})`);

  type SearchResult = {
    success?: boolean;
    result?: {
      lists?: {
        lcsc?: Array<{
          uuid: string;
          dataStr?: { head?: { c_para?: Record<string, string> } };
        }>;
      };
    };
  };
  const parsed = (await searchResp.json()) as SearchResult;
  const lcscList = parsed.result?.lists?.lcsc ?? [];
  if (!parsed.success || lcscList.length === 0)
    throw new Error(`Component ${lcscId} not found on EasyEDA`);

  const bestMatch =
    lcscList.find((c) => c.dataStr?.head?.c_para?.["Supplier Part"] === lcscId) ??
    lcscList[0];

  const compResp = await proxyFetch(
    `https://easyeda.com/api/components/${bestMatch.uuid}?version=6.4.7&uuid=${bestMatch.uuid}&datastrid=`,
    {
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
      },
    }
  );
  if (!compResp.ok)
    throw new Error(`EasyEDA component fetch failed (${compResp.status})`);

  const compResult = (await compResp.json()) as { result?: unknown };
  if (!compResult.result) throw new Error("EasyEDA component response was empty");
  return compResult.result;
}

export interface ComponentDefResult {
  componentName: string;
  lcscId: string;
  rawTsx: string;
}

export async function fetchComponentDef(lcscId: string): Promise<ComponentDefResult> {
  const [easyeda, rawComponent] = await Promise.all([
    loadEasyeda(),
    fetchEasyEDAComponentViaProxy(lcscId),
  ]);

  const tsxConvert = easyeda.convertRawEasyEdaToTs ?? easyeda.convertRawEasyToTsx;
  if (!tsxConvert) throw new Error("EasyEDA converter function not found");

  const rawTsx = await tsxConvert({ rawEasy: rawComponent });
  const nameMatch = rawTsx.match(/export\s+const\s+(\w+)\s*=/);
  const componentName = nameMatch?.[1] ?? lcscId.replace(/^C/, "C_");

  return { componentName, lcscId, rawTsx };
}
