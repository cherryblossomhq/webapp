import { describe, expect, it } from "vitest"
import { pcbPads } from "../src/model/instances"
import { addVia } from "../src/model/ops"
import { rectangle, analyze, fillArea, fillOf, filled, twoResistors, withZone } from "./zones-fixtures"
import type { Project } from "../src/model/types"

const gnd = (p: Project, ref = 0, pin = "2") => pcbPads(p.components[ref]).find((x) => x.pin === pin)!
const sig = (p: Project, ref = 0) => pcbPads(p.components[ref]).find((x) => x.pin === "1")!

describe("zone fill: the polygon and the board", () => {
  it("fills inside its polygon only, with the clearance round another net", () => {
    const p = withZone(twoResistors(), rectangle(-12, -8, 12, 4), { net: "GND" })
    const f = fillOf(p)
    expect(filled(f, { x: 0, y: -6 })).toBe(true)
    expect(filled(f, { x: 0, y: 10 })).toBe(false)
    expect(filled(f, { x: -18, y: -6 })).toBe(false)
    const s = sig(p)
    // 0.3 mm of pour clearance round a SIG pad: nothing just outside it, copper well beyond it.
    expect(filled(f, { x: s.x, y: s.y - s.height / 2 - 0.15 })).toBe(false)
    expect(filled(f, { x: s.x, y: s.y - s.height / 2 - 1.2 })).toBe(true)
  })

  it("keeps the edge clearance from the board edge, and the zone's own edge gap when it has one", () => {
    const p = withZone(twoResistors(), rectangle(-30, -30, 30, 30), { net: "GND" })
    const a = fillOf(p)
    expect(filled(a, { x: 19.9, y: -14.9 })).toBe(false)
    expect(filled(a, { x: 19.0, y: -14.0 })).toBe(true)
    const wide = { ...p, zones: p.zones.map((z) => ({ ...z, edgeGap: 2 })) }
    expect(filled(fillOf(wide), { x: 19.0, y: -14.0 })).toBe(false)
    expect(filled(fillOf(wide), { x: 17.5, y: -12.5 })).toBe(true)
  })

  it("leaves a hole of the polygon unfilled, and a zone of two layers fills both", () => {
    let p = withZone(twoResistors(), rectangle(-15, -12, 15, 3), { net: "GND", layers: ["top", "bottom"] })
    const hole = { closed: true, segs: rectangle(-2, -8, 2, -4).map((a, i, r) => ({ kind: "line" as const, a, b: r[(i + 1) % 4] })) }
    // A stitching via of the net joins the bottom copper to the net: a layer no copper of the net touches is all island, and goes.
    p = { ...p, zones: p.zones.map((z) => ({ ...z, outline: [...z.outline!, hole] })), vias: [{ id: "s", x: 10, y: -8, diameter: 0.6, drill: 0.3, net: "GND" }] }
    for (const layer of ["top", "bottom"] as const) {
      const f = fillOf(p, "z1", layer)
      expect(filled(f, { x: 0, y: -6 })).toBe(false)
      expect(filled(f, { x: 8, y: -6 })).toBe(true)
    }
  })

  it("follows the outline of a board that is not a rectangle: no copper in a cutout or off the board", () => {
    const board = {
      outline: {
        paths: [
          { closed: true, segs: rectangle(-20, -15, 20, 15).map((a, i, r) => ({ kind: "line" as const, a, b: r[(i + 1) % 4] })) },
          { closed: true, segs: rectangle(8, -10, 14, -5).map((a, i, r) => ({ kind: "line" as const, a, b: r[(i + 1) % 4] })) },
        ],
      },
    }
    const p = withZone(twoResistors(board), rectangle(-30, -30, 30, 30), { net: "GND" })
    const f = fillOf(p)
    expect(filled(f, { x: 11, y: -7.5 })).toBe(false)
    expect(filled(f, { x: 11, y: -1 })).toBe(true)
    expect(filled(f, { x: 25, y: 0 })).toBe(false)
  })
})

describe("zone fill: pads of its own net", () => {
  const spokesAt = (p: Project, padRef: number, f = fillOf(p)) => {
    const pad = gnd(p, padRef)
    const ring = pad.width / 2 + 0.3 + 0.1
    const probe = (dx: number, dy: number) => filled(f, { x: pad.x + dx * ring, y: pad.y + dy * ring })
    return { right: probe(1, 0), left: probe(-1, 0), up: probe(0, 1), down: probe(0, -1), corner: probe(0.7, 0.7) }
  }

  it("a thermal relief clears a ring round the pad and leaves four spokes, along the axes of a rectangular pad", () => {
    const p = withZone(twoResistors(), rectangle(-12, -8, 12, 8), { net: "GND", connect: "thermal", clearance: 0.3, spokeWidth: 0.4, thermalGap: 0.3 })
    const f = fillOf(p)
    const pad = gnd(p, 0)
    // The ring gap itself (between the pad and the copper) is bare away from the spokes.
    expect(filled(f, { x: pad.x + pad.width / 2 + 0.15, y: pad.y + pad.height / 2 + 0.15 })).toBe(false)
    // A spoke along x leaves the pad's right side and reaches the copper beyond the ring.
    expect(filled(f, { x: pad.x + pad.width / 2 + 0.15, y: pad.y })).toBe(true)
    expect(filled(f, { x: pad.x, y: pad.y + pad.height / 2 + 0.15 })).toBe(true)
    expect(filled(f, { x: pad.x, y: pad.y - pad.height / 2 - 0.15 })).toBe(true)
    expect(spokesAt(p, 0, f).corner).toBe(false)
  })

  it("solid joins the pad with no gap, none keeps the clearance all round", () => {
    const solid = withZone(twoResistors(), rectangle(-12, -8, 12, 8), { net: "GND", connect: "solid" })
    const pad = gnd(solid, 0)
    expect(filled(fillOf(solid), { x: pad.x + pad.width / 2 + 0.15, y: pad.y + pad.height / 2 + 0.15 })).toBe(true)
    const none = withZone(twoResistors(), rectangle(-12, -8, 12, 8), { net: "GND", connect: "none", clearance: 0.3 })
    const fn = fillOf(none)
    expect(filled(fn, { x: pad.x + pad.width / 2 + 0.15, y: pad.y })).toBe(false)
    expect(filled(fn, { x: pad.x + pad.width / 2 + 0.15, y: pad.y + pad.height / 2 + 0.15 })).toBe(false)
    // And with no spokes nothing joins the pour to the pad, so the net is left to route.
    expect(analyze(none).ratsnest.length).toBeGreaterThan(0)
    expect(analyze(solid).ratsnest.length).toBe(0)
  })

  it("through-hole only: a surface-mount pad is joined solidly", () => {
    const p = withZone(twoResistors(), rectangle(-12, -8, 12, 8), { net: "GND", connect: "tht" })
    const pad = gnd(p, 0)
    expect(pad.holeDiameter).toBeUndefined()
    expect(filled(fillOf(p), { x: pad.x + pad.width / 2 + 0.15, y: pad.y + pad.height / 2 + 0.15 })).toBe(true)
  })

  it("a spoke thinner than the minimum width is not made, so the relief leaves the pad alone", () => {
    const p = withZone(twoResistors(), rectangle(-12, -8, 12, 8), { net: "GND", connect: "thermal", spokeWidth: 0.1, minWidth: 0.25, thermalGap: 0.3 })
    const pad = gnd(p, 0)
    expect(filled(fillOf(p), { x: pad.x + pad.width / 2 + 0.15, y: pad.y })).toBe(false)
  })
})

describe("zone fill: priority and keepouts", () => {
  it("a zone of higher priority and another net cuts into the lower one, with the gap", () => {
    let p = withZone(twoResistors(), rectangle(-15, -10, 15, 4), { net: "GND", priority: 0 }, "low")
    p = withZone(p, rectangle(-3, -9, 3, -2), { net: "SIG", priority: 1 }, "high")
    const low = fillOf(p, "low")
    const high = fillOf(p, "high")
    expect(filled(high, { x: 0, y: -6 })).toBe(true)
    expect(filled(low, { x: 0, y: -6 })).toBe(false)
    expect(filled(low, { x: 3.1, y: -6 })).toBe(false)
    expect(filled(low, { x: 4.2, y: -6 })).toBe(true)
  })

  it("the same priority is settled by the order, the later zone first", () => {
    let p = withZone(twoResistors(), rectangle(-15, -10, 15, 4), { net: "GND" }, "first")
    p = withZone(p, rectangle(-3, -9, 3, -2), { net: "SIG" }, "second")
    expect(filled(fillOf(p, "first"), { x: 0, y: -6 })).toBe(false)
    expect(filled(fillOf(p, "second"), { x: 0, y: -6 })).toBe(true)
  })

  it("a zone of the same net and higher priority takes over its own polygon, with no gap between them", () => {
    let p = withZone(twoResistors(), rectangle(-15, -10, 15, 4), { net: "GND", priority: 0, minWidth: 0.25 }, "low")
    p = withZone(p, rectangle(-3, -9, 3, -2), { net: "GND", priority: 1, connect: "none" }, "high")
    expect(filled(fillOf(p, "low"), { x: 0, y: -6 })).toBe(false)
    expect(filled(fillOf(p, "high"), { x: 0, y: -6 })).toBe(true)
    expect(filled(fillOf(p, "low"), { x: 3.4, y: -6 })).toBe(true)
  })

  it("a keepout that keeps pours out leaves its area bare, with no gap round it", () => {
    let p = withZone(twoResistors(), rectangle(-15, -10, 15, 4), { net: "GND" })
    p = withZone(p, rectangle(-3, -9, 3, -2), { keepout: { pour: true } }, "k")
    const f = fillOf(p)
    expect(filled(f, { x: 0, y: -6 })).toBe(false)
    expect(filled(f, { x: 3.2, y: -6 })).toBe(true)
    // A keepout is not a pour: it has no fill of its own.
    expect(analyze(p).zoneFills.find((x) => x.zoneId === "k")).toBeUndefined()
  })

  it("a keepout that keeps only tracks out does not touch the pour", () => {
    let p = withZone(twoResistors(), rectangle(-15, -10, 15, 4), { net: "GND" })
    p = withZone(p, rectangle(-3, -9, 3, -2), { keepout: { tracks: true } }, "k")
    expect(filled(fillOf(p), { x: 0, y: -6 })).toBe(true)
  })
})

describe("zone fill: thinnest copper, smoothing, islands", () => {
  it("removes copper thinner than the minimum width and keeps copper as wide", () => {
    const thin = withZone(twoResistors(), rectangle(-12, -9, 12, -8.5), { net: "GND", minWidth: 1 })
    expect(fillOf(thin).polygons).toEqual([])
    const ok = withZone(twoResistors(), rectangle(-12, -10, 12, -8.5), { net: "GND", minWidth: 1 })
    expect(fillArea(fillOf(ok))).toBeGreaterThan(20)
  })

  it("rounds the corners of the polygon by a fillet and cuts them by a chamfer, never adding copper outside it", () => {
    const sharp = withZone(twoResistors(), rectangle(-12, -10, 12, -3), { net: "GND" })
    const round = withZone(twoResistors(), rectangle(-12, -10, 12, -3), { net: "GND", smoothing: { kind: "fillet", radius: 3 } })
    const cut = withZone(twoResistors(), rectangle(-12, -10, 12, -3), { net: "GND", smoothing: { kind: "chamfer", radius: 3 } })
    const a = fillArea(fillOf(sharp))
    const b = fillArea(fillOf(round))
    const c = fillArea(fillOf(cut))
    expect(b).toBeLessThan(a)
    expect(c).toBeLessThan(b)
    // A corner of the rectangle (not on the board's edge clearance) is bare in both.
    expect(filled(fillOf(round), { x: -11.9, y: -9.9 })).toBe(false)
    expect(filled(fillOf(round), { x: -8, y: -6 })).toBe(true)
  })

  it("removes an island no copper of its net touches, keeps it when the zone says never, and removes it only when small by area", () => {
    // A pour with a block of another net's copper (a SIG trace) cutting a corner off, where no GND pad is.
    const base = twoResistors()
    const wall = { ...base, traces: [...base.traces, { id: "w", layer: "top" as const, width: 0.4, net: "SIG", points: [{ x: 8, y: -14 }, { x: 8, y: 5 }] }] }
    const zone = (extra: object) => withZone(wall, rectangle(-15, -13, 15, 3), { net: "GND", ...extra })
    const keep = analyze(zone({}), true).zoneFills[0]
    const gone = analyze(zone({})).zoneFills[0]
    const never = analyze(zone({ islands: "never" })).zoneFills[0]
    // The strip right of the wall (x from 8.5 to 15) holds no GND pad: an island.
    expect(filled(gone, { x: 12, y: -8 })).toBe(false)
    expect(filled(keep, { x: 12, y: -8 })).toBe(true)
    expect(filled(never, { x: 12, y: -8 })).toBe(true)
    const small = analyze(zone({ islands: 5 })).zoneFills[0]
    // 5 mm² is smaller than that strip, so it stays; 500 mm² is not.
    expect(filled(small, { x: 12, y: -8 })).toBe(true)
    expect(filled(analyze(zone({ islands: 500 })).zoneFills[0], { x: 12, y: -8 })).toBe(false)
  })

  it("a zone with no net keeps clear of every net and keeps all its copper", () => {
    const p = withZone(twoResistors(), rectangle(-12, -10, 12, 4), { net: "" })
    const f = fillOf(p)
    const s = sig(p)
    const g = gnd(p, 1)
    expect(filled(f, { x: s.x, y: s.y - s.height / 2 - 0.15 })).toBe(false)
    expect(filled(f, { x: g.x, y: g.y - g.height / 2 - 0.15 })).toBe(false)
    expect(filled(f, { x: 0, y: -8 })).toBe(true)
  })

  it("a teardrop zone joins its own net's pad solidly and is cut by another net's copper", () => {
    const p0 = twoResistors()
    const pad = gnd(p0, 0)
    const poly = [
      { x: pad.x - 0.2, y: pad.y - 0.2 },
      { x: pad.x + 2.5, y: pad.y - 0.2 },
      { x: pad.x + 2.5, y: pad.y + 0.2 },
      { x: pad.x - 0.2, y: pad.y + 0.2 },
    ]
    const p = withZone(p0, poly, { net: "GND", teardrop: "padvia" } as never)
    const f = fillOf({ ...p, zones: p.zones.map((z) => ({ ...z, teardrop: "padvia" as const, minWidth: 0.1, connect: "thermal" as const })) })
    expect(filled(f, { x: pad.x + 0.1, y: pad.y })).toBe(true)
  })

  it("an unnetted vias and traces of the same net stay inside the copper, other nets are cleared", () => {
    let p = withZone(twoResistors(), rectangle(-12, -10, 12, 4), { net: "GND" })
    p = addVia(p, { x: 0, y: -6 }).project
    // A via on no net is another net's copper to a pour.
    expect(filled(fillOf(p), { x: 0, y: -6 })).toBe(false)
  })
})
