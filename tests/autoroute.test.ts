import { describe, expect, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
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
})
