import { describe, expect, it } from "vitest"
import { gerberCopper, gerberLayers, gerberMask } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { computeConnectivity } from "../src/model/connectivity"
import { setCopperLayerCount } from "../src/model/layerOps"
import { BUILT_EXTENSIONS, importKicadBoard, readKicadBoard } from "../src/model/kicad/board"
import { nonCopperFills, otherFillsOn } from "../src/model/nonCopperFill"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { removeZones, setZoneSurface, updateZone } from "../src/model/zoneOps"
import { isOtherZone, isWholeBoardPour, zoneLayers, zoneRings } from "../src/model/zones"
import { type ComponentInstance, type Project, type Vec2, type Zone } from "../src/model/types"
import { runTool } from "../src/ai/tools"
import { areaMm2OfZone } from "../src/panels/zoneInspector"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"
import { rectangle, twoResistors, withZone } from "./zones-fixtures"
import { autoroute } from "../src/model/autoroute"
import { updateComponent } from "../src/model/ops"
import { hasPartZones, withPartZones, worldPartZones } from "../src/model/partZones"
import { pcbPads } from "../src/model/instances"

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

{
// X30: zones that belong to a part, a keepout or a pour drawn inside a footprint. KiCad writes them in board coordinates (before 20260616) and they move with the part; here they
// are the part's land's (`FootprintDef.zones`, in the land's frame), the board has them where the part stands (`partZones.ts`), and Checks, the router, the pours and the exports read
// them there.

const nets = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
const KEEPOUT = (extra = "") => `(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (placement (enabled no) (sheetname "")) ${extra}`
const FILL = "(connect_pads (clearance 0)) (min_thickness 0.25) (filled_areas_thickness no) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))"
let n = 0
/** A zone inside a footprint, its corners in the board's frame as KiCad writes them. */
const zoneIn = (corners: [number, number][], layer = '(layer "F.Cu")', body = `${KEEPOUT()} ${FILL}`, net = '(net 0) (net_name "")') =>
  `(zone ${net} ${layer} (uuid "00000000-0000-4000-8000-${String(++n).padStart(12, "0")}") (hatch edge 0.5) ${body} (polygon (pts ${corners.map(([x, y]) => `(xy ${x} ${y})`).join(" ")})))`
const SQUARE: [number, number][] = [[9, 4], [11, 4], [11, 6], [9, 6]]
const part = (zones: string[], at = "10 5", layer = "F.Cu", ref = "U1", pads = [pad({ at: "-3 0" })]) => footprint({ ref, at, layer, pads, extra: zones.join(" ") })

const imported = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ nets, body, ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}\n${r.report.entries.filter((e) => e.severity === "refused").map((e) => e.why).join("\n")}`)
  return r
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
/** The corners of a world zone's outline, rounded to a micron and sorted. */
const corners = (z: Zone): string[] =>
  zoneRings(z)[0].map((p) => `${(Math.round(p.x * 1e3) / 1e3 + 0).toFixed(3)},${(Math.round(p.y * 1e3) / 1e3 + 0).toFixed(3)}`).sort()
/** The file's corners as the project has them (y up), sorted. */
const expected = (pts: [number, number][]): string[] => pts.map(([x, y]) => `${(x + 0).toFixed(3)},${(-y + 0).toFixed(3)}`).sort()
const ofRef = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!
const move = (p: Project, c: ComponentInstance, pcb: Partial<ComponentInstance["pcb"]>) => updateComponent(p, c.id, { pcb: { ...c.pcb, ...pcb } })

describe("X30 is built, and the gate says so", () => {
  it("BUILT_EXTENSIONS holds X30, the need is still named, and a board with a zone in a part is imported", () => {
    expect(BUILT_EXTENSIONS.has("X30")).toBe(true)
    const text = board({ nets, body: [part([zoneIn(SQUARE)])] })
    expect(readKicadBoard(text).board.footprints[0].zones).toHaveLength(1)
    expect(importKicadBoard(text).status).toBe("imported")
  })

  it("a placement area inside a part keeps no placement, and the report says so", () => {
    const on = `(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (placement (enabled yes) (sheetname "/A/")) ${FILL}`
    const r = imported([part([zoneIn(SQUARE, '(layer "F.Cu")', on)])])
    const z = r.project.footprints![0].zones![0]
    expect(z.keepout).toBeDefined()
    expect(z.placement).toBeUndefined()
    expect(r.project.zones.some((q) => q.placement)).toBe(false)
    const entry = r.report.entries.find((e) => e.code === "placement-in-parts")
    expect(entry?.severity).toBe("not-brought")
    expect(entry?.count).toBe(1)
    // a switched off one that names no sheet (what KiCad 9 writes on every keepout) is nothing to report
    const plain = imported([part([zoneIn(SQUARE)])])
    expect(plain.report.entries.some((e) => e.code === "placement-in-parts")).toBe(false)
  })

  it("the zone is the land's, in the land's frame, with none of the board's identity", () => {
    const r = imported([part([zoneIn(SQUARE)])])
    const land = r.project.footprints![0]
    expect(land.zones).toHaveLength(1)
    const z = land.zones![0]
    expect(z).toMatchObject({ id: "z0", net: "", layer: "top", keepout: { tracks: true, vias: true, pour: true } })
    expect(z.uuid).toBeUndefined()
    expect(z.unordered).toBeUndefined()
    // the part is at (10, -5) in the project; the zone is round it, y up
    expect(zoneRings(z)[0].map((p) => [p.x, p.y]).sort()).toEqual([[-1, -1], [-1, 1], [1, -1], [1, 1]].sort())
    expect(r.project.zones).toHaveLength(0)
    const e = r.report.entries.find((x) => x.code === "zones-in-parts")
    expect(e?.count).toBe(1)
    expect(e?.object).toMatch(/1 keepout inside 1 part/)
  })

  it("two parts with the same footprint and zone share a land, and the zone is the same for both", () => {
    const a = part([zoneIn(SQUARE)])
    const b = part([zoneIn([[19, 4], [21, 4], [21, 6], [19, 6]])], "20 5", "F.Cu", "U2")
    const r = imported([a, b])
    expect(r.project.footprints).toHaveLength(1)
    expect(worldPartZones(r.project)).toHaveLength(2)
  })
})

describe("the zone is where the file has it, for every way the part is placed", () => {
  const cases: [string, string][] = [
    ["top", "10 5"],
    ["top turned 90", "10 5 90"],
    ["top turned 180", "10 5 180"],
    ["top turned 270", "10 5 270"],
    ["top turned 33", "10 5 33"],
  ]
  for (const [name, at] of cases) {
    it(`a part on the ${name}`, () => {
      const r = imported([part([zoneIn(SQUARE)], at)])
      const [w] = worldPartZones(r.project)
      expect(corners(w)).toEqual(expected(SQUARE))
      expect(w.part).toBe(r.project.components[0].id)
      expect(zoneLayers(w)).toEqual(["top"])
    })
  }
  for (const [name, at] of [["bottom", "10 5"], ["bottom turned 90", "10 5 90"], ["bottom turned 215", "10 5 215"]] as const) {
    it(`a part on the ${name}: the file's B.Cu is the part's own side, and the world has it on the bottom`, () => {
      const r = imported([part([zoneIn(SQUARE, '(layer "B.Cu")')], at, "B.Cu")])
      const [w] = worldPartZones(r.project)
      expect(corners(w)).toEqual(expected(SQUARE))
      expect(zoneLayers(w)).toEqual(["bottom"])
      expect(r.project.footprints![0].zones![0].layer).toBe("top")
    })
  }

  it("a zone on both copper layers, and on the mask, in a part on the bottom", () => {
    const r = imported([part([zoneIn(SQUARE, '(layers "F&B.Cu" "F.Mask")', `${KEEPOUT()} ${FILL}`)], "10 5", "B.Cu")])
    const land = r.project.footprints![0].zones![0]
    // F.Mask of the file is the far side of a part on the bottom: the part's own side calls it its back
    expect(land).toMatchObject({ layers: ["top", "bottom"], other: ["B.Mask"] })
    const [w] = worldPartZones(r.project)
    expect(w).toMatchObject({ layers: ["top", "bottom"], other: ["F.Mask"] })
  })
})

describe("the zone moves, turns and flips with its part", () => {
  const base = () => imported([part([zoneIn(SQUARE)])]).project

  it("a move carries it, to the micron", () => {
    const p = base()
    const c = ofRef(p, "U1")
    const q = move(p, c, { x: c.pcb.x + 7, y: c.pcb.y - 3 })
    expect(corners(worldPartZones(q)[0])).toEqual(expected(SQUARE.map(([x, y]) => [x + 7, y + 3] as [number, number])))
  })

  it("a quarter turn turns it about the part", () => {
    const p = base()
    const c = ofRef(p, "U1")
    const q = move(p, c, { rot: 90 })
    const [w] = worldPartZones(q)
    const about = (pt: [number, number]): [number, number] => {
      // the part is at (10, 5) in the file's frame; a quarter turn counter-clockwise on the board (y up) is a quarter turn clockwise in the file's
      const dx = pt[0] - 10
      const dy = pt[1] - 5
      return [10 + dy, 5 - dx]
    }
    expect(corners(w)).toEqual(expected(SQUARE.map(about)))
  })

  it("a flip puts it on the other side: its layer, and its place mirrored about the part", () => {
    const p = base()
    const c = ofRef(p, "U1")
    const q = move(p, c, { side: "bottom" })
    const [w] = worldPartZones(q)
    expect(zoneLayers(w)).toEqual(["bottom"])
    // mirrored about the part's own vertical axis: x of the part's frame changes sign
    const mirrored = SQUARE.map(([x, y]) => [20 - x, y] as [number, number])
    expect(corners(w)).toEqual(expected(mirrored))
    // and back
    expect(corners(worldPartZones(move(q, ofRef(q, "U1"), { side: "top" }))[0])).toEqual(expected(SQUARE))
  })

  it("a part that is not placed has none on the board, and one deleted takes its zones", () => {
    const p = base()
    const c = ofRef(p, "U1")
    expect(worldPartZones(move(p, c, { placed: false }))).toHaveLength(0)
    expect(worldPartZones({ ...p, components: [] })).toHaveLength(0)
  })

  it("a board with no zone in a part is the very same project and the very same (empty) list", () => {
    const plain = twoResistors()
    expect(hasPartZones(plain)).toBe(false)
    expect(withPartZones(plain)).toBe(plain)
    expect(worldPartZones(plain)).toBe(worldPartZones(twoResistors()))
    const p = base()
    expect(withPartZones(p)).toBe(withPartZones(p))
    expect(withPartZones(withPartZones(p))).toBe(withPartZones(p))
    expect(withPartZones(p).zones).toHaveLength(1)
    expect(p.zones).toHaveLength(0)
    // while nothing changes, the zones are the same objects
    expect(worldPartZones(p)).toBe(worldPartZones(p))
  })
})

describe("Checks and the router keep to a keepout inside a part", () => {
  const withTrack = (track: string, extraBody: string[] = [], zones = [zoneIn(SQUARE)]) =>
    imported([part(zones, "10 5", "F.Cu", "U1", [pad({ at: "-3 0", net: '(net 1 "A")' }), pad({ number: "2", at: "-3 2", net: '(net 2 "B")' })]), track, ...extraBody])

  it("a track inside it is an error, and not when the part is moved away or the keepout lets tracks through", () => {
    const r = withTrack('(segment (start 8.5 5) (end 11.5 5) (width 0.2) (layer "F.Cu") (net 1))')
    const kinds = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "keepout").map((v) => v.message)
    expect(kinds(r.project)).toEqual(["A trace is inside a keepout that keeps tracks out"])
    // moved off the track
    expect(kinds(move(r.project, ofRef(r.project, "U1"), { y: ofRef(r.project, "U1").pcb.y - 6 }))).toEqual([])
    // the same track on the other layer is not inside a keepout that is on the top only
    const other = withTrack('(segment (start 8.5 5) (end 11.5 5) (width 0.2) (layer "B.Cu") (net 1))')
    expect(kinds(other.project)).toEqual([])
    // a part on the bottom has its keepout on the bottom
    const flipped = imported([part([zoneIn(SQUARE, '(layer "B.Cu")')], "10 5", "B.Cu", "U1", [pad({ at: "-3 0", net: '(net 1 "A")' })]), '(segment (start 8.5 5) (end 11.5 5) (width 0.2) (layer "B.Cu") (net 1))'])
    expect(kinds(flipped.project)).toHaveLength(1)
  })

  it("a part is not kept out of its own keepout that keeps parts out, and another one is", () => {
    const keep = `(keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints not_allowed)) (placement (enabled no) (sheetname "")) ${FILL}`
    const r = imported([part([zoneIn(SQUARE, '(layer "F.Cu")', keep)], "10 5", "F.Cu", "U1", [pad({ at: "0 0", size: "0.5 0.5" })]), footprint({ ref: "U2", at: "10.5 5.2", pads: [pad({ at: "0 0", size: "0.5 0.5" })] })])
    const msgs = analyzePcb(r.project, computeConnectivity(r.project)).violations.filter((v) => v.kind === "keepout").map((v) => v.message)
    expect(msgs.some((m) => /U2 is inside/.test(m))).toBe(true)
    expect(msgs.some((m) => /U1 is inside/.test(m))).toBe(false)
  })

  it("the router keeps its tracks out of it", () => {
    const text = board({
      nets,
      body: [
        footprint({ ref: "J1", at: "3 5", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }),
        footprint({ ref: "J2", at: "17 5", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }),
        // a wall of keepout across the middle of the board on both layers, inside a part that has no pad there
        part([zoneIn([[8, 3], [12, 3], [12, 7], [8, 7]], '(layers "F.Cu" "B.Cu")')], "10 9", "F.Cu", "U9", [pad({ at: "0 0" })]),
      ],
    })
    const r = importKicadBoard(text)
    if (r.status !== "imported") throw new Error(r.message)
    const res = autoroute(r.project, { timeLimitMs: 20000 })
    const [w] = worldPartZones(res.project)
    const ring = zoneRings(w)[0]
    const inside = (p: Vec2) => p.x > Math.min(...ring.map((q) => q.x)) + 0.05 && p.x < Math.max(...ring.map((q) => q.x)) - 0.05 && p.y > Math.min(...ring.map((q) => q.y)) + 0.05 && p.y < Math.max(...ring.map((q) => q.y)) - 0.05
    expect(res.project.traces.length).toBeGreaterThan(0)
    for (const t of res.project.traces) for (const pt of t.points) expect(inside(pt)).toBe(false)
    expect(res.project.zones).toHaveLength(0)
  })
})

describe("pours", () => {
  const pour = `(connect_pads (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))`
  const board1 = '(zone (net 1) (net_name "A") (layer "F.Cu") (uuid "00000000-0000-4000-8000-0000000000ff") (hatch edge 0.5) ' + pour + " (polygon (pts (xy 1 1) (xy 19 1) (xy 19 9) (xy 1 9))))"
  const fillArea = (p: Project) => analyzePcb(p, computeConnectivity(p)).zoneFills.reduce((s, f) => s + f.polygons.reduce((a, poly) => a + poly.reduce((b, ring, i) => b + (i === 0 ? 1 : -1) * Math.abs(ring.reduce((t, q, k) => t + (ring[(k + 1) % ring.length].x - q.x) * (ring[(k + 1) % ring.length].y + q.y), 0) / 2), 0), 0), 0)

  it("a keepout in a part that keeps pours out takes a hole out of a pour on its layer, and moves with the part", () => {
    const withPart = (at: string) => imported([footprint({ ref: "J1", at: "2 2", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }), part([zoneIn(SQUARE.map(([x, y]) => [x + (Number(at.split(" ")[0]) - 10), y] as [number, number]))], at), board1]).project
    const a = fillArea(withPart("10 5"))
    const none = imported([footprint({ ref: "J1", at: "2 2", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }), part([], "10 5"), board1]).project
    expect(fillArea(none) - a).toBeGreaterThan(3.9)
    expect(fillArea(none) - a).toBeLessThan(4.2)
    // moved to a place where the pour is not (off the pour to the right), the hole closes
    const p = withPart("10 5")
    const away = move(p, ofRef(p, "U1"), { x: 40 })
    expect(Math.abs(fillArea(away) - fillArea(move(none, ofRef(none, "U1"), { x: 40 })))).toBeLessThan(0.05)
  })

  it("a pour inside a part is filled, on no net, and drawn where the part stands", () => {
    const r = imported([part([zoneIn([[8, 3], [12, 3], [12, 7], [8, 7]], '(layer "F.Cu")', pour)], "10 5")])
    expect(r.project.footprints![0].zones![0]).toMatchObject({ net: "", clearance: 0.3, minWidth: 0.25 })
    const fills = analyzePcb(r.project, computeConnectivity(r.project)).zoneFills
    expect(fills).toHaveLength(1)
    expect(fills[0].zoneId).toBe(`${r.project.components[0].id}~z0`)
    expect(fills[0].polygons.length).toBeGreaterThan(0)
  })

  it("a pour inside a part that is on a net is refused as inexact, in words", () => {
    const r = importKicadBoard(board({ nets, body: [part([zoneIn(SQUARE, '(layer "F.Cu")', pour, '(net 1) (net_name "A")')], "10 5", "F.Cu", "U1", [pad({ at: "0 0", net: '(net 1 "A")' })])] }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") {
      expect(r.reason).toBe("inexact")
      expect(r.message).toMatch(/a pour inside a part that is on a net/)
    }
  })
})

describe("the KiCad file says it back", () => {
  const roundTrip = async (p: Project) => {
    const text = await pcbOf(p)
    expect(unknownNodes(text)).toEqual([])
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(`the written board is refused: ${again.message}`)
    return { text, differences: diffProjects(p, again.project), again: again.project }
  }

  it("writes a zone inside its footprint, in the board's frame, and imports as the same project, for a part on each side and turned", async () => {
    const r = imported([
      part([zoneIn(SQUARE)], "10 5", "F.Cu", "U1"),
      part([zoneIn([[19, 4], [21, 4], [21, 6], [19, 6]], '(layer "B.Cu")')], "20 5 90", "B.Cu", "U2"),
      part([zoneIn([[2, 7], [4, 7], [4, 9], [2, 9]], '(layers "F&B.Cu" "F.SilkS")', `${KEEPOUT()} ${FILL}`)], "3 8 215", "F.Cu", "U3"),
    ])
    const { text, differences } = await roundTrip(r.project)
    expect(differences).toEqual([])
    // each zone is inside its footprint in the file, none among the board's
    const read = readKicadBoard(text).board
    expect(read.zones).toHaveLength(0)
    expect(read.footprints.map((f) => f.zones.length)).toEqual([1, 1, 1])
    // and where the file first had it
    expect(text).toContain("(xy 9 4)")
    expect(text).toContain("(xy 11 6)")
  })

  it("a pour inside a part is written with its fill and reads back", async () => {
    const pour = `(connect_pads (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))`
    const r = imported([part([zoneIn([[8, 3], [12, 3], [12, 7], [8, 7]], '(layer "F.Cu")', pour)])])
    const { text, differences } = await roundTrip(r.project)
    expect(differences).toEqual([])
    expect(text).toMatch(/\(filled_polygon/)
  })
})

describe("the project file", () => {
  it("stores the zones on the land, compactly and exactly, and reads them back the same", () => {
    const r = imported([part([zoneIn(SQUARE), zoneIn([[8, 7], [12, 7], [12, 8]], '(layer "F.Cu")', `${KEEPOUT()} ${FILL}`)])])
    const raw = JSON.parse(serializeProject(r.project)).project
    expect(raw.footprints[0].zones[0].ol[0][0]).toBe("p")
    expect(raw.footprints[0].zones[0].outline).toBeUndefined()
    const back = parseProjectFile(serializeProject(r.project), { id: "p", createdAt: 1, updatedAt: 1 })
    expect(back.footprints![0].zones).toEqual(r.project.footprints![0].zones)
    expect(back.zones).toEqual([])
    expect(serializeProject(back)).toBe(serializeProject(parseProjectFile(serializeProject(back), { id: "p", createdAt: 1, updatedAt: 1 })))
  })

  it("repairs a land whose zones do not read: a zone with no polygon is dropped, ids are made from the place", () => {
    const r = imported([part([zoneIn(SQUARE)])])
    const raw = JSON.parse(serializeProject(r.project))
    raw.project.footprints[0].zones = [{ id: "x", net: "", layer: "top" }, { ...raw.project.footprints[0].zones[0], id: "weird" }]
    const back = parseProjectFile(raw, { id: "p", createdAt: 1, updatedAt: 1 })
    expect(back.footprints![0].zones!.map((z) => z.id)).toEqual(["z0"])
  })

  it("a project with no zone in a part stores no `zones` on any land", () => {
    const r = imported([footprint({ pads: [pad({ at: "0 0" })] })])
    expect(JSON.stringify(JSON.parse(serializeProject(r.project)).project.footprints)).not.toContain("zones")
  })
})

describe("editing", () => {
  it("taking away a copper layer takes it from the zones of a part, and a part on the bottom keeps its inner layers where they were", () => {
    const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
    const r = imported([part([zoneIn(SQUARE, '(layers "F.Cu" "In1.Cu")', `${KEEPOUT()} ${FILL}`)])], { layers: L4 })
    expect(r.project.footprints![0].zones![0].layers).toEqual(["top", "in1"])
    const two = setCopperLayerCount(r.project, 2).project
    expect(two.footprints![0].zones![0]).toMatchObject({ layer: "top" })
    expect(two.footprints![0].zones![0].layers).toBeUndefined()
    const only = imported([part([zoneIn(SQUARE, '(layer "In2.Cu")')], "10 5", "F.Cu", "U1")], { layers: L4 })
    expect(setCopperLayerCount(only.project, 2).project.footprints![0].zones).toBeUndefined()
  })

  it("Circuit JSON has a keepout where the part stands, and Sakura's get_design lists it with its part", () => {
    const r = imported([part([zoneIn(SQUARE)])])
    const cj = projectToCircuitJson(r.project).elements.filter((e) => e.type === "pcb_keepout")
    expect(cj).toHaveLength(1)
    const text = JSON.stringify(runTool(r.project, "get_design", {}))
    expect(text).toContain("U1")
    expect(text).toMatch(/keepout/)
  })
})
}

{
// X31: a pad that joins a pour on some copper layers and not others (KiCad's `zone_layer_connections` of a pad). With the pad's unused layers removed, it
// keeps its copper on the layers listed and on any other only where a track, a via or a pad touches it. The importer reads it, the project holds it (in the
// part's own frame), the checks and the plots drop the copper it does not keep, the project file stores it, and the writer says it back.

const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
const ORIGIN = { id: "p1", createdAt: 1, updatedAt: 1 }
const NETS = ['(net 0 "")', '(net 1 "A")']
const REMOVE = "(remove_unused_layers yes) (keep_end_layers no)"
const thru = (extra: string) => pad({ number: "1", type: "thru_hole", shape: "circle", at: "0 0", size: "1.6 1.6", layers: '"*.Cu" "*.Mask"', extra: `(drill 0.8) ${extra}` })
const fp = (extra: string, layer = "F.Cu") => footprint({ ref: "J1", layer, at: "10 5", pads: [thru(extra)] })

const imported = (text: string): Project => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.filter((e) => e.severity === "refused").map((e) => e.why).join("\n")}`)
  return r.project
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
const kept = (p: Project) => analyzePcb(p, computeConnectivity(p)).items.find((i) => i.kind === "pad")!.layers

describe("X31: the layers a pour joins a pad on", () => {
  it("is built, and a board with it is imported", () => {
    expect(BUILT_EXTENSIONS.has("X31")).toBe(true)
    expect(importKicadBoard(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu")`)] })).status).toBe("imported")
  })

  it("the pad keeps its copper on the layers listed, and drops the others where nothing touches it", () => {
    const without = imported(board({ layers: L4, nets: NETS, body: [fp(REMOVE)] }))
    expect(kept(without)).toEqual([])
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu" "B.Cu")`)] }))
    expect(p.footprints![0].pads[0].zoneLayers).toEqual(["in1", "bottom"])
    expect(kept(p)).toEqual(["in1", "bottom"])
  })

  it("the node with no layer is kept as the empty list, and a pad with none has none", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections)`)] }))
    expect(p.footprints![0].pads[0].zoneLayers).toEqual([])
    expect(await pcbOf(p)).toContain("(zone_layer_connections)")
    const plain = imported(board({ layers: L4, nets: NETS, body: [fp(REMOVE)] }))
    expect(plain.footprints![0].pads[0].zoneLayers).toBeUndefined()
    expect(await pcbOf(plain)).not.toContain("zone_layer_connections")
  })

  it("a layer a track touches the pad on is kept as well", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (net 1 "A") (zone_layer_connections "In1.Cu")`), '(segment (start 10 5) (end 14 5) (width 0.2) (layer "In2.Cu") (net 1))'] }))
    expect(kept(p)).toEqual(["in1", "in2"])
  })

  it("a part on the bottom has the layers turned over in its own frame, and they come back where the file had them", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu" "F.Cu")`, "B.Cu")] }))
    // the file's In1 is the part's In2 and the file's F.Cu is the part's far side
    expect(p.footprints![0].pads[0].zoneLayers).toEqual(["in2", "bottom"])
    expect(pcbPads(p.components[0], 4)[0].zoneLayers!.slice().sort()).toEqual(["in1", "top"])
    expect(kept(p).slice().sort()).toEqual(["in1", "top"])
    const text = await pcbOf(p)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project)).toEqual([])
    expect(unknownNodes(text)).toEqual([])
  })

  it("is written back and imports as the same project", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "F.Cu" "In2.Cu")`)] }))
    const text = await pcbOf(p)
    expect(text).toMatch(/\(zone_layer_connections "F\.Cu" "In2\.Cu"\)/)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project)).toEqual([])
  })

  it("survives a save and a load, the empty list as well", () => {
    for (const layers of ['"In1.Cu"', ""]) {
      const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections ${layers})`)] }))
      const back = parseProjectFile(serializeProject(p), ORIGIN)
      expect(back.footprints![0].pads[0].zoneLayers).toEqual(p.footprints![0].pads[0].zoneLayers)
    }
  })

  it("the Gerber of a layer has the pad's copper where it is kept and not where it is dropped", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu")`)] }))
    const a = analyzePcb(p, computeConnectivity(p))
    const flashes = (layer: "in1" | "in2") => (gerberCopper(p, layer, a.zoneFills, a.items).match(/D03\*/g) ?? []).length
    expect(flashes("in1")).toBe(1)
    expect(flashes("in2")).toBe(0)
  })

  it("taking away the layer a pad lists drops it from the list", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu" "In2.Cu")`)] }))
    const two = setCopperLayerCount(p, 2).project
    expect(two.footprints![0].pads[0].zoneLayers).toEqual([])
  })

  it("a stored pad whose list is not a list of layers is refused with its land, as any malformed pad", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu")`)] }))
    const raw = JSON.parse(serializeProject(p))
    raw.project.footprints[0].pads[0].zoneLayers = "in1"
    expect(parseProjectFile(raw, ORIGIN).footprints ?? []).toHaveLength(0)
  })
})
}
