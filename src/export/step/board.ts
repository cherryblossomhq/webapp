// The board as an exact solid: a rounded rectangle extruded to the board's thickness, with its
// drills cut through. Top and bottom are planes bounded by the outline and every hole; the sides
// are a plane per straight edge and a cylinder per corner; a round hole is two half cylinders
// and a slot two planes and two half cylinders, so no face needs a seam edge.
//
// OCCT (FreeCAD, KiCad's viewer) takes time quadratic in the holes of one face to read it: a
// face with 3,000 holes took a minute, ten faces of 100 a fraction of that. So a board with many
// holes has its top and bottom cut into strips of about STRIP holes, along lines across the board
// that pass between holes; with fewer, they are one face each.

import { len } from "./format"
import type { StepBoardInput, StepColor, StepContourSeg, StepHole, StepPoint } from "./types"
import { refs, type Shape, type StepWriter } from "./writer"

/** Cut edges and hole walls: the tan of bare FR4. */
export const FR4: StepColor = { r: 0.8, g: 0.72, b: 0.53 }

/** Holes closer than this to each other or the edge would share edges with them: left out. */
const GAP = 1e-3
const EPS = 1e-6
/** Holes per face of the top and bottom, about, once there are more than 1.5 times this. */
const STRIP = 100

type Seg =
  | { kind: "line"; a: StepPoint; b: StepPoint }
  /** Counter-clockwise from `a` to `b` about `c`; `ref` is the direction of the circle's angle 0. */
  | { kind: "arc"; a: StepPoint; b: StepPoint; c: StepPoint; r: number; ref: StepPoint; circle: string }

/** A closed profile, counter-clockwise seen from +z, whether it's the outline or a hole. */
interface Profile {
  segs: Seg[]
  hole: boolean
}

const pt = (x: number, y: number): StepPoint => ({ x, y })

const cornerRadius = (o: StepBoardInput["outline"]) => Math.min(Math.max(o.cornerRadius, 0), o.width / 2, o.height / 2)

/**
 * The outline, starting with its bottom edge. With `splits` (x positions across the straight
 * part), the bottom and top edges are cut there: `bottom[k]` and `top[k]` are the segments of
 * strip k.
 */
function outlineProfile(o: StepBoardInput["outline"], splits: number[]): Profile & { bottom: number[]; top: number[] } {
  const hw = o.width / 2
  const hh = o.height / 2
  const r = cornerRadius(o)
  const round = r >= EPS
  const [x0, x1, y0, y1] = [o.x - hw, o.x + hw, o.y - hh, o.y + hh]
  const segs: Seg[] = []
  const line = (a: StepPoint, b: StepPoint) => {
    if (Math.hypot(b.x - a.x, b.y - a.y) <= EPS) return -1
    segs.push({ kind: "line", a, b })
    return segs.length - 1
  }
  const arc = (a: StepPoint, b: StepPoint, c: StepPoint, ref: StepPoint, i: number) => {
    if (round) segs.push({ kind: "arc", a, b, c, r, ref, circle: `corner${i}` })
  }
  const rr = round ? r : 0
  const xs = [x0 + rr, ...splits, x1 - rr]
  const bottom = xs.slice(1).map((x, k) => line(pt(xs[k], y0), pt(x, y0)))
  arc(pt(x1 - r, y0), pt(x1, y0 + r), pt(x1 - r, y0 + r), pt(0, -1), 0)
  line(pt(x1, y0 + rr), pt(x1, y1 - rr))
  arc(pt(x1, y1 - r), pt(x1 - r, y1), pt(x1 - r, y1 - r), pt(1, 0), 1)
  const top: number[] = []
  for (let k = xs.length - 2; k >= 0; k--) top[k] = line(pt(xs[k + 1], y1), pt(xs[k], y1))
  arc(pt(x0 + r, y1), pt(x0, y1 - r), pt(x0 + r, y1 - r), pt(0, 1), 2)
  line(pt(x0, y1 - rr), pt(x0, y0 + rr))
  arc(pt(x0, y0 + r), pt(x0 + r, y0), pt(x0 + r, y0 + r), pt(-1, 0), 3)
  return { segs, hole: false, bottom, top }
}

/** A hole as the segment its centre line runs along (a point for a round one) and a radius. */
interface Capsule {
  a: StepPoint
  b: StepPoint
  r: number
  /** The piece of a board with `regions` it is cut from. */
  region?: number
}

function capsule(h: StepHole): Capsule {
  const r = h.diameter / 2
  if (!h.slot) return { a: pt(h.x, h.y), b: pt(h.x, h.y), r, region: h.region }
  return { a: h.slot.a, b: h.slot.b, r, region: h.region }
}

function holeProfile(c: Capsule, i: number): Profile {
  const { a, b, r } = c
  const l = Math.hypot(b.x - a.x, b.y - a.y)
  const circle = `hole${i}`
  if (l < EPS) {
    const right = pt(a.x + r, a.y)
    const left = pt(a.x - r, a.y)
    const ref = pt(1, 0)
    return {
      hole: true,
      segs: [
        { kind: "arc", a: right, b: left, c: a, r, ref, circle },
        { kind: "arc", a: left, b: right, c: a, r, ref, circle },
      ],
    }
  }
  const u = pt((b.x - a.x) / l, (b.y - a.y) / l)
  const p = pt(-u.y, u.x)
  const off = (q: StepPoint, s: number) => pt(q.x + p.x * r * s, q.y + p.y * r * s)
  return {
    hole: true,
    segs: [
      { kind: "line", a: off(a, -1), b: off(b, -1) },
      { kind: "arc", a: off(b, -1), b: off(b, 1), c: b, r, ref: pt(-p.x, -p.y), circle: `${circle}b` },
      { kind: "line", a: off(b, 1), b: off(a, 1) },
      { kind: "arc", a: off(a, 1), b: off(a, -1), c: a, r, ref: p, circle: `${circle}a` },
    ],
  }
}

/** Signed distance from a point to the outline: negative inside. */
function outlineDistance(o: StepBoardInput["outline"], p: StepPoint): number {
  const r = cornerRadius(o)
  const qx = Math.abs(p.x - o.x) - (o.width / 2 - r)
  const qy = Math.abs(p.y - o.y) - (o.height / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function pointSegment(p: StepPoint, a: StepPoint, b: StepPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

function segmentsCross(a: StepPoint, b: StepPoint, c: StepPoint, d: StepPoint): boolean {
  const side = (p: StepPoint, q: StepPoint, r: StepPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = side(c, d, a)
  const d2 = side(c, d, b)
  const d3 = side(a, b, c)
  const d4 = side(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function capsuleDistance(p: Capsule, q: Capsule): number {
  const between = segmentsCross(p.a, p.b, q.a, q.b)
    ? 0
    : Math.min(pointSegment(p.a, q.a, q.b), pointSegment(p.b, q.a, q.b), pointSegment(q.a, p.a, p.b), pointSegment(q.b, p.a, p.b))
  return between - p.r - q.r
}

export interface BoardHoles {
  kept: Capsule[]
  invalid: number
  overlapping: number
  atEdge: number
}

/**
 * The holes the solid can have: inside the outline, clear of each other. Where two overlap, the
 * bigger one is kept.
 */
export function boardHoles(board: StepBoardInput): BoardHoles {
  let invalid = 0
  let overlapping = 0
  let atEdge = 0
  const candidates: { c: Capsule; area: number; i: number }[] = []
  board.holes.forEach((h, i) => {
    const c = capsule(h)
    const finite = [c.a.x, c.a.y, c.b.x, c.b.y, c.r].every(Number.isFinite)
    if (!finite || c.r * 2 < GAP) {
      invalid++
      return
    }
    // With an outline of its own the caller has already measured each drill against it and says which piece it is in (or -1).
    const reaches = board.outline.regions ? c.region === undefined || c.region < 0 : outlineDistance(board.outline, c.a) > -(c.r + GAP) || outlineDistance(board.outline, c.b) > -(c.r + GAP)
    if (reaches) {
      atEdge++
      return
    }
    const l = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y)
    candidates.push({ c, area: Math.PI * c.r * c.r + 2 * c.r * l, i })
  })
  candidates.sort((p, q) => q.area - p.area || p.i - q.i)

  // A grid of the holes kept so far, so each candidate is checked against its neighbours only.
  const cell = 2
  const grid = new Map<string, Capsule[]>()
  const cells = (c: Capsule, pad: number, visit: (key: string) => boolean | void) => {
    const x0 = Math.floor((Math.min(c.a.x, c.b.x) - c.r - pad) / cell)
    const x1 = Math.floor((Math.max(c.a.x, c.b.x) + c.r + pad) / cell)
    const y0 = Math.floor((Math.min(c.a.y, c.b.y) - c.r - pad) / cell)
    const y1 = Math.floor((Math.max(c.a.y, c.b.y) + c.r + pad) / cell)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (visit(`${x},${y}`)) return true
    return false
  }
  const kept: { c: Capsule; i: number }[] = []
  for (const { c, i } of candidates) {
    const hit = cells(c, GAP, (key) => grid.get(key)?.some((o) => capsuleDistance(c, o) < GAP))
    if (hit) {
      overlapping++
      continue
    }
    kept.push({ c, i })
    cells(c, 0, (key) => {
      const list = grid.get(key)
      if (list) list.push(c)
      else grid.set(key, [c])
    })
  }
  kept.sort((p, q) => p.i - q.i)
  return { kept: kept.map((k) => k.c), invalid, overlapping, atEdge }
}

/**
 * Where to cut the top and bottom across x, between holes (never through one), so that each
 * strip has about STRIP of them. None for a board with few holes.
 */
function stripSplits(o: StepBoardInput["outline"], holes: Capsule[]): number[] {
  if (holes.length <= STRIP * 1.5) return []
  const r = cornerRadius(o) >= EPS ? cornerRadius(o) : 0
  const lo = o.x - o.width / 2 + r + GAP
  const hi = o.x + o.width / 2 - r - GAP
  const spans = holes
    .map((c) => [Math.min(c.a.x, c.b.x) - c.r - GAP, Math.max(c.a.x, c.b.x) + c.r + GAP])
    .sort((p, q) => p[0] - q[0])
  const splits: number[] = []
  let count = 0
  let reach = -Infinity
  spans.forEach(([start, end], i) => {
    // A gap between every hole so far and the next one, and enough left for a strip of its own.
    if (count >= STRIP && start > reach && spans.length - i > STRIP / 2) {
      const at = (reach + start) / 2
      if (at > lo && at < hi && (!splits.length || at - splits[splits.length - 1] > 10 * GAP)) {
        splits.push(at)
        count = 0
      }
    }
    count++
    reach = Math.max(reach, end)
  })
  return splits
}

/** Writes the board's product, solid and colours; the caller places it in the assembly. */
export function writeBoard(w: StepWriter, board: StepBoardInput, holes: Capsule[]): Shape {
  if (board.outline.regions) return writeRegions(w, board, holes)
  const t = board.thickness > EPS ? board.thickness : 1.6
  const o = board.outline
  const splits = stripSplits(o, holes)
  const outline = outlineProfile(o, splits)
  const profiles = [outline, ...holes.map(holeProfile)]
  const zAxis = w.dir(0, 0, 1)
  const up = w.add(`VECTOR('',#${zAxis},${len(t)})`)

  const vertices = new Map<string, number>()
  const vertex = (p: StepPoint, z: number) => {
    const key = `${len(p.x)},${len(p.y)},${z}`
    let id = vertices.get(key)
    if (id === undefined) {
      id = w.add(`VERTEX_POINT('',#${w.point(p.x, p.y, z)})`)
      vertices.set(key, id)
    }
    return id
  }
  const circles = new Map<string, number>()
  const circle = (s: Extract<Seg, { kind: "arc" }>, z: number) => {
    const key = `${s.circle}@${z}`
    let id = circles.get(key)
    if (id === undefined) {
      const at = w.placement(w.point(s.c.x, s.c.y, z), zAxis, w.dir(s.ref.x, s.ref.y, 0))
      id = w.add(`CIRCLE('',#${at},${len(s.r)})`)
      circles.set(key, id)
    }
    return id
  }
  const cylinders = new Map<string, number>()
  const edge = (from: number, to: number, curve: number) => w.add(`EDGE_CURVE('',#${from},#${to},#${curve},.T.)`)
  const line = (a: StepPoint, b: StepPoint, z: number) => {
    const v = w.add(`VECTOR('',#${w.dir(b.x - a.x, b.y - a.y, 0)},${len(Math.hypot(b.x - a.x, b.y - a.y))})`)
    return edge(vertex(a, z), vertex(b, z), w.add(`LINE('',#${w.point(a.x, a.y, z)},#${v})`))
  }
  const curved = (s: Seg, z: number) => (s.kind === "arc" ? edge(vertex(s.a, z), vertex(s.b, z), circle(s, z)) : line(s.a, s.b, z))
  const oriented = (e: number, forward: boolean) => w.add(`ORIENTED_EDGE('',*,*,#${e},${forward ? ".T." : ".F."})`)
  const loop = (edges: [number, boolean][]) => w.add(`EDGE_LOOP('',${refs(edges.map(([e, f]) => oriented(e, f)))})`)
  const bound = (l: number, outer: boolean) => w.add(`${outer ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',#${l},.T.)`)

  const strips = splits.length + 1
  const stripOf = (c: Capsule) => splits.filter((s) => s < c.a.x).length
  const topHoles: number[][] = Array.from({ length: strips }, () => [])
  const bottomHoles: number[][] = Array.from({ length: strips }, () => [])
  let outlineTops: number[] = []
  let outlineBottoms: number[] = []
  const walls: number[] = []
  profiles.forEach((profile, p) => {
    const { segs, hole } = profile
    const n = segs.length
    const verticals = segs.map((s) => {
      const vertical = w.add(`LINE('',#${w.point(s.a.x, s.a.y, 0)},#${up})`)
      return edge(vertex(s.a, 0), vertex(s.a, t), vertical)
    })
    const bottoms = segs.map((s) => curved(s, 0))
    const tops = segs.map((s) => curved(s, t))
    segs.forEach((s, i) => {
      const next = verticals[(i + 1) % n]
      const wall = hole
        ? loop([[verticals[i], true], [tops[i], true], [next, false], [bottoms[i], false]])
        : loop([[bottoms[i], true], [next, true], [tops[i], false], [verticals[i], false]])
      let surface: number
      if (s.kind === "line") {
        const dx = s.b.x - s.a.x
        const dy = s.b.y - s.a.y
        const normal = hole ? w.dir(-dy, dx, 0) : w.dir(dy, -dx, 0)
        surface = w.add(`PLANE('',#${w.placement(w.point(s.a.x, s.a.y, 0), normal, w.dir(dx, dy, 0))})`)
      } else {
        const known = cylinders.get(s.circle)
        surface =
          known ??
          w.add(`CYLINDRICAL_SURFACE('',#${w.placement(w.point(s.c.x, s.c.y, 0), zAxis, w.dir(s.ref.x, s.ref.y, 0))},${len(s.r)})`)
        cylinders.set(s.circle, surface)
      }
      // A hole's wall faces into the hole, against the cylinder's own outward normal.
      const sense = s.kind === "arc" && hole ? ".F." : ".T."
      walls.push(w.add(`ADVANCED_FACE('',(#${bound(wall, true)}),#${surface},${sense})`))
    })
    if (!hole) {
      outlineTops = tops
      outlineBottoms = bottoms
      return
    }
    const k = stripOf(holes[p - 1])
    topHoles[k].push(bound(loop(tops.map((e) => [e, false] as [number, boolean]).reverse()), false))
    bottomHoles[k].push(bound(loop(bottoms.map((e) => [e, true] as [number, boolean])), false))
  })

  // Each strip's outline, counter-clockwise from +z: outline segments and the cuts between strips.
  type Step = { seg: number } | { split: number; up: boolean }
  const y0 = o.y - o.height / 2
  const y1 = o.y + o.height / 2
  const cuts = (z: number) => splits.map((x) => line(pt(x, y0), pt(x, y1), z))
  const topCuts = cuts(t)
  const bottomCuts = cuts(0)
  const stripSteps = (k: number): Step[] => {
    const n = splits.length
    const all = outline.segs.map((_, i) => ({ seg: i }))
    if (!n) return all
    const { bottom, top } = outline
    if (k === 0) return [{ seg: bottom[0] }, { split: 0, up: true }, ...all.slice(top[0])]
    if (k === n) return [...all.slice(bottom[n], top[n] + 1), { split: n - 1, up: false }]
    return [{ seg: bottom[k] }, { split: k, up: true }, { seg: top[k] }, { split: k - 1, up: false }]
  }
  const { x, y } = o
  const topPlane = w.add(`PLANE('',#${w.placement(w.point(x, y, t), zAxis, w.dir(1, 0, 0))})`)
  const bottomPlane = w.add(`PLANE('',#${w.placement(w.point(x, y, 0), w.dir(0, 0, -1), w.dir(1, 0, 0))})`)
  const faces: number[] = []
  for (let k = 0; k < strips; k++) {
    const steps = stripSteps(k)
    const top = steps.map((s): [number, boolean] => ("seg" in s ? [outlineTops[s.seg], true] : [topCuts[s.split], s.up]))
    const bottom = steps
      .map((s): [number, boolean] => ("seg" in s ? [outlineBottoms[s.seg], false] : [bottomCuts[s.split], !s.up]))
      .reverse()
    faces.push(w.add(`ADVANCED_FACE('',${refs([bound(loop(top), true), ...topHoles[k]])},#${topPlane},.T.)`))
    faces.push(w.add(`ADVANCED_FACE('',${refs([bound(loop(bottom), true), ...bottomHoles[k]])},#${bottomPlane},.T.)`))
  }
  faces.push(...walls)
  const shell = w.add(`CLOSED_SHELL('',${refs(faces)})`)
  const solid = w.add(`MANIFOLD_SOLID_BREP('PCB',#${shell})`)
  const origin = w.origin()
  const ctx = w.contexts.geometry
  const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('PCB',(#${origin},#${solid}),#${ctx})`)
  const styled = [w.style(solid, board.color), ...walls.map((f) => w.style(f, FR4))]
  w.presentation(styled, ctx)
  const product = w.product("PCB")
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${product.shape},#${rep})`)
  return { definition: product.definition, rep, origin }
}


// ---------- a board with an outline of its own ----------

type RegionSeg = StepContourSeg

/** A contour run the other way: pieces in reverse, each from its far end to its near, an arc turning the other way. */
function reversed(segs: RegionSeg[]): RegionSeg[] {
  return segs
    .map((s): RegionSeg => (s.kind === "line" ? { kind: "line", a: s.b, b: s.a } : { kind: "arc", a: s.b, b: s.a, c: s.c, r: s.r, ccw: !s.ccw }))
    .reverse()
}

/** A rectangle-board profile piece as a contour piece: an arc there is always counter-clockwise. */
function toContour(s: Seg): RegionSeg {
  return s.kind === "line" ? s : { kind: "arc", a: s.a, b: s.b, c: s.c, r: s.r, ccw: true }
}

/**
 * The board when it is not a rounded rectangle: one solid for each piece of it (`regions`), each an outline of lines and circular
 * arcs, with the cutouts inside it and the drills in it cut through. Top and bottom are a plane each, bounded by the outline and
 * every hole; a wall is a plane per straight piece and a cylinder per arc, which may turn either way (a concave corner). Nothing
 * is cut into strips, so a very large number of holes in one piece is slow for a reader that is quadratic in them.
 */
function writeRegions(w: StepWriter, board: StepBoardInput, holes: Capsule[]): Shape {
  const t = board.thickness > EPS ? board.thickness : 1.6
  const regions = board.outline.regions!
  const zAxis = w.dir(0, 0, 1)
  const up = w.add(`VECTOR('',#${zAxis},${len(t)})`)
  const vertices = new Map<string, number>()
  const vertex = (p: StepPoint, z: number) => {
    const key = `${len(p.x)},${len(p.y)},${z}`
    let id = vertices.get(key)
    if (id === undefined) {
      id = w.add(`VERTEX_POINT('',#${w.point(p.x, p.y, z)})`)
      vertices.set(key, id)
    }
    return id
  }
  const edge = (from: number, to: number, curve: number, same = true) => w.add(`EDGE_CURVE('',#${from},#${to},#${curve},${same ? ".T." : ".F."})`)
  const line = (a: StepPoint, b: StepPoint, z: number) => {
    const v = w.add(`VECTOR('',#${w.dir(b.x - a.x, b.y - a.y, 0)},${len(Math.hypot(b.x - a.x, b.y - a.y))})`)
    return edge(vertex(a, z), vertex(b, z), w.add(`LINE('',#${w.point(a.x, a.y, z)},#${v})`))
  }
  const oriented = (e: number, forward: boolean) => w.add(`ORIENTED_EDGE('',*,*,#${e},${forward ? ".T." : ".F."})`)
  const loop = (edges: [number, boolean][]) => w.add(`EDGE_LOOP('',${refs(edges.map(([e, f]) => oriented(e, f)))})`)
  const bound = (l: number, outer: boolean) => w.add(`${outer ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',#${l},.T.)`)
  const topPlane = w.add(`PLANE('',#${w.placement(w.point(0, 0, t), zAxis, w.dir(1, 0, 0))})`)
  const bottomPlane = w.add(`PLANE('',#${w.placement(w.point(0, 0, 0), w.dir(0, 0, -1), w.dir(1, 0, 0))})`)

  const solids: number[] = []
  const walls: number[] = []
  const style: number[] = []
  const origin = w.origin()
  const ctx = w.contexts.geometry
  regions.forEach((region, ri) => {
    const faces: number[] = []
    const topHoles: number[] = []
    const bottomHoles: number[] = []
    let outerTops: number[] = []
    let outerBottoms: number[] = []
    // Every profile is counter-clockwise from +z, as the rectangle's are: the cutouts, written clockwise, are turned round.
    const profiles: { segs: RegionSeg[]; hole: boolean }[] = [
      { segs: region.outer, hole: false },
      ...region.holes.map((h) => ({ segs: reversed(h), hole: true })),
      ...holes.filter((c) => c.region === ri).map((c) => ({ segs: holeProfile(c, 0).segs.map(toContour), hole: true })),
    ]
    profiles.forEach(({ segs, hole }) => {
      const n = segs.length
      const verticals = segs.map((s) => edge(vertex(s.a, 0), vertex(s.a, t), w.add(`LINE('',#${w.point(s.a.x, s.a.y, 0)},#${up})`)))
      const curve = (s: RegionSeg, z: number) => {
        if (s.kind === "line") return line(s.a, s.b, z)
        const at = w.placement(w.point(s.c.x, s.c.y, z), zAxis, w.dir(s.a.x - s.c.x, s.a.y - s.c.y, 0))
        return edge(vertex(s.a, z), vertex(s.b, z), w.add(`CIRCLE('',#${at},${len(s.r)})`), s.ccw)
      }
      const bottoms = segs.map((s) => curve(s, 0))
      const tops = segs.map((s) => curve(s, t))
      segs.forEach((s, i) => {
        const next = verticals[(i + 1) % n]
        const wall = hole
          ? loop([[verticals[i], true], [tops[i], true], [next, false], [bottoms[i], false]])
          : loop([[bottoms[i], true], [next, true], [tops[i], false], [verticals[i], false]])
        let surface: number
        let sense = ".T."
        if (s.kind === "line") {
          const dx = s.b.x - s.a.x
          const dy = s.b.y - s.a.y
          const normal = hole ? w.dir(-dy, dx, 0) : w.dir(dy, -dx, 0)
          surface = w.add(`PLANE('',#${w.placement(w.point(s.a.x, s.a.y, 0), normal, w.dir(dx, dy, 0))})`)
        } else {
          surface = w.add(`CYLINDRICAL_SURFACE('',#${w.placement(w.point(s.c.x, s.c.y, 0), zAxis, w.dir(s.a.x - s.c.x, s.a.y - s.c.y, 0))},${len(s.r)})`)
          // The cylinder's own normal points away from its axis. A hole's wall faces into it and a concave corner of the outline faces in too.
          if (hole === s.ccw) sense = ".F."
        }
        const face = w.add(`ADVANCED_FACE('',(#${bound(wall, true)}),#${surface},${sense})`)
        walls.push(face)
        faces.push(face)
      })
      if (!hole) {
        outerTops = tops
        outerBottoms = bottoms
        return
      }
      topHoles.push(bound(loop(tops.map((e) => [e, false] as [number, boolean]).reverse()), false))
      bottomHoles.push(bound(loop(bottoms.map((e) => [e, true] as [number, boolean])), false))
    })
    faces.push(w.add(`ADVANCED_FACE('',${refs([bound(loop(outerTops.map((e) => [e, true] as [number, boolean])), true), ...topHoles])},#${topPlane},.T.)`))
    faces.push(w.add(`ADVANCED_FACE('',${refs([bound(loop(outerBottoms.map((e) => [e, false] as [number, boolean]).reverse()), true), ...bottomHoles])},#${bottomPlane},.T.)`))
    const shell = w.add(`CLOSED_SHELL('',${refs(faces)})`)
    const solid = w.add(`MANIFOLD_SOLID_BREP('PCB',#${shell})`)
    solids.push(solid)
    style.push(w.style(solid, board.color))
  })
  const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('PCB',(#${origin},${solids.map((s) => `#${s}`).join(",")}),#${ctx})`)
  w.presentation([...style, ...walls.map((f) => w.style(f, FR4))], ctx)
  const product = w.product("PCB")
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${product.shape},#${rep})`)
  return { definition: product.definition, rep, origin }
}
