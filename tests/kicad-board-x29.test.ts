import { describe, expect, it } from "vitest"
import { gerberLayers, gerberMask } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { computeConnectivity } from "../src/model/connectivity"
import { setCopperLayerCount } from "../src/model/layerOps"
import { BUILT_EXTENSIONS, importKicadBoard, readKicadBoard } from "../src/model/kicad/board"
import { nonCopperFills, otherFillsOn } from "../src/model/nonCopperFill"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { updateZone, removeZones, setZoneSurface } from "../src/model/zoneOps"
import { isOtherZone, isWholeBoardPour, zoneLayers } from "../src/model/zones"
import type { Project, Zone } from "../src/model/types"
import { runTool } from "../src/ai/tools"
import { areaMm2OfZone } from "../src/panels/zoneInspector"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"
import { rectangle, twoResistors, withZone } from "./zones-fixtures"

// X29: filled zones on layers that are not copper (solder mask, paste, silkscreen, user layers, the board's edge). The importer reads them with every setting of the file, the project holds
// them (`Zone.other`), the editor fills them by KiCad's rule for such a zone (`nonCopperFill.ts`), the Gerber of their layer plots the fill, the project file stores them, and the KiCad
// writer says them back so the file imports as the same project.

const square = "(polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8)))"
const nets = ['(net 0 "")', '(net 1 "GND")']
const part = footprint({ pads: [pad({ at: "5 5", net: '(net 1 "GND")' }), pad({ number: "2", at: "9 5", net: '(net 1 "GND")' })] })
const fill = "(connect_pads (clearance 0.508)) (min_thickness 0.254) (filled_areas_thickness no) (fill yes (thermal_gap 0.508) (thermal_bridge_width 0.508))"
let zoneCount = 0
const zone = (layer: string, extra = fill, polygon = square, net = '(net 0) (net_name "")') => `(zone ${net} ${layer} (uuid "00000000-0000-4000-8000-${String(++zoneCount).padStart(12, "0")}") (hatch edge 0.5) ${extra} ${polygon})`
const KEEPOUT = (pour: boolean) => `(keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour ${pour ? "not_allowed" : "allowed"}) (footprints allowed)) (placement (enabled no) (sheetname ""))`

const imp = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ nets, body: [part, ...body], ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}\n${r.report.entries.filter((e) => e.severity === "refused").map((e) => e.why).join("\n")}`)
  return r
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
const area = (p: Project, layer: string) => areaMm2OfZone(otherFillsOn(p, layer).flatMap((f) => f.polygons))

describe("X29 is built, and the gate says so", () => {
  it("BUILT_EXTENSIONS holds X29, the need is still named, and a board with such a zone is imported", () => {
    expect(BUILT_EXTENSIONS.has("X29")).toBe(true)
    const text = board({ nets, body: [part, zone('(layer "F.Mask")')] })
    const read = readKicadBoard(text)
    expect(read.board.zones[0].layers).toEqual(["F.Mask"])
    expect(importKicadBoard(text).status).toBe("imported")
  })

  it("brings in the layers, every setting of the file and no net", () => {
    const r = imp([zone('(layer "B.SilkS")', `(priority 2) (connect_pads yes (clearance 0.4)) (min_thickness 0.3) (filled_areas_thickness no) (fill yes (smoothing fillet) (radius 1) (thermal_gap 0.45) (thermal_bridge_width 0.35))`, square, '(net 1) (net_name "GND")')])
    const z = r.project.zones[0]
    expect(z).toMatchObject({ net: "", layer: "bottom", layers: [], other: ["B.SilkS"], priority: 2, clearance: 0.4, minWidth: 0.3, connect: "solid", thermalGap: 0.45, spokeWidth: 0.35, smoothing: { kind: "fillet", radius: 1 } })
    expect(z.teardrop).toBeUndefined()
    expect(z.edgeGap).toBeUndefined()
    expect(isOtherZone(z)).toBe(true)
    expect(zoneLayers(z)).toEqual([])
    expect(isWholeBoardPour(z)).toBe(false)
    const e = r.report.entries.find((x) => x.code === "zones-non-copper")
    expect(e?.count).toBe(1)
    expect(e?.why).toMatch(/plot on the Gerber/)
    expect(r.report.entries.find((x) => x.code === "zones-refilled")).toBeUndefined()
  })

  it("every kind of layer is held: mask, paste, silkscreen, fabrication, user, and the board's edge; a wildcard is both sides", () => {
    const r = imp([
      zone('(layer "F.Mask")'),
      zone('(layer "B.Paste")'),
      zone('(layer "F.Fab")'),
      zone('(layer "Dwgs.User")'),
      zone('(layer "User.3")'),
      zone('(layers "F.CrtYd" "B.CrtYd")'),
      zone('(layer "Edge.Cuts")'),
      zone('(layers "*.Mask")'),
    ])
    expect(r.project.zones.map((z) => z.other)).toEqual([["F.Mask"], ["B.Paste"], ["F.Fab"], ["Dwgs.User"], ["User.3"], ["F.CrtYd", "B.CrtYd"], ["Edge.Cuts"], ["F.Mask", "B.Mask"]])
    expect(r.project.zones.map((z) => z.layer)).toEqual(["top", "bottom", "top", "top", "top", "top", "top", "top"])
  })

  it("a keepout on copper and on the mask keeps both lists; one on a layer that is not copper alone has no copper layer", () => {
    const r = imp([
      zone('(layers "F&B.Cu" "*.Mask")', KEEPOUT(true)),
      zone('(layer "B.SilkS")', KEEPOUT(true)),
    ])
    const [mixed, sided] = r.project.zones
    expect(mixed).toMatchObject({ layer: "top", layers: ["top", "bottom"], other: ["F.Mask", "B.Mask"], keepout: { pour: true } })
    expect(sided).toMatchObject({ layer: "bottom", layers: [], other: ["B.SilkS"], keepout: { pour: true } })
    expect(r.report.entries.find((x) => x.code === "rule-areas-non-copper")?.count).toBe(2)
  })

  it("a pour on copper and on a layer that is not copper at once is refused as inexact, in words", () => {
    const r = importKicadBoard(board({ nets, body: [part, zone('(layers "F.Cu" "F.Mask")', fill, square, '(net 1) (net_name "GND")')] }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") {
      expect(r.reason).toBe("inexact")
      expect(r.message).toMatch(/filled on a copper layer and on a layer that is not copper at once/)
    }
  })

  it("a layer that is none of KiCad's is refused as inexact, naming it", () => {
    const r = importKicadBoard(board({ nets, body: [part, zone('(layer "Foo.Bar")')] }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.message).toMatch(/Foo\.Bar/)
  })

  it("a zone on a copper layer is what it was", () => {
    const r = imp([zone('(layer "F.Cu")', fill, square, '(net 1) (net_name "GND")')])
    const z = r.project.zones[0]
    expect(z.other).toBeUndefined()
    expect(z.layers).toBeUndefined()
    expect(z.net).toBe("GND")
  })

  it("an old board (KiCad 5) names its layers the same way and its zone's stored fill is not kept", () => {
    const text = board({ version: 4, nets, body: [footprint({ token: "module", pads: [pad({ at: "5 5", net: '(net 1 "GND")' })] }), `(zone (net 0) (net_name "") (layer F.Mask) (tstamp 5A0) (hatch edge 0.508) (connect_pads (clearance 0.508)) (min_thickness 0.254) (fill yes (arc_segments 16) (thermal_gap 0.508) (thermal_bridge_width 0.508)) (polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8))))`] })
    const r = importKicadBoard(text)
    expect(r.status).toBe("imported")
    if (r.status === "imported") expect(r.project.zones[0]).toMatchObject({ other: ["F.Mask"], unordered: true })
  })
})

describe("the fill of a zone that is not on copper", () => {
  const proj = (...zones: string[]) => imp(zones).project

  it("is its polygon, a little rounded at the corners by the minimum width, and nothing for a project without one", () => {
    const p = proj(zone('(layer "F.Mask")'))
    // 16 by 6 mm: the opening by 0.254 mm rounds the corners, taking a fraction of a square millimetre
    expect(area(p, "F.Mask")).toBeGreaterThan(95.9)
    expect(area(p, "F.Mask")).toBeLessThan(96)
    expect(nonCopperFills(p)).toHaveLength(1)
    const plain = twoResistors()
    expect(nonCopperFills(plain)).toBe(nonCopperFills(plain))
    expect(nonCopperFills(plain)).toHaveLength(0)
  })

  it("is kept inside the board's outline", () => {
    const p = proj(zone('(layer "F.Mask")', fill, "(polygon (pts (xy -5 2) (xy 10 2) (xy 10 8) (xy -5 8)))"))
    // the board is 0 to 20 by 0 to 10: only x from 0 to 10 stays
    expect(area(p, "F.Mask")).toBeGreaterThan(59.8)
    expect(area(p, "F.Mask")).toBeLessThan(60)
  })

  it("loses a neck thinner than the minimum width, and keeps one that is as wide", () => {
    const dumbbell = (neck: number) => `(polygon (pts (xy 2 2) (xy 6 2) (xy 6 ${5 - neck / 2}) (xy 12 ${5 - neck / 2}) (xy 12 2) (xy 16 2) (xy 16 8) (xy 12 8) (xy 12 ${5 + neck / 2}) (xy 6 ${5 + neck / 2}) (xy 6 8) (xy 2 8)))`
    const thin = proj(zone('(layer "F.SilkS")', fill, dumbbell(0.1)))
    const wide = proj(zone('(layer "F.SilkS")', fill, dumbbell(1)))
    expect(otherFillsOn(thin, "F.SilkS")[0].polygons).toHaveLength(2)
    expect(otherFillsOn(wide, "F.SilkS")[0].polygons).toHaveLength(1)
  })

  it("is cut by a rule area that keeps pours out and is on its layer, and by no other", () => {
    const cut = "(polygon (pts (xy 8 0) (xy 10 0) (xy 10 10) (xy 8 10)))"
    const p = proj(zone('(layer "F.Mask")'), zone('(layers "F.Cu" "F.Mask")', KEEPOUT(true), cut))
    expect(otherFillsOn(p, "F.Mask")[0].polygons).toHaveLength(2)
    expect(area(p, "F.Mask")).toBeGreaterThan(83.5)
    expect(area(p, "F.Mask")).toBeLessThan(84)
    // a rule area on the other side's mask, or one that allows pours, changes nothing
    const other = proj(zone('(layer "F.Mask")'), zone('(layers "F.Cu" "B.Mask")', KEEPOUT(true), cut), zone('(layers "F.Cu" "F.Mask")', KEEPOUT(false), cut))
    expect(otherFillsOn(other, "F.Mask")[0].polygons).toHaveLength(1)
  })

  it("two zones of a layer that overlap are one shape (no notch where corners are smoothed), and zones on other layers do not join", () => {
    const a = "(polygon (pts (xy 2 2) (xy 10 2) (xy 10 8) (xy 2 8)))"
    const b = "(polygon (pts (xy 8 2) (xy 16 2) (xy 16 8) (xy 8 8)))"
    const p = proj(zone('(layer "F.Mask")', fill, a), zone('(layer "F.Mask")', fill, b), zone('(layer "B.Mask")', fill, b))
    expect(otherFillsOn(p, "F.Mask").map((f) => f.polygons.length)).toEqual([1, 1])
    expect(area(p, "B.Mask")).toBeLessThan(area(p, "F.Mask") / 2 + 5)
  })

  it("a fillet takes the copper off a convex corner and nothing else", () => {
    const sq = proj(zone('(layer "F.SilkS")', fill, square))
    const round = proj(zone('(layer "F.SilkS")', "(connect_pads (clearance 0.5)) (min_thickness 0.254) (filled_areas_thickness no) (fill yes (smoothing fillet) (radius 2) (thermal_gap 0.5) (thermal_bridge_width 0.5))", square))
    // a corner of radius 2 cuts (4 - pi) = 0.858 mm2 off a square corner
    expect(area(sq, "F.SilkS") - area(round, "F.SilkS")).toBeGreaterThan(4 * 0.85 - 0.3)
    expect(area(sq, "F.SilkS") - area(round, "F.SilkS")).toBeLessThan(4 * 0.87 + 0.3)
  })

  it("a zone with a hole has the hole in its fill", () => {
    const holed = `(polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8))) (polygon (pts (xy 8 4) (xy 12 4) (xy 12 6) (xy 8 6)))`
    const p = proj(zone('(layer "F.Mask")', fill, holed))
    expect(otherFillsOn(p, "F.Mask")[0].polygons[0]).toHaveLength(2)
    expect(area(p, "F.Mask")).toBeLessThan(96 - 7.9)
  })

  it("a minimum width of nothing leaves the polygon as it is", () => {
    const p = proj(zone('(layer "F.Mask")', "(connect_pads (clearance 0.5)) (min_thickness 0) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))"))
    expect(area(p, "F.Mask")).toBeCloseTo(96, 3)
  })
})

describe("the Gerber of a layer plots the fill", () => {
  const regions = (g: string) => (g.match(/G36\*/g) ?? []).length

  it("mask, paste and silkscreen each plot the zone on their side and no other", () => {
    const r = imp([zone('(layer "F.Mask")'), zone('(layer "B.Paste")'), zone('(layer "F.SilkS")', fill, "(polygon (pts (xy 2 2) (xy 6 2) (xy 6 4)))")])
    const g = gerberLayers(r.project)
    expect(regions(g.F_Mask)).toBe(1)
    expect(regions(g.B_Mask)).toBe(0)
    expect(regions(g.B_Paste)).toBe(1)
    expect(regions(g.F_Paste)).toBe(0)
    expect(regions(g.F_Silkscreen)).toBe(1)
    expect(regions(g.B_Silkscreen)).toBe(0)
    expect(regions(g.F_Cu)).toBe(0)
  })

  it("a zone with a hole plots as one region with the hole fractured out of it", () => {
    const holed = `(polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8))) (polygon (pts (xy 8 4) (xy 12 4) (xy 12 6) (xy 8 6)))`
    const g = gerberLayers(imp([zone('(layer "F.Mask")', fill, holed)]).project)
    expect(regions(g.F_Mask)).toBe(1)
  })

  it("a board with a minimum mask web builds the opening from the zone's outline", () => {
    const r = imp([zone('(layer "F.Mask")')], { setup: "(setup (solder_mask_min_width 0.1))" })
    expect(r.project.rules.maskMinWidth).toBeGreaterThan(0)
    expect(regions(gerberMask(r.project, "top"))).toBeGreaterThanOrEqual(1)
    expect(regions(gerberMask(r.project, "bottom"))).toBe(0)
  })

  it("a zone on a user layer is kept and drawn, and plots nowhere (the editor has no Gerber for it)", () => {
    const base = gerberLayers(imp([]).project)
    const g = gerberLayers(imp([zone('(layer "Dwgs.User")')]).project)
    expect(g).toEqual(base)
  })

  it("a zone on the board's edge plots on the edge layer", () => {
    const g = gerberLayers(imp([zone('(layer "Edge.Cuts")')]).project)
    expect(regions(g.Edge_Cuts)).toBe(1)
  })
})

describe("the KiCad file says it back", () => {
  it("writes the layers, the settings and the fill of each layer, and imports as the same project", async () => {
    const r = imp([
      zone('(layer "F.Mask")', `(priority 1) ${fill}`),
      zone('(layers "B.SilkS" "B.Paste")', "(connect_pads (clearance 0.2)) (min_thickness 0.3) (filled_areas_thickness no) (fill yes (smoothing chamfer) (radius 1) (thermal_gap 0.5) (thermal_bridge_width 0.5))", "(polygon (pts (xy 3 3) (xy 9 3) (xy 9 7) (xy 3 7)))"),
      zone('(layers "F&B.Cu" "*.Mask")', KEEPOUT(true), "(polygon (pts (xy 10 0) (xy 12 0) (xy 12 10) (xy 10 10)))"),
      zone('(layer "Dwgs.User")'),
    ])
    const text = await pcbOf(r.project)
    expect(unknownNodes(text)).toEqual([])
    expect(text).toContain('(layer "F.Mask")')
    expect(text).toContain('(layers "B.SilkS" "B.Paste")')
    expect(text).toContain('(layers "F.Cu" "B.Cu" "F.Mask" "B.Mask")')
    expect(text).toMatch(/\(filled_polygon \(layer "F\.Mask"\)/)
    expect(text).toMatch(/\(filled_polygon \(layer "B\.SilkS"\)/)
    expect(text).toMatch(/\(filled_polygon \(layer "B\.Paste"\)/)
    expect(text).toMatch(/\(filled_polygon \(layer "Dwgs\.User"\)/)
    // the keepout is not filled
    expect(text.match(/\(keepout/g)).toHaveLength(1)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(r.project, again.project)).toEqual([])
    // the file's own reader sees the same layers
    expect(readKicadBoard(text).board.zones.map((z) => z.layers)).toEqual([["F.Mask"], ["B.SilkS", "B.Paste"], ["F.Cu", "B.Cu", "F.Mask", "B.Mask"], ["Dwgs.User"]])
  })

  it("the fill it writes is the editor's, one polygon for each piece", async () => {
    const holed = `(polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8))) (polygon (pts (xy 8 4) (xy 12 4) (xy 12 6) (xy 8 6)))`
    const r = imp([zone('(layer "F.Mask")', fill, holed)])
    const text = await pcbOf(r.project)
    expect(text.match(/\(filled_polygon \(layer "F\.Mask"\)/g)).toHaveLength(1)
    expect(text).toContain("(fill yes")
  })
})

describe("the project file", () => {
  it("stores a zone on layers that are not copper, in the zone's compact form, and reads it back the same", () => {
    const r = imp([zone('(layers "B.SilkS" "B.Paste")'), zone('(layer "B.SilkS")', KEEPOUT(true), square)])
    const raw = JSON.parse(serializeProject(r.project)).project
    expect(raw.zones[0]).toMatchObject({ layers: [], other: ["B.SilkS", "B.Paste"], layer: "bottom" })
    expect(raw.zones[0].ol[0][0]).toBe("p")
    const back = parseProjectFile(serializeProject(r.project), { id: "p1", createdAt: 1, updatedAt: 1 })
    expect(back.zones).toEqual(r.project.zones)
    // a second save and load changes nothing
    expect(parseProjectFile(serializeProject(back), { id: "p1", createdAt: 1, updatedAt: 1 }).zones).toEqual(back.zones)
  })

  it("repairs what cannot be: a pour on copper and on another layer keeps its copper, an unknown layer is left out, a zone with no layer at all is one on its anchor layer", () => {
    const r = imp([zone('(layer "F.Mask")')])
    const raw = JSON.parse(serializeProject(r.project))
    raw.project.zones[0] = { ...raw.project.zones[0], layers: ["top", "bottom"], other: ["F.Mask"] }
    const mixed = parseProjectFile(raw, { id: "p", createdAt: 1, updatedAt: 1 })
    expect(mixed.zones[0]).toMatchObject({ layer: "top", layers: ["top", "bottom"] })
    expect(mixed.zones[0].other).toBeUndefined()
    raw.project.zones[0] = { ...raw.project.zones[0], layers: [], other: ["Nope.Layer", "F.Mask"] }
    const clean = parseProjectFile(raw, { id: "p", createdAt: 1, updatedAt: 1 })
    expect(clean.zones[0].other).toEqual(["F.Mask"])
    raw.project.zones[0] = { ...raw.project.zones[0], layers: [], other: ["Nope.Layer"] }
    const none = parseProjectFile(raw, { id: "p", createdAt: 1, updatedAt: 1 })
    expect(none.zones[0].other).toBeUndefined()
  })

  it("a keepout on one copper layer and a layer that is not copper keeps both through a save and a load", () => {
    const r = imp([zone('(layers "F.Cu" "F.Fab")', KEEPOUT(true))])
    expect(r.project.zones[0]).toMatchObject({ layer: "top", other: ["F.Fab"] })
    expect(r.project.zones[0].layers).toBeUndefined()
    const back = parseProjectFile(serializeProject(r.project), { id: "p1", createdAt: 1, updatedAt: 1 })
    expect(back.zones).toEqual(r.project.zones)
  })

  it("a whole-board pour and a copper polygon are stored as they were", () => {
    const base = twoResistors()
    const p = withZone(withZone(base, rectangle(-10, -10, 10, 10), { net: "GND", layers: ["top"] }, "a"), rectangle(-5, -5, 5, 5), { net: "GND", layers: ["top", "bottom"] }, "b")
    const raw = JSON.parse(serializeProject(p)).project
    for (const z of raw.zones) {
      expect(z.other).toBeUndefined()
      expect(z.layers === undefined || z.layers.length > 1).toBe(true)
    }
  })
})

describe("editing", () => {
  const base = (): Project => {
    const p = twoResistors()
    const z: Zone = { id: "m1", net: "", layer: "top", layers: [], other: ["F.Mask"], outline: withZone(p, rectangle(-8, -6, 8, 6), {}, "tmp").zones[0].outline }
    return { ...p, zones: [z] }
  }

  it("moves a zone between layers: a pour is on one kind of layer, a keepout may be on both", () => {
    const p = base()
    const toSilk = setZoneSurface(p, "m1", [], ["B.SilkS", "F.SilkS"])
    expect(toSilk.zones[0]).toMatchObject({ layer: "top", layers: [], other: ["F.SilkS", "B.SilkS"] })
    expect(setZoneSurface(p, "m1", ["top"], ["F.Mask"])).toBe(p)
    expect(setZoneSurface(p, "m1", [], [])).toBe(p)
    const toCopper = setZoneSurface(p, "m1", ["top", "bottom"], [])
    expect(toCopper.zones[0].other).toBeUndefined()
    expect(toCopper.zones[0]).toMatchObject({ layer: "top", layers: ["top", "bottom"] })
    const rule = updateZone(p, "m1", { keepout: { pour: true } })
    expect(setZoneSurface(rule, "m1", ["bottom"], ["B.Mask"]).zones[0]).toMatchObject({ layer: "bottom", other: ["B.Mask"] })
    expect(setZoneSurface(rule, "m1", ["bottom"], ["B.Mask"]).zones[0].layers).toBeUndefined()
  })

  it("a locked zone stays where it is, and a zone is removed like any other", () => {
    const p = base()
    const locked = updateZone(p, "m1", { locked: true })
    expect(setZoneSurface(locked, "m1", [], ["B.Mask"])).toBe(locked)
    expect(removeZones(p, ["m1"]).zones).toHaveLength(0)
  })

  it("changing the number of copper layers keeps it, and so does taking an inner layer away from a rule area that has one", () => {
    const p = base()
    expect(setCopperLayerCount(p, 4).project.zones).toHaveLength(1)
    expect(setCopperLayerCount(setCopperLayerCount(p, 4).project, 2).project.zones[0]).toMatchObject({ layers: [], other: ["F.Mask"] })
    const mixed: Project = { ...setCopperLayerCount(p, 4).project }
    const rule: Zone = { ...mixed.zones[0], layer: "in1", layers: undefined, keepout: { pour: true } }
    const four = { ...mixed, zones: [rule] }
    const two = setCopperLayerCount(four, 2).project.zones
    expect(two).toHaveLength(1)
    expect(two[0]).toMatchObject({ layers: [], other: ["F.Mask"], layer: "top" })
  })

  it("does nothing to Checks, the router's copper or the pours: a zone that is not copper has no copper layer", () => {
    const p = base()
    const without = { ...p, zones: [] }
    const none = analyzePcb(without, computeConnectivity(without))
    const some = analyzePcb(p, computeConnectivity(p))
    expect(some.zoneFills).toEqual([])
    expect(some.violations.map((v) => v.kind)).toEqual(none.violations.map((v) => v.kind))
  })

  it("Sakura's get_design lists it by the layers it is on", () => {
    const p = base()
    const out = runTool(p, "get_design", {})
    const text = JSON.stringify(out)
    expect(text).toContain("F.Mask")
  })
})

describe("the other exports", () => {
  it("Circuit JSON leaves such a zone out and says so", () => {
    const r = imp([zone('(layer "F.Mask")')])
    const cj = projectToCircuitJson(r.project)
    expect(cj.notes.join("\n")).toMatch(/Zones on layers that are not copper/)
  })
})
