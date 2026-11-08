import { afterAll, describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { isKicadBoardProject } from "../src/export/kicadBoard"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES, importKicadBoard } from "../src/model/kicad/board"
import { setCopperLayerCount } from "../src/model/layerOps"
import { addTrace, createProject } from "../src/model/ops"
import { copperLayers } from "../src/model/stack"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads, schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import { type ComponentInstance, type DrawingBus, type DrawingLine, type Project, type SchematicDrawing } from "../src/model/types"
import { imp, S1, S2 } from "./kicad-sheets-fixtures"
import { bus, entry, label, load, pinsOn, resistor, sheetSymbol } from "./kicad-sch-s3-fixtures"
import { LIB_R, ROOT_UUID, schematic, type SymSpec } from "./kicad-schematic-fixtures"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bomCsv } from "../src/export/bom"
import { gerberLayers } from "../src/export/gerber"
import { pnpCsv } from "../src/export/pnp"
import { getConnectivity, sameSchematic } from "../src/model/connectivityCache"
import { moveDrawing } from "../src/model/drawings"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { joinFlags, onBoard, setFlags } from "../src/model/partFlags"
import { resolvedComponents, ruleAreaFlags, symbolBox } from "../src/model/ruleAreas"
import { commitOnUse, ROOT_SHEET, sheetUses } from "../src/model/sheets"
import { addVariant, setActiveVariant, setVariantOverride } from "../src/model/variants"
import { projectApi } from "../src/store/projectStore"
import { deriveNets } from "./kicad-census/netlist-sch.mjs"
import { built } from "./built"
import { buildFabricationFiles } from "../src/export/bundle"
import { schematicSvg } from "../src/ai/vision/schematicSvg"
import { measureSchematic } from "../src/ai/vision/measure"
import { parseSexpr } from "./kicad-census/sexpr.mjs"
import { kicad9SheetProblems } from "./kicad9-strict"
import { flagVoice } from "../src/model/kicad/schematic/read"
import { importKicadProject } from "../src/model/kicad/project"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { ALL_LIBS, importSheet, place } from "./kicad-sch-parts"
import { importedProject as imported } from "./kicad-test-helpers"
import { runTool } from "../src/ai/tools"
import { addSheetPin, addSheetUse, moveSheetSymbols, removeSheetSymbols, resizeSheetSymbol, setSheetSymbol } from "../src/model/sheetOps"
import { pasteItems, setSymbolVariant } from "../src/model/schematicEdit"
import { followNetRenames } from "../src/model/copperNets"

// The join of the board writer (X16) and multi-sheet schematics (S1): a board of a project with sheets names its nets as the sheets do.
const uses = [{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Other", y: 80 }]
/** The hierarchical schematic of the fixtures, with a land on every part and, if asked, a board outline (what makes it a board import). */
const hierarchical = (withBoard: boolean): Project => {
  const p = imp(uses).project
  // The fixtures' symbols name no footprint: give the part a land so the board has pads.
  for (const c of p.components) { const part = findPart(c.partId); if (part) part.footprints = ["0603"] }
  return { ...p, components: p.components.map((c) => ({ ...c, footprint: "0603", pcb: { ...c.pcb, placed: true } })), board: withBoard ? { ...p.board, outline: { paths: [] } } : p.board } as Project
}

describe("the board writer and the sheets", () => {
  it("a board from a project with sheets: each pad's net is the sheet-path net the connectivity names", async () => {
    const p = hierarchical(true)
    expect(isKicadBoardProject(p)).toBe(true)
    const conn = computeConnectivity(p)
    const expected = new Map<string, string>()
    for (const c of p.components) for (const pad of pcbPads(c)) {
      const net = conn.nets.find((n) => n.pins.some((x) => x.componentId === c.id && x.pin === pad.pin))
      if (net) expected.set(`${c.ref}:${pad.padNumber}`, net.name)
    }
    expect(new Set(expected.values())).toEqual(new Set(["/Power/VIN", "/Other/VIN"]))
    const pcb = Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    const found = new Map<string, string>()
    for (const fp of pcb.split(/\n\s*\(footprint /).slice(1)) {
      const ref = /\(property "Reference" "([^"]+)"/.exec(fp)![1]
      for (const pd of fp.split(/\n\s*\(pad /).slice(1)) {
        const net = /\(net (?:\d+ )?"([^"]*)"\)/.exec(pd)
        if (net?.[1]) found.set(`${ref}:${/^"([^"]*)"/.exec(pd)![1]}`, net[1])
      }
    }
    expect(found.size).toBe(expected.size)
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(expected))
  })
  it("the gate keeps a hierarchical schematic import on the converter's path", () => {
    expect(isKicadBoardProject(hierarchical(false))).toBe(false)
  })
  it("a four-layer board of a project with sheets keeps its inner copper and its sheet nets through the file", async () => {
    let p = setCopperLayerCount(hierarchical(true), 4).project
    p = addTrace(p, { layer: "in1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }).project
    p = addTrace(p, { layer: "in2", width: 0.2, points: [{ x: 0, y: 2 }, { x: 5, y: 2 }] }).project
    const pcb = Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(pcb).toMatch(/\(layers[^]*"In1\.Cu"[^]*"In2\.Cu"/)
    expect(pcb).toMatch(/\(segment[^]*?\(layer "In1\.Cu"\)/)
    expect(pcb).toMatch(/\(segment[^]*?\(layer "In2\.Cu"\)/)
    const again = importKicadBoard(pcb)
    if (again.status !== "imported") throw new Error(again.message)
    expect(copperLayers(again.project.board)).toEqual(["top", "in1", "in2", "bottom"])
    expect(again.project.traces.map((t) => t.layer).sort()).toEqual(["in1", "in2"])
    expect(pcb).toContain('"/Power/VIN"')
    expect(pcb).toContain('"/Other/VIN"')
  })
  it("the project file is at version 6 (the whole KiCad import is the one step from 2 to 3)", () => {
    expect(PROJECT_FILE_VERSION).toBe(6)
  })
})

// The join of the flatten fix (a net of a sheet used twice is the use's own) and buses (S3): the members of a local bus are the use's own too.
describe("a sheet used twice with a local bus and a local net", () => {
  const A1 = "00000000-0000-4000-8000-0000000000a1"
  const A2 = "00000000-0000-4000-8000-0000000000a2"
  const files = () => {
    const root = schematic({
      libs: [LIB_R],
      symbols: [resistor("R1", 50.8, 50.8, "aaaaaaaa-0000-4000-8000-000000000001")],
      wires: ["50.8 46.99 50.8 40.64"],
      body: [label("D3", 50.8, 40.64), sheetSymbol(A1, "Sub1", "child.kicad_sch", 100, []), sheetSymbol(A2, "Sub2", "child.kicad_sch", 140, [])],
    })
    const child = schematic({
      uuid: "00000000-0000-4000-8000-0000000000c1",
      libs: [LIB_R],
      symbols: [resistor("R9", 50.8, 50.8, "bbbbbbbb-0000-4000-8000-000000000001", [`/${ROOT_UUID}/${A1}|R2`, `/${ROOT_UUID}/${A2}|R3`])],
      wires: ["50.8 46.99 50.8 40.64"],
      body: [bus(40.64, 38.1, 63.5, 38.1), label("D[0..7]", 43.18, 38.1), entry(50.8, 40.64, 2.54, -2.54), label("D3", 50.8, 40.64)],
    })
    return new Map([["root.kicad_sch", root], ["child.kicad_sch", child]])
  }

  it("keeps /D3, /Sub1/D3 and /Sub2/D3 as three separate nets, each with its own part", () => {
    const { project } = load(files())
    const nets = computeConnectivity(project).nets
    expect(nets.map((n) => n.name).sort()).toEqual(["/D3", "/Sub1/D3", "/Sub2/D3"])
    expect(pinsOn(project, nets.find((n) => n.name === "/D3")!)).toEqual(["R1.1"])
    expect(pinsOn(project, nets.find((n) => n.name === "/Sub1/D3")!)).toEqual(["R2.1"])
    expect(pinsOn(project, nets.find((n) => n.name === "/Sub2/D3")!)).toEqual(["R3.1"])
  })

  it("is still three nets when the project is flattened for Circuit JSON", async () => {
    const { project } = load(files())
    const { projectToCircuitJson } = await import("../src/export/circuitJson")
    const names = projectToCircuitJson(project).elements.filter((e) => e.type === "source_net").map((e) => (e as unknown as { name: string }).name)
    expect(names.filter((n) => /D3$/.test(n))).toHaveLength(3)
    expect(new Set(names).size).toBe(names.length)
  })
})

// The join of S9 (variants) with S8 (rule areas, sheet symbols' flags), S3 (buses) and S11 (KiCad's joining rules): the one resolver chain of KiCad 10, and the
// buses of a sheet joined by KiCad's rules.

// ---------- the resolver: variant, then the sheet symbols, then the rule areas ----------

const base = built("regulator")
const areaOver = (c: ComponentInstance, ruleArea: NonNullable<DrawingLine["ruleArea"]>): DrawingLine => {
  const b = symbolBox(c)
  const x = (b.minX + b.maxX) / 2
  const y = (b.minY + b.maxY) / 2
  const d = 0.01
  return { id: `area-${c.id}`, type: "line", closed: true, points: [{ x: x - d, y: y - d }, { x: x + d, y: y - d }, { x: x + d, y: y + d }, { x: x - d, y: y + d }], ruleArea }
}
/** A placed part with a hole, alone in its box: an area over it touches no other symbol. */
const pick = (() => {
  for (const c of base.components) {
    if (!c.pcb.placed || !onBoard(c) || !pcbPads(c).some((p) => p.holeDiameter !== undefined)) continue
    const p = { ...base, drawings: [...(base.drawings ?? []), areaOver(c, { dnp: true })] }
    if (ruleAreaFlags(p).size === 1) return c
  }
  throw new Error("no through-hole part of the regulator stands alone")
})()
const flagsOf = (p: Project) => resolvedComponents(p).find((c) => c.id === pick.id)!.flags
const withArea = (p: Project): Project => ({ ...p, drawings: [...(p.drawings ?? []), areaOver(pick, { dnp: true })] })
const withSheet = (p: Project): Project => ({
  ...p,
  sheetSymbols: [{ id: "sym", sheet: ROOT_SHEET, child: "child", name: "child", file: "child", x: 0, y: 0, w: 1, h: 1, pins: [], flags: { dnp: true } }] as unknown as Project["sheetSymbols"],
  components: p.components.map((c) => (c.id === pick.id ? { ...c, inst: "/sym" } : c)),
})
const withOwn = (p: Project, flags: NonNullable<ComponentInstance["flags"]>): Project => ({ ...p, components: p.components.map((c) => (c.id === pick.id ? { ...c, flags } : c)) })
const variant = (p: Project, name: string, patch: Parameters<typeof setVariantOverride>[3], active = true): Project => {
  const added = addVariant(p, name) ?? p
  const set = setVariantOverride(added, pick.id, name, patch)
  return active ? setActiveVariant(set, name) : set
}

describe("resolvedComponents: the variant, then the sheet symbols, then the rule areas (KiCad 10's order)", () => {
  it("a variant sets dnp, the sheet does not, and the area does: the part is dnp", () => {
    const p = withArea(variant(base, "V", { dnp: true }))
    expect(flagsOf(p)?.dnp).toBe(true)
    // the area alone, and the variant alone, say the same
    expect(flagsOf(withArea(base))?.dnp).toBe(true)
    expect(flagsOf(variant(base, "V", { dnp: true }))?.dnp).toBe(true)
  })

  it("a variant clears dnp the part has, but a rule area sets it again: the part stays dnp", () => {
    const own = withOwn(base, { dnp: true })
    const cleared = variant(own, "V", { dnp: false })
    // the variant does clear the part's own flag ...
    expect(flagsOf(cleared)?.dnp).toBeUndefined()
    // ... and not one an area sets
    expect(flagsOf(withArea(cleared))?.dnp).toBe(true)
    expect(bomCsv(withArea(cleared))).toEqual(bomCsv(withArea(own)))
  })

  it("a variant never clears a flag a sheet symbol sets, and a resolved project is not resolved twice", () => {
    const cleared = variant(withOwn(base, { dnp: true }), "V", { dnp: false })
    const sheet = withSheet(cleared)
    expect(flagsOf(sheet)?.dnp).toBe(true)
    expect(flagsOf(withArea(sheet))?.dnp).toBe(true)
    // the components the resolver made, put through it again (a flattened project, a copy), keep the flag
    const again: Project = { ...withArea(sheet), components: resolvedComponents(withArea(sheet)) }
    expect(flagsOf(again)?.dnp).toBe(true)
  })

  it("a sheet symbol's own variant is read on each use", () => {
    const sheet = withSheet(addVariant(base, "V")!)
    const sym = sheet.sheetSymbols![0]
    const lifted: Project = { ...setActiveVariant(sheet, "V"), sheetSymbols: [{ ...sym, flags: { dnp: true }, variants: { "": { V: { dnp: false } } } }] }
    expect(flagsOf(lifted)?.dnp).toBeUndefined()
    expect(flagsOf({ ...lifted, sheetSymbols: [{ ...sym, flags: { dnp: true } }] })?.dnp).toBe(true)
  })

  it("switching the active variant flips the BOM, the position file and the Gerber files, and switching back restores them", () => {
    const off = { excludeFromBom: true, notOnBoard: true } as const
    const a = variant(variant(base, "NoPart", off, false), "Other", {}, false)
    const pA = setActiveVariant(a, "NoPart")
    const pB = setActiveVariant(a, "Other")
    const none = setActiveVariant(a, undefined)
    expect(bomCsv(pA)).not.toEqual(bomCsv(pB))
    expect(pnpCsv(pA)).not.toEqual(pnpCsv(pB))
    expect(gerberLayers(pA)).not.toEqual(gerberLayers(pB))
    expect(bomCsv(pB)).toEqual(bomCsv(none))
    expect(gerberLayers(pB)).toEqual(gerberLayers(none))
    // and back again: the same answers as the first time
    const back = setActiveVariant(pB, "NoPart")
    expect(bomCsv(back)).toEqual(bomCsv(pA))
    expect(gerberLayers(back)).toEqual(gerberLayers(pA))
  })

  it("the cache is not stale after a switch (the components array is the same object)", () => {
    const a = variant(variant(base, "NoPart", { notOnBoard: true }, false), "Other", {}, false)
    const pA = setActiveVariant(a, "NoPart")
    const pB = setActiveVariant(a, "Other")
    expect(pA.components).toBe(pB.components)
    const onA = () => resolvedComponents(pA).find((c) => c.id === pick.id)!.flags?.notOnBoard
    const onB = () => resolvedComponents(pB).find((c) => c.id === pick.id)!.flags?.notOnBoard
    expect(onA()).toBe(true)
    expect(onB()).toBeUndefined()
    expect(onA()).toBe(true)
    // the same object with only the active name changed, as a store update does
    const swapped: Project = { ...pA, variants: { ...pA.variants!, active: "Other" } }
    expect(resolvedComponents(swapped).find((c) => c.id === pick.id)!.flags?.notOnBoard).toBeUndefined()
    // the same with an area on the part: the area's flag is kept, the variant's follows the switch
    const area = withArea(pA)
    expect(resolvedComponents(area).find((c) => c.id === pick.id)!.flags).toEqual({ notOnBoard: true, dnp: true })
    expect(resolvedComponents({ ...area, variants: { ...area.variants!, active: "Other" } }).find((c) => c.id === pick.id)!.flags).toEqual({ dnp: true })
  })

  it("costs nothing without a variant, a flagged area or a flagged sheet symbol: the project's own array", () => {
    expect(resolvedComponents(base)).toBe(base.components)
    const listed = addVariant(base, "V")!
    expect(resolvedComponents(listed)).toBe(listed.components)
  })

  it("the connectivity of a project is worked out again when the variant is switched (a part off the board names no net)", () => {
    const a = variant(variant(base, "NoPart", { notOnBoard: true }, false), "Other", {}, false)
    const pA = setActiveVariant(a, "NoPart")
    const pB = setActiveVariant(a, "Other")
    const first = getConnectivity(pA)
    expect(getConnectivity(pB)).not.toBe(first)
    expect(getConnectivity(pA)).toBeDefined()
  })
})

// ---------- buses on a sheet joined by KiCad's rules ----------

const dir = mkdtempSync(join(tmpdir(), "kicad-join-187-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let counter = 0
const BUILT = new Set([...BUILT_EXTENSIONS, "S2", "S5", "S6", "S10"])
const R = (ref: string, at: string, n: number, extra: Partial<SymSpec> = {}): SymSpec => ({ lib: "Device:R", at, ref, uuid: `44444444-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, ...extra })
const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => a.join().localeCompare(b.join()))

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

function kicadGroups(text: string, project: Project, bySymbol: Map<{ uuid: string }, { id: string }>): string[][] {
  const d = join(dir, `t${counter++}`)
  mkdirSync(d)
  const file = join(d, "root.kicad_sch")
  writeFileSync(file, text)
  const derived = deriveNets(file, { hiddenPower: true, localJoinsGlobal: "same" })
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const refByUuid = new Map([...bySymbol].map(([sym, c]) => [sym.uuid, refOf.get(c.id)!]))
  const byGroup = new Map<number, string[]>()
  for (const [key, g] of derived.pins) {
    const [, uuid, pin] = /^\/([^#]+)#(.*)$/.exec(key)!
    for (const x of ([] as number[]).concat(g)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(`${refByUuid.get(uuid)}.${pin}`)
  }
  return sorted([...byGroup.values()].filter((l) => l.length > 1))
}

/**
 * A sheet with an unjunctioned T (R1 over R2's wire: KiCad joins nothing there, which is what makes the importer flag the sheet), a bus `D[0..7]` and a second bus
 * `E[0..3]` whose end lies on the first's side, at (60.96, 38.1), and R3 and R4 on wires named `D1` and `E1`. A bus of a vector joins another's members by position, so
 * whether the two buses are one decides whether R3 and R4 are one net.
 */
function sheet(junction: boolean) {
  const text = schematic({
    libs: [LIB_R],
    symbols: [R("R1", "100 100 0", 1), R("R2", "80 116.19 0", 2), R("R3", "150 100 0", 3), R("R4", "170 100 0", 4)],
    wires: ["80 120 120 120", "100 103.81 100 120", "150 96.19 150 90", "170 96.19 170 90"],
    junctions: junction ? ["60.96 38.1"] : [],
    body: [bus(40.64, 38.1, 76.2, 38.1), bus(60.96, 38.1, 60.96, 25.4), label("D[0..7]", 43.18, 38.1), label("E[0..3]", 60.96, 27.94, 90), label("D1", 150, 90), label("E1", 170, 90)],
  })
  const imported = importKicadSchematic(text, { built: BUILT })
  if (imported.status !== "imported") throw new Error(`not imported: ${imported.status === "refused" ? imported.message : ""}`)
  const project = imported.project
  const stripped: Project = { ...project, sheets: project.sheets?.map(({ kicadRules: _k, ...rest }) => rest) }
  return { project, mine: editorGroups(project), theirs: kicadGroups(text, project, imported.build.bySymbol as never), without: editorGroups(stripped) }
}

describe("buses on a sheet joined by KiCad's rules use KiCad's integer points", () => {
  it("the importer flags the sheet (the T of R1 and R2) and keeps the buses", () => {
    const { project } = sheet(false)
    expect(project.sheets?.some((s) => s.kicadRules)).toBe(true)
    expect(project.drawings?.filter((d) => d.type === "bus")).toHaveLength(2)
  })

  it("a bus end on another bus's side with no junction joins nothing: the nets are the oracle's, and the editor's own rules would have joined the buses", () => {
    const r = sheet(false)
    // KiCad: no net joins R1 and R2 (the T), no net joins R3 and R4 (the buses are two)
    expect(r.theirs).toEqual([])
    expect(r.mine).toEqual(r.theirs)
    // by hand: the same answer
    expect(r.mine).toEqual([])
    // the flag is what makes it so: the editor's tolerant rules join the T and the buses, so D1 and E1
    expect(r.without).toEqual(sorted([["R1.2", "R2.2"], ["R3.1", "R4.1"]]))
  })

  it("the same bus T with a junction joins the buses, in both", () => {
    const r = sheet(true)
    expect(r.theirs).toEqual([["R3.1", "R4.1"]])
    expect(r.mine).toEqual(r.theirs)
  })
})

describe("settling an edit of a flagged sheet, whatever made it, and its bus drawings", () => {
  it("moving a bus drawing on a flagged sheet keeps six digits, and the store settles a T that the same commit made", () => {
    const { project } = sheet(false)
    expect(project.sheets?.some((s) => s.kicadRules)).toBe(true)
    const line = project.drawings!.find((d) => d.type === "bus") as DrawingBus
    const moved = moveDrawing(line, { x: 0.123457, y: 0 }) as DrawingBus
    for (const p of moved.points) expect(Math.abs(p.x * 1e6 - Math.round(p.x * 1e6))).toBeLessThan(1e-6)
    expect(moved.points[0].x).toBeCloseTo(line.points[0].x + 0.123457, 6)

    projectApi().open(project)
    // one commit: the bus moved, and a wire put with its end on another wire's side (what a tool that does not go through addWire makes)
    // the wire from (80, 120) to (120, 120) mm: its middle is on no other wire
    const host = project.wires.find((w) => w.points.length >= 2 && w.points.every((p) => Math.abs(-p.y * 12.7 - 120) < 1e-3) && Math.abs(w.points[0].x * 12.7 - 80) < 1e-3 && Math.abs(w.points[w.points.length - 1].x * 12.7 - 120) < 1e-3)!
    expect(host, JSON.stringify(project.wires.map((w) => w.points))).toBeDefined()
    const midX = 90 / 12.7
    const wire = { id: "wx", points: [{ x: midX, y: host.points[0].y }, { x: midX, y: host.points[0].y + 1 }] }
    projectApi().commit((q) => ({ ...q, drawings: q.drawings!.map((d) => (d.id === line.id ? moved : d)), wires: [...q.wires, wire] }))
    const made = projectApi().project!
    expect((made.drawings!.find((d) => d.id === line.id) as DrawingBus).points).toEqual(moved.points)
    // the wire's end is on the host's side: the store cut the host there, so the ends meet
    const hostParts = made.wires.filter((w) => w.id !== "wx" && w.points.some((p) => Math.abs(p.x - midX) < 1e-6 && Math.abs(p.y - host.points[0].y) < 1e-6))
    expect(hostParts.length).toBe(2)
    projectApi().close()
  })
})

{
// The merge of S8 (rule areas) into the join: readers of the part flags that the multilayer and fab work added go through the resolved flags.

const base: Project = { ...built("regulator"), netNames: "kicad" }
const areaOver = (c: ComponentInstance, ruleArea: NonNullable<DrawingLine["ruleArea"]>): DrawingLine => {
  const b = symbolBox(c)
  const x = (b.minX + b.maxX) / 2
  const y = (b.minY + b.maxY) / 2
  const d = 0.01
  return { id: `area-${c.id}`, type: "line", closed: true, points: [{ x: x - d, y: y - d }, { x: x + d, y: y - d }, { x: x + d, y: y + d }, { x: x - d, y: y + d }], ruleArea }
}
const target = base.components.find((c) => c.pcb.placed && onBoard(c) && c.ref === "D1")!
const withArea = (p: Project, ruleArea: NonNullable<DrawingLine["ruleArea"]>): Project => ({ ...p, drawings: [...(p.drawings ?? []), areaOver(target, ruleArea)] })

describe("S8 flags reach the readers added by the other lanes", () => {
  it("the fab notes list a part a rule area marks do not populate", () => {
    const notes = Object.values(buildFabricationFiles(withArea(base, { dnp: true }))).find((t) => t.includes("PART FLAGS")) ?? ""
    expect(notes).toContain(`Do not populate   ${target.ref}:`)
    expect(Object.values(buildFabricationFiles(base)).some((t) => t.includes("PART FLAGS"))).toBe(false)
  })

  it("Sakura's schematic image draws the DNP cross for a part a rule area marks", () => {
    const box = { minX: -20, minY: -20, maxX: 20, maxY: 20 }
    const draw = (p: Project) => schematicSvg(p, box, { width: 800, height: 600 }, measureSchematic(p))
    const plain = draw(base)
    const marked = draw(withArea(base, { dnp: true }))
    expect(marked).not.toEqual(plain)
    expect(resolvedComponents(withArea(base, { dnp: true })).find((c) => c.id === target.id)!.flags?.dnp).toBe(true)
  })

  it("an edit of only a rule area's on_board flag refreshes the net names", () => {
    const a = withArea(base, {})
    const b: Project = { ...a, drawings: a.drawings!.map((d) => (d.type === "line" && d.ruleArea ? { ...d, ruleArea: { notOnBoard: true } } : d)) }
    expect(sameSchematic(a, b)).toBe(false)
    expect(sameSchematic(a, { ...a })).toBe(true)
    expect(sameSchematic(a, { ...a, drawings: [...a.drawings!] })).toBe(true)
    const names = (p: Project) => getConnectivity(p).nets.map((n) => n.name).sort()
    const before = names(a)
    expect(names(b)).not.toEqual(before)
    expect(names(a)).toEqual(before)
  })
})
}

{
// Fix round 1 of the join: what the exported sheet says, checked the way KiCad 9.0 reads it.

const R1 = "aaaaaaaa-0000-4000-8000-000000000001"
const sheet = (body: string[], version = 20250114) =>
  schematic({ version, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "R_0603", uuid: R1 }], wires: ["50.8 54.61 50.8 70"], body })
const imp = (text: string): Project => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r.project
}
const schOf = async (p: Project) => {
  const { files, notes } = await kicadFiles(p)
  return { sch: Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1], notes }
}
const withDrawings = (p: Project, drawings: SchematicDrawing[]): Project => ({ ...p, drawings })
const nodes = (sch: string, name: string) => (parseSexpr(sch)[0] as unknown[]).filter((n) => Array.isArray(n) && n[0] === name) as unknown[][]
const kid = (node: unknown[], name: string) => node.find((c) => Array.isArray(c) && c[0] === name) as unknown[] | undefined

describe("B1: a rounded rectangle in a KiCad 9 file", () => {
  it("the strict KiCad 9 reader rejects a radius on a rectangle (the checker is not blind)", () => {
    const bad = `(kicad_sch (version 20250114) (rectangle (start 0 0) (end 1 1) (radius 0.5) (stroke (width 0) (type default)) (fill (type none)) (uuid u)))`
    expect(kicad9SheetProblems(bad)).toEqual(["rectangle: KiCad 9 does not accept (radius ...)"])
  })

  it("writes a tool rectangle with a radius as four lines and four arcs, with no radius token", async () => {
    const base = imp(sheet([]))
    const p = withDrawings(base, [{ id: "d1", type: "rect", x: 1, y: 1, width: 2, height: 1, radius: 0.2, weight: "thick", dash: "dashed" }])
    const { sch, notes } = await schOf(p)
    expect(sch).not.toContain("(radius 2.54)")
    expect(kicad9SheetProblems(sch)).toEqual([])
    expect(nodes(sch, "rectangle")).toHaveLength(0)
    expect(nodes(sch, "polyline")).toHaveLength(4)
    expect(nodes(sch, "arc")).toHaveLength(4)
    expect(notes.join(" ")).toMatch(/no rounded rectangle/)
    // the outline closes: each line ends where an arc starts or ends, within a micrometre
    const pt = (n: unknown[] | undefined, i = 1) => [Number((n![i] as unknown[])[1]), Number((n![i] as unknown[])[2])]
    const at = (n: unknown[] | undefined) => [Number(n![1]), Number(n![2])]
    const ends: number[][] = []
    for (const l of nodes(sch, "polyline")) {
      const pts = kid(l, "pts")!
      ends.push(pt(pts, 1), pt(pts, 2))
    }
    for (const a of nodes(sch, "arc")) {
      const [s, e] = [at(kid(a, "start")), at(kid(a, "end"))]
      for (const q of [s, e]) expect(ends.some((x) => Math.hypot(x[0] - q[0], x[1] - q[1]) < 1e-3)).toBe(true)
      // the arc's radius is the rectangle's: 0.2 units of 12.7 mm
      const m = at(kid(a, "mid"))
      const c = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2]
      expect(Math.hypot(m[0] - c[0], m[1] - c[1])).toBeCloseTo(2.54 * (1 - Math.SQRT1_2), 2)
      expect(kid(a, "stroke")!.join(" ")).toMatch(/type,dash/)
    }
  })

  it("keeps a fill as a polygon behind the outline and says so", async () => {
    const base = imp(sheet([]))
    const p = withDrawings(base, [{ id: "d1", type: "rect", x: 1, y: 1, width: 2, height: 1, radius: 0.2, fill: "blue" }])
    const { sch, notes } = await schOf(p)
    expect(kicad9SheetProblems(sch)).toEqual([])
    const filled = nodes(sch, "polyline").filter((n) => kid(kid(n, "fill")!, "type")![1] === "color")
    expect(filled).toHaveLength(1)
    expect(kid(filled[0], "pts")!.length).toBeGreaterThan(60)
    expect(notes.join(" ")).toMatch(/fill as a polygon/)
  })

  it("a KiCad 10 rounded rectangle carried through an import is written the same way, and reads back", async () => {
    const p = imp(sheet([`(rectangle (start 20 20) (end 40 30) (radius 2.54) (stroke (width 0.254) (type dot) (color 255 0 0 1)) (fill (type color) (color 0 255 0 1)) (uuid r10))`], 20250829))
    expect(p.drawings?.some((d) => d.type === "rect" && d.radius)).toBe(true)
    const { sch } = await schOf(p)
    expect(kicad9SheetProblems(sch)).toEqual([])
    expect(sch).not.toMatch(/\(radius 2\.54\)/)
    expect(nodes(sch, "arc")).toHaveLength(4)
    expect(importKicadSchematic(sch).status).toBe("imported")
  })

  it("a radius bigger than half the shorter side is clamped, and a flat rectangle stays a rectangle", async () => {
    const base = imp(sheet([]))
    const p = withDrawings(base, [
      { id: "a", type: "rect", x: 1, y: 1, width: 2, height: 0.2, radius: 5 },
      { id: "b", type: "rect", x: 1, y: 3, width: 2, height: 0, radius: 0.3 },
    ])
    const { sch } = await schOf(p)
    expect(kicad9SheetProblems(sch)).toEqual([])
    expect(nodes(sch, "rectangle")).toHaveLength(1)
    expect(nodes(sch, "arc")).toHaveLength(4)
  })
})

describe("B6: a turned text with a border", () => {
  // KiCad 9 stores a text box as the box it draws (start and size in page space) and the text's angle apart
  // (parseSchTextBoxContent: `at` is start plus angle, `size` is end minus start; SCH_TEXTBOX::GetDrawPos puts
  // a turned text's start at the box's bottom-left plus the margins, for justify left top). So the box is the
  // turned frame, written with 90, and the text starts where the same text without a border starts.
  for (const rot of [0, 90] as const) {
    it(`rot ${rot}: the box carries the angle and the text starts where a plain text of it would`, async () => {
      const base = imp(sheet([]))
      const text = { type: "text" as const, x: 2, y: 3, text: "Turned\nnote", size: 0.1, rot }
      const { sch } = await schOf(withDrawings(base, [{ ...text, id: "a", border: true }, { ...text, id: "b" }]))
      const box = nodes(sch, "text_box")[0]
      const plain = nodes(sch, "text").find((n) => n[1] === "Turned\nnote")!
      const at = kid(box, "at")!
      expect(Number(at[3])).toBe(rot)
      const [sx, sy] = [Number(at[1]), Number(at[2])]
      const size = kid(box, "size")!
      const [w, h] = [Number(size[1]), Number(size[2])]
      // a turned text is taller than wide, an unturned one wider than tall
      expect(w > h).toBe(rot === 0)
      const m = kid(box, "margins")!.slice(1).map(Number)
      const [left, top, bottom] = [Math.min(sx, sx + w), Math.min(sy, sy + h), Math.max(sy, sy + h)]
      const draw = rot === 90 ? [left + m[0], bottom - m[3]] : [left + m[0], top + m[1]]
      const pat = kid(plain, "at")!
      expect(Math.abs(draw[0] - Number(pat[1]))).toBeLessThan(1e-3)
      expect(Math.abs(draw[1] - Number(pat[2]))).toBeLessThan(1e-3)
      expect(Number(pat[3])).toBe(rot)
      expect(kicad9SheetProblems(sch)).toEqual([])
    })
  }
})

describe("m2: ink is written as KiCad's default colour", () => {
  it("writes no colour for ink and a colour for a named one", async () => {
    const base = imp(sheet([]))
    const { sch } = await schOf(
      withDrawings(base, [
        { id: "l1", type: "line", points: [{ x: 1, y: 1 }, { x: 2, y: 1 }], arrows: "end" },
        { id: "l2", type: "line", points: [{ x: 1, y: 2 }, { x: 2, y: 2 }], color: "red" },
        { id: "t1", type: "text", x: 1, y: 3, text: "ink", size: 0.1 },
        { id: "t2", type: "text", x: 1, y: 4, text: "red", size: 0.1, color: "red" },
      ]),
    )
    const colorOf = (n: unknown[]) => kid(kid(n, "stroke") ?? [], "color")
    const lines = nodes(sch, "polyline")
    expect(lines.length).toBe(3)
    expect(colorOf(lines[0])).toBeUndefined()
    expect(colorOf(lines[1])).toBeUndefined()
    expect(colorOf(lines[2])).toBeDefined()
    // the arrowhead of an ink line is filled with the line's own colour, not a fixed near-black
    expect(kid(kid(lines[1], "fill")!, "type")![1]).toBe("outline")
    expect(sch).not.toContain("(color 36 33 28 1)")
    const texts = nodes(sch, "text")
    const fontColor = (n: unknown[]) => kid(kid(kid(n, "effects")!, "font")!, "color")
    expect(fontColor(texts.find((n) => n[1] === "ink")!)).toBeUndefined()
    expect(fontColor(texts.find((n) => n[1] === "red")!)).toBeDefined()
  })
})
}

{
// Fix round 1 of the join, B2 and m3: which of a part's flags the symbol is the authority for depends on the
// KiCad that wrote the file. pcbnew/netlist_reader/board_netlist_updater.cpp, per branch: 6.0 and 7.0 copy
// exclude_from_bom from the symbol to the footprint; 8.0 and 9.0 add dnp; 10.0 adds exclude_from_pos_files;
// the simulation flag only on master, after 10.0. A KiCad 9 symbol has no in_pos_files word at all.

const BUILT = new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S2", "S5", "S6", "S10", "S7"])
const U1 = "11111111-0000-4000-8000-000000000001"


/** One resistor: the symbol written in a file of `version` with the flag words that file has, and a footprint with `attr`. */
function oneResistor(version: number, symbolWords: string, attr: string) {
  const sch = schematic({ version, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric", uuid: U1, extra: symbolWords }] })
  const pcb = board({ nets: ['(net 0 "")'], body: [footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: `(path "/${U1}") (attr smd ${attr})` })] })
  const r = imported(importKicadProject([{ path: "demo.kicad_pcb", data: pcb }, { path: "demo.kicad_sch", data: sch }], { built: BUILT }))
  return { r, flags: r.project.components.find((c) => c.ref === "R1")?.flags, differ: r.report.entries.find((e) => e.code === "symbol-footprint-flags-differ") }
}

const ALL_THREE = "dnp exclude_from_bom exclude_from_pos_files"

describe("B2: the symbol wins only for the flags its file's KiCad copies", () => {
  it("KiCad 7: the BOM is the symbol's; do not populate and the position file stay the footprint's, with no difference said for them", () => {
    const { flags, differ } = oneResistor(20230121, "(dnp no)", ALL_THREE)
    expect(flags).toEqual({ mount: "smd", dnp: true, excludeFromPos: true })
    expect(differ?.why).toMatch(/R1 not in the BOM \(the symbol says no, the footprint yes\)\./)
    expect(differ?.why).not.toMatch(/do not populate|position file/)
  })

  it("KiCad 7: a symbol that says do not populate keeps it, since the footprint has no word for it there", () => {
    const { flags, differ } = oneResistor(20230121, "(dnp yes)", "")
    expect(flags).toEqual({ mount: "smd", dnp: true })
    expect(differ).toBeUndefined()
  })

  it("KiCad 8 and 9: the symbol wins for do not populate and the BOM; the position file stays the footprint's", () => {
    for (const version of [20231120, 20250114]) {
      const { flags, differ } = oneResistor(version, "(dnp no)", ALL_THREE)
      expect(flags, String(version)).toEqual({ mount: "smd", excludeFromPos: true })
      expect(differ?.why, String(version)).toMatch(/R1 do not populate \(the symbol says no, the footprint yes\), not in the BOM \(the symbol says no, the footprint yes\)\./)
      expect(differ?.why).not.toMatch(/position file/)
    }
  })

  it("the position-file flag of KiCad 6 to 9 projects survives (J2, J3, SW2 of a rotary encoder, TP1 to TP3, J1 to J4): no symbol word, so no difference", () => {
    for (const version of [20211123, 20230121, 20231120, 20250114]) {
      const { flags, differ } = oneResistor(version, version >= 20231120 ? "(dnp no)" : "", "exclude_from_pos_files")
      expect(flags, String(version)).toEqual({ mount: "smd", excludeFromPos: true })
      expect(differ, String(version)).toBeUndefined()
    }
  })

  it("KiCad 10: the symbol has in_pos_files and wins for all three", () => {
    const { flags, differ } = oneResistor(20250829, "(dnp no) (in_pos_files yes)", ALL_THREE)
    expect(flags).toEqual({ mount: "smd" })
    expect(differ?.why).toMatch(/do not populate.*not in the BOM.*not in the position file/)
    // a symbol that leaves itself out of the position files, over a footprint that is in them
    const out = oneResistor(20250829, "(dnp no) (in_pos_files no)", "")
    expect(out.flags).toEqual({ mount: "smd", excludeFromPos: true })
    expect(out.differ?.why).toMatch(/position file \(the symbol says yes, the footprint no\)/)
  })

  it("KiCad 10 with a symbol that lacks the word keeps the footprint's flag", () => {
    const { flags, differ } = oneResistor(20250829, "(dnp no)", "exclude_from_pos_files")
    expect(flags).toEqual({ mount: "smd", excludeFromPos: true })
    expect(differ).toBeUndefined()
  })

  it("the symbol's simulation flag is kept in every version", () => {
    const sim = oneResistor(20250114, "(dnp no) (exclude_from_sim yes)", "")
    expect(sim.flags).toEqual({ mount: "smd", excludeFromSim: true })
  })

  it("our own export imported back keeps the position-file flag, do not populate and the BOM", async () => {
    const first = oneResistor(20250114, "(dnp no)", "")
    const flagged = setFlags(first.r.project, first.r.project.components.find((c) => c.ref === "R1")!.id, { excludeFromPos: true, dnp: true, excludeFromBom: true })
    const { files } = await kicadFiles(flagged)
    const entries = Object.entries(files)
    // the whole export, the project file too: our own file is not refused for the keys our own converter writes
    const back = imported(importKicadProject([{ path: "back.kicad_pcb", data: entries.find(([k]) => k.endsWith(".kicad_pcb"))![1] }, { path: "back.kicad_sch", data: entries.find(([k]) => k.endsWith(".kicad_sch"))![1] }, { path: "back.kicad_pro", data: entries.find(([k]) => k.endsWith(".kicad_pro"))![1] }]))
    const r1 = back.project.components.find((c) => c.ref === "R1")!
    expect(r1.flags).toMatchObject({ excludeFromPos: true, dnp: true, excludeFromBom: true })
    expect(back.report.entries.some((e) => e.code === "symbol-footprint-flags-differ")).toBe(false)
  })

  it("joinFlags without a voice keeps the symbol as the authority for all three (the old rule), and flagVoice says what each file's KiCad copies", () => {
    expect(joinFlags({ dnp: true }, { excludeFromPos: true }).flags).toEqual({ dnp: true })
    const has = { inBom: true, dnp: true, inPosFiles: false }
    expect([...flagVoice({ stamp: 20230121, stated: has }).authority]).toEqual(["excludeFromBom"])
    expect([...flagVoice({ stamp: 20231120, stated: has }).authority].sort()).toEqual(["dnp", "excludeFromBom"])
    expect([...flagVoice({ stamp: 20250114, stated: has }).authority].sort()).toEqual(["dnp", "excludeFromBom"])
    expect([...flagVoice({ stamp: 20250829, stated: { ...has, inPosFiles: true } }).authority].sort()).toEqual(["dnp", "excludeFromBom", "excludeFromPos"])
    expect([...flagVoice({ stamp: 20250829, stated: { inBom: true, dnp: false, inPosFiles: false } }).authority]).toEqual(["excludeFromBom"])
  })
})

describe("m3: the footprint's flags are the part's, on every unit", () => {
  it("a part of three units, with a footprint that is smd, board only and has net ties, carries them on all three", () => {
    const uuids = ["aaaaaaaa-0000-4000-8000-0000000000a1", "aaaaaaaa-0000-4000-8000-0000000000a2", "aaaaaaaa-0000-4000-8000-0000000000a3"]
    const sch = schematic({
      version: 20250114,
      libs: ALL_LIBS,
      symbols: uuids.map((u, i) => ({ lib: "Test:OPA2", at: `100 ${100 + i * 40}`, ref: "U1", value: "OPA2", footprint: "Package_SO:SOIC-8", uuid: u, unit: i + 1, extra: "(dnp no)" })),
    })
    const pads = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pad({ number: String(n), at: `${n} 0` }))
    const pcb = board({ nets: ['(net 0 "")'], body: [footprint({ ref: "U1", name: "Package_SO:SOIC-8", at: "10 5", pads, extra: `(path "/${uuids[0]}") (attr smd board_only dnp) (net_tie_pad_groups "1, 2")` })] })
    const r = imported(importKicadProject([{ path: "demo.kicad_pcb", data: pcb }, { path: "demo.kicad_sch", data: sch }], { built: BUILT }))
    const units = r.project.components.filter((c) => c.ref === "U1")
    expect(units).toHaveLength(3)
    for (const u of units) expect(u.flags, `unit ${u.unit ?? 1}`).toEqual({ mount: "smd", boardOnly: true, netTies: [["1", "2"]] })
    // one note for the part, not one per unit
    expect(r.report.entries.find((e) => e.code === "symbol-footprint-flags-differ")?.items).toEqual(["U1"])
  })
})
}

// The final schematic review of the join: per-use variant changes (B1), the connectivity cache (B2), the KiCad 9 export of a shared sheet (B3) and Sakura's edit_sheet (B4).

const ref = (p: Project, r: string) => p.components.find((c) => c.ref === r)!

/** The S9 fixture: a sheet used twice (R2 on the first use, R3 on the second), with R3 do-not-populate under the variant Lite on its own use. */
function twoUses(): Project {
  const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Power2", y: 90 }])
  return setVariantOverride(project, ref(project, "R3").id, "Lite", { dnp: true })
}

describe("B1: the variant changes of one use of a sheet are that use's", () => {
  it("moving a part on the first use keeps R3's variants (commitOnUse)", () => {
    const p = twoUses()
    const first = sheetUses(p)[1].path
    expect(ref(p, "R3").variants).toEqual({ Lite: { dnp: true } })
    const moved = commitOnUse(p, first, (v) => ({ ...v, components: v.components.map((c) => (c.ref === "R2" ? { ...c, sch: { ...c.sch, x: c.sch.x + 5 } } : c)) }))
    expect(ref(moved, "R2").sch.x).toBe(ref(p, "R2").sch.x + 5)
    expect(ref(moved, "R3").sch.x).toBe(ref(p, "R3").sch.x + 5)
    expect(ref(moved, "R3").variants).toEqual({ Lite: { dnp: true } })
    expect(ref(moved, "R2").variants).toBeUndefined()
  })

  it("a variant set on the first use is not copied to the second", () => {
    const p = twoUses()
    const first = sheetUses(p)[1].path
    const made = commitOnUse(p, first, (v) => setVariantOverride(v, ref(v, "R2").id, "Lite", { excludeFromBom: true }))
    expect(ref(made, "R2").variants).toEqual({ Lite: { excludeFromBom: true } })
    expect(ref(made, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("Sakura's tools on a sheet (onSheet) keep R3's variants", () => {
    const p = twoUses()
    const out = runTool(p, "add_component", { part_id: "resistor", sheet: "Power", x: 20, y: 0 })
    expect(out.isError, out.result).toBe(false)
    expect(ref(out.project, "R3").variants).toEqual({ Lite: { dnp: true } })
    // the symbol that was added to the first use comes to the second with no variants
    const added = out.project.components.filter((c) => c.inst === sheetUses(p)[2].path && c.ref !== "R3")
    expect(added.length).toBe(1)
    expect(added[0].variants).toBeUndefined()
  })

  it("Sakura's tools on the project (syncEdited) keep R3's variants", () => {
    const p = twoUses()
    const out = runTool(p, "update_component", { ref: "R2", props: { resistance: "22k" } })
    expect(out.isError, out.result).toBe(false)
    expect(ref(out.project, "R3").props).toEqual(ref(out.project, "R2").props)
    expect(ref(out.project, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("a use added with addSheetUse starts with no variants, and the other uses keep theirs", () => {
    const p = twoUses()
    const r = addSheetUse(p, "", p.sheetSymbols![0].child, { minX: 10, minY: 120, maxX: 30, maxY: 130 })!
    expect(r).not.toBeNull()
    const third = sheetUses(r.project).at(-1)!.path
    const copies = r.project.components.filter((c) => c.inst === third)
    expect(copies.length).toBe(1)
    expect(copies[0].variants).toBeUndefined()
    expect(ref(r.project, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("a paste starts a new copy with no variants", () => {
    const p = twoUses()
    const r3 = ref(p, "R3")
    const res = pasteItems(p, { project: p, components: [r3.id], wires: [], labels: [], blocks: [] }, { x: 3, y: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const added = res.project.components.filter((c) => !p.components.some((x) => x.id === c.id))
    expect(added.length).toBe(1)
    expect(added[0].variants).toBeUndefined()
    expect(ref(res.project, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("a removed use's variant keys are gone, so a symbol that takes its id does not inherit them", () => {
    const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Power2", y: 90 }])
    // A sheet symbol on the child sheet, with variants for each use of it; the first use of the child goes.
    const [a, b] = project.sheetSymbols!
    const uses = sheetUses(project)
    const withInner: Project = {
      ...project,
      sheets: [...(project.sheets ?? []), { id: "s9" }],
      sheetSymbols: [
        ...project.sheetSymbols!,
        { id: "h9", sheet: a.child, child: "s9", x: 0, y: 0, w: 5, h: 5, name: "Inner", pins: [], variants: { [uses[1].path]: { Lite: { dnp: true } }, [uses[2].path]: { Lite: { excludeFromBom: true } } } },
      ],
    }
    const without = removeSheetSymbols(withInner, [a.id])
    const inner = without.sheetSymbols!.find((s) => s.id === "h9")!
    expect(inner.variants).toEqual({ [uses[2].path]: { Lite: { excludeFromBom: true } } })
    void b
  })
})

describe("B2: the connectivity cache sees what changes a symbol's pins", () => {
  /** What the nets are, by name and the pins on each. */
  const netsOf = (c: ReturnType<typeof computeConnectivity>) => c.nets.map((n) => `${n.name}: ${n.pins.map((p) => `${p.componentId}.${p.pin}`).join(",")}`)
  const edit = (p: Project, id: string, patch: Partial<ComponentInstance>): Project => ({ ...p, components: p.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  /** The cache is primed with the project before the edit, as the editor has it; what it answers for the project after must be what a fresh computation answers. */
  const expectFresh = (before: Project, after: Project) => {
    getConnectivity(before)
    expect(sameSchematic(before, after)).toBe(false)
    expect(netsOf(getConnectivity(after))).toEqual(netsOf(computeConnectivity(after)))
    expect(netsOf(computeConnectivity(after))).not.toEqual(netsOf(computeConnectivity(before)))
  }
  // An MCU at (60, 120): pin 1 (PA0) at (52.38, 114.92), wired to R1's pin 2 at (40, 114.92).
  const mcu = () => importSheet({ symbols: [place("Test:MCU", "60 120", "U3"), place("Device:R", "40 111.11", "R1")], wires: ["52.38 114.92 40 114.92"] })

  it("the scenario: a pin function picked with setSymbolVariant renames the net, and the trace follows", () => {
    const before = mcu()
    const u3 = before.components.find((c) => c.ref === "U3")!
    expect(computeConnectivity(before).nets.some((n) => n.name === "Net-(U3-PA0)")).toBe(true)
    const withTrace: Project = { ...before, traces: [{ id: "t1", layer: "top", width: 0.2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], net: "Net-(U3-PA0)" }] }
    getConnectivity(withTrace)
    const res = setSymbolVariant(withTrace, u3.id, { pinAlt: { pin: "1", alternate: "TX" } }, { conn: getConnectivity })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(getConnectivity(res.project).nets.some((n) => n.name === "Net-(U3-TX)")).toBe(true)
    expect(followNetRenames(withTrace, res.project).traces[0].net).toBe("Net-(U3-TX)")
  })

  it("pinAlt", () => {
    const before = mcu()
    const u3 = before.components.find((c) => c.ref === "U3")!
    expectFresh(before, edit(before, u3.id, { pinAlt: { "1": "TX" } }))
  })

  it("mirror", () => {
    const before = importSheet({ symbols: [place("Test:MCU", "60 120", "U3")], wires: ["52.38 114.92 40 114.92"], labels: ["M 40 114.92 0"] })
    const u3 = before.components[0]
    expectFresh(before, edit(before, u3.id, { sch: { ...u3.sch, mirror: "y" } }))
  })

  it("unit", () => {
    const before = importSheet({ symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 })], wires: ["107.62 100 115 100"], labels: ["A 115 100 0"] })
    const u1 = before.components[0]
    expectFresh(before, edit(before, u1.id, { unit: 2 }))
  })

  it("bodyStyle", () => {
    const font = "(effects (font (size 1.27 1.27)))"
    const pin = (at: string) => `(pin input line (at ${at}) (length 3.81) (name "A" ${font}) (number "1" ${font}))`
    const lib = `(symbol "Test:BS" (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 5.08 0) ${font}) (property "Value" "BS" (at 0 -5.08 0) ${font})
      (symbol "BS_1_1" (rectangle (start -3.81 5.08) (end 3.81 -5.08) (stroke (width 0) (type default)) (fill (type none))) ${pin("-7.62 2.54 0")})
      (symbol "BS_1_2" (rectangle (start -3.81 5.08) (end 3.81 -5.08) (stroke (width 0) (type default)) (fill (type none))) ${pin("-7.62 -2.54 0")}))`
    const r = importKicadSchematic(schematic({ libs: [lib], symbols: [place("Test:BS", "100 100", "U1")], wires: ["92.38 102.54 85 102.54"], labels: ["B 85 102.54 0"] }))
    if (r.status !== "imported") throw new Error(r.message)
    const before = r.project
    expectFresh(before, edit(before, before.components[0].id, { bodyStyle: 2 }))
  })

  it("the net naming rule of the project, and the symbol drawings parts are made of", () => {
    const before = mcu()
    getConnectivity(before)
    const kicad5 = { ...before, netNames: "kicad5" as const }
    expect(sameSchematic(before, kicad5)).toBe(false)
    expect(netsOf(getConnectivity(kicad5))).toEqual(netsOf(computeConnectivity(kicad5)))
    expect(sameSchematic(before, { ...before, symbols: { ...before.symbols } })).toBe(false)
  })

  it("an edit that no net can see is still not a schematic edit: a footprint, a PCB move and the fields' places", () => {
    const before = mcu()
    const u3 = before.components.find((c) => c.ref === "U3")!
    expect(sameSchematic(before, edit(before, u3.id, { footprint: "other", pcb: { ...u3.pcb, x: 9, y: 9, placed: true } }))).toBe(true)
    expect(sameSchematic(before, edit(before, u3.id, { fields: { Value: { x: 1, y: 1, angle: 0, size: 1.27 } as never } }))).toBe(true)
  })
})

describe("B3: the KiCad 9 export of a sheet used twice", () => {
  /** The root file and the shared child file of an export. */
  async function exported(p: Project) {
    const { files, notes } = await kicadFiles(p)
    const names = Object.keys(files).filter((k) => k.endsWith(".kicad_sch"))
    const root = names.find((k) => files[k].includes("(sheet\n"))!
    const child = names.find((k) => k !== root)!
    return { root: files[root], child: files[child], childName: child, notes: notes.join("\n"), all: files }
  }
  /** The text of the placed symbols of a file (the child file holds R9 once, with a reference for each use). */
  const symbolText = (sch: string) => sch.slice(sch.indexOf("\n  (symbol\n    (lib_id"))
  const sheetNodes = (root: string) => root.split("\n  (sheet\n").slice(1).map((n) => n.slice(0, n.indexOf("\n  )")))

  it("scenario 1: only the first sheet symbol is do not populate: that is on its node in the parent file, and not on the shared symbols", async () => {
    const p = twoUses()
    const first = p.sheetSymbols![0]
    const flagged = setSheetSymbol(p, first.id, { flags: { dnp: true } })
    const out = await exported(flagged)
    const nodes = sheetNodes(out.root)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatch(/\(dnp yes\)/)
    expect(nodes[1]).toMatch(/\(dnp no\)/)
    // the file both uses share does not say do not populate: the second use is not
    expect(symbolText(out.child)).toMatch(/\(dnp no\)/)
    expect(symbolText(out.child)).not.toMatch(/\(dnp yes\)/)
    expect(out.notes).toMatch(/The flags of a sheet symbol are written on the sheet symbol/)
    expect(kicad9SheetProblems(out.root)).toEqual([])
    expect(kicad9SheetProblems(out.child)).toEqual([])
  })

  it("a part's own flag is in the shared file, for every use", async () => {
    const p = twoUses()
    const own = { ...p, components: p.components.map((c) => (c.ref === "R2" || c.ref === "R3" ? { ...c, flags: { dnp: true as const } } : c)) }
    const out = await exported(own)
    expect(symbolText(out.child)).toMatch(/\(dnp yes\)/)
    expect(out.notes).not.toMatch(/KiCad 9 keeps a sheet used more than once/)
  })

  it("scenario 2: do not populate under the active variant on the second use only: the file has the first use's, and the note names the part and what was written", async () => {
    const p = setActiveVariant(twoUses(), "Lite")
    const out = await exported(p)
    expect(symbolText(out.child)).toMatch(/\(dnp no\)/)
    const line = out.notes.split("\n").find((l) => l.startsWith("R3 on "))!
    expect(line).toBeDefined()
    expect(line).toMatch(/R3 on \/Power2\/ has do not populate/)
    expect(line).toMatch(/says what R2 on \/Power\/ has, no flag/)
    expect(line).toContain(out.childName)
    // the variant note no longer claims the flags are on every symbol
    expect(out.notes).toMatch(/the active variant "Lite" makes them/)
    expect(out.notes).not.toMatch(/are on each symbol/)
  })

  it("a variant that is the same on every use is written in the shared file with no difference said", async () => {
    let p = twoUses()
    p = setVariantOverride(p, ref(p, "R2").id, "Lite", { dnp: true })
    const out = await exported(setActiveVariant(p, "Lite"))
    expect(symbolText(out.child)).toMatch(/\(dnp yes\)/)
    expect(out.notes).not.toMatch(/KiCad 9 keeps a sheet used more than once/)
  })

  it("a sheet symbol whose variant differs between the uses of its parent sheet is said", async () => {
    // Power sits on the root; a sheet Inner below it is drawn once and used twice (a symbol on each use of Power would need Power used twice), so the case is
    // the sheet symbols of a sheet used twice: give the first use's symbol a variant for the second parent use.
    const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Power2", y: 90 }])
    const [a, b] = project.sheetSymbols!
    const inner = { id: "h9", sheet: a.child, child: "s9", x: 0, y: 0, w: 5, h: 5, name: "Inner", file: "inner.kicad_sch", pins: [], variants: { [`/${b.id}`]: { Lite: { dnp: true } } } }
    const p = setActiveVariant({ ...project, sheets: [...(project.sheets ?? []), { id: "s9" }], sheetSymbols: [...project.sheetSymbols!, inner], variants: { list: [{ name: "Lite" }] } }, "Lite")
    const out = await exported(p)
    expect(out.notes).toMatch(/The sheet symbol Inner is do not populate on \/Power2\/ but not flagged on \/Power\//)
  })
})

describe("minors", () => {
  it("a pin added to a sheet symbol on a sheet joined by KiCad's rules keeps six digits", () => {
    const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }])
    const rules: Project = { ...project, sheets: (project.sheets ?? []).map((s) => (s.id === "root" ? { ...s, kicadRules: true as const } : s)), sheetSymbols: project.sheetSymbols!.map((s) => ({ ...s, x: 6.096123, y: 1.234567 })) }
    const sym = rules.sheetSymbols![0]
    const left = addSheetPin(rules, sym.id, "LEFT", "input", "left")
    expect(left.sheetSymbols![0].pins.at(-1)!.x).toBe(6.096123)
    // an editor sheet keeps its four
    const plain = addSheetPin({ ...rules, sheets: project.sheets }, sym.id, "LEFT", "input", "left")
    expect(plain.sheetSymbols![0].pins.at(-1)!.x).toBe(6.0961)
  })
})

describe("B4: resizing or moving a sheet symbol keeps the wires on its pins", () => {
  const run = (p: Project, name: string, input: Record<string, unknown>) => runTool(p, name, input)
  const good = (p: Project, name: string, input: Record<string, unknown>) => {
    const out = run(p, name, input)
    expect(out.isError, out.result).toBe(false)
    return out.project
  }
  /** A root with R1 and a sheet POWER with R2 and C1; POWER's pin VOUT is on the right edge and joined to R1 pin 1 by the labels wire_sheet_pin puts at the pin and at R1. */
  function labelled(): Project {
    let p = createProject("t")
    p = good(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
    p = good(p, "add_sheet", { name: "POWER" })
    p = good(p, "add_component", { part_id: "resistor", sheet: "POWER", x: 0, y: 0 })
    p = good(p, "add_component", { part_id: "capacitor", sheet: "POWER", x: 5, y: 0 })
    const inner = p.components.find((c) => c.inst)!
    p = good(p, "add_hier_label", { sheet: "POWER", name: "VOUT", pins: [`${inner.ref}.2`], shape: "output" })
    const root = p.components.find((c) => !c.inst)!
    return good(p, "wire_sheet_pin", { sheet: "POWER", pin: "VOUT", to: [`${root.ref}.1`] })
  }
  /** The same, with the labels on the root taken out and a wire drawn from the pin to R1 pin 1. */
  function wired(): Project {
    const p = labelled()
    const root = p.components.find((c) => !c.inst)!
    const pin = p.sheetSymbols![0].pins[0]
    const to = schematicPins(root).find((x) => x.pin === "1")!.pos
    return {
      ...p,
      labels: p.labels.filter((l) => l.sheet !== undefined),
      wires: [...p.wires.filter((w) => w.sheet !== undefined), { id: "wpin", points: [{ x: pin.x, y: pin.y }, { x: pin.x, y: 2 }, { x: to.x, y: 2 }, { x: to.x, y: to.y }] }],
    }
  }
  const connected = (p: Project) => {
    const root = p.components.find((c) => !c.inst)!
    const inner = p.components.find((c) => c.inst && c.partId === "resistor")!
    const conn = getConnectivity(p)
    const a = conn.pinNet.get(`${root.id}:1`)
    return a !== undefined && a === conn.pinNet.get(`${inner.id}:2`)
  }
  const symOf = (p: Project) => p.sheetSymbols![0]
  const pinOf = (p: Project) => symOf(p).pins.find((x) => x.name === "VOUT")!
  const at = (q: { x: number; y: number }, p: Project) => Math.abs(q.x - pinOf(p).x) < 1e-6 && Math.abs(q.y - pinOf(p).y) < 1e-6
  /** A wire ends on the pin. */
  const endsAtPin = (p: Project) => p.wires.some((w) => w.sheet === undefined && [w.points[0], w.points.at(-1)!].some((q) => at(q, p)))
  /** The root's label of the pin's name sits on the pin. */
  const labelAtPin = (p: Project) => p.labels.some((l) => l.sheet === undefined && l.name === "VOUT" && at(l, p))

  it("the fixtures are one net across the sheet pin", () => {
    expect(pinOf(wired()).rot).toBe(0)
    expect(connected(wired())).toBe(true)
    expect(endsAtPin(wired())).toBe(true)
    expect(connected(labelled())).toBe(true)
    expect(labelAtPin(labelled())).toBe(true)
  })

  it("the label wire_sheet_pin puts on a pin follows the pin when the sheet is resized or moved", () => {
    const p = labelled()
    const wider = good(p, "edit_sheet", { sheet: "POWER", w: symOf(p).w + 1 })
    expect(labelAtPin(wider)).toBe(true)
    expect(connected(wider)).toBe(true)
    const moved = good(p, "edit_sheet", { sheet: "POWER", w: symOf(p).w + 1, x: symOf(p).x + 3 })
    expect(labelAtPin(moved)).toBe(true)
    expect(connected(moved)).toBe(true)
  })

  it("edit_sheet with a wider w stretches the wire to the right pin", () => {
    const p = wired()
    const out = good(p, "edit_sheet", { sheet: "POWER", w: symOf(p).w + 1 })
    expect(pinOf(out).x).toBeCloseTo(pinOf(p).x + 1, 6)
    expect(endsAtPin(out)).toBe(true)
    expect(connected(out)).toBe(true)
  })

  it("a smaller h holds a pin on the edge, and the wire goes with it", () => {
    const p = wired()
    const out = good(p, "edit_sheet", { sheet: "POWER", h: 0.2 })
    expect(pinOf(out).y).toBeLessThan(pinOf(p).y)
    expect(endsAtPin(out)).toBe(true)
    expect(connected(out)).toBe(true)
  })

  it("a resize and a move in one call keep the wire", () => {
    const p = wired()
    const out = good(p, "edit_sheet", { sheet: "POWER", w: symOf(p).w + 2, h: symOf(p).h + 1, x: symOf(p).x + 3, y: symOf(p).y + 2 })
    expect(endsAtPin(out)).toBe(true)
    expect(connected(out)).toBe(true)
  })

  it("a move alone keeps the wire (the model function the editor's drag also ends in)", () => {
    const p = wired()
    const out = moveSheetSymbols(p, [symOf(p).id], { x: 2, y: -1 })
    expect(endsAtPin(out)).toBe(true)
    expect(connected(out)).toBe(true)
  })

  it("the model's resize keeps the wire too: the editor has no resize handle of its own, so this is the one path", () => {
    const p = wired()
    const out = resizeSheetSymbol(p, symOf(p).id, symOf(p).w + 1.5, symOf(p).h + 0.5)
    expect(endsAtPin(out)).toBe(true)
    expect(connected(out)).toBe(true)
  })

  it("on a sheet joined by KiCad's rules the points stay at six digits and the pin stays joined", () => {
    const p = wired()
    // the sheet symbol, its pin and the wire end on the pin are off the editor's grid, as a KiCad file's are
    const off = 0.000123
    const sym = symOf(p)
    const pin = pinOf(p)
    const flagged: Project = {
      ...p,
      sheets: (p.sheets ?? [{ id: "root" }]).map((s) => (s.id === "root" ? { ...s, kicadRules: true as const } : s)),
      sheetSymbols: [{ ...sym, x: sym.x + off, y: sym.y + off, pins: sym.pins.map((q) => ({ ...q, x: q.x + off, y: q.y + off })) }],
      wires: p.wires.map((w) => ({ ...w, points: w.points.map((q) => (Math.abs(q.x - pin.x) < 1e-6 && Math.abs(q.y - pin.y) < 1e-6 ? { x: q.x + off, y: q.y + off } : q)) })),
    }
    expect(connected(flagged)).toBe(true)
    // the tool's resize: the pin is at x + w + off, which four digits would have rounded
    const wider = good(flagged, "edit_sheet", { sheet: "POWER", w: sym.w + 1 })
    expect(connected(wider)).toBe(true)
    expect(endsAtPin(wider)).toBe(true)
    expect(pinOf(wider).x).toBeCloseTo(pin.x + off + 1, 6)
    expect(String(pinOf(wider).x).split(".")[1].length).toBeGreaterThan(4)
    // the model's resize and move
    const resized = resizeSheetSymbol(flagged, sym.id, sym.w + 1, sym.h - 1)
    expect(connected(resized)).toBe(true)
    expect(endsAtPin(resized)).toBe(true)
    const moved = moveSheetSymbols(flagged, [sym.id], { x: 1.000001, y: 0.500002 })
    expect(connected(moved)).toBe(true)
    expect(endsAtPin(moved)).toBe(true)
    expect(pinOf(moved).x).toBeCloseTo(pin.x + off + 1.000001, 6)
    // the tool's move lands on the target exactly, and the wire is still on the pin
    const placed = good(flagged, "edit_sheet", { sheet: "POWER", x: 5, y: 3 })
    expect(symOf(placed).x).toBe(5)
    expect(connected(placed)).toBe(true)
    expect(endsAtPin(placed)).toBe(true)
  })

  it("an edit that would still change a connection is refused, with nothing changed", () => {
    const p = wired()
    // a net of its own, labelled OTHER, where the stretched wire's end would be: the wire would run onto it
    const at = { x: pinOf(p).x + 1, y: pinOf(p).y }
    const q: Project = { ...p, labels: [...p.labels, { id: "lother", name: "OTHER", x: at.x, y: at.y, rot: 0 }] }
    expect(connected(q)).toBe(true)
    const out = run(q, "edit_sheet", { sheet: "POWER", w: symOf(q).w + 1 })
    expect(out.isError).toBe(true)
    expect(out.project).toBe(q)
    expect(out.result).toMatch(/Didn't resize the sheet POWER: .*Nothing was changed/)
    const moved = run(q, "edit_sheet", { sheet: "POWER", x: symOf(q).x + 1 })
    expect(moved.isError).toBe(true)
    expect(moved.result).toMatch(/Didn't move the sheet POWER/)
  })
})
