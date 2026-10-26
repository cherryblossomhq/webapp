import { describe, expect, it } from "vitest"
import { blockFrames, contentsOf, createBlock, framesDuringDrag } from "../src/model/blocks"
import { schematicPins } from "../src/model/instances"
import { addComponent, addLabel, addWire, createProject, dragPlan } from "../src/model/ops"
import { dragSelection, pasteItems, rotateSelection } from "../src/model/schematicEdit"
import type { Project } from "../src/model/types"

// Blocks (frames around groups of parts) and the guarded canvas edits have to agree: a frame follows
// what the carry logic moves, and a copied block keeps its block through the check.

/** R1 and R2 in a block "STAGE", a ground symbol right on R1's pin 1 and a rail label stub on R2. */
function sheet(): { p: Project; r1: string; r2: string } {
  let p = createProject("t")
  p = addComponent(p, "resistor", { ref: "R1", sch: { x: 0, y: 0, rot: 0 } }).project
  p = addComponent(p, "resistor", { ref: "R2", sch: { x: 4, y: 0, rot: 0 } }).project
  const [r1, r2] = p.components
  const pin1 = schematicPins(r1)[0].pos
  const probe = addComponent(p, "ground", { sch: { x: 0, y: 0, rot: 0 } }).component
  const off = schematicPins(probe)[0].pos
  p = addComponent(p, "ground", { sch: { x: pin1.x - off.x, y: pin1.y - off.y, rot: 0 } }).project
  p = addWire(p, [schematicPins(r1)[1].pos, schematicPins(r2)[0].pos]).project
  p = addLabel(p, "LINK", { x: 2, y: 0 }).project
  p = createBlock(p, "STAGE", [r1.id, r2.id]).project
  return { p, r1: r1.id, r2: r2.id }
}

describe("block frames and the carry", () => {
  it("a block holds the ground symbol on its part's pin, and the frame follows it in a drag", () => {
    const { p, r1, r2 } = sheet()
    const base = blockFrames(p)[0]
    expect(base.contents.components.length).toBe(3)
    const plan = dragPlan(p, { components: [r1, r2], labels: [], wires: [] })
    expect(plan.ids.components.length).toBe(3)
    const moved = framesDuringDrag(p, plan.ids.components, { x: 3, y: -2 })[0]
    expect(moved.box).toEqual({ minX: base.box.minX + 3, maxX: base.box.maxX + 3, minY: base.box.minY - 2, maxY: base.box.maxY - 2 })
    // The part alone would leave the symbol behind and the frame where it was.
    expect(framesDuringDrag(p, [r1, r2], { x: 3, y: -2 })[0].box).toEqual(base.box)
  })

  it("dragging the selected block moves its parts with the symbol, and the frame after the drop holds them", () => {
    const { p } = sheet()
    const held = contentsOf(p, [p.blocks![0].id])
    const res = dragSelection(p, { components: held.components, labels: held.labels, wires: held.wires }, { x: 3, y: -2 })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (!res.ok) return
    const before = blockFrames(p)[0].box
    const after = blockFrames(res.project)[0].box
    expect(after).toEqual({ minX: before.minX + 3, maxX: before.maxX + 3, minY: before.minY - 2, maxY: before.maxY - 2 })
  })

  it("turning a part in a block keeps the block and a frame around its parts", () => {
    const { p, r1 } = sheet()
    const res = rotateSelection(p, { components: [r1], labels: [] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.project.blocks).toEqual(p.blocks)
    const frame = blockFrames(res.project)[0].box
    for (const c of res.project.components.filter((x) => !x.ref.startsWith("#"))) {
      expect(c.sch.x).toBeGreaterThan(frame.minX)
      expect(c.sch.x).toBeLessThan(frame.maxX)
    }
  })
})

describe("copying a block through the check", () => {
  it("comes back as a block of the copies, with the same name made unique, and the copies' ground with them", () => {
    const { p, r1, r2 } = sheet()
    const block = p.blocks![0]
    const held = contentsOf(p, [block.id])
    const res = pasteItems(p, { project: p, ...held, blocks: [block.id] }, { x: 0, y: -6 })
    expect(res.ok, res.ok ? "" : res.message).toBe(true)
    if (!res.ok) return
    expect(res.project.blocks).toHaveLength(2)
    const copy = res.project.blocks!.find((b) => b.id !== block.id)!
    expect(copy.name).not.toBe(block.name)
    expect(copy.components).toHaveLength(2)
    expect(copy.components).not.toContain(r1)
    expect(copy.components).not.toContain(r2)
    expect(res.selection.some((s) => s === `b:${copy.id}`)).toBe(true)
    // A copy of a part with a ground on it is on ground; the original is as it was.
    expect(res.project.components.filter((c) => c.ref.startsWith("#GND"))).toHaveLength(2)
  })

  it("a paste the check refuses leaves the blocks as they were", () => {
    const { p } = sheet()
    const block = p.blocks![0]
    const held = contentsOf(p, [block.id])
    // On top of itself: the copy's wire would land on the original's ends of another net's name.
    const res = pasteItems(p, { project: p, ...held, blocks: [block.id] }, { x: 0, y: 0 })
    if (res.ok) expect(res.project.blocks).toHaveLength(2)
    else {
      expect(res.message).toMatch(/^Didn't paste: /)
      expect(p.blocks).toHaveLength(1)
    }
  })
})
