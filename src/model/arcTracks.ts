import { closestPointOnSegment, dist, pointSegmentDistance, type Box } from "../lib/geometry"
import { arcCircle, flattenArc, FLATTEN_TOLERANCE, type ArcCircle } from "./shapes"
import type { Trace, Vec2 } from "./types"

// X4: arc tracks. An arc track is a trace with `arc` set whose three points are KiCad's `start`, `mid` and `end`; the circle and the way
// round follow from them (`arcCircle`), so nothing is rounded to an angle. Distances are exact (an arc is a circle's piece, not a polyline
// of chords): a check that measured chords would be 0.2 micrometres wrong on one side of the circle.

const TAU = Math.PI * 2
const EPS = 1e-9

export interface ArcTrack {
  start: Vec2
  mid: Vec2
  end: Vec2
  circle: ArcCircle | null
}

/** The three points of an arc trace, with the circle they make (null when they lie on a line: a straight track from start to end). */
export function arcOf(points: readonly Vec2[]): ArcTrack {
  const [start, mid, end] = points
  return { start, mid, end, circle: arcCircle(start, mid, end) }
}

/** X24: the tracks whose copper is open through the solder mask on one side. */
export const bareTraces = (project: { traces: readonly Trace[] }, side: "top" | "bottom"): Trace[] => project.traces.filter((t) => t.bare && t.layer === side)

/** Whether a trace is an arc track with its three points. */
export const isArcTrace = (t: Pick<Trace, "arc" | "points">): boolean => t.arc === true && t.points.length === 3

/** Whether the direction `angle` (radians, from the centre) is on the arc's sweep, to a nanoradian. */
export function onSweep(a: ArcCircle, angle: number): boolean {
  const span = Math.abs(a.sweep)
  if (span >= TAU - EPS) return true
  let d = a.sweep > 0 ? angle - a.a0 : a.a0 - angle
  d = ((d % TAU) + TAU) % TAU
  return d <= span + EPS || d >= TAU - EPS
}

const at = (a: ArcCircle, angle: number): Vec2 => ({ x: a.c.x + a.r * Math.cos(angle), y: a.c.y + a.r * Math.sin(angle) })

const angleOf = (c: Vec2, p: Vec2) => Math.atan2(p.y - c.y, p.x - c.x)

/** The distance from a point to the arc's curve. */
export function pointArcDistance(p: Vec2, arc: ArcTrack): number {
  const a = arc.circle
  if (!a) return pointSegmentDistance(p, arc.start, arc.end)
  const d = dist(p, a.c)
  if (d < EPS) return a.r
  if (onSweep(a, angleOf(a.c, p))) return Math.abs(d - a.r)
  return Math.min(dist(p, arc.start), dist(p, arc.end))
}

/** Where a segment crosses the arc's circle, as the points of the segment that are on the arc's sweep. */
function segmentArcCrossings(p: Vec2, q: Vec2, a: ArcCircle): Vec2[] {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const fx = p.x - a.c.x
  const fy = p.y - a.c.y
  const A = dx * dx + dy * dy
  if (A < EPS * EPS) return []
  const B = 2 * (fx * dx + fy * dy)
  const C = fx * fx + fy * fy - a.r * a.r
  const disc = B * B - 4 * A * C
  if (disc < 0) return []
  const root = Math.sqrt(disc)
  const out: Vec2[] = []
  for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
    if (t < -EPS || t > 1 + EPS) continue
    const pt = { x: p.x + dx * t, y: p.y + dy * t }
    if (onSweep(a, angleOf(a.c, pt))) out.push(pt)
  }
  return out
}

/** The distance from a segment to the arc's curve; 0 where they cross. */
export function segmentArcDistance(p: Vec2, q: Vec2, arc: ArcTrack): number {
  const a = arc.circle
  if (!a) return segmentSegment(p, q, arc.start, arc.end)
  if (segmentArcCrossings(p, q, a).length) return 0
  let best = Math.min(pointArcDistance(p, arc), pointArcDistance(q, arc), pointSegmentDistance(arc.start, p, q), pointSegmentDistance(arc.end, p, q))
  // The arc's point nearest the line, when the segment reaches it.
  const foot = closestPointOnSegment(a.c, p, q)
  const d = dist(foot, a.c)
  if (d > EPS) {
    const angle = angleOf(a.c, foot)
    if (onSweep(a, angle)) best = Math.min(best, dist(foot, at(a, angle)))
  }
  return best
}

function segmentSegment(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  // Local copy so this module needs nothing beyond the geometry helpers it already imports.
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b))
}

/** Where two arcs' circles cross, as the points that are on both sweeps. */
function arcArcCrossings(x: ArcCircle, y: ArcCircle): Vec2[] {
  const d = dist(x.c, y.c)
  if (d < EPS || d > x.r + y.r + EPS || d < Math.abs(x.r - y.r) - EPS) return []
  const along = (x.r * x.r - y.r * y.r + d * d) / (2 * d)
  const h2 = x.r * x.r - along * along
  const h = h2 > 0 ? Math.sqrt(h2) : 0
  const ux = (y.c.x - x.c.x) / d
  const uy = (y.c.y - x.c.y) / d
  const mx = x.c.x + ux * along
  const my = x.c.y + uy * along
  const pts = h === 0 ? [{ x: mx, y: my }] : [{ x: mx - uy * h, y: my + ux * h }, { x: mx + uy * h, y: my - ux * h }]
  return pts.filter((p) => onSweep(x, angleOf(x.c, p)) && onSweep(y, angleOf(y.c, p)))
}

/** The distance between two arcs' curves; 0 where they cross. */
export function arcArcDistance(x: ArcTrack, y: ArcTrack): number {
  const a = x.circle
  const b = y.circle
  if (!a) return segmentArcDistance(x.start, x.end, y)
  if (!b) return segmentArcDistance(y.start, y.end, x)
  if (arcArcCrossings(a, b).length) return 0
  let best = Math.min(pointArcDistance(x.start, y), pointArcDistance(x.end, y), pointArcDistance(y.start, x), pointArcDistance(y.end, x))
  const d = dist(a.c, b.c)
  if (d > EPS) {
    // Along the line of the centres, where the circles are nearest and farthest.
    const ang = angleOf(a.c, b.c)
    for (const ta of [ang, ang + Math.PI]) {
      if (!onSweep(a, ta)) continue
      for (const tb of [ang, ang + Math.PI]) if (onSweep(b, tb)) best = Math.min(best, dist(at(a, ta), at(b, tb)))
    }
  } else {
    // Concentric: the same direction on both is |r1 - r2| apart.
    const shared = [a.a0, a.a0 + a.sweep, b.a0, b.a0 + b.sweep].some((t) => onSweep(a, t) && onSweep(b, t))
    if (shared) best = Math.min(best, Math.abs(a.r - b.r))
  }
  return best
}

/** The box of an arc track's copper: the curve's extremes, grown by half the width. */
export function arcBox(arc: ArcTrack, width: number): Box {
  const xs = [arc.start.x, arc.end.x]
  const ys = [arc.start.y, arc.end.y]
  const a = arc.circle
  if (a) {
    for (let k = 0; k < 4; k++) {
      const t = (k * Math.PI) / 2
      if (onSweep(a, t)) {
        const p = at(a, t)
        xs.push(p.x)
        ys.push(p.y)
      }
    }
  }
  const h = width / 2
  return { minX: Math.min(...xs) - h, minY: Math.min(...ys) - h, maxX: Math.max(...xs) + h, maxY: Math.max(...ys) + h }
}

/** The arc's length along its curve; the straight distance for a degenerate arc. */
export function arcLength(arc: ArcTrack): number {
  const a = arc.circle
  return a ? a.r * Math.abs(a.sweep) : dist(arc.start, arc.end)
}

/** The point of the arc nearest a point. */
export function closestPointOnArc(p: Vec2, arc: ArcTrack): Vec2 {
  const a = arc.circle
  if (!a) return closestPointOnSegment(p, arc.start, arc.end)
  if (dist(p, a.c) > EPS && onSweep(a, angleOf(a.c, p))) return at(a, angleOf(a.c, p))
  return dist(p, arc.start) <= dist(p, arc.end) ? arc.start : arc.end
}

/** Chords along the arc, no point more than `tol` from it, for the places that need a polyline (the router's grid, a pour's outline, a drawing). */
export function arcPolyline(points: readonly Vec2[], tol = FLATTEN_TOLERANCE): Vec2[] {
  return flattenArc(points[0], points[1], points[2], tol)
}

/**
 * An arc track's three points after a move of its middle to `to` (the way the editor bends an arc), the ends kept; unchanged when the three
 * would lie on a line. The middle is a point on the arc, so nothing about the circle is stored apart from it.
 */
export function bendArc(points: readonly Vec2[], to: Vec2): Vec2[] {
  return arcCircle(points[0], to, points[2]) ? [points[0], { ...to }, points[2]] : [...points]
}

/** The arc track's point halfway round, which is `mid` made exact: where the editor puts a new arc's middle. */
export function arcMiddle(start: Vec2, end: Vec2, bulge: number): Vec2 {
  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy) || 1
  return { x: mx - (dy / len) * bulge, y: my + (dx / len) * bulge }
}

/** The points of a track item's centre line: its two ends, or an arc track's curve cut to within the drawings' own tolerance. */
export const trackPoints = (it: { a: Vec2; b: Vec2; arc?: ArcTrack }): Vec2[] => (it.arc ? arcPolyline([it.arc.start, it.arc.mid, it.arc.end]) : [it.a, it.b])
