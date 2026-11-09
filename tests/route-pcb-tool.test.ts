import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { autoroute, compareResults, type AutorouteResult } from "../src/model/autoroute"
import { createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"

// route_pcb as an assistant drives it. On a user's 15 x 10 mm USB-C to UART bridge (a CH343P in QFN-16 beside a 16-pin receptacle),
// Sakura spent an evening of about 150 requests moving three capacitors 0.1 mm at a time and asking for "pour and route from scratch"
// after each. It never learned which connection was open (route_pcb and run_checks gave counts only: it said "I haven't found which
// net it is" forty times), nor where VBUS was thin (one connection at 0.25 mm of a 0.4 mm net, reported after every route), and it
// routed in two calls, VBUS and then the rest, because the tool told it to: on 37 layouts from that board's history that routed fewer
// boards whole (22) than one call did (26). Now one call routes every net, holds VBUS at its width where it fits, routes the board
// again in other orders while something is open or narrower, and names what is left by its pins.

/** Two two-pin parts 24 mm apart on a board of 40 x `height` mm, wired pin to pin as L1 and L2. */
function board(height = 40): Project {
  const made = runTool(createProject("route"), "create_part", {
    name: "TB2",
    description: "2-position terminal block",
    category: "Connectors",
    pins: [
      { number: "1", name: "1", kind: "passive" },
      { number: "2", name: "2", kind: "passive" },
    ],
    land: {
      pads: [
        { number: "1", x: 0, y: 0, shape: "circle", d: 2, drill: 1 },
        { number: "2", x: 0, y: -7.5, shape: "circle", d: 2, drill: 1 },
      ],
    },
  })
  const id = /part_id "([^"]+)"/.exec(made.result)![1]
  let p = made.project
  p = runTool(p, "add_component", { part_id: id, ref: "J1", x: 0, y: 0 }).project
  p = runTool(p, "add_component", { part_id: id, ref: "J2", x: 20, y: 0 }).project
  p = runTool(p, "connect", { pins: ["J1.1", "J2.1"], net_name: "L1" }).project
  p = runTool(p, "connect", { pins: ["J1.2", "J2.2"], net_name: "L2" }).project
  return {
    ...p,
    board: { ...p.board, height },
    components: p.components.map((c) => (c.ref === "J1" ? { ...c, pcb: { ...c.pcb, x: -12, y: 3.75, placed: true } } : c.ref === "J2" ? { ...c, pcb: { ...c.pcb, x: 12, y: 3.75, placed: true } } : c)),
  }
}

/** A wall of keepout across the board, solid on the bottom layer and with gaps of 0.6 mm on the top centred on `gaps` (y): room for one default trace each. */
function walled(p: Project, gaps: number[]): Project {
  p = runTool(p, "set_pour", { layer: "bottom", keepout: ["tracks", "vias"], polygon: [-0.5, -20, 0.5, -20, 0.5, 20, -0.5, 20] }).project
  const edges = [-20, ...gaps.flatMap((y) => [y - 0.3, y + 0.3]), 20]
  for (let i = 0; i < edges.length; i += 2) {
    const [y0, y1] = [edges[i], edges[i + 1]]
    p = runTool(p, "set_pour", { layer: "top", keepout: ["tracks", "vias"], polygon: [-0.5, y0, 0.5, y0, 0.5, y1, -0.5, y1] }).project
  }
  return p
}

describe("route_pcb names what it leaves", () => {
  it("names a connection left open by its pins, and so does run_checks", () => {
    // One gap, which L2 takes: L1 cannot be routed at all.
    const p = walled(board(), [-3.75])
    const out = runTool(p, "route_pcb", {})
    expect(out.isError).toBe(false)
    expect(out.result).toContain("1 connection(s) could not be routed: L1: J1.1 to J2.1")
    expect(out.result).toContain("Do not clear_routing and run route_pcb again on the same layout")
    const checks = runTool(out.project, "run_checks", {})
    expect(checks.result).toContain("- unrouted: L1: J1.1 to J2.1")
  })

  it("says nothing of other routings when the first is clean, and the board is routed once", () => {
    const res = autoroute(board(), { timeLimitMs: Infinity })
    expect(res.remaining).toBe(0)
    expect(res.narrowed).toBeUndefined()
    expect(res.tries).toBe(1)
    const out = runTool(board(), "route_pcb", {})
    expect(out.result).not.toContain("routings")
  })

  it("routes the board other ways while a connection stays open, and says so", () => {
    const res = autoroute(walled(board(), [-3.75]), { timeLimitMs: 4_000 })
    expect(res.remaining).toBe(1)
    expect(res.open).toEqual([expect.objectContaining({ net: "L1" })])
    expect(res.tries).toBeGreaterThan(1)
  })
})

describe("route_pcb clear and priority", () => {
  it("clear takes up the unlocked routing first and routes from scratch, in one call", () => {
    const routed = runTool(board(), "route_pcb", {}).project
    expect(routed.traces.length).toBeGreaterThan(0)
    const again = runTool(routed, "route_pcb", { clear: true })
    expect(again.isError).toBe(false)
    expect(again.result).toMatch(/^Cleared \d+ trace\(s\) and \d+ via\(s\) first\. Routed 2 connection\(s\)/)
    // Without clear, the routed board has nothing left to route.
    expect(runTool(routed, "route_pcb", {}).result).toContain("already routed")
  })

  it("clear with nets takes up only those nets' copper", () => {
    const routed = runTool(board(), "route_pcb", {}).project
    const again = runTool(routed, "route_pcb", { clear: true, nets: ["L1"] })
    expect(again.result).toMatch(/^Cleared 1 trace\(s\)/)
    expect(again.result).toContain("Routed 1 connection(s) of L1")
  })

  it("clear keeps locked copper", () => {
    const routed = runTool(board(), "route_pcb", {}).project
    const locked = { ...routed, traces: routed.traces.map((t) => ({ ...t, locked: true })) }
    expect(runTool(locked, "route_pcb", { clear: true }).result).toContain("already routed")
  })

  it("priority routes those nets first, in the one call, and refuses a net that does not exist", () => {
    // One gap for both rows: whichever goes first takes it.
    const p = walled(board(), [0])
    const first = (net: string) => {
      const res = autoroute(p, { order: [`net:${net}`], timeLimitMs: Infinity })
      return res.open.map((o) => o.net)
    }
    expect(first("L1")).toEqual(["L2"])
    expect(first("L2")).toEqual(["L1"])
    expect(runTool(p, "route_pcb", { priority: ["L2"] }).result).toContain("L1: J1.1 to J2.1")
    const bad = runTool(p, "route_pcb", { priority: ["NOPE"] })
    expect(bad.isError).toBe(true)
    expect(bad.result).toContain("No net named NOPE")
  })
})

describe("which routing is better", () => {
  const r = (remaining: number, narrowed: number, vias: number): AutorouteResult => ({
    project: { traces: [] } as unknown as Project,
    routed: 0,
    remaining,
    addedTraces: 0,
    addedVias: vias,
    finePitchOpen: 0,
    finePitchTried: null,
    open: [],
    tries: 1,
    ...(narrowed ? { narrowed: [{ net: "VBUS", width: 0.4, widths: [0.25], spans: [{ width: 0.25, length: narrowed, total: 3, a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, layer: "top" as const }] }] } : {}),
  })

  it("puts fewer open first, then less narrower length, then fewer vias", () => {
    expect(compareResults(r(0, 2, 30), r(1, 0, 0))).toBeLessThan(0)
    expect(compareResults(r(0, 0.1, 30), r(0, 1.3, 0))).toBeLessThan(0)
    expect(compareResults(r(0, 0, 10), r(0, 0, 12))).toBeLessThan(0)
    expect(compareResults(r(0, 0, 12), r(0, 0, 12))).toBe(0)
  })
})
