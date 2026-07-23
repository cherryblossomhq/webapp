// ─── Chat transport ──────────────────────────────────────────────────────────
//
// Single seam for every external call the chat loop makes. Model calls use the
// Cherry Blossom OpenRouter proxy's OpenAI-compatible Chat Completions API.
// Keep all chat HTTP in this file.

import { fetchAndSummarize, renderForModel } from "./datasheets";
import { SEMANTIC_CIRCUIT_TOOLS } from "../ai/semanticCircuitTools";

// Credential + routing for one model call through Cherry Blossom's OpenRouter
// proxy, authenticated by the signed-in user's WorkOS access token.
export interface OpenRouterAuth {
  token: string;
  url: string;
}

// Managed proxy endpoint, baked in at build time (env supplies the website
// origin/endpoint: dev → a local checkout, prd → production). Always force
// the current path so an older Doppler value cannot call the removed Messages
// endpoint. The fallback uses `www` because the apex redirects cross-origin and
// browsers drop Authorization on that redirect.
function openRouterCompletionsUrl(configured?: string): string {
  const base = configured ?? "https://www.trycherryblossom.com";
  return new URL("/api/v1/chat/completions", base).toString();
}

export const OPENROUTER_CHAT_COMPLETIONS_URL = openRouterCompletionsUrl(
  import.meta.env.VITE_MANAGED_AI_URL
);

export class ChatTransportError extends Error {
  readonly generationId?: string;
  readonly retryAfter?: string;

  constructor(message: string, response?: Response) {
    super(message);
    this.name = "ChatTransportError";
    this.generationId = response?.headers.get("x-generation-id") ?? undefined;
    this.retryAfter = response?.headers.get("retry-after") ?? undefined;
  }
}

function postJson(
  auth: OpenRouterAuth,
  body: unknown,
  signal?: AbortSignal,
  traceId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${auth.token}`,
  };
  if (traceId) headers["x-trace-id"] = traceId;
  return fetch(auth.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

// One assistant turn returned by `streamTurn`. `finishReason` uses OpenRouter
// values and `reasoning.details` is the exact replay payload that must be sent
// back unchanged on the next tool round.
export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatTurnResult {
  text: string;
  toolCalls: ChatToolCall[];
  reasoning: {
    text: string;
    details: unknown[];
  };
  finishReason: string;
}

export interface StreamTurnArgs {
  auth: OpenRouterAuth;
  model: string;
  /** Already-shaped system blocks (caller owns the `cache_control` breakpoint). */
  system: unknown[];
  /** Already-shaped messages array (strings or content-block arrays). */
  messages: unknown[];
  /** OpenRouter function definitions; omit / empty to force a tool-free turn. */
  tools?: ChatToolDefinition[];
  /** Require at least one tool call for this turn instead of leaving it optional. */
  toolChoice?: "auto" | "required";
  /** Adaptive-thinking effort (e.g. "high"); omit to disable thinking. */
  thinkingEffort?: string;
  /** Stable, non-sensitive conversation ID used for provider affinity. */
  sessionId?: string;
  /**
   * Per-conversation PostHog trace id, sent as `X-Trace-Id`. Must be a plain
   * UUID — the proxy silently ignores anything else and falls back to a
   * per-request trace, so this can never fail a request. Optional.
   */
  traceId?: string;
  signal?: AbortSignal;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Add the system message to an already OpenRouter-shaped chat history. */
export function toOpenRouterMessages(
  system: unknown[],
  messages: unknown[]
): unknown[] {
  const out: unknown[] = [];
  if (system.length > 0) {
    out.push({ role: "system", content: system });
  }

  for (const raw of messages) {
    if (!isRecord(raw) || typeof raw.role !== "string") continue;
    out.push(raw);
  }
  return out;
}

type OpenRouterChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[];
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: string | number };
};

async function readSse(
  response: Response,
  onData: (payload: unknown) => void
): Promise<void> {
  if (!response.body) {
    throw new ChatTransportError("api_error:Response had no body", response);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trimStart();
    if (data === "") return;
    if (data === "[DONE]") {
      finished = true;
      return;
    }
    try {
      onData(JSON.parse(data) as unknown);
    } catch (error) {
      if (error instanceof ChatTransportError) throw error;
      throw new ChatTransportError("api_error:Invalid SSE payload", response);
    }
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while (!finished && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    }
    if (!finished) {
      buffer += decoder.decode();
      if (buffer !== "") handleLine(buffer);
    } else {
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    reader.releaseLock();
  }
}

function httpError(response: Response, body: string): ChatTransportError {
  return new ChatTransportError(`${response.status}:${body}`, response);
}

function reasoningText(details: unknown[]): string {
  let text = "";
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    if (typeof detail.summary === "string") text += detail.summary;
    else if (typeof detail.text === "string") text += detail.text;
  }
  return text;
}

async function streamOpenRouterTurn(
  args: StreamTurnArgs,
  callbacks: StreamCallbacks | undefined,
  maxTokens: number
): Promise<ChatTurnResult> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: toOpenRouterMessages(args.system, args.messages),
    max_tokens: maxTokens,
    stream: true,
    cache_control: { type: "ephemeral" },
  };
  if (args.sessionId) body.session_id = args.sessionId;
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
    body.tool_choice = args.toolChoice ?? "auto";
  }
  if (args.thinkingEffort) {
    body.reasoning = { effort: args.thinkingEffort };
  }

  const response = await postJson(args.auth, body, args.signal, args.traceId);
  if (!response.ok) {
    throw httpError(response, await response.text().catch(() => ""));
  }

  let fullText = "";
  let fullReasoning = "";
  let finishReason = "";
  const reasoningDetails: unknown[] = [];
  const toolAccums = new Map<number, ToolCallAccum>();

  await readSse(response, (payload) => {
    const chunk = payload as OpenRouterChunk;
    if (chunk.error) {
      throw new ChatTransportError(
        `api_error:${chunk.error.message ?? "Unknown API error"}`,
        response
      );
    }
    const choice = chunk.choices?.[0];
    if (!choice) return; // Usage-only final chunk.
    const delta = choice.delta;
    // Some OpenRouter providers include `content: ""` on reasoning-only
    // chunks. Do not emit those as text events: an empty text event between
    // reasoning tokens splits one trace into many separate Thinking rows.
    if (typeof delta?.content === "string" && delta.content !== "") {
      fullText += delta.content;
      callbacks?.onText?.(delta.content);
    }

    const details = Array.isArray(delta?.reasoning_details)
      ? delta.reasoning_details
      : [];
    if (details.length > 0) reasoningDetails.push(...details);
    const visibleReasoning =
      typeof delta?.reasoning === "string"
        ? delta.reasoning
        : reasoningText(details);
    if (visibleReasoning) {
      fullReasoning += visibleReasoning;
      callbacks?.onThinking?.(visibleReasoning);
    }

    for (const fragment of delta?.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      const accum = toolAccums.get(index) ?? { id: "", name: "", input: "" };
      if (typeof fragment.id === "string" && fragment.id !== "") {
        accum.id = fragment.id;
      }
      if (
        typeof fragment.function?.name === "string" &&
        fragment.function.name !== ""
      ) {
        accum.name = fragment.function.name;
      }
      if (typeof fragment.function?.arguments === "string") {
        accum.input += fragment.function.arguments;
      }
      toolAccums.set(index, accum);
    }
    if (typeof choice.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
  });

  return {
    text: fullText,
    toolCalls: [...toolAccums.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => {
        let input: Record<string, unknown>;
        try {
          const parsed = JSON.parse(tc.input || "{}") as unknown;
          input = isRecord(parsed) ? parsed : {};
        } catch {
          input = {};
        }
        return { id: tc.id, name: tc.name, input };
      }),
    reasoning: {
      text: fullReasoning,
      details: reasoningDetails,
    },
    finishReason,
  };
}

/**
 * Stream one OpenRouter Chat Completions turn for the shared JS loop.
 * HTTP failures reject with "{status}:{body}" and mid-stream provider failures
 * with "api_error:{msg}"; ChatTransportError also retains safe response
 * diagnostics such as Retry-After and x-generation-id.
 */
export async function streamTurn(
  args: StreamTurnArgs,
  callbacks?: StreamCallbacks
): Promise<ChatTurnResult> {
  const maxTokens = args.thinkingEffort ? 64000 : 8192;
  return streamOpenRouterTurn(args, callbacks, maxTokens);
}

export interface CompleteTextArgs {
  auth: OpenRouterAuth;
  model: string;
  messages: unknown[];
  system?: unknown[];
  maxTokens: number;
  /** Per-conversation PostHog trace id — see StreamTurnArgs.traceId. */
  traceId?: string;
  signal?: AbortSignal;
}

function responseText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : ""
    )
    .join("")
    .trim();
}

/** Non-streaming text completion used by the datasheet summarizer. */
export async function completeText(args: CompleteTextArgs): Promise<string> {
  const system = args.system ?? [];
  const body = {
    model: args.model,
    max_tokens: args.maxTokens,
    messages: toOpenRouterMessages(system, args.messages),
    stream: false,
  };
  const response = await postJson(args.auth, body, args.signal, args.traceId);
  if (!response.ok) {
    throw httpError(response, await response.text().catch(() => ""));
  }
  const json = (await response.json()) as unknown;
  if (!isRecord(json)) return "";
  const choices = json.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0])) return "";
  const message = choices[0].message;
  return isRecord(message) ? responseText(message.content) : "";
}

// ─── Tool backends ───────────────────────────────────────────────────────────
// One function per tool the model can call (except `import_component`, which
// resolves inline in JS via easyedaImport.fetchComponentDef). Each returns the
// plain-text result string handed back to the model in a `role: "tool"` message — errors
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

  const passive = p.match(/^(0402|0603|0805|1206)(?:[_\s-]|$)/)?.[1];
  if (passive) return passive;

  // Common JLCPCB → catalog rewrites.
  const normalized = p
    .replace(/ /g, "")
    .replace(/-/g, "_");
  if (CANONICAL_FOOTPRINTS.includes(normalized)) return normalized;

  // SOT-23-5, SOT-23-6 variants.
  const compact = normalized.replace(/_/g, "");
  if (compact.startsWith("sot23")) {
    for (const variant of ["sot23_5", "sot23_6", "sot23"]) {
      if (compact.includes(variant.replace(/_/g, ""))) {
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
  auth: OpenRouterAuth,
  model: string,
  lcscId: string,
  mpn?: string,
  traceId?: string
): Promise<string> {
  const id = lcscId.trim();
  if (id === "") return "Error: fetch_datasheet requires lcsc_id";
  const part = mpn?.trim() || undefined;
  try {
    const summary = await fetchAndSummarize(auth, model, id, part, traceId);
    return renderForModel(summary);
  } catch (e) {
    return `Datasheet fetch failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool catalog ─────────────────────────────────────────────────────────────
// The model-facing tool definitions, sent on every design turn. The loop in
// chatStore dispatches each call to the backends above. These use OpenRouter's
// OpenAI-compatible function schema directly. `edit_tsx`/`write_tsx` have no
// HTTP backend — they resolve inline in JS against the loop's working TSX copy.
export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const CHAT_TOOLS: ChatToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "edit_tsx",
      description:
        "Make an incremental change to an existing circuit by replacing an exact string in its TSX. `old_string` must match the current circuit TSX EXACTLY — copy it verbatim from the " +
        "'## Current Circuit' code block in context, including indentation, `key=` props, and " +
        "`pcbX`/`pcbY`/`pcbRotation`. It must be unique unless `replace_all` is true; include a few " +
        "surrounding lines to disambiguate. To add a component, replace an existing line with that same line " +
        "plus the new one. To delete code, set `new_string` to an empty string. Call it multiple times for " +
        "multiple edits — each applies in order to a working copy, and the circuit is updated once you finish " +
        "the turn. Use `write_tsx` instead when the circuit is empty or you are rewriting most of the design.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "write_tsx",
      description:
        "Replace the ENTIRE circuit with a complete new TSX document. Use this when the circuit is empty " +
        "(nothing to anchor an `edit_tsx` `old_string` onto) or when a wholesale rewrite is simpler than many " +
        "`edit_tsx` calls. `tsx` must be the full, self-contained module — a single `export default` component " +
        "returning a `<board>…</board>` — not a fragment. When rewriting an existing design, preserve every " +
        "`key=` and `pcbX`/`pcbY`/`pcbRotation` prop you are keeping. Prefer `edit_tsx` for small, targeted " +
        "changes; reach for this only to build from scratch or replace most of the design.",
      parameters: {
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
  },
  ...SEMANTIC_CIRCUIT_TOOLS,
  {
    type: "function",
    function: {
      name: "finish_circuit_edit",
      description:
        "Signals that every requested circuit mutation is included in this same assistant response. Call it once, alongside and after the final circuit-mutating tool calls, so Cherry Blossom can validate and commit immediately without another model round. Do not call it when research, imports, wiring, or other requested changes still remain. Calling it without a successful mutation does not commit anything.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "A concise past-tense summary of the completed circuit change, suitable to show directly to the user.",
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_jlcpcb",
      description:
        "Search the JLCPCB/LCSC component library for real electronic parts. Returns LCSC part numbers, manufacturer part numbers, descriptions, packages, stock, and price. Use this to find real orderable components when the user needs a specific IC.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "import_component",
      description:
        "Imports a real JLCPCB component into the circuit. Call this after search_jlcpcb once you have chosen the right part. The component is fetched and converted immediately; the tool returns the EXACT JSX tag name to use — use it verbatim in your TSX. The definition block is added to the circuit automatically — do NOT write it yourself. If the import fails, the tool says so; pick another part or build it from discrete elements instead of referencing a tag that doesn't exist.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "lookup_footprint",
      description:
        "Returns the canonical Cherry Blossom footprint family (e.g. 'sot23_5', 'soic8', 'qfn32') for a JLCPCB part. Call this before placing a non-imported chip when you are uncertain which footprint string matches the real part. Cheaper than a full search + import.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "fetch_datasheet",
      description:
        "Fetches the datasheet PDF for a JLCPCB part and returns a structured summary (V_in range, output current, topology, pinout, key features, gotchas). MUST be called before placing any non-trivial IC (LDOs, chargers, drivers, MCUs, op-amps in a critical role, sensors) so you can confirm the part fits the circuit's rails. Results are cached per part — subsequent calls in this session are instant.",
      parameters: {
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
    },
  },
];
