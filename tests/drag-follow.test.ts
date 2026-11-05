import { describe, expect, it, vi } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { analysisWithItems, analyzePcb, followEdit } from "../src/model/pcb"
import type { Project } from "../src/model/types"
import { DRAG_FOLLOW_ITEMS, getLiveAnalysis, stopZoneFills } from "../src/store/analysis"
import { useProjectStore } from "../src/store/projectStore"
import { twoResistors } from "./zones-fixtures"

// A drag on a big board takes the analysis it began with and moves only the copper of what moved (`followEdit`, `getLiveAnalysis`): analysing the
// whole board for every frame took 18 s a frame on CERN's Macbeth. An edit does too, until the checks made off the page's thread come.

/** The blinker with its tracks taken up, so that it has connections to make. */
const unrouted = (): Project => {
  const p = structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project
  return { ...p, traces: [], vias: [], zones: [] }
}

describe("an analysis that follows a drag", () => {
  it("moves the pads of the part that moved, and the ends of its connections to make, and keeps the rest", () => {
    const base = unrouted()
    const sch = computeConnectivity(base)
    const from = analyzePcb(base, sch)
    const part = base.components.find((c) => c.pcb.placed && from.ratsnest.some((r) => from.items.some((it) => it.kind === "pad" && it.pad.componentId === c.id && it.pad.x === r.a.x && it.pad.y === r.a.y)))!
    const moved: Project = { ...base, components: base.components.map((c) => (c === part ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + 5, y: c.pcb.y - 2 } } : c)) }
    const now = followEdit(from, base, moved, sch)
    const exact = analyzePcb(moved, sch)
    // The pads are where a whole analysis puts them; every other item is the one the drag began with.
    const pads = (a: typeof from) => a.items.filter((it) => it.kind === "pad" && it.pad.componentId === part.id).map((it) => it.kind === "pad" && [it.id, it.pad.x, it.pad.y])
    expect(pads(now)).toEqual(pads(exact))
    for (const it of now.items) if (!(it.kind === "pad" && it.pad.componentId === part.id)) expect(from.items).toContain(it)
    // The connections that ended on its pads end where they are now; the others are as they were.
    const ends = new Set(exact.items.flatMap((it) => (it.kind === "pad" && it.pad.componentId === part.id ? [`${it.pad.x},${it.pad.y}`] : [])))
    const touching = now.ratsnest.filter((r) => ends.has(`${r.a.x},${r.a.y}`) || ends.has(`${r.b.x},${r.b.y}`))
    expect(touching.length).toBeGreaterThan(0)
    expect(now.ratsnest).toHaveLength(from.ratsnest.length)
    // Its checks are those of the start, until the drop analyses the board again.
    expect(now.violations).toBe(from.violations)
  })

  it("is the analysis it began with when nothing has moved", () => {
    const base = unrouted()
    const sch = computeConnectivity(base)
    const from = analyzePcb(base, sch)
    expect(followEdit(from, base, { ...base }, sch)).toBe(from)
  })
})

describe("an analysis that follows an edit, and one made elsewhere", () => {
  it("drops the copper of a part that went, and the connections that ended on it", () => {
    const base = unrouted()
    const sch = computeConnectivity(base)
    const from = analyzePcb(base, sch)
    const part = base.components.find((c) => c.pcb.placed && from.items.some((it) => it.kind === "pad" && it.pad.componentId === c.id))!
    const ends = new Set(from.items.flatMap((it) => (it.kind === "pad" && it.pad.componentId === part.id ? [`${it.pad.x},${it.pad.y}`] : [])))
    const after: Project = { ...base, components: base.components.filter((c) => c !== part) }
    const now = followEdit(from, base, after, computeConnectivity(after))
    expect(now.items.some((it) => it.kind === "pad" && it.pad.componentId === part.id)).toBe(false)
    expect(now.items).toHaveLength(from.items.filter((it) => !(it.kind === "pad" && it.pad.componentId === part.id)).length)
    expect(now.ratsnest.some((r) => ends.has(`${r.a.x},${r.a.y}`) || ends.has(`${r.b.x},${r.b.y}`))).toBe(false)
  })

  it("drops the connections to make of a part that is still there but no longer on the board", () => {
    const base = unrouted()
    const sch = computeConnectivity(base)
    const from = analyzePcb(base, sch)
    const part = base.components.find((c) => c.pcb.placed && from.ratsnest.some((r) => from.items.some((it) => it.kind === "pad" && it.pad.componentId === c.id && it.pad.x === r.a.x && it.pad.y === r.a.y)))!
    const ends = new Set(from.items.flatMap((it) => (it.kind === "pad" && it.pad.componentId === part.id ? [`${it.pad.x},${it.pad.y}`] : [])))
    const after: Project = { ...base, components: base.components.map((c) => (c === part ? { ...c, pcb: { ...c.pcb, placed: false } } : c)) }
    const now = followEdit(from, base, after, computeConnectivity(after))
    expect(now.items.some((it) => it.kind === "pad" && it.pad.componentId === part.id)).toBe(false)
    expect(now.ratsnest.some((r) => ends.has(`${r.a.x},${r.a.y}`) || ends.has(`${r.b.x},${r.b.y}`))).toBe(false)
  })

  it("is the same analysis when its results are made elsewhere and its copper here", () => {
    const p = structuredClone(EXAMPLES.find((e) => e.id === "esp32-robot")!.project) as Project
    const sch = computeConnectivity(p)
    const { items, ...results } = analyzePcb(p, sch)
    const made = analysisWithItems(p, sch, results)
    expect(made.items.map((it) => it.id)).toEqual(items.map((it) => it.id))
    expect(made.violations).toBe(results.violations)
  })
})

describe("a drag on a big board, as the views ask for it", () => {
  // A drag starts from what the views were shown. Its checks or its pours' fills may still be coming from the workers, and the drag used to
  // analyse the board it began with on the page then, the fills too: minutes on CERN's Macbeth, before the part moved.
  it("starts from the analysis shown, and analyses nothing on the page", () => {
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: unknown = null
        onerror: unknown = null
        postMessage() {}
        terminate() {}
      },
    )
    const api = () => useProjectStore.getState()
    try {
      stopZoneFills()
      const small = twoResistors()
      const vias = Array.from({ length: 4100 }, (_, i) => ({ id: `v${i}`, x: -19 + (i % 80) * 0.48, y: -14 + Math.floor(i / 80) * 0.55, diameter: 0.3, drill: 0.15 }))
      api().open({ ...small, vias })
      const base = api().project!
      const shown = getLiveAnalysis(base)
      expect(shown.opening).toBe(true)
      expect(shown.items.length).toBeGreaterThan(DRAG_FOLLOW_ITEMS)
      api().beginTransient()
      expect(getLiveAnalysis(base)).toBe(shown)
      api().setTransient((p) => ({ ...p, components: p.components.map((c, i) => (i === 0 ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + 1 } } : c)) }))
      const frame = getLiveAnalysis(api().project!)
      // The opening analysis it began with, the part's copper where it is now: no analysis of the board was made for it.
      expect(frame.opening).toBe(true)
      expect(frame.violations).toBe(shown.violations)
      api().cancelTransient()
    } finally {
      stopZoneFills()
      api().close()
      vi.unstubAllGlobals()
    }
  })
})
