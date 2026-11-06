import type { Entry } from "../store/copilotStore"
import type { ChatMessage, UserContentPart } from "./managedAi"
import { OMITTED } from "./vision/messages"

/**
 * A Sakura chat as it is stored (`store/chats.ts`): what the panel shows (`entries`) and what the model was told
 * (`messages`, with the conversation's id), so a chat opened again reads as it did and carries on where it stopped.
 * `{ "format": "cherryblossom.chat", "version", "conversationId", "entries", "messages" }`, JSON. Storage keeps it as
 * text and never reads it, as it keeps a project file.
 *
 * What is stored is less than the tab held:
 * - **No pictures.** A `look` picture is a base64 PNG of up to 640 KB, and a chat carried on later takes a new one
 *   anyway. Each becomes the line an old picture becomes in the conversation (`OMITTED`).
 * - **No reasoning but the last turn's.** A provider needs the thinking of the turn a tool loop is in (a stopped
 *   request's), not of turns that ended.
 * - **At most `MAX_CHAT_FILE_BYTES`.** Past it, the oldest tool results are shortened to a line, then the oldest
 *   requests leave what the model is told (the panel still shows them), then the oldest of what the panel shows goes.
 *   Every tool call keeps a result, so the conversation stays one a provider takes.
 */

export const CHAT_FILE_FORMAT = "cherryblossom.chat"
export const CHAT_FILE_VERSION = 1

/** The bytes of a chat file's JSON: under the account's cap (the hosted app's `MAX_CHAT_BYTES`), with room. */
export const MAX_CHAT_FILE_BYTES = 2_000_000

/** What a tool result shortened to fit says, to the model reading the chat later. */
export const TRIMMED_RESULT = "[This result was left out of the saved chat to save space. Call the tool again if you need it.]"

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

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).byteLength

/** What a chat is listed as: its first request, on one line. */
export function chatTitle(entries: Entry[]): string {
  const first = entries.find((e) => e.kind === "user")
  const line = first?.kind === "user" ? first.text.replace(/\s+/g, " ").trim() : ""
  if (!line) return "New chat"
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line
}

/** The conversation as it is stored: no pictures, and the reasoning of the last turn alone. The tab's copy is left as it is. */
function storedMessages(messages: ChatMessage[]): ChatMessage[] {
  let lastAssistant = -1
  messages.forEach((m, i) => m.role === "assistant" && (lastAssistant = i))
  return messages.map((m, i): ChatMessage => {
    if (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
      const parts: UserContentPart[] = []
      for (const part of m.content) {
        const kept = part.type === "image_url" ? { type: "text" as const, text: OMITTED } : part
        const last = parts[parts.length - 1]
        if (!(kept.type === "text" && kept.text === OMITTED && last?.type === "text" && last.text === OMITTED)) parts.push(kept)
      }
      return { role: "user", content: parts }
    }
    if (m.role === "assistant" && m.reasoning_details && i !== lastAssistant) {
      const { reasoning_details: _, ...rest } = m
      return rest
    }
    return m
  })
}

/** Where the request after the first starts: the next message the user typed. -1 when the first is the only one. */
function nextRequest(messages: ChatMessage[]): number {
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === "user" && typeof m.content === "string") return i
  }
  return -1
}

/** A chat as its file, fitted to `max` bytes as the module's comment says. */
export function serializeChat(entries: Entry[], conversation: ChatConversation, max = MAX_CHAT_FILE_BYTES): string {
  let messages = storedMessages(conversation.messages)
  let shown = entries
  const write = () => JSON.stringify({ format: CHAT_FILE_FORMAT, version: CHAT_FILE_VERSION, conversationId: conversation.id, entries: shown, messages })
  let text = write()
  let over = bytes(text) - max
  if (over <= 0) return text

  // Sizes counted once and kept up to date, rather than the whole chat written again after every cut.
  const size = (value: unknown) => bytes(JSON.stringify(value)) + 1
  const shortened = size(TRIMMED_RESULT)
  messages = messages.map((m) => {
    if (over <= 0 || m.role !== "tool") return m
    const saved = size(m.content) - shortened
    if (saved <= 0) return m
    over -= saved
    return { ...m, content: TRIMMED_RESULT }
  })
  while (over > 0 && messages.length) {
    const cut = nextRequest(messages)
    const dropped = cut === -1 ? messages : messages.slice(0, cut)
    over -= dropped.reduce((n, m) => n + size(m), 0)
    messages = cut === -1 ? [] : messages.slice(cut)
  }
  let first = 0
  while (over > 0 && first < shown.length) over -= size(shown[first++])
  shown = shown.slice(first)
  text = write()
  // Counted rather than measured: what is left over is what the count missed (separators), taken from what is shown.
  while (bytes(text) > max && shown.length) {
    shown = shown.slice(Math.max(1, Math.ceil(shown.length / 10)))
    text = write()
  }
  return text
}

const ENTRY_KINDS = new Set<Entry["kind"]>(["user", "assistant", "tool", "error", "plan"])
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * A chat file read back, or null when it isn't one this editor can read. What was under way when it was written (a
 * tool call running, a plan being applied) is over by now, and reads so.
 */
export function parseChat(text: string): ChatContents | null {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(file) || file.format !== CHAT_FILE_FORMAT || typeof file.version !== "number" || file.version > CHAT_FILE_VERSION) return null
  if (typeof file.conversationId !== "string" || !Array.isArray(file.entries) || !Array.isArray(file.messages)) return null
  const entries = file.entries
    .filter((e): e is Entry => isRecord(e) && ENTRY_KINDS.has(e.kind as Entry["kind"]))
    .map((e): Entry => {
      if (e.kind === "tool" && e.status === "running") return { ...e, status: "error" }
      if (e.kind === "plan" && e.status === "applying") return { ...e, status: "cancelled" }
      return e
    })
  const messages = file.messages.filter((m): m is ChatMessage => isRecord(m) && typeof m.role === "string")
  return { entries, conversation: { id: file.conversationId, messages } }
}
