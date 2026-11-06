import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { setCopperLayerCount } from "../src/model/layerOps"
import { ownTexts } from "../src/model/board"
import { built } from "./built"
import { analyzePcb } from "../src/model/pcb"
import { computeConnectivity } from "../src/model/connectivity"
import { onBoard } from "../src/model/partFlags"
import { symbolBox } from "../src/model/ruleAreas"
import type { DrawingLine } from "../src/model/types"
import { TEMPLATES } from "../src/model/templates"
import type { Project } from "../src/model/types"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES } from "../src/model/kicad/board"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { importKicadBoard } from "../src/model/kicad/board"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import { BUILT_EXTENSIONS as SCHEMATIC_BUILT } from "../src/model/kicad/schematic/needs"
import { gerberLayers } from "../src/export/gerber"
import { drillHoles } from "../src/export/excellon"
import { writeKicadBoard } from "../src/export/kicadBoard"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { ROOT_UUID, divider, schematic } from "./kicad-schematic-fixtures"
import { S1, files as sheetFiles } from "./kicad-sheets-fixtures"
import { importedProject as imported } from "./kicad-test-helpers"

// Final review of the join, blockers B1 to B4 (the fixes are tested in this file, in the order of the review).

const pcbOf = (files: Record<string, string>) => Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

/** Every `gr_text` of a board file: its content and layer. */
function grTexts(pcb: string): { text: string; layer: string }[] {
  const out: { text: string; layer: string }[] = []
  const re = /\(gr_text\s+"((?:[^"\\]|\\.)*)"[\s\S]*?\(layer\s+"?([^\s")]+)"?/g
  for (const m of pcb.matchAll(re)) out.push({ text: m[1], layer: m[2] })
  return out.sort((a, b) => (a.text + a.layer).localeCompare(b.text + b.layer))
}

describe("B1: an editor-drawn board of 4 or more layers keeps its silkscreen text in the KiCad export", () => {
  for (const tpl of TEMPLATES) {
    it(`${tpl.id}: the texts of the 2-layer and the 4-layer export are the same`, async () => {
      const two: Project = built(tpl.id)
      const four = setCopperLayerCount(two, 4).project
      const a = grTexts(pcbOf((await kicadFiles(two)).files))
      const b = grTexts(pcbOf((await kicadFiles(four)).files))
      expect(a.length).toBe(ownTexts(two).length)
      expect(b).toEqual(a)
    }, 120000)
  }

  it("the 4-layer file puts a text where the Gerber plots it: the editor's place in the file's frame, its size and side", async () => {
    const tpl = built(TEMPLATES[0].id)
    const four = setCopperLayerCount(tpl, 4).project
    const withBottom: Project = { ...four, texts: [...(four.texts ?? []), { id: "tb", text: "UNDER", x: 12.5, y: 7.25, size: 1.5, rot: 90, side: "bottom" }] }
    const pcb = pcbOf((await kicadFiles(withBottom)).files)
    const block = pcb.slice(pcb.indexOf('(gr_text "UNDER"'))
    expect(block.slice(0, block.indexOf("\n)\n"))).toMatch(/\(at 12\.5 -7\.25 90\)[\s\S]*\(layer "B\.SilkS"\)[\s\S]*\(size 1\.5 1\.5\)[\s\S]*\(thickness 0\.21\)[\s\S]*\(justify mirror\)/)
  }, 120000)
})

const BUILT = new Set([...Object.keys(BOARD_EXTENSION_NAMES), ...SCHEMATIC_BUILT])
const U1 = "11111111-0000-4000-8000-000000000001"
const U2 = "11111111-0000-4000-8000-000000000002"
const R1_FOOTPRINT = () => footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "VCC")' }), pad({ number: "2", at: "1 0", net: '(net 2 "/MID")' })], extra: `(path "/${U1}") (attr smd)` })
const R2_FOOTPRINT = () => footprint({ ref: "R2", at: "15 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 2 "/MID")' }), pad({ number: "2", at: "1 0", net: '(net 3 "GND")' })], extra: `(path "/${U2}") (attr smd)` })
const DIVIDER_BOARD = () => board({ nets: ['(net 0 "")', '(net 1 "VCC")', '(net 2 "/MID")', '(net 3 "GND")'], body: [R1_FOOTPRINT(), R2_FOOTPRINT()] })
const projectFiles = (pcb: string, sch: string): ProjectFile[] => [{ path: "demo.kicad_pcb", data: pcb }, { path: "demo.kicad_sch", data: sch }]
/** The divider's fields drawn on their symbols (the fixture's are all at the sheet's corner, which would put every symbol's box under any area). */
const tidy = (sch: string) =>
  sch
    .split("(symbol (lib_id ")
    .map((chunk, i) => (i === 0 ? chunk : chunk.replace(/\(at 0 0 0\)/g, `(at ${/\(at (\S+ \S+)/.exec(chunk)![1]} 0)`)))
    .join("(symbol (lib_id ")
/** The divider (KiCad 10's stamp) with a rule area over R1 only. */
const withArea = (flags: string, version = 20250610) =>
  tidy(divider(version)).replace("(sheet_instances", `(rule_area ${flags} (polyline (pts (xy 50.3 50.3) (xy 51.3 50.3) (xy 51.3 51.3) (xy 50.3 51.3)) (stroke (width 0) (type dash)) (fill (type none)) (uuid 22222222-0000-4000-8000-000000000002)))
  (sheet_instances`)

describe("B2: a footprint whose symbol a rule area takes off the board is kept, as the symbol's own flag keeps it", () => {
  const own = divider(20250610).replace(/(\(symbol \(lib_id "Device:R"\)[^]*?\(in_bom yes\) \(on_board )yes/, "$1no")

  it("the symbol's own flag: the footprint is kept, unlinked, with the note (the reference)", () => {
    const r = imported(importKicadProject(projectFiles(DIVIDER_BOARD(), own), { built: BUILT }))
    expect(r.report.entries.some((e) => e.code === "symbol-not-on-board")).toBe(true)
  })

  it("a rule area's on_board no does the same: the footprint is kept and in the Gerber, the drill file and the written board", () => {
    const r = imported(importKicadProject(projectFiles(DIVIDER_BOARD(), withArea("(on_board no)")), { built: BUILT }))
    expect(r.report.entries.filter((e) => e.code === "symbol-not-on-board").map((e) => e.object)).toEqual(["R1"])
    const p = r.project
    const r1 = p.components.filter((c) => c.ref === "R1")
    expect(r1.length).toBeGreaterThan(0)
    for (const c of r1) expect(c.flags?.notOnBoard).toBeUndefined()
    expect(writeKicadBoard(p).text).toContain('"Reference" "R1"')
    const plain = imported(importKicadProject(projectFiles(DIVIDER_BOARD(), divider(20250610)), { built: BUILT })).project
    expect(drillHoles(p)).toEqual(drillHoles(plain))
    // the same copper pads and the same silk, in whatever order the parts come
    const lines = (x: Record<string, string>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v.split("\n").sort()]))
    expect(lines(gerberLayers(p))).toEqual(lines(gerberLayers(plain)))
  })
  it("a sheet symbol's on_board no does the same for the footprints of the symbols below it", () => {
    const tree = sheetFiles([{ uuid: S1, name: "Power", y: 60.96 }])
    const kicad10 = (t: string) => t.replace("(version 20230121)", "(version 20250610)")
    const root = kicad10(tree.get("root.kicad_sch")!).replace("(fields_autoplaced yes) (stroke", "(on_board no) (fields_autoplaced yes) (stroke")
    const sub = `(path "/${ROOT_UUID}/${S1}/bbbbbbbb-0000-4000-8000-000000000001")`
    const pcb = board({ nets: ['(net 0 "")'], body: [footprint({ ref: "R2", at: "10 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: `${sub} (attr smd)` })] })
    const r = imported(importKicadProject([{ path: "demo.kicad_pcb", data: pcb }, { path: "root.kicad_sch", data: root }, { path: "child.kicad_sch", data: kicad10(tree.get("child.kicad_sch")!) }], { built: BUILT }))
    expect(r.report.entries.filter((e) => e.code === "symbol-not-on-board").map((e) => e.object)).toEqual(["R2"])
    expect(drillHoles(r.project)).toEqual([])
    expect(writeKicadBoard(r.project).text).toContain('"Reference" "R2"')
  })
})

describe("cleanup 9: the courtyard checks read the resolved flags", () => {
  it("a part a rule area takes off the board has no outside-board or overlap error, as one with its own flag has none", () => {
    const base = built("regulator")
    const target = base.components.find((c) => c.pcb.placed && onBoard(c) && c.ref === "D1")!
    const far: Project = { ...base, components: base.components.map((c) => (c.id === target.id ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + 500 } } : c)) }
    const b = symbolBox(far.components.find((c) => c.id === target.id)!)
    const area: DrawingLine = { id: "area", type: "line", closed: true, points: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], ruleArea: { notOnBoard: true } }
    const kinds = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "outside-board" && v.message.startsWith(`${target.ref} `)).length
    expect(kinds(far)).toBe(1)
    expect(kinds({ ...far, drawings: [...(far.drawings ?? []), area] })).toBe(0)
  })
})

// ---------- B3 ----------

const FONT = "(effects (font (size 1.27 1.27)))"
const lpin = (type: string, at: string, name: string, number: string) => `(pin ${type} line (at ${at}) (length 2.54) (name "${name}" ${FONT}) (number "${number}" ${FONT}))`
/** A chip with pins 1, 2 and an exposed pad EP, and a diode-like part with A and C, as the libraries name them. */
const LIB_CHIP = `(symbol "Test:CHIP" (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 7.62 0) ${FONT})
  (property "Value" "CHIP" (at 0 -7.62 0) ${FONT})
  (symbol "CHIP_0_1" (rectangle (start -2.54 5.08) (end 2.54 -5.08) (stroke (width 0.254) (type default)) (fill (type background))))
  (symbol "CHIP_1_1"
    ${lpin("input", "-5.08 2.54 0", "IN", "1")}
    ${lpin("output", "5.08 2.54 180", "OUT", "2")}
    ${lpin("power_in", "0 -7.62 90", "GND", "EP")}))`
const LIB_DIODE = `(symbol "Test:DIODE" (in_bom yes) (on_board yes)
  (property "Reference" "D" (at 0 5.08 0) ${FONT})
  (property "Value" "DIODE" (at 0 -5.08 0) ${FONT})
  (symbol "DIODE_0_1" (polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27) (xy 1.27 0) (xy -1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type outline))))
  (symbol "DIODE_1_1"
    ${lpin("passive", "-3.81 0 0", "K", "C")}
    ${lpin("passive", "3.81 0 180", "A", "A")}))`

describe("B3: the exported schematic carries every pin's real number and name", () => {
  const sheetWith = () => schematic({ version: 20250318, libs: [LIB_CHIP, LIB_DIODE], symbols: [{ lib: "Test:CHIP", at: "50.8 50.8", ref: "U1", uuid: "cccccccc-0000-4000-8000-000000000001" }, { lib: "Test:DIODE", at: "101.6 50.8", ref: "D1", uuid: "cccccccc-0000-4000-8000-000000000002" }] })

  it("a pin numbered EP is written as EP, and A and C as A and C", async () => {
    const r = importKicadSchematic(sheetWith(), { built: BUILT })
    if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
    const { files } = await kicadFiles(r.project)
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    const numbers = [...sch.matchAll(/\(number "([^"]*)"/g)].map((m) => m[1]).sort()
    expect(numbers).toEqual(["1", "2", "A", "C", "EP"])
    const names = [...sch.matchAll(/\(name "([^"]*)"/g)].map((m) => m[1]).sort()
    expect(names).toEqual(["A", "GND", "IN", "K", "OUT"])
  })
})

// ---------- B4 ----------

describe("B4: our own export, project file included, is accepted by our own project importer", () => {
  const roundTrip = async (p: Project) => {
    const { files } = await kicadFiles(p)
    const names = Object.keys(files)
    expect(names.some((n) => n.endsWith(".kicad_pro"))).toBe(true)
    return importKicadProject(Object.entries(files).map(([path, data]) => ({ path, data })))
  }

  for (const id of ["blinker", "mcu"]) {
    it(`${id}: the three files import (2 layers, through the converter)`, async () => {
      const r = await roundTrip(built(id))
      expect(r.status === "imported" ? "imported" : `refused: ${r.message}`).toBe("imported")
    }, 120000)
  }

  it("blinker on 4 layers: the three files import (written natively)", async () => {
    const four = setCopperLayerCount(built("blinker"), 4).project
    const r = await roundTrip(four)
    expect(r.status === "imported" ? "imported" : `refused: ${r.message}`).toBe("imported")
  }, 120000)
})

// ---------- cleanup 1 and 10 ----------

const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" power) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'

describe("cleanup 1: a board of more than 32 copper layers is refused", () => {
  it("names the count and the limit", () => {
    const inner = Array.from({ length: 31 }, (_, i) => `(${i + 1} "In${i + 1}.Cu" signal)`).join(" ")
    const r = importKicadBoard(board({ layers: `(layers (0 "F.Cu" signal) ${inner} (63 "B.Cu" signal) (44 "Edge.Cuts" user))` }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.message).toMatch(/33 copper layers.*at most 32/)
  })

  it("32 copper layers are read", () => {
    const inner = Array.from({ length: 30 }, (_, i) => `(${i + 1} "In${i + 1}.Cu" signal)`).join(" ")
    expect(importKicadBoard(board({ layers: `(layers (0 "F.Cu" signal) ${inner} (63 "B.Cu" signal) (44 "Edge.Cuts" user))` })).status).toBe("imported")
  })
})

describe("cleanup 10: a pad stack entry on a layer the board does not have is reported", () => {
  it("In9 on a board of four layers", () => {
    const stack = '(padstack (mode custom) (layer "F.Cu" (shape circle) (size 1 1)) (layer "In1.Cu" (shape circle) (size 1 1)) (layer "In9.Cu" (shape circle) (size 2 2)) (layer "B.Cu" (shape circle) (size 1 1)))'
    const p = pad({ type: "thru_hole", shape: "circle", at: "0 0", layers: '"*.Cu" "*.Mask"', extra: `(drill 0.5) ${stack}` })
    const r = importKicadBoard(board({ layers: L4, body: [footprint({ pads: [p] })] }))
    expect(r.status).toBe("imported")
    if (r.status === "imported") expect(r.report.entries.some((e) => /In9\.Cu, which is not a copper layer of the board/.test(`${e.why} ${e.items ?? ""}`))).toBe(true)
  })
})
