import { describe, expect, it } from "vitest"
import { schematicPins } from "../src/model/instances"
import { runTool } from "../src/ai/tools"
import { dragSelection, rotateSelection } from "../src/model/schematicEdit"
import { addComponent, addLabel, addWire, createProject, findRubberBands, moveSchematicItems, partFollowers } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { firstDrawn, netlist, netlistDiff, Session, U2_PART } from "./sakura-session"
import { clearStub, comb, portOnPin, symbolAt } from "./tidy-shapes"

// A Sakura session: "Updated U2: moved to (30, -30)", after which Sakura had to reconnect U2's GND
// and 3V3. The move cut five pins loose and was accepted.
//
// Cause: moveComponent took along only a part's "stubs", wires that end in a net label, and
// stretched wire ends that sit on the part's pins. Tidy draws a supply as a comb between
// pins with a tee to a power symbol, or a symbol right on a pin. The comb moved with U2; the tee and
// the symbols stayed, so U2's GND, SDO, CSB, VDD and VDDIO were cut off their nets. update_component
// saw it (connectionsLost) and still accepted the move, with a note in the reply text only; the
// transcript line, which is all the user sees, said just "Updated U2: moved to (30, -30)".
//
// This branch has no Tidy, so the sheet is built the way Tidy draws it: the plain drawing `connect`
// makes, with the supply labels on U2 swapped for what Tidy puts there (tidy-shapes.ts).

/** The BME280's supply pins as Tidy draws them: GND and 3V3 combs with a tee to a symbol, SDO and CSB with a symbol on the pin. */
function tidiedSheet(): Session {
  const s = firstDrawn({ at: { U2: { x: -8, y: -12 } } })
  const before = netlist(s.project)
  let p = s.project
  const pin = (n: string) => schematicPins(p.components.find((c) => c.ref === "U2")!).find((q) => q.pin === n)!
  const draw = (next: Project | null) => {
    if (!next) throw new Error("shape not drawn")
    p = next
  }
  draw(comb(p, [pin("1"), pin("7")], "GND"))
  draw(comb(p, [pin("6"), pin("8")], "3V3"))
  draw(portOnPin(p, pin("5"), "GND"))
  draw(portOnPin(p, pin("2"), "3V3"))
  s.project = p
  s.start = p
  // What was drawn must be the same netlist, or the tests below prove nothing.
  expect(netlistDiff(before, netlist(p))).toEqual([])
  return s
}

/**
 * Only the supplies: U2 with its GND and 3V3 drawn as Tidy draws them, and a capacitor on each rail
 * somewhere else. Nothing else is near U2's pins, so a move cannot be refused for landing on
 * another net, and the only way it goes wrong is by leaving a symbol or a wire behind.
 */
function supplySheet(): Session {
  const s = new Session()
  s.must("add_component", { part_id: U2_PART, ref: "U2", x: 0, y: 0 })
  s.must("add_component", { part_id: "capacitor", ref: "C1", x: 12, y: 0 })
  s.must("add_component", { part_id: "capacitor", ref: "C2", x: 12, y: 6 })
  s.must("connect", { pins: ["U2.1", "U2.7", "U2.SDO", "C1.2"], net_name: "GND" })
  s.must("connect", { pins: ["U2.6", "U2.8", "U2.CSB", "C1.1", "C2.1"], net_name: "3V3" })
  let p = s.project
  const before = netlist(p)
  const pin = (n: string) => schematicPins(p.components.find((c) => c.ref === "U2")!).find((q) => q.pin === n)!
  for (const next of [comb(p, [pin("1"), pin("7")], "GND")]) if (next) p = next
  for (const next of [comb(p, [pin("6"), pin("8")], "3V3")]) if (next) p = next
  for (const [n, net] of [["5", "GND"], ["2", "3V3"]]) {
    const next = portOnPin(p, pin(n), net)
    if (next) p = next
  }
  s.project = p
  s.start = p
  expect(netlistDiff(before, netlist(p))).toEqual([])
  return s
}

const portsOn = (s: Session) => {
  const u2 = schematicPins(s.ref("U2"))
  const near = (c: { sch: { x: number; y: number } }) => u2.some((q) => Math.abs(q.pos.x - c.sch.x) < 1.2 && Math.abs(q.pos.y - c.sch.y) < 1.2)
  return s.project.components.filter((c) => c.ref.startsWith("#") && near(c)).length
}

describe("update_component moving U2 across the sheet", () => {
  it("keeps U2's supply pins connected, or refuses the move", () => {
    const s = tidiedSheet()
    const before = netlist(s.project)
    const out = s.run("update_component", { ref: "U2", x: 30, y: -30 })
    if (!out.isError) expect(netlistDiff(before, netlist(s.project))).toEqual([])
    else expect(s.project).toBe(s.start)
  })

  it("takes the power symbols and the comb's tee along with it", () => {
    const s = tidiedSheet()
    const before = netlist(s.project)
    expect(portsOn(s)).toBeGreaterThanOrEqual(4)
    const out = s.run("update_component", { ref: "U2", x: 30, y: -30 })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).not.toMatch(/no longer on/)
    expect(netlistDiff(before, netlist(s.project))).toEqual([])
    // The four symbols that sat at U2 are at U2's new place, and none is left at the old one.
    expect(portsOn(s)).toBeGreaterThanOrEqual(4)
    const old = s.project.components.filter((c) => c.ref.startsWith("#") && Math.hypot(c.sch.x + 8, c.sch.y + 12) < 3)
    expect(old).toEqual([])
  })

  it("moves back and forth without losing a pin", () => {
    const s = tidiedSheet()
    const before = netlist(s.project)
    for (const [x, y] of [[30, -30], [-8, -12], [20, -20]]) {
      const out = s.must("update_component", { ref: "U2", x, y })
      expect(out.result).not.toMatch(/no longer on/)
      expect(netlistDiff(before, netlist(s.project))).toEqual([])
    }
  })

  it("never reports a move that cut pins loose as a plain success", () => {
    const s = tidiedSheet()
    const out = s.run("update_component", { ref: "U2", x: 30, y: -30 })
    if (!out.isError && out.result.includes("no longer on")) expect(out.summary).toMatch(/no longer|disconnect|cut/i)
  })
})

describe("a part with only its supplies drawn as symbols", () => {
  it("moves with the symbols and the comb, every pin still on its rail", () => {
    const s = supplySheet()
    expect(s.project.components.filter((c) => c.ref.startsWith("#")).length).toBeGreaterThanOrEqual(4)
    const before = netlist(s.project)
    for (const [x, y] of [[0, -10], [30, -30], [-8, 5]]) {
      const out = s.run("update_component", { ref: "U2", x, y })
      expect(out.isError, out.result).toBe(false)
      expect(out.result).not.toMatch(/no longer on/)
      expect(netlistDiff(before, netlist(s.project))).toEqual([])
    }
  })

  it("turns with the symbols too", () => {
    const s = supplySheet()
    const before = netlist(s.project)
    for (const rotation of [90, 180, 270, 0]) {
      const out = s.run("update_component", { ref: "U2", rotation })
      expect(out.isError, out.result).toBe(false)
      expect(netlistDiff(before, netlist(s.project))).toEqual([])
    }
  })
})

describe("a label in the middle of a wire stays on the wire when the part moves", () => {
  /** U2.SCK wired straight to a resistor, with the net's label sitting on the middle of that wire. */
  function labelOnWire(): Session {
    const s = tidiedSheet()
    const sck = schematicPins(s.ref("U2")).find((q) => q.pin === "4")!
    s.project = clearStub(s.project, sck)!
    s.must("add_component", { part_id: "resistor", ref: "R9", x: sck.pos.x + 3.3, y: sck.pos.y })
    const r9 = schematicPins(s.ref("R9")).find((q) => q.pin === "1")!
    expect(r9.pos.y).toBe(sck.pos.y)
    let p = addWire(s.project, [sck.pos, r9.pos]).project
    const mid = { x: Math.round(((sck.pos.x + r9.pos.x) / 2) * 10) / 10, y: sck.pos.y }
    p = addLabel(p, "SCK_TEST", mid, 0).project
    s.project = p
    s.start = p
    return s
  }

  it("moves the label onto the stretched wire, so the net keeps its name", () => {
    const s = labelOnWire()
    const before = netlist(s.project)
    expect(before.get("U2.4")).toBe("SCK_TEST")
    // Far enough right that the stretched wire no longer runs under the label where it was.
    for (const [x, y] of [[-6, -12], [-9, -12], [-7, -9], [-8, -15]]) {
      const out = s.run("update_component", { ref: "U2", x, y })
      expect(out.isError, out.result).toBe(false)
      expect(netlistDiff(before, netlist(s.project))).toEqual([])
    }
  })
})

describe("pins that touch another part's pin directly", () => {
  // A ground symbol sits on a point where R1's pin and R2's pin overlap. It is R2's as much as R1's,
  // so R1 cannot take it along: moving R1 away used to take R1.2 off the rail and apart from R2.1.
  // Now a wire joins R1.2 to the pins that stayed, as a wire on the pin would have followed it.
  function overlapping() {
    let p = createProject("t")
    p = addComponent(p, "resistor", { sch: { x: 0, y: 0, rot: 0 } }).project
    p = addComponent(p, "resistor", { sch: { x: 0.6, y: 0, rot: 0 } }).project
    expect(schematicPins(p.components[0])[1].pos).toEqual(schematicPins(p.components[1])[0].pos)
    return symbolAt(p, "GND", { x: 0.3, y: 0 }, "up")
  }

  it("keeps a moved part on the pins it touched, with a wire", () => {
    const p = overlapping()
    const before = netlist(p)
    expect(before.get("R1.2")).toBe("GND")
    const out = runTool(p, "update_component", { ref: "R1", x: 0, y: -4 })
    expect(out.isError, out.result).toBeFalsy()
    expect(netlistDiff(before, netlist(out.project))).toEqual([])
    expect(out.project.wires.length).toBe(p.wires.length + 1)
  })

  it("lets a power symbol set right on a pin be dragged and turned, and keeps the pin on its rail", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { sch: { x: 0, y: 0, rot: 0 } }).project
    const r1 = p.components[0]
    p = symbolAt(p, "GND", schematicPins(r1)[1].pos, "right")
    const gnd = p.components[1]
    const before = netlist(p)
    expect(before.get("R1.2")).toBe("GND")
    for (const d of [{ x: 0.1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 1 }]) {
      const dragged = dragSelection(p, { components: [gnd.id], labels: [], wires: [] }, d)
      expect(dragged.ok, dragged.ok ? "" : dragged.message).toBe(true)
      if (dragged.ok) expect(netlistDiff(before, netlist(dragged.project))).toEqual([])
    }
    const turned = rotateSelection(p, { components: [gnd.id], labels: [] })
    expect(turned.ok, turned.ok ? "" : turned.message).toBe(true)
    if (turned.ok) expect(netlistDiff(before, netlist(turned.project))).toEqual([])
  })

  it("still refuses the move when the wire it would draw lands on another net", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { sch: { x: 0, y: 0, rot: 0 } }).project
    const pin = schematicPins(p.components[0])[1].pos
    p = symbolAt(p, "GND", pin, "right")
    const gnd = p.components[1]
    // A wire of another net, SIG, that ends where the wire to the moved symbol would run.
    p = addWire(p, [{ x: pin.x, y: pin.y - 0.5 }, { x: pin.x + 1, y: pin.y - 0.5 }]).project
    p = addLabel(p, "SIG", { x: pin.x + 1, y: pin.y - 0.5 }).project
    const dragged = dragSelection(p, { components: [gnd.id], labels: [], wires: [] }, { x: 0, y: -1 })
    expect(dragged.ok).toBe(false)
    if (!dragged.ok) expect(dragged.message).toMatch(/would join/)
  })
})

describe("dragging on the canvas takes the same things along", () => {
  it("carries the power symbols and the comb with a dragged part", () => {
    const s = tidiedSheet()
    const before = netlist(s.project)
    const p = s.project
    const u2 = s.ref("U2")
    const f = partFollowers(p, [u2.id])
    expect(f.components.length).toBe(4)
    const ids = { components: [u2.id, ...f.components], labels: f.labels, wires: f.wires }
    const bands = findRubberBands(p, ids.components, ids.labels, ids.wires)
    const dragged = moveSchematicItems(p, ids, { x: 5, y: -4 }, bands)
    expect(netlistDiff(before, netlist(dragged))).toEqual([])
  })
})
