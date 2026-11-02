import { describe, expect, it } from "vitest"
import { defaultGraphicId, isCompactShapes, packGraphics, packShapes, unpackGraphics, unpackShapes } from "../src/model/shapeCodec"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { createProject } from "../src/model/ops"
import type { BoardGraphic, BoardShape } from "../src/model/types"

// The stored form of drawings: compact, exact, order and ids kept, and the same project in memory after a round trip.

const P = (x: number, y: number) => ({ x, y })
const base = { layer: "F.SilkS", width: 0.15 }
const every = (): BoardShape[] => [
  { ...base, type: "line", a: P(1.000001, -2), b: P(3, 4.5) },
  { ...base, type: "arc", start: P(1, 0), mid: P(0, 1), end: P(-1, 0) },
  { ...base, type: "circle", c: P(2, 3), r: 1.5, fill: true },
  { ...base, type: "rect", a: P(0, 0), b: P(4, 2) },
  { ...base, type: "rect", a: P(0, 0), b: P(4, 2), radius: 0.5, layer: "F.Fab", dash: "dash" },
  { ...base, type: "polygon", pts: [P(0, 0), P(4, 0), { x: 4, y: 3, mid: P(5, 1.5) }, P(0, 3)], fill: true, net: "GND", layer: "F.Cu" },
  { ...base, type: "polygon", pts: [P(0, 0), P(10, 0), P(10, 10), P(0, 10)], holes: [[P(2, 2), P(4, 2), P(4, 4)]], layer: "Dwgs.User", locked: true },
  { ...base, type: "curve", p0: P(0, 0), c1: P(1, 3), c2: P(3, 3), p1: P(4, 0), layer: "User.7", dash: "dot" },
  { ...base, type: "ellipse", c: P(1, 1), rx: 3, ry: 1, rot: 20.5 },
  { ...base, type: "ellipse", c: P(1, 1), rx: 3, ry: 1, rot: 20, from: -100, to: 10 },
]

describe("the stored form of drawings", () => {
  it("gives back every drawing exactly, in order, for a land", () => {
    const shapes = every()
    const stored = packShapes(shapes)
    expect(isCompactShapes(stored)).toBe(true)
    expect(unpackShapes(JSON.parse(JSON.stringify(stored)))).toEqual(shapes)
  })

  it("keeps the order when styles are mixed, and gives ids by place unless one is stored", () => {
    const graphics: BoardGraphic[] = every().map((s, i) => ({ ...s, id: defaultGraphicId(i) }))
    // The editor's own drawing, with a random id, and one whose id something refers to, after the others.
    graphics.push({ ...base, type: "line", a: P(0, 0), b: P(1, 1), id: "gabc123" })
    graphics.push({ ...base, type: "circle", c: P(0, 0), r: 1, id: "keep-me" })
    const stored = packGraphics(graphics)
    expect(Object.keys(stored.ids!).sort()).toEqual([String(graphics.length - 2), String(graphics.length - 1)].sort())
    const back = unpackGraphics(JSON.parse(JSON.stringify(stored)))!
    expect(back).toEqual(graphics)
    // Drawings brought in from KiCad have the default ids, so none is stored.
    const imported = every().map((s, i) => ({ ...s, id: defaultGraphicId(i) }))
    expect(packGraphics(imported).ids).toBeUndefined()
  })

  it("is a fraction of the size of the objects", () => {
    const many: BoardGraphic[] = Array.from({ length: 2000 }, (_, i) => ({ ...base, type: "line" as const, a: P(i * 0.1, 3.25), b: P(i * 0.1 + 1, 7.125), id: defaultGraphicId(i) }))
    expect(JSON.stringify(packGraphics(many)).length).toBeLessThan(JSON.stringify(many).length * 0.3)
  })

  it("survives a project save and load as the same project in memory, nothing rounded", () => {
    const p = createProject("drawings", "")
    const graphics: BoardGraphic[] = every().map((s, i) => ({ ...s, id: i === 4 ? "mine" : defaultGraphicId(i) }))
    const land = { name: "L1", pads: [], silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, shapes: every(), noCourtyard: true as const }
    const project = { ...p, graphics, footprints: [land] }
    const back = parseProjectFile(serializeProject(project), { id: p.id })
    expect(back.graphics).toEqual(graphics)
    expect(back.footprints).toEqual([land])
    // Read once, it writes the same file every time after.
    expect(serializeProject(parseProjectFile(serializeProject(back), { id: p.id }))).toBe(serializeProject(back))
    // The board's drawings are the objects the live sync edits one by one; a land's, which an edit replaces whole, are compact.
    const doc = JSON.parse(serializeProject(project)).project
    expect(doc.graphics.map((g: { id: string }) => g.id)).toEqual(graphics.map((g) => g.id))
    expect(Array.isArray(doc.footprints[0].shapes)).toBe(false)
  })

  it("drops what is damaged and nothing else", () => {
    const stored = JSON.parse(JSON.stringify(packShapes([every()[0], every()[1], every()[2]])))
    stored.g[0].s = ["L", 1, 2, 3, 4, "A", 1, 2]
    // The arc that is cut short and what follows it in its group are dropped; the other group is read.
    expect((unpackShapes(stored) ?? []).map((x) => x.type)).toEqual(["line", "circle"])
    expect(unpackShapes({ g: [{ l: "Nope", w: 1, s: ["L", 1, 2, 3, 4] }] })).toEqual([])
    expect(unpackShapes([])).toBeNull()
  })
})
