import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearZoneFillCache } from "../src/model/zoneFill"
import type { Project } from "../src/model/types"
import { FILL_DEBOUNCE_MS, getLiveAnalysis, getPcbAnalysis, getPreviewFills, stopZoneFills, useFillTick } from "../src/store/analysis"
import { useProjectStore } from "../src/store/projectStore"
import { rectangle, twoResistors, withZone } from "./zones-fixtures"

// What the views are given while a polygon zone's fill is made again (X3): the last fill, said to be the last, and then the current one.

const api = () => useProjectStore.getState()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const moveComponent = (dx: number, dy: number, index = 0) => (p: Project): Project => ({
  ...p,
  components: p.components.map((c, i) => (i === index ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + dx, y: c.pcb.y + dy } } : c)),
})

beforeEach(() => {
  stopZoneFills()
  clearZoneFillCache()
  api().open(withZone(twoResistors(), rectangle(-19, -13, -11, -5), { net: "GND" }))
})
afterEach(() => {
  stopZoneFills()
  api().close()
})

describe("getLiveAnalysis", () => {
  it("is the exact analysis for a project with no polygon zone, and when nothing reaches the zone", () => {
    const whole = { ...api().project!, zones: [{ id: "pour", net: "GND", layer: "bottom" as const }] }
    expect(getLiveAnalysis(whole)).toBe(getPcbAnalysis(whole))
    getPcbAnalysis(api().project!)
    api().commit(moveComponent(0.5, 1, 1))
    const next = api().project!
    expect(getLiveAnalysis(next).zonesPending).toBeUndefined()
  })

  it("has nothing to show for a zone that was never filled, says so, and then shows the fill", async () => {
    const p = api().project!
    const first = getLiveAnalysis(p)
    expect(first.zonesPending).toHaveLength(1)
    expect(first.zoneFills).toEqual([])
    await sleep(FILL_DEBOUNCE_MS + 1500)
    const now = getLiveAnalysis(p)
    expect(now.zonesPending).toBeUndefined()
    expect(now.zoneFills[0].polygons.length).toBeGreaterThan(0)
  })

  it("shows the last fill and says so while an edit under the zone is filled again, then the current one", async () => {
    const before = getPcbAnalysis(api().project!)
    expect(before.zonesPending).toBeUndefined()
    api().commit(moveComponent(-11, -6))
    const edited = api().project!
    const pending = getLiveAnalysis(edited)
    expect(pending.zonesPending).toHaveLength(1)
    expect(pending.zoneFills).toEqual(before.zoneFills)
    // Asked again before the refill, it is the same answer, and no refill has started.
    expect(getLiveAnalysis(edited)).toBe(pending)
    const tick = useFillTick.getState().tick
    await sleep(FILL_DEBOUNCE_MS + 1500)
    expect(useFillTick.getState().tick).toBeGreaterThan(tick)
    const now = getLiveAnalysis(edited)
    expect(now.zonesPending).toBeUndefined()
    // What it is now is what the exact analysis says.
    expect(now.zoneFills).toEqual(getPcbAnalysis(edited).zoneFills)
    expect(now.zoneFills).not.toEqual(before.zoneFills)
  })

  it("makes one refill for edits that follow each other, and for the project as it is by then", async () => {
    getPcbAnalysis(api().project!)
    api().commit(moveComponent(-11, -6))
    getLiveAnalysis(api().project!)
    api().commit(moveComponent(0, 1))
    const last = api().project!
    expect(getLiveAnalysis(last).zonesPending).toBeDefined()
    await sleep(FILL_DEBOUNCE_MS + 1500)
    expect(getLiveAnalysis(last).zonesPending).toBeUndefined()
  })

  it("keeps the last fill during a drag and refills after the drop", async () => {
    const before = getPcbAnalysis(api().project!)
    api().beginTransient()
    api().setTransient(moveComponent(-11, -6))
    const dragged = api().project!
    expect(getLiveAnalysis(dragged).zoneFills).toEqual(before.zoneFills)
    api().endTransient()
    const dropped = api().project!
    expect(getLiveAnalysis(dropped).zonesPending).toBeDefined()
    await sleep(FILL_DEBOUNCE_MS + 1500)
    expect(getLiveAnalysis(dropped).zonesPending).toBeUndefined()
  })
})

describe("getPreviewFills", () => {
  it("fills no polygon zone on the page, and draws the fill once one is made", () => {
    // A projects page draws every project's preview: a big board's zones took minutes to fill there.
    const p = withZone(twoResistors(), rectangle(-19, -13, -11, -5), { net: "GND" })
    expect(getPreviewFills(p)).toEqual([])
    const made = getPcbAnalysis(p).zoneFills
    expect(made.length).toBeGreaterThan(0)
    expect(getPreviewFills(p)).toBe(made)
  })

  it("fills a project of whole-board pours as the analysis does", () => {
    const whole = { ...twoResistors(), zones: [{ id: "pour", net: "GND", layer: "bottom" as const }] }
    expect(getPreviewFills(whole)).toEqual(getPcbAnalysis(whole).zoneFills)
  })
})
