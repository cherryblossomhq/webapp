import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { safeFileStem, safePath, sheetFileNames } from "../src/export/kicadSheets"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { EXAMPLES } from "../src/model/examples"
import type { Project } from "../src/model/types"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"
import { files as sheetFiles } from "./kicad-sheets-fixtures"

// What a KiCad round trip keeps: the user's data (a simulation flag on a text, a hyperlink, a sheet's own file name) comes back, and only KiCad's own
// bookkeeping (uuids, page numbers, the board-wide castellated flag) is regenerated or read past.

const origin = { id: "p1", createdAt: 1_000, updatedAt: 2_000 }
const imp = (text: string) => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}

describe("a text, a text box and a table cell left out of simulation stay out of it through KiCad", () => {
  const body = [
    `(text "Spice" (exclude_from_sim yes) (at 101.6 25.4 90) (effects (font (size 2.54 2.54)) (justify left bottom) (href "https://example.com")) (uuid t1))`,
    `(text_box "Note" (exclude_from_sim yes) (at 111.76 30.48 0) (size 20.32 10.16) (margins 0.9525 0.9525 0.9525 0.9525) (stroke (width 0.254) (type dash)) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid t2))`,
    `(table (column_count 1) (border (external yes) (header yes) (stroke (width 0.1) (type default))) (separators (rows yes) (cols yes)) (column_widths 10.16) (row_heights 5.08)
      (cells (table_cell "A" (exclude_from_sim yes) (at 127 127 0) (size 10.16 5.08) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid c1))))`,
  ]
  const project = imp(schematic({ version: 20250114, libs: [LIB_R], body }))
  const cell = (p: Project) => (p.drawings?.find((d) => d.type === "table") as unknown as { cells: { excludeFromSim?: true }[] }).cells[0]

  it("are read with the flag and the hyperlink", () => {
    expect(project.drawings?.find((d) => d.type === "text")).toMatchObject({ excludeFromSim: true, href: "https://example.com" })
    expect(project.drawings?.find((d) => d.type === "textbox")).toMatchObject({ excludeFromSim: true })
    expect(cell(project)).toMatchObject({ excludeFromSim: true })
  })

  it("are written back and read again with the flag", async () => {
    const { files } = await kicadFiles(project)
    const sch = Object.entries(files).find(([n]) => n.endsWith(".kicad_sch"))![1]
    expect(sch).toMatch(/\(text "Spice"\s+\(exclude_from_sim yes\)/)
    expect(sch).toMatch(/\(text_box "Note"\s+\(exclude_from_sim yes\)/)
    const again = imp(sch)
    expect(again.drawings?.find((d) => d.type === "text")).toMatchObject({ excludeFromSim: true, href: "https://example.com" })
    expect(again.drawings?.find((d) => d.type === "textbox")).toMatchObject({ excludeFromSim: true })
    expect(cell(again)).toMatchObject({ excludeFromSim: true })
  })

  it("keep the flag through a save and a load of the project", () => {
    const back = parseProjectFile(serializeProject(project), origin)
    expect(back.drawings?.find((d) => d.type === "text")).toMatchObject({ excludeFromSim: true, href: "https://example.com" })
    expect(back.drawings?.find((d) => d.type === "textbox")).toMatchObject({ excludeFromSim: true })
    expect(cell(back)).toMatchObject({ excludeFromSim: true })
  })
})

describe("what KiCad keeps for itself is read past in a saved project", () => {
  it("loads a project that has a sheet's uuid and page, a sheet symbol's uuid and pages, a pin's uuid and the castellated flag, and ignores them", () => {
    const ex = EXAMPLES[0].project
    const doc = JSON.parse(
      serializeProject({
        ...ex,
        sheets: [{ id: "root" }, { id: "s1" }],
        sheetSymbols: [{ id: "h1", sheet: "root", child: "s1", x: 0, y: 0, w: 5, h: 3, name: "Power", pins: [{ id: "p1", name: "VIN", shape: "input", x: 0, y: 1, rot: 180 }] }],
      }),
    )
    const raw = doc.project
    raw.sheets = [
      { id: "root", page: "4", uuid: "u-root" },
      { id: "s1", page: "5", uuid: "u-s1", titleBlock: [{ key: "Title", value: "Power stage" }], file: "power.kicad_sch" },
    ]
    raw.sheetSymbols[0].uuid = "u-h1"
    raw.sheetSymbols[0].pages = { "/h1": "7" }
    raw.sheetSymbols[0].pins[0].uuid = "u-p1"
    raw.board = { ...raw.board, stack: { copper: [{ id: "top" }, { id: "bottom" }], castellated: true } }
    const read = parseProjectFile(JSON.stringify(doc), origin)
    expect(read.sheets).toEqual([{ id: "root" }, { id: "s1", titleBlock: [{ key: "Title", value: "Power stage" }], file: "power.kicad_sch" }])
    expect(read.sheetSymbols![0]).not.toHaveProperty("uuid")
    expect(read.sheetSymbols![0]).not.toHaveProperty("pages")
    expect(read.sheetSymbols![0].pins[0]).not.toHaveProperty("uuid")
    expect(read.board.stack ?? {}).not.toHaveProperty("castellated")
  })
})

describe("a sheet's file name in the KiCad export", () => {
  const project = (sheets: Project["sheets"], names: Record<string, string>): Project =>
    ({
      ...EXAMPLES[0].project,
      sheets,
      sheetSymbols: Object.entries(names).map(([child, name], i) => ({ id: `h${i + 1}`, sheet: "root", child, x: 0, y: i * 5, w: 5, h: 3, name, pins: [] })),
    }) as Project
  const names = (p: Project) => Object.fromEntries(sheetFileNames(p, "demo"))

  it("is the file a sheet from KiCad was read from, and a sheet made here is named after its symbol", () => {
    const p = project([{ id: "root" }, { id: "s1", file: "power_stage.kicad_sch" }, { id: "s2" }], { s1: "Power", s2: "Sensors" })
    expect(names(p)).toEqual({ root: "demo.kicad_sch", s1: "power_stage.kicad_sch", s2: "Sensors.kicad_sch" })
  })

  it("keeps the file of an imported sheet when it is renamed, and when a sheet made here is named like it", () => {
    const p = project([{ id: "root" }, { id: "s1", file: "power_stage.kicad_sch" }, { id: "s2" }], { s1: "Renamed", s2: "power_stage" })
    // the sheet made here gives way to the file KiCad had
    expect(names(p)).toEqual({ root: "demo.kicad_sch", s1: "power_stage.kicad_sch", s2: "power_stage_2.kicad_sch" })
  })

  it("is each sheet's own, whatever the case, and never the root's", () => {
    const p = project([{ id: "root" }, { id: "s1", file: "Demo.kicad_sch" }, { id: "s2" }, { id: "s3" }], { s1: "A", s2: "Same", s3: "SAME" })
    expect(names(p)).toEqual({ root: "demo.kicad_sch", s1: "Demo_2.kicad_sch", s2: "Same.kicad_sch", s3: "SAME_2.kicad_sch" })
  })

  it("is not a name Windows keeps for a device, with or without an extension, whatever the case", () => {
    for (const reserved of ["CON", "prn", "Aux", "NUL", "com1", "COM9", "lpt1", "LPT9", "con.v2", "aux.txt"]) {
      const stem = safeFileStem(reserved)
      expect(stem, reserved).not.toBe(reserved)
      expect(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem), reserved).toBe(false)
    }
    const p = project([{ id: "root" }, { id: "s1" }, { id: "s2", file: "CON.kicad_sch" }, { id: "s3" }], { s1: "NUL", s2: "x", s3: "COM3.old" })
    expect(names(p)).toEqual({ root: "demo.kicad_sch", s1: "NUL_.kicad_sch", s2: "CON_.kicad_sch", s3: "COM3_.old.kicad_sch" })
    // a name only near a device name is left alone
    expect(safeFileStem("console")).toBe("console")
    expect(safeFileStem("com10")).toBe("com10")
  })

  it("has no trailing dots or spaces, nothing that is a path, and something when nothing is left", () => {
    expect(safeFileStem("Power. ")).toBe("Power")
    expect(safeFileStem("a/b\\c:d")).toBe("a_b_c_d")
    expect(safeFileStem("..")).toBe("")
    const p = project([{ id: "root" }, { id: "s1" }, { id: "s2" }], { s1: "Power. .", s2: "..." })
    expect(names(p)).toEqual({ root: "demo.kicad_sch", s1: "Power.kicad_sch", s2: "s2.kicad_sch" })
  })

  it("comes through an import and an export unchanged, for a sheet of a KiCad project", async () => {
    const r = importKicadSchematic({ files: sheetFiles([{ uuid: "00000000-0000-4000-8000-0000000000a1", name: "A", y: 60.96 }]), root: "root.kicad_sch" })
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.project.sheets?.find((s) => s.id !== "root")?.file).toBe("child.kicad_sch")
    const out = await kicadFiles(r.project)
    expect(out.files["child.kicad_sch"]).toBeDefined()
  })
})

describe("the file names and folders of an imported project in the KiCad export", () => {
  const nested = (uses: { uuid: string; name: string; y: number }[], dir = "proj") => {
    const f = sheetFiles(uses)
    const root = f.get("root.kicad_sch")!.split('"child.kicad_sch"').join('"sheets/child.kicad_sch"')
    return new Map([
      [`${dir}/Main.kicad_sch`, root],
      [`${dir}/sheets/child.kicad_sch`, f.get("child.kicad_sch")!],
    ])
  }
  const run = (files: Map<string, string>, root: string) => {
    const r = importKicadSchematic({ files, root })
    if (r.status !== "imported") throw new Error(r.message)
    return r.project
  }

  it("keeps the root schematic's file name, and the board and project files take it", async () => {
    const p = run(nested([{ uuid: "00000000-0000-4000-8000-0000000000a1", name: "A", y: 60.96 }]), "proj/Main.kicad_sch")
    const out = await kicadFiles(p)
    expect(out.files["Main.kicad_sch"]).toBeDefined()
    expect(out.files["Main.kicad_pro"]).toBeDefined()
    expect(out.files["Main.kicad_pcb"]).toBeDefined()
  })

  it("round-trips a sheet in a subfolder with the same path, and the sheet symbol points to it", async () => {
    const p = run(nested([{ uuid: "00000000-0000-4000-8000-0000000000a1", name: "A", y: 60.96 }]), "proj/Main.kicad_sch")
    expect(p.sheets?.find((s) => s.id !== "root")?.file).toBe("sheets/child.kicad_sch")
    const out = await kicadFiles(p)
    expect(out.files["sheets/child.kicad_sch"]).toBeDefined()
    expect(out.files["Main.kicad_sch"]).toContain('(property "Sheetfile" "sheets/child.kicad_sch"')
  })

  it("keeps one file for a sheet used twice from a subfolder", async () => {
    const p = run(nested([{ uuid: "00000000-0000-4000-8000-0000000000a1", name: "A", y: 60.96 }, { uuid: "00000000-0000-4000-8000-0000000000a2", name: "B", y: 90 }]), "proj/Main.kicad_sch")
    const out = await kicadFiles(p)
    expect(Object.keys(out.files).filter((n) => n.endsWith(".kicad_sch")).sort()).toEqual(["Main.kicad_sch", "sheets/child.kicad_sch"])
    expect(out.files["Main.kicad_sch"].match(/"Sheetfile" "sheets\/child\.kicad_sch"/g)).toHaveLength(2)
  })

  it("makes paths safe: forward slashes, no climbing, no absolute or drive paths, each segment cleaned, collisions by case", () => {
    expect(safePath("sheets\\power")).toBe("sheets/power")
    expect(safePath("../x/power")).toBe("power")
    expect(safePath("/etc/power")).toBe("power")
    expect(safePath("C:/x/power")).toBe("power")
    expect(safePath("a/./CON/b?")).toBe("a/CON_/b_")
    const p = {
      ...EXAMPLES[0].project,
      sheets: [{ id: "root" }, { id: "s1", file: "Sheets/Power.kicad_sch" }, { id: "s2", file: "sheets/power.kicad_sch" }, { id: "s3", file: "../../out.kicad_sch" }],
      sheetSymbols: ["s1", "s2", "s3"].map((child, i) => ({ id: `h${i + 1}`, sheet: "root", child, x: 0, y: i * 5, w: 5, h: 3, name: child, pins: [] })),
    } as Project
    expect(Object.fromEntries(sheetFileNames(p, "demo"))).toEqual({ root: "demo.kicad_sch", s1: "Sheets/Power.kicad_sch", s2: "sheets/power_2.kicad_sch", s3: "out.kicad_sch" })
  })

  it("leaves a project made in the editor as it was", async () => {
    const p = EXAMPLES[0].project
    expect(sheetsFileOf(p)).toBeUndefined()
    const out = await kicadFiles(p)
    const names = Object.keys(out.files).sort()
    expect(names.every((n) => !n.includes("/"))).toBe(true)
    expect(names.filter((n) => n.endsWith(".kicad_sch"))).toHaveLength(1)
  })
})

const sheetsFileOf = (p: Project) => p.sheets?.find((s) => s.id === "root")?.file
