import { acquireBoard, type BoardLease } from "../../store/boardLease"
import { shownProject } from "../../store/sheetScope"
import { isHierarchical } from "../../model/sheets"
import { create } from "zustand"
import { finishCleanup, hasParts, planCleanup, type CleanupPlan, type CleanupResult } from "../../model/cleanup"
import { parseProjectFile, serializeProject } from "../../model/projectFile"
import { tidySchematic, type TidyResult } from "../../model/tidy"
import type { Project } from "../../model/types"
import { applyTidyResult, TIDY_TIMEOUT_MS, type TidyReply, type TidyRequest } from "./tidyAction"

// Clean up from the schematic toolbar, the free version: the parts in no block are grouped by how
// they are wired, then Tidy arranges the sheet, as one undo step. Nothing changes until the user
// says so: the toolbar shows what it would do (`phase.kind === "preview"`), and Apply starts it.
// Tidy runs in its worker as on the toolbar's broom; Esc or Cancel stops it with the sheet as it was.

export type CleanupPhase = { kind: "idle" } | { kind: "preview"; plan: CleanupPlan } | { kind: "running" }

interface CleanupState {
  phase: CleanupPhase
}

export const useCleanup = create<CleanupState>(() => ({ phase: { kind: "idle" } }))

/** Lets go of the board lease while Clean up runs, when it ends however it ends. */
let releaseLease: (() => void) | null = null

const setPhase = (phase: CleanupPhase) => {
  if (phase.kind !== "running") {
    releaseLease?.()
    releaseLease = null
  }
  useCleanup.setState({ phase })
}

/** Which run is current, so a worker's late answer to a cancelled one is ignored. */
let run = 0
let worker: Worker | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function dropWorker() {
  if (timer !== null) clearTimeout(timer)
  timer = null
  worker?.terminate()
  worker = null
}

/** What the toolbar is told when the sheet is left as it was. */
const left = (project: Project, message: string, problems: string[] = []): TidyResult => ({
  project,
  changed: false,
  ok: false,
  message,
  renamed: {},
  dropped: [],
  loose: { wires: 0, labels: 0, ports: 0 },
  problems,
})

/** Tell the toolbar, and take the sheet in as one undo step when it changed. */
function conclude(result: CleanupResult) {
  applyTidyResult({
    project: result.project,
    changed: result.changed,
    ok: result.ok,
    message: result.message,
    renamed: result.tidy?.renamed ?? {},
    dropped: [],
    loose: { wires: 0, labels: 0, ports: 0 },
    problems: result.problems.length ? result.problems : (result.tidy?.problems ?? []),
  })
}

/** Show what Clean up would do. Nothing on an empty sheet, and nothing while it is already working. */
export function openCleanup(): void {
  const project = shownProject()
  if (!project || !hasParts(project) || useCleanup.getState().phase.kind === "running") return
  setPhase({ kind: "preview", plan: planCleanup(project) })
}

/** Close the preview, or stop a running cleanup and leave the sheet as it was. */
export function cancelCleanup(): void {
  const { phase } = useCleanup.getState()
  if (phase.kind === "idle") return
  run++
  dropWorker()
  setPhase({ kind: "idle" })
  if (phase.kind === "running") applyTidyResult(left(shownProject(), "Clean up was stopped; nothing was changed."))
}

/** Stop everything as the editor closes. */
export const stopCleanup = (): void => {
  run++
  dropWorker()
  setPhase({ kind: "idle" })
}

/** Group the parts and tidy the sheet, after the preview. A sheet edited since the preview gets a new one. */
export function applyCleanup(timeoutMs = TIDY_TIMEOUT_MS): void {
  const { phase } = useCleanup.getState()
  if (phase.kind !== "preview") return
  const { plan } = phase
  const now = shownProject()
  if (!now) return
  if (now !== plan.before) {
    setPhase({ kind: "preview", plan: planCleanup(now) })
    return
  }
  const id = ++run
  setPhase({ kind: "running" })
  // Tidying rewrites the sheet: one tab at a time (the board lease). Taken at once where there are no leases.
  const begin = (lease: BoardLease) => {
    // Cancelled while the lease was on its way.
    if (id !== run) {
      if (lease.ok) lease.release()
      return
    }
    if (!lease.ok) {
      setPhase({ kind: "idle" })
      applyTidyResult(left(plan.before, lease.message))
      return
    }
    releaseLease = lease.release
    work()
  }
  const work = () => {
    const finish = (tidy: TidyResult) => {
      if (id !== run) return
      dropWorker()
      setPhase({ kind: "idle" })
      if (shownProject() !== plan.before) {
        applyTidyResult(left(shownProject(), "The sheet changed while it was being cleaned up, so nothing was changed."))
        return
      }
      conclude(finishCleanup(plan, tidy))
    }
    const fail = (message: string, problems: string[] = []) => {
      if (id !== run) return
      dropWorker()
      setPhase({ kind: "idle" })
      applyTidyResult(left(plan.before, message, problems))
    }

    if (typeof Worker !== "function" || isHierarchical(plan.before)) {
      // No workers (the unit tests): after the busy state is drawn, tidy here.
      setTimeout(() => {
        try {
          finish(tidySchematic(plan.project))
        } catch (e) {
          fail("Clean up couldn't finish; nothing was changed.", [e instanceof Error ? e.message : String(e)])
        }
      }, 0)
      return
    }
    try {
      worker = new Worker(new URL("./tidy.worker.ts", import.meta.url), { type: "module" })
    } catch {
      worker = null
      fail("Clean up couldn't start; nothing was changed.")
      return
    }
    timer = setTimeout(() => fail("Clean up took too long and was stopped; nothing was changed."), timeoutMs)
    worker.onmessage = (e: MessageEvent<TidyReply>) => {
      const reply = e.data
      if ("error" in reply) {
        fail("Clean up couldn't finish; nothing was changed.", [reply.error])
        return
      }
      const project = reply.project ? parseProjectFile(reply.project, { id: plan.before.id, createdAt: plan.before.createdAt, updatedAt: Date.now() }) : plan.project
      finish({ ...reply, project })
    }
    worker.onerror = () => fail("Clean up couldn't finish; nothing was changed.")
    worker.postMessage({ file: serializeProject(plan.project) } satisfies TidyRequest)
  }
  const leased = acquireBoard("cleanup", false)
  if (leased instanceof Promise) void leased.then(begin)
  else begin(leased)
}
