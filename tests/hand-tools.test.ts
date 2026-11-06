import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { pairClearance } from "../src/model/netClasses"
import { createProject } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import type { Project } from "../src/model/types"

// What an assistant over MCP could not do on a 10 A board: keep its mains nets further from the rest than the board's clearance,
// draw a wide trace itself, or label a connector's pins A, B, C on the silkscreen. set_net_class, draw_trace and pcb_text.

const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))

/** Two terminal blocks of two 2.6 mm through-hole pads, 7.5 mm apart, at x = -12 and 12: J1.1 and J2.1 on L1 (y = 3.75), J1.2 and J2.2 on L2 (y = -3.75). */
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

describe("set_net_class", () => {
  it("keeps a class's nets its own clearance from every other net", () => {
    const out = runTool(board(), "set_net_class", { name: "Mains", nets: ["L1"], clearance: 2.5 })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toContain("Net class Mains made: clearance 2.5 mm, trace width 0.25 mm (Default's)")
    expect(out.result).toContain("Nets in it: L1.")
    const rules = out.project.rules
    expect(pairClearance(rules, "L1", "L2")).toBe(2.5)
    expect(pairClearance(rules, "L2", "GND")).toBe(rules.clearance)

    // Changed, then given back to Default, then removed.
    const wider = runTool(out.project, "set_net_class", { name: "mains", trace_width: 3 }).project
    expect(wider.rules.netClasses).toEqual([{ name: "Mains", clearance: 2.5, traceWidth: 3, nets: ["L1"] }])
    expect(runTool(wider, "set_net_class", { name: "Mains", reset: ["trace_width"], remove_nets: ["L1"] }).project.rules.netClasses).toEqual([{ name: "Mains", clearance: 2.5, nets: [] }])
    expect(runTool(wider, "set_net_class", { name: "Mains", remove: true }).project.rules.netClasses).toBeUndefined()
  })

  it("refuses an unknown net, a size out of range and the Default class, changing nothing", () => {
    const p = board()
    expect(runTool(p, "set_net_class", { name: "Mains", nets: ["L3"] }).result).toMatch(/no net named L3\. Did you mean|Nets: /)
    expect(runTool(p, "set_net_class", { name: "Mains", clearance: 20 }).result).toContain("clearance must be between 0 and 10 mm")
    expect(runTool(p, "set_net_class", { name: "Default", clearance: 1 }).result).toContain("set_design_rules")
    expect(runTool(p, "set_net_class", { name: "Mains", via_diameter: 0.5, via_drill: 0.6 }).result).toContain("must be smaller than its via diameter")
  })
})

describe("draw_trace", () => {
  it("draws a locked trace at the width asked, which routing keeps", () => {
    const out = runTool(board(), "draw_trace", { net: "L1", points: [-12, 3.75, 12, 3.75], width: 3 })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toMatch(/^Drew a 3 mm trace of L1 on top, 24\.00 mm long \(id \w+\), locked\. L1 has no open connections left\./)
    const t = out.project.traces.at(-1)!
    expect(t).toMatchObject({ layer: "top", width: 3, locked: true })
    expect(analyze(out.project).violations.filter((v) => v.severity === "error" && v.kind !== "unrouted")).toEqual([])
    expect(runTool(out.project, "clear_routing", {}).project.traces).toContainEqual(t)
  })

  it("is refused where it would short, touch nothing, or crowd a net of a wider class", () => {
    const p = board()
    expect(runTool(p, "draw_trace", { net: "L1", points: [-12, 3.75, 12, -3.75] }).result).toContain("Not drawn: it would short L1")
    expect(runTool(p, "draw_trace", { net: "L1", points: [-5, 10, 5, 10] }).result).toContain("Not drawn: it touches no copper of L1 (nothing at all)")
    // 1.2 mm past an L2 pad's edge: clear of the board's 0.2 mm, not of Mains's 2.5 mm.
    const past = { net: "L1", points: [12, 3.75, 9.2, 3.75, 9.2, -3.75] }
    expect(runTool(p, "draw_trace", past).isError).toBe(false)
    const mains = runTool(p, "set_net_class", { name: "Mains", nets: ["L1"], clearance: 2.5 }).project
    const refused = runTool(mains, "draw_trace", past)
    expect(refused.isError).toBe(true)
    expect(refused.result).toMatch(/^Error: Not drawn: .*clearance/i)
    expect(refused.project).toBe(mains)
  })

  it("runs from pin to pin, on their net, with no coordinates to know", () => {
    const out = runTool(board(), "draw_trace", { from: "J1.1", to: "J2.1", width: 3 })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toMatch(/^Drew a 3 mm trace of L1 on top from J1\.1 \(-12, 3\.75\) to J2\.1 \(12, 3\.75\), 24\.00 mm long/)
    expect(out.result).toContain("L1 has no open connections left")
    expect(out.project.traces.at(-1)).toMatchObject({ layer: "top", width: 3, locked: true, points: [{ x: -12, y: 3.75 }, { x: 12, y: 3.75 }] })
  })

  it("bends at 45 degrees into to, or goes through the corners given", () => {
    // J2 5 mm higher: straight for 19 mm, then 5 mm at 45 degrees.
    const p = board()
    const higher = { ...p, components: p.components.map((c) => (c.ref === "J2" ? { ...c, pcb: { ...c.pcb, y: 8.75 } } : c)) }
    const bent = runTool(higher, "draw_trace", { from: "J1.1", to: "J2.1" })
    expect(bent.isError, bent.result).toBe(false)
    expect(bent.project.traces.at(-1)!.points).toEqual([{ x: -12, y: 3.75 }, { x: 7, y: 3.75 }, { x: 12, y: 8.75 }])
    const through = runTool(board(), "draw_trace", { from: "J1.1", points: [0, 8], to: "J2.1" })
    expect(through.isError, through.result).toBe(false)
    expect(through.project.traces.at(-1)!.points).toEqual([{ x: -12, y: 3.75 }, { x: 0, y: 8 }, { x: 12, y: 3.75 }])
  })

  it("is refused between pins of two nets, on a net the pins are not on, or from a pin that is not there", () => {
    const p = board()
    expect(runTool(p, "draw_trace", { from: "J1.1", to: "J2.2" }).result).toContain("J1.1 is on L1 and J2.2 on L2: a trace joins pins of one net")
    expect(runTool(p, "draw_trace", { from: "J1.1", to: "J2.1", net: "L2" }).result).toContain("J1.1 is on L1, not L2")
    expect(runTool(p, "draw_trace", { from: "J9.1", to: "J2.1" }).result).toContain("There is no pin J9.1")
    const short = runTool(p, "draw_trace", { from: "J1.1", to: "J2.1", points: [-12, -3.75] })
    expect(short.isError).toBe(true)
    // Where it ran, so the next try can go round.
    expect(short.result).toContain("from J1.1 (-12, 3.75) to J2.1 (12, 3.75), through (-12, 3.75), (-12, -3.75), (12, 3.75)): it would short L1")
  })

  it("can end on a via to carry on on the other layer", () => {
    const first = runTool(board(), "draw_trace", { net: "L1", points: [-12, 3.75, 0, 3.75], width: 1, via_at_end: true })
    expect(first.result).toContain("with a via at (0, 3.75)")
    const second = runTool(first.project, "draw_trace", { net: "L1", points: [0, 3.75, 12, 3.75], layer: "bottom", width: 1 })
    expect(second.isError, second.result).toBe(false)
    expect(second.result).toContain("L1 has no open connections left")
  })
})

describe("route_pcb nets", () => {
  it("routes only the nets asked, and says what is left for the next call", () => {
    const out = runTool(board(), "route_pcb", { nets: ["L1"] })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toMatch(/^Routed 1 connection\(s\) of L1 /)
    expect(out.result).toContain("1 connection(s) of other nets are still open: route_pcb routes them.")
    const rest = runTool(out.project, "route_pcb", {})
    expect(rest.result).toMatch(/^Routed 1 connection\(s\) with/)
    expect(runTool(rest.project, "route_pcb", { nets: ["L1"] }).result).toBe("Every connection of L1 is already routed.")
    expect(runTool(board(), "route_pcb", { nets: ["L9"] }).result).toContain("No net named L9. Nets: ")
  })
})

describe("pcb_text", () => {
  it("puts a label on the silkscreen, then changes, moves and removes it by its id", () => {
    const out = runTool(board(), "pcb_text", { text: "A", x: -12, y: 7 })
    expect(out.isError, out.result).toBe(false)
    const id = /\(id (\S+)\)/.exec(out.result)![1]
    expect(out.project.texts.at(-1)).toMatchObject({ id, text: "A", layer: "F.SilkS", x: -12, y: 7, size: 1, side: "top" })
    const design = JSON.parse(runTool(out.project, "get_design", {}).result)
    expect(design.texts.board).toEqual([expect.objectContaining({ id, text: "A", layer: "F.SilkS" })])

    const moved = runTool(out.project, "pcb_text", { id, text: "L1", x: -12, y: 8, size: 1.5 })
    expect(moved.project.texts.at(-1)).toMatchObject({ id, text: "L1", y: 8, size: 1.5 })
    expect(runTool(moved.project, "pcb_text", { id, remove: true }).project.texts).toEqual([])
    expect(runTool(moved.project, "pcb_text", { id: "nope", remove: true }).result).toContain("There is no board text nope")
  })

  it("mirrors bottom text, and refuses copper text where it would touch another net", () => {
    const bottom = runTool(board(), "pcb_text", { text: "REV A", x: 0, y: -10, layer: "B.SilkS" }).project
    expect(bottom.texts.at(-1)).toMatchObject({ layer: "B.SilkS", mirror: true, side: "bottom" })
    const over = runTool(board(), "pcb_text", { text: "HOT", x: 12, y: -3.75, layer: "F.Cu", size: 2 })
    expect(over.isError).toBe(true)
    expect(over.result).toContain("Not placed")
    expect(runTool(board(), "pcb_text", { text: "X", x: 0, y: 0, layer: "Edge.Cuts" }).isError).toBe(true)
  })
})
