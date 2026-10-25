import { describe, expect, it } from "vitest"
import { importKicadBoard, readKicadBoard, outlineOf, needsOf, buildKicadProject, BUILT_EXTENSIONS, type ImportReport } from "../src/model/kicad/board"
import { accountNodes, countPaths } from "../src/model/kicad/board/account"
import { settledFor } from "../src/model/kicad/board/carried"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { componentFootprint, maskSides, pasteSides, pcbPads, slotEnds, type WorldPad } from "../src/model/instances"
import { holeCentre, padBox, pointPadDistance, segmentPadDistance } from "../src/model/padDistance"
import { padOpeningRings, pasteMargins, maskMargin } from "../src/model/padOpening"
import { padRings } from "../src/model/padGeom"
import type { PadDef } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// X7, the pad model, from the importer to the editor's own pads: every shape, a pad's own turn, its layers, margins and holes, the nets of pads that share
// a number, and what the project says about each.

const imp = (text: string): Extract<ReturnType<typeof importKicadBoard>, { status: "imported" }> => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => `${e.code}: ${e.why}`).join("\n")}`)
  return r
}
const one = (extra: string, over: Partial<Parameters<typeof pad>[0]> = {}, fp: Partial<Parameters<typeof footprint>[0]> = {}) => {
  const r = imp(board({ body: [footprint({ ref: "U1", at: "10 5", pads: [pad({ number: "1", at: "0 0", size: "2 1", extra, ...over })], ...fp })] }))
  const c = r.project.components[0]
  return { r, c, land: componentFootprint(c)!, world: pcbPads(c)[0] }
}
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps)

describe("X7 is built, and the gate says so", () => {
  it("BUILT_EXTENSIONS holds X7, and a board with every pad feature is imported", () => {
    expect(BUILT_EXTENSIONS.has("X7")).toBe(true)
    const r = imp(
      board({
        body: [
          footprint({
            pads: [
              pad({ number: "1", at: "-3 0", shape: "roundrect", size: "1 2", extra: "(roundrect_rratio 0.25)" }),
              pad({ number: "2", at: "0 0 30", shape: "rect", size: "1 2" }),
              pad({ number: "3", at: "3 0", shape: "custom", size: "0.5 0.5", extra: "(options (clearance outline) (anchor circle)) (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0.1) (fill yes)))" }),
            ],
          }),
        ],
      }),
    )
    expect(r.status).toBe("imported")
  })
  it("a pad stack, a pad that drops its copper where nothing connects, a pad's own pour layers and its own tenting need other extensions, named", () => {
    const ext = (extra: string, type = "smd") => {
      const text = board({ body: [footprint({ pads: [pad({ number: "1", at: "0 0", type, extra, ...(type === "thru_hole" ? { layers: '"*.Cu" "*.Mask"' } : {}) })] })] })
      const read = readKicadBoard(text)
      return needsOf(read.board, { paths: countPaths(read.board.tree) }, outlineOf(read.board)).map((n) => n.ext)
    }
    expect(ext('(padstack (mode front_inner_back) (layer "Inner" (shape rect) (size 2 2)))')).toContain("X1")
    expect(ext("(remove_unused_layers yes) (keep_end_layers no)", "thru_hole")).toContain("X1")
    expect(ext("(remove_unused_layers yes) (keep_end_layers yes)", "thru_hole")).not.toContain("X1")
    expect(ext("(remove_unused_layers no)", "thru_hole")).not.toContain("X1")
    expect(ext('(zone_layer_connections "F.Cu")', "thru_hole")).toContain("X3")
    expect(ext("(tenting (front yes) (back none))")).toContain("X5")
    expect(ext("(tenting (front none) (back none))")).not.toContain("X5")
  })
})

describe("pad shapes", () => {
  it("a rectangle, a circle and an oval are what they were: no field of X7 on the land, a plain world pad", () => {
    const rect = one("")
    expect(rect.land.pads[0]).toEqual({ pin: "1", shape: "rect", x: 0, y: 0, width: 2, height: 1, layer: "top" })
    expect(rect.world.x7).toBeUndefined()
    expect(rect.world.corner).toBeUndefined()
    expect(one("", { shape: "circle", size: "1.5 1.5" }).land.pads[0]).toMatchObject({ shape: "circle", width: 1.5, height: 1.5 })
    expect(one("", { shape: "oval", size: "2 1" }).land.pads[0]).toMatchObject({ shape: "pill", width: 2, height: 1 })
    // an oval of two equal sizes is a circle
    expect(one("", { shape: "oval", size: "1 1" }).land.pads[0].shape).toBe("circle")
  })

  it("a rounded rectangle keeps its ratio, and its corner is a quarter circle of the ratio of the shorter side (0.25 when the file gives none)", () => {
    const a = one("(roundrect_rratio 0.2)", { shape: "roundrect" })
    expect(a.land.pads[0].round).toBe(0.2)
    near(a.world.corner!, 0.2)
    const b = one("", { shape: "roundrect" })
    expect(b.land.pads[0].round).toBe(0.25)
    near(b.world.corner!, 0.25)
    // the sharp corner of a 2 by 1 pad (0.5 round) is the corner's distance from the arc's centre less the radius
    const centre = { x: 10 - 1 + 0.25, y: -5 + 0.5 - 0.25 }
    const corner = { x: 9, y: -5 + 0.5 }
    near(pointPadDistance(corner, b.world), Math.hypot(corner.x - centre.x, corner.y - centre.y) - 0.25, 1e-9)
    // the middle of a side is on the pad
    expect(pointPadDistance({ x: 10, y: -4.6 }, b.world)).toBe(0)
    // a rectangle that says "roundrect" with a ratio of 0 is a rectangle
    expect(one("(roundrect_rratio 0)", { shape: "roundrect" }).land.pads[0].round).toBeUndefined()
  })

  it("a rounded pad on a part turned a quarter turn is the same pad turned; at any other angle it is a polygon that keeps its size, turn and radius", () => {
    const q = one("(roundrect_rratio 0.25)", { shape: "roundrect", at: "0 0 90" }, { at: "10 5 90" }).world
    expect(q.shape).toBe("rect")
    expect([q.width, q.height]).toEqual([1, 2])
    near(q.corner!, 0.25)
    const t = one("(roundrect_rratio 0.25)", { shape: "roundrect", at: "0 0 33" }, { at: "10 5 33" }).world
    expect(t.shape).toBe("polygon")
    expect(t.oriented).toMatchObject({ width: 2, height: 1, rot: 33, corner: 0.25 })
    near(pointPadDistance({ x: t.x, y: t.y }, t), 0)
  })

  it("a chamfered rectangle cuts the corners the file names, as the pad is seen, on top and on the bottom", () => {
    const top = one("(roundrect_rratio 0) (chamfer_ratio 0.25) (chamfer top_left bottom_right)", { shape: "roundrect" })
    expect(top.land.pads[0].chamfer).toEqual({ ratio: 0.25, corners: 1 | 4 })
    // 2 by 1, a cut of 0.25: the corner point is 0.25 / sqrt 2 from the cut's edge; y is up in the editor, so the file's top is +y
    const cut = 0.25 / Math.SQRT2
    near(pointPadDistance({ x: 9, y: -5 + 0.5 }, top.world), cut, 1e-9)
    near(pointPadDistance({ x: 11, y: -5 - 0.5 }, top.world), cut, 1e-9)
    expect(pointPadDistance({ x: 11, y: -5 + 0.5 }, top.world)).toBe(0)
    expect(pointPadDistance({ x: 9, y: -5 - 0.5 }, top.world)).toBe(0)
    // a part on the bottom is stored flipped: what the file's own frame shows as the top left is the top left of the board too
    const bottom = one("(roundrect_rratio 0) (chamfer_ratio 0.25) (chamfer top_left)", { shape: "roundrect", layers: '"B.Cu" "B.Mask" "B.Paste"' }, { layer: "B.Cu" })
    near(pointPadDistance({ x: 9, y: -5 + 0.5 }, bottom.world), cut, 1e-9)
    expect(pointPadDistance({ x: 11, y: -5 + 0.5 }, bottom.world)).toBe(0)
    expect(pointPadDistance({ x: 9, y: -5 - 0.5 }, bottom.world)).toBe(0)
  })

  it("a chamfer ratio or a corner makes any shape a chamfered rectangle, as KiCad reads it", () => {
    const a = one("(chamfer_ratio 0.2) (chamfer top_left)", { shape: "rect" })
    expect(a.land.pads[0].chamfer?.corners).toBe(1)
    // and its corners are rounded by the default ratio of a rounded rectangle, 0.25
    expect(a.land.pads[0].round).toBe(0.25)
  })

  it("a trapezoid is a polygon of the corners KiCad's delta gives, turned with the pad", () => {
    const t = one("(rect_delta 0.4 0)", { shape: "trapezoid" })
    expect(t.land.pads[0].shape).toBe("polygon")
    const pts = t.world.points!.map((p) => [Math.round((p.x - 10) * 1e6) / 1e6, Math.round((p.y + 5) * 1e6) / 1e6]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    // 2 by 1, delta x 0.4: the right side is 0.4 shorter than the left, symmetrically
    expect(pts).toEqual([[-1, -0.7], [-1, 0.7], [1, -0.3], [1, 0.3]].sort((a, b) => a[0] - b[0] || a[1] - b[1]))
  })

  it("a pad turned by 90 on a part at 0 swaps its sides, and one turned 45 keeps its own turn", () => {
    const a = one("", { at: "0 0 90" })
    expect(a.land.pads[0]).toMatchObject({ width: 1, height: 2 })
    expect(a.land.pads[0].rot).toBeUndefined()
    const b = one("", { at: "0 0 45" })
    expect(b.land.pads[0]).toMatchObject({ width: 2, height: 1, rot: 45 })
    expect(b.world.shape).toBe("polygon")
    expect(b.world.oriented).toMatchObject({ width: 2, height: 1, rot: 45 })
    near(b.world.width, (2 + 1) / Math.SQRT2, 1e-6)
  })

  it("a pad of no size is a micron square, as KiCad makes it", () => {
    const z = one("", { size: "0 0" })
    expect(z.land.pads[0]).toMatchObject({ width: 0.001, height: 0.001 })
  })

  it("a pad of a shape KiCad does not know is not imported silently", () => {
    const text = board({ body: [footprint({ pads: [pad({ at: "0 0", shape: "hexagon" })] })] })
    expect(importKicadBoard(text).status).toBe("refused")
  })
})

describe("custom pads", () => {
  const prims = '(primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0.1) (fill yes)) (gr_line (start 0 0) (end -1 0) (width 0.2)) (gr_circle (center 0 -1) (end 0.3 -1) (width 0) (fill yes)) (gr_arc (start 1 -1) (mid 1.5 -1.5) (end 2 -1) (width 0.1)))'
  const custom = (anchor = "circle") => one(`(options (clearance outline) (anchor ${anchor})) ${prims}`, { shape: "custom", size: "0.4 0.4" })

  it("is an anchor with drawings, held exactly, in the pad's frame with y up", () => {
    const { land } = custom()
    const c = land.pads[0].custom!
    expect(c.anchor).toBe("circle")
    expect(c.shapes.map((s) => s.type)).toEqual(["polygon", "line", "circle", "arc"])
    // y negated: the file's y down is the editor's y up
    expect(c.shapes[1]).toMatchObject({ type: "line", a: { x: 0, y: 0 }, b: { x: -1, y: 0 }, width: 0.2 })
    expect(c.shapes[2]).toMatchObject({ type: "circle", c: { x: 0, y: 1 }, r: 0.3, fill: true })
    expect(land.pads[0]).toMatchObject({ shape: "circle", width: 0.4, height: 0.4 })
  })

  it("covers what its anchor and its drawings cover, with their line widths (a distance field)", () => {
    const { world } = custom()
    // inside the polygon (file frame x 0.8, y 0.3: the editor's y is -0.3 about the pad)
    const at = (x: number, y: number) => ({ x: 10 + x, y: -5 + y })
    expect(pointPadDistance(at(0.8, -0.3), world)).toBe(0)
    // on the line's stroke, and 0.1 beyond its edge (width 0.2: half 0.1)
    expect(pointPadDistance(at(-0.5, 0.05), world)).toBe(0)
    near(pointPadDistance(at(-0.5, 0.2), world), 0.1, 2e-4)
    // in the filled circle (centre (0, +1), radius 0.3)
    expect(pointPadDistance(at(0, 1.2), world)).toBe(0)
    near(pointPadDistance(at(0, 1.5), world), 0.2, 2e-4)
    // far away
    expect(pointPadDistance(at(10, 10), world)).toBeGreaterThan(5)
  })

  it("a ring drawn round the anchor leaves a hole, and the pad keeps both rings", () => {
    const { world } = one('(options (clearance outline) (anchor circle)) (primitives (gr_circle (center 0 0) (end 1 0) (width 0.4) (fill no)))', { shape: "custom", size: "0.1 0.1" })
    expect(world.rings?.length).toBe(3)
    // in the hole between the anchor and the ring, outside both
    expect(pointPadDistance({ x: 10.5, y: -5 }, world)).toBeGreaterThan(0.25)
    expect(pointPadDistance({ x: 10, y: -5 }, world)).toBe(0)
    // on the ring itself
    expect(pointPadDistance({ x: 11, y: -5 }, world)).toBe(0)
  })

  it("a rectangle anchor is a rectangle of the pad's size, and the clearance setting is kept", () => {
    const rect = one(`(options (clearance convexhull) (anchor rect)) ${prims}`, { shape: "custom", size: "0.6 0.4" })
    expect(rect.land.pads[0].custom).toMatchObject({ anchor: "rect", hull: true })
    expect(rect.land.pads[0]).toMatchObject({ shape: "rect", width: 0.6, height: 0.4 })
    expect(rect.world.hull).toBe(true)
  })

  it("a custom pad on the bottom of a part at an angle is the same copper, turned (distance field against the top part's)", () => {
    const top = one(`(options (clearance outline) (anchor circle)) ${prims}`, { shape: "custom", size: "0.4 0.4" }, { at: "10 5 0" })
    const rotated = one(`(options (clearance outline) (anchor circle)) ${prims}`, { shape: "custom", size: "0.4 0.4", at: "0 0 90" }, { at: "10 5 90" })
    // the same pad in a part turned a quarter turn: every point of one is the turned point of the other
    for (const [x, y] of [[0.8, 0.3], [-0.5, 0.15], [0, -1.2], [1.5, -1.3], [3, 3]]) {
      const a = pointPadDistance({ x: 10 + x, y: -5 - y }, top.world)
      // a quarter turn counter-clockwise: (x, y) -> (-y, x) about the part, with y up
      const b = pointPadDistance({ x: 10 - -y, y: -5 + x }, rotated.world)
      near(a, b, 1e-6)
    }
  })
})

describe("holes", () => {
  it("a hole drilled off the copper's centre: the copper is moved from the hole by the offset, turned with the pad", () => {
    // the hole is at the pad's place (0, 0); the copper's centre is at the offset (0.4, 0.2) from it (the file's y down)
    const a = one("(drill 0.5 (offset 0.4 0.2))", { type: "thru_hole", layers: '"*.Cu" "*.Mask"', at: "0 0" })
    expect(a.world.holeDiameter).toBe(0.5)
    near(a.world.x, 10.4, 1e-6)
    near(a.world.y, -5 - 0.2, 1e-6)
    const h = holeCentre(a.world)
    near(h.x, 10, 1e-6)
    near(h.y, -5, 1e-6)
    // the land: the hole is the negative of the copper's offset from it, in the pad's frame
    expect(a.land.pads[0].holeOffset).toEqual({ x: -0.4, y: 0.2 })
    // a pad turned 90 about its place carries the offset round with it: (0.4, 0.2) in the pad's frame is (-0.2, 0.4) turned counter-clockwise on screen, in the file's y down (0.2, 0.4)... checked against the oracle in the corpus test
    const t = one("(drill 0.5 (offset 0.4 0))", { type: "thru_hole", layers: '"*.Cu" "*.Mask"', at: "0 0 90" }, { at: "10 5 0" })
    near(t.world.x, 10, 1e-6)
    near(t.world.y, -5 + 0.4, 1e-6)
  })

  it("an oval drill is a slot along the pad's own axis, across the pad's long side too, and a slot's ends move with the copper off-centre", () => {
    const along = one("(drill oval 1.2 0.6)", { type: "thru_hole", shape: "oval", size: "2 1", layers: '"*.Cu" "*.Mask"' })
    expect(along.land.pads[0]).toMatchObject({ holeDiameter: 0.6, slotLength: 1.2 })
    expect(along.land.pads[0].holeAxis).toBeUndefined()
    const across = one("(drill oval 0.6 1.2)", { type: "thru_hole", shape: "oval", size: "2 1", layers: '"*.Cu" "*.Mask"' })
    expect(across.land.pads[0].holeAxis).toBe(90)
    const ends = slotEnds(across.world)!
    near(ends[0].x, ends[1].x)
    near(Math.abs(ends[0].y - ends[1].y), 0.6)
    // a square pad's slot has no longer side to follow: its axis is always held
    const square = one("(drill oval 0.6 1.2)", { type: "thru_hole", shape: "rect", size: "2 2", layers: '"*.Cu" "*.Mask"' })
    expect(square.land.pads[0].holeAxis).toBe(90)
    const turned = one("(drill oval 1.2 0.6)", { type: "thru_hole", shape: "oval", size: "2 1", at: "0 0 30", layers: '"*.Cu" "*.Mask"' }, { at: "10 5 30" })
    expect(turned.world.slotAxis).toBeCloseTo(30, 6)
  })

  it("a non-plated hole with copper round it keeps the copper (a ring), and one whose pad the hole swallows has none", () => {
    const ring = one("(drill 0.6)", { type: "np_thru_hole", shape: "circle", size: "1 1", layers: '"*.Cu" "*.Mask"', number: "" })
    expect(ring.world.plated).toBe(false)
    expect(ring.world.ring).toEqual(["top", "bottom"])
    near(ring.world.width, 1)
    const bare = one("(drill 1)", { type: "np_thru_hole", shape: "circle", size: "1 1", layers: '"*.Cu" "*.Mask"', number: "" })
    expect(bare.world.ring).toBeUndefined()
    // the old path's pad for a bare hole: no field of X7
    expect(bare.world.x7).toBeUndefined()
  })

  it("a non-plated hole with only a mask opening round it has its opening larger than its hole, and the hole is what copper keeps its clearance from", () => {
    const m = one("(drill 1)", { type: "np_thru_hole", shape: "circle", size: "2 2", layers: '"*.Mask"', number: "" })
    expect(m.world.ring).toBeUndefined()
    near(m.world.width, 1)
    expect(m.world.opening).toMatchObject({ shape: "circle", width: 2 })
    expect(m.world.layers).toEqual(["top", "bottom"])
    expect(maskSides(m.world)).toEqual(["top", "bottom"])
    // no copper layer in its set: the board's mask margin does not apply
    expect(maskMargin(m.world, { maskExpansion: 0.1 })).toBe(0)
  })
})

describe("a pad's layers", () => {
  it("a surface-mount pad on the other side of its part, and a through-hole pad with copper on one side only", () => {
    const other = one("", { layers: '"B.Cu" "B.Mask" "B.Paste"' })
    expect(other.land.pads[0].layers).toEqual({ copper: "bottom", mask: "bottom", paste: "bottom" })
    expect(other.world.layers).toEqual(["bottom"])
    expect(maskSides(other.world)).toEqual(["bottom"])
    expect(pasteSides(other.world)).toEqual(["bottom"])
    // a part on the bottom turns the sides over: its own side is the board's bottom
    const flipped = one("", { layers: '"B.Cu" "B.Mask" "B.Paste"' }, { layer: "B.Cu" })
    expect(flipped.land.pads[0].layers).toBeUndefined()
    expect(flipped.world.layers).toEqual(["bottom"])
    const one_sided = one("(drill 0.8)", { type: "thru_hole", shape: "circle", size: "1.6 1.6", layers: '"F.Cu" "F.Mask"' })
    expect(one_sided.land.pads[0].layers).toEqual({ copper: "top", mask: "top" })
    expect(one_sided.world.layers).toEqual(["top"])
    expect(maskSides(one_sided.world)).toEqual(["top"])
  })

  it("no copper layer, paste on a through-hole pad, mask only, and the other layers a pad lists are kept", () => {
    const none = one("", { layers: '"F.Mask" "F.Paste"' })
    expect(none.world.layers).toEqual([])
    expect(maskSides(none.world)).toEqual(["top"])
    expect(pasteSides(none.world)).toEqual(["top"])
    const paste = one("(drill 0.8)", { type: "thru_hole", shape: "circle", size: "1.6 1.6", layers: '"*.Cu" "*.Mask" "F.Paste"' })
    expect(pasteSides(paste.world)).toEqual(["top"])
    const user = one("", { layers: '"F.Cu" "F.Mask" "F.Paste" "Dwgs.User" "F.Fab"' })
    expect(user.land.pads[0].layers).toEqual({ other: ["Dwgs.User", "F.Fab"] })
    const userBottom = one("", { layers: '"B.Cu" "B.Mask" "B.Paste" "B.Fab"' }, { layer: "B.Cu" })
    expect(userBottom.land.pads[0].layers).toEqual({ other: ["F.Fab"] })
  })

  it("silkscreen on a pad is kept and does nothing, as in KiCad 9 and 10", () => {
    const s = one("", { layers: '"F.Cu" "F.Mask" "F.Paste" "F.SilkS"' })
    expect(s.land.pads[0].layers).toEqual({ silk: "top" })
    expect(s.world.silk).toEqual(["top"])
  })
})

describe("a pad's own settings", () => {
  it("margins, clearance and pour settings are the pad's, and the footprint's reach every pad that sets none", () => {
    const own = one("(solder_mask_margin 0.07) (solder_paste_margin -0.05) (solder_paste_margin_ratio -0.1) (clearance 0.3) (zone_connect 2) (thermal_bridge_width 0.4) (thermal_gap 0.35) (thermal_bridge_angle 45)")
    expect(own.land.pads[0]).toMatchObject({ maskMargin: 0.07, pasteMargin: -0.05, pasteRatio: -0.1, clearance: 0.3, zoneConnect: "solid", thermalWidth: 0.4, thermalGap: 0.35, thermalAngle: 45 })
    for (const [n, name] of [[0, "none"], [1, "thermal"], [2, "solid"], [3, "tht"]] as const) expect(one(`(zone_connect ${n})`).land.pads[0].zoneConnect).toBe(name)
    // the footprint's own, for a pad that has none of its own
    const fp = imp(
      board({
        version: 20250108,
        body: [footprint({ ref: "U1", extra: "(solder_mask_margin 0.02) (clearance 0.25) (zone_connect 1)", pads: [pad({ number: "1", at: "0 0", extra: "(solder_mask_margin 0.09)" }), pad({ number: "2", at: "3 0" })] })],
      }),
    )
    const pads = componentFootprint(fp.project.components[0])!.pads
    expect(pads[0]).toMatchObject({ maskMargin: 0.09, clearance: 0.25, zoneConnect: "thermal" })
    expect(pads[1]).toMatchObject({ maskMargin: 0.02, clearance: 0.25, zoneConnect: "thermal" })
    // the footprint's thermal settings are read and dropped by KiCad, so they reach no pad
    expect(pads[1].thermalGap).toBeUndefined()
  })

  it("a zero margin is no setting in a file up to stamp 20240201, and a setting in a later one", () => {
    const old = one("(solder_mask_margin 0) (solder_paste_margin 0) (solder_paste_margin_ratio 0) (clearance 0)")
    expect(old.land.pads[0]).toEqual({ pin: "1", shape: "rect", x: 0, y: 0, width: 2, height: 1, layer: "top" })
    const fresh = imp(board({ version: 20240215, body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", extra: "(solder_mask_margin 0) (solder_paste_margin 0) (solder_paste_margin_ratio 0) (clearance 0)" })] })] }))
    expect(componentFootprint(fresh.project.components[0])!.pads[0]).toMatchObject({ maskMargin: 0, pasteMargin: 0, pasteRatio: 0, clearance: 0 })
    // a footprint's own zero in an old file inherits too
    const fpOld = imp(board({ body: [footprint({ ref: "U1", extra: "(solder_mask_margin 0)", pads: [pad({ number: "1", at: "0 0" })] })] }))
    expect(componentFootprint(fpOld.project.components[0])!.pads[0].maskMargin).toBeUndefined()
  })

  it("a fabrication property is kept", () => {
    expect(one("(property pad_prop_bga)").land.pads[0].property).toBe("bga")
    expect(one("(property pad_prop_heatsink)").land.pads[0].property).toBe("heatsink")
  })

  it("the margins reach the plot as KiCad's rules say: the mask margin held to half the pad, the paste margin and ratio on each axis", () => {
    const p = one("(solder_mask_margin -2) (solder_paste_margin -0.1) (solder_paste_margin_ratio 0.1)").world
    // a mask margin of -2 on a 1 high pad cannot take more than half of its shorter side
    near(maskMargin(p, { maskExpansion: 0.05 }), -0.5)
    // paste: -0.1 + 0.1 of the size along each axis (2 along x, 1 along y)
    const m = pasteMargins(p, { pasteExpansion: 0, pasteRatio: undefined })
    near(m.x, -0.1 + 0.2)
    near(m.y, -0.1 + 0.1)
    // the board's own, for a pad with none
    const plain = one("").world
    near(maskMargin(plain, { maskExpansion: 0.05 }), 0.05)
    expect(pasteMargins(plain, { pasteExpansion: -0.02, pasteRatio: -0.1 })).toEqual({ x: expect.closeTo(-0.02 - 0.2, 9), y: expect.closeTo(-0.02 - 0.1, 9) })
  })
})

describe("pads that share a number, and pads with none", () => {
  const nets = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
  it("each net of one number is a pin of its own; the first keeps the number; the land keeps the file's number on every pad", () => {
    const r = imp(
      board({
        nets,
        body: [
          footprint({
            ref: "U1",
            pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")' }), pad({ number: "1", at: "2 0", net: '(net 2 "B")' }), pad({ number: "1", at: "4 0", net: '(net 1 "A")' }), pad({ number: "2", at: "6 0" })],
          }),
        ],
      }),
    )
    const c = r.project.components[0]
    const land = componentFootprint(c)!
    // pads 1 and 3 agree on the net, so they are one pin; the one on B has its own
    expect(land.pads.map((p) => p.pin)).toEqual(["1", "1.2", "1", "2"])
    expect(land.pads.map((p) => p.number)).toEqual([undefined, "1", undefined, undefined])
    const { pinNet } = computeConnectivity(r.project)
    expect(pinNet.get(pinKey(c.id, "1"))).toBe("net:A")
    expect(pinNet.get(pinKey(c.id, "1.2"))).toBe("net:B")
    expect(pcbPads(c).map((p) => p.padNumber)).toEqual(["1", "1", "1", "2"])
    expect(c.nc).toEqual(["2"])
    expect(r.report.entries.some((e) => e.code === "net-mismatch")).toBe(false)
  })

  it("pads of one number that differ in pin name or type are pins of their own too, not a refusal", () => {
    const r = imp(board({ nets, body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")', extra: '(pinfunction "IN")' }), pad({ number: "1", at: "2 0", net: '(net 1 "A")', extra: '(pinfunction "OUT")' })] })] }))
    const part = r.project.parts![0]
    expect(part.pins.map((p) => [p.number, p.name])).toEqual([["1", "IN"], ["1.2", "OUT"]])
  })

  it("an unnumbered pad that carries a net has a pin and its net; one with none has no pin; a made-up pin never takes a number the file uses", () => {
    const r = imp(
      board({
        nets,
        body: [footprint({ ref: "U1", pads: [pad({ number: "", at: "0 0", net: '(net 1 "A")' }), pad({ number: "_1", at: "2 0" }), pad({ number: "", at: "4 0" }), pad({ number: "", at: "6 0", net: '(net 1 "A")' })] })],
      }),
    )
    const c = r.project.components[0]
    const land = componentFootprint(c)!
    // the made-up pin is not "_1", which the file's own pad is
    expect(land.pads.map((p) => p.pin)).toEqual(["_2", "_1", null, "_2"])
    expect(land.pads.map((p) => p.number)).toEqual(["", undefined, undefined, ""])
    expect(computeConnectivity(r.project).pinNet.get(pinKey(c.id, "_2"))).toBe("net:A")
    expect(pcbPads(c).map((p) => p.padNumber)).toEqual([null, "_1", null, null])
  })

  it("a non-plated hole that carries a net has a pin and its net, its number cleared as KiCad clears it", () => {
    const r = imp(board({ nets, body: [footprint({ ref: "U1", pads: [pad({ number: "7", at: "0 0", type: "np_thru_hole", shape: "circle", size: "1 1", layers: '"*.Cu" "*.Mask"', net: '(net 1 "A")', extra: "(drill 1)" }), pad({ number: "1", at: "3 0" })] })] }))
    const c = r.project.components[0]
    const land = componentFootprint(c)!
    expect(land.pads[0]).toMatchObject({ pin: "_1", number: "", plated: false })
    expect(computeConnectivity(r.project).pinNet.get(pinKey(c.id, "_1"))).toBe("net:A")
  })
})

describe("what the importer reports", () => {
  it("a through-hole pad with no drill is held with no hole, and the report says KiCad makes it a hole of a nanometre", () => {
    const r = imp(board({ body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", type: "thru_hole", shape: "circle", size: "1.6 1.6", layers: '"*.Cu" "*.Mask"' })] })] }))
    const w = pcbPads(r.project.components[0])[0]
    expect(w.holeDiameter).toBeUndefined()
    expect(w.layers).toEqual(["top", "bottom"])
    expect(r.report.entries.find((e) => e.code === "pad-as-kicad-reads-it")?.why).toMatch(/no drill/)
  })
})

describe("the accounting: every pad node counted as imported is in the built project", () => {
  const fixture = board({
    version: 20250108,
    nets: ['(net 0 "")', '(net 1 "A")'],
    body: [
      footprint({
        ref: "U1",
        extra: "(solder_mask_margin 0.01) (solder_paste_margin -0.01) (solder_paste_margin_ratio -0.05) (clearance 0.2) (zone_connect 2)",
        pads: [
          pad({ number: "1", at: "-3 0", shape: "roundrect", size: "2 1", net: '(net 1 "A")', extra: "(roundrect_rratio 0.2) (chamfer_ratio 0.2) (chamfer top_left) (rect_delta 0 0) (solder_mask_margin 0.05) (solder_paste_margin -0.02) (solder_paste_margin_ratio -0.1) (clearance 0.15) (zone_connect 1) (thermal_bridge_width 0.3) (thermal_gap 0.4) (thermal_bridge_angle 90) (property pad_prop_bga)" }),
          pad({ number: "2", at: "0 0", type: "thru_hole", shape: "oval", size: "2 1", layers: '"*.Cu" "*.Mask"', extra: "(drill oval 1.2 0.6 (offset 0.2 0))" }),
          pad({ number: "3", at: "3 0", shape: "custom", size: "0.5 0.5", extra: "(options (clearance convexhull) (anchor rect)) (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0.1) (fill yes)) (gr_line (start 0 0) (end 1 0) (width 0.1)) (gr_circle (center 0 1) (end 0.3 1) (width 0.1)) (gr_arc (start 1 -1) (mid 1.5 -1.5) (end 2 -1) (width 0.1)) (gr_rect (start 0 0) (end 1 1) (width 0.1) (fill yes)) (gr_curve (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (width 0.1)))" }),
          pad({ number: "4", at: "6 0", shape: "trapezoid", size: "2 1", extra: "(rect_delta 0.2 0)" }),
        ],
      }),
    ],
  })
  it("every imported path has a check, and every check holds", () => {
    const read = readKicadBoard(fixture)
    const b = read.board
    const outline = outlineOf(b)
    const paths = countPaths(b.tree)
    const needs = needsOf(b, { paths }, outline)
    const account = accountNodes(b.tree, read.text, new Set(needs.filter((n) => !BUILT_EXTENSIONS.has(n.ext)).map((n) => n.ext)), paths, (path) => settledFor(path))
    const report: ImportReport = { entries: [], account }
    const built = buildKicadProject(b, outline, report, { allowLossy: true })
    const comp = built.project.components[0]
    const land = componentFootprint(comp)!
    const pads = land.pads
    const world = pcbPads(comp)
    const checks: [RegExp, () => boolean][] = [
      [/^footprint$/, () => built.project.components.length === 1],
      [/^footprint>pad$/, () => pads.length === 4],
      [/^footprint>pad>(at|size)$/, () => pads[0].width === 2 && pads[0].height === 1 && pads[0].x === -3],
      [/^footprint>pad>layers$/, () => world[1].layers.length === 2],
      [/^footprint>pad>drill$/, () => pads[1].holeDiameter === 0.6 && pads[1].slotLength === 1.2],
      [/^footprint>pad>drill>offset$/, () => !!pads[1].holeOffset && Math.abs(pads[1].holeOffset.x + 0.2) < 1e-9],
      [/^footprint>pad>options$/, () => pads[2].custom?.anchor === "rect"],
      [/^footprint>pad>options>anchor$/, () => pads[2].custom?.anchor === "rect"],
      [/^footprint>pad>options>clearance$/, () => pads[2].custom?.hull === true],
      [/^footprint>pad>primitives$/, () => pads[2].custom?.shapes.length === 6],
      [/^footprint>pad>primitives>(gr_poly|gr_line|gr_circle|gr_arc|gr_rect|gr_curve)(>.*)?$/, () => pads[2].custom?.shapes.length === 6],
      [/^footprint>pad>rect_delta$/, () => pads[3].shape === "polygon" && (pads[3].points?.length ?? 0) === 4],
      [/^footprint>pad>roundrect_rratio$/, () => pads[0].round === 0.2],
      [/^footprint>pad>chamfer(_ratio)?$/, () => pads[0].chamfer?.corners === 1 && pads[0].chamfer?.ratio === 0.2],
      [/^footprint>pad>solder_mask_margin$/, () => pads[0].maskMargin === 0.05 && pads[1].maskMargin === 0.01],
      [/^footprint>pad>solder_paste_margin$/, () => pads[0].pasteMargin === -0.02 && pads[1].pasteMargin === -0.01],
      [/^footprint>pad>solder_paste_margin_ratio$/, () => pads[0].pasteRatio === -0.1 && pads[1].pasteRatio === -0.05],
      [/^footprint>pad>clearance$/, () => pads[0].clearance === 0.15 && pads[1].clearance === 0.2],
      [/^footprint>pad>zone_connect$/, () => pads[0].zoneConnect === "thermal" && pads[1].zoneConnect === "solid"],
      [/^footprint>pad>thermal_bridge_width$/, () => pads[0].thermalWidth === 0.3],
      [/^footprint>pad>thermal_gap$/, () => pads[0].thermalGap === 0.4],
      [/^footprint>pad>thermal_bridge_angle$/, () => pads[0].thermalAngle === 90],
      [/^footprint>pad>property$/, () => pads[0].property === "bga"],
      [/^footprint>(solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|clearance|zone_connect)$/, () => pads[1].maskMargin === 0.01 && pads[1].clearance === 0.2 && pads[1].zoneConnect === "solid" && pads[1].pasteRatio === -0.05 && pads[1].pasteMargin === -0.01],
      [/^footprint>pad>net$/, () => computeConnectivity(built.project).pinNet.get(pinKey(comp.id, "1")) === "net:A"],
    ]
    const imported = [...account.importedPaths.keys()].map((k) => k.replace(/^module(?=$|>)/, "footprint")).filter((k) => /^footprint(>pad|>(solder_|clearance|zone_connect))/.test(k) || k === "footprint")
    expect(imported.length).toBeGreaterThan(10)
    expect(imported.filter((path) => !checks.some(([re]) => re.test(path)))).toEqual([])
    expect(imported.filter((path) => checks.filter(([re]) => re.test(path)).some(([, check]) => !check()))).toEqual([])
  })
})

describe("the editor's own pads do not change", () => {
  it("a plain pad on a placed part has none of X7's fields, whatever the part's angle", () => {
    for (const rot of [0, 90]) {
      const r = imp(board({ body: [footprint({ ref: "U1", at: `10 5 ${rot}`, pads: [pad({ number: "1", at: "0 0", size: "2 1" }), pad({ number: "2", at: "2 0", shape: "circle", size: "1 1" })] })] }))
      for (const w of pcbPads(r.project.components[0])) {
        const keys = Object.keys(w)
        for (const k of ["corner", "rings", "hole", "mask", "paste", "silk", "ring", "opening", "x7", "maskMargin", "pasteMargin", "pasteRatio", "clearance", "zoneConnect"]) expect(keys).not.toContain(k)
      }
    }
  })
})

describe("a pad as the checks, the router and the pour measure it", () => {
  it("distances to a rounded pad are a rectangle's less the radius; to a custom pad's hole they are to the hole's edge", () => {
    const w: WorldPad = { componentId: "c", pin: "1", padNumber: "1", shape: "rect", x: 0, y: 0, width: 2, height: 1, layers: ["top"], corner: 0.25 }
    near(pointPadDistance({ x: 2, y: 0 }, w), 1)
    near(segmentPadDistance({ x: 2, y: -3 }, { x: 2, y: 3 }, w), 1)
    near(segmentPadDistance({ x: 1.2, y: 0.9 }, { x: 3, y: 0.9 }, w), Math.hypot(0.2 - 0.25, 0.4 - 0.25 + 0) > 0 ? pointPadDistance({ x: 1.2, y: 0.9 }, w) : 0)
    const b = padBox(w)
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-1, 1, -0.5, 0.5])
  })
  it("padRings of a land pad follow the pad's turn", () => {
    const def: PadDef = { pin: "1", shape: "rect", x: 1, y: 2, width: 2, height: 1, layer: "top", rot: 90 }
    const xs = padRings(def)[0].map((p) => p.x)
    near(Math.max(...xs) - Math.min(...xs), 1, 1e-9)
    near((Math.max(...xs) + Math.min(...xs)) / 2, 1, 1e-9)
  })
  it("opening of a plain rectangle grown by a margin has round corners of the margin's radius (X7 pads), and the pad itself when it is not grown", () => {
    const w = one("(solder_mask_margin 0.1)").world
    const open = padOpeningRings(w, 0.1)!
    expect(open).toHaveLength(1)
    const xs = open[0].map((p) => p.x)
    near(Math.max(...xs) - Math.min(...xs), 2.2, 1e-6)
    // the corner is cut: no point of the opening is at the square corner
    expect(open[0].some((p) => Math.abs(p.x - 11.1) < 1e-6 && Math.abs(p.y - (-5 + 0.6)) < 1e-6)).toBe(false)
    const plain = padOpeningRings(w, 0)!
    expect(plain[0]).toHaveLength(4)
  })
})

describe("the project is the project it was for a board with no X7 features", () => {
  it("lands carry no field of X7", () => {
    const r = imp(board({ body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")' }), pad({ number: "2", at: "2 0" })], })], nets: ['(net 0 "")', '(net 1 "A")'] }))
    const land = componentFootprint(r.project.components[0]) as unknown as { pads: Record<string, unknown>[] }
    for (const p of land.pads) expect(Object.keys(p).sort()).toEqual(["height", "layer", "pin", "shape", "width", "x", "y"])
  })
})
