import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { schematicPins, unitOwners } from "../src/model/instances"
import { findPart } from "../src/model/library"
import type { ComponentInstance, Project } from "../src/model/types"
import { importSheet, place } from "./kicad-sch-parts"

// Sakura's schematic tools on symbols that came from KiCad: parts with several units, body styles,
// pin functions, mirrors and fields.

// ---------- helpers ----------

/** The same sheet with a footprint on every part, so the parts are on the board (an imported sheet has none until it is linked to one). */
function withFootprint(p: Project, fp = "soic8"): Project {
  const parts = (p.parts ?? []).map((s) => ({ ...s, id: s.id + "-fp", footprint: fp }))
  const q = { ...p, parts }
  registerProjectParts(q)
  return {
    ...q,
    components: q.components.map((c) => {
      const twin = c.partId.endsWith("@sub")
      return { ...c, partId: twin ? c.partId.replace("@sub", "-fp@sub") : `${c.partId}-fp`, footprint: twin ? "" : fp }
    }),
  }
}

const OPA = (at: string, unit: number, ref = "U1") => place("Test:OPA2", at, ref, { unit })
const sheet = (units: number[]) => withFootprint(importSheet({ symbols: units.map((u) => OPA(`${100 + (u === 3 ? 40 : 0)} ${100 + (u === 2 ? 40 : 0)}`, u)) }))

interface Design {
  components: {
    ref: string
    x: number
    y: number
    rotation: number
    mirror?: string
    unit?: number
    body_style?: number
    units_placed?: { unit: number; x: number; y: number; rotation: number; mirror?: string; body_style?: number }[]
    units_missing?: number[]
    fields?: { name: string; text: string; hidden?: true; x?: number; y?: number }[]
    footprint?: string
    props?: Record<string, string>
    pins?: { pin: string; name: string; net: string | null; type?: string; hidden?: boolean; unit?: number; unit_not_placed?: boolean; functions?: string[]; function?: string; joins_net?: string; note?: string }[]
  }[]
  nets: { name: string; pins: string[] }[]
  blocks?: { name: string; parts: string[] }[]
  checks: Record<string, number>
}
const design = (p: Project) => {
  const out = runTool(p, "get_design", {})
  expect(out.isError, out.result).toBe(false)
  return JSON.parse(out.result) as Design
}
const call = (p: Project, name: string, input: Record<string, unknown>) => runTool(p, name, input)
const must = (p: Project, name: string, input: Record<string, unknown>) => {
  const out = runTool(p, name, input)
  expect(out.isError, out.result).toBe(false)
  return out
}
const baseId = (p: Project) => p.components.find((c) => !findPart(c.partId)?.unitOf)!.partId
const refs = (p: Project, ref: string) => p.components.filter((c) => c.ref === ref)
const unitOf = (c: ComponentInstance) => c.unit ?? 1

// ---------- get_design ----------

describe("get_design", () => {
  it("lists a part with several units once, with the units placed and the ones missing", () => {
    const d = design(sheet([1, 2]))
    expect(d.components.map((c) => c.ref)).toEqual(["U1"])
    const u1 = d.components[0]
    expect(u1.unit).toBe(1)
    expect(u1.units_placed!.map((u) => u.unit)).toEqual([1, 2])
    expect(u1.units_placed![1].y).toBeLessThan(u1.units_placed![0].y)
    expect(u1.units_missing).toEqual([3])
    expect(design(sheet([1, 2, 3])).components[0].units_missing).toEqual([])
  })

  it("gives every pin of the part: its net, its type, and the unit that has it", () => {
    const u1 = design(sheet([1, 2])).components[0]
    expect(u1.pins!.map((p) => p.pin)).toEqual(["1", "2", "3", "7", "6", "5", "8", "4"])
    const pin = (n: string) => u1.pins!.find((p) => p.pin === n)!
    expect(pin("1")).toMatchObject({ name: "1", type: "output", unit: 1 })
    expect(pin("5")).toMatchObject({ type: "input", unit: 2 })
    expect(pin("8")).toMatchObject({ type: "power_in", unit: 3, unit_not_placed: true })
    expect(pin("2").unit_not_placed).toBeUndefined()
  })

  it("reports each unit's own place and turn, and a mirror", () => {
    let p = sheet([1, 2])
    p = { ...p, components: p.components.map((c) => (unitOf(c) === 2 ? { ...c, sch: { ...c.sch, rot: 90 as const, mirror: "x" as const } } : c)) }
    const u = design(p).components[0].units_placed!
    expect(u[1]).toMatchObject({ unit: 2, rotation: 90, mirror: "x" })
    expect(u[0].mirror).toBeUndefined()
    expect(design(p).components[0].mirror).toBeUndefined()
  })

  it("lists the fields with their text, and whether they are hidden", () => {
    const u1 = design(sheet([1, 2])).components[0]
    expect(u1.fields).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Reference", text: "U1A" }), expect.objectContaining({ name: "Value", text: "OPA2" })]))
    const hidden = u1.fields!.find((f) => f.name === "Footprint")
    // A field with nothing to say is not listed; one that has something and is hidden says so.
    expect(hidden === undefined || hidden.hidden === true).toBe(true)
  })

  it("lists the pin functions a pin offers, the one in use, hidden power pins as joining a net, and a no-connect pin", () => {
    const base = withFootprint(importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] }))
    const pins = (p: Project) => design(p).components[0].pins!
    const pin = (p: Project, n: string) => pins(p).find((x) => x.pin === n)!
    expect(pin(base, "1")).toMatchObject({ functions: ["SCL", "TX", "VREF"], type: "bidirectional" })
    expect(pin(base, "1").function).toBeUndefined()
    const switched = { ...base, components: base.components.map((c) => ({ ...c, pinAlt: { "1": "TX" } })) }
    expect(pin(switched, "1")).toMatchObject({ function: "TX", type: "output" })
    const hidden = pin(base, "4")
    expect(hidden).toMatchObject({ hidden: true, joins_net: "VDD", net: "VDD", type: "power_in" })
    expect(hidden.note).toMatch(/joins net VDD, it is not unconnected/)
    expect(pin(base, "3")).toMatchObject({ type: "no_connect", net: null })
    expect(pin(base, "3").note).toMatch(/no-connect/)
    // And the checks do not call either pin unconnected.
    const checks = runTool(base, "run_checks", {}).result
    expect(checks).toMatch(/U3\.1\/PA0/)
    expect(checks).not.toMatch(/U3\.4|U3\.VDD|U3\.3|U3\.NC/)
  })

  it("lists a KiCad symbol that has no footprint with its pins", () => {
    const bare = importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] })
    const u3 = design(bare).components[0]
    expect(u3.pins).toHaveLength(5)
    expect(u3.footprint).toBe("")
  })

  it("lists a body style, and leaves it out of a part that has one", () => {
    const gate = withFootprint(importSheet({ symbols: [place("Test:AND2", "100 100", "U2")] }))
    expect(design(gate).components[0].body_style).toBe(1)
    const two = { ...gate, components: gate.components.map((c) => ({ ...c, bodyStyle: 2 })) }
    expect(design(two).components[0].body_style).toBe(2)
    expect(design(sheet([1])).components[0].body_style).toBeUndefined()
  })

  it("leaves the editor's own parts exactly as they were", () => {
    const own = EXAMPLES.find((e) => e.id === "blinker")!.project
    const d = JSON.parse(runTool(own, "get_design", {}).result) as { components: Record<string, unknown>[] }
    const allowed = new Set(["ref", "part", "name", "value", "x", "y", "rotation", "footprint", "props", "pcb", "pins"])
    for (const c of d.components) expect(Object.keys(c).filter((k) => !allowed.has(k))).toEqual([])
    for (const c of d.components) for (const pin of (c.pins as Record<string, unknown>[] | undefined) ?? []) expect(Object.keys(pin)).toEqual(["pin", "name", "net"])
    expect(runTool(own, "get_design", {}).result).not.toMatch(/units_|mirror|fields|joins_net/)
  })
})

// ---------- add_component ----------

describe("add_component with units", () => {
  it("adds another unit of a part: the same reference, no footprint, nothing more on the board", () => {
    const p = sheet([1, 2])
    const out = must(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 3, x: 3, y: -2 })
    const next = out.project
    const all = refs(next, "U1")
    expect(all).toHaveLength(3)
    const added = all.find((c) => unitOf(c) === 3)!
    expect(findPart(added.partId)?.unitOf).toBe(baseId(p))
    expect(added.footprint).toBe("")
    expect(added.sch).toMatchObject({ x: 3, y: -2 })
    expect(next.components.filter((c) => c.ref.startsWith("U"))).toHaveLength(3)
    expect(out.result).toMatch(/Added unit 3 of U1/)
    expect(out.result).toMatch(/Pins on this symbol: 8:V\+ 4:V-/)
    expect(design(next).components[0].units_missing).toEqual([])
    // The part is still one on the board and one in the netlist.
    expect(unitOwners(next.components).size).toBe(2)
    expect(design(next).components).toHaveLength(1)
  })

  it("places the unit in free space when no place is given, clear of the other units", () => {
    const p = sheet([1, 2])
    const next = must(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 3 }).project
    const added = refs(next, "U1").find((c) => unitOf(c) === 3)!
    const others = refs(next, "U1").filter((c) => unitOf(c) !== 3)
    expect(added.sch.x).toBeGreaterThan(Math.max(...others.map((c) => c.sch.x)))
  })

  it("turns and mirrors the new unit as asked", () => {
    const p = sheet([1, 2])
    const next = must(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 3, x: 3, y: -2, rotation: 90, mirror: "y" }).project
    expect(refs(next, "U1").find((c) => unitOf(c) === 3)!.sch).toMatchObject({ rot: 90, mirror: "y" })
    const pins = schematicPins(refs(next, "U1").find((c) => unitOf(c) === 3)!)
    // Turned a quarter then flipped left to right: V+ (up in the symbol) points left.
    expect(pins.find((x) => x.pin === "8")!.dir).toBe("right")
  })

  it("places a unit that is not the first as the part itself", () => {
    const p = withFootprint(importSheet({ symbols: [] }))
    const own = sheet([1])
    const out = must({ ...own, components: [] }, "add_component", { part_id: baseId(own), unit: 2, x: 0, y: 0 })
    const c = out.project.components[0]
    expect(unitOf(c)).toBe(2)
    expect(c.footprint).toBe("soic8")
    expect(out.result).toMatch(/unit 2 of U1/)
    expect(out.result).toMatch(/Units not on the sheet yet: 1, 3/)
    expect(p.components).toHaveLength(0)
  })

  it("refuses a unit that is on the sheet already, one the part does not have, and a designator that is another part's", () => {
    const p = sheet([1, 2])
    expect(call(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 2 })).toMatchObject({ isError: true, result: expect.stringMatching(/Unit 2 of U1 is already on the sheet/) })
    expect(call(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 4 }).result).toMatch(/has 3 units, so there is no unit 4/)
    const taken = call(p, "add_component", { part_id: "resistor", ref: "U1", unit: 2 })
    expect(taken.isError).toBe(true)
    expect(taken.result).toMatch(/Designator U1 is already used, by OPA2; to add a unit of it give its part_id/)
    expect(call(p, "add_component", { part_id: baseId(p), ref: "U1" }).result).toMatch(/Designator U1 is already used/)
  })

  it("keeps a part with one unit and no other input exactly as it was", () => {
    const p = createProjectWithResistor()
    const out = must(p, "add_component", { part_id: "resistor", x: 5, y: 0 })
    expect(out.result).toMatch(/^Added R2 \(Resistor\) at \(5, 0\)\. Pins: 1 2/)
    expect(call(p, "add_component", { part_id: "resistor", unit: 2 }).result).toMatch(/has 1 unit, so there is no unit 2/)
    expect(call(p, "add_component", { part_id: "resistor", ref: "R1" }).result).toBe("Error: Designator R1 is already used")
  })

  it("does not drop a unit with a pin on the middle of another net's wire", () => {
    // Unit 1's output wire runs from (8.6, -8) to (11, -8); unit 3's V+ pin (0.6 above its origin) would sit on it.
    const p = withFootprint(importSheet({ symbols: [OPA("101.6 101.6", 1)], wires: ["109.22 101.6 139.7 101.6"] }))
    const out = call(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 3, x: 9.8, y: -8.6 })
    expect(out.isError).toBe(true)
    expect(out.result).toBe("Error: Not added: OPA2 at (9.8, -8.6) would connect U1.V+ would sit under the wire of Net-(U1-1), which looks connected. Pick another x/y, or leave them out to place it in free space.")
    expect(out.project).toBe(p)
    // A little to the side it goes in.
    expect(call(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 3, x: 9.8, y: -10 }).isError).toBe(false)
  })
})

const createProjectWithResistor = () => {
  let p = importSheet({ symbols: [] })
  p = must(p, "add_component", { part_id: "resistor", x: 0, y: 0 }).project
  return p
}

// ---------- update_component ----------

describe("update_component on a symbol from KiCad", () => {
  it("mirrors a symbol as asked: x, y, then none, taking the old mirror off first", () => {
    let p = sheet([1])
    const c = () => p.components[0].sch
    p = must(p, "update_component", { ref: "U1", mirror: "x" }).project
    expect(c().mirror).toBe("x")
    expect(design(p).components[0].mirror).toBe("x")
    const same = must(p, "update_component", { ref: "U1", mirror: "x" })
    expect(same.result).toBe("No changes for U1")
    p = must(p, "update_component", { ref: "U1", mirror: "y" }).project
    expect(c().mirror).toBe("y")
    expect(c().rot).toBe(0)
    p = must(p, "update_component", { ref: "U1", mirror: "none" }).project
    expect("mirror" in c()).toBe(false)
    expect(c().rot).toBe(0)
  })

  it("moves the pins with the mirror, and the wire on them follows", () => {
    let p = sheet([1])
    p = must(p, "add_component", { part_id: "resistor", x: -4, y: 0 }).project
    p = must(p, "connect", { pins: ["U1.2", "R1.2"] }).project
    const out = must(p, "update_component", { ref: "U1", mirror: "y" })
    const c = out.project.components.find((x) => x.ref === "U1")!
    const pin = schematicPins(c).find((x) => x.pin === "2")!
    // Pin 2 was on the left of the symbol and is on the right now, with its wire end on it.
    expect(pin.pos.x).toBeGreaterThan(c.sch.x)
    expect(pin.dir).toBe("right")
    expect(out.project.wires.some((w) => w.points.some((q) => Math.abs(q.x - pin.pos.x) < 1e-3 && Math.abs(q.y - pin.pos.y) < 1e-3))).toBe(true)
    const net = computeConnectivity(out.project).nets.find((n) => n.pins.length === 2)!
    expect(net.pins.map((x) => x.pin).sort()).toEqual(["2", "2"])
  })

  it("turns one unit of a part and leaves the others", () => {
    const p = sheet([1, 2])
    const out = must(p, "update_component", { ref: "U1", placed_unit: 2, rotation: 90, x: 2, y: -3 })
    const u2 = refs(out.project, "U1").find((c) => unitOf(c) === 2)!
    expect(u2.sch).toMatchObject({ x: 2, y: -3, rot: 90 })
    expect(refs(out.project, "U1").find((c) => unitOf(c) === 1)!.sch).toEqual(p.components.find((c) => unitOf(c) === 1)!.sch)
  })

  it("names the units that are placed when asked for one that is not", () => {
    const p = sheet([1, 2])
    const out = call(p, "update_component", { ref: "U1", placed_unit: 3, rotation: 90 })
    expect(out.isError).toBe(true)
    expect(out.result).toBe("Error: U1 has no unit 3 on the sheet. Units placed: 1, 2")
  })

  it("changes a symbol to another unit of the part, which has its own pins", () => {
    const p = sheet([1])
    const out = must(p, "update_component", { ref: "U1", unit: 3 })
    expect(out.result).toMatch(/Updated U1: now unit 3/)
    const c = out.project.components[0]
    expect(unitOf(c)).toBe(3)
    expect(schematicPins(c).map((x) => x.pin).sort()).toEqual(["4", "8"])
    expect(design(out.project).components[0].unit).toBe(3)
  })

  it("will not make a symbol a unit that is already on the sheet", () => {
    const p = sheet([1, 2])
    const out = call(p, "update_component", { ref: "U1", unit: 2 })
    expect(out.isError).toBe(true)
    expect(out.result).toBe("Error: Unit 2 of U1 is already on the sheet; units placed: 1, 2")
  })

  it("refuses a unit the part does not have, and changes nothing", () => {
    const p = sheet([1])
    expect(call(p, "update_component", { ref: "U1", unit: 9 }).result).toMatch(/has 3 units, so there is no unit 9/)
    const one = importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] })
    expect(call(one, "update_component", { ref: "U3", unit: 2 }).result).toMatch(/has 1 unit, so there is no unit 2/)
  })

  it("refuses to change a unit that would cut a wired pin off its net, and leaves the sheet alone", () => {
    let p = sheet([1])
    p = must(p, "add_component", { part_id: "resistor", x: -4, y: 0 }).project
    p = must(p, "connect", { pins: ["U1.2", "R1.2"] }).project
    const out = call(p, "update_component", { ref: "U1", unit: 3 })
    expect(out.isError).toBe(true)
    expect(out.result).toMatch(/^Error: Didn't change U1: it would cut R1\.2 off U1\.- \(pin 2\)\. Nothing was changed\./)
    expect(out.project).toBe(p)
  })

  it("changes a body style, and refuses one the part does not have", () => {
    const gate = withFootprint(importSheet({ symbols: [place("Test:AND2", "100 100", "U2")] }))
    const out = must(gate, "update_component", { ref: "U2", body_style: 2 })
    expect(out.project.components[0].bodyStyle).toBe(2)
    expect(design(out.project).components[0].body_style).toBe(2)
    const back = must(out.project, "update_component", { ref: "U2", body_style: 1 })
    expect(back.project.components[0].bodyStyle).toBeUndefined()
    expect(call(gate, "update_component", { ref: "U2", body_style: 3 }).result).toMatch(/has 2 body styles, so there is no style 3/)
  })

  it("switches a pin to one of its functions, and back", () => {
    const p = withFootprint(importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] }))
    const out = must(p, "update_component", { ref: "U3", pin_function: { pin: "PA0", function: "SCL" } })
    expect(out.result).toMatch(/pin 1 is SCL/)
    expect(out.project.components[0].pinAlt).toEqual({ "1": "SCL" })
    expect(design(out.project).components[0].pins!.find((x) => x.pin === "1")).toMatchObject({ function: "SCL", type: "bidirectional" })
    const tx = must(out.project, "update_component", { ref: "U3", pin_function: { pin: "1", function: "tx" } })
    expect(tx.project.components[0].pinAlt).toEqual({ "1": "TX" })
    expect(schematicPins(tx.project.components[0]).find((x) => x.pin === "1")!.type).toBe("output")
    const back = must(tx.project, "update_component", { ref: "U3", pin_function: { pin: "1", function: "default" } })
    expect(back.project.components[0].pinAlt).toBeUndefined()
    expect(back.result).toMatch(/back to its own function/)
  })

  it("names the functions a pin has when asked for one it does not", () => {
    const p = withFootprint(importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] }))
    expect(call(p, "update_component", { ref: "U3", pin_function: { pin: "PA0", function: "MOSI" } }).result).toBe("Error: Pin 1 of U3 has no function MOSI. Its functions: SCL, TX, VREF, or default")
    expect(call(p, "update_component", { ref: "U3", pin_function: { pin: "2", function: "TX" } }).result).toBe("Error: Pin 2 of U3 has one function only")
    expect(call(p, "update_component", { ref: "U3", pin_function: { pin: "99", function: "TX" } }).result).toBe("Error: U3 has no pin 99")
  })

  it("refuses a pin function that would put a wired pin on another net's terms: the net stays", () => {
    // VREF is a power input: switching a wired pin to it changes what ERC says, not what is connected.
    let p = withFootprint(importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] }))
    p = must(p, "connect", { pins: ["U3.1"], net_name: "SIG" }).project
    const out = must(p, "update_component", { ref: "U3", pin_function: { pin: "1", function: "VREF" } })
    expect(design(out.project).nets.find((n) => n.name === "SIG")!.pins).toEqual(["U3.1"])
  })

  it("shows, hides and moves fields", () => {
    const p = sheet([1])
    const hide = must(p, "update_component", { ref: "U1", fields: [{ name: "value", hidden: true }] })
    expect(hide.result).toMatch(/Value hidden/)
    expect(design(hide.project).components[0].fields!.find((f) => f.name === "Value")).toMatchObject({ hidden: true })
    expect(design(hide.project).components[0].fields!.find((f) => f.name === "Value")!.x).toBeUndefined()
    const shown = must(hide.project, "update_component", { ref: "U1", fields: [{ name: "Value", hidden: false, x: 9, y: -9, angle: 90, size: 0.2 }] })
    const value = design(shown.project).components[0].fields!.find((f) => f.name === "Value")!
    expect(value).toMatchObject({ x: 9, y: -9 })
    expect(value.hidden).toBeUndefined()
    expect(shown.project.components[0].fields!.Value).toMatchObject({ angle: 90, size: 0.2 })
    expect(shown.project.components[0].fields!.Value.hidden).toBeUndefined()
  })

  it("names the fields a symbol has when asked for one it does not, and says an own part has none to move", () => {
    const p = sheet([1])
    const out = call(p, "update_component", { ref: "U1", fields: [{ name: "Colour", hidden: true }] })
    expect(out.result).toMatch(/^Error: U1 has no field Colour\. Its fields: /)
    expect(out.result).toMatch(/Reference/)
    const own = createProjectWithResistor()
    expect(call(own, "update_component", { ref: "R1", fields: [{ name: "Value", hidden: true }] }).result).toBe("Error: R1's reference and value are part of its symbol: they cannot be hidden or moved")
  })

  it("renames every unit of a part, and shares properties between them", () => {
    const p = sheet([1, 2, 3])
    const out = must(p, "update_component", { ref: "U1", new_ref: "U7", props: { value: "TL072" } })
    expect(refs(out.project, "U7")).toHaveLength(3)
    expect(refs(out.project, "U1")).toHaveLength(0)
    for (const c of refs(out.project, "U7")) expect(c.props.value).toBe("TL072")
    expect(design(out.project).components[0].fields!.find((f) => f.name === "Reference")!.text).toBe("U7A")
    expect(call(out.project, "update_component", { ref: "U7", new_ref: "R9" }).isError).toBe(false)
    const clash = call(must(out.project, "add_component", { part_id: "resistor", ref: "R5" }).project, "update_component", { ref: "U7", new_ref: "R5" })
    expect(clash.result).toBe("Error: Designator R5 is already used")
  })

  it("leaves the editor's own parts alone: a part with one unit renames as before", () => {
    const own = createProjectWithResistor()
    const out = must(own, "update_component", { ref: "R1", new_ref: "R9", rotation: 90 })
    expect(out.result).toBe("Updated R1: renamed to R9; rotated to 90°")
    expect(out.project.components[0]).toMatchObject({ ref: "R9", sch: { rot: 90 } })
  })

  it("checks input: placed_unit must be a whole number, mirror one of x, y, none", () => {
    const p = sheet([1])
    expect(call(p, "update_component", { ref: "U1", placed_unit: 1.5 }).result).toMatch(/placed_unit must be an integer/)
    expect(call(p, "update_component", { ref: "U1", mirror: "z" }).result).toMatch(/mirror must be one of x, y, none/)
  })
})

// ---------- connect ----------

describe("connect on a part with several units", () => {
  it("finds a pin on the unit that has it", () => {
    let p = sheet([1, 2])
    p = must(p, "add_component", { part_id: "resistor", x: 5, y: -6 }).project
    const out = must(p, "connect", { pins: ["U1.7", "R1.1"] })
    const twin = refs(out.project, "U1").find((c) => unitOf(c) === 2)!
    const pinPos = schematicPins(twin).find((x) => x.pin === "7")!.pos
    // A wire (or a label stub) leaves unit 2's output pin: the pin is on unit 2's symbol.
    const touches = out.project.wires.some((w) => w.points.some((q) => Math.abs(q.x - pinPos.x) < 1e-3 && Math.abs(q.y - pinPos.y) < 1e-3))
    expect(touches).toBe(true)
    const conn = computeConnectivity(out.project)
    const owner = refs(out.project, "U1").find((c) => !findPart(c.partId)?.unitOf)!
    const net = conn.nets.find((n) => n.pins.some((x) => x.pin === "7"))!
    // The net lists the pin under the part, and both ends are on it.
    expect(net.pins.map((x) => `${x.componentId === owner.id ? "U1" : "R1"}.${x.pin}`).sort()).toEqual(["R1.1", "U1.7"])
    expect(conn.pinNet.get(pinKey(twin.id, "7"))).toBe(net.id)
    expect(conn.pinNet.get(pinKey(owner.id, "7"))).toBe(net.id)
    expect(design(out.project).nets.some((n) => n.pins.includes("U1.7") && n.pins.includes("R1.1"))).toBe(true)
  })

  it("takes a pin of another unit by name when that is unambiguous", () => {
    const p = sheet([1, 2, 3])
    const out = must(p, "connect", { pins: ["U1.V+"], net_name: "VCC" })
    const twin = refs(out.project, "U1").find((c) => unitOf(c) === 3)!
    expect(out.project.labels.some((l) => l.name === "VCC")).toBe(true)
    expect(computeConnectivity(out.project).pinNet.has(pinKey(twin.id, "8"))).toBe(true)
  })

  it("asks for the pin number when a name belongs to pins of two units", () => {
    const p = sheet([1, 2])
    const out = call(p, "connect", { pins: ["U1.+", "U1.1"] })
    expect(out.isError).toBe(true)
    expect(out.result).toBe('Error: Unknown pin "U1.+": U1 has pins 3 and 5 called +; give the pin number')
  })

  it("names the unit to place first when the pin's unit is not on the sheet", () => {
    const p = sheet([1, 2])
    const out = call(p, "connect", { pins: ["U1.8"], net_name: "VCC" })
    expect(out.isError).toBe(true)
    expect(out.result).toBe(`Error: Pin 8 (V+) of U1 is on unit 3, which is not on the sheet yet. Place it first: add_component with part_id "${baseId(p)}", ref "U1" and unit 3`)
    expect(out.project).toBe(p)
    // The pin by number or name gives the same answer, and so does one of several.
    expect(call(p, "connect", { pins: ["U1.V+", "U1.1"] }).result).toMatch(/is on unit 3, which is not on the sheet yet/)
    const both = call(p, "connect", { pins: ["U1.V+", "U1.9"] }).result
    expect(both).toMatch(/Unknown pin "U1\.9": U1 has pins 1 \(unit 1\), 2\/- \(unit 1\)/)
    expect(both).toMatch(/Pin 8 \(V\+\) of U1 is on unit 3/)
  })

  it("then connects it once the unit is placed", () => {
    let p = sheet([1, 2])
    p = must(p, "add_component", { part_id: baseId(p), ref: "U1", unit: 3, x: 6, y: 0 }).project
    expect(call(p, "connect", { pins: ["U1.8"], net_name: "VCC" }).isError).toBe(false)
  })

  it("connects a hidden pin like any other", () => {
    const p = withFootprint(importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] }))
    const out = call(p, "connect", { pins: ["U3.VDD", "U3.5"], net_name: "VDD" })
    expect(out.result).not.toMatch(/Unknown pin/)
    expect(out.isError, out.result).toBe(false)
    // The pin was on VDD by its name; the other pin joins it.
    expect(design(out.project).nets.find((n) => n.name === "VDD")!.pins.sort()).toEqual(["U3.4", "U3.5"])
  })

  it("leaves a part with one unit exactly as before", () => {
    const p = must(createProjectWithResistor(), "add_component", { part_id: "resistor", x: 3, y: 0 }).project
    expect(call(p, "connect", { pins: ["R1.9", "R2.1"] }).result).toBe('Error: Unknown pin "R1.9": R1 has pins 1, 2')
    expect(call(p, "connect", { pins: ["R1.2", "R2.1"] }).isError).toBe(false)
  })
})

// ---------- remove_component ----------

describe("remove_component on a part with several units", () => {
  it("takes off one unit and leaves the part", () => {
    const p = sheet([1, 2, 3])
    const out = must(p, "remove_component", { ref: "U1", placed_unit: 2 })
    expect(refs(out.project, "U1").map(unitOf).sort()).toEqual([1, 3])
    expect(out.result).toMatch(/^Removed unit 2 of U1 and 0 attached wire\(s\)\. Units still on the sheet: 1, 3\./)
    expect(design(out.project).components[0].units_missing).toEqual([2])
  })

  it("promotes the next unit when the part's own symbol goes, with its footprint, so the part stays whole", () => {
    const p = sheet([1, 2, 3])
    const out = must(p, "remove_component", { ref: "U1", placed_unit: 1 })
    const left = refs(out.project, "U1")
    expect(left.map(unitOf).sort()).toEqual([2, 3])
    const owners = left.filter((c) => !findPart(c.partId)?.unitOf)
    expect(owners).toHaveLength(1)
    expect(owners[0].footprint).toBe("soic8")
    expect(design(out.project).components).toHaveLength(1)
    expect(design(out.project).components[0].units_missing).toEqual([1])
    // Still one line in the board's BOM terms: one physical part.
    expect(out.project.components.filter((c) => c.footprint).length).toBe(1)
  })

  it("removes every unit when no unit is named, with the wires on their pins", () => {
    let p = sheet([1, 2])
    p = must(p, "add_component", { part_id: "resistor", x: 6, y: -6 }).project
    p = must(p, "connect", { pins: ["U1.7", "R1.1"] }).project
    const out = must(p, "remove_component", { ref: "U1" })
    expect(refs(out.project, "U1")).toHaveLength(0)
    expect(out.result).toMatch(/^Removed U1 \(all 2 units\) and \d+ attached wire\(s\)/)
    expect(out.project.wires.length).toBeLessThan(p.wires.length)
    expect(out.project.components.map((c) => c.ref)).toEqual(["R1"])
  })

  it("says which units are placed when asked to remove one that is not", () => {
    expect(call(sheet([1, 2]), "remove_component", { ref: "U1", placed_unit: 3 }).result).toBe("Error: U1 has no unit 3 on the sheet. Units placed: 1, 2")
  })

  it("removes a part with one unit as before", () => {
    const p = createProjectWithResistor()
    expect(call(p, "remove_component", { ref: "R1" }).result).toBe("Removed R1 and 0 attached wire(s).")
  })
})

// ---------- blocks ----------

describe("group_parts", () => {
  it("takes every unit of a part into the block, and names the part once", () => {
    const p = sheet([1, 2, 3])
    const out = must(p, "group_parts", { block: "AMPS", refs: ["U1"] })
    const block = out.project.blocks![0]
    expect(block.components).toHaveLength(3)
    expect(out.result).toMatch(/^Block AMPS holds U1\./)
    expect(out.summary).toBe("Grouped U1 into AMPS")
    expect(design(out.project).blocks![0].parts).toEqual(["U1"])
  })
})
