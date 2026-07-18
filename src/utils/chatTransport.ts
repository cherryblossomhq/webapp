// ─── Chat transport ──────────────────────────────────────────────────────────
//
// Single swappable seam for every external call the chat loop makes. Direct
// BYOK calls use Anthropic's native Messages API. Managed account calls use the
// Cherry Blossom OpenRouter proxy's OpenAI-compatible Chat Completions API.
// Both protocols are normalized into ChatTurnResult so the tool loop stays
// provider-agnostic. Keep all chat HTTP in this file.

import { fetchAndSummarize, renderForModel } from "./datasheets";

// Credential + routing for one model call. `apiKey` goes straight to Anthropic
// with the user's own key; `managed` routes through Cherry Blossom's OpenRouter
// proxy, authenticated by the signed-in user's WorkOS access token.
export type ChatAuth =
  | { kind: "apiKey"; key: string }
  | { kind: "managed"; token: string; url: string };

// Managed proxy endpoint, baked in at build time (env supplies the website
// origin/endpoint: dev → a local checkout, prd → production). Always force
// the current path so an older Doppler value cannot call the removed Messages
// endpoint. The fallback uses `www` because the apex redirects cross-origin and
// browsers drop Authorization on that redirect.
function managedCompletionsUrl(configured?: string): string {
  const base = configured ?? "https://www.trycherryblossom.com";
  return new URL("/api/v1/chat/completions", base).toString();
}

export const MANAGED_CHAT_COMPLETIONS_URL = managedCompletionsUrl(
  import.meta.env.VITE_MANAGED_AI_URL
);

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

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

// One assistant turn returned by `streamTurn`. Chat Completions semantics are
// canonical: `finishReason` uses OpenRouter values and reasoning exposes the
// normalized text/details fields. `reasoning.replay` is the opaque provider
// payload the caller must return unchanged on the next tool round; native
// Anthropic is adapted into this contract for the legacy BYOK path.
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
    replay: unknown[];
  };
  finishReason: string;
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
  /** Stable, non-sensitive conversation ID used for managed provider affinity. */
  sessionId?: string;
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

const OPENROUTER_REASONING_REPLAY = "openrouter_reasoning_replay";

interface OpenRouterReasoningReplay {
  type: typeof OPENROUTER_REASONING_REPLAY;
  reasoning?: string;
  reasoning_details: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenRouterReasoningReplay(
  value: unknown
): value is OpenRouterReasoningReplay {
  return (
    isRecord(value) &&
    value.type === OPENROUTER_REASONING_REPLAY &&
    Array.isArray(value.reasoning_details)
  );
}

const MANAGED_MODEL_IDS: Record<string, string> = {
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  // Temporary managed-mode override for local testing. BYOK still sends the
  // native `claude-opus-4-8` ID directly to Anthropic.
  "claude-opus-4-8": "tencent/hy3:free",
  "claude-fable-5": "anthropic/claude-fable-5",
};

export function managedModelId(nativeModelId: string): string {
  return MANAGED_MODEL_IDS[nativeModelId] ?? nativeModelId;
}

function openRouterContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.flatMap((part): unknown[] => {
    if (!isRecord(part)) return [part];
    if (part.type === "document" && isRecord(part.source)) {
      const source = part.source;
      if (
        source.type === "base64" &&
        typeof source.media_type === "string" &&
        typeof source.data === "string"
      ) {
        return [
          {
            type: "file",
            file: {
              filename: "datasheet.pdf",
              file_data: `data:${source.media_type};base64,${source.data}`,
            },
          },
        ];
      }
    }
    return [part];
  });
}

function toolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Convert the loop's Anthropic-shaped canonical history to Chat Completions. */
export function toOpenRouterMessages(
  system: unknown[],
  messages: unknown[]
): unknown[] {
  const out: unknown[] = [];
  if (system.length > 0) {
    out.push({ role: "system", content: openRouterContent(system) });
  }

  for (const raw of messages) {
    if (!isRecord(raw) || typeof raw.role !== "string") continue;
    const role = raw.role;
    const content = raw.content;

    if (role === "user" && Array.isArray(content)) {
      const normalParts = content.filter(
        (part) => !isRecord(part) || part.type !== "tool_result"
      );
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool_result") continue;
        out.push({
          role: "tool",
          tool_call_id:
            typeof part.tool_use_id === "string" ? part.tool_use_id : "",
          content: toolResultContent(part.content),
        });
      }
      if (normalParts.length > 0) {
        out.push({ role: "user", content: openRouterContent(normalParts) });
      }
      continue;
    }

    if (role === "assistant" && Array.isArray(content)) {
      const textParts: unknown[] = [];
      const toolCalls: unknown[] = [];
      let reasoning: string | undefined;
      let reasoningDetails: unknown[] | undefined;
      for (const part of content) {
        if (isOpenRouterReasoningReplay(part)) {
          reasoning = part.reasoning;
          reasoningDetails = part.reasoning_details;
        } else if (isRecord(part) && part.type === "tool_use") {
          toolCalls.push({
            id: typeof part.id === "string" ? part.id : "",
            type: "function",
            function: {
              name: typeof part.name === "string" ? part.name : "",
              arguments: JSON.stringify(
                isRecord(part.input) ? part.input : (part.input ?? {})
              ),
            },
          });
        } else if (isRecord(part) && part.type === "text") {
          textParts.push(part);
        }
      }
      const assistant: Record<string, unknown> = {
        role: "assistant",
        content:
          textParts.length === 0 ? null : openRouterContent(textParts),
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      if (reasoningDetails !== undefined && reasoningDetails.length > 0) {
        assistant.reasoning_details = reasoningDetails;
      } else if (reasoning !== undefined) {
        assistant.reasoning = reasoning;
      }
      out.push(assistant);
      continue;
    }

    out.push({ role, content: openRouterContent(content) });
  }
  return out;
}

export function toOpenRouterTools(tools: unknown[]): unknown[] {
  return tools.flatMap((tool): unknown[] => {
    if (!isRecord(tool) || typeof tool.name !== "string") return [];
    return [
      {
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          parameters: isRecord(tool.input_schema)
            ? tool.input_schema
            : { type: "object" },
        },
      },
    ];
  });
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

async function streamAnthropicTurn(
  args: StreamTurnArgs,
  callbacks: StreamCallbacks | undefined,
  maxTokens: number
): Promise<ChatTurnResult> {
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: maxTokens,
    system: args.system,
    messages: args.messages,
    stream: true,
  };
  if (args.tools && args.tools.length > 0) body.tools = args.tools;
  if (args.thinkingEffort) {
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: args.thinkingEffort };
  }

  const response = await postJson(args.auth, body, args.signal);
  if (!response.ok) {
    throw httpError(response, await response.text().catch(() => ""));
  }

  if (!response.body) {
    throw new ChatTransportError("api_error:Response had no body", response);
  }
  let fullText = "";
  let nativeStopReason = "";

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
        if (typeof reason === "string") nativeStopReason = reason;
        break;
      }

      case "error": {
        const msg = parsed.error?.message ?? "Unknown API error";
        throw new ChatTransportError(`api_error:${msg}`, response);
      }
    }
  };
  await readSse(response, (payload) => handleEvent(payload as SseEvent));

  completedTools.sort((a, b) => a[0] - b[0]);
  completedThinking.sort((a, b) => a[0] - b[0]);

  const replay = completedThinking.map(([, block]) => block);
  const reasoningText = replay
    .map((block) =>
      isRecord(block) && typeof block.thinking === "string"
        ? block.thinking
        : ""
    )
    .join("");

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
    reasoning: { text: reasoningText, details: [], replay },
    finishReason: normalizeAnthropicFinishReason(nativeStopReason),
  };
}

function normalizeAnthropicFinishReason(reason: string): string {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    default:
      return reason;
  }
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
    model: managedModelId(args.model),
    messages: toOpenRouterMessages(args.system, args.messages),
    max_tokens: maxTokens,
    stream: true,
    cache_control: { type: "ephemeral" },
  };
  if (args.sessionId) body.session_id = args.sessionId;
  if (args.tools && args.tools.length > 0) {
    body.tools = toOpenRouterTools(args.tools);
    body.tool_choice = "auto";
  }
  if (args.thinkingEffort) {
    body.reasoning = { effort: args.thinkingEffort };
  }

  const response = await postJson(args.auth, body, args.signal);
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

  const replay: unknown[] = [];
  if (reasoningDetails.length > 0 || fullReasoning !== "") {
    replay.push({
      type: OPENROUTER_REASONING_REPLAY,
      ...(fullReasoning !== "" ? { reasoning: fullReasoning } : {}),
      reasoning_details: reasoningDetails,
    } satisfies OpenRouterReasoningReplay);
  }

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
      replay,
    },
    finishReason,
  };
}

/**
 * Stream one provider-specific turn and normalize it for the shared JS loop.
 * HTTP failures reject with "{status}:{body}" and mid-stream provider failures
 * with "api_error:{msg}"; ChatTransportError also retains safe response
 * diagnostics such as Retry-After and x-generation-id.
 */
export async function streamTurn(
  args: StreamTurnArgs,
  callbacks?: StreamCallbacks
): Promise<ChatTurnResult> {
  const maxTokens = args.thinkingEffort ? 64000 : 8192;
  return args.auth.kind === "managed"
    ? streamOpenRouterTurn(args, callbacks, maxTokens)
    : streamAnthropicTurn(args, callbacks, maxTokens);
}

export interface CompleteTextArgs {
  auth: ChatAuth;
  model: string;
  messages: unknown[];
  system?: unknown[];
  maxTokens: number;
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
  const managed = args.auth.kind === "managed";
  const body = managed
    ? {
        model: managedModelId(args.model),
        max_tokens: args.maxTokens,
        messages: toOpenRouterMessages(system, args.messages),
        stream: false,
      }
    : {
        model: args.model,
        max_tokens: args.maxTokens,
        ...(system.length > 0 ? { system } : {}),
        messages: args.messages,
      };
  const response = await postJson(args.auth, body, args.signal);
  if (!response.ok) {
    throw httpError(response, await response.text().catch(() => ""));
  }
  const json = (await response.json()) as unknown;
  if (!isRecord(json)) return "";
  if (managed) {
    const choices = json.choices;
    if (!Array.isArray(choices) || !isRecord(choices[0])) return "";
    const message = choices[0].message;
    return isRecord(message) ? responseText(message.content) : "";
  }
  const content = json.content;
  return responseText(content);
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
