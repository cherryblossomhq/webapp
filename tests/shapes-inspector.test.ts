import { describe, expect, it } from "vitest"
import { DASH_OPTIONS, MIXED, common, isCopperLayer, landSelectionOwner, landUsers, layerGroups, parseOffset, selectedGraphicIds, selectedLandIndices, shapeFacts, shapeRowText } from "../src/panels/shapeInspector"
import { SHAPE_LAYERS } from "../src/model/shapeLayers"
import { addComponent, createProject } from "../src/model/ops"
import type { BoardGraphic, BoardShape, Project } from "../src/model/types"

const line = (extra: Partial<BoardShape> = {}) => ({ type: "line", a: { x: 0, y: 0 }, b: { x: 2, y: 1 }, layer: "F.SilkS", width: 0.15, ...extra }) as BoardShape
const rect = (extra: Partial<BoardShape> = {}) => ({ type: "rect", a: { x: 1, y: 1 }, b: { x: 4, y: 3 }, layer: "F.Fab", width: 0.1, ...extra }) as BoardShape

describe("shape facts for the Inspector", () => {
  it("common values and mixed ones", () => {
    expect(common([])).toBeUndefined()
    expect(common([1, 1])).toBe(1)
    expect(common([1, 2])).toBe(MIXED)
  })

  it("one drawing reads as itself", () => {
    const f = shapeFacts([line({ dash: "dot", locked: true })])
    expect(f).toMatchObject({ count: 1, type: "Line", layer: "F.SilkS", width: 0.15, dash: "dot", fill: false, locked: true, net: "", allClosed: false, anyCopper: false })
    expect(f.box).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 1 })
  })

  it("several drawings show mixed where they differ and the box of all", () => {
    const f = shapeFacts([line(), rect({ fill: true })])
    expect(f.type).toBe("Mixed")
    expect(f.layer).toBe(MIXED)
    expect(f.width).toBe(MIXED)
    expect(f.fill).toBe(MIXED)
    expect(f.allClosed).toBe(false)
    expect(f.box).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 3 })
    expect(shapeFacts([rect(), rect()])).toMatchObject({ type: "Rectangle", layer: "F.Fab", allClosed: true })
  })

  it("copper layers get a net field", () => {
    expect(shapeFacts([line({ layer: "B.Cu", net: "GND" })])).toMatchObject({ anyCopper: true, net: "GND" })
    expect(isCopperLayer("F.Cu")).toBe(true)
    expect(isCopperLayer("F.SilkS")).toBe(false)
  })

  it("lists every layer once, grouped, and shows an unusual current layer", () => {
    const groups = layerGroups()
    expect(groups.flatMap((g) => g.layers).length).toBe(SHAPE_LAYERS.length)
    expect(groups.map((g) => g.label)).toContain("Silkscreen")
    const odd = layerGroups(["Weird.Layer", "F.SilkS"])
    expect(odd[0]).toEqual({ label: "Other", layers: [{ name: "Weird.Layer", label: "Weird.Layer" }] })
    expect(DASH_OPTIONS.map((d) => d.value)).toEqual(["", "dash", "dot", "dash_dot", "dash_dot_dot"])
    expect(shapeRowText(rect())).toBe("Rectangle, Top fabrication")
  })
})

describe("selection of drawings", () => {
  const project: Project = { ...createProject("t"), graphics: [{ ...line(), id: "a" } as BoardGraphic, { ...rect(), id: "b" } as BoardGraphic] }

  it("finds the board drawings that exist and ignores the rest", () => {
    expect(selectedGraphicIds(project, ["g:a", "g:zzz", "c:x", "s:c1:0", "g:b"])).toEqual(["a", "b"])
  })

  it("picks a part's drawing indices that exist in its land", () => {
    expect(selectedLandIndices(["s:c1:2", "s:c1:0", "s:c2:1", "s:c1:9", "s:c1:2"], "c1", 3)).toEqual([0, 2])
  })

  it("a selection of one part's drawings keeps that part's panel", () => {
    expect(landSelectionOwner(["s:c1:0", "s:c1:3"])).toBe("c1")
    expect(landSelectionOwner(["s:c1:0", "s:c2:0"])).toBeNull()
    expect(landSelectionOwner(["s:c1:0", "g:a"])).toBeNull()
    expect(landSelectionOwner([])).toBeNull()
  })

  it("counts the parts that use a land", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { footprint: "0603" }).project
    p = addComponent(p, "resistor", { footprint: "0603" }).project
    p = addComponent(p, "resistor", { footprint: "0805" }).project
    expect(landUsers(p, "0603")).toBe(2)
    expect(landUsers(p, "none")).toBe(0)
  })

  it("reads typed offsets", () => {
    expect(parseOffset("1,5")).toBe(1.5)
    expect(parseOffset(" -2 ")).toBe(-2)
    expect(parseOffset("")).toBe(0)
    expect(parseOffset("abc")).toBeNull()
  })
})
