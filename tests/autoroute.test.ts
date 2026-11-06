import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { createProject } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { TEMPLATES } from "../src/model/templates"
import type { Project } from "../src/model/types"
import { built } from "./built"

const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))
const errors = (p: Project) => analyze(p).violations.filter((v) => v.severity === "error")

describe("autoroute", () => {
  it.each(TEMPLATES.map((t) => [t.name, t.id] as const))("routes %s without DRC errors", (_name, id) => {
    // Start over, keeping only copper the template routed by hand.
    const p = built(id)
    const base = { ...p, traces: p.traces.filter((t) => t.locked), vias: p.vias.filter((v) => v.locked) }
    const t0 = performance.now()
    // Untimed, as the examples are: with the default budget, how much gets routed depends on
    // how busy the machine is, and a CI runner sharing its cores with a Next build ran out.
    const res = autoroute(base, { timeLimitMs: Infinity })
    const ms = performance.now() - t0
    console.log(_name, { ms: Math.round(ms), routed: res.routed, remaining: res.remaining, traces: res.addedTraces, vias: res.addedVias })
    expect(errors(res.project)).toEqual([])
    expect(res.remaining).toBe(0)
  })

  it("routes a net at its own width and narrows only where a pad is too small", () => {
    const base = built("regulator")
    const conn = computeConnectivity(base)
    const net = conn.nets.find((n) => n.pins.length >= 2 && !base.zones.some((z) => z.net === n.name))!
    const p = { ...base, traces: [], vias: [], rules: { ...base.rules, netWidths: { [net.name]: 0.6 } } }
    const res = autoroute(p)
    expect(errors(res.project)).toEqual([])
    expect(res.remaining).toBe(0)
    const pcb = analyze(res.project)
    const widths = res.project.traces.filter((t) => pcb.traceNet.get(t.id) === net.id).map((t) => t.width)
    expect(widths.length).toBeGreaterThan(0)
    expect(widths.every((w) => w === 0.6 || w <= 0.4)).toBe(true)
    expect(widths).toContain(0.6)
  })

  it("drops vias into a bottom ground pour", () => {
    const base = built("blinker")
    const p = { ...base, traces: [], vias: [], zones: [{ id: "z", net: "GND", layer: "bottom" as const }] }
    const res = autoroute(p)
    expect(errors(res.project)).toEqual([])
    expect(res.remaining).toBe(0)
  })

  it("joins a surface-mount pad to its pour on the same layer, not to the next pad over the pour", () => {
    // Two surface-mount parts 20 mm apart, VIN on the pad facing a top VIN strip 3 mm below it that reaches neither pad.
    const made = runTool(createProject("smd pour"), "create_part", {
      name: "SMD2",
      description: "2-pad SMD",
      category: "Passives",
      pins: [
        { number: "1", name: "1", kind: "passive" },
        { number: "2", name: "2", kind: "passive" },
      ],
      land: {
        pads: [
          { number: "1", x: 0, y: -2, shape: "rect", w: 2, h: 1.5 },
          { number: "2", x: 0, y: 2, shape: "rect", w: 2, h: 1.5 },
        ],
      },
    })
    const id = /part_id "([^"]+)"/.exec(made.result)![1]
    let p = made.project
    p = runTool(p, "add_component", { part_id: id, ref: "U1", x: 0, y: 0 }).project
    p = runTool(p, "add_component", { part_id: id, ref: "U2", x: 5, y: 0 }).project
    p = runTool(p, "connect", { pins: ["U1.1", "U2.1"], net_name: "VIN" }).project
    p = runTool(p, "connect", { pins: ["U1.2", "U2.2"], net_name: "SIG" }).project
    p = { ...p, components: p.components.map((c) => ({ ...c, pcb: { ...c.pcb, x: c.ref === "U1" ? -10 : 10, y: 0, placed: true } })) }
    p = runTool(p, "set_board", { width: 40, height: 30 }).project
    p = runTool(p, "set_pour", { net: "VIN", layer: "top", polygon: [-14, -10, 14, -10, 14, -5, -14, -5] }).project
    expect(analyze(p).ratsnest.length).toBe(2)

    const res = autoroute(p)
    expect(errors(res.project)).toEqual([])
    expect(res.remaining).toBe(0)
    const pcb = analyze(res.project)
    const vin = computeConnectivity(res.project).nets.find((n) => n.name === "VIN")!.id
    const stubs = res.project.traces.filter((t) => pcb.traceNet.get(t.id) === vin)
    expect(res.project.vias).toEqual([])
    // A stub from each pad down into the strip, and nothing running from one pad to the other.
    expect(stubs.map((t) => [t.layer, t.points[0]])).toEqual(
      expect.arrayContaining([
        ["top", { x: -10, y: -2 }],
        ["top", { x: 10, y: -2 }],
      ]),
    )
    expect(stubs).toHaveLength(2)
    for (const t of stubs) {
      expect(t.points.at(-1)!.y).toBeLessThanOrEqual(-5)
      expect(Math.max(...t.points.map((q) => q.x)) - Math.min(...t.points.map((q) => q.x))).toBeLessThan(3)
    }
  })
})
