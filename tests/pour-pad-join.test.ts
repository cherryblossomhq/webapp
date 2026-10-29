import { describe, expect, it } from "vitest"
import { getFootprint, registerProjectFootprints } from "../src/model/footprints"
import { padJoinsFill } from "../src/model/pour"
import type { PadDef, Project, Zone } from "../src/model/types"
import { analyze, rectangle, twoResistors, withZone } from "./zones-fixtures"

// A through-hole pad that joins a pour by a thermal relief: the spokes cross its ring, and the drill is cut out of the fill, so the middle of the pad is in the hole
// and in no copper. The pad is joined to the pour all the same (KiCad joins copper that shares copper), and Checks must not call it unrouted
// (the arduino-shield board: eight GND pads of headers, a buzzer and a capacitor, joined to the pour by their reliefs alone, were listed as unrouted).

/** The first part with its land copied under a name of its own, both pads made through-hole pads with a drill, so that they have a ring and a hole. */
function throughHole(p: Project, fields: Partial<PadDef>): Project {
  const c = p.components[0]
  const land = getFootprint(c.footprint!)
  const def = { ...land, name: `tht-probe-${JSON.stringify(fields)}`, pads: land.pads.map((pad) => ({ ...pad, ...fields })) }
  registerProjectFootprints({ footprints: [def] })
  return { ...p, footprints: [...(p.footprints ?? []), def], components: p.components.map((x) => ({ ...x, footprint: def.name })) }
}

const pour = (connect: Zone["connect"]) => {
  const p = withZone(twoResistors(), rectangle(-12, -8, 12, 4), { net: "GND" })
  return { ...p, zones: p.zones.map((z) => ({ ...z, connect })) }
}

describe("a through-hole pad joined to a pour by its thermal relief", () => {
  const hole = { holeDiameter: 0.8, shape: "circle" as const, width: 1.6, height: 1.6, layers: ["top", "bottom"] as PadDef["layers"] }

  it("is connected: the ring touches the spokes, whatever the drill cut out of the middle", () => {
    for (const connect of ["thermal", "tht"] as const) {
      const p = throughHole(pour(connect), hole)
      const a = analyze(p)
      // the fill has no copper at the pad's centre (the drill) ...
      const pads = a.items.filter((it) => it.kind === "pad" && it.netId)
      expect(pads.length).toBeGreaterThan(0)
      // ... and still the two GND pads are one island with the pour: no ratsnest line, no unrouted warning
      expect(a.violations.filter((v) => v.kind === "unrouted" && /GND/.test(v.message))).toEqual([])
      expect(a.ratsnest.filter((r) => r.netId)).toEqual([])
    }
  })

  it("is still unrouted when the pour does not reach it (no connection)", () => {
    const p = throughHole(pour("none"), hole)
    expect(analyze(p).violations.some((v) => v.kind === "unrouted" && /GND/.test(v.message))).toBe(true)
  })

  it("padJoinsFill: a region over the ring joins, one only in the drill or far away does not", () => {
    const p = throughHole(pour("thermal"), hole)
    const pad = analyze(p).items.flatMap((it) => (it.kind === "pad" && it.pad.holeDiameter ? [it.pad] : []))[0]
    const box = (x0: number, y0: number, x1: number, y1: number) => [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]]
    const r = pad.width / 2
    expect(padJoinsFill(pad, box(pad.x + 0.45, pad.y - 0.1, pad.x + r + 0.5, pad.y + 0.1))).toBe(true)
    expect(padJoinsFill(pad, box(pad.x - 0.25, pad.y - 0.25, pad.x + 0.25, pad.y + 0.25))).toBe(false)
    expect(padJoinsFill(pad, box(pad.x + r + 0.2, pad.y - 0.1, pad.x + r + 1, pad.y + 0.1))).toBe(false)
  })
})
