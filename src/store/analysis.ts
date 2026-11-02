import { create } from "zustand"
import { getConnectivity, getErc } from "../model/connectivityCache"
import type { SchematicConnectivity } from "../model/connectivity"
import type { ErcFinding } from "../model/erc"
import { analyzePcb, type PcbAnalysis } from "../model/pcb"
import type { ZoneFill } from "../model/pour"
import { serializeProject } from "../model/projectFile"
import type { Project } from "../model/types"
import { seedZoneFills, type PendingGroup } from "../model/zoneFill"
import { needsZoneEngine } from "../model/zones"
import { useProjectStore } from "./projectStore"
import type { ZoneFillReply, ZoneFillRequest } from "./zoneFill.worker"

export { getConnectivity, getErc }

const pcbCache = new WeakMap<Project, PcbAnalysis>()

export function useErc(): ErcFinding[] | null {
  const p = useProjectStore((s) => s.project)
  return p ? getErc(p) : null
}

const dragCache = new WeakMap<Project, PcbAnalysis>()
let lastFills: { zones: Project["zones"]; board: Project["board"]; fills: ZoneFill[] } | null = null
/** The fills of the last analysis that was current: shown while an edit's refill is made (`getLiveAnalysis`). */
let lastGood: { project: string; fills: ZoneFill[] } = { project: "", fills: [] }

function noteCurrent(p: Project, value: PcbAnalysis) {
  lastFills = { zones: p.zones, board: p.board, fills: value.zoneFills }
  lastGood = { project: p.id, fills: value.zoneFills }
}

export function getPcbAnalysis(p: Project): PcbAnalysis {
  const hit = pcbCache.get(p)
  if (hit) return hit
  // While something is being dragged, keep the last pour fill; it refills on drop. That holds for the corner of a zone that is being dragged
  // too (its outline moves with the pointer and its copper follows on drop, as KiCad's does on a refill): the fill of a big board takes seconds.
  const dragging = useProjectStore.getState().transientBase !== null
  if (dragging && p.zones.length && lastFills && lastFills.zones.length === p.zones.length && lastFills.board === p.board) {
    const stale = dragCache.get(p)
    if (stale) return stale
    const value = analyzePcb(p, getConnectivity(p), { fills: lastFills.fills })
    dragCache.set(p, value)
    return value
  }
  const value = analyzePcb(p, getConnectivity(p))
  pcbCache.set(p, value)
  noteCurrent(p, value)
  return value
}

// ---------- The analysis for what is on screen: no waiting for a refill ----------
//
// Filling a polygon zone takes seconds on a big board, and every edit that reached one used to wait for it on the page's thread.
// `getPcbAnalysis` still does that (Sakura, the exports and the export checks need the answer now, and the fills the zones keep make it
// cheap when nothing reached them). The views take `getLiveAnalysis`: a zone whose fill is kept is current, and one that is not shows the
// last fill while a worker makes the new one (`zonesPending` says so, and the views say it). When the worker is done the views ask again and
// are given the current analysis, so a stale fill's checks are shown as such, and only for as long as the refill takes.

/** Counts the refills that finished, so a view that asked while one was pending asks again. */
export const useFillTick = create<{ tick: number }>(() => ({ tick: 0 }))
const bump = () => useFillTick.setState((s) => ({ tick: s.tick + 1 }))

const liveCache = new WeakMap<Project, { value: PcbAnalysis; tick: number }>()

/** How long after the last edit a refill starts: edits in a run (typing a value, nudging) make one refill. */
export const FILL_DEBOUNCE_MS = 250
interface Job {
  project: Project
  groups: PendingGroup[]
}

let worker: Worker | null = null
let workerOff = false
let wanted: Job | null = null
let inFlight: Job | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

function dropWorker() {
  if (worker) {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
  }
  worker = null
}

/** The fill worker, made once; null where there are no workers (tests) or it can't start. */
function fillWorker(): Worker | null {
  if (worker || workerOff || typeof Worker !== "function") return worker
  try {
    worker = new Worker(new URL("./zoneFill.worker.ts", import.meta.url), { type: "module" })
  } catch {
    workerOff = true
    worker = null
  }
  return worker
}

/**
 * Make the fill here, on the page's thread, where there is no worker or it failed: what the zones keep serves the views after. A fill that is only
 * slow stays in the worker, however long it takes: CERN's Macbeth fills its 47 zones in about three minutes, and a two-minute limit that moved the
 * fill here froze the page for four more.
 */
function fillHere(job: Job) {
  if (inFlight !== job) return
  try {
    analyzePcb(job.project, getConnectivity(job.project))
  } finally {
    inFlight = null
    bump()
    next()
  }
}

function finish(job: Job, fills: ZoneFill[]) {
  // Each group's fills are kept under the key this thread made for it, which is what the next analysis looks up.
  seedZoneFills(job.groups.map((g) => ({ key: g.key, fills: fills.filter((f) => g.zones.includes(f.zoneId)) })))
  inFlight = null
  bump()
  next()
}

function start(job: Job) {
  inFlight = job
  const w = fillWorker()
  let file: string | null = null
  if (w) {
    try {
      file = serializeProject(job.project)
    } catch {
      file = null
    }
  }
  if (!w || file === null) {
    setTimeout(() => fillHere(job), 0)
    return
  }
  const fail = () => {
    dropWorker()
    workerOff = true
    setTimeout(() => fillHere(job), 0)
  }
  w.onmessage = (e: MessageEvent<ZoneFillReply>) => {
    if (inFlight !== job) return
    if ("error" in e.data) fail()
    else finish(job, e.data.fills)
  }
  w.onerror = fail
  w.postMessage({ file } satisfies ZoneFillRequest)
}

/** Start the newest wanted refill, when none is running. */
function next() {
  if (inFlight || !wanted) return
  const job = wanted
  wanted = null
  // Edited again since: ask for what is current instead (it is the same job when nothing was, and nothing when the fills are kept).
  const current = useProjectStore.getState().project
  if (current && current !== job.project) {
    getLiveAnalysis(current)
    return
  }
  start(job)
}

/** Ask for the fill of a project some of whose groups of zones are not current, once the edits settle. */
function wantFill(project: Project, groups: PendingGroup[]) {
  wanted = { project, groups }
  if (debounce !== null) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    next()
  }, FILL_DEBOUNCE_MS)
}

/** Stop any refill under way, as the editor closes. */
export function stopZoneFills(): void {
  if (debounce !== null) clearTimeout(debounce)
  debounce = null
  wanted = null
  inFlight = null
  dropWorker()
}

/**
 * The analysis of a project for the views. The same as `getPcbAnalysis` unless a polygon zone's fill has to be made again: then the last
 * fill stands in for it (`zonesPending`) and the new one is made off the page's thread, after which `useFillTick` changes and this is
 * asked again. While something is being dragged it is `getPcbAnalysis`'s, which keeps the last fill until the drop.
 */
export function getLiveAnalysis(p: Project): PcbAnalysis {
  if (!needsZoneEngine(p)) return getPcbAnalysis(p)
  const exact = pcbCache.get(p)
  if (exact) return exact
  if (useProjectStore.getState().transientBase !== null) return getPcbAnalysis(p)
  const tick = useFillTick.getState().tick
  const hit = liveCache.get(p)
  if (hit && hit.tick === tick) return hit.value
  const value = analyzePcb(p, getConnectivity(p), { reuseOnly: { stale: lastGood.project === p.id ? lastGood.fills : [] } })
  if (value.zonesPending) {
    liveCache.set(p, { value, tick })
    wantFill(p, value.zonesPending)
  } else {
    pcbCache.set(p, value)
    noteCurrent(p, value)
  }
  return value
}

/** The fills the views draw: current, or the last ones while a refill is made. */
export const getLiveZoneFills = (p: Project): ZoneFill[] => getLiveAnalysis(p).zoneFills

/** Filled copper pours, computed as part of the PCB analysis. */
export function getZoneFills(p: Project): ZoneFill[] {
  return getPcbAnalysis(p).zoneFills
}

/** Parts, tracks and vias past which a board's preview fills none of its zones itself. */
const PREVIEW_FILL_ITEMS = 3000

/**
 * The fills a board's preview draws: the analysis's when it is made; on a small board, every zone filled, as the editor fills them; on a big one, the fills kept
 * already (KiCad's own, or ones this page made), filling no zone that has none. A projects page draws a preview of every project on the page itself, and filling
 * the 47 zones of a 2,970-part board there held it for minutes; the editor fills them in its worker once the project is open.
 */
export function getPreviewFills(p: Project): ZoneFill[] {
  const made = pcbCache.get(p)
  if (made) return made.zoneFills
  const big = p.components.length + p.traces.length + p.vias.length > PREVIEW_FILL_ITEMS
  return analyzePcb(p, getConnectivity(p), { ...(big ? { reuseOnly: { stale: [] } } : {}), fillsOnly: true }).zoneFills
}

export function useConnectivity(): SchematicConnectivity | null {
  const p = useProjectStore((s) => s.project)
  return p ? getConnectivity(p) : null
}

/** The analysis the views show (`getLiveAnalysis`), asked again when a refill finishes. */
export function usePcbAnalysis(): PcbAnalysis | null {
  const p = useProjectStore((s) => s.project)
  useFillTick((s) => s.tick)
  return p ? getLiveAnalysis(p) : null
}
