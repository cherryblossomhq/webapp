import { describe, expect, it } from "vitest"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { copperLayers } from "../src/model/stack"
import { createProject } from "../src/model/ops"

const doc = () => JSON.parse(serializeProject(createProject("t")))

describe("a project file with a hostile stack", () => {
  it("a thousand copper layers is not a stack", () => {
    const d = doc()
    d.project.board.stack = { copper: Array.from({ length: 1000 }, () => ({})) }
    const p = parseProjectFile(d, { id: "x" })
    expect(copperLayers(p.board).length).toBeLessThanOrEqual(32)
  })

  it("text, numbers and null where a stack should be leave a two-layer board", () => {
    for (const bad of ["x", 7, null, [], { copper: "no" }, { copper: null }, { copper: [null, 3, "a"] }]) {
      const d = doc()
      d.project.board.stack = bad
      const p = parseProjectFile(d, { id: "x" })
      expect(copperLayers(p.board).length).toBeGreaterThanOrEqual(2)
      expect(() => serializeProject(p)).not.toThrow()
    }
  })

  it("vias and traces on layers the board lacks, a via from a layer to itself and an arc of many points are repaired, not kept", () => {
    const d = doc()
    d.project.vias = [
      { id: "a", x: 0, y: 0, diameter: 0.6, drill: 0.3, kind: "blind", from: "in9", to: "top" },
      { id: "b", x: 1, y: 0, diameter: 0.6, drill: 0.3, kind: "micro", from: "top", to: "top" },
    ]
    d.project.traces = [{ id: "t", layer: "in7", width: 0.2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, { id: "u", layer: "top", width: 0.2, arc: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] }]
    const p = parseProjectFile(d, { id: "x" })
    const ids = copperLayers(p.board) as string[]
    for (const v of p.vias) {
      if (v.kind) expect(ids.includes(v.from!) && ids.includes(v.to!) && v.from !== v.to).toBe(true)
    }
    for (const t of p.traces) expect(ids).toContain(t.layer)
    for (const t of p.traces) if (t.arc) expect(t.points.length).toBe(3)
  })
})
