import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { FROZEN_EXAMPLES } from "./frozen-examples"
import { registerProjectParts } from "../src/model/customParts"
import { schematicPins } from "../src/model/instances"
import { addComponent, addWire, cleanupWires, createProject, dragPlan, moveSchematicItems } from "../src/model/ops"
import type { Project, Vec2 } from "../src/model/types"
import { netlist, netlistDiff } from "./sakura-session"
import { symbolAt } from "./tidy-shapes"

// Dragging a part on the canvas (and moving it with update_component) must not change what is
// connected to what. A drag stretches the wires attached to the part; whatever sat on a stretched
// wire (a net label in the middle of it, the end of a wire that tees into it) has to stay on it.

/** One drag as the canvas does it: the part and what hangs off it alone move, attached wires stretch, wires are tidied at the end. */
function drag(p: Project, ref: string, delta: Vec2): Project {
  const c = p.components.find((x) => x.ref === ref)!
  const { ids, bands } = dragPlan(p, { components: [c.id], labels: [], wires: [] })
  return cleanupWires(moveSchematicItems(p, ids, delta, bands))
}

const pinAt = (p: Project, ref: string, pin: string) => schematicPins(p.components.find((c) => c.ref === ref)!).find((q) => q.pin === pin)!.pos

const DELTAS: Vec2[] = [{ x: 0, y: 0.2 }, { x: 0, y: -0.2 }, { x: 0.1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 3 }, { x: -2.5, y: 1.5 }, { x: 6, y: -4 }]

describe("a drag keeps every pin on its net", () => {
  it("keeps the label in the middle of a wire on the wire (J3 of the ESP32 robot)", () => {
    const p = FROZEN_EXAMPLES.find((e) => e.id === "esp32-robot")!.project
    registerProjectParts(p)
    const before = netlist(p)
    expect(before.get("J3.1")).toBe("VBAT_IN")
    for (const delta of DELTAS) {
      const moved = drag(p, "J3", delta)
      expect(netlistDiff(before, netlist(moved)), `J3 by ${JSON.stringify(delta)}`).toEqual([])
    }
  })

  it("keeps a wire that ends on the first run leaving a pin attached when the part moves 0.2 (the U3.13 tee)", () => {
    // R1.2 runs right, then down to R2.1. R3 hangs off the middle of that first run with a wire of its own.
    let p = createProject("t")
    p = addComponent(p, "resistor", { sch: { x: 0, y: 0, rot: 0 } }).project
    p = addComponent(p, "resistor", { sch: { x: 3.3, y: -2, rot: 0 } }).project
    p = addComponent(p, "resistor", { sch: { x: 0.9, y: 2, rot: 0 } }).project
    expect(pinAt(p, "R1", "2")).toEqual({ x: 0.3, y: 0 })
    expect(pinAt(p, "R2", "1")).toEqual({ x: 3, y: -2 })
    expect(pinAt(p, "R3", "1")).toEqual({ x: 0.6, y: 2 })
    p = addWire(p, [{ x: 0.3, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -2 }, { x: 3, y: -2 }]).project
    p = addWire(p, [{ x: 0.6, y: 0 }, { x: 0.6, y: 2 }]).project
    const before = netlist(p)
    expect(before.get("R3.1")).toBe(before.get("R1.2"))
    expect(before.get("R3.1")).toBe(before.get("R2.1"))
    for (const delta of DELTAS) {
      expect(netlistDiff(before, netlist(drag(p, "R1", delta))), `drag R1 by ${JSON.stringify(delta)}`).toEqual([])
    }
    const out = runTool(p, "update_component", { ref: "R1", x: 0, y: 0.2 })
    expect(out.isError, out.result).toBe(false)
    expect(netlistDiff(before, netlist(out.project))).toEqual([])
  })

  it("keeps two parts that share one wire with a GND symbol on a tee in the middle of it", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { sch: { x: 0, y: 0, rot: 0 } }).project
    p = addComponent(p, "resistor", { sch: { x: 2.6, y: 0, rot: 0 } }).project
    p = addComponent(p, "resistor", { sch: { x: 1.3, y: 4, rot: 0 } }).project
    const a = pinAt(p, "R1", "2")
    const b = pinAt(p, "R2", "1")
    const mid = { x: (a.x + b.x) / 2, y: a.y }
    p = addWire(p, [a, b]).project
    p = addWire(p, [mid, { x: mid.x, y: mid.y + 0.3 }]).project
    p = symbolAt(p, "GND", { x: mid.x, y: mid.y + 0.3 }, "up")
    const before = netlist(p)
    expect(before.get("R1.2")).toBe("GND")
    expect(before.get("R2.1")).toBe("GND")
    for (const ref of ["R1", "R2"]) {
      for (const delta of DELTAS) {
        expect(netlistDiff(before, netlist(drag(p, ref, delta))), `drag ${ref} by ${JSON.stringify(delta)}`).toEqual([])
      }
    }
    for (const [x, y] of [[0, 6], [-3, -3], [0, 0.2]]) {
      const out = runTool(p, "update_component", { ref: "R1", x, y })
      if (!out.isError) expect(netlistDiff(before, netlist(out.project))).toEqual([])
    }
  })
})
