import { describe, expect, it } from "vitest"
import { typedLabelName } from "../src/model/busNames"
import { globalLabelUses, intersheetRefs } from "../src/model/intersheetRefs"
import { labelBox } from "../src/model/labels"
import { addComponent, addLabel, addWire, createProject } from "../src/model/ops"
import { setLabelStyle } from "../src/model/schematicEdit"
import { addSheet, addSheetPin, addSheetUse, edgeSpot, moveSheetPin, syncSheetEntry } from "../src/model/sheetOps"
import { commitOnUse, sheetView } from "../src/model/sheets"
import type { NetLabel, Project, Rotation } from "../src/model/types"

// Drawing a sheet hierarchy by hand: entries slid along a sheet symbol's edges, entries and ports kept in step, labels of every kind, the name a user types,
// and the other sheets a global label's name is on.

/** Main with a sheet Power on it, a symbol at (0, 0) two wide and 1.2 high. */
function withSheet(): { project: Project; symbol: string } {
  const made = addSheet(createProject("t"), "", { minX: 0, minY: 0, maxX: 2, maxY: 1.2 }, "Power")
  return { project: made.project, symbol: made.symbol.id }
}

const pinsOf = (p: Project, symbol: string) => p.sheetSymbols!.find((s) => s.id === symbol)!.pins
/** A label put on a sheet, as the editor puts one on the sheet it shows. */
const labelOn = (p: Project, sheet: string, name: string, at: { x: number; y: number }, rot: Rotation, kind: NetLabel["kind"]) => {
  const made = addLabel(p, name, at, rot, { kind })
  return { ...made.project, labels: made.project.labels.map((l) => (l.id === made.label.id ? { ...l, sheet } : l)) }
}
const ports = (p: Project, sheet: string) => p.labels.filter((l) => l.kind === "hierarchical" && l.sheet === sheet)

describe("edgeSpot", () => {
  const sym = withSheet().project.sheetSymbols![0]

  it("is the nearest place on an edge, on the grid", () => {
    expect(edgeSpot(sym, { x: -0.03, y: 0.57 })).toEqual({ side: "left", at: { x: 0, y: 0.6 } })
    expect(edgeSpot(sym, { x: 2.04, y: 0.81 })).toEqual({ side: "right", at: { x: 2, y: 0.8 } })
    expect(edgeSpot(sym, { x: 1.26, y: 1.25 })).toEqual({ side: "top", at: { x: 1.3, y: 1.2 } })
  })

  it("keeps a grid step from every corner", () => {
    expect(edgeSpot(sym, { x: -0.05, y: 0.02 })).toEqual({ side: "left", at: { x: 0, y: 0.1 } })
    expect(edgeSpot(sym, { x: 2.05, y: 1.21 })).toEqual({ side: "right", at: { x: 2, y: 1.1 } })
  })

  it("is null away from every edge, unless asked at any distance", () => {
    expect(edgeSpot(sym, { x: 1, y: 0.6 })).toBeNull()
    expect(edgeSpot(sym, { x: -3, y: 0.6 })).toBeNull()
    expect(edgeSpot(sym, { x: 1, y: 0.3 }, { reach: Infinity })).toEqual({ side: "bottom", at: { x: 1, y: 0 } })
  })
})

describe("moveSheetPin", () => {
  /** An entry DATA on the left edge at (0, 0.6), a wire to it from the left and a net label at its point. */
  function wired() {
    const { project, symbol } = withSheet()
    let p = addSheetPin(project, symbol, "DATA", "input", "left", { x: 0, y: 0.6 })
    p = addWire(p, [{ x: -1, y: 0.6 }, { x: 0, y: 0.6 }]).project
    p = addLabel(p, "DATA", { x: 0, y: 0.6 }, 180).project
    return { p, symbol, pin: pinsOf(p, symbol)[0].id }
  }

  it("slides the entry along its edge on the grid, with the wire and the label at it", () => {
    const { p, symbol, pin } = wired()
    const moved = moveSheetPin(p, symbol, pin, { x: 0.02, y: 0.33 })
    expect(pinsOf(moved, symbol)[0]).toMatchObject({ x: 0, y: 0.3, rot: 180 })
    expect(moved.wires[0].points.at(-1)).toEqual({ x: 0, y: 0.3 })
    expect(moved.labels[0]).toMatchObject({ x: 0, y: 0.3 })
    // The sheet symbols are a new list, so the connectivity cache sees the change.
    expect(moved.sheetSymbols).not.toBe(p.sheetSymbols)
  })

  it("turns a corner, pointing the way of its new edge", () => {
    const { p, symbol, pin } = wired()
    const moved = moveSheetPin(p, symbol, pin, { x: 0.5, y: -0.4 })
    expect(pinsOf(moved, symbol)[0]).toMatchObject({ x: 0.5, y: 0, rot: 270 })
    expect(moved.wires[0].points.at(-1)).toEqual({ x: 0.5, y: 0 })
  })

  it("never lands on a corner or on another entry's place", () => {
    const { p, symbol, pin } = wired()
    const corner = moveSheetPin(p, symbol, pin, { x: -0.2, y: -0.2 })
    const at = pinsOf(corner, symbol)[0]
    expect([at.x, at.y]).not.toEqual([0, 0])
    const two = addSheetPin(p, symbol, "CLK", "input", "left", { x: 0, y: 0.3 })
    expect(moveSheetPin(two, symbol, pin, { x: 0, y: 0.31 })).toBe(two)
  })
})

describe("syncSheetEntry", () => {
  it("gives a port's entry to every symbol of a reused sheet", () => {
    const { project, symbol } = withSheet()
    const again = addSheetUse(project, "", "s1", { minX: 3, minY: 0, maxX: 5, maxY: 1.2 })!
    const p = labelOn(again.project, "s1", "DATA", { x: 0, y: 0 }, 180, "hierarchical")
    const r = syncSheetEntry(p, "s1", "DATA", "input")
    expect(r.entries).toEqual(["Power", "Power2"])
    expect(r.port).toBe(false)
    for (const s of r.project.sheetSymbols!) expect(s.pins.map((q) => [q.name, q.rot])).toEqual([["DATA", 180]])
    expect(pinsOf(r.project, symbol)[0].x).toBe(0)
  })

  it("puts a port inside for an entry, clear of the drawing, pointing out by its shape", () => {
    const { project, symbol } = withSheet()
    // A resistor on the sheet below, so it has a drawing to stand beside.
    let p = commitOnUse(project, `/${symbol}`, (v) => addComponent(v, "resistor", { sch: { x: 0, y: 0, rot: 0 } }).project)
    const drawn = sheetView(p, `/${symbol}`).components[0]
    p = addSheetPin(p, symbol, "OUT", "output", "right")
    const out = syncSheetEntry(p, "s1", "OUT", "output")
    expect(out.port).toBe(true)
    expect(out.entries).toEqual([])
    const [port] = ports(out.project, "s1")
    expect(port).toMatchObject({ name: "OUT", kind: "hierarchical", shape: "output", rot: 0 })
    expect(port.x).toBeGreaterThan(drawn.sch.x + 0.3)
    // An input goes in a column on the left, pointing left, and two in one column stand apart.
    const a = syncSheetEntry(addSheetPin(out.project, symbol, "IN", "input", "left"), "s1", "IN", "input").project
    const b = syncSheetEntry(addSheetPin(a, symbol, "EN", "input", "left"), "s1", "EN", "input").project
    const [inPort, enPort] = ports(b, "s1").filter((l) => l.rot === 180)
    expect(inPort.x).toBeLessThan(drawn.sch.x - 0.3)
    expect(enPort.x).toBe(inPort.x)
    expect(enPort.y).toBeLessThan(inPort.y)
    const [ib, eb] = [labelBox(inPort), labelBox(enPort)]
    expect(eb.maxY).toBeLessThan(ib.minY)
  })

  it("starts down from the origin on an empty sheet", () => {
    const { project, symbol } = withSheet()
    const r = syncSheetEntry(addSheetPin(project, symbol, "VIN", "bidirectional", "left"), "s1", "VIN", "bidirectional")
    expect(ports(r.project, "s1")[0]).toMatchObject({ x: 0, y: 0, rot: 180, shape: "bidirectional" })
  })

  it("adds nothing when the entry and the port are both there", () => {
    const { project, symbol } = withSheet()
    const p = labelOn(addSheetPin(project, symbol, "DATA", "input", "left"), "s1", "DATA", { x: 0, y: 0 }, 180, "hierarchical")
    const r = syncSheetEntry(p, "s1", "DATA", "input")
    expect(r).toEqual({ project: p, entries: [], port: false })
    expect(r.project).toBe(p)
  })

  it("puts the port on the sheet below even after an edit of the parent's view, and refuses to run on a view", () => {
    const { project, symbol } = withSheet()
    const edited = commitOnUse(project, "", (v) => addSheetPin(v, symbol, "SDA", "bidirectional", "left"))
    const r = syncSheetEntry(edited, "s1", "SDA", "bidirectional")
    expect(r.project.labels.map((l) => [l.name, l.sheet])).toEqual([["SDA", "s1"]])
    expect(() => syncSheetEntry(sheetView(edited, ""), "s1", "SDA", "bidirectional")).toThrow(/whole project/)
  })
})

describe("labels of every kind", () => {
  it("addLabel places global labels and ports with a shape, and net labels as each project has them", () => {
    const here = createProject("t")
    expect(addLabel(here, "A", { x: 0, y: 0 }, 0, { kind: "global" }).label).toMatchObject({ kind: "global", shape: "bidirectional" })
    expect(addLabel(here, "A", { x: 0, y: 0 }, 0, { kind: "hierarchical", shape: "output" }).label).toMatchObject({ kind: "hierarchical", shape: "output" })
    const net = addLabel(here, "A", { x: 0, y: 0 }).label
    expect(net).not.toHaveProperty("kind")
    expect(net).not.toHaveProperty("shape")
    expect(addLabel({ ...here, netNames: "kicad" }, "A", { x: 0, y: 0 }).label).toMatchObject({ kind: "local" })
  })

  it("setLabelStyle back to This sheet clears the kind in a project drawn here, and keeps KiCad's local label in a KiCad project", () => {
    const here = addLabel(createProject("t"), "A", { x: 0, y: 0 }, 0, { kind: "global" })
    const plain = setLabelStyle(here.project, here.label.id, { kind: "local" }).labels[0]
    expect(plain).not.toHaveProperty("kind")
    expect(plain).not.toHaveProperty("shape")
    const kicad = addLabel({ ...createProject("k"), netNames: "kicad" }, "A", { x: 0, y: 0 }, 0, { kind: "global" })
    const local = setLabelStyle(kicad.project, kicad.label.id, { kind: "local" }).labels[0]
    expect(local.kind).toBe("local")
    expect(local).not.toHaveProperty("shape")
  })

  it("typedLabelName upper-cases a name in a project drawn here and keeps the case in a KiCad project", () => {
    const here = createProject("t")
    expect(typedLabelName(here, " data bus ")).toBe("DATA_BUS")
    expect(typedLabelName({ netNames: "kicad" }, " data bus ")).toBe("data_bus")
    expect(typedLabelName(here, "d[0..7]")).toBe("D[0..7]")
    expect(typedLabelName({ netNames: "kicad" }, "{a   b}")).toBe("{a b}")
    // While typing, nothing is trimmed and an open group keeps its spaces.
    expect(typedLabelName(here, "usb{dp ", true)).toBe("USB{DP ")
  })
})

describe("the other sheets of a global label", () => {
  /** Main, Power used twice (Power and Power2) and MCU, with a global label SDA on Power's sheet, on MCU's and on Main. */
  function threeSheets(netNames?: Project["netNames"]) {
    const { project } = withSheet()
    const power2 = addSheetUse(project, "", "s1", { minX: 3, minY: 0, maxX: 5, maxY: 1.2 })!.project
    const mcu = addSheet(power2, "", { minX: 6, minY: 0, maxX: 8, maxY: 1.2 }, "MCU").project
    let p = labelOn(mcu, "s1", "SDA", { x: 0, y: 0 }, 0, "global")
    p = labelOn(p, "s2", "SDA", { x: 0, y: 0 }, 180, "global")
    p = addLabel(p, "SDA", { x: 0, y: 0 }, 0, { kind: "global" }).project
    return { ...p, ...(netNames ? { netNames } : {}) }
  }

  it("are the other uses whose sheet has a global label of its name, the other use of a reused sheet too", () => {
    const p = threeSheets()
    expect(globalLabelUses(p).get("SDA")!.map((u) => u.name)).toEqual(["Main", "Power", "Power2", "MCU"])
    const onPower = p.labels.find((l) => l.sheet === "s1")!
    expect(intersheetRefs(p, "/h1", onPower)!.names.map((n) => n.use.name)).toEqual(["Main", "Power2", "MCU"])
    expect(intersheetRefs(p, "/h1", onPower)!.text).toBe("[Main, Power2, MCU]")
    // After its flag: right of a flag pointing right, left of one pointing left.
    expect(intersheetRefs(p, "/h1", onPower)!.at.x).toBeGreaterThan(labelBox(onPower).maxX)
    const onMcu = p.labels.find((l) => l.sheet === "s2")!
    const left = intersheetRefs(p, "/h3", onMcu)!
    expect(left.at.x).toBeLessThan(labelBox(onMcu).minX)
    expect(Math.max(...left.names.map((n) => n.box.maxX))).toBeLessThanOrEqual(left.at.x + 1e-9)
  })

  it("are none in a KiCad project or in a project of one sheet, and never for a label that is not global", () => {
    expect(globalLabelUses(threeSheets("kicad")).size).toBe(0)
    const one = addLabel(createProject("t"), "SDA", { x: 0, y: 0 }, 0, { kind: "global" })
    expect(globalLabelUses(one.project).size).toBe(0)
    const p = threeSheets()
    expect(intersheetRefs(p, "", { ...p.labels[0], kind: undefined })).toBeNull()
  })
})
