import { describe, expect, it } from "vitest"
import { pcbShapes } from "../src/model/instances"
import { pointSegmentDistance } from "../src/lib/geometry"
import { arcCircle, flattenPath, type PathSeg, shapePaths } from "../src/model/shapes"
import { worldShapes } from "../src/model/shapeItems"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { type BoardShape, type Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { ALL, nearE6 as near } from "./kicad-test-helpers"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { analyzePcb } from "../src/model/pcb"
import { fillTester } from "../src/model/pour"
import { placeDesignators } from "../src/model/silk"

// Slice 1b-ii: board and footprint drawings (X8), as the importer builds them: every shape type on
// its layer, KiCad's arc, ellipse and polygon rules, a bottom footprint's land, parts with no pins,
// and what the gate and the accounting say about what is and is not carried.

const imp = (text: string) => {
  const r = importKicadBoard(text, { built: ALL })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}
/** Distance from a point to a polyline. */
const toLine = (p: { x: number; y: number }, line: { x: number; y: number }[]) => Math.min(...line.slice(1).map((q, i) => pointSegmentDistance(p, line[i], q)))
const stroke = (w = 0.15, t = "solid") => `(stroke (width ${w}) (type ${t}))`
const gr = (kind: string, body: string, layer = "F.SilkS", extra = "") => `(gr_${kind} ${body} ${stroke()} ${extra} (layer "${layer}"))`

describe("every shape on the board", () => {
  const r = imp(
    board({
      body: [
        gr("line", "(start 1 2) (end 5 2)"),
        gr("arc", "(start 0 0) (mid 1 -1) (end 2 0)", "F.Fab"),
        gr("circle", "(center 3 4) (end 5 4)", "Dwgs.User", "(fill solid)"),
        gr("rect", "(start 1 1) (end 4 3)", "B.SilkS", "(fill none)"),
        gr("poly", "(pts (xy 0 0) (xy 3 0) (xy 3 2))", "F.Mask", "(fill solid)"),
        gr("curve", "(pts (xy 0 0) (xy 1 2) (xy 3 2) (xy 4 0))", "User.7"),
        gr("line", "(start 0 0) (end 4 0)", "F.SilkS", "").replace(stroke(), stroke(0.2, "dash")),
      ],
    }),
  )
  const g = r.project.graphics!
  it("keeps each with its layer by name, y up", () => {
    expect(g.map((s) => [s.type, s.layer])).toEqual([["line", "F.SilkS"], ["arc", "F.Fab"], ["circle", "Dwgs.User"], ["rect", "B.SilkS"], ["polygon", "F.Mask"], ["curve", "User.7"], ["line", "F.SilkS"]])
    expect(g[0]).toMatchObject({ a: { x: 1, y: -2 }, b: { x: 5, y: -2 }, width: 0.15 })
  })
  it("holds an arc by its three points and a circle by its centre and radius", () => {
    expect(g[1]).toMatchObject({ type: "arc", start: { x: 0, y: 0 }, mid: { x: 1, y: 1 }, end: { x: 2, y: 0 } })
    expect(g[2]).toMatchObject({ type: "circle", c: { x: 3, y: -4 }, r: 2, fill: true })
  })
  it("keeps fill, dash and width", () => {
    expect(g[3].fill).toBeUndefined()
    expect(g[4].fill).toBe(true)
    expect(g[6]).toMatchObject({ dash: "dash", width: 0.2 })
  })
  it("keeps a curve's four points", () => {
    expect(g[5]).toMatchObject({ type: "curve", p0: { x: 0, y: 0 }, c1: { x: 1, y: -2 }, c2: { x: 3, y: -2 }, p1: { x: 4, y: 0 } })
  })
})

describe("KiCad's rules for a drawing", () => {
  it("gives an unfilled drawing with no width the default one, and lets a filled one have none", () => {
    const r = imp(board({ body: ['(gr_line (start 0 0) (end 1 0) (stroke (width 0) (type solid)) (layer "F.SilkS"))', '(gr_circle (center 5 5) (end 6 5) (stroke (width 0) (type solid)) (fill solid) (layer "F.SilkS"))'] }))
    expect(r.project.graphics![0].width).toBe(0.1)
    expect(r.project.graphics![1]).toMatchObject({ width: 0, fill: true })
  })

  it("fills a legacy polygon off Edge.Cuts that says nothing, and a zero-width legacy circle", () => {
    const r = imp(board({ version: 20200101, body: ["(gr_poly (pts (xy 0 0) (xy 2 0) (xy 2 2)) (layer F.SilkS) (width 0.1))", "(gr_circle (center 5 5) (end 6 5) (layer F.SilkS) (width 0))"] }))
    expect(r.project.graphics!.every((s) => s.fill === true)).toBe(true)
  })

  it("reads a legacy arc (centre, first end, a sweep clockwise on screen) as the arc it is", () => {
    const r = imp(board({ version: 20200101, body: ["(gr_arc (start 10 10) (end 15 10) (angle 90) (layer F.SilkS) (width 0.15))"] }))
    const a = r.project.graphics![0] as Extract<BoardShape, { type: "arc" }>
    const k = arcCircle(a.start, a.mid, a.end)!
    expect(near(k.c.x, 10) && near(k.c.y, -10) && near(k.r, 5)).toBe(true)
    // Clockwise on screen from east: the end is south of the centre (y down 15), which is y up -5 in the editor.
    expect(near(a.start.x, 15) && near(a.start.y, -10)).toBe(true)
    expect(near(a.end.x, 10) && near(a.end.y, -15)).toBe(true)
  })

  it("keeps a polygon's arc corners and an arc that closes it", () => {
    const poly = '(gr_poly (pts (xy 0 0) (xy 4 0) (arc (start 4 0) (mid 5 1) (end 4 2)) (xy 0 2) (arc (start 0 2) (mid -1 1) (end 0 0))) (stroke (width 0.1) (type solid)) (fill solid) (layer "F.SilkS"))'
    const g = imp(board({ body: [poly] })).project.graphics![0] as Extract<BoardShape, { type: "polygon" }>
    expect(g.pts).toHaveLength(4)
    expect(g.pts[2]).toMatchObject({ x: 4, y: -2, mid: { x: 5, y: -1 } })
    // The arc ending on the first corner makes the edge into it an arc.
    expect(g.pts[0]).toMatchObject({ x: 0, y: 0, mid: { x: -1, y: -1 } })
    const segs = shapePaths(g)[0].segs
    expect(segs.filter((s) => s.kind === "arc")).toHaveLength(2)
  })

  it("brings nothing for a polygon with fewer than three corners, and says how many", () => {
    const r = imp(board({ body: ['(gr_poly (pts (xy 0 0) (xy 1 0)) (stroke (width 0.1) (type solid)) (fill solid) (layer "F.SilkS"))'] }))
    expect(r.project.graphics).toBeUndefined()
    expect(r.report.entries.find((e) => e.code === "polygon-too-small")?.count).toBe(1)
  })

  it("makes a rectangle's corner radius an exact rounded outline", () => {
    const g = imp(board({ body: [gr("rect", "(start 0 0) (end 10 6) (radius 2)", "F.SilkS", "(fill none)")] })).project.graphics![0]
    expect(g).toMatchObject({ type: "rect", radius: 2 })
    const arcs = shapePaths(g)[0].segs.filter((s): s is Extract<PathSeg, { kind: "arc" }> => s.kind === "arc")
    expect(arcs).toHaveLength(4)
    for (const a of arcs) expect(near(arcCircle(a.start, a.mid, a.end)!.r, 2, 1e-9)).toBe(true)
  })

  it("makes a target a circle and two lines, as KiCad plots one", () => {
    const g = imp(board({ body: ['(target plus (at 10 10) (size 6) (width 0.2) (layer "F.SilkS"))', '(target x (at 20 10) (size 6) (width 0.2) (layer "F.Fab"))'] })).project.graphics!
    expect(g).toHaveLength(6)
    expect(g[0]).toMatchObject({ type: "circle", r: 2, c: { x: 10, y: -10 }, layer: "F.SilkS", width: 0.2 })
    expect(g[1]).toMatchObject({ type: "line", a: { x: 7, y: -10 }, b: { x: 13, y: -10 } })
    expect(g[3]).toMatchObject({ type: "circle", r: 3 })
    expect(g[4]).toMatchObject({ type: "line", a: { x: 17, y: -7 }, b: { x: 23, y: -13 } })
  })

  it("keeps a target on Edge.Cuts beside the outline, on Dwgs.User, and says where: KiCad leaves it out of the outline", () => {
    const r = imp(board({ body: ['(target plus (at 30 5) (size 3) (width 0.1) (layer "Edge.Cuts"))'] }))
    const g = r.project.graphics!
    expect(g.map((s) => [s.type, s.layer])).toEqual([["circle", "Dwgs.User"], ["line", "Dwgs.User"], ["line", "Dwgs.User"]])
    // The outline is the 20 by 10 rectangle alone.
    expect(r.project.board).toMatchObject({ width: 20, height: 10 })
    expect(r.project.board.outline?.paths.length ?? 1).toBe(1)
    expect(r.report.entries.find((e) => e.code === "target-off-edge")).toMatchObject({ severity: "note", object: "1 alignment mark on Edge.Cuts (at (30, 5))" })
  })
})

describe("ellipses (KiCad's parametric definition, turned by its rotation in the file's frame)", () => {
  const ell = (extra: string) => `(gr_ellipse (center 10 10) (major_radius 4) (minor_radius 2) (rotation_angle 30) ${extra} (stroke (width 0.1) (type solid)) (fill none) (layer "F.SilkS"))`
  const arcOf = `(gr_ellipse_arc (center 10 10) (major_radius 4) (minor_radius 2) (rotation_angle 30) (start_angle 20) (end_angle 100) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))`
  const pointAt = (c: { x: number; y: number }, rx: number, ry: number, rotDeg: number, tDeg: number) => {
    const t = (tDeg * Math.PI) / 180
    const rot = (rotDeg * Math.PI) / 180
    return { x: c.x + rx * Math.cos(t) * Math.cos(rot) - ry * Math.sin(t) * Math.sin(rot), y: c.y + rx * Math.cos(t) * Math.sin(rot) + ry * Math.sin(t) * Math.cos(rot) }
  }
  it("is the same curve after the y flip", () => {
    const g = imp(board({ body: [ell(""), arcOf] })).project.graphics!
    // The file's point at parameter t (y down), flipped, lies on the editor's curve.
    for (const [shape, from, to] of [[g[1], 20, 100]] as const) {
      const pts = flattenPath(shapePaths(shape)[0], 0.0001)
      for (let k = 0; k <= 8; k++) {
        const raw = pointAt({ x: 10, y: 10 }, 4, 2, 30, from + ((to - from) * k) / 8)
        const want = { x: raw.x, y: -raw.y }
        expect(toLine(want, pts)).toBeLessThan(0.001)
      }
    }
    expect(g[0]).toMatchObject({ type: "ellipse", rx: 4, ry: 2 })
    expect((g[0] as { from?: number }).from).toBeUndefined()
  })
  it("a footprint's ellipse on the bottom side lands where the file puts it", () => {
    const fp = footprint({ ref: "G1", name: "X:E", layer: "B.Cu", at: "50 20", pads: [pad({ at: "0 0", layers: '"B.Cu" "B.Paste" "B.Mask"' })], extra: '(fp_ellipse (center 2 1) (major_radius 3) (minor_radius 1) (rotation_angle 40) (stroke (width 0.1) (type solid)) (fill none) (layer "B.SilkS"))' })
    const r = imp(board({ body: [fp] }))
    const c = r.project.components[0]
    const s = pcbShapes(c, 2)[0]
    expect(s.layer).toBe("B.SilkS")
    // The file's stored point at parameter t, on the board: at + stored (no turn), y flipped.
    const raw = pointAt({ x: 2, y: 1 }, 3, 1, 40, 70)
    const want = { x: 50 + raw.x, y: -(20 + raw.y) }
    const pts = flattenPath(shapePaths(s)[0], 0.0001)
    expect(toLine(want, pts)).toBeLessThan(0.001)
  })
})

describe("layers", () => {
  it("reads KiCad's translated layer names as KiCad does, and names the edge layer under one as X2's", () => {
    const text = board({
      version: 3,
      layers: "(layers (15 Gorna signal) (0 Dolna signal) (21 Opisowa_Gorna user) (28 Krawedziowa user))",
      header: "(host pcbnew 2013)",
      outline: "",
      body: ["(gr_line (start 0 0) (end 4 0) (layer Opisowa_Gorna) (width 0.15))", "(gr_line (start 0 0) (end 4 0) (layer Krawedziowa) (width 0.15))"],
    })
    const r = importKicadBoard(text, { built: new Set([...ALL].filter((e) => e !== "X2")) })
    expect(r.status).toBe("refused")
    if (r.status !== "refused") return
    expect(r.needs.map((n) => n.ext)).toContain("X2")
    const ok = imp(board({ version: 3, layers: "(layers (15 Gorna signal) (0 Dolna signal) (21 Opisowa_Gorna user))", header: "(host pcbnew 2013)", body: ["(gr_line (start 0 0) (end 4 0) (layer Opisowa_Gorna) (width 0.15))"] }))
    expect(ok.project.graphics![0].layer).toBe("F.SilkS")
  })

  it("puts copper drawings on F.Cu and B.Cu whatever the table names them", () => {
    const text = board({ version: 3, layers: "(layers (15 Gorna signal) (0 Dolna signal))", header: "(host pcbnew 2013)", body: ["(gr_line (start 0 0) (end 4 0) (layer Gorna) (width 0.15))", "(gr_line (start 0 0) (end 4 0) (layer Dolna) (width 0.15))"] })
    expect(imp(text).project.graphics!.map((s) => s.layer)).toEqual(["F.Cu", "B.Cu"])
  })

  it("moves a drawing on a layer that is none of KiCad's to Cmts.User, as KiCad's rescue does, naming it, and keeps a drawing on an inner copper layer the board has", () => {
    const r = importKicadBoard(board({ body: [gr("line", "(start 0 0) (end 1 0)", "Weird.Layer")] }), { built: ALL })
    expect(r.status === "imported" && r.project.graphics?.[0].layer).toBe("Cmts.User")
    expect(r.report.entries.find((e) => e.code === "layer-rescued")?.object).toMatch(/Weird\.Layer/)
    const inner = importKicadBoard(board({ layers: '(layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))', body: [gr("line", "(start 0 0) (end 1 0)", "In1.Cu")] }))
    // the board has the layer, so the drawing is on it (X1)
    expect(inner.status === "imported" && inner.project.graphics?.[0].layer).toBe("In1.Cu")
    // a layer the table lacks is refused, named
    const lacks = importKicadBoard(board({ body: [gr("line", "(start 0 0) (end 1 0)", "In1.Cu")] }))
    expect(lacks.status === "refused" && lacks.message).toMatch(/In1\.Cu/)
  })

  it("does not carry drawings on Edge.Cuts: they are the outline", () => {
    const r = imp(board({ body: [gr("rect", "(start 0 0) (end 40 30)", "Edge.Cuts", "(fill none)")], outline: false }))
    expect(r.project.graphics).toBeUndefined()
  })

  it("a shape on a copper layer and its own side's mask is the copper and an opening grown by the mask margin", () => {
    const text = board({ setup: "(setup (pad_to_mask_clearance 0.05))", body: ['(gr_line (start 0 0) (end 4 0) (stroke (width 0.2) (type solid)) (layers "F.Cu" "F.Mask"))'] })
    const g = imp(text).project.graphics!
    expect(g.map((s) => [s.layer, s.width])).toEqual([["F.Cu", 0.2], ["F.Mask", 0.3]])
  })

  it("carries a copper drawing's net by the project's name", () => {
    const text = board({ nets: ['(net 0 "")', '(net 1 "GND")'], body: ['(gr_line (start 0 0) (end 4 0) (stroke (width 0.2) (type solid)) (layer "F.Cu") (net 1 "GND"))'] })
    expect(imp(text).project.graphics![0]).toMatchObject({ layer: "F.Cu", net: "GND" })
  })
})

describe("X24 on drawings: line ends and colours are kept, a hatched fill is refused", () => {
  const real = (text: string) => importKicadBoard(text)
  it("a drawing filled with a hatch is refused as inexact, in words: the editor holds a pour's hatch, not a drawing's", () => {
    const hatch = real(board({ body: [gr("rect", "(start 0 0) (end 4 3)", "F.SilkS", "(fill hatch)")] }))
    expect(hatch.status === "refused" && hatch.reason).toBe("inexact")
    expect(hatch.status === "refused" && hatch.message).toMatch(/a drawing filled with a hatch/)
    expect(hatch.status === "refused" && hatch.needs).toEqual([])
  })
  it("a line end shape and a drawing's colour come in with the drawing, whether it has a stroke width or not", () => {
    const ending = real(board({ body: ['(gr_line (start 0 0) (end 4 0) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (end_shape arrow (length 3) (width 2) (stroke (width 0.2) (type dash))) (start_shape circle))'] }))
    expect(ending.status).toBe("imported")
    expect(ending.status === "imported" && ending.project.graphics![0].ends).toEqual({ start: { style: "circle" }, end: { style: "arrow", length: 3, width: 2, stroke: { width: 0.2, dash: "dash" } } })
    const color = real(board({ body: ['(gr_line (start 0 0) (end 4 0) (stroke (width 0.1) (type solid) (color 255 0 0 0.5)) (layer "F.SilkS"))'] }))
    expect(color.status === "imported" && color.project.graphics![0].color).toEqual([255, 0, 0, 0.5])
  })
})

describe("a footprint's drawings", () => {
  // The file stores a bottom footprint flipped about its x axis, so the same library drawing has the other sign of y there.
  const fp = (layer: string, ref = "U1", at = "10 10") =>
    footprint({
      ref,
      name: "Pkg:Two",
      layer,
      at,
      pads: [pad({ number: "1", at: "-1 0", layers: layer === "B.Cu" ? '"B.Cu" "B.Paste" "B.Mask"' : undefined }), pad({ number: "2", at: "1 0", layers: layer === "B.Cu" ? '"B.Cu" "B.Paste" "B.Mask"' : undefined })],
      extra: `(fp_line (start -2 ${layer === "B.Cu" ? 1 : -1}) (end 2 ${layer === "B.Cu" ? 1 : -1}) ${stroke()} (layer "${layer === "B.Cu" ? "B.SilkS" : "F.SilkS"}")) (fp_rect (start -2 ${layer === "B.Cu" ? 1.5 : -1.5}) (end 2 ${layer === "B.Cu" ? -1.5 : 1.5}) ${stroke(0.05)} (fill none) (layer "${layer === "B.Cu" ? "B.CrtYd" : "F.CrtYd"}"))`,
    })

  it("is the land's, in the part's own frame, the same on both sides", () => {
    const r = imp(board({ body: [fp("F.Cu", "U1", "10 10"), fp("B.Cu", "U2", "30 10")] }))
    expect(r.project.footprints).toHaveLength(1)
    const land = r.project.footprints![0]
    expect(land.shapes!.map((s) => s.layer)).toEqual(["F.SilkS", "F.CrtYd"])
    expect(land.shapes![0]).toMatchObject({ type: "line", a: { x: -2, y: 1 }, b: { x: 2, y: 1 } })
  })

  it("lands where the file has it on a top part and on a bottom part", () => {
    const r = imp(board({ body: [fp("F.Cu", "U1", "10 10"), fp("B.Cu", "U2", "30 10")] }))
    const top = pcbShapes(r.project.components.find((c) => c.ref === "U1")!, 2)[0] as Extract<BoardShape, { type: "line" }>
    const bottom = pcbShapes(r.project.components.find((c) => c.ref === "U2")!, 2)[0] as Extract<BoardShape, { type: "line" }>
    expect(top.layer).toBe("F.SilkS")
    expect(top.a).toMatchObject({ x: 8, y: -9 })
    expect(bottom.layer).toBe("B.SilkS")
    // Stored on the board, a bottom footprint's drawing at (-2, 1) is at (30 - 2, 10 + 1) y down.
    expect([bottom.a, bottom.b].some((p) => near(p.x, 28) && near(p.y, -11))).toBe(true)
    expect([bottom.a, bottom.b].some((p) => near(p.x, 32) && near(p.y, -11))).toBe(true)
  })

  it("takes the courtyard from the drawing on its courtyard layer", () => {
    const land = imp(board({ body: [fp("F.Cu")] })).project.footprints![0]
    expect(land.courtyard).toEqual({ minX: -2, minY: -1.5, maxX: 2, maxY: 1.5 })
    expect(land.noCourtyard).toBeUndefined()
  })

  it("leaves out the footprint's drawings on a private layer, and says so", () => {
    const text = board({ body: [footprint({ ref: "U1", pads: [pad({ at: "0 0" })], extra: `(private_layers "F.Fab") (fp_line (start 0 0) (end 1 0) ${stroke()} (layer "F.Fab")) (fp_line (start 0 0) (end 1 1) ${stroke()} (layer "F.SilkS"))` })] })
    const r = imp(text)
    expect(r.project.footprints![0].shapes).toHaveLength(1)
    expect(r.report.entries.find((e) => e.code === "private-layer-drawings")?.count).toBe(1)
  })

  it("worldShapes lists the board's drawings first, then each part's, by selection id", () => {
    const r = imp(board({ body: [gr("line", "(start 0 0) (end 1 0)"), fp("F.Cu")] }))
    const w = worldShapes(r.project)
    expect(w[0].id).toMatch(/^g:/)
    expect(w[1].id).toBe(`s:${r.project.components[0].id}:0`)
  })
})

describe("a part with no pins", () => {
  const logo = footprint({ ref: "REF**", name: "Symbol:Logo", pads: [], extra: `(fp_poly (pts (xy -2 -2) (xy 2 -2) (xy 0 2)) ${stroke(0)} (fill solid) (layer "F.SilkS"))` })
  const hole = footprint({ ref: "H1", name: "MountingHole:M3", pads: ['(pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask"))'], extra: `(fp_circle (center 0 0) (end 3 0) ${stroke(0.05)} (fill none) (layer "F.CrtYd"))` })
  const r = imp(board({ body: [logo, hole] }))

  it("is a part with no pins on a land with no pads, and a mounting hole is the same with its hole", () => {
    expect(r.project.parts!.map((p) => p.pins.length)).toEqual([0, 0])
    const lands = r.project.footprints!
    expect(lands.find((l) => l.pads.length === 0)!.noCourtyard).toBe(true)
    expect(lands.find((l) => l.pads.length === 1)!.pads[0]).toMatchObject({ pin: null, plated: false })
    expect(lands.find((l) => l.pads.length === 1)!.courtyard).toEqual({ minX: -3, minY: -3, maxX: 3, maxY: 3 })
  })

  it("keeps the references the file has (REF** as REF) and says how many parts have no pins", () => {
    expect(r.project.components.map((c) => c.ref).sort()).toEqual(["H1", "REF"])
    expect(r.report.entries.find((e) => e.code === "parts-without-pins")?.count).toBe(2)
  })
})

describe("the gate and the accounting", () => {
  it("X8 is built, so a board of drawings alone imports through the real gate", () => {
    expect(BUILT_EXTENSIONS.has("X8")).toBe(true)
    const r = importKicadBoard(board({ body: [gr("line", "(start 0 0) (end 4 0)"), gr("circle", "(center 3 3) (end 4 3)", "Dwgs.User")] }))
    expect(r.status).toBe("imported")
  })

  it("a part with graphics is imported, its text and its drawings with it (X9 is built since slice 1b-iii)", () => {
    const r = importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "0 0" })] }), gr("line", "(start 0 0) (end 4 0)")] }))
    expect(r.status).toBe("imported")
    expect(r.status === "imported" && r.project.components[0].texts?.map((t) => t.kind)).toEqual(["reference", "value"])
  })

  it("counts the stroke and width of a drawing on Edge.Cuts as not needed and every other drawing's as imported", () => {
    const r = importKicadBoard(board({ body: [gr("line", "(start 0 0) (end 4 0)"), gr("line", "(start 0 1) (end 4 1)"), gr("rect", "(start 0 0) (end 40 30)", "Edge.Cuts", "(fill none)")], outline: false }))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const a = r.report.account!
    expect(a.importedPaths.get("gr_line>stroke")).toBe(2)
    expect([...a.notNeeded].find(([why]) => /board is cut along/.test(why))?.[1]).toBeGreaterThanOrEqual(1)
  })

  it("every X8 node the decision table has is settled by the builder", async () => {
    const { PATH_RULES } = await import("../src/model/kicad/board/decisions")
    const { settledFor } = await import("../src/model/kicad/board/carried")
    const unsettled = PATH_RULES.filter((r) => r.decision === "extend" && r.ext === "X8").filter((r) => {
      // A path the rule matches: its source with the alternations resolved to their first choice is awkward, so try the shapes by name.
      const re = new RegExp(r.source)
      const samples: string[] = []
      for (const root of ["gr_", "footprint>fp_"]) {
        for (const kind of ["line", "arc", "circle", "rect", "poly", "curve", "ellipse", "ellipse_arc"]) {
          for (const tail of ["", ">start", ">end", ">mid", ">center", ">layer", ">layers", ">stroke", ">stroke>type", ">stroke>width", ">width", ">fill", ">pts", ">pts>xy", ">pts>arc", ">pts>arc>start", ">pts>arc>mid", ">pts>arc>end", ">locked", ">net", ">radius", ">solder_mask_margin", ">angle", ">major_radius", ">minor_radius", ">rotation_angle", ">start_angle", ">end_angle"]) samples.push(`${root}${kind}${tail}`)
        }
      }
      samples.push("target", "target>at", "target>layer", "target>size", "target>width")
      return samples.some((p) => re.test(p) && !settledFor(p, { edge: new Map([[p, 1]]), net: new Map([[p, 1]]) }))
    })
    expect(unsettled.map((r) => r.source)).toEqual([])
  })
})

describe("a net number on a drawing that the net table lacks (KiCad logs it and loads the drawing)", () => {
  it("on a layer that is not copper the net is ignored and counted as not needed", () => {
    const r = imp(board({ nets: ['(net 0 "")', '(net 1 "GND")'], body: [`(gr_line (start 0 0) (end 4 0) ${stroke()} (layer "F.SilkS") (net 791112488))`, `(gr_line (start 0 1) (end 4 1) ${stroke()} (layer "F.Fab") (net 1 "GND"))`] }))
    expect(r.project.graphics!.map((g) => g.net)).toEqual([undefined, undefined])
    expect(r.report.entries.some((e) => e.code === "unreadable-value")).toBe(false)
    const a = r.report.account!
    expect([...a.notNeeded].find(([why]) => /not on a copper layer/.test(why))?.[1]).toBe(2)
    expect(a.importedPaths.get("gr_line>net")).toBeUndefined()
  })

  it("on copper it is no net, and the report says so; a known net is kept and counted as imported", () => {
    const r = imp(board({ nets: ['(net 0 "")', '(net 1 "GND")'], body: [`(gr_line (start 0 0) (end 4 0) ${stroke()} (layer "F.Cu") (net 99))`, `(gr_line (start 0 1) (end 4 1) ${stroke()} (layer "F.Cu") (net 1 "GND"))`] }))
    expect(r.project.graphics!.map((g) => g.net)).toEqual([undefined, "GND"])
    const e = r.report.entries.find((x) => x.code === "drawing-net-unknown")!
    expect(e.severity).toBe("changed")
    expect(e.count).toBe(1)
    expect(r.report.entries.some((x) => x.code === "unreadable-value")).toBe(false)
    expect(r.report.account!.importedPaths.get("gr_line>net")).toBe(2)
  })

  it("in a footprint too", () => {
    const r = imp(board({ body: [footprint({ pads: [pad({ at: "0 0" })], extra: `(fp_line (start 0 0) (end 1 0) ${stroke()} (layer "F.SilkS") (net 791112488))` })] }))
    expect(r.project.footprints![0].shapes).toHaveLength(1)
    expect(r.report.entries.some((x) => x.code === "unreadable-value")).toBe(false)
  })
})

describe("a negative width", () => {
  it("is the default width on an unfilled drawing, none on a filled one when it is a nanometre, and refused when it is more", () => {
    const body = (w: string, extra: string) => board({ body: [`(gr_poly (pts (xy 0 0) (xy 2 0) (xy 2 2)) (stroke (width ${w}) (type solid)) ${extra} (layer "F.SilkS"))`] })
    expect(imp(body("-1518.4", "(fill none)")).project.graphics![0].width).toBe(0.1)
    expect(imp(body("-0.000001", "(fill solid)")).project.graphics![0]).toMatchObject({ width: 0, fill: true })
    expect(importKicadBoard(body("-0.5", "(fill solid)"), { built: ALL }).status).toBe("refused")
  })
})

{
// X8 in the editor's checks: copper drawings are copper (shorts, clearance, pours, the router),
// silkscreen drawings are kept clear of by designators, and a net tie excuses only its own copper.

const imp = (text: string): Project => {
  const r = importKicadBoard(text, { built: ALL })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}
const analysis = (p: Project) => analyzePcb(p, computeConnectivity(p))
const net = (n: number, name: string) => `(net ${n} "${name}")`
const stroke = "(stroke (width 0.2) (type solid))"
const kinds = (p: Project, kind: string) => analysis(p).violations.filter((v) => v.kind === kind)
const two = (extra: string[], nets = ['(net 0 "")', net(1, "A"), net(2, "B")]) =>
  board({
    nets,
    setup: "(setup (pad_to_mask_clearance 0))",
    body: [
      footprint({ ref: "R1", at: "5 10", pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0", net: net(1, "A") })] }),
      footprint({ ref: "R2", at: "25 10", pads: [pad({ number: "1", at: "-1 0", net: net(2, "B") }), pad({ number: "2", at: "1 0", net: net(2, "B") })] }),
      ...extra,
    ],
    outline: '(gr_rect (start 0 0) (end 40 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))',
  })

describe("copper drawings are copper", () => {
  it("one with a net of its own joins that net's copper and is a short on another net's pad", () => {
    const joins = imp(two([`(gr_line (start 6 10) (end 15 10) ${stroke} (layer "F.Cu") ${net(1, "A")})`]))
    expect(kinds(joins, "short")).toEqual([])
    const shorts = imp(two([`(gr_line (start 6 10) (end 24 10) ${stroke} (layer "F.Cu") ${net(1, "A")})`]))
    expect(kinds(shorts, "short")).toHaveLength(1)
  })

  it("one with no net connects nothing, and keeps clear of a net's copper like any other copper", () => {
    const touching = imp(two([`(gr_line (start 6 10) (end 15 10) ${stroke} (layer "F.Cu"))`]))
    const a = analysis(touching)
    expect(a.violations.filter((v) => v.kind === "short")).toEqual([])
    expect(a.violations.filter((v) => v.kind === "clearance")).toHaveLength(1)
    expect(a.violations.filter((v) => v.kind === "floating-copper")).toEqual([])
    const away = imp(two([`(gr_line (start 12 4) (end 20 4) ${stroke} (layer "F.Cu"))`]))
    expect(kinds(away, "clearance")).toEqual([])
  })

  it("a filled polygon is copper inside its edge and not only along it", () => {
    const p = imp(two([`(gr_poly (pts (xy 10 8) (xy 20 8) (xy 20 12) (xy 10 12)) ${stroke} (fill solid) (layer "F.Cu") ${net(1, "A")})`]))
    // R2's pad at x 23.5 is 3.5 mm off the polygon: no clearance error; widening the copper to reach it is a short.
    expect(kinds(p, "short")).toEqual([])
    const bad = imp(two([`(gr_poly (pts (xy 10 8) (xy 24 8) (xy 24 12) (xy 10 12)) ${stroke} (fill solid) (layer "F.Cu") ${net(1, "A")})`]))
    expect(kinds(bad, "short")).toHaveLength(1)
  })

  it("a drawing on the bottom copper layer does not meet top copper", () => {
    const p = imp(two([`(gr_line (start 6 10) (end 24 10) ${stroke} (layer "B.Cu") ${net(1, "A")})`]))
    expect(kinds(p, "short")).toEqual([])
  })

  it("a pour keeps its clearance from another net's drawing and takes in the same net's", () => {
    const base = imp(two([`(gr_line (start 12 6) (end 20 6) ${stroke} (layer "F.Cu"))`]))
    const withZone: Project = { ...base, zones: [{ id: "z", net: "A", layer: "top" }] }
    const a = analysis(withZone)
    const fill = a.zoneFills[0].polygons
    const inside = fillTester(fill[0])
    // On the line it is cleared; well away from it is poured.
    expect(fill.some((poly) => fillTester(poly)({ x: 16, y: -6 }))).toBe(false)
    expect(fill.some((poly) => fillTester(poly)({ x: 16, y: -14 }))).toBe(true)
    void inside
  })

  it("the router keeps its traces off a drawing", () => {
    const p = imp(two([`(gr_line (start 15 2) (end 15 18) ${stroke} (layer "F.Cu"))`], ['(net 0 "")', net(1, "A"), net(2, "B")]))
    // Make A and B go to each other's side: a net between R1 and R2 across the drawing.
    const crossing: Project = { ...p, labels: p.labels.map((l) => (l.name === "B" ? { ...l, name: "A" } : l)), traces: [], vias: [] }
    const routed = autoroute(crossing).project
    for (const t of routed.traces) {
      if (t.layer !== "top") continue
      for (let i = 0; i + 1 < t.points.length; i++) {
        const a = t.points[i]
        const b = t.points[i + 1]
        const lo = Math.min(a.x, b.x)
        const hi = Math.max(a.x, b.x)
        // A top trace does not cross x = 15 between y -18 and -2 (the drawing, at the router's clearance).
        const crosses = lo < 15 && hi > 15 && Math.max(a.y, b.y) < -2 && Math.min(a.y, b.y) > -18
        expect(crosses).toBe(false)
      }
    }
  })

  it("a copper drawing too near the board edge is reported like a trace", () => {
    const p = imp(two([`(gr_line (start 10 0.1) (end 20 0.1) ${stroke} (layer "F.Cu"))`]))
    expect(kinds(p, "edge-clearance").length).toBeGreaterThan(0)
  })
})

describe("net ties excuse only the tie's own copper", () => {
  /** A tie of two separate pads (A on the left, B on the right) bridged by the footprint's own copper drawing. */
  const tie = (own: string, track: string[]) =>
    board({
      nets: ['(net 0 "")', net(1, "A"), net(2, "B")],
      setup: "(setup (pad_to_mask_clearance 0))",
      body: [
        footprint({ ref: "NT1", name: "NetTie:Bridge", at: "20 10", pads: [pad({ number: "1", at: "-2 0", size: "1 1", net: net(1, "A") }), pad({ number: "2", at: "2 0", size: "1 1", net: net(2, "B") })], extra: `(attr smd) (net_tie_pad_groups "1, 2") ${own}` }),
        footprint({ ref: "R1", at: "8 10", pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0", net: net(1, "A") })] }),
        footprint({ ref: "R2", at: "32 10", pads: [pad({ number: "1", at: "-1 0", net: net(2, "B") }), pad({ number: "2", at: "1 0", net: net(2, "B") })] }),
        ...track,
      ],
      outline: '(gr_rect (start 0 0) (end 40 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))',
    })
  const bridge = `(fp_line (start -2 0) (end 2 0) (stroke (width 0.4) (type solid)) (layer "F.Cu"))`
  const seg = (a: string, b: string, n: string) => `(segment (start ${a}) (end ${b}) (width 0.25) (layer "F.Cu") ${n})`

  it("the tie's own copper drawing over both pads is no short and no clearance error", () => {
    const p = imp(tie(bridge, [seg("9 10 ", "17.5 10", net(1, "A")), seg("22.5 10", "31 10", net(2, "B"))]))
    expect(kinds(p, "short")).toEqual([])
    expect(kinds(p, "clearance")).toEqual([])
  })

  it("a track of A that goes onto the tie's pad of B is a short, though the tie is there", () => {
    const p = imp(tie(bridge, [seg("9 10", "22 10", net(1, "A")), seg("23 10", "31 10", net(2, "B"))]))
    expect(kinds(p, "short").length).toBeGreaterThan(0)
  })

  it("a track of A that reaches the tie's pad of A and no further is fine", () => {
    const p = imp(tie("", [seg("9 10", "18 10", net(1, "A")), seg("22 10", "31 10", net(2, "B"))]))
    expect(kinds(p, "short")).toEqual([])
  })

  it("without a tie the bridge is a short", () => {
    const p = imp(tie(bridge.replace("(layer", "(net 1 \"A\") (layer"), []).replace(' (net_tie_pad_groups "1, 2")', ""))
    expect(kinds(p, "short").length).toBeGreaterThan(0)
  })
})

describe("silkscreen drawings and designators", () => {
  it("a designator keeps off a filled drawing on the same side, and a part with no pins has none", () => {
    const logo = footprint({ ref: "G1", name: "Symbol:Logo", at: "20 10", pads: [], extra: `(fp_poly (pts (xy -4 -4) (xy 4 -4) (xy 4 4) (xy -4 4)) (stroke (width 0) (type solid)) (fill solid) (layer "F.SilkS"))` })
    const p = imp(board({ nets: ['(net 0 "")'], body: [footprint({ ref: "R1", at: "20 10.8", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] }), logo], outline: '(gr_rect (start 0 0) (end 40 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' }))
    // A part from a KiCad board has the texts the file gives it and no designator of the editor's; without them it is a part drawn here.
    const d = placeDesignators({ ...p, components: p.components.map(({ texts: _texts, ...c }) => c) })
    const r1 = p.components.find((c) => c.ref === "R1")!
    const logoPart = p.components.find((c) => c.ref !== "R1")!
    expect(d.has(logoPart.id)).toBe(false)
    const box = d.get(r1.id)!.box
    // The filled square covers x 16..24, y -14..-6 (y up); the designator box does not overlap it.
    const overlaps = box.minX < 24 && box.maxX > 16 && box.minY < -6 && box.maxY > -14
    expect(overlaps).toBe(false)
  })
})

describe("a part with no courtyard of its own", () => {
  it("is not checked for overlap or for being off the board, but one with a courtyard is", () => {
    const logo = footprint({ ref: "G1", name: "Symbol:Logo", at: "20.5 10", pads: [], extra: `(fp_poly (pts (xy -4 -4) (xy 4 -4) (xy 4 4) (xy -4 4)) (stroke (width 0) (type solid)) (fill solid) (layer "F.SilkS"))` })
    const part = (extra: string) => footprint({ ref: "R1", at: "20 10", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra })
    const text = (body: string[]) => board({ nets: ['(net 0 "")'], body, outline: '(gr_rect (start 0 0) (end 40 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' })
    expect(kinds(imp(text([part(""), logo])), "overlap")).toEqual([])
    const outside = footprint({ ref: "G1", name: "Symbol:Logo", at: "-1 10", pads: [], extra: `(fp_line (start -4 0) (end 4 0) (stroke (width 0.15) (type solid)) (layer "F.SilkS"))` })
    expect(kinds(imp(text([outside])), "outside-board")).toEqual([])
    // A courtyard the land draws is checked; a land that draws none has none, as in KiCad (where `missing_courtyard` is a rule of its own).
    const yard = `(fp_rect (start -1.5 -0.8) (end 1.5 0.8) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))`
    const twin = (extra: string) => footprint({ ref: "R2", at: "21 10", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra })
    expect(kinds(imp(text([part(yard), twin(yard)])), "overlap").length).toBeGreaterThan(0)
    expect(kinds(imp(text([part(""), twin("")])), "overlap")).toEqual([])
  })
})
}
