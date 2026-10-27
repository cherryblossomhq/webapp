import { describe, expect, it } from "vitest"
import type { Paths64 } from "@countertype/clipper2-ts"
import { gerberMask } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { computeConnectivity } from "../src/model/connectivity"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { DEFAULT_MIN_HOLE, hatchPaths } from "../src/model/zoneHatch"
import { areaMm2, intersect, pt, U } from "../src/model/zoneGeom"
import type { Project, ZoneHatch } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X24: a hatched pour (a grid of lines cut into the copper by KiCad's rules), tracks whose copper is open through the solder mask, and the line ends and colours of KiCad 10's drawings, which are
// kept and written back where KiCad 9 reads them. The corpus run against the file's own filled polygons is `kicad-x24-corpus.test.ts`.

const box = (x0: number, y0: number, x1: number, y1: number): Paths64 => [[pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)]]
const inside = (paths: Paths64, x0: number, y0: number, x1: number, y1: number) => areaMm2(intersect(paths, box(x0, y0, x1, y1)))
const FILL_30 = box(0, 0, 30, 30)
const eps = 0.001
const hatch = (h: ZoneHatch, at?: { x: number; y: number }, fill = FILL_30) => hatchPaths(fill, h, 0.25, at)

describe("the hatch grid (zoneHatch.ts)", () => {
  const plain: ZoneHatch = { thickness: 1, gap: 2 }

  it("cuts square holes of the gap's size, a line and a gap apart, from the board's origin", () => {
    const out = hatch(plain)
    // The inside of the pour, away from its edge: 6 by 6 cells of 3 mm, each a hole of the gap and the minimum width's easing (2.002) and copper round it.
    const cell = 9 - (2 + 2 * eps) ** 2
    expect(inside(out, 6, 6, 24, 24)).toBeCloseTo(36 * cell, 2)
    // A hole is where the lattice puts it: from 0.124 (half the minimum width less a thousandth) in each cell, 2.002 wide.
    expect(inside(out, 9.9, 9.9, 10.1, 10.1)).toBe(0)
    expect(inside(out, 9.0, 9.9, 9.1, 10.1)).toBeCloseTo(0.02, 3)
    expect(inside(out, 8.3, 9.9, 8.7, 10.1)).toBeCloseTo(0.08, 3)
  })

  it("keeps a band as wide as the lines along the pour's edge, whole", () => {
    const out = hatch(plain)
    expect(inside(out, 0, 0, 0.99, 30)).toBeCloseTo(0.99 * 30, 3)
    expect(inside(out, 0, 0, 30, 0.99)).toBeCloseTo(0.99 * 30, 3)
    // and no further in than that is a hole's own business
    expect(inside(out, 1.0, 0, 1.3, 30)).toBeLessThan(0.3 * 30)
  })

  it("a band of the minimum width only, when the border says so", () => {
    const thin = hatch({ ...plain, thinBorder: true })
    const thick = hatch(plain)
    expect(inside(thin, 0.3, 0, 0.9, 30)).toBeLessThan(inside(thick, 0.3, 0, 0.9, 30))
  })

  it("drops a hole the edge cuts to less than the smallest part asked for, and keeps it whole", () => {
    const keepAll = hatch({ ...plain, minHole: 0 })
    const dropSmall = hatch(plain)
    const dropAllCut = hatch({ ...plain, minHole: 1 })
    expect(DEFAULT_MIN_HOLE).toBe(0.3)
    expect(areaMm2(dropSmall)).toBeGreaterThanOrEqual(areaMm2(keepAll))
    expect(areaMm2(dropAllCut)).toBeGreaterThan(areaMm2(keepAll))
  })

  it("turns the grid by the angle (counter-clockwise on the board, y up)", () => {
    const out = hatch({ ...plain, angle: 45 })
    // a hole's centre, in the grid's frame (u along the angle, v down the board's other diagonal), and the middle of a line between two holes
    const at = (u: number, v: number) => ({ x: (u + v) * Math.SQRT1_2, y: (u - v) * Math.SQRT1_2 })
    const hole = at(19.125, 13.125)
    const line = at(20.625, 13.125)
    expect(inside(out, hole.x - 0.05, hole.y - 0.05, hole.x + 0.05, hole.y + 0.05)).toBe(0)
    expect(inside(out, line.x - 0.05, line.y - 0.05, line.x + 0.05, line.y + 0.05)).toBeCloseTo(0.01, 4)
    // the same share of copper in the middle of a pour, whichever way the grid is turned
    expect(inside(out, 8, 8, 22, 22) / 196).toBeCloseTo((9 - (2 + 2 * eps) ** 2) / 9, 1)
  })

  it("starts the grid at the pour's own corner for a file of KiCad 9 or earlier, and at a hatch position moves it", () => {
    const corner = hatch({ ...plain, fromFill: true }, undefined, box(2, 3, 32, 33))
    // the first whole hole is a cell in from the corner: its left edge is at 2.248 (the corner, and the minimum width less two thousandths) plus a cell
    expect(inside(corner, 6.2, 8, 6.3, 8.1)).toBe(0)
    expect(inside(corner, 5.1, 8, 5.2, 8.1)).toBeCloseTo(0.01, 4)
    const moved = hatch(plain, { x: 1, y: 0 })
    expect(inside(moved, 9.5, 9.9, 9.6, 10.1)).toBeCloseTo(0.02, 3)
    expect(inside(hatch(plain), 9.5, 9.9, 9.6, 10.1)).toBe(0)
    // a hatch position is not used by a grid that starts at the corner
    expect(areaMm2(hatch({ ...plain, fromFill: true }, { x: 1, y: 0 }, box(2, 3, 32, 33)))).toBeCloseTo(areaMm2(corner), 6)
  })

  it("rounds or cuts the holes' corners by the smoothing", () => {
    const square = areaMm2(hatch(plain))
    const rounded = areaMm2(hatch({ ...plain, smooth: { level: 2, value: 1 } }))
    const cut = areaMm2(hatch({ ...plain, smooth: { level: 1, value: 1 } }))
    expect(rounded).toBeGreaterThan(square)
    expect(cut).toBeGreaterThan(square)
    // a rounding of a whole half gap makes the hole nearly a circle: the corners' share of the square, 1 - pi/4, of the hole's area is given back
    expect(rounded - square).toBeGreaterThan(30 * 0.5 * (1 - Math.PI / 4) * 0.7)
    // a cut of the same distance takes more of the corner than a rounding of that radius
    expect(cut).toBeGreaterThan(rounded)
    // a smoothing too small to see is square holes
    expect(areaMm2(hatch({ ...plain, smooth: { level: 2, value: 0.01 } }))).toBeCloseTo(square, 6)
  })

  it("makes the lines wider than the minimum width, as KiCad does", () => {
    const out = hatchPaths(FILL_30, { thickness: 0.1, gap: 1 }, 0.25, undefined)
    const pitch = 0.251 + 1
    const cell = pitch ** 2 - (1 + 2 * eps) ** 2
    expect(inside(out, 6, 6, 6 + 10 * pitch, 6 + 10 * pitch)).toBeCloseTo(100 * cell, 0)
  })

  it("leaves a grid too fine for the pour solid", () => {
    expect(areaMm2(hatchPaths(box(0, 0, 1000, 1000), { thickness: 0.011, gap: 0.01 }, 0.01, undefined))).toBeCloseTo(1_000_000, 6)
  })

  it("is exactly the pour when there is none", () => {
    expect(hatchPaths([], plain, 0.25, undefined)).toEqual([])
    expect(U).toBe(10_000)
  })
})

const nets = ['(net 0 "")', '(net 1 "GND")']
const part = footprint({ pads: [pad({ at: "5 5", net: '(net 1 "GND")' })] })
const hatchFill = "(fill yes (mode hatch) (thermal_gap 0.5) (thermal_bridge_width 0.5) (hatch_thickness 1) (hatch_gap 2) (hatch_orientation 45) (hatch_border_algorithm hatch_thickness) (hatch_min_hole_area 0.3))"
let ids = 0
const zone = (fill = hatchFill, extra = "", layer = '(layer "F.Cu")', polygon = "(polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8)))") =>
  `(zone (net 1) (net_name "GND") ${layer} (uuid "00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (filled_areas_thickness no) ${fill} ${extra} ${polygon})`
const imp = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ nets, body: [part, ...body], ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
const fillsOf = (p: Project) => analyzePcb(p, computeConnectivity(p)).zoneFills

describe("X24 is built, and the gate says so", () => {
  it("BUILT_EXTENSIONS holds X24", () => {
    expect(BUILT_EXTENSIONS.has("X24")).toBe(true)
  })
})

describe("a hatched pour", () => {
  it("is read with its grid, KiCad's defaults where the file says none, and the lattice of its release", () => {
    const r = imp([zone()])
    expect(r.project.zones[0].hatch).toEqual({ thickness: 1, gap: 2, angle: 45, fromFill: true })
    const modern = imp([zone()], { version: 20260206 })
    expect(modern.project.zones[0].hatch).toEqual({ thickness: 1, gap: 2, angle: 45 })
    const all = imp([zone("(fill yes (mode hatch) (hatch_thickness 0.5) (hatch_gap 0.8) (hatch_orientation 0) (hatch_smoothing_level 3) (hatch_smoothing_value 0.5) (hatch_border_algorithm min_thickness) (hatch_min_hole_area 0.1))")], { version: 20260206 })
    expect(all.project.zones[0].hatch).toEqual({ thickness: 0.5, gap: 0.8, minHole: 0.1, thinBorder: true, smooth: { level: 3, value: 0.5 } })
    expect(all.report.entries.find((e) => e.code === "zones-hatched")?.count).toBe(1)
  })

  it("is the file's pour cut by the grid: less copper than the solid pour, in the pieces the grid leaves", () => {
    const hatched = imp([zone()])
    const solid = imp([zone("(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))")])
    const [h] = fillsOf(hatched.project)
    const [s] = fillsOf(solid.project)
    const copper = (f: typeof h) => f.polygons.reduce((n, poly) => n + areaMm2(poly.map((ring) => ring.map((p) => pt(p.x, p.y)))), 0)
    expect(copper(h)).toBeLessThan(copper(s) * 0.85)
    expect(copper(h)).toBeGreaterThan(copper(s) * 0.4)
    // a hole in the middle of the pour is a hole of the polygon
    expect(h.polygons.some((poly) => poly.length > 1)).toBe(true)
  })

  it("a position of the pattern is kept on each layer, in the editor's frame, with or without a hatch", () => {
    const r = imp([zone("(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))", '(property (layer "F.Cu") (hatch_position (xy 1 2)))')])
    expect(r.project.zones[0].hatchAt).toEqual({ top: { x: 1, y: -2 } })
    expect(r.project.zones[0].hatch).toBeUndefined()
    // a layer the zone is not on has none
    const off = imp([zone("(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))", '(property (layer "B.Cu") (hatch_position (xy 1 2)))')])
    expect(off.project.zones[0].hatchAt).toBeUndefined()
  })

  it("a hatched pour inside a part is the part's, and is filled", () => {
    const inPart = importKicadBoard(
      board({
        nets,
        body: [
          footprint({ pads: [pad({ at: "0 0" })], extra: `(zone (net 0) (net_name "") (layer "F.Cu") (uuid "00000000-0000-4000-8000-0000000000a1") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (filled_areas_thickness no) ${hatchFill} (polygon (pts (xy 3 3) (xy 13 3) (xy 13 8) (xy 3 8))))` }),
        ],
      }),
    )
    expect(inPart.status).toBe("imported")
    if (inPart.status !== "imported") return
    expect(inPart.project.footprints![0].zones![0].hatch).toMatchObject({ thickness: 1, gap: 2, angle: 45 })
    expect(fillsOf(inPart.project).some((f) => f.polygons.length > 0)).toBe(true)
  })

  it("is refused, in words, when the file says what the editor does not hold", () => {
    const refusal = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
      const r = importKicadBoard(board({ nets, body: [part, ...body], ...extra }))
      expect(r.status).toBe("refused")
      return r.status === "refused" ? r : null
    }
    expect(refusal([zone("(fill yes (mode thieving) (thermal_gap 0.5) (thermal_bridge_width 0.5))")])?.message).toMatch(/copper thieving pattern/)
    expect(refusal([zone("(fill yes (mode hatch) (hatch_gap 2))")])?.message).toMatch(/line width or gap the file does not give/)
    expect(refusal([zone(hatchFill, "", '(layer "F.SilkS")')])?.message).toMatch(/hatched fill on a layer that is not copper/)
    expect(refusal([zone(hatchFill, "(zone_type 1)")])?.message).toMatch(/zone type/)
    expect(refusal([zone(hatchFill, '(property (layer "F.Cu") (color 1))')])?.message).toMatch(/zone property other than a hatch position \("color"\)/)
  })

  it("is written as KiCad 9 writes it, and read back as the same project", async () => {
    const a = imp([zone(hatchFill.replace("(hatch_min_hole_area 0.3)", "(hatch_smoothing_level 2) (hatch_smoothing_value 0.2) (hatch_min_hole_area 0.2)"))])
    const text = await pcbOf(a.project)
    expect(text).toMatch(/\(fill yes \(mode hatch\) \(thermal_gap 0\.5\) \(thermal_bridge_width 0\.5\) \(hatch_thickness 1\) \(hatch_gap 2\) \(hatch_orientation 45\) \(hatch_smoothing_level 2\) \(hatch_smoothing_value 0\.2\) \(hatch_border_algorithm hatch_thickness\) \(hatch_min_hole_area 0\.2\)\)/)
    expect(unknownNodes(text)).toEqual([])
    const b = importKicadBoard(text)
    expect(b.status).toBe("imported")
    if (b.status === "imported") expect(diffProjects(a.project, b.project)).toEqual([])
  })

  it("the hatch position is KiCad 10's: it stays in the project, and the export says it is not written", async () => {
    const a = imp([zone(hatchFill, '(property (layer "F.Cu") (hatch_position (xy 1 2)))')], { version: 20260206 })
    const written = await kicadFiles(a.project)
    const text = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(text).not.toMatch(/hatch_position|\(property \(layer/)
    expect(unknownNodes(text)).toEqual([])
    expect(written.notes.join(" ")).toMatch(/no hatch position/)
  })

  it("is kept by a save and a load, on the board and in a part", () => {
    const a = imp([zone(hatchFill, '(property (layer "F.Cu") (hatch_position (xy 1 2)))')])
    const back = parseProjectFile(serializeProject(a.project), { id: "x" })
    expect(back.zones).toEqual(a.project.zones)
    expect(back.zones[0].hatch).toBeDefined()
    expect(back.zones[0].hatchAt).toEqual({ top: { x: 1, y: -2 } })
    // a grid that does not read is a solid pour, a position that does not read is none
    const doc = JSON.parse(serializeProject(a.project))
    doc.project.zones[0].hatch = { thickness: 0, gap: 1 }
    doc.project.zones[0].hatchAt = { top: { x: "1", y: 2 }, nonsense: { x: 1, y: 1 } }
    const damaged = parseProjectFile(JSON.stringify(doc), { id: "x" })
    expect(damaged.zones[0].hatch).toBeUndefined()
    expect(damaged.zones[0].hatchAt).toBeUndefined()
  })
})

describe("a track whose copper is open through the mask", () => {
  const seg = (extra: string, layer = '(layers "F.Cu" "F.Mask")', net = "(net 1)") => `(segment (start 2 5) (end 8 5) (width 0.2) ${layer} ${extra} ${net} (uuid "00000000-0000-4000-8000-0000000000b1"))`
  const arc = `(arc (start 10 5) (mid 12 7) (end 14 5) (width 0.2) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.1) (net 1) (uuid "00000000-0000-4000-8000-0000000000b2"))`

  it("is a trace that says so, with its own margin or the board's", () => {
    const r = imp([seg("(solder_mask_margin 0.3)"), arc, seg("", '(layers "F.Cu" "F.Mask")').replace("(start 2 5) (end 8 5)", "(start 2 7) (end 8 7)").replace("b1", "b3")])
    const traces = r.project.traces
    // the tracks in the order of the file, then the arc tracks
    expect(traces.map((t) => t.bare)).toEqual([{ margin: 0.3 }, {}, { margin: 0.1 }])
    expect(traces[2].arc).toBe(true)
    expect(r.report.entries.find((e) => e.code === "tracks-bare")?.count).toBe(3)
  })

  it("is not joined with a track that is not open, or is open by another margin", () => {
    const r = imp([seg("(solder_mask_margin 0.3)"), `(segment (start 8 5) (end 9 5) (width 0.2) (layer "F.Cu") (net 1) (uuid "00000000-0000-4000-8000-0000000000b4"))`, `(segment (start 9 5) (end 10 5) (width 0.2) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.2) (net 1) (uuid "00000000-0000-4000-8000-0000000000b5"))`])
    expect(r.project.traces).toHaveLength(3)
    const joined = imp([seg("(solder_mask_margin 0.3)"), `(segment (start 8 5) (end 9 5) (width 0.2) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.3) (net 1) (uuid "00000000-0000-4000-8000-0000000000b6"))`])
    expect(joined.project.traces).toHaveLength(1)
    expect(joined.project.traces[0].points).toHaveLength(3)
  })

  it("is refused when its opening is not on its own side, or a margin has no mask to open", () => {
    const wrong = importKicadBoard(board({ nets, body: [part, seg("", '(layers "F.Cu" "B.Mask")')] }))
    expect(wrong.status === "refused" && wrong.message).toMatch(/open through B\.Mask, which is not the mask of its own side/)
    const none = importKicadBoard(board({ nets, body: [part, seg("(solder_mask_margin 0.3)", '(layer "F.Cu")')] }))
    expect(none.status === "refused" && none.message).toMatch(/own solder mask margin and no mask layer/)
  })

  it("opens the mask along it, wider than the track by its margin or the board's, and a track that is not open has no opening", () => {
    const r = imp([seg("(solder_mask_margin 0.3)"), `(segment (start 2 7) (end 8 7) (width 0.2) (layer "F.Cu") (net 1) (uuid "00000000-0000-4000-8000-0000000000b7"))`])
    const mask = gerberMask(r.project, "top")
    // a stroke 0.8 wide (the track and 0.3 on each side) that the other track does not have
    expect(mask).toMatch(/C,0\.8\*/)
    expect(mask).not.toMatch(/C,0\.2\*/)
    expect(gerberMask(r.project, "bottom")).not.toMatch(/C,0\.8\*/)
    // the board's own expansion where the track names none
    const plain = imp([seg("")], { setup: "(setup (pad_to_mask_clearance 0.1))" })
    expect(gerberMask(plain.project, "top")).toMatch(/C,0\.4\*/)
    // with a minimum mask web the openings are merged regions, and the track's is one
    const merged = imp([seg("(solder_mask_margin 0.3)")], { setup: "(setup (pad_to_mask_clearance 0) (solder_mask_min_width 0.1))" })
    expect(gerberMask(merged.project, "top")).toMatch(/G36/)
  })

  it("is written as KiCad 9 writes it, and read back as the same project", async () => {
    const a = imp([seg("(solder_mask_margin 0.3)"), arc, `(segment (start 2 7) (end 8 7) (width 0.2) (layers "F.Cu" "F.Mask") (net 1) (uuid "00000000-0000-4000-8000-0000000000b8"))`])
    const text = await pcbOf(a.project)
    expect(text).toMatch(/\(layers "F\.Cu" "F\.Mask"\)\n\s+\(solder_mask_margin 0\.3\)/)
    expect(text).toMatch(/\(arc[\s\S]*?\(layers "F\.Cu" "F\.Mask"\)\n\s+\(solder_mask_margin 0\.1\)/)
    expect(unknownNodes(text)).toEqual([])
    const b = importKicadBoard(text)
    expect(b.status).toBe("imported")
    if (b.status === "imported") expect(diffProjects(a.project, b.project)).toEqual([])
  })

  it("is kept by a save and a load, and one that does not read is a plain track", () => {
    const a = imp([seg("(solder_mask_margin 0.3)")])
    const back = parseProjectFile(serializeProject(a.project), { id: "x" })
    expect(back.traces).toEqual(a.project.traces)
    const doc = JSON.parse(serializeProject(a.project))
    doc.project.traces[0].bare = { margin: "wide" }
    expect(parseProjectFile(JSON.stringify(doc), { id: "x" }).traces[0].bare).toBeUndefined()
  })
})

describe("the line ends and the colour of a drawing", () => {
  const line = `(gr_line (start 3 3) (end 9 3) (stroke (width 0.2) (type solid) (color 10 20 30 0.5)) (start_shape arrow (length 3) (width 2)) (end_shape circle) (layer "F.SilkS"))`
  const inPart = footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })], extra: `(fp_line (start -2 -2) (end 2 -2) (stroke (width 0.1) (type solid) (color 255 0 0 1)) (end_shape square) (layer "F.SilkS"))` })

  it("come in with the drawing, on the board and in a part, and are kept by a save and a load", () => {
    const r = imp([line, inPart])
    expect(r.project.graphics![0]).toMatchObject({ ends: { start: { style: "arrow", length: 3, width: 2 }, end: { style: "circle" } }, color: [10, 20, 30, 0.5] })
    expect(r.project.footprints!.find((f) => f.shapes?.length)!.shapes![0]).toMatchObject({ ends: { end: { style: "square" } }, color: [255, 0, 0, 1] })
    expect(r.report.entries.find((e) => e.code === "drawing-extras-kept")?.count).toBe(4)
    const back = parseProjectFile(serializeProject(r.project), { id: "x" })
    expect(back.graphics).toEqual(r.project.graphics)
    expect(back.footprints).toEqual(r.project.footprints)
  })

  it("a colour is written back, where KiCad 9 reads it, and the line ends stay in the project with a note", async () => {
    const a = imp([line, inPart])
    const written = await kicadFiles(a.project)
    const text = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(text).toMatch(/\(color 10 20 30 0\.5\)/)
    expect(text).toMatch(/\(color 255 0 0 1\)/)
    expect(text).not.toMatch(/start_shape|end_shape/)
    expect(unknownNodes(text)).toEqual([])
    expect(written.notes.join(" ")).toMatch(/no shapes at the ends of a line/)
    const b = importKicadBoard(text)
    expect(b.status).toBe("imported")
    if (b.status !== "imported") return
    expect(b.project.graphics![0].color).toEqual([10, 20, 30, 0.5])
    expect(b.project.graphics![0].ends).toBeUndefined()
  })

  it("a damaged colour or end is none", () => {
    const a = imp([line])
    const doc = JSON.parse(serializeProject(a.project))
    doc.project.graphics = [{ id: "g1", type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, layer: "F.SilkS", width: 0.1, color: [300, 0, 0, 1], ends: { start: { length: 1 } } }]
    const read = parseProjectFile(JSON.stringify(doc), { id: "x" })
    expect(read.graphics![0].color).toBeUndefined()
    expect(read.graphics![0].ends).toBeUndefined()
  })
})
