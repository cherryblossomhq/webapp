import { writeFileSync } from "node:fs"
import { describe, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { groundNetIds, isChip, isSupplyPin, padGap } from "../src/model/decoupling"
import { pcbPads } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { EXAMPLES } from "../src/model/examples"
import { autoPlacePcb } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { powerStages, stageGaps } from "../src/model/powerStage"
import type { Project } from "../src/model/types"
import { boostDesign, buckDesign, ldoDesign } from "./powerStageFixtures"

// How the power stage rules change placement, as a table. Slow (it routes every board), so it
// only runs when asked:
//
//   MEASURE_POWERSTAGE=1 MEASURE_OUT=table.md npx vitest run tests/power-stage.measure.test.ts
//
// Each board is placed from scratch the way Re-pack does it, once without the rules
// (`powerStage: false`) and once with them. "Loop" columns are pad-to-pad gaps in mm between a
// stage part and the pin it serves; they are only filled for boards with a power stage.

const f = (x: number | null) => (x === null ? "-" : x.toFixed(2))

/**
 * Capacitors on a rail a regulator shares with other chips (a motor driver, a microcontroller) that the
 * regulator does not own: the worst and the total pad gap from each to the nearest supply pin of a chip
 * that is not a regulator. A regulator that grabs a bulk capacitor from the chip it serves makes these
 * grow. The set of capacitors comes from the schematic, so it is the same before and after.
 */
function otherChips(p: Project) {
  const sch = computeConnectivity(p)
  const ground = groundNetIds(p, sch)
  const stages = powerStages(p, sch)
  const regulators = new Set(stages.map((s) => s.chipId))
  const owned = new Set(stages.flatMap((s) => s.sats.map((x) => x.id)))
  const regulatorNets = new Set<string>()
  for (const id of regulators) {
    const c = p.components.find((x) => x.id === id)!
    const part = findPart(c.partId)!
    for (const pin of part.pins) {
      const net = sch.pinNet.get(pinKey(c.id, pin.number))
      if (net && isSupplyPin(part, pin)) regulatorNets.add(net)
    }
  }
  const chips = p.components.filter((c) => isChip(findPart(c.partId)) && !regulators.has(c.id) && c.pcb.placed)
  const gaps: { ref: string; gap: number }[] = []
  for (const cap of p.components) {
    const part = findPart(cap.partId)
    if (part?.valueProp !== "capacitance" || part.pins.length !== 2 || !cap.pcb.placed) continue
    const nets = part.pins.map((pin) => ({ pin: pin.number, net: sch.pinNet.get(pinKey(cap.id, pin.number)) }))
    const rail = nets.find((n) => n.net && !ground.has(n.net))
    if (owned.has(cap.id) || !rail?.net || !regulatorNets.has(rail.net) || !nets.some((n) => n.net && ground.has(n.net))) continue
    let best = Infinity
    for (const chip of chips) {
      const cp = findPart(chip.partId)!
      const numbers = cp.pins.filter((pin) => isSupplyPin(cp, pin) && sch.pinNet.get(pinKey(chip.id, pin.number)) === rail.net).map((pin) => pin.number)
      for (const a of pcbPads(cap).filter((x) => x.pin === rail.pin)) for (const b of pcbPads(chip).filter((x) => x.pin !== null && numbers.includes(x.pin))) best = Math.min(best, padGap(a, b))
    }
    if (best < Infinity) gaps.push({ ref: cap.ref, gap: best })
  }
  return gaps
}

function metrics(p: Project) {
  const others = otherChips(p)
  const reports = stageGaps(p, powerStages(p))
  const gaps = reports.flatMap((r) => r.gaps)
  const max = (role: string) => {
    const g = gaps.filter((x) => x.role === role).map((x) => x.gap)
    return g.length ? Math.max(...g) : null
  }
  const sum = gaps.length ? gaps.reduce((a, g) => a + g.gap, 0) : null
  const checks = analyzePcb(p, computeConnectivity(p)).violations
  return {
    inputMax: max("input-cap"),
    inductor: max("inductor"),
    boot: max("boot-cap"),
    output: max("output-cap"),
    sum,
    othersMax: others.length ? Math.max(...others.map((g) => g.gap)) : null,
    othersSum: others.length ? others.reduce((a, g) => a + g.gap, 0) : null,
    n: gaps.length,
    problems: checks.filter((v) => v.kind === "overlap" || v.kind === "outside-board").length,
  }
}

function row(name: string, project: Project): string[] {
  const cells: string[] = []
  for (const stage of [false, true]) {
    const p = autoPlacePcb(project, true, { powerStage: stage })
    const m = metrics(p)
    const unrouted = autoroute(p, { timeLimitMs: Infinity }).remaining
    cells.push(`${f(m.inputMax)} / ${f(m.inductor)} / ${f(m.boot)} / ${f(m.output)}`, f(m.sum), `${f(m.othersMax)} / ${f(m.othersSum)}`, String(m.problems), String(unrouted))
  }
  return [`| ${name} | ${cells.slice(0, 5).join(" | ")} | ${cells.slice(5).join(" | ")} |`]
}

describe.skipIf(!process.env.MEASURE_POWERSTAGE)("power stage measurement", () => {
  it("compares placement with and without the rules", { timeout: 3_600_000 }, () => {
    const lines = [
      "| Board | Before: input / inductor / boot / output worst gap (mm) | Before: stage gap sum (mm) | Before: shared-rail caps to other chips worst / sum (mm) | Before: overlaps + off board | Before: unrouted | After: input / inductor / boot / output worst gap (mm) | After: stage gap sum (mm) | After: shared-rail caps to other chips worst / sum (mm) | After: overlaps + off board | After: unrouted |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    lines.push(...row("buck (TPS563200 pinout)", buckDesign()))
    lines.push(...row("boost (TPS61023 pinout)", boostDesign()))
    lines.push(...row("LDO with bulk caps", ldoDesign()))
    for (const e of EXAMPLES) lines.push(...row(e.id, e.project))
    const table = lines.join("\n")
    if (process.env.MEASURE_OUT) writeFileSync(process.env.MEASURE_OUT, table)
  })
})
