/**
 * Where Sakura's chats are kept: each user's own, per project, so a past chat can be read again and carried on. The host
 * implements it, as it does `ProjectStorage`: the website's keeps them in the account, which follows the user to any device.
 * Where the host keeps none (the development harness, the tests), `memoryChats` keeps them for as long as the page is open.
 *
 * A chat is stored as a chat file (`ai/chatFile.ts`), text the editor alone reads and writes, in parts, beside its title
 * and dates for the list. A save sends only the parts that changed since the tab last saved or read the chat, on top of
 * what storage had then (`ChatWrite.base`). A collaborator's chats on a shared project are theirs: nobody else sees them.
 */

export interface ChatSummary {
  /** The editor's id for the chat, made when its first message is sent. */
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface StoredChat extends ChatSummary {
  /** The chat file's parts, in order (`serializeChat`). */
  parts: string[]
}

/** A part of a chat file, by its place in the file. */
export interface ChatPart {
  index: number
  content: string
}

/** A save of a chat: the parts that changed since `base`, or all of them. */
export interface ChatWrite {
  id: string
  title: string
  createdAt: number
  /** The chat's `updatedAt` as this tab last saved or read it, which the parts go on top of. Null to write the chat whole. */
  base: number | null
  /** How many parts the chat has: storage drops any past them. */
  count: number
  /** The parts that changed since `base`, and every part storage doesn't have yet. All `count` of them when `base` is null. */
  parts: ChatPart[]
}

/**
 * `stale`: the chat isn't at `base` any more (another tab or device carried it on, or deleted it): write it whole, and
 * the last write wins, as a chat is one person's. `forbidden`: the project is only shared with the user to view.
 * `too_large`: past what a chat may be, even trimmed. `invalid`: parts numbered wrong.
 */
export type ChatSaveOutcome = { ok: true; updatedAt: number } | { ok: false; reason: "not_found" | "forbidden" | "too_large" | "invalid" | "stale" }

export interface ChatSource {
  /** The user's chats on a project, newest first, now and whenever they change; `null` while loading. */
  watch(projectId: string, listener: (chats: ChatSummary[] | null) => void, onError: (error: Error) => void): () => void
  /** One chat, or null when it is gone. */
  load(projectId: string, chatId: string): Promise<StoredChat | null>
  save(projectId: string, chat: ChatWrite): Promise<ChatSaveOutcome>
  remove(projectId: string, chatId: string): Promise<void>
}

/** The chat a write makes of what storage has (`stored`, at `base`), or null when its parts are numbered wrong. */
export function applyChatWrite(stored: string[] | null, write: ChatWrite): string[] | null {
  if (!Number.isInteger(write.count) || write.count < 1) return null
  const parts = write.base === null || !stored ? [] : stored.slice(0, write.count)
  for (const { index, content } of write.parts) {
    if (!Number.isInteger(index) || index < 0 || index >= write.count) return null
    parts[index] = content
  }
  for (let i = 0; i < write.count; i++) if (typeof parts[i] !== "string") return null
  return parts
}

/** Chats kept in this page alone, for a host that keeps none. */
export function memoryChats(): ChatSource {
  const chats = new Map<string, Map<string, StoredChat>>()
  const listeners = new Map<string, Set<(chats: ChatSummary[]) => void>>()
  const of = (projectId: string) => {
    let project = chats.get(projectId)
    if (!project) chats.set(projectId, (project = new Map()))
    return project
  }
  const list = (projectId: string): ChatSummary[] =>
    [...of(projectId).values()].map(({ parts: _, ...summary }) => summary).sort((a, b) => b.updatedAt - a.updatedAt)
  const emit = (projectId: string) => listeners.get(projectId)?.forEach((listener) => listener(list(projectId)))
  return {
    watch(projectId, listener) {
      let set = listeners.get(projectId)
      if (!set) listeners.set(projectId, (set = new Set()))
      set.add(listener)
      listener(list(projectId))
      return () => void set.delete(listener)
    },
    async load(projectId, chatId) {
      const chat = of(projectId).get(chatId)
      return chat ? { ...chat, parts: [...chat.parts] } : null
    },
    async save(projectId, chat) {
      const previous = of(projectId).get(chat.id)
      if (chat.base !== null && previous?.updatedAt !== chat.base) return { ok: false, reason: "stale" }
      const parts = applyChatWrite(previous?.parts ?? null, chat)
      if (!parts) return { ok: false, reason: "invalid" }
      // Never earlier than the last write, so the newest chat is first even within one millisecond.
      const updatedAt = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1)
      of(projectId).set(chat.id, { id: chat.id, title: chat.title, createdAt: previous?.createdAt ?? chat.createdAt, updatedAt, parts })
      emit(projectId)
      return { ok: true, updatedAt }
    },
    async remove(projectId, chatId) {
      of(projectId).delete(chatId)
      emit(projectId)
    },
  }
}
