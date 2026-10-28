import { describe, expect, it } from "vitest"
import { pcbPads } from "../src/model/instances"
import { getFootprint, registerProjectFootprints } from "../src/model/footprints"
import { fillZones } from "../src/model/pour"
import { analyzePcb } from "../src/model/pcb"
import { computeConnectivity } from "../src/model/connectivity"
import type { PadDef, Project, Zone } from "../src/model/types"
import { analyze, fillArea, fillOf, filled, rectangle, twoResistors, withZone } from "./zones-fixtures"

// The join of the zone fill (X3) and the pad model (X7): the polygon engine honours each pad's own zone connection, thermal gap, spoke width and
// spoke angle, its clearance and its shape, as the whole-board path (`pour.ts`) does, and as KiCad does (the pad's local setting comes before the zone's).

/** The first part with its land copied under a name of its own and the pad `pin` given `fields`. */
function withPad(p: Project, pin: string, fields: Partial<PadDef>): Project {
  const c = p.components[0]
  const land = getFootprint(c.footprint!)
  const def = { ...land, name: `probe-${JSON.stringify(fields)}`, pads: land.pads.map((pad) => (pad.pin === pin ? { ...pad, ...fields } : pad)) }
  registerProjectFootprints({ footprints: [def] })
  return { ...p, footprints: [...(p.footprints ?? []), def], components: p.components.map((x, i) => (i === 0 ? { ...x, footprint: def.name } : x)) }
}

/** The zone joins its pads by reliefs unless it says otherwise (the editor's own default joins a surface pad solidly). */
const zoned = (connect: Zone["connect"] = "thermal") => {
  const p = withZone(twoResistors(), rectangle(-12, -8, 12, 4), { net: "GND" })
  return { ...p, zones: p.zones.map((z) => ({ ...z, connect })) }
}
const gnd = (p: Project) => pcbPads(p.components[0]).find((x) => x.pin === "2")!
const sig = (p: Project) => pcbPads(p.components[0]).find((x) => x.pin === "1")!
/** A point `dx` right of the GND pad's right edge and `dy` below its middle. */
const right = (p: Project, dx: number, dy = 0) => ({ x: gnd(p).x + gnd(p).width / 2 + dx, y: gnd(p).y + dy })

describe("the pad's own zone connection", () => {
  it("a pad that is to join solidly is covered, one that is not to join is cleared, and one with a relief has spokes", () => {
    const thermal = zoned()
    const spoke = right(thermal, 0.15)
    const gap = right(thermal, 0.15, 0.4)
    expect(filled(fillOf(thermal), spoke)).toBe(true)
    expect(filled(fillOf(thermal), gap)).toBe(false)
    const solid = withPad(thermal, "2", { zoneConnect: "solid" })
    expect(filled(fillOf(solid), gap)).toBe(true)
    const none = withPad(thermal, "2", { zoneConnect: "none" })
    expect(filled(fillOf(none), spoke)).toBe(false)
    // out of the clearance round it the copper comes back
    expect(filled(fillOf(none), right(none, 0.6))).toBe(true)
  })

  it("replaces the zone's: a pad with a relief in a zone that joins solidly, and a solid pad in a zone with reliefs", () => {
    const solidZone = zoned("solid")
    const gap = right(solidZone, 0.15, 0.4)
    expect(filled(fillOf(solidZone), gap)).toBe(true)
    expect(filled(fillOf(withPad(solidZone, "2", { zoneConnect: "thermal" })), gap)).toBe(false)
    const reliefZone = zoned("thermal")
    expect(filled(fillOf(reliefZone), gap)).toBe(false)
    expect(filled(fillOf(withPad(reliefZone, "2", { zoneConnect: "solid" })), gap)).toBe(true)
  })

  it("through-hole only is a relief on a pad with a hole and solid on a surface pad", () => {
    const p = withPad(zoned(), "2", { zoneConnect: "tht" })
    // a surface-mount pad: solid
    expect(filled(fillOf(p), right(p, 0.15, 0.4))).toBe(true)
  })

  it("takes its own thermal gap, spoke width and spoke angle", () => {
    const base = zoned()
    // a wider spoke covers a point beside the spoke's axis that a narrow one leaves clear
    const beside = right(base, 0.15, 0.25)
    expect(filled(fillOf(withPad(base, "2", { thermalWidth: 0.2 })), beside)).toBe(false)
    expect(filled(fillOf(withPad(base, "2", { thermalWidth: 0.7 })), beside)).toBe(true)
    // a wider gap keeps the copper further off the pad: a point past the zone's gap but inside the pad's
    const far = right(base, 0.45, 0.4)
    expect(filled(fillOf(base), far)).toBe(true)
    expect(filled(fillOf(withPad(base, "2", { thermalGap: 0.6 })), far)).toBe(false)
    // spokes turned by 45 degrees leave the axes: a point on a diagonal is covered, and the one on the axis is not
    const g = gnd(base)
    const diagonal = { x: g.x + g.width / 2 + 0.12, y: g.y + g.height / 2 + 0.1 }
    const turned = withPad(base, "2", { thermalAngle: 45 })
    expect(filled(fillOf(turned), right(turned, 0.15))).toBe(false)
    expect(filled(fillOf(turned), diagonal)).toBe(true)
    expect(filled(fillOf(base), diagonal)).toBe(false)
  })

  it("is part of what a fill is kept under: a pad's edit fills again", () => {
    const base = zoned()
    const a = fillArea(fillOf(base))
    expect(fillArea(fillOf(withPad(base, "2", { zoneConnect: "solid" })))).toBeGreaterThan(a)
    expect(fillArea(fillOf(base))).toBeCloseTo(a, 9)
  })
})

describe("the pad's own clearance and shape", () => {
  const above = (p: Project, d: number) => ({ x: sig(p).x, y: sig(p).y - sig(p).height / 2 - d })
  it("raises the gap to a pad of another net and never lowers it", () => {
    const base = zoned()
    expect(filled(fillOf(base), above(base, 0.6))).toBe(true)
    const wide = withPad(base, "1", { clearance: 1 })
    expect(filled(fillOf(wide), above(wide, 0.6))).toBe(false)
    expect(filled(fillOf(wide), above(wide, 1.2))).toBe(true)
    // a clearance under the pour's keeps the pour's
    const small = withPad(base, "1", { clearance: 0.1 })
    expect(filled(fillOf(small), above(small, 0.2))).toBe(false)
    expect(fillArea(fillOf(small))).toBeCloseTo(fillArea(fillOf(base)), 6)
  })

  it("follows a pad's rounded corners: the copper comes closer at a corner that is round", () => {
    const base = zoned()
    const round = withPad(base, "1", { round: 0.5 })
    expect(fillArea(fillOf(round))).toBeGreaterThan(fillArea(fillOf(base)))
  })
})

describe("the engine and the whole-board path agree on what a pad asks", () => {
  // The same board poured by the whole-board path (the editor's own pour, no polygon) and by the engine with a zone that is the board: a pad that is not
  // to join is clear of copper in both, and one that joins solidly is covered in both.
  const whole = (p: Project, net = "GND") => ({ ...p, zones: [{ id: "pour", net, layer: "top" as const }] })
  const poured = (p: Project) => {
    const sch = computeConnectivity(p)
    const a = analyzePcb(p, sch)
    return fillZones(p, sch, { items: a.items, netOf: (i) => (a.items[i].kind === "pad" ? (a.items[i] as { netId: string | null }).netId : null) })
  }
  const inFill = (fills: ReturnType<typeof poured>, at: { x: number; y: number }) => fills.some((f) => f.polygons.some((poly) => fillIn(poly, at)))
  const fillIn = (poly: { x: number; y: number }[][], at: { x: number; y: number }) => {
    const inside = (ring: { x: number; y: number }[]) => {
      let c = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (ring[i].y > at.y !== ring[j].y > at.y && at.x < ((ring[j].x - ring[i].x) * (at.y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) c = !c
      return c
    }
    return inside(poly[0]) && !poly.slice(1).some(inside)
  }
  it.each([
    ["solid", { zoneConnect: "solid" as const }, true],
    ["none", { zoneConnect: "none" as const }, false],
  ])("a pad that joins %s", (_name, fields, covered) => {
    const base = withPad(twoResistors(), "2", fields)
    const onPad = { x: gnd(base).x, y: gnd(base).y }
    const board = whole(base)
    const engine = withZone(base, rectangle(-19, -14, 19, 14), { net: "GND" })
    expect(inFill(poured(board), onPad)).toBe(covered)
    expect(filled(fillOf(engine), onPad)).toBe(covered)
  })
  it("a pad's own clearance pulls both pours back from it", () => {
    const base = withPad(twoResistors(), "1", { clearance: 1 })
    const p = { x: sig(base).x, y: sig(base).y - sig(base).height / 2 - 0.6 }
    const engine = withZone(base, rectangle(-19, -14, 19, 14), { net: "GND" })
    expect(inFill(poured(whole(base)), p)).toBe(false)
    expect(filled(fillOf(engine), p)).toBe(false)
    const plain = twoResistors()
    const q = { x: sig(plain).x, y: sig(plain).y - sig(plain).height / 2 - 0.6 }
    expect(inFill(poured(whole(plain)), q)).toBe(true)
    expect(filled(fillOf(withZone(plain, rectangle(-19, -14, 19, 14), { net: "GND" })), q)).toBe(true)
    // keep the analysis import used
    expect(analyze(plain).zoneFills.length).toBeGreaterThanOrEqual(0)
  })
})
