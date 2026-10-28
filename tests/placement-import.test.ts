import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard } from "../src/model/kicad/board"
import { BUILT_EXTENSIONS } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { placementAreas, placementProblems } from "../src/model/placementAreas"
import { analyzePcb } from "../src/model/pcb"
import { computeConnectivity } from "../src/model/connectivity"
import { board, footprint, pad } from "./kicad-board-fixtures"

// X20: placement rule areas and component classes, from a KiCad board to the project, the stored file and back to a KiCad board.

const outline = (pts: string) => `(polygon (pts ${pts}))`
const rule = (name: string, placement: string, polygon: string, layers = '(layers "F.Cu" "B.Cu")') =>
  `(zone (net 0) (net_name "") ${layers} (uuid "a4b45835-7b94-49de-8b40-b19da997fcc${name.length}") (name "${name}") (hatch none 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) (filled_areas_thickness no) (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed)) ${placement} (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) ${polygon})`
const left = outline("(xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9)")
const right = outline("(xy 11 1) (xy 19 1) (xy 19 9) (xy 11 9)")

const part = (ref: string, at: string, extra = "") => footprint({ ref, at, pads: [pad({ at: "0 0", size: "1 1" })], extra })

const imported = (body: string[], version = 20241229) => {
  const r = importKicadBoard(board({ version, body }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r
}

describe("the gate", () => {
  it("builds X20, so a board with an area or a class is imported, and the rule still finds them when X20 is not built", () => {
    expect(BUILT_EXTENSIONS.has("X20")).toBe(true)
    const text = board({ body: [part("R1", "5 5", '(component_classes (class "Power"))'), rule("a", '(placement (enabled yes) (component_class "Power"))', left)] })
    expect(importKicadBoard(text).status).toBe("imported")
    const without = importKicadBoard(text, { built: new Set([...BUILT_EXTENSIONS].filter((x) => x !== "X20")) })
    expect(without.status).toBe("refused")
    expect(without.status === "refused" && without.needs.map((n) => n.ext)).toEqual(["X20"])
    // an ordinary keepout (the placement KiCad 9 writes on it is off and names nothing) never needs it
    const keepout = board({ body: [part("R1", "5 5"), rule("k", '(placement (enabled no) (sheetname ""))', left)] })
    expect(importKicadBoard(keepout, { built: new Set([...BUILT_EXTENSIONS].filter((x) => x !== "X20")) }).status).toBe("imported")
  })
})

describe("importing placement areas", () => {
  it("brings in an area for a sheet, one for a class and one for a group, with their target, layer and outline", () => {
    const r = imported([
      rule("sheet area", '(placement (enabled yes) (sheetname "/Power/"))', left),
      rule("class area", '(placement (enabled yes) (component_class "Analog"))', right, '(layer "B.Cu")'),
      rule("group area", '(placement (enabled yes) (group "Front end"))', outline("(xy 1 11) (xy 9 11) (xy 9 15) (xy 1 15)")),
    ])
    const [a, b, c] = r.project.zones
    expect(a.placement).toEqual({ by: "sheet", name: "/Power/" })
    expect(b.placement).toEqual({ by: "class", name: "Analog" })
    expect(b.layer).toBe("bottom")
    expect(c.placement).toEqual({ by: "group", name: "Front end" })
    expect(a.keepout).toEqual({})
    expect(a.layers).toEqual(["top", "bottom"])
    expect(a.name).toBe("sheet area")
    expect(placementAreas(r.project)).toHaveLength(3)
  })

  it("keeps a switched off area's target, and holds nothing for the default KiCad writes on every keepout", () => {
    const r = imported([rule("off", '(placement (enabled no) (sheetname "/"))', left), rule("plain", '(placement (enabled no) (sheetname ""))', right), rule("bare", "", outline("(xy 1 11) (xy 9 11) (xy 9 15) (xy 1 15)"))])
    expect(r.project.zones[0].placement).toEqual({ by: "sheet", name: "/", off: true })
    expect(r.project.zones[1].placement).toBeUndefined()
    expect(r.project.zones[2].placement).toBeUndefined()
    expect(placementAreas(r.project)).toHaveLength(0)
  })

  it("keeps the keepout flags of an area that also keeps things out", () => {
    const text = rule("both", '(placement (enabled yes) (sheetname "/A/"))', left).replace("(tracks allowed)", "(tracks not_allowed)")
    const z = imported([text]).project.zones[0]
    expect(z.keepout).toEqual({ tracks: true })
    expect(z.placement).toEqual({ by: "sheet", name: "/A/" })
  })

  it("brings in the component classes of a part, and its sheet", () => {
    const r = imported([part("R1", "5 5", '(component_classes (class "Power") (class "Fast")) (sheetname "/Power/") (sheetfile "p.kicad_sch")'), part("R2", "15 5")])
    expect(r.project.components.find((c) => c.ref === "R1")).toMatchObject({ classes: ["Power", "Fast"], sheetPath: "/Power/" })
    expect(r.project.components.find((c) => c.ref === "R2")?.classes).toBeUndefined()
  })

  it("reports a part that sits outside the area that picks it, by part and area", () => {
    const r = imported([
      part("R1", "5 5", '(component_classes (class "Power"))'),
      part("R2", "15 5", '(component_classes (class "Power"))'),
      rule("power area", '(placement (enabled yes) (component_class "Power"))', left),
    ])
    const problems = placementProblems(r.project)
    expect(problems.map((p) => p.component.ref)).toEqual(["R2"])
    const checks = analyzePcb(r.project, computeConnectivity(r.project)).violations.filter((v) => v.kind === "placement-area")
    expect(checks).toHaveLength(1)
    expect(checks[0].message).toBe("R2 is outside placement area power area (the parts of class Power), where it has to sit")
  })
})

describe("the stored file", () => {
  it("saves and loads areas and classes exactly, in version 3", () => {
    const r = imported([
      part("R1", "5 5", '(component_classes (class "Power")) (sheetname "/Power/")'),
      rule("sheet area", '(placement (enabled yes) (sheetname "/Power/"))', left),
      rule("off", '(placement (enabled no) (component_class "X"))', right),
    ])
    const text = serializeProject(r.project)
    expect(JSON.parse(text).version).toBe(3)
    const back = parseProjectFile(text, { id: r.project.id })
    expect(back.zones.map((z) => z.placement)).toEqual(r.project.zones.map((z) => z.placement))
    expect(back.components.map((c) => [c.classes, c.sheetPath])).toEqual(r.project.components.map((c) => [c.classes, c.sheetPath]))
    expect(JSON.parse(serializeProject(back))).toEqual(JSON.parse(text))
  })

  it("reads a version 3 document, which has none of it", () => {
    const r = imported([part("R1", "5 5"), rule("plain", '(placement (enabled no) (sheetname ""))', left)])
    const doc = JSON.parse(serializeProject(r.project))
    doc.version = 3
    const back = parseProjectFile(doc, { id: "x" })
    expect(back.zones[0].placement).toBeUndefined()
    expect(back.zones[0].keepout).toEqual({})
    expect(back.components[0].classes).toBeUndefined()
  })

  it("drops damage: a target of an unknown kind, and a class that is not text", () => {
    const r = imported([part("R1", "5 5", '(component_classes (class "A"))'), rule("a", '(placement (enabled yes) (sheetname "/A/"))', left)])
    const doc = JSON.parse(serializeProject(r.project))
    doc.project.zones[0].placement = { by: "color", name: "red" }
    doc.project.components[0].classes = ["A", 3, "", "A", "B"]
    const back = parseProjectFile(doc, { id: "x" })
    expect(back.zones[0].placement).toBeUndefined()
    expect(back.components[0].classes).toEqual(["A", "B"])
  })
})

describe("writing a KiCad board", () => {
  const writtenBoard = async (body: string[]) => {
    const r = imported(body)
    const out = await kicadFiles(r.project)
    return { r, pcb: Object.entries(out.files).find(([k]) => k.endsWith(".kicad_pcb"))![1], notes: out.notes }
  }

  it("writes areas and classes back, and reads them back as the same", async () => {
    const { r, pcb } = await writtenBoard([
      part("R1", "5 5", '(component_classes (class "Power") (class "Fast")) (sheetname "/Power/")'),
      rule("sheet area", '(placement (enabled yes) (sheetname "/Power/"))', left),
      rule("class area", '(placement (enabled yes) (component_class "Fast"))', right),
      rule("off", '(placement (enabled no) (component_class "X"))', outline("(xy 1 11) (xy 9 11) (xy 9 15) (xy 1 15)")),
      rule("plain", '(placement (enabled no) (sheetname ""))', outline("(xy 11 11) (xy 19 11) (xy 19 15) (xy 11 15)")),
    ])
    expect(pcb).toMatch(/\(placement \(enabled yes\) \(sheetname "\/Power\/"\)\)/)
    expect(pcb).toMatch(/\(placement \(enabled yes\) \(component_class "Fast"\)\)/)
    expect(pcb).toMatch(/\(placement \(enabled no\) \(component_class "X"\)\)/)
    expect(pcb).toMatch(/\(placement \(enabled no\) \(sheetname ""\)\)/)
    expect(pcb).toMatch(/\(component_classes \(class "Power"\) \(class "Fast"\)\)/)
    expect(pcb).toMatch(/\(sheetname "\/Power\/"\)/)
    const again = importKicadBoard(pcb)
    if (again.status !== "imported") throw new Error(`the written board was refused: ${again.message}`)
    expect(again.project.zones.map((z) => z.placement)).toEqual(r.project.zones.map((z) => z.placement))
    expect(again.project.components[0]).toMatchObject({ classes: ["Power", "Fast"], sheetPath: "/Power/" })
  })

  it("writes a group area switched off, with a note: KiCad 9 has no group source", async () => {
    const { pcb, notes } = await writtenBoard([rule("g", '(placement (enabled yes) (group "G"))', left)])
    expect(pcb).toMatch(/\(placement \(enabled no\) \(sheetname ""\)\)/)
    expect(pcb).not.toMatch(/\(group "G"\)/)
    expect(notes.join("\n")).toMatch(/placement area for a group is KiCad 10's/)
  })
})
