import { describe, expect, it } from "vitest"
import { EXAMPLES } from "../src/model/examples"
import { dragSelection, pasteItems, placeComponent, rotateSelection, type EditResult } from "../src/model/schematicEdit"
import type { Project, Rotation } from "../src/model/types"
import { broken } from "./net-rules"
import { firstDrawn } from "./sakura-session"

// Rotate, drag, copy and drop random parts on random sheets, one action after another. Every
// action ends one of two ways, and nothing in between:
//   - it went through, and for every pin that was on the sheet: it is still on the nets it was
//     on (nothing cut loose, except by a wire cut on purpose to put a part in line), no two nets
//     that each had a name, or each held 2+ pins, were joined, and a named net kept its name; or
//   - it was refused with a sentence, and the sheet it was refused on is untouched.
// The schematic has no flip or mirror (a part turns, and that is all); the PCB's flip is a change of
// side and does not touch the netlist. SEEDS=40 runs more, FUZZ_STATS=1 prints how each ended.

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

interface Tally {
  went: number
  refused: number
  byAction: Record<string, { went: number; refused: number }>
}

/** One random action on `p`; returns the sheet to go on with. */
function act(p: Project, r: () => number, tally: Tally, label: string): Project {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const some = <T,>(xs: T[], max: number) => {
    const n = 1 + Math.floor(r() * max)
    const left = [...xs]
    const out: T[] = []
    while (out.length < n && left.length) out.push(left.splice(Math.floor(r() * left.length), 1)[0])
    return out
  }
  const parts = p.components
  if (!parts.length) return p
  const kind = pick(["rotate", "rotate", "rotate-many", "drag", "drag", "drag-with-wires", "paste", "place"])
  const snapshot = JSON.stringify(p)
  const spot = () => ({ x: Math.round((r() - 0.5) * 400) / 10, y: Math.round((r() - 0.5) * 300) / 10 })
  let res: EditResult
  switch (kind) {
    case "rotate":
      res = rotateSelection(p, { components: [pick(parts).id], labels: [] })
      break
    case "rotate-many":
      res = rotateSelection(p, { components: some(parts, 4).map((c) => c.id), labels: some(p.labels, 3).map((l) => l.id) })
      break
    case "drag":
    case "drag-with-wires": {
      const d = spot()
      res = dragSelection(
        p,
        {
          components: some(parts, 3).map((c) => c.id),
          labels: kind === "drag" ? [] : some(p.labels, 3).map((l) => l.id),
          wires: kind === "drag" || !p.wires.length ? [] : some(p.wires, 3).map((w) => w.id),
        },
        { x: d.x / 5, y: d.y / 5 },
      )
      break
    }
    case "paste": {
      const chosen = some(parts, 3).map((c) => c.id)
      const d = spot()
      res = pasteItems(p, { project: p, components: chosen, wires: some(p.wires, 2).map((w) => w.id), labels: some(p.labels, 2).map((l) => l.id) , blocks: [] }, { x: d.x / 4, y: d.y / 4 }, "paste")
      break
    }
    default: {
      const at = spot()
      res = placeComponent(p, pick(["resistor", "capacitor", "led", "ne555", "usb_c", "ground", "power"]), { sch: { ...at, rot: pick([0, 90, 180, 270]) as Rotation } })
    }
  }
  const stat = (tally.byAction[kind] ??= { went: 0, refused: 0 })
  expect(JSON.stringify(p), `${label}: ${kind} edited the sheet it was given`).toBe(snapshot)
  if (res.ok) {
    tally.went++
    stat.went++
    expect(broken(p, res.project, !!res.inline), `${label}: ${kind} went through and broke a net`).toEqual([])
    return res.project
  }
  tally.refused++
  stat.refused++
  expect(res.message, label).toMatch(/^Didn't .+: .+\. Nothing was changed\. \S/)
  return p
}

/** FUZZ_STATS=1 prints how each action ended. */
const report = (name: string, t: Tally) => {
  if (process.env.FUZZ_STATS) console.info(name, JSON.stringify(t))
}

function walk(start: Project, seed: number, steps: number, tally: Tally, name: string) {
  const r = rng(seed)
  let p = start
  for (let i = 0; i < steps; i++) p = act(p, r, tally, `${name}, action ${i + 1}`)
}

describe("random edits keep every pin on its net or are refused untouched", () => {
  const seeds = Number(process.env.SEEDS ?? 6)

  it("on the Sakura session's design, parts dropped at random spots and turns", () => {
    const tally: Tally = { went: 0, refused: 0, byAction: {} }
    for (let seed = 1; seed <= seeds; seed++) {
      const r = rng(seed * 7919)
      const at: Record<string, { x: number; y: number; rotation: number }> = {}
      for (const ref of ["U1", "U2", "U3", "J1", "SW1", "SW2", "D1", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "C1", "C2", "C3", "C4", "C5"]) {
        at[ref] = { x: Math.round((r() - 0.5) * 300) / 10, y: Math.round((r() - 0.5) * 200) / 10, rotation: [0, 90, 180, 270][Math.floor(r() * 4)] }
      }
      // Parts dropped on one another may leave connect nothing to draw; that sheet is not the test.
      let s
      try {
        s = firstDrawn({ at })
      } catch {
        continue
      }
      walk(s.project, seed, 25, tally, `session seed ${seed}`)
    }
    report("session", tally)
    expect(tally.went).toBeGreaterThan(0)
    expect(tally.refused).toBeGreaterThan(0)
  })

  it("on the Sakura session's design, placed where add_component puts it", () => {
    const tally: Tally = { went: 0, refused: 0, byAction: {} }
    for (let seed = 1; seed <= seeds; seed++) walk(firstDrawn().project, seed * 31, 25, tally, `placed seed ${seed}`)
    report("placed", tally)
    expect(tally.went).toBeGreaterThan(0)
  })

  it.each(EXAMPLES.map((e) => [e.name, e] as const))("on the example %s", (_name, example) => {
    const tally: Tally = { went: 0, refused: 0, byAction: {} }
    for (let seed = 1; seed <= Math.max(2, seeds / 3); seed++) walk(example.project, seed * 101, 20, tally, `${example.id} seed ${seed}`)
    report(example.id, tally)
    expect(tally.went + tally.refused).toBeGreaterThan(0)
  })
})
