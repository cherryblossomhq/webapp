import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { rotateSelection } from "../src/model/schematicEdit"
import type { Project } from "../src/model/types"
import { firstDrawn, netlist, netlistDiff } from "./sakura-session"

// Found while explaining a Sakura session: one R press on the USB-C connector J1 in the schematic
// moved D+, D-, CC2 and VBUS onto CC1 and cut J1's GND loose, with no tool call in the log.
//
// Cause: the R key (SchematicEditor) turned the part, then re-pointed the wire ends that sat on its
// pins with an elbow from the wire's next point and never checked the result. The elbows ran over
// other pins and wires, and the net labels at the far end of each pin's stub stayed behind. Now the
// turn is rotateSelection (model/schematicEdit.ts): what hangs off the part's pins turns with it
// (rotateComponent, ops.ts), wires to other parts follow the pins, and a turn that still changes
// the netlist is refused.

const pressR = (p: Project, ref: string) => rotateSelection(p, { components: [p.components.find((c) => c.ref === ref)!.id], labels: [] })

/** The same design with every part a long way from the others, so nothing can touch. */
const FAR: Record<string, { x: number; y: number }> = {
  U1: { x: 0, y: 0 }, U2: { x: 12, y: 0 }, U3: { x: 18, y: 0 }, J1: { x: -10, y: 0 }, SW1: { x: 24, y: 0 }, SW2: { x: 28, y: 0 }, D1: { x: 32, y: 0 },
  R1: { x: -10, y: -8 }, R2: { x: -7, y: -8 }, R3: { x: -4, y: -8 }, R4: { x: -1, y: -8 }, R5: { x: 2, y: -8 }, R6: { x: 5, y: -8 }, R7: { x: 8, y: -8 },
  C1: { x: -10, y: -12 }, C2: { x: -7, y: -12 }, C3: { x: -4, y: -12 }, C4: { x: -1, y: -12 }, C5: { x: 2, y: -12 },
}

describe("R on J1 in the schematic", () => {
  it("the design keeps its nets wherever add_component puts the parts", () => {
    const placed = firstDrawn().project
    expect(computeConnectivity(placed).conflicts).toEqual([])
    // Placed far apart, nothing can touch: that sheet is what the nets are meant to be.
    const apart = firstDrawn({ at: FAR }).project
    expect(computeConnectivity(apart).conflicts).toEqual([])
    expect(netlistDiff(netlist(placed), netlist(apart))).toEqual([])
  })

  it("parts packed in one row 1.3 apart, as main's add_component put them, never have nets touching (main: 42 pins on the wrong net)", () => {
    const at: Record<string, { x: number; y: number }> = {}
    Object.keys(FAR).forEach((ref, i) => (at[ref] = { x: i * 1.3, y: 0 }))
    let p: Project
    try {
      p = firstDrawn({ at }).project
    } catch (e) {
      // connect may refuse a net it can't draw without touching another, and says nothing was changed.
      expect(String(e)).toMatch(/Nothing was changed/)
      return
    }
    expect(computeConnectivity(p).conflicts).toEqual([])
    // A pin may be left out (named in connect's reply), but none may be on another net's name.
    const want = netlist(firstDrawn({ at: FAR }).project)
    for (const [pin, net] of netlist(p)) if (net) expect(net, pin).toBe(want.get(pin))
  })

  it("never joins nets or cuts pins loose", () => {
    const p = firstDrawn().project
    const res = pressR(p, "J1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(netlistDiff(netlist(p), netlist(res.project))).toEqual([])
  })

  it("turns J1 with its labels, so the sheet is the same sheet turned", () => {
    const p = firstDrawn({ at: FAR }).project
    const res = pressR(p, "J1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.project.components.find((c) => c.ref === "J1")!.sch.rot).toBe(90)
    expect(netlistDiff(netlist(p), netlist(res.project))).toEqual([])
    // Every label is still where a wire of its own ends; none is left behind in the air.
    const ends = res.project.wires.flatMap((w) => [w.points[0], w.points[w.points.length - 1]])
    for (const l of res.project.labels) expect(ends.some((e) => Math.abs(e.x - l.x) < 1e-6 && Math.abs(e.y - l.y) < 1e-6)).toBe(true)
  })

  it("four presses bring J1 home with the same netlist", () => {
    const start = firstDrawn().project
    let p = start
    for (let i = 0; i < 4; i++) {
      const res = pressR(p, "J1")
      expect(res.ok).toBe(true)
      if (res.ok) p = res.project
    }
    expect(p.components.find((c) => c.ref === "J1")!.sch.rot).toBe(0)
    expect(netlistDiff(netlist(start), netlist(p))).toEqual([])
  })

  it("on a J1 that was drawn turned 90", () => {
    const p = firstDrawn({ j1Rot: 90 }).project
    const res = pressR(p, "J1")
    expect(res.ok).toBe(true)
    if (res.ok) expect(netlistDiff(netlist(p), netlist(res.project))).toEqual([])
  })

  it("every part of the sheet turns, with every pin on its net", () => {
    const p = firstDrawn().project
    for (const c of p.components) {
      const res = rotateSelection(p, { components: [c.id], labels: [] })
      expect(res.ok, `${c.ref}: ${res.ok ? "" : res.message}`).toBe(true)
      if (res.ok) expect(netlistDiff(netlist(p), netlist(res.project)), c.ref).toEqual([])
    }
  })

  it("all the parts at once", () => {
    const p = firstDrawn().project
    const res = rotateSelection(p, { components: p.components.map((c) => c.id), labels: p.labels.map((l) => l.id) })
    expect(res.ok).toBe(true)
    if (res.ok) expect(netlistDiff(netlist(p), netlist(res.project))).toEqual([])
  })

  it("parts crowded 1.6 apart, where connect's labels nearly meet, are turned or refused untouched", () => {
    const at: Record<string, { x: number; y: number }> = {}
    Object.keys(FAR).forEach((ref, i) => (at[ref] = { x: (i % 10) * 1.6, y: -Math.floor(i / 10) * 3 }))
    const p = firstDrawn({ at }).project
    for (const c of p.components) {
      const res = rotateSelection(p, { components: [c.id], labels: [] })
      if (res.ok) expect(netlistDiff(netlist(p), netlist(res.project)), c.ref).toEqual([])
      else expect(res.message, c.ref).toMatch(/^Didn't turn .*Nothing was changed\./)
    }
  })
})
