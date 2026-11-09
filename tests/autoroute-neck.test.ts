import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { createProject } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import type { Project } from "../src/model/types"

// A trace wider than the pads it joins. An assistant over MCP set 3 mm on the nets of a 10 A board whose terminal blocks have
// 2.6 mm pads, and every connection came out at the default width: the router started a trace only where it fitted inside a
// pad whole, found nowhere, and fell back to the next width for the whole run. It said so in one clause of set_net_width's
// reply, and route_pcb said nothing. A trace now leaves such a pad by a neck of the pad's width, and route_pcb names any net
// that still went narrower.

const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))
const errors = (p: Project) => analyze(p).violations.filter((v) => v.severity === "error" && v.kind !== "unrouted")

/** Two terminal blocks of two 2.6 mm through-hole pads, 7.5 mm apart, wired pin to pin. */
function board(height = 40): Project {
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
  p = {
    ...p,
    board: { ...p.board, height },
    components: p.components.map((c) => (c.ref === "J1" ? { ...c, pcb: { ...c.pcb, x: -12, y: 3.75, placed: true } } : c.ref === "J2" ? { ...c, pcb: { ...c.pcb, x: 12, y: 3.75, placed: true } } : c)),
  }
  return p
}

const tracesOn = (p: Project, net: string) => {
  const conn = computeConnectivity(p)
  const id = conn.nets.find((n) => n.name === net)!.id
  const pcb = analyze(p)
  return p.traces.filter((t) => pcb.traceNet.get(t.id) === id)
}

describe("a trace wider than its pads", () => {
  it("runs at its width and necks down to the pad's at each end", () => {
    const p = runTool(board(), "set_net_width", { widths: { L1: 3, L2: 3 } }).project
    const res = autoroute(p, { timeLimitMs: Infinity })
    expect(res.remaining).toBe(0)
    expect(errors(res.project)).toEqual([])
    expect(res.narrowed).toBeUndefined()
    const pads = res.project.components.flatMap(pcbPads)
    for (const net of ["L1", "L2"]) {
      const traces = tracesOn(res.project, net)
      const necks = traces.filter((t) => t.width < 3)
      expect(traces.filter((t) => t.width === 3)).toHaveLength(1)
      expect(necks).toHaveLength(2)
      // As wide as fits in a cell of the router's grid inside the pad, which sits half a cell off it here; each from a pad's centre.
      for (const t of necks) {
        expect(t.width).toBeGreaterThanOrEqual(2.4)
        expect(t.width).toBeLessThanOrEqual(2.6)
        expect(pads.some((pad) => [t.points[0], t.points.at(-1)!].some((q) => q.x === pad.x && q.y === pad.y))).toBe(true)
      }
    }
  })

  it("says which connection went in narrower than its width, where and how much, and goes as wide as fits", () => {
    // 9 mm of copper does not fit across an 8 mm board.
    const p = runTool(board(8), "set_net_width", { widths: { L1: 9 } }).project
    const out = runTool(p, "route_pcb", {})
    expect(out.isError).toBe(false)
    // By its pins, with its length and where it is: a count alone ("L1 (1 at 0.25 mm, not 9 mm)") left Sakura guessing which connection.
    expect(out.result).toMatch(/Narrower than their net's width, for want of room at that width: L1 \(9 mm\) [0-9.]+ mm for all of the [0-9.]+ mm from J1\.1 to J2\.1, between \(/)
    expect(out.result).not.toMatch(/L2 \(/)
    // As wide as there is room for, not straight down to the default 0.25 mm.
    const width = Number(/L1 \(9 mm\) ([0-9.]+) mm/.exec(out.result)![1])
    expect(width).toBeGreaterThan(0.25)
    // What to do is draw it or make room, not stand a polygon pour in for the trace, nor route it in a call of its own.
    expect(out.result).toContain('draw_trace that connection from pin to pin at the width (from "J1.1" to "J2.1")')
    expect(out.result).not.toContain("set_pour")
    expect(out.result).not.toContain("before the rest")
  })

  it("holds a net at its width wherever it fits and necks down only through the gap that has no room", () => {
    // A wall of keepout across the board on both layers, with a 1.2 mm gap in front of each pin row: a 2 mm trace cannot pass, 1 mm can.
    // The old router laid the whole connection at the next width it could, the default 0.25 mm, end to end; on a user's USB-C bridge that
    // put a 0.4 mm VBUS at 0.25 mm from its capacitor to its pin, through two vias, for want of room in one spot.
    let p = runTool(board(40), "set_net_width", { widths: { L1: 2 } }).project
    for (const [y0, y1] of [[-20, -4.35], [-3.15, 3.15], [4.35, 20]]) {
      p = runTool(p, "set_pour", { layer: "both", keepout: ["tracks", "vias"], polygon: [-0.5, y0, 0.5, y0, 0.5, y1, -0.5, y1] }).project
    }
    const res = autoroute(p, { timeLimitMs: Infinity })
    expect(res.remaining).toBe(0)
    expect(errors(res.project)).toEqual([])
    const l1 = tracesOn(res.project, "L1")
    expect(l1.some((t) => t.width === 2)).toBe(true)
    const span = res.narrowed?.find((n) => n.net === "L1")?.spans
    expect(span).toHaveLength(1)
    // as wide as the gap takes, for the wall's 1 mm and the 1 mm a 2 mm trace keeps from it on each side, and 2 mm everywhere else
    expect(span![0].width).toBeGreaterThanOrEqual(0.75)
    expect(span![0].total).toBeGreaterThan(20)
    expect(span![0].length).toBeLessThan(span![0].total / 4)
  })
})
