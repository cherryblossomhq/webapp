import { Clipper, Clipper64, ClipType, FillRule, JoinType, PointInPolygonResult, PolyTree64, type Path64, type Paths64, type PolyPath64 } from "@countertype/clipper2-ts"
import { circlePath, difference, inflate, intersect, U, union, upright } from "./zoneGeom"
import type { Vec2, ZoneHatch } from "./types"

// The hatched fill of a pour (X24), ported from KiCad's `ZONE_FILLER::addHatchFillTypeOnZone` (pcbnew/zone_filler.cpp: branch 9.0 for KiCad 6 to 9, which share one hatch code, and branch 10.0 for
// KiCad 10), in KiCad's order and with its integers. It runs on the copper while it is shrunk by half the minimum width (`zoneFill.ts` calls it between the shrinking and the growing back), as KiCad
// does: a lattice of square holes, `gap` plus the minimum width on a side, a `thickness` plus `gap` apart, turned by the hatch angle, is cut off at a margin inside the copper and the zone's outline,
// a hole that the cut left less than `minHole` of a whole one is dropped, and what is left is taken out of the copper. The copper then grows by half the minimum width again, which shrinks each hole to `gap`.
//
// KiCad 9 and earlier start the lattice at the corner of the copper's box (in the grid's frame), keep the vias and pads of the pour's net from being isolated in a hole by cutting an apron round
// each out of the holes, and leave a band of the hatch thickness along the edge unless the border algorithm says the minimum width. KiCad 10 anchors the lattice at the board's origin (moved by the
// zone's hatch position, which counts only modulo the pitch), always leaves the band, and keeps a thermal relief's ring, a solid via and a clearance hole from being isolated in a hole by dropping
// the hole that holds it whole.
//
// KiCad's frame has y down: the lattice is laid out there (a hole extends right and down from its corner) and turned into the editor's, y up.

/** KiCad's default for the smallest part of a hole that is kept. */
export const DEFAULT_MIN_HOLE = 0.3
/** KiCad's default for how much of a hole's half width its smoothing takes. */
export const DEFAULT_SMOOTH_VALUE = 0.1
/** Past this many holes the grid is not worth cutting (a hatch this fine over this much copper is solid to the eye, and the cut would take minutes), and the pour is filled solid. The importer refuses such a pour and the zone's panel says so. */
export const MAX_HOLES = 300_000
/** KiCad's default maximum error (`m_MaxError`), mm. */
const MAX_ERROR_MM = 0.005
/** The margin a hatch line is kept wider than the minimum width by, mm. */
const LINE_MARGIN_MM = 0.001
/** KiCad rounds a smoothing no larger than this (mm) away, and uses a chamfer for a rounding no larger than the second. */
const SMOOTH_MIN_MM = 0.02
const SMOOTH_SMALL_MM = 0.04
/** `MIN_SEGCOUNT_FOR_CIRCLE` of KiCad's `GetArcToSegmentCount`. */
const MIN_SEGMENTS_FOR_CIRCLE = 8

/** The vias and pads of the pour's net on the layer, which KiCad 9 and earlier keep from being isolated in a hole: a via's position and drill, a pad's copper, narrowest side and slot or drill width (mm). */
export interface HatchNet {
  vias: { at: Vec2; drill: number }[]
  pads: { shape: Paths64; width: number; slot: number }[]
}

/**
 * What a hatch needs of what is round it: KiCad 9 and earlier the pour's net; KiCad 10 where the grid starts (the zone's hatch position on this layer, mm, y up) and the copper a hole may not hold
 * whole (the thermal relief rings, the solid vias' discs and the clearance holes).
 */
export type HatchAround = { net: HatchNet } | { at: Vec2 | undefined; protect: Paths64 }

const toU = (mm: number) => Math.round(mm * U)
/** C++'s integer `/ 2`. */
const half = (n: number) => Math.trunc(n / 2)

/** The number of segments `GetArcToSegmentCount` makes of an arc: its radius and error in whole units, its angle in degrees. */
function arcSegments(radius: number, error: number, degrees: number): number {
  const relative = Math.max(1, error) / Math.max(1, radius)
  const increment = Math.min(360 / MIN_SEGMENTS_FOR_CIRCLE, (180 / Math.PI) * Math.acos(1 - relative) * 2)
  return Math.max(Math.round(Math.abs(degrees) / increment), 2)
}

/** `SHAPE_POLY_SET::Chamfer` (`chamferFilletPolygon`, chamfered) of a contour: each corner replaced by the two points `distance` along its edges, at most half an edge. */
function chamfer(contour: Vec2[], distance: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < contour.length; i++) {
    const c = contour[i]
    const a = contour[(i + contour.length - 1) % contour.length]
    const b = contour[(i + 1) % contour.length]
    const [xa, ya, xb, yb] = [a.x - c.x, a.y - c.y, b.x - c.x, b.y - c.y]
    const [lena, lenb] = [Math.hypot(xa, ya), Math.hypot(xb, yb)]
    const d = Math.min(distance, 0.5 * lena, 0.5 * lenb)
    out.push({ x: c.x + Math.round((d * xa) / lena), y: c.y + Math.round((d * ya) / lena) }, { x: c.x + Math.round((d * xb) / lenb), y: c.y + Math.round((d * yb) / lenb) })
  }
  return out
}

/** `SHAPE_POLY_SET::Fillet` (`chamferFilletPolygon`, filleted) of a contour: each corner replaced by an arc of `distance`, in segments no further than `error` from the circle. */
function fillet(contour: Vec2[], distance: number, error: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < contour.length; i++) {
    const c = contour[i]
    const a = contour[(i + contour.length - 1) % contour.length]
    const b = contour[(i + 1) % contour.length]
    const [xa, ya, xb, yb] = [a.x - c.x, a.y - c.y, b.x - c.x, b.y - c.y]
    const [lena, lenb] = [Math.hypot(xa, ya), Math.hypot(xb, yb)]
    const cosine = (xa * xb + ya * yb) / (lena * lenb)
    let radius = distance
    const denom = Math.sqrt(2 / (1 + cosine) - 1)
    // Do nothing in case of parallel edges
    if (!Number.isFinite(denom)) continue
    // Limit the rounding distance to one half of an edge
    if (0.5 * lena * denom < radius) radius = 0.5 * lena * denom
    if (0.5 * lenb * denom < radius) radius = 0.5 * lenb * denom
    // The arc's centre
    let k = radius / Math.sqrt(0.5 * (1 - cosine))
    const lenab = Math.sqrt((xa / lena + xb / lenb) ** 2 + (ya / lena + yb / lenb) ** 2)
    const xc = c.x + (k * (xa / lena + xb / lenb)) / lenab
    const yc = c.y + (k * (ya / lena + yb / lenb)) / lenab
    // The arc's start and end vectors
    k = radius / Math.sqrt(2 / (1 + cosine) - 1)
    const xs = c.x + (k * xa) / lena - xc
    const ys = c.y + (k * ya) / lena - yc
    const xe = c.x + (k * xb) / lenb - xc
    const ye = c.y + (k * yb) / lenb - yc
    const arcAngle = Math.acos(Math.min(1, Math.max(-1, (xs * xe + ys * ye) / (radius * radius))))
    const segments = arcSegments(Math.trunc(radius), error, (arcAngle * 180) / Math.PI)
    let delta = arcAngle / segments
    const start = Math.atan2(-ys, xs)
    // Flip the arc for an inner corner
    if (xa * yb - ya * xb <= 0) delta *= -1
    let prev = { x: Math.round(xc + xs), y: Math.round(yc + ys) }
    out.push(prev)
    for (let j = 0; j < segments; j++) {
      const p = { x: Math.round(xc + Math.cos(start + (j + 1) * delta) * radius), y: Math.round(yc - Math.sin(start + (j + 1) * delta) * radius) }
      // The rounding can repeat a corner, which is not added
      if (p.x !== prev.x || p.y !== prev.y) {
        out.push(p)
        prev = p
      }
    }
  }
  return out
}

/** The contour of one hole, `hole_base` of KiCad's function (a square of `size` from the origin, in whole units, cut off or rounded as the hatch says), and the `maxError` the smoothing leaves for the rest. */
function holeBase(size: number, gap: number, minT: number, smooth: ZoneHatch["smooth"]): { corners: Vec2[]; maxError: number } {
  const square = [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }]
  let maxError = toU(MAX_ERROR_MM)
  if (!smooth) return { corners: square, maxError }
  // The actual size of the chamfer, or the rounded corner's radius, is the half of the gap scaled by the smoothing value
  let value = Math.round((gap * smooth.value) / 2)
  if (value <= toU(SMOOTH_MIN_MM)) return { corners: square, maxError }
  let level = smooth.level
  // If the smooth value is small, a chamfer is used even if a fillet is asked for
  if (value < toU(SMOOTH_SMALL_MM) && level > 1) level = 1
  // A larger value makes up for the outline thickness, and it is no larger than the hole's half
  value += half(minT)
  value = Math.min(value, half(gap))
  maxError = Math.max(maxError * 2, Math.trunc(value / 20))
  if (level === 1) return { corners: chamfer(square, value), maxError }
  // Force a better smoothing
  if (smooth.level > 2) maxError = half(maxError)
  return { corners: fillet(square, value, maxError), maxError }
}

/** A polytree's outlines each with its holes (a nested outline inside a hole stands alone, as KiCad's polygons do); `keep` says which outlines stay. */
function walk(node: PolyPath64, keep: (outline: Path64) => boolean, out: Paths64) {
  for (let i = 0; i < node.count; i++) {
    const outer = node.child(i)
    const stays = keep(outer.poly!)
    if (stays) out.push(outer.poly!)
    for (let j = 0; j < outer.count; j++) {
      const hole = outer.child(j)
      if (stays) out.push(hole.poly!)
      walk(hole, keep, out)
    }
  }
}

/** Some paths with the outlines `keep` does not want gone, along with their holes. */
function filterOutlines(paths: Paths64, keep: (outline: Path64) => boolean): Paths64 {
  const tree = new PolyTree64()
  const c = new Clipper64()
  c.addSubject(paths)
  c.execute(ClipType.Union, FillRule.NonZero, tree)
  const out: Paths64 = []
  walk(tree, keep, out)
  return out
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function boxOf(paths: Paths64): Box {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const path of paths) {
    for (const p of path) {
      if (p.x < b.minX) b.minX = p.x
      if (p.x > b.maxX) b.maxX = p.x
      if (p.y < b.minY) b.minY = p.y
      if (p.y > b.maxY) b.maxY = p.y
    }
  }
  return b
}

/** Whether a ring is wholly inside a hole, touching it nowhere: the ring's box is in the hole's, its centre and its first point are in the hole, and the two outlines do not meet (KiCad's checks). */
function holdsRing(hole: Path64, holeBox: Box, ring: Path64, ringBox: Box): boolean {
  if (ringBox.minX < holeBox.minX || ringBox.maxX > holeBox.maxX || ringBox.minY < holeBox.minY || ringBox.maxY > holeBox.maxY) return false
  const centre = { x: Math.trunc((ringBox.minX + ringBox.maxX) / 2), y: Math.trunc((ringBox.minY + ringBox.maxY) / 2) }
  if (Clipper.pointInPolygon(centre, hole) === PointInPolygonResult.IsOutside) return false
  if (Clipper.pointInPolygon(ring[0], hole) === PointInPolygonResult.IsOutside) return false
  return ring.every((p) => Clipper.pointInPolygon(p, hole) === PointInPolygonResult.IsInside) && !difference([ring], [hole]).length
}

/**
 * The lattice over some copper: its pitch, the grid's frame (the editor's points as KiCad turns the copper by minus the hatch angle, y down; the map is its own inverse), where the lattice starts in that
 * frame and how many holes it has each way. KiCad 9 and earlier start at the corner of the copper's box and stop past its size; KiCad 10 starts a pitch before the multiple of the pitch at or before the
 * corner and stops past the far side.
 */
function lattice(fill: Paths64, hatch: ZoneHatch, minT: number) {
  const thickness = Math.max(toU(hatch.thickness), minT + toU(LINE_MARGIN_MM))
  const gridsize = thickness + toU(hatch.gap)
  const angle = ((hatch.angle ?? 0) * Math.PI) / 180
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
  const turn = (p: Vec2): Vec2 => ({ x: p.x * cos + p.y * sin, y: p.x * sin - p.y * cos })
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const path of fill) {
    for (const p of path) {
      const q = turn(p)
      const [x, y] = [Math.round(q.x), Math.round(q.y)]
      if (x < box.minX) box.minX = x
      if (x > box.maxX) box.maxX = x
      if (y < box.minY) box.minY = y
      if (y > box.maxY) box.maxY = y
    }
  }
  const [x0, y0] = hatch.fromFill ? [box.minX, box.minY] : [box.minX - (box.minX % gridsize) - gridsize, box.minY - (box.minY % gridsize) - gridsize]
  return { thickness, gridsize, turn, x0, y0, columns: Math.floor((box.maxX - x0) / gridsize) + 1, rows: Math.floor((box.maxY - y0) / gridsize) + 1 }
}

/** Whether the grid of a hatched pour is too fine for the copper (more than `MAX_HOLES` holes over its box), so that the pour is filled solid instead. */
export function hatchTooFine(fill: Paths64, hatch: ZoneHatch, minWidth: number): boolean {
  if (!fill.length) return false
  const l = lattice(fill, hatch, toU(minWidth))
  return l.columns * l.rows > MAX_HOLES
}

/**
 * The copper of a hatched pour: `fill`, the copper while it is shrunk by half the minimum width, with the grid's holes cut out of it. `outline` is the zone's own outline, as drawn (not smoothed), inside
 * which the holes are kept, and `minWidth` the zone's minimum width (mm), which makes the holes larger by itself. `around` is KiCad 9's `net` when the hatch says it is `fromFill` and KiCad 10's otherwise.
 */
export function hatchPaths(fill: Paths64, hatch: ZoneHatch, minWidth: number, outline: Paths64, around: HatchAround): Paths64 {
  if (!fill.length) return fill
  const minT = toU(minWidth)
  const { thickness, gridsize, turn, x0, y0, columns, rows } = lattice(fill, hatch, minT)
  if (columns * rows > MAX_HOLES) return fill
  const hatchT = toU(hatch.thickness)
  const gap = toU(hatch.gap)
  // The hole is the gap, but the outline is the minimum width thick, so it is larger
  const size = gap + minT
  // All holes smaller than this are removed
  const minimalHoleArea = size * size * (hatch.minHole ?? DEFAULT_MIN_HOLE)
  const { corners, maxError } = holeBase(size, gap, minT, hatch.smooth)

  // Build the holes
  let move = { x: 0, y: 0 }
  if ("at" in around && around.at) {
    // KiCad 10 moves each hole by the position's remainder after the pitch, on the board's axes (y down), after the grid is turned
    const [x, y] = [toU(around.at.x), -toU(around.at.y)]
    move = { x: x % gridsize, y: -(y % gridsize) }
  }
  const holes: Paths64 = []
  for (let i = 0; i < columns; i++) {
    for (let j = 0; j < rows; j++) {
      const path = corners.map((c) => {
        const q = turn({ x: x0 + i * gridsize + c.x, y: y0 + j * gridsize + c.y })
        return { x: Math.round(q.x) + move.x, y: Math.round(q.y) + move.y }
      })
      holes.push(upright(path))
    }
  }

  // The fill has already been shrunk to ensure the minimum width, so the holes keep off its edge by what is beyond that, and off the zone's outline by the margin
  let margin = Math.trunc(minT * 1.1)
  // Using the hatch thickness can look more consistent than the minimum width
  if ("net" in around && !hatch.thinBorder && hatchT > margin) margin = hatchT
  // Don't let the thickness drop below twice the maximum error, or it might not grow back (KiCad 10)
  const fillMargin = "net" in around ? margin - minT : Math.max(hatchT - minT, maxError * 2)
  const outlineMargin = "net" in around ? margin : minT
  let cut = intersect(holes, inflate(fill, -fillMargin / U, JoinType.Square))
  cut = intersect(cut, inflate(outline, -outlineMargin / U, JoinType.Square))

  // KiCad 9 and earlier: vias and pads connected to the zone must not be allowed to become isolated inside one of the holes, so their copper is grown to be at least as wide as the gap, which guarantees
  // it touches at least one edge, and that is cut out of the holes
  if ("net" in around) {
    const minApronRadius = Math.trunc((gap * 10) / 19)
    const aprons: Paths64 = []
    for (const via of around.net.vias) aprons.push(circlePath(via.at.x, via.at.y, Math.max(minApronRadius, half(toU(via.drill)) + margin) / U))
    for (const pad of around.net.pads) {
      // What is wanted is to bulk up the pad's shape so that the narrowest bit of copper between the hole and the apron's edge is at least the margin wide, and the apron itself meets the minimum radius
      const padWidth = toU(pad.width)
      const minRingWidth = half(padWidth - toU(pad.slot))
      let clearance = Math.max(minApronRadius - half(padWidth), margin - minRingWidth)
      clearance = Math.max(0, clearance - half(thickness - minT))
      aprons.push(...inflate(pad.shape, clearance / U))
    }
    cut = difference(cut, union(aprons))
  }

  // Drop the holes that the cut left too small
  const rings = "protect" in around ? filterOutlines(around.protect, () => true).filter((p) => Clipper.isPositive(p)) : []
  const ringBoxes = rings.map((r) => boxOf([r]))
  const ringsBox = boxOf(rings)
  const kept = filterOutlines(cut, (hole) => {
    if (Math.abs(Clipper.area(hole)) < minimalHoleArea) return false
    if (!rings.length) return true
    // KiCad 10 drops any hole that holds a ring (a thermal relief's, a solid via's, a clearance hole) whole, so that it stays connected to the webbing; a hole it only overlaps stays
    const box = boxOf([hole])
    if (box.minX > ringsBox.maxX || box.maxX < ringsBox.minX || box.minY > ringsBox.maxY || box.maxY < ringsBox.minY) return true
    return !rings.some((ring, k) => holdsRing(hole, box, ring, ringBoxes[k]))
  })
  return difference(fill, kept)
}
