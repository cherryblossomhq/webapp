import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { bomCsv } from "../src/export/bom"
import { gerberLayers } from "../src/export/gerber"
import { pnpCsv } from "../src/export/pnp"
import { computeConnectivity } from "../src/model/connectivity"
import { getConnectivity } from "../src/model/connectivityCache"
import { moveDrawing } from "../src/model/drawings"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { onBoard } from "../src/model/partFlags"
import { pcbPads } from "../src/model/instances"
import { resolvedComponents, ruleAreaFlags, symbolBox } from "../src/model/ruleAreas"
import { ROOT_SHEET } from "../src/model/sheets"
import type { ComponentInstance, DrawingBus, DrawingLine, Project } from "../src/model/types"
import { addVariant, setActiveVariant, setVariantOverride } from "../src/model/variants"
import { projectApi } from "../src/store/projectStore"
import { deriveNets } from "./kicad-census/netlist-sch.mjs"
import { built } from "./built"
import { LIB_R, schematic, type SymSpec } from "./kicad-schematic-fixtures"
import { bus, label } from "./kicad-sch-s3-fixtures"

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
