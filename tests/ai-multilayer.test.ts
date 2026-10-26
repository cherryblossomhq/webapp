import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { pcbSvg } from "../src/ai/vision/pcbSvg"
import { measurePcb } from "../src/ai/vision/measure"
import { createProject } from "../src/model/ops"
import { copperColor } from "../src/editor/theme"
import { copperLayers } from "../src/model/stack"

describe("Sakura on multilayer boards", () => {
  it("reports no layer fields for a plain two-layer board", () => {
    const out = JSON.parse(runTool(createProject("t"), "get_design", {}).result)
    expect(out.board_mm.copper_layers).toBeUndefined()
    expect(out.board_mm.via_kinds).toBeUndefined()
  })

  it("set_board changes the layer count and get_design lists the layers", () => {
    let p = createProject("t")
    expect(runTool(p, "set_board", { copper_layers: 3 }).isError).toBe(true)
    const out = runTool(p, "set_board", { copper_layers: 4 })
    expect(out.isError).toBe(false)
    p = out.project
    expect(copperLayers(p.board)).toEqual(["top", "in1", "in2", "bottom"])
    expect(JSON.parse(runTool(p, "get_design", {}).result).board_mm.copper_layers).toEqual(["top", "in1", "in2", "bottom"])
  })

  it("set_pour takes an inner layer id and refuses one the board lacks", () => {
    const p = runTool(createProject("t"), "set_board", { copper_layers: 4 }).project
    expect(runTool(p, "set_pour", { net: "GND", layer: "in5" }).isError).toBe(true)
    expect(runTool(p, "set_pour", { net: "GND", layer: "in1" }).result).not.toContain("layer must be")
  })

  it("the look render draws inner layers", () => {
    const p = runTool(createProject("t"), "set_board", { copper_layers: 4 }).project
    const svg = pcbSvg(p, { minX: -20, minY: -20, maxX: 20, maxY: 20 } as never, { width: 400, height: 400 }, { side: "both", extras: new Set() }, measurePcb(p))
    expect(svg).toContain("<svg")
    const traced = { ...p, traces: [{ id: "t1", net: "N", layer: "in1" as const, width: 0.2, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }] }
    expect(pcbSvg(traced as never, { minX: -20, minY: -20, maxX: 20, maxY: 20 } as never, { width: 400, height: 400 }, { side: "both", extras: new Set() }, measurePcb(traced as never))).toContain(copperColor("in1"))
  })
})
