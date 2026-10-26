import type { Box } from "../lib/geometry"
import { pointSegmentDistance } from "../lib/geometry"
import type { Vec2 } from "./types"

// What KiCad's rule areas ask of a polygon (`SCH_RULE_AREA::RefreshContainedItemsAndDirectives`, eeschema/sch_rule_area.cpp of 10.0): whether a
// point, a wire with a width, or a box (the box of a symbol) touches or lies inside a polygon, and whether a point is on its edge. Touching
// counts: KiCad's `SHAPE_POLY_SET::Collide` is true at a distance of nothing (shape_poly_set.cpp:2410 to 2424 of 10.0).

/** Whether `p` is inside the polygon or on its edge. */
export function pointInPolygon(poly: readonly Vec2[], p: Vec2): boolean {
  if (poly.length < 3) return false
  if (onPolygonEdge(poly, p, 1e-9)) return true
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (poly[i].y > p.y !== poly[j].y > p.y && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) inside = !inside
  }
  return inside
}

/** Whether `p` is within `tol` of one of the polygon's edges (the closing edge included). */
export function onPolygonEdge(poly: readonly Vec2[], p: Vec2, tol: number): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (pointSegmentDistance(p, poly[j], poly[i]) <= tol) return true
  return false
}

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** Whether two segments share a point (touching and lying along each other included). */
export function segmentsMeet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  const within = (p: Vec2, q: Vec2, r: Vec2) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y)
  return (d1 === 0 && within(a, b, c)) || (d2 === 0 && within(a, b, d)) || (d3 === 0 && within(c, d, a)) || (d4 === 0 && within(c, d, b))
}

/** The distance between two segments: nothing when they meet. */
export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsMeet(a, b, c, d)) return 0
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b))
}

/**
 * Whether a wire from `a` to `b` of the width `2 * half` touches the polygon: an end inside it, or the wire within `half` of its edge
 * (`SHAPE_POLY_SET::Collide( SHAPE_SEGMENT )`: a distance of nothing, or under the half width).
 */
export function polygonHitsWire(poly: readonly Vec2[], a: Vec2, b: Vec2, half: number): boolean {
  if (poly.length < 3) return false
  if (pointInPolygon(poly, a) || pointInPolygon(poly, b)) return true
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = segmentDistance(a, b, poly[j], poly[i])
    if (d === 0 || d < half) return true
  }
  return false
}

/** Whether a box and the polygon share a point: a corner of one inside the other, or their edges crossing. */
export function polygonHitsBox(poly: readonly Vec2[], box: Box): boolean {
  if (poly.length < 3) return false
  const corners: Vec2[] = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ]
  if (poly.some((p) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY)) return true
  if (corners.some((c) => pointInPolygon(poly, c))) return true
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    for (let k = 0, l = 3; k < 4; l = k++) if (segmentsMeet(poly[j], poly[i], corners[l], corners[k])) return true
  }
  return false
}
