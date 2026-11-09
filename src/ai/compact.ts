import type { ChatMessage } from "./managedAi"

// Keeping a long chat affordable. Every round of the tool loop sends the whole conversation, and
// nothing ever left it but pictures: in production (October to November 2026) Sakura's prompts
// averaged 145k tokens and reached 657k, 89% of what it cost was input, most of
// it old `get_design` answers (8k characters each, up to 43k) sent again on every round for the rest of the chat.
//
// So, at the start of a request, results of tools that only read are left out once newer requests
// have come since (the model reads the design again when it needs it, as the guide says), and long
// results of the others are cut to their first lines. Never within a request: its rounds keep the
// history byte for byte, so the provider's prompt cache holds. And only when that cache has gone
// cold anyway (the chat was quiet longer than the provider keeps it) or the history is past a size no
// cache makes cheap, since changing an old message means the whole history is written again.

/** Tools whose results only describe the project or the world as it was: a newer read replaces them. */
const READS = new Set([
  "get_design",
  "get_wiring",
  "run_checks",
  "look",
  "search_parts",
  "find_part",
  "get_part_data",
  "read_datasheet",
  "read_web_page",
  "web_search",
  "list_versions",
  "verify_parts",
])

/** Requests at the end of the history whose tool results are kept whole. */
export const KEEP_REQUESTS = 2
/** A read's result shorter than this is kept: leaving it out saves nothing. */
const SMALL_READ = 600
/** Another tool's result is cut to this many characters past this size. */
const LONG_RESULT = 2_000
const CUT_TO = 700

/** How long the provider keeps a prompt cache (Anthropic's is 5 minutes): a chat quiet longer is written again whole anyway. */
export const CACHE_COLD_MS = 4.5 * 60_000
/** Past this many characters of history (about 140k tokens) the chat is compacted however warm its cache. */
export const COMPACT_ABOVE_CHARS = 480_000

const leftOut = (name: string) => `[An earlier ${name} result, left out to keep the chat small. Call ${name} again if you need what it said now.]`

/** Characters a message costs, roughly: its text, its tool calls' arguments, and a picture as its data. */
export function messageChars(m: ChatMessage): number {
  if (m.role === "tool") return m.content.length
  if (m.role === "assistant") return (m.content?.length ?? 0) + (m.tool_calls ?? []).reduce((n, c) => n + c.function.arguments.length, 0)
  if (typeof m.content === "string") return m.content.length
  return m.content.reduce((n, p) => n + ("text" in p ? p.text.length : 1_000), 0)
}

export const historyChars = (messages: readonly ChatMessage[]) => messages.reduce((n, m) => n + messageChars(m), 0)

/** Whether to compact before a request: the cache has expired since the last one ended, or the history is too big to resend as it is. */
export function shouldCompact(messages: readonly ChatMessage[], lastEndedAt: number | undefined, now = Date.now()): boolean {
  if (historyChars(messages) > COMPACT_ABOVE_CHARS) return true
  return lastEndedAt === undefined || now - lastEndedAt > CACHE_COLD_MS
}

/**
 * The history with what older requests' tools said made small: a read's result left out, another
 * tool's long result cut. The last `keep` requests (from their user message on) are kept whole, and
 * every tool call keeps a result, so the conversation stays valid. Returns the same array when
 * nothing changed.
 */
export function compactHistory(messages: ChatMessage[], keep = KEEP_REQUESTS): { messages: ChatMessage[]; saved: number } {
  // Where the kept requests start: the `keep`-th user message from the end that isn't a picture or an editor note.
  let starts = 0
  let boundary = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("Editor note")) {
      starts++
      boundary = i
      if (starts >= keep) break
    }
  }
  if (starts < keep) return { messages, saved: 0 }
  const names = new Map<string, string>()
  for (const m of messages) if (m.role === "assistant") for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name)
  let saved = 0
  const out = messages.map((m, i) => {
    if (i >= boundary || m.role !== "tool" || m.content.startsWith("[An earlier ")) return m
    const name = names.get(m.tool_call_id) ?? "tool"
    if (READS.has(name) && m.content.length > SMALL_READ) {
      const content = leftOut(name)
      saved += m.content.length - content.length
      return { ...m, content }
    }
    if (m.content.length > LONG_RESULT) {
      const cut = m.content.lastIndexOf(" ", CUT_TO)
      const content = `${m.content.slice(0, cut > CUT_TO / 2 ? cut : CUT_TO)} [... the rest of this result left out to keep the chat small]`
      saved += m.content.length - content.length
      return { ...m, content }
    }
    return m
  })
  return saved > 0 ? { messages: out, saved } : { messages, saved: 0 }
}
