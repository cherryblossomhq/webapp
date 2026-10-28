import { Clipper, EndType, FillRule, JoinType, type Paths64 } from "@countertype/clipper2-ts"
import { rotate90, transformPoint, round } from "../lib/geometry"
import type { WorldPad } from "./instances"
import { circleRing, mm, nm, NM, padLocalRings, pillRing, roundChamferRing } from "./padGeom"
import { FLATTEN_TOLERANCE } from "./shapes"
import type { DesignRules, PadDef, Vec2 } from "./types"

// The shape a pad has on a layer that is not its copper's size: the opening in the solder mask and the aperture in the paste stencil, each
// the pad grown by a margin, as KiCad plots them (`PlotStandardLayer`, plot_board_layers.cpp 10.0.0 `:327`, with `PlotPad`, plot_brditems_plotter.cpp
// `:151`; 9.0.0 does the same). In the pad's own frame, before its turn:
// - a circle and an oval grow to the size plus twice the margin along each axis;
// - a plain rectangle does too, and when the margin is above zero its corners are rounded by it (the rectangle is plotted as a rounded one of radius the margin);
// - a rounded rectangle grows the same way with its radius ratio kept, so the radius is the ratio of the new shorter side;
// - a chamfered rectangle shrinks the same way (ratios kept) and, when it grows, is its own outline offset by the margin with round corners;
// - a trapezoid and a custom pad are their outline offset by the margin with round corners (a custom pad's copper is the anchor and its drawings merged, `PAD::MergePrimitivesAsPolygon`);
// - a pad is not plotted where its size goes to nothing (a custom pad's anchor may).
// The margin is the pad's own, else the footprint's (copied onto the pad by the importer), else the board's; a mask margin is kept from taking more than
// half the pad's shorter side; a paste margin is the absolute one and the ratio of the pad's size on each axis, kept from taking more than half the size
// (`PAD::GetSolderMaskExpansion`, pad.cpp `:1639`; `GetSolderPasteMargin` `:1702`). Pads that have no copper layer in their set (a mask-only or paste-only
// pad) are plotted as they are.

/** Rings offset by `d` (outwards when positive) with round corners, in whole nanometres; the rings are counted even-odd, so holes shrink as the pad grows. */
export function offsetRings(rings: Vec2[][], d: number): Vec2[][] {
  if (d === 0 || !rings.length) return rings
  const union: Paths64 = Clipper.union(rings.map((r) => r.map(nm)), [], FillRule.EvenOdd)
  const out = Clipper.inflatePaths(union, d * NM, JoinType.Round, EndType.Polygon, 2, Math.max(1, FLATTEN_TOLERANCE * NM))
  return out.map(mm).filter((r) => r.length >= 3)
}

/** The rings of a pad's shape in the pad's own frame (before its turn, about its centre; a polygon pad's are the land's own), grown by `mx` along x and `my` along y; null for nothing. */
export function openingLocal(def: PadDef, mx: number, my: number): Vec2[][] | null {
  const w = def.width
  const h = def.height
  if (def.custom) return offsetRings(padLocalRings(def), mx)
  if (def.shape === "polygon") return offsetRings(padLocalRings(def), mx)
  const sx = w + 2 * mx
  const sy = h + 2 * my
  if (sx <= 0 || sy <= 0) return null
  if (def.shape === "circle") return [circleRing(0, 0, sx / 2)]
  if (def.shape === "pill") return [pillRing(sx, sy)]
  const min = Math.min(sx, sy)
  const chamfered = def.chamfer && def.chamfer.corners !== 0
  if (!chamfered) {
    if (!def.round) return [roundChamferRing(sx, sy, mx > 0 ? mx : 0, 0, 0)]
    return [roundChamferRing(sx, sy, def.round * min, 0, 0)]
  }
  const c = def.chamfer!
  if (mx <= 0) return [roundChamferRing(sx, sy, (def.round ?? 0) * min, c.ratio * min, c.corners)]
  // Grown: the pad's own outline (the grown size where the margins differ along the two axes) offset by the margin.
  if (mx === my) {
    const own = Math.min(w, h)
    return offsetRings([roundChamferRing(w, h, (def.round ?? 0) * own, c.ratio * own, c.corners)], mx)
  }
  return [roundChamferRing(sx, sy, (def.round ?? 0) * min, c.ratio * min, c.corners)]
}

/** A ring of the pad's own frame on the board. */
function place(pad: WorldPad, ring: Vec2[]): Vec2[] {
  const x = pad.x7!
  const def = x.def
  const fixed = def.shape === "polygon" && !def.custom
  const own = def.rot ?? 0
  return ring.map((p) => {
    const q = fixed ? p : rotate90(p, own)
    const w = transformPoint(fixed ? q : { x: def.x + q.x, y: def.y + q.y }, x.origin, x.rot, x.mirror)
    return { x: round(w.x, 6), y: round(w.y, 6) }
  })
}

/**
 * The rings of a pad that has X7 features as it is plotted when grown by the margins `mx` and `my` (zero for its copper), on the board;
 * null for a pad that has none (the plot draws those as it always has), and `[]` for a pad that is not plotted.
 */
export function padOpeningRings(pad: WorldPad, mx: number, my: number = mx): Vec2[][] | null {
  if (!pad.x7) return null
  const rings = openingLocal(pad.x7.def, mx, my)
  return rings ? rings.map((r) => place(pad, r)) : []
}

/** The pad's solder mask margin: its own, else the board's, held to half the pad's shorter side when it is negative; 0 for a pad with no copper layer in its set. */
export function maskMargin(pad: WorldPad, rules: Pick<DesignRules, "maskExpansion">): number {
  const def = pad.x7?.def
  if (def?.layers?.copper === "none") return 0
  const m = pad.maskMargin ?? rules.maskExpansion
  const half = Math.min(def?.width ?? pad.width, def?.height ?? pad.height) / 2
  return m < 0 && m < -half ? -half : m
}

/** The pad's paste margin along x and y: the absolute margin (its own, else the board's) plus the ratio (its own, else the board's) of its size, held to half the size (not for a custom pad). */
export function pasteMargins(pad: WorldPad, rules: Pick<DesignRules, "pasteExpansion" | "pasteRatio">): { x: number; y: number } {
  const def = pad.x7?.def
  if (def?.layers?.copper === "none") return { x: 0, y: 0 }
  const abs = pad.pasteMargin ?? rules.pasteExpansion
  const ratio = pad.pasteRatio ?? rules.pasteRatio ?? 0
  const w = def?.width ?? pad.width
  const h = def?.height ?? pad.height
  let x = abs + round(w * ratio, 6)
  let y = abs + round(h * ratio, 6)
  if (!def?.custom) {
    x = Math.max(x, -w / 2)
    y = Math.max(y, -h / 2)
  }
  return { x, y }
}
