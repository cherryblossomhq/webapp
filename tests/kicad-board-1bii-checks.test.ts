import { describe, expect, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { EXTENSION_NAMES, importKicadBoard } from "../src/model/kicad/board"
import { analyzePcb } from "../src/model/pcb"
import { fillTester } from "../src/model/pour"
import { placeDesignators } from "../src/model/silk"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// X8 in the editor's checks: copper drawings are copper (shorts, clearance, pours, the router),
// silkscreen drawings are kept clear of by designators, and a net tie excuses only its own copper.

const ALL = new Set(Object.keys(EXTENSION_NAMES))
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
    const twin = footprint({ ref: "R2", at: "21 10", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] })
    expect(kinds(imp(text([part(""), twin])), "overlap").length).toBeGreaterThan(0)
  })
})
