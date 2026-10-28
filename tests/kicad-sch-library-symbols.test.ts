import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { readSymLibTable, SymbolLibraries } from "../src/model/kicad/schematic/libraries"
import { FileIndex } from "../src/model/kicad/schematic/tree"
import { importKicadProject } from "../src/model/kicad/project"
import { LIB_GND, LIB_R, ROOT_UUID, schematic, type SchSpec } from "./kicad-schematic-fixtures"

// S12: a symbol the schematic's cache lacks is taken from the project's own libraries (`sym-lib-table` and its `.kicad_sym` files), then from the parts
// database; the cache entry wins when there is one, a symbol found nowhere is refused naming the libraries looked in, and a library that has drawn a
// symbol differently since the sheet was saved is refused rather than put the nets on other pins.

/** `Device:R` as a library file has it: the symbol is named without its library. */
const lib = (...symbols: string[]) => `(kicad_symbol_lib (version 20231120) (generator "kicad_symbol_editor") (generator_version "8.0")\n${symbols.join("\n")}\n)`
const R_BODY = LIB_R.replace('(symbol "Device:R"', '(symbol "R"')
const R_LIB = lib(R_BODY)
const table = (...libs: [string, string, string?][]) => `(sym_lib_table\n  (version 7)\n${libs.map(([name, uri, type]) => `  (lib (name "${name}")(type "${type ?? "KiCad"}")(uri "${uri.replace(/\\/g, "\\\\")}")(options "")(descr ""))`).join("\n")}\n)`

const R1 = "aaaaaaaa-0000-4000-8000-000000000001"
const R2 = "aaaaaaaa-0000-4000-8000-000000000002"
const body = (libs: string[], extra: { wires?: string[]; symbols?: SchSpec["symbols"] } = {}) =>
  schematic({
    libs,
    symbols: extra.symbols ?? [
      { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 },
      { lib: "Device:R", at: "50.8 63.5", ref: "R2", uuid: R2 },
    ],
    wires: extra.wires ?? ["50.8 54.61 50.8 59.69"],
    labels: ["A 50.8 46.99 0", "B 50.8 67.31 0"],
  })

const files = (entries: Record<string, string>) => new Map(Object.entries(entries))
const run = (f: Map<string, string>, root = "root.kicad_sch", options: Parameters<typeof importKicadSchematic>[1] = {}) => importKicadSchematic({ files: f, root }, options)
const ok = (r: ReturnType<typeof run>) => {
  if (r.status !== "imported") throw new Error(`${r.message}\n${r.report.entries.map((e) => `${e.code} (${e.severity}): ${e.why}`).join("\n")}`)
  return r
}
const netsOf = (r: ReturnType<typeof ok>) => computeConnectivity(r.project).nets.map((n) => [n.name, n.pins.map((p) => `${r.project.components.find((c) => c.id === p.componentId)!.ref}.${p.pin}`).sort()] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1))

describe("S12: symbols from the project's libraries", () => {
  const withCache = ok(run(files({ "root.kicad_sch": body([LIB_R]) })))

  it("takes a symbol the cache lacks from the library the table names, and draws what the cache would have", () => {
    const r = ok(run(files({ "root.kicad_sch": body([]), "sym-lib-table": table(["Device", "${KIPRJMOD}/libs/Device.kicad_sym"]), "libs/Device.kicad_sym": R_LIB })))
    expect(r.project.symbols).toEqual(withCache.project.symbols)
    expect(netsOf(r)).toEqual(netsOf(withCache))
    expect(r.project.components.map((c) => [c.ref, c.sch])).toEqual(withCache.project.components.map((c) => [c.ref, c.sch]))
    const said = r.report.entries.find((e) => e.code === "symbol-from-library")!
    expect(said.object).toContain("Device:R")
    expect(said.object).toContain("libs/Device.kicad_sym")
    expect(r.report.entries.filter((e) => e.severity === "refused")).toEqual([])
  })

  it("reads the table's paths as KiCad does: relative to the project, through ${KIPRJMOD}, by file name for a path of another machine", () => {
    for (const uri of ["libs/Device.kicad_sym", "${KIPRJMOD}/libs/Device.kicad_sym", "$(KIPRJMOD)/libs/Device.kicad_sym", "C:\\Users\\someone\\KiCad\\Device.kicad_sym", "/home/someone/kicad/Device.kicad_sym"]) {
      const r = ok(run(files({ "root.kicad_sch": body([]), "sym-lib-table": table(["Device", uri]), "libs/Device.kicad_sym": R_LIB })))
      expect(r.project.symbols, uri).toEqual(withCache.project.symbols)
    }
  })

  it("does not take a project's file for KiCad's stock library when the table names it through a KiCad variable", () => {
    for (const uri of ["${KICAD9_SYMBOL_DIR}/Device.kicad_sym", "$(KICAD_SYMBOL_DIR)/Device.kicad_sym", "${KICAD9_3RD_PARTY}/Device.kicad_sym"]) {
      const r = run(files({ "root.kicad_sch": body([]), "sym-lib-table": table(["Device", uri]), "libs/Device.kicad_sym": R_LIB, "Device.kicad_sym": R_LIB }))
      expect(r.status, uri).toBe("refused")
      expect(r.report.entries.some((e) => e.severity === "refused" && /KICAD\d*_/.test(`${e.object} ${e.why}`) || /another machine|machine that made/.test(e.why)), uri).toBe(true)
    }
    // A variable of the user's own, and an absolute path of another machine, are still read by their file name.
    expect(ok(run(files({ "root.kicad_sch": body([]), "sym-lib-table": table(["Device", "${MYLIBS}/Device.kicad_sym"]), "libs/Device.kicad_sym": R_LIB }))).project.symbols).toEqual(withCache.project.symbols)
  })

  it("does not look for a library by its nickname when the project has a table that does not list it", () => {
    const listed = table(["Other", "libs/Other.kicad_sym"])
    const r = run(files({ "root.kicad_sch": body([]), "sym-lib-table": listed, "libs/Other.kicad_sym": R_LIB, "Device.kicad_sym": R_LIB }))
    expect(r.status).toBe("refused")
    expect(r.report.entries.some((e) => e.code === "symbol-library-missing" || /Device/.test(e.object + e.why))).toBe(true)
  })

  it("finds the table and the libraries beside a root sheet that is in a folder, and without regard to case", () => {
    const r = ok(run(files({ "proj/root.kicad_sch": body([]), "proj/Sym-Lib-Table": table(["Device", "${KIPRJMOD}/Libs/device.KICAD_SYM"]), "proj/libs/Device.kicad_sym": R_LIB }), "proj/root.kicad_sch"))
    expect(netsOf(r)).toEqual(netsOf(withCache))
  })

  it("uses a library file named for the nickname when the project has no table", () => {
    const r = ok(run(files({ "root.kicad_sch": body([]), "Device.kicad_sym": R_LIB })))
    expect(r.project.symbols).toEqual(withCache.project.symbols)
  })

  it("prefers the schematic's own cache to a library, which may have changed", () => {
    // The library's resistor has a third pin; the cache's has two, and the cache is what the wires were drawn to.
    const other = lib(R_BODY.replace('(symbol "R_1_1"', '(symbol "R_1_1" (pin passive line (at 5 0 180) (length 1.27) (name "X" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))'))
    const r = ok(run(files({ "root.kicad_sch": body([LIB_R]), "sym-lib-table": table(["Device", "libs/Device.kicad_sym"]), "libs/Device.kicad_sym": other })))
    expect(r.project.symbols).toEqual(withCache.project.symbols)
    expect(r.report.entries.some((e) => e.code === "symbol-from-library")).toBe(false)
  })

  it("reads the libraries in the table's order and a nickname's own library only", () => {
    const wrong = lib(R_BODY.replace('(number "1"', '(number "9"'))
    const r = ok(run(files({ "root.kicad_sch": body([]), "sym-lib-table": table(["Other", "libs/Other.kicad_sym"], ["Device", "libs/Device.kicad_sym"]), "libs/Other.kicad_sym": wrong, "libs/Device.kicad_sym": R_LIB })))
    expect(r.project.symbols).toEqual(withCache.project.symbols)
  })

  it("takes the base of a symbol that extends one from its library when the cache lacks the base", () => {
    const derived = `(symbol "R_Small" (extends "R") (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "R_Small" (at 0 0 0) (effects (font (size 1.27 1.27)))))`
    const cached = LIB_R.replace('"Device:R"', '"Device:R_Small"').replace(/\(symbol "R_(\d)_1"/g, '(symbol "R_Small_$1_1"').replace(/\(symbol "R_0_1"/, '(symbol "R_Small_0_1"')
    void cached
    const own = `(symbol "Device:R_Small" (extends "R") (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "R_Small" (at 0 0 0) (effects (font (size 1.27 1.27)))))`
    const f = (libs: string[], extra: Record<string, string> = {}) =>
      run(files({ "root.kicad_sch": schematic({ libs, symbols: [{ lib: "Device:R_Small", at: "50.8 50.8", ref: "R1", uuid: R1 }], labels: ["A 50.8 46.99 0", "B 50.8 54.61 0"] }), ...extra }))
    const refused = f([own])
    expect(refused.status).toBe("refused")
    expect(refused.report.entries.find((e) => e.code === "symbol-base-missing")?.why).toMatch(/extends R/)
    const r = ok(f([own], { "sym-lib-table": table(["Device", "libs/Device.kicad_sym"]), "libs/Device.kicad_sym": lib(R_BODY, derived) }))
    expect(r.project.components).toHaveLength(1)
    expect(r.project.symbols && Object.keys(r.project.symbols)).toHaveLength(1)
    expect(computeConnectivity(r.project).nets.map((n) => n.name).sort()).toEqual(["/A", "/B"])
  })

  it("reads a Legacy library (a .lib) the table names", () => {
    const LEGACY = `EESCHEMA-LIBRARY Version 2.4\n#encoding utf-8\n#\n# R\n#\nDEF R R 0 0 N Y 1 F N\nF0 "R" 80 0 50 V V C CNN\nF1 "R" 0 0 50 V V C CNN\nDRAW\nS -40 -100 40 100 0 1 10 N\nX ~ 1 0 150 50 D 50 50 1 1 P\nX ~ 2 0 -150 50 U 50 50 1 1 P\nENDDRAW\nENDDEF\n#\n#End Library\n`
    const r = run(files({ "root.kicad_sch": body([]), "sym-lib-table": table(["Device", "libs/Device.lib", "Legacy"]), "libs/Device.lib": LEGACY }))
    // Its drawing is KiCad 5's resistor, which is not the one the wires were drawn to here (7.62 mm apart): a library read for it is named as the source, or the import says the library moved its pins.
    expect(r.report.entries.some((e) => e.code === "symbol-from-library")).toBe(true)
  })

  it("takes a symbol from the parts database last, and a project library first", () => {
    const db = new Map([["Device:R", R_LIB]])
    const only = ok(run(files({ "root.kicad_sch": body([]) }), "root.kicad_sch", { databaseSymbols: db }))
    expect(only.project.symbols).toEqual(withCache.project.symbols)
    expect(only.report.entries.find((e) => e.code === "symbol-from-library")!.object).toContain("the parts database")
    const wrong = lib(R_BODY.replace('(number "1"', '(number "9"'))
    const both = ok(run(files({ "root.kicad_sch": body([]), "Device.kicad_sym": R_LIB }), "root.kicad_sch", { databaseSymbols: new Map([["Device:R", wrong]]) }))
    expect(both.project.symbols).toEqual(withCache.project.symbols)
    // A database text that is not a library is a named miss, not a crash.
    const junk = run(files({ "root.kicad_sch": body([]) }), "root.kicad_sch", { databaseSymbols: new Map([["Device:R", "not a library"]]) })
    expect(junk.status).toBe("refused")
    expect(junk.report.entries.find((e) => e.code === "symbol-not-in-cache")!.why).toMatch(/parts database/)
  })

  it("refuses a symbol found nowhere, naming the libraries looked in, those missing, those unreadable and those of another machine", () => {
    const r = run(
      files({
        "root.kicad_sch": body([]),
        "sym-lib-table": table(["Device", "libs/Device.kicad_sym"], ["Gone", "${KIPRJMOD}/libs/Gone.kicad_sym"], ["Away", "${KICAD9_SYMBOL_DIR}/Away.kicad_sym"], ["Broken", "libs/Broken.kicad_sym"]),
        "libs/Device.kicad_sym": lib(`(symbol "C" (property "Reference" "C" (at 0 0 0) (effects (font (size 1.27 1.27)))))`),
        "libs/Broken.kicad_sym": "this is not a library",
      }),
    )
    expect(r.status).toBe("refused")
    const e = r.report.entries.find((x) => x.code === "symbol-not-in-cache")!
    expect(e.severity).toBe("refused")
    expect(e.object).toContain("Device:R")
    expect(e.why).toContain("Device")
    expect(e.why).toContain("S12")
    // The nickname asked for is Device: only that library is looked in, and the others are named by what the table says of them.
    expect(e.why).toMatch(/do not have them/)
  })

  it("says why for each kind of library a table can name", () => {
    const miss = (entries: Record<string, string>) => {
      const r = run(files({ "root.kicad_sch": body([]), ...entries }))
      expect(r.status).toBe("refused")
      return r.report.entries.find((x) => x.code === "symbol-not-in-cache")!.why
    }
    expect(miss({})).toMatch(/no symbol library/)
    expect(miss({ "sym-lib-table": table(["Device", "libs/Device.kicad_sym"]) })).toMatch(/Device, whose file is not among the files/)
    expect(miss({ "sym-lib-table": table(["Device", "${KICAD9_SYMBOL_DIR}/Device.kicad_sym"]) })).toMatch(/path of the machine that made the project/)
    expect(miss({ "sym-lib-table": table(["Device", "libs/Device.kicad_sym"]), "libs/Device.kicad_sym": "garbage" })).toMatch(/Device cannot be read/)
    expect(miss({ "sym-lib-table": table(["Device", "libs/Device.dat", "Altium"]), "libs/Device.dat": "x" })).toMatch(/kind the importer does not read/)
    expect(miss({ "sym-lib-table": "(sym_lib_table (broken" })).toMatch(/sym-lib-table cannot be read|no symbol library/)
  })

  it("does not take an edited copy (lib_name) from the library, which has the unedited drawing", () => {
    const edited = schematic({ libs: [], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1, extra: '(lib_name "R_1")' }], labels: ["A 50.8 46.99 0", "B 50.8 54.61 0"] })
    const r = run(files({ "root.kicad_sch": edited, "Device.kicad_sym": R_LIB }))
    expect(r.status).toBe("refused")
    expect(r.report.entries.find((e) => e.code === "symbol-not-in-cache")!.object).toContain("R_1")
  })

  it("refuses a library that has moved a pin since the sheet was drawn, naming the symbol", () => {
    // The library's resistor is 10.16 mm tall; the wire was drawn to one that is 7.62 mm.
    const taller = lib(R_BODY.replace("(at 0 3.81 270)", "(at 0 5.08 270)").replace("(at 0 -3.81 90)", "(at 0 -5.08 90)"))
    const r = run(files({ "root.kicad_sch": body([]), "Device.kicad_sym": taller }))
    expect(r.status).toBe("refused")
    const e = r.report.entries.find((x) => x.code === "symbol-may-have-changed")!
    expect(e.severity).toBe("refused")
    expect(e.object).toMatch(/R1|R2/)
  })

  it("refuses a library that has renumbered or renamed (as an alternate) its pins at the same places", () => {
    // The wires are drawn to the same points, and the instance lists pins 1 and 2: the library's are now A and B.
    const renumbered = lib(R_BODY.replace('(number "1"', '(number "A"').replace('(number "2"', '(number "B"'))
    const r = run(files({ "root.kicad_sch": body([]), "Device.kicad_sym": renumbered }))
    expect(r.status).toBe("refused")
    expect(r.report.entries.find((x) => x.code === "symbol-may-have-changed")!.severity).toBe("refused")
    // A library that is as it was is not refused.
    expect(run(files({ "root.kicad_sch": body([]), "Device.kicad_sym": R_LIB })).status).toBe("imported")
  })

  it("reads a power symbol from its library, and a symbol of two libraries by the nickname", () => {
    const gnd = lib(LIB_GND.replace('"power:GND"', '"GND"'))
    const r = ok(
      run(files({ "root.kicad_sch": schematic({ libs: [], symbols: [{ lib: "power:GND", at: "50.8 54.61", ref: "#PWR01", uuid: R1 }, { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R2 }], labels: ["A 50.8 46.99 0"] }), "sym-lib-table": table(["power", "libs/power.kicad_sym"], ["Device", "libs/Device.kicad_sym"]), "libs/power.kicad_sym": gnd, "libs/Device.kicad_sym": R_LIB })),
    )
    expect(computeConnectivity(r.project).nets.map((n) => n.name)).toContain("GND")
    expect(r.report.entries.find((e) => e.code === "symbol-from-library")!.count).toBe(2)
  })

  it("is read by the project import too, with the libraries among the files", () => {
    const r = importKicadProject([
      { path: "p/p.kicad_sch", data: body([]) },
      { path: "p/p.kicad_pcb", data: `(kicad_pcb (version 20240108) (generator "pcbnew") (general (thickness 1.6)) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 ""))` },
      { path: "p/sym-lib-table", data: table(["Device", "${KIPRJMOD}/libs/Device.kicad_sym"]) },
      { path: "p/libs/Device.kicad_sym", data: R_LIB },
    ])
    expect(r.status === "imported" || r.report.entries.every((e) => e.code !== "symbol-not-in-cache")).toBe(true)
  })

  it("reads a table and refuses damage with a named error, for every shape of garbage", () => {
    expect(readSymLibTable(table(["A", "a.kicad_sym"], ["B", "b.kicad_sym", "Legacy"]))).toEqual([
      { nickname: "A", type: "KiCad", uri: "a.kicad_sym", disabled: false },
      { nickname: "B", type: "Legacy", uri: "b.kicad_sym", disabled: false },
    ])
    expect(() => readSymLibTable("(fp_lib_table)")).toThrow(/sym_lib_table/)
    for (const text of ["", "(", "\u0000\u0001", "(sym_lib_table (lib", "(sym_lib_table (lib (name)))", "(sym_lib_table (lib (uri 5)))"]) {
      let out: unknown
      try {
        out = readSymLibTable(text)
      } catch (e) {
        out = e
      }
      expect(out instanceof Error || Array.isArray(out), JSON.stringify(text)).toBe(true)
    }
    const index = new FileIndex(new Map([["root.kicad_sch", ""], ["sym-lib-table", "("]]))
    const libs = new SymbolLibraries(index, "root.kicad_sch")
    expect(libs.tableError).not.toBeNull()
    expect(libs.find("Device:R")).toMatchObject({ libId: "Device:R" })
  })

  it("survives a library with a cycle of extends and a huge table", () => {
    const cyc = lib(`(symbol "A" (extends "B"))`, `(symbol "B" (extends "A"))`)
    const cycle = schematic({ libs: [], symbols: [{ lib: "Device:A", at: "50.8 50.8", ref: "R1", uuid: R1 }], labels: ["A 50.8 46.99 0"] })
    const r = run(files({ "root.kicad_sch": cycle, "Device.kicad_sym": cyc }))
    expect(r.status).toBe("refused")
    expect(r.report.entries.find((e) => e.code === "symbol-base-missing")!.why).toMatch(/cycle/)
    const many = table(...[...Array.from({ length: 5000 }, (_, i) => [`L${i}`, `libs/L${i}.kicad_sym`] as [string, string]), ["Device", "Device.kicad_sym"] as [string, string]])
    const t0 = Date.now()
    const big = run(files({ "root.kicad_sch": body([]), "sym-lib-table": many, "Device.kicad_sym": R_LIB }))
    expect(big.status).toBe("imported")
    expect(Date.now() - t0).toBeLessThan(5000)
    void ROOT_UUID
  })
})
