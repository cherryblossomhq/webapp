import type { Entry } from "../store/copilotStore"
import type { ChatMessage, UserContentPart } from "./managedAi"
import { OMITTED } from "./vision/messages"

/**
 * A Sakura chat as it is stored (`store/chats.ts`): what the panel shows (`entries`) and what the model was told
 * (`messages`, with the conversation's id), so a chat opened again reads as it did and carries on where it stopped.
 *
 * **It is stored in parts, so a save sends what changed, not the whole chat.** Part 0 is the header,
 * `{ "format": "cherryblossom.chat", "version", "conversationId" }`; each part after it is one request, from a message
 * the user sent to the next, `{ "entries", "messages" }`. Carrying a chat on adds a part and changes its last, and the
 * store sends those two (`persist` in `store/copilotStore.ts`). A request that is over changes only when something in
 * it does: a plan applied later, a picture the conversation let go of, its tool results shortened to fit. Each part is
 * JSON text, which storage keeps and never reads, as it keeps a project file.
 *
 * What is stored is less than the tab held:
 * - **No entry ids.** They are the tab's own (`nextEntryId`), and numbered again when a chat is opened; stored, they
 *   would make every part of a chat opened again differ from what storage has.
 * - **No pictures.** A `look` picture is a base64 PNG of up to 640 KB, and a chat carried on later takes a new one
 *   anyway. Each becomes the line an old picture becomes in the conversation (`OMITTED`).
 * - **No reasoning but each request's last.** A provider needs the thinking of the turn a tool loop is in (a stopped
 *   request's), not of every round of a request that ended. Keeping each request's last, rather than the chat's
 *   last alone, is what leaves a request's part as it was when the next one starts.
 * - **At most `MAX_CHAT_FILE_BYTES` in all.** Past it, the oldest tool results are shortened to a line, then the oldest
 *   requests leave what the model is told (the panel still shows them), then the panel's oldest requests go. A request
 *   emptied so keeps its part, so the parts after it keep their numbers and aren't sent again. Every tool call keeps a
 *   result, so the conversation stays one a provider takes.
 *
 * And one thing more: **a result for every tool call**, `UNFINISHED_RESULT` for one whose result hadn't come when a
 * request still running was saved, so a chat kept from a tab closed mid-request carries on like any other.
 */

export const CHAT_FILE_FORMAT = "cherryblossom.chat"
export const CHAT_FILE_VERSION = 1

/** The bytes of a chat file's JSON, its parts together: under the account's cap (the hosted app's `MAX_CHAT_BYTES`), with room. */
export const MAX_CHAT_FILE_BYTES = 2_000_000

/** What a tool result shortened to fit says, to the model reading the chat later. */
export const TRIMMED_RESULT = "[This result was left out of the saved chat to save space. Call the tool again if you need it.]"

/** The result of a call that hadn't run yet when the chat was saved mid-request, and so never did if the tab closed then. */
export const UNFINISHED_RESULT = "Error: The request ended before this call's result was kept. Read the design again before relying on it."

const MAX_TITLE = 80

export interface ChatConversation {
  /** The conversation's trace and cache affinity id (`X-Trace-Id`, `session_id`). */
  id: string
  messages: ChatMessage[]
}

export interface ChatContents {
  entries: Entry[]
  conversation: ChatConversation
}

/** An entry as it is stored: without the tab's id. */
type StoredEntry = { [K in Entry["kind"]]: Omit<Extract<Entry, { kind: K }>, "id"> }[Entry["kind"]]

/** One request's part. */
interface Request {
  entries: StoredEntry[]
  messages: ChatMessage[]
}

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).byteLength

/** What a chat is listed as: its first request, on one line. */
export function chatTitle(entries: Entry[]): string {
  const first = entries.find((e) => e.kind === "user")
  const line = first?.kind === "user" ? first.text.replace(/\s+/g, " ").trim() : ""
  if (!line) return "New chat"
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line
}

/** Items split where each request starts. */
function byRequest<T>(items: T[], starts: (item: T) => boolean): T[][] {
  const out: T[][] = []
  for (const item of items) {
    if (!out.length || starts(item)) out.push([])
    out[out.length - 1].push(item)
  }
  return out
}

/** A message the user typed, which starts a request (a picture `look` took is a user message too, in parts). */
const typed = (m: ChatMessage) => m.role === "user" && typeof m.content === "string"

/**
 * Every tool call with a result after it, as a provider requires. A chat saved while a turn's tools run (Sakura's
 * checkpoints, `persist` in `store/copilotStore.ts`) has calls still waiting for theirs; stored so, a tab closed then
 * would leave a chat no request could carry on.
 */
function withEveryResult(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    out.push(m)
    if (m.role !== "assistant" || !m.tool_calls?.length) continue
    const answered = new Set<string>()
    for (let next = messages[i + 1]; next?.role === "tool"; next = messages[i + 1]) {
      answered.add(next.tool_call_id)
      out.push(next)
      i++
    }
    for (const call of m.tool_calls) if (!answered.has(call.id)) out.push({ role: "tool", tool_call_id: call.id, content: UNFINISHED_RESULT })
  }
  return out
}

/** One request's messages as they are stored: no pictures, the reasoning of its last turn alone, and a result for every call. The tab's copy is left as it is. */
function storedMessages(messages: ChatMessage[]): ChatMessage[] {
  let lastAssistant = -1
  messages.forEach((m, i) => m.role === "assistant" && (lastAssistant = i))
  return withEveryResult(messages).map((m): ChatMessage => {
    if (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
      const parts: UserContentPart[] = []
      for (const part of m.content) {
        const kept = part.type === "image_url" ? { type: "text" as const, text: OMITTED } : part
        const last = parts[parts.length - 1]
        if (!(kept.type === "text" && kept.text === OMITTED && last?.type === "text" && last.text === OMITTED)) parts.push(kept)
      }
      return { role: "user", content: parts }
    }
    if (m.role === "assistant" && m.reasoning_details && m !== messages[lastAssistant]) {
      const { reasoning_details: _, ...rest } = m
      return rest
    }
    return m
  })
}

/** A chat as its file's parts, fitted to `max` bytes in all as the module's comment says. */
export function serializeChat(entries: Entry[], conversation: ChatConversation, max = MAX_CHAT_FILE_BYTES): string[] {
  const shown = byRequest(
    entries.map(({ id: _, ...entry }): StoredEntry => entry),
    (e) => e.kind === "user",
  )
  const told = byRequest(conversation.messages, typed).map(storedMessages)
  // Paired by number: a request refused before the model heard it has entries and no messages, and every part after
  // it pairs a request's entries with the next one's messages. Storage only needs the pairing to stay put, and it does.
  const requests: Request[] = Array.from({ length: Math.max(shown.length, told.length) }, (_, i) => ({ entries: shown[i] ?? [], messages: told[i] ?? [] }))
  const head = JSON.stringify({ format: CHAT_FILE_FORMAT, version: CHAT_FILE_VERSION, conversationId: conversation.id })
  const write = () => [head, ...requests.map((r) => JSON.stringify(r))]
  const parts = write()
  let over = parts.reduce((n, part) => n + bytes(part), 0) - max
  if (over <= 0) return parts

  // Counted exactly without writing the parts again: a value's JSON is the same text inside its part.
  const size = (value: unknown) => bytes(JSON.stringify(value))
  const shortened = size(TRIMMED_RESULT)
  for (const r of requests) {
    if (over <= 0) break
    r.messages = r.messages.map((m) => {
      if (over <= 0 || m.role !== "tool") return m
      const saved = size(m.content) - shortened
      if (saved <= 0) return m
      over -= saved
      return { ...m, content: TRIMMED_RESULT }
    })
  }
  for (const r of requests) {
    if (over <= 0) break
    over -= size(r.messages) - 2
    r.messages = []
  }
  for (const r of requests) {
    if (over <= 0) break
    over -= size(r.entries) - 2
    r.entries = []
  }
  return write()
}

const ENTRY_KINDS = new Set<Entry["kind"]>(["user", "assistant", "tool", "error", "plan"])
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isRequest = (v: unknown): v is { entries: unknown[]; messages: unknown[] } => isRecord(v) && Array.isArray(v.entries) && Array.isArray(v.messages)

function read(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * A chat file read back from its parts, or null when it isn't one this editor can read. Entries are numbered from 1,
 * for the store to number again as its own. What was under way when it was written (a tool call running, a plan being
 * applied) is over by now, and reads so.
 */
export function parseChat(parts: string[]): ChatContents | null {
  const [head, ...requests] = parts.map(read)
  if (!isRecord(head) || head.format !== CHAT_FILE_FORMAT || typeof head.version !== "number" || head.version > CHAT_FILE_VERSION) return null
  if (typeof head.conversationId !== "string" || !requests.every(isRequest)) return null
  const entries = requests
    .flatMap((r) => r.entries)
    .filter((e): e is StoredEntry => isRecord(e) && ENTRY_KINDS.has(e.kind as Entry["kind"]))
    .map((stored, i): Entry => {
      const e = { ...stored, id: i + 1 } as Entry
      if (e.kind === "tool" && e.status === "running") return { ...e, status: "error" }
      if (e.kind === "plan" && e.status === "applying") return { ...e, status: "cancelled" }
      return e
    })
  const messages = requests.flatMap((r) => r.messages).filter((m): m is ChatMessage => isRecord(m) && typeof m.role === "string")
  return { entries, conversation: { id: head.conversationId, messages } }
}
