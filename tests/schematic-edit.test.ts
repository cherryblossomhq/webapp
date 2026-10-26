import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { modelAssignment, setModel, supplierModel } from "../src/model/models3d"
import { addComponent, addLabel, addWire, createProject } from "../src/model/ops"
import { dragSelection, pasteItems, placeComponent, rotateSelection } from "../src/model/schematicEdit"
import type { Project } from "../src/model/types"
import { netlist, netlistDiff } from "./sakura-session"

// The canvas edits that move things without meaning to connect them: turn, drag, paste, drop. Each
// is checked and refused, with nothing changed, only when it would join two nets that each stand
// for something (both named, or both unnamed with 2+ pins), cut a pin off its net, or leave a pin
// lying on another net's wire. Drawing is not refused: a symbol dropped on a pin, a label naming a
// wire, a pin meeting a loose wire, a resistor dropped in line on a wire. The Sakura session's own
// sheet is in sakura-canvas-rotate-shorts.test.ts, the random walk in schematic-edit-fuzz.test.ts.

/**
 * R1 at (0,0) and R2 at (3,0). R1's pin 2 runs by a wire to a label A at (2,0); R2's pin 1 to a
 * label B at (1,-3) by a wire that goes down first. Two resistors on two named nets, with room.
 */
function sheet(): { p: Project; r1: string; r2: string } {
  let p = createProject("t")
  p = addComponent(p, "resistor", { ref: "R1", sch: { x: 0, y: 0, rot: 0 } }).project
  p = addComponent(p, "resistor", { ref: "R2", sch: { x: 3, y: 0, rot: 0 } }).project
  const [r1, r2] = p.components
  const r1p2 = schematicPins(r1).find((q) => q.pin === "2")!.pos
  const r2p1 = schematicPins(r2).find((q) => q.pin === "1")!.pos
  p = addWire(p, [r1p2, { x: 2, y: 0 }]).project
  p = addLabel(p, "A", { x: 2, y: 0 }).project
  p = addWire(p, [r2p1, { x: r2p1.x, y: -3 }, { x: 1, y: -3 }]).project
  p = addLabel(p, "B", { x: 1, y: -3 }, 180).project
  return { p, r1: r1.id, r2: r2.id }
}

const pinPos = (p: Project, id: string, pin: string) => schematicPins(p.components.find((c) => c.id === id)!).find((q) => q.pin === pin)!.pos
const netOf = (p: Project, ref: string, pin: string) => netlist(p).get(`${ref}.${pin}`)
const sameAt = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/** A power symbol of `part` ("ground" or "power") with its pin at `at`. */
function symbolAt(p: Project, part: "ground" | "power", at: { x: number; y: number }, props: Record<string, string> = {}): Project {
  const probe = addComponent(p, part, { props, sch: { x: 0, y: 0, rot: 0 } }).component
  const pin = schematicPins(probe)[0].pos
  return addComponent(p, part, { props, sch: { x: at.x - pin.x, y: at.y - pin.y, rot: 0 } }).project
}

describe("turning", () => {
  it("takes the wire to the pin and keeps the nets", () => {
    const { p, r1 } = sheet()
    const res = rotateSelection(p, { components: [r1], labels: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(netlistDiff(netlist(p), netlist(res.project))).toEqual([])
    expect(res.project.components.find((c) => c.id === r1)!.sch.rot).toBe(90)
  })

  /** R1 with a wire of net B ending exactly where its pin 2 goes in a quarter turn: (0.3, 0) to (0, 0.3). */
  function blocked() {
    const { p, r1 } = sheet()
    let q = addWire(p, [{ x: 0, y: 0.3 }, { x: 0, y: 2 }]).project
    q = addLabel(q, "B", { x: 0, y: 2 }, 90).project
    return { q, r1 }
  }

  it("is refused when a pin would land on another named net, and says what it would join and what to do", () => {
    const { q, r1 } = blocked()
    // Two parts selected: there is no other position to go to, so the turn is refused.
    const r2 = q.components.find((c) => c.ref === "R2")!.id
    const before = JSON.stringify(q)
    const res = rotateSelection(q, { components: [r1, r2], labels: [] })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toMatch(/^Didn't turn 2 parts: it would join A.* and B.*\. Nothing was changed\. Move it off the other part's pins and wires/)
    expect(JSON.stringify(q)).toBe(before)
  })

  it("a single part whose quarter turn is blocked goes to the next position that works, and says why", () => {
    const { q, r1 } = blocked()
    const res = rotateSelection(q, { components: [r1], labels: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.project.components.find((c) => c.id === r1)!.sch.rot).toBe(180)
    expect(res.note).toMatch(/^Turned R1 180 degrees instead of 90, because at 90 degrees it would join A.* and B.*\.$/)
    expect(netlistDiff(netlist(q), netlist(res.project))).toEqual([])
  })

  it("turns a part with a ground symbol sitting right on its pin, and the symbol goes with it", () => {
    const { p, r1 } = sheet()
    const withGnd = symbolAt(p, "ground", pinPos(p, r1, "1"))
    expect(netOf(withGnd, "R1", "1")).toBe("GND")
    let q = withGnd
    for (let i = 0; i < 4; i++) {
      const res = rotateSelection(q, { components: [r1], labels: [] })
      expect(res.ok, res.ok ? "" : res.message).toBe(true)
      if (!res.ok) return
      q = res.project
      expect(netOf(q, "R1", "1")).toBe("GND")
      const sym = q.components.find((c) => c.ref.startsWith("#GND"))!
      expect(sameAt(schematicPins(sym)[0].pos, pinPos(q, r1, "1"))).toBe(true)
    }
  })

  it("turns a part with a supply symbol on a tee of a wire from its pin", () => {
    const { p, r1 } = sheet()
    // R1's pin 1 at (-0.15, 0): a wire goes left to (-1, 0), with a power symbol at its end.
    let q = addWire(p, [pinPos(p, r1, "1"), { x: -1, y: 0 }]).project
    q = symbolAt(q, "power", { x: -1, y: 0 }, { net: "3V3" })
    expect(netOf(q, "R1", "1")).toBe("3V3")
    const res = rotateSelection(q, { components: [r1], labels: [] })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (res.ok) expect(netOf(res.project, "R1", "1")).toBe("3V3")
  })
})

describe("dragging", () => {
  it("to open space takes the part's labels with it and keeps the nets", () => {
    const { p, r1 } = sheet()
    const res = dragSelection(p, { components: [r1], labels: [], wires: [] }, { x: -4, y: 2 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(netlistDiff(netlist(p), netlist(res.project))).toEqual([])
    const a = res.project.labels.find((l) => l.name === "A")!
    expect([a.x, a.y]).toEqual([-2, 2])
  })

  it("a part with a symbol on its pin keeps it when dragged", () => {
    const { p, r2 } = sheet()
    const q = symbolAt(p, "ground", pinPos(p, r2, "2"))
    const res = dragSelection(q, { components: [r2], labels: [], wires: [] }, { x: 0, y: 5 })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (res.ok) expect(netOf(res.project, "R2", "2")).toBe("GND")
  })

  it("a pin dropped on the end of a loose wire, or on an unnamed net, joins it", () => {
    let { p, r2 } = sheet()
    // A loose wire end at (6, 0), and an unnamed net of two pins (R1.1 and R2.2 by a wire) elsewhere.
    p = addWire(p, [{ x: 6, y: 0 }, { x: 6, y: 1 }]).project
    const res = dragSelection(p, { components: [r2], labels: [], wires: [] }, { x: 3, y: 0 })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    // R2.2 was at (3.15, 0) and is now (6.15, 0): not on the wire end at (6, 0). R2.1 is at (5.85, 0).
    // One more step puts R2.1 on the wire end.
    const onto = dragSelection(p, { components: [r2], labels: [], wires: [] }, { x: 3.15, y: 0 })
    expect(onto.ok, onto.ok ? "" : onto.message).toBe(true)
  })

  it("a pin dropped on the end of another named net's wire is refused as a join", () => {
    const { p, r2 } = sheet()
    // R2's pin 1 is at (2.85, 0), on net B; the end of A's wire is at (2, 0).
    const res = dragSelection(p, { components: [r2], labels: [], wires: [] }, { x: -0.85, y: 0 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/^Didn't move R2: it would join .*A.* and .*B.*\. Nothing was changed\./)
  })

  it("a pin dropped on the middle of a wire is refused, and the message says to cut the wire first", () => {
    let { p } = sheet()
    p = addComponent(p, "resistor", { ref: "R3", sch: { x: 10, y: 10, rot: 90 } }).project
    const r3 = p.components.find((c) => c.ref === "R3")!
    // R3 stands upright: pin 1 at (10, 9.7), pin 2 at (10, 10.3). Pin 1 is dragged onto A's wire (y = 0) at x = 1; pin 2 is off it.
    const res = dragSelection(p, { components: [r3.id], labels: [], wires: [] }, { x: -9, y: -9.7 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/R3\.1 would sit under the wire of A.*Cut the wire first/)
  })

  it("says what a cut leaves: the pins on the other side, or that the net falls apart", () => {
    // An unnamed net of R1.1 and R2.2 by one wire; the wire dragged away cuts both loose.
    let { p } = sheet()
    const a = pinPos(p, p.components[0].id, "1")
    const b = pinPos(p, p.components[1].id, "2")
    p = addWire(p, [a, { x: a.x, y: 1.5 }, { x: b.x, y: 1.5 }, b]).project
    const wire = p.wires[p.wires.length - 1]
    const res = dragSelection(p, { components: [], labels: [], wires: [wire.id] }, { x: 0, y: 2 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/it would split R1\.1 and R2\.2 apart|it would cut R1\.1 off R2\.2|it would cut R2\.2 off R1\.1/)
  })

  it("a wire dragged off the pins it joins is refused as a cut", () => {
    const { p } = sheet()
    const wire = p.wires.find((w) => w.points.some((q) => q.x === 2 && q.y === 0))!
    const res = dragSelection(p, { components: [], labels: [], wires: [wire.id] }, { x: 0, y: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/^Didn't move the selection: it would cut /)
  })
})

describe("dropping a symbol, pasting a label", () => {
  it("a ground symbol dropped on a pin puts the pin on GND", () => {
    const { p, r1 } = sheet()
    const at = pinPos(p, r1, "1")
    const probe = addComponent(p, "ground", {}).component
    const pin = schematicPins(probe)[0].pos
    const res = placeComponent(p, "ground", { sch: { x: at.x - pin.x, y: at.y - pin.y, rot: 0 } })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (res.ok) expect(netOf(res.project, "R1", "1")).toBe("GND")
  })

  it("a power symbol dropped on the end of a wire joins that net to its rail when the wire's net has no name", () => {
    let { p } = sheet()
    // A wire from R1's pin 1 to (-1, 0): an unnamed net of one pin.
    p = addWire(p, [pinPos(p, p.components[0].id, "1"), { x: -1, y: 0 }]).project
    const probe = addComponent(p, "power", { props: { net: "5V" } }).component
    const pin = schematicPins(probe)[0].pos
    const res = placeComponent(p, "power", { props: { net: "5V" }, sch: { x: -1 - pin.x, y: 0 - pin.y, rot: 0 } })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (res.ok) expect(netOf(res.project, "R1", "1")).toBe("5V")
  })

  it("a power symbol on the end of a net that already has another name is refused", () => {
    const { p } = sheet()
    const probe = addComponent(p, "power", { props: { net: "5V" } }).component
    const pin = schematicPins(probe)[0].pos
    const res = placeComponent(p, "power", { props: { net: "5V" }, sch: { x: 2 - pin.x, y: 0 - pin.y, rot: 0 } })
    expect(res.ok).toBe(false)
  })

  it("a label pasted on an unnamed net's wire names it", () => {
    let { p } = sheet()
    const a = pinPos(p, p.components[0].id, "1")
    const b = pinPos(p, p.components[1].id, "2")
    p = addWire(p, [a, { x: a.x, y: 1 }, { x: b.x, y: 1 }, b]).project
    expect(netOf(p, "R1", "1")).toMatch(/^Net-/)
    const clip = addLabel(createProject("clip"), "NEW", { x: 1, y: 1 })
    const res = pasteItems(p, { project: clip.project, components: [], wires: [], labels: [clip.label.id] , blocks: [] }, { x: 0, y: 0 }, "paste")
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (res.ok) {
      expect(netOf(res.project, "R1", "1")).toBe("NEW")
      expect(netOf(res.project, "R2", "2")).toBe("NEW")
    }
  })

  it("a label named for another net, pasted on a named wire, is refused as a join", () => {
    const { p } = sheet()
    const clip = addLabel(createProject("clip"), "B", { x: 1, y: 0 })
    const res = pasteItems(p, { project: clip.project, components: [], wires: [], labels: [clip.label.id] , blocks: [] }, { x: 0, y: 0 }, "paste")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/^Didn't paste: it would join A.* and B/)
  })

  it("a pasted wire that would bridge two named nets is refused, and goes through elsewhere", () => {
    const { p, r1 } = sheet()
    const clip = addWire(createProject("clip"), [{ x: 1, y: 0 }, { x: 1, y: -3 }])
    const ref = { project: clip.project, components: [], wires: [clip.wire!.id], labels: [] , blocks: [] }
    const bridge = pasteItems(p, ref, { x: 0, y: 0 }, "paste")
    expect(bridge.ok).toBe(false)
    if (!bridge.ok) expect(bridge.message).toMatch(/^Didn't paste: it would join .* and .*\. Nothing was changed\./)
    expect(pasteItems(p, ref, { x: 20, y: 0 }, "paste").ok).toBe(true)
    const part = pasteItems(p, { project: p, components: [r1], wires: [], labels: [] , blocks: [] }, { x: 0, y: -8 }, "duplicate")
    expect(part.ok).toBe(true)
  })
})

describe("a resistor dropped on a wire", () => {
  it("goes in line: the wire is cut at its pins and runs through it", () => {
    const { p } = sheet()
    // A's wire runs (0.15,0) to (2,0). R3 at (1.15, 0), pins at 1.0 and 1.3: both on its middle.
    const res = placeComponent(p, "resistor", { ref: "R3", sch: { x: 1.15, y: 0, rot: 0 } })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (!res.ok) return
    const q = res.project
    // The net runs through the part: R1.2 on one side, R3's pin 1 with it; pin 2 on the far side, still A.
    expect(netOf(q, "R3", "2")).toBe("A")
    expect(netOf(q, "R3", "1")).toBe(netOf(q, "R1", "2"))
    expect(netOf(q, "R1", "2")).not.toBe("A")
    expect(netOf(q, "R2", "1")).toBe("B")
    expect(q.wires).toHaveLength(p.wires.length + 1)
    expect(computeConnectivity(q).conflicts).toEqual([])
  })

  it("is the same for a part that is dragged there", () => {
    let { p } = sheet()
    p = addComponent(p, "resistor", { ref: "R3", sch: { x: 5, y: 5, rot: 0 } }).project
    const r3 = p.components.find((c) => c.ref === "R3")!
    const res = dragSelection(p, { components: [r3.id], labels: [], wires: [] }, { x: -3.85, y: -5 })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (!res.ok) return
    expect(netOf(res.project, "R3", "2")).toBe("A")
    expect(netOf(res.project, "R3", "1")).toBe(netOf(res.project, "R1", "2"))
  })

  it("is refused, saying to cut the wire first, when something else touches the stretch it would cut", () => {
    let { p } = sheet()
    // A wire of its own ending on A's wire at (1.1, 0), under where R3 would sit.
    p = addWire(p, [{ x: 1.1, y: 0 }, { x: 1.1, y: 2 }]).project
    const res = placeComponent(p, "resistor", { sch: { x: 1.15, y: 0, rot: 0 } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/Cut the wire first/)
  })

  it("is refused, saying to cut the wire first, when only one pin is on the wire", () => {
    const { p } = sheet()
        const res = placeComponent(p, "resistor", { sch: { x: 1.0, y: 0.3, rot: 90 } })
    // Upright, its pins are (1.0, 0.0) and (1.0, 0.6): one on A's wire, one in the air.
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/R3\.1 would sit under the wire of A.*Cut the wire first/)
  })
})

describe("pins", () => {
  it("a pin lying on a second wire of its own net is not a problem", () => {
    const { p, r1 } = sheet()
    // A second wire along A's net, through where R1 turns to.
    const q = addWire(p, [{ x: 1, y: 0 }, { x: 1, y: 1 }]).project
    expect(computeConnectivity(q).pinNet.get(pinKey(r1, "2"))).toBeTruthy()
    expect(rotateSelection(q, { components: [r1], labels: [] }).ok).toBe(true)
  })
})

describe("paste carries a part's 3D model", () => {
  it("gives the copy the model its part had on that footprint, in another project too", () => {
    const placed = addComponent(createProject("source"), "resistor", { sch: { x: 0, y: 0 } })
    const model = supplierModel({ id: "0123456789abcdef0123456789abcdef", title: "R0603", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 0 } })
    const source = setModel(placed.project, placed.component.partId, placed.component.footprint, model)
    const clip = { project: source, components: [placed.component.id], wires: [], labels: [], blocks: [] }
    const res = pasteItems(createProject("target"), clip, { x: 20, y: 0 }, "paste")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(modelAssignment(res.project, placed.component.partId, placed.component.footprint)?.id).toBe(model.id)
  })
})
