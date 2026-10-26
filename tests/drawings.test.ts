import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { describeSchematic, measureSchematic } from "../src/ai/vision/measure"
import { frame } from "../src/ai/vision/framing"
import { schematicSvg } from "../src/ai/vision/schematicSvg"
import { paintDrawing } from "../src/editor/schematic/drawingPaint"
import { SCH_DARK, SCH_LIGHT } from "../src/editor/theme"
import { blockFrames, contentsOf, createBlock } from "../src/model/blocks"
import { computeConnectivity } from "../src/model/connectivity"
import { pasteItems } from "../src/model/schematicEdit"
import { tidySchematic } from "../src/model/tidy"
import {
  addDrawings,
  constrain45,
  dragHandle,
  drawingBounds,
  drawingHandles,
  hitDrawing,
  reorderDrawings,
  rotateDrawing,
  textBox,
  textFrame,
  updateDrawings,
} from "../src/model/drawings"
import { addComponent, createProject, moveSchematicItems, removeItems } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { DrawingBox, DrawingLine, DrawingText, Project, SchematicDrawing } from "../src/model/types"

const origin = { id: "p_test", createdAt: 1, updatedAt: 2 }

const step = (p: Project, name: string, input: Record<string, unknown>) => {
  const out = runTool(p, name, input)
  expect(out.isError, out.result).toBe(false)
  return out
}

function withDrawings(...items: Parameters<typeof addDrawings>[1]) {
  const { project, added } = addDrawings(createProject("d"), items)
  return { p: project, d: added }
}

const rect = (x: number, y: number, width: number, height: number, extra: Partial<DrawingBox> = {}) => ({ type: "rect" as const, x, y, width, height, ...extra })
const text = (t: string, x: number, y: number, extra: Partial<DrawingText> = {}) => ({ type: "text" as const, text: t, x, y, size: 0.2, ...extra })

describe("drawings in the model", () => {
  it("are stored without their defaults and with clean numbers", () => {
    const { d } = withDrawings(
      rect(0.30000000004, 0, 2, 1, { color: "ink", weight: "medium", dash: "solid", radius: 0 }),
      { type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false, arrows: "end", color: "blue" },
      text("NOTE", 0, 0, { align: "left", rot: 0, bold: false, border: true }),
    )
    expect(d[0]).toEqual({ id: d[0].id, type: "rect", x: 0.3, y: 0, width: 2, height: 1 })
    expect(d[1]).toEqual({ id: d[1].id, type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], arrows: "end", color: "blue" })
    expect(d[2]).toEqual({ id: d[2].id, type: "text", text: "NOTE", x: 0, y: 0, size: 0.2, border: true })
    // A polygon has no arrowheads.
    const poly = withDrawings({ type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], closed: true, arrows: "both" }).d[0]
    expect(poly).not.toHaveProperty("arrows")
  })

  it("puts a text's lines below its anchor, by its alignment, and turns them to read upwards", () => {
    const left = text("AB\nABCD", 1, 2) as DrawingText
    const b = textBox(left)
    expect(b.minX).toBe(1)
    expect(b.maxY).toBe(2)
    expect(b.minY).toBeLessThan(2 - 0.2 * 1.3)
    const center = textBox({ ...left, align: "center" })
    expect((center.minX + center.maxX) / 2).toBeCloseTo(1)
    const right = textBox({ ...left, align: "right" })
    expect(right.maxX).toBeCloseTo(1)
    // Turned, it runs up from the anchor with its lines stacked to the right.
    const up = textBox({ ...left, rot: 90 })
    expect(up.minX).toBeCloseTo(1)
    expect(up.minY).toBeCloseTo(2)
    expect(up.maxY - up.minY).toBeCloseTo(b.maxX - b.minX)
    // A border or a tint takes room around the lines.
    expect(textFrame({ ...left, border: true }).minX).toBeLessThan(b.minX)
    expect(textFrame(left)).toEqual(b)
  })

  it("is picked up by its stroke, inside only when filled, and a text anywhere on it", () => {
    const tol = 0.05
    const box = { id: "r", ...rect(0, 0, 2, 1) } as SchematicDrawing
    expect(hitDrawing(box, { x: 0, y: 0.5 }, tol)).toBe(true)
    expect(hitDrawing(box, { x: 1, y: 0.5 }, tol)).toBe(false)
    expect(hitDrawing({ ...box, fill: "blue" }, { x: 1, y: 0.5 }, tol)).toBe(true)
    const line = { id: "l", type: "line", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }] } as SchematicDrawing
    expect(hitDrawing(line, { x: 1, y: 0.03 }, tol)).toBe(true)
    expect(hitDrawing(line, { x: 1, y: 1 }, tol)).toBe(false)
    // Closed and filled, the inside of the triangle counts; open, the missing side doesn't.
    expect(hitDrawing({ ...line, closed: true } as SchematicDrawing, { x: 1, y: 1 }, tol)).toBe(true)
    expect(hitDrawing({ ...line, closed: true, fill: "red" } as SchematicDrawing, { x: 1.5, y: 0.5 }, tol)).toBe(true)
    const note = { id: "t", ...text("Hello", 0, 0) } as SchematicDrawing
    expect(hitDrawing(note, { x: 0.2, y: -0.1 }, tol)).toBe(true)
  })

  it("turns a quarter about its middle and stays on the grid", () => {
    const box = { id: "r", ...rect(0, 0, 2, 1) } as DrawingBox
    const turned = rotateDrawing(box) as DrawingBox
    expect(turned).toMatchObject({ width: 1, height: 2 })
    expect(drawingBounds(turned)).toEqual({ minX: 0.5, minY: -0.5, maxX: 1.5, maxY: 1.5 })
    const line = { id: "l", type: "line", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] } as DrawingLine
    expect((rotateDrawing(line) as DrawingLine).points).toEqual([{ x: 1, y: -1 }, { x: 1, y: 1 }])
    const t = { id: "t", ...text("A", 0, 0) } as DrawingText
    expect(rotateDrawing(t)).toMatchObject({ rot: 90 })
    expect(rotateDrawing(rotateDrawing(t))).not.toHaveProperty("rot")
  })

  it("resizes a box by its handles, never thinner than half a grid square, and moves a line's corners", () => {
    const box = { id: "r", ...rect(0, 0, 2, 1) } as DrawingBox
    const handles = drawingHandles(box)
    expect(handles).toHaveLength(8)
    expect(dragHandle(box, 4, { x: 3, y: 2 })).toMatchObject({ x: 0, y: 0, width: 3, height: 2 })
    expect(dragHandle(box, 0, { x: -1, y: -1 })).toMatchObject({ x: -1, y: -1, width: 3, height: 2 })
    // The bottom side's middle moves only the bottom.
    expect(dragHandle(box, 1, { x: 9, y: 0.5 })).toMatchObject({ x: 0, y: 0.5, width: 2, height: 0.5 })
    expect(dragHandle(box, 3, { x: -5, y: 0 })).toMatchObject({ x: 0, width: 0.05 })
    const line = { id: "l", type: "line", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] } as DrawingLine
    expect((dragHandle(line, 1, { x: 2, y: 1 }) as DrawingLine).points).toEqual([{ x: 0, y: 0 }, { x: 2, y: 1 }])
    expect(drawingHandles({ id: "t", ...text("A", 0, 0) } as DrawingText)).toEqual([])
  })

  it("draws lines at 45° steps with Shift, ending on the grid", () => {
    expect(constrain45({ x: 0, y: 0 }, { x: 1.3, y: 0.2 })).toEqual({ x: 1.3, y: 0 })
    expect(constrain45({ x: 0, y: 0 }, { x: 0.1, y: -0.9 })).toEqual({ x: 0, y: -0.9 })
    expect(constrain45({ x: 0, y: 0 }, { x: 1, y: 1.2 })).toEqual({ x: 1.1, y: 1.1 })
    expect(constrain45({ x: 0, y: 0 }, { x: -0.9, y: 1 })).toEqual({ x: -1, y: 1 })
    expect(constrain45({ x: 1, y: 1 }, { x: 0, y: 0.1 })).toEqual({ x: 0, y: 0 })
  })

  it("is ordered, moved, edited and deleted by id", () => {
    const { p, d } = withDrawings(rect(0, 0, 1, 1), rect(2, 0, 1, 1), text("A", 0, 3))
    const ids = (q: Project) => q.drawings!.map((x) => x.id)
    expect(ids(reorderDrawings(p, [d[0].id], "front"))).toEqual([d[1].id, d[2].id, d[0].id])
    expect(ids(reorderDrawings(p, [d[2].id], "back"))).toEqual([d[2].id, d[0].id, d[1].id])
    expect(reorderDrawings(p, [d[2].id], "front")).toBe(p)
    const moved = moveSchematicItems(p, { components: [], labels: [], wires: [], drawings: [d[1].id] }, { x: 1, y: -1 }, [])
    expect(moved.drawings![1]).toMatchObject({ x: 3, y: -1 })
    expect(moved.drawings![0]).toBe(p.drawings![0])
    expect(updateDrawings(p, [d[0].id], (x) => x)).toBe(p)
    expect(updateDrawings(p, [d[0].id], (x) => ({ ...x, color: "red" })).drawings![0]).toMatchObject({ color: "red" })
    const gone = removeItems(p, { drawings: [d[0].id, d[1].id, d[2].id] })
    expect(gone.drawings).toBeUndefined()
  })

  it("never connects anything, even a line drawn from pin to pin", () => {
    let p = addComponent(createProject("d"), "resistor", { sch: { x: 0, y: 0 } }).project
    p = addComponent(p, "resistor", { sch: { x: 2, y: 0 } }).project
    const before = computeConnectivity(p)
    p = addDrawings(p, [{ type: "line", points: [{ x: 0.3, y: 0 }, { x: 1.7, y: 0 }] }]).project
    const after = computeConnectivity(p)
    expect(after.nets.map((n) => n.pins.length)).toEqual(before.nets.map((n) => n.pins.length))
    expect(after.unconnectedPins).toHaveLength(before.unconnectedPins.length)
  })

  it("inside a block's frame moves with the block", () => {
    let p = addComponent(createProject("d"), "resistor", { sch: { x: 0, y: 0 } }).project
    p = addComponent(p, "resistor", { sch: { x: 3, y: 0 } }).project
    const made = createBlock(p, "POWER", [p.components[0].id, p.components[1].id])
    p = made.project
    const box = blockFrames(p)[0].box
    const res = addDrawings(p, [
      text("in", box.minX + 0.2, box.minY + 0.4, { size: 0.1 }),
      text("out", box.maxX + 2, 0),
      // Its middle inside, its bottom out of the frame: it is the block's note all the same.
      text("poking out", box.minX + 0.2, box.minY + 0.1, { size: 0.1, border: true }),
      // Around the block and more: a box drawn round the sheet, not the block's.
      rect(box.minX - 1, box.minY - 1, box.maxX - box.minX + 2, box.maxY - box.minY + 2),
    ])
    p = res.project
    expect(contentsOf(p, [made.block!.id]).drawings).toEqual([res.added[0].id, res.added[2].id])
  })
})

describe("drawings in the project file", () => {
  it("survive a save and a load, unknown fields included", () => {
    const { p } = withDrawings(rect(0, 0, 2, 1, { fill: "yellow", dash: "dashed" }), text("A\nB", 1, 1, { bold: true, rot: 90 }))
    const withExtra = { ...p, drawings: [...p.drawings!, { id: "d_x", type: "rect", x: 0, y: 0, width: 1, height: 2, comment: "kept" } as unknown as SchematicDrawing] }
    const back = parseProjectFile(serializeProject(withExtra), origin)
    expect(back.drawings).toEqual(withExtra.drawings)
  })

  it("drop what can't be drawn and read styles they don't know as the default", () => {
    const raw = {
      format: "cherryblossom.project",
      version: 2,
      project: {
        name: "d",
        components: [],
        drawings: [
          { id: "a", type: "line", points: [{ x: 0, y: 0 }] },
          { id: "b", type: "rect", x: 0, y: 0, width: 0, height: 1 },
          { id: "c", type: "text", text: "   ", x: 0, y: 0, size: 0.1 },
          { id: "d", type: "star", x: 0, y: 0 },
          "nonsense",
          { id: "e", type: "rect", x: 0, y: 0, width: 1, height: 1, color: "chartreuse", weight: "heavy", fill: "red" },
          { id: "e", type: "rect", x: 5, y: 5, width: 1, height: 1 },
          { id: "f", type: "text", text: "T", x: 0, y: 0, size: -3, align: "justify", bold: "yes", rot: 45 },
        ],
      },
    }
    const p = parseProjectFile(JSON.stringify(raw), origin)
    expect(p.drawings).toEqual([
      { id: "e", type: "rect", x: 0, y: 0, width: 1, height: 1, fill: "red" },
      { id: "f", type: "text", text: "T", x: 0, y: 0, size: 0.14 },
    ])
    const empty = parseProjectFile(JSON.stringify({ ...raw, project: { name: "d", drawings: [] } }), origin)
    expect(empty.drawings).toBeUndefined()
  })
})

describe("copying drawings", () => {
  it("pastes them at the offset with ids of their own", () => {
    const { p, d } = withDrawings(rect(0, 0, 1, 1), { type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], arrows: "end" })
    const res = pasteItems(p, { project: p, components: [], wires: [], labels: [], drawings: d.map((x) => x.id), blocks: [] }, { x: 2, y: -1 })
    if (!res.ok) throw new Error(res.message)
    const copies = res.project.drawings!.slice(2)
    expect(copies).toHaveLength(2)
    expect(copies[0]).toMatchObject({ type: "rect", x: 2, y: -1 })
    expect(copies[1]).toMatchObject({ points: [{ x: 2, y: -1 }, { x: 3, y: -1 }], arrows: "end" })
    expect(res.selection).toEqual(copies.map((c) => `d:${c.id}`))
    expect(new Set(res.project.drawings!.map((x) => x.id)).size).toBe(4)
  })
})

describe("painting drawings", () => {
  it("draws each shape in the sheet's shade of its colour, with a soft fill", () => {
    const box = { id: "r", ...rect(0, 0, 2, 1, { color: "blue", fill: "blue", dash: "dashed", radius: 0.06 }) } as SchematicDrawing
    const [light] = paintDrawing(box, SCH_LIGHT, 0.01)
    expect(light).toMatchObject({ tag: "rect", attrs: { stroke: SCH_LIGHT.drawing.blue, fill: SCH_LIGHT.drawing.blue, fillOpacity: SCH_LIGHT.tint, rx: 0.06 } })
    expect(light.attrs.strokeDasharray).toBeTruthy()
    expect(paintDrawing(box, SCH_DARK, 0.01)[0].attrs.stroke).toBe(SCH_DARK.drawing.blue)
  })

  it("puts arrowheads on an open line, a line per text line, and a frame behind a bordered note", () => {
    const arrow = { id: "l", type: "line", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], arrows: "both" } as SchematicDrawing
    const nodes = paintDrawing(arrow, SCH_LIGHT, 0.01)
    expect(nodes.map((n) => n.tag)).toEqual(["polyline", "polygon", "polygon"])
    // The line stops under its heads rather than poking out of their tips.
    const ends = String(nodes[0].attrs.points).split(" ").map((pt) => Number(pt.split(",")[0]))
    expect(ends[0]).toBeGreaterThan(0)
    expect(ends[1]).toBeLessThan(2)
    const note = { id: "t", ...text("ONE\n\nTHREE", 0, 0, { border: true }) } as SchematicDrawing
    const painted = paintDrawing(note, SCH_LIGHT, 0.01)
    expect(painted.map((n) => n.tag)).toEqual(["rect", "text", "text"])
    expect(painted.filter((n) => n.tag === "text").map((n) => n.text)).toEqual(["ONE", "THREE"])
  })
})

describe("Sakura's drawing tools", () => {
  function sheet() {
    let p = createProject("t")
    p = step(p, "add_component", { part_id: "resistor", x: 0, y: 0 }).project
    p = step(p, "add_component", { part_id: "led", x: 3, y: 0 }).project
    p = step(p, "add_component", { part_id: "capacitor", x: 8, y: 0 }).project
    p = step(p, "group_parts", { block: "LED", refs: ["R1", "D1"] }).project
    return p
  }
  const design = (p: Project) => JSON.parse(runTool(p, "get_design", {}).result) as { drawings?: Record<string, unknown>[] }

  it("draws a title, an arrow and boxes around parts and blocks in one call, and lists them in get_design", () => {
    const p = sheet()
    const out = step(p, "draw", {
      shapes: [
        { type: "text", text: "LED DRIVER", x: -1, y: 3, size: "title", bold: true },
        { type: "line", points: [{ x: 6, y: 1.04 }, { x: 8, y: 0.5 }], arrows: "end", color: "red" },
        { type: "rect", around: ["C1"], dash: "dashed", corners: "small" },
        { type: "rect", around: ["LED"], padding: 0 },
      ],
    })
    expect(out.summary).toBe("Drew 4 drawings (text, arrow, rectangle)")
    const [title, arrow, box, ring] = out.project.drawings!
    expect(title).toMatchObject({ type: "text", text: "LED DRIVER", size: 0.5, bold: true, x: -1, y: 3 })
    // On the grid, as the user's tools put them.
    expect((arrow as DrawingLine).points).toEqual([{ x: 6, y: 1 }, { x: 8, y: 0.5 }])
    expect(box).toMatchObject({ type: "rect", dash: "dashed", radius: 0.06 })
    const c1 = out.project.components.find((c) => c.ref === "C1")!
    expect(drawingBounds(box).minX).toBeLessThan(c1.sch.x)
    expect(drawingBounds(box).maxX).toBeGreaterThan(c1.sch.x)
    expect(drawingBounds(ring)).toEqual(blockFrames(out.project)[0].box)
    for (const d of out.project.drawings!) expect(out.result).toContain(d.id)

    const listed = design(out.project).drawings!
    expect(listed.map((d) => d.type)).toEqual(["text", "line", "rect", "rect"])
    expect(listed[0]).toMatchObject({ id: title.id, text: "LED DRIVER", size: "title", bold: true })
    expect(listed[2]).toMatchObject({ corners: "small", dash: "dashed" })
    expect(design(p).drawings).toBeUndefined()
  })

  it("draws nothing when any shape is wrong, and says which", () => {
    const p = sheet()
    const out = runTool(p, "draw", { shapes: [{ type: "text", text: "OK", x: 0, y: 0 }, { type: "rect", around: ["U9"] }, { type: "line" }] })
    expect(out.isError).toBe(true)
    expect(out.project).toBe(p)
    expect(out.result).toContain("shapes[1]: No part or block U9")
    expect(out.result).toContain("shapes[2]: a line needs at least two points")
  })

  it("edits, moves, turns, reorders and deletes drawings by id", () => {
    let p = step(sheet(), "draw", { shapes: [{ type: "text", text: "note", x: 0, y: -2 }, { type: "rect", x: 0, y: 0, width: 2, height: 1 }] }).project
    const [note, box] = p.drawings!
    p = step(p, "edit_drawings", { ids: [note.id], text: "Fit R1 for 5 mA", size: "small", border: true, fill: "yellow", color: "gray" }).project
    expect(p.drawings![0]).toMatchObject({ text: "Fit R1 for 5 mA", size: 0.1, border: true, fill: "yellow", color: "gray" })
    p = step(p, "edit_drawings", { ids: [note.id, box.id], move_by: { x: 1, y: 1 }, fill: "none" }).project
    expect(p.drawings![0]).toMatchObject({ x: 1, y: -1 })
    expect(p.drawings![0]).not.toHaveProperty("fill")
    expect(p.drawings![1]).toMatchObject({ x: 1, y: 1 })
    p = step(p, "edit_drawings", { ids: [box.id], width: 3, corners: "large", rotate: true, order: "back" }).project
    expect(p.drawings![0]).toMatchObject({ id: box.id, width: 1, height: 3, radius: 0.2 })
    const same = step(p, "edit_drawings", { ids: [box.id], text: "only texts have text" })
    expect(same.project).toBe(p)
    expect(runTool(p, "edit_drawings", { ids: ["d_nope"] }).result).toContain(note.id)
    p = step(p, "edit_drawings", { ids: [note.id, box.id], remove: true }).project
    expect(p.drawings).toBeUndefined()
  })

  it("moves a whole block with what it holds, as dragging its title does", () => {
    let p = sheet()
    const frame0 = blockFrames(p)[0].box
    p = step(p, "draw", { shapes: [{ type: "text", text: "inside", x: frame0.minX + 0.2, y: frame0.minY + 0.4, size: "small" }] }).project
    const out = step(p, "edit_block", { block: "LED", move_by: { x: 0, y: -3.04 } })
    const at = (q: Project, ref: string) => q.components.find((c) => c.ref === ref)!.sch
    expect(at(out.project, "R1")).toMatchObject({ x: 0, y: -3 })
    expect(at(out.project, "D1")).toMatchObject({ x: 3, y: -3 })
    expect(at(out.project, "C1")).toMatchObject({ x: 8, y: 0 })
    expect(out.project.drawings![0]).toMatchObject({ y: round(frame0.minY + 0.4 - 3) })
    expect(out.result).toContain("moved by (0, -3)")
  })
})

const round = (n: number) => Math.round(n * 1e4) / 1e4

describe("drawings and Tidy", () => {
  it("keep their place in a block Tidy moves, and the others stay where they are", () => {
    let p = createProject("t")
    p = step(p, "add_component", { part_id: "resistor", x: 0, y: 0 }).project
    p = step(p, "add_component", { part_id: "led", x: 3, y: 0 }).project
    p = step(p, "connect", { pins: ["R1.2", "D1.A"] }).project
    p = step(p, "add_component", { part_id: "capacitor", x: 20, y: 9 }).project
    p = step(p, "group_parts", { block: "LED", refs: ["R1", "D1"] }).project
    p = step(p, "group_parts", { block: "BULK", refs: ["C1"] }).project
    const before = blockFrames(p)
    const led = before.find((f) => f.name === "LED")!.box
    p = step(p, "draw", {
      shapes: [
        { type: "text", text: "5 mA", x: led.minX + 0.2, y: led.minY + 0.3, size: "small" },
        { type: "text", text: "SHEET", x: -10, y: 20, size: "title" },
      ],
    }).project
    const note = p.drawings![0] as DrawingText
    const title = p.drawings![1]
    const res = tidySchematic(p)
    expect(res.ok, res.message).toBe(true)
    expect(res.changed).toBe(true)
    const after = blockFrames(res.project)
    const was = blockFrames(p).find((f) => f.name === "LED")!.box
    const now = after.find((f) => f.name === "LED")!.box
    expect(now.minX !== was.minX || now.maxY !== was.maxY).toBe(true)
    const moved = res.project.drawings!.find((d) => d.id === note.id) as DrawingText
    // Where it was in the frame, to the grid.
    expect(Math.abs(moved.x - note.x - (now.minX - was.minX))).toBeLessThanOrEqual(0.05 + 1e-9)
    expect(Math.abs(moved.y - note.y - (now.maxY - was.maxY))).toBeLessThanOrEqual(0.05 + 1e-9)
    expect(res.project.drawings!.find((d) => d.id === title.id)).toEqual(title)
  })
})

describe("Sakura sees drawings and frames", () => {
  it("in the picture, and reads texts over symbols as problems", () => {
    let p = step(createProject("t"), "add_component", { part_id: "resistor", x: 0, y: 0 }).project
    p = step(p, "group_parts", { block: "POWER", refs: ["R1"] }).project
    p = step(p, "draw", { shapes: [{ type: "text", text: "ON THE PART", x: -0.2, y: 0.1 }, { type: "text", text: "Sheet title", x: -3, y: 3, size: "title" }] }).project
    const m = measureSchematic(p)
    expect(m.drawings).toBe(2)
    expect(m.textsOnSymbols.map((c) => c.b)).toEqual(["R1"])
    expect(describeSchematic(m).join("\n")).toContain('drawn text(s) over a symbol or label: the text "ON THE PART" on R1')
    const view = frame(p, "schematic", {})
    // The whole sheet takes in the title far from the part.
    expect(view.box.minX).toBeLessThan(-3)
    const svg = schematicSvg(p, view.box, { width: 800, height: 600 }, m)
    expect(svg).toContain(">POWER</text>")
    expect(svg).toContain(">Sheet title</text>")
    expect(svg).toContain(`fill="${SCH_LIGHT.drawing.ink}"`)
    const d = p.drawings![1]
    expect(frame(p, "schematic", { selection: true }, [`d:${d.id}`]).box.minX).toBeLessThan(drawingBounds(d).minX)
  })
})
