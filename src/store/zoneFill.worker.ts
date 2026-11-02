import { computeConnectivity } from "../model/connectivity"
import { analyzePcb, type PcbAnalysis } from "../model/pcb"
import type { ZoneFill } from "../model/pour"
import type { PendingGroup } from "../model/zoneFill"
import { parseProjectFile } from "../model/projectFile"

// The zone fill off the page's thread (X3): filling a big board's pours takes seconds. The project comes as a project file, which reading
// registers its own parts and land patterns for here as it does on the page, and the fills go back as they are (plain numbers). This
// worker lives as long as the editor, so what it has filled stays kept (`model/zoneFill.ts`) and a refill after an edit makes only the
// groups of zones the edit reached.

export interface ZoneFillRequest {
  file: string
  /**
   * The fills that stand in for the groups of zones whose fill is not kept here: with them the worker makes the board's checks without filling any
   * zone (`reuseOnly`), which the checks worker does after each edit of a big board; without them it fills what it has to and analyses the board.
   */
  stale?: ZoneFill[]
}
/**
 * The fills, and the analysis of the board they are part of (its islands, nets, ratsnest and checks, as lists): the page makes the copper items itself
 * (`analysisWithItems`) and has the board's checks without running them on its thread.
 */
export type ZoneFillReply = { fills: ZoneFill[]; analysis: WorkerAnalysis; pending?: PendingGroup[] } | { error: string }
export interface WorkerAnalysis {
  island: [string, number][]
  islandNet: [number, string | null][]
  traceNet: [string, string | null][]
  viaNet: [string, string | null][]
  ratsnest: PcbAnalysis["ratsnest"]
  violations: PcbAnalysis["violations"]
}

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<ZoneFillRequest>) => void) | null; postMessage: (reply: ZoneFillReply) => void }

const pack = (a: PcbAnalysis): WorkerAnalysis => ({ island: [...a.island], islandNet: [...a.islandNet], traceNet: [...a.traceNet], viaNet: [...a.viaNet], ratsnest: a.ratsnest, violations: a.violations })

scope.onmessage = (e) => {
  try {
    const project = parseProjectFile(e.data.file, { id: "fill", createdAt: 0, updatedAt: 0 })
    const sch = computeConnectivity(project)
    const stale = e.data.stale
    const a = stale ? analyzePcb(project, sch, { reuseOnly: { stale } }) : analyzePcb(project, sch)
    scope.postMessage({ fills: a.zoneFills, analysis: pack(a), ...(a.zonesPending ? { pending: a.zonesPending } : {}) })
  } catch (err) {
    scope.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
