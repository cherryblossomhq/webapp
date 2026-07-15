// ─── Chat transport ──────────────────────────────────────────────────────────
//
// Single swappable seam for every external call the chat loop makes. Each is a
// plain browser fetch: Anthropic's API allows direct browser calls when the
// `anthropic-dangerous-direct-browser-access` header is set (the key is the
// user's own, entered in Settings), the managed proxy is CORS-enabled, and
// jlcsearch.tscircuit.com serves `access-control-allow-origin: *`. The
// `ChatAuth` passed with every model call picks the upstream: the user's own
// Anthropic key, or the managed proxy with their account's access token. Keep
// all chat HTTP in this file.

import { fetchAndSummarize, renderForModel } from "./datasheets";

// Credential + routing for one Claude Messages call. `apiKey` goes straight to
// api.anthropic.com with the user's own key; `managed` routes through Cherry
// Blossom's proxy at `url`, authenticated by the signed-in user's WorkOS
// access token.
export type ChatAuth =
  | { kind: "apiKey"; key: string }
  | { kind: "managed"; token: string; url: string };

// Managed proxy endpoint, baked in at build time (env supplies it: dev → a
// local website checkout, prd → production). The fallback must be the
// canonical `www` host: the apex 308-redirects to it, and fetch drops the
// Authorization header on cross-origin redirects, turning every call into a 401.
export const MANAGED_MESSAGES_URL: string =
  import.meta.env.VITE_MANAGED_AI_URL ??
  "https://www.trycherryblossom.com/api/v1/messages";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/**
 * POST a Messages-API body, routed and authenticated per auth mode. Shared by
 * the streaming design loop below and the non-streaming Haiku datasheet
 * extraction in datasheets.ts.
 */
export function messagesPost(
  auth: ChatAuth,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  let url: string;
  if (auth.kind === "apiKey") {
    url = ANTHROPIC_MESSAGES_URL;
    headers["x-api-key"] = auth.key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
    // Required for Anthropic to serve CORS headers to a browser origin.
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    url = auth.url;
    headers["authorization"] = `Bearer ${auth.token}`;
  }
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

// One assistant turn returned by `streamTurn`. `thinkingBlocks` are opaque
// `{type:"thinking"|"redacted_thinking", …}` objects (carrying signatures) that
// MUST be replayed verbatim at the head of the next assistant message, or the
// API rejects the following turn.
export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatTurnResult {
  text: string;
  toolCalls: ChatToolCall[];
  thinkingBlocks: unknown[];
  stopReason: string;
}

export interface StreamTurnArgs {
  auth: ChatAuth;
  model: string;
  /** Already-shaped system blocks (caller owns the `cache_control` breakpoint). */
  system: unknown[];
  /** Already-shaped messages array (strings or content-block arrays). */
  messages: unknown[];
  /** Tool definitions; omit / empty to force a tool-free turn. */
  tools?: unknown[];
  /** Adaptive-thinking effort (e.g. "high"); omit to disable thinking. */
  thinkingEffort?: string;
}

export interface StreamCallbacks {
  /** Live assistant text deltas, in order. */
  onText?: (delta: string) => void;
  /** Live thinking-summary deltas, in order. */
  onThinking?: (delta: string) => void;
}

// Internal per-block accumulators while streaming, keyed by block index.
// `input` is the raw JSON text assembled from partial_json deltas.
interface ToolCallAccum {
  id: string;
  name: string;
  input: string;
}

type SseEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; data?: string };
  delta?: {
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  error?: { message?: string };
};

/**
 * Stream a single model turn. Live text/thinking reach the UI through the
 * callbacks; the promise resolves with the assembled turn (text, tool calls,
 * thinking blocks, stop reason). The multi-turn loop lives in the caller
 * (chatStore), not here.
 *
 * Failure contract (matched by chatStore's friendlyChatError): HTTP errors
 * reject with "{status}:{body}", mid-stream SSE errors with "api_error:{msg}".
 */
export async function streamTurn(
  args: StreamTurnArgs,
  callbacks?: StreamCallbacks
): Promise<ChatTurnResult> {
  // With adaptive thinking, reasoning tokens count against max_tokens, so give
  // a generous ceiling (we stream, so a large cap can't trip an HTTP timeout).
  // It's a cap, not a spend — only actual tokens are billed.
  const maxTokens = args.thinkingEffort ? 64000 : 8192;

  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: maxTokens,
    system: args.system,
    messages: args.messages,
    stream: true,
  };
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
  }
  // Opus 4.8 uses adaptive thinking + an effort level — not budget_tokens.
  // Sampling params (temperature/top_p/top_k) are removed on this model and
  // would 400, so we set none. "display": "summarized" streams a readable
  // reasoning summary (default is "omitted" → empty) so the UI can show it.
  if (args.thinkingEffort) {
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: args.thinkingEffort };
  }

  const response = await messagesPost(args.auth, body);
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`${response.status}:${errorBody}`);
  }
  if (!response.body) {
    throw new Error("api_error:Response had no body");
  }

  let fullText = "";
  let stopReason = "";

  const blockKind = new Map<number, string>();
  const toolAccums = new Map<number, ToolCallAccum>();
  const thinkingTexts = new Map<number, string>();
  const thinkingSigs = new Map<number, string>();
  // Completed tool calls / thinking blocks tagged with their block index so
  // final ordering matches the model's output order.
  const completedTools: Array<[number, ToolCallAccum]> = [];
  const completedThinking: Array<[number, unknown]> = [];

  const handleEvent = (parsed: SseEvent): void => {
    const idx = parsed.index ?? 0;
    switch (parsed.type) {
      case "content_block_start": {
        const kind = parsed.content_block?.type ?? "";
        if (kind === "tool_use") {
          toolAccums.set(idx, {
            id: parsed.content_block?.id ?? "",
            name: parsed.content_block?.name ?? "",
            input: "",
          });
        } else if (kind === "thinking") {
          thinkingTexts.set(idx, "");
        } else if (kind === "redacted_thinking") {
          completedThinking.push([
            idx,
            { type: "redacted_thinking", data: parsed.content_block?.data ?? "" },
          ]);
        }
        blockKind.set(idx, kind);
        break;
      }

      case "content_block_delta": {
        switch (blockKind.get(idx)) {
          case "text": {
            const text = parsed.delta?.text;
            if (typeof text === "string") {
              fullText += text;
              callbacks?.onText?.(text);
            }
            break;
          }
          case "thinking": {
            const thinking = parsed.delta?.thinking;
            if (typeof thinking === "string") {
              thinkingTexts.set(idx, (thinkingTexts.get(idx) ?? "") + thinking);
              callbacks?.onThinking?.(thinking);
            }
            // The signature arrives as a separate signature_delta on the same
            // block; capture it for replay.
            const sig = parsed.delta?.signature;
            if (typeof sig === "string") thinkingSigs.set(idx, sig);
            break;
          }
          case "tool_use": {
            const partial = parsed.delta?.partial_json;
            const accum = toolAccums.get(idx);
            if (typeof partial === "string" && accum) accum.input += partial;
            break;
          }
        }
        break;
      }

      case "content_block_stop": {
        switch (blockKind.get(idx)) {
          case "tool_use": {
            const accum = toolAccums.get(idx);
            if (accum) {
              completedTools.push([idx, accum]);
              toolAccums.delete(idx);
            }
            break;
          }
          case "thinking": {
            const text = thinkingTexts.get(idx) ?? "";
            const sig = thinkingSigs.get(idx) ?? "";
            thinkingTexts.delete(idx);
            thinkingSigs.delete(idx);
            // Only replay a signed block; an unsigned one would be rejected on
            // the next round, so drop it rather than poison the request.
            if (sig !== "") {
              completedThinking.push([
                idx,
                { type: "thinking", thinking: text, signature: sig },
              ]);
            }
            break;
          }
        }
        break;
      }

      case "message_delta": {
        const reason = parsed.delta?.stop_reason;
        if (typeof reason === "string") stopReason = reason;
        break;
      }

      case "error": {
        const msg = parsed.error?.message ?? "Unknown API error";
        throw new Error(`api_error:${msg}`);
      }
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let pos: number;
      while ((pos = buffer.indexOf("\n\n")) !== -1) {
        const eventBlock = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 2);

        for (const line of eventBlock.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice("data: ".length);
          if (data === "[DONE]") continue;
          let parsed: SseEvent;
          try {
            parsed = JSON.parse(data) as SseEvent;
          } catch {
            continue;
          }
          handleEvent(parsed);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  completedTools.sort((a, b) => a[0] - b[0]);
  completedThinking.sort((a, b) => a[0] - b[0]);

  return {
    text: fullText,
    toolCalls: completedTools.map(([, tc]) => {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.input) as Record<string, unknown>;
      } catch {
        input = {};
      }
      return { id: tc.id, name: tc.name, input };
    }),
    thinkingBlocks: completedThinking.map(([, block]) => block),
    stopReason,
  };
}

// ─── Tool backends ───────────────────────────────────────────────────────────
// One function per tool the model can call (except `import_component`, which
// resolves inline in JS via easyedaImport.fetchComponentDef). Each returns the
// plain-text result string handed back to the model as a tool_result — errors
// included, so a failed lookup reads as a result rather than crashing the loop.

const JLCSEARCH_URL = "https://jlcsearch.tscircuit.com/api/search";

interface JlcComponent {
  lcsc?: number;
  mfr?: string;
  description?: string;
  package?: string;
  stock?: number;
  is_basic?: boolean;
  price?: number;
}

async function jlcSearch(query: string, limit: number): Promise<JlcComponent[]> {
  const url = `${JLCSEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Search API error: ${resp.status}`);
  const data = (await resp.json()) as { components?: JlcComponent[] };
  return data.components ?? [];
}

// Map a JLCPCB-reported package string to one of the catalog footprints used
// by Cherry Blossom. Best-effort — when the raw package doesn't match anything
// canonical, returns null and the caller surfaces the raw string.
const CANONICAL_FOOTPRINTS = [
  "0402", "0603", "0805", "1206",
  "soic8", "soic16", "soic20", "ssop16", "qfn16", "qfn32", "qfp32",
  "dip8", "dip14", "dip16", "dip28", "dip40",
  "sot23", "sot23_5", "sot23_6",
  "sod123", "do35",
  "axial_p5mm",
  "pinrow2", "pinrow3", "pinrow4", "pinrow6", "pinrow8",
];

export function normalizePackageToCatalog(pkg: string): string | null {
  const p = pkg.trim().toLowerCase();
  if (p === "") return null;
  if (CANONICAL_FOOTPRINTS.includes(p)) return p;

  // Common JLCPCB → catalog rewrites.
  const normalized = p
    .replace("0402_", "0402")
    .replace("0603_", "0603")
    .replace("0805_", "0805")
    .replace("1206_", "1206")
    .replace(/ /g, "")
    .replace(/-/g, "_");
  if (CANONICAL_FOOTPRINTS.includes(normalized)) return normalized;

  // SOT-23-5, SOT-23-6 variants.
  if (normalized.startsWith("sot23")) {
    for (const variant of ["sot23_5", "sot23_6", "sot23"]) {
      if (normalized.includes(variant) || normalized.includes(variant.replace(/_/g, ""))) {
        return variant;
      }
    }
  }
  // SOIC-N → soicN.
  if (normalized.startsWith("soic")) {
    const n = Number.parseInt(normalized.slice("soic".length).replace(/^_/, ""), 10);
    if (Number.isFinite(n)) {
      const candidate = `soic${n}`;
      if (CANONICAL_FOOTPRINTS.includes(candidate)) return candidate;
    }
  }
  return null;
}

export async function searchJlcpcb(query: string, limit?: number): Promise<string> {
  const q = query.trim();
  if (q === "") return "Error: search query is required";
  const capped = Math.min(limit ?? 5, 8);
  let components: JlcComponent[];
  try {
    components = await jlcSearch(q, capped);
  } catch (e) {
    return `Search error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (components.length === 0) return `No components found for "${q}".`;

  const lines = [`Found ${components.length} result(s) for "${q}":`];
  for (const comp of components) {
    const lcsc = comp.lcsc ?? 0;
    const mfr = comp.mfr ?? "—";
    const desc = comp.description ?? "—";
    const pkg = comp.package ?? "—";
    const stock = comp.stock ?? 0;
    const price = comp.price ?? 0;
    lines.push(
      `  C${lcsc} | ${mfr} | ${desc} | pkg:${pkg} | $${price.toFixed(4)} | stock:${stock}${
        comp.is_basic ? " [JLCPCB Basic]" : ""
      }`
    );
  }
  return lines.join("\n");
}

export async function lookupFootprint(lcscId?: string, mpn?: string): Promise<string> {
  const id = lcscId?.trim() ?? "";
  const part = mpn?.trim() ?? "";
  if (id === "" && part === "") {
    return "Error: lookup_footprint requires lcsc_id or mpn";
  }
  const query = id !== "" ? id : part;
  let components: JlcComponent[];
  try {
    components = await jlcSearch(query, 1);
  } catch (e) {
    return `Footprint lookup error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (components.length === 0) return `No JLCPCB results for "${query}".`;

  const top = components[0];
  const pkg = top.package ?? "";
  const canonical = normalizePackageToCatalog(pkg);
  return (
    `Best match: C${top.lcsc ?? 0} (${top.mfr ?? "—"}). Raw package: "${pkg}". ` +
    `Canonical footprint: ${
      canonical ??
      `(no canonical match — use "${pkg}" verbatim or call search_jlcpcb for alternatives)`
    }`
  );
}

export async function fetchDatasheet(
  auth: ChatAuth,
  lcscId: string,
  mpn?: string
): Promise<string> {
  const id = lcscId.trim();
  if (id === "") return "Error: fetch_datasheet requires lcsc_id";
  const part = mpn?.trim() || undefined;
  try {
    const summary = await fetchAndSummarize(auth, id, part);
    return renderForModel(summary);
  } catch (e) {
    return `Datasheet fetch failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool catalog ─────────────────────────────────────────────────────────────
// The model-facing tool definitions, sent on every design turn. The loop in
// chatStore dispatches each call to the backends above. `cache_control` on the
// last tool caches the whole tools block server-side. `edit_tsx`/`write_tsx`
// have no HTTP backend — they resolve inline in JS against the loop's working
// TSX copy.
export const CHAT_TOOLS: unknown[] = [
  {
    name: "edit_tsx",
    description:
      "Make an incremental change to an existing circuit by replacing an exact string in its TSX. `old_string` must match the current circuit TSX EXACTLY — copy it verbatim from the " +
      "'## Current Circuit' code block in context, including indentation, `key=` props, and " +
      "`pcbX`/`pcbY`/`pcbRotation`. It must be unique unless `replace_all` is true; include a few " +
      "surrounding lines to disambiguate. To add a component, replace an existing line with that same line " +
      "plus the new one. To delete code, set `new_string` to an empty string. Call it multiple times for " +
      "multiple edits — each applies in order to a working copy, and the circuit is updated once you finish " +
      "the turn. Use `write_tsx` instead when the circuit is empty or you are rewriting most of the design.",
    input_schema: {
      type: "object",
      properties: {
        old_string: {
          type: "string",
          description:
            "Exact text to find in the current TSX, copied verbatim including indentation. Must be unique unless replace_all is true.",
        },
        new_string: {
          type: "string",
          description:
            "Replacement text. Must differ from old_string. Use an empty string to delete the matched text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence of old_string instead of requiring a single unique match. Default false.",
          default: false,
        },
      },
      required: ["old_string", "new_string"],
    },
  },
  {
    name: "write_tsx",
    description:
      "Replace the ENTIRE circuit with a complete new TSX document. Use this when the circuit is empty " +
      "(nothing to anchor an `edit_tsx` `old_string` onto) or when a wholesale rewrite is simpler than many " +
      "`edit_tsx` calls. `tsx` must be the full, self-contained module — a single `export default` component " +
      "returning a `<board>…</board>` — not a fragment. When rewriting an existing design, preserve every " +
      "`key=` and `pcbX`/`pcbY`/`pcbRotation` prop you are keeping. Prefer `edit_tsx` for small, targeted " +
      "changes; reach for this only to build from scratch or replace most of the design.",
    input_schema: {
      type: "object",
      properties: {
        tsx: {
          type: "string",
          description:
            "The complete new circuit TSX — a full module with a single `export default` component returning a `<board>`. Replaces the current circuit wholesale.",
        },
      },
      required: ["tsx"],
    },
  },
  {
    name: "search_jlcpcb",
    description:
      "Search the JLCPCB/LCSC component library for real electronic parts. Returns LCSC part numbers, manufacturer part numbers, descriptions, packages, stock, and price. Use this to find real orderable components when the user needs a specific IC.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query, e.g. 'TP4056 battery charger', 'LM3914 LED bar driver', 'HLK-PM01 AC-DC 5V module'",
        },
        limit: {
          type: "integer",
          description: "Number of results to return (default 5, max 8)",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "import_component",
    description:
      "Imports a real JLCPCB component into the circuit. Call this after search_jlcpcb once you have chosen the right part. The component is fetched and converted immediately; the tool returns the EXACT JSX tag name to use — use it verbatim in your TSX. The definition block is added to the circuit automatically — do NOT write it yourself. If the import fails, the tool says so; pick another part or build it from discrete elements instead of referencing a tag that doesn't exist.",
    input_schema: {
      type: "object",
      properties: {
        lcsc_id: {
          type: "string",
          description: "LCSC part number starting with C, e.g. 'C16581'",
        },
      },
      required: ["lcsc_id"],
    },
  },
  {
    name: "lookup_footprint",
    description:
      "Returns the canonical Cherry Blossom footprint family (e.g. 'sot23_5', 'soic8', 'qfn32') for a JLCPCB part. Call this before placing a non-imported chip when you are uncertain which footprint string matches the real part. Cheaper than a full search + import.",
    input_schema: {
      type: "object",
      properties: {
        lcsc_id: {
          type: "string",
          description:
            "LCSC part number, e.g. 'C16581'. Either lcsc_id or mpn is required.",
        },
        mpn: {
          type: "string",
          description:
            "Manufacturer part number, e.g. 'TP4056'. Either lcsc_id or mpn is required.",
        },
      },
    },
  },
  {
    name: "fetch_datasheet",
    description:
      "Fetches the datasheet PDF for a JLCPCB part and returns a structured summary (V_in range, output current, topology, pinout, key features, gotchas). MUST be called before placing any non-trivial IC (LDOs, chargers, drivers, MCUs, op-amps in a critical role, sensors) so you can confirm the part fits the circuit's rails. Results are cached per part — subsequent calls in this session are instant.",
    input_schema: {
      type: "object",
      properties: {
        lcsc_id: {
          type: "string",
          description: "LCSC part number, e.g. 'C16581'",
        },
        mpn: {
          type: "string",
          description:
            "Manufacturer part number, e.g. 'TP4056'. Optional but improves accuracy.",
        },
      },
      required: ["lcsc_id"],
    },
    cache_control: { type: "ephemeral" },
  },
];
