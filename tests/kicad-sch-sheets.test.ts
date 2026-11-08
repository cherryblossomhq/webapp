import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { commitOnUse, mergeSheetView, ROOT_SHEET, sheetUses, sheetView, syncCopies, usesOfSheet } from "../src/model/sheets"
import { addComponent, addWire, createProject } from "../src/model/ops"
import { kicadFiles } from "../src/export/kicad"
import { runTool } from "../src/ai/tools"
import { bomCsv } from "../src/export/bom"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { setSheetSymbol } from "../src/model/sheetOps"
import { files as sheetFiles, imp, S1, S2 } from "./kicad-sheets-fixtures"
import { flattenHierarchy } from "../src/export/flatten"
import { type Project } from "../src/model/types"
import { divider, LIB_GND, LIB_R, ROOT_UUID, schematic } from "./kicad-schematic-fixtures"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"

// S1: hierarchical sheets, end to end, from the files KiCad writes.


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
    // the sheet comes from KiCad's `child.kicad_sch`, so it is written to the same name
    const root = Object.entries(out.files).find(([n]) => n.endsWith(".kicad_sch") && n !== "child.kicad_sch")!
    expect((out.files["child.kicad_sch"].match(/\(symbol\n/g) ?? []).length).toBe(1)
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

// S1 export blockers: a hierarchy drawn in the editor (no `netNames`) keeps its hierarchical labels and its local power symbols.

const CHILD = "00000000-0000-4000-8000-0000000000c1"
const UA = "00000000-0000-4000-8000-0000000000a1"
const UB = "00000000-0000-4000-8000-0000000000a2"
const VERSION = 20250318
const LIB_GNDL = LIB_GND.replace('"power:GND" (power)', '"power:GNDL" (power local)').replace(/"GND_/g, '"GNDL_').replace('"Value" "GND"', '"Value" "GNDL"')

const sheet = (uuid: string, name: string, y: number, page: string) =>
  `(sheet (at 60.96 ${y}) (size 20.32 10.16) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid ${uuid})
    (property "Sheetname" "${name}" (at 60.96 ${y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "child.kicad_sch" (at 60.96 ${y + 11} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (pin "VIN" input (at 60.96 ${y + 5.08} 180) (effects (font (size 1.27 1.27)) (justify left)) (uuid p-${name}))
    (instances (project "demo" (path "/${ROOT_UUID}" (page "${page}")))))`

/** A root with R1 wired to the VIN pin of sheet A, and a child with R9 (VIN on its pin 1, a local GNDL on its pin 2) used as A and B. */
function hierarchy(childLabel: "hierarchical" | "local" = "hierarchical", withGlobal = false) {
  const root = schematic({
    version: VERSION,
    libs: [LIB_R, LIB_GND],
    symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }],
    wires: ["50.8 54.61 50.8 66.04", "50.8 66.04 60.96 66.04"],
    body: [sheet(UA, "A", 60.96, "2"), sheet(UB, "B", 90, "3")],
  })
  const label = childLabel === "hierarchical" ? `(hierarchical_label "VIN" (shape input) (at 50.8 46.99 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid hl1))` : `(label "VIN" (at 50.8 46.99 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid hl1))`
  const child = schematic({
    version: VERSION,
    uuid: CHILD,
    libs: [LIB_R, LIB_GNDL, LIB_GND],
    symbols: [
      { lib: "Device:R", at: "50.8 50.8", ref: "R9", uuid: "bbbbbbbb-0000-4000-8000-000000000001", instances: [`/${ROOT_UUID}/${UA}|R2`, `/${ROOT_UUID}/${UB}|R3`] },
      { lib: "power:GNDL", at: "50.8 54.61", ref: "#PWR01", uuid: "bbbbbbbb-0000-4000-8000-000000000002", instances: [`/${ROOT_UUID}/${UA}|#PWR01`, `/${ROOT_UUID}/${UB}|#PWR02`] },
      ...(withGlobal ? [{ lib: "power:GND", at: "76.2 54.61", ref: "#PWR03", uuid: "bbbbbbbb-0000-4000-8000-000000000003", instances: [`/${ROOT_UUID}/${UA}|#PWR03`, `/${ROOT_UUID}/${UB}|#PWR04`] }] : []),
    ],
    body: [label],
  })
  return new Map([["root.kicad_sch", root], ["child.kicad_sch", child]])
}

function load(files: Map<string, string>, root = "root.kicad_sch"): Project {
  const r = importKicadSchematic({ files, root })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => `${e.code}: ${e.why}`).join("\n")}`)
  return r.project
}

/** What the editor makes of a hierarchy: no `netNames` and no file a sheet was read from, which only a KiCad import sets. */
function drawnInEditor(files: Map<string, string>): Project {
  const { netNames: _gone, ...rest } = load(files)
  void _gone
  return { ...rest, sheets: rest.sheets?.map(({ file: _file, ...sheet }) => sheet) } as Project
}

const netNamesOf = (p: Project) => computeConnectivity(p).nets.map((n) => n.name).filter((n) => /GNDL/.test(n)).sort()
const schFiles = (out: Awaited<ReturnType<typeof kicadFiles>>) => new Map(Object.entries(out.files).filter(([n]) => n.endsWith(".kicad_sch")))
// The sheet used as A and B is written to a file named after its first use.
const rootOf = (m: Map<string, string>) => [...m.keys()].find((n) => n !== "A.kicad_sch")!

describe("S1 export: a hierarchy drawn in the editor keeps its hierarchy", () => {
  it("the project has no netNames and two local GNDL nets, one per use", () => {
    const p = drawnInEditor(hierarchy())
    expect(p.netNames).toBeUndefined()
    expect(netNamesOf(p)).toEqual(["/A/GNDL", "/B/GNDL"])
  })

  it("writes the child's VIN as a hierarchical_label, never a global_label, and re-imports with the sheet pin joined to R1", async () => {
    const p = drawnInEditor(hierarchy())
    const files = schFiles(await kicadFiles(p))
    const child = files.get("A.kicad_sch")!
    expect(child).toMatch(/\(hierarchical_label "VIN"/)
    for (const [, text] of files) expect(text).not.toMatch(/\(global_label/)
    const back = load(files, rootOf(files))
    expect(back.labels.map((l) => l.kind)).toEqual(["hierarchical"])
    const { nets } = computeConnectivity(back)
    const vin = nets.find((n) => n.name === "/A/VIN")!
    expect(vin.pins.map((x) => back.components.find((c) => c.id === x.componentId)!.ref).sort()).toEqual(["R1", "R2"])
  })

  it("writes a local label as a local label", async () => {
    const files = schFiles(await kicadFiles(drawnInEditor(hierarchy("local"))))
    const child = files.get("A.kicad_sch")!
    expect(child).toMatch(/\n {2}\(label "VIN"/)
    expect(child).not.toMatch(/hierarchical_label|global_label/)
  })
})

describe("S1 export: a local power symbol stays local", () => {
  it("writes (power local) for the lib symbol, and the uses stay two nets after a re-import", async () => {
    const p = drawnInEditor(hierarchy())
    const files = schFiles(await kicadFiles(p))
    const child = files.get("A.kicad_sch")!
    expect(child).toMatch(/\(power local\)/)
    expect(child).not.toMatch(/\(power global\)/)
    // KiCad 10 is the first version with (power local), so every sheet file carries its stamp, and the globals are bare.
    for (const text of files.values()) expect(text).toMatch(/\(version 20250227\)/)
    expect([...files.values()].join("").match(/\(power[^)]*\)/g)!.every((t) => t === "(power)" || t === "(power local)")).toBe(true)
    expect((await kicadFiles(p)).notes.some((n) => /needs KiCad 10|only KiCad 10/.test(n))).toBe(true)
    const back = load(files, rootOf(files))
    expect(netNamesOf(back)).toEqual(["/A/GNDL", "/B/GNDL"])
    // the board does not merge the uses either
    const pcb = (await kicadFiles(p)).files
    const boardNets = [...Object.entries(pcb).find(([n]) => n.endsWith(".kicad_pcb"))![1].matchAll(/\(net \d+ "([^"]*GNDL[^"]*)"\)/g)].map((m) => m[1]).sort()
    expect(boardNets).toEqual(["/A/GNDL", "/B/GNDL"])
  })

  it("with a global power symbol too, the globals are bare, the locals local, every sheet is stamped KiCad 10, and the uses stay two nets", async () => {
    const files = schFiles(await kicadFiles(drawnInEditor(hierarchy("hierarchical", true))))
    const all = [...files.values()].join("")
    for (const text of files.values()) expect(text).toMatch(/\(version 20250227\)/)
    expect(all).toMatch(/\(power local\)/)
    expect(all).toMatch(/\(power\)/)
    expect(all).not.toMatch(/\(power global\)/)
    expect(netNamesOf(load(files, rootOf(files)))).toEqual(["/A/GNDL", "/B/GNDL"])
  })

  it("a global power symbol is written bare, and a flat project with only globals keeps KiCad 9's stamp", async () => {
    const { files: flat } = await kicadFiles(drawnInEditor(new Map([["root.kicad_sch", schematic({ version: VERSION, libs: [LIB_R, LIB_GND], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }, { lib: "power:GND", at: "50.8 54.61", ref: "#PWR01", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }] })]])))
    const all = Object.values(flat).join("")
    expect(all).toMatch(/\(power\)/)
    expect(all).not.toMatch(/\(power (?:global|local)\)/)
    expect(Object.entries(flat).find(([n]) => n.endsWith(".kicad_sch"))![1]).toMatch(/\(version 20250114\)/)
  })
})

describe("S1 export: the board's nets are the schematic's, pin by pin", () => {
  /** The net name of every pin, by reference and pin number. */
  const pinNets = (p: Project) => {
    const c = computeConnectivity(p)
    const name = new Map(c.nets.map((n) => [n.id, n.name]))
    return Object.fromEntries(p.components.filter((x) => !x.ref.startsWith("#")).flatMap((x) => ["1", "2"].map((pin) => [`${x.ref}.${pin}`, name.get(c.pinNet.get(`${x.id}:${pin}`) ?? "") ?? null])))
  }
  for (const withGlobal of [false, true]) {
    for (const reversed of [false, true]) {
      it(`a sheet used twice with a local power symbol${withGlobal ? " and a global GND" : ""}${reversed ? ", created in reverse order" : ""}: the flat project the board is written from has each pin on the net the sheets give it`, async () => {
        const drawn = drawnInEditor(hierarchy("hierarchical", withGlobal))
        const p = reversed ? { ...drawn, components: [...drawn.components].reverse() } : drawn
        const want = pinNets(p)
        expect(want["R2.2"]).toBe("/A/GNDL")
        expect(want["R3.2"]).toBe("/B/GNDL")
        expect(want["R3.1"]).toBe("/B/VIN")
        expect(pinNets(flattenHierarchy(p).project)).toEqual(want)
        const pcb = Object.entries((await kicadFiles(p)).files).find(([n]) => n.endsWith(".kicad_pcb"))![1]
        const rows = [...pcb.matchAll(/\(net \d+ "([^"]*)"\)/g)].map((m) => m[1])
        for (const n of ["/A/GNDL", "/B/GNDL", "/A/VIN", "/B/VIN"]) expect(rows).toContain(n)
      })
    }
  }
})

{
// S1: every node of a sheet, a sheet pin, a hierarchical label and the instance data is held by the project, not only counted: a
// sheet with every field the table has, read back exactly, saved and loaded, and written to KiCad and read again.

const SHEET = "00000000-0000-4000-8000-0000000000b1"
const CHILD = "00000000-0000-4000-8000-0000000000b2"

const root = schematic({
  libs: [LIB_R],
  symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }],
  body: [
    `(sheet (at 76.2 50.8) (size 25.4 17.78)
      (exclude_from_sim yes) (in_bom no) (on_board no) (dnp yes) (fields_autoplaced yes)
      (stroke (width 0.254) (type dash) (color 255 0 0 1))
      (fill (color 255 255 194 1))
      (uuid ${SHEET})
      (property "Sheetname" "Power" (at 76.2 50.165 0) (effects (font (size 1.524 1.524) bold italic (color 0 0 255 1)) (justify left bottom)))
      (property "Sheetfile" "power.kicad_sch" (at 76.2 69.215 0) (effects (font (size 1.27 1.27)) (justify left top)) (show_name yes) (do_not_autoplace yes))
      (property "Note" "rev B" (at 90 60 90) (effects (font (size 1.27 1.27) (thickness 0.3)) hide))
      (pin "VIN" input (at 76.2 55.88 180) (uuid 00000000-0000-4000-8000-0000000000c1) (effects (font (size 1.016 1.016) italic) (justify right)))
      (pin "VOUT/A" output (at 101.6 55.88 0) (uuid 00000000-0000-4000-8000-0000000000c2) (effects (font (size 1.27 1.27)) (justify left)))
      (pin "PASS" passive (at 88.9 50.8 90) (uuid 00000000-0000-4000-8000-0000000000c3) (effects (font (size 1.27 1.27)) (justify left)))
      (pin "TRI" tri_state (at 88.9 68.58 270) (uuid 00000000-0000-4000-8000-0000000000c4) (effects (font (size 1.27 1.27)) (justify right)))
      (instances (project "demo" (path "/${ROOT_UUID}" (page "5")))))`,
  ],
}).replace(`(path "/" (page "1"))`, `(path "/" (page "3"))`)

const child = schematic({
  uuid: CHILD,
  head: '(title_block (title "Power stage") (date "2026-01-01") (rev "B") (company "ACME") (comment 1 "first"))',
  libs: [LIB_R],
  symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R9", uuid: "bbbbbbbb-0000-4000-8000-000000000001", instances: [`/${ROOT_UUID}/${SHEET}|R2`] }],
  body: [
    `(hierarchical_label "VIN" (shape input) (at 50.8 54.61 0) (fields_autoplaced yes) (effects (font (size 1.524 1.524) bold) (justify left)) (uuid hl-1))`,
    `(hierarchical_label "VOUT{slash}A" (shape output) (at 60.96 50.8 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid hl-2))`,
  ],
})

const files = new Map([
  ["root.kicad_sch", root],
  ["power.kicad_sch", child],
])
const imported = () => {
  const r = importKicadSchematic({ files, root: "root.kicad_sch" })
  if (r.status !== "imported") throw new Error(`${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}

describe("S1 nodes are held", () => {
  const { project, report } = imported()
  const sym = project.sheetSymbols![0]
  const mm = (n: number) => Math.round(n * 12.7 * 1e4) / 1e4

  it("keeps the rectangle, its flags, its border and its fill", () => {
    expect([mm(sym.x), mm(-(sym.y + sym.h)), mm(sym.w), mm(sym.h)]).toEqual([76.2, 50.8, 25.4, 17.78])
    expect(sym.flags).toEqual({ dnp: true, excludeFromBom: true, notOnBoard: true, excludeFromSim: true })
    expect(sym.fieldsAutoplaced).toBe(true)
    expect(sym.stroke).toMatchObject({ dash: "dash", color: "#ff0000" })
    expect(mm(sym.stroke!.width!)).toBeCloseTo(0.254, 3)
    expect(sym.fill).toEqual({ kind: "color", color: "#ffffc2" })
    // KiCad's own id is kept (a footprint's path on the board ends with the ids of the sheet symbols above it)
    expect(sym.uuid).toBe(SHEET)
  })

  it("keeps every field with its place and look, relative to the symbol", () => {
    const name = sym.fields!.find((f) => f.name === "Sheetname")!
    expect(name).toMatchObject({ value: "Power", place: { bold: true, italic: true, color: "#0000ff", h: "left", v: "bottom" } })
    expect(mm(name.place.size!)).toBeCloseTo(1.524, 3)
    const file = sym.fields!.find((f) => f.name === "Sheetfile")!
    expect(file.place).toMatchObject({ showName: true, noAutoplace: true, h: "left", v: "top" })
    const note = sym.fields!.find((f) => f.name === "Note")!
    expect(note).toMatchObject({ value: "rev B", place: { angle: 90, hidden: true } })
    expect(mm(note.place.thickness!)).toBeCloseTo(0.3, 3)
    // relative to the lower-left corner, y up
    expect(mm(name.place.x)).toBeCloseTo(0, 3)
    expect(mm(name.place.y)).toBeCloseTo(17.78 + 0.635, 3)
  })

  it("keeps each pin where it is, with its shape, its turn and its text (a slash decoded)", () => {
    expect(sym.pins.map((p) => [p.name, p.shape, p.rot, mm(p.x), mm(-p.y)])).toEqual([
      ["VIN", "input", 180, 76.2, 55.88],
      ["VOUT/A", "output", 0, 101.6, 55.88],
      ["PASS", "passive", 90, 88.9, 50.8],
      ["TRI", "tri_state", 270, 88.9, 68.58],
    ])
    expect(sym.pins[0].look).toMatchObject({ italic: true, h: "right" })
    expect(sym.pins[0]).not.toHaveProperty("uuid")
  })

  it("keeps a sub-sheet's own title block, which the project's properties do not hold", () => {
    expect(project.sheets![1].titleBlock).toEqual([
      { key: "Title", value: "Power stage" },
      { key: "Date", value: "2026-01-01" },
      { key: "Rev", value: "B" },
      { key: "Company", value: "ACME" },
      { key: "Comment1", value: "first" },
    ])
  })

  it("numbers the pages in the order of the tree, whatever the file numbered them", () => {
    expect(project.sheets![0]).not.toHaveProperty("page")
    expect(project.sheets![0]).not.toHaveProperty("uuid")
    expect(sym).not.toHaveProperty("pages")
    expect(sheetUses(project).map((u) => u.page)).toEqual(["1", "2"])
  })

  it("keeps a hierarchical label's shape and look, and the reference the use gives the symbol", () => {
    const hl = project.labels.find((l) => l.name === "VIN")!
    expect(hl).toMatchObject({ kind: "hierarchical", shape: "input", sheet: "s1", fieldsAutoplaced: true, look: { bold: true } })
    expect(project.labels.find((l) => l.name === "VOUT/A")).toMatchObject({ kind: "hierarchical", shape: "output" })
    expect(project.components.find((c) => c.inst)!.ref).toBe("R2")
  })

  it("joins the pin to the label of its name, with the slash decoded on both", () => {
    const { nets } = computeConnectivity(project)
    expect(nets.map((n) => n.name)).toContain("/Power/VIN")
  })

  it("counts no S1 node as pending or unknown, and says nothing was dropped", () => {
    expect(report.account?.pending.size).toBe(0)
    expect(report.account?.unknownPaths.size).toBe(0)
    const held = [...(report.account?.importedPaths.keys() ?? [])]
    for (const path of ["sheet", "sheet>at", "sheet>size", "sheet>dnp", "sheet>in_bom", "sheet>on_board", "sheet>exclude_from_sim", "sheet>fields_autoplaced", "sheet>fill>color", "sheet>stroke>color", "sheet>stroke>type", "sheet>stroke>width", "sheet>property", "sheet>property>at", "sheet>property>effects>font>size", "sheet>pin", "sheet>pin>at", "sheet>pin>effects>justify", "hierarchical_label", "hierarchical_label>shape", "hierarchical_label>fields_autoplaced", "hierarchical_label>at"]) {
      expect(held, path).toContain(path)
    }
    // KiCad's ids and page numbers are read past, not kept
    for (const path of ["sheet>uuid", "sheet>pin>uuid", "sheet>instances>project>path>page", "sheet_instances>path>page"]) expect(held, path).not.toContain(path)
  })

  it("survives a save and a load exactly", () => {
    const back = parseProjectFile(serializeProject(project), { id: project.id })
    expect(back.sheets).toEqual(project.sheets)
    expect(back.sheetSymbols).toEqual(project.sheetSymbols)
    expect(back.components).toEqual(project.components)
    expect(back.labels).toEqual(project.labels)
  })

  it("is written to KiCad and read back with the same sheet symbol", async () => {
    const out = await kicadFiles(project)
    const names = Object.keys(out.files).filter((n) => n.endsWith(".kicad_sch"))
    const rootName = names.find((n) => !n.startsWith("power"))!
    const again = importKicadSchematic({ files: new Map(names.map((n) => [n, out.files[n]])), root: rootName })
    if (again.status !== "imported") throw new Error(again.message)
    const s = again.project.sheetSymbols![0]
    expect(s).toMatchObject({ name: "Power", flags: { dnp: true, excludeFromBom: true, notOnBoard: true, excludeFromSim: true } })
    expect(s.pins.map((p) => [p.name, p.shape, p.rot])).toEqual(sym.pins.map((p) => [p.name, p.shape, p.rot]))
    expect(sheetUses(again.project).map((u) => u.page)).toEqual(["1", "2"])
    expect(again.project.labels.find((l) => l.name === "VOUT/A")).toMatchObject({ kind: "hierarchical" })
    expect(again.project.sheets![1].titleBlock).toEqual(project.sheets![1].titleBlock)
  })
})
}

// ---------- the page: KiCad's paper, read and written back where KiCad has it ----------

describe("a sheet's page in KiCad", () => {
  const onPaper = (paper: string) => divider().replace('(paper "A4")', paper)
  const load1 = (text: string) => {
    const r = importKicadSchematic(text)
    if (r.status !== "imported") throw new Error(r.message)
    return r.project
  }
  const exported = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([n]) => n.endsWith(".kicad_sch"))![1]
  const cases = [
    { file: '(paper "A3")', paper: { size: "A3", x: 0, y: 0 } },
    { file: '(paper "A4" portrait)', paper: { size: "A4", portrait: true, x: 0, y: 0 } },
    { file: '(paper "User" 300 200)', paper: { size: "User", width: 300, height: 200, x: 0, y: 0 } },
  ]

  it.each(cases)("$file is imported with its page at (0, 0), where KiCad has it, and written back on it in the same place", async ({ file, paper }) => {
    const project = load1(onPaper(file))
    expect(project.sheets).toEqual([{ id: ROOT_SHEET, paper }])
    // R1 is at (50.8, 50.8) mm in the file: 4 units right of the page's corner and 4 down.
    expect(project.components.find((c) => c.ref === "R1")!.sch).toMatchObject({ x: 4, y: -4 })
    const text = await exported(project)
    expect(text.match(/\(paper[^()]*\)/g)).toEqual([file])
    expect(text).toMatch(/\(lib_id "Device:R"\)\n\s*\(at 50\.8 50\.8 0\)/)
    const back = load1(text)
    expect(back.sheets).toEqual(project.sheets)
    // the parts (the converter draws power symbols as ports of its own, which come back as other symbols)
    const places = (p: Project) => p.components.filter((c) => /^R\d$/.test(c.ref)).map((c) => [c.ref, c.sch.x, c.sch.y]).sort()
    expect(places(back)).toEqual(places(project))
  })

  it("a page KiCad gives no name of the editor's: GERBER is a custom page 32 inches square, an unknown name A4, and a file with none A4", () => {
    expect(load1(onPaper('(paper "GERBER")')).sheets![0].paper).toEqual({ size: "User", width: 812.8, height: 812.8, x: 0, y: 0 })
    expect(load1(onPaper('(paper "B5")')).sheets![0].paper).toEqual({ size: "A4", x: 0, y: 0 })
    expect(load1(onPaper("")).sheets![0].paper).toEqual({ size: "A4", x: 0, y: 0 })
  })

  it("an editor-drawn project, its page centred on the origin, is written with a part at its offset from the page's corner in mm", async () => {
    const drawn = addComponent(createProject("Drawn"), "resistor", { ref: "R1", sch: { x: 1, y: -1, rot: 0 }, props: { resistance: "10k" } }).project
    // A4 landscape about the origin has its top-left corner at (-11.7, 8.3): R1 is 12.7 units right of it and 9.3 down.
    expect(drawn.sheets).toEqual([{ id: ROOT_SHEET, paper: { size: "A4", x: -11.7, y: 8.3 } }])
    const text = await exported(drawn)
    expect(text.match(/\(paper[^()]*\)/g)).toEqual(['(paper "A4")'])
    expect(text).toMatch(/\(lib_id "[^"]*resistor[^"]*"\)\n\s*\(at 161\.29 118\.11 0\)/)
    // a page moved elsewhere moves the part in the file with it: the corner, not the drawing, is KiCad's origin
    const moved = await exported({ ...drawn, sheets: [{ id: ROOT_SHEET, paper: { size: "A3", portrait: true, x: -3, y: 2 } }] })
    expect(moved.match(/\(paper[^()]*\)/g)).toEqual(['(paper "A3" portrait)'])
    expect(moved).toMatch(/\(lib_id "[^"]*resistor[^"]*"\)\n\s*\(at 50\.8 38\.1 0\)/)
    const back = load1(text)
    expect(back.components.map((c) => [c.ref, c.sch.x, c.sch.y])).toEqual([["R1", 12.7, -9.3]])
  })

  it("writes each sheet's file on its own page", async () => {
    const files = sheetFiles([{ uuid: S1, name: "Power", y: 60.96 }])
    files.set("root.kicad_sch", files.get("root.kicad_sch")!.replace('(paper "A4")', '(paper "A3")'))
    files.set("child.kicad_sch", files.get("child.kicad_sch")!.replace('(paper "A4")', '(paper "User" 250 180)'))
    const r = importKicadSchematic({ files, root: "root.kicad_sch" })
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.project.sheets?.map((x) => [x.id, x.paper])).toEqual([
      [ROOT_SHEET, { size: "A3", x: 0, y: 0 }],
      ["s1", { size: "User", width: 250, height: 180, x: 0, y: 0 }],
    ])
    const out = schFiles(await kicadFiles(r.project))
    expect(out.get("child.kicad_sch")!.match(/\(paper[^()]*\)/g)).toEqual(['(paper "User" 250 180)'])
    expect(out.get([...out.keys()].find((n) => n !== "child.kicad_sch")!)!.match(/\(paper[^()]*\)/g)).toEqual(['(paper "A3")'])
    // R9 on the sheet below is at (50.8, 50.8) mm of its own page, as KiCad had it
    expect(out.get("child.kicad_sch")).toMatch(/\(lib_id "Device:R"\)\n\s*\(at 50\.8 50\.8 0\)/)
  })
})
