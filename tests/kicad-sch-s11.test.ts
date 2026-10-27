import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { addWire } from "../src/model/ops"
import { findPart } from "../src/model/library"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { deriveNets } from "./kicad-census/netlist-sch.mjs"
import { LIB_R, ROOT_UUID, schematic, type SymSpec } from "./kicad-schematic-fixtures"
import { CHILD_UUID, S1, S2, files as sheetFiles } from "./kicad-sheets-fixtures"

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
