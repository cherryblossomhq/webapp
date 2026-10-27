import { Clipper, Clipper64, ClipType, FillRule, JoinType, PolyTree64, type Paths64 } from "@countertype/clipper2-ts"
import { ARC_MM, difference, inflate, intersect, pt, U, union, upright } from "./zoneGeom"
import type { Vec2, ZoneHatch } from "./types"

// The hatched fill of a pour (X24), as KiCad's `ZONE_FILLER::addHatchFillTypeOnZone` makes it (pcbnew/zone_filler.cpp, KiCad 9 and 10). KiCad builds it on the copper
// as it is before the copper grows back by half the minimum width: a lattice of square holes, `gap` plus the minimum width on a side, a `thickness` plus `gap` apart, turned
// by the hatch angle and anchored at the board's origin (or at the zone's `hatch_position`); holes are cut off at a margin inside the copper's edge, so a band along it stays
// whole, and a hole that margin cut to less than `minHole` of a whole one is dropped. The copper then grows by half the minimum width again, which shrinks each hole to `gap`.
// The fill here is already grown, so the holes are shrunk by what the growing would take (the minimum width's half less a thousandth of a millimetre, as everywhere in the fill)
// and the margin is that and the band's own width. On a KiCad 10 board (`hatch_thermal_connectivity`) the lattice lands where the file's own filled polygons put it, to the micrometre.

/** KiCad's default for the smallest part of a hole that is kept. */
export const DEFAULT_MIN_HOLE = 0.3
/** KiCad's default for how much of a hole's half width its smoothing takes. */
export const DEFAULT_SMOOTH_VALUE = 0.1
/** Past this many holes the grid is not worth cutting: a hatch this fine over this much copper is solid to the eye, and the cut would take minutes. */
const MAX_HOLES = 300_000
/** The thousandth of a millimetre a minimum width is eased by when copper shrinks and grows back (`zoneFill.ts`). */
const EPSILON_MM = 0.001
/** KiCad rounds a smoothing no larger than this (mm) away, and uses a chamfer for a rounding no larger than the second. */
const SMOOTH_MIN_MM = 0.02
const SMOOTH_SMALL_MM = 0.04

/** The corners of one hole in the lattice's own frame, `size` on a side from the origin, cut off or rounded as the hatch says. */
function holeCorners(size: number, gap: number, minWidth: number, smooth: ZoneHatch["smooth"]): Vec2[] {
  const square = [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }]
  if (!smooth) return square
  let value = (gap * smooth.value) / 2
  if (value <= SMOOTH_MIN_MM) return square
  let level = smooth.level
  if (value < SMOOTH_SMALL_MM && level > 1) level = 1
  // KiCad makes the cut larger by half the minimum width to make up for the copper that grows back into it.
  value = Math.min(value + minWidth / 2, size / 2)
  const out: Vec2[] = []
  const corners = [
    { c: { x: 0, y: 0 }, a: { x: 1, y: 0 }, b: { x: 0, y: 1 } },
    { c: { x: size, y: 0 }, a: { x: 0, y: 1 }, b: { x: -1, y: 0 } },
    { c: { x: size, y: size }, a: { x: -1, y: 0 }, b: { x: 0, y: -1 } },
    { c: { x: 0, y: size }, a: { x: 0, y: -1 }, b: { x: 1, y: 0 } },
  ]
  for (const { c, a, b } of corners) {
    const from = { x: c.x + a.x * value, y: c.y + a.y * value }
    const to = { x: c.x + b.x * value, y: c.y + b.y * value }
    if (level === 1) {
      out.push(from, to)
      continue
    }
    // A quarter circle of radius `value` tangent to both sides; its centre is `value` in from each.
    const centre = { x: c.x + (a.x + b.x) * value, y: c.y + (a.y + b.y) * value }
    const error = level > 2 ? ARC_MM / 2 : ARC_MM
    const steps = Math.max(2, Math.ceil(Math.PI / 4 / Math.acos(Math.max(0, 1 - error / value))))
    const start = Math.atan2(from.y - centre.y, from.x - centre.x)
    const end = Math.atan2(to.y - centre.y, to.x - centre.x)
    let sweep = end - start
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    for (let i = 0; i <= steps; i++) {
      const t = start + (sweep * i) / steps
      out.push({ x: centre.x + Math.cos(t) * value, y: centre.y + Math.sin(t) * value })
    }
  }
  return out
}

/**
 * The copper of a hatched pour: `fill` with the grid's holes cut out of it. `layerAt` is the zone's `hatch_position` on this layer (mm, y up). `minWidth` is the zone's minimum width, which
 * makes the holes larger by itself and keeps the grid's lines at least that wide.
 */
export function hatchPaths(fill: Paths64, hatch: ZoneHatch, minWidth: number, layerAt: Vec2 | undefined): Paths64 {
  if (!fill.length) return fill
  // KiCad makes sure the grid's lines are thicker than the minimum width, or the machine could not make them.
  const thickness = Math.max(hatch.thickness, minWidth + 0.001)
  const pitch = thickness + hatch.gap
  const size = hatch.gap + minWidth
  const shrink = Math.max(0, minWidth / 2 - EPSILON_MM)
  const angle = ((hatch.angle ?? 0) * Math.PI) / 180
  const ax = { x: Math.cos(angle), y: Math.sin(angle) }
  // The lattice's second axis points down the board (KiCad's y runs that way), so that a hole is a `size` square from its corner in KiCad's own frame.
  const ay = { x: Math.sin(angle), y: -Math.cos(angle) }
  const origin = layerAt && !hatch.fromFill ? layerAt : { x: 0, y: 0 }

  // The lattice's range: the fill's box in the lattice's frame.
  let minI = Infinity
  let maxI = -Infinity
  let minJ = Infinity
  let maxJ = -Infinity
  for (const path of fill) {
    for (const p of path) {
      const x = p.x / U - origin.x
      const y = p.y / U - origin.y
      const i = x * ax.x + y * ax.y
      const j = x * ay.x + y * ay.y
      if (i < minI) minI = i
      if (i > maxI) maxI = i
      if (j < minJ) minJ = j
      if (j > maxJ) maxJ = j
    }
  }
  // KiCad 9 and earlier start the lattice at the corner of the copper (its box in the lattice's frame, shrunk by the same amount the holes are): a hole there starts where the copper does.
  const startI = hatch.fromFill ? minI + shrink : 0
  const startJ = hatch.fromFill ? minJ + shrink : 0
  const i0 = Math.floor((minI - startI) / pitch) - 1
  const i1 = Math.ceil((maxI - startI) / pitch)
  const j0 = Math.floor((minJ - startJ) / pitch) - 1
  const j1 = Math.ceil((maxJ - startJ) / pitch)
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_HOLES) return fill

  const corners = holeCorners(size, hatch.gap, minWidth, hatch.smooth)
  const holes: Paths64 = []
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const u = startI + i * pitch
      const v = startJ + j * pitch
      holes.push(upright(corners.map((c) => pt(origin.x + (u + c.x) * ax.x + (v + c.y) * ay.x, origin.y + (u + c.x) * ax.y + (v + c.y) * ay.y))))
    }
  }

  // Holes stop short of the copper's edge, which keeps the band along it, and a hole that stop cut small is dropped.
  const margin = shrink + (hatch.thinBorder ? 0 : thickness - minWidth)
  const inside = margin > 0 ? inflate(fill, -margin, JoinType.Square) : fill
  const whole = size * size * (hatch.minHole ?? DEFAULT_MIN_HOLE)
  const kept: Paths64 = []
  const tree = new PolyTree64()
  const cut = new Clipper64()
  cut.addSubject(intersect(holes, inside))
  cut.execute(ClipType.Union, FillRule.NonZero, tree)
  for (let k = 0; k < tree.count; k++) {
    const piece = tree.child(k)
    if (!piece.poly || Math.abs(Clipper.area(piece.poly)) / (U * U) < whole) continue
    kept.push(piece.poly)
    for (let h = 0; h < piece.count; h++) kept.push(piece.child(h).poly!)
  }
  if (!kept.length) return fill
  // The copper grows back into the holes by what it was shrunk.
  const open = shrink > 0 ? inflate(union(kept), -shrink, JoinType.Square) : union(kept)
  return difference(fill, open)
}
