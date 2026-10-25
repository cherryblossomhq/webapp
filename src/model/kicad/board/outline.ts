import { reversePath } from "../../outlineOps"
import { arcCircle, flattenSeg, mapShape, segEnd, segStart, shapePaths, type PathSeg, type ShapePath } from "../../shapes"
import type { ShapeGeometry, Vec2 } from "../../types"
import { rawGeometry, TRANSLATED_LAYER_NAMES } from "./graphics"
import { arcThrough, rotK } from "./geometry"
import type { KicadBoard, KicadShape, Pt } from "./types"

// The board's outline from the pieces drawn on Edge.Cuts, on the board and inside footprints.
// KiCad never checked an outline before version 6, so real boards have doubled lines, a side drawn
// in overlapping pieces and stubs under a tenth of a millimetre. The repair, in this order: merge
// straight pieces on one line that overlap or touch, drop a straight piece shorter than the
// tolerance (unless both its ends touch other pieces, which makes it part of the loop), join the
// pieces' ends. What still does not close is reported with where the gap is.

/** Pieces whose ends are within this of each other are joined, in millimetres. */
export const JOIN_TOLERANCE = 0.1
/** Two ends are one point, for deciding a short piece belongs to the loop. */
const TOUCH = 0.002
/**
 * A loop is a rectangle or a rounded rectangle only when every piece of it lies on that shape
 * within this, in millimetres: the board is built from the shape, so a piece 0.1 mm off would be
 * a board 0.1 mm off. Anything not exact within it needs X2.
 */
export const EXACT_TOLERANCE = 0.001

type Xy = [number, number]

interface Piece {
  kind: "line" | "arc" | "circle" | "rect" | "poly" | "curve"
  /** The ends of an open piece; null for a closed one. */
  a: Xy | null
  b: Xy | null
  pts: Xy[]
  quarter?: boolean
  fullCircle?: boolean
  radius?: number
  rectLike?: boolean
  /** A polygon with arcs among its points. */
  polyArcs?: boolean
  /** The piece as exact geometry in the board's frame (KiCad's, y down), which is what the outline is built from. */
  geom?: ShapeGeometry | null
}

export interface OutlineGap {
  /** KiCad coordinates in millimetres: where the chain stops, and where the nearest loose end is. */
  from: Pt
  to: Pt | null
  width: number
}

export type OutlineStatus = "closed" | "open chain left" | "no closed loop" | "no outline"

export interface OutlineResult {
  status: OutlineStatus
  /** Of the biggest closed loop: rect, roundrect, roundrect-unequal, polygon, circle, curve or arcs; `open` or `none` without one. */
  shape: string
  pieces: number
  loops: number
  outerLoops: number
  cutouts: number
  openChains: number
  repair: { merged: number; dropped: number; zeroLength: number; moved: number }
  /**
   * The outline as the model holds it (X2): closed loops and the chains left open, exact lines, arcs and curves in the editor's frame (y up),
   * in the order of the file. Every piece is where the file has it; where two ends of a loop meet by up to a tenth of a millimetre and not
   * exactly, a straight connector joins them (`connectors`), and ends within a thousandth of a millimetre are made one point (`snapped`).
   */
  paths: ShapePath[]
  joins: { connectors: number; snapped: number; maxGap: number }
  /** Whether `BoardDef` holds it: one closed rectangle, or one with four equal corner radii, and nothing cut out of it. */
  representable: boolean
  /** The biggest outer loop's bounding box, in KiCad's frame. */
  box: { minX: number; minY: number; maxX: number; maxY: number } | null
  /** The corner radius of a rounded rectangle. */
  cornerRadius: number
  gaps: OutlineGap[]
}

const dist = (p: Xy, q: Xy) => Math.hypot(p[0] - q[0], p[1] - q[1])

function pathsBoxOf(path: ShapePath) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const sg of path.segs) {
    for (const q of flattenSeg(sg, 0.001)) {
      minX = Math.min(minX, q.x)
      minY = Math.min(minY, q.y)
      maxX = Math.max(maxX, q.x)
      maxY = Math.max(maxY, q.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

class UF {
  p: number[]
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]]
      i = this.p[i]
    }
    return i
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b)
  }
}

function pieceOf(s: KicadShape, tf: (p: Pt) => Xy, zero?: { n: number }): Piece | null {
  const piece = pieceOfShape(s, tf, zero)
  if (!piece) return null
  const raw = rawGeometry(s)
  piece.geom = raw ? mapShape(raw, (q) => {
    const r = tf(q)
    return { x: r[0], y: r[1] }
  }) : null
  return piece
}

function pieceOfShape(s: KicadShape, tf: (p: Pt) => Xy, zero?: { n: number }): Piece | null {
  if (s.kind === "ellipse" || s.kind === "ellipse_arc") {
    const raw = rawGeometry(s)
    if (!raw || raw.type !== "ellipse") return null
    const geom = mapShape(raw, (q) => {
      const r = tf(q)
      return { x: r[0], y: r[1] }
    })
    const [path] = shapePaths(geom)
    if (path.closed) {
      const box = pathsBoxOf(path)
      return { kind: "poly", a: null, b: null, pts: [[box.minX, box.minY], [box.maxX, box.maxY]], rectLike: false, polyArcs: true }
    }
    const a = segStart(path.segs[0])
    const b = segEnd(path.segs[path.segs.length - 1])
    return { kind: "curve", a: [a.x, a.y], b: [b.x, b.y], pts: [[a.x, a.y], [b.x, b.y]] }
  }
  if (s.kind === "bbox") return pieceOfShape({ ...s, kind: "rect" }, tf, zero)
  if (s.kind === "line") {
    if (!s.start || !s.end) return null
    const a = tf(s.start)
    const b = tf(s.end)
    if (dist(a, b) < 0.001) {
      if (zero) zero.n++
      return null
    }
    return { kind: "line", a, b, pts: [a, b] }
  }
  if (s.kind === "circle") {
    if (!s.center || !s.end) return null
    const c = tf(s.center)
    const e = tf(s.end)
    const r = dist(c, e)
    return { kind: "circle", a: null, b: null, pts: [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]] }
  }
  if (s.kind === "rect") {
    if (!s.start || !s.end) return null
    return { kind: "rect", a: null, b: null, pts: [tf(s.start), tf(s.end)] }
  }
  if (s.kind === "poly") {
    const pts = (s.pts ?? []).map(tf)
    if (pts.length < 3) return null
    // A polygon with arcs among its points is not a plain polygon: it is classed with the arcs.
    if (s.hasArcs) return { kind: "poly", a: null, b: null, pts, rectLike: false, polyArcs: true }
    const rectLike = pts.length === 4 && pts.every((p, i) => Math.abs(p[0] - pts[(i + 1) % 4][0]) < 0.01 || Math.abs(p[1] - pts[(i + 1) % 4][1]) < 0.01)
    return { kind: "poly", a: null, b: null, pts, rectLike }
  }
  if (s.kind === "curve") {
    const pts = (s.pts ?? []).map(tf)
    if (pts.length < 2) return null
    return { kind: "curve", a: pts[0], b: pts[pts.length - 1], pts }
  }
  if (s.kind === "arc") {
    if (!s.start || !s.mid || !s.end) return null
    const S = tf(s.start)
    const M = tf(s.mid)
    const E = tf(s.end)
    const through = arcThrough({ x: S[0], y: S[1] }, { x: M[0], y: M[1] }, { x: E[0], y: E[1] })
    // an arc that starts where it ends is a circle, unless it is a speck: a micro arc is a short piece like any other
    const fullCircle = dist(S, E) < 0.01 && dist(S, M) > 0.05
    const sweep = s.legacySweep !== undefined ? Math.abs(s.legacySweep) : (through?.sweep ?? 0)
    return { kind: "arc", a: S, b: E, pts: [S, M, E], quarter: Math.abs(sweep - 90) < 3, fullCircle, radius: through?.radius ?? 0 }
  }
  return null
}

/** Whether a drawing's layer is the board's edge: `Edge.Cuts`, or the name an old board in Italian, Polish or French gives it, which KiCad itself maps (`createOldLayerMapping`). */
const isEdgeLayer = (layer: string) => layer === "Edge.Cuts" || TRANSLATED_LAYER_NAMES[layer] === "Edge.Cuts"

/** The Edge.Cuts pieces of a board, footprints' included, in the board's frame. `zero` counts the lines of no length that are left out. */
export function edgePieces(board: KicadBoard, zero?: { n: number }): Piece[] {
  const out: Piece[] = []
  for (const s of board.shapes) {
    if (!isEdgeLayer(s.layer)) continue
    const p = pieceOf(s, (q) => [q.x, q.y], zero)
    if (p) out.push(p)
  }
  for (const fp of board.footprints) {
    for (const s of fp.shapes) {
      if (!isEdgeLayer(s.layer)) continue
      const p = pieceOf(
        s,
        (q) => {
          const r = rotK(q.x, q.y, fp.angle)
          return [fp.at.x + r.x, fp.at.y + r.y]
        },
        zero,
      )
      if (p) out.push(p)
    }
  }
  return out
}

function repairPieces(pieces: Piece[], tol: number, stats: { merged: number; dropped: number; moved: number }): Piece[] {
  const lines = pieces.filter((p) => p.kind === "line")
  const others = pieces.filter((p) => p.kind !== "line")
  interface Cluster {
    ux: number
    uy: number
    p0: Xy
    /** Each piece's extent along the line, and how far its ends are from it. */
    spans: [number, number, number, Piece][]
  }
  const clusters: Cluster[] = []
  for (const l of lines) {
    const a = l.a!
    const b = l.b!
    const len = dist(a, b)
    let ux = (b[0] - a[0]) / len
    let uy = (b[1] - a[1]) / len
    if (ux < 0 || (ux === 0 && uy < 0)) {
      ux = -ux
      uy = -uy
    }
    const c = clusters.find((k) => Math.abs(k.ux * uy - k.uy * ux) < 0.01 && Math.abs(k.uy * (a[0] - k.p0[0]) - k.ux * (a[1] - k.p0[1])) <= tol && Math.abs(k.uy * (b[0] - k.p0[0]) - k.ux * (b[1] - k.p0[1])) <= tol)
    const k = c ?? { ux, uy, p0: a, spans: [] }
    if (!c) clusters.push(k)
    const t0 = (a[0] - k.p0[0]) * k.ux + (a[1] - k.p0[1]) * k.uy
    const t1 = (b[0] - k.p0[0]) * k.ux + (b[1] - k.p0[1]) * k.uy
    const off = (p: Xy) => Math.abs(k.uy * (p[0] - k.p0[0]) - k.ux * (p[1] - k.p0[1]))
    k.spans.push([Math.min(t0, t1), Math.max(t0, t1), Math.max(off(a), off(b)), l])
  }
  const out: Piece[] = []
  const stubs: Piece[] = []
  for (const p of others) {
    const extent = p.a && p.b ? Math.max(...p.pts.map((q) => Math.max(dist(q, p.a!), dist(q, p.b!)))) : Infinity
    if (p.a && p.b && !p.fullCircle && extent < tol) stubs.push(p)
    else out.push(p)
  }
  for (const k of clusters) {
    k.spans.sort((a, b) => a[0] - b[0])
    // Pieces that overlap are one line drawn twice, however far (within the tolerance) the second is off; pieces that only
    // meet end to end are one line only when both lie on it exactly, since otherwise their joint is a corner of the outline.
    const merged: { t0: number; t1: number; dev: number; members: [number, number, number, Piece][] }[] = []
    for (const sp of k.spans) {
      const last = merged[merged.length - 1]
      if (last && (sp[0] < last.t1 || (sp[0] <= last.t1 + tol && sp[2] <= EXACT_TOLERANCE && last.dev <= EXACT_TOLERANCE))) {
        last.t1 = Math.max(last.t1, sp[1])
        last.dev = Math.max(last.dev, sp[2])
        last.members.push(sp)
      } else merged.push({ t0: sp[0], t1: sp[1], dev: sp[2], members: [sp] })
    }
    stats.merged += k.spans.length - merged.length
    for (const g of merged) {
      // A piece that merges with nothing stays exactly where the file has it; only a merged run is rebuilt on the line.
      if (g.members.length === 1) {
        const original = g.members[0][3]
        if (g.t1 - g.t0 < tol) stubs.push(original)
        else out.push(original)
        continue
      }
      // Every member that does not lie on the merged line moves with it, and is counted.
      stats.moved += g.members.filter((m) => m[2] > 1e-6).length
      const a: Xy = [k.p0[0] + k.ux * g.t0, k.p0[1] + k.uy * g.t0]
      const b: Xy = [k.p0[0] + k.ux * g.t1, k.p0[1] + k.uy * g.t1]
      const piece: Piece = { kind: "line", a, b, pts: [a, b] }
      if (g.t1 - g.t0 < tol) stubs.push(piece)
      else out.push(piece)
    }
  }
  // A short piece stays when both its ends meet the ends of other pieces: it is part of the loop
  // (a chamfer, one step of an arc drawn in tiny lines), and dropping it would open the outline.
  const ends: Xy[] = []
  for (const p of out) if (p.a && p.b) ends.push(p.a, p.b)
  for (const s of stubs) if (s.a && s.b) ends.push(s.a, s.b)
  for (const s of stubs) {
    const near = (pt: Xy) => ends.filter((e) => e !== s.a && e !== s.b && dist(e, pt) <= TOUCH).length
    if (near(s.a!) > 0 && near(s.b!) > 0) out.push(s)
    else stats.dropped++
  }
  return out
}

interface Seq {
  p: Piece
  a: Xy
  b: Xy
  /** The vertices a merged straight run passed through between `a` and `b`: each still lies on the run within `EXACT_TOLERANCE`. */
  joints?: Xy[]
}

/** The pieces of a closed chain in order, each oriented to end where the next begins, following the matched ends. */
function orderLoop(ps: Piece[], first: number, partner: Int32Array): Seq[] | null {
  const seq: Seq[] = []
  const seen = new Set<number>()
  let i = 0
  let enter = 0
  for (;;) {
    if (seen.has(i)) return null
    seen.add(i)
    const p = ps[i]
    const a = enter === 0 ? p.a! : p.b!
    const b = enter === 0 ? p.b! : p.a!
    seq.push({ p, a, b })
    const next = partner[2 * (first + i) + (1 - enter)]
    if (next < 0) return null
    const j = (next >> 1) - first
    if (j === 0) break
    if (j < 0 || j >= ps.length) return null
    i = j
    enter = next & 1
  }
  return seq.length === ps.length ? seq : null
}

/** Distance from a point to the segment a to b. */
function toSegment(p: Xy, a: Xy, b: Xy): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/**
 * One straight side drawn in several pieces becomes one line, but only when every joint between
 * them lies on the merged line within `EXACT_TOLERANCE`: a joint 0.2 mm off is a corner of the
 * outline, and merging it would move the edge. (An earlier version merged any pieces within half a
 * degree, which made a 100 by 50 board with a 0.2 mm kink a rectangle.)
 */
function mergeCollinear(seq: Seq[]): Seq[] {
  const straight = (s: Seq) => s.p.kind === "line"
  /** The two pieces joined: null when a joint of either leaves the merged line, or the second turns back. */
  const join = (u: Seq, v: Seq): Seq | null => {
    if ((u.b[0] - u.a[0]) * (v.b[0] - v.a[0]) + (u.b[1] - u.a[1]) * (v.b[1] - v.a[1]) <= 0) return null
    // Both ends of the joint count: they meet within the join tolerance and not always exactly, and each must lie on the merged line.
    const joints = [...(u.joints ?? []), u.b, v.a, ...(v.joints ?? [])]
    if (joints.some((j) => toSegment(j, u.a, v.b) > EXACT_TOLERANCE)) return null
    return { p: u.p, a: u.a, b: v.b, joints }
  }
  const out: Seq[] = []
  for (const s of seq) {
    const last = out[out.length - 1]
    const joined = last && straight(last) && straight(s) ? join(last, s) : null
    if (joined) out[out.length - 1] = joined
    else out.push({ ...s })
  }
  while (out.length > 2 && straight(out[0]) && straight(out[out.length - 1])) {
    const joined = join(out[out.length - 1], out[0])
    if (!joined) break
    out.pop()
    out[0] = joined
  }
  return out
}

interface Loop {
  kinds: string[]
  pts: Xy[]
  pieces: Piece[]
  merged: Seq[] | null
  box: { minX: number; minY: number; maxX: number; maxY: number; area: number }
  shape: string
}

type Box = { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Whether the pieces of a closed chain are exactly a rectangle with a rounded corner at each of
 * four places, or none: every piece lies on the box's boundary within `EXACT_TOLERANCE`. Four arcs
 * are four convex corners (the arc's middle point is where a circle of its radius tucked into that
 * corner has it, so an arc that bends the other way is no corner), each starts and ends at the
 * tangent points of its own corner, and each side that is longer than its two corners need has
 * exactly one line, from tangent point to tangent point. Returns each corner's radius (0 for a
 * square corner), clockwise on screen from the top left, or null.
 */
function fitBox(seq: Seq[], box: Box): number[] | null {
  const near = (p: Xy, x: number, y: number) => Math.abs(p[0] - x) <= EXACT_TOLERANCE && Math.abs(p[1] - y) <= EXACT_TOLERANCE
  const lines = seq.filter((s) => s.p.kind === "line")
  const arcs = seq.filter((s) => s.p.kind === "arc")
  if (lines.length + arcs.length !== seq.length || (arcs.length !== 0 && arcs.length !== 4)) return null
  const { minX, minY, maxX, maxY } = box
  const w = maxX - minX
  const h = maxY - minY
  // The corner points and which way is inward on each axis: top left, top right, bottom right, bottom left.
  const corners = [
    { x: minX, y: minY, sx: 1, sy: 1 },
    { x: maxX, y: minY, sx: -1, sy: 1 },
    { x: maxX, y: maxY, sx: -1, sy: -1 },
    { x: minX, y: maxY, sx: 1, sy: -1 },
  ]
  const radii = [0, 0, 0, 0]
  if (arcs.length === 4) {
    const used = new Set<number>()
    for (const arc of arcs) {
      const r = arc.p.radius ?? 0
      const [s, m, e] = arc.p.pts
      let found = -1
      corners.forEach((c, k) => {
        if (found >= 0 || used.has(k) || r <= 0) return
        const t1: Xy = [c.x + c.sx * r, c.y]
        const t2: Xy = [c.x, c.y + c.sy * r]
        const ends = (near(s, t1[0], t1[1]) && near(e, t2[0], t2[1])) || (near(s, t2[0], t2[1]) && near(e, t1[0], t1[1]))
        const k2 = Math.SQRT1_2
        const mid = near(m, c.x + c.sx * r - c.sx * r * k2, c.y + c.sy * r - c.sy * r * k2)
        if (ends && mid) found = k
      })
      if (found < 0) return null
      used.add(found)
      radii[found] = r
    }
    if (radii[0] + radii[1] > w + EXACT_TOLERANCE || radii[3] + radii[2] > w + EXACT_TOLERANCE || radii[0] + radii[3] > h + EXACT_TOLERANCE || radii[1] + radii[2] > h + EXACT_TOLERANCE) return null
  }
  // The four sides, each as the two points a line on it runs between (nothing when the corners meet).
  const sides: [Xy, Xy][] = [
    [[minX + radii[0], minY], [maxX - radii[1], minY]],
    [[maxX, minY + radii[1]], [maxX, maxY - radii[2]]],
    [[minX + radii[3], maxY], [maxX - radii[2], maxY]],
    [[minX, minY + radii[0]], [minX, maxY - radii[3]]],
  ]
  const taken = new Set<number>()
  for (const [a, b] of sides) {
    if (dist(a, b) <= EXACT_TOLERANCE) continue
    const i = lines.findIndex((l, n) => !taken.has(n) && ((near(l.a, a[0], a[1]) && near(l.b, b[0], b[1])) || (near(l.a, b[0], b[1]) && near(l.b, a[0], a[1]))))
    if (i < 0) return null
    taken.add(i)
  }
  return taken.size === lines.length ? radii : null
}

const boxOf = (pts: Xy[]): Box => ({ minX: Math.min(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxX: Math.max(...pts.map((p) => p[0])), maxY: Math.max(...pts.map((p) => p[1])) })

function classifyLoop(l: Omit<Loop, "box" | "shape">): string {
  const ks = l.kinds
  if (ks.includes("curve")) return "curve"
  if (ks.length === 1 && ks[0] === "circle") return "circle"
  if (ks.length === 1 && ks[0] === "rect") return "rect"
  if (ks.length === 1 && ks[0] === "poly") {
    const piece = l.pieces[0]
    if (piece.polyArcs) return "arcs"
    // A polygon of four points is a rectangle only when each point is a corner of its bounding box.
    if (piece.pts.length === 4) {
      const seq: Seq[] = piece.pts.map((a, i) => ({ p: { kind: "line", a, b: piece.pts[(i + 1) % 4], pts: [a, piece.pts[(i + 1) % 4]] }, a, b: piece.pts[(i + 1) % 4] }))
      if (fitBox(seq, boxOf(piece.pts))) return "rect"
    }
    return "polygon"
  }
  const seq = l.merged ?? l.pieces.map((p) => ({ p, a: p.a!, b: p.b! }))
  const lines = seq.filter((x) => x.p.kind === "line")
  const arcs = seq.filter((x) => x.p.kind === "arc")
  if (!arcs.length) return lines.length === 4 && fitBox(seq, boxOf(l.pts)) ? "rect" : "polygon"
  if (!lines.length && arcs.every((x) => x.p.fullCircle)) return "circle"
  if (arcs.length === 4) {
    const radii = fitBox(seq, boxOf(l.pts))
    if (radii) return Math.max(...radii) - Math.min(...radii) <= EXACT_TOLERANCE ? "roundrect" : "roundrect-unequal"
  }
  return "arcs"
}

// ---------- the outline as exact paths ----------

const negate = (q: Vec2): Vec2 => ({ x: q.x, y: -q.y })

/** A piece of the board's frame (y down) in the editor's (y up): the same piece mirrored, an arc through the mirrored three points. */
function toEditor(sg: PathSeg): PathSeg {
  switch (sg.kind) {
    case "line":
      return { kind: "line", a: negate(sg.a), b: negate(sg.b) }
    case "arc":
      return { kind: "arc", start: negate(sg.start), mid: negate(sg.mid), end: negate(sg.end) }
    case "bezier":
      return { kind: "bezier", p0: negate(sg.p0), c1: negate(sg.c1), c2: negate(sg.c2), p1: negate(sg.p1) }
    case "ellipse": {
      // Mirrored in y: (rx cos t, ry sin t) turned by rot becomes the same turned by -rot at -t.
      return { kind: "ellipse", c: negate(sg.c), rx: sg.rx, ry: sg.ry, rot: -sg.rot, t0: -sg.t1, t1: -sg.t0 }
    }
  }
}

/** The segs of one piece, oriented to run from `from` (an arc or curve is turned round when `from` is its far end). Null for an elliptical arc run backwards: it is held counter-clockwise only. */
function orientedSegs(piece: Piece, from: Xy, a: Xy, b: Xy): PathSeg[] {
  const geom = piece.geom
  if (!geom) return [{ kind: "line", a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } }]
  if (piece.kind === "line") return [{ kind: "line", a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } }]
  const [path] = shapePaths(geom)
  const forward = dist(from, [segStart(path.segs[0]).x, segStart(path.segs[0]).y]) <= dist(from, [segEnd(path.segs[path.segs.length - 1]).x, segEnd(path.segs[path.segs.length - 1]).y])
  if (forward) return path.segs
  const back = reversePath({ closed: false, segs: path.segs })
  if (back) return back.segs
  // An elliptical arc run backwards is held as short straight pieces within the flattening tolerance.
  const pts = path.segs.flatMap((sg) => flattenSeg(sg, 0.0002)).reverse()
  return pts.slice(1).map((q, i): PathSeg => ({ kind: "line", a: pts[i], b: q }))
}

function setStart(sg: PathSeg, to: Vec2): PathSeg {
  switch (sg.kind) {
    case "line":
      return { ...sg, a: to }
    case "arc":
      return { ...sg, start: to }
    case "bezier":
      return { ...sg, p0: to }
    case "ellipse":
      return sg
  }
}

/**
 * Pieces in order, each running into the next, as one path of the model. A joint whose two ends are the same point stays as it is; ends
 * within a thousandth of a millimetre are made one point (the next piece begins where the last ended); ends further apart, as far as the join
 * tolerance, are joined by a straight connector, so no piece of the file is moved.
 */
function pathOf(chain: { piece: Piece; segs: PathSeg[] }[], closed: boolean, joins: { connectors: number; snapped: number; maxGap: number }): ShapePath {
  const segs: PathSeg[] = []
  const link = (to: PathSeg) => {
    const last = segs[segs.length - 1]
    if (!last) {
      segs.push(to)
      return
    }
    const e = segEnd(last)
    const st = segStart(to)
    const gap = Math.hypot(e.x - st.x, e.y - st.y)
    if (gap === 0) segs.push(to)
    else if (gap <= EXACT_TOLERANCE && to.kind !== "ellipse") {
      joins.snapped++
      segs.push(setStart(to, e))
    } else {
      joins.connectors++
      joins.maxGap = Math.max(joins.maxGap, gap)
      segs.push({ kind: "line", a: e, b: st }, to)
    }
  }
  for (const c of chain) for (const sg of c.segs) link(sg)
  if (closed && segs.length) {
    const e = segEnd(segs[segs.length - 1])
    const st = segStart(segs[0])
    const gap = Math.hypot(e.x - st.x, e.y - st.y)
    if (gap > 0) {
      if (gap <= EXACT_TOLERANCE && segs[segs.length - 1].kind !== "ellipse") {
        joins.snapped++
        const last = segs.length - 1
        const sg = segs[last]
        segs[last] = sg.kind === "line" ? { ...sg, b: st } : sg.kind === "arc" ? { ...sg, end: st } : sg.kind === "bezier" ? { ...sg, p1: st } : sg
      } else {
        joins.connectors++
        joins.maxGap = Math.max(joins.maxGap, gap)
        segs.push({ kind: "line", a: e, b: st })
      }
    }
  }
  return { closed, segs: segs.map(toEditor) }
}

/** The path of a loop of one piece (a circle, a rectangle, a polygon, a whole ellipse), or null when it has none. */
function closedPiecePath(piece: Piece): ShapePath | null {
  const geom = piece.geom
  if (!geom) return null
  if (piece.kind === "arc" && piece.fullCircle) {
    const c = arcCircle({ x: piece.pts[0][0], y: piece.pts[0][1] }, { x: piece.pts[1][0], y: piece.pts[1][1] }, { x: piece.pts[2][0], y: piece.pts[2][1] })
    if (!c) return null
    return { closed: true, segs: shapePaths({ type: "circle", c: c.c, r: c.r })[0].segs.map(toEditor) }
  }
  const [path] = shapePaths(geom)
  return path && path.closed ? { closed: true, segs: path.segs.map(toEditor) } : null
}

/** The outline of a board: its loops, what is left open, and whether the model holds it. */
export function outlineOf(board: KicadBoard, tol = JOIN_TOLERANCE): OutlineResult {
  const zero = { n: 0 }
  const raw = edgePieces(board, zero)
  if (!raw.length) {
    return { status: "no outline", shape: "none", pieces: 0, loops: 0, outerLoops: 0, cutouts: 0, openChains: 0, repair: { merged: 0, dropped: 0, zeroLength: zero.n, moved: 0 }, representable: false, box: null, cornerRadius: 0, gaps: [], paths: [], joins: { connectors: 0, snapped: 0, maxGap: 0 } }
  }
  const repair = { merged: 0, dropped: 0, zeroLength: zero.n, moved: 0 }
  const pieces = repairPieces(raw, tol, repair)
  const open = pieces.filter((p) => p.a)
  const loops: Loop[] = []
  const mk = (kinds: string[], pts: Xy[], ps: Piece[], merged: Seq[] | null): Loop => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [x, y] of pts) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    const base = { kinds, pts, pieces: ps, merged }
    return { ...base, box: { minX, minY, maxX, maxY, area: (maxX - minX) * (maxY - minY) }, shape: classifyLoop(base) }
  }
  const joins = { connectors: 0, snapped: 0, maxGap: 0 }
  const closedPaths: ShapePath[] = []
  const openPaths: ShapePath[] = []
  const addClosed = (path: ShapePath | null) => {
    if (path && path.segs.length) closedPaths.push(path)
  }
  for (const p of pieces) {
    if (!p.a) {
      loops.push(mk([p.kind], p.pts, [p], null))
      addClosed(closedPiecePath(p))
    }
  }

  // Join ends within the tolerance, on a grid so thousands of pieces stay fast. Each end is matched
  // with the nearest end of another piece, so a chamfer of 0.05 mm whose ends meet its neighbours
  // exactly closes the loop instead of confusing every end within the tolerance of it.
  const cell = Math.max(0.05, tol)
  const grid = new Map<string, { id: number; x: number; y: number }[]>()
  const uf = new UF(open.length)
  const key = (cx: number, cy: number) => `${cx},${cy}`
  const pairs: { d: number; i: number; j: number }[] = []
  open.forEach((p, i) => {
    ;[p.a!, p.b!].forEach((e, which) => {
      const id = 2 * i + which
      const cx = Math.floor(e[0] / cell)
      const cy = Math.floor(e[1] / cell)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const o of grid.get(key(cx + dx, cy + dy)) ?? []) {
            const d = Math.hypot(o.x - e[0], o.y - e[1])
            if (d > tol) continue
            uf.union(o.id >> 1, i)
            if (o.id >> 1 !== i) pairs.push({ d, i: o.id, j: id })
          }
        }
      }
      const k = key(cx, cy)
      const bucket = grid.get(k)
      if (bucket) bucket.push({ id, x: e[0], y: e[1] })
      else grid.set(k, [{ id, x: e[0], y: e[1] }])
    })
  })
  pairs.sort((a, b) => a.d - b.d)
  const partner = new Int32Array(2 * open.length).fill(-1)
  for (const { i, j } of pairs) {
    if (partner[i] < 0 && partner[j] < 0) {
      partner[i] = j
      partner[j] = i
    }
  }
  const comps = new Map<number, number[]>()
  open.forEach((_, i) => {
    const r = uf.find(i)
    const list = comps.get(r)
    if (list) list.push(i)
    else comps.set(r, [i])
  })
  let openChains = 0
  const gaps: OutlineGap[] = []
  const looseEnds: Xy[] = []
  for (const members of comps.values()) {
    for (const i of members) {
      if (partner[2 * i] < 0) looseEnds.push(open[i].a!)
      if (partner[2 * i + 1] < 0) looseEnds.push(open[i].b!)
    }
  }
  /** Follows the matched ends from piece `i0`, entered at its end `enter0`: the pieces in order, and whether it came round to where it began. */
  const visited = new Set<number>()
  const walk = (i0: number, enter0: number): { seq: Seq[]; closed: boolean } => {
    const seq: Seq[] = []
    let i = i0
    let enter = enter0
    for (;;) {
      visited.add(i)
      const piece = open[i]
      seq.push({ p: piece, a: enter === 0 ? piece.a! : piece.b!, b: enter === 0 ? piece.b! : piece.a! })
      const next = partner[2 * i + (1 - enter)]
      if (next < 0) return { seq, closed: false }
      const j = next >> 1
      if (j === i0 && (next & 1) === enter0) return { seq, closed: true }
      if (visited.has(j)) return { seq, closed: false }
      i = j
      enter = next & 1
    }
  }
  const chainSegs = (seq: Seq[]) => seq.map((x) => ({ piece: x.p, segs: orientedSegs(x.p, x.a, x.a, x.b) }))
  for (const members of comps.values()) {
    const ps = members.map((i) => open[i])
    const loose: Xy[] = []
    for (const i of members) {
      if (partner[2 * i] < 0) loose.push(open[i].a!)
      if (partner[2 * i + 1] < 0) loose.push(open[i].b!)
    }
    const single = ps.length === 1 && ps[0].kind === "arc" && ps[0].fullCircle
    if (single || (!loose.length && ps.length >= 2)) {
      // pieces of one component are contiguous in `open` only by construction of the sort below
      const idx = members.slice().sort((a, b) => a - b)
      let seq: Seq[] | null = null
      if (ps.length >= 2) {
        // order within the component: renumber so the matched ends can be followed
        const local = new Map(idx.map((g, n) => [g, n]))
        const sub = new Int32Array(2 * idx.length).fill(-1)
        idx.forEach((g, n) => {
          for (const w of [0, 1]) {
            const other = partner[2 * g + w]
            sub[2 * n + w] = other < 0 ? -1 : 2 * local.get(other >> 1)! + (other & 1)
          }
        })
        seq = orderLoop(idx.map((g) => open[g]), 0, sub)
      }
      const merged = seq ? mergeCollinear(seq) : null
      loops.push(mk(ps.map((p) => p.kind), ps.flatMap((p) => p.pts), ps, merged))
      if (single) addClosed(closedPiecePath(ps[0]))
      else if (merged) closedPaths.push(pathOf(chainSegs(merged), true, joins))
      else {
        // The matched ends could not be followed round: whatever they make is kept as the pieces they join.
        for (const i of members) if (!visited.has(i)) {
          const w = walk(i, 0)
          ;(w.closed ? closedPaths : openPaths).push(pathOf(chainSegs(w.seq), w.closed, joins))
        }
      }
    } else {
      // A component with an end that touches nothing: its chains are kept as drawn (the board is "not closed"), and a loop in it is kept as a loop.
      for (const i of members) {
        if (visited.has(i) || (partner[2 * i] >= 0 && partner[2 * i + 1] >= 0)) continue
        const w = walk(i, partner[2 * i] < 0 ? 0 : 1)
        openPaths.push(pathOf(chainSegs(w.seq), false, joins))
      }
      for (const i of members) {
        if (visited.has(i)) continue
        const w = walk(i, 0)
        const pathHere = pathOf(chainSegs(w.closed ? mergeCollinear(w.seq) : w.seq), w.closed, joins)
        ;(w.closed ? closedPaths : openPaths).push(pathHere)
      }
      openChains++
      if (gaps.length < 3 && loose.length) {
        const from = loose[0]
        const nearest = looseEnds.filter((e) => !loose.includes(e)).concat(loose.slice(1)).sort((p, q) => dist(from, p) - dist(from, q))[0]
        gaps.push({ from: { x: from[0], y: from[1] }, to: nearest ? { x: nearest[0], y: nearest[1] } : null, width: nearest ? dist(from, nearest) : 0 })
      }
    }
  }
  loops.sort((a, b) => b.box.area - a.box.area)
  const inside = (a: Loop["box"], b: Loop["box"]) => a.minX >= b.minX - 0.01 && a.maxX <= b.maxX + 0.01 && a.minY >= b.minY - 0.01 && a.maxY <= b.maxY + 0.01
  const outer = loops.filter((l, i) => !loops.some((o, j) => j < i && inside(l.box, o.box)))
  const cutouts = loops.length - outer.length
  const biggest = outer[0]
  const status: OutlineStatus = biggest && openChains === 0 ? "closed" : biggest ? "open chain left" : "no closed loop"
  let cornerRadius = 0
  if (biggest?.shape === "roundrect") {
    // The four radii agree within `EXACT_TOLERANCE` (that is what makes the shape a rounded rectangle), so their mean is each of them to within it.
    const radii = (biggest.merged ?? []).filter((x) => x.p.kind === "arc").map((x) => x.p.radius ?? 0)
    cornerRadius = radii.length ? radii.reduce((a, b) => a + b, 0) / radii.length : 0
  }
  return {
    status,
    shape: biggest ? biggest.shape : "open",
    pieces: raw.length,
    loops: loops.length,
    outerLoops: outer.length,
    cutouts,
    openChains,
    repair,
    representable: !!biggest && outer.length === 1 && cutouts === 0 && openChains === 0 && (biggest.shape === "rect" || biggest.shape === "roundrect"),
    box: biggest ? { minX: biggest.box.minX, minY: biggest.box.minY, maxX: biggest.box.maxX, maxY: biggest.box.maxY } : null,
    cornerRadius,
    gaps,
    paths: [...closedPaths, ...openPaths],
    joins,
  }
}
