import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { analyzePcb } from "../src/model/pcb"
import { removeStitching, STITCH_PITCHES, stitchCount, stitchPitch, stitchVias } from "../src/model/stitch"
import { TEMPLATES } from "../src/model/templates"
import { built } from "./built"

describe("via stitching", () => {
  it.each(TEMPLATES.map((t) => t.id))("%s ties both GND pours together", (id) => {
    const p = built(id)
    const n = stitchCount(p, "GND")
    expect(n).toBeGreaterThan(0)
    const sch = computeConnectivity(p)
    const gnd = sch.nets.find((x) => x.name === "GND")!.id
    const pcb = analyzePcb(p, sch)
    for (const v of p.vias.filter((x) => x.net === "GND")) expect(pcb.viaNet.get(v.id)).toBe(gnd)
    expect(pcb.violations.filter((v) => v.severity === "error")).toEqual([])
  })

  it("replaces earlier stitching and can remove it", () => {
    const p = built("blinker")
    const before = stitchCount(p, "GND")
    const again = stitchVias(p, "GND").project
    expect(stitchCount(again, "GND")).toBe(before)
    const coarse = stitchVias(p, "GND", 8).project
    expect(stitchCount(coarse, "GND")).toBeLessThan(before)
    expect(stitchCount(removeStitching(p, "GND"), "GND")).toBe(0)
  })

  it("adds nothing without pours on both layers", () => {
    const p = built("blinker")
    const oneLayer = { ...removeStitching(p, "GND"), zones: p.zones.filter((z) => z.layer === "top") }
    expect(stitchVias(oneLayer, "GND").added).toBe(0)
  })

  it("picks a default pitch the inspector offers, opening up on large boards", () => {
    const pitch = (width: number, height: number) => stitchPitch({ width, height, x: 0, y: 0, thickness: 1.6, cornerRadius: 1 })
    for (let w = 10; w <= 300; w += 7) for (let h = 10; h <= 300; h += 11) expect(STITCH_PITCHES).toContain(pitch(w, h))
    expect(pitch(40, 26)).toBe(4)
    expect(pitch(74, 48)).toBe(4)
    expect(pitch(100, 100)).toBe(8)
  })
})
