import { describe, expect, it } from "vitest"
import { arcArcDistance, arcBox, arcLength, arcMiddle, arcOf, bendArc, closestPointOnArc, isArcTrace, onSweep, pointArcDistance, segmentArcDistance } from "../src/model/arcTracks"
import type { Vec2 } from "../src/model/types"

// X4: arc tracks. The distances are exact; each is checked against a dense sampling of the same curve, at many angles, both ways round.

const TAU = Math.PI * 2
const P = (x: number, y: number): Vec2 => ({ x, y })

/** An arc of radius r about c from angle a0 sweeping s radians (positive counter-clockwise), as the three points KiCad stores. */
function arcPoints(c: Vec2, r: number, a0: number, s: number): Vec2[] {
  const at = (a: number) => P(c.x + r * Math.cos(a), c.y + r * Math.sin(a))
  return [at(a0), at(a0 + s / 2), at(a0 + s)]
}

function sample(points: Vec2[], n = 4000): Vec2[] {
  const arc = arcOf(points)
  const a = arc.circle!
  return Array.from({ length: n + 1 }, (_, i) => P(a.c.x + a.r * Math.cos(a.a0 + (a.sweep * i) / n), a.c.y + a.r * Math.sin(a.a0 + (a.sweep * i) / n)))
}

const brutePointArc = (p: Vec2, pts: Vec2[]) => Math.min(...pts.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))
const bruteSegArc = (a: Vec2, b: Vec2, pts: Vec2[]) => {
  let best = Infinity
  for (let i = 0; i <= 600; i++) {
    const t = i / 600
    const q = P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    best = Math.min(best, brutePointArc(q, pts))
  }
  return best
}

const ANGLES = [0, 15, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 270, 300, 330, 359]
const SWEEPS = [20, 60, 90, 135, 179, 180, 181, 270, 340].flatMap((d) => [d, -d])

describe("arc geometry", () => {
  it("finds the circle, the sweep and the way round at many angles", () => {
    for (const a0 of ANGLES) {
      for (const sweep of SWEEPS) {
        const pts = arcPoints(P(3, -2), 5, (a0 * Math.PI) / 180, (sweep * Math.PI) / 180)
        const arc = arcOf(pts)
        expect(arc.circle, `${a0} ${sweep}`).not.toBeNull()
        expect(arc.circle!.c.x).toBeCloseTo(3, 6)
        expect(arc.circle!.c.y).toBeCloseTo(-2, 6)
        expect(arc.circle!.r).toBeCloseTo(5, 6)
        expect(arc.circle!.sweep).toBeCloseTo((sweep * Math.PI) / 180, 6)
        expect(arcLength(arc)).toBeCloseTo(5 * Math.abs((sweep * Math.PI) / 180), 6)
      }
    }
  })

  it("tells which directions are on the sweep", () => {
    const arc = arcOf(arcPoints(P(0, 0), 2, Math.PI / 6, Math.PI)).circle!
    expect(onSweep(arc, Math.PI / 2)).toBe(true)
    expect(onSweep(arc, Math.PI / 6)).toBe(true)
    expect(onSweep(arc, Math.PI / 6 + Math.PI)).toBe(true)
    expect(onSweep(arc, -Math.PI / 2)).toBe(false)
    const cw = arcOf(arcPoints(P(0, 0), 2, Math.PI / 6, -Math.PI)).circle!
    expect(onSweep(cw, -Math.PI / 2)).toBe(true)
    expect(onSweep(cw, Math.PI / 2)).toBe(false)
  })

  it("is a straight track when its three points lie on a line", () => {
    const arc = arcOf([P(0, 0), P(1, 0), P(2, 0)])
    expect(arc.circle).toBeNull()
    expect(pointArcDistance(P(1, 3), arc)).toBeCloseTo(3, 9)
    expect(arcLength(arc)).toBeCloseTo(2, 9)
  })

  it("measures a point to the curve", () => {
    for (const a0 of ANGLES) {
      for (const sweep of SWEEPS) {
        const pts = arcPoints(P(1, 1), 4, (a0 * Math.PI) / 180, (sweep * Math.PI) / 180)
        const arc = arcOf(pts)
        const dense = sample(pts)
        for (const p of [P(1, 1), P(1, 6), P(-5, 1), P(6, -4), P(1.5, 1.5), P(8, 8), P(0, -3)]) {
          const exact = pointArcDistance(p, arc)
          const brute = brutePointArc(p, dense)
          expect(exact, `${a0} ${sweep} ${p.x},${p.y}`).toBeLessThanOrEqual(brute + 1e-9)
          expect(brute - exact, `${a0} ${sweep} ${p.x},${p.y}`).toBeLessThan(0.003)
        }
      }
    }
  })

  it("measures a segment to the curve", () => {
    const segs: [Vec2, Vec2][] = [[P(-6, 7), P(8, 7)], [P(-3, -9), P(-3, 9)], [P(0, 0), P(0.5, 0.5)], [P(7, -2), P(2, 6)], [P(-1, 3), P(5, -2)], [P(9, 9), P(10, 10)]]
    for (const a0 of ANGLES.filter((_, i) => i % 2 === 0)) {
      for (const sweep of SWEEPS.filter((_, i) => i % 2 === 0)) {
        const pts = arcPoints(P(1, 1), 4, (a0 * Math.PI) / 180, (sweep * Math.PI) / 180)
        const arc = arcOf(pts)
        const dense = sample(pts, 2000)
        for (const [a, b] of segs) {
          const exact = segmentArcDistance(a, b, arc)
          const brute = bruteSegArc(a, b, dense)
          expect(exact, `${a0} ${sweep}`).toBeLessThanOrEqual(brute + 1e-6)
          expect(brute - exact, `${a0} ${sweep} ${a.x},${a.y}`).toBeLessThan(0.02)
        }
      }
    }
  })

  it("is zero where a segment crosses the arc and not where it crosses the circle elsewhere", () => {
    const arc = arcOf(arcPoints(P(0, 0), 5, 0, Math.PI / 2))
    expect(segmentArcDistance(P(0, 3), P(6, 3), arc)).toBe(0)
    expect(segmentArcDistance(P(-6, -3), P(-1, -3), arc)).toBeGreaterThan(3)
    // The segment crosses the circle on the far side of the sweep.
    expect(segmentArcDistance(P(-6, 0), P(-1, 0), arc)).toBeGreaterThan(5)
  })

  it("measures two arcs to each other", () => {
    const cases: [Vec2[], Vec2[]][] = [
      [arcPoints(P(0, 0), 5, 0, Math.PI), arcPoints(P(0, 0), 7, 0, Math.PI)],
      [arcPoints(P(0, 0), 5, 0, Math.PI), arcPoints(P(0, 0), 7, Math.PI, Math.PI)],
      [arcPoints(P(0, 0), 5, 0, Math.PI), arcPoints(P(8, 0), 4, Math.PI / 2, Math.PI)],
      [arcPoints(P(0, 0), 5, 0.3, 1), arcPoints(P(2, 9), 3, -1, -2)],
      [arcPoints(P(0, 0), 5, 0, TAU * 0.9), arcPoints(P(1, 0), 2, 0, TAU * 0.8)],
    ]
    for (const [x, y] of cases) {
      const exact = arcArcDistance(arcOf(x), arcOf(y))
      const dx = sample(x, 1500)
      const dy = sample(y, 1500)
      let brute = Infinity
      for (const p of dx) brute = Math.min(brute, brutePointArc(p, dy.filter((_, i) => i % 3 === 0)))
      expect(exact).toBeLessThanOrEqual(brute + 1e-6)
      expect(brute - exact).toBeLessThan(0.02)
    }
  })

  it("boxes the curve, extremes included", () => {
    const arc = arcOf(arcPoints(P(0, 0), 5, -Math.PI / 4, Math.PI / 2))
    const box = arcBox(arc, 0.4)
    expect(box.maxX).toBeCloseTo(5.2, 9)
    expect(box.minX).toBeCloseTo(5 * Math.cos(Math.PI / 4) - 0.2, 9)
    expect(box.maxY).toBeCloseTo(5 * Math.sin(Math.PI / 4) + 0.2, 9)
  })

  it("finds the point of the curve nearest a point", () => {
    const arc = arcOf(arcPoints(P(0, 0), 5, 0, Math.PI / 2))
    const p = closestPointOnArc(P(10, 10), arc)
    expect(p.x).toBeCloseTo(5 / Math.SQRT2, 9)
    expect(p.y).toBeCloseTo(5 / Math.SQRT2, 9)
    expect(closestPointOnArc(P(0, -10), arc)).toEqual(arc.start)
  })

  it("bends an arc through a new middle and keeps its ends", () => {
    const pts = [P(0, 0), P(1, 1), P(2, 0)]
    const bent = bendArc(pts, P(1, 2))
    expect(bent[0]).toEqual(pts[0])
    expect(bent[2]).toEqual(pts[2])
    expect(bent[1]).toEqual(P(1, 2))
    // The middle on the line is no arc: unchanged.
    expect(bendArc(pts, P(1, 0))).toEqual(pts)
    const m = arcMiddle(P(0, 0), P(4, 0), 1)
    expect(m.x).toBeCloseTo(2, 9)
    expect(Math.abs(m.y)).toBeCloseTo(1, 9)
  })

  it("an arc trace needs its three points", () => {
    expect(isArcTrace({ arc: true, points: [P(0, 0), P(1, 1), P(2, 0)] })).toBe(true)
    expect(isArcTrace({ arc: true, points: [P(0, 0), P(2, 0)] })).toBe(false)
    expect(isArcTrace({ points: [P(0, 0), P(1, 1), P(2, 0)] })).toBe(false)
  })
})
