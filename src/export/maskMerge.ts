import type { WorldPad } from "../model/instances"
import { maskMargin, padOpeningRings } from "../model/padOpening"
import { padPaths, polygonKit, withMaxError, type FillPolygon } from "../model/pour"
import { dashShape, flattenSeg, isClosedShape, shapeRings, shapePolylines, type DashPiece } from "../model/shapes"
import { smoothedOtherRings } from "../model/nonCopperFill"
import { withPartZones } from "../model/partZones"
import { textsOnLayer } from "../model/texts"
import { isOtherZone, isRuleArea } from "../model/zones"
import type { BoardShape, PcbSide, Project, Vec2 } from "../model/types"

// The solder mask when the board has a minimum mask web (`DesignRules.maskMinWidth`, KiCad's `solder_mask_min_width`).
//
// KiCad does not plot such a mask opening by opening. `PlotSolderMaskLayer` (plot_board_layers.cpp:90 of 10.0, from stamp 5.1
// on: the setting has been a plot rule since then) builds every opening as a polygon grown by half the minimum width less 1 nm
// (`GenerateLayerPoly`: `inflate = m_SolderMaskMinWidth / 2 - 1`), merges them, shrinks the result by the same amount with
// bevelled corners, and adds the exact openings back so the round trip loses none of them. Openings closer than the
// minimum width end up as one, and a notch in an opening narrower than it is filled: the closing of the shapes by that
// width. A rectangular pad's opening is its pad grown by the mask expansion with round corners there (a polygon grown
// by `TransformShapeToPolygon`), where the plain plot flashes a rectangle with square ones.
//
// The openings are the pads (with the expansion), the vias that are not tented, and the drawings and texts on the mask layer.

const NM = 1e-6

/** A pad's opening as polygons: its copper shape grown by the mask expansion, round at the corners when it grows. */
function padOpening(pad: WorldPad, grow: number, rules: Project["rules"]) {
  // A pad with X7 features has the opening KiCad plots for it, with its own margin (`padOpening.ts`).
  if (pad.x7) {
    const rings = padOpeningRings(pad, maskMargin(pad, rules))
    return rings?.length ? polygonKit.unionEvenOdd(rings.map((r) => polygonKit.path(r))) : []
  }
  const copper = padPaths(pad)
  return grow === 0 ? copper : polygonKit.inflate(copper, grow)
}

/** A drawing on the mask layer as the plot draws it (`plotShape`): a stroke of its width, the fill of a closed one (a filled circle grown by half the width). */
function shapePolygons(shape: BoardShape) {
  const out = []
  const filled = shape.fill === true && isClosedShape(shape)
  if (filled) {
    if (shape.type === "circle") out.push(...polygonKit.circle(shape.c.x, shape.c.y, shape.r + (shape.dash ? 0 : shape.width) / 2))
    else {
      const rings = shapeRings(shape)
      if (rings.length) out.push(...polygonKit.unionEvenOdd(rings.map((r) => polygonKit.path(r))))
    }
    if (shape.type === "circle" && !shape.dash) return out
  }
  if (shape.width <= 0) return out
  const half = shape.width / 2
  if (shape.dash) {
    for (const piece of dashShape(shape)) {
      const pts = pieceOutline(piece)
      if (pts.length >= 2) out.push(...polygonKit.stroke(pts, half))
    }
  } else {
    for (const line of shapePolylines(shape)) if (line.length >= 2) out.push(...polygonKit.stroke(line, half))
  }
  return out
}

function pieceOutline(piece: DashPiece): Vec2[] {
  if (piece.kind === "line") return [piece.a, piece.b]
  if (piece.kind === "poly") return piece.pts
  return flattenSeg(piece)
}

/**
 * The mask openings of one side as regions (an outer ring and its holes each), merged as KiCad merges them. `drawings` are the board's and
 * its parts' drawings on that side's mask layer, `pads` its pads on that side, `vias` the untented vias.
 */
export function maskRegions(project: Project, side: PcbSide, pads: WorldPad[], drawings: BoardShape[]): FillPolygon[] {
  const { maskExpansion: grow, maskMinWidth: minWidth = 0, tentVias } = project.rules
  return withMaxError(project.rules.maxError, () => {
    const parts = []
    for (const pad of pads) parts.push(...padOpening(pad, grow, project.rules))
    if (!tentVias) for (const v of project.vias) parts.push(...polygonKit.circle(v.x, v.y, v.diameter / 2 + grow))
    for (const shape of drawings) parts.push(...shapePolygons(shape))
    const layer = side === "top" ? "F.Mask" : "B.Mask"
    // X29: a zone on the mask layer opens it by its smoothed outline (`TransformSmoothedOutlineToPolygon`), not by its fill.
    const withParts = withPartZones(project)
    for (const z of withParts.zones) {
      if (!isOtherZone(z) || isRuleArea(z) || !z.other!.includes(layer)) continue
      const rings = smoothedOtherRings(withParts, z, layer)
      if (rings.length) parts.push(...polygonKit.unionEvenOdd(rings.map((r) => polygonKit.path(r))))
    }
    for (const t of textsOnLayer(project, layer)) {
      for (const polygon of t.fills) parts.push(...polygonKit.unionEvenOdd(polygon.map((r) => polygonKit.path(r))))
      for (const stroke of t.strokes) parts.push(...polygonKit.stroke(stroke.length === 1 ? [stroke[0], { x: stroke[0].x + 1e-6, y: stroke[0].y }] : stroke, t.pen / 2))
      if (t.border) parts.push(...polygonKit.stroke([...t.border.points, t.border.points[0]], t.border.width / 2))
    }
    const exact = polygonKit.union(parts)
    const inflate = minWidth / 2 - NM
    if (inflate <= 0 || !exact.length) return polygonKit.regions(exact)
    const grown = polygonKit.union(polygonKit.inflate(exact, inflate))
    const closed = polygonKit.inflateBevel(grown, -inflate)
    return polygonKit.regions(polygonKit.union([...closed, ...exact]))
  }, 1e6)
}
