import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { addComponent, addTrace, labelPin } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { clearZoneFillCache, setZoneFillCacheLimit, takeFilled } from "../src/model/zoneFill"
import type { Project } from "../src/model/types"
import { analyze, rectangle, twoResistors, withZone } from "./zones-fixtures"

// A zone's fill is kept while its inputs are the same (X3), so an edit that does not reach a zone does not fill it again, and an edit that
// does gives the fill a fresh run would give.

beforeEach(() => {
  setZoneFillCacheLimit(96)
  clearZoneFillCache()
})
afterEach(() => {
  setZoneFillCacheLimit(96)
  clearZoneFillCache()
})

const moveComponent = (p: Project, index: number, dx: number, dy = 0): Project => ({
  ...p,
  components: p.components.map((c, i) => (i === index ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + dx, y: c.pcb.y + dy } } : c)),
})

/** The fill a run with nothing kept gives. */
const cold = (p: Project) => {
  clearZoneFillCache()
  const a = analyze(p)
  takeFilled()
  return a
}

/** Two resistors with a small GND zone in the top left corner of a 40 by 30 board, away from both. */
function cornerZone() {
  return withZone(twoResistors(), rectangle(-19, -13, -11, -5), { net: "GND" })
}

describe("a kept fill", () => {
  it("is the fill a fresh run makes", () => {
    const p = cornerZone()
    const first = analyze(p)
    const again = analyze(p)
    expect(again.zoneFills).toEqual(first.zoneFills)
    expect(again.zoneFills).toEqual(cold(p).zoneFills)
    expect(first.zoneFills[0].polygons.length).toBeGreaterThan(0)
  })

  it("is reused when a part far from the zone moves, and when nothing that is copper changes", () => {
    const p = cornerZone()
    analyze(p)
    expect(takeFilled()).toHaveLength(1)
    // The right resistor is 25 mm from the zone: its pads and its copper are outside what the zone can reach.
    analyze(moveComponent(p, 1, 0.5, 1))
    expect(takeFilled()).toEqual([])
    // A name, which is no copper.
    analyze({ ...p, name: "Renamed", components: p.components.map((c) => ({ ...c, sch: { ...c.sch, x: c.sch.x + 3 } })) })
    expect(takeFilled()).toEqual([])
  })

  it("is made again when a part moves under the zone, and is then what a fresh run makes", () => {
    const p = cornerZone()
    analyze(p)
    takeFilled()
    const near = moveComponent(p, 0, -11, -6)
    const a = analyze(near)
    expect(takeFilled()).toHaveLength(1)
    expect(a.zoneFills).toEqual(cold(near).zoneFills)
  })

  it("is made again when the zone, its settings, the board or the net of copper under it changes", () => {
    const p = cornerZone()
    analyze(p)
    takeFilled()
    const edits: Project[] = [
      { ...p, zones: p.zones.map((z) => ({ ...z, clearance: 0.6 })) },
      { ...p, zones: p.zones.map((z) => ({ ...z, priority: 2 })) },
      { ...p, board: { ...p.board, width: 44 } },
      { ...p, rules: { ...p.rules, clearance: 0.5 } },
    ]
    for (const e of edits) {
      analyze(e)
      expect(takeFilled(), JSON.stringify(e.zones[0])).toHaveLength(1)
    }
  })

  it("keeps the zones that do not touch apart: an edit under one leaves the other's fill", () => {
    const base = withZone(twoResistors(), rectangle(-19, -13, -11, -5), { net: "GND" }, "za")
    const p = withZone(base, rectangle(11, 5, 19, 13), { net: "SIG" }, "zb")
    analyze(p)
    expect(takeFilled()).toHaveLength(2)
    const a = analyze(moveComponent(p, 1, 3, 4))
    const filled = takeFilled()
    expect(filled).toHaveLength(1)
    expect(filled[0].fills.map((f) => f.zoneId)).toEqual(["zb"])
    expect(a.zoneFills).toEqual(cold(moveComponent(p, 1, 3, 4)).zoneFills)
  })

  it("keeps nothing when told to keep nothing, and the same fill comes out", () => {
    const p = cornerZone()
    setZoneFillCacheLimit(0)
    const a = analyze(p)
    analyze(p)
    expect(takeFilled()).toHaveLength(2)
    setZoneFillCacheLimit(96)
    expect(analyze(p).zoneFills).toEqual(a.zoneFills)
  })

  it("lets the least recently used go when more groups are kept than the limit", () => {
    setZoneFillCacheLimit(2)
    const a = cornerZone()
    const b = { ...a, board: { ...a.board, width: 42 } }
    const c = { ...a, board: { ...a.board, width: 44 } }
    for (const p of [a, b, c]) analyze(p)
    takeFilled()
    analyze(c)
    analyze(b)
    expect(takeFilled()).toEqual([])
    analyze(a)
    expect(takeFilled()).toHaveLength(1)
  })
})

describe("filling only what is kept", () => {
  it("stands the earlier fills in for a zone that would have to be filled, and says which", () => {
    const p = cornerZone()
    const before = analyze(p)
    takeFilled()
    const near = moveComponent(p, 0, -11, -6)
    const pending = analyzePcb(near, computeConnectivity(near), { reuseOnly: { stale: before.zoneFills } })
    expect(takeFilled()).toEqual([])
    expect(pending.zonesPending).toHaveLength(1)
    expect(pending.zonesPending![0].zones).toEqual([p.zones[0].id])
    expect(pending.zoneFills).toEqual(before.zoneFills)
    // Nothing is pending when what is wanted is kept.
    expect(analyzePcb(p, computeConnectivity(p), { reuseOnly: { stale: [] } }).zonesPending).toBeUndefined()
  })
})

describe("autoroute with a polygon zone", () => {
  /** Two parts to join across a GND zone that covers the middle, on a board where the connection has to cross it. */
  function crossing(): Project {
    let p = twoResistors()
    const a = addComponent(p, "resistor", { sch: { x: 0, y: 6 }, pcb: { x: -6, y: 8, placed: true } })
    p = a.project
    const b = addComponent(p, "resistor", { sch: { x: 3, y: 6 }, pcb: { x: 6, y: 8, placed: true } })
    p = b.project
    for (const c of [a.component, b.component]) {
      p = labelPin(p, { componentId: c.id, pin: "1" }, "SIG2")
      p = labelPin(p, { componentId: c.id, pin: "2" }, "GND")
    }
    return withZone(p, rectangle(-15, -10, 15, 4), { net: "GND", layers: ["top", "bottom"] })
  }

  it("routes as it does with the zone filled at every step, and fills the zone only at the start and the end", () => {
    const p = crossing()
    const kept = autoroute(p, { timeLimitMs: 60_000 })
    const groups = takeFilled().length
    clearZoneFillCache()
    setZoneFillCacheLimit(0)
    const every = autoroute(p, { timeLimitMs: 60_000 })
    expect(kept.remaining).toBe(every.remaining)
    expect(kept.routed).toBeGreaterThan(0)
    // The result is judged by the zone as the copper left it: the kept analysis equals a fresh one.
    setZoneFillCacheLimit(96)
    const judged = analyze(kept.project)
    expect(judged.zoneFills).toEqual(cold(kept.project).zoneFills)
    expect(groups).toBeLessThanOrEqual(4)
  })

  it("leaves a board with no polygon zone alone", () => {
    let p = twoResistors()
    p = { ...p, zones: [{ id: "pour", net: "GND", layer: "bottom" }] }
    p = addTrace(p, { layer: "top", width: 0.25, points: [{ x: -6, y: 6 }, { x: 6, y: 6 }] }).project
    clearZoneFillCache()
    analyze(p)
    expect(takeFilled()).toEqual([])
  })
})
