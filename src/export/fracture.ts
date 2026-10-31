import type { Vec2 } from "../model/types"

// A filled drawing with holes as one contour. A Gerber region has one outline, and clearing the
// holes with the clear polarity would also erase the pads and traces that were drawn earlier
// inside them, so the holes are joined to the outline by a bridge: the contour goes out along it,
// round the hole the other way and back along the same line. The bridge covers no area.

const signedArea = (ring: Vec2[]) => {
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  return twice / 2
}

const oriented = (ring: Vec2[], ccw: boolean) => ((signedArea(ring) > 0) === ccw ? ring : [...ring].reverse())

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

const inTriangle = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) => {
  const d1 = cross(a, b, p)
  const d2 = cross(b, c, p)
  const d3 = cross(c, a, p)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

/** The outline and its holes as one ring, the holes joined to the outline by bridges (Eberly's visible vertex). */
export function fractureRings(outer: Vec2[], holes: Vec2[][]): Vec2[] {
  let ring = oriented(outer, true).slice()
  const todo = holes
    .filter((h) => h.length >= 3)
    .map((h) => oriented(h, false))
    .map((hole) => ({ hole, right: hole.reduce((m, p) => Math.max(m, p.x), -Infinity) }))
    .sort((a, b) => b.right - a.right)
  for (const { hole } of todo) {
    let mi = 0
    for (let i = 1; i < hole.length; i++) if (hole[i].x > hole[mi].x) mi = i
    const m = hole[mi]
    // The nearest outline edge to the right of the hole's rightmost point.
    let bestX = Infinity
    let edge = -1
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      if (a.y === b.y || (m.y < Math.min(a.y, b.y) || m.y > Math.max(a.y, b.y))) continue
      const x = a.x + ((m.y - a.y) / (b.y - a.y)) * (b.x - a.x)
      if (x >= m.x - 1e-12 && x < bestX) {
        bestX = x
        edge = i
      }
    }
    let target = -1
    if (edge >= 0) {
      const a = ring[edge]
      const b = ring[(edge + 1) % ring.length]
      const hit = { x: bestX, y: m.y }
      const pi = a.x > b.x ? edge : (edge + 1) % ring.length
      target = pi
      // A vertex inside the triangle hides the corner: the one closest in direction to the ray is visible.
      let bestAngle = Infinity
      for (let i = 0; i < ring.length; i++) {
        if (i === pi) continue
        const v = ring[i]
        if (!inTriangle(v, m, hit, ring[pi])) continue
        const angle = Math.abs(Math.atan2(v.y - m.y, v.x - m.x))
        if (angle < bestAngle) {
          bestAngle = angle
          target = i
        }
      }
    } else {
      let best = Infinity
      ring.forEach((v, i) => {
        const d = Math.hypot(v.x - m.x, v.y - m.y)
        if (d < best) [best, target] = [d, i]
      })
    }
    const around = [...hole.slice(mi), ...hole.slice(0, mi)]
    ring.splice(target + 1, 0, ...around, around[0], ring[target])
  }
  return ring
}
