/**
 * Where Sakura's chats are kept: each user's own, per project, so a past chat can be read again and carried on. The host
 * implements it, as it does `ProjectStorage`: the website's keeps them in the account, which follows the user to any device.
 * Where the host keeps none (the development harness, the tests), `memoryChats` keeps them for as long as the page is open.
 *
 * A chat is stored as a chat file (`ai/chatFile.ts`), text the editor alone reads and writes, beside its title and dates
 * for the list. A collaborator's chats on a shared project are theirs: nobody else sees them.
 */

export interface ChatSummary {
  /** The editor's id for the chat, made when its first message is sent. */
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface StoredChat extends ChatSummary {
  /** The chat file (`serializeChat`). */
  content: string
}

export interface ChatRecord {
  id: string
  title: string
  content: string
  createdAt: number
}

/** `forbidden`: the project is only shared with the user to view. `too_large`: past what a chat may be, even trimmed. */
export type ChatSaveOutcome = { ok: true; updatedAt: number } | { ok: false; reason: "not_found" | "forbidden" | "too_large" | "invalid" }

export interface ChatSource {
  /** The user's chats on a project, newest first, now and whenever they change; `null` while loading. */
  watch(projectId: string, listener: (chats: ChatSummary[] | null) => void, onError: (error: Error) => void): () => void
  /** One chat, or null when it is gone. */
  load(projectId: string, chatId: string): Promise<StoredChat | null>
  /** Write a chat whole, made or replaced. The last write wins: a chat is one person's. */
  save(projectId: string, chat: ChatRecord): Promise<ChatSaveOutcome>
  remove(projectId: string, chatId: string): Promise<void>
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
    [...of(projectId).values()].map(({ content: _, ...summary }) => summary).sort((a, b) => b.updatedAt - a.updatedAt)
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
      return of(projectId).get(chatId) ?? null
    },
    async save(projectId, chat) {
      // Never earlier than the last write, so the newest chat is first even within one millisecond.
      const previous = of(projectId).get(chat.id)
      const updatedAt = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1)
      of(projectId).set(chat.id, { ...chat, createdAt: previous?.createdAt ?? chat.createdAt, updatedAt })
      emit(projectId)
      return { ok: true, updatedAt }
    },
    async remove(projectId, chatId) {
      of(projectId).delete(chatId)
      emit(projectId)
    },
  }
}
