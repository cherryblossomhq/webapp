import { writeFileSync } from "node:fs"
import { describe, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { decouplingGaps } from "../src/model/decoupling"
import { EXAMPLES } from "../src/model/examples"
import { autoPlacePcb, repackPcb } from "../src/model/ops"
import { routeAroundStitching } from "../src/model/stitch"
import { analyzePcb } from "../src/model/pcb"
import type { Project } from "../src/model/types"

// How automatic placement does on the shipped examples, as a table. Too slow for every run
// (routing the re-packed ESP32 robot takes a while), so it only runs when asked:
//
//   MEASURE_PLACEMENT=1 MEASURE_OUT=table.md npx vitest run tests/placement.measure.test.ts
//
// Each example is re-packed the way the Re-pack button does it, repackPcb(p): the placement with
// locked copper and the parts it reaches kept, and the pour's stitching vias put back. Then it is
// routed four ways: the way the Autoroute button does it (stitching vias lifted for routing and
// put back after), with no time limit as the examples are built, and with the button's own limit,
// clicked once and clicked again; with no limit and the stitching vias left in as obstacles; and
// with no limit and no stitching vias at all. "robot, no locked copper" re-packs the ESP32 robot with its
// hand fan-out removed too, so every part moves. A capacitor's gap is from its supply pad to the
// nearest pad of the supply pin it serves, copper edge to copper edge (decouplingGaps).

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const mm = (x: number) => x.toFixed(2)
const ms = (x: number) => x.toFixed(0)
const stitching = (p: Project) => p.vias.filter((v) => v.net).length

function row(name: string, shipped: Project): string {
  const before = decouplingGaps(shipped).map((g) => g.gap)
  let t = performance.now()
  const placed = autoPlacePcb(shipped, true)
  const placeMs = performance.now() - t
  t = performance.now()
  const repacked = repackPcb(shipped)
  const repackMs = performance.now() - t
  const after = decouplingGaps(repacked).map((g) => g.gap)
  const checks = analyzePcb(repacked, computeConnectivity(repacked)).violations
  const overlaps = checks.filter((v) => v.kind === "overlap").length
  const outside = checks.filter((v) => v.kind === "outside-board").length
  const far = checks.filter((v) => v.kind === "decoupling").length
  // What the Autoroute button does: the stitching vias lifted for routing and put back after.
  const untimed = routeAroundStitching(repacked, (p) => autoroute(p, { timeLimitMs: Infinity })).remaining
  const click = routeAroundStitching(repacked, (p) => autoroute(p))
  const again = routeAroundStitching(click.project, (p) => autoroute(p))
  const stitched = autoroute(repacked, { timeLimitMs: Infinity }).remaining
  const bare = autoroute(placed, { timeLimitMs: Infinity }).remaining
  return `| ${name} | ${after.length} | ${mm(median(before))} / ${mm(Math.max(...before))} | ${mm(median(after))} / ${mm(Math.max(...after))} | ${overlaps} / ${outside} | ${far} | ${stitching(shipped)} to ${stitching(repacked)} | ${untimed} | ${click.remaining} then ${again.remaining} | ${stitched} | ${bare} | ${ms(placeMs)} / ${ms(repackMs)} |`
}

describe.skipIf(!process.env.MEASURE_PLACEMENT)("placement measurement", () => {
  it("re-packs and routes every example", { timeout: 3_600_000 }, () => {
    const lines = [
      "| Example | Decoupling caps | Gap as shipped, median / worst (mm) | Gap after Re-pack | Overlaps / off board | Checks warnings | Stitching vias, shipped to re-packed | Unrouted, no limit | Unrouted, button once then twice | Unrouted, no limit, routed around stitching vias | Unrouted, no limit, no stitching | Re-pack ms, placing only / with stitching |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for (const e of EXAMPLES) lines.push(row(e.id, e.project))
    const robot = EXAMPLES.find((e) => e.id === "esp32-robot")!.project
    lines.push(row("robot, no locked copper", { ...robot, traces: [], vias: [] }))
    const table = lines.join("\n")
    console.log(table)
    if (process.env.MEASURE_OUT) writeFileSync(process.env.MEASURE_OUT, table)
  })
})
