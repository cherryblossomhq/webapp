import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { analyzePcb, followDrag } from "../src/model/pcb"
import type { Project } from "../src/model/types"

// A drag on a big board takes the analysis it began with and moves only the copper of what moved (`followDrag`, `getLiveAnalysis`): analysing the
// whole board for every frame took 18 s a frame on CERN's Macbeth.

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
    const now = followDrag(from, base, moved, sch)
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
    expect(followDrag(from, base, { ...base }, sch)).toBe(from)
  })
})
