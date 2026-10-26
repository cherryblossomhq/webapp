import { describe, expect, it } from "vitest"
import { unroutedAdvice } from "../src/ai/tools"
import { autoroute, type AutorouteResult } from "../src/model/autoroute"
import { pcbPads } from "../src/model/instances"
import type { Project } from "../src/model/types"
import { getPcbAnalysis } from "../src/store/analysis"
import { analysis, chipBoard, drcErrors, unrouted } from "./finePitch"
import { firstRequest, type Session } from "./sakura-session"

// Fine-pitch pads and the autorouter.
//
// An owner's Sakura session left 8 connections open on a 40x30 mm 2-layer ESP32-C3 board: the USB-C
// receptacle's D+, D-, CC1 and CC2 (USB4105: pads 0.3 mm wide at 0.5 mm pitch), an SCL and a GND link,
// however often Sakura cleared the routing and ran it again. The receptacle is routable at the board's
// own rules: a 0.25 mm trace straight out of a pad leaves 0.35 - 0.125 = 0.225 mm to the next pad.
// The router could not find it because
// - its grid is 0.1 mm from the board's corner and a keepout carries half a cell of margin, so a pad
//   that sits 0.03 mm off the grid (layout_pcb put J1 there) has no cell centre in front of it;
// - it never tried a trace thinner than the default width;
// - wide supply copper joining the outer pads of the receptacle sealed in the signals between them;
// - it gave the same answer every time.

const USB = ["USB_DP", "USB_DM", "CC1", "CC2"]
const open = (p: Project) => unrouted(p).map((v) => v.message.replace("Unrouted connection on ", ""))

/** The session's board as Sakura left it before route_pcb: laid out, GND poured, VBUS and 3V3 widened. */
function laidOut(): Session {
  const s = firstRequest()
  s.must("layout_pcb")
  s.must("set_pour", { net: "GND", layer: "both" })
  s.must("set_net_width", { widths: { VBUS: 0.5, "3V3": 0.4 } })
  return s
}

describe("USB-C receptacle (USB4105, 0.5 mm pitch) on the session's board", () => {
  it("routes every connection at the board's own rules with no DRC error, without moving a part", () => {
    const s = laidOut()
    const before = s.project
    const t0 = performance.now()
    const res = autoroute(before, { timeLimitMs: Infinity })
    const ms = performance.now() - t0
    expect(res.remaining).toBe(0)
    expect(open(res.project)).toEqual([])
    expect(drcErrors(res.project).map((v) => v.message)).toEqual([])
    // The user's parts stay where they were.
    expect(res.project.components.map((c) => [c.ref, c.pcb])).toEqual(before.components.map((c) => [c.ref, c.pcb]))
    // No trace is below the rules' minimum, however thin the escape.
    const min = res.project.rules.minTraceWidth
    expect(Math.min(...res.project.traces.map((t) => t.width))).toBeGreaterThanOrEqual(min)
    expect(ms).toBeLessThan(60_000)
  }, 120_000)

  it("keeps the supply nets at their set width away from the pads", () => {
    const s = laidOut()
    const res = autoroute(s.project, { timeLimitMs: Infinity })
    const a = analysis(res.project)
    const net = (name: string) => a.traceNet && [...a.traceNet].filter(([, n]) => n === `net:${name}`).map(([id]) => id)
    const j1 = pcbPads(res.project.components.find((c) => c.ref === "J1")!)
    const atPad = (t: Project["traces"][number]) => t.points.some((q) => j1.some((p) => Math.hypot(p.x - q.x, p.y - q.y) < 0.01))
    for (const [name, width] of [["VBUS", 0.5], ["3V3", 0.4]] as const) {
      const ids = new Set(net(name))
      const away = res.project.traces.filter((t) => ids.has(t.id) && !atPad(t))
      // Wide where there is room: nothing narrower than the width asked for, except where a pad forced a fall back.
      expect(away.filter((t) => t.width >= 0.4).length, name).toBeGreaterThan(0)
      expect(Math.max(...away.map((t) => t.width), 0), name).toBeLessThanOrEqual(width)
    }
  }, 120_000)

  it("reaches 0 open inside the default time budget", () => {
    const s = laidOut()
    // Measured in CPU time, so that a busy machine cannot fail it: the default budget is 10 s of wall
    // time for everything, the fine-pitch retry included, and a route that needs under 70% of that in
    // CPU still finishes in it on a machine a third slower (the process counts every worker thread, so this is generous).
    const c0 = process.cpuUsage()
    const res = autoroute(s.project, { timeLimitMs: Infinity })
    const c = process.cpuUsage(c0)
    expect(res.remaining).toBe(0)
    expect(drcErrors(res.project)).toEqual([])
    expect((c.user + c.system) / 1000).toBeLessThan(7_000)
  }, 120_000)

  it("through route_pcb, as Sakura ran it, leaves nothing open and says nothing about spreading parts", () => {
    const s = laidOut()
    const out = s.must("route_pcb")
    expect(getPcbAnalysis(s.project).violations.filter((v) => v.severity === "error")).toEqual([])
    expect(open(s.project).filter((n) => USB.includes(n))).toEqual([])
    expect(out.result).not.toContain("spread the parts out")
  }, 120_000)
})

describe("what route_pcb says about connections it could not route", () => {
  const result = (finePitchOpen: number, remaining: number, tried: number | null): AutorouteResult => ({ project: {} as Project, routed: 3, remaining, addedTraces: 0, addedVias: 0, finePitchOpen, finePitchTried: tried })

  it("blames fine-pitch pads, says what was tried, and does not send Sakura to spread parts out", () => {
    const text = unroutedAdvice(result(4, 4, 0.15))
    expect(text).toContain("4 of them end at fine-pitch pads")
    expect(text).toContain("escape stubs")
    expect(text).toContain("down to 0.15 mm")
    expect(text).toContain("will not fix it")
    expect(text).not.toContain("spread the parts out or enlarge the board")
    expect(text).not.toContain("move parts apart")
    expect(text).toContain("Do not clear_routing and run route_pcb again on the same layout")
    expect(text).toContain("same layout and rules give the same result")
    expect(text).not.toContain("every time")
    // Hand routing is offered once the retry has run and failed.
    expect(text).toContain("route those connections by hand")
  })

  it("does not offer hand routing while the fine-pitch retry has not run", () => {
    const text = unroutedAdvice(result(2, 2, null))
    expect(text).toContain("did not run to the end")
    expect(text).not.toContain("by hand")
    expect(text).not.toContain("spread the parts out or enlarge the board")
    expect(text).toContain("Do not clear_routing")
  })

  it("still names congestion when some of what is left is not at a fine-pitch pad", () => {
    const text = unroutedAdvice(result(1, 3, 0.15))
    expect(text).toContain("1 of them end at fine-pitch pads")
    expect(text).toContain("2 other connection(s) may be short of room")
    expect(text).toContain("Do not clear_routing")
  })

  it("is the old advice, minus the loop, when no fine-pitch pad is involved", () => {
    const text = unroutedAdvice(result(0, 2, null))
    expect(text).not.toContain("fine-pitch")
    expect(text).toContain("enlarge the board")
    expect(text).toContain("Do not clear_routing")
  })

  it("reaches Sakura when a fine-pitch connection stays open", () => {
    const s = laidOut()
    // A fab class this board cannot meet at the receptacle: 0.35 mm clearance leaves its pads no room at all.
    s.must("set_design_rules", { clearance: 0.35, trace_width: 0.3, min_trace_width: 0.3 })
    const t0 = performance.now()
    const out = s.run("route_pcb")
    const ms = performance.now() - t0
    expect(unrouted(s.project).length).toBeGreaterThan(0)
    expect(out.result).toContain("end at fine-pitch pads")
    expect(out.result).not.toContain("spread the parts out or enlarge the board")
    expect(out.result).toContain("Do not clear_routing")
    // The pads leave no room for any trace at these rules, so the fine-pitch retry is skipped.
    expect(out.result).toContain("did not run to the end")
    expect(out.result).not.toContain("by hand")
    expect(ms).toBeLessThan(10_000 + 4_000)
  }, 120_000)
})

describe("other fine-pitch parts escaping on 2 layers", () => {
  // Every signal lead goes to a resistor of its own, fanned out around the chip by hand, with a GND pour
  // on both layers. Corner leads of a four-sided part stay unconnected: the footprinter draws the
  // corner pads of neighbouring sides on top of each other.
  it("routes a QFN-56 at 0.5 mm pitch (0.875 x 0.25 mm pads) completely", () => {
    const p = chipBoard({ name: "QFN56", footprint: "qfn56_w8_h8_p0.5mm", leads: 56, groundEvery: 14, skipCorners: true, board: { width: 40, height: 40 } })
    const res = autoroute(p, { timeLimitMs: Infinity })
    expect(res.remaining).toBe(0)
    expect(drcErrors(res.project).map((v) => v.message)).toEqual([])
  }, 300_000)

  it("gets an RP2040-style QFN-56 (7 x 7 mm, 0.4 mm pitch, 0.2 mm pads) mostly out, with no DRC error", () => {
    const p = chipBoard({ name: "RP2040", footprint: "qfn56_w7_h7_p0.4mm_pl0.8_pw0.2", leads: 56, groundEvery: 14, skipCorners: true, board: { width: 40, height: 40 } })
    const connections = analysis(p).ratsnest.length
    // 0.4 mm pitch at 0.2 mm clearance leaves 0.2 mm between pads: only a 0.15 mm trace straight out fits.
    // Before the fine-pitch retry none of the 48 connections routed.
    const res = autoroute(p, { timeLimitMs: Infinity })
    expect(res.routed).toBeGreaterThanOrEqual(Math.floor(connections * 0.8))
    expect(drcErrors(res.project).map((v) => v.message)).toEqual([])
  }, 300_000)

  it("routes a TSSOP-20 at 0.65 mm pitch with its ground pins", () => {
    const p = chipBoard({ name: "TSSOP20", footprint: "tssop20_p0.65mm", leads: 20, groundEvery: 10, board: { width: 44, height: 38 } })
    const res = autoroute(p, { timeLimitMs: Infinity })
    expect(res.remaining).toBe(0)
    expect(drcErrors(res.project).map((v) => v.message)).toEqual([])
  }, 120_000)

  it("never puts two vias within the drill clearance of each other, ground pins and all", () => {
    // Four ground pins on a 0.5 mm part: the retries once fanned a pad out to the pour twice, leaving two vias on one spot.
    const p = chipBoard({ name: "TSSOP28", footprint: "tssop28_p0.5mm", leads: 28, groundEvery: 7, board: { width: 44, height: 38 } })
    const res = autoroute(p, { timeLimitMs: Infinity })
    expect(drcErrors(res.project).map((v) => v.message)).toEqual([])
    const { viaDrill, holeClearance } = res.project.rules
    const vias = res.project.vias
    for (let i = 0; i < vias.length; i++) {
      for (let j = i + 1; j < vias.length; j++) {
        expect(Math.hypot(vias[i].x - vias[j].x, vias[i].y - vias[j].y)).toBeGreaterThanOrEqual(viaDrill + holeClearance - 1e-6)
      }
    }
  }, 300_000)

  it("routes a TSSOP-28 at 0.5 mm pitch (0.3 mm pads, 0.2 mm apart) completely", () => {
    // Before the fine-pitch retry all 26 connections stayed open.
    const p = chipBoard({ name: "TSSOP28", footprint: "tssop28_p0.5mm", leads: 28, board: { width: 44, height: 38 } })
    const res = autoroute(p, { timeLimitMs: Infinity })
    expect(res.remaining).toBe(0)
    expect(drcErrors(res.project).map((v) => v.message)).toEqual([])
    const min = res.project.rules.minTraceWidth
    expect(Math.min(...res.project.traces.map((t) => t.width))).toBeGreaterThanOrEqual(min)
  }, 120_000)
})
