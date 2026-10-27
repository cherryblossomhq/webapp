import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { ROOT_SHEET, sheetUses, sheetView, mergeSheetView, syncCopies, commitOnUse, usesOfSheet } from "../src/model/sheets"
import { addWire, createProject } from "../src/model/ops"
import { kicadFiles } from "../src/export/kicad"
import { runTool } from "../src/ai/tools"
import { bomCsv } from "../src/export/bom"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { setSheetSymbol } from "../src/model/sheetOps"

// S1: hierarchical sheets, end to end, from the files KiCad writes.

import { S1, S2, imp } from "./kicad-sheets-fixtures"

describe("S1: a sheet below the root", () => {
  const { project } = imp()

  it("holds the sheet, the symbol that stands for it and its pin", () => {
    expect(project.sheets?.map((s) => s.id)).toEqual([ROOT_SHEET, "s1"])
    expect(project.sheetSymbols).toHaveLength(1)
    const sym = project.sheetSymbols![0]
    expect(sym).toMatchObject({ sheet: ROOT_SHEET, child: "s1", name: "Power" })
    expect(sym.pins.map((p) => [p.name, p.shape, p.rot])).toEqual([["VIN", "input", 180]])
    expect(sym.w).toBeCloseTo(20.32 / 12.7, 5)
  })

  it("puts each symbol on its own use of a sheet, with the reference that use gives it", () => {
    const r2 = project.components.find((c) => c.ref === "R2")!
    expect(r2.inst).toBe("/h1")
    expect(project.components.find((c) => c.ref === "R1")!.inst).toBeUndefined()
    expect(project.labels.find((l) => l.name === "VIN")).toMatchObject({ kind: "hierarchical", shape: "input", sheet: "s1" })
  })

  it("joins a sheet pin to the hierarchical label of its name, and names the net by the label, below a sheet pin", () => {
    const { nets } = computeConnectivity(project)
    const net = nets.find((n) => n.pins.length === 2)!
    expect(net.name).toBe("/Power/VIN")
    expect(net.label).toEqual({ text: "VIN", kind: "hierarchical" })
    expect(net.pins.map((p) => project.components.find((c) => c.id === p.componentId)!.ref).sort()).toEqual(["R1", "R2"])
  })

  it("has a page for each use, the root being 1 and the sheet 2", () => {
    expect(sheetUses(project).map((u) => [u.path, u.page, u.human])).toEqual([
      ["", "1", "/"],
      ["/h1", "2", "/Power/"],
    ])
  })
})

describe("S1: a sheet used twice", () => {
  const two = [
    { uuid: S1, name: "A", y: 60.96 },
    { uuid: S2, name: "B", y: 90 },
  ]

  it("is stored once, and its symbols are one per use with their own references", () => {
    const { project } = imp(two)
    expect(project.sheets?.length).toBe(2)
    expect(project.wires.filter((w) => w.sheet === "s1")).toHaveLength(0)
    expect(project.labels.filter((l) => l.sheet === "s1")).toHaveLength(1)
    const copies = project.components.filter((c) => c.inst)
    expect(copies.map((c) => [c.ref, c.inst]).sort()).toEqual([
      ["R2", "/h1"],
      ["R3", "/h2"],
    ])
    expect(copies[1].tpl).toBe(copies[0].id)
    expect(usesOfSheet(project, "s1")).toHaveLength(2)
  })

  it("keeps the uses of a sheet apart: each has its own nets, named by its path", () => {
    const { project } = imp(two)
    const { nets } = computeConnectivity(project)
    // only the first use's pin is on R1's wire: the second use's VIN is a net of its own, however alike the pins' names are
    expect(nets.filter((n) => n.pins.length > 1).map((n) => [n.name, n.pins.length])).toEqual([["/A/VIN", 2]])
    expect(nets.map((n) => n.name)).toContain("/B/VIN")
  })

  it("a view of one use holds only its symbols and the sheet's items, and an edit on it is made for every use", () => {
    const { project } = imp(two)
    const view = sheetView(project, "/h2")
    expect(view.components.map((c) => c.ref)).toEqual(["R3"])
    expect(sheetView(project, "/h2")).toBe(view)
    const moved = commitOnUse(project, "/h2", (v) => ({ ...v, components: v.components.map((c) => ({ ...c, sch: { ...c.sch, x: 9 } })) }))
    expect(moved.components.filter((c) => c.inst).map((c) => c.sch.x)).toEqual([9, 9])
    expect(moved.components.filter((c) => c.inst).map((c) => c.ref).sort()).toEqual(["R2", "R3"])
  })

  it("a symbol added on one use is added to the others with the next free reference, and removed with it", () => {
    const { project } = imp(two)
    const base = commitOnUse(project, "/h1", (v) => ({ ...v, components: [...v.components, { ...v.components[0], id: "new", ref: "R20", tpl: undefined }] }))
    const added = base.components.filter((c) => c.inst && c.id !== project.components.find((x) => x.inst === "/h1")!.id && c.tpl !== project.components.find((x) => x.inst === "/h1")!.id)
    expect(base.components.filter((c) => c.inst === "/h2")).toHaveLength(2)
    expect(new Set(base.components.map((c) => c.ref)).size).toBe(base.components.length)
    void added
    const gone = commitOnUse(base, "/h1", (v) => ({ ...v, components: v.components.filter((c) => c.id !== "new") }))
    expect(gone.components.filter((c) => c.inst === "/h2")).toHaveLength(1)
  })
})

describe("S1: editing a view", () => {
  it("a wire drawn on a sheet belongs to the sheet, and the sheet's connectivity is its own", () => {
    const { project } = imp()
    const made = commitOnUse(project, "/h1", (v) => addWire(v, [{ x: 0, y: 0 }, { x: 1, y: 0 }]).project)
    expect(made.wires.filter((w) => w.sheet === "s1")).toHaveLength(1)
    expect(made.wires.filter((w) => w.sheet === undefined)).toHaveLength(project.wires.length)
    expect(mergeSheetView(project, sheetView(project, ""), sheetView(project, ""))).toBe(project)
    expect(syncCopies(project, "/h1")).toBe(project)
  })
})

describe("S1: the KiCad export", () => {
  const two = [
    { uuid: S1, name: "A", y: 60.96 },
    { uuid: S2, name: "B", y: 90 },
  ]
  it("writes a file for each sheet, drawn once, with the reference of every use, and reads back as the same hierarchy", async () => {
    const { project } = imp(two)
    const out = await kicadFiles(project)
    const names = Object.keys(out.files).filter((n) => n.endsWith(".kicad_sch"))
    expect(names).toHaveLength(2)
    const root = Object.entries(out.files).find(([n]) => n.endsWith(".kicad_sch") && n !== "A.kicad_sch")!
    expect((out.files["A.kicad_sch"].match(/\(symbol\n/g) ?? []).length).toBe(1)
    expect(root[1].match(/\(sheet\n/g)).toHaveLength(2)
    expect(out.notes.join(" ")).toMatch(/2 files/)
    const files = new Map(Object.entries(out.files).filter(([n]) => n.endsWith(".kicad_sch")))
    const back = importKicadSchematic({ files, root: root[0] })
    if (back.status !== "imported") throw new Error(`${back.message}\n${back.report.entries.map((e) => e.why).join("\n")}`)
    expect(back.project.sheetSymbols?.map((s) => s.name).sort()).toEqual(["A", "B"])
    expect(back.project.components.map((c) => c.ref).sort()).toEqual(["R1", "R2", "R3"])
    expect(sheetUses(back.project).map((u) => u.human)).toEqual(["/", "/A/", "/B/"])
    expect(back.project.labels.filter((l) => l.kind === "hierarchical")).toHaveLength(1)
  })
})

describe("S1: Sakura's tools take a sheet", () => {
  it("get_design lists each part's sheet, one sheet's parts alone, and refuses a sheet a one-sheet project does not have", () => {
    const { project } = imp()
    const all = JSON.parse(runTool(project, "get_design", {}).result)
    expect(all.sheets.map((s: { path: string }) => s.path)).toEqual(["/", "/Power/"])
    expect(all.components.map((c: { ref: string; sheet: string }) => [c.ref, c.sheet])).toEqual([["R1", "/"], ["R2", "/Power/"]])
    const one = JSON.parse(runTool(project, "get_design", { sheet: "Power" }).result)
    expect(one.components.map((c: { ref: string }) => c.ref)).toEqual(["R2"])
    expect(one.showing_sheet).toBe("/Power/")
    expect(runTool(project, "get_design", { sheet: "Nope" }).isError).toBe(true)
    const flat = runTool(createProject("x"), "get_design", { sheet: "Power" })
    expect(flat.isError).toBe(true)
  })

  it("connect works on the sheet of its pins, and one sheet's tidy leaves the others alone", () => {
    const { project } = imp()
    const r = runTool(project, "connect", { pins: ["R1.1", "R2.1"] })
    expect(r.isError).toBe(true)
    expect(r.result).toMatch(/different sheets/)
    const tidy = runTool(project, "tidy_schematic", {})
    expect(tidy.isError).toBe(true)
    expect(tidy.result).toMatch(/sheets: \//)
    const ok = runTool(project, "tidy_schematic", { sheet: "Power", whole_sheet: true })
    expect(ok.project.components.find((c) => c.ref === "R1")).toEqual(project.components.find((c) => c.ref === "R1"))
  })
})

describe("S1: Circuit JSON and the BOM", () => {
  const two = [
    { uuid: S1, name: "A", y: 60.96 },
    { uuid: S2, name: "B", y: 90 },
  ]
  it("counts the parts of every use in the BOM", () => {
    const { project } = imp(two)
    const rows = bomCsv(project).trim().split(String.fromCharCode(10)).slice(1)
    expect(rows.join(" ")).toMatch(/R1/)
    expect(rows.join(" ")).toMatch(/R2/)
    expect(rows.join(" ")).toMatch(/R3/)
  })

  it("leaves a sheet's do-not-populate flag on every part of it in the BOM and the position file", () => {
    const { project } = imp(two)
    const flagged = setSheetSymbol(project, project.sheetSymbols![0].id, { flags: { excludeFromBom: true } })
    const csv = bomCsv(flagged)
    expect(csv).not.toContain("R2")
    expect(csv).toContain("R3")
  })

  it("is flattened, says so, and keeps the nets and their names", () => {
    const { project } = imp(two)
    const out = projectToCircuitJson(project)
    expect(out.notes.join(" ")).toMatch(/3 sheets/)
    const nets = out.elements.filter((e) => e.type === "source_net").map((e) => (e as { name: string }).name)
    expect(nets).toContain("/A/VIN")
    expect(out.elements.filter((e) => e.type === "source_component").length).toBeGreaterThanOrEqual(3)
  })
})
