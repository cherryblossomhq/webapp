import { create } from "zustand"
import { applySession, CLEANUP_APPLY_PROMPT, CLEANUP_PROMPT, CLEANUP_REQUEST, checkPlan, loosePartRefs, planningSession, type ProposedPlan } from "../ai/cleanupAi"
import { chatTitle, parseChat, serializeChat } from "../ai/chatFile"
import { clearHistory, conversationOf, restoreConversation, runCopilot, type CopilotEvent } from "../ai/copilot"
import type { FailureKind } from "../ai/managedAi"
import type { LimitOffer } from "./accountStore"
import { openCleanup } from "../editor/schematic/cleanupAction"
import { hasParts } from "../model/cleanup"
import { announceTidy } from "../editor/schematic/tidyAction"
import { toolActivityLabel, toolPhase } from "../ai/tools"
import { acquireBoard, type BoardLease } from "./boardLease"
import { memoryChats, type ChatSource, type ChatSummary } from "./chats"
import { projectStorage, useProjectStore } from "./projectStore"
import { useUi } from "./uiStore"

export type Entry =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool"; id: number; toolId: string; label: string; status: "running" | "ok" | "error"; changed: boolean }
  /** `offer`: what a plan limit's refusal offered when it happened (Ultra, pay-as-you-go). */
  | { kind: "error"; id: number; text: string; failure?: FailureKind; offer?: LimitOffer }
  /** The blocks Clean up with AI proposes, waiting for the user's word. */
  | { kind: "plan"; id: number; plan: ProposedPlan; status: PlanStatus }

/** Where a plan is: waiting, being applied, done, turned down, or out of date (the sheet or the conversation moved on). */
export type PlanStatus = "pending" | "applying" | "applied" | "cancelled" | "stale"

/** A chat opened in this tab: what the panel shows of it, and how it stands with storage. */
export interface ChatThread {
  projectId: string
  entries: Entry[]
  createdAt: number
  /** Storage's `updatedAt` for the chat as this tab has it; null until it is first stored. */
  savedAt: number | null
  /** The chat file's parts as storage has them at `savedAt`: what the next save leaves out. Null until it is first stored. */
  stored: string[] | null
}

interface CopilotState {
  /** The chats opened in this tab, by chat id. */
  threads: Record<string, ChatThread>
  /** The chat each project's panel shows, by project id. None is a new chat, made by its first message. */
  active: Record<string, string>
  /** The user's chats on each project, newest first, as storage lists them (`watchChats`); null while loading. */
  chats: Record<string, ChatSummary[] | null>
  /** A chat being read from storage to be shown. */
  opening: string | null
  runningProject: string | null
  /** The chat the running request belongs to: its events land there whichever chat is shown. */
  runningChat: string | null
  /** What Sakura is doing in a word or two while it runs ("Routing", "Thinking"): what collaborators see beside this user. Null when idle. */
  activity: string | null
  controller: AbortController | null
  /** Text to start a project's composer with, once: a request handed over from the website's hero. */
  seeds: Record<string, string>
  seed: (projectId: string, text: string) => void
  /** Clear a project's seed once its composer has it. */
  takeSeed: (projectId: string) => void
  /** Which step of Clean up with AI is running, if one is. */
  cleanup: "planning" | "applying" | null
  send: (projectId: string, text: string) => void
  /** Clean up with AI: Sakura proposes blocks and the panel asks for the user's word (`applyPlan`). */
  startCleanup: (projectId: string) => void
  /** The user confirmed a plan: group, tidy the whole sheet, report. */
  applyPlan: (projectId: string, entryId: number) => void
  cancelPlan: (projectId: string, entryId: number) => void
  stop: () => void
  /** Show a new chat on a project. The one shown before stays in the history. */
  newChat: (projectId: string) => void
  /** Show one of a project's chats, read from storage unless this tab has it. Says why when it can't. */
  openChat: (projectId: string, chatId: string) => Promise<string | null>
  deleteChat: (projectId: string, chatId: string) => Promise<void>
  /** Follow the list of a project's chats while the panel shows it. */
  watchChats: (projectId: string) => () => void
}

let nextEntryId = 1

/** Where chats are kept when the host keeps none (the harness, the tests): this page, until it closes. */
const pageChats = memoryChats()
const chatSource = (): ChatSource => projectStorage()?.chats ?? pageChats

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record
  const { [key]: _, ...rest } = record
  return rest
}

/** What a project's panel shows: the entries of its active chat. */
export function activeEntries(state: Pick<CopilotState, "active" | "threads">, projectId: string): Entry[] | undefined {
  const chatId = state.active[projectId]
  return chatId ? state.threads[chatId]?.entries : undefined
}

/** Saves of each chat, one after another, so an older one never lands last. */
const saving = new Map<string, Promise<void>>()

/**
 * While Sakura works, the chat is saved again at the first tool call to end this long after its last save: a request
 * can run for minutes, editing the project as it goes, and a tab closed or crashed meanwhile would otherwise keep only
 * the message that started it. Each such save rewrites the request's own part alone.
 */
export const CHECKPOINT_MS = 15_000

/** When each chat was last saved, for `CHECKPOINT_MS`. */
const lastSaved = new Map<string, number>()

/** Every chat save under way, for the tests. */
export const chatSaves = () => Promise.all(saving.values())

/** A plan still waiting when something else is said is out of date: it was made for a conversation that has moved on. */
const staleAll = (entries: Entry[]): Entry[] => entries.map((e) => (e.kind === "plan" && e.status === "pending" ? { ...e, status: "stale" } : e))

export const useCopilot = create<CopilotState>((set, get) => {
  const update = (chatId: string, fn: (entries: Entry[]) => Entry[]) =>
    set((s) => {
      const thread = s.threads[chatId]
      return thread ? { threads: { ...s.threads, [chatId]: { ...thread, entries: fn(thread.entries) } } } : {}
    })

  /** The chat a project's panel shows, made now when it shows a new one. */
  const ensureChat = (projectId: string): string => {
    const shown = get().active[projectId]
    if (shown && get().threads[shown]) return shown
    const chatId = crypto.randomUUID()
    set((s) => ({
      active: { ...s.active, [projectId]: chatId },
      threads: { ...s.threads, [chatId]: { projectId, entries: [], createdAt: Date.now(), savedAt: null, stored: null } },
    }))
    return chatId
  }

  /** Whether the chat a project's panel shows is still being read: nothing is sent to it until it is. Another chat being read meanwhile doesn't hold the one shown up. */
  const openingShown = (projectId: string) => {
    const { opening, active } = get()
    return opening !== null && active[projectId] === opening
  }

  /** The chat that holds an entry: entry ids are this tab's, never reused. */
  const chatWith = (entryId: number) => Object.keys(get().threads).find((id) => get().threads[id].entries.some((e) => e.id === entryId)) ?? null

  /**
   * Store a chat as it is now, once it has a request in it: the parts of its file that changed since storage last had
   * it, which carrying a chat on keeps to the request added. The whole chat when this tab doesn't know what storage has,
   * or storage has moved on (`stale`). Best effort: a chat that doesn't store stays in this tab.
   */
  const persist = (chatId: string): Promise<void> => {
    lastSaved.set(chatId, Date.now())
    const write = async () => {
      const thread = get().threads[chatId]
      if (!thread || !thread.entries.some((e) => e.kind === "user")) return
      const parts = serializeChat(thread.entries, conversationOf(chatId) ?? { id: chatId, messages: [] })
      const had = thread.savedAt !== null ? thread.stored : null
      if (had && had.length === parts.length && parts.every((part, i) => part === had[i])) return
      const save = (base: number | null, under: string[]) =>
        chatSource().save(thread.projectId, {
          id: chatId,
          title: chatTitle(thread.entries),
          createdAt: thread.createdAt,
          base,
          count: parts.length,
          parts: parts.flatMap((content, index) => (content === under[index] ? [] : [{ index, content }])),
        })
      let outcome = had ? await save(thread.savedAt, had) : await save(null, [])
      if (!outcome.ok && outcome.reason === "stale" && had) outcome = await save(null, [])
      if (!outcome.ok) return
      const { updatedAt } = outcome
      set((s) => (s.threads[chatId] ? { threads: { ...s.threads, [chatId]: { ...s.threads[chatId], savedAt: updatedAt, stored: parts } } } : {}))
    }
    const next = (saving.get(chatId) ?? Promise.resolve()).then(write).catch(() => {})
    saving.set(chatId, next)
    void next.then(() => saving.get(chatId) === next && saving.delete(chatId))
    return next
  }

  const apply = (chatId: string, e: CopilotEvent) => {
    switch (e.type) {
      case "text":
        update(chatId, (entries) => {
          const last = entries[entries.length - 1]
          if (last?.kind === "assistant") return [...entries.slice(0, -1), { ...last, text: last.text + e.delta }]
          return [...entries, { kind: "assistant", id: nextEntryId++, text: e.delta }]
        })
        break
      case "tool_start":
        update(chatId, (entries) => [
          ...entries,
          { kind: "tool", id: nextEntryId++, toolId: e.id, label: toolActivityLabel(e.name, e.input), status: "running", changed: false },
        ])
        set({ activity: toolPhase(e.name) })
        break
      case "tool_end":
        update(chatId, (entries) =>
          entries.map((x) =>
            x.kind === "tool" && x.toolId === e.id
              ? { ...x, label: e.summary, status: e.isError ? "error" : "ok", changed: e.changed }
              : x,
          ),
        )
        set({ activity: "Thinking" })
        if (Date.now() - (lastSaved.get(chatId) ?? 0) >= CHECKPOINT_MS) void persist(chatId)
        break
      case "error":
        update(chatId, (entries) => [...entries, { kind: "error", id: nextEntryId++, text: e.message, failure: e.kind, ...(e.offer && { offer: e.offer }) }])
        break
      case "done":
        set({ runningProject: null, runningChat: null, controller: null, activity: null })
        void persist(chatId)
        break
    }
  }

  return {
    threads: {},
    active: {},
    chats: {},
    opening: null,
    runningProject: null,
    runningChat: null,
    activity: null,
    controller: null,
    seeds: {},
    cleanup: null,
    seed: (projectId, text) => set((s) => ({ seeds: { ...s.seeds, [projectId]: text } })),
    takeSeed: (projectId) => {
      if (!(projectId in get().seeds)) return
      set((s) => ({ seeds: Object.fromEntries(Object.entries(s.seeds).filter(([id]) => id !== projectId)) }))
    },
    send: (projectId, text) => {
      if (get().runningProject || openingShown(projectId)) return
      const chatId = ensureChat(projectId)
      const controller = new AbortController()
      update(chatId, (entries) => [...staleAll(entries), { kind: "user", id: nextEntryId++, text }])
      set({ runningProject: projectId, runningChat: chatId, controller, activity: "Thinking" })
      // Listed at once, under its first request, and kept should the tab close before Sakura is done.
      void persist(chatId)
      void runCopilot(text, { signal: controller.signal, onEvent: (e) => apply(chatId, e), chat: chatId })
    },
    startCleanup: (projectId) => {
      if (get().runningProject || openingShown(projectId)) return
      const chatId = ensureChat(projectId)
      const open = useProjectStore.getState().project
      if (open?.id === projectId && !loosePartRefs(open).length) {
        // Nothing to propose. With parts, all in blocks already, the free flow's own question is asked
        // (tidy the sheet?); with none there is nothing to do.
        const parts = hasParts(open)
        update(chatId, (entries) => [
          ...staleAll(entries),
          { kind: "user", id: nextEntryId++, text: CLEANUP_REQUEST },
          {
            kind: "assistant",
            id: nextEntryId++,
            text: parts
              ? "Every part is already in a block, so there is nothing to group. The toolbar asks whether to tidy the sheet."
              : "There are no parts on the sheet yet, so there is nothing to clean up.",
          },
        ])
        if (parts) openCleanup()
        void persist(chatId)
        return
      }
      const controller = new AbortController()
      const session = planningSession()
      update(chatId, (entries) => [...staleAll(entries), { kind: "user", id: nextEntryId++, text: CLEANUP_REQUEST }])
      set({ runningProject: projectId, runningChat: chatId, controller, cleanup: "planning", activity: "Planning blocks" })
      void persist(chatId)
      void runCopilot(CLEANUP_PROMPT, { signal: controller.signal, onEvent: (e) => apply(chatId, e), tools: session.tools, chat: chatId }).then(() => {
        const plan = session.plan()
        if (plan && !controller.signal.aborted) update(chatId, (entries) => [...entries, { kind: "plan", id: nextEntryId++, plan, status: "pending" }])
        set({ cleanup: null })
        void persist(chatId)
      })
    },
    applyPlan: (projectId, entryId) => {
      if (get().runningProject) return
      const chatId = chatWith(entryId)
      const entry = chatId ? get().threads[chatId].entries.find((e) => e.kind === "plan" && e.id === entryId) : undefined
      const project = useProjectStore.getState().project
      // A chat being read again from storage is replaced when it comes, run and all.
      if (!chatId || get().opening === chatId || entry?.kind !== "plan" || entry.status !== "pending" || project?.id !== projectId) return
      const setStatus = (status: PlanStatus) =>
        update(chatId, (entries) => entries.map((e) => (e.kind === "plan" && e.id === entryId ? { ...e, status } : e)))
      // The sheet may have been edited since the plan was made: it is checked again before anything runs.
      const checked = checkPlan(project, { blocks: entry.plan.blocks.map((b) => ({ name: b.name, refs: b.refs })) })
      if (!("plan" in checked) || checked.plan.blocks.length !== entry.plan.blocks.length) {
        setStatus("stale")
        update(chatId, (entries) => [...entries, { kind: "error", id: nextEntryId++, text: "The sheet changed since this plan was made. Run Clean up with AI again." }])
        void persist(chatId)
        return
      }
      const controller = new AbortController()
      const session = applySession(entry.plan)
      let failed = false
      setStatus("applying")
      const applyId = nextEntryId
      update(chatId, (entries) => [...entries, { kind: "user", id: nextEntryId++, text: "Apply the plan" }])
      set({ runningProject: projectId, runningChat: chatId, controller, cleanup: "applying", activity: "Tidying" })
      // Tidying the whole sheet is a whole-board action: held under the board lease from here to the end.
      const begin = (lease: BoardLease) => {
        if (!lease.ok) {
          setStatus("cancelled")
          update(chatId, (entries) => [...entries, { kind: "error", id: nextEntryId++, text: lease.message }])
          set({ runningProject: null, runningChat: null, controller: null, cleanup: null, activity: null })
          void persist(chatId)
          return
        }
        void runCopilot(CLEANUP_APPLY_PROMPT, {
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === "error") failed = true
            apply(chatId, e)
          },
          tools: session.tools,
          chat: chatId,
        }).then(() => {
          setStatus(failed || controller.signal.aborted ? "cancelled" : "applied")
          // Nothing was kept, so the chat must not say it was: Sakura's report is dropped (the panel's line says what happened) and her steps show as not kept.
          if (failed || controller.signal.aborted) {
            update(chatId, (entries) =>
              entries.flatMap((e): Entry[] =>
                e.id <= applyId ? [e] : e.kind === "assistant" ? [] : e.kind === "tool" ? [{ ...e, status: "error", changed: false, label: `Not kept: ${e.label}` }] : [e],
              ),
            )
          }
          set({ cleanup: null })
          void persist(chatId)
          // The sheet is new: the toolbar says so and the view shows all of it.
          const now = useProjectStore.getState().project
          if (now && !failed && !controller.signal.aborted && now !== project) {
            announceTidy({ project: now, changed: true, ok: true, message: "Cleaned up with Sakura.", renamed: {}, dropped: [], loose: { wires: 0, labels: 0, ports: 0 }, problems: [] })
          }
        }).finally(lease.release)
      }
      const leased = acquireBoard("cleanup", true)
      if (leased instanceof Promise) void leased.then(begin)
      else begin(leased)
    },
    cancelPlan: (_projectId, entryId) => {
      const chatId = chatWith(entryId)
      if (!chatId || get().opening === chatId) return
      update(chatId, (entries) => entries.map((e) => (e.kind === "plan" && e.id === entryId && e.status === "pending" ? { ...e, status: "cancelled" } : e)))
      void persist(chatId)
    },
    stop: () => get().controller?.abort(),
    newChat: (projectId) => {
      const shown = get().active[projectId]
      // A chat nothing was said in is never listed: it goes rather than lingering in the tab.
      const unused = shown && !get().threads[shown]?.entries.length && get().runningChat !== shown
      set((s) => ({ active: without(s.active, projectId), threads: unused ? without(s.threads, shown) : s.threads }))
    },
    openChat: async (projectId, chatId) => {
      const have = get().threads[chatId]
      const listed = get().chats[projectId]?.find((c) => c.id === chatId)
      // Carried on in another tab or on another device since this tab last had it: read again, unless it runs here.
      const behind = !!have && !!listed && have.savedAt !== null && listed.updatedAt > have.savedAt && get().runningChat !== chatId
      if (have && !behind) {
        set((s) => ({ active: { ...s.active, [projectId]: chatId } }))
        return null
      }
      set((s) => ({ active: { ...s.active, [projectId]: chatId }, opening: chatId }))
      const done = (thread: ChatThread | null) =>
        set((s) => ({
          opening: s.opening === chatId ? null : s.opening,
          threads: thread ? { ...s.threads, [chatId]: thread } : s.threads,
          // Not opened: the panel goes back to a new chat, unless another was picked meanwhile.
          active: !thread && s.active[projectId] === chatId && !s.threads[chatId] ? without(s.active, projectId) : s.active,
        }))
      try {
        const stored = await chatSource().load(projectId, chatId)
        const contents = stored && parseChat(stored.parts)
        if (!stored || !contents) {
          done(null)
          return stored ? "This chat can't be read here. Reload the page to get the latest editor." : "That chat is gone."
        }
        restoreConversation(chatId, contents.conversation)
        // Numbered again: entry ids are this tab's own.
        const entries = contents.entries.map((e) => ({ ...e, id: nextEntryId++ }))
        done({ projectId, entries, createdAt: stored.createdAt, savedAt: stored.updatedAt, stored: stored.parts })
        return null
      } catch {
        done(null)
        return "Couldn't open that chat. Check the connection and try again."
      }
    },
    deleteChat: async (projectId, chatId) => {
      if (get().runningChat === chatId) return
      clearHistory(chatId)
      lastSaved.delete(chatId)
      set((s) => ({
        threads: without(s.threads, chatId),
        active: s.active[projectId] === chatId ? without(s.active, projectId) : s.active,
        chats: { ...s.chats, [projectId]: s.chats[projectId]?.filter((c) => c.id !== chatId) ?? null },
      }))
      // A save under way would bring it back.
      await saving.get(chatId)
      await chatSource().remove(projectId, chatId)
    },
    watchChats: (projectId) =>
      chatSource().watch(
        projectId,
        (chats) => set((s) => ({ chats: { ...s.chats, [projectId]: chats } })),
        // The list stays as it was; the chats in this tab work regardless.
        () => set((s) => ({ chats: { ...s.chats, [projectId]: s.chats[projectId] ?? [] } })),
      ),
  }
})

/** Show the copilot and send it a request for the open project. False when it is busy. */
export function askCopilot(text: string): boolean {
  const projectId = useProjectStore.getState().project?.id
  const { runningProject, opening, active } = useCopilot.getState()
  if (!projectId || runningProject || (opening !== null && active[projectId] === opening)) return false
  useUi.getState().setCopilotOpen(true)
  useCopilot.getState().send(projectId, text)
  return true
}
