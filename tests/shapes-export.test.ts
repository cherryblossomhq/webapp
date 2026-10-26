import { describe, expect, it } from "vitest"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { gerberLayers, type GerberLayerName } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { fabricationNotes } from "../src/export/notes"
import { readKicadBoard } from "../src/model/kicad/board/read"
import { pcbSvg, type PcbExtra } from "../src/ai/vision/pcbSvg"
import { pcbShapes } from "../src/model/instances"
import { measurePcb } from "../src/ai/vision/measure"
import { getPcbAnalysis } from "../src/store/analysis"
import { fractureRings } from "../src/export/fracture"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { arcCircle, dashShape, ellipsePoint, FLATTEN_TOLERANCE } from "../src/model/shapes"
import type { BoardGraphic, BoardShape, CustomPartSpec, FootprintDef, Project, ShapeStyle, Vec2 } from "../src/model/types"

// The Gerber text for drawings is read back by a small parser (D01, D02, G01/G02/G03, I and J, G36
// and G37, the apertures) and set against the model's own geometry: arcs by their circle, circles
// whole, curves within a micrometre of the true curve.

// ---------- a small Gerber reader ----------

type Mode = "G01" | "G02" | "G03"
interface Stroke {
  kind: "line" | "arc"
  from: Vec2
  to: Vec2
  centre?: Vec2
  ccw?: boolean
  width: number
}
interface Parsed {
  strokes: Stroke[]
  flashes: { at: Vec2; diameter: number }[]
  regions: Vec2[][]
  clearRegions: number
  /** Everything in the order it was drawn: "S" stroke, "F" flash, "R" region. */
  order: string[]
}

function parseGerber(text: string): Parsed {
  const apertures = new Map<string, number>()
  const out: Parsed = { strokes: [], flashes: [], regions: [], clearRegions: 0, order: [] }
  let aperture = 0
  let mode: Mode = "G01"
  let at: Vec2 = { x: 0, y: 0 }
  let region: Vec2[] | null = null
  let dark = true
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const def = line.match(/^%ADD(\d+)C,([\d.]+)\*%$/)
    if (def) {
      apertures.set(`D${def[1]}`, Number(def[2]))
      continue
    }
    if (line === "%LPD*%") dark = true
    else if (line === "%LPC*%") dark = false
    else if (line === "G36*") region = []
    else if (line === "G37*") {
      if (region) {
        if (dark) out.regions.push(region)
        else out.clearRegions++
        out.order.push("R")
      }
      region = null
    } else if (/^G0[123]\*$/.test(line)) mode = line.slice(0, 3) as Mode
    else if (/^D\d+\*$/.test(line)) aperture = apertures.get(line.slice(0, -1)) ?? 0
    else {
      const m = line.match(/^(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0([123])\*$/)
      if (!m) continue
      const to = { x: m[1] !== undefined ? Number(m[1]) / 1e6 : at.x, y: m[2] !== undefined ? Number(m[2]) / 1e6 : at.y }
      const op = m[5]
      if (op === "2") {
        if (region) region.push(to)
      } else if (op === "3") {
        out.flashes.push({ at: to, diameter: aperture })
        out.order.push("F")
      } else if (region) {
        if (mode === "G01") region.push(to)
        else throw new Error("an arc inside a region: this writer flattens regions")
      } else if (mode === "G01") {
        out.strokes.push({ kind: "line", from: at, to, width: aperture })
        out.order.push("S")
      } else {
        const centre = { x: at.x + Number(m[3] ?? 0) / 1e6, y: at.y + Number(m[4] ?? 0) / 1e6 }
        out.strokes.push({ kind: "arc", from: at, to, centre, ccw: mode === "G03", width: aperture })
        out.order.push("S")
      }
      at = to
    }
  }
  return out
}

// ---------- projects ----------

const blinker = () => structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project

const withGraphics = (shapes: BoardShape[], base: Project = blinker()): Project => ({ ...base, graphics: shapes.map((s, i): BoardGraphic => ({ ...s, id: `zg${i}` })) })

const style = (layer: string, width = 0.2, extra: Partial<ShapeStyle> = {}): ShapeStyle => ({ layer, width, ...extra })

const ALL: GerberLayerName[] = ["F_Cu", "B_Cu", "F_Mask", "B_Mask", "F_Silkscreen", "B_Silkscreen", "F_Paste", "B_Paste", "Edge_Cuts"]

const stripped = (p: Project): Project => {
  const { graphics: _g, ...rest } = p
  return { ...rest, footprints: rest.footprints?.map(({ shapes: _s, ...f }) => f as FootprintDef) }
}

const near = (a: Vec2, b: Vec2, tol = 1e-9) => Math.hypot(a.x - b.x, a.y - b.y) <= tol
const round6 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 })
const area = (ring: Vec2[]) => {
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  return twice / 2
}

/** Distance from a point to a dense sampling of a curve. */
const toCurve = (p: Vec2, curve: Vec2[]) => {
  let best = Infinity
  for (let i = 0; i + 1 < curve.length; i++) {
    const a = curve[i]
    const b = curve[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
  }
  return best
}

describe("Gerber: boards with no drawings", () => {
  it("every shipped example plots the same with the drawing fields absent or empty", () => {
    for (const example of EXAMPLES) {
      const p = example.project
      registerProjectParts(p)
      const base = gerberLayers(p)
      expect(gerberLayers(stripped(p)), example.id).toEqual(base)
      expect(gerberLayers({ ...p, graphics: [] }), example.id).toEqual(base)
    }
  })

  it("drawings change only the files they are on", () => {
    const p = blinker()
    registerProjectParts(p)
    const before = gerberLayers(p)
    const after = gerberLayers(withGraphics([{ type: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 1 }, ...style("F.SilkS") }], p))
    for (const name of ALL) {
      if (name === "F_Silkscreen") expect(after[name]).not.toBe(before[name])
      else expect(after[name], name).toBe(before[name])
    }
  })
})

describe("Gerber: which file a layer goes to", () => {
  const line = (layer: string): BoardShape => ({ type: "line", a: { x: 1, y: 1 }, b: { x: 4, y: 2 }, ...style(layer, 0.25) })
  const routes: [string, GerberLayerName][] = [
    ["F.Cu", "F_Cu"],
    ["B.Cu", "B_Cu"],
    ["F.Mask", "F_Mask"],
    ["B.Mask", "B_Mask"],
    ["F.Paste", "F_Paste"],
    ["B.Paste", "B_Paste"],
    ["F.SilkS", "F_Silkscreen"],
    ["B.SilkS", "B_Silkscreen"],
  ]
  for (const [layer, file] of routes) {
    it(`${layer} is drawn in ${file} and in no other file`, () => {
      const p = blinker()
      registerProjectParts(p)
      const before = gerberLayers(p)
      const after = gerberLayers(withGraphics([line(layer)], p))
      for (const name of ALL) {
        if (name === file) {
          const parsed = parseGerber(after[name])
          const had = parseGerber(before[name]).strokes.length
          expect(parsed.strokes.length).toBe(had + 1)
          const s = parsed.strokes[parsed.strokes.length - 1]
          expect(s).toMatchObject({ kind: "line", from: { x: 1, y: 1 }, to: { x: 4, y: 2 }, width: 0.25 })
        } else expect(after[name], name).toBe(before[name])
      }
    })
  }

  it("fabrication, courtyard, adhesive and user layers are not plotted", () => {
    const p = blinker()
    registerProjectParts(p)
    const before = gerberLayers(p)
    const layers = ["F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "F.Adhes", "B.Adhes", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Margin", "User.1", "User.45"]
    expect(gerberLayers(withGraphics(layers.map(line), p))).toEqual(before)
  })

  it("the mask file stays negative and the drawing is a dark draw in it", () => {
    const p = blinker()
    registerProjectParts(p)
    const text = gerberLayers(withGraphics([line("F.Mask")], p)).F_Mask
    expect(text).toContain("%TF.FilePolarity,Negative*%")
    expect(text).not.toContain("%LPC*%")
  })
})

describe("Gerber: arcs, circles and fills are exact", () => {
  const plot = (shape: BoardShape, file: GerberLayerName = "F_Silkscreen") => {
    const p = withGraphics([shape])
    registerProjectParts(p)
    const before = parseGerber(gerberLayers(stripped(p))[file])
    const after = parseGerber(gerberLayers(p)[file])
    return {
      strokes: after.strokes.slice(before.strokes.length),
      flashes: after.flashes.slice(before.flashes.length),
      regions: after.regions.slice(before.regions.length),
      clear: after.clearRegions - before.clearRegions,
      order: after.order.slice(before.order.length),
    }
  }

  const checkArc = (s: Stroke, start: Vec2, mid: Vec2, end: Vec2) => {
    const a = arcCircle(start, mid, end)!
    expect(s.kind).toBe("arc")
    expect(near(s.from, round6(start))).toBe(true)
    expect(near(s.to, round6(end))).toBe(true)
    expect(Math.hypot(s.centre!.x - a.c.x, s.centre!.y - a.c.y)).toBeLessThanOrEqual(1e-6)
    expect(s.ccw).toBe(a.sweep > 0)
    // The radius the reader would draw from the start and from the end is the circle's within a micrometre.
    expect(Math.abs(Math.hypot(s.from.x - s.centre!.x, s.from.y - s.centre!.y) - a.r)).toBeLessThanOrEqual(1e-6)
    expect(Math.abs(Math.hypot(s.to.x - s.centre!.x, s.to.y - s.centre!.y) - a.r)).toBeLessThanOrEqual(1e-6)
  }

  it("a counter-clockwise arc and a clockwise one are G03 and G02 about the model's centre", () => {
    const ccw = { start: { x: 10.123457, y: 5.3333333 }, mid: { x: 11.7, y: 6.2 }, end: { x: 10.4, y: 8.0123456 } }
    const cw = { start: ccw.end, mid: ccw.mid, end: ccw.start }
    for (const geom of [ccw, cw]) {
      const { strokes } = plot({ type: "arc", ...geom, ...style("F.SilkS", 0.15) })
      expect(strokes).toHaveLength(1)
      checkArc(strokes[0], geom.start, geom.mid, geom.end)
      expect(strokes[0].width).toBe(0.15)
    }
    expect(arcCircle(ccw.start, ccw.mid, ccw.end)!.ccw).not.toBe(arcCircle(cw.start, cw.mid, cw.end)!.ccw)
  })

  it("an arc of more than half a turn keeps its long way round", () => {
    const geom = { start: { x: 14, y: 5 }, mid: { x: 12, y: 3.1 }, end: { x: 14.1, y: 5.05 } }
    const a = arcCircle(geom.start, geom.mid, geom.end)!
    expect(Math.abs(a.sweep)).toBeGreaterThan(Math.PI)
    const { strokes } = plot({ type: "arc", ...geom, ...style("F.SilkS") })
    checkArc(strokes[0], geom.start, geom.mid, geom.end)
  })

  it("an arc written with equal ends is a full circle", () => {
    const geom = { start: { x: 8, y: 4 }, mid: { x: 6, y: 4 }, end: { x: 8, y: 4 } }
    const { strokes } = plot({ type: "arc", ...geom, ...style("F.SilkS") })
    expect(strokes).toHaveLength(1)
    expect(strokes[0].from).toEqual(strokes[0].to)
    expect(strokes[0].centre).toEqual({ x: 7, y: 4 })
  })

  it("an unfilled circle is a ring of two half arcs on the model's circle", () => {
    const c = { x: 20.0000004, y: 7.25 }
    const { strokes, flashes } = plot({ type: "circle", c, r: 3.3333333, ...style("F.SilkS", 0.2) })
    expect(flashes).toHaveLength(0)
    expect(strokes).toHaveLength(2)
    for (const s of strokes) {
      expect(s.kind).toBe("arc")
      expect(Math.hypot(s.centre!.x - c.x, s.centre!.y - c.y)).toBeLessThanOrEqual(1e-6)
      expect(Math.abs(Math.hypot(s.from.x - c.x, s.from.y - c.y) - 3.3333333)).toBeLessThanOrEqual(1e-6)
      expect(s.ccw).toBe(true)
    }
    expect(near(strokes[0].to, strokes[1].from)).toBe(true)
    expect(near(strokes[1].to, strokes[0].from)).toBe(true)
  })

  it("a filled circle is one flash of 2r plus the width", () => {
    const { strokes, flashes } = plot({ type: "circle", c: { x: 9, y: 9 }, r: 1.5, ...style("F.Cu", 0.2, { fill: true }) }, "F_Cu")
    expect(strokes).toHaveLength(0)
    expect(flashes).toHaveLength(1)
    expect(flashes[0].diameter).toBeCloseTo(3.2, 9)
    expect(flashes[0].at).toEqual({ x: 9, y: 9 })
  })

  it("a filled rectangle is a region of the edge, then its outline", () => {
    const { strokes, regions, order } = plot({ type: "rect", a: { x: 2, y: 3 }, b: { x: 6, y: 5 }, ...style("F.SilkS", 0.2, { fill: true }) })
    expect(regions).toHaveLength(1)
    expect(Math.abs(area(regions[0]))).toBeCloseTo(8, 9)
    expect(strokes).toHaveLength(4)
    expect(order[0]).toBe("R")
  })

  it("a rounded rectangle has exact corner arcs", () => {
    const { strokes } = plot({ type: "rect", a: { x: 2, y: 3 }, b: { x: 8, y: 7 }, radius: 1, ...style("F.SilkS", 0.2) })
    const arcs = strokes.filter((s) => s.kind === "arc")
    expect(arcs).toHaveLength(4)
    expect(strokes.filter((s) => s.kind === "line")).toHaveLength(4)
    const centres = arcs.map((s) => s.centre!).sort((p, q) => p.x - q.x || p.y - q.y)
    expect(centres).toEqual([{ x: 3, y: 4 }, { x: 3, y: 6 }, { x: 7, y: 4 }, { x: 7, y: 6 }])
    for (const s of arcs) expect(s.ccw).toBe(true)
  })

  it("a polygon with an arc corner and a hole: exact arc stroke, a region with no clear polarity and the right area", () => {
    const shape: BoardShape = {
      type: "polygon",
      pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 5, y: 8, mid: { x: 8.5, y: 8.6 } }, { x: 0, y: 6 }],
      holes: [[{ x: 3, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 4 }, { x: 3, y: 4 }]],
      ...style("F.SilkS", 0.2, { fill: true }),
    }
    const { strokes, regions, clear, order } = plot(shape)
    expect(clear).toBe(0)
    expect(regions).toHaveLength(1)
    const arcs = strokes.filter((s) => s.kind === "arc")
    expect(arcs).toHaveLength(1)
    checkArc(arcs[0], { x: 10, y: 6 }, { x: 8.5, y: 8.6 }, { x: 5, y: 8 })
    // The outline stroke has the five edges and the hole's four.
    expect(strokes).toHaveLength(9)
    expect(order[0]).toBe("R")
    // The region is the outline's area less the hole's: the bridge adds none. The arc bows outward from the chord.
    const a = arcCircle({ x: 10, y: 6 }, { x: 8.5, y: 8.6 }, { x: 5, y: 8 })!
    const sweep = Math.abs(a.sweep)
    const segment = (a.r * a.r * (sweep - Math.sin(sweep))) / 2
    const polyArea = Math.abs(area([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 5, y: 8 }, { x: 0, y: 6 }]))
    expect(Math.abs(area(regions[0]))).toBeCloseTo(polyArea + segment - 4, 2)
  })

  it("a filled copper shape with a hole does not clear the pads inside it", () => {
    const shape: BoardShape = { type: "polygon", pts: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }, { x: 0, y: 12 }], holes: [[{ x: 4, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 8 }, { x: 4, y: 8 }]], ...style("F.Cu", 0, { fill: true }) }
    const { regions, clear, strokes } = plot(shape, "F_Cu")
    expect(clear).toBe(0)
    expect(strokes).toHaveLength(0)
    expect(Math.abs(area(regions[0]))).toBeCloseTo(144 - 16, 9)
  })

  it("a bezier curve is a polyline within a micrometre of the true curve", () => {
    const g = { p0: { x: 1, y: 1 }, c1: { x: 4, y: 9 }, c2: { x: 9, y: -3 }, p1: { x: 12, y: 6 } }
    const { strokes } = plot({ type: "curve", ...g, ...style("F.SilkS", 0.15) })
    expect(strokes.every((s) => s.kind === "line")).toBe(true)
    const dense: Vec2[] = []
    for (let i = 0; i <= 20000; i++) {
      const t = i / 20000
      const u = 1 - t
      dense.push({
        x: u ** 3 * g.p0.x + 3 * u * u * t * g.c1.x + 3 * u * t * t * g.c2.x + t ** 3 * g.p1.x,
        y: u ** 3 * g.p0.y + 3 * u * u * t * g.c1.y + 3 * u * t * t * g.c2.y + t ** 3 * g.p1.y,
      })
    }
    expect(strokes.length).toBeGreaterThan(20)
    expect(near(strokes[0].from, g.p0)).toBe(true)
    expect(near(strokes[strokes.length - 1].to, g.p1)).toBe(true)
    for (const s of strokes) {
      expect(toCurve(s.to, dense)).toBeLessThanOrEqual(1e-3)
      // The chord between two vertices stays near the curve too.
      expect(toCurve({ x: (s.from.x + s.to.x) / 2, y: (s.from.y + s.to.y) / 2 }, dense)).toBeLessThanOrEqual(1e-3)
    }
  })

  it("an ellipse and an elliptical arc are polylines within a micrometre of the true curve", () => {
    const e = { c: { x: 10, y: 8 }, rx: 5, ry: 2.5, rot: 30 }
    const rot = (e.rot * Math.PI) / 180
    const full = plot({ type: "ellipse", ...e, ...style("F.SilkS", 0.15) })
    const arc = plot({ type: "ellipse", ...e, from: 20, to: 200, ...style("F.SilkS", 0.15) })
    const dense = (t0: number, t1: number) => Array.from({ length: 20001 }, (_, i) => ellipsePoint(e.c, e.rx, e.ry, rot, t0 + ((t1 - t0) * i) / 20000))
    const cases = [
      [full, dense(0, Math.PI * 2)],
      [arc, dense((20 * Math.PI) / 180, (200 * Math.PI) / 180)],
    ] as const
    for (const [result, curve] of cases) {
      expect(result.strokes.length).toBeGreaterThan(30)
      for (const s of result.strokes) {
        expect(s.kind).toBe("line")
        expect(toCurve(s.to, curve)).toBeLessThanOrEqual(1e-3)
      }
    }
    // The closed one comes back to where it started; the arc starts where its parameter says.
    expect(near(full.strokes[0].from, full.strokes[full.strokes.length - 1].to, 1e-6)).toBe(true)
    expect(near(arc.strokes[0].from, round6(ellipsePoint(e.c, e.rx, e.ry, rot, (20 * Math.PI) / 180)), 1e-6)).toBe(true)
    expect(FLATTEN_TOLERANCE).toBeLessThan(1e-3)
  })

  it("a filled ellipse is a region and its stroke", () => {
    const { regions, strokes, order } = plot({ type: "ellipse", c: { x: 10, y: 8 }, rx: 4, ry: 2, rot: 0, ...style("F.SilkS", 0.1, { fill: true }) })
    expect(regions).toHaveLength(1)
    expect(Math.abs(area(regions[0]))).toBeCloseTo(Math.PI * 8, 2)
    expect(strokes.length).toBeGreaterThan(20)
    expect(order[0]).toBe("R")
  })

  it("a dashed line is its dashes, each a short stroke", () => {
    const shape: BoardShape = { type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, ...style("F.SilkS", 0.2, { dash: "dash" }) }
    const pieces = dashShape(shape)
    const { strokes } = plot(shape)
    expect(pieces.length).toBeGreaterThan(2)
    expect(strokes).toHaveLength(pieces.length)
    strokes.forEach((s, i) => {
      const piece = pieces[i] as { a: Vec2; b: Vec2 }
      expect(near(s.from, round6(piece.a))).toBe(true)
      expect(near(s.to, round6(piece.b))).toBe(true)
    })
  })

  it("a dashed circle is its dashes as arcs of the model's circle", () => {
    const c = { x: 20, y: 10 }
    const shape: BoardShape = { type: "circle", c, r: 4, ...style("F.SilkS", 0.2, { dash: "dash_dot" }) }
    const pieces = dashShape(shape)
    const { strokes } = plot(shape)
    expect(strokes).toHaveLength(pieces.length)
    for (const s of strokes) {
      expect(s.kind).toBe("arc")
      expect(Math.hypot(s.centre!.x - c.x, s.centre!.y - c.y)).toBeLessThanOrEqual(1e-6)
      expect(Math.abs(Math.hypot(s.from.x - c.x, s.from.y - c.y) - 4)).toBeLessThanOrEqual(1e-6)
    }
  })

  it("a dashed filled rectangle keeps its fill solid", () => {
    const shape: BoardShape = { type: "rect", a: { x: 0, y: 0 }, b: { x: 10, y: 4 }, ...style("F.SilkS", 0.2, { dash: "dash", fill: true }) }
    const { regions, strokes } = plot(shape)
    expect(regions).toHaveLength(1)
    expect(Math.abs(area(regions[0]))).toBeCloseTo(40, 9)
    expect(strokes).toHaveLength(dashShape(shape).length)
  })
})

describe("Gerber: the fracture of a ring with holes", () => {
  it("keeps the outline's area less the holes', for holes it has to look past", () => {
    const outer = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]
    const holes = [
      [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }],
      [{ x: 9, y: 8 }, { x: 15, y: 9 }, { x: 12, y: 14 }],
      [{ x: 3, y: 10 }, { x: 6, y: 10 }, { x: 6, y: 17 }, { x: 3, y: 17 }],
    ]
    const ring = fractureRings(outer, holes)
    expect(Math.abs(area(ring))).toBeCloseTo(400 - 16 - 16.5 - 21, 9)
  })
})

// ---------- parts with drawings of their own ----------

const LAND_SHAPES: BoardShape[] = [
  { type: "line", a: { x: -1.5, y: 0.25 }, b: { x: 1.5, y: 0.5 }, ...style("F.SilkS", 0.2) },
  { type: "arc", start: { x: -1, y: -0.5 }, mid: { x: 0, y: -1 }, end: { x: 1, y: -0.5 }, ...style("F.SilkS", 0.15) },
  { type: "circle", c: { x: 0.5, y: 0.5 }, r: 0.4, ...style("F.Mask", 0.1, { fill: true }) },
  { type: "rect", a: { x: -2, y: -1.2 }, b: { x: 2, y: 1.2 }, ...style("F.Fab", 0.1) },
  { type: "polygon", pts: [{ x: -0.5, y: -0.2 }, { x: 0.5, y: -0.2 }, { x: 0.5, y: 0.2 }, { x: -0.5, y: 0.2 }], ...style("F.Cu", 0.1, { fill: true, net: "GND" }) },
  { type: "curve", p0: { x: -2, y: 1 }, c1: { x: -1, y: 2 }, c2: { x: 1, y: 2 }, p1: { x: 2, y: 1 }, ...style("F.Fab", 0.1) },
  { type: "ellipse", c: { x: 0, y: 0 }, rx: 1.8, ry: 0.9, rot: 15, ...style("F.SilkS", 0.1) },
  { type: "rect", a: { x: -2.2, y: -1.4 }, b: { x: 2.2, y: 1.4 }, ...style("F.CrtYd", 0.05) },
]

const LAND: FootprintDef = { name: "zz_logo", pads: [], silk: [], courtyard: { minX: -2.2, minY: -1.4, maxX: 2.2, maxY: 1.4 }, noCourtyard: true, shapes: LAND_SHAPES }
const SPEC: CustomPartSpec = { id: "zz-logo-part", name: "Logo", description: "A logo with no pins", category: "Passives", refPrefix: "LOGO", footprint: "zz_logo", pins: [], props: {} }
/** The same part with a land that has no drawings: the baseline that differs from the logo by its drawings alone. */
const BARE_LAND: FootprintDef = { ...LAND, name: "zz_logo_bare", shapes: undefined }
const BARE_SPEC: CustomPartSpec = { ...SPEC, id: "zz-logo-bare", footprint: "zz_logo_bare" }

/** The blinker with a pin-less part on it (a logo: a land with drawings and no pads). */
function withLogo(side: "top" | "bottom" = "top", rot: 0 | 90 | 180 | 270 = 0, placed = true, base: Project = blinker(), bare = false): Project {
  const spec = bare ? BARE_SPEC : SPEC
  const land = bare ? BARE_LAND : LAND
  const component = { id: "zzlogo", partId: spec.id, ref: "LOGO1", props: {}, footprint: land.name, sch: { x: 0, y: 0, rot: 0 as const }, pcb: { x: 30, y: 12, rot, side, placed } }
  const p: Project = { ...base, parts: [...(base.parts ?? []), spec], footprints: [...(base.footprints ?? []), land], components: [...base.components, component] }
  registerProjectParts(p)
  return p
}

const pcbShapesOf = (p: Project, id: string) => pcbShapes(p.components.find((c) => c.id === id)!, 2)

describe("Gerber: a part's drawings", () => {
  const plotted = (p: Project, file: GerberLayerName) => parseGerber(gerberLayers(p)[file])

  it("a part on the top has its F.SilkS drawings in the top silkscreen, in the board's frame", () => {
    const p = withLogo("top", 0)
    const base = plotted(withLogo("top", 0, true, blinker(), true), "F_Silkscreen")
    const mine = plotted(p, "F_Silkscreen").strokes.slice(base.strokes.length)
    // The line, from (-1.5, 0.25) to (1.5, 0.5) about the part at (30, 12).
    expect(mine[0]).toMatchObject({ kind: "line", from: { x: 28.5, y: 12.25 }, to: { x: 31.5, y: 12.5 }, width: 0.2 })
    expect(plotted(p, "B_Silkscreen").strokes).toHaveLength(plotted(withLogo("top", 0, true, blinker(), true), "B_Silkscreen").strokes.length)
  })

  it("a part on the bottom has them mirrored in the bottom silkscreen", () => {
    const p = withLogo("bottom", 0)
    const bare = withLogo("bottom", 0, true, blinker(), true)
    const mine = plotted(p, "B_Silkscreen").strokes.slice(plotted(bare, "B_Silkscreen").strokes.length)
    expect(mine[0]).toMatchObject({ kind: "line", from: { x: 31.5, y: 12.25 }, to: { x: 28.5, y: 12.5 } })
    expect(plotted(p, "F_Silkscreen").strokes).toHaveLength(plotted(bare, "F_Silkscreen").strokes.length)
    // Its mask circle (F.Mask) is B.Mask now, and its copper polygon B.Cu.
    expect(plotted(p, "B_Mask").flashes.length).toBe(plotted(bare, "B_Mask").flashes.length + 1)
    expect(plotted(p, "B_Cu").regions.length).toBe(plotted(bare, "B_Cu").regions.length + 1)
    expect(plotted(p, "F_Cu").regions.length).toBe(plotted(bare, "F_Cu").regions.length)
  })

  it("a part not placed on the board leaves its drawings out, and its fab and courtyard drawings are never plotted", () => {
    expect(gerberLayers(withLogo("top", 0, false))).toEqual(gerberLayers(withLogo("top", 0, false, blinker(), true)))
    const f = gerberLayers(withLogo("top", 0, true))
    const bare = gerberLayers(withLogo("top", 0, true, blinker(), true))
    // Of the eight drawings only silk, mask and copper reach a file: three files change.
    expect(ALL.filter((name) => f[name] !== bare[name])).toEqual(["F_Cu", "F_Mask", "F_Silkscreen"])
  })
})

// ---------- KiCad ----------

const KICAD_BOARD_SHAPES: BoardShape[] = [
  { type: "line", a: { x: 5, y: 5 }, b: { x: 9, y: 6 }, ...style("F.SilkS", 0.2, { dash: "dash" }) },
  { type: "arc", start: { x: 10, y: 5 }, mid: { x: 11, y: 7 }, end: { x: 13, y: 8 }, ...style("B.SilkS", 0.15) },
  { type: "circle", c: { x: 20, y: 5 }, r: 2, ...style("F.SilkS", 0.1, { fill: true }) },
  { type: "rect", a: { x: 4, y: 9 }, b: { x: 8, y: 12 }, ...style("F.Fab", 0.1) },
  { type: "rect", a: { x: 14, y: 9 }, b: { x: 18, y: 12 }, radius: 1, ...style("User.3", 0.1) },
  { type: "polygon", pts: [{ x: 0, y: 14 }, { x: 4, y: 14 }, { x: 6, y: 17, mid: { x: 5.5, y: 15.2 } }, { x: 0, y: 17 }], ...style("F.Mask", 0.1, { fill: true }) },
  { type: "curve", p0: { x: 8, y: 14 }, c1: { x: 9, y: 18 }, c2: { x: 12, y: 18 }, p1: { x: 13, y: 14 }, ...style("F.Cu", 0.3, { net: "VCC", locked: true }) },
  { type: "polygon", pts: [{ x: 20, y: 14 }, { x: 26, y: 14 }, { x: 26, y: 20 }, { x: 20, y: 20 }], holes: [[{ x: 22, y: 16 }, { x: 24, y: 16 }, { x: 24, y: 18 }, { x: 22, y: 18 }]], ...style("B.Cu", 0.2, { fill: true }) },
  { type: "ellipse", c: { x: 30, y: 5 }, rx: 3, ry: 1.5, rot: 0, ...style("Dwgs.User", 0.1) },
  { type: "ellipse", c: { x: 30, y: 9 }, rx: 3, ry: 1.5, rot: 0, from: 0, to: 180, ...style("F.SilkS", 0.1) },
]

/** A point of a footprint's own frame on KiCad's page: KiCad turns by the footprint's angle counter-clockwise, y down. */
const fpToPage = (at: Vec2, angle: number, l: Vec2): Vec2 => {
  const a = (angle * Math.PI) / 180
  return { x: at.x + l.x * Math.cos(a) + l.y * Math.sin(a), y: at.y - l.x * Math.sin(a) + l.y * Math.cos(a) }
}
const pageOf = (p: Vec2): Vec2 => ({ x: 100 + p.x, y: 100 - p.y })

const boardFile = (files: Record<string, string>) => Object.entries(files).find(([name]) => name.endsWith(".kicad_pcb"))![1]

describe("KiCad export: drawings", () => {
  it("writes the board's drawings as KiCad's own items, on their layers, with stroke, fill and net", async () => {
    const p = withGraphics(KICAD_BOARD_SHAPES, withLogo("top", 0))
    const { files, notes } = await kicadFiles(p)
    const { board } = readKicadBoard(boardFile(files))
    // The outline of the board is gr_line too (Edge.Cuts): the drawings are the rest.
    const own = board.shapes.filter((s) => s.layer !== "Edge.Cuts")
    const byLayer = (layer: string) => own.filter((s) => s.layer === layer)
    // Ellipses came as lines and a polygon: the full one a polygon, the arc a run of lines.
    expect(byLayer("Dwgs.User").map((s) => s.kind)).toEqual(["poly"])
    expect(byLayer("F.SilkS").filter((s) => s.kind === "line" && !s.dash).length).toBeGreaterThan(40)

    const line = byLayer("F.SilkS").find((s) => s.dash)!
    expect(line).toMatchObject({ kind: "line", dash: "dash", width: 0.2 })
    expect(line.start).toEqual(pageOf({ x: 5, y: 5 }))
    expect(line.end).toEqual(pageOf({ x: 9, y: 6 }))

    const arc = byLayer("B.SilkS")[0]
    expect(arc).toMatchObject({ kind: "arc", width: 0.15 })
    expect([arc.start, arc.mid, arc.end]).toEqual([pageOf({ x: 10, y: 5 }), pageOf({ x: 11, y: 7 }), pageOf({ x: 13, y: 8 })])

    const circle = byLayer("F.SilkS").find((s) => s.kind === "circle")!
    expect(circle).toMatchObject({ filled: true, width: 0.1, center: pageOf({ x: 20, y: 5 }), end: pageOf({ x: 22, y: 5 }) })

    expect(byLayer("F.Fab").find((s) => s.kind === "rect")).toMatchObject({ filled: false, start: pageOf({ x: 4, y: 9 }), end: pageOf({ x: 8, y: 12 }) })

    // A rounded rectangle is a polygon with four arc corners.
    const rounded = byLayer("User.3")[0]
    expect(rounded.kind).toBe("poly")
    expect(rounded.polyItems!.filter((i) => "arc" in i)).toHaveLength(4)

    // A polygon's arc corner is an `arc` item from the corner before it, to the corner.
    const mask = byLayer("F.Mask")[0]
    expect(mask).toMatchObject({ kind: "poly", filled: true })
    const maskArc = mask.polyItems!.find((i) => "arc" in i) as { arc: { start: Vec2; mid: Vec2; end: Vec2 } }
    expect(maskArc.arc).toEqual({ start: pageOf({ x: 4, y: 14 }), mid: pageOf({ x: 5.5, y: 15.2 }), end: pageOf({ x: 6, y: 17 }) })

    // The curve is copper on VCC and locked.
    const curve = byLayer("F.Cu").find((s) => s.kind === "curve")!
    expect(curve).toMatchObject({ net: "VCC", locked: true, width: 0.3 })
    expect(curve.pts).toEqual([pageOf({ x: 8, y: 14 }), pageOf({ x: 9, y: 18 }), pageOf({ x: 12, y: 18 }), pageOf({ x: 13, y: 14 })])

    // The polygon with a hole: one filled polygon (the outline joined to its hole) and the two edges.
    const bCu = byLayer("B.Cu")
    expect(bCu.filter((s) => s.filled)).toHaveLength(1)
    expect(bCu.filter((s) => !s.filled)).toHaveLength(2)

    // The user layer the drawings are on is in the layer table.
    expect(board.layers.some((l) => l.name === "User.3")).toBe(true)

    expect(notes.some((n) => /no ellipse/.test(n))).toBe(true)
    expect(notes.some((n) => /no holes/.test(n))).toBe(true)
    expect(notes.join(" ")).not.toMatch(/[\u2013\u2014]/)
  }, 120_000)

  for (const [side, rot] of [["top", 0], ["top", 90], ["bottom", 0], ["bottom", 270]] as const) {
    it(`writes a pin-less part on the ${side} turned ${rot} as a footprint with its drawings in its own frame`, async () => {
      const p = withLogo(side, rot)
      const { files } = await kicadFiles(p)
      const { board } = readKicadBoard(boardFile(files))
      const fp = board.footprints.find((f) => f.ref === "LOGO1")!
      expect(fp).toBeTruthy()
      expect(fp.pads).toHaveLength(0)
      expect(fp.side).toBe(side)
      expect(fp.at).toEqual(pageOf({ x: 30, y: 12 }))
      // Every drawing of the land, the ellipse as many pieces.
      expect(fp.shapes.length).toBeGreaterThan(LAND_SHAPES.length)
      // The line, put back on the page with the footprint's place and angle, is where the board has it.
      const world = pcbShapesOf(p, "zzlogo")
      const wline = world[0] as Extract<BoardShape, { type: "line" }>
      const line = fp.shapes.find((s) => s.kind === "line" && s.layer === wline.layer && Math.abs(s.width - 0.2) < 1e-9)!
      const back = (l: Vec2) => fpToPage(fp.at, fp.angle, l)
      expect(near(back(line.start!), pageOf(wline.a), 2e-6)).toBe(true)
      expect(near(back(line.end!), pageOf(wline.b), 2e-6)).toBe(true)
      // The arc.
      const warc = world[1] as Extract<BoardShape, { type: "arc" }>
      const arc = fp.shapes.find((s) => s.kind === "arc")!
      expect(arc.layer).toBe(warc.layer)
      const want = [warc.start, warc.mid, warc.end]
      expect([back(arc.start!), back(arc.mid!), back(arc.end!)].every((q, i) => near(q, pageOf(want[i]), 2e-6))).toBe(true)
      // The layers follow the part's side: F.SilkS on the top, B.SilkS on the bottom.
      expect(line.layer).toBe(side === "top" ? "F.SilkS" : "B.SilkS")
      expect(fp.shapes.find((s) => s.kind === "rect" && s.layer.endsWith(".Fab"))!.layer).toBe(side === "top" ? "F.Fab" : "B.Fab")
      // The copper polygon carries its net.
      const copper = fp.shapes.find((s) => s.layer.endsWith(".Cu"))!
      expect(copper.net).toBe("GND")
      expect(copper.layer).toBe(side === "top" ? "F.Cu" : "B.Cu")
    }, 120_000)
  }

  it("a board with no drawings exports the same with the fields absent or empty", async () => {
    const p = blinker()
    const a = await kicadFiles(p)
    const b = await kicadFiles({ ...p, graphics: [] })
    // The board file is the converter's, ids and all; the schematic carries random ids of its own.
    expect(boardFile(b.files)).toBe(boardFile(a.files))
    expect(b.notes).toEqual(a.notes)
  }, 120_000)
})

// ---------- Circuit JSON ----------

describe("Circuit JSON: drawings", () => {
  const p = withGraphics(KICAD_BOARD_SHAPES, withLogo("top", 0))
  const { elements, notes } = projectToCircuitJson(p)
  const of = (type: string) => elements.filter((e) => e.type === type)

  it("has the silkscreen, fabrication, courtyard and copper drawings it has elements for", () => {
    expect(of("pcb_silkscreen_circle")).toHaveLength(1)
    expect(of("pcb_silkscreen_circle")[0]).toMatchObject({ center: { x: 20, y: 5 }, radius: 2, layer: "top", is_filled: true })
    // The part's silkscreen line is a line; the dashed board one is dashes as paths.
    expect(of("pcb_silkscreen_line").length).toBeGreaterThanOrEqual(1)
    expect(of("pcb_silkscreen_path").length).toBeGreaterThan(5)
    expect(of("pcb_fabrication_note_rect")).toHaveLength(2)
    expect(of("pcb_courtyard_outline")).toHaveLength(1)
    const pours = of("pcb_copper_pour")
    expect(pours.length).toBeGreaterThanOrEqual(3)
    expect(pours.some((e) => "source_net_id" in e && !!e.source_net_id)).toBe(true)
    // A copper curve is a trace of the layer, on the net's source trace.
    const traces = of("pcb_trace") as unknown as { route: { layer: string; width: number }[]; source_trace_id?: string }[]
    expect(traces.some((t) => t.route.some((r) => r.width === 0.3 && r.layer === "top") && t.source_trace_id)).toBe(true)
  })

  it("leaves out mask, paste, adhesive and user layer drawings, and says so", () => {
    expect(notes.some((n) => /Left out, since Circuit JSON has no element/.test(n))).toBe(true)
    expect(notes.join(" ")).not.toMatch(/[\u2013\u2014]/)
    // The mask polygon of the board, the mask circle of the part, the user rectangle and ellipse have no element.
    expect(JSON.stringify(elements)).not.toContain("User.3")
  })

  it("is the same as before for a board with no drawings, and the KiCad export's circuit has none of them", () => {
    const base = blinker()
    registerProjectParts(base)
    expect(JSON.stringify(projectToCircuitJson({ ...base, graphics: [] }))).toBe(JSON.stringify(projectToCircuitJson(base)))
    // The KiCad export writes the drawings itself, so the circuit it converts is the one without them.
    const options = { forKicad: true, nameAllNets: true }
    expect(JSON.stringify(projectToCircuitJson(p, options).elements)).toBe(JSON.stringify(projectToCircuitJson({ ...p, graphics: [] }, options).elements.filter(() => true)))
  })
})

// ---------- Sakura's picture ----------

describe("Sakura's SVG: drawings", () => {
  const box = { minX: -5, minY: -5, maxX: 60, maxY: 45 }
  const size = { width: 650, height: 500 }
  const svg = (p: Project, extras: string[], side: "top" | "bottom" | "both" = "top") => {
    registerProjectParts(p)
    return pcbSvg(p, box, size, { side, extras: new Set(extras) as ReadonlySet<PcbExtra> }, measurePcb(p))
  }

  it("is unchanged for a board with no drawings", () => {
    const p = blinker()
    for (const extras of [[], ["silkscreen"], ["silkscreen", "courtyards"]]) expect(svg({ ...p, graphics: [] }, extras)).toBe(svg(p, extras))
  })

  it("draws silkscreen drawings in the silk colour, only with the silkscreen option", () => {
    const p = withGraphics(KICAD_BOARD_SHAPES, withLogo("top", 0))
    const on = svg(p, ["silkscreen"])
    const off = svg(p, [])
    expect(on).toContain('stroke="#45ecff"')
    expect(on.length).toBeGreaterThan(off.length)
    expect(on).toContain('fill="#45ecff"')
    // An arc is an SVG arc.
    expect(svg(withGraphics([{ type: "arc", start: { x: 10, y: 5 }, mid: { x: 11, y: 7 }, end: { x: 13, y: 8 }, ...style("F.SilkS", 0.15) }]), ["silkscreen"])).toMatch(/d="M10 5A[\d.]+ [\d.]+ 0 0 [01] 13 8"/)
    // The bottom silkscreen is not in a view of the top.
    const back = withGraphics([{ type: "line", a: { x: 1, y: 1 }, b: { x: 3, y: 3 }, ...style("B.SilkS", 0.2) }])
    expect(svg(back, ["silkscreen"], "top")).not.toContain("#e27cff")
    expect(svg(back, ["silkscreen"], "both")).toContain("#e27cff")
  })

  it("draws copper drawings in the copper colour of their layer, whatever the options", () => {
    const top = withGraphics([{ type: "line", a: { x: 1, y: 1 }, b: { x: 3, y: 3 }, ...style("F.Cu", 0.5) }])
    expect(svg(top, [], "top")).toContain('d="M1 1L3 3" fill="none" stroke="#ff3b3b"')
    const bottom = withGraphics([{ type: "line", a: { x: 1, y: 1 }, b: { x: 3, y: 3 }, ...style("B.Cu", 0.5) }])
    expect(svg(bottom, [], "bottom")).toContain('d="M1 1L3 3" fill="none" stroke="#4a5bff"')
    expect(svg(bottom, [], "top")).not.toContain('d="M1 1L3 3"')
  })

  it("draws the muted layers with the courtyards, thin and soft", () => {
    const p = withGraphics([
      { type: "rect", a: { x: 1, y: 1 }, b: { x: 5, y: 4 }, ...style("F.Fab", 0.1) },
      { type: "circle", c: { x: 9, y: 9 }, r: 2, ...style("F.Mask", 0.5, { fill: true }) },
      { type: "line", a: { x: 1, y: 8 }, b: { x: 6, y: 9 }, ...style("Dwgs.User", 0.1) },
    ])
    expect(svg(p, ["silkscreen"])).not.toContain("rgba(175,165,200,0.8)")
    const on = svg(p, ["courtyards"])
    expect(on).toContain("rgba(175,165,200,0.8)")
    expect(on).toContain("rgba(150,175,205,0.8)")
    // Mask is drawn thin: its 0.5 mm width is cut to the 0.08 cap, and then to a pixel at least (0.1 mm here).
    expect(on).toMatch(/fill="rgba\(96,200,120,0.75\)" fill-opacity="0.4"[^>]*stroke-width="0.1"/)
  })
})

// ---------- Fabrication notes ----------

describe("fabrication notes: drawings", () => {
  const notes = (p: Project) => fabricationNotes(p, ["a.gtl"], getPcbAnalysis(p).items)

  it("say nothing of drawings for a board that has none", () => {
    expect(notes(blinker())).not.toContain("DRAWINGS")
  })

  it("name the files drawings went to and the layers that were not plotted", () => {
    const text = notes(withGraphics(KICAD_BOARD_SHAPES, withLogo("top", 0)))
    expect(text).toContain("DRAWINGS")
    expect(text).toMatch(/Top silkscreen\s+\d+: in the top silkscreen file/)
    expect(text).toMatch(/Bottom copper\s+1: /)
    expect(text).toMatch(/Not plotted\s+.*fabrication \d+/)
    expect(text).toMatch(/user 2/)
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })

  it("count a part not placed apart", () => {
    expect(notes(withLogo("top", 0, false))).toMatch(/Not on the PCB\s+8/)
  })
})
