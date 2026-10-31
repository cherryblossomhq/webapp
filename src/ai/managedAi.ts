import type { ApiErrorResponse, MeResponse } from "@cherryblossom/api-contract"

// The copilot's only way out to a model: Cherry Blossom's managed AI, `/api/v1` on the host.
// Every request carries the signed-in user's WorkOS token; the proxy decides plan, model and
// quota, and this side only branches on its error contract. No key, no plan logic here.

/** What the host app provides. The editor holds no session of its own. */
export interface ManagedAiHost {
  /** The signed-in user's access token, refreshed if it is about to expire; empty when signed out. */
  getAccessToken: () => Promise<string | null | undefined>
  /** The browser's PostHog distinct id, so a refusal joins the user's other events. */
  getDistinctId?: () => string | undefined
  /** Origin serving `/api/v1`; the page's own when unset. */
  baseUrl?: string
  /** Leave for sign-in and come back to this page. */
  signIn?: () => void
  /** Where plans are bought and usage is managed. */
  upgradeUrl?: string
  accountUrl?: string
  /**
   * Where the user connects an AI assistant of their own (Claude, ChatGPT, Cursor) to their
   * projects through MCP, which every plan has: what a plan without Sakura is offered beside the
   * upgrade.
   */
  assistantsUrl?: string
  /** Each assistant's own steps on that page, by client; one without links to the page. */
  assistantGuides?: Partial<Record<AssistantClient, string>>
}

/** The assistants the notice on Free names, each by the setup steps the host has for it. */
export type AssistantClient = "claude" | "chatgpt" | "claudeCode" | "codex" | "cursor"

let host: ManagedAiHost | null = null

export function connectManagedAi(next: ManagedAiHost | null | undefined) {
  host = next ?? null
}

export const managedAiHost = () => host

/** How the copilot surfaces a failure: each kind offers its own way forward. */
export type FailureKind = "signin" | "plan" | "limit" | "error"

export class ManagedAiError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status?: number,
    /** The proxy's `error.type`, e.g. `plan_required`. */
    readonly type?: string,
    /** Seconds, from `Retry-After`. */
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = "ManagedAiError"
  }
}

const SIGN_IN = "Sign in to use Sakura."

function url(path: string) {
  return host?.baseUrl ? new URL(path, host.baseUrl).toString() : path
}

async function headers(traceId?: string): Promise<Record<string, string>> {
  let token: string | null | undefined = null
  try {
    token = await host?.getAccessToken()
  } catch {
    token = null
  }
  if (!token) throw new ManagedAiError(SIGN_IN, "signin", 401, "not_authenticated")
  const out: Record<string, string> = { authorization: `Bearer ${token}` }
  if (traceId) out["x-trace-id"] = traceId
  const distinctId = host?.getDistinctId?.()
  if (distinctId) out["x-posthog-distinct-id"] = distinctId
  return out
}

/** Turn a non-2xx response into a ManagedAiError, by status and the proxy's `error.type`. */
export async function responseError(res: Response): Promise<ManagedAiError> {
  let type: string | undefined
  let message: string | undefined
  let upstream = false
  try {
    const body = (await res.json()) as Partial<ApiErrorResponse> & { error?: { code?: string | number } }
    type = typeof body.error?.type === "string" ? body.error.type : undefined
    message = typeof body.error?.message === "string" ? body.error.message : undefined
    // OpenRouter's own errors pass through carrying a `code` and no `type`.
    upstream = !type && body.error?.code !== undefined
  } catch {
    // not JSON: a gateway page or an empty body
  }
  const retry = Number(res.headers.get("retry-after"))
  const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : undefined
  // An upstream 401 is the server's key, not the user's session: signing in again wouldn't fix it.
  if (type === "not_authenticated" || (res.status === 401 && !upstream)) {
    return new ManagedAiError(SIGN_IN, "signin", res.status, type)
  }
  if (type === "plan_required" || type === "model_not_allowed") {
    return new ManagedAiError(message ?? "Your plan doesn't include Sakura.", "plan", res.status, type)
  }
  if (res.status === 429 || type === "rate_limited") {
    return new ManagedAiError(message ?? "You've reached your plan's usage limit. Try again later.", "limit", res.status, type, retryAfter)
  }
  const fallback = res.status >= 500 ? "Sakura is unavailable right now. Try again in a moment." : `Request failed (${res.status}).`
  return new ManagedAiError(message ?? fallback, "error", res.status, type)
}

async function send(path: string, init: RequestInit, traceId?: string): Promise<Response> {
  const auth = await headers(traceId)
  let res: Response
  try {
    res = await fetch(url(path), { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } })
  } catch (err) {
    if (init.signal?.aborted) throw err
    throw new ManagedAiError("Couldn't reach Cherry Blossom. Check your connection.", "error")
  }
  if (!res.ok) throw await responseError(res)
  return res
}

/** `GET /api/v1/me`: the plan, its models and limits. */
export async function fetchAccount(signal?: AbortSignal): Promise<MeResponse> {
  const res = await send("/api/v1/me", { method: "GET", signal })
  return (await res.json()) as MeResponse
}

// ---------- Chat completions ----------

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/** A part of a user message that carries more than text: a picture as a base64 data URL. */
export type UserContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }

export type ChatMessage =
  | { role: "system"; content: string | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] }
  | { role: "user"; content: string | UserContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface ChatTurn {
  text: string
  toolCalls: ToolCall[]
  /** Reasoning blocks to send back with this turn on the next request, merged from their stream fragments. */
  reasoningDetails: unknown[]
  /** `stop`, `tool_calls`, `length`, `content_filter`, ... or null when the stream ended without one. */
  finishReason: string | null
}

interface Chunk {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_details?: unknown[]
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  error?: { message?: string; code?: string | number }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** Fields that stream in pieces, per reasoning detail type. Encrypted entries are whole and never merge. */
const REASONING_CONCAT: Record<string, string[]> = {
  "reasoning.text": ["text", "signature"],
  "reasoning.summary": ["summary"],
}

/**
 * Merge streamed `reasoning_details` fragments back into one entry per block. Claude splits a
 * thinking block across chunks (text pieces, then the signature) under one index, and replaying
 * the pieces fails its signature check. Only adjacent fragments of the same block merge.
 */
export function coalesceReasoningDetails(details: unknown[]): unknown[] {
  const out: unknown[] = []
  let lastKey: string | null = null
  for (const detail of details) {
    const fields = isRecord(detail) && typeof detail.type === "string" ? REASONING_CONCAT[detail.type] : undefined
    if (!isRecord(detail) || !fields || !Number.isInteger(detail.index)) {
      out.push(detail)
      lastKey = null
      continue
    }
    const key = `${detail.index}|${detail.type}|${String(detail.format)}`
    if (key !== lastKey) {
      out.push({ ...detail })
      lastKey = key
      continue
    }
    const block = out[out.length - 1] as Record<string, unknown>
    for (const [field, value] of Object.entries(detail)) {
      if (fields.includes(field)) {
        if (typeof value === "string") block[field] = typeof block[field] === "string" ? block[field] + value : value
      } else if (block[field] === undefined || block[field] === null) {
        block[field] = value
      }
    }
  }
  return out
}

/** Call `onData` with each `data:` payload of a server-sent event stream, until `[DONE]`. */
async function readSse(body: ReadableStream<Uint8Array>, onData: (payload: unknown) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let done = false
  const line = (raw: string) => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!l.startsWith("data:")) return
    const data = l.slice(5).trim()
    if (!data) return
    if (data === "[DONE]") {
      done = true
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      throw new ManagedAiError("Sakura sent a response that couldn't be read.", "error")
    }
    onData(payload)
  }
  try {
    while (!done) {
      const { done: end, value } = await reader.read()
      if (end) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while (!done && (nl = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    }
    if (!done) {
      buffer += decoder.decode()
      if (buffer) line(buffer)
    } else {
      await reader.cancel().catch(() => undefined)
    }
  } catch (err) {
    // An error chunk or an unreadable line: stop the response rather than leave it streaming.
    await reader.cancel().catch(() => undefined)
    throw err
  } finally {
    reader.releaseLock()
  }
}

export interface StreamOptions {
  signal?: AbortSignal
  /** One UUID per conversation: groups its requests into one trace in analytics. */
  traceId?: string
  onText?: (delta: string) => void
}

/** Stream one Chat Completions turn through `/api/v1/chat/completions`. */
export async function streamChat(body: Record<string, unknown>, { signal, traceId, onText }: StreamOptions): Promise<ChatTurn> {
  const res = await send(
    "/api/v1/chat/completions",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true }), signal },
    traceId,
  )
  if (!res.body) throw new ManagedAiError("Sakura sent an empty response.", "error")

  let text = ""
  let finishReason: string | null = null
  const reasoning: unknown[] = []
  const calls = new Map<number, { id: string; name: string; args: string }>()
  await readSse(res.body, (payload) => {
    const chunk = payload as Chunk
    // A provider failure after the stream started arrives as a chunk of a 200 response.
    if (chunk.error) throw new ManagedAiError(chunk.error.message || "The model stopped with an error. Try again.", "error")
    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = choice.delta
    if (typeof delta?.content === "string" && delta.content) {
      text += delta.content
      onText?.(delta.content)
    }
    if (Array.isArray(delta?.reasoning_details)) reasoning.push(...delta.reasoning_details)
    for (const part of delta?.tool_calls ?? []) {
      const index = part.index ?? 0
      const call = calls.get(index) ?? { id: "", name: "", args: "" }
      if (part.id) call.id = part.id
      if (part.function?.name) call.name = part.function.name
      if (typeof part.function?.arguments === "string") call.args += part.function.arguments
      calls.set(index, call)
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  })

  return {
    text,
    toolCalls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({ id: c.id || `call_${index}`, type: "function", function: { name: c.name, arguments: c.args } })),
    reasoningDetails: coalesceReasoningDetails(reasoning),
    finishReason,
  }
}
