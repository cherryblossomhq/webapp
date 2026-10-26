import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { sheetUses } from "../src/model/sheets"
import { ROOT_UUID, LIB_R, schematic } from "./kicad-schematic-fixtures"

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
    expect(sym.pins[0].uuid).toBe("00000000-0000-4000-8000-0000000000c1")
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

  it("keeps the pages of the root and of the use", () => {
    expect(project.sheets![0]).toMatchObject({ id: "root", page: "3" })
    expect(sheetUses(project).map((u) => u.page)).toEqual(["3", "5"])
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
    for (const path of ["sheet", "sheet>at", "sheet>size", "sheet>dnp", "sheet>in_bom", "sheet>on_board", "sheet>exclude_from_sim", "sheet>fields_autoplaced", "sheet>fill>color", "sheet>stroke>color", "sheet>stroke>type", "sheet>stroke>width", "sheet>uuid", "sheet>property", "sheet>property>at", "sheet>property>effects>font>size", "sheet>pin", "sheet>pin>at", "sheet>pin>effects>justify", "sheet>pin>uuid", "sheet>instances>project>path>page", "hierarchical_label", "hierarchical_label>shape", "hierarchical_label>fields_autoplaced", "hierarchical_label>at", "sheet_instances>path>page"]) {
      expect(held, path).toContain(path)
    }
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
    expect(sheetUses(again.project).map((u) => u.page)).toEqual(["3", "5"])
    expect(again.project.labels.find((l) => l.name === "VOUT/A")).toMatchObject({ kind: "hierarchical" })
    expect(again.project.sheets![1].titleBlock).toEqual(project.sheets![1].titleBlock)
  })
})
