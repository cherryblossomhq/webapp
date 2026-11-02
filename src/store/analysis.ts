import { create } from "zustand"
import { getConnectivity, getErc } from "../model/connectivityCache"
import type { SchematicConnectivity } from "../model/connectivity"
import type { ErcFinding } from "../model/erc"
import { analysisWithItems, analyzePcb, followEdit, type PcbAnalysis } from "../model/pcb"
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
    const value = analyzePcb(job.project, getConnectivity(job.project))
    pcbCache.set(job.project, value)
    noteCurrent(job.project, value)
  } finally {
    inFlight = null
    bump()
    next()
  }
}

/** The worker's analysis, with the copper items made here. */
function adopted(job: Job, reply: Extract<ZoneFillReply, { fills: ZoneFill[] }>): PcbAnalysis {
  const a = reply.analysis
  return analysisWithItems(job.project, getConnectivity(job.project), {
    island: new Map(a.island),
    islandNet: new Map(a.islandNet),
    traceNet: new Map(a.traceNet),
    viaNet: new Map(a.viaNet),
    ratsnest: a.ratsnest,
    violations: a.violations,
    zoneFills: reply.fills,
    ...(reply.pending ? { zonesPending: reply.pending } : {}),
  })
}

/** A project as the workers read it, written once for both. */
const files = new WeakMap<Project, string>()
function fileOf(p: Project): string {
  let file = files.get(p)
  if (file === undefined) files.set(p, (file = serializeProject(p)))
  return file
}

// ---------- The checks of a big board, off the page's thread ----------
//
// After an edit of a big board the views are given the analysis shown last with the edited copper where it is (`followEdit`), and the board's checks
// are made in a worker of their own with the last fills (it never fills a zone, so it answers in seconds); when an edit reached a pour, the fill
// worker then fills it again and its analysis replaces them. One worker for both made an edit's checks wait for the last edit's refill, minutes on
// a board of 47 pours.

let checker: Worker | null = null
let checkerOff = false
let checkWanted: Project | null = null
let checking: Project | null = null
let checkDebounce: ReturnType<typeof setTimeout> | null = null

function checksWorker(): Worker | null {
  if (checker || checkerOff || typeof Worker !== "function") return checker
  try {
    checker = new Worker(new URL("./zoneFill.worker.ts", import.meta.url), { type: "module" })
  } catch {
    checkerOff = true
    checker = null
  }
  return checker
}

/** Ask for the checks of a big board as it is now, once the edits settle. */
function wantChecks(p: Project) {
  checkWanted = p
  if (checkDebounce !== null) clearTimeout(checkDebounce)
  checkDebounce = setTimeout(() => {
    checkDebounce = null
    nextCheck()
  }, FILL_DEBOUNCE_MS)
}

function nextCheck() {
  if (checking || !checkWanted) return
  const p = checkWanted
  checkWanted = null
  if (pcbCache.get(p) || useProjectStore.getState().project !== p) return
  const w = checksWorker()
  if (!w) return
  checking = p
  const done = () => {
    checking = null
    nextCheck()
  }
  w.onmessage = (e: MessageEvent<ZoneFillReply>) => {
    if ("error" in e.data) {
      if (checker) checker.terminate()
      checker = null
      checkerOff = true
      wantFill(p, [])
    } else if (!pcbCache.get(p)) {
      const value = adopted({ project: p, groups: [] }, e.data)
      if (!e.data.pending) {
        // No pour was reached: these are the board's checks.
        pcbCache.set(p, value)
        noteCurrent(p, value)
        liveCache.delete(p)
      } else {
        // The checks with the last fills of the pours the edit reached, which the fill worker fills again now.
        liveCache.set(p, { value, tick: useFillTick.getState().tick + 1 })
        wantFill(p, e.data.pending)
      }
      if (lastShown?.project.id === p.id) lastShown = { project: p, value }
      bump()
    }
    done()
  }
  w.onerror = () => {
    if (checker) checker.terminate()
    checker = null
    checkerOff = true
    wantFill(p, [])
    done()
  }
  w.postMessage({ file: fileOf(p), stale: lastGood.project === p.id ? lastGood.fills : [] } satisfies ZoneFillRequest)
}

function finish(job: Job, reply: Extract<ZoneFillReply, { fills: ZoneFill[] }>) {
  const fills = reply.fills
  // Each group's fills are kept under the key this thread made for it, which is what the next analysis looks up.
  seedZoneFills(job.groups.map((g) => ({ key: g.key, fills: fills.filter((f) => g.zones.includes(f.zoneId)) })))
  // The worker's analysis is the board's, checks and all: the views take it (and `getPcbAnalysis` too), with the copper items made here.
  const value = adopted(job, reply)
  pcbCache.set(job.project, value)
  noteCurrent(job.project, value)
  liveCache.delete(job.project)
  if (lastShown?.project.id === job.project.id) lastShown = { project: job.project, value }
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
      file = fileOf(job.project)
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
    else finish(job, e.data)
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
  if (checkDebounce !== null) clearTimeout(checkDebounce)
  checkDebounce = null
  checkWanted = null
  checking = null
  if (checker) checker.terminate()
  checker = null
}

/**
 * The analysis of a project for the views. The same as `getPcbAnalysis` unless a polygon zone's fill has to be made again: then the last
 * fill stands in for it (`zonesPending`) and the new one is made off the page's thread, after which `useFillTick` changes and this is
 * asked again. While something is being dragged it is `getPcbAnalysis`'s, which keeps the last fill until the drop.
 */
export function getLiveAnalysis(p: Project): PcbAnalysis {
  // While something is dragged on a big board the views are given the analysis the drag began with, its moved copper where it is now
  // (`followEdit`): analysing the whole board for every frame of the drag took 18 s a frame on a board of 1,566 parts. A small board is analysed
  // whole, so its checks follow the drag.
  const base = useProjectStore.getState().transientBase
  if (base !== null && base !== p) {
    const start = getLiveAnalysis(base)
    if (start.items.length > DRAG_FOLLOW_ITEMS) return draggedAnalysis(p, base, start)
  }
  if (!needsZoneEngine(p)) return getPcbAnalysis(p)
  const exact = pcbCache.get(p)
  if (exact) return shown(p, exact)
  const tick = useFillTick.getState().tick
  const hit = liveCache.get(p)
  if (hit && hit.tick === tick) return shown(p, hit.value)
  // A big board's checks are made off the page's thread, where its pours are filled (`zoneFill.worker.ts`): after an edit the views are given the
  // analysis shown last with the edited copper where it is now (`followEdit`), and when the board opens its copper and connections without the
  // checks (`connectionsOnly`); the worker's analysis replaces either when it comes. Analysing the board here took 14 s an edit, and 18 to 36 s on
  // opening, on one of 1,566 parts.
  if (bigBoard(p) && fillWorker() !== null) {
    const from = lastShown
    const value =
      from && from.project.id === p.id && from.project !== p
        ? { ...followEdit(from.value, from.project, p, getConnectivity(p)), checksPending: true }
        : analyzePcb(p, getConnectivity(p), { reuseOnly: { stale: lastGood.project === p.id ? lastGood.fills : [] }, connectionsOnly: true })
    liveCache.set(p, { value, tick })
    wantChecks(p)
    return shown(p, value)
  }
  const value = analyzePcb(p, getConnectivity(p), { reuseOnly: { stale: lastGood.project === p.id ? lastGood.fills : [] } })
  if (value.zonesPending) {
    liveCache.set(p, { value, tick })
    wantFill(p, value.zonesPending)
  } else {
    pcbCache.set(p, value)
    noteCurrent(p, value)
  }
  return shown(p, value)
}

/** The parts, tracks and vias past which a board's checks are made off the page's thread (`getLiveAnalysis`). */
const BACKGROUND_CHECKS_SIZE = 3000
const bigBoard = (p: Project) => p.components.length + p.traces.length + p.vias.length > BACKGROUND_CHECKS_SIZE

/** The analysis the views were given last, and the project it is of: an edit's analysis follows it until the worker's comes (`followEdit`). */
let lastShown: { project: Project; value: PcbAnalysis } | null = null
function shown(p: Project, value: PcbAnalysis): PcbAnalysis {
  lastShown = { project: p, value }
  return value
}

/** The copper items past which a drag follows the analysis it began with instead of analysing every frame. */
const DRAG_FOLLOW_ITEMS = 4000

const dragFrames = new WeakMap<Project, PcbAnalysis>()

function draggedAnalysis(p: Project, base: Project, start: PcbAnalysis): PcbAnalysis {
  let value = dragFrames.get(p)
  if (!value) dragFrames.set(p, (value = followEdit(start, base, p, getConnectivity(base))))
  return value
}

/** The fills the views draw: current, or the last ones while a refill is made. */
export const getLiveZoneFills = (p: Project): ZoneFill[] => getLiveAnalysis(p).zoneFills

/** Filled copper pours, computed as part of the PCB analysis. */
export function getZoneFills(p: Project): ZoneFill[] {
  return getPcbAnalysis(p).zoneFills
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
