import { create } from "zustand"
import { applySession, CLEANUP_APPLY_PROMPT, CLEANUP_PROMPT, CLEANUP_REQUEST, checkPlan, loosePartRefs, planningSession, type ProposedPlan } from "../ai/cleanupAi"
import { clearHistory, runCopilot, type CopilotEvent } from "../ai/copilot"
import type { FailureKind } from "../ai/managedAi"
import { openCleanup } from "../editor/schematic/cleanupAction"
import { hasParts } from "../model/cleanup"
import { announceTidy } from "../editor/schematic/tidyAction"
import { toolActivityLabel, toolPhase } from "../ai/tools"
import { acquireBoard, type BoardLease } from "./boardLease"
import { useProjectStore } from "./projectStore"
import { useUi } from "./uiStore"

export type Entry =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool"; id: number; toolId: string; label: string; status: "running" | "ok" | "error"; changed: boolean }
  | { kind: "error"; id: number; text: string; failure?: FailureKind }
  /** The blocks Clean up with AI proposes, waiting for the user's word. */
  | { kind: "plan"; id: number; plan: ProposedPlan; status: PlanStatus }

/** Where a plan is: waiting, being applied, done, turned down, or out of date (the sheet or the conversation moved on). */
export type PlanStatus = "pending" | "applying" | "applied" | "cancelled" | "stale"

interface CopilotState {
  threads: Record<string, Entry[]>
  runningProject: string | null
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
  clear: (projectId: string) => void
}

let nextEntryId = 1

/** A plan still waiting when something else is said is out of date: it was made for a conversation that has moved on. */
const staleAll = (entries: Entry[]): Entry[] => entries.map((e) => (e.kind === "plan" && e.status === "pending" ? { ...e, status: "stale" } : e))

export const useCopilot = create<CopilotState>((set, get) => {
  const update = (projectId: string, fn: (entries: Entry[]) => Entry[]) =>
    set((s) => ({ threads: { ...s.threads, [projectId]: fn(s.threads[projectId] ?? []) } }))

  const apply = (projectId: string, e: CopilotEvent) => {
    switch (e.type) {
      case "text":
        update(projectId, (entries) => {
          const last = entries[entries.length - 1]
          if (last?.kind === "assistant") return [...entries.slice(0, -1), { ...last, text: last.text + e.delta }]
          return [...entries, { kind: "assistant", id: nextEntryId++, text: e.delta }]
        })
        break
      case "tool_start":
        update(projectId, (entries) => [
          ...entries,
          { kind: "tool", id: nextEntryId++, toolId: e.id, label: toolActivityLabel(e.name, e.input), status: "running", changed: false },
        ])
        set({ activity: toolPhase(e.name) })
        break
      case "tool_end":
        update(projectId, (entries) =>
          entries.map((x) =>
            x.kind === "tool" && x.toolId === e.id
              ? { ...x, label: e.summary, status: e.isError ? "error" : "ok", changed: e.changed }
              : x,
          ),
        )
        set({ activity: "Thinking" })
        break
      case "error":
        update(projectId, (entries) => [...entries, { kind: "error", id: nextEntryId++, text: e.message, failure: e.kind }])
        break
      case "done":
        set({ runningProject: null, controller: null, activity: null })
        break
    }
  }

  return {
    threads: {},
    runningProject: null,
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
      if (get().runningProject) return
      const controller = new AbortController()
      update(projectId, (entries) => [...staleAll(entries), { kind: "user", id: nextEntryId++, text }])
      set({ runningProject: projectId, controller, activity: "Thinking" })
      void runCopilot(text, { signal: controller.signal, onEvent: (e) => apply(projectId, e) })
    },
    startCleanup: (projectId) => {
      if (get().runningProject) return
      const open = useProjectStore.getState().project
      if (open?.id === projectId && !loosePartRefs(open).length) {
        // Nothing to propose. With parts, all in blocks already, the free flow's own question is asked
        // (tidy the sheet?); with none there is nothing to do.
        const parts = hasParts(open)
        update(projectId, (entries) => [
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
        return
      }
      const controller = new AbortController()
      const session = planningSession()
      update(projectId, (entries) => [...staleAll(entries), { kind: "user", id: nextEntryId++, text: CLEANUP_REQUEST }])
      set({ runningProject: projectId, controller, cleanup: "planning", activity: "Planning blocks" })
      void runCopilot(CLEANUP_PROMPT, { signal: controller.signal, onEvent: (e) => apply(projectId, e), tools: session.tools }).then(() => {
        const plan = session.plan()
        if (plan && !controller.signal.aborted) update(projectId, (entries) => [...entries, { kind: "plan", id: nextEntryId++, plan, status: "pending" }])
        set({ cleanup: null })
      })
    },
    applyPlan: (projectId, entryId) => {
      if (get().runningProject) return
      const entry = (get().threads[projectId] ?? []).find((e) => e.kind === "plan" && e.id === entryId)
      const project = useProjectStore.getState().project
      if (entry?.kind !== "plan" || entry.status !== "pending" || project?.id !== projectId) return
      const setStatus = (status: PlanStatus) =>
        update(projectId, (entries) => entries.map((e) => (e.kind === "plan" && e.id === entryId ? { ...e, status } : e)))
      // The sheet may have been edited since the plan was made: it is checked again before anything runs.
      const checked = checkPlan(project, { blocks: entry.plan.blocks.map((b) => ({ name: b.name, refs: b.refs })) })
      if (!("plan" in checked) || checked.plan.blocks.length !== entry.plan.blocks.length) {
        setStatus("stale")
        update(projectId, (entries) => [...entries, { kind: "error", id: nextEntryId++, text: "The sheet changed since this plan was made. Run Clean up with AI again." }])
        return
      }
      const controller = new AbortController()
      const session = applySession(entry.plan)
      let failed = false
      setStatus("applying")
      const applyId = nextEntryId
      update(projectId, (entries) => [...entries, { kind: "user", id: nextEntryId++, text: "Apply the plan" }])
      set({ runningProject: projectId, controller, cleanup: "applying", activity: "Tidying" })
      // Tidying the whole sheet is a whole-board action: held under the board lease from here to the end.
      const begin = (lease: BoardLease) => {
        if (!lease.ok) {
          setStatus("cancelled")
          update(projectId, (entries) => [...entries, { kind: "error", id: nextEntryId++, text: lease.message }])
          set({ runningProject: null, controller: null, cleanup: null, activity: null })
          return
        }
        void runCopilot(CLEANUP_APPLY_PROMPT, {
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === "error") failed = true
            apply(projectId, e)
          },
          tools: session.tools,
        }).then(() => {
          setStatus(failed || controller.signal.aborted ? "cancelled" : "applied")
          // Nothing was kept, so the chat must not say it was: Sakura's report is dropped (the panel's line says what happened) and her steps show as not kept.
          if (failed || controller.signal.aborted) {
            update(projectId, (entries) =>
              entries.flatMap((e): Entry[] =>
                e.id <= applyId ? [e] : e.kind === "assistant" ? [] : e.kind === "tool" ? [{ ...e, status: "error", changed: false, label: `Not kept: ${e.label}` }] : [e],
              ),
            )
          }
          set({ cleanup: null })
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
    cancelPlan: (projectId, entryId) =>
      update(projectId, (entries) => entries.map((e) => (e.kind === "plan" && e.id === entryId && e.status === "pending" ? { ...e, status: "cancelled" } : e))),
    stop: () => get().controller?.abort(),
    clear: (projectId) => {
      clearHistory(projectId)
      set((s) => ({ threads: { ...s.threads, [projectId]: [] } }))
    },
  }
})

/** Show the copilot and send it a request for the open project. False when it is busy. */
export function askCopilot(text: string): boolean {
  const projectId = useProjectStore.getState().project?.id
  if (!projectId || useCopilot.getState().runningProject) return false
  useUi.getState().setCopilotOpen(true)
  useCopilot.getState().send(projectId, text)
  return true
}
