import { Clipper, PointInPolygonResult } from "@countertype/clipper2-ts"
import { describe, expect, it } from "vitest"
import { fillTester } from "../src/model/pour"
import type { Vec2 } from "../src/model/types"

// `fillTester` holds a ring of many corners with its edges in bands (the point-in-fill tests of a big pour's connectivity were most of an
// analysis), and has to answer as `Clipper.pointInPolygon` does everywhere, the boundary included.

const S = 1000
const pt = (v: Vec2) => ({ x: Math.round(v.x * S), y: Math.round(v.y * S) })

/** A wobbly circle of many corners, an exact grid of micrometres. */
function ring(cx: number, cy: number, r: number, n: number, wobble: number): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    const rr = r + wobble * ((i * 7919) % 13) / 13
    return { x: Math.round((cx + Math.cos(a) * rr) * S) / S, y: Math.round((cy + Math.sin(a) * rr) * S) / S }
  })
}

/** What the fill's own tests said before the bands: the outline, then the holes. */
function reference(polygon: Vec2[][], p: Vec2): boolean {
  const q = pt(p)
  const rings = polygon.map((r) => r.map(pt))
  if (Clipper.pointInPolygon(q, rings[0]) === PointInPolygonResult.IsOutside) return false
  for (let i = 1; i < rings.length; i++) if (Clipper.pointInPolygon(q, rings[i]) === PointInPolygonResult.IsInside) return false
  return true
}

describe("fillTester", () => {
  const polygon = [ring(0, 0, 50, 400, 3), ring(10, 5, 8, 120, 1), ring(-20, -10, 6, 60, 0.5), ring(30, 20, 5, 40, 0)]
  const inside = fillTester(polygon)

  it("agrees with Clipper on a grid of points, a pour's corners, and the middles of its edges", () => {
    const points: Vec2[] = []
    for (let x = -60; x <= 60; x += 1.37) for (let y = -60; y <= 60; y += 1.41) points.push({ x, y })
    for (const r of polygon) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i]
        const b = r[(i + 1) % r.length]
        points.push(a, { x: Math.round(((a.x + b.x) / 2) * S) / S, y: Math.round(((a.y + b.y) / 2) * S) / S })
        // On the ray of an edge's end, which a banded count must not count twice.
        points.push({ x: a.x - 3, y: a.y }, { x: a.x + 3, y: a.y })
      }
    }
    const wrong = points.filter((p) => inside(p) !== reference(polygon, p))
    expect(wrong).toEqual([])
    expect(points.length).toBeGreaterThan(5000)
    expect(points.some((p) => inside(p))).toBe(true)
    expect(points.some((p) => !inside(p))).toBe(true)
  })

  it("agrees on rings of few corners, which it leaves to Clipper, and on a square's edge", () => {
    const square: Vec2[][] = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }]]
    const t = fillTester(square)
    for (const p of [{ x: 0, y: 5 }, { x: 10, y: 10 }, { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 11, y: 5 }, { x: 2, y: 2 }]) expect(t(p)).toBe(reference(square, p))
  })
})
