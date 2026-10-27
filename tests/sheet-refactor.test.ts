import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { schematicPins } from "../src/model/instances"
import { addComponent, addLabel, addWire, createProject } from "../src/model/ops"
import { moveToNewSheet, type MoveToSheetResult } from "../src/model/sheetRefactor"
import { findPart } from "../src/model/library"
import { addSheetUse } from "../src/model/sheetOps"
import { sheetUses, sheetView, usesOfSheet } from "../src/model/sheets"
import type { Project } from "../src/model/types"
import { S1, S2, imp } from "./kicad-sheets-fixtures"

// Moving part of a sheet onto a new sheet of its own: what goes, the pins and labels that keep each net whole, and that nothing else changes.

/** Every pin's net as a partition: the pins each pin shares a net with, among the pins of `of` (the project before, whose pins are compared). */
function partition(p: Project, of: Project = p): Map<string, string> {
  const conn = computeConnectivity(p)
  const old = new Set(of.components.flatMap((c) => schematicPins(c).map((pin) => pinKey(c.id, pin.pin))))
  const members = new Map<string, string[]>()
  const own = new Map<string, string>()
  for (const c of p.components)
    for (const pin of schematicPins(c)) {
      const k = pinKey(c.id, pin.pin)
      if (!old.has(k)) continue
      const net = conn.pinNet.get(k) ?? `alone:${k}`
      own.set(k, net)
      ;(members.get(net) ?? members.set(net, []).get(net)!).push(k)
    }
  return new Map([...own].map(([k, net]) => [k, members.get(net)!.sort().join(" ")]))
}

function ok(r: MoveToSheetResult) {
  if ("error" in r) throw new Error(r.error)
  return r
}

const pinAt = (p: Project, id: string, pin: string) => schematicPins(p.components.find((c) => c.id === id)!).find((x) => x.pin === pin)!.pos

/** R1 and R2 side by side, R1.2 wired to R2.1. */
function pair() {
  let p = createProject("t")
  const a = addComponent(p, "resistor", { sch: { x: 0, y: 0, rot: 90 } })
  p = a.project
  const b = addComponent(p, "resistor", { sch: { x: 2, y: 0, rot: 90 } })
  p = b.project
  p = addWire(p, [pinAt(p, a.component.id, "2"), pinAt(p, b.component.id, "1")]).project
  return { p, r1: a.component.id, r2: b.component.id }
}

describe("moving a selection to a new sheet", () => {
  it("cuts a wire between what moves and what stays and joins the two through a pin of the net's own name", () => {
    const { p, r1, r2 } = pair()
    const r = ok(moveToNewSheet(p, "", { components: [r2] }, "Load"))
    expect(r.parts).toBe(1)
    expect(r.symbol.name).toBe("Load")
    expect(r.pins).toEqual(["R1_2"])
    expect(r.project.components.find((c) => c.id === r2)!.inst).toBe(r.path)
    expect(r.project.components.find((c) => c.id === r1)!.inst).toBeUndefined()
    // The wire stayed, so inside the new sheet the pin carries a hierarchical label, and outside the loose end and the new pin a label of the name.
    const inside = r.project.labels.filter((l) => l.sheet === r.symbol.child)
    expect(inside.map((l) => [l.name, l.kind])).toEqual([["R1_2", "hierarchical"]])
    expect(inside[0]).toMatchObject(pinAt(p, r2, "1"))
    const outside = r.project.labels.filter((l) => l.sheet === undefined)
    expect(outside.map((l) => l.name)).toEqual(["R1_2", "R1_2"])
    expect(partition(r.project, p)).toEqual(partition(p))
  })

  it("takes the wires selected with it, and cuts at the far end instead", () => {
    const { p, r2 } = pair()
    const r = ok(moveToNewSheet(p, "", { components: [r2], wires: [p.wires[0].id] }))
    expect(r.project.wires[0].sheet).toBe(r.symbol.child)
    expect(r.symbol.name).toBe("Sheet")
    expect(partition(r.project, p)).toEqual(partition(p))
  })

  it("keeps a name that joined by labels alone: the label that moved becomes the sheet's hierarchical label, and no wire is drawn", () => {
    let { p, r1, r2 } = pair()
    p = { ...p, wires: [] }
    const l1 = addLabel(p, "SDA", pinAt(p, r1, "2"))
    p = l1.project
    const l2 = addLabel(p, "SDA", pinAt(p, r2, "1"))
    p = l2.project
    const r = ok(moveToNewSheet(p, "", { components: [r2] }))
    expect(r.pins).toEqual(["SDA"])
    expect(r.project.labels.find((l) => l.id === l2.label.id)).toMatchObject({ sheet: r.symbol.child, kind: "hierarchical" })
    expect(r.project.labels.filter((l) => l.sheet === r.symbol.child)).toHaveLength(1)
    expect(partition(r.project, p)).toEqual(partition(p))
  })

  it("lets a supply cross by its name: a power symbol on a pin goes with its part, and a shared one is drawn again inside", () => {
    let { p, r1, r2 } = pair()
    p = { ...p, wires: [] }
    // VCC on R1.1 and R2.1 by one wire from R1.1 to the symbol and on to R2.1.
    const vcc = addComponent(p, "power", { sch: { ...pinAt(p, r1, "1"), rot: 0 } })
    p = vcc.project
    const portPin = schematicPins(vcc.component)[0].pos
    const shift = { x: pinAt(p, r1, "1").x - portPin.x, y: pinAt(p, r1, "1").y - portPin.y }
    p = { ...p, components: p.components.map((c) => (c.id === vcc.component.id ? { ...c, sch: { ...c.sch, x: c.sch.x + shift.x, y: c.sch.y + shift.y } } : c)) }
    p = addWire(p, [pinAt(p, r1, "1"), { x: pinAt(p, r1, "1").x, y: pinAt(p, r1, "1").y + 1 }, { x: pinAt(p, r2, "1").x, y: pinAt(p, r1, "1").y + 1 }, pinAt(p, r2, "1")]).project
    const r = ok(moveToNewSheet(p, "", { components: [r2] }))
    expect(r.pins).toEqual([])
    expect(r.globals).toEqual(["VCC"])
    const inside = r.project.components.filter((c) => c.inst === r.path)
    expect(inside.map((c) => c.partId).sort()).toEqual(["power", "resistor"])
    expect(partition(r.project, p)).toEqual(partition(p))
  })

  it("refuses with nothing selected that is a part", () => {
    const { p } = pair()
    expect(moveToNewSheet(p, "", { wires: [p.wires[0].id] })).toEqual({ error: "Select the parts to move to a new sheet first." })
  })

  it("moves a part of a sheet used twice in both uses, and keeps the pin it had to the sheet above", () => {
    const { project } = imp([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }])
    const [, a, b] = sheetUses(project)
    const r9 = sheetView(project, a.path).components.find((c) => c.ref !== undefined && !c.ref.startsWith("#"))!
    const r = ok(moveToNewSheet(project, a.path, { components: [r9.id] }, "Inner"))
    const uses = usesOfSheet(r.project, r.symbol.child)
    expect(uses.map((u) => u.path)).toEqual([`${a.path}/${r.symbol.id}`, `${b.path}/${r.symbol.id}`])
    for (const u of uses) expect(sheetView(r.project, u.path).components.filter((c) => !c.ref.startsWith("#"))).toHaveLength(1)
    expect(r.pins).toEqual(["VIN"])
    expect(partition(r.project, project)).toEqual(partition(project))
  })
})

describe("every block of every example on a sheet of its own", () => {
  for (const ex of EXAMPLES) {
    it(`${ex.name}: each block moves and every connection stays`, () => {
      const before = partition(ex.project)
      for (const block of ex.project.blocks ?? []) {
        const r = ok(moveToNewSheet(ex.project, "", { blocks: [block.id] }))
        expect(r.symbol.name).toBe(block.name)
        expect(partition(r.project, ex.project), block.name).toEqual(before)
      }
    })
  }
})

describe("any selection of parts and wires on the examples", () => {
  // Seeded, so a failure is the same every run.
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (const ex of EXAMPLES) {
    it(`${ex.name}: moves, and then moves again inside a sheet used twice, with every connection kept`, () => {
      const parts = ex.project.components.filter((c) => !findPart(c.partId)?.powerNet)
      const before = partition(ex.project)
      for (let t = 0; t < 12; t++) {
        const pick = [...parts].sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * Math.min(8, parts.length))).map((c) => c.id)
        const wires = t % 2 ? ex.project.wires.filter(() => rnd() < 0.3).map((w) => w.id) : []
        const r = ok(moveToNewSheet(ex.project, "", { components: pick, wires }))
        expect(partition(r.project, ex.project)).toEqual(before)
        // The new sheet used again, and part of it moved once more from one of its uses: both uses move.
        const again = addSheetUse(r.project, "", r.symbol.child, { minX: 40, minY: 40, maxX: 42, maxY: 41.2 })!.project
        const inner = sheetView(again, r.path).components.filter((c) => !findPart(c.partId)?.powerNet)
        const deeper = ok(moveToNewSheet(again, r.path, { components: inner.slice(0, 1 + (t % Math.max(1, inner.length))).map((c) => c.id) }))
        expect(partition(deeper.project, again)).toEqual(partition(again))
        expect(usesOfSheet(deeper.project, deeper.symbol.child)).toHaveLength(2)
      }
    })
  }
})
