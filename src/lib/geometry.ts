import type { Rotation, Vec2 } from "../model/types"

export const EPS = 1e-6

export const v = (x: number, y: number): Vec2 => ({ x, y })
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s })
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y
export const len = (a: Vec2) => Math.hypot(a.x, a.y)
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y)
export const samePoint = (a: Vec2, b: Vec2, eps = 1e-4) =>
  Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps

export const snap = (value: number, grid: number) => Math.round(value / grid) * grid
export const snapPoint = (p: Vec2, grid: number): Vec2 => ({
  x: round(snap(p.x, grid)),
  y: round(snap(p.y, grid)),
})

/** Trim floating point noise so coordinates serialise cleanly. */
export const round = (n: number, digits = 4) => {
  const f = 10 ** digits
  const r = Math.round(n * f) / f
  return Object.is(r, -0) ? 0 : r
}

export const roundPoint = (p: Vec2): Vec2 => ({ x: round(p.x), y: round(p.y) })

/** Rotate counter-clockwise by a multiple of 90°, exact for grid coordinates. */
export function rotate90(p: Vec2, rot: Rotation): Vec2 {
  switch (rot) {
    case 0:
      return { x: p.x, y: p.y }
    case 90:
      return { x: -p.y, y: p.x }
    case 180:
      return { x: -p.x, y: -p.y }
    case 270:
      return { x: p.y, y: -p.x }
  }
}

export const nextRotation = (rot: Rotation): Rotation => (((rot + 90) % 360) as Rotation)

export function transformPoint(
  p: Vec2,
  origin: Vec2,
  rot: Rotation,
  mirrorX = false,
): Vec2 {
  const m = mirrorX ? { x: -p.x, y: p.y } : p
  const r = rotate90(m, rot)
  return { x: origin.x + r.x, y: origin.y + r.y }
}

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const emptyBox = (): Box => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
})

export function expandBox(b: Box, p: Vec2, pad = 0): Box {
  b.minX = Math.min(b.minX, p.x - pad)
  b.minY = Math.min(b.minY, p.y - pad)
  b.maxX = Math.max(b.maxX, p.x + pad)
  b.maxY = Math.max(b.maxY, p.y + pad)
  return b
}

export const boxValid = (b: Box) => Number.isFinite(b.minX) && b.maxX >= b.minX

export function transformBox(b: Box, origin: Vec2, rot: Rotation, mirrorX = false): Box {
  const out = emptyBox()
  for (const c of [
    v(b.minX, b.minY),
    v(b.maxX, b.minY),
    v(b.maxX, b.maxY),
    v(b.minX, b.maxY),
  ]) {
    expandBox(out, transformPoint(c, origin, rot, mirrorX))
  }
  return out
}

export const pointInBox = (p: Vec2, b: Box, pad = 0) =>
  p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad

export const boxesOverlap = (a: Box, b: Box) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

export const boxContains = (outer: Box, inner: Box) =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY &&
  inner.maxY <= outer.maxY

export function normBox(a: Vec2, b: Vec2): Box {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  }
}

/** Distance from point p to segment ab. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  if (l2 < EPS * EPS) return dist(p, a)
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))
  return dist(p, add(a, scale(ab, t)))
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  if (l2 < EPS * EPS) return a
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))
  return add(a, scale(ab, t))
}

function orient(a: Vec2, b: Vec2, c: Vec2) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (o1 * o2 < 0 && o3 * o4 < 0) return true
  const on = (p: Vec2, q: Vec2, r: Vec2) =>
    Math.abs(orient(p, q, r)) < EPS &&
    r.x >= Math.min(p.x, q.x) - EPS &&
    r.x <= Math.max(p.x, q.x) + EPS &&
    r.y >= Math.min(p.y, q.y) - EPS &&
    r.y <= Math.max(p.y, q.y) + EPS
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)
}

export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  )
}

/** True when p lies on segment ab (within eps), endpoints included. */
export const pointOnSegment = (p: Vec2, a: Vec2, b: Vec2, eps = 1e-4) =>
  pointSegmentDistance(p, a, b) < eps

export function polylineSegments(points: Vec2[]): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = []
  for (let i = 0; i < points.length - 1; i++) out.push([points[i], points[i + 1]])
  return out
}

/** Remove duplicate and collinear interior points from an orthogonal or free polyline. */
export function simplifyPolyline(points: Vec2[]): Vec2[] {
  const dedup: Vec2[] = []
  for (const p of points) {
    if (!dedup.length || !samePoint(dedup[dedup.length - 1], p)) dedup.push(p)
  }
  if (dedup.length < 3) return dedup
  const out: Vec2[] = [dedup[0]]
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = out[out.length - 1]
    const b = dedup[i]
    const c = dedup[i + 1]
    if (Math.abs(orient(a, b, c)) > 1e-9) out.push(b)
  }
  out.push(dedup[dedup.length - 1])
  return out
}

/** Constrain the vector from `from` to `to` to the nearest multiple of 45°. */
export function snap45(from: Vec2, to: Vec2): Vec2 {
  const d = sub(to, from)
  const l = len(d)
  if (l < EPS) return to
  const angle = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4)
  const projected = Math.abs(Math.cos(angle) * d.x + Math.sin(angle) * d.y)
  return { x: from.x + Math.cos(angle) * projected, y: from.y + Math.sin(angle) * projected }
}

/**
 * Route from a to b using one horizontal and one vertical leg.
 * `horizontalFirst` picks which leg leaves `a`.
 */
export function orthogonalElbow(a: Vec2, b: Vec2, horizontalFirst: boolean): Vec2[] {
  if (Math.abs(a.x - b.x) < EPS || Math.abs(a.y - b.y) < EPS) return [a, b]
  const mid = horizontalFirst ? v(b.x, a.y) : v(a.x, b.y)
  return [a, mid, b]
}

/** Route from a to b with a 45° chamfer: straight leg then diagonal leg. */
export function chamferedElbow(a: Vec2, b: Vec2, diagonalFirst: boolean): Vec2[] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx < EPS || ady < EPS || Math.abs(adx - ady) < EPS) return [a, b]
  const diag = Math.min(adx, ady)
  const diagVec = v(Math.sign(dx) * diag, Math.sign(dy) * diag)
  if (diagonalFirst) return [a, add(a, diagVec), b]
  return [a, sub(b, diagVec), b]
}
