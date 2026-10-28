import { describe, expect, it } from "vitest"
import { areaTouches, zoneArea } from "../src/model/zones"
import { autoroute } from "../src/model/autoroute"
import { pcbPads } from "../src/model/instances"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { clearZoneFillCache } from "../src/model/zoneFill"
import type { DesignRules, NetClass, Project } from "../src/model/types"
import { analyze, fillArea, fillOf, filled, rectangle, twoResistors, withZone } from "./zones-fixtures"

// The join of the zone fill (X3) and net classes (X10): a polygon zone keeps the largest of its own clearance, the larger of the two nets'
// class clearances and the board minimum from other nets' copper (KiCad: drc_engine.cpp 9.0 :1383-1400 and :1451-1540, 10.0 :1889-1897 and
// :1982-2063: the class value is the larger of the two items' classes, a zone's local clearance is max'ed with it and not substituted, and the
// board minimum comes last).

const cls = (name: string, extra: Partial<NetClass> = {}): NetClass => ({ name, nets: [], ...extra })
const withRules = (p: Project, rules: Partial<DesignRules>): Project => ({ ...p, rules: { ...p.rules, ...rules } })
const sigPad = (p: Project) => pcbPads(p.components[0]).find((x) => x.pin === "1")!
/** A point `d` mm above the SIG pad's top edge (the board's y runs the way the pad's does). */
const above = (p: Project, d: number) => {
  const s = sigPad(p)
  return { x: s.x, y: s.y - s.height / 2 - d }
}
const zoned = () => withZone(twoResistors(), rectangle(-12, -8, 12, 4), { net: "GND" })

describe("a polygon zone keeps the class clearance of the copper it is cleared from", () => {
  it("is pulled back further from a net whose class asks for more, and not at all when the class asks for the rules' own", () => {
    const base = zoned()
    expect(filled(fillOf(base), above(base, 0.6))).toBe(true)
    const wide = withRules(base, { netClasses: [cls("Wide", { nets: ["SIG"], clearance: 1 })] })
    expect(filled(fillOf(wide), above(wide, 0.6))).toBe(false)
    expect(filled(fillOf(wide), above(wide, 1.2))).toBe(true)
    // a class that has the rules' clearance is Default's, and changes nothing
    const same = withRules(base, { netClasses: [cls("Same", { nets: ["SIG"] })] })
    expect(fillArea(fillOf(same))).toBeCloseTo(fillArea(fillOf(base)), 6)
  })

  it("uses the larger of the two nets' classes: the zone's own net can ask for the gap as well", () => {
    const base = zoned()
    const ground = withRules(base, { netClasses: [cls("Ground", { nets: ["GND"], clearance: 1 })] })
    expect(filled(fillOf(ground), above(ground, 0.6))).toBe(false)
    expect(filled(fillOf(ground), above(ground, 1.2))).toBe(true)
  })

  it("max's a zone's own clearance with the class's, and keeps the larger", () => {
    const wide = withRules(zoned(), { netClasses: [cls("Wide", { nets: ["SIG"], clearance: 1 })] })
    // an own clearance below the class's is raised to it
    const small = { ...wide, zones: wide.zones.map((z) => ({ ...z, clearance: 0.1 })) }
    expect(fillArea(fillOf(small))).toBeCloseTo(fillArea(fillOf(wide)), 6)
    expect(filled(fillOf(small), above(small, 0.6))).toBe(false)
    // an own clearance above the class's stays
    const big = { ...wide, zones: wide.zones.map((z) => ({ ...z, clearance: 2 })) }
    expect(filled(fillOf(big), above(big, 1.5))).toBe(false)
    expect(filled(fillOf(big), above(big, 2.4))).toBe(true)
  })

  it("never goes under the board minimum", () => {
    const base = withRules(zoned(), { minClearance: 0.9 })
    expect(filled(fillOf(base), above(base, 0.6))).toBe(false)
    expect(filled(fillOf(base), above(base, 1.2))).toBe(true)
  })

  it("a zone of higher priority and another net is kept the larger of the classes' and the two zones' clearances from", () => {
    const top = (p: Project) => Math.max(...fillOf(p, "z1").polygons.flatMap((poly) => poly[0].map((q) => q.y)))
    const stack = (clearance: number) => {
      const p = withRules(zoned(), { netClasses: [cls("Far", { nets: ["SIG"], clearance })] })
      return withZone(p, rectangle(-12, 4, 12, 12), { net: "SIG", priority: 1 }, "z2")
    }
    // z2 (SIG, priority 1) cuts z1 (GND) back by its class's clearance, as it cuts it from the pads
    expect(top(stack(0.2))).toBeGreaterThan(3.5)
    expect(top(stack(1.5))).toBeLessThanOrEqual(2.5 + 0.01)
  })
})

describe("a class edit fills the zones again", () => {
  it("is not served from the fill kept for the old clearance", () => {
    clearZoneFillCache()
    const base = zoned()
    const a = fillArea(fillOf(base))
    const edited = withRules(base, { netClasses: [cls("Wide", { nets: ["SIG"], clearance: 1 })] })
    const b = fillArea(fillOf(edited))
    expect(b).toBeLessThan(a)
    // a class's members and patterns count as well: moving the net out of the class gives the first fill back
    const moved = withRules(base, { netClasses: [cls("Wide", { nets: ["OTHER"], clearance: 1 })] })
    expect(fillArea(fillOf(moved))).toBeCloseTo(a, 6)
    // and the wider class again, from the kept fills
    expect(fillArea(fillOf(edited))).toBeCloseTo(b, 9)
    // a pattern too
    const patterned = withRules(base, { netClasses: [cls("Wide", { patterns: ["SI*"], clearance: 1 })] })
    expect(fillArea(fillOf(patterned))).toBeCloseTo(b, 6)
  })

  it("is what the fill worker makes: the project it is sent (a project file) holds the classes, and its fill is the page's", () => {
    clearZoneFillCache()
    const wide = withRules(zoned(), { netClasses: [cls("Wide", { nets: ["SIG"], clearance: 1 })] })
    const direct = analyze(wide).zoneFills
    clearZoneFillCache()
    const sent = parseProjectFile(serializeProject(wide), { id: "fill", createdAt: 0, updatedAt: 0 })
    expect(sent.rules.netClasses).toEqual(wide.rules.netClasses)
    expect(analyze(sent).zoneFills).toEqual(direct)
  })
})

describe("the router keeps out of a rule area whatever the class of the net", () => {
  it("routes round a keepout with a class whose width and clearance differ", () => {
    const bare = { ...twoResistors(), traces: [] }
    const classed = withRules(bare, { netClasses: [cls("Fat", { nets: ["SIG"], clearance: 0.4, traceWidth: 0.5 })] })
    const blocked = withZone(classed, rectangle(-3, -12, 3, 12), { keepout: { tracks: true, vias: true }, layers: ["top", "bottom"] }, "k")
    const res = autoroute(blocked, { timeLimitMs: 8000 })
    for (const t of res.project.traces) {
      for (let i = 0; i + 1 < t.points.length; i++) expect(areaTouches(zoneArea(blocked.zones[0])!, [t.points[i], t.points[i + 1]], t.width / 2), "a routed trace in the keepout").toBe(false)
    }
    for (const v of res.project.vias) expect(areaTouches(zoneArea(blocked.zones[0])!, [{ x: v.x, y: v.y }], v.diameter / 2), "a via in the keepout").toBe(false)
  })
})
