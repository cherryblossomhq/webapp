import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { ROOT_SHEET, sheetUses, sheetView, mergeSheetView, syncCopies, commitOnUse, usesOfSheet } from "../src/model/sheets"
import { addWire } from "../src/model/ops"
import { kicadFiles } from "../src/export/kicad"
import { LIB_GND, LIB_R, ROOT_UUID, schematic } from "./kicad-schematic-fixtures"

// S1: hierarchical sheets, end to end, from the files KiCad writes.

const CHILD_UUID = "00000000-0000-4000-8000-0000000000c1"
const S1 = "00000000-0000-4000-8000-0000000000a1"
const S2 = "00000000-0000-4000-8000-0000000000a2"

const sheet = (uuid: string, name: string, file: string, y: number, pins: string[], pages: string[]) =>
  `(sheet (at 60.96 ${y}) (size 20.32 10.16) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid ${uuid})
    (property "Sheetname" "${name}" (at 60.96 ${y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "${file}" (at 60.96 ${y + 11} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    ${pins.join("\n")}
    (instances (project "demo" (path "/${ROOT_UUID}" (page "${pages[0]}")))))`

const pin = (name: string, y: number) => `(pin "${name}" input (at 60.96 ${y} 180) (effects (font (size 1.27 1.27)) (justify left)) (uuid p-${name}-${y}))`

function files(uses: { uuid: string; name: string; y: number }[]) {
  const rootSyms = [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }]
  const root = schematic({
    libs: [LIB_R, LIB_GND],
    symbols: rootSyms,
    wires: ["50.8 54.61 50.8 66.04", "50.8 66.04 60.96 66.04"],
    body: uses.map((u, i) => sheet(u.uuid, u.name, "child.kicad_sch", u.y, [pin("VIN", u.y + 5.08)], [String(i + 2)])),
  })
  const child = schematic({
    uuid: CHILD_UUID,
    libs: [LIB_R, LIB_GND],
    symbols: [
      {
        lib: "Device:R",
        at: "50.8 50.8",
        ref: "R9",
        uuid: "bbbbbbbb-0000-4000-8000-000000000001",
        instances: uses.map((u, i) => `/${ROOT_UUID}/${u.uuid}|R${i + 2}`),
      },
    ],
    body: [`(hierarchical_label "VIN" (shape input) (at 50.8 54.61 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid hl1))`],
  })
  return new Map<string, string>([
    ["root.kicad_sch", root],
    ["child.kicad_sch", child],
  ])
}

const imp = (uses = [{ uuid: S1, name: "Power", y: 60.96 }]) => {
  const r = importKicadSchematic({ files: files(uses), root: "root.kicad_sch" })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => `${e.code}: ${e.why}`).join("\n")}`)
  return r
}

describe("S1: a sheet below the root", () => {
  const { project } = imp()

  it("holds the sheet, the symbol that stands for it and its pin", () => {
    expect(project.sheets?.map((s) => s.id)).toEqual([ROOT_SHEET, "s1"])
    expect(project.sheetSymbols).toHaveLength(1)
    const sym = project.sheetSymbols![0]
    expect(sym).toMatchObject({ sheet: ROOT_SHEET, child: "s1", name: "Power", file: "child.kicad_sch" })
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
    const root = Object.entries(out.files).find(([n]) => n.endsWith(".kicad_sch") && !n.startsWith("child"))!
    expect((out.files[names.find((n) => n.startsWith("child"))!].match(/\(symbol\n/g) ?? []).length).toBe(1)
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
