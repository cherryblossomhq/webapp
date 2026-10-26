import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { FROZEN_EXAMPLES } from "./frozen-examples"
import { cleanupWires, dragPlan, moveSchematicItems } from "../src/model/ops"
import { dragSelection } from "../src/model/schematicEdit"
import { broken } from "./net-rules"
import { netlist, netlistDiff } from "./sakura-session"

// Every part of every shipped example, nudged and dragged. No drag is left out of the count. A drag
// on the canvas ends in one of three ways, and nothing else:
//   - the netlist is the same,
//   - the only change is a pin meeting a loose wire or an unnamed net (what drawing does), or
//   - it is refused, with a sentence, and the sheet is as it was.
// `raw` is what the same drag does with no check (the stretch and the reseat alone): those are the
// drops the check is for. FUZZ_STATS=1 prints the table.

const NUDGES = [0.1, 0.2, 0.5, 1].flatMap((n) => [{ x: n, y: 0 }, { x: -n, y: 0 }, { x: 0, y: n }, { x: 0, y: -n }])

// The netlist rule on the shipped examples and on the ones drawn before Tidy; the nudge rate on
// those only (frozen-examples.ts: a tidied sheet packs parts closer, so a nudge lands on a
// neighbour more often, and is refused as it should be).
const BOARDS = [...EXAMPLES.map((e) => [`shipped ${e.id}`, e.project, false] as const), ...FROZEN_EXAMPLES.map((e) => [e.id, e.project, true] as const)]

describe.each(BOARDS)("%s", (_id, project, rated) => {
  registerProjectParts(project)
  const base = netlist(project)

  it("every drag keeps the netlist, connects only by the lenient rule, or is refused untouched", () => {
    const table = { drags: 0, same: 0, connected: 0, refused: 0, rawChangedANet: 0, rawChangedAndRefused: 0 }
    const before = JSON.stringify(project)
    for (const c of project.components) {
      for (const delta of [...NUDGES, { x: 3, y: 2 }, { x: -6, y: 4 }]) {
        table.drags++
        const { ids, bands } = dragPlan(project, { components: [c.id], labels: [], wires: [] })
        const raw = cleanupWires(moveSchematicItems(project, ids, delta, bands))
        const rawChanged = netlistDiff(base, netlist(raw)).length > 0
        if (rawChanged) table.rawChangedANet++
        const res = dragSelection(project, { components: [c.id], labels: [], wires: [] }, delta)
        if (!res.ok) {
          table.refused++
          if (rawChanged) table.rawChangedAndRefused++
          expect(res.message, `${c.ref} by ${JSON.stringify(delta)}`).toMatch(/^Didn't move .*Nothing was changed\./)
          continue
        }
        expect(broken(project, res.project, !!res.inline), `${c.ref} by ${JSON.stringify(delta)}`).toEqual([])
        if (netlistDiff(base, netlist(res.project)).length) table.connected++
        else table.same++
      }
    }
    if (process.env.FUZZ_STATS) console.info(_id, JSON.stringify(table))
    expect(JSON.stringify(project), "the sheet is as it was").toBe(before)
    expect(table.drags).toBe(table.same + table.connected + table.refused)
    expect(table.drags).toBeGreaterThan(0)
  })

  it.runIf(rated)("lets Sakura nudge a part without refusing it, nearly always", () => {
    let calls = 0
    let refused = 0
    const why: string[] = []
    for (const c of project.components.filter((x) => !x.ref.startsWith("#"))) {
      for (const n of NUDGES) {
        calls++
        const out = runTool(project, "update_component", { ref: c.ref, x: Math.round((c.sch.x + n.x) * 10) / 10, y: Math.round((c.sch.y + n.y) * 10) / 10 })
        if (!out.isError) {
          expect(netlistDiff(base, netlist(out.project)), `${c.ref} by ${JSON.stringify(n)}`).toEqual([])
          continue
        }
        refused++
        if (why.length < 3) why.push(`${c.ref} by ${JSON.stringify(n)}: ${out.result.slice(0, 140)}`)
      }
    }
    expect(refused / calls, why.join("\n")).toBeLessThan(0.05)
  })
})
