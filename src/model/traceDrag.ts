import { round, simplifyPolyline } from "../lib/geometry"
import { pointPadDistance } from "./padDistance"
import type { CopperItem } from "./pcb"
import type { Project, Trace, Vec2 } from "./types"

// Reshaping a straight track by hand, as Altium drags one. A segment (an edge of the track) moves square to itself and the copper it meets follows,
// so the track stays whole and keeps its angles:
// - an end joined by one straight segment slides along that segment's line, which grows or shrinks (a 45° bend stays a 45° bend). Once that segment
//   would shrink past nothing, the end carries on along the segment before it, over plain corners, so a short stub left by the grid is swallowed;
//   with nothing more to carry on along, a 45° jog from the last corner takes over, so pulling a bump flat and on through turns it over;
// - an end held by a pad, a via, a junction of several tracks, an arc or a segment in line with it stays where it is, and a 45° jog joins it to the
//   segment (square when two 45° jogs would cross);
// - an end that nothing joins moves with the segment;
// - another track that ends on the middle of the segment keeps its end on it, its last segment's angle too;
// - where another track ends, or a via or pad sits, on the middle of a segment an end slides along, the end stops there as at a corner something
//   meets, and jogs from it, so the copper is never pulled out from under it.
// A segment cannot be pulled through itself: past that it stops. A corner of a track can be dragged on its own, and the tracks that end there go
// with it. A track keeps its lock as it was: reshaping one does not lock it, so Sakura and routing see it as they did before.

const NEAR = 1e-6
/** The shortest segment a drag leaves (coordinates are kept to 1e-4). */
const MIN_LEN = 1e-3
/** A neighbour this close to the segment's own direction (the sine of the angle between them) is in line with it: sliding along it would fling the end away. */
const IN_LINE = 0.1
/** How many corners past an end a drag may swallow. */
const MAX_CHAIN = 32

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y
const len = (a: Vec2) => Math.hypot(a.x, a.y)
const along = (p: Vec2, d: Vec2, k: number): Vec2 => ({ x: p.x + d.x * k, y: p.y + d.y * k })
const unit = (a: Vec2): Vec2 => {
  const l = len(a)
  return { x: a.x / l, y: a.y / l }
}
const near = (a: Vec2, b: Vec2) => len(sub(a, b)) <= NEAR

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0
  return len(sub(p, along(a, ab, t))) <= NEAR
}

/** A point of a track: the drag puts it somewhere else. */
export interface TracePoint {
  trace: string
  index: number
}

type End =
  /** Nothing joins this end: it moves with the segment. */
  | { kind: "free" }
  /**
   * One straight segment joins it: the end slides along that segment's line. `at` are the points of tracks at the end (the dragged track's own, and
   * another's that carries on from it); `chain` the corners going away from it along the joining track, nearest first: each but the last is a plain
   * corner (nothing else meets it), which the end may pass.
   */
  | { kind: "slide"; at: TracePoint[]; chain: { p: Vec2; ref: TracePoint }[] }
  /** A pad, a via, several tracks, an arc or a segment in line with it hold it: it stays, and a jog joins it to the segment. */
  | { kind: "held" }

/** What a drag of one segment of a track moves, worked out once as it starts (`planSegmentDrag`) and applied on every move (`dragSegment`). */
export interface SegmentDrag {
  trace: string
  /** The segment runs from `points[index]` to `points[index + 1]` of the track. */
  index: number
  a: Vec2
  b: Vec2
  ends: [End, End]
  /** Other tracks ending on the middle of the segment: each such end, where it is, and the point before it on its track. */
  tees: { at: TracePoint; was: Vec2; far: Vec2 }[]
  /**
   * Corners put in (`withCuts`) before the drag is worked out, where something holds the middle of a segment an end may slide along. Every index
   * of the plan is one of the tracks with these in.
   */
  cuts: Cut[]
}

/** A corner put in segment `after` of a track (between its points `after` and `after + 1`) at `at`. */
interface Cut {
  trace: string
  after: number
  at: Vec2
}

/** The project with the corners of `cuts` put in, each segment's in the order they come along it. */
function withCuts(project: Project, cuts: readonly Cut[]): Project {
  if (!cuts.length) return project
  const by = new Map<string, Map<number, Vec2[]>>()
  for (const c of cuts) {
    const m = by.get(c.trace) ?? new Map<number, Vec2[]>()
    m.set(c.after, [...(m.get(c.after) ?? []), c.at])
    by.set(c.trace, m)
  }
  return { ...project, traces: project.traces.map((u) => (by.has(u.id) ? { ...u, points: u.points.flatMap((p, i) => [p, ...(by.get(u.id)!.get(i) ?? [])]) } : u)) }
}

/**
 * Where another track ends, or a via or a pad sits, on the middle of a segment an end of segment `index` of `t` may slide along (the track's other
 * segments, and those of a track carrying on from an end): a corner goes in there, so the end stops at it as at any corner something meets.
 */
function cutsFor(project: Project, items: readonly CopperItem[], t: Trace, index: number): Cut[] {
  const ends = [t.points[index], t.points[index + 1]]
  const slid = project.traces.filter(
    (u) => u.layer === t.layer && !u.arc && u.points.length >= 2 && (u.id === t.id || ends.some((p) => near(u.points[0], p) || near(u.points[u.points.length - 1], p))),
  )
  const holds: Vec2[] = []
  for (const u of project.traces) if (u.layer === t.layer && u.points.length >= 2) holds.push(u.points[0], u.points[u.points.length - 1])
  for (const it of items) {
    if (!it.layers.includes(t.layer)) continue
    if (it.kind === "via") holds.push(it.at)
    else if (it.kind === "pad") holds.push({ x: it.pad.x, y: it.pad.y })
  }
  const cuts: Cut[] = []
  for (const u of slid) {
    for (let k = 0; k < u.points.length - 1; k++) {
      if (u.id === t.id && k === index) continue
      const p = u.points[k]
      const q = u.points[k + 1]
      const on = holds.filter((h) => !near(h, p) && !near(h, q) && onSegment(h, p, q)).sort((h1, h2) => len(sub(h1, p)) - len(sub(h2, p)))
      for (const h of on) if (!cuts.some((c) => c.trace === u.id && c.after === k && near(c.at, h))) cuts.push({ trace: u.id, after: k, at: h })
    }
  }
  return cuts
}

/** The straight tracks of a layer other than `skip` that end at `p`, and whether anything else of theirs touches it. */
function tracksAt(project: Project, layer: Trace["layer"], skip: string, p: Vec2): { ends: TracePoint[]; other: boolean } {
  const ends: TracePoint[] = []
  let other = false
  for (const u of project.traces) {
    if (u.id === skip || u.layer !== layer || u.points.length < 2) continue
    const n = u.points.length
    if (u.arc) {
      // An arc track joins at one of its ends; it cannot slide, so it holds the point.
      if (near(u.points[0], p) || near(u.points[n - 1], p)) other = true
      continue
    }
    if (near(u.points[0], p)) ends.push({ trace: u.id, index: 0 })
    else if (near(u.points[n - 1], p)) ends.push({ trace: u.id, index: n - 1 })
    else if (u.points.some((q, i) => i < n - 1 && onSegment(p, q, u.points[i + 1]))) other = true
  }
  return { ends, other }
}

/** Whether a pad or a via on the track's layer holds the point. */
function heldByCopper(items: readonly CopperItem[], layer: Trace["layer"], p: Vec2): boolean {
  for (const it of items) {
    if (it.kind === "pad" && it.layers.includes(layer) && pointPadDistance(p, it.pad) <= NEAR) return true
    if (it.kind === "via" && it.layers.includes(layer) && len(sub(p, it.at)) <= it.diameter / 2 + NEAR) return true
  }
  return false
}

/** Whether a corner of track `u` meets nothing but its own two segments: no pad, no via, no other track, no other part of the track. */
function plainCorner(project: Project, items: readonly CopperItem[], u: Trace, i: number): boolean {
  const p = u.points[i]
  if (heldByCopper(items, u.layer, p)) return false
  const others = tracksAt(project, u.layer, u.id, p)
  if (others.ends.length || others.other) return false
  return !u.points.some((q, k) => k < u.points.length - 1 && k !== i - 1 && k !== i && onSegment(p, q, u.points[k + 1]))
}

/**
 * How a drag of segment `index` of a straight track moves the copper around it, or null when there is no such segment. `items` are the board's copper
 * items (`PcbAnalysis.items`): their pads and vias hold the ends that sit on them.
 */
export function planSegmentDrag(given: Project, traceId: string, seg: number, items: readonly CopperItem[]): SegmentDrag | null {
  const t0 = given.traces.find((x) => x.id === traceId)
  if (!t0 || t0.arc || !Number.isInteger(seg) || seg < 0 || seg >= t0.points.length - 1) return null
  if (len(sub(t0.points[seg + 1], t0.points[seg])) < MIN_LEN) return null
  // Worked out on the tracks with their cuts in, as `dragSegment` applies it.
  const cuts = cutsFor(given, items, t0, seg)
  const project = withCuts(given, cuts)
  const index = seg + cuts.filter((c) => c.trace === traceId && c.after < seg).length
  const t = project.traces.find((x) => x.id === traceId)!
  const a = t.points[index]
  const b = t.points[index + 1]
  const n = unit({ x: a.y - b.y, y: b.x - a.x })
  const byId = new Map(project.traces.map((u) => [u.id, u]))
  const last = t.points.length - 1
  /** The corners of `u` from `i` on, going by `step`: each pushed while the one before it is a plain corner. */
  const chainOf = (u: Trace, i: number, step: 1 | -1) => {
    const chain: { p: Vec2; ref: TracePoint }[] = []
    for (let k = i; k >= 0 && k < u.points.length && chain.length < MAX_CHAIN; k += step) {
      chain.push({ p: u.points[k], ref: { trace: u.id, index: k } })
      if (!plainCorner(project, items, u, k)) break
    }
    return chain
  }
  const end = (i: number, step: 1 | -1): End => {
    const p = t.points[i]
    if (!plainCornerOf(i)) return { kind: "held" }
    const others = tracksAt(project, t.layer, t.id, p)
    const own = i + step >= 0 && i + step <= last
    if (others.other || others.ends.length + (own ? 1 : 0) > 1) return { kind: "held" }
    if (!own && !others.ends.length) return { kind: "free" }
    const via = others.ends[0]
    const u = via ? byId.get(via.trace)! : t
    const chain = via ? chainOf(u, via.index === 0 ? 1 : u.points.length - 2, via.index === 0 ? 1 : -1) : chainOf(t, i + step, step)
    const way = sub(p, chain[0].p)
    if (len(way) < MIN_LEN || Math.abs(dot(unit(way), n)) < IN_LINE) return { kind: "held" }
    return { kind: "slide", at: [{ trace: t.id, index: i }, ...(via ? [via] : [])], chain }
  }
  /** Whether an end of the segment meets nothing on its own track or of copper but its neighbours (other tracks are counted by `end`). */
  const plainCornerOf = (i: number) =>
    !heldByCopper(items, t.layer, t.points[i]) && !t.points.some((q, k) => k < last && k !== index && k !== i - 1 && k !== i && onSegment(t.points[i], q, t.points[k + 1]))
  const tees: SegmentDrag["tees"] = []
  for (const u of project.traces) {
    if (u.id === t.id || u.layer !== t.layer || u.arc || u.points.length < 2) continue
    const k = u.points.length - 1
    for (const [i, j] of [
      [0, 1],
      [k, k - 1],
    ] as const) {
      const q = u.points[i]
      if (near(q, a) || near(q, b) || !onSegment(q, a, b) || onSegment(u.points[j], a, b) || heldByCopper(items, t.layer, q)) continue
      tees.push({ at: { trace: u.id, index: i }, was: q, far: u.points[j] })
    }
  }
  return { trace: t.id, index, a, b, ends: [end(index, -1), end(index + 1, 1)], tees, cuts }
}

/** The jogs to put in at each end of the segment and the points of tracks to move, for the segment moved `o` square to itself; null when it would turn the segment round. */
function shaped(plan: SegmentDrag, o: number, square: boolean): { jogs: [Vec2 | null, Vec2 | null]; moves: Map<string, Map<number, Vec2>> } | null {
  const d = unit(sub(plan.b, plan.a))
  const n = { x: -d.y, y: d.x }
  /** How far `p` is from the moved segment's line, across it. */
  const across = (p: Vec2) => o - dot(sub(p, plan.a), n)
  /** The jog from `f` to the moved line: at 45°, toward the segment's other end (`s`), or square. */
  const jog = (f: Vec2, s: 1 | -1): Vec2 => {
    const h = across(f)
    return along(along(f, n, h), d, square ? 0 : s * Math.abs(h))
  }
  const moves = new Map<string, Map<number, Vec2>>()
  const put = (q: TracePoint, to: Vec2) => {
    const m = moves.get(q.trace) ?? new Map<number, Vec2>()
    m.set(q.index, to)
    moves.set(q.trace, m)
  }
  const jogs: [Vec2 | null, Vec2 | null] = [null, null]
  const ends = plan.ends.map((e, k): Vec2 => {
    const p = k === 0 ? plan.a : plan.b
    const s = k === 0 ? 1 : -1
    if (e.kind === "free") {
      const to = along(p, n, o)
      put({ trace: plan.trace, index: plan.index + k }, to)
      return to
    }
    if (e.kind === "held") return (jogs[k] = jog(p, s))
    // Along the joining segment's line while it is still there; past its far corner, along the next one's; with none left, a jog from the last corner.
    let to: Vec2 | null = null
    let passed = 0
    for (let j = 0; j < e.chain.length && !to; j++) {
      const far = e.chain[j].p
      const from = j === 0 ? p : e.chain[j - 1].p
      const u = unit(sub(from, far))
      const slant = dot(u, n)
      if (Math.abs(slant) < IN_LINE) {
        // In line with the segment: the corner before it stays, and a jog from it takes over.
        to = jog(from, s)
        passed = j - 1
      } else {
        const t = across(far) / slant
        if (t > MIN_LEN) to = along(far, u, t)
        else if (j === e.chain.length - 1) to = jog(far, s)
        passed = j
      }
    }
    for (const q of e.at) put(q, to!)
    for (let j = 0; j < passed; j++) put(e.chain[j].ref, to!)
    return to!
  })
  if (dot(sub(ends[1], ends[0]), d) < MIN_LEN) return null
  for (const { at, was, far } of plan.tees) {
    const u = unit(sub(was, far))
    const slant = dot(u, n)
    const slid = Math.abs(slant) >= IN_LINE && across(far) / slant > MIN_LEN ? along(far, u, across(far) / slant) : along(was, n, o)
    // Kept on the moved segment: a slide that runs off its end is a plain shift instead.
    const k = dot(sub(slid, ends[0]), d)
    put(at, k > 0 && k < dot(sub(ends[1], ends[0]), d) ? slid : along(was, n, o))
  }
  return { jogs, moves }
}

/** A project with the tracks of `changes` reshaped (each simplified, and gone when nothing of it is left). */
function reshaped(project: Project, changes: Map<string, Vec2[]>): Project {
  if (!changes.size) return project
  const traces: Trace[] = []
  for (const t of project.traces) {
    const pts = changes.get(t.id)
    if (!pts) {
      traces.push(t)
      continue
    }
    const points = simplifyPolyline(pts.map((p) => ({ x: round(p.x), y: round(p.y) })))
    if (points.length >= 2) traces.push({ ...t, points })
  }
  return { ...project, traces, updatedAt: Date.now() }
}

/**
 * The project with the segment of `plan` dragged by `delta` (only the part of it square to the segment counts). The same project when that is nothing.
 * Where the jogs would cross they are square, and where even that would turn the segment round it goes as far as it can.
 */
export function dragSegment(project: Project, plan: SegmentDrag, delta: Vec2): Project {
  const d = unit(sub(plan.b, plan.a))
  const want = dot(delta, { x: -d.y, y: d.x })
  if (Math.abs(want) < NEAR) return project
  const at = (o: number) => shaped(plan, o, false) ?? shaped(plan, o, true)
  let shape = at(want)
  if (!shape) {
    let lo = 0
    let hi = want
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (at(mid)) lo = mid
      else hi = mid
    }
    if (Math.abs(lo) < NEAR) return project
    shape = at(lo)!
  }
  // The plan's indices are those of the tracks with its cuts in. A cut track the drag moves nothing of is left as it was; on one it moves, a cut
  // still in line goes again with the simplifying.
  const cut = withCuts(project, plan.cuts)
  const t = cut.traces.find((x) => x.id === plan.trace)
  if (!t) return project
  const changes = new Map<string, Vec2[]>()
  for (const [id, m] of shape.moves) {
    const u = cut.traces.find((x) => x.id === id)
    if (u) changes.set(id, u.points.map((p, i) => m.get(i) ?? p))
  }
  // The jogs go in between the segment's ends, which stay where they were.
  const own = changes.get(t.id) ?? t.points
  const [ja, jb] = shape.jogs
  changes.set(t.id, [...own.slice(0, plan.index + 1), ...(ja ? [ja] : []), ...(jb ? [jb] : []), ...own.slice(plan.index + 1)])
  return reshaped(project, changes)
}

/**
 * The pointer's move `raw` as a move of the segment square to itself, snapped: a segment along x, along y or at 45° lands with its line on the grid
 * (through grid points, so the corners it makes with its neighbours are on it too), one at another angle moves by whole steps of it.
 */
export function snapSegmentMove(plan: SegmentDrag, raw: Vec2, grid: number): Vec2 {
  const d = unit(sub(plan.b, plan.a))
  const n = { x: -d.y, y: d.x }
  const ax = Math.abs(d.x)
  const ay = Math.abs(d.y)
  const straight = ax < 1e-6 || ay < 1e-6
  let o: number
  if (straight || Math.abs(ax - ay) < 1e-6) {
    // A grid point's distance across such a line is a whole number of these steps.
    const step = straight ? grid : grid / Math.SQRT2
    const from = dot(plan.a, n)
    o = Math.round((from + dot(raw, n)) / step) * step - from
  } else o = Math.round(dot(raw, n) / grid) * grid
  return { x: n.x * o, y: n.y * o }
}

/** What a drag of one corner of a straight track moves: the corner, and the ends of the other tracks there. */
export interface VertexDrag {
  trace: string
  index: number
  follow: TracePoint[]
}

/** How a drag of corner `index` of a straight track moves the copper there, or null when there is no such corner. */
export function planVertexDrag(project: Project, traceId: string, index: number): VertexDrag | null {
  const t = project.traces.find((x) => x.id === traceId)
  if (!t || t.arc || !Number.isInteger(index) || index < 0 || index >= t.points.length) return null
  return { trace: t.id, index, follow: tracksAt(project, t.layer, t.id, t.points[index]).ends }
}

/** The project with the corner of `plan` at `to`. */
export function dragVertex(project: Project, plan: VertexDrag, to: Vec2): Project {
  const changes = new Map<string, Vec2[]>()
  for (const q of [{ trace: plan.trace, index: plan.index }, ...plan.follow]) {
    const u = project.traces.find((x) => x.id === q.trace)
    if (!u) continue
    const pts = changes.get(u.id) ?? [...u.points]
    pts[q.index] = to
    changes.set(u.id, pts)
  }
  const t = project.traces.find((x) => x.id === plan.trace)
  if (!t || near(t.points[plan.index], to)) return project
  return reshaped(project, changes)
}
