import { Clipper, EndType, FillRule, JoinType, type Path64, type Paths64 } from "@countertype/clipper2-ts"
import { slotEnds, type WorldPad } from "./instances"
import { outlineGeometry } from "./outline"
import { flattenPath, shapePolylines, shapeRings } from "./shapes"
import type { CopperItem } from "./pcb"
import type { Project, Vec2 } from "./types"

// The geometry the zone fill (`zoneFill.ts`) works in: clipper paths in tenths of a micron, so the 0.001 mm KiCad subtracts from
// a minimum width is ten units and the rounding of a coordinate is a tenth of what any rule distinguishes. The editor's own
// whole-board pour (`pour.ts`) keeps its own micron grid: nothing here is used by it.

/** Clipper units per millimetre. */
export const U = 10_000
/** How far a round join or a circle may be from the true curve (mm): half of KiCad's default maximum error of 0.005 mm. */
export const ARC_MM = 0.0025
const ARC_TOL = ARC_MM * U

export const pt = (x: number, y: number) => ({ x: Math.round(x * U), y: Math.round(y * U) })
export const toVec = (path: Path64): Vec2[] => path.map((p) => ({ x: p.x / U, y: p.y / U }))
export const ring = (points: Vec2[]): Path64 => points.map((p) => pt(p.x, p.y))

/** A path wound the way a filled outline is (positive area). */
export const upright = (path: Path64): Path64 => (Clipper.isPositive(path) ? path : [...path].reverse())

/** The corners of a circle's polygon so that it holds the true circle: a vertex is `r / cos(pi / n)` out, and the chord is within `ARC_MM`. */
export function circlePath(x: number, y: number, r: number): Path64 {
  const rr = Math.max(r, 1e-6)
  const n = Math.max(12, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - ARC_MM / rr))))
  const out = r / Math.cos(Math.PI / n)
  const path: Path64 = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    path.push(pt(x + Math.cos(a) * out, y + Math.sin(a) * out))
  }
  return path
}

export const rectPath = (cx: number, cy: number, w: number, h: number): Path64 => [pt(cx - w / 2, cy - h / 2), pt(cx + w / 2, cy - h / 2), pt(cx + w / 2, cy + h / 2), pt(cx - w / 2, cy + h / 2)]

export const inflate = (paths: Paths64, d: number, join: JoinType = JoinType.Round): Paths64 =>
  paths.length && d !== 0 ? Clipper.inflatePaths(paths, d * U, join, EndType.Polygon, 2, ARC_TOL) : paths

/** An open polyline grown to a stroke of the given half width, with round ends. */
export const stroke = (points: Vec2[], halfWidth: number): Paths64 => Clipper.inflatePaths([points.map((p) => pt(p.x, p.y))], Math.max(halfWidth, 1e-5) * U, JoinType.Round, EndType.Round, 2, ARC_TOL)

export const union = (a: Paths64, b: Paths64 = [], rule: FillRule = FillRule.NonZero): Paths64 => (a.length || b.length ? Clipper.union(a, b, rule) : [])
export const difference = (a: Paths64, b: Paths64, rule: FillRule = FillRule.NonZero): Paths64 => (a.length ? (b.length ? Clipper.difference(a, b, rule) : a) : [])
export const intersect = (a: Paths64, b: Paths64, rule: FillRule = FillRule.NonZero): Paths64 => (a.length && b.length ? Clipper.intersect(a, b, rule) : [])

/** The area of some paths (the holes wound the other way count against it), in square millimetres. */
export const areaMm2 = (paths: Paths64): number => Math.abs(Clipper.areaPaths(paths)) / (U * U)

/** Where a pad's copper is: the hole is not taken out of it. */
export function padShape(pad: WorldPad): Paths64 {
  if (pad.shape === "circle") return [circlePath(pad.x, pad.y, pad.width / 2)]
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    if (half < 1e-6) return [circlePath(pad.x, pad.y, r)]
    const horizontal = pad.width >= pad.height
    const a = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
    const b = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
    return stroke([a, b], r)
  }
  if (pad.shape === "polygon" && pad.points && pad.points.length >= 3) return [upright(ring(pad.points))]
  return [rectPath(pad.x, pad.y, pad.width, pad.height)]
}

/** The drilled hole of a pad as a shape, or null for a pad with none: a circle, or a slot as a stroke between its two ends. */
export function holeShape(pad: WorldPad): Paths64 | null {
  if (!pad.holeDiameter) return null
  const ends = slotEnds(pad)
  if (ends) return stroke([ends[0], ends[1]], pad.holeDiameter / 2)
  return [circlePath(pad.x, pad.y, pad.holeDiameter / 2)]
}

/** A copper drawing or a copper text, grown by `d`: its outline stroked with half its width plus `d`, and what a filled one covers. */
export function shapeObstacle(it: Extract<CopperItem, { kind: "shape" }>, d: number): Paths64 {
  const half = it.copper.half + d
  const out: Paths64 = []
  if (it.what === "text") {
    for (const [a, b] of it.copper.edges) out.push(...stroke(a === b || (a.x === b.x && a.y === b.y) ? [a, { x: a.x + 1e-6, y: a.y }] : [a, b], half))
    if (it.copper.fill.length) out.push(...inflate(union(it.copper.fill.map(ring), [], FillRule.EvenOdd), half))
    return out
  }
  for (const line of shapePolylines(it.shape)) if (line.length >= 2) out.push(...stroke(line, half))
  if (it.shape.fill) {
    const rings = shapeRings(it.shape).map(ring)
    if (rings.length) out.push(...inflate(union(rings, [], FillRule.EvenOdd), half))
  }
  return out
}

/** What a board's outline leaves of the board as clipper paths: its loops with the cutouts taken out, before any inset. Null when the board has no loop (it is its rectangle). */
export function boardLoops(b: Project["board"]): Paths64 {
  const g = outlineGeometry(b)
  if (!g) return [rectPath(b.x, b.y, b.width, b.height)]
  if (!g.rings.length) return [rectPath((g.box.minX + g.box.maxX) / 2, (g.box.minY + g.box.maxY) / 2, g.box.maxX - g.box.minX, g.box.maxY - g.box.minY)]
  // Each piece of board with its cutouts: one even-odd union so a hole stays a hole.
  return union(
    g.regions.flatMap((r) => [r.outer, ...r.holes]).map(ring),
    [],
    FillRule.NonZero,
  )
}

/**
 * The part of the board a pour may reach: the board kept `edge` away from its edge (the rounded rectangle, or the outline's loops with
 * their cutouts), and `edge` away from any piece of outline left open. A rounded corner of the rectangle follows `cornerRadius`.
 */
export function boardArea(b: Project["board"], edge: number): Paths64 {
  const g = outlineGeometry(b)
  if (!g) {
    const w = b.width - edge * 2
    const h = b.height - edge * 2
    if (w <= 0 || h <= 0) return []
    const rr = Math.max(0, Math.min(b.cornerRadius - edge, w / 2, h / 2))
    if (rr < 1e-6) return [rectPath(b.x, b.y, w, h)]
    return inflate([rectPath(b.x, b.y, w - rr * 2, h - rr * 2)], rr)
  }
  const loops = g.rings.length ? inflate(boardLoops(b), -edge) : boardLoops(b)
  const open = (b.outline?.paths ?? []).filter((p) => !p.closed)
  if (!open.length) return loops
  const strokes: Paths64 = open.flatMap((p) => {
    const pts = flattenPath(p)
    return pts.length >= 2 ? stroke(pts, edge) : []
  })
  return difference(loops, strokes)
}
