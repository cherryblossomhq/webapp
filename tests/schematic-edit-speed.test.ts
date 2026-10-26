import { describe, expect, it } from "vitest"
import { EXAMPLES } from "../src/model/examples"
import { dragPlan, moveSchematicItems } from "../src/model/ops"
import { guardDrop, rotateSelection } from "../src/model/schematicEdit"
import type { Project } from "../src/model/types"
import { getConnectivity } from "../src/store/analysis"

// A drag plans once on pointer down, moves the part on every frame, and checks once, on the drop;
// R checks once. All of it has to be quick on a big sheet. The sheets are the ESP32 robot (45 parts,
// 130 wires) laid side by side, up to 315 parts and 910 wires. The bounds are the median of several
// runs with room for a slow machine; FUZZ_STATS=1 prints what they were.

function tiled(base: Project, copies: number): Project {
  const xs = base.components.map((c) => c.sch.x)
  const width = Math.max(...xs) - Math.min(...xs) + 30
  let out: Project = { ...base, components: [], wires: [], labels: [] }
  for (let i = 0; i < copies; i++) {
    const dx = i * width
    out = {
      ...out,
      components: [...out.components, ...base.components.map((c) => ({ ...c, id: `${c.id}_${i}`, ref: `${c.ref}_${i}`, sch: { ...c.sch, x: c.sch.x + dx } }))],
      wires: [...out.wires, ...base.wires.map((w) => ({ ...w, id: `${w.id}_${i}`, points: w.points.map((p) => ({ x: p.x + dx, y: p.y })) }))],
      labels: [...out.labels, ...base.labels.map((l) => ({ ...l, id: `${l.id}_${i}`, x: l.x + dx }))],
    }
  }
  return out
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/** Median of a few runs, in ms; `setup` makes what each run starts from and is not timed. */
function time<T>(setup: () => T, f: (x: T) => unknown, runs = 7) {
  const out: number[] = []
  for (let i = 0; i < runs; i++) {
    const x = setup()
    const t0 = performance.now()
    f(x)
    out.push(performance.now() - t0)
  }
  return median(out)
}

describe("planning a drag, a frame, a drop and a turn on a big sheet are quick", () => {
  const esp = EXAMPLES.find((e) => e.id === "esp32-robot")!.project
  it.each([
    // copies, planMs, coldFrameMs, frameMs, dropMs, turnMs
    [1, 40, 40, 16, 100, 100],
    [2, 40, 40, 16, 150, 150],
    // 315 parts: a drop is about 150 ms and a turn 120 ms; a real regression was 4,400 ms, so the room is for a loaded machine.
    [7, 100, 100, 16, 1200, 1200],
  ])("on %i copies of the ESP32 robot", (copies, planMs, coldMs, frameMs, dropMs, turnMs) => {
    const p = copies === 1 ? esp : tiled(esp, copies)
    getConnectivity(p) // the editor has drawn the sheet with it already
    const target = p.components.find((c) => c.ref.startsWith("R5"))!
    const picked = { components: [target.id], labels: [], wires: [] as string[] }
    // Each run is on a sheet nobody has looked at yet, as the first drag after an edit is.
    const fresh = () => {
      const q = { ...p }
      getConnectivity(q)
      return q
    }
    const plan = time(fresh, (q) => dragPlan(q, picked))
    const cold = time(
      () => {
        const q = fresh()
        return { q, ...dragPlan(q, picked) }
      },
      ({ q, ids, bands }) => moveSchematicItems(q, ids, { x: 0.5, y: 0.3 }, bands, getConnectivity(q)),
    )
    const warm = time(
      () => {
        const q = fresh()
        const plan = dragPlan(q, picked)
        moveSchematicItems(q, plan.ids, { x: 0.2, y: 0.1 }, plan.bands, getConnectivity(q))
        return { q, ...plan }
      },
      ({ q, ids, bands }) => moveSchematicItems(q, ids, { x: 0.5, y: 0.3 }, bands, getConnectivity(q)),
    )
    const { ids, bands } = dragPlan(p, picked)
    const moved = moveSchematicItems(p, ids, { x: 0.5, y: 0.5 }, bands, getConnectivity(p))
    const drop = time(() => undefined, () => guardDrop(p, moved, picked, { conn: getConnectivity }))
    const turn = time(() => undefined, () => rotateSelection(p, { components: [target.id], labels: [] }, { conn: getConnectivity }))
    if (process.env.FUZZ_STATS) {
      console.info(`${p.components.length} parts, ${p.wires.length} wires: plan ${plan.toFixed(1)} ms, first frame ${cold.toFixed(1)} ms, frame ${warm.toFixed(1)} ms, drop ${drop.toFixed(1)} ms, turn ${turn.toFixed(1)} ms`)
    }
    expect(plan).toBeLessThan(planMs)
    expect(cold).toBeLessThan(coldMs)
    expect(warm).toBeLessThan(frameMs)
    expect(drop).toBeLessThan(dropMs)
    expect(turn).toBeLessThan(turnMs)
  })
})
