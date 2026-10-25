import { describe, expect, it } from "vitest"
import {
  addDrawPoint,
  buildShape,
  defaultDrawWidth,
  drawLayerChoices,
  finishPolygon,
  graphicIds,
  hitShape,
  marqueeShapes,
  previewShape,
  shapeSelectionId,
  shapeShown,
  usedShapeLayers,
  visibleShapes,
  type ShapeVisibility,
} from "../src/editor/pcb/shapeEditing"
import { createProject } from "../src/model/ops"
import { worldShapes, type WorldShape } from "../src/model/shapeItems"
import { SHAPE_LAYERS } from "../src/model/shapeLayers"
import { addGraphic, moveGraphics, removeGraphics } from "../src/model/shapeOps"
import type { BoardShape } from "../src/model/types"

const vis = (hidden: Record<string, boolean> = {}, layers = { top: true, bottom: true, silk: true }): ShapeVisibility => ({ hidden, layers })

const world = (shape: BoardShape, id = "g:a", owner = "#board", placed = true): WorldShape => ({ id, owner, index: 0, shape, placed })

const line = (layer: string, a = { x: 0, y: 0 }, b = { x: 10, y: 0 }, width = 0.2): BoardShape => ({ type: "line", layer, width, a, b })

describe("which drawings are visible", () => {
  it("hides a layer the user hid and keeps the others", () => {
    const shapes = [world(line("F.Fab"), "g:1"), world(line("User.3"), "g:2")]
    const out = visibleShapes(shapes, vis({ "F.Fab": true }))
    expect(out.map((s) => s.id)).toEqual(["g:2"])
  })

  it("follows the copper and silkscreen switches of the side", () => {
    const top = world(line("F.Cu"))
    const bottom = world(line("B.Cu"))
    const silk = world(line("F.SilkS"))
    const off = vis({}, { top: false, bottom: true, silk: false })
    expect(shapeShown(top, off)).toBe(false)
    expect(shapeShown(bottom, off)).toBe(true)
    expect(shapeShown(silk, off)).toBe(false)
    expect(shapeShown(silk, vis())).toBe(true)
  })

  it("leaves out the drawings of a part not placed", () => {
    expect(shapeShown(world(line("F.SilkS"), "s:c:0", "c", false), vis())).toBe(false)
  })
})

describe("the layer list", () => {
  it("lists only the layers in use, in the order of the layer table", () => {
    const shapes = [world(line("User.2"), "g:1"), world(line("F.SilkS"), "g:2"), world(line("F.SilkS"), "g:3"), world(line("B.Fab"), "g:4")]
    expect(usedShapeLayers(shapes).map((l) => l.name)).toEqual(["F.SilkS", "B.Fab", "User.2"])
    expect(usedShapeLayers(shapes)[0].label).toBe("Top silkscreen")
  })

  it("is empty for a project with no drawings", () => {
    expect(usedShapeLayers(worldShapes(createProject("x")))).toEqual([])
  })

  it("offers every drawing layer to the tools", () => {
    expect(drawLayerChoices()).toBe(SHAPE_LAYERS)
    expect(drawLayerChoices().some((l) => l.name === "User.45")).toBe(true)
  })
})

describe("hit testing", () => {
  it("picks a line by its stroke and not away from it", () => {
    const shapes = [world(line("F.SilkS"))]
    expect(hitShape(shapes, { x: 5, y: 0.05 }, 0.1, vis())?.id).toBe("g:a")
    expect(hitShape(shapes, { x: 5, y: 1 }, 0.1, vis())).toBeNull()
  })

  it("counts half the width of the stroke", () => {
    const shapes = [world(line("F.SilkS", { x: 0, y: 0 }, { x: 10, y: 0 }, 1))]
    expect(hitShape(shapes, { x: 5, y: 0.45 }, 0, vis())).not.toBeNull()
    expect(hitShape(shapes, { x: 5, y: 0.6 }, 0, vis())).toBeNull()
  })

  it("picks inside a filled shape but not inside an outline", () => {
    const outline: BoardShape = { type: "rect", layer: "F.Fab", width: 0.1, a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }
    const filled: BoardShape = { ...outline, fill: true }
    expect(hitShape([world(outline)], { x: 5, y: 5 }, 0.1, vis())).toBeNull()
    expect(hitShape([world(filled)], { x: 5, y: 5 }, 0.1, vis())).not.toBeNull()
  })

  it("picks a circle on its ring and an arc along its curve", () => {
    const circle: BoardShape = { type: "circle", layer: "F.SilkS", width: 0.2, c: { x: 0, y: 0 }, r: 5 }
    expect(hitShape([world(circle)], { x: 5, y: 0 }, 0.1, vis())).not.toBeNull()
    expect(hitShape([world(circle)], { x: 0, y: 0 }, 0.1, vis())).toBeNull()
    const arc: BoardShape = { type: "arc", layer: "F.SilkS", width: 0.2, start: { x: 5, y: 0 }, mid: { x: 0, y: 5 }, end: { x: -5, y: 0 } }
    expect(hitShape([world(arc)], { x: 0, y: 5 }, 0.1, vis())).not.toBeNull()
    expect(hitShape([world(arc)], { x: 0, y: -5 }, 0.1, vis())).toBeNull()
  })

  it("skips a hidden layer and takes the one on top", () => {
    const shapes = [world(line("F.Fab"), "g:under"), world(line("User.1"), "g:over")]
    expect(hitShape(shapes, { x: 5, y: 0 }, 0.1, vis())?.id).toBe("g:over")
    expect(hitShape(shapes, { x: 5, y: 0 }, 0.1, vis({ "User.1": true }))?.id).toBe("g:under")
  })
})

describe("selection ids", () => {
  it("selects a board drawing itself and a part's drawing as the part", () => {
    expect(shapeSelectionId(world(line("F.SilkS"), "g:abc"))).toBe("g:abc")
    expect(shapeSelectionId(world(line("F.SilkS"), "s:c_1:0", "c_1"))).toBe("c:c_1")
  })

  it("reads the drawings out of a selection", () => {
    expect(graphicIds(["c:1", "g:x", "t:2", "g:y"])).toEqual(["x", "y"])
  })

  it("marquee picks the board drawings whose box it touches", () => {
    const shapes = [world(line("F.SilkS", { x: 0, y: 0 }, { x: 10, y: 0 }), "g:in"), world(line("F.SilkS", { x: 50, y: 50 }, { x: 60, y: 50 }), "g:out"), world(line("F.SilkS"), "s:c:0", "c")]
    expect(marqueeShapes(shapes, { minX: 4, minY: -1, maxX: 6, maxY: 1 }, vis())).toEqual(["g:in"])
    expect(marqueeShapes(shapes, { minX: 4, minY: -1, maxX: 6, maxY: 1 }, vis({ "F.SilkS": true }))).toEqual([])
  })
})

describe("the drawing tools", () => {
  const style = { layer: "F.SilkS", width: 0.15 }
  const P = (x: number, y: number) => ({ x, y })

  it("starts with the usual width of each layer", () => {
    expect(defaultDrawWidth("F.SilkS")).toBe(0.15)
    expect(defaultDrawWidth("B.SilkS")).toBe(0.15)
    expect(defaultDrawWidth("F.Cu")).toBe(0.25)
    expect(defaultDrawWidth("F.Fab")).toBe(0.1)
    expect(defaultDrawWidth("User.9")).toBe(0.1)
  })

  it("takes the clicks each tool needs and ignores a repeated one", () => {
    expect(addDrawPoint("line", [], P(0, 0))).toEqual({ points: [P(0, 0)], complete: false })
    expect(addDrawPoint("line", [P(0, 0)], P(1, 0)).complete).toBe(true)
    expect(addDrawPoint("line", [P(0, 0)], P(0, 0))).toEqual({ points: [P(0, 0)], complete: false })
    expect(addDrawPoint("arc", [P(0, 0), P(1, 1)], P(2, 0)).complete).toBe(true)
    expect(addDrawPoint("arc", [P(0, 0)], P(1, 1)).complete).toBe(false)
    expect(addDrawPoint("polygon", [P(0, 0), P(1, 0), P(1, 1)], P(0, 1)).complete).toBe(false)
  })

  it("makes a line, a circle and a rectangle", () => {
    expect(buildShape("line", [P(0, 0), P(3, 4)], style)).toEqual({ ...style, type: "line", a: P(0, 0), b: P(3, 4) })
    const c = buildShape("circle", [P(1, 1), P(4, 5)], style)
    expect(c).toMatchObject({ type: "circle", c: P(1, 1), r: 5 })
    expect(buildShape("rect", [P(0, 0), P(2, 3)], style)).toMatchObject({ type: "rect", a: P(0, 0), b: P(2, 3) })
  })

  it("makes a valid arc from three clicks, through the middle one", () => {
    const arc = buildShape("arc", [P(5, 0), P(0, 5), P(-5, 0)], style)
    expect(arc).toMatchObject({ type: "arc", start: P(5, 0), mid: P(0, 5), end: P(-5, 0) })
    // The same three points make the circle of radius 5 round the origin.
    expect(hitShape([world(arc!)], P(0, 5), 0.1, vis())).not.toBeNull()
  })

  it("refuses what is not a shape", () => {
    expect(buildShape("line", [P(0, 0), P(0, 0)], style)).toBeNull()
    expect(buildShape("circle", [P(1, 1), P(1, 1)], style)).toBeNull()
    expect(buildShape("rect", [P(0, 0), P(0, 5)], style)).toBeNull()
    expect(buildShape("rect", [P(0, 0), P(5, 0)], style)).toBeNull()
    expect(buildShape("arc", [P(0, 0), P(1, 0), P(2, 0)], style)).toBeNull()
    expect(buildShape("arc", [P(0, 0), P(1, 1)], style)).toBeNull()
    expect(buildShape("polygon", [P(0, 0), P(1, 0)], style)).toBeNull()
    expect(buildShape("polygon", [P(0, 0), P(1, 0), P(2, 0)], style)).toBeNull()
  })

  it("makes a polygon from its corners without a repeated one", () => {
    const poly = finishPolygon([P(0, 0), P(4, 0), P(4, 3), P(4, 3)], style)
    expect(poly).toMatchObject({ type: "polygon", pts: [P(0, 0), P(4, 0), P(4, 3)] })
    // Closing back onto the first corner is not a fourth corner.
    expect(finishPolygon([P(0, 0), P(4, 0), P(4, 3), P(0, 0)], style)).toMatchObject({ pts: [P(0, 0), P(4, 0), P(4, 3)] })
  })

  it("previews with the cursor as the next click", () => {
    expect(previewShape("line", [], P(1, 1), style)).toBeNull()
    expect(previewShape("rect", [P(0, 0)], P(2, 2), style)).toMatchObject({ type: "rect" })
    expect(previewShape("arc", [P(5, 0)], P(0, 5), style)).toMatchObject({ type: "line" })
    expect(previewShape("arc", [P(5, 0), P(0, 5)], P(-5, 0), style)).toMatchObject({ type: "arc" })
    expect(previewShape("polygon", [P(0, 0), P(4, 0)], P(4, 3), style)).toMatchObject({ type: "polygon" })
    expect(previewShape("polygon", [P(0, 0)], P(4, 0), style)).toMatchObject({ type: "line" })
  })
})

describe("board drawings in a project", () => {
  it("draws, moves and deletes through the shared model", () => {
    const shape = buildShape("rect", [{ x: 0, y: 0 }, { x: 2, y: 2 }], { layer: "User.1", width: 0.1 })!
    const { project, graphic } = addGraphic(createProject("x"), shape)
    expect(worldShapes(project).map((s) => s.id)).toEqual([`g:${graphic.id}`])
    expect(usedShapeLayers(worldShapes(project)).map((l) => l.name)).toEqual(["User.1"])
    const moved = moveGraphics(project, [graphic.id], 1, 1)
    expect(moved.graphics![0]).toMatchObject({ a: { x: 1, y: 1 }, b: { x: 3, y: 3 } })
    expect(removeGraphics(moved, [graphic.id]).graphics).toBeUndefined()
  })
})
