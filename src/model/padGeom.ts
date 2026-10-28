import { Clipper, EndType, FillRule, JoinType, type Path64, type Paths64 } from "@countertype/clipper2-ts"
import { rotate90 } from "../lib/geometry"
import { FLATTEN_TOLERANCE, shapePolylines, shapeRings } from "./shapes"
import type { PadDef, Vec2 } from "./types"

// X7: what a pad's copper is, as exact rings, in the land's own frame (before the part is placed).
//
// A pad is a rectangle, a circle or a pill (`shape`), which may be turned (`rot`), rounded (`round`) or chamfered (`chamfer`);
// a polygon (`points`); or a custom pad, the union of its anchor and its drawings with their line widths (`custom`). The
// outlines follow KiCad's own: `TransformRoundChamferedRectToPolygon` (convert_basic_shapes_to_polygon.cpp, 10.0.0 `:459`) for
// the rectangle and `PAD::MergePrimitivesAsPolygon` (pad.cpp, 10.0.0 `:3216`) for the custom pad. Arcs are flattened to
// 0.0002 mm (`FLATTEN_TOLERANCE`), 25 times finer than KiCad's own 5 micron default, and a custom pad's union is made in whole nanometres.

/** The corners a chamfer can cut, as the pad is seen. */
export const CHAMFER_TOP_LEFT = 1
export const CHAMFER_TOP_RIGHT = 2
export const CHAMFER_BOTTOM_RIGHT = 4
export const CHAMFER_BOTTOM_LEFT = 8

/** A pad with something in it that a plain pad (a rectangle, circle or pill with a hole in the middle) does not have. */
export function hasPadFeatures(pad: PadDef): boolean {
  return (
    pad.number !== undefined ||
    pad.rot !== undefined ||
    pad.round !== undefined ||
    pad.chamfer !== undefined ||
    pad.custom !== undefined ||
    pad.holeOffset !== undefined ||
    pad.holeAxis !== undefined ||
    pad.layers !== undefined ||
    pad.maskMargin !== undefined ||
    pad.pasteMargin !== undefined ||
    pad.pasteRatio !== undefined ||
    pad.clearance !== undefined ||
    pad.zoneConnect !== undefined ||
    pad.thermalGap !== undefined ||
    pad.thermalWidth !== undefined ||
    pad.thermalAngle !== undefined ||
    pad.property !== undefined ||
    pad.stack !== undefined ||
    pad.unused !== undefined ||
    pad.tent !== undefined
  )
}

const TAU = Math.PI * 2

/** Corners (as an angle step) of an arc of radius `r` and sweep `sweep` within `tol` of the circle. */
function arcCount(r: number, sweep: number, tol: number): number {
  if (r <= tol) return 1
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)))
  return Math.max(1, Math.min(2048, Math.ceil(Math.abs(sweep) / step)))
}

/** A circle as a ring of corners on it, counter-clockwise, within `tol`. */
export function circleRing(cx: number, cy: number, r: number, tol = FLATTEN_TOLERANCE): Vec2[] {
  const n = Math.max(8, arcCount(r, TAU, tol))
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return out
}

/** A stadium of width `w` and height `h` about the origin: the rectangle with its shorter ends half circles. */
export function pillRing(w: number, h: number, tol = FLATTEN_TOLERANCE): Vec2[] {
  const r = Math.min(w, h) / 2
  const half = (Math.max(w, h) - 2 * r) / 2
  if (half < 1e-9) return circleRing(0, 0, r, tol)
  const horizontal = w >= h
  const n = Math.max(2, arcCount(r, Math.PI, tol))
  const out: Vec2[] = []
  for (const end of [1, -1]) {
    for (let i = 0; i <= n; i++) {
      const a = (horizontal ? -Math.PI / 2 : 0) + (end === 1 ? 0 : Math.PI) + (i / n) * Math.PI
      out.push(horizontal ? { x: end * half + r * Math.cos(a), y: r * Math.sin(a) } : { x: r * Math.cos(a), y: end * half + r * Math.sin(a) })
    }
  }
  return out
}

/**
 * A rectangle `w` by `h` about the origin with rounded corners of radius `radius` and chamfered ones (a chamfer of `cut` on the
 * corners of the mask `corners`), as KiCad cuts them: a chamfered corner is not rounded too, a cut of nothing leaves a sharp
 * corner, and two cuts that meet at the middle of a side join. Counter-clockwise from the bottom left, y up.
 */
export function roundChamferRing(w: number, h: number, radius: number, cut: number, corners: number, tol = FLATTEN_TOLERANCE): Vec2[] {
  const hx = w / 2
  const hy = h / 2
  const r = Math.max(0, Math.min(radius, hx, hy))
  // Corners counter-clockwise from the bottom left, each with the way it is arrived at and left (y up).
  const defs = [
    { x: -hx, y: -hy, bit: CHAMFER_BOTTOM_LEFT, arrive: { x: 0, y: -1 }, leave: { x: 1, y: 0 } },
    { x: hx, y: -hy, bit: CHAMFER_BOTTOM_RIGHT, arrive: { x: 1, y: 0 }, leave: { x: 0, y: 1 } },
    { x: hx, y: hy, bit: CHAMFER_TOP_RIGHT, arrive: { x: 0, y: 1 }, leave: { x: -1, y: 0 } },
    { x: -hx, y: hy, bit: CHAMFER_TOP_LEFT, arrive: { x: -1, y: 0 }, leave: { x: 0, y: -1 } },
  ]
  const out: Vec2[] = []
  for (const d of defs) {
    if (corners & d.bit) {
      if (cut > 0) {
        out.push({ x: d.x - d.arrive.x * cut, y: d.y - d.arrive.y * cut }, { x: d.x + d.leave.x * cut, y: d.y + d.leave.y * cut })
      } else out.push({ x: d.x, y: d.y })
    } else if (r > 0) {
      const cx = d.x - d.arrive.x * r + d.leave.x * r
      const cy = d.y - d.arrive.y * r + d.leave.y * r
      const a0 = Math.atan2(-d.leave.y, -d.leave.x)
      const n = arcCount(r, Math.PI / 2, tol)
      for (let i = 0; i <= n; i++) {
        const a = a0 + (i / n) * (Math.PI / 2)
        out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
      }
    } else out.push({ x: d.x, y: d.y })
  }
  return dedupe(out)
}

/** A ring with the corners that repeat the one before (or the first) taken out. */
function dedupe(ring: Vec2[]): Vec2[] {
  const out: Vec2[] = []
  for (const p of ring) {
    const last = out[out.length - 1]
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) out.push(p)
  }
  while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) <= 1e-9 && Math.abs(out[0].y - out[out.length - 1].y) <= 1e-9) out.pop()
  return out
}

// ---------- a custom pad's copper ----------

const NM = 1e6
const nm = (p: Vec2) => ({ x: Math.round(p.x * NM), y: Math.round(p.y * NM) })
const mm = (path: Path64): Vec2[] => path.map((p) => ({ x: p.x / NM, y: p.y / NM }))
const positive = (path: Path64): Path64 => (Clipper.isPositive(path) ? path : [...path].reverse())

/** One of a custom pad's drawings as paths: its fill grown by half its line width, or its line stroked with a round pen (`EDA_SHAPE::TransformShapeToPolygon`, eda_shape.cpp 10.0.0 `:2363`). */
function primitivePaths(shape: NonNullable<PadDef["custom"]>["shapes"][number]): Paths64 {
  const half = Math.max(0, shape.width) / 2
  const arcTol = Math.max(1, FLATTEN_TOLERANCE * NM)
  const filled = shape.fill === true && shape.type !== "line" && shape.type !== "arc" && shape.type !== "curve"
  const out: Paths64 = []
  if (filled) {
    const rings = shapeRings(shape).map((r) => r.map(nm))
    if (rings.length) {
      const fill = Clipper.union(rings, [], FillRule.EvenOdd)
      out.push(...(half > 0 ? Clipper.inflatePaths(fill, half * NM, JoinType.Round, EndType.Polygon, 2, arcTol) : fill))
    }
    return out
  }
  if (half <= 0) return out
  for (const line of shapePolylines(shape)) {
    if (line.length === 0) continue
    // A line of one point (a circle of no radius) is a dot.
    const pts = line.length === 1 ? [line[0], { x: line[0].x + 1e-6, y: line[0].y }] : line
    out.push(...Clipper.inflatePaths([pts.map(nm)], half * NM, JoinType.Round, EndType.Round, 2, arcTol))
  }
  return out
}

const customCache = new WeakMap<object, Vec2[][]>()

/**
 * The rings of a custom pad's copper, about the pad's centre before its turn: the anchor (a circle of diameter `width`, or the rectangle
 * `width` by `height`) merged with every drawing, whole nanometres, outer rings counter-clockwise and the holes inside them clockwise.
 */
export function customRings(pad: PadDef): Vec2[][] {
  const custom = pad.custom
  if (!custom) return []
  const hit = customCache.get(custom)
  if (hit) return hit
  const anchor: Path64 = custom.anchor === "rect" ? [nm({ x: -pad.width / 2, y: -pad.height / 2 }), nm({ x: pad.width / 2, y: -pad.height / 2 }), nm({ x: pad.width / 2, y: pad.height / 2 }), nm({ x: -pad.width / 2, y: pad.height / 2 })] : circleRing(0, 0, pad.width / 2).map(nm)
  const parts: Paths64 = [positive(anchor)]
  // A drawing's own paths are already outer rings counter-clockwise and holes clockwise (a ring drawn round the anchor has a hole): they are not turned.
  for (const s of custom.shapes) for (const path of primitivePaths(s)) parts.push(path)
  const merged = Clipper.union(parts, [], FillRule.NonZero)
  const rings = merged.map(mm).filter((r) => r.length >= 3)
  customCache.set(custom, rings)
  return rings
}

// ---------- every pad as rings ----------

/** The rings of a pad about its centre, before its turn (a polygon pad's are in the land's frame already: its `points`). */
export function padLocalRings(pad: PadDef): Vec2[][] {
  if (pad.custom) return customRings(pad)
  if (pad.shape === "polygon") return pad.points && pad.points.length >= 3 ? [pad.points] : []
  if (pad.shape === "circle") return [circleRing(0, 0, pad.width / 2)]
  if (pad.shape === "pill") return [pillRing(pad.width, pad.height)]
  const radius = (pad.round ?? 0) * Math.min(pad.width, pad.height)
  const c = pad.chamfer
  return [roundChamferRing(pad.width, pad.height, radius, c ? c.ratio * Math.min(pad.width, pad.height) : 0, c?.corners ?? 0)]
}

/** The rings of a pad in the land's frame: turned by its own turn, then moved to its place. */
export function padRings(pad: PadDef): Vec2[][] {
  const rings = padLocalRings(pad)
  if (pad.shape === "polygon" && !pad.custom) return rings
  const turn = pad.rot ?? 0
  return rings.map((ring) =>
    ring.map((p) => {
      const q = turn ? rotate90(p, turn) : p
      return { x: pad.x + q.x, y: pad.y + q.y }
    }),
  )
}
