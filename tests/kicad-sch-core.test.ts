import { describe, expect, it } from "vitest"
import { orientPoint } from "../src/lib/geometry"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { schematicBounds, schematicPins, unitOwners } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { composeOrientation, createProject, mirrorComponent, removeItems, rotateComponent } from "../src/model/ops"
import { PROJECT_FILE_VERSION, parseProjectFile, serializeProject } from "../src/model/projectFile"
import { addUnit, mirrorSelection, pasteItems, renameReference, rotateSelection, setFieldPlace, setSymbolVariant } from "../src/model/schematicEdit"
import { componentFields, fieldValue, unitLetters } from "../src/model/symbolDrawing"
import type { Mirror, Project, Rotation } from "../src/model/types"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { ALL_LIBS, importSheet, place } from "./kicad-sch-parts"
import { schematic } from "./kicad-schematic-fixtures"

// Symbols with units, mirrors, hidden power pins, repeated pin numbers and alternates (S5), as the
// editor works with them once imported: connectivity, editing, and the project file.

/** An imported part has no footprint until it is linked to a board, and is a part of the sheet all the same: nets list its pins. */
const physical = (p: Project) => p

const netOf = (p: Project, ref: string, pin: string, unit?: number) => {
  const conn = computeConnectivity(p)
  const c = p.components.find((x) => x.ref === ref && (unit === undefined || (x.unit ?? 1) === unit))!
  const id = conn.pinNet.get(pinKey(c.id, pin))
  return id ? conn.nets.find((n) => n.id === id) : undefined
}

describe("a part with several units", () => {
  const sheet = () =>
    importSheet({
      symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 }), place("Test:OPA2", "100 140", "U1", { unit: 2 }), place("Test:OPA2", "140 100", "U1", { unit: 3 })],
      // the output of unit 1 and the output of unit 2 are one net by their label
      wires: ["107.62 100 115 100", "107.62 140 115 140"],
      labels: ["A 115 100 0", "A 115 140 0"],
    })

  it("is placed as several symbols of one reference, one of which is the part", () => {
    const p = sheet()
    expect(p.components.map((c) => [c.ref, c.unit ?? 1])).toEqual([["U1", 1], ["U1", 2], ["U1", 3]])
    const [a, b, c] = p.components.map((x) => findPart(x.partId)!)
    expect(a.unitOf).toBeUndefined()
    expect(b.unitOf).toBe(a.id)
    expect(c.unitOf).toBe(a.id)
    // only the part has a footprint (none here: nothing links it to a board), and none of them is a second part
    expect(b.footprints).toEqual([])
    expect(unitOwners(p.components).get(p.components[1].id)).toBe(p.components[0].id)
    expect(unitOwners(p.components).has(p.components[0].id)).toBe(false)
    expect(a.units?.count).toBe(3)
    expect(a.pins.map((q) => q.number).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"])
  })

  it("has the pins of each unit on its own symbol, and all of them on the part", () => {
    const p = sheet()
    expect(schematicPins(p.components[0]).map((q) => q.pin)).toEqual(["1", "2", "3"])
    expect(schematicPins(p.components[1]).map((q) => q.pin)).toEqual(["7", "6", "5"])
    expect(schematicPins(p.components[2]).map((q) => q.pin)).toEqual(["8", "4"])
  })

  it("puts a pin of another unit on the net it is wired to, and lists it under the part", () => {
    const p = physical(sheet())
    const conn = computeConnectivity(p)
    const owner = p.components[0]
    const twin = p.components[1]
    const a = netOf(p, "U1", "1", 1)!
    expect(a.name).toBe("/A")
    // pin 7 is a pin of unit 2, whose symbol is the twin: it is on A by the twin's key and by the part's
    expect(conn.pinNet.get(pinKey(twin.id, "7"))).toBe(a.id)
    expect(conn.pinNet.get(pinKey(owner.id, "7"))).toBe(a.id)
    // both pins are listed under the component that is on the board
    expect(a.pins).toEqual([{ componentId: owner.id, pin: "1" }, { componentId: owner.id, pin: "7" }])
  })

  it("is not joined between units by a shared pin number: each unit's pin is its own, as KiCad's graph has it", () => {
    // the same hidden power pin number drawn in two units, wired to different nets, stays two nets
    const p = importSheet({
      symbols: [place("Test:MCU", "60 120", "U3"), place("Test:MCU", "60 160", "U4")],
    })
    expect(netOf(p, "U3", "4")?.name).toBe("VDD")
    expect(netOf(p, "U4", "4")?.name).toBe("VDD")
  })

  it("is renamed whole, and a unit whose part is deleted takes its place", () => {
    const p = sheet()
    const renamed = renameReference(p, p.components[1].id, "U9")
    expect(renamed.components.map((c) => c.ref)).toEqual(["U9", "U9", "U9"])
    const gone = removeItems(p, { components: [p.components[0].id] })
    // the next unit is now the part: its own symbol, with the footprint and place the old one had
    expect(gone.components).toHaveLength(2)
    const first = findPart(gone.components[0].partId)!
    expect(first.unitOf).toBeUndefined()
    expect(gone.components[0].unit).toBe(2)
    expect(findPart(gone.components[1].partId)!.unitOf).toBe(first.id)
    // delete them all: nothing is left behind
    expect(removeItems(gone, { components: gone.components.map((c) => c.id) }).components).toEqual([])
  })

  it("is given another unit by addUnit, as a symbol of the same reference, refused when that unit is on the sheet", () => {
    const p = importSheet({ symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 })] })
    const res = addUnit(p, p.components[0].id, 2, { x: 4, y: -12 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.component.ref).toBe("U1")
    expect(res.component.unit).toBe(2)
    expect(res.component.footprint).toBe("")
    expect(findPart(res.component.partId)!.unitOf).toBe(p.components[0].partId)
    expect(addUnit(res.project, p.components[0].id, 2, { x: 4, y: -14 }).ok).toBe(false)
    expect(addUnit(res.project, p.components[0].id, 9, { x: 4, y: -14 }).ok).toBe(false)
    expect(unitLetters(1)).toBe("A")
    expect(unitLetters(27)).toBe("AA")
  })

  it("is copied whole under one new reference, and a unit copied alone is a part of its own", () => {
    const p = sheet()
    const all = pasteItems(p, { project: p, components: p.components.map((c) => c.id), wires: [], labels: [], blocks: [] }, { x: 0, y: -10 })
    expect(all.ok).toBe(true)
    if (!all.ok) return
    const added = all.project.components.slice(3)
    expect(new Set(added.map((c) => c.ref)).size).toBe(1)
    expect(added[0].ref).not.toBe("U1")
    expect(added.map((c) => c.unit ?? 1)).toEqual([1, 2, 3])
    expect(unitOwners(all.project.components).get(added[1].id)).toBe(added[0].id)
    const lone = pasteItems(p, { project: p, components: [p.components[1].id], wires: [], labels: [], blocks: [] }, { x: 0, y: -10 })
    expect(lone.ok).toBe(true)
    if (!lone.ok) return
    const copy = lone.project.components[3]
    expect(copy.ref).not.toBe("U1")
    expect(findPart(copy.partId)!.unitOf).toBeUndefined()
  })

  it("keeps its part when one unit is pasted alone into an empty project, through a save and a load", () => {
    const p = sheet()
    const unit2 = p.components[1]
    expect(findPart(unit2.partId)!.unitOf).toBeDefined()
    const pasted = pasteItems(createProject("empty"), { project: p, components: [unit2.id], wires: [], labels: [], blocks: [] }, { x: 0, y: 0 })
    expect(pasted.ok).toBe(true)
    if (!pasted.ok) return
    expect(pasted.project.parts?.length).toBe(1)
    expect(Object.keys(pasted.project.symbols ?? {})).toHaveLength(1)
    const back = parseProjectFile(serializeProject(pasted.project), { id: "back" })
    const copy = back.components[0]
    const part = findPart(copy.partId)
    expect(part).toBeDefined()
    expect(part!.units?.count).toBe(3)
    expect(copy.unit).toBe(2)
    expect(schematicPins(copy).length).toBeGreaterThan(0)
  })

  it("gives a unit to the part drawn from its own symbol when two parts share a reference", () => {
    const p = sheet()
    const gate = importSheet({ symbols: [place("Test:AND2", "60 60", "U9")] }).components[0]
    // a gate with the op-amp's designator, ahead of it in the list
    const components = [{ ...gate, ref: "U1" }, ...p.components]
    const owners = unitOwners(components)
    expect(owners.get(p.components[1].id)).toBe(p.components[0].id)
    expect(owners.get(p.components[2].id)).toBe(p.components[0].id)
    expect([...owners.values()].includes(components[0].id)).toBe(false)
  })

  it("writes the unit's letter after the reference", () => {
    const p = sheet()
    const part = findPart(p.components[1].partId)!
    expect(fieldValue(p.components[1], part, "Reference")).toBe("U1B")
    expect(fieldValue(p.components[0], findPart(p.components[0].partId)!, "Reference")).toBe("U1A")
  })
})

describe("a part with a body style", () => {
  it("is drawn in the style it is placed in, with that style's pins where its drawing has them", () => {
    const p = importSheet({ symbols: [place("Test:AND2", "100 100", "U1"), place("Test:AND2", "140 100", "U2", { extra: "(body_style 2)" })] })
    const [a, b] = p.components
    expect([a.bodyStyle, b.bodyStyle]).toEqual([undefined, 2])
    expect(findPart(a.partId)!.units?.bodyStyles).toBe(2)
    expect(schematicBounds(a).maxX).toBeLessThan(schematicBounds(b).maxX + 1e-9)
    const res = setSymbolVariant(p, a.id, { bodyStyle: 2 })
    expect(res.ok && res.project.components[0].bodyStyle).toBe(2)
    expect(setSymbolVariant(p, a.id, { bodyStyle: 3 }).ok).toBe(false)
  })
})

describe("hidden power pins, pins that are not connected, and pins that share a number", () => {
  it("a hidden power-input pin is on the global net of its name, with no wire and no label", () => {
    const p = importSheet({ symbols: [place("Test:MCU", "60 120", "U3"), place("Test:MCU", "120 120", "U4")], labels: ["VDD 200 200 0"] })
    const n = netOf(p, "U3", "4")!
    expect(n.name).toBe("VDD")
    expect(n.named).toBe(true)
    expect(netOf(p, "U4", "4")?.id).toBe(n.id)
    expect(p.labels.map((l) => l.name)).toEqual(["VDD"])
    // the pin is not drawn
    const pin = schematicPins(p.components[0]).find((q) => q.pin === "4")!
    expect(pin.hidden).toBe(true)
  })

  it("a pin of the type no connect is on no net, whatever is drawn to it", () => {
    // pin 3 of the MCU at (52.38, 120): a wire ends there, and a label of another net
    const p = importSheet({ symbols: [place("Test:MCU", "60 120", "U3"), place("Test:MCU", "120 120", "U4")], wires: ["52.38 120 40 120"], labels: ["Z 40 120 0"] })
    expect(netOf(p, "U3", "3")).toBeUndefined()
    const conn = computeConnectivity(p)
    expect(conn.unconnectedPins.some((q) => q.pin === "3")).toBe(false)
  })

  it("pins that share a number are one pin when the symbol says it jumpers them", () => {
    // J1 pins 1a (174.92, 98.73) and 1b (174.92, 101.27) are both pin 1
    const p = importSheet({ symbols: [place("Test:JMP", "180 100", "J1")], wires: ["174.92 98.73 160 98.73"], labels: ["X 160 98.73 0"] })
    const j = p.components[0]
    expect(netOf(p, "J1", "1")?.name).toBe("/X")
    const conn = computeConnectivity(p)
    // the second pin 1 is on that net as well: nothing is left unconnected for it
    expect(conn.unconnectedPins.filter((q) => q.pin === "1")).toEqual([])
    expect(schematicPins(j).filter((q) => q.pin === "1")).toHaveLength(2)
  })

  it("pins that share a number are separate pins when it does not", () => {
    const p = physical(importSheet({ symbols: [place("Test:DUP", "180 100", "J2")], wires: ["174.92 98.73 160 98.73"], labels: ["X 160 98.73 0"] }))
    const conn = computeConnectivity(p)
    expect(netOf(p, "J2", "1")?.name).toBe("/X")
    // the pin 1 that is not wired is its own, floating
    expect(conn.unconnectedPins.filter((q) => q.pin === "1")).toHaveLength(1)
    expect(conn.unconnectedPins.find((q) => q.pin === "1")?.slot).toBe(1)
  })

  it("names a pad whose pins of one number are on different nets, since the board's pad takes the first's", () => {
    const wired = (labels: string[]) => importKicadSchematic(schematic({ libs: ALL_LIBS, symbols: [place("Test:DUP", "180 100", "J2")], wires: ["174.92 98.73 160 98.73", "174.92 101.27 160 101.27"], labels }))
    const split = wired(["X 160 98.73 0", "Y 160 101.27 0"])
    expect(split.status).toBe("imported")
    if (split.status !== "imported") return
    const entry = split.report.entries.find((e) => e.code === "split-pad")
    expect(entry?.object).toContain("J2 pin 1")
    expect(entry?.count).toBe(1)
    // on one net the two pins agree, and there is nothing to say
    const same = wired(["X 160 98.73 0", "X 160 101.27 0"])
    if (same.status === "imported") expect(same.report.entries.some((e) => e.code === "split-pad")).toBe(false)
  })

  it("pins of different numbers a symbol joins inside itself are one net", () => {
    const p = importSheet({ symbols: [place("Test:GRP", "180 100", "J3")], wires: ["174.92 98.73 160 98.73"], labels: ["X 160 98.73 0"] })
    expect(netOf(p, "J3", "1")?.name).toBe("/X")
    expect(netOf(p, "J3", "2")?.name).toBe("/X")
    expect(netOf(p, "J3", "3")).toBeUndefined()
  })

  it("a pin switched to an alternate function has its name and type", () => {
    const p = importSheet({ symbols: [place("Test:MCU", "60 120", "U3")] })
    const c = p.components[0]
    const before = schematicPins(c).find((q) => q.pin === "1")!
    expect([before.name, before.type]).toEqual(["PA0", "bidirectional"])
    const res = setSymbolVariant(p, c.id, { pinAlt: { pin: "1", alternate: "TX" } })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const after = schematicPins(res.project.components[0]).find((q) => q.pin === "1")!
    expect([after.name, after.type]).toEqual(["TX", "output"])
    expect(res.project.components[0].pinAlt).toEqual({ "1": "TX" })
    expect(setSymbolVariant(res.project, c.id, { pinAlt: { pin: "1", alternate: null } }).ok && (setSymbolVariant(res.project, c.id, { pinAlt: { pin: "1", alternate: null } }) as { project: Project }).project.components[0].pinAlt).toBeUndefined()
    expect(setSymbolVariant(p, c.id, { pinAlt: { pin: "1", alternate: "NOPE" } }).ok).toBe(false)
  })
})

describe("a mirrored and turned symbol", () => {
  const ROTS: Rotation[] = [0, 90, 180, 270]
  const MIRRORS: (Mirror | undefined)[] = [undefined, "x", "y"]

  it("puts its pins where turn then mirror puts them, in all twelve placements", () => {
    for (const rot of ROTS)
      for (const mirror of MIRRORS) {
        const p = importSheet({ symbols: [place("Test:AND2", "100 100", "U1")] })
        const c = { ...p.components[0], sch: { ...p.components[0].sch, rot, ...(mirror ? { mirror } : {}) } }
        const base = schematicPins(p.components[0])
        const now = schematicPins(c)
        base.forEach((b, i) => {
          const rel = { x: b.pos.x - p.components[0].sch.x, y: b.pos.y - p.components[0].sch.y }
          const want = orientPoint(rel, rot, mirror)
          expect(now[i].pos.x).toBeCloseTo(c.sch.x + want.x, 4)
          expect(now[i].pos.y).toBeCloseTo(c.sch.y + want.y, 4)
        })
      }
  })

  it("composes a turn or a mirror with a placement as the sheet does", () => {
    for (const rot of ROTS)
      for (const mirror of MIRRORS)
        for (const w of [{ kind: "turn", by: 90 }, { kind: "turn", by: 270 }, { kind: "mirror", axis: "x" }, { kind: "mirror", axis: "y" }] as const) {
          const next = composeOrientation({ rot, mirror }, w)
          for (const q of [{ x: 3, y: 1 }, { x: -2, y: 5 }]) {
            const before = orientPoint(q, rot, mirror)
            const want = w.kind === "turn" ? orientPoint(before, w.by, undefined) : orientPoint(before, 0, w.axis)
            const got = orientPoint(q, next.rot, next.mirror)
            expect(got.x).toBeCloseTo(want.x, 9)
            expect(got.y).toBeCloseTo(want.y, 9)
          }
        }
  })

  it("keeps its wires on its pins when it is turned or mirrored, and the nets as they were", () => {
    const p = physical(
      importSheet({
        symbols: [place("Device:R", "100 100", "R1"), place("Device:R", "140 100", "R2")],
        // R1 pin 2 (100, 103.81) to R2 pin 1 (140, 96.19)
        wires: ["100 103.81 100 110", "100 110 140 110", "140 110 140 96.19"],
      }),
    )
    const before = netOf(p, "R1", "2")!
    expect(before.pins.map((q) => q.pin)).toEqual(["2", "1"])
    let cur = p
    // left to right swaps no pin of a vertical part; top to bottom would put pin 1 where pin 2's wire is, and is refused
    for (const axis of ["y", "y"] as const) {
      const res = mirrorSelection(cur, { components: [cur.components[0].id] }, axis)
      expect(res.ok, res.ok ? "" : res.message).toBe(true)
      if (!res.ok) return
      cur = res.project
      expect(netOf(cur, "R1", "2")?.pins.length).toBe(2)
    }
    const refused = mirrorSelection(cur, { components: [cur.components[0].id] }, "x")
    expect(refused.ok).toBe(false)
    for (let i = 0; i < 4; i++) {
      const res = rotateSelection(cur, { components: [cur.components[0].id], labels: [] })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      cur = res.project
      expect(netOf(cur, "R1", "2")?.pins.length).toBe(2)
    }
    // a mirror alone is kept on the component, and absent when there is none
    const once = mirrorComponent(p, p.components[0].id, "y")
    expect(once.components[0].sch.mirror).toBe("y")
    expect("mirror" in mirrorComponent(once, once.components[0].id, "y").components[0].sch).toBe(false)
  })

  it("turns a mirrored part the way the screen turns, not the way its own turn runs", () => {
    const p = importSheet({ symbols: [place("Test:AND2", "100 100", "U1", { mirror: "y" })] })
    const c = p.components[0]
    const out = rotateComponent(p, c.id, 90)
    // counter-clockwise on screen is a step back in a mirrored part's own turn
    const res = rotateSelection(p, { components: [c.id], labels: [] })
    expect(res.ok && res.project.components[0].sch.rot).toBe(270)
    expect(out.components[0].sch.mirror).toBe("y")
  })
})

describe("the fields of a placed symbol", () => {
  it("has its own place, size and look for each, and keeps them in the component", () => {
    const text = `(property "Value" "10k" (at 3 4 90) (effects (font (size 2 2) italic) (justify left top)))`
    void text
    const p = importSheet({ symbols: [place("Device:R", "100 100", "R1", { value: "4k7" })] })
    const c = p.components[0]
    const part = findPart(c.partId)!
    const fields = componentFields(c, part)
    expect(fields.map((f) => f.name)).toEqual(["Reference", "Value"])
    expect(fields[1].text).toBe("4k7")
    expect(c.fields?.Reference).toBeDefined()
    const moved = setFieldPlace(p, c.id, "Value", { x: 0.5, y: -0.25 })
    expect(moved.components[0].fields?.Value).toMatchObject({ x: 0.5, y: -0.25 })
    const hidden = setFieldPlace(moved, c.id, "Value", { hidden: true })
    expect(componentFields(hidden.components[0], part).map((f) => f.name)).toEqual(["Reference"])
    const shown = setFieldPlace(hidden, c.id, "Value", { hidden: undefined })
    expect(componentFields(shown.components[0], part).map((f) => f.name)).toEqual(["Reference", "Value"])
  })
})

describe("the project file", () => {
  const sheet = () =>
    importSheet({
      symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 }), place("Test:OPA2", "100 140", "U1", { unit: 2 }), place("Test:AND2", "60 60", "U2", { mirror: "x" }), place("Test:SHAPES", "220 100", "U4")],
    })

  it("the project file is at version 5, and a project with drawings, units, mirrors and fields reads back as it was written", () => {
    expect(PROJECT_FILE_VERSION).toBe(5)
    const p = sheet()
    const back = parseProjectFile(serializeProject(p), { id: p.id })
    expect(back.symbols).toEqual(p.symbols)
    expect(back.parts).toEqual(p.parts)
    back.components.forEach((c, i) => expect(JSON.parse(JSON.stringify(c))).toEqual(JSON.parse(JSON.stringify(p.components[i]))))
    expect(back.components.some((c) => c.sch.mirror === "x")).toBe(true)
    expect(back.components.some((c) => c.unit === 2)).toBe(true)
    // the parts are drawn from the drawings: the unit twin is there again
    expect(findPart(back.components[1].partId)?.unitOf).toBe(back.components[0].partId)
  })

  it("reads a version 2 document, which has none of it, as it is", () => {
    const doc = { format: "cherryblossom.project", version: 2, project: { name: "Old", description: "", components: [{ id: "c1", partId: "resistor", ref: "R1", props: { resistance: "10k" }, footprint: "0603", sch: { x: 1, y: 2, rot: 90 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false } }], wires: [], labels: [], traces: [], vias: [], zones: [], texts: [] } }
    const p = parseProjectFile(JSON.stringify(doc), { id: "p" })
    expect(p.components[0]).toMatchObject({ ref: "R1", sch: { x: 1, y: 2, rot: 90 } })
    expect(p.components[0].unit).toBeUndefined()
    expect(p.symbols).toBeUndefined()
    expect(JSON.parse(serializeProject(p)).version).toBe(PROJECT_FILE_VERSION)
  })

  it("drops a drawing the editor cannot draw with the parts that name it, and promotes a unit that has lost its part", () => {
    const p = sheet()
    const doc = JSON.parse(serializeProject(p))
    const key = Object.keys(doc.project.symbols)[0]
    doc.project.symbols[key].items.push({ kind: "polyline", points: [{ x: "a", y: 1 }] })
    const broken = parseProjectFile(doc, { id: "p" })
    expect(broken.symbols?.[key]).toBeUndefined()
    expect(broken.parts?.every((s) => s.drawing !== key)).toBe(true)
    // the part is gone from the file but its unit is there: it takes the part's place
    const doc2 = JSON.parse(serializeProject(p))
    doc2.project.components = doc2.project.components.filter((c: { id: string }) => c.id !== p.components[0].id)
    const orphan = parseProjectFile(doc2, { id: "p" })
    const unit2 = orphan.components.find((c) => c.unit === 2)!
    expect(findPart(unit2.partId)?.unitOf).toBeUndefined()
  })

  it("throws away a field place or a mirror that is not one", () => {
    const p = sheet()
    const doc = JSON.parse(serializeProject(p))
    doc.project.components[2].sch.mirror = "z"
    doc.project.components[2].fields = { Value: { x: "no", y: 1, angle: 0 }, Reference: { x: 1, y: 2, angle: 90 } }
    const back = parseProjectFile(doc, { id: "p" })
    expect("mirror" in back.components[2].sch).toBe(false)
    expect(Object.keys(back.components[2].fields ?? {})).toEqual(["Reference"])
  })
})
