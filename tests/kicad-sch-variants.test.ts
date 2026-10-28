import { describe, expect, it } from "vitest"
import { bomCsv } from "../src/export/bom"
import { buildFabricationFiles } from "../src/export/bundle"
import { kicadFiles } from "../src/export/kicad"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { pnpCsv } from "../src/export/pnp"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { onBoard } from "../src/model/partFlags"
import { addComponent, createProject } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { type Project } from "../src/model/types"
import { activeVariant, addVariant, removeVariant, renameVariant, resolveVariant, setActiveVariant, setVariantOverride, variantComponent } from "../src/model/variants"
import { resolvedComponents } from "../src/model/ruleAreas"
import { LIB_GND, LIB_R, schematic } from "./kicad-schematic-fixtures"
import { files as sheetFiles, imp as importSheets, S1 } from "./kicad-sheets-fixtures"
import { runTool } from "../src/ai/tools"
import { getDesignators, placeDesignators } from "../src/model/silk"

// S9: schematic variants (KiCad 10). The importer keeps them, the editor chooses one, and the BOM, the position file, the do not populate marks, the board
// side and the exports follow it, all through the one resolver (`model/variants.ts`). KiCad's rules, from `sch_io_kicad_sexpr_parser.cpp` of 10.0 (the
// parser of `symbol>instances>project>path>variant`), which this was written from:
//  - a variant starts from the symbol's own attributes (`SCH_SYMBOL_VARIANT::InitializeAttributes`), so a flag the variant does not say is the symbol's;
//  - `dnp`, `exclude_from_sim`, `on_board`, `in_pos_files` are plain; `in_bom` is read as "excluded from the BOM" with no inversion before stamp 20260306
//    and inverted from it (the parser's own comment calls the older reading "incorrect logic from prior file versions");
//  - `(field (name N) (value V))` replaces the field N for that variant;
//  - the writer (`sch_io_kicad_sexpr.cpp`) writes only what differs from the symbol, and `in_bom` as the positive word.

const U = (n: number) => `aaaaaaaa-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`

function load(text: string): { project: Project; report: ReturnType<typeof importKicadSchematic> & { status: "imported" } } {
  const r = importKicadSchematic(text, { built: new Set([...BUILT_EXTENSIONS, "S2", "S5", "S6", "S10"]) })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return { project: r.project, report: r }
}

const R = (ref: string, n: number, variants?: string, at = "50.8 50.8") => ({ lib: "Device:R", at, ref, uuid: U(n), value: "10k", footprint: "R_0603", ...(variants ? { variants } : {}) })

describe("the importer keeps the variants of a KiCad 10 schematic", () => {
  const text = (version: number) =>
    schematic({
      version,
      libs: [LIB_R],
      symbols: [
        R("R1", 1, `(variant (name "Lite") (dnp yes) (field (name "Value") (value "0R")) (field (name "Part Number") (value "X1"))) (variant (name "Full"))`),
        R("R2", 2, `(variant (name "Lite") (on_board no) (in_pos_files no) (in_bom no) (exclude_from_sim yes))`, "80 50.8"),
        R("R3", 3, undefined, "110 50.8"),
      ],
    })

  it("is built, and nothing else of S9 is: the KiCad 11 development words still refuse", () => {
    expect(BUILT_EXTENSIONS.has("S9")).toBe(true)
    const r = importKicadSchematic(schematic({ body: [`(symbol_override)`] }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.message).toBe("This schematic uses symbol overrides and custom properties (KiCad 11 development files), which are not supported yet.")
  })

  it("holds each symbol's changes by variant, and only what differs from the symbol", () => {
    const { project } = load(text(20260306))
    expect(project.variants?.list).toEqual([{ name: "Lite" }, { name: "Full" }])
    expect(project.variants?.active).toBeUndefined()
    const c = (ref: string) => project.components.find((x) => x.ref === ref)!
    expect(c("R1").variants).toEqual({ Lite: { dnp: true, fields: { Value: "0R", "Part Number": "X1" } } })
    // from stamp 20260306 `in_bom no` is out of the BOM
    expect(c("R2").variants).toEqual({ Lite: { excludeFromBom: true, notOnBoard: true, excludeFromPos: true, excludeFromSim: true } })
    expect(c("R3").variants).toBeUndefined()
    // the symbols themselves are as the file has them: the variants are not applied
    expect(c("R1").flags).toBeUndefined()
    expect(c("R1").props.value).toBe("10k")
  })

  it("reads in_bom as KiCad 10 does for the stamp: before 20260306 the word is the exclusion itself", () => {
    const old = (version: number, word: string) =>
      load(schematic({ version, libs: [LIB_R], symbols: [R("R1", 1, `(variant (name "A") (in_bom ${word}))`)] })).project.components[0].variants
    // `(in_bom yes)` of a KiCad 10 file before the fix leaves the symbol out of the BOM; `(in_bom no)` says nothing (the symbol is in the BOM already)
    expect(old(20251028, "yes")).toEqual({ A: { excludeFromBom: true } })
    expect(old(20251028, "no")).toBeUndefined()
    expect(old(20260306, "no")).toEqual({ A: { excludeFromBom: true } })
    expect(old(20260306, "yes")).toBeUndefined()
  })

  it("a variant that changes nothing is still a variant of the project, and the same flag as the symbol's changes nothing", () => {
    const { project } = load(
      schematic({ version: 20260306, libs: [LIB_R], symbols: [{ ...R("R1", 1, `(variant (name "Same") (dnp yes))`), extra: "(dnp yes)" }] }),
    )
    expect(project.variants?.list).toEqual([{ name: "Same" }])
    expect(project.components[0].variants).toBeUndefined()
  })

  it("a variant of a symbol on a sheet used twice belongs to its own use", () => {
    const f = sheetFiles([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: "00000000-0000-4000-8000-0000000000a2", name: "Power2", y: 90 }])
    const child = f.get("child.kicad_sch")!.replace(/\(path "\/[^"]*\/00000000-0000-4000-8000-0000000000a2" \(reference "R3"\) \(unit 1\)/, (m) => `${m} (variant (name "Lite") (dnp yes))`)
    f.set("child.kicad_sch", child)
    const r = importKicadSchematic({ files: f, root: "root.kicad_sch" })
    if (r.status !== "imported") throw new Error(r.message)
    const uses = r.project.components.filter((c) => c.ref === "R2" || c.ref === "R3")
    expect(uses.map((c) => [c.ref, c.variants?.Lite])).toEqual([["R2", undefined], ["R3", { dnp: true }]])
  })

  it("a variant of a sheet symbol is kept for each use of its parent sheet", () => {
    const f = sheetFiles([{ uuid: S1, name: "Power", y: 60.96 }])
    const root = f.get("root.kicad_sch")!.replace(/\(page "2"\)/, `(page "2") (variant (name "Lite") (dnp yes) (in_bom yes))`)
    f.set("root.kicad_sch", root)
    const r = importKicadSchematic({ files: f, root: "root.kicad_sch" })
    if (r.status !== "imported") throw new Error(r.message)
    // the fixture's stamp is 20230121, before 20260306: `in_bom yes` is the exclusion (see above)
    expect(r.project.sheetSymbols?.[0].variants).toEqual({ "": { Lite: { dnp: true, excludeFromBom: true } } })
    expect(r.project.variants?.list).toEqual([{ name: "Lite" }])
  })

  it("every variant node counted as imported is in the project", () => {
    const { report, project } = load(text(20260306))
    const a = report.report.account!
    const paths = [...a.importedPaths.keys()].filter((p) => p.includes(">variant"))
    expect(paths.sort()).toEqual(
      [
        "symbol>instances>project>path>variant",
        "symbol>instances>project>path>variant>name",
        "symbol>instances>project>path>variant>dnp",
        "symbol>instances>project>path>variant>field",
        "symbol>instances>project>path>variant>field>name",
        "symbol>instances>project>path>variant>field>value",
        "symbol>instances>project>path>variant>on_board",
        "symbol>instances>project>path>variant>in_pos_files",
        "symbol>instances>project>path>variant>in_bom",
        "symbol>instances>project>path>variant>exclude_from_sim",
      ].sort(),
    )
    expect(a.pending.size).toBe(0)
    // name, dnp, field name and value, on_board, in_pos_files, in_bom and exclude_from_sim are each in a symbol's changes
    const all = project.components.flatMap((c) => Object.values(c.variants ?? {}))
    expect(all.some((o) => o.dnp)).toBe(true)
    expect(all.some((o) => o.fields?.Value === "0R")).toBe(true)
    expect(all.some((o) => o.notOnBoard && o.excludeFromPos && o.excludeFromBom && o.excludeFromSim)).toBe(true)
    expect(project.variants?.list.map((v) => v.name)).toEqual(["Lite", "Full"])
  })
})

/** A board drawn in the editor with three resistors and two variants: Lite takes R1 out (do not populate), R2 off the board, and changes R3's value. */
function board(): Project {
  let p = createProject("variants")
  for (const v of ["10k", "1k", "4.7k"]) p = addComponent(p, "resistor", { props: { resistance: v } }).project
  p = addVariant(p, "Lite", "a cheaper build")!
  p = addVariant(p, "Full")!
  const id = (ref: string) => p.components.find((c) => c.ref === ref)!.id
  p = setVariantOverride(p, id("R1"), "Lite", { dnp: true })
  p = setVariantOverride(p, id("R2"), "Lite", { notOnBoard: true })
  p = setVariantOverride(p, id("R3"), "Lite", { fields: { Value: "0R" } })
  p = setVariantOverride(p, id("R3"), "Full", { excludeFromPos: true })
  // place every part on the board, so the position file lists them
  return { ...p, components: p.components.map((c, i) => ({ ...c, pcb: { ...c.pcb, x: 5 + i * 5, y: 5, placed: true } })) }
}

const bomRefs = (p: Project) => bomCsv(p).trimEnd().split("\n").slice(1).map((l) => l.split(",")[0].replace(/"/g, ""))
const pnpRefs = (p: Project) => pnpCsv(p).trimEnd().split("\n").slice(1).map((l) => l.split(",")[0])

describe("the active variant is followed by the BOM, the position file, the marks and the board side, through one resolver", () => {
  it("with no variant active nothing changes: the same objects, the same files", () => {
    const p = board()
    expect(activeVariant(p)).toBeUndefined()
    expect(resolveVariant(p)).toBe(p)
    expect(resolvedComponents(p)).toBe(p.components)
    expect(bomRefs(p)).toEqual(["R1", "R2", "R3"])
    expect(pnpRefs(p)).toEqual(["R1", "R2", "R3"])
    const { variants: _v, ...bare } = p
    void _v
    expect(bomCsv(p)).toBe(bomCsv({ ...bare, components: p.components.map(({ variants: _c, ...c }) => c) }))
  })

  it("choosing a variant changes the BOM: do not populate leaves a part out, and a value is the variant's", () => {
    const p = setActiveVariant(board(), "Lite")
    expect(activeVariant(p)).toBe("Lite")
    const lines = bomCsv(p)
    // R1 is do not populate: out of the BOM. R2 is on the board but not changed in the BOM. R3 is 0R.
    expect(lines).not.toMatch(/R1/)
    expect(lines).toMatch(/R2/)
    expect(lines).toMatch(/0R/)
    expect(lines).not.toMatch(/4\.7k/)
  })

  it("the position file follows: do not populate, not on the board and not in the file leave the file", () => {
    expect(pnpRefs(board())).toEqual(["R1", "R2", "R3"])
    expect(pnpRefs(setActiveVariant(board(), "Lite"))).toEqual(["R3"])
    expect(pnpRefs(setActiveVariant(board(), "Full"))).toEqual(["R1", "R2"])
  })

  it("the DNP marks and the board side read the resolved parts, and the symbols themselves are never rewritten", () => {
    const p = setActiveVariant(board(), "Lite")
    const base = (ref: string) => p.components.find((c) => c.ref === ref)!
    const seen = (ref: string) => resolvedComponents(p).find((c) => c.ref === ref)!
    expect(seen("R1").flags?.dnp).toBe(true)
    expect(base("R1").flags).toBeUndefined()
    expect(variantComponent(base("R1"), "Lite").flags?.dnp).toBe(true)
    expect(onBoard(seen("R2"))).toBe(false)
    expect(onBoard(base("R2"))).toBe(true)
    // a symbol the variant does not touch is the same object
    expect(resolvedComponents(p).find((c) => c.ref === "R3")).not.toBe(base("R3"))
    const q = setActiveVariant(p, undefined)
    expect(resolvedComponents(q)).toBe(q.components)
    expect(q.components.map((c) => c.flags)).toEqual([undefined, undefined, undefined])
  })

  it("the fabrication files follow the variant: a part off the board has no footprint, no drill and no paste", () => {
    const all = buildFabricationFiles(board())
    const lite = buildFabricationFiles(setActiveVariant(board(), "Lite"))
    expect(lite["pnp.csv"]).not.toBe(all["pnp.csv"])
    expect(lite["bom.csv"]).not.toBe(all["bom.csv"])
    const gerber = (f: Record<string, string>) => Object.entries(f).filter(([k]) => /F_Cu|F_Paste/.test(k)).map(([, v]) => v).join("")
    expect(gerber(lite)).not.toBe(gerber(all))
    expect(lite["fabrication-notes.txt"] ?? Object.values(lite).find((v) => /^VARIANT$/m.test(v))).toMatch(/Variant +Lite/)
  })

  it("a variant the project does not list, and an unknown name, change nothing", () => {
    const p = board()
    expect(setActiveVariant(p, "Nope")).toBe(p)
    const lite = setActiveVariant(p, "Lite")
    expect(setActiveVariant(lite, "Lite")).toBe(lite)
  })
})

describe("variants are keyed by name: a rename, a removal, a copy and an undo keep them consistent", () => {
  it("renaming a variant moves what it changes and the active choice with it", () => {
    let p = setActiveVariant(board(), "Lite")
    p = renameVariant(p, "Lite", "Budget")!
    expect(p.variants).toEqual({ list: [{ name: "Budget", description: "a cheaper build" }, { name: "Full" }], active: "Budget" })
    expect(p.components.flatMap((c) => Object.keys(c.variants ?? {}))).not.toContain("Lite")
    expect(pnpRefs(p)).toEqual(["R3"])
    // a taken or an empty name is refused
    expect(renameVariant(p, "Budget", "Full")).toBeNull()
    expect(renameVariant(p, "Budget", "  ")).toBeNull()
  })

  it("removing a variant removes what it changed, and the active choice when it was that one", () => {
    let p = setActiveVariant(board(), "Lite")
    p = removeVariant(p, "Lite")
    expect(p.variants).toEqual({ list: [{ name: "Full" }] })
    expect(p.components.flatMap((c) => Object.keys(c.variants ?? {}))).toEqual(["Full"])
    expect(pnpRefs(p)).toEqual(["R1", "R2", "R3"])
    expect(removeVariant(removeVariant(p, "Full"), "Full").variants).toBeUndefined()
  })

  it("a part removed or copied takes its changes with it (they are on the part)", () => {
    const p = board()
    const r1 = p.components.find((c) => c.ref === "R1")!
    const copy = { ...r1, id: "copy", ref: "R9" }
    expect(copy.variants).toEqual(r1.variants)
    const without = { ...p, components: p.components.filter((c) => c.id !== r1.id) }
    expect(without.components.flatMap((c) => Object.keys(c.variants ?? {})).includes("Lite")).toBe(true)
    expect(setVariantOverride(p, "nobody", "Lite", { dnp: true })).toBe(p)
  })

  it("an override set back to the symbol's own is removed, so nothing empty is kept", () => {
    let p = board()
    const id = p.components.find((c) => c.ref === "R1")!.id
    p = setVariantOverride(p, id, "Lite", { dnp: null })
    expect(p.components.find((c) => c.ref === "R1")!.variants).toBeUndefined()
    // a change under a variant the project does not list adds the variant
    p = setVariantOverride(p, id, "New", { dnp: true })
    expect(p.variants?.list.map((v) => v.name)).toContain("New")
  })
})

describe("a project with variants is saved and loaded exactly", () => {
  it("what the importer built survives a save and a load, active variant included", () => {
    const text = schematic({ version: 20260306, libs: [LIB_R], symbols: [R("R1", 1, `(variant (name "Lite") (dnp yes) (field (name "Value") (value "0R")))`)] })
    const { project } = load(text)
    const chosen = setActiveVariant(project, "Lite")
    const back = parseProjectFile(serializeProject(chosen), { id: "x" })
    expect(back.variants).toEqual({ list: [{ name: "Lite" }], active: "Lite" })
    expect(back.components[0].variants).toEqual({ Lite: { dnp: true, fields: { Value: "0R" } } })
    expect(JSON.parse(serializeProject(back))).toEqual(JSON.parse(serializeProject(chosen)))
  })

  it("the file stays compact: a project with no variants has none of the fields", () => {
    const written = JSON.parse(serializeProject(board()))
    expect(written.project.variants.list).toHaveLength(2)
    const plain = JSON.parse(serializeProject(addComponent(createProject("p"), "resistor").project))
    expect(plain.project).not.toHaveProperty("variants")
    expect(plain.project.components[0]).not.toHaveProperty("variants")
  })
})

describe("exports: a format with no variants is written from the active variant and says so; KiCad 10 files keep them", () => {
  it("KiCad 9 writes the active variant's flags and values on the symbols, and the report says the variants are not in the files", async () => {
    const { files, notes } = await kicadFiles(setActiveVariant(board(), "Lite"))
    const sch = files[Object.keys(files).find((k) => k.endsWith(".kicad_sch"))!]
    expect(sch).not.toMatch(/\(variant/)
    expect(sch).toMatch(/\(dnp yes\)/)
    expect(sch).toMatch(/"0R/)
    expect(notes.join("\n")).toMatch(/KiCad 9 has no schematic variants: the symbols are written as the active variant "Lite" makes them/)
    expect(notes.join("\n")).toMatch(/the other 1 variant is not in the files/)
  })

  it("with no variant active KiCad 9 writes the symbols as they are and still says so", async () => {
    const { files, notes } = await kicadFiles(board())
    const sch = files[Object.keys(files).find((k) => k.endsWith(".kicad_sch"))!]
    expect(sch).not.toMatch(/\(dnp yes\)/)
    expect(notes.join("\n")).toMatch(/KiCad 9 has no schematic variants: the symbols are written as they are, with no variant active/)
  })

  it("a project with no variants adds no note", async () => {
    const { notes } = await kicadFiles(addComponent(createProject("p"), "resistor").project)
    expect(notes.join("\n")).not.toMatch(/variant/)
  })

  it("Circuit JSON is written from the active variant and says so", () => {
    const lite = projectToCircuitJson(setActiveVariant(board(), "Lite"))
    expect(lite.notes.join("\n")).toMatch(/Circuit JSON has no schematic variants/)
    expect(JSON.stringify(lite.elements)).toMatch(/do_not_place":true/)
    expect(JSON.stringify(projectToCircuitJson(board()).elements)).not.toMatch(/do_not_place":true/)
  })

  const LIB_GNDL = LIB_GND.replace('"power:GND" (power)', '"power:GNDL" (power local)').replace(/"GND_/g, '"GNDL_').replace('"Value" "GND"', '"Value" "GNDL"')
  const withLocalPower = () =>
    schematic({
      version: 20260306,
      libs: [LIB_R, LIB_GNDL],
      symbols: [
        R("R1", 1, `(variant (name "Lite") (dnp yes) (in_bom no) (field (name "Value") (value "0R")))`, "50.8 50.8"),
        { lib: "power:GNDL", at: "50.8 54.61", ref: "#PWR01", uuid: U(9) },
      ],
      wires: [],
    })

  it("a project that is written as KiCad 10 files (it has a local power symbol) keeps its variants in the symbols' instance data", async () => {
    const { project } = load(withLocalPower())
    const { files, notes } = await kicadFiles(setActiveVariant(project, "Lite"))
    const sch = files[Object.keys(files).find((k) => k.endsWith(".kicad_sch"))!]
    // the variant is in the instance, the symbol itself is as it is by itself, and the file is stamped so `in_bom` is read as written
    expect(sch).toMatch(/\(version 20260306\)/)
    expect(sch).toMatch(/\(variant \(name "Lite"\) \(dnp yes\) \(in_bom no\) \(field \(name "Value"\) \(value "0R"\)\)\)/)
    expect(notes.join("\n")).toMatch(/schematic variant is written in the symbols' instance data/)
    const at = sch.indexOf('(reference "R1")')
    const symbol = sch.slice(sch.lastIndexOf("(lib_id", at), at)
    expect(symbol).toMatch(/\(dnp no\)/)
    // read back by the importer the variants are what they were
    const again = importKicadSchematic(sch, { built: new Set([...BUILT_EXTENSIONS, "S2", "S5", "S6", "S10"]) })
    if (again.status !== "imported") throw new Error(`refused: ${again.message}`)
    expect(again.project.components.find((c) => c.ref === "R1")?.variants).toEqual({ Lite: { dnp: true, excludeFromBom: true, fields: { Value: "0R" } } })
  })
})

describe("the importer of a sheet project builds the same variants as a single file", () => {
  it("a project whose sheets have none has none", () => {
    expect(importSheets().project.variants).toBeUndefined()
  })
})

describe("a sheet symbol's variants are followed by the exports too", () => {
  const withSheetVariant = () => {
    const f = sheetFiles([{ uuid: S1, name: "Power", y: 60.96 }])
    f.set("root.kicad_sch", f.get("root.kicad_sch")!.replace(/\(page "2"\)/, `(page "2") (variant (name "Lite") (dnp yes) (in_bom yes))`))
    const r = importKicadSchematic({ files: f, root: "root.kicad_sch" })
    if (r.status !== "imported") throw new Error(r.message)
    return r.project
  }

  it("KiCad 9 writes the sheet symbol's flags as the active variant makes them, and the BOM leaves out the parts below it", async () => {
    const project = setActiveVariant(withSheetVariant(), "Lite")
    const { files } = await kicadFiles(project)
    const root = files[Object.keys(files).find((k) => k.endsWith(".kicad_sch"))!]
    const sheet = root.slice(root.indexOf("(sheet"))
    expect(sheet).toMatch(/\(dnp yes\)/)
    expect(sheet).toMatch(/\(in_bom no\)/)
    expect(sheet).not.toMatch(/\(variant/)
    // the parts on the sheet below are do not populate in the BOM: R2 is not there, R1 on the root is
    const rows = bomCsv(project)
    expect(rows).toMatch(/R1/)
    expect(rows).not.toMatch(/R2/)
    expect(bomCsv(setActiveVariant(project, undefined))).toMatch(/R2/)
  })
})

describe("hostile input", () => {
  it("a symbol with 20,000 variants is read in no more than a moment, and its names are each once", () => {
    const many = Array.from({ length: 20000 }, (_, i) => `(variant (name "V${i}") (dnp yes))`).join(" ")
    const t0 = Date.now()
    const { project } = load(schematic({ version: 20260306, libs: [LIB_R], symbols: [R("R1", 1, many)] }))
    expect(project.variants?.list).toHaveLength(20000)
    expect(Object.keys(project.components[0].variants!)).toHaveLength(20000)
    expect(Date.now() - t0).toBeLessThan(10000)
  })

  it("a variant with no name, a name given twice and a word KiCad does not have are handled by name or by the last", () => {
    const { project } = load(schematic({ version: 20260306, libs: [LIB_R], symbols: [R("R1", 1, `(variant (name "A") (dnp yes)) (variant (name "A") (dnp no)) (variant (name "") (dnp yes))`)] }))
    // the last variant of a name is the one KiCad keeps, and an empty name is no variant of the project
    expect(project.components[0].variants).toBeUndefined()
    expect(project.variants?.list.map((v) => v.name)).toEqual(["A"])
  })
})

{
// S9: what the active variant takes off the board is read as off the board by everything that reads a part's flags: the silkscreen designators (editor, Gerbers and
// 3D board), the counts Sakura reports, the Inspector's.

function board(): Project {
  let p = createProject("v")
  for (const x of [-8, 8]) p = addComponent(p, "resistor", { sch: { x: x / 4, y: 0 }, pcb: { x, y: 0, rot: 0, side: "top", placed: true } }).project
  return { ...p, board: { ...p.board, width: 60, height: 60, x: 0, y: 0 } }
}

describe("a part the active variant takes off the board has no designator", () => {
  it("placeDesignators and getDesignators leave it out, and the cache follows the active variant", () => {
    const p0 = board()
    const r2 = p0.components[1]
    expect(placeDesignators(p0).has(r2.id)).toBe(true)
    const p1 = setActiveVariant(setVariantOverride(p0, r2.id, "NoR2", { notOnBoard: true }), "NoR2")
    expect(placeDesignators(p1).has(r2.id)).toBe(false)
    expect(placeDesignators(p1).has(p0.components[0].id)).toBe(true)
    // the same parts and board with the variant switched: the cached answer is not reused
    expect(getDesignators(p0).has(r2.id)).toBe(true)
    expect(getDesignators(p1).has(r2.id)).toBe(false)
    expect(getDesignators(setActiveVariant(p1, undefined)).has(r2.id)).toBe(true)
  })

  it("Sakura's count of parts still to place does not count a part the variant takes off the board", () => {
    const p0 = board()
    const unplaced = { ...p0, components: p0.components.map((c, i) => (i === 1 ? { ...c, pcb: { ...c.pcb, placed: false } } : c)) }
    const get = (p: Project) => (JSON.parse(runTool(p, "get_design", {}).result) as { checks: { unplaced_on_pcb: number } }).checks.unplaced_on_pcb
    const before = get(unplaced)
    const off = setActiveVariant(setVariantOverride(unplaced, unplaced.components[1].id, "NoR2", { notOnBoard: true }), "NoR2")
    const after = get(off)
    expect(before).toBe(1)
    expect(after).toBe(0)
  })
})
}
