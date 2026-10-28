import { describe, expect, it, vi } from "vitest"
import { excellonDrill, drillSets } from "../src/export/excellon"
import { writeKicadBoard } from "../src/export/kicadBoard"
import { addTrace } from "../src/model/ops"
import { importKicadBoard } from "../src/model/kicad/board"
import { setCopperLayerCount } from "../src/model/layerOps"
import { createProject } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { registerProjectFootprints } from "../src/model/footprints"
import { pcbShapes } from "../src/model/instances"
import { worldShapes } from "../src/model/shapeItems"
import { clampLayer, copperLayers, layerOfKicadName } from "../src/model/stack"
import { componentTexts, worldTexts } from "../src/model/texts"
import type { Project } from "../src/model/types"
import { checkLayers } from "./kicad-layers-check"
import { board, footprint, pad } from "./kicad-board-fixtures"

// A bottom-side part keeps its inner copper layers in its own frame, and the map between that frame and the board's depends on the layer count.

const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
const inner = '(fp_line (start -1 0) (end 1 0) (stroke (width 0.2) (type solid)) (layer "In1.Cu")) (fp_text user "hi" (at 0 2) (layer "In1.Cu") (effects (font (size 1 1) (thickness 0.15))))'
// a smd pad on the back with copper on the first inner layer, too
const innerPad = pad({ number: "1", at: "0 0", size: "1 1", layers: '"B.Cu" "In1.Cu" "B.Mask"' })
const make = (layers = L4): Project => {
  const r = importKicadBoard(board({ layers, nets: ['(net 0 "")'], body: [footprint({ ref: "J2", at: "10 5", layer: "B.Cu", pads: [innerPad], extra: inner })] }))
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}
const names = (p: Project) => [...worldShapes(p).filter((s) => s.owner !== "#board").map((s) => s.shape.layer), ...worldTexts(p).filter((t) => t.kind === "user").map((t) => t.layer)]

describe("a bottom part's drawings and texts on inner copper", () => {
  it("are on the layer the file gives them in the board, and the file writes them there again", () => {
    const p = make()
    expect(names(p).filter((n) => n.endsWith(".Cu"))).toEqual(["In1.Cu", "In1.Cu"])
    const text = writeKicadBoard(p).text
    expect(text.match(/\(layer "In1\.Cu"\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(text).not.toMatch(/\(fp_line[^]*?\(layer "In2\.Cu"\)/)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(names(again.project).filter((n) => n.endsWith(".Cu"))).toEqual(["In1.Cu", "In1.Cu"])
    // the part's own frame is the same both times
    const land = (q: Project) => pcbShapes(q.components[0], 4).map((s) => s.layer)
    expect(land(again.project)).toEqual(land(p))
  })

  it("are copper of inner layer 1 for the editor and the checks", () => {
    const p = make()
    const shape = worldShapes(p).find((s) => s.owner !== "#board" && s.shape.layer.endsWith(".Cu"))!
    expect(layerOfKicadName(shape.shape.layer)).toBe("in1")
    expect(componentTexts(p.components[0], 4).find((t) => t.kind === "user")!.layer).toBe("In1.Cu")
  })

  it("the layers oracle reads the same layers off the file", () => {
    const p = make()
    expect(checkLayers(writeKicadBoard(p).text, p).wrong).toEqual([])
  })

  it("stay on the physical layer when the board gets more or fewer layers", () => {
    // the editor's store registers the lands of each project it holds (projectStore.ts)
    const p6 = setCopperLayerCount(make(), 6).project
    registerProjectFootprints(p6)
    expect(names(p6).filter((n) => n.endsWith(".Cu"))).toEqual(["In1.Cu", "In1.Cu"])
    const text = writeKicadBoard(p6).text
    // the pad's copper is on In1.Cu in the file, as it was
    expect(text.match(/\(pad "?1"? smd[^\n]*\n(?:[^\n]*\n)*?\s*\(layers [^)]*"In1\.Cu"/)).not.toBeNull()
    const back = setCopperLayerCount(p6, 4).project
    registerProjectFootprints(back)
    expect(names(back).filter((n) => n.endsWith(".Cu"))).toEqual(["In1.Cu", "In1.Cu"])
    expect(writeKicadBoard(back).text).toBe(writeKicadBoard(make()).text.replace(/\(uuid [^)]*\)/g, (m) => m))
  })
})

describe("copper on a layer the board does not have", () => {
  it("the active layer is clamped to the board's", () => {
    const p = make()
    expect(clampLayer(p.board, "in1")).toBe("in1")
    expect(clampLayer(createProject("x").board, "in1")).toBe("top")
  })

  it("a trace on a layer the board lacks is refused when it is drawn", () => {
    const p = createProject("x")
    expect(addTrace(p, { layer: "in1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }).trace).toBeNull()
    expect(addTrace(p, { layer: "top", width: 0.2, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }).trace).not.toBeNull()
  })

  it("loading a project drops such a trace with a note, not silently", () => {
    const d = JSON.parse(serializeProject(createProject("t")))
    d.project.traces = [{ id: "t1", layer: "in1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }]
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const q = parseProjectFile(d, { id: "x" })
    expect(q.traces).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 1 trace"))
    warn.mockRestore()
  })
})

describe("a blind via from the front layer to the back layer", () => {
  it("is drilled with the through holes, with no drill file of its own", () => {
    const p = createProject("x")
    const v = { id: "v1", x: 1, y: 1, diameter: 0.8, drill: 0.4, kind: "blind" as const, from: "top" as const, to: "bottom" as const }
    const q = { ...p, vias: [v] }
    expect(drillSets(q).map((s) => s.suffix)).toEqual(["PTH"])
    expect(excellonDrill(q)).toContain("0.400")
    expect(copperLayers(q.board)).toEqual(["top", "bottom"])
  })
})
