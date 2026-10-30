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
import { trackPoints } from "./arcTracks"
import type { CopperItem } from "./pcb"
import { outlineGeometry } from "./outline"
import { flattenPath, shapePolylines, shapeRings } from "./shapes"
import { classPourClearance, hasNetClasses } from "./netClasses"
import { zoneClearance } from "./rules"
import { fillPolygonZones, fillPolygonZonesEx, type PendingGroup } from "./zoneFill"
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

// Clipper works in integers; one unit is a micron, or a nanometre inside `withMaxError(..., 1e6)`, where a polygon's offset is exact to KiCad's own unit.
let S = 1000
/** Max deviation of offset arcs from a true circle when no `maxError` is given: 5 µm, which is also KiCad's own default for it. */
const ARC_TOL_MM = 0.005

/**
 * The most a polygon may differ from the circle or arc it stands for, in mm, while a caller runs inside `withMaxError` (KiCad's `max_error`,
 * `DesignRules.maxError`); outside it, or with none given, the editor's own tolerance (5 µm for offsets, a fixed count of corners for a circle).
 */
let maxError: number | undefined

/** Run `fn` with the polygons it makes held to `error` mm of the true shape; an absent error is the editor's own tolerance. */
export function withMaxError<T>(error: number | undefined, fn: () => T, scale = 1000): T {
  const before = maxError
  const beforeScale = S
  maxError = error !== undefined && error > 0 ? error : undefined
  S = scale
  try {
    return fn()
  } finally {
    maxError = before
    S = beforeScale
  }
}

/** Corners of a polygon that stands for a circle within `error`, as KiCad counts them (`GetArcToSegmentCount`, geometry_utils.cpp: at least 8 around, one corner per 2 acos(1 - error / r)). */
export function circleSegments(r: number, error: number): number {
  const rel = Math.min(1, error / Math.max(r, 1e-6))
  const increment = Math.min(45, ((180 / Math.PI) * Math.acos(1 - rel)) * 2)
  return Math.max(Math.round(360 / increment), 2)
}

const arcTol = () => Math.max(1, (maxError ?? ARC_TOL_MM) * S)

const pt = (x: number, y: number) => ({ x: Math.round(x * S), y: Math.round(y * S) })

function circlePath(x: number, y: number, r: number): Path64 {
  const n = maxError !== undefined ? Math.max(circleSegments(r, maxError), 8) : Math.max(12, Math.min(48, Math.ceil(r * 16)))
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
  paths.length ? Clipper.inflatePaths(paths, d * S, JoinType.Round, EndType.Polygon, 2, arcTol()) : []

const stroke = (points: Vec2[], halfWidth: number): Paths64 =>
  Clipper.inflatePaths([points.map((p) => pt(p.x, p.y))], halfWidth * S, JoinType.Round, EndType.Round, 2, arcTol())

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
  if (pad.rings && pad.rings.length > 1) return Clipper.union(pad.rings.map((ring) => ring.map((p) => pt(p.x, p.y))), [], FillRule.EvenOdd)
  if (pad.shape === "polygon" && pad.points && pad.points.length >= 3) {
    const path = pad.points.map((p) => pt(p.x, p.y))
    return [Clipper.isPositive(path) ? path : path.reverse()]
  }
  if (pad.corner) return [roundedPadPath(pad.x, pad.y, pad.width, pad.height, pad.corner)]
  return [rectPath(pad.x, pad.y, pad.width, pad.height)]
}

/** A level rectangle with rounded corners, each corner within the error of the circle (the editor's own tolerance, or `max_error`). */
function roundedPadPath(cx: number, cy: number, w: number, h: number, r: number): Path64 {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  const tol = maxError ?? ARC_TOL_MM
  const steps = rr <= tol ? 1 : Math.max(2, Math.ceil(Math.PI / 2 / (2 * Math.acos(1 - tol / rr))))
  const path: Path64 = []
  const corners: [number, number, number][] = [
    [cx + w / 2 - rr, cy - h / 2 + rr, -Math.PI / 2],
    [cx + w / 2 - rr, cy + h / 2 - rr, 0],
    [cx - w / 2 + rr, cy + h / 2 - rr, Math.PI / 2],
    [cx - w / 2 + rr, cy - h / 2 + rr, Math.PI],
  ]
  for (const [x, y, start] of corners) for (let i = 0; i <= steps; i++) path.push(pt(x + Math.cos(start + (i / steps) * (Math.PI / 2)) * rr, y + Math.sin(start + (i / steps) * (Math.PI / 2)) * rr))
  return path
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
  return inflate(pad.hull ? hullPaths(pad) : padPaths(pad), gap)
}

/** The convex hull of a custom pad's outline, for a pad whose pour clearance follows it (KiCad's `clearance convexhull`). */
function hullPaths(pad: WorldPad): Paths64 {
  const pts = (pad.rings ?? (pad.points ? [pad.points] : [])).flat().map((p) => pt(p.x, p.y))
  if (pts.length < 3) return padPaths(pad)
  pts.sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (list: typeof pts) => {
    const out: typeof pts = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [[...half(pts), ...half([...pts].reverse())]]
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
function thermalRelief(pad: WorldPad, zoneGap: number, rules: DesignRules): Paths64 {
  // A pad's own gap, spoke width and spoke angle replace the board's (KiCad's `thermal_gap`, `thermal_bridge_width` and `thermal_bridge_angle`).
  const gap = pad.thermalGap && pad.thermalGap > 0 ? pad.thermalGap : zoneGap
  const width = pad.thermalWidth && pad.thermalWidth > 0 ? pad.thermalWidth : rules.thermalSpokeWidth
  const copper = padPaths(pad)
  const ring = Clipper.difference(inflate(copper, gap), copper, FillRule.NonZero)
  const reach = Math.hypot(pad.width, pad.height) + gap * 2 + 0.2
  // A pad of a part at an angle keeps its spokes on its own axes; any other pad is as it always was.
  const axis = pad.oriented ? (pad.oriented.rot * Math.PI) / 180 + (pad.oriented.height > pad.oriented.width ? Math.PI / 2 : 0) : pad.height > pad.width ? Math.PI / 2 : 0
  const base = axis + (pad.thermalAngle !== undefined ? ((pad.thermalAngle % 90) * Math.PI) / 180 : rules.thermalSpokeAngle === 45 ? Math.PI / 4 : 0)
  const angles = rules.thermalSpokes === 2 ? [base] : [base, base + Math.PI / 2]
  const spokes = angles.map((a) => barPath(pad.x, pad.y, reach, width, a))
  return Clipper.difference(ring, spokes, FillRule.NonZero)
}

/** Whether a same-net pad joins the pour through spokes rather than solidly. */
function relieved(pad: WorldPad, rules: DesignRules): boolean {
  // A pad's own connection (`zone_connect`) replaces the rule: thermal relief, solid, or thermal relief on a through-hole pad only.
  if (pad.zoneConnect === "thermal") return true
  if (pad.zoneConnect === "solid") return false
  if (pad.zoneConnect === "tht") return pad.holeDiameter !== undefined
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
  // A zone with a polygon of its own, a rule area or settings of its own (X3) is filled by the polygon engine (`zoneFill.ts`, which keeps its
  // own geometry and does not use `withMaxError`); a project whose pours are all the editor's whole-board pours is filled by the code below, as it always was.
  if (needsZoneEngine(project)) return fillPolygonZones(project, sch, input)
  return withMaxError(project.rules.maxError, () => fillZonesIn(project, sch, input))
}

function fillZonesIn(project: Project, sch: SchematicConnectivity, input: PourInput): ZoneFill[] {
  const b = project.board
  const { rules } = project
  const edge = rules.edgeClearance
  const area = boardArea(b, edge)
  const minWidth = Math.max(0.01, rules.pourMinWidth)
  const eroded = inflate(area, -minWidth / 2)
  const fills: ZoneFill[] = []
  const filledByLayer = new Map<CopperLayer, Paths64>()
  const classed = hasNetClasses(rules)
  const netNames = classed ? new Map(sch.nets.map((n) => [n.id, n.name])) : null

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
    // A zone keeps at least the clearance a net class asks for, from copper of that class (`classPourClearance`), and at least its own: KiCad
    // max's a zone's local clearance with the class value and does not substitute it (drc_engine.cpp 9.0 :1451-1540, 10.0 :1982-2063; the polygon
    // engine, `zoneFill.ts`, does the same). A board with no classes is the zone's gap throughout.
    const lifted = classed
    input.items.forEach((it, i) => {
      if (!it.layers.includes(zone.layer) || it.kind === "zone") return
      const itemNet = input.netOf(i)
      const same = itemNet === netId
      const g = lifted ? Math.max(gap, classPourClearance(rules, zone.net, itemNet ? (netNames!.get(itemNet) ?? null) : null)) : gap
      // A non-plated hole carries no net: cleared by the zone clearance, never relieved.
      if (it.kind === "pad" && isNpth(it.pad)) clip.push(...padClearance(it.pad, g + m))
      else if (it.kind === "pad") {
        // A pad's own clearance raises the gap and never lowers it: KiCad max's a local clearance with the class's and the zone's (drc_engine.cpp
        // 9.0 :1451-1540, 10.0 :1982-2063), and holds the result to the board's minimum.
        const own = it.pad.clearance ? Math.max(it.pad.clearance, g, rules.minClearance ?? 0) : g
        if (same && it.pad.zoneConnect !== "none") {
          anchors.push({ x: it.pad.x, y: it.pad.y })
          if (relieved(it.pad, rules)) clip.push(...inflate(thermalRelief(it.pad, rules.thermalGap ?? gap, rules), m))
        } else clip.push(...padClearance(it.pad, own + m))
      } else if (it.kind === "segment") {
        if (same) anchors.push(it.a, it.b)
        else clip.push(...stroke(trackPoints(it), it.width / 2 + g + m))
      } else if (it.kind === "via") {
        if (same) anchors.push(it.at)
        else clip.push(circlePath(it.at.x, it.at.y, it.diameter / 2 + g + m))
      } else if (it.kind === "shape") {
        if (same) {
          const step = Math.max(1, Math.ceil(it.copper.edges.length / 32))
          it.copper.edges.forEach(([a], i) => i % step === 0 && anchors.push(a))
        }
        else clip.push(...shapeObstacle(it, g + m))
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

/** Clipper helpers for the other modules that make polygons of copper and mask (`export/maskMerge.ts`): a round circle path, a stroked polyline, an offset, and a union read back as regions. */
export const polygonKit = {
  circle: (x: number, y: number, r: number): Paths64 => [circlePath(x, y, r)],
  stroke: (points: Vec2[], halfWidth: number): Paths64 => stroke(points, halfWidth),
  inflate: (paths: Paths64, d: number): Paths64 => inflate(paths, d),
  /** An offset with bevelled corners, as KiCad's `CHAMFER_ALL_CORNERS` makes them. */
  inflateBevel: (paths: Paths64, d: number): Paths64 => (paths.length ? Clipper.inflatePaths(paths, d * S, JoinType.Bevel, EndType.Polygon, 2, arcTol()) : []),
  /** The union of paths with every ring turned counter-clockwise first, so rings that overlap add and never cancel. */
  union: (paths: Paths64): Paths64 => {
    const positive = paths.map((r) => (Clipper.isPositive(r) ? r : [...r].reverse()))
    return positive.length ? Clipper.union(positive, [], FillRule.NonZero) : []
  },
  /** Fill-rule union of rings whose holes are the rings inside them (a text's letters). */
  unionEvenOdd: (paths: Paths64): Paths64 => (paths.length ? Clipper.union(paths, [], FillRule.EvenOdd) : []),
  path: (ring: Vec2[]): Path64 => ring.map((p) => pt(p.x, p.y)),
  /** Regions of a set of paths as an outer ring and its holes each, in millimetres. */
  regions: (paths: Paths64): FillPolygon[] => {
    const tree = new PolyTree64()
    const c = new Clipper64()
    c.addSubject(paths)
    c.execute(ClipType.Union, FillRule.NonZero, tree)
    const groups: Path64[][] = []
    collect(tree, groups)
    return groups.map((g) => g.map(toVec))
  },
}

/**
 * The fills of a project without filling any group of zones whose fill is not already kept (`zoneFill.ts`): `stale` stands in for those,
 * and `missing` lists them. A project with only whole-board pours is filled as it always was.
 */
export function fillZonesReusing(project: Project, sch: SchematicConnectivity, input: PourInput, stale: ZoneFill[]): { fills: ZoneFill[]; missing: PendingGroup[] } {
  if (!needsZoneEngine(project)) return { fills: fillZones(project, sch, input), missing: [] }
  return fillPolygonZonesEx(project, sch, input, { stale })
}

/** Point-in-fill tester in millimetres, honouring holes. */
export function fillTester(polygon: FillPolygon): (p: Vec2) => boolean {
  const rings = polygon.map((ring) => ring.map((q) => pt(q.x, q.y))).map(ringTester)
  return (p) => {
    const q = pt(p.x, p.y)
    // A point on the outline counts as inside it; one on the edge of a hole is not inside the hole.
    if (rings[0](q) === PointInPolygonResult.IsOutside) return false
    for (let i = 1; i < rings.length; i++) if (rings[i](q) === PointInPolygonResult.IsInside) return false
    return true
  }
}

type Place = (q: { x: number; y: number }) => PointInPolygonResult

/**
 * Where a point is against one ring, as `Clipper.pointInPolygon` says it. A ring of many corners (a big pour's outline, or the copper
 * round its pads) is held with its edges sorted into bands of y, so a point is tested against the edges of its band and not all of them,
 * and with the box of the ring, so a point that is far from it costs nothing. The sums are exact (whole micrometres).
 */
function ringTester(path: Path64): Place {
  const n = path.length
  if (n < 48) return (q) => Clipper.pointInPolygon(q, path)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const q of path) {
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  const bands = Math.min(2048, Math.max(8, n >> 2))
  const height = (maxY - minY) / bands || 1
  const band = (y: number) => Math.min(bands - 1, Math.max(0, Math.floor((y - minY) / height)))
  const edges: number[][] = Array.from({ length: bands }, () => [])
  for (let i = 0; i < n; i++) {
    const a = path[i]
    const b = path[(i + 1) % n]
    for (let k = band(Math.min(a.y, b.y)); k <= band(Math.max(a.y, b.y)); k++) edges[k].push(i)
  }
  return (q) => {
    if (q.x < minX || q.x > maxX || q.y < minY || q.y > maxY) return PointInPolygonResult.IsOutside
    let crossings = 0
    for (const i of edges[band(q.y)]) {
      const a = path[i]
      const b = path[(i + 1) % n]
      const cross = (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y)
      // On the edge: collinear and between its ends.
      if (cross === 0 && q.x >= Math.min(a.x, b.x) && q.x <= Math.max(a.x, b.x) && q.y >= Math.min(a.y, b.y) && q.y <= Math.max(a.y, b.y)) return PointInPolygonResult.IsOn
      // A crossing of the ray to the right, the half-open way so a corner on the ray counts once.
      if (a.y > q.y !== b.y > q.y && (b.y > a.y ? cross > 0 : cross < 0)) crossings++
    }
    return crossings & 1 ? PointInPolygonResult.IsInside : PointInPolygonResult.IsOutside
  }
}
