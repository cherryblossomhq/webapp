import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { addWire, findRubberBands, moveComponent, moveSchematicItems, removeItems } from "../src/model/ops"
import { findPart } from "../src/model/library"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { type Mirror, type Project } from "../src/model/types"
import { deriveNets } from "./kicad-census/netlist-sch.mjs"
import { LIB_R, ROOT_UUID, schematic, type SymSpec } from "./kicad-schematic-fixtures"
import { CHILD_UUID, files as sheetFiles, S1, S2 } from "./kicad-sheets-fixtures"
import { runTool } from "../src/ai/tools"
import { settleKicadSheet } from "../src/model/kicadJoin"
import { type Clipboard, dragSelection, mirrorSelection, pasteItems, rotateSelection } from "../src/model/schematicEdit"
import { tidySchematic } from "../src/model/tidy"
import { projectApi } from "../src/store/projectStore"

// S11: KiCad's rules for what a wire joins, on the imported sheets that need them. Every refusal case of slice 3a is imported now, with the sheet flagged
// (`SchematicSheet.kicadRules`) and its nets equal to the independent derivation of the raw file (`tests/kicad-census/netlist-sch.mjs`, which reads the
// file by KiCad's rules and shares no code with `src`). Each case is also run with the flag taken off, to show that the editor's own rules would have joined
// something else: the flag is what makes the nets KiCad's. Sheets drawn in the editor, and imported sheets with no such case, are unchanged.
//
// KiCad's rules, by release (eeschema, read for this slice; see docs/kicad-import-schematic.md section 10):
//  - connection points are integer points of 100 nm (SCH_IU, `schematic.h`), and items join where their points are equal (`connection_graph.cpp`,
//    `updateItemConnectivity`: a map from point to items; the same in 6.0, 7.0, 8.0, 9.0 and 10.0);
//  - a wire has two connection points, its ends (`SCH_LINE::GetConnectionPoints`, `sch_line.cpp`), so another wire's end or a pin on its side joins nothing;
//  - a junction joins what is on it because the sheet is cleaned up when it is loaded: `SCHEMATIC::CleanUp` first runs `BreakSegmentsOnJunctions`
//    (`schematic.cpp`, 9.0 lines 1090 to 1147), which cuts every wire at each junction, so the cut ends are equal points;
//  - a label joins the pin at its point and, when it has no pin there, the wires under it (`SCH_LABEL_BASE`, `connection_graph.cpp` 9.0 lines 1243 to 1263).

const BUILT = new Set([...BUILT_EXTENSIONS, "S2", "S5", "S6", "S10"])
const WITHOUT_S11 = new Set([...BUILT].filter((x) => x !== "S11"))

const dir = mkdtempSync(join(tmpdir(), "kicad-s11-"))
let counter = 0
function write(text: string): string {
  const d = join(dir, `t${counter++}`)
  mkdirSync(d)
  const file = join(d, "root.kicad_sch")
  writeFileSync(file, text)
  return file
}

const R = (ref: string, at: string, n: number, extra: Partial<SymSpec> = {}): SymSpec => ({ lib: "Device:R", at, ref, uuid: `22222222-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, ...extra })
const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => a.join().localeCompare(b.join()))

/** The pins that share a net with another, as `REF.pin` groups, in the editor's reading of a project. */
function editorGroups(project: Project): string[][] {
  const { pinNet } = computeConnectivity(project)
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const byNet = new Map<string, string[]>()
  for (const [key, netId] of pinNet) {
    const at = key.lastIndexOf(":")
    const id = key.slice(0, at)
    if (!refOf.has(id)) continue
    const pin = `${refOf.get(id)}.${key.slice(at + 1)}`
    const list = byNet.get(netId) ?? []
    if (!list.includes(pin)) list.push(pin)
    byNet.set(netId, list)
  }
  return sorted([...byNet.values()].filter((l) => l.length > 1))
}

/** KiCad's groups from the raw file. */
function kicadGroups(text: string, project: Project, bySymbol: Map<{ uuid: string }, { id: string }>): { groups: string[][]; kinds: string[] } {
  const derived = deriveNets(write(text), { hiddenPower: true, localJoinsGlobal: "same" })
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const refByUuid = new Map([...bySymbol].map(([sym, c]) => [sym.uuid, refOf.get(c.id)!]))
  const byGroup = new Map<number, string[]>()
  for (const [key, g] of derived.pins) {
    const [, uuid, pin] = /^\/([^#]+)#(.*)$/.exec(key)!
    for (const x of ([] as number[]).concat(g)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(`${refByUuid.get(uuid)}.${pin}`)
  }
  return { groups: sorted([...byGroup.values()].filter((l) => l.length > 1)), kinds: [...new Set(derived.cases.map((c) => c.kind))].sort() }
}

interface Result {
  project: Project
  mine: string[][]
  theirs: string[][]
  /** The editor's own rules over the same sheet: the flag taken off. */
  without: string[][]
  flagged: boolean
  /** What the oracle says differs between the editor's rules and KiCad's in this file. */
  kinds: string[]
}

function run(text: string): Result {
  const imported = importKicadSchematic(text, { built: BUILT })
  if (imported.status !== "imported") throw new Error(`not imported: ${imported.status === "refused" ? imported.message : ""}`)
  const project = imported.project
  const { groups: theirs, kinds } = kicadGroups(text, project, imported.build.bySymbol as never)
  const stripped: Project = { ...project, sheets: project.sheets?.map(({ kicadRules: _k, ...rest }) => rest) }
  return { project, mine: editorGroups(project), theirs, without: editorGroups(stripped), flagged: !!project.sheets?.some((s) => s.kicadRules), kinds }
}

// R1 at (100,100) unturned has pin 1 at (100,96.19) and pin 2 at (100,103.81). R2 at (80,116.19) has its pin 2 at (80,120).
const R1 = R("R1", "100 100 0", 1)
const R2 = R("R2", "80 116.19 0", 2)

describe("every case slice 3a refused naming S11 is imported, flagged, with KiCad's nets", () => {
  it("is built: the importer's own set names S11", () => {
    expect(BUILT_EXTENSIONS.has("S11")).toBe(true)
  })

  it("a wire end on another wire's side with no junction joins nothing in KiCad", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const r = run(text)
    expect(r.flagged).toBe(true)
    expect(r.kinds).toEqual(["wire-end-on-side"])
    expect(r.theirs).toEqual([])
    expect(r.mine).toEqual(r.theirs)
    // the editor's rule joins R1 pin 2 to R2 pin 2 through the T: that is what the flag takes away
    expect(r.without).toEqual([["R1.2", "R2.2"]])
  })

  it("the same T with a junction joins in both, and needs no flag", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"], junctions: ["100 120"] })
    const r = run(text)
    expect(r.flagged).toBe(false)
    expect(r.theirs).toEqual([["R1.2", "R2.2"]])
    expect(r.mine).toEqual(r.theirs)
  })

  it("a wire end a hair's breadth from another wire (0.1 um) is a separate point in KiCad", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 119.9999"] })
    const r = run(text)
    expect(r.flagged).toBe(true)
    expect(r.kinds).toEqual(["near-miss"])
    expect(r.theirs).toEqual([])
    expect(r.mine).toEqual([])
    expect(r.without).toEqual([["R1.2", "R2.2"]])
  })

  it("a label a hair's breadth from a wire does not join it", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 110"], labels: ["SIG 100 120.0001 0", "SIG 100 106 0"] })
    const r = run(text)
    expect(r.flagged).toBe(true)
    expect(r.kinds).toEqual(["near-miss"])
    expect(r.theirs).toEqual([])
    expect(r.mine).toEqual([])
    // the editor's tolerance (1.27 um) puts the label on the wire, and the name SIG joins both wires
    expect(r.without).toEqual([["R1.2", "R2.2"]])
  })

  it("two points closer than the editor tells apart stay two points", () => {
    // R3 has its pin 2 at (100.001,120); the wire from R1 pin 2 starts at the pin and a second wire starts 1 um from it
    const R3 = R("R3", "100.001 116.19 0", 3)
    const text = schematic({ libs: [LIB_R], symbols: [R1, R3], wires: ["100 103.81 100 110", "100.001 110 100.001 120"] })
    const r = run(text)
    expect(r.flagged).toBe(true)
    expect(r.kinds).toEqual(["close-points", "near-miss"])
    expect(r.theirs).toEqual([])
    expect(r.mine).toEqual([])
    expect(r.without).toEqual([["R1.2", "R3.2"]])
  })

  it("a label on a pin that lies on a wire's side joins the pin alone", () => {
    // R4 turned 90 at (100,100): pin 1 at (96.19,100) is on the side of a wire from 90 to 110, and the label sits on the pin. R5's pin 1 is at the wire's end.
    const R4 = R("R4", "100 100 90", 4)
    const R5 = R("R5", "113.81 100 90", 5)
    const text = schematic({ libs: [LIB_R], symbols: [R4, R5], wires: ["90 100 110 100"], labels: ["SIG 96.19 100 0"] })
    const r = run(text)
    expect(r.flagged).toBe(true)
    expect(r.kinds).toEqual(["label-pin-side"])
    expect(r.theirs).toEqual([])
    expect(r.mine).toEqual(r.theirs)
    expect(r.without).toEqual([["R4.1", "R5.1"]])
  })

  it("a label on a pin on a wire with a junction there joins all three, and needs no flag", () => {
    const R4 = R("R4", "100 100 90", 4)
    const R5 = R("R5", "113.81 100 90", 5)
    const text = schematic({ libs: [LIB_R], symbols: [R4, R5], wires: ["90 100 110 100"], junctions: ["96.19 100"], labels: ["SIG 96.19 100 0"] })
    const r = run(text)
    expect(r.flagged).toBe(false)
    expect(r.theirs).toEqual([["R4.1", "R5.1"]])
    expect(r.mine).toEqual(r.theirs)
  })

  it("a label on the side of a wire with no pin there still joins the wire", () => {
    const R4 = R("R4", "100 100 90", 4)
    const R5 = R("R5", "113.81 100 90", 5)
    const R6 = R("R6", "100 120 90", 6)
    const text = schematic({ libs: [LIB_R], symbols: [R4, R5, R6], wires: ["96.19 100 110 100", "96.19 120 110 120"], labels: ["SIG 105 100 0", "SIG 105 120 0"] })
    const r = run(text)
    expect(r.theirs).toEqual([["R4.1", "R5.1", "R6.1"]])
    expect(r.mine).toEqual(r.theirs)
  })

  it("a pin the editor's rounding moves off its wire: on a sheet joined by KiCad's rules the wire end is put on the pin the editor has", () => {
    // R7 at x 100.0017 turned 90: its pin 1 is at 96.1917. The editor sums the symbol's place and the pin's offset each to six digits and rounds to four, so its pin is
    // 1.27 um from where the wire end that KiCad has on it would be put. The editor's own rule (three digits) still joins them; KiCad's (exact points) would not, so on a
    // sheet with KiCad's rules the end is put on the pin, at most 0.64 um from the file's, and the report says so. A T with no junction elsewhere on the sheet makes it one.
    const R7 = R("R7", "100.0017 100 90", 7)
    const R8 = R("R8", "84.7617 100 90", 8)
    const R11 = R("R11", "100 150 0", 11)
    const R12 = R("R12", "80 166.19 0", 12)
    const text = schematic({ libs: [LIB_R], symbols: [R7, R8, R11, R12], wires: ["88.5717 100 96.1917 100", "80 170 120 170", "100 153.81 100 170"] })
    const r = run(text)
    expect(r.flagged).toBe(true)
    expect(r.kinds).toEqual(["pin-rounding", "wire-end-on-side"])
    expect(r.theirs).toEqual([["R7.1", "R8.2"]])
    expect(r.mine).toEqual(r.theirs)
    const c = r.project.components.find((x) => x.ref === "R7")!
    const pin = schematicPins(c, findPart(c.partId)).find((p) => p.pin === "1")!
    const wire = r.project.wires.find((w) => w.points.some((q) => Math.abs(q.y + 7.874) < 1e-6))!
    // the wire ends on the pin exactly, in the editor's own places, and within 0.63 um of KiCad's
    expect(wire.points[1]).toEqual(pin.pos)
    expect(Math.abs(wire.points[1].x * 12.7 - 96.1917)).toBeLessThan(0.0007)
    const imported = importKicadSchematic(text, { built: BUILT })
    if (imported.status !== "imported") throw new Error("not imported")
    expect(imported.report.entries.find((e) => e.code === "kicad-pins-snapped")?.count).toBeGreaterThanOrEqual(1)
    // a sheet with the pin case alone is not flagged: the editor's three digits join the pin and the wire, as KiCad does
    const alone = run(schematic({ libs: [LIB_R], symbols: [R7, R8], wires: ["88.5717 100 96.1917 100"] }))
    expect(alone.flagged).toBe(false)
    expect(alone.theirs).toEqual([["R7.1", "R8.2"]])
    expect(alone.mine).toEqual(alone.theirs)
  })

  it("the report says which sheets are joined by KiCad's rules, and why", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const imported = importKicadSchematic(text, { built: BUILT })
    if (imported.status !== "imported") throw new Error("not imported")
    const entry = imported.report.entries.filter((e) => e.code === "kicad-join-rules")
    expect(entry).toHaveLength(1)
    expect(entry[0].why).toMatch(/wire end touches another wire's side with no junction/)
    expect(entry[0].severity).toBe("note")
  })

  it("a sheet with no such case is built as before: no flag, no sheet list, four digits", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 80 130"] })
    const r = run(text)
    expect(r.flagged).toBe(false)
    expect(r.project.sheets).toBeUndefined()
  })

  it("without S11 named built, each case is the need it was: refused naming S11", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const r = importKicadSchematic(text, { built: WITHOUT_S11 })
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.message).toMatch(/KiCad's rules for what a wire joins/)
  })
})

describe("the flag is the project's, saved and loaded, and a sheet drawn in the editor has none", () => {
  it("survives a save and a load, and a document of version 14 has none and loads", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const imported = importKicadSchematic(text, { built: BUILT })
    if (imported.status !== "imported") throw new Error("not imported")
    const back = parseProjectFile(serializeProject(imported.project), { id: "x" })
    expect(back.sheets).toEqual([{ id: "root", kicadRules: true }])
    expect(editorGroups(back)).toEqual([])
  })

  it("the editor's own T with no junction still joins", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const imported = importKicadSchematic(text, { built: BUILT })
    if (imported.status !== "imported") throw new Error("not imported")
    const plain: Project = { ...imported.project, sheets: undefined }
    expect(editorGroups(plain)).toEqual([["R1.2", "R2.2"]])
  })
})

describe("the flag is per sheet: a child sheet with a case is joined by KiCad's rules and its parent is not, whatever the number of uses", () => {
  it("flags the child file only, and the nets of the whole hierarchy are KiCad's", () => {
    const f = sheetFiles([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }])
    // the child: R9 (a different one in each use) with its pin 2 at (50.8, 54.61), a wire from it ending on the side of another with no junction, and R10 on that wire's end
    const child = schematic({
      uuid: CHILD_UUID,
      libs: [LIB_R],
      symbols: [
        { lib: "Device:R", at: "50.8 50.8", ref: "R9", uuid: "bbbbbbbb-0000-4000-8000-000000000001", instances: [`/${ROOT_UUID}/${S1}|R2`, `/${ROOT_UUID}/${S2}|R3`] },
        { lib: "Device:R", at: "30.48 66.04", ref: "R10", uuid: "bbbbbbbb-0000-4000-8000-000000000002", instances: [`/${ROOT_UUID}/${S1}|R4`, `/${ROOT_UUID}/${S2}|R5`] },
      ],
      wires: ["30.48 69.85 70 69.85", "50.8 54.61 50.8 69.85"],
      body: [`(hierarchical_label "VIN" (shape input) (at 50.8 46.99 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid hl1))`],
    })
    f.set("child.kicad_sch", child)
    const r = importKicadSchematic({ files: f, root: "root.kicad_sch" }, { built: BUILT })
    if (r.status !== "imported") throw new Error(r.status === "refused" ? r.message : "")
    const flagged = r.project.sheets?.filter((x) => x.kicadRules).map((x) => x.id)
    expect(flagged).toHaveLength(1)
    expect(flagged![0]).not.toBe("root")
    // the independent derivation of the same files, by their paths (`/<sheet uuid>/<symbol uuid>#pin`), against the editor's groups of the same pins
    const d = join(dir, `h${counter++}`)
    mkdirSync(d)
    for (const [name, text] of f) writeFileSync(join(d, name), text)
    const oracle = deriveNets(join(d, "root.kicad_sch"), { hiddenPower: true, localJoinsGlobal: "same" })
    const refOf = new Map([...r.build.byRecord].map(([rec, c]) => [rec.path, c.ref]))
    const byGroup = new Map<number, string[]>()
    for (const [key, g] of oracle.pins) {
      const [path, pin] = key.split("#")
      const ref = refOf.get(path)
      if (!ref || !/^R(2|3|4|5)$/.test(ref)) continue
      for (const x of ([] as number[]).concat(g)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(`${ref}.${pin}`)
    }
    const theirs = sorted([...byGroup.values()].filter((l) => l.length > 1))
    const mine = editorGroups(r.project).map((g) => g.filter((x) => /^R(2|3|4|5)\./.test(x))).filter((g) => g.length > 1)
    expect(sorted(mine)).toEqual(theirs)
    // the editor's groups: R9's pin 2 and R10's pin 2 are on the two wires, which KiCad does not join without a junction, in either use
    const groups = editorGroups(r.project)
    expect(groups.some((g) => g.includes("R2.2") && g.includes("R4.2"))).toBe(false)
    expect(groups.some((g) => g.includes("R3.2") && g.includes("R5.2"))).toBe(false)
    // and with the flag taken off the editor joins them, in each use
    const plain = { ...r.project, sheets: r.project.sheets?.map(({ kicadRules: _k, ...rest }) => rest) }
    const joined = editorGroups(plain as Project)
    expect(joined.some((g) => g.includes("R2.2") && g.includes("R4.2"))).toBe(true)
    expect(joined.some((g) => g.includes("R3.2") && g.includes("R5.2"))).toBe(true)
  })
})

describe("a sheet with KiCad's rules is edited by them: a wire drawn to the side of another is cut there", () => {
  const R12 = 12.7
  const pt = (x: number, y: number) => ({ x: Math.round((x / R12) * 1e4) / 1e4, y: Math.round((-y / R12) * 1e4) / 1e4 })

  it("on a flagged sheet a new wire that ends on another's side cuts it, so the two are one net; another wire's end on the new wire's side cuts the new one", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const imported = importKicadSchematic(text, { built: BUILT })
    if (imported.status !== "imported") throw new Error("not imported")
    const project = imported.project
    expect(project.wires).toHaveLength(2)
    // a wire from (90, 130) up to (90, 120): its end is on the side of the wire along y = 120
    const { project: next, wire } = addWire(project, [pt(90, 130), pt(90, 120)])
    expect(wire).not.toBeNull()
    expect(next.wires).toHaveLength(4)
    const conn = computeConnectivity(next)
    const net = (id: string) => conn.wireNet.get(id)
    // the long wire is two wires meeting at (90, 120), and the new wire is on their net
    const pieces = next.wires.filter((w) => w.points.every((q) => Math.abs(q.y + 120 / R12) < 1e-3))
    expect(pieces).toHaveLength(2)
    expect(new Set([...pieces.map((w) => net(w.id)), net(wire!.id)]).size).toBe(1)
    // another wire's end on the side of the new wire: a wire ending at (90, 125) cuts the new one when the new one is drawn after it
    const second = addWire(next, [pt(90, 125), pt(95, 125)])
    expect(second.project.wires.length).toBeGreaterThan(next.wires.length)
    // an end lying on a side the wire does not cross does not cut
    const away = addWire(project, [pt(70, 130), pt(70, 125)])
    expect(away.project.wires).toHaveLength(3)
  })

  it("on a sheet drawn in the editor nothing is cut: the wire list is the editor's own", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R1, R2], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const imported = importKicadSchematic(text, { built: BUILT })
    if (imported.status !== "imported") throw new Error("not imported")
    const plain: Project = { ...imported.project, sheets: undefined }
    const { project: next } = addWire(plain, [pt(90, 130), pt(90, 120)])
    expect(next.wires).toHaveLength(3)
    expect(next.wires.slice(0, 2)).toEqual(plain.wires)
  })
})

describe("the cases hold for symbols turned and mirrored: the pin is where KiCad draws it, whatever the stored numbers", () => {
  for (const turn of [0, 90, 180, 270]) {
    for (const mirror of [undefined, "x", "y"] as const) {
      it(`a T with no junction on pin 1 of a symbol turned ${turn}${mirror ? ` and mirrored about ${mirror}` : ""}`, () => {
        // where the editor puts pin 1 of such a symbol at (100, 100): read from a file with the symbol alone, in KiCad's frame (millimetres, y down)
        const lone = importKicadSchematic(schematic({ libs: [LIB_R], symbols: [R("R1", `100 100 ${turn}`, 1, mirror ? { mirror } : {})] }), { built: BUILT })
        if (lone.status !== "imported") throw new Error("not imported")
        const c = lone.project.components[0]
        const p1 = schematicPins(c, findPart(c.partId)).find((p) => p.pin === "1")!.pos
        const px = Math.round(p1.x * 12.7 * 1e4) / 1e4
        const py = Math.round(-p1.y * 12.7 * 1e4) / 1e4
        // a wire from the pin 10 mm down to y + 10, ending on the side of a wire along y + 10 whose left end is pin 2 of an unturned R2
        const R2b = R("R2", `${px - 5} ${py + 10 - 3.81} 0`, 2)
        const text = schematic({ libs: [LIB_R], symbols: [R("R1", `100 100 ${turn}`, 1, mirror ? { mirror } : {}), R2b], wires: [`${px - 5} ${py + 10} ${px + 5} ${py + 10}`, `${px} ${py} ${px} ${py + 10}`] })
        const r = run(text)
        expect(r.flagged).toBe(true)
        expect(r.theirs).toEqual([])
        expect(r.mine).toEqual(r.theirs)
        expect(r.without).toEqual([["R1.1", "R2.2"]])
      })
    }
  }
})

{
// S11, the edits: a sheet joined by KiCad's rules (`SchematicSheet.kicadRules`) keeps KiCad's integer points (100 nm) through every edit, and every edit follows
// KiCad's rules for what a wire joins: a wire an edit puts on another wire's side is cut there (KiCad breaks the wires at the new T when it finishes an edit), an old
// T that joins nothing is left alone, and nothing an edit moves is parted from what it was joined to by the editor's rounding to four digits.
//
// The nets of an edited sheet are compared with the independent derivation of the same sheet written out as a KiCad file (`tests/kicad-census/netlist-sch.mjs`, which
// shares no code with `src`), on a sheet whose points are on KiCad's 1.27 mm grid, where the editor's four digits and KiCad's points are the same points.

const BUILT = new Set([...BUILT_EXTENSIONS, "S2", "S5", "S6", "S10"])
const dir = mkdtempSync(join(tmpdir(), "kicad-s11-edits-"))
let counter = 0

const R = (ref: string, at: string, n: number, extra: Partial<SymSpec> = {}): SymSpec => ({ lib: "Device:R", at, ref, uuid: `33333333-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, ...extra })
const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => a.join().localeCompare(b.join()))

/** The pins that share a net with another, as `REF.pin` groups, in the editor's reading of a project. */
function editorGroups(project: Project): string[][] {
  const { pinNet } = computeConnectivity(project)
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const byNet = new Map<string, string[]>()
  for (const [key, netId] of pinNet) {
    const at = key.lastIndexOf(":")
    const id = key.slice(0, at)
    if (!refOf.has(id)) continue
    const pin = `${refOf.get(id)}.${key.slice(at + 1)}`
    const list = byNet.get(netId) ?? []
    if (!list.includes(pin)) list.push(pin)
    byNet.set(netId, list)
  }
  return sorted([...byNet.values()].filter((l) => l.length > 1))
}

const mm = (v: number) => (v * 12.7).toFixed(4)

/** The project's sheet written out as a KiCad file, and KiCad's groups of it by the independent derivation. */
function kicadGroups(project: Project): string[][] {
  const refs = new Map<string, string>()
  const symbols = project.components.map((c, i) => {
    const spec = R(c.ref, `${mm(c.sch.x)} ${mm(-c.sch.y)} ${c.sch.rot}`, i + 1, c.sch.mirror ? { mirror: c.sch.mirror } : {})
    refs.set(spec.uuid, c.ref)
    return spec
  })
  const wires = project.wires.flatMap((w) => w.points.slice(1).map((p, i) => `${mm(w.points[i].x)} ${mm(-w.points[i].y)} ${mm(p.x)} ${mm(-p.y)}`))
  const d = join(dir, `t${counter++}`)
  mkdirSync(d)
  const file = join(d, "root.kicad_sch")
  writeFileSync(file, schematic({ libs: [LIB_R], symbols, wires }))
  const derived = deriveNets(file, { hiddenPower: true, localJoinsGlobal: "same" })
  const byGroup = new Map<number, string[]>()
  for (const [key, g] of derived.pins) {
    const [, uuid, pin] = /^\/([^#]+)#(.*)$/.exec(key)!
    for (const x of ([] as number[]).concat(g)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(`${refs.get(uuid)}.${pin}`)
  }
  return sorted([...byGroup.values()].filter((l) => l.length > 1))
}

function load(text: string): Project {
  const imported = importKicadSchematic(text, { built: BUILT })
  if (imported.status !== "imported") throw new Error("not imported")
  expect(imported.project.sheets?.some((s) => s.kicadRules)).toBe(true)
  return imported.project
}

const id = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id
/** The wire with a point at (x, y) millimetres (KiCad's frame). */
const wireAt = (p: Project, x: number, y: number) => p.wires.find((w) => w.points.some((q) => Math.abs(q.x * 12.7 - x) < 1e-3 && Math.abs(-q.y * 12.7 - y) < 1e-3))!

// ---- the sheet of the proof: KiCad's points at 100 mm, which the editor keeps to six digits (7.874016, -9.448819) ----
// R1 above a wire from R2 to R4 (a T with a junction: three pins on one net), and a second T with no junction (R5 above a wire from R6): KiCad joins nothing there,
// which is what makes the sheet one joined by KiCad's rules.
const PROOF = () =>
  load(
    schematic({
      libs: [LIB_R],
      symbols: [R("R1", "100 100 0", 1), R("R2", "80 116.19 0", 2), R("R4", "120 116.19 0", 4), R("R5", "140 100 0", 5), R("R6", "130 116.19 0", 6)],
      wires: ["80 120 120 120", "100 103.81 100 120", "130 120 160 120", "140 103.81 140 120"],
      junctions: ["100 120"],
    }),
  )

// ---- the sheet for the oracle: every point on KiCad's 1.27 mm grid (n steps of 1.27 mm), so the editor's four digits are KiCad's points ----
const G = (n: number) => (n * 1.27).toFixed(2)
const at = (x: number, y: number, rot = 0) => `${G(x)} ${G(y)} ${rot}`
const seg = (x1: number, y1: number, x2: number, y2: number) => `${G(x1)} ${G(y1)} ${G(x2)} ${G(y2)}`
// A resistor at (x, y) has its pins at (x, y - 3) and (x, y + 3) steps. R1 over the junctioned wire from R2 to R4 at y 95; R5 over R6's wire (the second T, no junction);
// R7 above the wire R6 - (120, 95), with a wire from its pin down to y 90 that ends in the air.
const GRID = () =>
  load(
    schematic({
      libs: [LIB_R],
      symbols: [R("R1", at(80, 80), 1), R("R2", at(64, 92), 2), R("R4", at(96, 92), 4), R("R5", at(114, 80), 5), R("R6", at(104, 92), 6), R("R7", at(108, 80), 7)],
      wires: [seg(64, 95, 96, 95), seg(80, 83, 80, 95), seg(104, 95, 120, 95), seg(114, 83, 114, 95), seg(108, 83, 108, 90)],
      junctions: [`${G(80)} ${G(95)}`],
    }),
  )

const KICAD_NETS = [["R1.2", "R2.2", "R4.2"]]

/** Every group there was is still whole, and no two of them are one: a part turned may touch a loose pin's net (drawing), never part or join the nets that stand. */
function kept(want: string[][], got: string[][]): boolean {
  const whole = want.every((g) => got.some((h) => g.every((x) => h.includes(x))))
  const apart = got.every((h) => want.filter((g) => g.some((x) => h.includes(x))).length <= 1)
  return whole && apart
}
const step = (n: number) => (n * 1.27) / 12.7

describe("the sheets of these tests are what they claim", () => {
  it("the proof sheet: three pins on one net, and the second T joins nothing, in the editor's reading", () => {
    const p = PROOF()
    expect(editorGroups(p)).toEqual(KICAD_NETS)
    // the wires are at KiCad's six digits, not the editor's four
    expect(wireAt(p, 100, 120).points.some((q) => q.x === 7.874016 && q.y === -9.448819)).toBe(true)
  })

  it("the grid sheet: the editor's nets are the oracle's", () => {
    const p = GRID()
    expect(editorGroups(p)).toEqual(KICAD_NETS)
    expect(kicadGroups(p)).toEqual(KICAD_NETS)
  })
})

describe("moving a part on a sheet joined by KiCad's rules keeps its points, so it drops no join", () => {
  it("R2 moved by (-0.5, 0) keeps R1.2 + R2.2 + R4.2 on one net (findRubberBands, moveSchematicItems)", () => {
    const p = PROOF()
    const ids = { components: [id(p, "R2")], labels: [], wires: [] }
    const moved = moveSchematicItems(p, ids, { x: -0.5, y: 0 }, findRubberBands(p, ids.components, [], []))
    expect(editorGroups(moved)).toEqual(KICAD_NETS)
  })

  it("every part, moved every way a drag moves it, keeps the nets it had (moveComponent, dragSelection)", () => {
    const p = PROOF()
    for (const ref of ["R1", "R2", "R4", "R5", "R6"]) {
      for (const [dx, dy] of [[-0.5, 0], [0.3, 0], [0, -0.4], [0, 0.55], [-0.2, 0.2], [0.1, 0.1]]) {
        const c = p.components.find((x) => x.ref === ref)!
        const a = moveComponent(p, c.id, { x: c.sch.x + dx, y: c.sch.y + dy })
        expect(editorGroups(a), `${ref} by ${dx},${dy} (moveComponent)`).toEqual(KICAD_NETS)
        const b = dragSelection(p, { components: [c.id], labels: [], wires: [] }, { x: dx, y: dy })
        if (b.ok) expect(editorGroups(b.project), `${ref} by ${dx},${dy} (dragSelection)`).toEqual(KICAD_NETS)
      }
    }
  })

  it("a part, its wires and what is on them carried together keep their joins, and the points they leave alone stay exactly where they were", () => {
    const p = PROOF()
    const comps = ["R1", "R2", "R4"].map((r) => id(p, r))
    const wires = ["80 120", "100 103.81", "100 120"].flatMap((s) => {
      const [x, y] = s.split(" ").map(Number)
      return wireAt(p, x, y) ? [wireAt(p, x, y).id] : []
    })
    const ids = { components: comps, labels: [], wires: [...new Set(wires)] }
    const moved = moveSchematicItems(p, ids, { x: 0.3, y: -0.2 }, findRubberBands(p, comps, [], ids.wires))
    expect(editorGroups(moved)).toEqual(KICAD_NETS)
    // R5 and R6 and their wires did not move: their points are the very same objects' values, at six digits
    const still = wireAt(p, 140, 103.81)
    expect(moved.wires.find((w) => w.id === still.id)).toEqual(still)
  })

  it("the sheet's old T (R5 over R6's wire) is not joined by an edit that has nothing to do with it", () => {
    const p = PROOF()
    const c = p.components.find((x) => x.ref === "R1")!
    const moved = moveComponent(p, c.id, { x: c.sch.x - 0.3, y: c.sch.y })
    expect(editorGroups(moved).flat()).not.toContain("R5.2")
  })

  it("a sheet drawn in the editor keeps the editor's four digits: nothing is changed for it", () => {
    const p: Project = { ...PROOF(), sheets: undefined }
    const ids = { components: [id(p, "R2")], labels: [], wires: [] }
    const moved = moveSchematicItems(p, ids, { x: -0.5, y: 0 }, findRubberBands(p, ids.components, [], []))
    const was = new Set(p.wires.flatMap((w) => w.points.flatMap((q) => [q.x, q.y])))
    for (const w of moved.wires) for (const q of w.points) for (const v of [q.x, q.y]) if (!was.has(v)) expect(Math.round(v * 1e4) / 1e4).toBe(v)
    expect(settleKicadSheet(p, moved)).toBe(moved)
  })
})

describe("a wire put on another wire's side by an edit is cut there, as KiCad cuts it", () => {
  /** R7's wire (108, 83 to 90) carried down five steps ends at (108, 95): on the side of the wire from R6.2 to (120, 95). */
  const w7 = (p: Project) => wireAt(p, 108 * 1.27, 90 * 1.27)

  it("dragging a part with its wire so the wire's end lands on a wire's side joins them, and the old T stays unjoined (moveSchematicItems, against the oracle)", () => {
    const p = GRID()
    const ids = { components: [id(p, "R7")], labels: [], wires: [w7(p).id] }
    const moved = moveSchematicItems(p, ids, { x: 0, y: -step(5) }, findRubberBands(p, ids.components, [], ids.wires))
    // y is up in the editor: -step is down on screen
    const mine = editorGroups(moved)
    expect(mine).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    expect(kicadGroups(moved)).toEqual(mine)
    // the wire from R6.2 is cut at the new end, so the two ends meet
    expect(moved.wires.length).toBe(p.wires.length + 1)
  })

  it("the same by dragSelection and by moveComponent", () => {
    const p = GRID()
    const a = dragSelection(p, { components: [id(p, "R7")], labels: [], wires: [w7(p).id] }, { x: 0, y: -step(5) })
    expect(a.ok).toBe(true)
    if (a.ok) expect(editorGroups(a.project)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    const c = p.components.find((x) => x.ref === "R7")!
    const b = moveComponent(p, c.id, { x: c.sch.x, y: c.sch.y - step(5) })
    expect(editorGroups(b)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
  })

  it("a wire drawn onto a wire's side is cut there (addWire)", () => {
    const p = GRID()
    const x = 108 * 0.1
    const { project } = addWire(p, [{ x, y: -(90 * 1.27) / 12.7 }, { x, y: -(95 * 1.27) / 12.7 }])
    expect(editorGroups(project)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    expect(kicadGroups(project)).toEqual(editorGroups(project))
  })

  it("a copy pasted so the end of its wire lies on a wire's side joins it (pasteItems, against the oracle)", () => {
    const p = GRID()
    const c = p.components.find((x) => x.ref === "R7")!
    const clip: Clipboard = { project: p, components: [c.id], wires: [w7(p).id], labels: [], blocks: [] }
    const res = pasteItems(p, clip, { x: step(2), y: -step(5) })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const copy = res.project.components.find((x) => !p.components.some((y) => y.id === x.id))!
    const group = editorGroups(res.project).find((g) => g.includes("R6.2"))
    expect(group).toEqual(["R6.2", `${copy.ref}.2`].sort())
    expect(kicadGroups(res.project)).toEqual(editorGroups(res.project))
  })

  it("a copy of a network keeps its joins at six digits (pasteItems)", () => {
    const p = PROOF()
    const comps = ["R1", "R2", "R4"].map((r) => id(p, r))
    const wires = [wireAt(p, 80, 120).id, wireAt(p, 100, 103.81).id, wireAt(p, 120, 120).id]
    const clip: Clipboard = { project: p, components: comps, wires: [...new Set(wires)], labels: [], blocks: [] }
    const res = pasteItems(p, clip, { x: 1.5, y: -1 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(editorGroups(res.project)).toHaveLength(2)
  })

  it("the store settles an edit that put a wire on another's side, whatever made it (commit)", () => {
    const p = GRID()
    projectApi().open(p)
    const x = 108 * 0.1
    const wire = { id: "wx", points: [{ x, y: -(90 * 1.27) / 12.7 }, { x, y: -(95 * 1.27) / 12.7 }] }
    projectApi().commit((q) => ({ ...q, wires: [...q.wires, wire] }))
    const made = projectApi().project!
    expect(editorGroups(made)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    projectApi().close()
  })
})

describe("settleKicadSheet", () => {
  it("returns an unflagged project, and an edit that changed no wire, as it is", () => {
    const p = PROOF()
    const plain: Project = { ...p, sheets: undefined }
    const edited = { ...plain, wires: [...plain.wires] }
    expect(settleKicadSheet(plain, edited)).toBe(edited)
    expect(settleKicadSheet(p, p)).toBe(p)
    const relabelled = { ...p, labels: [] }
    expect(settleKicadSheet(p, relabelled)).toBe(relabelled)
  })

  it("is idempotent: settling an edit a second time changes nothing, and an old T stays unjoined", () => {
    const p = GRID()
    const x = 108 * 0.1
    const { project: once } = addWire(p, [{ x, y: -(90 * 1.27) / 12.7 }, { x, y: -(95 * 1.27) / 12.7 }])
    const twice = settleKicadSheet(p, once)
    expect(twice.wires).toEqual(once.wires)
    expect(editorGroups(twice).flat()).not.toContain("R5.2")
  })
})

describe("turning and mirroring a part on a sheet joined by KiCad's rules keep its nets", () => {
  const turns = () => [PROOF(), GRID()]
  for (const [name, sheet] of [["the proof sheet", PROOF], ["the grid sheet", GRID]] as const) {
    it(`every part, turned a quarter at a time and mirrored both ways, on ${name}`, () => {
      const p = sheet()
      const want = editorGroups(p)
      for (const c of p.components) {
        let q = p
        for (let i = 0; i < 4; i++) {
          const r = rotateSelection(q, { components: [c.id], labels: [] })
          if (!r.ok) break
          q = r.project
          expect(kept(want, editorGroups(q)), `${c.ref} turned ${i + 1} times: ${JSON.stringify(editorGroups(q))}`).toBe(true)
          if (name === "the grid sheet") expect(kicadGroups(q), `${c.ref} turned ${i + 1} times (oracle)`).toEqual(editorGroups(q))
        }
        for (const axis of ["x", "y"] as Mirror[]) {
          const r = mirrorSelection(p, { components: [c.id] }, axis)
          if (!r.ok) continue
          expect(kept(want, editorGroups(r.project)), `${c.ref} mirrored ${axis}: ${JSON.stringify(editorGroups(r.project))}`).toBe(true)
          if (name === "the grid sheet") expect(kicadGroups(r.project), `${c.ref} mirrored ${axis} (oracle)`).toEqual(editorGroups(r.project))
        }
      }
    })
  }
  void turns
})

describe("deleting on a sheet joined by KiCad's rules leaves the other nets as they were", () => {
  it("a part or a wire deleted: the pins left are joined as KiCad joins them", () => {
    const p = GRID()
    for (const ref of ["R5", "R6", "R7"]) {
      const q = removeItems(p, { components: [id(p, ref)] })
      expect(editorGroups(q)).toEqual(KICAD_NETS)
      expect(kicadGroups(q)).toEqual(KICAD_NETS)
    }
    const q = removeItems(p, { wires: [wireAt(p, 64 * 1.27, 95 * 1.27).id] })
    expect(kicadGroups(q)).toEqual(editorGroups(q))
  })
})

describe("Tidy on a sheet joined by KiCad's rules", () => {
  it("when it succeeds, the nets it leaves are KiCad's and are the nets there were", () => {
    const p = GRID()
    const r = tidySchematic(p)
    if (!r.ok || !r.changed) return
    expect(editorGroups(r.project).filter((g) => !g.some((x) => /^R[5-7]/.test(x)))).toEqual(KICAD_NETS)
    expect(kicadGroups(r.project)).toEqual(editorGroups(r.project))
  })
})

describe("Sakura's tools on a sheet joined by KiCad's rules", () => {
  it("connect joins what it says, in KiCad's reading too, and leaves the old T alone", () => {
    const p = GRID()
    const out = runTool(p, "connect", { pins: ["R7.2", "R6.1"] })
    expect(out.isError).toBe(false)
    const mine = editorGroups(out.project)
    expect(mine.some((g) => g.includes("R7.2") && g.includes("R6.1"))).toBe(true)
    expect(mine.flat()).not.toContain("R5.2")
    expect(kicadGroups(out.project)).toEqual(mine)
  })

  it("moving a part keeps its nets (update_component) and removing one leaves the others' (remove_component)", () => {
    const p = PROOF()
    const out = runTool(p, "update_component", { ref: "R2", x: -3, y: 0 })
    expect(out.isError).toBe(false)
    expect(editorGroups(out.project)).toEqual(KICAD_NETS)
    const gone = runTool(p, "remove_component", { ref: "R6" })
    expect(editorGroups(gone.project)).toEqual(KICAD_NETS)
  })

  it("turning a part keeps its nets (update_component rotation)", () => {
    const p = PROOF()
    const out = runTool(p, "update_component", { ref: "R1", rotation: 90 })
    expect(out.isError).toBe(false)
    expect(editorGroups(out.project)).toEqual(KICAD_NETS)
  })
})
}
