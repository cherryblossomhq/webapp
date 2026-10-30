import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { createProject } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { fillTester } from "../src/model/pour"
import { padsPourMisses } from "../src/model/pourReach"
import type { Project } from "../src/model/types"

// A pour's thermal gap was its clearance. An assistant gave a 10 A board's pour a 2.5 mm clearance, which made a 2.5 mm ring round
// each 2.6 mm terminal pad: 7.6 mm across, wider than the 7 mm strip of copper the pads sat in, so the spokes reached nothing. The
// pour dropped the pads without a word, and route_pcb joined them with thin traces. The board has a thermal gap of its own now,
// and set_pour and set_design_rules name the pads a pour leaves out.

const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))

/** Two terminal blocks of two 2.6 mm through-hole pads, 7.5 mm apart, wired pin to pin, at x = -12 and 12. */
function board(): Project {
  const made = runTool(createProject("10 A"), "create_part", {
    name: "TB2-7.5",
    description: "2-position PCB terminal block, 7.5 mm pitch",
    category: "Connectors",
    pins: [
      { number: "1", name: "1", kind: "passive" },
      { number: "2", name: "2", kind: "passive" },
    ],
    land: {
      pads: [
        { number: "1", x: 0, y: 0, shape: "circle", d: 2.6, drill: 1.3 },
        { number: "2", x: 0, y: -7.5, shape: "circle", d: 2.6, drill: 1.3 },
      ],
    },
  })
  const id = /part_id "([^"]+)"/.exec(made.result)![1]
  let p = made.project
  p = runTool(p, "add_component", { part_id: id, ref: "J1", x: 0, y: 0 }).project
  p = runTool(p, "add_component", { part_id: id, ref: "J2", x: 20, y: 0 }).project
  p = runTool(p, "connect", { pins: ["J1.1", "J2.1"], net_name: "L1" }).project
  p = runTool(p, "connect", { pins: ["J1.2", "J2.2"], net_name: "L2" }).project
  return { ...p, components: p.components.map((c) => ({ ...c, pcb: { ...c.pcb, x: c.ref === "J1" ? -12 : 12, y: 3.75, placed: true } })) }
}

// A 7 mm square of pour round each L1 pad, joined by a 1 mm strip along their foot.
const DUMBBELL = [-15.5, 0.25, 15.5, 0.25, 15.5, 7.25, 8.5, 7.25, 8.5, 1.25, -8.5, 1.25, -8.5, 7.25, -15.5, 7.25]

describe("pads a pour leaves out", () => {
  it("are named when the thermal ring outgrows the copper round them, and joined once the gap is narrowed", () => {
    const wide = runTool(board(), "set_design_rules", { pour_clearance: 2.5 }).project
    const poured = runTool(wide, "set_pour", { net: "L1", layer: "top", polygon: DUMBBELL })
    expect(poured.isError).toBe(false)
    expect(poured.result).toContain("The L1 pour does not join J1.1, J2.1")
    expect(poured.result).toContain("at a 2.5 mm thermal gap (the pour clearance) and a 2.5 mm pour clearance")

    const narrowed = runTool(poured.project, "set_design_rules", { thermal_gap: 0.5 })
    expect(narrowed.result).toContain("thermal_gap 0.5")
    expect(narrowed.result).not.toContain("does not join")
    expect(padsPourMisses(narrowed.project, analyze(narrowed.project), "L1")).toEqual([])
    // The clearance to the other net stays as it was.
    expect(narrowed.project.rules.pourClearance).toBe(2.5)

    const back = runTool(narrowed.project, "set_design_rules", { thermal_gap: 0 })
    expect(back.project.rules.thermalGap).toBeUndefined()
    expect(back.result).toContain("The L1 pour does not join J1.1, J2.1")
  })

  it("join a through-hole pad that a zone of its own settings reaches by spokes", () => {
    // Such a fill has the pad's drill cut out, so the pad's centre is not in it: only the spokes are.
    const p = runTool(board(), "set_pour", { net: "L1", layer: "top" }).project
    const own = { ...p, zones: p.zones.map((z) => ({ ...z, priority: 1 })) }
    const nets = (q: Project) => analyze(q).ratsnest.map((r) => r.netId)
    expect(nets(p)).toEqual(["net:L2"])
    expect(nets(own)).toEqual(["net:L2"])
    expect(padsPourMisses(own, analyze(own), "L1")).toEqual([])
  })

  it("narrows the ring of a whole-board pour too", () => {
    const p = runTool(runTool(board(), "set_design_rules", { pour_clearance: 1 }).project, "set_pour", { net: "L1", layer: "top" }).project
    // Between the spokes, 0.6 mm off the pad's edge: in a 1 mm ring, not in a 0.3 mm one.
    const at = { x: -12 + (1.3 + 0.6) * Math.SQRT1_2, y: 3.75 + (1.3 + 0.6) * Math.SQRT1_2 }
    const filled = (q: Project) => analyze(q).zoneFills.some((f) => f.netName === "L1" && f.polygons.some((poly) => fillTester(poly)(at)))
    expect(filled(p)).toBe(false)
    expect(filled(runTool(p, "set_design_rules", { thermal_gap: 0.3 }).project)).toBe(true)
  })
})
