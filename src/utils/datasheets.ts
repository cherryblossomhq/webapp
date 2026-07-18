// Datasheet fetch + extraction. Hits EasyEDA to find the canonical datasheet
// URL for a JLCPCB part, downloads the PDF, then asks a plan-safe helper model
// to extract the structured fields the design AI actually cares about (V_in
// range, output current, topology, pinout, key features, gotchas).
//
// EasyEDA and the LCSC datasheet CDNs don't send CORS headers, so both fetches
// go through the same-origin `/api/proxy` endpoint (see proxy-fetch.ts). A PDF
// whose host falls outside the proxy allowlist simply fails the download and
// we return an explicitly unverified summary rather than guessing from the part
// number.
//
// Summaries are cached in localStorage so we only invoke the helper once per
// part — subsequent calls just read the JSON. The summary is also surfaced to
// the main chat model via listCachedDatasheets → buildDynamicContext.

import { proxyFetch } from "./proxy-fetch";
import { completeText, type OpenRouterAuth } from "./chatTransport";

const MAX_PDF_BYTES = 12 * 1024 * 1024; // 12 MiB hard cap
const CACHE_PREFIX = "cherryblossom:datasheet:v2:";

export type DatasheetEvidenceConfidence = "high" | "medium" | "low";
export type DatasheetSourceKind = "datasheet_pdf" | "identifier_only";

export interface DatasheetEvidence {
  field: string;
  value: string;
  page?: number;
  section?: string;
  confidence: DatasheetEvidenceConfidence;
}

export interface DatasheetSummary {
  schema_version: 2;
  lcsc_id: string;
  mpn?: string;
  vin_min?: string;
  vin_max?: string;
  iout_max?: string;
  topology?: string;
  pinout?: string;
  key_features?: string;
  typical_apps?: string;
  gotchas?: string;
  source_url?: string;
  source_kind: DatasheetSourceKind;
  evidence: DatasheetEvidence[];
  /** One-line condensation suitable for the design AI's dynamic context. */
  summary_line: string;
}

export interface NamedSummary {
  name: string;
  summary: string;
  evidence?: string[];
  sourceUrl?: string;
}

function normalizeLcsc(raw: string): string {
  const trimmed = raw.trim();
  return /^c/i.test(trimmed) ? trimmed.toUpperCase() : `C${trimmed}`;
}

function readCache(lcscId: string): DatasheetSummary | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + lcscId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DatasheetSummary;
    return parsed.schema_version === 2 &&
      typeof parsed.summary_line === "string" &&
      Array.isArray(parsed.evidence)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeCache(summary: DatasheetSummary): void {
  try {
    localStorage.setItem(CACHE_PREFIX + summary.lcsc_id, JSON.stringify(summary));
  } catch {
    // Quota/security errors just mean no cache — the summary still returns.
  }
}

// Hits EasyEDA search (through the proxy), returns the datasheet URL from
// c_para if present, falling back to the per-part detail endpoint.
async function findDatasheetUrl(lcscId: string): Promise<string | null> {
  const searchBody =
    "type=3&doctype%5B%5D=2&uid=0819f05c4eef4c71ace90d822a990e87" +
    `&returnListStyle=classifyarr&wd=${encodeURIComponent(lcscId)}&version=6.4.7`;
  const search = await proxyFetch("https://easyeda.com/api/components/search", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
    },
    body: searchBody,
  });
  if (!search.ok) throw new Error(`EasyEDA search HTTP ${search.status}`);

  type SearchEntry = {
    uuid?: string;
    dataStr?: { head?: { c_para?: Record<string, string> } };
  };
  const searchJson = (await search.json()) as {
    result?: { lists?: { lcsc?: SearchEntry[] } };
  };
  const list = searchJson.result?.lists?.lcsc ?? [];
  if (list.length === 0) throw new Error(`EasyEDA: no results for ${lcscId}`);

  // Prefer the entry whose Supplier Part matches exactly; fall back to first.
  const best =
    list.find((c) => c.dataStr?.head?.c_para?.["Supplier Part"] === lcscId) ??
    list[0];
  const uuid = best.uuid;
  if (!uuid) throw new Error("EasyEDA: missing uuid");
  const direct = best.dataStr?.head?.c_para?.["Datasheet"];
  if (direct) return direct;

  // The search hit didn't carry a Datasheet — sometimes only the per-part
  // detail endpoint has it.
  const detail = await proxyFetch(
    `https://easyeda.com/api/components/${uuid}?version=6.4.7&uuid=${uuid}&datastrid=`,
    {
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
      },
    }
  );
  if (!detail.ok) return null;
  try {
    const detailJson = (await detail.json()) as {
      result?: { dataStr?: { head?: { c_para?: Record<string, string> } } };
    };
    return detailJson.result?.dataStr?.head?.c_para?.["Datasheet"] ?? null;
  } catch {
    return null;
  }
}

async function downloadPdf(url: string): Promise<Uint8Array | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const resp = await proxyFetch(url, {
      headers: { accept: "application/pdf,*/*" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked btoa: String.fromCharCode(...bytes) overflows the arg limit on
  // multi-megabyte PDFs.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function extractViaModel(
  auth: OpenRouterAuth,
  model: string,
  pdfBytes: Uint8Array,
  lcscId: string,
  mpn?: string
): Promise<DatasheetSummary> {
  const extractionPrompt =
    `Extract a structured summary of the datasheet for JLCPCB part ${lcscId} ` +
    `(manufacturer part: ${mpn ?? "unknown"}). ` +
    "Return ONLY a JSON object with these string fields (use null when truly unknown):\n" +
    "{\n" +
    '  "vin_min": "e.g. \'2.7 V\'",\n' +
    '  "vin_max": "e.g. \'5.5 V\'",\n' +
    '  "iout_max": "e.g. \'1 A\'",\n' +
    '  "topology": "e.g. \'linear LDO\', \'synchronous buck\', \'op-amp\', \'gate driver\'",\n' +
    '  "pinout": "compact pin map, one line per pin",\n' +
    '  "key_features": "3-5 bullet points",\n' +
    '  "typical_apps": "one short sentence",\n' +
    '  "gotchas": "any non-obvious application caveats (e.g. needs bootstrap cap, max V_in absolute, polarity)",\n' +
    '  "evidence": [{ "field": "vin_max", "value": "5.5 V", "page": 3, "section": "Recommended operating conditions", "confidence": "high" }]\n' +
    "}\n" +
    "If the datasheet contradicts the JLCPCB metadata, trust the datasheet.\n" +
    "Every non-null field MUST have at least one matching evidence item. Page is the printed PDF page when visible; otherwise omit it and include the section. " +
    "A datasheet PDF is attached. Ground every claim in that document.\n" +
    "Do NOT include markdown fences or commentary — JSON only.";

  const content: unknown[] = [{
    type: "file",
    file: {
      filename: `${lcscId}-datasheet.pdf`,
      file_data: `data:application/pdf;base64,${bytesToBase64(pdfBytes)}`,
    },
  }];
  content.push({ type: "text", text: extractionPrompt });

  const answer = await completeText({
    auth,
    model,
    maxTokens: 1800,
    messages: [{ role: "user", content }],
  });
  if (!answer) throw new Error("Datasheet helper returned no text");
  return parseDatasheetExtraction(
    answer,
    lcscId,
    mpn,
    "datasheet_pdf"
  );
}

function unavailableSummary(lcscId: string, mpn?: string): DatasheetSummary {
  return {
    schema_version: 2,
    lcsc_id: lcscId,
    mpn,
    source_kind: "identifier_only",
    evidence: [],
    summary_line: "datasheet unavailable; electrical limits are unverified",
  };
}

const EVIDENCE_FIELDS = new Set([
  "vin_min",
  "vin_max",
  "iout_max",
  "topology",
  "pinout",
  "key_features",
  "typical_apps",
  "gotchas",
]);

export function parseDatasheetExtraction(
  answer: string,
  lcscId: string,
  mpn: string | undefined,
  sourceKind: DatasheetSourceKind
): DatasheetSummary {

  // Models sometimes add a leading "Here's the JSON:" preamble despite the
  // instruction. Slice from the first { to the last }.
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Datasheet helper returned no JSON object -- raw: ${answer}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `Datasheet helper JSON parse failed: ${e} -- raw: ${answer}`,
      { cause: e },
    );
  }

  const s = (key: string): string | undefined => {
    const v = parsed[key];
    return typeof v === "string" && v !== "" && v !== "null" ? v : undefined;
  };

  const evidence: DatasheetEvidence[] = [];
  if (sourceKind === "datasheet_pdf" && Array.isArray(parsed.evidence)) {
    for (const item of parsed.evidence) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const field = typeof record.field === "string" ? record.field.trim() : "";
      const value = typeof record.value === "string" ? record.value.trim() : "";
      const confidence = record.confidence;
      if (
        !EVIDENCE_FIELDS.has(field) ||
        !value ||
        (confidence !== "high" && confidence !== "medium" && confidence !== "low")
      ) {
        continue;
      }
      const page =
        typeof record.page === "number" &&
        Number.isInteger(record.page) &&
        record.page > 0
          ? record.page
          : undefined;
      const section =
        typeof record.section === "string" && record.section.trim()
          ? record.section.trim()
          : undefined;
      if (page === undefined && section === undefined) continue;
      evidence.push({ field, value, page, section, confidence });
    }
  }

  const grounded = (key: string): string | undefined =>
    evidence.some((item) => item.field === key) ? s(key) : undefined;

  const topology = grounded("topology");
  const vinMin = grounded("vin_min");
  const vinMax = grounded("vin_max");
  const ioutMax = grounded("iout_max");

  return {
    schema_version: 2,
    lcsc_id: lcscId,
    mpn,
    vin_min: vinMin,
    vin_max: vinMax,
    iout_max: ioutMax,
    topology,
    pinout: grounded("pinout"),
    key_features: grounded("key_features"),
    typical_apps: grounded("typical_apps"),
    gotchas: grounded("gotchas"),
    source_kind: sourceKind,
    evidence,
    summary_line: buildSummaryLine(topology, vinMin, vinMax, ioutMax),
  };
}

function buildSummaryLine(
  topology?: string,
  vinMin?: string,
  vinMax?: string,
  ioutMax?: string
): string {
  const parts: string[] = [];
  if (topology) parts.push(topology);
  if (vinMin && vinMax) parts.push(`V_in ${vinMin}–${vinMax}`);
  else if (vinMax) parts.push(`V_in up to ${vinMax}`);
  if (ioutMax) parts.push(`I_out ≤ ${ioutMax}`);
  return parts.length === 0 ? "datasheet summary cached" : parts.join(" · ");
}

export function renderForModel(summary: DatasheetSummary): string {
  let out = `Datasheet summary for ${summary.lcsc_id}`;
  if (summary.mpn) out += ` (${summary.mpn})`;
  out += ":\n";
  const pairs: Array<[string, string | undefined]> = [
    ["Topology", summary.topology],
    ["V_in min", summary.vin_min],
    ["V_in max", summary.vin_max],
    ["I_out max", summary.iout_max],
    ["Pinout", summary.pinout],
    ["Key features", summary.key_features],
    ["Typical apps", summary.typical_apps],
    ["Gotchas", summary.gotchas],
  ];
  for (const [label, val] of pairs) {
    if (val) out += `- ${label}: ${val}\n`;
  }
  if (summary.evidence.length > 0) {
    out += "Evidence:\n";
    for (const evidence of summary.evidence) {
      const location = [
        evidence.page ? `p. ${evidence.page}` : "",
        evidence.section ?? "",
      ].filter(Boolean).join(", ");
      out += `- ${evidence.field}: ${evidence.value} (${location}; ${evidence.confidence} confidence)\n`;
    }
  } else {
    out += "Evidence: unavailable; do not treat unspecified limits as verified.\n";
  }
  if (summary.source_url) out += `Source: ${summary.source_url}\n`;
  return out;
}

export async function fetchAndSummarize(
  auth: OpenRouterAuth,
  model: string,
  lcscIdRaw: string,
  mpn?: string
): Promise<DatasheetSummary> {
  const lcscId = normalizeLcsc(lcscIdRaw);

  const cached = readCache(lcscId);
  if (cached) return cached;

  // Discover the datasheet URL. Failure here is non-fatal, but the identifier-
  // only fallback is forbidden from inventing electrical specifications.
  let datasheetUrl: string | null = null;
  try {
    datasheetUrl = await findDatasheetUrl(lcscId);
  } catch {
    // No datasheet URL — the identifier-only path below still returns safely.
  }

  const pdfBytes = datasheetUrl ? await downloadPdf(datasheetUrl) : null;

  const summary = pdfBytes
    ? await extractViaModel(auth, model, pdfBytes, lcscId, mpn)
    : unavailableSummary(lcscId, mpn);
  summary.source_url = datasheetUrl ?? undefined;

  writeCache(summary);
  return summary;
}

// Component-name -> LCSC ID lookup is not stored anywhere durable. The
// front-end either passes the LCSC ID alongside each name, or treats the name
// itself as the lookup key. Scan the cache and return matches by either
// dimension (name contains/equals the mpn, or equals the LCSC ID).
export function listCachedDatasheets(names: string[]): NamedSummary[] {
  const summaries: DatasheetSummary[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(CACHE_PREFIX)) continue;
      const summary = readCache(key.slice(CACHE_PREFIX.length));
      if (summary) summaries.push(summary);
    }
  } catch {
    return [];
  }

  const out: NamedSummary[] = [];
  for (const name of names) {
    const upper = name.toUpperCase();
    for (const s of summaries) {
      const mpnUpper = s.mpn?.toUpperCase();
      const matchesMpn =
        !!mpnUpper && (upper.includes(mpnUpper) || mpnUpper.includes(upper));
      const matchesLcsc = upper === s.lcsc_id.toUpperCase();
      if (matchesMpn || matchesLcsc) {
        out.push({
          name,
          summary: s.summary_line,
          evidence: s.evidence.slice(0, 6).map((item) => {
            const location = [
              item.page ? `p. ${item.page}` : "",
              item.section ?? "",
            ].filter(Boolean).join(", ");
            return `${item.field}=${item.value} (${location}, ${item.confidence})`;
          }),
          sourceUrl: s.source_url,
        });
        break;
      }
    }
  }
  return out;
}
