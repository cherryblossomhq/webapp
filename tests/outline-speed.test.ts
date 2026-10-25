import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { boardObstacles } from "../src/model/autoplace"
import { outlineGeometry } from "../src/model/outline"
import { circlePath, setOutlinePaths } from "../src/model/outlineOps"
import { analyzePcb } from "../src/model/pcb"
import type { Project, Vec2 } from "../src/model/types"
import { synthetic } from "./synthetic"

// A crowded board (462 parts, 2,900 pads) with an outline of its own (a 200-corner polygon, cutouts and arcs) is checked in a time of the same order
// as the same board with the rectangle: the edge index, not a scan of every edge for every item.

function placed(): Project {
  let p = synthetic(77)
  const parts = p.components.filter((c) => c.footprint)
  p = { ...p, components: p.components.map((c) => (c.footprint ? { ...c, pcb: { ...c.pcb, x: -110 + (parts.indexOf(c) % 24) * 9.2, y: -110 + Math.floor(parts.indexOf(c) / 24) * 9.2, placed: true } } : c)) }
  return p
}

const ring = (n: number, r: number, cx: number, cy: number): Vec2[] => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * 2 * Math.PI), y: cy + r * Math.sin((i / n) * 2 * Math.PI) }))

describe("a crowded board with an outline of its own", () => {
  it("is checked about as fast as the rectangle, and its geometry is built once", () => {
    const rect = placed()
    const pts = ring(200, 150, 0, 0)
    const loop = { closed: true, segs: pts.map((a, i) => ({ kind: "line" as const, a, b: pts[(i + 1) % pts.length] })) }
    const shaped = setOutlinePaths(rect, [loop, circlePath({ x: 20, y: 20 }, 30), circlePath({ x: -60, y: 40 }, 12)])
    const time = (p: Project) => {
      const t = performance.now()
      const res = analyzePcb(p, computeConnectivity(p))
      return { ms: performance.now() - t, res }
    }
    time(rect)
    const a = time(rect)
    const b = time(shaped)
    // the same copper on a board that is not the rectangle: the edge checks cost a lookup of the nearest edges per item
    expect(b.ms).toBeLessThan(Math.max(4 * a.ms, 4000))
    expect(b.res.items.length).toBe(a.res.items.length)
    const t = performance.now()
    outlineGeometry(shaped.board)
    boardObstacles(shaped)
    expect(performance.now() - t).toBeLessThan(2000)
    console.log(`2,900-pad board: rectangle ${a.ms.toFixed(0)} ms, outline of 200 corners and two cutouts ${b.ms.toFixed(0)} ms`)
  }, 60000)
})
