import { describe, expect, it } from "vitest"
import { Clipper, EndType, FillRule, JoinType, type Paths64 } from "@countertype/clipper2-ts"
import { gerberLayers, gerberMask } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { computeConnectivity } from "../src/model/connectivity"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { DEFAULT_MIN_HOLE, hatchPaths, hatchTooFine, MAX_HOLES, type HatchNet } from "../src/model/zoneHatch"
import { areaMm2, circlePath, difference, intersect, pt, U } from "../src/model/zoneGeom"
import { drawnPaths, lineEndParts, pointShapeDistance, shapeCopper, shapePaths, type PathSeg } from "../src/model/shapes"
import type { BoardShape, Project, ZoneHatch } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X24: a hatched pour (a grid of lines cut into the copper by KiCad's rules), tracks whose copper is open through the solder mask, and the line ends (KiCad 11 development's) and colours of drawings, which are
// kept and written back where KiCad 9 reads them. The corpus run against the file's own filled polygons is `kicad-x24-corpus.test.ts`.

const box = (x0: number, y0: number, x1: number, y1: number): Paths64 => [[pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)]]
const inside = (paths: Paths64, x0: number, y0: number, x1: number, y1: number) => areaMm2(intersect(paths, box(x0, y0, x1, y1)))
const FILL_30 = box(0, 0, 30, 30)
const NO_NET: HatchNet = { vias: [], pads: [] }
/** The hatch of a pour whose copper, shrunk by half the minimum width as KiCad hatches it, is `fill` (and whose outline is the same unless it is given), by the rules of the release the hatch says. */
const hatch = (h: ZoneHatch, o: { fill?: Paths64; outline?: Paths64; at?: { x: number; y: number }; net?: HatchNet; protect?: Paths64 } = {}) => {
  const fill = o.fill ?? FILL_30
  return hatchPaths(fill, h, 0.25, o.outline ?? fill, h.fromFill ? { net: o.net ?? NO_NET } : { at: o.at, protect: o.protect ?? [] })
}

describe("the hatch grid (zoneHatch.ts)", () => {
  const plain: ZoneHatch = { thickness: 1, gap: 2 }
  // KiCad 9 and earlier: from the corner of the copper
  const old: ZoneHatch = { ...plain, fromFill: true }

  it("KiCad 10 cuts square holes of the gap and the minimum width, a line and a gap apart, from the board's origin", () => {
    const out = hatch(plain)
    // The holes are 2.25 wide (the gap and the minimum width, which the copper growing back takes to the gap) at every 3 mm: 6 by 6 of them in the middle of the pour, each with a line and the rest of the cell round it.
    // (KiCad's grid is laid out from the origin downwards, so across the holes are at 9 to 11.25 and up the board at 9.75 to 12.)
    const cell = 9 - 2.25 ** 2
    expect(inside(out, 6, 6, 24, 24)).toBeCloseTo(36 * cell, 3)
    expect(inside(out, 9, 9.75, 11.25, 12)).toBe(0)
    // the line between two holes is whole copper, 3 - 2.25 wide
    expect(inside(out, 11.25, 9.75, 12, 12)).toBeCloseTo(0.75 * 2.25, 3)
  })

  it("KiCad 10 keeps a band along the pour's edge, as wide as the lines less the minimum width, and no hole the cut leaves too small", () => {
    const out = hatch(plain)
    expect(inside(out, 0, 0, 0.75, 30)).toBeCloseTo(0.75 * 30, 3)
    expect(inside(out, 0, 0, 30, 0.75)).toBeCloseTo(0.75 * 30, 3)
    // the first hole starts where the band ends: a corner hole of 1.5 by 1.5, kept
    expect(inside(out, 0.76, 27.8, 2.24, 29.2)).toBe(0)
    // the band is the same for either border algorithm in KiCad 10, which has only the one
    expect(areaMm2(hatch({ ...plain, thinBorder: true }))).toBeCloseTo(areaMm2(out), 6)
  })

  it("keeps the holes inside the zone's own outline and leaves the rest of the copper whole", () => {
    const out = hatch(plain, { outline: box(5, 5, 25, 25) })
    expect(inside(out, 0, 0, 5, 30)).toBeCloseTo(150, 3)
    expect(inside(out, 5, 5, 5.25, 25)).toBeCloseTo(0.25 * 20, 3)
    expect(inside(out, 9, 9.75, 11.25, 12)).toBe(0)
  })

  it("KiCad 9 and earlier leave a band of the hatch's own width along the edge, or 1.1 times the minimum width with the thin border", () => {
    const thick = hatch(old)
    const thin = hatch({ ...old, thinBorder: true })
    expect(inside(thick, 0, 0, 0.99, 30)).toBeCloseTo(0.99 * 30, 3)
    expect(inside(thin, 0.3, 0, 0.9, 30)).toBeLessThan(inside(thick, 0.3, 0, 0.9, 30))
    expect(inside(thin, 0, 0, 0.275, 30)).toBeCloseTo(0.275 * 30, 3)
    expect(inside(thin, 0.3, 0.3, 2.2, 2.2)).toBeLessThan(1.9 * 1.9)
  })

  it("drops a hole the edge cuts to less than the smallest part asked for, and keeps it whole", () => {
    expect(DEFAULT_MIN_HOLE).toBe(0.3)
    // the corner hole is 1.5 by 1.5, 0.44 of a whole hole of 2.25: kept by 0.3, dropped by 0.5
    expect(inside(hatch(plain), 0.8, 27.8, 2.2, 29.2)).toBe(0)
    expect(inside(hatch({ ...plain, minHole: 0.5 }), 0.8, 27.8, 2.2, 29.2)).toBeCloseTo(1.4 * 1.4, 3)
    expect(areaMm2(hatch({ ...plain, minHole: 1 }))).toBeGreaterThan(areaMm2(hatch({ ...plain, minHole: 0 })))
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
    expect(inside(out, 8, 8, 22, 22) / 196).toBeCloseTo((9 - 2.25 ** 2) / 9, 1)
  })

  it("starts the grid at the pour's own corner for a file of KiCad 9 or earlier, and at a hatch position moves a KiCad 10 grid by the remainder of the pitch", () => {
    const corner = hatch(old, { fill: box(2, 3, 32, 33) })
    // the grid starts at the top left (KiCad's y runs down): its second column of holes is 5 to 7.25, its second row 27.75 to 30
    expect(inside(corner, 5.1, 27.8, 7.2, 29.9)).toBe(0)
    expect(inside(corner, 4.3, 27.8, 4.9, 29.9)).toBeCloseTo(0.6 * 2.1, 3)
    // a hatch position is not used by a grid that starts at the corner
    expect(areaMm2(hatch(old, { fill: box(2, 3, 32, 33), at: { x: 1, y: 0 } }))).toBeCloseTo(areaMm2(corner), 6)
    // KiCad 10: a hole at 9 to 11.25 goes to 10 to 12.25 by a position of 1, and by a position of 4 (a remainder of 1) as well
    const moved = hatch(plain, { at: { x: 1, y: 0 } })
    expect(inside(moved, 9.5, 9.9, 9.6, 10.1)).toBeCloseTo(0.02, 3)
    expect(inside(hatch(plain), 9.5, 9.9, 9.6, 10.1)).toBe(0)
    expect(areaMm2(hatch(plain, { at: { x: 4, y: 0 } }))).toBeCloseTo(areaMm2(moved), 6)
    // the position's y is KiCad's (down): a position of -1 in the editor's frame is KiCad's +1, which moves the holes down the board by that
    expect(inside(hatch(plain, { at: { x: 0, y: -1 } }), 9.5, 11.2, 10.5, 11.7)).toBeCloseTo(0.5, 3)
    expect(inside(hatch(plain), 9.5, 11.2, 10.5, 11.7)).toBe(0)
    // a position of -1 across takes its remainder with its sign, as KiCad's integers do: the holes move left by 1, where a position of 2 moves them right by 2 (the same lattice)
    expect(inside(hatch(plain, { at: { x: -1, y: 0 } }), 9.5, 9.9, 9.6, 10.1)).toBe(0)
    expect(inside(hatch(plain, { at: { x: -1, y: 0 } }), 7.6, 9.9, 7.7, 10.1)).toBeCloseTo(0.02, 3)
  })

  it("rounds or cuts the holes' corners by the smoothing, as KiCad's Fillet and Chamfer do, never by more than half the gap", () => {
    const square = inside(hatch(plain), 6, 6, 24, 24)
    const rounded = inside(hatch({ ...plain, smooth: { level: 2, value: 1 } }), 6, 6, 24, 24)
    const cut = inside(hatch({ ...plain, smooth: { level: 1, value: 1 } }), 6, 6, 24, 24)
    // a rounding of half the gap, 1 mm, on a 2.25 mm hole is in two segments for each corner (KiCad's error for it is a twentieth of the radius): the corner's 1 mm square less what the two chords leave
    expect(rounded - square).toBeCloseTo(36 * 4 * (1 - Math.SQRT1_2), 1)
    // a cut of the same distance takes a triangle of half a square millimetre off each corner
    expect(cut - square).toBeCloseTo(36 * 4 * 0.5, 1)
    // a smoothing larger than half the gap is the half gap (the minimum width's half is added to it, and the half gap is the most)
    expect(inside(hatch({ ...plain, smooth: { level: 2, value: 10 } }), 6, 6, 24, 24)).toBeCloseTo(rounded, 6)
    // a smoothing too small to see is square holes, and one that is small makes a cut even where a rounding is asked
    expect(inside(hatch({ ...plain, smooth: { level: 2, value: 0.01 } }), 6, 6, 24, 24)).toBeCloseTo(square, 6)
    expect(inside(hatch({ ...plain, smooth: { level: 3, value: 0.03 } }), 6, 6, 24, 24)).toBeCloseTo(inside(hatch({ ...plain, smooth: { level: 1, value: 0.03 } }), 6, 6, 24, 24), 6)
    // the third level rounds finer than the second
    expect(inside(hatch({ ...plain, smooth: { level: 3, value: 1 } }), 6, 6, 24, 24)).toBeLessThan(rounded)
  })

  it("makes the lines wider than the minimum width, as KiCad does", () => {
    const out = hatch({ thickness: 0.1, gap: 1 })
    const pitch = 0.251 + 1
    const cell = pitch ** 2 - 1.25 ** 2
    expect(inside(out, 6, 6, 6 + 10 * pitch, 6 + 10 * pitch)).toBeCloseTo(100 * cell, 3)
  })

  it("KiCad 9 and earlier grow an apron round a via of the pour's net out of the holes, so that a hole does not isolate it", () => {
    // the hole at 15 to 17.25 across and 12.75 to 15 up is the sixth of the sixth from the corner; its middle is a via
    const via = { at: { x: 16.125, y: 13.875 }, drill: 0.3 }
    expect(inside(hatch(old), 15.05, 12.8, 17.2, 14.95)).toBe(0)
    // the apron's radius is the largest of a hole's tenth of nineteen and the drill's half and the margin (1.15): it takes the whole hole but its corners, which the smallest hole drops
    expect(inside(hatch(old, { net: { vias: [via], pads: [] } }), 15.05, 12.8, 17.2, 14.95)).toBeCloseTo(2.15 * 2.15, 3)
    // a via of another place does not touch it
    expect(inside(hatch(old, { net: { vias: [{ at: { x: 1, y: 1 }, drill: 0.3 }], pads: [] } }), 15.05, 12.8, 17.2, 14.95)).toBe(0)
    // a pad is grown to be at least as wide as the gap
    const pad = { shape: box(15.6, 13.4, 16.6, 14.4), width: 1, slot: 0 }
    expect(inside(hatch(old, { net: { vias: [], pads: [pad] } }), 15.05, 12.8, 17.2, 14.95)).toBeGreaterThan(1)
  })

  it("KiCad 10 drops the hole that holds a thermal ring or a clearance whole, and keeps one that it only overlaps", () => {
    // the hole at 9 to 11.25 across and 9.75 to 12 up: a ring of 1 mm round its middle sits wholly inside it
    const ring = difference([circlePath(10.125, 10.875, 1)], [circlePath(10.125, 10.875, 0.5)])
    expect(inside(hatch(plain, { protect: ring }), 9.1, 9.85, 11.15, 11.9)).toBeCloseTo(2.05 * 2.05, 3)
    // a ring that crosses the hole's edge is not whole inside it
    const wide = difference([circlePath(10.125, 10.875, 1.3)], [circlePath(10.125, 10.875, 0.5)])
    expect(inside(hatch(plain, { protect: wide }), 10, 10.7, 10.25, 11)).toBe(0)
  })

  it("is the pour whole when its grid is too fine for it, and says so", () => {
    expect(areaMm2(hatchPaths(box(0, 0, 1000, 1000), { thickness: 0.011, gap: 0.01 }, 0.01, box(0, 0, 1000, 1000), { at: undefined, protect: [] }))).toBeCloseTo(1_000_000, 6)
    expect(hatchTooFine(box(0, 0, 1000, 1000), { thickness: 0.011, gap: 0.01 }, 0.01)).toBe(true)
    expect(hatchTooFine(FILL_30, plain, 0.25)).toBe(false)
    expect(MAX_HOLES).toBe(300_000)
  })

  it("is exactly the pour when there is none", () => {
    expect(hatchPaths([], plain, 0.25, [], { at: undefined, protect: [] })).toEqual([])
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
const refusalOf = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ nets, body: [part, ...body], ...extra }))
  expect(r.status).toBe("refused")
  return r.status === "refused" ? r : null
}

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
    // KiCad 10 has no border algorithm (it always leaves the band of the hatch thickness), so the word is not kept; an older release has it
    expect(all.project.zones[0].hatch).toEqual({ thickness: 0.5, gap: 0.8, minHole: 0.1, smooth: { level: 3, value: 0.5 } })
    const older = imp([zone("(fill yes (mode hatch) (hatch_thickness 0.5) (hatch_gap 0.8) (hatch_orientation 0) (hatch_border_algorithm min_thickness))")], { version: 20241229 })
    expect(older.project.zones[0].hatch).toEqual({ thickness: 0.5, gap: 0.8, thinBorder: true, fromFill: true })
    // the grid of a file from before the hatch position (2025-03-02) is the old release's, one from that day on is the new one's
    expect(imp([zone()], { version: 20250301 }).project.zones[0].hatch?.fromFill).toBe(true)
    expect(imp([zone()], { version: 20250302 }).project.zones[0].hatch?.fromFill).toBeUndefined()
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

  it("KiCad 10 gives a via of the pour's net a thermal relief and a ring in a hatched pour, as it does a pad, and KiCad 9 leaves it solid", () => {
    const via = '(via (at 10 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "00000000-0000-4000-8000-0000000000c1"))'
    const copperAt = (version: number, x: number, y: number) => {
      const r = imp([via, zone()], { version })
      const [f] = fillsOf(r.project)
      const paths = f.polygons.flatMap((poly) => poly.map((ring) => ring.map((p) => pt(p.x, p.y))))
      return areaMm2(intersect(paths, box(x - 0.02, -y - 0.02, x + 0.02, -y + 0.02))) > 0.0007
    }
    // the relief's gap is 0.5 from the via's copper (0.3 out): at 45 degrees, where there is no spoke, nothing between 0.35 and 0.75 out and the ring 0.8 to 1.3 out
    const diagonal = (r: number) => [10 + r * Math.SQRT1_2, 5 + r * Math.SQRT1_2] as const
    expect(copperAt(20260206, ...diagonal(0.55))).toBe(false)
    expect(copperAt(20260206, ...diagonal(1.05))).toBe(true)
    // KiCad 9 and earlier: the via is joined to the copper solid, with no gap round it
    expect(copperAt(20241229, ...diagonal(0.55))).toBe(true)
  })

  it("keeps a hatch position as the file has it in a part on the bottom, as KiCad does not flip it with the part", () => {
    const withPosition = (bottom: boolean) =>
      importKicadBoard(
        board({
          nets,
          body: [
            footprint({ pads: [pad({ at: "0 0" })], layer: bottom ? "B.Cu" : "F.Cu", extra: `(zone (net 0) (net_name "") (layer "${bottom ? "B.Cu" : "F.Cu"}") (uuid "00000000-0000-4000-8000-0000000000a2") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (filled_areas_thickness no) ${hatchFill} (property (layer "${bottom ? "B.Cu" : "F.Cu"}") (hatch_position (xy 1 2))) (polygon (pts (xy 3 3) (xy 13 3) (xy 13 8) (xy 3 8))))` }),
          ],
        }),
      )
    for (const bottom of [false, true]) {
      const r = withPosition(bottom)
      expect(r.status).toBe("imported")
      if (r.status !== "imported") continue
      expect(Object.values(r.project.footprints![0].zones![0].hatchAt ?? {})).toEqual([{ x: 1, y: -2 }])
    }
  })

  it("is refused when its grid has more holes than the editor cuts, and says how many", () => {
    const fine = refusalOf([zone("(fill yes (mode hatch) (hatch_thickness 0.011) (hatch_gap 0.01) (hatch_orientation 0) (hatch_border_algorithm hatch_thickness) (hatch_min_hole_area 0.3))", "", '(layer "F.Cu")', "(polygon (pts (xy 0 0) (xy 300 0) (xy 300 300) (xy 0 300)))")])
    expect(fine?.message).toMatch(/more than 300,000 holes/)
  })

  it("is refused, in words, when the file says what the editor does not hold", () => {
    const refusal = refusalOf
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

  it("is refused when its opening is not on its own side, and a margin with no mask to open is nothing, as in KiCad", () => {
    const wrong = importKicadBoard(board({ nets, body: [part, seg("", '(layers "F.Cu" "B.Mask")')] }))
    expect(wrong.status === "refused" && wrong.message).toMatch(/open through B\.Mask, which is not the mask of its own side/)
    const none = importKicadBoard(board({ nets, body: [part, seg("(solder_mask_margin 0.3)", '(layer "F.Cu")')] }))
    expect(none.status).toBe("imported")
    expect(none.status === "imported" && none.project.traces.map((t) => t.bare)).toEqual([undefined])
  })

  it("keeps a negative margin from opening less than the track's own middle, as KiCad does", () => {
    // a 0.2 mm track with a margin of -0.3 would have an opening of -0.4 mm: the margin stops at minus half the width, which leaves none
    const r = imp([seg("(solder_mask_margin -0.3)")])
    expect(gerberMask(r.project, "top")).not.toMatch(/C,-/)
    const mild = imp([seg("(solder_mask_margin -0.05)")])
    expect(gerberMask(mild.project, "top")).toMatch(/C,0\.1\*/)
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

describe("the shapes at the ends of a line, as KiCad draws, plots and keeps copper from them", () => {
  const base = { layer: "F.SilkS", width: 0.2 }
  const arrowCircle: BoardShape = { type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, ...base, ends: { start: { style: "arrow", length: 3, width: 2 }, end: { style: "circle" } } }
  const rounded = (p: { x: number; y: number }) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6]

  it("puts an arrow by its tip at the end, along the line, and a circle of five line widths centred on it, and stops the line short under both", () => {
    const [arrow, circle] = lineEndParts(arrowCircle)
    expect(arrow.open).toBe(false)
    // the tip at the end of the line and the base 3 mm along it, 2 mm across
    expect(arrow.outline).toHaveLength(3)
    expect(rounded(arrow.outline[0])).toEqual([0, 0])
    expect(arrow.outline.slice(1).map(rounded).sort((p, q) => p[1] - q[1])).toEqual([[3, -1], [3, 1]])
    // a circle of 32 corners, 1 mm across (an unset size is five line widths), centred on the end
    expect(circle.outline).toHaveLength(32)
    expect(Math.min(...circle.outline.map((p) => p.x))).toBeCloseTo(9.5, 6)
    expect(Math.max(...circle.outline.map((p) => p.x))).toBeCloseTo(10.5, 6)
    // the line starts where the arrow ends and stops at the circle's near side
    const [path] = drawnPaths(arrowCircle)
    expect(path.segs).toEqual([{ kind: "line", a: { x: 3, y: 0 }, b: { x: 9.5, y: 0 } }])
  })

  it("does not shorten the line under an open arrow, which is two strokes of its own width or the line's", () => {
    const open: BoardShape = { type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, ...base, ends: { end: { style: "arrow_open", length: 2, width: 2 } } }
    expect(drawnPaths(open)[0].segs).toEqual([{ kind: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }])
    const [part] = lineEndParts(open)
    expect(part.open).toBe(true)
    expect(part.width).toBe(0.2)
    expect(part.outline.map(rounded)).toEqual([[8, -1], [10, 0], [8, 1]])
    expect(lineEndParts({ ...open, ends: { end: { style: "arrow_open", length: 2, width: 2, stroke: { width: 0.5 } } } })[0].width).toBe(0.5)
  })

  it("draws nothing for a word it does not know, and nothing is left of a line the ends take all of", () => {
    expect(lineEndParts({ ...arrowCircle, ends: { start: { style: "diamond" } } })).toEqual([])
    expect(drawnPaths({ ...arrowCircle, ends: { start: { style: "diamond" } } })).toEqual(shapePaths(arrowCircle))
    const short: BoardShape = { type: "line", a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, ...base, ends: { start: { style: "arrow", length: 3 } } }
    expect(drawnPaths(short)).toEqual([])
  })

  it("stops an arc short by length along it, and an arrow on an arc points out of it", () => {
    // a quarter circle of radius 5 from (5, 0) to (0, 5) round the origin, with an arrow 2 long at its start
    const arc: BoardShape = { type: "arc", start: { x: 5, y: 0 }, mid: { x: 5 * Math.SQRT1_2, y: 5 * Math.SQRT1_2 }, end: { x: 0, y: 5 }, ...base, ends: { start: { style: "arrow", length: 2, width: 1 } } }
    const [path] = drawnPaths(arc)
    const seg = path.segs[0] as Extract<PathSeg, { kind: "arc" }>
    // it starts 2 / 5 of a radian along
    expect(seg.start.x).toBeCloseTo(5 * Math.cos(0.4), 6)
    expect(seg.start.y).toBeCloseTo(5 * Math.sin(0.4), 6)
    expect(seg.end.x).toBeCloseTo(0, 6)
    // the arrow's tip is the arc's start, pointing out of the arc (against the way round, down), so the arrow lies along minus y
    const [arrow] = lineEndParts(arc)
    expect(rounded(arrow.outline[0])).toEqual([5, 0])
    expect(Math.min(...arrow.outline.map((p) => p.y))).toBeCloseTo(0, 6)
    expect(Math.max(...arrow.outline.map((p) => p.y))).toBeCloseTo(2, 6)
  })

  it("stops a curve short by length along it", () => {
    const curve: BoardShape = { type: "curve", p0: { x: 0, y: 0 }, c1: { x: 3, y: 0 }, c2: { x: 6, y: 0 }, p1: { x: 9, y: 0 }, ...base, ends: { end: { style: "square", length: 2 } } }
    // a straight curve of length 9, a square 2 long takes 1 off the end
    const [path] = drawnPaths(curve)
    const seg = path.segs[0] as Extract<PathSeg, { kind: "bezier" }>
    expect(seg.p0).toEqual({ x: 0, y: 0 })
    expect(seg.p1.x).toBeCloseTo(8, 3)
    expect(Math.min(...lineEndParts(curve)[0].outline.map((p) => p.x))).toBeCloseTo(8, 6)
  })

  it("plots the ends with the line: a region for each closed one, and the line short under it", () => {
    const r = imp(["(gr_line (start 3 3) (end 9 3) (stroke (width 0.2) (type solid)) (start_shape arrow (length 1) (width 1)) (end_shape circle (length 1)) (layer \"F.Cu\") (net 1))"])
    const copper = gerberLayers(r.project).F_Cu
    expect(copper.match(/G36\*/g)).toHaveLength(2)
    // the line is drawn from 4 to 8.5 (an arrow of 1 at one end and half of a circle of 1 at the other)
    expect(copper).toMatch(/X4000000Y-3000000D02\*\s*X8500000Y-3000000D01\*/)
  })

  it("keeps a pour away from them, the arrow's wings too, by the gap", () => {
    const r = imp(["(gr_line (start 5 5) (end 9 5) (stroke (width 0.2) (type solid)) (start_shape arrow (length 2) (width 3)) (layer \"F.Cu\") (net 0))", zone("(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))", "", '(layer "F.Cu")', "(polygon (pts (xy 1 1) (xy 20 1) (xy 20 12) (xy 1 12)))")])
    const [fill] = fillsOf(r.project)
    const copper = Clipper.union(
      fill.polygons.flatMap((poly) => poly.map((ring) => ring.map((p) => pt(p.x, p.y)))),
      [],
      FillRule.EvenOdd,
    )
    const wings = lineEndParts(r.project.graphics![0]).map((part) => part.outline.map((p) => pt(p.x, p.y)))
    // the arrow's polygon (tip at 5, base at 7, 3 across) is cleared by the zone's gap of 0.5
    expect(areaMm2(intersect(copper, Clipper.inflatePaths(wings, 0.49 * U, JoinType.Round, EndType.Polygon, 2, 25)))).toBe(0)
    // and the pour comes up to it
    expect(areaMm2(intersect(copper, Clipper.inflatePaths(wings, 0.7 * U, JoinType.Round, EndType.Polygon, 2, 25)))).toBeGreaterThan(0.1)
  })

  it("is measured by the checks as copper: an arrow's wing is near a point that the line itself is not", () => {
    const withEnds: BoardShape = { type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, layer: "F.Cu", width: 0.2, ends: { end: { style: "arrow", length: 2, width: 4 } } }
    const bare = shapeCopper({ ...withEnds, ends: undefined })
    const near = shapeCopper(withEnds)
    const point = { x: 8.5, y: 1.5 }
    expect(pointShapeDistance(point, bare)).toBeGreaterThan(1.3)
    expect(pointShapeDistance(point, near)).toBeLessThan(0.1)
  })
})
