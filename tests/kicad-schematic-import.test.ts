import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
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
const needsOf = (text: string) => {
  const r = importKicadSchematic(text)
  return r.status === "refused" ? r.needs.map((n) => n.ext) : []
}
const message = (text: string) => refused(importKicadSchematic(text)).message

describe("the gate", () => {
  it("builds what every symbol needs (S5, S6, S10) and labels and net names (S2), annotations (S4), symbol flags (S7), buses (S3), directive labels and rule areas (S8), variants (S9), KiCad's joining rules (S11) and libraries (S12)", () => {
    expect([...BUILT_EXTENSIONS].sort()).toEqual(["S1", "S10", "S11", "S12", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"])
  })

  it("imports a divider: KiCad's net names are the project's rule now", () => {
    expect(imported(importKicadSchematic(divider())).project.netNames).toBe("kicad")
  })

  it("refuses a schematic that uses what the editor cannot hold yet, naming it in plain words, and imports nothing", () => {
    // S8 is built: a build without it is what refuses.
    const r = refused(importKicadSchematic(schematic({ body: [`(netclass_flag "" (length 2.54) (shape round) (at 10 10 0) (effects (font (size 1.27 1.27))) (uuid f) (property "Netclass" "Fast" (at 0 0 0)))`] }), { built: new Set([...BUILT_EXTENSIONS].filter((x) => x !== "S8")) }))
    expect(r.reason).toBe("unsupported")
    expect(r.message).toBe("This schematic uses directive labels and rule areas, which are not supported yet.")
    expect(r.needs.map((n) => n.ext)).toEqual(["S8"])
    expect(r.report.entries.some((e) => e.code === "unsupported" && e.severity === "refused" && /S8/.test(e.why))).toBe(true)
  })

  const one: [string, SchSpec, string, string][] = [
    ["S8", { body: [`(netclass_flag "" (length 2.54) (shape round) (at 10 10 0) (effects (font (size 1.27 1.27))) (uuid f) (property "Netclass" "Fast" (at 0 0 0)))`] }, "directive labels and rule areas", "directive labels or rule areas"],
    ["S9", { body: [`(symbol_variant_marker (variant (name "A")))`] }, "schematic variants", "schematic variants"],
  ]
  for (const [ext, spec, words, why] of one) {
    it(`${ext}: ${why} are named "${words}"`, () => {
      const text = schematic(spec)
      if (ext === "S9") {
        // variants live in the instance data of a symbol: put one in the cached file as the table's own path says
        const withVariant = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001", extra: "" }] }).replace(`(unit 1)))))`, `(unit 1) (variant (name "A") (dnp yes))))))`)
        // S9 is built: it imports, with the variant; named not built, the same file is refused naming schematic variants
        expect(needsOf(withVariant)).toEqual([])
        const without = importKicadSchematic(withVariant, { built: new Set([...BUILT_EXTENSIONS].filter((x) => x !== "S9")) })
        expect(without.status).toBe("refused")
        if (without.status === "refused") expect(without.message).toBe("This schematic uses schematic variants, which are not supported yet.")
        return
      }
      // An extension that is built is imported (S8 is); the table's sentence is what a build without it says.
      const built = new Set([...BUILT_EXTENSIONS].filter((x) => x !== ext))
      const r = refused(importKicadSchematic(text, { built }))
      expect(r.needs.map((n) => n.ext)).toEqual([ext])
      expect(r.message).toBe(`This schematic uses ${words}, which are not supported yet.`)
      expect(r.report.entries.find((e) => e.code === "unsupported")?.why).toContain(`(${ext})`)
    })
  }

  it("S7: a symbol marked do not populate, left out of the BOM or the board, or simulated out, is imported with its flags", () => {
    const flagged = (extra: string, uuid: string) => schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid, extra }] })
    const flags = (extra: string) => imported(importKicadSchematic(flagged(extra, "aaaaaaaa-0000-4000-8000-000000000001"))).project.components[0].flags
    expect(flags("(dnp yes)")).toEqual({ dnp: true })
    expect(flags("(exclude_from_sim yes) (in_pos_files no)")).toEqual({ excludeFromSim: true, excludeFromPos: true })
    expect(flags("(dnp no)")).toBeUndefined()
  })

  it("X19: embedded fonts", () => {
    expect(needsOf(schematic({ version: 20250114, body: [`(embedded_fonts yes)`] }))).toEqual(["X19"])
    expect(message(schematic({ version: 20250114, body: [`(embedded_fonts yes)`] }))).toBe("This schematic uses text outlines or embedded fonts, which are not supported yet.")
    const plain = importKicadSchematic(schematic({ version: 20250114, body: [`(embedded_fonts no)`] }))
    expect(plain.status).toBe("imported")
  })

  it("names every extension a schematic needs in the one sentence", () => {
    const text = schematic({
      body: [`(netclass_flag "" (length 2.54) (shape round) (at 10 10 0) (effects (font (size 1.27 1.27))) (uuid f) (property "Netclass" "Fast" (at 0 0 0)))`, `(text "t" (at 1 2 0) (effects (font (size 1.27 1.27))))`, `(bus (pts (xy 0 0) (xy 5 0)) (stroke (width 0) (type default)) (uuid b))`, `(embedded_fonts yes)`],
      version: 20250114,
    })
    const r = refused(importKicadSchematic(text, { built: new Set([...BUILT_EXTENSIONS].filter((x) => x !== "S8")) }))
    expect(r.needs.map((n) => n.ext)).toEqual(["S8", "X19"])
    expect(r.message).toBe("This schematic uses directive labels and rule areas and text outlines or embedded fonts, which are not supported yet.")
    // With S8 built the text outlines are what is left.
    expect(needsOf(text)).toEqual(["X19"])
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
    expect(nets.nets.map((n) => [n.name, n.named])).toEqual([["/SIG", true]])
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
    expect(r.needs).toEqual([])
  })

  it("a project with its sheets is read whole and imported, each sheet with its own items", () => {
    const files = new Map([
      ["root.kicad_sch", schematic({ uuid: "r", body: [`(sheet (at 10 10) (size 20 10) (uuid s1) (property "Sheetname" "Power" (at 0 0 0)) (property "Sheetfile" "power.kicad_sch" (at 0 0 0)))`] })],
      ["power.kicad_sch", schematic({ uuid: "p", body: [`(hierarchical_label "VIN" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid h))`] })],
    ])
    const r = imported(importKicadSchematic({ files, root: "root.kicad_sch" }))
    expect(r.tree.files.size).toBe(2)
    expect(r.project.sheets?.map((x) => x.id)).toEqual(["root", "s1"])
    expect(r.project.labels).toMatchObject([{ name: "VIN", kind: "hierarchical", sheet: "s1" }])
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

  it("S2: a local label of its own size, justification, italic or bold, or with fields, is imported with them", () => {
    const l = (text: string) => imported(importKicadSchematic(wired(text))).project.labels[0]
    expect(l(label("1.524")).look?.size).toBeCloseTo(1.524 / 12.7, 9)
    // a justification the turn gives is the default and is not kept; another is
    expect(l(label("1.27", "left bottom")).look).toBeUndefined()
    expect(l(label("1.27", "right bottom")).look).toEqual({ h: "right" })
    expect(l(`(label "A" (at 10 10 0) (effects (font (size 1.27 1.27) italic bold) (justify left bottom)) (uuid l))`).look).toEqual({ bold: true, italic: true })
    const withField = l(`(label "A" (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid l) (property "Netclass" "x" (at 12.7 10 0) (effects (font (size 1.27 1.27)))))`)
    expect(withField.fields?.[0]).toMatchObject({ name: "Netclass", value: "x", place: { x: expect.closeTo(2.7 / 12.7, 5), y: 0 } })
    expect(withField.kind).toBe("local")
  })

  it("S4: a wire of its own width, line style or colour is imported with it", () => {
    const wire = (stroke: string) => imported(importKicadSchematic(schematic({ body: [`(wire (pts (xy 0 0) (xy 5 0)) ${stroke} (uuid w))`] }))).project.wires[0].look
    expect(wire("(stroke (width 0.5) (type default))")?.width).toBeCloseTo(0.5 / 12.7, 5)
    expect(wire("(stroke (width 0) (type dash))")).toEqual({ dash: "dash" })
    expect(wire("(stroke (width 0) (type default) (color 255 0 0 1))")).toEqual({ color: "#ff0000" })
    expect(wire("(stroke (width 0) (type default) (color 0 0 0 0))")).toBeUndefined()
    expect(wire("(stroke (width 0) (type solid))")).toBeUndefined()
  })

  it("S7: a symbol left out of the position files keeps it", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001", extra: "(in_pos_files no)" }] })
    expect(imported(importKicadSchematic(text)).project.components[0].flags).toEqual({ excludeFromPos: true })
  })

  it("S1: a symbol used on a sheet other than this one, or used twice", () => {
    const sym = { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }
    const own = schematic({ libs: [LIB_R], symbols: [sym] })
    expect(needsOf(own)).not.toContain("S1")
    // used on a sheet below the root that the project does not have, and a second time: the instance of a use that does not exist is a note, and the symbol keeps its own reference
    const stray = imported(importKicadSchematic(own.replace(`(instances`, `(instances (project "demo" (path "/${ROOT_UUID}/sheet2" (reference "R9") (unit 1)))`)))
    expect(stray.report.entries.find((e) => e.code === "instance-of-no-sheet")?.count).toBe(1)
    expect(stray.project.components.map((c) => c.ref)).toEqual(["R1"])
    // the instance of another project that shares the sheet is not this project's, and is a note
    const foreign = own.replace(`(instances`, `(instances (project "other" (path "/ffffffff-0000-4000-8000-000000000009" (reference "R7") (unit 1)))`)
    const r = imported(importKicadSchematic(foreign))
    expect(r.report.entries.find((e) => e.code === "other-projects-instances")?.count).toBe(1)
  })

  it("a symbol in the cache that no symbol is placed from is kept as a stored drawing, not listed as a part, and named once in the report", () => {
    const r = imported(importKicadSchematic(schematic({ libs: [LIB_R] })))
    expect(r.project.components).toEqual([])
    expect(r.project.parts ?? []).toEqual([])
    expect(Object.values(r.project.symbols ?? {}).map((d) => d.name)).toEqual(["Device:R"])
    const notes = r.report.entries.filter((e) => e.code === "unplaced-symbols-kept")
    expect(notes).toHaveLength(1)
    expect(notes[0].object).toContain("Device:R")
  })

  it("the root's own sheet_instances, in the spelling of either release, say nothing", () => {
    expect(importKicadSchematic(schematic()).status).toBe("imported")
    expect(importKicadSchematic(schematic().replace(`(path "/" (page "1"))`, `(path "/${ROOT_UUID}" (page "1"))`)).status).toBe("imported")
    // a page for a sheet that is not there is a note
    expect(imported(importKicadSchematic(schematic().replace(`(path "/" (page "1"))`, `(path "/${ROOT_UUID}" (page "1")) (path "/${ROOT_UUID}/x" (page "2"))`))).report.entries.some((e) => e.code === "page-of-no-sheet")).toBe(true)
  })
})

describe("the accounting of every node", () => {
  const account = (text: string) => importKicadSchematic(text).report.account!
  const total = (a: ReturnType<typeof account>) =>
    a.imported + [...a.notNeeded.values(), ...a.pending.values(), ...a.unknownPaths.values()].reduce((x, y) => x + y, 0) + a.reported

  it("every node is imported, not needed with a reason, pending an extension, or reported: the states add up", () => {
    const a = account(divider())
    expect(a.unknownPaths.size).toBe(0)
    expect(a.unknownAtoms.size).toBe(0)
    expect(total(a)).toBe(a.total)
    expect(a.pending.size).toBe(0)
    expect(a.pending.get("S5")).toBeUndefined()
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
    const a = imported(importKicadSchematic({ files, root: "root.kicad_sch" })).report.account!
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
  it("makes power ports of power symbols that keep KiCad's drawing, with the symbol where KiCad has it", () => {
    const r = imported(importKicadSchematic(divider(), { built: SYMBOLS }))
    const gnd = r.project.components.find((c) => c.ref === "#PWR02")!
    const vcc = r.project.components.find((c) => c.ref === "#PWR01")!
    expect([gnd.props.net, gnd.sch.rot, vcc.props.net, vcc.sch.rot]).toEqual(["GND", 0, "VCC", 0])
    expect(findPart(gnd.partId)!.powerNet).toBe("GND")
    expect(findPart(vcc.partId)!.powerNet).toBe("VCC")
    expect(r.project.parts?.find((p) => p.id === vcc.partId)?.drawing).toBeTruthy()
    // the symbol of VCC is at (50.8, 43.18) mm, its pin at its origin
    expect([vcc.sch.x, vcc.sch.y]).toEqual([4, -3.4])
    expect(schematicPins(vcc)[0].pos).toEqual({ x: 4, y: -3.4 })
  })

  it("takes a symbol's reference from its instance, and its other fields as properties", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] }).replace(`(reference "R1")`, `(reference "R42")`)
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.project.components[0].ref).toBe("R42")
  })

  it("KiCad 6 keeps a symbol's real value and footprint in the root list: they stand in place of the fields, and the list does not make the file need S1", () => {
    const sym = { lib: "Device:R", at: "50.8 50.8", ref: "D5", value: "", uuid: "aaaaaaaa-0000-4000-8000-000000000001", footprint: "" }
    const text = schematic({ version: 20211123, libs: [LIB_R], symbols: [sym], rootEntries: [`/${sym.uuid}|D5|red|Local:LED_D3.0mm`] })
    expect(needsOf(text)).toEqual([])
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.project.components[0].props).toEqual({ value: "red", Footprint: "Local:LED_D3.0mm" })
    // before 20230221 a global power symbol is named by its hidden pin, whatever the instance's value says
    const gnd = schematic({ version: 20211123, libs: [LIB_GND], symbols: [{ lib: "power:GND", at: "50.8 76.2", ref: "#PWR01", value: "GND", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }], rootEntries: [`/aaaaaaaa-0000-4000-8000-000000000002|#PWR01|GND2`] })
    expect(imported(importKicadSchematic(gnd, { built: SYMBOLS })).project.components[0].props.net).toBe("GND")
  })

  it("a symbol whose drawing is in no library either is refused naming the symbol and what to add (S12, built: the libraries of the project are read)", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:C", at: "50.8 50.8", ref: "C1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    const r = refused(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.reason).toBe("inexact")
    const e = r.report.entries.find((x) => x.code === "symbol-not-in-cache")!
    expect(e.object).toBe("1 symbol (Device:C)")
    expect(e.why).toContain("no symbol library")
    expect(e.why).toContain("S12")
    expect(r.message).toBe(e.why)
  })

  it("a pin with no number is a pin of the part like any other: it joins a wire, and no pad is paired with it", () => {
    const lib = `(symbol "T:V" (property "Reference" "V" (at 0 0 0)) (symbol "V_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "A") (number "~"))))`
    const text = schematic({ libs: [lib], symbols: [{ lib: "T:V", at: "50.8 50.8", ref: "V1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    expect(lossy(text).filter(([ext]) => ext === "S5")).toEqual([])
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    expect(findPart(r.project.components[0].partId)!.pins.map((p) => p.number)).toEqual([""])
  })

  it("pins that share a number are separate pins, whatever the build says: a net is KiCad's", () => {
    const lib = `(symbol "T:D" (property "Reference" "D" (at 0 0 0)) (symbol "D_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "A") (number "12")) (pin passive line (at 5 0 0) (length 2.54) (name "B") (number "12"))))`
    const text = schematic({ libs: [lib], symbols: [{ lib: "T:D", at: "50.8 50.8", ref: "U1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    expect(lossy(text)).toEqual([])
    expect(imported(importKicadSchematic(text, { built: SYMBOLS })).project.components).toHaveLength(1)
  })

  it("a symbol turned by other than a quarter turn is unreadable, as KiCad's parser rejects it", () => {
    const text = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8 45", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })
    const r = refused(importKicadSchematic(text, { built: SYMBOLS }))
    expect(r.reason).toBe("unreadable")
    expect(r.message).toBe("A symbol is turned by 45 degrees, which KiCad does not read: a symbol turns 0, 90, 180 or 270 degrees.")
  })

  it("a mirrored symbol is the same part, placed mirrored, so the editor's pins are where KiCad's are", () => {
    const text = schematic({ libs: [LIB_U], symbols: [{ lib: "Test:U", at: "100 100", ref: "U1", uuid: "aaaaaaaa-0000-4000-8000-000000000001", mirror: "y" }, { lib: "Test:U", at: "130 100", ref: "U2", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }] })
    const r = imported(importKicadSchematic(text, { built: SYMBOLS }))
    const [u1, u2] = r.project.components
    expect(u1.partId).toBe(u2.partId)
    expect([u1.sch.rot, u1.sch.mirror, u2.sch.mirror]).toEqual([0, "y", undefined])
    // pin 3 is a no-connect pin: it has a port, and connectivity leaves it out
    expect(findPart(u1.partId)!.symbol.ports.map((p) => p.pin)).toEqual(["1", "2", "3"])
    expect(findPart(u1.partId)!.pins.map((p) => p.number)).toEqual(["1", "2", "3"])
    // mirrored left to right: pin 1 (left of the body) is on the right of U1 and on the left of U2
    expect(schematicPins(u1)[0].pos.x).toBeGreaterThan(u1.sch.x)
    expect(schematicPins(u2)[0].pos.x).toBeLessThan(u2.sch.x)
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
      ["net:/MID", ["R1.2", "R2.1"]],
      ["net:GND", ["#PWR02.1", "R2.2"]],
      ["net:VCC", ["#PWR01.1", "R1.1"]],
    ])
    expect(c.pinNet.get(pinKey(r.project.components.find((x) => x.ref === "R2")!.id, "2"))).toBe("net:GND")
  })
})

describe("what each flag and field of the file needs, so that nothing imported is lost", () => {
  const node = (text: string) => schematic({ body: [text] })

  it("a junction with a size or colour of its own is a drawing of the sheet; the default dot is the editor's own", () => {
    const items = (text: string) => imported(importKicadSchematic(node(text))).project.drawings
    expect(items(`(junction (at 10 10) (diameter 1) (color 0 0 0 0) (uuid j))`)).toMatchObject([{ type: "junction", diameter: expect.closeTo(1 / 12.7, 5) }])
    expect(items(`(junction (at 10 10) (diameter 0) (color 255 0 0 1) (uuid j))`)).toMatchObject([{ type: "junction", dotColor: "#ff0000" }])
    // a default dot where no wires meet is still drawn by KiCad, so it is a drawing too; one the editor draws itself is not
    expect(items(`(junction (at 10 10) (diameter 0) (color 0 0 0 0) (uuid j))`)).toMatchObject([{ type: "junction" }])
    const wires = schematic({ wires: ["10 10 20 10", "15 10 15 5"], junctions: ["15 10"] })
    expect(imported(importKicadSchematic(wires)).project.drawings).toBeUndefined()
  })

  it("a no-connect flag that is not on a pin of a placed symbol is a drawing, and one on a pin is that pin's mark", () => {
    expect(imported(importKicadSchematic(schematic({ noConnects: ["10 10"] }))).project.drawings).toMatchObject([{ type: "noconnect" }])
    const on = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }], noConnects: ["50.8 46.99"] })
    const r = imported(importKicadSchematic(on, { built: SYMBOLS }))
    expect(r.project.components[0].nc).toEqual(["1"])
    expect(r.project.drawings).toBeUndefined()
  })

  it("a symbol that jumpers pins of one number is kept with that in its drawing, even when no symbol is placed from it", () => {
    const lib = `(symbol "T:J" (duplicate_pin_numbers_are_jumpers yes) (symbol "J_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "A") (number "1"))))`
    const r = imported(importKicadSchematic(schematic({ libs: [lib] })))
    expect(Object.values(r.project.symbols ?? {})[0].jumpers).toEqual({ duplicates: true })
  })

  it("a locked group is a locked block", () => {
    const sym = { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }
    const group = (extra: string) => imported(importKicadSchematic(schematic({ libs: [LIB_R], symbols: [sym], body: [`(group "G" (uuid g1) ${extra} (members ${sym.uuid}))`] }))).project.blocks
    expect(group("(locked yes)")).toMatchObject([{ name: "G", locked: true }])
    expect(group("")?.[0].locked).toBeUndefined()
  })

  it("a page number is read past: the editor has none, and the export numbers the pages in the order of the tree", () => {
    expect(imported(importKicadSchematic(schematic().replace(`(page "1")`, `(page "7")`))).project.sheets).toBeUndefined()
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
