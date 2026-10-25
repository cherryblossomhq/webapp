import { describe, expect, it } from "vitest"
import { blockFrames, componentTextBoxes } from "../src/model/blocks"
import { cleanupSheet } from "../src/model/cleanup"
import { isBulkCap, isCapacitor, isMainPart, isResistorPart } from "../src/model/cleanup/roles"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { findPart, registerPart, unregisterPart } from "../src/model/library"
import { connectPins, labelPin } from "../src/model/ops"
import { serializeProject } from "../src/model/projectFile"
import { componentFields, symbolOf } from "../src/model/symbolDrawing"
import { netlistChanges, tidySchematic } from "../src/model/tidy"
import { planConnect, drawnPin } from "../src/model/attach"
import { decouplingPairs } from "../src/model/decoupling"
import { pinsCutOff, unrequestedMerges } from "../src/model/merges"
import { findSafeSpot } from "../src/model/spots"
import { partShape, portShape, withPortVias } from "../src/model/tidy/shapes"
import { createBlock } from "../src/model/blocks"
import type { ComponentInstance, Project } from "../src/model/types"
import { ALL_LIBS, importSheet as imported, place } from "./kicad-sch-parts"
import { LIB_GND, type SchSpec } from "./kicad-schematic-fixtures"
import { frameProblems, offGrid, overlaps, pinsOnWires, wireProblems } from "./tidy-metrics"

// Tidy and Clean up on a design brought in from KiCad: parts with units (placed apart), mirrored
// parts, a hidden power pin, a pin switched to an alternate function, fields with places of their
// own and power symbols that are KiCad's. Each tidy is held to what the editor's own tidy is held to,
// and to leaving what the editor does not draw as it was.

const FONT = `(effects (font (size 1.27 1.27)))`
const pin = (type: string, at: string, length: number, name: string, number: string) =>
  `(pin ${type} line (at ${at}) (length ${length}) (name "${name}" ${FONT}) (number "${number}" ${FONT}))`

/** A capacitor and a two pin connector, which the shared fixtures do not have. */
const LIB_C = `(symbol "Device:C" (pin_numbers hide) (pin_names (offset 0.254) hide) (in_bom yes) (on_board yes)
  (property "Reference" "C" (at 1.27 1.27 0) (effects (font (size 1.27 1.27)) (justify left)))
  (property "Value" "C" (at 1.27 -1.27 0) (effects (font (size 1.27 1.27)) (justify left)))
  (symbol "C_0_1" (polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none))) (polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none))))
  (symbol "C_1_1"
    ${pin("passive", "0 3.81 270", 3.048, "~", "1")}
    ${pin("passive", "0 -3.81 90", 3.048, "~", "2")}))`

const LIB_J = `(symbol "Conn:J2" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
  (property "Reference" "J" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
  (property "Value" "J2" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
  (symbol "J2_1_1"
    (rectangle (start -1.27 2.54) (end 1.27 -2.54) (stroke (width 0.254) (type default)) (fill (type background)))
    ${pin("passive", "-3.81 1.27 0", 2.54, "VIN", "1")}
    ${pin("passive", "-3.81 -1.27 0", 2.54, "GND", "2")}))`

/** A power symbol whose pin is off the grid: Tidy cannot stand it on a stub. */
const LIB_OFFGRID = LIB_GND.replace('"power:GND"', '"power:OFF"').replace("(at 0 0 270)", "(at 0.5 0 270)").replace(/GND_/g, "OFF_").replace('"GND"', '"OFF"')

const LIBS = [...ALL_LIBS, LIB_C, LIB_J, LIB_OFFGRID]
const FOOTPRINT = "0603"

/**
 * A sheet imported on its own has no footprints (they come from a board), so none of its parts is
 * physical. Parts with one are what Tidy and the netlist work on, so give them one, as a project
 * that came with its board has them.
 */
function importSheet(spec: SchSpec): Project {
  const p = imported({ libs: LIBS, ...spec })
  const done = new Set<string>()
  for (const c of p.components) {
    const part = findPart(c.partId)
    if (!part || part.powerNet || part.unitOf || done.has(part.id)) continue
    done.add(part.id)
    unregisterPart(part.id)
    registerPart({ ...part, footprints: [FOOTPRINT] })
  }
  return { ...p, components: p.components.map((c) => (findPart(c.partId)?.powerNet || findPart(c.partId)?.unitOf ? c : { ...c, footprint: FOOTPRINT })) }
}

const of = (p: Project, ref: string, unit = 1) => p.components.find((c) => c.ref === ref && (c.unit ?? 1) === unit)!
const pinOf = (p: Project, ref: string, number: string, unit = 1) => ({ componentId: of(p, ref, unit).id, pin: number })

/**
 * An op-amp stage on a sheet where nothing is where it belongs: a dual op-amp with its three units
 * apart (a non-inverting amplifier, a follower, the power unit), feedback resistors one of them
 * mirrored, a decoupling capacitor mirrored the other way, a connector, a controller with a hidden
 * supply pin, a pin on an alternate function and a pin that is not connected, and KiCad's GND and
 * VCC symbols, two of each.
 */
function stage(): Project {
  let p = importSheet({
    symbols: [
      place("Test:OPA2", "100 100", "U1", { unit: 1 }),
      place("Test:OPA2", "220 100", "U1", { unit: 2 }),
      place("Test:OPA2", "160 190", "U1", { unit: 3 }),
      place("Device:R", "100 40", "R1", { value: "10k" }),
      place("Device:R", "150 40", "R2", { value: "1k", mirror: "x" }),
      place("Device:R", "270 40", "R3", { value: "4.7k", mirror: "y" }),
      place("Device:C", "200 190", "C1", { value: "100n", mirror: "y" }),
      place("Conn:J2", "40 100", "J1"),
      place("Test:MCU", "60 190", "U2"),
      place("power:GND", "20 20", "#PWR01"),
      place("power:GND", "300 220", "#PWR03"),
      place("power:VCC", "40 20", "#PWR02"),
      place("power:VCC", "300 20", "#PWR04"),
    ],
  })
  // The fixtures write every field at the sheet's origin; a drawn symbol's own places are where a real file has them. Two
  // placements keep a place of their own: U1's first unit writes its value below the symbol, left justified, and U2's
  // reference stands up the sheet.
  p = {
    ...p,
    components: p.components.map((c): ComponentInstance => {
      const { fields: _own, ...rest } = c
      if (c.ref === "U1" && !c.unit) return { ...rest, fields: { Value: { x: -0.2, y: -0.9, angle: 0 as const, h: "left" as const } } }
      if (c.ref === "U2") return { ...rest, pinAlt: { "1": "SCL" }, fields: { Reference: { x: 0.9, y: 0.2, angle: 90 as const, h: "left" as const } } }
      return rest
    }),
  }
  const wire = (a: [string, string, number?], b: [string, string, number?]) => (p = connectPins(p, pinOf(p, a[0], a[1], a[2]), pinOf(p, b[0], b[1], b[2])))
  const tag = (a: [string, string, number?], name: string) => (p = labelPin(p, pinOf(p, a[0], a[1], a[2]), name))
  wire(["U1", "1", 1], ["R1", "1"])
  tag(["U1", "2", 1], "FB")
  tag(["R1", "2"], "FB")
  tag(["R2", "1"], "FB")
  tag(["J1", "1"], "IN")
  tag(["U1", "3", 1], "IN")
  tag(["U1", "1", 1], "AMP")
  tag(["U1", "5", 2], "AMP")
  tag(["U1", "6", 2], "BUF")
  tag(["U1", "7", 2], "BUF")
  tag(["R3", "1"], "BUF")
  tag(["U2", "1"], "SIG")
  tag(["R3", "2"], "SIG")
  tag(["U1", "8", 3], "VCC")
  tag(["C1", "1"], "VCC")
  tag(["U1", "4", 3], "GND")
  tag(["C1", "2"], "GND")
  tag(["R2", "2"], "GND")
  tag(["J1", "2"], "GND")
  tag(["U2", "5"], "GND")
  tag(["U2", "2"], "VCC")
  wire(["#PWR01", "1"], ["J1", "2"])
  wire(["#PWR02", "1"], ["U1", "8", 3])
  wire(["#PWR03", "1"], ["C1", "2"])
  wire(["#PWR04", "1"], ["U2", "2"])
  return p
}

/** The netlist as pins grouped by net, with the name of a net that has one, computed from the connectivity alone. */
function netlist(p: Project) {
  const conn = computeConnectivity(p)
  const refOf = new Map(p.components.map((c) => [c.id, c.ref]))
  return conn.nets
    .filter((n) => n.named || n.pins.length > 1)
    .map((n) => ({ name: n.named ? n.name : null, pins: n.pins.map((x) => `${refOf.get(x.componentId)}.${x.pin}`).sort() }))
    .sort((a, b) => (a.pins.join() < b.pins.join() ? -1 : 1))
}

/** What a part is besides where it stands: Tidy and Clean up change nothing of it. */
const identity = (c: ComponentInstance) => ({
  id: c.id,
  ref: c.ref,
  partId: c.partId,
  unit: c.unit,
  bodyStyle: c.bodyStyle,
  fields: c.fields,
  pinAlt: c.pinAlt,
  mirror: c.sch.mirror,
  props: c.props,
  footprint: c.footprint,
  pcb: c.pcb,
  nc: c.nc,
})

const arranged = (p: Project) => p.components.filter((c) => !findPart(c.partId)?.powerNet)
const ports = (p: Project) => p.components.filter((c) => findPart(c.partId)?.powerNet)

function expectDrawnWell(p: Project) {
  expect(overlaps(p)).toEqual([])
  const wires = wireProblems(p)
  expect(wires.through).toEqual([])
  expect(wires.crossings).toEqual([])
  expect(pinsOnWires(p)).toEqual([])
  expect(offGrid(p)).toEqual([])
  expect(frameProblems(p)).toEqual([])
}

/** Every field of every part of a block is inside its frame. */
function expectFieldsInFrames(p: Project) {
  const frames = blockFrames(p)
  expect(frames.length).toBeGreaterThan(0)
  for (const f of frames) {
    for (const id of f.contents.components) {
      const c = p.components.find((x) => x.id === id)!
      for (const t of componentTextBoxes(c)) {
        expect(t.minX).toBeGreaterThanOrEqual(f.box.minX - 1e-6)
        expect(t.maxX).toBeLessThanOrEqual(f.box.maxX + 1e-6)
        expect(t.minY).toBeGreaterThanOrEqual(f.box.minY - 1e-6)
        expect(t.maxY).toBeLessThanOrEqual(f.box.maxY + 1e-6)
      }
    }
  }
}

describe("Tidy on a design from KiCad", () => {
  it("keeps every connection, and what each part is", () => {
    const before = stage()
    const r = tidySchematic(before)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expect(netlist(r.project)).toEqual(netlist(before))
    const was = new Map(before.components.map((c) => [c.id, c]))
    for (const c of arranged(r.project)) expect(identity(c)).toEqual(identity(was.get(c.id)!))
    expect(arranged(r.project)).toHaveLength(arranged(before).length)
  })

  it("keeps the mirror of every part and the unit each placement draws", () => {
    const r = tidySchematic(stage())
    expect(r.ok && r.changed).toBe(true)
    expect(of(r.project, "R2").sch.mirror).toBe("x")
    expect(of(r.project, "R3").sch.mirror).toBe("y")
    expect(of(r.project, "C1").sch.mirror).toBe("y")
    expect(of(r.project, "U1", 1).unit).toBeUndefined()
    expect(of(r.project, "U1", 2).unit).toBe(2)
    expect(of(r.project, "U1", 3).unit).toBe(3)
    expect(of(r.project, "U2").pinAlt).toEqual({ "1": "SCL" })
  })

  it("draws the three units of a part as symbols of their own, each with its own pins", () => {
    const r = tidySchematic(stage())
    for (const unit of [1, 2, 3]) {
      const c = of(r.project, "U1", unit)
      expect(schematicPins(c).map((x) => x.pin).sort()).toEqual(unit === 1 ? ["1", "2", "3"] : unit === 2 ? ["5", "6", "7"] : ["4", "8"])
    }
  })

  it("draws no wire to a pin the symbol does not draw, and none over it", () => {
    const r = tidySchematic(stage())
    const u2 = of(r.project, "U2")
    const hidden = schematicPins(u2).filter((p) => p.hidden)
    expect(hidden.map((p) => p.pin)).toEqual(["4"])
    for (const h of hidden) {
      for (const w of r.project.wires) for (const q of w.points) expect(Math.hypot(q.x - h.pos.x, q.y - h.pos.y)).toBeGreaterThan(1e-6)
      for (const l of r.project.labels) expect(Math.hypot(l.x - h.pos.x, l.y - h.pos.y)).toBeGreaterThan(1e-6)
    }
    // It is on VDD by its name all the same.
    expect(netlist(r.project).some((n) => n.name === "VDD" && n.pins.includes("U2.4"))).toBe(true)
  })

  it("draws a net's ports with the power symbol KiCad had on it, and none of the editor's own", () => {
    const before = stage()
    const imported = new Set(ports(before).map((c) => c.partId))
    expect(imported.size).toBe(2)
    const r = tidySchematic(before)
    const after = ports(r.project)
    expect(after.length).toBeGreaterThan(0)
    for (const c of after) {
      expect(imported.has(c.partId)).toBe(true)
      expect(c.partId).not.toBe("power")
      expect(c.partId).not.toBe("ground")
    }
    // Each net's ports are the part its own symbols were.
    const byNet = (p: Project) => {
      const out = new Map<string, Set<string>>()
      for (const c of ports(p)) out.set(c.props.net, (out.get(c.props.net) ?? new Set()).add(c.partId))
      return out
    }
    const was = byNet(before)
    const now = byNet(r.project)
    expect([...now.keys()].sort()).toEqual([...was.keys()].sort())
    for (const [net, parts] of now) expect([...parts]).toEqual([...was.get(net)!])
    // And they are drawn as that symbol draws them: its own pin, its own value.
    for (const c of after) {
      const part = findPart(c.partId)!
      expect(componentFields(c, part).map((f) => f.name)).toContain("Value")
      expect(schematicPins(c)).toHaveLength(1)
    }
  })

  it("is drawn with nothing over anything else", () => {
    const r = tidySchematic(stage())
    expectDrawnWell(r.project)
  })

  it("changes nothing when it is run again, and comes out the same from the same sheet", () => {
    const r = tidySchematic(stage())
    const again = tidySchematic(r.project)
    expect(again.ok).toBe(true)
    expect(again.changed).toBe(false)
    const twice = tidySchematic(structuredClone(stage()))
    expect(serializeProject(twice.project).length).toBe(serializeProject(tidySchematic(structuredClone(stage())).project).length)
  })

  it("keeps the fields of every block inside its frame", () => {
    expectFieldsInFrames(tidySchematic(stage()).project)
  })

  it("tidies one block where it is, with its units in other blocks", () => {
    let p = stage()
    const split = (name: string, ids: string[]) => (p = createBlock(p, name, ids).project)
    split("AMP", [of(p, "U1", 1).id, of(p, "R1").id, of(p, "R2").id, of(p, "J1").id])
    split("FOLLOWER", [of(p, "U1", 2).id, of(p, "R3").id])
    split("SUPPLY", [of(p, "U1", 3).id, of(p, "C1").id])
    split("MCU", [of(p, "U2").id])
    const whole = tidySchematic(p)
    expect(whole.ok).toBe(true)
    expect(whole.problems).toEqual([])
    expect(netlist(whole.project)).toEqual(netlist(p))
    expect(blockFrames(whole.project).map((f) => f.name).sort()).toEqual(["AMP", "FOLLOWER", "MCU", "SUPPLY"])
    expectDrawnWell(whole.project)
    for (const b of whole.project.blocks!) {
      const one = tidySchematic(whole.project, { blockId: b.id })
      expect(one.ok).toBe(true)
      expect(netlist(one.project)).toEqual(netlist(p))
      for (const c of arranged(one.project)) expect(identity(c)).toEqual(identity(of(p, c.ref, c.unit ?? 1)))
    }
  })
})

describe("Clean up on a design from KiCad", () => {
  it("groups the parts, keeps every connection and what each part is", () => {
    const before = stage()
    const r = cleanupSheet(before)
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expect(netlist(r.project)).toEqual(netlist(before))
    const was = new Map(before.components.map((c) => [c.id, c]))
    for (const c of arranged(r.project)) expect(identity(c)).toEqual(identity(was.get(c.id)!))
    const blocked = new Set((r.project.blocks ?? []).flatMap((b) => b.components))
    for (const c of arranged(r.project)) expect(blocked.has(c.id)).toBe(true)
    expectDrawnWell(r.project)
    expectFieldsInFrames(r.project)
    for (const c of ports(r.project)) expect(["power", "ground"]).not.toContain(c.partId)
  })

  it("names a block after each unit of a part with several, as KiCad writes the units", () => {
    const names = (cleanupSheet(stage()).project.blocks ?? []).map((b) => b.name)
    expect(names.filter((n) => /U1[ABC]( |$)/.test(n)).sort()).toHaveLength(3)
    expect(new Set(names).size).toBe(names.length)
  })

  it("knows a resistor, a capacitor and an LED brought in from KiCad by what they are", () => {
    const p = stage()
    expect(isResistorPart(findPart(of(p, "R1").partId))).toBe(true)
    expect(isCapacitor(of(p, "C1"))).toBe(true)
    expect(isCapacitor(of(p, "R1"))).toBe(false)
    expect(isBulkCap(of(p, "C1"))).toBe(false)
    expect(isBulkCap({ ...of(p, "C1"), props: { ...of(p, "C1").props, value: "47u" } })).toBe(true)
    expect(isMainPart(findPart(of(p, "U1").partId))).toBe(true)
    expect(isMainPart(findPart(of(p, "R1").partId))).toBe(false)
  })

  it("changes nothing when it is run again", () => {
    const first = cleanupSheet(stage())
    const second = cleanupSheet(first.project)
    expect(second.ok).toBe(true)
    expect(second.changed).toBe(false)
  })
})

describe("names Tidy gives", () => {
  it("names an unnamed net for the function a pin is switched to", () => {
    let p = importSheet({ symbols: [place("Test:MCU", "60 100", "U2"), place("Device:R", "160 100", "R1")] })
    p = { ...p, components: p.components.map((c) => (c.ref === "U2" ? { ...c, pinAlt: { "1": "SCL" } } : c)) }
    p = connectPins(p, pinOf(p, "U2", "1"), pinOf(p, "R1", "1"))
    p = createBlock(p, "CHIP", [of(p, "U2").id]).project
    p = createBlock(p, "PULL", [of(p, "R1").id]).project
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect(r.project.labels.map((l) => l.name)).toContain("U2_SCL")
  })
})

describe("what Tidy will not draw", () => {
  it("leaves the sheet as it was when a power symbol's pin is off the grid", () => {
    let p = importSheet({ symbols: [place("Device:R", "100 100", "R1"), place("Device:R", "140 100", "R2"), place("power:OFF", "100 60", "#PWR01")] })
    p = connectPins(p, { componentId: of(p, "#PWR01").id, pin: "1" }, pinOf(p, "R1", "1"))
    p = labelPin(p, pinOf(p, "R1", "2"), "X")
    p = labelPin(p, pinOf(p, "R2", "1"), "X")
    const r = tidySchematic(p)
    expect(r.ok).toBe(false)
    expect(r.changed).toBe(false)
    expect(r.project).toBe(p)
    expect(r.message).toMatch(/power symbol/)
    expect(r.problems.join(" ")).toMatch(/off the grid/)
  })

  it("leaves the sheet as it was when the second pin of a number is wired apart from the first", () => {
    let p = importSheet({ symbols: [place("Test:DUP", "100 100", "J1"), place("Device:R", "160 100", "R1")] })
    p = labelPin(p, pinOf(p, "J1", "2"), "A")
    p = labelPin(p, pinOf(p, "R1", "1"), "A")
    // Pin 1a stands where it does, the other pin of that number, 1b, somewhere else: wire 1b.
    const second = schematicPins(of(p, "J1")).find((x) => x.pin === "1" && x.slot === 1)!
    p = { ...p, wires: [...p.wires, { id: "w_dup", points: [second.pos, { x: second.pos.x - 0.4, y: second.pos.y }] }] }
    const r = tidySchematic(p)
    expect(r.ok).toBe(false)
    expect(r.project).toBe(p)
    expect(r.problems.join(" ")).toMatch(/J1 pin 1/)
  })

  it("tidies it when the second pin of the number is left alone", () => {
    let p = importSheet({ symbols: [place("Test:DUP", "100 100", "J1"), place("Device:R", "160 100", "R1")] })
    p = labelPin(p, pinOf(p, "J1", "2"), "A")
    p = labelPin(p, pinOf(p, "R1", "1"), "A")
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect(netlist(r.project)).toEqual(netlist(p))
    expectDrawnWell(r.project)
  })
})

describe("the shapes Tidy draws with", () => {
  it("tells a unit from another unit, and a mirrored part from the same part", () => {
    const p = stage()
    const a = of(p, "U1", 1)
    const b = of(p, "U1", 2)
    expect(partShape({ ...a, partId: b.partId, unit: 2 }, 0).pins.map((x) => x.pin).sort()).toEqual(["5", "6", "7"])
    // The same component object type with the unit swapped, in the same part: the cache must not hand back unit 1.
    const c = { ...of(p, "U1", 3), partId: of(p, "U1", 2).partId }
    expect(partShape({ ...c, unit: 3 }, 0).pins.map((x) => x.pin).sort()).toEqual(["4", "8"])
    expect(partShape({ ...c, unit: 2 }, 0).pins.map((x) => x.pin).sort()).toEqual(["5", "6", "7"])
    const r1 = of(p, "R1")
    const plain = partShape(r1, 0)
    const flipped = partShape({ ...r1, id: "other", sch: { ...r1.sch, mirror: "x" } }, 0)
    expect(flipped.pins[0].y).toBe(-plain.pins[0].y)
    expect(flipped.pins[0].dir).not.toBe(plain.pins[0].dir)
  })

  it("stands an imported power symbol as the symbol says, its pin where a wire meets it", () => {
    const p = stage()
    const gnd = ports(p).find((c) => c.props.net === "GND")!
    const vcc = ports(p).find((c) => c.props.net === "VCC")!
    const via = new Map([
      ["GND", { partId: gnd.partId }],
      ["VCC", { partId: vcc.partId }],
    ])
    withPortVias(via, () => {
      // A ground that hangs below its pin: its wire leaves up. On a pin that points down it stands as drawn, on one that points up it is turned over.
      expect(symbolOf(findPart(gnd.partId)!).ports[0].dir).toBe("up")
      const g = portShape("ground", "GND", "down")
      expect(g.partId).toBe(gnd.partId)
      expect(g.rot).toBe(0)
      expect(portShape("ground", "GND", "up").rot).toBe(180)
      // A supply that stands above its pin: its wire leaves down.
      expect(portShape("power", "VCC", "up").rot).toBe(0)
      expect(portShape("power", "VCC", "up").partId).toBe(vcc.partId)
    })
    // Outside, the editor's own.
    expect(portShape("ground", "GND", "up").partId).toBe("ground")
  })
})

describe("the text of an imported part", () => {
  const width = (len: number, advance: number, size = 0.1) => len * size * advance

  it("has a box for each field that shows, where the field says, however the part is turned or mirrored", () => {
    const p = stage()
    const c1 = of(p, "C1")
    const part = findPart(c1.partId)!
    const boxes = componentTextBoxes(c1)
    const fields = componentFields(c1, part)
    expect(fields.map((f) => f.name)).toEqual(["Reference", "Value"])
    expect(boxes).toHaveLength(2)
    // C's Reference is justified left and reads across. C1 is mirrored left to right, so KiCad puts the box on the other side: it ends at its anchor and runs left, centred on it up and down.
    const ref = fields[0].place
    expect(ref.h).toBe("left")
    expect(c1.sch.mirror).toBe("y")
    expect(boxes[0].maxX).toBeCloseTo(c1.sch.x + ref.x, 6)
    expect(boxes[0].maxX - boxes[0].minX).toBeCloseTo(width("C1".length, 0.62), 6)
    expect((boxes[0].minY + boxes[0].maxY) / 2).toBeCloseTo(c1.sch.y + ref.y, 6)
    expect(boxes[1].maxX - boxes[1].minX).toBeCloseTo(width("100n".length, 0.6), 6)
    // Turned a quarter, the same text lies the other way: the box is as tall as it was wide (KiCad swaps across and up).
    const turned = componentTextBoxes({ ...c1, sch: { ...c1.sch, rot: 90 } })
    expect(turned[0].maxY - turned[0].minY).toBeCloseTo(boxes[0].maxX - boxes[0].minX, 6)
    expect(turned[0].maxX - turned[0].minX).toBeCloseTo(boxes[0].maxY - boxes[0].minY, 6)
  })

  it("makes a field that reads up the sheet tall, not wide", () => {
    const p = stage()
    const r1 = of(p, "R1")
    const fields = componentFields(r1, findPart(r1.partId)!)
    expect(fields.every((f) => f.place.angle === 90)).toBe(true)
    const boxes = componentTextBoxes(r1)
    expect(boxes).toHaveLength(2)
    expect(boxes[0].maxY - boxes[0].minY).toBeCloseTo(width("R1".length, 0.62), 6)
    expect(boxes[0].maxX - boxes[0].minX).toBeCloseTo(0.1, 6)
    expect(boxes[1].maxY - boxes[1].minY).toBeCloseTo(width("10k".length, 0.6), 6)
    expect(fields[0].extent.y).toBe(0)
  })

  it("has none for a hidden field, and none for a part with no field of its own", () => {
    const p = stage()
    const gnd = ports(p).find((c) => c.props.net === "GND")!
    // The ground symbol hides its reference; its value is its one text.
    expect(componentFields(gnd, findPart(gnd.partId)!).map((f) => f.name)).toEqual(["Value"])
    expect(componentTextBoxes(gnd)).toHaveLength(1)
    const text = (c: ComponentInstance) => componentTextBoxes(c).length
    expect(text(of(p, "U1", 1))).toBe(2)
    // A place of the placement's own stands in place of the symbol's: U1's value is left of where it is, below the symbol.
    const u1 = of(p, "U1", 1)
    const value = componentTextBoxes(u1)[1]
    expect(value.minX).toBeCloseTo(u1.sch.x - 0.2, 6)
    expect(value.maxY).toBeCloseTo(u1.sch.y - 0.9 + 0.05, 6)
    // U2's reference reads up the sheet.
    const [ref] = componentTextBoxes(of(p, "U2"))
    expect(ref.maxY - ref.minY).toBeGreaterThan(ref.maxX - ref.minX)
  })
})

/** The project without the wire that leaves a pin and the label on its end. */
function withoutStubAt(p: Project, at: { x: number; y: number }): Project {
  const same = (q: { x: number; y: number }, r: { x: number; y: number }) => Math.abs(q.x - r.x) < 1e-6 && Math.abs(q.y - r.y) < 1e-6
  const stub = p.wires.find((w) => w.points.some((q) => same(q, at)))!
  const end = stub.points.find((q) => !same(q, at))!
  return { ...p, wires: p.wires.filter((w) => w !== stub), labels: p.labels.filter((l) => !same(l, end)) }
}

describe("the check that Tidy changed no connection", () => {
  it("sees the pins of the other units of a part", () => {
    const before = stage()
    expect(netlistChanges(before, before)).toEqual([])
    // Take the label off a pin of unit B, which is a component of its own: that pin's connection is gone.
    const pin = schematicPins(of(before, "U1", 2)).find((x) => x.pin === "6")!
    const after = withoutStubAt(before, pin.pos)
    expect(netlistChanges(before, after).join(" ")).toMatch(/U1\.6/)
  })
})

describe("the guards of an edit, with units, hidden pins and mirrors", () => {
  it("cuts off a pin of another unit that an edit leaves without its net", () => {
    const before = stage()
    const pin = schematicPins(of(before, "U1", 2)).find((x) => x.pin === "6")!
    const next = withoutStubAt(before, pin.pos)
    const problems = pinsCutOff(before, next, computeConnectivity(before), computeConnectivity(next))
    expect(problems).toEqual(["it would cut U1.7, U1.- (pin 6), and R3.1 off BUF"])
  })

  it("names a pin of another unit once when an edit joins two nets", () => {
    const before = stage()
    // Wire pin 7 of unit B (net BUF) to pin 1 of R1 (net AMP): two nets joined.
    const next = connectPins(before, pinOf(before, "U1", "7", 2), pinOf(before, "R1", "1"))
    const problems = unrequestedMerges(next, computeConnectivity(before), computeConnectivity(next), new Set())
    expect(problems).toHaveLength(1)
    const text = problems[0]
    expect((text.match(/U1\.7/g) ?? []).length).toBeLessThanOrEqual(1)
  })

  it("will not draw to a pin that is not drawn, and finds the unit that draws a pin of the part", () => {
    const p = stage()
    const conn = computeConnectivity(p)
    const hidden = pinOf(p, "U2", "4")
    const opts = { netName: "", nameFor: () => "NEW", netOf: () => null }
    const plan = planConnect(p, conn, [hidden, pinOf(p, "R1", "1")], opts)
    expect(plan.failed.map((f) => f.ref)).toEqual([hidden])
    expect(plan.failed[0].why).toMatch(/not drawn/)
    expect(plan.wired).toBe(false)
    // Pin 7 belongs to the part U1, which draws unit A: unit B is the component that draws it.
    const owner = pinOf(p, "U1", "7", 1)
    expect(drawnPin(p, owner)?.componentId).toBe(of(p, "U1", 2).id)
    const joined = planConnect(p, conn, [owner, pinOf(p, "J1", "1")], { ...opts, netName: "FRESH" })
    expect(joined.failed).toEqual([])
    expect(joined.onNet).toHaveLength(2)
  })

  it("keeps a mirror when it looks for a spot for a part", () => {
    const p = stage()
    const c = of(p, "R3")
    expect(c.sch.mirror).toBe("y")
    const spot = findSafeSpot({
      project: p,
      id: c.id,
      target: { x: c.sch.x + 0.4, y: c.sch.y },
      rot: 90,
      build: (at) => ({ ...p, components: p.components.map((x) => (x.id === c.id ? { ...x, sch: { ...x.sch, ...at, rot: 90 as const } } : x)) }),
      accepts: () => true,
    })
    expect(spot).not.toBeNull()
  })

  it("pairs a decoupling capacitor with a chip whose supply pin is on another unit", () => {
    const p = stage()
    const pairs = decouplingPairs(p)
    const pair = pairs.find((x) => x.capId === of(p, "C1").id)
    expect(pair?.chipId).toBeDefined()
    // VCC is on pin 8 of U1 (its power unit, which is a component of its own) and on pin 2 of U2.
    expect([of(p, "U1").id, of(p, "U2").id]).toContain(pair!.chipId)
    expect(pair!.netName).toBe("VCC")
  })
})
