import { describe, expect, it } from "vitest"
import {
  addToBlock,
  BLOCK_PADDING,
  BLOCK_TITLE,
  blockFrames,
  blockOf,
  contentsOf,
  createBlock,
  deleteBlocks,
  framesDuringDrag,
  groupSelection,
  removeFromBlocks,
  renameBlock,
  ungroupSelection,
} from "../src/model/blocks"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { schematicBounds } from "../src/model/instances"
import { labelBox } from "../src/model/labels"
import { addComponent, addWire, createProject, findRubberBands, freeSchematicSpot, labelPin, moveSchematicItems, removeItems } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"

const onGrid = (n: number) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-6

/** How far a resistor's designator and value reach past its symbol: 0.05 to the text, then its height. */
const TEXT_REACH = 0.13 - 0.08 + 0.1

/** A project with the given parts, each at its own spot, and their ids by designator. */
function parts(...placed: [partId: string, x: number, y: number][]) {
  let p = createProject("t")
  const id: Record<string, string> = {}
  for (const [partId, x, y] of placed) {
    const res = addComponent(p, partId, { sch: { x, y } })
    p = res.project
    id[res.component.ref] = res.component.id
  }
  return { p, id }
}

const refsOf = (p: Project, ids: string[]) => ids.map((id) => p.components.find((c) => c.id === id)?.ref)

describe("block operations", () => {
  it("makes a block of parts, each in one block at most, and drops a block left empty", () => {
    const { p: start, id } = parts(["resistor", 0, 0], ["resistor", 2, 0], ["led", 4, 0])
    const a = createBlock(start, "Power", [id.R1, id.R2, "gone"])
    expect(a.block).toMatchObject({ name: "Power", components: [id.R1, id.R2] })

    // Grouping a part again moves it.
    const b = createBlock(a.project, "LED", [id.R2, id.D1])
    expect(blockOf(b.project, id.R2)?.name).toBe("LED")
    expect(b.project.blocks?.map((x) => [x.name, refsOf(b.project, x.components)])).toEqual([
      ["Power", ["R1"]],
      ["LED", ["R2", "D1"]],
    ])

    // Taking the last part out of a block removes it.
    const c = createBlock(b.project, "power", [id.R1])
    expect(c.block?.name).toBe("power 2")
    expect(c.project.blocks?.map((x) => x.name)).toEqual(["LED", "power 2"])
    expect(createBlock(start, "Empty", ["gone"]).block).toBeNull()
  })

  it("adds and removes members, renames and deletes, leaving the parts where they are", () => {
    const { p: start, id } = parts(["resistor", 0, 0], ["resistor", 2, 0], ["led", 4, 0])
    const { project: one, block } = createBlock(start, "MCU", [id.R1])
    const other = createBlock(one, "LED", [id.D1]).project
    let p = addToBlock(other, block!.id, [id.R2, id.D1])
    expect(refsOf(p, blockOf(p, id.R1)!.components)).toEqual(["R1", "R2", "D1"])
    expect(p.blocks).toHaveLength(1)

    expect(renameBlock(p, block!.id, "   ")).toBe(p)
    p = renameBlock(p, block!.id, "  3.3V   POWER ")
    expect(p.blocks?.[0].name).toBe("3.3V POWER")

    p = removeFromBlocks(p, [id.R2])
    expect(refsOf(p, p.blocks![0].components)).toEqual(["R1", "D1"])
    p = deleteBlocks(p, [block!.id])
    expect(p.blocks).toBeUndefined()
    expect(p.components.map((c) => c.sch)).toEqual(start.components.map((c) => c.sch))
  })

  it("groups a selection into its first block or a new one, and ungroups it", () => {
    const { p: start, id } = parts(["resistor", 0, 0], ["resistor", 2, 0], ["led", 4, 0])
    const fresh = groupSelection(start, [id.R1, id.R2], [])
    expect(fresh.project.blocks?.[0]).toMatchObject({ id: fresh.blockId, name: "BLOCK 1" })

    const led = createBlock(fresh.project, "LED", [id.D1]).project
    const merged = groupSelection(led, [], [led.blocks![1].id, fresh.blockId!])
    expect(merged.blockId).toBe(led.blocks![1].id)
    expect(merged.project.blocks?.map((b) => [b.name, refsOf(merged.project, b.components)])).toEqual([["LED", ["D1", "R1", "R2"]]])

    const out = ungroupSelection(merged.project, [id.R1], [])
    expect(refsOf(out, out.blocks![0].components)).toEqual(["D1", "R2"])
    expect(ungroupSelection(out, [], [out.blocks![0].id]).blocks).toBeUndefined()
  })

  it("drops deleted parts from their block, and deletes blocks without their parts", () => {
    const { p: start, id } = parts(["resistor", 0, 0], ["resistor", 2, 0], ["led", 4, 0])
    let p = createBlock(start, "A", [id.R1, id.R2]).project
    p = createBlock(p, "B", [id.D1]).project
    p = removeItems(p, { components: [id.R1, id.D1] })
    expect(p.blocks?.map((b) => [b.name, refsOf(p, b.components)])).toEqual([["A", ["R2"]]])
    p = removeItems(p, { blocks: [p.blocks![0].id] })
    expect(p.blocks).toBeUndefined()
    expect(p.components).toHaveLength(1)
    // A project that never had blocks doesn't grow the field.
    expect(removeItems(start, { components: [id.R1] })).not.toHaveProperty("blocks")
  })
})

describe("block frames", () => {
  it("frame the parts with their designators and values, padded, with room for the title, on the grid", () => {
    const { p: start, id } = parts(["resistor", 0, 0], ["resistor", 0, -1])
    const p = createBlock(start, "PULL-UPS", [id.R1, id.R2]).project
    const [frame] = blockFrames(p)
    const { box } = frame
    for (const n of [box.minX, box.minY, box.maxX, box.maxY]) expect(onGrid(n), String(n)).toBe(true)

    const r1 = schematicBounds(p.components[0])
    const r2 = schematicBounds(p.components[1])
    expect(box.minX).toBeLessThanOrEqual(r1.minX - BLOCK_PADDING)
    // R2's value sits under its symbol, so the frame goes below that too.
    expect(box.minY).toBeLessThanOrEqual(r2.minY - TEXT_REACH - BLOCK_PADDING)
    // R1's designator sits above it, and the title above that.
    expect(box.maxY).toBeGreaterThanOrEqual(r1.maxY + TEXT_REACH + BLOCK_TITLE)
    expect(frame.title.x).toBeGreaterThan(box.minX)
    expect(frame.title.y).toBeLessThan(box.maxY)
    // Wide enough for its title.
    expect(box.maxX - box.minX).toBeGreaterThan("PULL-UPS".length * BLOCK_TITLE * 0.5)
    expect(frame.titleBox.minX).toBe(box.minX)
    expect(frame.titleBox.maxY).toBe(box.maxY)
  })

  it("take in the wires, labels and ports drawn for its parts alone, and nothing that reaches another part", () => {
    let { p, id } = parts(["resistor", 0, 0], ["capacitor", 0, -2], ["led", 5, 0], ["led", -3, -2], ["ground", 0.3, -3], ["ground", -1, -3])
    p = labelPin(p, { componentId: id.R1, pin: "1" }, "VIN")
    const toD1 = addWire(p, [{ x: 0.3, y: 0 }, { x: 4.7, y: 0 }])
    p = addWire(toD1.project, [{ x: 0.3, y: -2 }, { x: 0.3, y: -2.7 }]).project
    // A ground port shared with a part outside the block stays outside it.
    p = addWire(p, [{ x: -0.3, y: -2 }, { x: -1, y: -2 }, { x: -1, y: -2.7 }]).project
    p = addWire(p, [{ x: -2.7, y: -2 }, { x: -2.7, y: -2.7 }, { x: -1, y: -2.7 }]).project
    p = createBlock(p, "INPUT", [id.R1, id.C1]).project

    const [frame] = blockFrames(p)
    expect(refsOf(p, frame.contents.components).sort()).toEqual(["#GND1", "C1", "R1"])
    expect(frame.contents.labels).toEqual([p.labels[0].id])
    expect(frame.contents.wires).toEqual([p.wires[0].id, p.wires[2].id])
    expect(frame.box.minX).toBeLessThanOrEqual(labelBox(p.labels[0]).minX - BLOCK_PADDING)
    expect(frame.box.maxX).toBeLessThan(4.7)
    expect(contentsOf(p, [frame.id])).toEqual(frame.contents)
  })

  it("follow their parts when the block is dragged, stretching the wires that leave it", () => {
    let { p, id } = parts(["resistor", 0, 0], ["led", 5, 0], ["ground", -0.3, -1.5])
    p = addWire(p, [{ x: 0.3, y: 0 }, { x: 4.7, y: 0 }]).project
    p = addWire(p, [{ x: -0.3, y: 0 }, { x: -0.3, y: -1.2 }]).project
    p = createBlock(p, "R", [id.R1]).project
    const before = blockFrames(p)[0]
    const held = contentsOf(p, [before.id])
    expect(refsOf(p, held.components)).toEqual(["R1", "#GND1"])
    const moved = moveSchematicItems(p, held, { x: -1, y: 1 }, findRubberBands(p, held.components, held.labels, held.wires))

    const after = blockFrames(moved)[0].box
    const shifted = { minX: before.box.minX - 1, minY: before.box.minY + 1, maxX: before.box.maxX - 1, maxY: before.box.maxY + 1 }
    for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(after[k]).toBeCloseTo(shifted[k], 6)
    const net = (q: Project, ref: string, pin: string) => computeConnectivity(q).pinNet.get(pinKey(id[ref], pin))
    expect(net(moved, "D1", "1")).toBe(net(moved, "R1", "2"))
    expect(net(moved, "#GND1", "1")).toBe(net(moved, "R1", "1"))
  })

  it("move whole with a drag without being worked out again, and stand still for a part dragged out", () => {
    let { p, id } = parts(["resistor", 0, 0], ["led", 2, 0], ["resistor", 6, 0])
    p = createBlock(p, "LED", [id.R1, id.D1]).project
    p = createBlock(p, "R2", [id.R2]).project
    const [led, r2] = blockFrames(p)
    const during = framesDuringDrag(p, [id.R1, id.D1], { x: 1, y: -0.5 })
    expect(during[0].box).toEqual({ minX: led.box.minX + 1, minY: led.box.minY - 0.5, maxX: led.box.maxX + 1, maxY: led.box.maxY - 0.5 })
    expect(during[0].title).toEqual({ x: led.title.x + 1, y: led.title.y - 0.5 })
    expect(during[1]).toBe(r2)
    // Only some of a block's parts moving: its frame waits for the drop.
    expect(framesDuringDrag(p, [id.R1], { x: 1, y: 0 })[0]).toBe(led)
  })

  it("leave room for themselves when a part is placed without a position", () => {
    const { p: start, id } = parts(["resistor", 0, 0])
    const p = createBlock(start, "A LONG BLOCK TITLE", [id.R1]).project
    expect(freeSchematicSpot(p).x).toBeGreaterThan(blockFrames(p)[0].box.maxX)
  })
})

describe("blocks in the project file", () => {
  const origin = { id: "p1", createdAt: 1, updatedAt: 2 }

  it("read back as they were written", () => {
    const { p: start, id } = parts(["resistor", 0, 0], ["led", 2, 0])
    const p = createBlock(start, "LED", [id.R1, id.D1]).project
    const read = parseProjectFile(serializeProject(p), origin)
    expect(read.blocks).toEqual(p.blocks)
    expect(serializeProject(read)).toBe(serializeProject(p))
  })

  it("lose members that are gone, a second claim on a part, and blocks left with nothing", () => {
    const { p, id } = parts(["resistor", 0, 0], ["led", 2, 0])
    const file = JSON.parse(serializeProject(p))
    file.project.blocks = [
      { id: "b1", name: " MCU ", components: [id.R1, "gone", id.R1] },
      { id: "b2", name: "LED", components: [id.R1, id.D1] },
      { id: "b3", name: "EMPTY", components: ["gone"] },
      { id: "b4", name: "", components: [id.D1] },
      { id: "b1", name: "AGAIN", components: [id.D1] },
      { name: "NO ID", components: [id.D1] },
      "nonsense",
    ]
    expect(parseProjectFile(file, origin).blocks).toEqual([
      { id: "b1", name: "MCU", components: [id.R1] },
      { id: "b2", name: "LED", components: [id.D1] },
    ])
    file.project.blocks = "nonsense"
    expect(parseProjectFile(file, origin).blocks).toBeUndefined()
  })

  it("read names as the editor writes them: spaces collapsed, unique whatever their case", () => {
    const { p, id } = parts(["resistor", 0, 0], ["led", 2, 0], ["resistor", 4, 0])
    const file = JSON.parse(serializeProject(p))
    file.project.blocks = [
      { id: "b1", name: "  USB   IN ", components: [id.R1] },
      { id: "b2", name: "usb in", components: [id.D1] },
      { id: "b3", name: "USB IN", components: [id.R2] },
    ]
    expect(parseProjectFile(file, origin).blocks!.map((b) => b.name)).toEqual(["USB IN", "usb in 2", "USB IN 3"])
  })
})
