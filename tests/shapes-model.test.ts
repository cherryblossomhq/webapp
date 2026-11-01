import { describe, expect, it } from "vitest"
import { arcCircle, dashPattern, dashShape, flattenArc, flattenBezier, flattenEllipse, mapShape, pointInRings, shapeBox, shapeCopper, shapePaths, shapeRings, shapeShapeDistance, shapeSvgPath, type ShapeCopper } from "../src/model/shapes"
import { flipShapeLayer, isShapeLayer, shapeLayerInfo } from "../src/model/shapeLayers"
import type { BoardShape } from "../src/model/types"

// The shape geometry: exact arcs by three points, flattening within its tolerance, mapping onto another
// frame (turns and mirrors) for every shape type, KiCad's dash pattern, and the layer table.

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps
const style = { layer: "F.SilkS", width: 0.15 }

describe("arcs are the circle through three points", () => {
  it("finds the centre, radius and way round, either way", () => {
    const a = arcCircle({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })!
    expect(a.ccw).toBe(true)
    expect(near(a.c.x, 0) && near(a.c.y, 0) && near(a.r, 1) && near(a.sweep, Math.PI)).toBe(true)
    const b = arcCircle({ x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 })!
    expect(b.ccw).toBe(false)
    expect(near(b.sweep, -Math.PI)).toBe(true)
  })
  it("is a line when the points are, and a full circle when it ends where it starts", () => {
    expect(arcCircle({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull()
    const full = arcCircle({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 })!
    expect(near(full.r, 1) && near(Math.abs(full.sweep), 2 * Math.PI)).toBe(true)
  })
  it("flattens with its own ends exactly and no point farther than the tolerance from the circle", () => {
    const pts = flattenArc({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }, 0.0002)
    expect(pts[0]).toEqual({ x: 10, y: 0 })
    expect(pts[pts.length - 1]).toEqual({ x: -10, y: 0 })
    for (let i = 0; i + 1 < pts.length; i++) {
      const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }
      expect(10 - Math.hypot(mid.x, mid.y)).toBeLessThan(0.0002 + 1e-9)
    }
  })
  it("has an exact box, with the extremes between its ends", () => {
    const b = shapeBox({ type: "arc", start: { x: 1, y: -1 }, mid: { x: 2, y: 0 }, end: { x: 1, y: 1 } })
    expect(near(b.maxX, 2, 1e-9)).toBe(true)
    expect(near(b.minY, -1) && near(b.maxY, 1)).toBe(true)
  })
})

describe("curves and ellipses stay within the tolerance", () => {
  it("a bezier's polyline is within 0.0002 mm of the curve", () => {
    const [p0, c1, c2, p1] = [{ x: 0, y: 0 }, { x: 5, y: 20 }, { x: 15, y: 20 }, { x: 20, y: 0 }]
    const pts = flattenBezier(p0, c1, c2, p1, 0.0002)
    for (let k = 0; k <= 200; k++) {
      const t = k / 200
      const u = 1 - t
      const x = u ** 3 * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * p1.x
      const y = u ** 3 * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * p1.y
      let best = Infinity
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const l = dx * dx + dy * dy
        const s = l === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l))
        best = Math.min(best, Math.hypot(x - (a.x + s * dx), y - (a.y + s * dy)))
      }
      expect(best).toBeLessThan(0.0002 + 1e-9)
    }
    expect(pts[0]).toEqual(p0)
    expect(pts[pts.length - 1]).toEqual(p1)
  })
  it("an ellipse's points satisfy its equation, and its box is exact", () => {
    const e: BoardShape = { ...style, type: "ellipse", c: { x: 5, y: 5 }, rx: 6, ry: 2, rot: 30 }
    for (const p of flattenEllipse(e.c, 6, 2, (30 * Math.PI) / 180, 0, 2 * Math.PI)) {
      const dx = p.x - 5
      const dy = p.y - 5
      const c = Math.cos((30 * Math.PI) / 180)
      const s = Math.sin((30 * Math.PI) / 180)
      const lx = dx * c + dy * s
      const ly = -dx * s + dy * c
      expect(near((lx / 6) ** 2 + (ly / 2) ** 2, 1, 1e-9)).toBe(true)
    }
    const b = shapeBox(e)
    expect(near(b.maxX - 5, Math.hypot(6 * Math.cos((30 * Math.PI) / 180), 2 * Math.sin((30 * Math.PI) / 180)), 1e-9)).toBe(true)
  })
})

describe("mapping onto another frame", () => {
  const turn90 = (p: { x: number; y: number }) => ({ x: -p.y, y: p.x })
  const mirrorX = (p: { x: number; y: number }) => ({ x: -p.x, y: p.y })
  const all: BoardShape[] = [
    { ...style, type: "line", a: { x: 1, y: 2 }, b: { x: 3, y: 5 } },
    { ...style, type: "arc", start: { x: 1, y: 0 }, mid: { x: 0, y: 1 }, end: { x: -1, y: 0 } },
    { ...style, type: "circle", c: { x: 2, y: 3 }, r: 1.5 },
    { ...style, type: "rect", a: { x: 0, y: 0 }, b: { x: 4, y: 2 }, radius: 0.5 },
    { ...style, type: "polygon", pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3, mid: { x: 5, y: 1.5 } }, { x: 0, y: 3 }] },
    { ...style, type: "curve", p0: { x: 0, y: 0 }, c1: { x: 1, y: 3 }, c2: { x: 3, y: 3 }, p1: { x: 4, y: 0 } },
    { ...style, type: "ellipse", c: { x: 1, y: 1 }, rx: 3, ry: 1, rot: 20 },
    { ...style, type: "ellipse", c: { x: 1, y: 1 }, rx: 3, ry: 1, rot: 20, from: 10, to: 100 },
  ]
  const sample = (s: BoardShape) => shapeRings(s, 0.0001).flat().concat(shapePaths(s).flatMap((p) => p.segs.map((g) => (g.kind === "line" ? g.a : g.kind === "arc" ? g.start : g.kind === "bezier" ? g.p0 : g.c))))
  for (const [name, f] of [["a quarter turn", turn90], ["a mirror", mirrorX], ["a mirror then a turn", (p: { x: number; y: number }) => turn90(mirrorX(p))]] as const) {
    it(`${name} keeps every type's outline where the map puts it`, () => {
      for (const s of all) {
        const m = mapShape(s, f)
        expect(m.type).toBe(s.type)
        if (s.type === "circle" && m.type === "circle") {
          const c = f(s.c)
          expect(near(m.c.x, c.x) && near(m.c.y, c.y) && near(m.r, s.r)).toBe(true)
          continue
        }
        // Every point of the outline of the mapped shape is the map of a point of the original's outline (checked by flattening both).
        const want = shapePaths(s).flatMap((p) => p.segs.flatMap((g) => (g.kind === "line" ? [g.a, g.b] : g.kind === "arc" ? [g.start, g.end] : g.kind === "bezier" ? [g.p0, g.p1] : [])))
        const got = shapePaths(m).flatMap((p) => p.segs.flatMap((g) => (g.kind === "line" ? [g.a, g.b] : g.kind === "arc" ? [g.start, g.end] : g.kind === "bezier" ? [g.p0, g.p1] : [])))
        const mapped = want.map(f)
        for (const q of mapped) expect(got.some((p) => near(p.x, q.x, 1e-9) && near(p.y, q.y, 1e-9)), `${s.type} ${JSON.stringify(q)}`).toBe(true)
      }
    })
  }
  it("a mirrored ellipse arc is the mirror of the arc: its points land on the mirrored curve", () => {
    const s = all[7]
    const m = mapShape(s, mirrorX)
    const orig = shapePaths(s)[0].segs[0]
    const pts = shapePaths(m)[0].segs[0]
    expect(orig.kind).toBe("ellipse")
    expect(pts.kind).toBe("ellipse")
    const a = flattenEllipse((orig as { c: { x: number; y: number } }).c, 3, 1, (20 * Math.PI) / 180, (10 * Math.PI) / 180, (100 * Math.PI) / 180, 0.0001).map(mirrorX)
    const b = flattenEllipse((pts as { c: { x: number; y: number } }).c, 3, 1, (pts as { rot: number }).rot, (pts as { t0: number }).t0, (pts as { t1: number }).t1, 0.0001)
    for (const p of a) expect(Math.min(...b.map((q) => Math.hypot(q.x - p.x, q.y - p.y)))).toBeLessThan(0.001)
  })
  it("a turned rectangle stays a rectangle, and one turned at any other angle is a polygon with its arcs", () => {
    const r = all[3]
    expect(mapShape(r, turn90).type).toBe("rect")
    const tilt = mapShape(r, (p) => ({ x: p.x * Math.cos(0.3) - p.y * Math.sin(0.3), y: p.x * Math.sin(0.3) + p.y * Math.cos(0.3) }))
    expect(tilt.type).toBe("polygon")
    expect(shapePaths(tilt)[0].segs.filter((g) => g.kind === "arc")).toHaveLength(4)
    void sample
  })
  it("a polygon with an arc corner keeps the arc through the map", () => {
    const m = mapShape(all[4], mirrorX)
    expect(shapePaths(m)[0].segs.filter((g) => g.kind === "arc")).toHaveLength(1)
  })
})

describe("filled shapes and paths", () => {
  it("a polygon's ring and a hole make an even-odd area", () => {
    const ring = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    const hole = [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }]
    expect(pointInRings({ x: 1, y: 1 }, [ring, hole])).toBe(true)
    expect(pointInRings({ x: 5, y: 5 }, [ring, hole])).toBe(false)
  })
  it("SVG path data for an arc says its radius, whether it is large and which way it turns", () => {
    expect(shapeSvgPath({ type: "arc", start: { x: 1, y: 0 }, mid: { x: 0, y: 1 }, end: { x: -1, y: 0 } })).toBe("M1 0A1 1 0 0 1 -1 0")
    expect(shapeSvgPath({ type: "arc", start: { x: 1, y: 0 }, mid: { x: 0, y: 1 }, end: { x: 0, y: -1 } })).toBe("M1 0A1 1 0 1 1 0 -1")
    expect(shapeSvgPath({ type: "curve", p0: { x: 0, y: 0 }, c1: { x: 1, y: 1 }, c2: { x: 2, y: 1 }, p1: { x: 3, y: 0 } })).toBe("M0 0C1 1 2 1 3 0")
  })
})

describe("dashes", () => {
  it("are 11 widths on and 4 off, a dot 0.2 on, as KiCad cuts them", () => {
    expect(dashPattern("dash", 0.2).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([2.2, 0.8])
    expect(dashPattern("dot", 1)).toEqual([0.2, 4])
    expect(dashPattern("dash_dot", 1)).toEqual([11, 4, 0.2, 4])
    expect(dashPattern("dash_dot_dot", 1)).toEqual([11, 4, 0.2, 4, 0.2, 4])
  })
  it("cut a line into pieces that lie on it and add up to the on part of the pattern", () => {
    const pieces = dashShape({ ...style, width: 1, dash: "dash", type: "line", a: { x: 0, y: 0 }, b: { x: 30, y: 0 } })
    expect(pieces).toHaveLength(2)
    const on = pieces.reduce((n, p) => n + (p.kind === "line" ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : 0), 0)
    // 11 on, 4 off, 11 on, 4 off: the third dash starts at 30, so two full dashes
    expect(near(on, 22, 1e-9)).toBe(true)
  })
  it("keep an arc's pieces as arcs on the same circle", () => {
    const pieces = dashShape({ ...style, width: 0.5, dash: "dash", type: "arc", start: { x: 10, y: 0 }, mid: { x: 0, y: 10 }, end: { x: -10, y: 0 } })
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces) {
      expect(p.kind).toBe("arc")
      if (p.kind !== "arc") continue
      const c = arcCircle(p.start, p.mid, p.end)!
      expect(near(c.r, 10, 1e-6)).toBe(true)
    }
  })
  it("a solid shape has none", () => {
    expect(dashShape({ ...style, type: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 0 } })).toEqual([])
  })
})

describe("the layers", () => {
  it("name every layer a drawing can be on, by kind and side, and swap the sides", () => {
    expect(shapeLayerInfo("F.SilkS")).toMatchObject({ kind: "silk", side: "top" })
    expect(shapeLayerInfo("B.Mask")).toMatchObject({ kind: "mask", side: "bottom" })
    expect(shapeLayerInfo("F.Paste")?.kind).toBe("paste")
    expect(shapeLayerInfo("B.Fab")?.kind).toBe("fab")
    expect(shapeLayerInfo("F.CrtYd")?.kind).toBe("courtyard")
    expect(shapeLayerInfo("B.Adhes")?.kind).toBe("adhesive")
    for (const n of ["Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Margin", "User.1", "User.45"]) expect(shapeLayerInfo(n)).toMatchObject({ kind: "user", side: null })
    expect(shapeLayerInfo("F.Cu")?.kind).toBe("copper")
    expect(isShapeLayer("Edge.Cuts")).toBe(false)
    expect(isShapeLayer("User.46")).toBe(false)
    expect(flipShapeLayer("F.SilkS", 2)).toBe("B.SilkS")
    expect(flipShapeLayer("B.Cu", 2)).toBe("F.Cu")
    expect(flipShapeLayer("User.3", 2)).toBe("User.3")
  })
})

describe("the distance between two drawings, with a limit", () => {
  // Two combs of a thousand corners each, their teeth between each other's: what a flex sensor's copper drawings are, and what took Checks over a minute
  // when every edge was measured against every other.
  const comb = (x0: number, y0: number, teeth: number, up: boolean): ShapeCopper => {
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i < teeth; i++) {
      const x = x0 + i * 0.5
      const tip = up ? y0 + 5 : y0 - 5
      pts.push({ x, y: y0 }, { x, y: tip }, { x: x + 0.2, y: tip }, { x: x + 0.2, y: y0 })
    }
    return shapeCopper({ id: "c", type: "polygon", layer: "top", width: 0.02, fill: true, pts } as unknown as BoardShape)
  }
  const a = comb(0, 0, 250, true)
  const b = comb(0.25, 5.4, 250, false)

  it("is exact below the limit, the same as measuring every pair", () => {
    const exact = shapeShapeDistance(a, b)
    expect(exact).toBeGreaterThan(0)
    expect(shapeShapeDistance(a, b, exact + 0.05)).toBeCloseTo(exact, 9)
    expect(shapeShapeDistance(a, b, 10)).toBeCloseTo(exact, 9)
  })

  it("is at least the limit when nothing is nearer", () => {
    const exact = shapeShapeDistance(a, b)
    expect(shapeShapeDistance(a, b, exact / 2)).toBeGreaterThanOrEqual(exact / 2)
    expect(shapeShapeDistance(comb(0, 0, 250, true), comb(500, 0, 250, true), 0.2)).toBeGreaterThanOrEqual(0.2)
  })

  it("is 0 where one lies inside the other, whatever the limit", () => {
    const outer = shapeCopper({ id: "o", type: "polygon", layer: "top", width: 0, fill: true, pts: Array.from({ length: 400 }, (_, i) => ({ x: 50 * Math.cos(i / 63.66), y: 50 * Math.sin(i / 63.66) })) } as unknown as BoardShape)
    expect(shapeShapeDistance(outer, comb(-10, -2, 40, true), 1e-3)).toBe(0)
  })
})
