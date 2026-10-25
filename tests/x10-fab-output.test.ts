import { describe, expect, it } from "vitest"
import { gerberMask, gerberPaste } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { applyBoardSettings, applyProjectSettings } from "../src/export/kicadPost"
import { maskRegions } from "../src/export/maskMerge"
import { fabricationNotes } from "../src/export/notes"
import type { WorldPad } from "../src/model/instances"
import { classIndex } from "../src/model/netClasses"
import { analyzePcb } from "../src/model/pcb"
import { computeConnectivity } from "../src/model/connectivity"
import { circleSegments, fillZones, withMaxError } from "../src/model/pour"
import { migrateProjectFile, parseProjectFile, PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION, serializeProject } from "../src/model/projectFile"
import type { DesignRules, NetClass, Project } from "../src/model/types"
import { built } from "./built"

const DASHES = new RegExp(String.fromCharCode(0x2013) + "|" + String.fromCharCode(0x2014))
const cls = (name: string, extra: Partial<NetClass> = {}): NetClass => ({ name, nets: [], ...extra })
const rect = (x: number, y: number, w = 1, h = 1): WorldPad => ({ componentId: "c", pin: "1", padNumber: "1", shape: "rect", x, y, width: w, height: h, layers: ["top"] })
const withRules = (p: Project, rules: Partial<DesignRules>): Project => ({ ...p, rules: { ...p.rules, ...rules } })
const area = (ring: { x: number; y: number }[]) => Math.abs(ring.reduce((a, p, i) => a + (ring[(i + 1) % ring.length].x - p.x) * (ring[(i + 1) % ring.length].y + p.y), 0)) / 2

describe("the mask with a minimum web (KiCad's solder_mask_min_width)", () => {
  const base = built("blinker")
  const openings = (minWidth: number, pads: WorldPad[], grow = 0.05) => maskRegions(withRules(base, { maskMinWidth: minWidth, maskExpansion: grow }), "top", pads, [])
  it("openings closer than the minimum are one region, and openings further apart are two", () => {
    // pads 1 mm wide, 1.25 mm apart centre to centre: 0.25 apart, and 0.15 apart once each opening grows by 0.05
    const pair = [rect(0, 0), rect(1.25, 0)]
    expect(openings(0.2, pair)).toHaveLength(1)
    expect(openings(0.15, pair)).toHaveLength(2)
    expect(openings(0.1, pair)).toHaveLength(2)
  })
  it("a gap exactly the minimum wide is kept: KiCad inflates by half the minimum less a nanometre", () => {
    const pair = [rect(0, 0), rect(1.2, 0)]
    // openings 1.1 wide with a gap of 0.1: a minimum of 0.1 keeps them apart, a hair more joins them
    expect(openings(0.1, pair)).toHaveLength(2)
    expect(openings(0.100003, pair)).toHaveLength(1)
  })
  it("the exact openings are all kept, and a merged one covers both", () => {
    const pair = [rect(0, 0), rect(1.25, 0)]
    const one = openings(0.2, pair)[0][0]
    expect(area(one)).toBeGreaterThan(2 * 1.1 * 1.1)
    // the bridge is as tall as the pads and fills the gap between the openings
    const xs = one.map((p) => p.x)
    expect(Math.min(...xs)).toBeCloseTo(-0.55, 5)
    expect(Math.max(...xs)).toBeCloseTo(1.8, 5)
  })
  it("a rectangular opening grown by the expansion has rounded corners, as KiCad's polygon opening has", () => {
    const [region] = openings(0.1, [rect(0, 0)], 0.2)
    expect(region[0].length).toBeGreaterThan(8)
    // and no corner of the grown rectangle is filled: the corner point is outside the opening
    const corner = { x: 0.7, y: 0.7 }
    expect(region[0].some((p) => Math.hypot(p.x - corner.x, p.y - corner.y) < 0.02)).toBe(false)
  })
  it("the Gerber has regions for it, and plain flashes without it", () => {
    const merged = gerberMask(withRules(base, { maskMinWidth: 0.1 }), "top")
    expect(merged).toMatch(/G36\*/)
    expect(merged).not.toMatch(/D03\*/)
    const plain = gerberMask(base, "top")
    expect(plain).toMatch(/D03\*/)
    expect(plain).not.toMatch(/G36\*/)
    // the file is the same kind of file: a negative Soldermask layer
    expect(merged).toMatch(/%TF.FileFunction,Soldermask,Top\*%/)
    expect(merged).toMatch(/%TF.FilePolarity,Negative\*%/)
  })
  it("a board with the rule absent or zero plots exactly as a board with none", () => {
    expect(gerberMask(withRules(base, { maskMinWidth: 0 as unknown as undefined }), "top")).toBe(gerberMask(base, "top"))
  })
})

describe("the paste ratio (KiCad's pad_to_paste_clearance_ratio)", () => {
  const base = built("blinker")
  it("grows an aperture by the ratio of the pad's size on each side, on top of the expansion, and a negative ratio shrinks it", () => {
    const apertures = (g: string) => [...g.matchAll(/%ADD\d+(R|C|O),([0-9.]+)(?:X([0-9.]+))?\*%/g)].map((m) => [m[1], Number(m[2]), m[3] ? Number(m[3]) : null] as const)
    const flat = apertures(gerberPaste(base, "top"))
    const shrunk = apertures(gerberPaste(withRules(base, { pasteRatio: -0.1 }), "top"))
    const grown = apertures(gerberPaste(withRules(base, { pasteRatio: 0.1, pasteExpansion: 0.02 }), "top"))
    expect(flat.length).toBeGreaterThan(0)
    const pads = flat.filter((a) => a[0] === "R" && a[2] !== null)
    expect(pads.length).toBeGreaterThan(0)
    const [, w, h] = pads[0]
    // a pad of w by h with a ratio of -10% is 0.8 w by 0.8 h (each side loses a tenth); +10% with 0.02 added each side is 1.2 w + 0.04
    expect(shrunk.some((a) => a[0] === "R" && Math.abs(a[1] - 0.8 * w) < 1e-5 && Math.abs((a[2] ?? 0) - 0.8 * (h ?? 0)) < 1e-5)).toBe(true)
    expect(grown.some((a) => a[0] === "R" && Math.abs(a[1] - (1.2 * w + 0.04)) < 1e-5 && Math.abs((a[2] ?? 0) - (1.2 * (h ?? 0) + 0.04)) < 1e-5)).toBe(true)
  })
  it("never takes more than half the pad off each side", () => {
    const g = gerberPaste(withRules(base, { pasteRatio: -9 }), "top")
    expect(g).not.toMatch(/D03\*/)
  })
  it("a board with no ratio plots exactly as before", () => {
    expect(gerberPaste(withRules(base, { pasteRatio: undefined }), "top")).toBe(gerberPaste(base, "top"))
  })
})

describe("max_error (KiCad's largest gap between a polygon and the circle it stands for)", () => {
  it("counts the corners of a circle as KiCad does: at least 8, one per 2 acos(1 - error / r)", () => {
    expect(circleSegments(0.3, 0.005)).toBe(17)
    expect(circleSegments(10, 0.005)).toBe(Math.round(360 / ((180 / Math.PI) * Math.acos(1 - 0.0005) * 2)))
    // a small circle is held to 8 corners at the least (45 degrees each) and a huge error does not break it
    expect(circleSegments(0.01, 1)).toBe(8)
  })
  it("a finer maximum error makes the pour's round shapes finer, and none given leaves them as they were", () => {
    const base = built("blinker")
    const pour = { ...base, zones: [{ id: "z", net: "GND", layer: "top" as const }], traces: [], vias: [] }
    const sch = computeConnectivity(pour)
    const analysis = analyzePcb(pour, sch)
    const run = (maxError?: number) => fillZones({ ...pour, rules: { ...pour.rules, ...(maxError ? { maxError } : {}) } }, sch, { items: analysis.items.filter((i) => i.kind !== "zone"), netOf: (i) => analysis.islandNet.get(analysis.island.get(analysis.items[i].id)!) ?? null })
    const count = (f: ReturnType<typeof fillZones>) => f.reduce((n, z) => n + z.polygons.reduce((m, poly) => m + poly.reduce((k, ring) => k + ring.length, 0), 0), 0)
    const none = run()
    expect(count(run(0.0005))).toBeGreaterThan(count(none))
    expect(count(run(0.5))).toBeLessThanOrEqual(count(none))
    expect(JSON.stringify(run(undefined))).toBe(JSON.stringify(none))
    expect(withMaxError(undefined, () => 1)).toBe(1)
  })
})

describe("a pour keeps a net class's clearance from its nets' copper", () => {
  it("a zone with no clearance of its own is pulled back further from copper of a class that wants more; one with its own clearance is not", () => {
    const base = built("regulator")
    const zoneNet = base.zones[0].net
    const conn = computeConnectivity(base)
    const other = conn.nets.find((n) => n.name !== zoneNet && n.pins.length >= 2)!
    const area = (p: Project) => analyzePcb(p, computeConnectivity(p)).zoneFills.reduce((a, f) => a + f.polygons.reduce((s, poly) => s + poly.reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0), 0), 0)
    const flat = area(base)
    const classed = withRules(base, { netClasses: [cls("Wide", { nets: [other.name], clearance: 1.5 })] })
    expect(area(classed)).toBeLessThan(flat)
    // the Default class's clearance, which is the rules', adds nothing to the pour's own
    const defaulted = withRules(base, { netClasses: [cls("Same", { nets: [other.name] })] })
    expect(area(defaulted)).toBeCloseTo(flat, 6)
    // a zone that sets its own clearance keeps it: a local override wins over classes
    const own: Project = { ...classed, zones: classed.zones.map((z) => ({ ...z, clearance: base.rules.pourClearance })) }
    const ownFlat: Project = { ...base, zones: base.zones.map((z) => ({ ...z, clearance: base.rules.pourClearance })) }
    expect(area(own)).toBeCloseTo(area(ownFlat), 6)
  })
})

const ringArea = (ring: { x: number; y: number }[]) => ring.reduce((a, p, i) => a + (ring[(i + 1) % ring.length].x - p.x) * (ring[(i + 1) % ring.length].y + p.y), 0) / 2

describe("the KiCad export writes the classes", () => {
  const base = built("blinker")
  const nets = computeConnectivity(base).nets.filter((n) => n.pins.length > 1).map((n) => n.name)
  const classed = withRules(base, {
    clearance: 0.2,
    netClasses: [
      cls("Power", { nets: [nets[0]], clearance: 0.4, traceWidth: 0.6, viaDiameter: 0.9, viaDrill: 0.5, diffPairWidth: 0.2, diffPairGap: 0.25, microViaDiameter: 0.3, microViaDrill: 0.1 }),
      cls("Fine", { nets: [nets[1]], clearance: 0.1 }),
      cls("Bus", { patterns: ["D*"] }),
    ],
    viaSizes: [{ diameter: 0.8, drill: 0.4 }],
    maskMinWidth: 0.1,
    pasteRatio: -0.05,
    maskBridgesInParts: true,
    maxError: 0.002,
  })
  const pro = (p: Project) => JSON.parse(applyProjectSettings(JSON.stringify({ board: { design_settings: { rules: {}, defaults: {} } }, net_settings: {} }), p).text)
  it("each class is in the project with every size resolved, its nets as exact patterns, and the board's smallest clearance is the lowest of them", () => {
    const j = pro(classed)
    const byName = Object.fromEntries(j.net_settings.classes.map((c: { name: string }) => [c.name, c]))
    expect(byName.Default).toMatchObject({ clearance: 0.2, track_width: base.rules.traceWidth })
    expect(byName.Power).toMatchObject({ clearance: 0.4, track_width: 0.6, via_diameter: 0.9, via_drill: 0.5, diff_pair_width: 0.2, diff_pair_gap: 0.25, microvia_diameter: 0.3, microvia_drill: 0.1 })
    // a class that sets only a clearance still states every size (the first class a net is in decides all of them)
    expect(byName.Fine).toMatchObject({ clearance: 0.1, track_width: base.rules.traceWidth, via_diameter: base.rules.viaDiameter, via_drill: base.rules.viaDrill })
    expect(j.net_settings.netclass_patterns).toEqual(expect.arrayContaining([{ netclass: "Power", pattern: nets[0].replace(/[.+*?^$()[\]{}|\\]/g, "\\$&") }, { netclass: "Bus", pattern: "D*" }]))
    expect(j.board.design_settings.rules.min_clearance).toBe(0.1)
    expect(j.board.design_settings.rules.max_error).toBe(0.002)
    expect(j.board.design_settings.defaults.via_dimensions).toContainEqual({ diameter: 0.8, drill: 0.4 })
  })
  it("classes are written in the project's order, after the classes that carry a width given to one net, which only set the width", () => {
    const j = pro(withRules(classed, { netWidths: { [nets[0]]: 0.8 } }))
    const names = j.net_settings.classes.map((c: { name: string; priority?: number }) => [c.name, c.priority])
    expect(names).toEqual([["Default", undefined], ["Trace 0.8 mm", 0], ["Power", 1], ["Fine", 2], ["Bus", 3]])
    const width = j.net_settings.classes.find((c: { name: string }) => c.name === "Trace 0.8 mm")
    expect(Object.keys(width).sort()).toEqual(["name", "priority", "track_width"])
  })
  it("a net with characters KiCad reads specially is matched exactly, and needs no wildcard warning", () => {
    const odd = withRules(base, { netClasses: [cls("Odd", { nets: ["Net-(U1-Pad1)", "A*B"] })] })
    const out = applyProjectSettings(JSON.stringify({ board: { design_settings: { rules: {}, defaults: {} } }, net_settings: {} }), odd)
    expect(JSON.parse(out.text).net_settings.netclass_patterns.map((p: { pattern: string }) => p.pattern)).toEqual(["Net-\\(U1-Pad1\\)", "A\\*B"])
    expect(out.unmatched).toEqual([])
  })
  it("the minimum drill is the smaller of the two, and the export says so; a board with no X10 rules is written as it was", () => {
    const two = applyProjectSettings(JSON.stringify({ board: { design_settings: { rules: {}, defaults: {} } }, net_settings: {} }), withRules(base, { minDrill: 0.3, minViaDrill: 0.2 }))
    expect(JSON.parse(two.text).board.design_settings.rules.min_through_hole_diameter).toBe(0.2)
    expect(two.notes.join(" ")).toMatch(/one smallest drill/)
    const plain = applyProjectSettings(JSON.stringify({ board: { design_settings: { rules: {}, defaults: {} } }, net_settings: {} }), base)
    expect(plain.notes).toEqual([])
    const j = JSON.parse(plain.text)
    expect(j.board.design_settings.rules.min_clearance).toBe(base.rules.clearance)
    expect(j.net_settings.classes).toEqual([{ name: "Default", track_width: base.rules.traceWidth, clearance: base.rules.clearance, via_diameter: base.rules.viaDiameter, via_drill: base.rules.viaDrill }])
    expect(j.board.design_settings.rules).not.toHaveProperty("max_error")
  })
  it("the board file has the mask web, the paste ratio and the mask bridges, in the places KiCad 9's parser reads them", () => {
    const pcb = applyBoardSettings("(kicad_pcb\n  (setup\n    (pad_to_mask_clearance 0.05)\n  )\n)", classed)
    expect(pcb).toMatch(/\(solder_mask_min_width 0\.1\)/)
    expect(pcb).toMatch(/\(pad_to_paste_clearance_ratio -0\.05\)/)
    expect(pcb).toMatch(/\(allow_soldermask_bridges_in_footprints yes\)/)
    expect(pcb.indexOf("(setup")).toBeLessThan(pcb.indexOf("solder_mask_min_width"))
    expect(pcb.indexOf("solder_mask_min_width")).toBeLessThan(pcb.indexOf("\n  )"))
    const plain = applyBoardSettings("(kicad_pcb\n  (setup\n    (pad_to_mask_clearance 0.05)\n  )\n)", base)
    expect(plain).not.toMatch(/solder_mask_min_width|paste_clearance_ratio|allow_soldermask/)
  })
  it("the whole export carries them, with notes for what KiCad 9 cannot hold", async () => {
    const { files, notes } = await kicadFiles(classed)
    const pro = JSON.parse(Object.entries(files).find(([k]) => k.endsWith(".kicad_pro"))![1])
    expect(pro.net_settings.classes.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["Default", "Power", "Fine", "Bus"]))
    expect(Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]).toMatch(/solder_mask_min_width 0\.1/)
    expect(notes.join(" ")).toMatch(/Net classes are in the KiCad project/)
    expect(notes.every((n) => !DASHES.test(n))).toBe(true)
  }, 120_000)
})

describe("the fabrication notes list what a fab needs", () => {
  const base = built("blinker")
  const files = ["a.gtl"]
  const notes = (p: Project) => fabricationNotes(p, files, analyzePcb(p, computeConnectivity(p)).items)
  it("a board with no classes reads as it did", () => {
    const text = notes(base)
    expect(text).not.toMatch(/NET CLASSES|Mask web|Paste  |Minimum clearance|Curve accuracy|Via drill  /)
  })
  it("each class with its sizes and net count, the tightest space, the mask web, the paste ratio and the minimum via drill", () => {
    const netNames = computeConnectivity(base).nets.filter((n) => n.pins.length > 1).map((n) => n.name)
    const text = notes(withRules(base, { netClasses: [cls("Power", { nets: [netNames[0]], clearance: 0.4, traceWidth: 0.6 }), cls("Fine", { nets: [netNames[1]], clearance: 0.1 })], maskMinWidth: 0.1, pasteRatio: -0.1, minViaDrill: 0.15, minClearance: 0.05, maxError: 0.002 }))
    expect(text).toMatch(/NET CLASSES/)
    expect(text).toMatch(/Default +0\.2 mm space/)
    expect(text).toMatch(/Power +0\.4 mm space, 0\.6 mm trace, via 0\.6 mm \/ 0\.3 mm; 1 net\b/)
    expect(text).toMatch(/Tightest space +0\.1 mm/)
    expect(text).toMatch(/Mask web +0\.1 mm minimum/)
    expect(text).toMatch(/Paste +-10% of each pad/)
    expect(text).toMatch(/Via drill +0\.15 mm minimum \(through holes: 0\.2 mm\)/)
    expect(text).toMatch(/Minimum clearance +0\.05 mm/)
    expect(text).toMatch(/Curve accuracy +0\.002 mm/)
    expect(DASHES.test(text)).toBe(false)
  })
})

describe("project file version 7 (X10): net classes and their rules", () => {
  const v4doc = {
    format: PROJECT_FILE_FORMAT,
    version: 4,
    project: { name: "v4", description: "", components: [], wires: [], labels: [], rules: { clearance: 0.3, traceWidth: 0.3, netWidths: { VCC: 0.8 } } },
  }
  it("opens a version 4 document with no classes, and keeps what it had", () => {
    const read = parseProjectFile(v4doc, { id: "p" })
    expect(read.rules.netWidths).toEqual({ VCC: 0.8 })
    expect(read.rules).not.toHaveProperty("netClasses")
    expect(migrateProjectFile(v4doc)).toEqual(v4doc.project)
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
    expect(PROJECT_FILE_VERSION).toBe(8)
    // no field of X10 is written for a project that has none
    const written = JSON.parse(serializeProject(read)).project.rules
    for (const k of ["netClasses", "defaultClass", "viaSizes", "diffPairSizes", "minViaDrill", "minClearance", "maskMinWidth", "pasteRatio", "maxError", "maskBridgesInParts"]) expect(written).not.toHaveProperty(k)
  })
  it("a version 3 and a version 2 document reach the current version the same way", () => {
    for (const version of [2, 3]) expect(JSON.parse(serializeProject(parseProjectFile({ ...v4doc, version }, { id: "p" }))).version).toBe(PROJECT_FILE_VERSION)
  })
  it("classes and every rule of X10 survive a save and a load exactly", () => {
    const base = parseProjectFile(v4doc, { id: "p" })
    const p: Project = {
      ...base,
      rules: {
        ...base.rules,
        netClasses: [cls("Power", { nets: ["VCC", "GND"], clearance: 0.4, traceWidth: 0.6, viaDiameter: 1, viaDrill: 0.5, microViaDiameter: 0.35, microViaDrill: 0.12, diffPairWidth: 0.2, diffPairGap: 0.25, patterns: ["V*"], description: "supplies" }), cls("Empty")],
        defaultClass: { description: "Ceci est la Netclass par défaut", diffPairGap: 0.3 },
        viaSizes: [{ diameter: 0.8, drill: 0.4 }, { diameter: 1, drill: 0.6 }],
        diffPairSizes: [{ width: 0.2, gap: 0.25, viaGap: 0.3 }],
        minViaDrill: 0.25,
        minClearance: 0.1,
        maskMinWidth: 0.1,
        pasteRatio: -0.1,
        maxError: 0.002,
        maskBridgesInParts: true,
      },
    }
    const back = parseProjectFile(serializeProject(p), { id: "p" })
    expect(back.rules).toEqual(p.rules)
    // and a second round trip changes nothing, whatever order the fields were built in
    expect(serializeProject(parseProjectFile(serializeProject(back), { id: "p" }))).toBe(serializeProject(back))
  })
  it("a reader of version 6 would refuse this file, which is what keeps a class from being dropped", () => {
    const text = JSON.parse(serializeProject(parseProjectFile(v4doc, { id: "p" })))
    expect(text.version).toBeGreaterThan(6)
  })
})

describe("the class index is cheap", () => {
  it("is built once per rules object and answers a board with no classes without a lookup", () => {
    const base = built("blinker")
    expect(classIndex(base.rules)).toBe(classIndex(base.rules))
    const t0 = performance.now()
    const index = classIndex(base.rules)
    for (let i = 0; i < 200_000; i++) index.pair("A", "B")
    expect(performance.now() - t0).toBeLessThan(200)
  })
})
