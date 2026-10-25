import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { findPart } from "../src/model/library"
import { importKicadSchematic, type SchematicImportResult } from "../src/model/kicad/schematic"
import { buildSchematicProject, releaseBuild } from "../src/model/kicad/schematic/build"
import { gateSchematic } from "../src/model/kicad/schematic/import"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { LIB_GND, LIB_R, LIB_U, LIB_VCC, ROOT_UUID, divider, schematic, type SchSpec } from "./kicad-schematic-fixtures"

// The importer end to end: the gate (what it refuses and how it says so), the accounting of every
// node, and the project it builds, with the extensions every symbol needs treated as built so the
// build path can be exercised on files that the real gate still refuses.

const SYMBOLS = new Set(["S2", "S5", "S6", "S10"])

/** What the build finds that the model cannot hold, each with its extension, with the symbol extensions treated as built (the gate would otherwise stop first). */
const lossy = (text: string) => {
  const gate = gateSchematic(text, { built: SYMBOLS })
  if ("refused" in gate) throw new Error(gate.refused.message)
  return buildSchematicProject(gate.gate.tree, gate.gate.report, { built: new Set(["S2", "S6", "S10"]) }).lossy.map((n) => [n.ext, n.why])
}

const refused = (r: SchematicImportResult) => {
  if (r.status !== "refused") throw new Error("imported")
  return r
}
const imported = (r: SchematicImportResult) => {
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}
const needsOf = (text: string) => refused(importKicadSchematic(text)).needs.map((n) => n.ext)
const message = (text: string) => refused(importKicadSchematic(text)).message

describe("the gate", () => {
  it("builds nothing of the extensions yet: slice 3a reads, links and checks", () => {
    expect(BUILT_EXTENSIONS.size).toBe(0)
  })

  it("refuses a schematic that uses what the editor cannot hold yet, naming it in plain words, and imports nothing", () => {
    const r = refused(importKicadSchematic(divider()))
    expect(r.reason).toBe("unsupported")
    expect(r.message).toBe("This schematic uses labels and net names as KiCad has them, symbols as KiCad draws them (units, mirrors, hidden power pins, repeated pin numbers), symbol drawings beyond lines and circles and symbols kept in the project, which are not supported yet.")
    expect(r.needs.map((n) => n.ext)).toEqual(["S2", "S5", "S6", "S10"])
    expect(r.report.entries.some((e) => e.code === "unsupported" && e.severity === "refused" && /S5/.test(e.why))).toBe(true)
  })

  const one: [string, SchSpec, string, string][] = [
    ["S1", { body: [`(hierarchical_label "IN" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid h))`] }, "hierarchical sheets", "hierarchical labels"],
    ["S2", { body: [`(global_label "VBUS" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid g))`] }, "labels and net names as KiCad has them", "global labels"],
    ["S3", { body: [`(bus (pts (xy 0 0) (xy 5 0)) (stroke (width 0) (type default)) (uuid b))`] }, "buses", "buses, bus entries or bus aliases"],
    ["S3", { body: [`(bus_alias "DATA" (members "D0" "D1"))`] }, "buses", "buses, bus entries or bus aliases"],
    ["S4", { body: [`(text "hello" (at 1 2 0) (effects (font (size 1.27 1.27))))`] }, "annotations and styled wires", "text, drawings, images or tables"],
    ["S4", { body: [`(rectangle (start 0 0) (end 5 5) (stroke (width 0) (type default)) (fill (type none)))`] }, "annotations and styled wires", "text, drawings, images or tables"],
    ["S8", { body: [`(netclass_flag "" (length 2.54) (shape round) (at 10 10 0) (effects (font (size 1.27 1.27))) (uuid f) (property "Netclass" "Fast" (at 0 0 0)))`] }, "directive labels and rule areas", "directive labels or rule areas"],
    ["S9", { body: [`(symbol_variant_marker (variant (name "A")))`] }, "schematic variants", "schematic variants"],
  ]
  for (const [ext, spec, words, why] of one) {
    it(`${ext}: ${why} are named "${words}"`, () => {
      const text = schematic(spec)
      if (ext === "S9") {
        // variants live in the instance data of a symbol: put one in the cached file as the table's own path says
        const withVariant = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001", extra: "" }] }).replace(`(unit 1)))))`, `(unit 1) (variant (name "A") (dnp yes))))))`)
        expect(needsOf(withVariant)).toContain("S9")
        return
      }
      expect(needsOf(text)).toEqual([ext])
      expect(message(text)).toBe(`This schematic uses ${words}, which are not supported yet.`)
      expect(refused(importKicadSchematic(text)).report.entries.find((e) => e.code === "unsupported")?.why).toContain(`(${ext})`)
    })
  }

  it("S7: a symbol marked do not populate, left out of the BOM or the board, or simulated out", () => {
    const flagged = (extra: string, uuid: string) => schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid, extra }] })
    expect(needsOf(flagged("(dnp yes)", "aaaaaaaa-0000-4000-8000-000000000001"))).toContain("S7")
    expect(needsOf(flagged("(exclude_from_sim yes)", "aaaaaaaa-0000-4000-8000-000000000001"))).toContain("S7")
    expect(needsOf(flagged("(dnp no)", "aaaaaaaa-0000-4000-8000-000000000001"))).not.toContain("S7")
    expect(message(flagged("(dnp yes)", "aaaaaaaa-0000-4000-8000-000000000001"))).toContain("symbol flags such as do not populate")
  })

  it("X19: embedded fonts", () => {
    expect(needsOf(schematic({ version: 20250114, body: [`(embedded_fonts yes)`] }))).toEqual(["X19"])
    expect(message(schematic({ version: 20250114, body: [`(embedded_fonts yes)`] }))).toBe("This schematic uses text outlines or embedded fonts, which are not supported yet.")
    const plain = importKicadSchematic(schematic({ version: 20250114, body: [`(embedded_fonts no)`] }))
    expect(plain.status).toBe("imported")
  })

  it("names every extension a schematic needs in the one sentence", () => {
    const text = schematic({
      body: [`(global_label "A" (shape input) (at 1 1 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid g))`, `(text "t" (at 1 2 0) (effects (font (size 1.27 1.27))))`, `(bus (pts (xy 0 0) (xy 5 0)) (stroke (width 0) (type default)) (uuid b))`],
    })
    expect(needsOf(text)).toEqual(["S2", "S3", "S4"])
    expect(message(text)).toBe("This schematic uses labels and net names as KiCad has them, buses and annotations and styled wires, which are not supported yet.")
  })

  it("a schematic that needs nothing the editor lacks is imported: wires, junctions, labels and no-connects", () => {
    const r = imported(importKicadSchematic(schematic({ wires: ["10 10 20 10", "20 10 20 20", "15 10 15 5"], junctions: ["15 10"], labels: ["SIG 20 20 0"] })))
    // the first wire is cut at the junction on its body
    expect(r.project.wires.map((w) => w.points)).toEqual([
      [{ x: 0.7874, y: -0.7874 }, { x: 1.1811, y: -0.7874 }],
      [{ x: 1.1811, y: -0.7874 }, { x: 1.5748, y: -0.7874 }],
      [{ x: 1.5748, y: -0.7874 }, { x: 1.5748, y: -1.5748 }],
      [{ x: 1.1811, y: -0.7874 }, { x: 1.1811, y: -0.3937 }],
    ])
    expect(r.project.labels.map((l) => [l.name, l.x, l.y, l.rot])).toEqual([["SIG", 1.5748, -1.5748, 0]])
    const nets = computeConnectivity(r.project)
    expect(nets.nets.map((n) => [n.name, n.named])).toEqual([["SIG", true]])
    expect(nets.wireNet.size).toBe(4)
  })

  it("an empty sheet is imported", () => {
    const r = imported(importKicadSchematic(schematic({ version: 20230121 })))
    expect(r.project.components).toEqual([])
    expect(r.project.properties?.map((p) => p.key)).toEqual(["Imported from", "KiCad file version"])
    expect(r.bytes).toBeGreaterThan(0)
  })

  it("the title block is the project's name and properties", () => {
    const head = `(title_block (title "Demo board") (date "2026-01-01") (rev "B") (company "Acme") (comment 1 "first") (comment 2 "second"))`
    const r = imported(importKicadSchematic(schematic({ head })))
    expect(r.project.name).toBe("Demo board")
    expect(r.project.properties).toEqual([
      { key: "Imported from", value: "KiCad 7" },
      { key: "KiCad file version", value: "file version 20230121" },
      { key: "Date", value: "2026-01-01" },
      { key: "Rev", value: "B" },
      { key: "Company", value: "Acme" },
      { key: "Comment1", value: "first" },
      { key: "Comment2", value: "second" },
    ])
    expect(imported(importKicadSchematic(schematic({ head }), { name: "Mine" })).project.name).toBe("Mine")
    // the title is kept as a property when the caller names the project
    expect(imported(importKicadSchematic(schematic({ head }), { name: "Mine" })).project.properties?.some((p) => p.key === "Title")).toBe(true)
  })

  it("refuses a file that is not a schematic, with the reason in the message", () => {
    const r = refused(importKicadSchematic(`(kicad_pcb (version 20240108))`))
    expect(r.reason).toBe("unreadable")
    expect(r.message).toBe("This is a KiCad board, not a schematic (.kicad_sch).")
    expect(r.tree).toBeNull()
    expect(refused(importKicadSchematic("")).message).toBe("The file is empty.")
    expect(refused(importKicadSchematic(divider().slice(0, 900))).message).toMatch(/cut short/)
  })

  it("a missing sheet file is a refusal that names it", () => {
    const text = schematic({ body: [`(sheet (at 10 10) (size 20 10) (uuid s1) (property "Sheetname" "Power" (at 0 0 0)) (property "Sheetfile" "power.kicad_sch" (at 0 0 0)))`] })
    const r = refused(importKicadSchematic(text))
    expect(r.reason).toBe("unreadable")
    expect(r.message).toBe(`the sheet "Power" (power.kicad_sch) is not among the files, so its pages are missing.`)
    expect(r.report.entries.some((e) => e.code === "sheet-missing" && e.severity === "refused")).toBe(true)
    expect(r.needs.map((n) => n.ext)).toContain("S1")
  })

  it("a project with its sheets is read whole, and refused for what it needs, not for the files", () => {
    const files = new Map([
      ["root.kicad_sch", schematic({ uuid: "r", body: [`(sheet (at 10 10) (size 20 10) (uuid s1) (property "Sheetname" "Power" (at 0 0 0)) (property "Sheetfile" "power.kicad_sch" (at 0 0 0)))`] })],
      ["power.kicad_sch", schematic({ uuid: "p", body: [`(hierarchical_label "VIN" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid h))`] })],
    ])
    const r = refused(importKicadSchematic({ files, root: "root.kicad_sch" }))
    expect(r.reason).toBe("unsupported")
    expect(r.tree?.files.size).toBe(2)
    expect(r.needs.map((n) => n.ext)).toEqual(["S1"])
    expect(r.message).toBe("This schematic uses hierarchical sheets, which are not supported yet.")
  })

  it("a schematic whose project would be over the size limit is refused, saying how big it is", () => {
    const r = refused(importKicadSchematic(schematic({ wires: ["10 10 20 10"] }), { limitBytes: 100 }))
    expect(r.reason).toBe("too-large")
    expect(r.message).toMatch(/^This schematic needs \d+ KB and projects hold up to 0 KB\.$/)
  })
})

describe("what the importer finds on top of the census's rules", () => {
  const wired = (extra: string) => schematic({ wires: ["10 10 20 10"], body: [extra] })
  const label = (size: string, justify = "left bottom") => `(label "A" (at 10 10 0) (effects (font (size ${size} ${size})) (justify ${justify})) (uuid l))`

  it("S2: a local label of its own size, justification, italic or bold, or with fields", () => {
    expect(needsOf(wired(label("1.524")))).toEqual(["S2"])
    expect(needsOf(wired(label("1.27", "right bottom")))).toEqual(["S2"])
    expect(needsOf(wired(`(label "A" (at 10 10 0) (effects (font (size 1.27 1.27) italic) (justify left bottom)) (uuid l))`))).toEqual(["S2"])
    expect(needsOf(wired(`(label "A" (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid l) (property "Netclass" "x" (at 0 0 0)))`))).toEqual(["S2"])
    expect(importKicadSchematic(wired(label("1.27"))).status).toBe("imported")
    const why = refused(importKicadSchematic(wired(label("1.524")))).needs[0]
    expect([why.ext, why.source, why.why]).toEqual(["S2", "importer", `the node "label>effects"`])
  })

  it("S4: a wire of its own width, line style or colour", () => {
    const wire = (stroke: string) => schematic({ body: [`(wire (pts (xy 0 0) (xy 5 0)) ${stroke} (uuid w))`] })
    expect(needsOf(wire("(stroke (width 0.5) (type default))"))).toEqual(["S4"])
    expect(needsOf(wire("(stroke (width 0) (type dash))"))).toEqual(["S4"])
    expect(needsOf(wire("(stroke (width 0) (type default) (color 255 0 0 1))"))).toEqual(["S4"])
    expect(importKicadSchematic(wire("(stroke (width 0) (type default) (color 0 0 0 0))")).status).toBe("imported")
    expect(importKicadSchematic(wire("(stroke (width 0) (type solid))")).status).toBe("imported")
  })

  it("S7: a symbol left out of the position files", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001", extra: "(in_pos_files no)" }] })
    const r = refused(importKicadSchematic(text))
    expect(r.needs.find((n) => n.ext === "S7")?.source).toBe("importer")
  })

  it("S1: a symbol used on a sheet other than this one, or used twice", () => {
    const sym = { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }
    const own = schematic({ libs: [LIB_R], symbols: [sym] })
    expect(needsOf(own)).not.toContain("S1")
    // used on a sheet below the root, and a second time
    expect(needsOf(own.replace(`(path "/${ROOT_UUID}"`, `(path "/${ROOT_UUID}/sheet1"`))).toContain("S1")
    expect(needsOf(own.replace(`(instances`, `(instances (project "demo" (path "/${ROOT_UUID}/sheet2" (reference "R9") (unit 1)))`))).toContain("S1")
    // the instance of another project that shares the sheet is not this project's, and is a note
    const foreign = own.replace(`(instances`, `(instances (project "other" (path "/ffffffff-0000-4000-8000-000000000009" (reference "R7") (unit 1)))`)
    const r = refused(importKicadSchematic(foreign))
    expect(r.needs.map((n) => n.ext)).not.toContain("S1")
    expect(r.report.entries.find((e) => e.code === "other-projects-instances")?.count).toBe(1)
  })

  it("S5, S6 and S10 also for symbols in the cache that no symbol is placed from", () => {
    const r = refused(importKicadSchematic(schematic({ libs: [LIB_R] })))
    expect(r.needs.map((n) => [n.ext, n.source])).toEqual([
      ["S5", "importer"],
      ["S6", "importer"],
      ["S10", "importer"],
    ])
  })

  it("the root's own sheet_instances, in the spelling of either release, say nothing", () => {
    expect(importKicadSchematic(schematic()).status).toBe("imported")
    expect(importKicadSchematic(schematic().replace(`(path "/" (page "1"))`, `(path "/${ROOT_UUID}" (page "1"))`)).status).toBe("imported")
    expect(needsOf(schematic().replace(`(path "/" (page "1"))`, `(path "/${ROOT_UUID}" (page "1")) (path "/${ROOT_UUID}/x" (page "2"))`))).toEqual(["S1"])
  })
})

describe("the accounting of every node", () => {
  const account = (text: string) => refused(importKicadSchematic(text)).report.account!
  const total = (a: ReturnType<typeof account>) =>
    a.imported + [...a.notNeeded.values(), ...a.pending.values(), ...a.unknownPaths.values()].reduce((x, y) => x + y, 0) + a.reported

  it("every node is imported, not needed with a reason, pending an extension, or reported: the states add up", () => {
    const a = account(divider())
    expect(a.unknownPaths.size).toBe(0)
    expect(a.unknownAtoms.size).toBe(0)
    expect(total(a)).toBe(a.total)
    expect(a.pending.get("S5")).toBeGreaterThan(0)
    expect(a.imported).toBeGreaterThan(0)
    expect(a.notNeeded.get("sheet size of KiCad's drawing frame")).toBe(1)
  })

  it("a plain file puts its extension nodes where they belong: derived or built, not pending", () => {
    const r = imported(importKicadSchematic(schematic({ wires: ["10 10 20 10"], labels: ["A 10 10 0"] })))
    const a = r.report.account!
    expect(total(a)).toBe(a.total)
    expect(a.pending.size).toBe(0)
    expect([...a.notNeeded.keys()]).toContain("every wire is drawn at the editor's one width and colour")
    expect([...a.notNeeded.keys()]).toContain("a label is drawn at the editor's text size and turned with its angle")
    expect([...a.notNeeded.keys()]).toContain("the page number of the one sheet")
  })

  it("a node the table does not know refuses the file, naming it", () => {
    const r = refused(importKicadSchematic(schematic({ body: [`(frobnicate (at 1 2))`] })))
    expect(r.reason).toBe("unknown")
    expect(r.message).toBe(`This schematic has something this importer does not know yet: the node "frobnicate".`)
    expect(r.report.entries.find((e) => e.code === "unknown-node")).toMatchObject({ severity: "refused", object: `the node "frobnicate"`, count: 1 })
  })

  it("a node of a known list that the table does not know is named with its place", () => {
    const r = refused(importKicadSchematic(schematic({ wires: ["1 1 2 2"] }).replace("(uuid w0)", "(uuid w0) (sparkle 1)")))
    expect(r.reason).toBe("unknown")
    expect(r.message).toContain(`the node "wire>sparkle"`)
  })

  it("a word the table does not know in a list it covers refuses the file, naming the word and the list", () => {
    const lib = `(symbol "T:X" (symbol "X_1_1" (pin teleporting line (at 0 0 0) (length 1) (name "A") (number "1"))))`
    const r = refused(importKicadSchematic(schematic({ libs: [lib] })))
    expect(r.reason).toBe("unknown")
    expect(r.message).toBe(`This schematic has something this importer does not know yet: the word "teleporting" in "lib_symbols>symbol>symbol>pin".`)
    // a bare word in a list the table has no atoms for is a name the file's author chose: `generator eeschema`
    expect(imported(importKicadSchematic(schematic({ version: 20211123 }))).report.account!.unknownAtoms.size).toBe(0)
  })

  it("says how many unknown things there are, and names the first three", () => {
    const r = refused(importKicadSchematic(schematic({ body: [`(a1)`, `(a2)`, `(a3)`, `(a4)`] })))
    expect(r.message).toBe(`This schematic has things this importer does not know yet: the node "a1", the node "a2", the node "a3" and more.`)
  })

  it("reports the nodes that cannot be represented, and each embedded file by name", () => {
    const text = schematic({
      version: 20250114,
      body: [`(net_chain (nets "A" "B"))`, `(embedded_files (file (name "datasheet.pdf") (type datasheet) (data |abc|) (checksum "x")) (file (name "model.step") (type model) (data |abc|) (checksum "y")))`],
    })
    const r = imported(importKicadSchematic(text))
    expect(r.report.entries.find((e) => e.code === "not-representable")?.object).toBe(`the node "net_chain"`)
    expect(r.report.entries.filter((e) => e.code === "embedded-file-not-brought").map((e) => e.object)).toEqual(["the embedded file datasheet.pdf (datasheet) in schematic.kicad_sch", "the embedded file model.step (model) in schematic.kicad_sch"])
  })

  it("the accounting counts the nodes of every sheet", () => {
    const files = new Map([
      ["root.kicad_sch", schematic({ uuid: "r", wires: ["1 1 2 2"], body: [`(sheet (at 10 10) (size 20 10) (uuid s1) (property "Sheetname" "A" (at 0 0 0)) (property "Sheetfile" "a.kicad_sch" (at 0 0 0)))`] })],
      ["a.kicad_sch", schematic({ uuid: "a", wires: ["1 1 2 2", "3 3 4 4"] })],
    ])
    const a = refused(importKicadSchematic({ files, root: "root.kicad_sch" })).report.account!
    expect(a.paths.get("wire")).toBe(3)
    expect(total(a)).toBe(a.total)
  })
})

describe("every node counted as imported is one the builder writes", () => {
  // The `native` rows of the table, and the extension rows the file does not need and the builder
  // carries, are counted as imported. This builds a file that has every kind of them and says, for each
  // path counted, where in the project it went: a path that is not here is a node counted without being
  // written, and the test fails until the builder or the table is fixed.
  const text = schematic({
    version: 20250114,
    head: `(title_block (title "T") (date "d") (rev "1") (company "C") (comment 1 "c"))`,
    libs: [LIB_R, LIB_GND, LIB_VCC],
    symbols: [
      { lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "R_0603", uuid: "aaaaaaaa-0000-4000-8000-000000000001" },
      { lib: "power:GND", at: "80 76.2", ref: "#PWR02", value: "GND", uuid: "aaaaaaaa-0000-4000-8000-000000000002" },
    ],
    wires: ["50.8 54.61 50.8 70", "50.8 59.69 60.96 59.69"],
    junctions: ["50.8 59.69"],
    noConnects: ["50.8 46.99"],
    labels: ["MID 60.96 59.69 0"],
    body: [`(group "Divider" (uuid g1) (members aaaaaaaa-0000-4000-8000-000000000001 aaaaaaaa-0000-4000-8000-000000000002))`],
  })
  const built = imported(importKicadSchematic(text, { built: SYMBOLS }))

  /** Where each counted path went. */
  const carried: Record<string, (r: typeof built) => boolean> = {
    version: (r) => r.project.properties?.some((p) => p.key === "KiCad file version" && p.value.includes("20250114")) === true,
    generator: (r) => r.project.properties?.some((p) => p.key === "Imported from") === true,
    generator_version: (r) => r.project.properties?.some((p) => p.value.startsWith("KiCad 8.0")) === true,
    uuid: () => true, // the sheet's id: the first part of every instance path, used to link footprints (`link.ts`), not stored
    title_block: (r) => r.project.name === "T",
    "title_block>title": (r) => r.project.name === "T",
    "title_block>date": (r) => r.project.properties?.some((p) => p.key === "Date") === true,
    "title_block>rev": (r) => r.project.properties?.some((p) => p.key === "Rev") === true,
    "title_block>company": (r) => r.project.properties?.some((p) => p.key === "Company") === true,
    "title_block>comment": (r) => r.project.properties?.some((p) => p.key === "Comment1") === true,
    lib_symbols: (r) => r.project.components.length === 2,
    symbol: (r) => r.project.components.length === 2,
    "symbol>at": (r) => r.project.components.some((c) => c.ref === "R1" && c.sch.x === 4 && c.sch.y === -4),
    "symbol>lib_id": (r) => r.project.components.some((c) => findPart(c.partId)?.name === "R"),
    "symbol>uuid": (r) => r.build.bySymbol.size === 2,
    "symbol>in_bom": () => true, // the default flag, derived
    wire: (r) => r.project.wires.length >= 2,
    "wire>pts": (r) => r.project.wires.every((w) => w.points.length === 2),
    "wire>pts>xy": (r) => r.project.wires.every((w) => w.points.length === 2),
    "wire>uuid": () => true,
    junction: (r) => r.project.wires.length === 3, // the wire is cut at it
    "junction>at": (r) => r.project.wires.length === 3,
    "junction>uuid": () => true,
    no_connect: (r) => r.project.components.some((c) => c.ref === "R1" && c.nc?.includes("1")),
    "no_connect>at": (r) => r.project.components.some((c) => c.nc?.includes("1")),
    "no_connect>uuid": () => true,
    label: (r) => r.project.labels.length === 1,
    "label>at": (r) => r.project.labels[0].x > 0,
    "label>uuid": () => true,
    group: (r) => r.project.blocks?.[0]?.name === "Divider",
    "group>members": (r) => r.project.blocks?.[0]?.components.length === 2,
    "group>uuid": () => true,
  }

  it("each such path went to the project", () => {
    const a = built.report.account!
    const natives = [...a.importedPaths.keys()].filter((p) => !/^(lib_symbols|symbol)>(?!at$|lib_id$|uuid$|in_bom$)/.test(p) && !p.startsWith("symbol>property") && !p.startsWith("symbol>pin") && !p.startsWith("symbol>instances") && !p.startsWith("sheet_instances"))
    const missing = natives.filter((p) => !(p in carried))
    expect(missing).toEqual([])
    for (const p of natives) expect(carried[p](built), p).toBe(true)
  })

  it("the cached symbols' own nodes are the parts' pins and drawing, and a symbol's fields are its properties", () => {
    const r1 = built.project.components.find((c) => c.ref === "R1")!
    expect(r1.props).toEqual({ value: "10k", Footprint: "R_0603" })
    const part = findPart(r1.partId)!
    expect(part.pins.map((p) => p.number)).toEqual(["1", "2"])
    expect(part.symbol.ports.map((p) => [p.pin, p.x, p.y, p.dir])).toEqual([
      ["1", 0, 0.3, "up"],
      ["2", 0, -0.3, "down"],
    ])
    expect(part.symbol.primitives.length).toBeGreaterThan(0)
  })
})

describe("the build", () => {
  it("makes the editor's own power ports of power symbols, turned so their pin is where KiCad has it", () => {
    const r = imported(importKicadSchematic(divider(), { built: SYMBOLS }))
    const gnd = r.project.components.find((c) => c.ref === "#PWR02")!
    const vcc = r.project.components.find((c) => c.ref === "#PWR01")!
    expect([gnd.partId, gnd.props.net, gnd.sch.rot]).toEqual(["ground", "GND", 0])
    expect([vcc.partId, vcc.props.net, vcc.sch.rot]).toEqual(["power", "VCC", 0])
    expect(findPart(gnd.partId)!.powerNet).toBe("GND")
    // the pin of VCC at (50.8, 43.18) mm: the editor's power port is 0.2 below its origin
    expect([vcc.sch.x, vcc.sch.y]).toEqual([4, -3.2])
  })

  it("takes a symbol's reference from its instance, and its other fields as properties", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] }).replace(`(reference "R1")`, `(reference "R42")`)
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.project.components[0].ref).toBe("R42")
  })

  it("KiCad 6 keeps a symbol's real value and footprint in the root list: they stand in place of the fields, and the list does not make the file need S1", () => {
    const sym = { lib: "Device:R", at: "50.8 50.8", ref: "D5", value: "", uuid: "aaaaaaaa-0000-4000-8000-000000000001", footprint: "" }
    const text = schematic({ version: 20211123, libs: [LIB_R], symbols: [sym], rootEntries: [`/${sym.uuid}|D5|red|Local:LED_D3.0mm`] })
    expect(needsOf(text)).toEqual(["S2", "S5", "S6", "S10"])
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.project.components[0].props).toEqual({ value: "red", Footprint: "Local:LED_D3.0mm" })
    // before 20230221 a global power symbol is named by its hidden pin, whatever the instance's value says
    const gnd = schematic({ version: 20211123, libs: [LIB_GND], symbols: [{ lib: "power:GND", at: "50.8 76.2", ref: "#PWR01", value: "GND", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }], rootEntries: [`/aaaaaaaa-0000-4000-8000-000000000002|#PWR01|GND2`] })
    expect(imported(importKicadSchematic(gnd, { built: SYMBOLS })).project.components[0].props.net).toBe("GND")
  })

  it("a symbol whose drawing is not in the cache needs the symbol sources slice (S12), with the symbol named", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:C", at: "50.8 50.8", ref: "C1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    const r = refused(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.reason).toBe("unsupported")
    expect(r.message).toBe("This schematic uses symbols from a project's own libraries or the parts database, which are not supported yet.")
    expect(r.needs.map((n) => n.ext)).toEqual(["S12"])
    expect(r.report.entries.find((e) => e.code === "symbol-not-in-cache")?.object).toBe("1 symbol (Device:C)")
  })

  it("a symbol with a pin that has no number needs S5: no pad can be paired with it", () => {
    const lib = `(symbol "T:V" (property "Reference" "V" (at 0 0 0)) (symbol "V_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "A") (number "~"))))`
    const text = schematic({ libs: [lib], symbols: [{ lib: "T:V", at: "50.8 50.8", ref: "V1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    expect(lossy(text)).toContainEqual(["S5", "a pin with no number, which no pad can be paired with"])
  })

  it("pins that share a number need S5, whether KiCad jumpers them or flags them", () => {
    const lib = `(symbol "T:D" (property "Reference" "D" (at 0 0 0)) (symbol "D_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "A") (number "12")) (pin passive line (at 5 0 0) (length 2.54) (name "B") (number "12"))))`
    const text = schematic({ libs: [lib], symbols: [{ lib: "T:D", at: "50.8 50.8", ref: "U1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    expect(lossy(text)).toContainEqual(["S5", "pins that share a number: one pin to KiCad when they are jumpered, an error when not"])
    expect(lossy(text).filter(([ext]) => ext === "S11")).toEqual([])
  })

  it("a symbol turned by other than a quarter turn is unreadable, as KiCad's parser rejects it", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8 45", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    const r = refused(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.reason).toBe("unreadable")
    expect(r.message).toBe("A symbol is turned by 45 degrees, which KiCad does not read: a symbol turns 0, 90, 180 or 270 degrees.")
  })

  it("a mirrored symbol is built as a part of its own, so the editor's pins are where KiCad's are", () => {
    const text = schematic({ libs: [LIB_U], symbols: [{ lib: "Test:U", at: "100 100", ref: "U1", uuid: "aaaaaaaa-0000-4000-8000-000000000001", mirror: "y" }, { lib: "Test:U", at: "130 100", ref: "U2", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }] })
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    const [u1, u2] = r.project.components
    expect(u1.partId).not.toBe(u2.partId)
    expect(u1.sch.rot).toBe(0)
    // the part with no pin 3: it is a no-connect pin and has no port
    expect(findPart(u1.partId)!.symbol.ports.map((p) => p.pin)).toEqual(["1", "2"])
    expect(findPart(u1.partId)!.pins.map((p) => p.number)).toEqual(["1", "2", "3"])
  })

  it("a group becomes a block of its symbols, and says what of the group is not in it", () => {
    const text = schematic({
      libs: [LIB_R],
      symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }],
      wires: ["50.8 54.61 50.8 60"],
      body: [`(group "Part" (uuid g1) (members aaaaaaaa-0000-4000-8000-000000000001 w0))`],
    })
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.project.blocks?.map((b) => [b.name, b.components.length])).toEqual([["Part", 1]])
    expect(r.report.entries.find((e) => e.code === "group-member-not-in-block")?.count).toBe(1)
  })

  it("reads every release's divider to the same project", () => {
    const shape = (v: number) => {
      const r = imported(importKicadSchematic(divider(v), { built: SYMBOLS }))
      const nets = computeConnectivity(r.project)
      return [r.project.components.map((c) => [c.ref, c.sch.x, c.sch.y]), r.project.wires.length, nets.nets.map((n) => [n.name, n.pins.map((p) => `${p.componentId ? r.project.components.find((c) => c.id === p.componentId)!.ref : ""}.${p.pin}`)])]
    }
    const base = JSON.stringify(shape(20230121))
    for (const v of [20211123, 20231120, 20250114, 20250227, 20260306]) expect(JSON.stringify(shape(v)), `${v}`).toBe(base)
  })

  it("the nets of the divider by the editor's own connectivity", () => {
    const r = imported(importKicadSchematic(divider(), { built: SYMBOLS }))
    const c = computeConnectivity(r.project)
    const ref = (key: string) => {
      const at = key.lastIndexOf(":")
      return `${r.project.components.find((x) => x.id === key.slice(0, at))!.ref}.${key.slice(at + 1)}`
    }
    const byNet = new Map<string, string[]>()
    for (const [key, net] of c.pinNet) byNet.set(net, [...(byNet.get(net) ?? []), ref(key)].sort())
    expect([...byNet].sort()).toEqual([
      ["net:GND", ["#PWR02.1", "R2.2"]],
      ["net:MID", ["R1.2", "R2.1"]],
      ["net:VCC", ["#PWR01.1", "R1.1"]],
    ])
    expect(c.pinNet.get(pinKey(r.project.components.find((x) => x.ref === "R2")!.id, "2"))).toBe("net:GND")
  })
})

describe("what each flag and field of the file needs, so that nothing imported is lost", () => {
  const node = (text: string) => schematic({ body: [text] })

  it("a junction with a size or colour of its own is S4; the default dot is imported", () => {
    expect(needsOf(node(`(junction (at 10 10) (diameter 1) (color 0 0 0 0) (uuid j))`))).toEqual(["S4"])
    expect(needsOf(node(`(junction (at 10 10) (diameter 0) (color 255 0 0 1) (uuid j))`))).toEqual(["S4"])
    expect(importKicadSchematic(node(`(junction (at 10 10) (diameter 0) (color 0 0 0 0) (uuid j))`)).status).toBe("imported")
  })

  it("a no-connect flag that is not on a pin of a placed symbol is S4, and one on a pin is imported", () => {
    expect(needsOf(schematic({ noConnects: ["10 10"] }))).toEqual(["S4"])
    const on = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }], noConnects: ["50.8 46.99"] })
    expect(imported(importKicadSchematic(on, { built: SYMBOLS })).project.components[0].nc).toEqual(["1"])
  })

  it("a symbol that jumpers pins of one number is S5 even when no symbol is placed from it", () => {
    const lib = `(symbol "T:J" (duplicate_pin_numbers_are_jumpers yes) (symbol "J_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "A") (number "1"))))`
    expect(needsOf(schematic({ libs: [lib] }))).toContain("S5")
  })

  it("a locked group is S4: the editor's blocks cannot be locked", () => {
    expect(needsOf(node(`(group "G" (uuid g1) (locked yes) (members))`))).toEqual(["S4"])
    expect(importKicadSchematic(node(`(group "G" (uuid g1) (members))`)).status).toBe("imported")
  })

  it("a page number other than 1 on the root sheet is S1", () => {
    expect(needsOf(schematic().replace(`(page "1")`, `(page "7")`))).toEqual(["S1"])
    expect(importKicadSchematic(schematic()).status).toBe("imported")
  })
})

describe("numbers and turns the file gets wrong are unreadable, not read as zero", () => {
  const read = (text: string) => refused(importKicadSchematic(text))

  it("a coordinate that is not a number, or not finite, or absurdly large", () => {
    for (const bad of ["abc", "1e400", "NaN", "1e9"]) {
      const r = read(schematic({ body: [`(wire (pts (xy ${bad} 0) (xy 5 0)) (stroke (width 0) (type default)) (uuid w))`] }))
      expect(r.reason, bad).toBe("unreadable")
      expect(r.message, bad).toMatch(/number/)
    }
  })

  it("a mirror that says both axes is unreadable", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] }).replace("(unit 1) (in_bom", "(mirror x y) (unit 1) (in_bom")
    expect(read(text).reason).toBe("unreadable")
  })

  it("a project whose root sheet is not among the files is named as a missing root", () => {
    const r = refused(importKicadSchematic({ files: new Map([["a/other.kicad_sch", schematic()]]), root: "demo.kicad_sch" }))
    expect(r.reason).toBe("unreadable")
    expect(r.message).toBe("The schematic demo.kicad_sch is not among the files.")
    expect(r.report.entries.some((e) => e.code === "missing-root")).toBe(true)
  })
})

describe("the size of what is read is bounded", () => {
  it("forty thousand uses of a missing sheet are one error and are read in a moment", () => {
    const sheet = (i: number) => `(sheet (at 10 ${i}) (size 20 10) (uuid s${i}) (property "Sheetname" "S${i}" (at 0 0 0)) (property "Sheetfile" "gone.kicad_sch" (at 0 0 0)))`
    const text = schematic({ body: Array.from({ length: 40000 }, (_, i) => sheet(i)) })
    const t0 = Date.now()
    const r = importKicadSchematic({ files: new Map([["demo.kicad_sch", text]]), root: "demo.kicad_sch" })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(r.status).toBe("refused")
    expect(r.report.entries.filter((e) => e.code === "sheet-missing" || /gone\.kicad_sch/.test(e.why)).length).toBe(1)
  })

  it("wires that make the nets costly to read are refused before the build, in a moment: 2,000 on one line, and 24,000 anywhere", () => {
    const line = schematic({ wires: Array.from({ length: 2000 }, (_, i) => `${i} 0 ${i + 1} 0`) })
    const t0 = Date.now()
    const r = refused(importKicadSchematic(line, { built: SYMBOLS }))
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.reason).toBe("too-large")
    expect(r.report.entries.some((e) => e.code === "too-costly")).toBe(true)
    expect(r.message).toMatch(/^This schematic is too large to import: it has wires that run along the same lines in such numbers, or are so long, that the editor would need minutes to read its nets, and a sheet this big would be over the 900 KB project limit anyway/)
    const spread = schematic({ wires: Array.from({ length: 24000 }, (_, i) => `${(i % 200) * 10} ${Math.floor(i / 200) * 7} ${(i % 200) * 10 + 5} ${Math.floor(i / 200) * 7}`) })
    const t1 = Date.now()
    expect(refused(importKicadSchematic(spread, { built: SYMBOLS })).reason).toBe("too-large")
    expect(Date.now() - t1).toBeLessThan(2000)
    // a sheet well inside the budgets is built
    const fine = schematic({ wires: Array.from({ length: 300 }, (_, i) => `${i} 0 ${i + 1} 0`) })
    expect(importKicadSchematic(fine, { built: SYMBOLS }).status).toBe("imported")
  })

  it("a schematic with more objects than the limit is refused with the count", () => {
    const r = refused(importKicadSchematic(divider(), { built: SYMBOLS, maxObjects: 3 }))
    expect(r.reason).toBe("too-large")
    expect(r.report.entries.some((e) => e.code === "too-many-objects")).toBe(true)
    expect(r.message).toMatch(/^This schematic is too large to import: it has \d+ drawn objects .* over the 900 KB project limit anyway\.$/)
  })

  it("parts registered to check a build are taken out again when the import is refused", () => {
    // a symbol of its own, so that no other test has registered its part; a wire end on another wire's side is S11, which the build cannot hold
    const lib = LIB_R.replace(/Device:R/g, "Unique:ZQ")
    const text = schematic({
      libs: [lib],
      symbols: [{ lib: "Unique:ZQ", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }],
      wires: ["30 80 60 80", "45 70 45 80"].map((w) => w),
    })
    const r = refused(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.needs.map((n) => n.ext)).toContain("S11")
    // the build, run again, finds nothing of its parts in memory: the refusal took them out
    const gate = gateSchematic(text, { built: SYMBOLS })
    if ("refused" in gate) throw new Error(gate.refused.message)
    const build = buildSchematicProject(gate.gate.tree, gate.gate.report, { built: new Set(["S2", "S5", "S6", "S10"]) })
    expect(build.registered.length).toBeGreaterThan(0)
    releaseBuild(build)
    for (const id of build.registered) expect(findPart(id)).toBeUndefined()
  })
})
