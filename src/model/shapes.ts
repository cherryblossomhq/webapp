import { dist, emptyBox, expandBox, pointSegmentDistance, segmentSegmentDistance, type Box } from "../lib/geometry"
import type { BoardShape, ShapeDash, ShapeGeometry, ShapePoint, Vec2 } from "./types"

// The geometry of a board or footprint drawing: its outline as exact pieces (lines, arcs, curves,
// elliptical arcs), flattened where a tool needs points, mapped from a footprint's frame onto the
// board, and cut into dashes. Nothing here rounds to an angle: an arc is the circle through its
// three points, and every flattening says how far from the true curve it may be.

const TAU = Math.PI * 2
const DEG = Math.PI / 180

/** How far a flattened curve may be from the true one (mm). The editor and the Gerber use this, a fifth of the 0.001 mm the importer promises. */
export const FLATTEN_TOLERANCE = 0.0002

/** The most points one arc or ellipse is flattened to: 0.0002 mm accuracy needs fewer on any radius under a kilometre. */
const MAX_FLATTEN_POINTS = 100_000

/** KiCad's width for a drawing a file gives none (`DEFAULT_LINE_WIDTH`). */
export const DEFAULT_SHAPE_WIDTH = 0.1

// ---------- exact outline pieces ----------

export type PathSeg =
  | { kind: "line"; a: Vec2; b: Vec2 }
  /** A circular arc through three points, from `start` to `end`; which way round follows from `mid`. */
  | { kind: "arc"; start: Vec2; mid: Vec2; end: Vec2 }
  | { kind: "bezier"; p0: Vec2; c1: Vec2; c2: Vec2; p1: Vec2 }
  /** An elliptical arc (a whole ellipse is a sweep of 2 pi): `(rx cos t, ry sin t)` turned by `rot`, t from `t0` to `t1` counter-clockwise (radians). */
  | { kind: "ellipse"; c: Vec2; rx: number; ry: number; rot: number; t0: number; t1: number }

export interface ShapePath {
  closed: boolean
  segs: PathSeg[]
}

export interface ArcCircle {
  c: Vec2
  r: number
  /** Counter-clockwise (y up) from start to end. */
  ccw: boolean
  /** The angle of the start point, radians. */
  a0: number
  /** The signed sweep, radians: positive counter-clockwise, never more than a full turn. */
  sweep: number
}

const same = (p: Vec2, q: Vec2, eps = 1e-9) => Math.abs(p.x - q.x) <= eps && Math.abs(p.y - q.y) <= eps

/** The circle through an arc's three points and the way round, or null when they lie on a line. */
export function arcCircle(start: Vec2, mid: Vec2, end: Vec2): ArcCircle | null {
  if (same(start, end)) {
    // A full circle written as an arc: it has to go through `mid`, so its centre is halfway.
    if (same(start, mid)) return null
    const c = { x: (start.x + mid.x) / 2, y: (start.y + mid.y) / 2 }
    return { c, r: dist(c, start), ccw: true, a0: Math.atan2(start.y - c.y, start.x - c.x), sweep: TAU }
  }
  const ax = start.x
  const ay = start.y
  const bx = mid.x
  const by = mid.y
  const cx = end.x
  const cy = end.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return null
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const c = { x: ux, y: uy }
  const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
  const ccw = cross > 0
  const a0 = Math.atan2(ay - uy, ax - ux)
  const a1 = Math.atan2(cy - uy, cx - ux)
  let sweep = ccw ? a1 - a0 : a0 - a1
  while (sweep <= 0) sweep += TAU
  while (sweep > TAU) sweep -= TAU
  return { c, r: Math.hypot(ax - ux, ay - uy), ccw, a0, sweep: ccw ? sweep : -sweep }
}

/** A point of an arc's circle at an angle. */
const onCircle = (c: Vec2, r: number, a: number): Vec2 => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })

const rectBounds = (g: Extract<ShapeGeometry, { type: "rect" }>) => ({ minX: Math.min(g.a.x, g.b.x), maxX: Math.max(g.a.x, g.b.x), minY: Math.min(g.a.y, g.b.y), maxY: Math.max(g.a.y, g.b.y) })

/** A rectangle's clamped corner radius. */
export function rectRadius(g: Extract<ShapeGeometry, { type: "rect" }>): number {
  const r = g.radius ?? 0
  const b = rectBounds(g)
  return Math.max(0, Math.min(r, (b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2))
}

function ringPath(pts: ShapePoint[]): ShapePath {
  const segs: PathSeg[] = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const to = pts[i]
    const from = pts[(i + n - 1) % n]
    if (i === 0 && !to.mid && n < 3) continue
    segs.push(to.mid ? { kind: "arc", start: { x: from.x, y: from.y }, mid: { x: to.mid.x, y: to.mid.y }, end: { x: to.x, y: to.y } } : { kind: "line", a: { x: from.x, y: from.y }, b: { x: to.x, y: to.y } })
  }
  return { closed: true, segs }
}

/** The ellipse's point at parameter `t`. */
export function ellipsePoint(c: Vec2, rx: number, ry: number, rot: number, t: number): Vec2 {
  const lx = rx * Math.cos(t)
  const ly = ry * Math.sin(t)
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  return { x: c.x + lx * cs - ly * sn, y: c.y + lx * sn + ly * cs }
}

/** The pieces a shape is drawn along, as open or closed paths: the centre line of its stroke and the edge of its fill. */
export function shapePaths(shape: ShapeGeometry): ShapePath[] {
  switch (shape.type) {
    case "line":
      return [{ closed: false, segs: [{ kind: "line", a: shape.a, b: shape.b }] }]
    case "arc":
      return [{ closed: false, segs: [arcCircle(shape.start, shape.mid, shape.end) ? { kind: "arc", start: shape.start, mid: shape.mid, end: shape.end } : { kind: "line", a: shape.start, b: shape.end }] }]
    case "circle": {
      const { c, r } = shape
      const e = { x: c.x + r, y: c.y }
      const w = { x: c.x - r, y: c.y }
      return [{ closed: true, segs: [{ kind: "arc", start: e, mid: { x: c.x, y: c.y + r }, end: w }, { kind: "arc", start: w, mid: { x: c.x, y: c.y - r }, end: e }] }]
    }
    case "rect": {
      const b = rectBounds(shape)
      const r = rectRadius(shape)
      const { minX, maxX, minY, maxY } = b
      if (r < 1e-9) {
        const p = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
        return [{ closed: true, segs: p.map((q, i) => ({ kind: "line" as const, a: q, b: p[(i + 1) % 4] })) }]
      }
      const k = r * Math.SQRT1_2
      const corner = (cx: number, cy: number, sx: number, sy: number, from: Vec2, to: Vec2): PathSeg => ({ kind: "arc", start: from, mid: { x: cx + sx * k, y: cy + sy * k }, end: to })
      const segs: PathSeg[] = [
        { kind: "line", a: { x: minX + r, y: minY }, b: { x: maxX - r, y: minY } },
        corner(maxX - r, minY + r, 1, -1, { x: maxX - r, y: minY }, { x: maxX, y: minY + r }),
        { kind: "line", a: { x: maxX, y: minY + r }, b: { x: maxX, y: maxY - r } },
        corner(maxX - r, maxY - r, 1, 1, { x: maxX, y: maxY - r }, { x: maxX - r, y: maxY }),
        { kind: "line", a: { x: maxX - r, y: maxY }, b: { x: minX + r, y: maxY } },
        corner(minX + r, maxY - r, -1, 1, { x: minX + r, y: maxY }, { x: minX, y: maxY - r }),
        { kind: "line", a: { x: minX, y: maxY - r }, b: { x: minX, y: minY + r } },
        corner(minX + r, minY + r, -1, -1, { x: minX, y: minY + r }, { x: minX + r, y: minY }),
      ]
      return [{ closed: true, segs }]
    }
    case "polygon":
      return [shape.pts, ...(shape.holes ?? [])].filter((ring) => ring.length >= 2).map(ringPath)
    case "curve":
      return [{ closed: false, segs: [{ kind: "bezier", p0: shape.p0, c1: shape.c1, c2: shape.c2, p1: shape.p1 }] }]
    case "ellipse": {
      const rot = shape.rot * DEG
      if (shape.from === undefined || shape.to === undefined) return [{ closed: true, segs: [{ kind: "ellipse", c: shape.c, rx: shape.rx, ry: shape.ry, rot, t0: 0, t1: TAU }] }]
      const t0 = shape.from * DEG
      let t1 = shape.to * DEG
      while (t1 <= t0) t1 += TAU
      if (t1 - t0 > TAU) t1 = t0 + TAU
      return [{ closed: false, segs: [{ kind: "ellipse", c: shape.c, rx: shape.rx, ry: shape.ry, rot, t0, t1 }] }]
    }
  }
}

export function segStart(s: PathSeg): Vec2 {
  switch (s.kind) {
    case "line":
      return s.a
    case "arc":
      return s.start
    case "bezier":
      return s.p0
    case "ellipse":
      return ellipsePoint(s.c, s.rx, s.ry, s.rot, s.t0)
  }
}

export function segEnd(s: PathSeg): Vec2 {
  switch (s.kind) {
    case "line":
      return s.b
    case "arc":
      return s.end
    case "bezier":
      return s.p1
    case "ellipse":
      return ellipsePoint(s.c, s.rx, s.ry, s.rot, s.t1)
  }
}

// ---------- flattening ----------

/** Points along an arc, the ends exactly the arc's own, no point more than `tol` from the circle. */
export function flattenArc(start: Vec2, mid: Vec2, end: Vec2, tol = FLATTEN_TOLERANCE): Vec2[] {
  const a = arcCircle(start, mid, end)
  if (!a || a.r < 1e-9) return [start, end]
  const step = a.r <= tol ? Math.PI : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / a.r)))
  // An arc of a radius no board has (a hostile file's near-straight arc) is cut into at most MAX_FLATTEN_POINTS pieces, so it cannot hang a reader.
  const n = Math.min(MAX_FLATTEN_POINTS, Math.max(2, Math.ceil(Math.abs(a.sweep) / step)))
  const out: Vec2[] = [start]
  for (let i = 1; i < n; i++) out.push(onCircle(a.c, a.r, a.a0 + (a.sweep * i) / n))
  out.push(end)
  return out
}

/** Points along a cubic bezier, within `tol` of the curve. */
export function flattenBezier(p0: Vec2, c1: Vec2, c2: Vec2, p1: Vec2, tol = FLATTEN_TOLERANCE): Vec2[] {
  const out: Vec2[] = [p0]
  const rec = (a: Vec2, b: Vec2, c: Vec2, d: Vec2, depth: number) => {
    // The curve stays within 3/4 of the larger distance of its control points from the chord.
    const dd = Math.max(pointSegmentDistance(b, a, d), pointSegmentDistance(c, a, d))
    if (depth >= 18 || dd * 0.75 <= tol) {
      out.push(d)
      return
    }
    const m = (p: Vec2, q: Vec2): Vec2 => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
    const ab = m(a, b)
    const bc = m(b, c)
    const cd = m(c, d)
    const abc = m(ab, bc)
    const bcd = m(bc, cd)
    const mid = m(abc, bcd)
    rec(a, ab, abc, mid, depth + 1)
    rec(mid, bcd, cd, d, depth + 1)
  }
  rec(p0, c1, c2, p1, 0)
  out[out.length - 1] = p1
  return out
}

/** Points along an elliptical arc, within `tol` of the curve. */
export function flattenEllipse(c: Vec2, rx: number, ry: number, rot: number, t0: number, t1: number, tol = FLATTEN_TOLERANCE): Vec2[] {
  const big = Math.max(rx, ry)
  const step = big <= tol ? Math.PI : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / big)))
  const n = Math.min(MAX_FLATTEN_POINTS, Math.max(2, Math.ceil(Math.abs(t1 - t0) / step)))
  const out: Vec2[] = []
  for (let i = 0; i <= n; i++) out.push(ellipsePoint(c, rx, ry, rot, t0 + ((t1 - t0) * i) / n))
  return out
}

export function flattenSeg(s: PathSeg, tol = FLATTEN_TOLERANCE): Vec2[] {
  switch (s.kind) {
    case "line":
      return [s.a, s.b]
    case "arc":
      return flattenArc(s.start, s.mid, s.end, tol)
    case "bezier":
      return flattenBezier(s.p0, s.c1, s.c2, s.p1, tol)
    case "ellipse":
      return flattenEllipse(s.c, s.rx, s.ry, s.rot, s.t0, s.t1, tol)
  }
}

/** A path as one list of points (a closed path does not repeat its first). */
export function flattenPath(path: ShapePath, tol = FLATTEN_TOLERANCE): Vec2[] {
  const out: Vec2[] = []
  for (const s of path.segs) {
    const pts = flattenSeg(s, tol)
    for (let i = out.length ? 1 : 0; i < pts.length; i++) out.push(pts[i])
  }
  if (path.closed && out.length > 1 && same(out[0], out[out.length - 1], 1e-12)) out.pop()
  return out
}

/** The edge of a filled shape: its outline ring, then its holes. */
export function shapeRings(shape: ShapeGeometry, tol = FLATTEN_TOLERANCE): Vec2[][] {
  return shapePaths(shape)
    .filter((p) => p.closed)
    .map((p) => flattenPath(p, tol))
    .filter((r) => r.length >= 3)
}

/** The centre lines of a shape's stroke as lists of points: an open path is one, a closed path repeats its first point. */
export function shapePolylines(shape: ShapeGeometry, tol = FLATTEN_TOLERANCE): Vec2[][] {
  return shapePaths(shape).map((p) => {
    const pts = flattenPath(p, tol)
    return p.closed && pts.length ? [...pts, pts[0]] : pts
  })
}

// ---------- extent ----------

const boxCache = new WeakMap<object, Box>()

/** The box of a shape's geometry (its centre lines and edges), exact for arcs and ellipses; not grown by the stroke. A shape is replaced, never edited, so the box is kept with it. */
export function shapeBox(shape: ShapeGeometry): Box {
  const hit = boxCache.get(shape)
  if (hit) return hit
  const b = computeShapeBox(shape)
  boxCache.set(shape, b)
  return b
}

function computeShapeBox(shape: ShapeGeometry): Box {
  return pathsBox(shapePaths(shape))
}

/** The exact box of some paths (arcs and ellipses to their true extremes), not grown by any stroke. */
export function pathsBox(paths: ShapePath[]): Box {
  const b = emptyBox()
  for (const path of paths) {
    for (const s of path.segs) {
      expandBox(b, segStart(s))
      expandBox(b, segEnd(s))
      if (s.kind === "arc") {
        const a = arcCircle(s.start, s.mid, s.end)
        if (!a) continue
        const lo = a.sweep >= 0 ? a.a0 : a.a0 + a.sweep
        const span = Math.abs(a.sweep)
        for (let k = 0; k < 4; k++) {
          const ang = (k * Math.PI) / 2
          let d = (ang - lo) % TAU
          if (d < 0) d += TAU
          if (d <= span + 1e-12) expandBox(b, onCircle(a.c, a.r, ang))
        }
      } else if (s.kind === "bezier") {
        for (const p of flattenBezier(s.p0, s.c1, s.c2, s.p1, 0.0005)) expandBox(b, p)
      } else if (s.kind === "ellipse") {
        // The extremes are where the derivative is zero: tan t = -(ry sin rot) / (rx cos rot) for x, (ry cos rot) / (rx sin rot) for y.
        const cs = Math.cos(s.rot)
        const sn = Math.sin(s.rot)
        const tx = Math.atan2(-s.ry * sn, s.rx * cs)
        const ty = Math.atan2(s.ry * cs, s.rx * sn)
        for (const base of [tx, tx + Math.PI, ty, ty + Math.PI]) {
          let d = (base - s.t0) % TAU
          if (d < 0) d += TAU
          if (d <= s.t1 - s.t0 + 1e-12) expandBox(b, ellipsePoint(s.c, s.rx, s.ry, s.rot, base))
        }
      }
    }
  }
  return b
}

/** The box of a shape with its stroke: a filled shape is outlined by the stroke too, so it reaches half the width past its edge. */
export function shapeInkBox(shape: BoardShape): Box {
  const b = shapeBox(shape)
  const h = shape.width / 2
  return { minX: b.minX - h, minY: b.minY - h, maxX: b.maxX + h, maxY: b.maxY + h }
}

// ---------- mapping onto another frame ----------

/**
 * A shape with its points sent through `f`, which must be an isometry (a move, a turn by a quarter or
 * any angle, a mirror, or those together): lengths and angles stay, so a circle stays a circle and an
 * arc the arc through the three mapped points. A rectangle stays one when the map keeps it level
 * (quarter turns and mirrors do), and is a polygon otherwise.
 */
export function mapShape<T extends ShapeGeometry>(shape: T, f: (p: Vec2) => Vec2): T {
  const p = (q: Vec2) => f(q)
  const g = shape as ShapeGeometry
  let out: ShapeGeometry
  switch (g.type) {
    case "line":
      out = { ...g, a: p(g.a), b: p(g.b) }
      break
    case "arc":
      out = { ...g, start: p(g.start), mid: p(g.mid), end: p(g.end) }
      break
    case "circle":
      out = { ...g, c: p(g.c) }
      break
    case "rect": {
      const o = f({ x: 0, y: 0 })
      const ex = f({ x: 1, y: 0 })
      const ey = f({ x: 0, y: 1 })
      const level = (Math.abs(ex.y - o.y) < 1e-9 && Math.abs(ey.x - o.x) < 1e-9) || (Math.abs(ex.x - o.x) < 1e-9 && Math.abs(ey.y - o.y) < 1e-9)
      if (level) out = { ...g, a: p(g.a), b: p(g.b) }
      else {
        const [path] = shapePaths(g)
        // Its outline as a polygon: corners, and the arcs of a rounded one.
        const pts: ShapePoint[] = []
        for (const s of path.segs) {
          if (s.kind === "line") pts.push(p(s.b))
          else if (s.kind === "arc") pts.push({ ...p(s.end), mid: p(s.mid) })
        }
        // The drawing's style (layer, width, dash, fill, net, lock) goes with it: only the geometry is a polygon now.
        const { a: _a, b: _b, radius: _radius, ...style } = g
        out = { ...style, type: "polygon", pts }
      }
      break
    }
    case "polygon": {
      const ring = (pts: ShapePoint[]) => pts.map((q) => (q.mid ? { ...p(q), mid: p(q.mid) } : p(q)))
      out = { ...g, pts: ring(g.pts), ...(g.holes ? { holes: g.holes.map(ring) } : {}) }
      break
    }
    case "curve":
      out = { ...g, p0: p(g.p0), c1: p(g.c1), c2: p(g.c2), p1: p(g.p1) }
      break
    case "ellipse": {
      const c = f(g.c)
      const rot = g.rot * DEG
      const major = f({ x: g.c.x + Math.cos(rot), y: g.c.y + Math.sin(rot) })
      const minor = f({ x: g.c.x - Math.sin(rot), y: g.c.y + Math.cos(rot) })
      const u = { x: major.x - c.x, y: major.y - c.y }
      const v = { x: minor.x - c.x, y: minor.y - c.y }
      const flip = u.x * v.y - u.y * v.x < 0
      const rot2 = (Math.atan2(u.y, u.x) / DEG + 360) % 360
      if (flip && g.from !== undefined && g.to !== undefined) out = { ...g, c, rot: rot2, from: -g.to, to: -g.from }
      else out = { ...g, c, rot: rot2 }
      break
    }
  }
  return out as T
}

// ---------- distance and containment (for checks and picking) ----------

/** Whether a point is inside a ring (even-odd with the holes). */
export function pointInRings(p: Vec2, rings: Vec2[][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

/** A shape reduced to what a distance needs: the line pieces of its outline (each with the half width of its stroke round it), and the rings a filled shape covers inside its edge. */
export interface ShapeCopper {
  edges: [Vec2, Vec2][]
  half: number
  /** The ring and holes a filled shape covers (empty for one that is only outlined). */
  fill: Vec2[][]
}

export function shapeCopper(shape: BoardShape, tol = FLATTEN_TOLERANCE): ShapeCopper {
  const edges: [Vec2, Vec2][] = []
  for (const line of shapePolylines(shape, tol)) for (let i = 0; i + 1 < line.length; i++) edges.push([line[i], line[i + 1]])
  return { edges, half: shape.width / 2, fill: shape.fill ? shapeRings(shape, tol) : [] }
}

/** Distance from a point to the copper of a shape, 0 inside it. */
export function pointShapeDistance(p: Vec2, c: ShapeCopper): number {
  if (c.fill.length && pointInRings(p, c.fill)) return 0
  let best = Infinity
  for (const [a, b] of c.edges) best = Math.min(best, pointSegmentDistance(p, a, b))
  return Math.max(0, best - c.half)
}

/** Distance between the copper of two shapes, 0 where they touch or one lies inside the other. */
export function shapeShapeDistance(x: ShapeCopper, y: ShapeCopper): number {
  if (x.fill.length && y.edges.length && pointInRings(y.edges[0][0], x.fill)) return 0
  if (y.fill.length && x.edges.length && pointInRings(x.edges[0][0], y.fill)) return 0
  let best = Infinity
  for (const [a, b] of x.edges) for (const [p, q] of y.edges) best = Math.min(best, segmentSegmentDistance(a, b, p, q))
  return Math.max(0, best - x.half - y.half)
}

// ---------- dashes ----------

/** The pattern of a dash style at a line width, as KiCad draws it (render_settings.cpp: a dash is 11 widths, a dot 0.2, a gap 4): lengths of "on", "off" and so on. */
export function dashPattern(dash: ShapeDash, width: number): number[] {
  const w = Math.max(width, 1e-6)
  const D = 11 * w
  const T = 0.2 * w
  const G = 4 * w
  switch (dash) {
    case "dash":
      return [D, G]
    case "dot":
      return [T, G]
    case "dash_dot":
      return [D, G, T, G]
    case "dash_dot_dot":
      return [D, G, T, G, T, G]
  }
}

/** What a dash piece is: a straight piece, an arc of the circle, or a run of points (a curve flattened). */
export type DashPiece = { kind: "line"; a: Vec2; b: Vec2 } | { kind: "arc"; start: Vec2; mid: Vec2; end: Vec2 } | { kind: "poly"; pts: Vec2[] }

/** Lengths along a polyline cut by the pattern; the pattern carries across corners. */
function dashPolyline(pts: Vec2[], pattern: number[], out: DashPiece[], state = { index: 0, left: pattern[0] }) {
  let run: Vec2[] | null = null
  const flush = () => {
    if (run && run.length > 1) out.push(run.length === 2 ? { kind: "line", a: run[0], b: run[1] } : { kind: "poly", pts: run })
    run = null
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const len = dist(a, b)
    if (len === 0) continue
    let at = 0
    while (at < len - 1e-12) {
      const take = Math.min(state.left, len - at)
      const from = { x: a.x + ((b.x - a.x) * at) / len, y: a.y + ((b.y - a.y) * at) / len }
      const to = { x: a.x + ((b.x - a.x) * (at + take)) / len, y: a.y + ((b.y - a.y) * (at + take)) / len }
      if (state.index % 2 === 0) {
        if (!run) run = [from]
        run.push(to)
      } else flush()
      at += take
      state.left -= take
      if (state.left <= 1e-12) {
        state.index++
        state.left = pattern[state.index % pattern.length]
        if (state.index % 2 === 1) flush()
      }
    }
  }
  flush()
}

/** An arc cut by the pattern into arcs, by angle along the circle. */
function dashArc(seg: Extract<PathSeg, { kind: "arc" }>, pattern: number[], out: DashPiece[]) {
  const a = arcCircle(seg.start, seg.mid, seg.end)
  if (!a || a.r < 1e-9) return dashPolyline([seg.start, seg.end], pattern, out)
  const total = Math.abs(a.sweep) * a.r
  const sign = a.sweep >= 0 ? 1 : -1
  let at = 0
  let i = 0
  while (at < total - 1e-12) {
    const len = pattern[i % pattern.length]
    const to = Math.min(at + len, total)
    if (i % 2 === 0 && to > at) {
      const s0 = a.a0 + (sign * at) / a.r
      const s1 = a.a0 + (sign * to) / a.r
      const start = at === 0 ? seg.start : onCircle(a.c, a.r, s0)
      const end = to >= total ? seg.end : onCircle(a.c, a.r, s1)
      out.push({ kind: "arc", start, mid: onCircle(a.c, a.r, (s0 + s1) / 2), end })
    }
    at = to
    i++
  }
}

/** Where a shape's stroke is, cut into the pieces a dashed line draws. Lines, arcs and the sides of a rectangle start their pattern anew; a polygon, curve and ellipse carry it along. */
export function dashShape(shape: BoardShape): DashPiece[] {
  if (!shape.dash) return []
  const pattern = dashPattern(shape.dash, shape.width)
  const out: DashPiece[] = []
  const restart = shape.type === "line" || shape.type === "arc" || shape.type === "rect" || shape.type === "circle"
  for (const path of shapePaths(shape)) {
    if (restart) {
      for (const s of path.segs) {
        if (s.kind === "arc") dashArc(s, pattern, out)
        else dashPolyline(flattenSeg(s), pattern, out)
      }
    } else {
      const pts = flattenPath(path)
      dashPolyline(path.closed && pts.length ? [...pts, pts[0]] : pts, pattern, out)
    }
  }
  return out
}

// ---------- drawing paths ----------

const f6 = (n: number) => String(Math.round(n * 1e6) / 1e6)

/**
 * SVG path data for a shape in the frame it is held in (y up, so a positive sweep is
 * counter-clockwise, which is what SVG's sweep flag 1 means in a y-up user space).
 */
export function shapeSvgPath(shape: ShapeGeometry): string {
  return pathsSvgPath(shapePaths(shape))
}

/** SVG path data for some paths (an outline's), in the frame they are held in. */
export function pathsSvgPath(paths: ShapePath[]): string {
  let d = ""
  for (const path of paths) {
    path.segs.forEach((s, i) => {
      const from = segStart(s)
      if (i === 0) d += `M${f6(from.x)} ${f6(from.y)}`
      switch (s.kind) {
        case "line":
          d += `L${f6(s.b.x)} ${f6(s.b.y)}`
          break
        case "arc": {
          const a = arcCircle(s.start, s.mid, s.end)
          if (!a) d += `L${f6(s.end.x)} ${f6(s.end.y)}`
          else d += `A${f6(a.r)} ${f6(a.r)} 0 ${Math.abs(a.sweep) > Math.PI ? 1 : 0} ${a.sweep > 0 ? 1 : 0} ${f6(s.end.x)} ${f6(s.end.y)}`
          break
        }
        case "bezier":
          d += `C${f6(s.c1.x)} ${f6(s.c1.y)} ${f6(s.c2.x)} ${f6(s.c2.y)} ${f6(s.p1.x)} ${f6(s.p1.y)}`
          break
        case "ellipse": {
          const sweep = s.t1 - s.t0
          const end = segEnd(s)
          const rot = f6((s.rot * 180) / Math.PI)
          if (sweep >= TAU - 1e-9) {
            const mid = ellipsePoint(s.c, s.rx, s.ry, s.rot, s.t0 + Math.PI)
            d += `A${f6(s.rx)} ${f6(s.ry)} ${rot} 0 1 ${f6(mid.x)} ${f6(mid.y)}A${f6(s.rx)} ${f6(s.ry)} ${rot} 0 1 ${f6(end.x)} ${f6(end.y)}`
          } else d += `A${f6(s.rx)} ${f6(s.ry)} ${rot} ${sweep > Math.PI ? 1 : 0} 1 ${f6(end.x)} ${f6(end.y)}`
          break
        }
      }
    })
    if (path.closed) d += "Z"
  }
  return d
}

/** Draw a shape's outline into a 2D canvas context whose user space is the board's (y up). Strokes and fills are the caller's. */
export function shapeCanvasPath(ctx: CanvasPathLike, shape: ShapeGeometry) {
  pathsCanvasPath(ctx, shapePaths(shape))
}

type CanvasPathLike = { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; arc(x: number, y: number, r: number, a0: number, a1: number, anticlockwise?: boolean): void; ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, anticlockwise?: boolean): void; bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void; closePath(): void }

/** Draw some paths into a 2D canvas context whose user space is the board's (y up). */
export function pathsCanvasPath(ctx: CanvasPathLike, paths: ShapePath[]) {
  for (const path of paths) {
    path.segs.forEach((s, i) => {
      const from = segStart(s)
      if (i === 0) ctx.moveTo(from.x, from.y)
      switch (s.kind) {
        case "line":
          ctx.lineTo(s.b.x, s.b.y)
          break
        case "arc": {
          const a = arcCircle(s.start, s.mid, s.end)
          if (!a) ctx.lineTo(s.end.x, s.end.y)
          else ctx.arc(a.c.x, a.c.y, a.r, a.a0, a.a0 + a.sweep, a.sweep < 0)
          break
        }
        case "bezier":
          ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y)
          break
        case "ellipse":
          ctx.ellipse(s.c.x, s.c.y, s.rx, s.ry, s.rot, s.t0, s.t1, false)
          break
      }
    })
    if (path.closed) ctx.closePath()
  }
}

// ---------- shape facts ----------

/** Whether a shape can be filled: a closed one. */
export const isClosedShape = (shape: ShapeGeometry) => shape.type === "circle" || shape.type === "rect" || shape.type === "polygon" || (shape.type === "ellipse" && shape.from === undefined)

/** How a shape reads in words, for the Inspector and the report. */
export const SHAPE_NAMES: Record<ShapeGeometry["type"], string> = { line: "Line", arc: "Arc", circle: "Circle", rect: "Rectangle", polygon: "Polygon", curve: "Curve", ellipse: "Ellipse" }

// ---------- reading a stored shape ----------

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const pt = (v: unknown): v is Vec2 => !!v && typeof v === "object" && num((v as Vec2).x) && num((v as Vec2).y)
const cleanPt = (p: Vec2): Vec2 => ({ x: p.x, y: p.y })
const DASHES = new Set(["dash", "dot", "dash_dot", "dash_dot_dot"])

function ringOf(raw: unknown): ShapePoint[] | null {
  if (!Array.isArray(raw) || !raw.every((p) => pt(p) && ((p as ShapePoint).mid === undefined || pt((p as ShapePoint).mid)))) return null
  return (raw as ShapePoint[]).map((p) => (p.mid ? { ...cleanPt(p), mid: cleanPt(p.mid) } : cleanPt(p)))
}

/** A shape as a stored project holds it, or null when it is not one: what is damaged is dropped rather than drawn wrong. The layer is checked by the caller's `valid` (a KiCad drawing layer). */
export function normalizeShape(raw: unknown, validLayer: (name: string) => boolean): BoardShape | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.layer !== "string" || !validLayer(r.layer) || !num(r.width) || r.width < 0) return null
  let geom: ShapeGeometry | null = null
  switch (r.type) {
    case "line":
      if (pt(r.a) && pt(r.b)) geom = { type: "line", a: cleanPt(r.a), b: cleanPt(r.b) }
      break
    case "arc":
      if (pt(r.start) && pt(r.mid) && pt(r.end)) geom = { type: "arc", start: cleanPt(r.start), mid: cleanPt(r.mid), end: cleanPt(r.end) }
      break
    case "circle":
      if (pt(r.c) && num(r.r) && r.r >= 0) geom = { type: "circle", c: cleanPt(r.c), r: r.r }
      break
    case "rect":
      if (pt(r.a) && pt(r.b) && (r.radius === undefined || (num(r.radius) && r.radius >= 0))) geom = { type: "rect", a: cleanPt(r.a), b: cleanPt(r.b), ...(num(r.radius) && r.radius > 0 ? { radius: r.radius } : {}) }
      break
    case "polygon": {
      const pts = ringOf(r.pts)
      const holes = Array.isArray(r.holes) ? r.holes.map(ringOf) : []
      if (pts && pts.length >= 3 && holes.every((h) => h && h.length >= 3)) geom = { type: "polygon", pts, ...(holes.length ? { holes: holes as ShapePoint[][] } : {}) }
      break
    }
    case "curve":
      if (pt(r.p0) && pt(r.c1) && pt(r.c2) && pt(r.p1)) geom = { type: "curve", p0: cleanPt(r.p0), c1: cleanPt(r.c1), c2: cleanPt(r.c2), p1: cleanPt(r.p1) }
      break
    case "ellipse":
      if (pt(r.c) && num(r.rx) && r.rx > 0 && num(r.ry) && r.ry > 0 && num(r.rot) && (r.from === undefined) === (r.to === undefined) && (r.from === undefined || (num(r.from) && num(r.to)))) {
        geom = { type: "ellipse", c: cleanPt(r.c), rx: r.rx, ry: r.ry, rot: r.rot, ...(num(r.from) && num(r.to) ? { from: r.from, to: r.to } : {}) }
      }
      break
  }
  if (!geom) return null
  return {
    ...geom,
    layer: r.layer,
    width: r.width,
    ...(typeof r.dash === "string" && DASHES.has(r.dash) ? { dash: r.dash as ShapeDash } : {}),
    ...(r.fill === true && isClosedShape(geom) ? { fill: true as const } : {}),
    ...(typeof r.net === "string" && r.net.trim() ? { net: r.net } : {}),
    ...(r.locked === true ? { locked: true as const } : {}),
  }
}
