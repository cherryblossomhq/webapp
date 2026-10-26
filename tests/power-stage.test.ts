import { describe, expect, it } from "vitest"
import { EXAMPLES } from "../src/model/examples"
import { computeConnectivity } from "../src/model/connectivity"
import { padGap } from "../src/model/decoupling"
import { pcbPads } from "../src/model/instances"
import { autoPlacePcb } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { powerStages, stageGaps } from "../src/model/powerStage"
import type { Project } from "../src/model/types"
import { boostDesign, buckDesign, ldoDesign, ldoFeedsMcuDesign } from "./powerStageFixtures"

const gapOf = (p: Project, label: string) => {
  const g = stageGaps(p).flatMap((s) => s.gaps).find((x) => x.label === label)
  if (!g) throw new Error(`no gap "${label}" in ${stageGaps(p).flatMap((s) => s.gaps.map((x) => x.label)).join(" | ")}`)
  return g.gap
}
const problems = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "overlap" || v.kind === "outside-board")
const padOf = (p: Project, ref: string, pin: string) => {
  const c = p.components.find((x) => x.ref === ref)!
  return pcbPads(c).find((x) => x.pin === pin)!
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe("power stage detection", () => {
  it("finds a buck converter's loop parts by pin name, in placement order", () => {
    const p = buckDesign()
    const [stage] = powerStages(p)
    const ref = (id: string) => p.components.find((c) => c.id === id)!.ref
    expect(stage.kind).toBe("buck")
    expect(stage.sats.map((s) => `${s.role}:${ref(s.id)}`)).toEqual([
      "inductor:L1",
      "input-cap:C2",
      "input-cap:C1",
      "boot-cap:C3",
      "output-cap:C4",
      "output-cap:C5",
      "feedback:R1",
      "feedback:R2",
    ])
  })

  it("tells a boost converter from a buck by where the inductor's far end goes", () => {
    const [stage] = powerStages(boostDesign())
    expect(stage.kind).toBe("boost")
    expect(stage.sats.map((s) => s.role)).toEqual(["inductor", "input-cap", "output-cap", "output-cap", "feedback", "feedback"])
  })

  it("treats an LDO's input and output capacitors of any value as its stage", () => {
    const p = ldoDesign()
    const [stage] = powerStages(p)
    expect(stage.kind).toBe("ldo")
    expect(stage.sats.map((s) => s.role).sort()).toEqual(["input-cap", "input-cap", "output-cap", "output-cap"])
  })
})

describe("power stage placement", () => {
  it("puts a buck's input capacitors, inductor and bootstrap capacitor at its pins", () => {
    const p = autoPlacePcb(buckDesign())
    // A 1206 inductor and two capacitors share the three pins of one SOT-23-6 edge: about a
    // millimetre each is what fits, against 5 to 6 mm when nothing places them.
    expect(gapOf(p, "C1.1 to U1.VIN")).toBeLessThanOrEqual(1.5)
    expect(gapOf(p, "C2.1 to U1.VIN")).toBeLessThanOrEqual(1.5)
    expect(gapOf(p, "L1.1 to U1.SW")).toBeLessThanOrEqual(1.6)
    expect(gapOf(p, "C3.1 to U1.VBST")).toBeLessThanOrEqual(1.2)
    expect(gapOf(p, "C3.2 to U1.SW")).toBeLessThanOrEqual(2.2)
    expect(problems(p)).toEqual([])
  })

  it("points the inductor's far end away from the chip and puts output capacitors there", () => {
    const p = autoPlacePcb(buckDesign())
    const chip = padOf(p, "U1", "2")
    expect(dist(padOf(p, "L1", "2"), chip)).toBeGreaterThan(dist(padOf(p, "L1", "1"), chip))
    expect(gapOf(p, "C4.1 to L1.2")).toBeLessThanOrEqual(1.2)
    expect(gapOf(p, "C5.1 to L1.2")).toBeLessThanOrEqual(1.2)
  })

  it("keeps the feedback divider nearer FB than the switch node", () => {
    const p = autoPlacePcb(buckDesign())
    const fb = padOf(p, "U1", "4")
    const sw = padOf(p, "U1", "2")
    const r1 = padOf(p, "R1", "2")
    expect(gapOf(p, "R1.2 to U1.VFB")).toBeLessThanOrEqual(1.2)
    expect(dist(r1, fb)).toBeLessThan(dist(r1, sw))
  })

  it("keeps a boost converter's inductor at SW and its output capacitors at VOUT", () => {
    const p = autoPlacePcb(boostDesign())
    expect(gapOf(p, "L1.2 to U1.SW")).toBeLessThanOrEqual(1)
    expect(gapOf(p, "C2.1 to U1.VOUT")).toBeLessThanOrEqual(1.6)
    expect(gapOf(p, "C3.1 to U1.VOUT")).toBeLessThanOrEqual(2.1)
    expect(gapOf(p, "C1.1 to U1.VIN")).toBeLessThanOrEqual(1.2)
    expect(problems(p)).toEqual([])
  })

  it("places an LDO's bulk capacitors at its pins, where decoupling alone left them loose", () => {
    const withStage = autoPlacePcb(ldoDesign())
    const without = autoPlacePcb(ldoDesign(), false, { powerStage: false })
    expect(gapOf(withStage, "C1.1 to U1.VIN")).toBeLessThanOrEqual(1.2)
    expect(gapOf(withStage, "C3.1 to U1.VOUT")).toBeLessThanOrEqual(2.5)
    expect(gapOf(withStage, "C1.1 to U1.VIN")).toBeLessThan(gapOf(without, "C1.1 to U1.VIN"))
    expect(problems(withStage)).toEqual([])
    const sum = (p: Project) => stageGaps(p, powerStages(p)).flatMap((s) => s.gaps).reduce((a, g) => a + g.gap, 0)
    expect(sum(withStage)).toBeLessThan(sum(without))
  })

  it("beats placement without the rules on the buck's loop", () => {
    const sum = (p: Project, role: string) => stageGaps(p).flatMap((s) => s.gaps).filter((g) => g.role === role).reduce((a, g) => a + g.gap, 0)
    const withStage = autoPlacePcb(buckDesign())
    const without = autoPlacePcb(buckDesign(), false, { powerStage: false })
    expect(sum(withStage, "input-cap")).toBeLessThan(sum(without, "input-cap"))
    expect(sum(withStage, "inductor")).toBeLessThanOrEqual(sum(without, "inductor"))
  })

  it("leaves parts that are locked where they are", () => {
    const first = autoPlacePcb(buckDesign())
    const l1 = first.components.find((c) => c.ref === "L1")!
    const locked = {
      ...first,
      components: first.components.map((c) => (c.ref === "L1" ? { ...c, pcb: { ...c.pcb, x: 15, y: 10, locked: true } } : c)),
    }
    const again = autoPlacePcb(locked, true)
    const after = again.components.find((c) => c.ref === "L1")!
    expect([after.pcb.x, after.pcb.y]).toEqual([15, 10])
    expect(l1.pcb.placed).toBe(true)
  })
})

describe("bulk capacitors of a shared rail", () => {
  // The LM7805 on the robot shares VBAT with the TB6612 motor driver; its bulk capacitors are drawn by the motor driver.
  it("stay with the chip they serve instead of going to the regulator on the rail", () => {
    const robot = EXAMPLES.find((e) => e.id === "esp32-robot")!.project
    const ref = (p: Project, r: string) => p.components.find((c) => c.ref === r)!
    const stages = powerStages(robot)
    const claimed = stages.flatMap((s) => s.sats.map((x) => robot.components.find((c) => c.id === x.id)!.ref))
    // C2 is drawn at the LM7805's input and is its; C3 is drawn beside the motor driver's VM pins.
    expect(claimed).toContain("C2")
    expect(claimed).not.toContain("C3")

    const withStage = autoPlacePcb(robot, true)
    const without = autoPlacePcb(robot, true, { powerStage: false })
    const toMotorDriver = (p: Project, cap: string) => {
      const pads = pcbPads(ref(p, "U2")).filter((x) => x.pin !== null)
      return Math.min(...pcbPads(ref(p, cap)).flatMap((a) => pads.map((b) => padGap(a, b))))
    }
    for (const cap of ["C3"]) expect(toMotorDriver(withStage, cap)).toBeLessThanOrEqual(toMotorDriver(without, cap) + 1)
  })
})

describe("an LDO's output capacitors", () => {
  // A design built without coordinates lays parts in a row in creation order, so which chip the capacitors
  // land beside says nothing about who they serve: the regulator keeps its own output filter either way.
  for (const capsFirst of [false, true]) {
    it(`stay with the LDO that makes the rail, whichever chip shares it (${capsFirst ? "capacitors" : "microcontroller"} added first)`, () => {
      const p = ldoFeedsMcuDesign(capsFirst)
      const ref = (id: string) => p.components.find((c) => c.id === id)!.ref
      const [stage] = powerStages(p)
      expect(stage.sats.map((s) => `${s.role}:${ref(s.id)}`).sort()).toEqual(["input-cap:C1", "output-cap:C2", "output-cap:C3"])
      const placed = autoPlacePcb(p, true)
      for (const cap of ["C2", "C3"]) expect(gapOf(placed, `${cap}.1 to U1.VOUT`), cap).toBeLessThan(2)
    })
  }

  it("still leave a bulk input capacitor with the chip it is drawn beside", () => {
    const robot = EXAMPLES.find((e) => e.id === "esp32-robot")!.project
    const claimed = powerStages(robot).flatMap((s) => s.sats.map((x) => robot.components.find((c) => c.id === x.id)!.ref))
    expect(claimed).not.toContain("C3")
  })
})
