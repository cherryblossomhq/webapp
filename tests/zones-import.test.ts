import { describe, expect, it } from "vitest"
import { importKicadBoard, readKicadBoard } from "../src/model/kicad/board"
import { BUILT_EXTENSIONS } from "../src/model/kicad/board"
import { kicadFiles } from "../src/export/kicad"
import { board, footprint, pad } from "./kicad-board-fixtures"
import type { Project } from "../src/model/types"
import { analyze } from "./zones-fixtures"

const square = "(polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8)))"
const part = footprint({ pads: [pad({ at: "5 5", net: '(net 1 "GND")' }), pad({ number: "2", at: "9 5", net: '(net 2 "SIG")' })] })
const nets = ['(net 0 "")', '(net 1 "GND")', '(net 2 "SIG")']

const zone = (extra: string, polygon = square, layer = '(layer "F.Cu")', net = '(net 1) (net_name "GND")') => `(zone ${net} ${layer} (uuid "a1") (hatch edge 0.5) ${extra} ${polygon})`
const modernFill = "(connect_pads (clearance 0.4)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.45) (thermal_bridge_width 0.35))"

const imported = (body: string[], version?: number, extra: object = {}) => {
  const r = importKicadBoard(board({ nets, body: [part, ...body], version, ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r
}

describe("the gate", () => {
  it("builds X3 and X24 (hatched pours), and the extension is named when a zone uses it", () => {
    expect(BUILT_EXTENSIONS.has("X3")).toBe(true)
    expect(BUILT_EXTENSIONS.has("X24")).toBe(true)
  })
})

describe("importing a zone", () => {
  it("brings in a copper zone with every setting of the file, y flipped, and fills it", () => {
    const r = imported([zone(`(priority 3) ${modernFill.replace("(fill yes", "(fill yes (smoothing fillet) (radius 1.5) (island_removal_mode 2) (island_area_min 4)")}`)])
    expect(r.project.zones).toHaveLength(1)
    const z = r.project.zones[0]
    expect(z).toMatchObject({ net: "GND", layer: "top", priority: 3, clearance: 0.4, minWidth: 0.25, connect: "thermal", thermalGap: 0.45, spokeWidth: 0.35, smoothing: { kind: "fillet", radius: 1.5 }, islands: 4, edgeGap: 0.5, holeGap: 0.25 })
    expect(z.outline![0].segs[0]).toMatchObject({ kind: "line", a: { x: 2, y: -2 }, b: { x: 18, y: -2 } })
    expect(r.report.entries.find((e) => e.code === "zones-refilled")?.count).toBe(1)
    const fill = analyze(r.project).zoneFills[0]
    expect(fill.polygons.length).toBeGreaterThan(0)
  })

  it("reads each way a pad joins: yes is solid, no is none, thru_hole_only is through-hole only, nothing is a thermal relief", () => {
    const by = (word: string) => imported([zone(`(connect_pads ${word} (clearance 0.4)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))`)]).project.zones[0].connect
    expect([by("yes"), by("no"), by("thru_hole_only"), by("")]).toEqual(["solid", "none", "tht", "thermal"])
  })

  it("a KiCad 5 zone keeps its clearance and half the edge line's width from the edge, and its own clearance from holes", () => {
    const text = board({
      version: 4,
      nets,
      outline: `(gr_line (start 0 0) (end 20 0) (layer Edge.Cuts) (width 0.2)) (gr_line (start 20 0) (end 20 10) (layer Edge.Cuts) (width 0.2)) (gr_line (start 20 10) (end 0 10) (layer Edge.Cuts) (width 0.2)) (gr_line (start 0 10) (end 0 0) (layer Edge.Cuts) (width 0.2))`,
      body: [footprint({ token: "module", pads: [pad({ at: "5 5", net: '(net 1 "GND")' })] }), `(zone (net 1) (net_name GND) (layer F.Cu) (tstamp 5) (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (arc_segments 16) (thermal_gap 0.5) (thermal_bridge_width 0.5)) ${square})`],
    })
    const r = importKicadBoard(text)
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.zones[0].edgeGap).toBeCloseTo(0.6, 6)
    expect(r.project.zones[0].holeGap).toBeUndefined()
    expect(readKicadBoard(text).board.zones[0].strokedFill).toBe(true)
  })

  it("a zone on both layers, a polygon with a hole and with an arc, and a teardrop, all come in", () => {
    const hole = "(polygon (pts (xy 8 4) (xy 10 4) (xy 10 6) (xy 8 6)))"
    const r = imported([
      zone(modernFill, square, '(layers "F.Cu" "B.Cu")'),
      zone(modernFill, `(polygon (pts (xy 1 1) (xy 6 1) (xy 6 5) (xy 1 5))) ${hole}`),
      zone(modernFill, "(polygon (pts (xy 12 1) (arc (start 16 1) (mid 17 3) (end 16 5)) (xy 12 5)))"),
      zone(`(attr (teardrop (type padvia))) ${modernFill}`),
    ])
    const [both, holed, arced, drop] = r.project.zones
    expect(both).toMatchObject({ layer: "top", layers: ["top", "bottom"] })
    expect(holed.outline).toHaveLength(2)
    expect(arced.outline![0].segs.some((s) => s.kind === "arc")).toBe(true)
    expect(drop.teardrop).toBe("padvia")
  })

  it("a keepout comes in with what it keeps out, and KiCad 9's switched off placement does not make it a placement area", () => {
    const k = `(keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (placement (enabled no) (sheetname ""))`
    const r = imported([zone(`${k} (connect_pads (clearance 0)) (min_thickness 0.25) (filled_areas_thickness no) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))`, square, '(layer "F.Cu")', '(net 0) (net_name "")')])
    expect(r.project.zones[0]).toMatchObject({ net: "", keepout: { tracks: true, pour: true } })
    expect(r.project.zones[0].keepout).not.toHaveProperty("vias")
    expect(r.report.entries.some((e) => e.code === "rule-areas")).toBe(true)
  })

  it("brings in a placement rule area (X20), and a hatched fill with its grid (X24)", () => {
    const placement = imported([zone(`(keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (placement (enabled yes) (sheetname "/")) ${modernFill}`, square, '(layer "F.Cu")', '(net 0) (net_name "")')])
    expect(placement.project.zones[0]).toMatchObject({ keepout: {}, placement: { by: "sheet", name: "/" } })
    const hatch = imported([zone("(connect_pads (clearance 0.4)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (mode hatch) (thermal_gap 0.5) (thermal_bridge_width 0.5) (hatch_thickness 0.5) (hatch_gap 1) (hatch_orientation 0))")])
    expect(hatch.project.zones[0].hatch).toMatchObject({ thickness: 0.5, gap: 1 })
    // a zone on a layer that is not copper is imported (X29, kicad-board-zone-family.test.ts)
    const mask = imported([zone(modernFill, square, '(layer "F.Mask")', '(net 0) (net_name "")')])
    expect(mask.project.zones[0].other).toEqual(["F.Mask"])
    // a zone inside a part is imported too (X30, kicad-board-zone-family.test.ts)
    const inPart = imported([footprint({ pads: [pad({ at: "0 0" })], extra: `(zone (net 0) (net_name "") (layer "F.Cu") (hatch edge 0.5) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (polygon (pts (xy -1 -1) (xy 1 -1) (xy 1 1))))` })])
    expect(inPart.project.footprints!.some((f) => f.zones?.length === 1)).toBe(true)
    // a zone on an inner layer of a board that has one is imported (X1); one on a layer the board lacks is not brought in, and the report says so
    const lacks = imported([zone(modernFill, square, '(layer "In1.Cu")')])
    expect(lacks.project.zones).toHaveLength(0)
    expect(lacks.report.entries.find((e) => e.code === "zones-degenerate")?.count).toBe(1)
  })

  it("zones with no fill in the file are filled, a zone with two corners is not brought in, a zone on a net no pin is on is said so", () => {
    const r = imported([
      zone("(connect_pads (clearance 0.4)) (min_thickness 0.25) (filled_areas_thickness no) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))"),
      zone(modernFill, "(polygon (pts (xy 0 0) (xy 1 1)))"),
      zone(modernFill, "(polygon (pts (xy 12 1) (xy 16 1) (xy 16 5)))", '(layer "B.Cu")', '(net 5) (net_name "NOPINS")'),
    ], undefined, { nets: [...nets, '(net 5 "NOPINS")'] })
    expect(r.project.zones).toHaveLength(2)
    expect(r.report.entries.find((e) => e.code === "zones-unfilled")?.count).toBe(2)
    expect(r.report.entries.find((e) => e.code === "zones-degenerate")?.count).toBe(1)
    expect(r.report.entries.find((e) => e.code === "zones-net-without-pins")?.items).toEqual(["NOPINS"])
  })

  it("a board with a zone imported, saved, exported to KiCad and read again keeps its zones", async () => {
    const r = imported([zone(`(priority 2) ${modernFill}`), zone("(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (connect_pads (clearance 0)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))", "(polygon (pts (xy 10 3) (xy 12 3) (xy 12 6) (xy 10 6)))", '(layer "F.Cu")', '(net 0) (net_name "")')])
    const p: Project = r.project
    const { files } = await kicadFiles(p)
    const text = Object.entries(files).find(([name]) => name.endsWith(".kicad_pcb"))![1]
    const back = readKicadBoard(text).board.zones
    expect(back).toHaveLength(2)
    expect(back[0]).toMatchObject({ net: "GND", priority: 2, clearance: 0.4, minThickness: 0.25, thermalGap: 0.45, thermalBridge: 0.35 })
    expect(back[1]).toMatchObject({ kind: "keepout", keepout: { tracks: true, vias: true, copperpour: true } })
    // Its outline is the file's, to the last digit (the y flipped twice).
    expect(back[0].rings[0].map((s) => (s.kind === "xy" ? [s.at.x, s.at.y] : []))).toEqual([[2, 2], [18, 2], [18, 8], [2, 8]])
  })
})
