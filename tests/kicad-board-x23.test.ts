import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { bomCsv } from "../src/export/bom"
import { kicadFiles } from "../src/export/kicad"
import { pnpCsv } from "../src/export/pnp"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { partPointWorld, worldPoints } from "../src/model/pcbPoints"
import { parseProjectFile, PROJECT_FILE_VERSION, serializeProject } from "../src/model/projectFile"
import { resolvedComponents } from "../src/model/ruleAreas"
import type { Project } from "../src/model/types"
import { updateComponent } from "../src/model/ops"
import { joinOverrides, removeVariant, renameVariant, setActiveVariant } from "../src/model/variants"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { BY_DESIGN, diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X23: board variants (KiCad 10), a footprint's units and PCB points. The importer reads them, the project holds them (a part's variants on the part, as a schematic symbol's, so the one
// resolver, the BOM, the position file and the exports follow the variant shown), the project file stores them, and a KiCad 9 file, which cannot say them, is written as the variant shown makes it.

const ORIGIN = { id: "p1", createdAt: 1, updatedAt: 1 }
const VARIANTS = '(variants (variant (name "Lite") (description "No sensor")) (variant (name "Full")))'
const two = [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })]
const parts = (extra: Record<string, string> = {}) => [
  footprint({ ref: "R1", value: "10k", at: "5 5", pads: two, extra: extra.R1 }),
  footprint({ ref: "R2", value: "22k", at: "10 5", pads: two, extra: extra.R2 }),
  footprint({ ref: "R3", value: "33k", at: "15 5", pads: two, extra: extra.R3 }),
]
const VARIANT_PARTS = parts({
  R1: '(attr smd) (variant (name "Lite") (dnp yes))',
  R2: '(attr smd dnp) (variant (name "Lite") (dnp no) (exclude_from_pos_files yes)) (variant (name "Full") (field (name "Value") (value "0R")) (field (name "LCSC") (value "C1")))',
  R3: '(attr smd) (variant (name "Lite") (exclude_from_bom yes) (exclude_from_sim yes))',
})

const imported = (text: string): Project => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}
const variantBoard = () => imported(board({ version: 20260206, body: [VARIANTS, ...VARIANT_PARTS] }))
const column = (csv: string) => csv.trimEnd().split("\n").slice(1).map((l) => l.split(",")[0].replace(/"/g, ""))
const part = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!
const boardText = (files: Record<string, string>) => Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

describe("X23: the extension", () => {
  it("is built, and a board that uses variants, units and points imports", () => {
    expect(BUILT_EXTENSIONS.has("X23")).toBe(true)
    expect(importKicadBoard(board({ version: 20260206, body: [VARIANTS, ...VARIANT_PARTS] })).status).toBe("imported")
  })

  it("custom properties (KiCad 11 development) are not built and are named, not dropped", () => {
    expect(BUILT_EXTENSIONS.has("X23X")).toBe(false)
    const r = importKicadBoard(board({ version: 20260206, body: [footprint({ pads: two, extra: '(custom_property (name "a") (value "b"))' })] }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.needs.map((n) => n.ext)).toEqual(["X23X"])
  })
})

describe("X23: reading variants", () => {
  it("lists the board's variants with their descriptions, and what each changes on a footprint", () => {
    const p = variantBoard()
    expect(p.variants).toEqual({ list: [{ name: "Lite", description: "No sensor" }, { name: "Full" }] })
    expect(part(p, "R1").variants).toEqual({ Lite: { dnp: true } })
    // a variant says `no` for what the footprint sets: a clear, not an absence
    expect(part(p, "R2").variants).toEqual({ Lite: { dnp: false, excludeFromPos: true }, Full: { fields: { Value: "0R", LCSC: "C1" } } })
    expect(part(p, "R3").variants).toEqual({ Lite: { excludeFromBom: true, excludeFromSim: true } })
    expect(p.components.every((c) => !c.flags?.excludeFromBom)).toBe(true)
  })

  it("no variant is shown after an import, and the parts are as the footprints say", () => {
    const p = variantBoard()
    expect(p.variants?.active).toBeUndefined()
    expect(resolvedComponents(p).map((c) => !!c.flags?.dnp)).toEqual([false, true, false])
  })

  it("a name only a footprint mentions is still a variant of the project", () => {
    const p = imported(board({ version: 20260206, body: parts({ R1: '(variant (name "Solo") (dnp yes))' }) }))
    expect(p.variants?.list).toEqual([{ name: "Solo" }])
  })

  it("a variant that says nothing, and a board with none, leave the project as it was", () => {
    const p = imported(board({ version: 20260206, body: [footprint({ pads: two, extra: '(variant (name "Empty"))' })] }))
    expect(p.components[0].variants).toBeUndefined()
    expect(imported(board({ version: 20260206, body: parts() })).variants).toBeUndefined()
  })
})

describe("X23: a footprint's variants joined with its symbol's", () => {
  it("are joined variant by variant, flag by flag and field by field, the symbol's word standing", () => {
    const joined = joinOverrides({ A: { dnp: true, excludeFromBom: false, fields: { Value: "1k", LCSC: "C1" } }, B: { dnp: true } }, { A: { excludeFromBom: true, fields: { Value: "2k" } }, C: { excludeFromPos: true } })
    expect(joined).toEqual({ A: { dnp: true, excludeFromBom: true, fields: { Value: "2k", LCSC: "C1" } }, B: { dnp: true }, C: { excludeFromPos: true } })
    expect(joinOverrides(undefined, { A: { dnp: true } })).toEqual({ A: { dnp: true } })
    expect(joinOverrides({ A: { dnp: true } }, undefined)).toEqual({ A: { dnp: true } })
  })
})

describe("X23: the variant shown", () => {
  it("decides the flags, the BOM and the position file, and the value a variant sets", () => {
    const p = variantBoard()
    // R2 is not populated as the footprint says; the BOM leaves it out
    expect(column(bomCsv(p))).toEqual(["R1", "R3"])
    expect(column(pnpCsv(p))).toEqual(["R1", "R3"])
    const lite = setActiveVariant(p, "Lite")
    // R1 is not populated, R2 is (the variant clears its own), R3 is out of the BOM; R2 is out of the position file
    expect(resolvedComponents(lite).map((c) => !!c.flags?.dnp)).toEqual([true, false, false])
    expect(column(bomCsv(lite))).toEqual(["R2"])
    expect(column(pnpCsv(lite))).toEqual(["R3"])
    const full = setActiveVariant(p, "Full")
    expect(resolvedComponents(full)[1].props.value).toBe("0R")
  })

  it("is written to a KiCad 9 file as the variant makes the footprints, with a note that the variants stay in the project", async () => {
    const lite = setActiveVariant(variantBoard(), "Lite")
    const { files, notes } = await kicadFiles(lite)
    const text = boardText(files)
    expect(unknownNodes(text)).toEqual([])
    expect(text).not.toMatch(/\(variants?\b/)
    const again = imported(text)
    expect(again.components.map((c) => !!c.flags?.dnp)).toEqual([true, false, false])
    expect(notes.join("\n")).toMatch(/A footprint's variants are KiCad 10's/)
  })

  it("renaming and removing a variant follow the parts, as for a schematic's", () => {
    const p = variantBoard()
    expect(Object.keys(part(renameVariant(p, "Lite", "Slim")!, "R1").variants!)).toEqual(["Slim"])
    const gone = removeVariant(p, "Lite")
    expect(gone.variants?.list.map((v) => v.name)).toEqual(["Full"])
    expect(part(gone, "R1").variants).toBeUndefined()
    expect(part(gone, "R2").variants).toEqual({ Full: { fields: { Value: "0R", LCSC: "C1" } } })
  })
})

describe("X23: footprint units and PCB points", () => {
  const withUnits = parts({ R1: '(units (unit (name "A") (pins "1")) (unit (name "B") (pins "2" "3")))' })

  it("reads a footprint's units as the file lists them", () => {
    const p = imported(board({ version: 20260206, body: withUnits }))
    expect(part(p, "R1").units).toEqual([{ name: "A", pins: ["1"] }, { name: "B", pins: ["2", "3"] }])
    expect(part(p, "R2").units).toBeUndefined()
  })

  it("a point of a footprint is in the footprint's own frame: an older file's, in the board's, is brought into it", () => {
    const point = (at: string) => `(point (at ${at}) (size 1.27) (layer "F.Fab") (uuid "00000000-0000-0000-0000-000000000001"))`
    const turned = (version: number, at: string) => imported(board({ version, body: [footprint({ ref: "R1", at: "10 5 90", pads: two, extra: point(at) })] }))
    const old = part(turned(20260206, "11 6"), "R1")
    expect(old.points).toEqual([{ x: -1, y: -1, size: 1.27, layer: "F.Fab" }])
    // from stamp 20260616 the file says it in the footprint's frame already
    expect(part(turned(20260616, "-1 1"), "R1").points).toEqual(old.points)
    // where the point is on the board (y up): the file's (11, 6)
    const w = partPointWorld(old, old.points![0], 2)
    expect([w.x, w.y].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([11, -6])
  })

  it("a part on the bottom keeps its points as for the top, and they land where the file has them, on the layer the file names", () => {
    const point = '(point (at 1 2) (size 1) (layer "B.Fab"))'
    const p = imported(board({ version: 20260616, body: [footprint({ ref: "R1", layer: "B.Cu", at: "10 5", pads: two, extra: point })] }))
    const c = part(p, "R1")
    expect(c.pcb.side).toBe("bottom")
    expect(c.points).toEqual([{ x: 1, y: 2, size: 1, layer: "F.Fab" }])
    const at = worldPoints(p, [c])[0]
    expect([at.x, at.y, at.layer]).toEqual([11, -7, "B.Fab"])
  })

  it("flipping a part moves its points with it and takes them to the other side's layer", () => {
    const point = '(point (at 1 2) (size 1) (layer "B.Fab"))'
    const p = imported(board({ version: 20260616, body: [footprint({ ref: "R1", layer: "B.Cu", at: "10 5", pads: two, extra: point })] }))
    const c = part(p, "R1")
    const top = updateComponent(p, c.id, { pcb: { side: "top", rot: 0 } }).components[0]
    expect(top.points).toEqual(c.points)
    const at = worldPoints(p, [top])[0]
    expect([at.x, at.y, at.layer]).toEqual([11, -3, "F.Fab"])
  })

  it("the board's own points are in the board's frame, and the part's follow the part", () => {
    const p = imported(board({ version: 20260206, body: [footprint({ ref: "R1", at: "5 5", pads: two, extra: '(point (at 6 5) (size 1) (layer "F.Cu"))' }), '(point (at 3 4) (size 0.5) (layer "Cmts.User"))'] }))
    expect(p.points).toEqual([{ x: 3, y: -4, size: 0.5, layer: "Cmts.User" }])
    const all = worldPoints(p, p.components)
    expect(all.map((q) => [q.x, q.y, q.layer])).toEqual([[3, -4, "Cmts.User"], [6, -5, "F.Cu"]])
    const moved = worldPoints(p, [{ ...p.components[0], pcb: { ...p.components[0].pcb, x: p.components[0].pcb.x + 2 } }])
    expect(moved[1].x).toBe(8)
  })

  it("a KiCad 9 file cannot hold them: they stay in the project, with a note", async () => {
    const p = imported(board({ version: 20260206, body: [...withUnits, '(point (at 3 4) (size 0.5) (layer "Cmts.User"))'] }))
    const { files, notes } = await kicadFiles(p)
    const text = boardText(files)
    expect(text).not.toMatch(/\((units|point)\b/)
    expect(unknownNodes(text)).toEqual([])
    expect(notes.join("\n")).toMatch(/footprint's units are KiCad 10's/)
    expect(notes.join("\n")).toMatch(/PCB points are KiCad 10's/)
    // what differs is what the file cannot say, and nothing else
    const differences = diffProjects(p, imported(text))
    expect(differences.map((d) => d.kind)).toEqual(["project.points", "project.components[].units"])
    expect(differences.filter((d) => !BY_DESIGN.some((re) => re.test(d.kind)))).toEqual([])
  })
})

describe("X23: saving and loading", () => {
  const full = () => {
    const extra = '(attr smd) (variant (name "Lite") (dnp yes)) (units (unit (name "A") (pins "1" "2"))) (point (at 6 5) (size 1) (layer "F.Fab"))'
    const p = imported(board({ version: 20260206, body: [VARIANTS, ...parts({ R1: extra }), '(point (at 3 4) (size 0.5) (layer "Cmts.User"))'] }))
    return setActiveVariant(p, "Lite")
  }

  it("keeps the variants, the shown one, the units and the points, in a file that is still version 3", () => {
    const p = full()
    const text = serializeProject(p)
    expect(JSON.parse(text).version).toBe(PROJECT_FILE_VERSION)
    expect(PROJECT_FILE_VERSION).toBe(3)
    const back = parseProjectFile(text, ORIGIN)
    expect(back.variants).toEqual({ list: [{ name: "Lite", description: "No sensor" }, { name: "Full" }], active: "Lite" })
    expect(part(back, "R1").variants).toEqual({ Lite: { dnp: true } })
    expect(part(back, "R1").units).toEqual([{ name: "A", pins: ["1", "2"] }])
    // a unit is stored as a list of its name and its pad numbers in one string
    expect(text).toContain('"units":[["A","1 2"]]')
    expect(part(back, "R1").points).toEqual(part(p, "R1").points)
    expect(back.points).toEqual(p.points)
    expect(diffProjects(p, back)).toEqual([])
  })

  it("a project with none of it is stored with none of it", () => {
    const text = serializeProject(imported(board({ version: 20260206, body: parts() })))
    expect(text).not.toMatch(/"(variants|units|points)"/)
    const back = parseProjectFile(text, ORIGIN)
    expect(back.variants).toBeUndefined()
    expect(back.points).toBeUndefined()
    expect(back.components.every((c) => c.units === undefined && c.points === undefined)).toBe(true)
  })

  it("a unit whose pad number has a space in it keeps its numbers as a list", () => {
    const p = imported(board({ version: 20260206, body: parts({ R1: '(units (unit (name "A") (pins "1 2" "3")))' }) }))
    const text = serializeProject(p)
    expect(text).toContain('["A",["1 2","3"]]')
    expect(part(parseProjectFile(text, ORIGIN), "R1").units).toEqual([{ name: "A", pins: ["1 2", "3"] }])
  })

  it("drops what is not a unit or a point when it reads a file", () => {
    const stored = JSON.parse(serializeProject(full()))
    stored.project.components[0].units = [{ name: "A", pins: ["1", 2] }, { pins: ["3"] }, "x"]
    stored.project.components[0].points = [{ x: 1, y: 2, size: 1, layer: "F.Fab" }, { x: "1", y: 2, size: 1, layer: "F.Fab" }, { x: 1, y: 2, size: -1, layer: "F.Fab" }]
    stored.project.points = [{ x: 1, y: 2 }]
    const back = parseProjectFile(JSON.stringify(stored), ORIGIN)
    expect(back.components[0].units).toEqual([{ name: "A", pins: ["1"] }])
    expect(back.components[0].points).toEqual([{ x: 1, y: 2, size: 1, layer: "F.Fab" }])
    expect(back.points).toBeUndefined()
  })
})

describe("X23: Sakura reads the variants", () => {
  it("get_design lists the variant shown and what each changes on which parts, and says nothing for a project with none", () => {
    const read = (p: Project) => JSON.parse(runTool(p, "get_design", {}).result)
    const design = read(setActiveVariant(variantBoard(), "Lite"))
    expect(design.variants.shown).toBe("Lite")
    expect(design.variants.list[0]).toEqual({
      name: "Lite",
      description: "No sensor",
      parts: [
        { ref: "R1", changes: ["do not populate"] },
        { ref: "R2", changes: ["populate", "not in the position file"] },
        { ref: "R3", changes: ["not in the BOM", "left out of simulation"] },
      ],
    })
    expect(design.variants.list[1].parts).toEqual([{ ref: "R2", changes: ["Value = 0R", "LCSC = C1"] }])
    // the parts above are as the variant shown makes them
    expect(design.components.find((c: { ref: string }) => c.ref === "R1").flags).toContain("do not populate")
    expect(read(imported(board({ version: 20260206, body: parts() }))).variants).toBeUndefined()
  })
})
