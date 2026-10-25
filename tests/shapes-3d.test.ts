import { afterAll, describe, expect, it } from "vitest"
import { buildBoardTextures, type TextureInput } from "../src/editor/three/boardTextures"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical, pcbPads } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { dashShape } from "../src/model/shapes"
import type { BoardGraphic, BoardShape, Project, ShapeStyle } from "../src/model/types"

// There is no canvas here, so the 2D context is a recorder: every call and every style it is given
// is logged, and the tests read what was drawn on each of the four canvases (albedo and surface of
// each side) from the log.

type Entry = [string, ...unknown[]]
let logs: Entry[][] = []

function fakeContext(log: Entry[]): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {}
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_t, key: string) {
      if (key in state) return state[key]
      return (...args: unknown[]) => {
        log.push([key, ...args])
      }
    },
    set(_t, key: string, value) {
      state[key] = value
      log.push(["set", key, value])
      return true
    },
  })
}

;(globalThis as { document?: unknown }).document = {
  createElement: () => {
    const log: Entry[] = []
    logs.push(log)
    return { width: 0, height: 0, getContext: () => fakeContext(log) }
  },
}
afterAll(() => {
  delete (globalThis as { document?: unknown }).document
})

const blinker = () => structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project
const style = (layer: string, width = 0.2, extra: Partial<ShapeStyle> = {}): ShapeStyle => ({ layer, width, ...extra })
const withGraphics = (shapes: BoardShape[], base: Project): Project => ({ ...base, graphics: shapes.map((s, i): BoardGraphic => ({ ...s, id: `zg${i}` })) })

function input(project: Project): TextureInput {
  registerProjectParts(project)
  const placed = project.components.filter((c) => c.pcb.placed && isPhysical(findPart(c.partId)))
  return { project, placed, padsByComponent: new Map(placed.map((c) => [c.id, pcbPads(c)])), fills: [], anisotropy: 1 }
}

/** The log of each canvas, in the order they are made: top albedo, top surface, bottom albedo, bottom surface. */
function draw(project: Project) {
  logs = []
  const set = buildBoardTextures(input(project))
  set.dispose()
  expect(logs).toHaveLength(4)
  return { topAlbedo: logs[0], topSurface: logs[1], bottomAlbedo: logs[2], bottomSurface: logs[3] }
}

interface Mark {
  kind: "fill" | "stroke"
  width: number
  fillStyle: unknown
  strokeStyle: unknown
  /** The path ops since the last beginPath. */
  path: Entry[]
}

/** The fills and strokes of a canvas, each with the path it painted and the style then in force. */
function marks(log: Entry[]): Mark[] {
  const out: Mark[] = []
  const state: Record<string, unknown> = {}
  const stack: Record<string, unknown>[] = []
  let path: Entry[] = []
  for (const e of log) {
    const [op, ...args] = e
    if (op === "set") state[args[0] as string] = args[1]
    else if (op === "save") stack.push({ ...state })
    else if (op === "restore") Object.assign(state, stack.pop() ?? {})
    else if (op === "beginPath") path = []
    else if (op === "fill" || op === "stroke") out.push({ kind: op, width: Number(state.lineWidth), fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, path: [...path] })
    else if (["moveTo", "lineTo", "arc", "ellipse", "bezierCurveTo", "closePath", "roundRect"].includes(op)) path.push(e)
  }
  return out
}

const sameLog = (a: Entry[], b: Entry[]) => JSON.stringify(a) === JSON.stringify(b)

describe("3D board textures: boards with no drawings", () => {
  it("draw the same whether the drawing fields are absent or empty", () => {
    for (const example of EXAMPLES.slice(0, 3)) {
      const p = structuredClone(example.project) as Project
      const base = draw(p)
      const empty = draw({ ...p, graphics: [] })
      for (const key of Object.keys(base) as (keyof typeof base)[]) expect(sameLog(base[key], empty[key]), `${example.id} ${key}`).toBe(true)
    }
  })
})

describe("3D board textures: drawings", () => {
  const base = blinker()
  const ref = draw(base)

  it("a silkscreen line is ink on its own side's albedo and surface, and on no other canvas", () => {
    const line: BoardShape = { type: "line", a: { x: 1, y: 2 }, b: { x: 5, y: 3 }, ...style("F.SilkS", 0.3) }
    const out = draw(withGraphics([line], base))
    const extra = marks(out.topAlbedo).filter((m) => m.kind === "stroke" && m.path.some((e) => e[0] === "lineTo" && e[1] === 5 && e[2] === 3))
    expect(extra).toHaveLength(1)
    expect(extra[0].width).toBe(0.3)
    expect(extra[0].path[0]).toEqual(["moveTo", 1, 2])
    expect(marks(out.topSurface).some((m) => m.kind === "stroke" && m.width === 0.3)).toBe(true)
    expect(sameLog(out.bottomAlbedo, ref.bottomAlbedo)).toBe(true)
    expect(sameLog(out.bottomSurface, ref.bottomSurface)).toBe(true)
  })

  it("a filled silkscreen circle is an arc on the circle, filled in the silkscreen colour and outlined", () => {
    const circle: BoardShape = { type: "circle", c: { x: 7, y: 4 }, r: 1.25, ...style("B.SilkS", 0.15, { fill: true }) }
    const out = draw(withGraphics([circle], base))
    const m = marks(out.bottomAlbedo).filter((x) => x.path.some((e) => e[0] === "arc" && e[1] === 7 && e[2] === 4 && e[3] === 1.25))
    expect(m.map((x) => x.kind).sort()).toEqual(["fill", "stroke"])
    const fill = m.find((x) => x.kind === "fill")!
    const stroke = m.find((x) => x.kind === "stroke")!
    expect(fill.fillStyle).toBe(stroke.strokeStyle)
    expect(sameLog(out.topAlbedo, ref.topAlbedo)).toBe(true)
  })

  it("an arc, a curve and an ellipse are drawn with the canvas's own arc, curve and ellipse", () => {
    const shapes: BoardShape[] = [
      { type: "arc", start: { x: 1, y: 1 }, mid: { x: 2, y: 2 }, end: { x: 3, y: 1 }, ...style("F.SilkS") },
      { type: "curve", p0: { x: 0, y: 0 }, c1: { x: 1, y: 5 }, c2: { x: 4, y: 5 }, p1: { x: 5, y: 0 }, ...style("F.SilkS") },
      { type: "ellipse", c: { x: 9, y: 9 }, rx: 3, ry: 1, rot: 20, ...style("F.SilkS") },
    ]
    const out = draw(withGraphics(shapes, base))
    const ops = marks(out.topAlbedo).flatMap((m) => m.path.map((e) => e[0]))
    expect(ops).toContain("arc")
    expect(ops).toContain("bezierCurveTo")
    expect(ops).toContain("ellipse")
    const arc = marks(out.topAlbedo).flatMap((m) => m.path).find((e) => e[0] === "arc" && e[1] === 2 && e[2] === 1 && e[3] === 1)!
    expect(arc[3]).toBe(1)
    // The arc bows upward through (2, 2), so it runs clockwise in the board's y-up space from start to end.
    expect(arc[6]).toBe(true)
  })

  it("a dashed silkscreen line draws its dashes", () => {
    const shape: BoardShape = { type: "line", a: { x: 0, y: 0 }, b: { x: 9, y: 0 }, ...style("F.SilkS", 0.2, { dash: "dash" }) }
    const out = draw(withGraphics([shape], base))
    const stroke = marks(out.topAlbedo).find((m) => m.kind === "stroke" && m.width === 0.2 && m.path.filter((e) => e[0] === "moveTo").length === dashShape(shape).length)
    expect(stroke).toBeTruthy()
  })

  it("a copper drawing is copper of its layer: filled in the copper's colour on the albedo and the surface", () => {
    const rect: BoardShape = { type: "rect", a: { x: 2, y: 2 }, b: { x: 6, y: 4 }, ...style("B.Cu", 0.25, { fill: true }) }
    const out = draw(withGraphics([rect], base))
    for (const [log, refLog] of [[out.bottomAlbedo, ref.bottomAlbedo], [out.bottomSurface, ref.bottomSurface]] as const) {
      const filled = marks(log).filter((m) => m.kind === "fill" && m.path.some((e) => e[0] === "moveTo" && e[1] === 2 && e[2] === 2))
      expect(filled).toHaveLength(1)
      const stroked = marks(log).filter((m) => m.kind === "stroke" && m.width === 0.25)
      expect(stroked.length).toBeGreaterThan(0)
      expect(log.length).toBeGreaterThan(refLog.length)
    }
    expect(sameLog(out.topAlbedo, ref.topAlbedo)).toBe(true)
    expect(sameLog(out.topSurface, ref.topSurface)).toBe(true)
  })

  it("a mask drawing is an opening on its side's albedo only", () => {
    const line: BoardShape = { type: "line", a: { x: 1, y: 1 }, b: { x: 8, y: 1 }, ...style("F.Mask", 0.4) }
    const out = draw(withGraphics([line], base))
    expect(marks(out.topAlbedo).some((m) => m.kind === "stroke" && m.width === 0.4)).toBe(true)
    expect(sameLog(out.topSurface, ref.topSurface)).toBe(true)
    expect(sameLog(out.bottomAlbedo, ref.bottomAlbedo)).toBe(true)
  })

  it("paste, fabrication, courtyard, adhesive and user drawings are not in the 3D board", () => {
    const layers = ["F.Paste", "B.Paste", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "F.Adhes", "B.Adhes", "Dwgs.User", "User.3"]
    const out = draw(withGraphics(layers.map((l) => ({ type: "line" as const, a: { x: 1, y: 1 }, b: { x: 8, y: 1 }, ...style(l) })), base))
    for (const key of Object.keys(ref) as (keyof typeof ref)[]) expect(sameLog(out[key], ref[key]), key).toBe(true)
  })

  it("a part's drawings go on the side its layer says, and a part not placed has none", () => {
    const p = blinker()
    const c = p.components[0]
    const land = { name: "zz_3d_land", pads: [], silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, shapes: [{ type: "line" as const, a: { x: -1, y: 0 }, b: { x: 1, y: 0 }, ...style("F.SilkS", 0.33) }] }
    const withLand = (side: "top" | "bottom", placed: boolean): Project => ({ ...p, footprints: [land], components: p.components.map((x) => (x.id === c.id ? { ...x, footprint: "zz_3d_land", pcb: { ...x.pcb, side, placed, x: 20, y: 10, rot: 0 as const } } : x)) })
    const top = draw(withLand("top", true))
    const bottom = draw(withLand("bottom", true))
    const none = draw(withLand("top", false))
    expect(marks(top.topAlbedo).some((m) => m.kind === "stroke" && m.width === 0.33)).toBe(true)
    expect(marks(top.bottomAlbedo).some((m) => m.kind === "stroke" && m.width === 0.33)).toBe(false)
    // On the bottom its F.SilkS is B.SilkS, mirrored about the part's own vertical axis.
    expect(marks(bottom.bottomAlbedo).some((m) => m.kind === "stroke" && m.width === 0.33)).toBe(true)
    expect(marks(bottom.topAlbedo).some((m) => m.kind === "stroke" && m.width === 0.33)).toBe(false)
    expect(marks(none.topAlbedo).some((m) => m.kind === "stroke" && m.width === 0.33)).toBe(false)
  })
})
