import { dist, pointSegmentDistance, segmentSegmentDistance, segmentsIntersect, type Box } from "../lib/geometry"
import { slotEnds, type WorldPad } from "./instances"
import { circleRing, pillRing, roundChamferRing } from "./padGeom"
import type { ShapeCopper } from "./shapes"
import type { Vec2 } from "./types"

// Where a pad's copper is, as distances (the checks, the router, the pour and the picking all ask). A pad is a level rectangle, a
// circle, a pill, a level rectangle with rounded corners (a rectangle's inner part grown by the radius, so a distance is a rectangle's
// less the radius), or a polygon with one ring or several (a chamfered corner, a turned pad, a custom shape, with holes in it), counted
// even-odd.

/** The rings of a polygon pad: all of them, or the first alone; null for a pad that is not a polygon. */
export const padRingsOf = (pad: WorldPad): Vec2[][] | null => (pad.rings ?? (pad.shape === "polygon" && pad.points && pad.points.length >= 3 ? [pad.points] : null))

/** Where a pad's hole is: its own place when it has none apart. */
export const holeCentre = (pad: Pick<WorldPad, "x" | "y" | "hole">): Vec2 => pad.hole ?? pad

/** The box of a pad's copper. */
export function padBox(p: WorldPad): Box {
  const rings = padRingsOf(p)
  if (rings) {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const ring of rings) {
      for (const q of ring) {
        if (q.x < b.minX) b.minX = q.x
        if (q.y < b.minY) b.minY = q.y
        if (q.x > b.maxX) b.maxX = q.x
        if (q.y > b.maxY) b.maxY = q.y
      }
    }
    return b
  }
  return { minX: p.x - p.width / 2, minY: p.y - p.height / 2, maxX: p.x + p.width / 2, maxY: p.y + p.height / 2 }
}

function pointRingsDistance(p: Vec2, rings: Vec2[][]): number {
  let inside = false
  let best = Infinity
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
      best = Math.min(best, pointSegmentDistance(p, a, b))
    }
  }
  return inside ? 0 : best
}

/** The level rectangle a rounded-corner pad is grown from: its size less the radius all round (a stadium's is a line). */
function innerOf(pad: WorldPad, corner: number): WorldPad {
  return { ...pad, corner: undefined, width: Math.max(0, pad.width - 2 * corner), height: Math.max(0, pad.height - 2 * corner) }
}

function rectCorners(pad: WorldPad): Vec2[] {
  const hw = pad.width / 2
  const hh = pad.height / 2
  return [
    { x: pad.x - hw, y: pad.y - hh },
    { x: pad.x + hw, y: pad.y - hh },
    { x: pad.x + hw, y: pad.y + hh },
    { x: pad.x - hw, y: pad.y + hh },
  ]
}

/** Distance from point to a pad's copper (0 inside). */
export function pointPadDistance(p: Vec2, pad: WorldPad): number {
  const rings = padRingsOf(pad)
  if (rings) return pointRingsDistance(p, rings)
  if (pad.shape === "circle") return Math.max(0, dist(p, pad) - pad.width / 2)
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    const horizontal = pad.width >= pad.height
    const a = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
    const b = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
    return Math.max(0, pointSegmentDistance(p, a, b) - r)
  }
  if (pad.corner) return Math.max(0, pointPadDistance(p, innerOf(pad, pad.corner)) - pad.corner)
  const dx = Math.max(Math.abs(p.x - pad.x) - pad.width / 2, 0)
  const dy = Math.max(Math.abs(p.y - pad.y) - pad.height / 2, 0)
  return Math.hypot(dx, dy)
}

export function segmentPadDistance(a: Vec2, b: Vec2, pad: WorldPad): number {
  const rings = padRingsOf(pad)
  if (rings) {
    if (pointRingsDistance(a, rings) === 0 || pointRingsDistance(b, rings) === 0) return 0
    let best = Math.min(pointRingsDistance(a, rings), pointRingsDistance(b, rings))
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const c = ring[i]
        const d = ring[(i + 1) % ring.length]
        if (segmentsIntersect(a, b, c, d)) return 0
        best = Math.min(best, pointSegmentDistance(c, a, b))
      }
    }
    return best
  }
  if (pad.shape === "circle") return Math.max(0, pointSegmentDistance(pad, a, b) - pad.width / 2)
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    const horizontal = pad.width >= pad.height
    const c = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
    const d = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
    return Math.max(0, segmentSegmentDistance(a, b, c, d) - r)
  }
  if (pad.corner) return Math.max(0, segmentPadDistance(a, b, innerOf(pad, pad.corner)) - pad.corner)
  if (pointPadDistance(a, pad) === 0 || pointPadDistance(b, pad) === 0) return 0
  const corners = rectCorners(pad)
  let best = Math.min(pointPadDistance(a, pad), pointPadDistance(b, pad))
  for (let i = 0; i < 4; i++) {
    const c = corners[i]
    const d = corners[(i + 1) % 4]
    if (segmentsIntersect(a, b, c, d)) return 0
    best = Math.min(best, pointSegmentDistance(c, a, b))
  }
  return best
}

/** A pad as lines with a half width and a filled area. */
export function padCopper(p: WorldPad): ShapeCopper {
  const rings = padRingsOf(p)
  if (rings) return { edges: rings.flatMap((ring) => ring.map((q, i) => [q, ring[(i + 1) % ring.length]] as [Vec2, Vec2])), half: 0, fill: rings }
  if (p.shape === "circle") return { edges: [[p, p]], half: p.width / 2, fill: [] }
  if (p.shape === "pill") {
    const r = Math.min(p.width, p.height) / 2
    const half = Math.max(p.width, p.height) / 2 - r
    const horizontal = p.width >= p.height
    return { edges: [horizontal ? [{ x: p.x - half, y: p.y }, { x: p.x + half, y: p.y }] : [{ x: p.x, y: p.y - half }, { x: p.x, y: p.y + half }]], half: r, fill: [] }
  }
  if (p.corner) {
    const ring = rectCorners(innerOf(p, p.corner))
    return { edges: ring.map((q, i) => [q, ring[(i + 1) % ring.length]] as [Vec2, Vec2]), half: p.corner, fill: [ring] }
  }
  const ring = rectCorners(p)
  return { edges: ring.map((q, i) => [q, ring[(i + 1) % ring.length]] as [Vec2, Vec2]), half: 0, fill: [ring] }
}

/**
 * How near the board edge a pad's copper can come, for an edge that is a convex outline's: nearest at a corner, a pill's end or a
 * circle's rim, so it is the least over those points less the rounding that stands for the rest of the shape.
 */
export function padEdgeDistance(pad: WorldPad, d: (p: Vec2) => number): number {
  if (pad.shape === "circle") return d(pad) - pad.width / 2
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    const ends = pad.width >= pad.height ? [{ x: pad.x - half, y: pad.y }, { x: pad.x + half, y: pad.y }] : [{ x: pad.x, y: pad.y - half }, { x: pad.x, y: pad.y + half }]
    return Math.min(...ends.map(d)) - r
  }
  const rings = padRingsOf(pad)
  if (rings) return Math.min(...rings.flatMap((ring) => ring.map(d)))
  if (pad.corner) return Math.min(...rectCorners(innerOf(pad, pad.corner)).map(d)) - pad.corner
  return Math.min(...rectCorners(pad).map(d))
}

/** The rings of a pad's copper as polygons, arcs flattened: for what a polygon is needed of (the annular ring, an outline of it on screen). */
export function padOutline(pad: WorldPad): Vec2[][] {
  const rings = padRingsOf(pad)
  if (rings) return rings
  const at = (ring: Vec2[]) => ring.map((q) => ({ x: pad.x + q.x, y: pad.y + q.y }))
  if (pad.shape === "circle") return [at(circleRing(0, 0, pad.width / 2))]
  if (pad.shape === "pill") return [at(pillRing(pad.width, pad.height))]
  return [at(roundChamferRing(pad.width, pad.height, pad.corner ?? 0, 0, 0))]
}

/**
 * The copper ring round a pad's hole, from the hole's edge to the nearest edge of the copper: the least distance from the hole's centre
 * line (its centre, or a slot's two ends) to the outline, less the hole's radius. A hole off the pad's centre, a rounded or custom pad:
 * what a centred hole in a rectangle or circle has as `(shorter side - hole) / 2`, which is what this gives for those.
 */
export function padRingWidth(pad: WorldPad): number {
  const hole = pad.holeDiameter ?? 0
  const ends = slotEnds(pad)
  const a = ends?.[0] ?? holeCentre(pad)
  const b = ends?.[1] ?? holeCentre(pad)
  let best = Infinity
  for (const ring of padOutline(pad)) {
    for (let i = 0; i < ring.length; i++) best = Math.min(best, segmentSegmentDistance(a, b, ring[i], ring[(i + 1) % ring.length]))
  }
  return best - hole / 2
}
