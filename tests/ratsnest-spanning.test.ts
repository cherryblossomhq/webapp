import { describe, expect, it } from "vitest"
import { dist } from "../src/lib/geometry"
import { spanningLines } from "../src/model/pcb"
import type { Vec2 } from "../src/model/types"

/** The ratsnest's search as it was: every pair of points between the tree and each island left, for each island joined. */
function plainLines(groups: Vec2[][]): { a: Vec2; b: Vec2 }[] {
  const lines: { a: Vec2; b: Vec2 }[] = []
  const inTree = [0]
  const remaining = new Set(groups.map((_, i) => i).slice(1))
  while (remaining.size) {
    let best: { d: number; a: Vec2; b: Vec2; g: number } | null = null
    for (const ti of inTree) {
      for (const gi of remaining) {
        for (const a of groups[ti]) {
          for (const b of groups[gi]) {
            const d = dist(a, b)
            if (!best || d < best.d) best = { d, a, b, g: gi }
          }
        }
      }
    }
    if (!best) break
    lines.push({ a: best.a, b: best.b })
    inTree.push(best.g)
    remaining.delete(best.g)
  }
  return lines
}

function seeded(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
}

describe("a net's ratsnest", () => {
  it("draws the lines the search over every pair drew, ties included", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = seeded(seed)
      // Points on a small grid, so that equal distances are common; some islands have no point at all.
      const groups = Array.from({ length: 2 + Math.floor(rnd() * 25) }, () =>
        Array.from({ length: Math.floor(rnd() * 4) + (rnd() < 0.1 ? 0 : 1) }, () => ({ x: Math.floor(rnd() * 8), y: Math.floor(rnd() * 8) })),
      )
      expect(spanningLines(groups), `seed ${seed}`).toEqual(plainLines(groups))
    }
  })

  it("joins 3,000 islands of one net in seconds, where the search over every pair took hours", () => {
    // A ground net whose pours are not filled yet: every pad an island of its own.
    const groups = Array.from({ length: 3000 }, (_, i) => [{ x: (i % 60) * 1.27, y: Math.floor(i / 60) * 2.54 }, { x: (i % 60) * 1.27 + 0.5, y: Math.floor(i / 60) * 2.54 }])
    const t = performance.now()
    const lines = spanningLines(groups)
    // About 1 s alone and 2 s beside the rest of the suite; the cube-time search never finished.
    expect(performance.now() - t).toBeLessThan(10_000)
    expect(lines).toHaveLength(2999)
  })
})
