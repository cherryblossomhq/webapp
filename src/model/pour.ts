import {
  Clipper,
  Clipper64,
  ClipType,
  EndType,
  FillRule,
  JoinType,
  PointInPolygonResult,
  PolyTree64,
  type Path64,
  type Paths64,
  type PolyPath64,
} from "@countertype/clipper2-ts"
import type { SchematicConnectivity } from "./connectivity"
import { isNpth, type WorldPad } from "./instances"
import type { CopperItem } from "./pcb"
import { outlineGeometry } from "./outline"
import { flattenPath, shapePolylines, shapeRings } from "./shapes"
import { zoneClearance } from "./rules"
import { fillPolygonZones } from "./zoneFill"
import { needsZoneEngine } from "./zones"
import type { CopperLayer, DesignRules, Project, Vec2 } from "./types"

/** One filled region: the outer ring (counter-clockwise) followed by its holes (clockwise). */
export type FillPolygon = Vec2[][]

export interface ZoneFill {
  zoneId: string
  /** Schematic net id the zone belongs to, or null when no pin is on that net. */
  netId: string | null
  netName: string
  layer: CopperLayer
  polygons: FillPolygon[]
}

// Clipper works in integers; one unit is a micron.
const S = 1000
/** Max deviation of offset arcs from a true circle, in clipper units (5 µm). */
const ARC_TOL = 5

const pt = (x: number, y: number) => ({ x: Math.round(x * S), y: Math.round(y * S) })

function circlePath(x: number, y: number, r: number): Path64 {
  const n = Math.max(12, Math.min(48, Math.ceil(r * 16)))
  const path: Path64 = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    path.push(pt(x + Math.cos(a) * r, y + Math.sin(a) * r))
  }
  return path
}

function rectPath(cx: number, cy: number, w: number, h: number): Path64 {
  return [pt(cx - w / 2, cy - h / 2), pt(cx + w / 2, cy - h / 2), pt(cx + w / 2, cy + h / 2), pt(cx - w / 2, cy + h / 2)]
}

function roundedRectPath(cx: number, cy: number, w: number, h: number, r: number): Path64 {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  if (rr < 1e-6) return rectPath(cx, cy, w, h)
  const path: Path64 = []
  const corners: [number, number, number][] = [
    [cx + w / 2 - rr, cy - h / 2 + rr, -Math.PI / 2],
    [cx + w / 2 - rr, cy + h / 2 - rr, 0],
    [cx - w / 2 + rr, cy + h / 2 - rr, Math.PI / 2],
    [cx - w / 2 + rr, cy - h / 2 + rr, Math.PI],
  ]
  const steps = 8
  for (const [x, y, start] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = start + (i / steps) * (Math.PI / 2)
      path.push(pt(x + Math.cos(a) * rr, y + Math.sin(a) * rr))
    }
  }
  return path
}

const inflate = (paths: Paths64, d: number): Paths64 =>
  paths.length ? Clipper.inflatePaths(paths, d * S, JoinType.Round, EndType.Polygon, 2, ARC_TOL) : []

const stroke = (points: Vec2[], halfWidth: number): Paths64 =>
  Clipper.inflatePaths([points.map((p) => pt(p.x, p.y))], halfWidth * S, JoinType.Round, EndType.Round, 2, ARC_TOL)

/** A copper drawing's copper grown by `d`: its outline stroked with half its width plus `d`, and what a filled one covers. */
function shapeObstacle(it: Extract<CopperItem, { kind: "shape" }>, d: number): Paths64 {
  const half = it.copper.half + d
  const out: Paths64 = []
  // A text: its strokes (and a knockout's rings) as they are in `copper`.
  if (it.what === "text") {
    for (const [a, b] of it.copper.edges) out.push(...stroke(a === b || (a.x === b.x && a.y === b.y) ? [a, { x: a.x + 1e-6, y: a.y }] : [a, b], half))
    if (it.copper.fill.length) out.push(...inflate(Clipper.union(it.copper.fill.map((ring) => ring.map((p) => pt(p.x, p.y))), [], FillRule.EvenOdd), half))
    return out
  }
  for (const line of shapePolylines(it.shape)) if (line.length >= 2) out.push(...stroke(line, half))
  if (it.shape.fill) {
    const rings = shapeRings(it.shape).map((ring) => ring.map((p) => pt(p.x, p.y)))
    if (rings.length) out.push(...inflate(Clipper.union(rings, [], FillRule.EvenOdd), half))
  }
  return out
}

/** Copper outline of a pad as clipper paths. */
export function padPaths(pad: WorldPad): Paths64 {
  if (pad.shape === "circle") return [circlePath(pad.x, pad.y, pad.width / 2)]
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    if (half < 1e-6) return [circlePath(pad.x, pad.y, r)]
    const horizontal = pad.width >= pad.height
    const a = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
    const b = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
    return stroke([a, b], r)
  }
  if (pad.shape === "polygon" && pad.points && pad.points.length >= 3) {
    const path = pad.points.map((p) => pt(p.x, p.y))
    return [Clipper.isPositive(path) ? path : path.reverse()]
  }
  return [rectPath(pad.x, pad.y, pad.width, pad.height)]
}

/**
 * Where copper may be poured: the board inset by the edge clearance. A board with an outline of its own is its loops (holes
 * cut out) inset the same way, and a piece of outline left open is kept clear of by the same distance on either side; with no loop at all
 * the box of the edges stands for the board.
 */
function boardArea(b: Project["board"], edge: number): Paths64 {
  const g = outlineGeometry(b)
  if (!g) return [roundedRectPath(b.x, b.y, b.width - edge * 2, b.height - edge * 2, Math.max(0, b.cornerRadius - edge))]
  const loops = g.rings.length
    ? inflate(Clipper.union(g.regions.flatMap((r) => [r.outer, ...r.holes]).map((ring) => ring.map((p) => pt(p.x, p.y))), [], FillRule.NonZero), -edge)
    : [rectPath((g.box.minX + g.box.maxX) / 2, (g.box.minY + g.box.maxY) / 2, g.box.maxX - g.box.minX, g.box.maxY - g.box.minY)]
  const open = (b.outline?.paths ?? []).filter((p) => !p.closed)
  if (!open.length) return loops
  const strokes: Paths64 = open.flatMap((p) => {
    const pts = flattenPath(p)
    return pts.length >= 2 ? stroke(pts, edge) : []
  })
  return Clipper.difference(loops, strokes, FillRule.NonZero)
}

/** Keepout around a pad of another net. */
function padClearance(pad: WorldPad, gap: number): Paths64 {
  return inflate(padPaths(pad), gap)
}

/** A bar of the given length and width through (cx, cy), turned by `angle` radians. */
function barPath(cx: number, cy: number, length: number, width: number, angle: number): Path64 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [
    [-length / 2, -width / 2],
    [length / 2, -width / 2],
    [length / 2, width / 2],
    [-length / 2, width / 2],
  ].map(([x, y]) => pt(cx + x * c - y * s, cy + x * s + y * c))
}

/**
 * Ring around a same-net pad with spokes left in place: two along the pad's longer side or
 * four across both, square to the pad or at 45 degrees.
 */
function thermalRelief(pad: WorldPad, gap: number, rules: DesignRules): Paths64 {
  const copper = padPaths(pad)
  const ring = Clipper.difference(inflate(copper, gap), copper, FillRule.NonZero)
  const reach = Math.hypot(pad.width, pad.height) + gap * 2 + 0.2
  // A pad of a part at an angle keeps its spokes on its own axes; any other pad is as it always was.
  const axis = pad.oriented ? (pad.oriented.rot * Math.PI) / 180 + (pad.oriented.height > pad.oriented.width ? Math.PI / 2 : 0) : pad.height > pad.width ? Math.PI / 2 : 0
  const base = axis + (rules.thermalSpokeAngle === 45 ? Math.PI / 4 : 0)
  const angles = rules.thermalSpokes === 2 ? [base] : [base, base + Math.PI / 2]
  const spokes = angles.map((a) => barPath(pad.x, pad.y, reach, rules.thermalSpokeWidth, a))
  return Clipper.difference(ring, spokes, FillRule.NonZero)
}

/** Whether a same-net pad joins the pour through spokes rather than solidly. */
function relieved(pad: WorldPad, rules: DesignRules): boolean {
  if (rules.thermalRelief === "direct") return false
  return rules.thermalRelief === "relief" || pad.holeDiameter !== undefined
}

function inside(p: Vec2, polygon: Path64[]): boolean {
  const q = pt(p.x, p.y)
  if (Clipper.pointInPolygon(q, polygon[0]) === PointInPolygonResult.IsOutside) return false
  for (let i = 1; i < polygon.length; i++) {
    if (Clipper.pointInPolygon(q, polygon[i]) === PointInPolygonResult.IsInside) return false
  }
  return true
}

/** Flatten a polytree into [outer, ...holes] groups, including islands nested inside holes. */
function collect(node: PolyPath64, out: Path64[][]) {
  for (let i = 0; i < node.count; i++) {
    const outer = node.child(i)
    if (!outer.poly) continue
    const group: Path64[] = [outer.poly]
    for (let j = 0; j < outer.count; j++) {
      const hole = outer.child(j)
      if (hole.poly) group.push(hole.poly)
      collect(hole, out)
    }
    out.push(group)
  }
}

const toVec = (path: Path64): Vec2[] => path.map((p) => ({ x: p.x / S, y: p.y / S }))

export interface PourInput {
  items: CopperItem[]
  /** Net of each item from copper connectivity before pours are added. */
  netOf: (index: number) => string | null
  /** Keep regions that no same-net copper touches yet, e.g. to plan stitching vias. */
  keepIslands?: boolean
}

/**
 * Fill every zone on the board: board outline inset by the edge clearance, minus other-net
 * copper and non-plated holes grown by the zone clearance, with thermal spokes on same-net
 * pads as the thermal relief rule says. Regions that no same-net copper touches are dropped.
 */
export function fillZones(project: Project, sch: SchematicConnectivity, input: PourInput): ZoneFill[] {
  // A zone with a polygon of its own, a rule area or settings of its own (X3) is filled by the polygon engine (`zoneFill.ts`); a project whose
  // pours are all the editor's whole-board pours is filled by the code below, as it always was.
  if (needsZoneEngine(project)) return fillPolygonZones(project, sch, input)
  const b = project.board
  const { rules } = project
  const edge = rules.edgeClearance
  const area = boardArea(b, edge)
  const minWidth = Math.max(0.01, rules.pourMinWidth)
  const eroded = inflate(area, -minWidth / 2)
  const fills: ZoneFill[] = []
  const filledByLayer = new Map<CopperLayer, Paths64>()

  for (const zone of project.zones) {
    const netId = sch.nets.find((n) => n.name === zone.net)?.id ?? null
    const fill: ZoneFill = { zoneId: zone.id, netId, netName: zone.net, layer: zone.layer, polygons: [] }
    fills.push(fill)
    if (!netId) continue
    const gap = zoneClearance(project, zone.clearance)
    // Opening removes necks thinner than the minimum width: erode(area - obstacles) equals
    // erode(area) - dilate(obstacles), so obstacles are simply built m wider, and the
    // result is grown back by m afterwards.
    const m = minWidth / 2

    const clip: Paths64 = []
    const anchors: Vec2[] = []
    input.items.forEach((it, i) => {
      if (!it.layers.includes(zone.layer) || it.kind === "zone") return
      const same = input.netOf(i) === netId
      // A non-plated hole carries no net: cleared by the zone clearance, never relieved.
      if (it.kind === "pad" && isNpth(it.pad)) clip.push(...padClearance(it.pad, gap + m))
      else if (it.kind === "pad") {
        if (same) {
          anchors.push({ x: it.pad.x, y: it.pad.y })
          if (relieved(it.pad, rules)) clip.push(...inflate(thermalRelief(it.pad, gap, rules), m))
        } else clip.push(...padClearance(it.pad, gap + m))
      } else if (it.kind === "segment") {
        if (same) anchors.push(it.a, it.b)
        else clip.push(...stroke([it.a, it.b], it.width / 2 + gap + m))
      } else if (it.kind === "via") {
        if (same) anchors.push(it.at)
        else clip.push(circlePath(it.at.x, it.at.y, it.diameter / 2 + gap + m))
      } else if (it.kind === "shape") {
        if (same) {
          const step = Math.max(1, Math.ceil(it.copper.edges.length / 32))
          it.copper.edges.forEach(([a], i) => i % step === 0 && anchors.push(a))
        }
        else clip.push(...shapeObstacle(it, gap + m))
      }
    })
    const earlier = filledByLayer.get(zone.layer)
    if (earlier?.length) clip.push(...inflate(earlier, gap + m))

    const paths = inflate(Clipper.difference(eroded, clip, FillRule.NonZero), m)
    const tree = new PolyTree64()
    const c = new Clipper64()
    c.addSubject(paths)
    c.execute(ClipType.Union, FillRule.NonZero, tree)
    const groups: Path64[][] = []
    collect(tree, groups)

    const kept: Paths64 = []
    for (const group of groups) {
      if (!input.keepIslands && !anchors.some((a) => inside(a, group))) continue
      kept.push(...group)
      fill.polygons.push(group.map(toVec))
    }
    filledByLayer.set(zone.layer, [...(earlier ?? []), ...kept])
  }
  return fills
}

/** Point-in-fill tester in millimetres, honouring holes. */
export function fillTester(polygon: FillPolygon): (p: Vec2) => boolean {
  const rings = polygon.map((ring) => ring.map((q) => pt(q.x, q.y)))
  return (p) => inside(p, rings)
}
