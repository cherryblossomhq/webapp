import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { COPPER_LIST_CAP, drawingsReport } from "../src/ai/shapeReport"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { addComponent, createProject } from "../src/model/ops"
import type { BoardGraphic, BoardShape, CustomPartSpec, FootprintDef, Project } from "../src/model/types"

const line = (layer: string, extra: Partial<BoardShape> = {}) => ({ type: "line", a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, layer, width: 0.2, ...extra }) as BoardShape
const graphic = (id: string, shape: BoardShape) => ({ ...shape, id }) as BoardGraphic

const logoLand: FootprintDef = {
  name: "LOGO_LAND",
  pads: [],
  silk: [],
  courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
  shapes: [line("F.SilkS"), line("F.Cu", { net: "GND" })],
}
const logoSpec: CustomPartSpec = { id: "logo-part", name: "Logo", description: "A logo", category: "Passives", refPrefix: "LOGO", footprint: "LOGO_LAND", pins: [], props: {} }

function withLogo(extra: Partial<Project> = {}): Project {
  const p: Project = { ...createProject("t"), parts: [logoSpec], footprints: [logoLand], ...extra }
  registerProjectParts(p)
  return addComponent(p, "logo-part", { footprint: "LOGO_LAND", pcb: { x: 10, y: 5, rot: 0, side: "top", placed: true } }).project
}

const design = (p: Project) => JSON.parse(runTool(p, "get_design", {}).result)

describe("get_design and drawings", () => {
  it("says nothing about drawings when there are none", () => {
    for (const e of EXAMPLES) {
      expect(drawingsReport(e.project)).toBeNull()
      expect(runTool(e.project, "get_design", {}).result).not.toContain("drawings")
    }
  })

  it("reads a part with no pins and reports counts per layer, copper in full, and the pinless parts", () => {
    const p = withLogo({ graphics: [graphic("g1", line("F.Fab")), graphic("g2", line("B.Cu", { net: "VCC", width: 0.3 }))] })
    const out = runTool(p, "get_design", {})
    expect(out.isError).toBe(false)
    const d = JSON.parse(out.result)
    const logo = d.components.find((c: { part: string }) => c.part === "logo-part")
    expect(logo.pins).toEqual([])
    expect(d.drawings.board_by_layer).toEqual({ "F.Fab": 1, "B.Cu": 1 })
    expect(d.drawings.part_by_layer).toEqual({ "F.SilkS": 1, "F.Cu": 1 })
    expect(d.drawings.parts_without_pins).toBe(1)
    expect(d.drawings.copper).toEqual([
      { type: "line", layer: "B.Cu", width: 0.3, net: "VCC", owner: "board", box_mm: [0, 0, 2, 0] },
      { type: "line", layer: "F.Cu", width: 0.2, net: "GND", owner: logo.ref, box_mm: [10, 5, 12, 5] },
    ])
    expect(d.drawings).not.toHaveProperty("copper_more")
  })

  it("caps the copper list and says how many more", () => {
    const graphics = Array.from({ length: COPPER_LIST_CAP + 3 }, (_, i) => graphic(`g${i}`, line("F.Cu")))
    const d = design({ ...createProject("t"), graphics }).drawings
    expect(d.copper).toHaveLength(COPPER_LIST_CAP)
    expect(d.copper_more).toBe("and 3 more copper drawings")
  })

  it("other tools survive a part with no pins", () => {
    const p = withLogo()
    const ref = p.components[0].ref
    expect(runTool(p, "run_checks", {}).isError).toBe(false)
    const connect = runTool(p, "connect", { pins: [`${ref}.1`, `${ref}.2`] })
    expect(connect.isError).toBe(true)
    expect(connect.result).toContain("no pins")
  })
})

describe("the other tools with a part with no pins", () => {
  it("layout_pcb and route_pcb run", () => {
    const p = withLogo()
    expect(runTool(p, "layout_pcb", {}).isError).toBe(false)
    expect(runTool(p, "route_pcb", {}).isError).toBeDefined()
  })
})
