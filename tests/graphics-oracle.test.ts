import { describe, expect, it } from "vitest"
import { circleThrough, lineDistance, lineWithin } from "./kicad-census/graphics.mjs"

// The oracle's own comparison, so the corpus test's "0.001 mm" cannot pass by being loose.
describe("the drawing comparison of the corpus oracle", () => {
  const ring = (r: number, n: number, dx = 0) => Array.from({ length: n + 1 }, (_, i) => [dx + r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)])
  it("accepts the same outline sampled differently and refuses one 2 micrometres off", () => {
    const a = ring(10, 5000)
    expect(lineWithin(a, ring(10, 7000), 0.001)).toBe(true)
    expect(lineWithin(a, ring(10.002, 5000), 0.001)).toBe(false)
    expect(lineWithin(a, ring(10, 5000, 0.0015), 0.001)).toBe(false)
    expect(lineWithin(a, ring(10, 5000, 0.0005), 0.001)).toBe(true)
  })
  it("agrees with the exact Hausdorff distance", () => {
    const a = [[0, 0], [10, 0], [10, 10]]
    const b = [[0, 0.0007], [10, 0.0007], [10.0007, 10]]
    expect(lineDistance(a, b)).toBeCloseTo(0.0007, 6)
    expect(lineWithin(a, b, 0.001)).toBe(true)
    expect(lineWithin(a, b, 0.0005)).toBe(false)
  })
  it("is fast on a polyline of a hundred thousand points", () => {
    const a = ring(50, 100000)
    const t = performance.now()
    expect(lineWithin(a, ring(50, 100000), 0.001)).toBe(true)
    expect(performance.now() - t).toBeLessThan(5000)
  })
  it("finds the circle through three points", () => {
    const c = circleThrough([1, 0], [0, 1], [-1, 0])!
    expect(c.r).toBeCloseTo(1, 12)
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeNull()
  })
})
