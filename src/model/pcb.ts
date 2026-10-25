import {
  boxesOverlap,
  closestPointOnSegment,
  dist,
  isQuarterTurn,
  pointSegmentDistance,
  segmentSegmentDistance,
  segmentsIntersect,
  type Box,
} from "../lib/geometry"
import { mountingHoles } from "./board"
import { crossingSentence, outlineCrossings } from "./outlineCrossing"
import { boxOnBoard, convexOverlap, copperEdgeClearance, outlineGeometry, outlineState, ringOnBoard } from "./outline"
import { pinKey, type SchematicConnectivity } from "./connectivity"
import { DECOUPLING_WARN_MM, decouplingGaps, decouplingPairs } from "./decoupling"
import { findPart } from "./library"
import { hasCourtyard, isNpth, isPhysical, pcbCourtyard, pcbCourtyardRing, pcbPads, slotEnds, type WorldPad } from "./instances"
import { keepoutViolations } from "./zoneChecks"
import { carveFills, type PendingGroup } from "./zoneFill"
import { fillTester, fillZones, fillZonesReusing, type FillPolygon, type ZoneFill } from "./pour"
import { formatLength } from "./rules"
import { netTieGroups } from "./partFlags"
import { worldShapes } from "./shapeItems"
import { segEnd, shapeCopper, shapeInkBox, shapeShapeDistance, type ShapeCopper } from "./shapes"
import { layerText, worldTexts } from "./texts"
import type { BoardDef, BoardShape, ComponentInstance, CopperLayer, Project, Vec2, Via } from "./types"

/** componentId used for board-level copper such as mounting holes. */
export const BOARD_OWNER = "#board"

export type CopperItem =
  | { kind: "pad"; id: string; pad: WorldPad; netId: string | null; layers: CopperLayer[]; box: Box }
  | {
      kind: "segment"
      id: string
      traceId: string
      index: number
      a: Vec2
      b: Vec2
      width: number
      layers: CopperLayer[]
      box: Box
      /** The net the trace says it is on (`Trace.net`), when it says one and the project has it. */
      netId?: string | null
    }
  | {
      kind: "via"
      id: string
      viaId: string
      at: Vec2
      diameter: number
      layers: CopperLayer[]
      box: Box
      /** The net the via says it is on (`Via.routedNet`), when it says one and the project has it. */
      netId?: string | null
    }
  | {
      /**
       * A drawing on a copper layer (a board brought in from KiCad can have them): copper like a trace or a pad. It
       * conducts only when it names a net (`BoardShape.net`); one with none is copper that touches nothing and
       * keeps clear of every net, as KiCad treats it.
       */
      kind: "shape"
      id: string
      /** The selection id of the drawing (`g:` or `s:`). */
      shapeId: string
      /** `#board`, or the component the drawing belongs to. */
      owner: string
      shape: BoardShape
      copper: ShapeCopper
      conducts: boolean
      layers: CopperLayer[]
      box: Box
      netId?: string | null
      /** Set when the copper is a text (its strokes as edges, `shape` a box standing for it): it never conducts and is copper for every check. */
      what?: "text"
    }
  | {
      kind: "zone"
      id: string
      zoneId: string
      polygon: FillPolygon
      contains: (p: Vec2) => boolean
      layers: CopperLayer[]
      box: Box
    }

export interface RatsLine {
  netId: string
  a: Vec2
  b: Vec2
}

export interface DrcViolation {
  id: string
  severity: "error" | "warning"
  kind:
    | "short"
    | "clearance"
    | "unrouted"
    | "outside-board"
    | "overlap"
    | "unconnected-pin"
    | "net-conflict"
    | "trace-width"
    | "drill"
    | "annular-ring"
    | "via-size"
    | "hole-clearance"
    | "edge-clearance"
    | "outline"
    | "via-in-pad"
    | "floating-copper"
    | "decoupling"
    | "keepout"
  message: string
  at: Vec2
}

export interface PcbAnalysis {
  items: CopperItem[]
  /** island index for each item id */
  island: Map<string, number>
  /** net id for each island, null if no pad, "short" if more than one */
  islandNet: Map<number, string | null>
  traceNet: Map<string, string | null>
  viaNet: Map<string, string | null>
  ratsnest: RatsLine[]
  violations: DrcViolation[]
  zoneFills: ZoneFill[]
  /** Set when some zones' fill is not current (the groups it lists): it is the earlier one, kept while the new one is made (`reuseOnly`). Every result in this analysis that depends on the copper of a pour is then of the earlier fill. */
  zonesPending?: PendingGroup[]
}

function padBox(p: WorldPad): Box {
  return { minX: p.x - p.width / 2, minY: p.y - p.height / 2, maxX: p.x + p.width / 2, maxY: p.y + p.height / 2 }
}

const segBox = (a: Vec2, b: Vec2, w: number): Box => ({
  minX: Math.min(a.x, b.x) - w / 2,
  minY: Math.min(a.y, b.y) - w / 2,
  maxX: Math.max(a.x, b.x) + w / 2,
  maxY: Math.max(a.y, b.y) + w / 2,
})

const inflate = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })

/** A polygon pad's corners when it has them (a part turned by other than a quarter turn has all its rectangular pads this way), else null. */
const polygonRing = (pad: WorldPad): Vec2[] | null => (pad.shape === "polygon" && pad.points && pad.points.length >= 3 ? pad.points : null)

function pointRingDistance(p: Vec2, ring: Vec2[]): number {
  let inside = false
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    best = Math.min(best, pointSegmentDistance(p, a, b))
  }
  return inside ? 0 : best
}

/** Distance from point to a pad's copper (0 inside). */
export function pointPadDistance(p: Vec2, pad: WorldPad): number {
  const ring = polygonRing(pad)
  if (ring) return pointRingDistance(p, ring)
  if (pad.shape === "circle") return Math.max(0, dist(p, pad) - pad.width / 2)
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    const horizontal = pad.width >= pad.height
    const a = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
    const b = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
    return Math.max(0, pointSegmentDistance(p, a, b) - r)
  }
  const dx = Math.max(Math.abs(p.x - pad.x) - pad.width / 2, 0)
  const dy = Math.max(Math.abs(p.y - pad.y) - pad.height / 2, 0)
  return Math.hypot(dx, dy)
}

function rectCorners(pad: WorldPad): Vec2[] {
  const hw = pad.width / 2
  const hh = pad.height / 2
  return [
    { x: pad.x - hw, y: pad.y - hh },
    { x: pad.x + hw, y: pad.y - hh },
    { x: pad.x + hw, y: pad.y + hh },
    { x: pad.x - hw, y: pad.y + hh },
  ]
}

export function segmentPadDistance(a: Vec2, b: Vec2, pad: WorldPad): number {
  const ring = polygonRing(pad)
  if (ring) {
    if (pointRingDistance(a, ring) === 0 || pointRingDistance(b, ring) === 0) return 0
    let best = Math.min(pointRingDistance(a, ring), pointRingDistance(b, ring))
    for (let i = 0; i < ring.length; i++) {
      const c = ring[i]
      const d = ring[(i + 1) % ring.length]
      if (segmentsIntersect(a, b, c, d)) return 0
      best = Math.min(best, pointSegmentDistance(c, a, b))
    }
    return best
  }
  if (pad.shape === "circle") return Math.max(0, pointSegmentDistance(pad, a, b) - pad.width / 2)
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    const horizontal = pad.width >= pad.height
    const c = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
    const d = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
    return Math.max(0, segmentSegmentDistance(a, b, c, d) - r)
  }
  if (pointPadDistance(a, pad) === 0 || pointPadDistance(b, pad) === 0) return 0
  const corners = rectCorners(pad)
  let best = Math.min(pointPadDistance(a, pad), pointPadDistance(b, pad))
  for (let i = 0; i < 4; i++) {
    const c = corners[i]
    const d = corners[(i + 1) % 4]
    if (segmentsIntersect(a, b, c, d)) return 0
    best = Math.min(best, pointSegmentDistance(c, a, b))
  }
  return best
}

function padPadDistance(p: WorldPad, q: WorldPad): number {
  if (p.shape === "circle" && q.shape === "circle") return Math.max(0, dist(p, q) - p.width / 2 - q.width / 2)
  if (polygonRing(p) || polygonRing(q)) return shapeShapeDistance(padCopper(p), padCopper(q))
  const a = padBox(p)
  const b = padBox(q)
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0)
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0)
  return Math.hypot(dx, dy)
}

const copperCache = new WeakMap<CopperItem, ShapeCopper>()

/** A pad as lines with a half width and a filled area. */
function padCopper(p: WorldPad): ShapeCopper {
  if (p.shape === "circle") return { edges: [[p, p]], half: p.width / 2, fill: [] }
  if (p.shape === "pill") {
    const r = Math.min(p.width, p.height) / 2
    const half = Math.max(p.width, p.height) / 2 - r
    const horizontal = p.width >= p.height
    return { edges: [horizontal ? [{ x: p.x - half, y: p.y }, { x: p.x + half, y: p.y }] : [{ x: p.x, y: p.y - half }, { x: p.x, y: p.y + half }]], half: r, fill: [] }
  }
  const ring = polygonRing(p) ?? rectCorners(p)
  return { edges: ring.map((q, i) => [q, ring[(i + 1) % ring.length]] as [Vec2, Vec2]), half: 0, fill: [ring] }
}

/** A pad, trace, via or drawing as lines with a half width and a filled area, for measuring against a drawing. */
function itemCopper(it: CopperItem): ShapeCopper {
  if (it.kind === "shape") return it.copper
  let c = copperCache.get(it)
  if (c) return c
  if (it.kind === "segment") c = { edges: [[it.a, it.b]], half: it.width / 2, fill: [] }
  else if (it.kind === "via") c = { edges: [[it.at, it.at]], half: it.diameter / 2, fill: [] }
  else if (it.kind === "pad") {
    c = padCopper(it.pad)
  } else c = { edges: [], half: 0, fill: [] }
  copperCache.set(it, c)
  return c
}

/** Edge-to-edge distance between two copper items (0 when touching/overlapping). */
export function itemDistance(x: CopperItem, y: CopperItem): number {
  if (x.kind === "shape" || y.kind === "shape") return x.kind === "zone" || y.kind === "zone" ? Infinity : shapeShapeDistance(itemCopper(x), itemCopper(y))
  if (x.kind === "pad" && y.kind === "pad") return padPadDistance(x.pad, y.pad)
  if (x.kind === "segment" && y.kind === "segment")
    return Math.max(0, segmentSegmentDistance(x.a, x.b, y.a, y.b) - x.width / 2 - y.width / 2)
  if (x.kind === "via" && y.kind === "via") return Math.max(0, dist(x.at, y.at) - x.diameter / 2 - y.diameter / 2)
  if (x.kind === "pad" && y.kind === "segment") return Math.max(0, segmentPadDistance(y.a, y.b, x.pad) - y.width / 2)
  if (x.kind === "segment" && y.kind === "pad") return itemDistance(y, x)
  if (x.kind === "via" && y.kind === "segment")
    return Math.max(0, pointSegmentDistance(x.at, y.a, y.b) - x.diameter / 2 - y.width / 2)
  if (x.kind === "segment" && y.kind === "via") return itemDistance(y, x)
  if (x.kind === "via" && y.kind === "pad") return Math.max(0, pointPadDistance(x.at, y.pad) - x.diameter / 2)
  if (x.kind === "pad" && y.kind === "via") return itemDistance(y, x)
  return Infinity
}

const shareLayer = (a: CopperItem, b: CopperItem) => a.layers.some((l) => b.layers.includes(l))

/** Non-plated holes are copper obstacles (for clearance) but never conduct. */
export const isNpthItem = (it: CopperItem) => it.kind === "pad" && isNpth(it.pad)

/** At most this many points of a drawing stand for it in the ratsnest and where it joins a pour. */
const SHAPE_POINTS = 32

function itemPoint(item: CopperItem): Vec2[] {
  if (item.kind === "pad") return [{ x: item.pad.x, y: item.pad.y }]
  if (item.kind === "via") return [item.at]
  if (item.kind === "zone") return []
  if (item.kind === "shape") {
    const pts = item.copper.edges.flatMap(([a]) => [a])
    const step = Math.max(1, Math.ceil(pts.length / SHAPE_POINTS))
    return pts.filter((_, i) => i % step === 0)
  }
  return [item.a, item.b]
}

function itemCenter(item: CopperItem): Vec2 {
  if (item.kind === "pad") return { x: item.pad.x, y: item.pad.y }
  if (item.kind === "via") return item.at
  if (item.kind === "zone") return item.polygon[0][0]
  if (item.kind === "shape") return { x: (item.box.minX + item.box.maxX) / 2, y: (item.box.minY + item.box.maxY) / 2 }
  return { x: (item.a.x + item.b.x) / 2, y: (item.a.y + item.b.y) / 2 }
}

/** Points that join an item to a pour when they lie inside the fill. */
const anchorPoints = (item: CopperItem): Vec2[] => itemPoint(item)

/**
 * The copper of the board as items. A trace or via that names its net (a board brought in from KiCad)
 * carries it as `netId`; `useStored: false` leaves that out, which is what the editor would derive for
 * the same copper from the pads it touches alone.
 */
export function buildCopperItems(project: Project, sch: SchematicConnectivity, useStored = true): CopperItem[] {
  const items: CopperItem[] = []
  const stored = useStored && (project.traces.some((t) => t.net) || project.vias.some((v) => v.routedNet) || project.graphics?.some((g) => g.net) || project.footprints?.some((f) => f.shapes?.some((s) => s.net)))
  const netByName = stored ? new Map(sch.nets.map((n) => [n.name, n.id])) : null
  const idOf = (name: string | undefined) => (name && netByName ? (netByName.get(name.trim()) ?? null) : null)
  for (const c of project.components) {
    if (!c.pcb.placed || !isPhysical(findPart(c.partId))) continue
    pcbPads(c).forEach((pad, i) => {
      const netId = pad.pin ? (sch.pinNet.get(pinKey(c.id, pad.pin)) ?? null) : null
      items.push({ kind: "pad", id: `pad:${c.id}:${i}`, pad, netId, layers: pad.layers, box: padBox(pad) })
    })
  }
  for (const t of project.traces) {
    for (let i = 0; i < t.points.length - 1; i++) {
      const a = t.points[i]
      const b = t.points[i + 1]
      items.push({
        kind: "segment",
        id: `seg:${t.id}:${i}`,
        traceId: t.id,
        index: i,
        a,
        b,
        width: t.width,
        layers: [t.layer],
        box: segBox(a, b, t.width),
        ...(t.net ? { netId: idOf(t.net) } : {}),
      })
    }
  }
  for (const h of mountingHoles(project.board)) {
    const pad: WorldPad = {
      componentId: BOARD_OWNER,
      pin: null,
      padNumber: null,
      shape: "circle",
      x: h.x,
      y: h.y,
      width: h.diameter,
      height: h.diameter,
      holeDiameter: h.drill,
      layers: ["top", "bottom"],
    }
    items.push({ kind: "pad", id: `pad:${BOARD_OWNER}:${h.id}`, pad, netId: null, layers: pad.layers, box: padBox(pad) })
  }
  for (const v of project.vias) {
    const r = v.diameter / 2
    items.push({
      kind: "via",
      id: `via:${v.id}`,
      viaId: v.id,
      at: { x: v.x, y: v.y },
      diameter: v.diameter,
      layers: ["top", "bottom"],
      box: { minX: v.x - r, minY: v.y - r, maxX: v.x + r, maxY: v.y + r },
      ...(v.routedNet ? { netId: idOf(v.routedNet) } : {}),
    })
  }
  // Drawings on a copper layer.
  for (const w of worldShapes(project)) {
    if (!w.placed || (w.shape.layer !== "F.Cu" && w.shape.layer !== "B.Cu")) continue
    const layer: CopperLayer = w.shape.layer === "F.Cu" ? "top" : "bottom"
    const box = shapeInkBox(w.shape)
    items.push({
      kind: "shape",
      id: `shape:${w.id}`,
      shapeId: w.id,
      owner: w.owner,
      shape: w.shape,
      copper: shapeCopper(w.shape),
      conducts: useStored && !!w.shape.net,
      layers: [layer],
      box,
      ...(w.shape.net && useStored ? { netId: idOf(w.shape.net) } : {}),
    })
  }
  // Text on a copper layer is copper (never on a net): a pour keeps clear of it, the router goes round it, and it keeps clear of every net.
  for (const wt of worldTexts(project)) {
    if (!wt.placed || wt.hidden || (wt.layer !== "F.Cu" && wt.layer !== "B.Cu")) continue
    const t = layerText(project, wt)
    if (!t) continue
    const layer: CopperLayer = wt.layer === "F.Cu" ? "top" : "bottom"
    const edges: [Vec2, Vec2][] = []
    const fill: Vec2[][] = []
    for (const line of t.strokes) for (let i = 0; i + 1 < line.length; i++) edges.push([line[i], line[i + 1]])
    // A single-point stroke is a dot: an edge of no length.
    for (const line of t.strokes) if (line.length === 1) edges.push([line[0], line[0]])
    for (const polygon of t.fills) {
      for (const ring of polygon) {
        fill.push(ring)
        for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]])
      }
    }
    if (t.border) for (let i = 0; i < t.border.points.length; i++) edges.push([t.border.points[i], t.border.points[(i + 1) % t.border.points.length]])
    const half = t.fills.length ? 0 : t.pen / 2
    const box = t.box
    const shape: BoardShape = { type: "rect", a: { x: box.minX, y: box.minY }, b: { x: box.maxX, y: box.maxY }, layer: wt.layer, width: 0 }
    items.push({ kind: "shape", id: `text:${wt.id}`, shapeId: wt.id, owner: wt.owner, shape, copper: { edges, half, fill }, conducts: false, layers: [layer], box, what: "text" })
  }
  return items
}

/** Visit every pair of items whose boxes, grown by `pad`, overlap in x (sweep and prune). */
function forOverlappingPairs(items: CopperItem[], pad: number, visit: (i: number, j: number) => void) {
  const order = items.map((_, i) => i).sort((a, b) => items[a].box.minX - items[b].box.minX)
  for (let a = 0; a < order.length; a++) {
    const i = order[a]
    const maxX = items[i].box.maxX + pad
    for (let b = a + 1; b < order.length; b++) {
      const j = order[b]
      if (items[j].box.minX > maxX) break
      if (i < j) visit(i, j)
      else visit(j, i)
    }
  }
}

interface Islands {
  find: (i: number) => number
  islandNets: Map<number, Set<string>>
  islandNet: Map<number, string | null>
}

/** Union-find over copper items: touching copper on a shared layer, aliased pads, and pour anchors. */
function connectItems(items: CopperItem[], ties: NetTies | null = null): Islands {
  const n = items.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const sameComponentPads = (x: CopperItem, y: CopperItem) =>
    x.kind === "pad" && y.kind === "pad" && x.pad.componentId === y.pad.componentId

  // Consecutive segments of one trace always connect.
  const segIndex = new Map<string, number>()
  items.forEach((it, i) => {
    if (it.kind === "segment") segIndex.set(`${it.traceId}:${it.index}`, i)
  })
  items.forEach((it, i) => {
    if (it.kind === "segment") {
      const prev = segIndex.get(`${it.traceId}:${it.index - 1}`)
      if (prev !== undefined) union(prev, i)
    }
  })

  forOverlappingPairs(items, 0, (i, j) => {
    const x = items[i]
    const y = items[j]
    if (!shareLayer(x, y) || !boxesOverlap(x.box, y.box)) return
    // A non-plated hole has no copper: whatever touches it stays its own island.
    if (isNpthItem(x) || isNpthItem(y)) return
    // A drawing that names no net is copper that connects nothing.
    if ((x.kind === "shape" && !x.conducts) || (y.kind === "shape" && !y.conducts)) return
    if (x.kind === "zone" || y.kind === "zone") {
      const [z, o] = x.kind === "zone" ? [x, y] : [y, x]
      if (z.kind === "zone" && o.kind !== "zone" && anchorPoints(o).some((p) => z.contains(p))) union(i, j)
      return
    }
    if (sameComponentPads(x, y)) return
    if (itemDistance(x, y) > 1e-6) return
    if (ties && tieExempt(ties, x, y)) return
    union(i, j)
  })

  // Same-pin pads of a component (aliases like SOT-223 tab) are internally connected.
  const padByPin = new Map<string, number>()
  items.forEach((it, i) => {
    if (it.kind !== "pad" || !it.pad.pin) return
    const key = `${it.pad.componentId}:${it.pad.pin}`
    const first = padByPin.get(key)
    if (first === undefined) padByPin.set(key, i)
    else union(first, i)
  })

  // A pad's net, and the net a trace or via of an imported board says it is on.
  const islandNets = new Map<number, Set<string>>()
  items.forEach((it, i) => {
    if (it.kind === "zone" || !it.netId) return
    const r = find(i)
    const s = islandNets.get(r) ?? new Set<string>()
    s.add(it.netId)
    islandNets.set(r, s)
  })
  const islandNet = new Map<number, string | null>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (islandNet.has(r)) continue
    const s = islandNets.get(r)
    islandNet.set(r, !s || s.size === 0 ? null : s.size === 1 ? [...s][0] : "short")
  }
  return { find, islandNets, islandNet }
}

function zoneItems(fills: ZoneFill[]): CopperItem[] {
  const out: CopperItem[] = []
  for (const f of fills) {
    f.polygons.forEach((polygon, i) => {
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      for (const p of polygon[0]) {
        box.minX = Math.min(box.minX, p.x)
        box.minY = Math.min(box.minY, p.y)
        box.maxX = Math.max(box.maxX, p.x)
        box.maxY = Math.max(box.maxY, p.y)
      }
      out.push({
        kind: "zone",
        id: `zone:${f.zoneId}:${i}`,
        zoneId: f.zoneId,
        polygon,
        contains: fillTester(polygon),
        layers: [f.layer],
        box,
      })
    })
  }
  return out
}

// ---------- Net ties ----------

/** The net tie groups of the parts on the board, and the pads of each that carry a net; null when no part has a net tie. */
interface NetTies {
  /** By component id: the pads in its tie groups that are on a net (the pad's item and its net). */
  pads: Map<string, { item: CopperItem; net: string }[]>
}

function netTies(project: Project, items: CopperItem[]): NetTies | null {
  const tied = project.components.filter((c) => c.flags?.netTies?.length)
  if (!tied.length) return null
  const numbers = new Map(tied.map((c) => [c.id, new Set(netTieGroups(c).flatMap((g) => [...g]))]))
  const pads = new Map<string, { item: CopperItem; net: string }[]>(tied.map((c) => [c.id, []]))
  for (const it of items) {
    if (it.kind !== "pad" || !it.netId || !it.pad.padNumber) continue
    if (numbers.get(it.pad.componentId)?.has(it.pad.padNumber)) pads.get(it.pad.componentId)!.push({ item: it, net: it.netId })
  }
  return { pads }
}

const ownerOf = (it: CopperItem): string | null => (it.kind === "pad" ? it.pad.componentId : it.kind === "shape" ? it.owner : null)
const netOfItem = (it: CopperItem): string | null => (it.kind === "pad" || it.kind === "shape" || it.kind === "segment" || it.kind === "via" ? (it.netId ?? null) : null)

/**
 * Whether two copper items that meet are allowed to, because one belongs to a net tie footprint. KiCad
 * exempts only the tie's own copper (`DRC_ENGINE::IsNetTieExclusion`): the tie's own pads and drawings may overlap each other
 * whatever their nets, and a track meeting the tie's other copper is excused only where it enters a tie pad on the track's own net
 * (there the tie's copper lies under the track's own net). A track of net A that meets the tie's pad of net B anywhere else is a
 * short, as it is anywhere else on the board. "Where" is judged as the point of the track nearest the other copper lying inside
 * that tie pad, with the pad touching both.
 */
/** The point of an item nearest a place, which stands for where it meets another item there. */
function nearestPointOf(it: CopperItem, ref: Vec2): Vec2 {
  if (it.kind === "segment") return closestPointOnSegment(ref, it.a, it.b)
  if (it.kind === "via") return it.at
  if (it.kind === "pad") return { x: it.pad.x, y: it.pad.y }
  if (it.kind === "shape") {
    let best: Vec2 = itemCenter(it)
    let d = Infinity
    for (const [a] of it.copper.edges) {
      const dd = Math.hypot(a.x - ref.x, a.y - ref.y)
      if (dd < d) {
        d = dd
        best = a
      }
    }
    return best
  }
  return itemCenter(it)
}

function tieExempt(ties: NetTies, x: CopperItem, y: CopperItem): boolean {
  const ox = ownerOf(x)
  const oy = ownerOf(y)
  // The tie's own copper: its pads and drawings may overlap each other.
  const nx = netOfItem(x)
  const ny = netOfItem(y)
  if (ox !== null && ox === oy && ties.pads.has(ox) && nx && ny && nx !== ny) return true
  for (const [foreign, own, owner] of [[x, y, oy], [y, x, ox]] as const) {
    if (owner === null || !ties.pads.has(owner) || ownerOf(foreign) === owner) continue
    const net = netOfItem(foreign)
    if (!net) continue
    for (const p of ties.pads.get(owner)!) {
      if (p.net !== net) continue
      // The track is on this tie pad's net and enters it, and the other copper of the tie overlaps that pad there.
      if (own === p.item || itemDistance(foreign, p.item) > 1e-6 || itemDistance(own, p.item) > 1e-6) continue
      // ... and the meeting is inside that pad: the foreign copper where it is nearest the tie's other copper lies in the pad.
      const at = nearestPointOf(foreign, itemCenter(own))
      if (p.item.kind === "pad" && pointPadDistance(at, p.item.pad) <= 1e-6) return true
    }
  }
  return false
}

/**
 * Which net each trace and via is on from what it touches alone, ignoring the nets a trace or via
 * says it is on: what the editor derives, to compare with what a board brought in from KiCad says.
 * "short" for copper that touches pads of two nets, null for copper that touches none.
 */
export function derivedCopperNets(project: Project, sch: SchematicConnectivity): { traceNet: Map<string, string | null>; viaNet: Map<string, string | null> } {
  const items = buildCopperItems(project, sch, false)
  const { find, islandNet } = connectItems(items, netTies(project, items))
  const traceNet = new Map<string, string | null>()
  const viaNet = new Map<string, string | null>()
  items.forEach((it, i) => {
    const net = islandNet.get(find(i)) ?? null
    if (it.kind === "segment" && !traceNet.has(it.traceId)) traceNet.set(it.traceId, net)
    if (it.kind === "via") viaNet.set(it.viaId, net)
  })
  return { traceNet, viaNet }
}

/**
 * Connectivity, ratsnest and DRC for the board. `fills` reuses earlier pour fills instead of
 * recomputing them, which keeps drags responsive.
 */
export function analyzePcb(
  project: Project,
  sch: SchematicConnectivity,
  opts: {
    fills?: ZoneFill[]
    keepIslands?: boolean
    /** Fill no zone whose fill is not kept already: `stale` stands in for it and the analysis says so (`zonesPending`). */
    reuseOnly?: { stale: ZoneFill[] }
    /** Take `fills` as they were made with the copper whose ids are in `known`, and cut the copper added since out of them (`carveFills`), instead of filling again. */
    carve?: { fills: ZoneFill[]; known: ReadonlySet<string> }
  } = {},
): PcbAnalysis {
  const copper = buildCopperItems(project, sch)
  // Pours need each item's net, which comes from copper connectivity without the pours.
  let zoneFills: ZoneFill[] = opts.fills ?? []
  let pending: PendingGroup[] = []
  if (project.zones.length && !opts.fills) {
    const pre = connectItems(copper, netTies(project, copper))
    // A stitching via touches nothing but the pours, so it carries its net itself.
    const viaNetName = new Map(project.vias.filter((v) => v.net).map((v) => [v.id, v.net!]))
    const netOf = (i: number) => {
      const net = pre.islandNet.get(pre.find(i)) ?? null
      const it = copper[i]
      if (net === null && it.kind === "via" && viaNetName.has(it.viaId)) {
        return sch.nets.find((n) => n.name === viaNetName.get(it.viaId))?.id ?? null
      }
      return net === "short" ? null : net
    }
    if (opts.carve) {
      const { fills, known } = opts.carve
      zoneFills = carveFills(project, fills, copper.flatMap((it, i) => (known.has(it.id) ? [] : [{ item: it, net: netOf(i) }])))
    } else if (opts.reuseOnly) {
      const r = fillZonesReusing(project, sch, { items: copper, netOf, keepIslands: opts.keepIslands }, opts.reuseOnly.stale)
      zoneFills = r.fills
      pending = r.missing
    } else zoneFills = fillZones(project, sch, { items: copper, netOf, keepIslands: opts.keepIslands })
  }
  const items = zoneFills.length ? [...copper, ...zoneItems(zoneFills)] : copper
  // Net ties: a net tie footprint's own copper may overlap itself, and a track is excused where it enters a tie pad of its own net.
  const ties = netTies(project, items)
  const { find, islandNets, islandNet } = connectItems(items, ties)

  const island = new Map<string, number>()
  items.forEach((it, i) => island.set(it.id, find(i)))

  const traceNet = new Map<string, string | null>()
  const viaNet = new Map<string, string | null>()
  items.forEach((it, i) => {
    const net = islandNet.get(find(i)) ?? null
    if (it.kind === "segment" && !traceNet.has(it.traceId)) traceNet.set(it.traceId, net)
    if (it.kind === "via") viaNet.set(it.viaId, net)
  })

  const violations: DrcViolation[] = []
  let vid = 0
  const push = (v: Omit<DrcViolation, "id">) => violations.push({ ...v, id: `drc${vid++}` })

  // Shorts
  for (const [root, nets] of islandNets) {
    if (nets.size < 2) continue
    const names = [...nets].map((id) => sch.nets.find((x) => x.id === id)?.name ?? id)
    const idx = items.findIndex((_, i) => find(i) === root && items[i].kind === "segment")
    const at = itemCenter(items[idx >= 0 ? idx : items.findIndex((_, i) => find(i) === root)])
    push({ severity: "error", kind: "short", message: `Short between ${names.join(", ")}`, at })
  }

  // Ratsnest: MST between islands of each net.
  const ratsnest: RatsLine[] = []
  const netIslands = new Map<string, Map<number, Vec2[]>>()
  items.forEach((it, i) => {
    const r = find(i)
    const net = it.kind === "pad" ? it.netId : islandNet.get(r)
    if (!net || net === "short" || it.kind === "zone") return
    const m = netIslands.get(net) ?? new Map<number, Vec2[]>()
    const pts = m.get(r) ?? []
    pts.push(...itemPoint(it))
    m.set(r, pts)
    netIslands.set(net, m)
  })
  for (const [netId, islands] of netIslands) {
    const groups = [...islands.values()]
    if (groups.length < 2) continue
    const inTree = [0]
    const remaining = new Set(groups.map((_, i) => i).slice(1))
    while (remaining.size) {
      let best: { d: number; a: Vec2; b: Vec2; g: number } | null = null
      for (const ti of inTree) {
        for (const gi of remaining) {
          for (const a of groups[ti]) {
            for (const b of groups[gi]) {
              const d = dist(a, b)
              if (!best || d < best.d) best = { d, a, b, g: gi }
            }
          }
        }
      }
      if (!best) break
      ratsnest.push({ netId, a: best.a, b: best.b })
      inTree.push(best.g)
      remaining.delete(best.g)
    }
  }
  for (const r of ratsnest) {
    const name = sch.nets.find((x) => x.id === r.netId)?.name ?? r.netId
    push({
      severity: "warning",
      kind: "unrouted",
      message: `Unrouted connection on ${name}`,
      at: { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 },
    })
  }

  // Clearance between copper on different nets (or unassigned copper vs a net).
  const clearance = project.rules.clearance
  const reported = new Set<string>()
  const refOfPart = new Map(project.components.map((c) => [c.id, c.ref]))
  /** Which copper an item is, for a message: a pad as "J1.2", else a trace, a via or a mounting hole. */
  const describe = (it: CopperItem) => {
    if (it.kind === "pad") return it.pad.componentId === BOARD_OWNER ? "a mounting hole" : `${refOfPart.get(it.pad.componentId) ?? "a part"}.${it.pad.padNumber ?? it.pad.pin ?? "pad"}`
    if (it.kind === "shape") {
      const what = it.what === "text" ? "copper text" : "copper drawing"
      return it.owner === BOARD_OWNER ? `a ${what}` : `a ${what} of ${refOfPart.get(it.owner) ?? "a part"}`
    }
    return it.kind === "segment" ? "a trace" : it.kind === "via" ? "a via" : "a pour"
  }
  forOverlappingPairs(items, clearance, (i, j) => {
    const x = items[i]
    const y = items[j]
    if (x.kind === "zone" || y.kind === "zone") return
    if (!shareLayer(x, y)) return
    if (x.kind === "pad" && y.kind === "pad" && x.pad.componentId === y.pad.componentId) return
    // Hole-to-hole spacing is a drill rule, not a copper clearance.
    const holeX = isNpthItem(x)
    const holeY = isNpthItem(y)
    if (holeX && holeY) return
    if (!boxesOverlap(inflate(x.box, clearance), y.box)) return
    const ri = find(i)
    const rj = find(j)
    if (ri === rj) return
    const ni = islandNet.get(ri)
    const nj = islandNet.get(rj)
    if (ni && nj && ni === nj && ni !== "short") return
    // Copper drawings that name no net are checked against copper that has one, not against each other or against copper that has none.
    if ((x.kind === "shape" || y.kind === "shape") && !ni && !nj) return
    // A net tie's own copper, and a track entering a tie pad of its own net, are excused (see `tieExempt`); and so is a part's own copper against itself.
    if (ties && tieExempt(ties, x, y)) return
    if (x.kind === "shape" || y.kind === "shape") {
      const ox = ownerOf(x)
      if (ox !== null && ox === ownerOf(y) && ox !== BOARD_OWNER) return
    }
    const d = itemDistance(x, y)
    if (d >= clearance - 1e-6) return
    const key = `${Math.min(ri, rj)}:${Math.max(ri, rj)}`
    if (reported.has(key)) return
    reported.add(key)
    const at =
      x.kind === "segment"
        ? closestPointOnSegment(itemCenter(y), x.a, x.b)
        : y.kind === "segment"
          ? closestPointOnSegment(itemCenter(x), y.a, y.b)
          : itemCenter(x)
    push({
      severity: "error",
      kind: "clearance",
      message: `${holeX || holeY ? "Hole clearance" : "Clearance"} ${d.toFixed(3)} mm < ${clearance} mm between ${describe(x)} and ${describe(y)}`,
      at,
    })
  })

  // Board edge
  const b = project.board
  // A board whose outline is not closed (or is missing) cannot be cut out: the one error that says so, where the outline stops.
  const state = outlineState(b)
  if (state !== "closed") {
    const open = (b.outline?.paths ?? []).filter((p) => !p.closed)
    const first = open[0]
    const at = first ? segEnd(first.segs[first.segs.length - 1]) : { x: b.x, y: b.y }
    push({
      severity: "error",
      kind: "outline",
      message: state === "missing" ? "The board has no outline, so it cannot be cut out" : `The board outline is not closed: ${open.length} piece${open.length === 1 ? "" : "s"} of it end${open.length === 1 ? "s" : ""} in the open`,
      at: { x: at.x, y: at.y },
    })
  }
  // Edges that cross themselves or each other cannot be cut either: one error each, where they meet.
  for (const x of outlineCrossings(b.outline?.paths ?? [])) push({ severity: "error", kind: "outline", message: `${crossingSentence(x)}, so it cannot be cut out`, at: x.at })
  for (const c of project.components) {
    const cy = c.pcb.placed && hasCourtyard(c) ? pcbCourtyard(c) : null
    if (cy && partOutsideBoard(project, c, cy)) {
      push({
        severity: "error",
        kind: "outside-board",
        message: `${c.ref} is outside the board outline`,
        at: { x: c.pcb.x, y: c.pcb.y },
      })
    }
  }

  // Courtyard overlap
  const placed = project.components
    .map((c) => ({ c, box: c.pcb.placed && hasCourtyard(c) ? pcbCourtyard(c) : null }))
    .filter((x): x is { c: (typeof project.components)[number]; box: Box } => !!x.box)
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i]
      const q = placed[j]
      if (p.c.pcb.side !== q.c.pcb.side) continue
      if (!boxesOverlap(inflate(p.box, -0.05), inflate(q.box, -0.05))) continue
      // A part at an angle that is not a quarter turn has a turned courtyard, whose box overlaps more than it does.
      if (!isQuarterTurn(p.c.pcb.rot) || !isQuarterTurn(q.c.pcb.rot)) {
        const ra = pcbCourtyardRing(p.c)
        const rb = pcbCourtyardRing(q.c)
        if (ra && rb && convexOverlap(ra, rb) <= 0.1) continue
      }
      push({
        severity: "warning",
        kind: "overlap",
        message: `${p.c.ref} overlaps ${q.c.ref}`,
        at: { x: (p.c.pcb.x + q.c.pcb.x) / 2, y: (p.c.pcb.y + q.c.pcb.y) / 2 },
      })
    }
  }

  // Rule areas that keep tracks, vias, pads or parts out.
  if (project.zones.length) for (const v of keepoutViolations(project, items)) push(v)

  // Decoupling capacitors far from the supply pin they serve. Where several chips share the rail,
  // a capacitor beside the supply pin of any of them is fine, so only one far from all is reported.
  for (const d of decouplingGaps(project, decouplingPairs(project, sch))) {
    // Judged as the message rounds it, so "3.0 mm" never reads as over 3 mm.
    if (Number(d.gap.toFixed(1)) <= DECOUPLING_WARN_MM) continue
    push({
      severity: "warning",
      kind: "decoupling",
      message: `${d.cap.ref} is ${d.gap.toFixed(1)} mm from ${d.chip.ref} pin ${d.pin} (${d.pinName}); aim for under ${DECOUPLING_WARN_MM} mm`,
      at: { x: d.cap.pcb.x, y: d.cap.pcb.y },
    })
  }

  manufacturability(project, items, find, push)

  for (const conflict of sch.conflicts) {
    push({
      severity: "warning",
      kind: "net-conflict",
      message: `Net names merged: ${conflict.names.join(", ")}`,
      at: { x: 0, y: 0 },
    })
  }

  return { items, island, islandNet, traceNet, viaNet, ratsnest, violations, zoneFills, ...(pending.length ? { zonesPending: pending } : {}) }
}

// ---------- Manufacturability ----------

const mm = (v: number) => formatLength(v, "mm", true)

/**
 * Whether a placed part's courtyard is not wholly on the board. A part on a quarter turn is its box against the board's box (or its outline); a part
 * at any other angle is its turned courtyard itself, so a part standing across a corner is not taken for one that sticks out.
 */
export function partOutsideBoard(project: Project, c: ComponentInstance, box = pcbCourtyard(c)): boolean {
  if (!box) return false
  const b = project.board
  const geometry = outlineGeometry(b)
  if (!isQuarterTurn(c.pcb.rot)) {
    const ring = pcbCourtyardRing(c)
    if (ring) return geometry ? !ringOnBoard(geometry, ring) : ring.some((p) => edgeDistance(b, p) < -1e-9)
  }
  if (geometry) return !boxOnBoard(geometry, box)
  return box.minX < b.x - b.width / 2 || box.maxX > b.x + b.width / 2 || box.minY < b.y - b.height / 2 || box.maxY > b.y + b.height / 2
}

/** Distance from a point inside the board to its (rounded) outline; negative outside. */
export function edgeDistance(b: BoardDef, p: Vec2): number {
  const g = outlineGeometry(b)
  if (g) return g.signedDistance(p)
  const r = Math.max(0, Math.min(b.cornerRadius, b.width / 2, b.height / 2))
  const qx = Math.abs(p.x - b.x) - (b.width / 2 - r)
  const qy = Math.abs(p.y - b.y) - (b.height / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  return -outside
}

/**
 * How close an item's copper comes to the board edge. The inner distance to a convex
 * outline is concave, so over a segment or a rectangle it is smallest at a vertex.
 */
function itemEdgeDistance(b: BoardDef, it: CopperItem, limit = Infinity): number {
  const g = outlineGeometry(b)
  if (g) {
    // A board with an outline of its own: the copper's centre lines against every edge, so concave corners, arcs and cutouts count.
    if (it.kind === "zone") return Infinity
    const c = itemCopper(it)
    return copperEdgeClearance(g, c.edges, c.half, limit)
  }
  const d = (p: Vec2) => edgeDistance(b, p)
  if (it.kind === "segment") return Math.min(d(it.a), d(it.b)) - it.width / 2
  if (it.kind === "via") return d(it.at) - it.diameter / 2
  // A drawing is nearest the edge at one of its points (the outline is convex, so the distance is smallest at a vertex).
  if (it.kind === "shape") return it.copper.edges.reduce((m, [a, b]) => Math.min(m, d(a), d(b)), Infinity) - it.copper.half
  if (it.kind !== "pad") return Infinity
  const pad = it.pad
  if (pad.shape === "circle") return d(pad) - pad.width / 2
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    const ends = pad.width >= pad.height ? [{ x: pad.x - half, y: pad.y }, { x: pad.x + half, y: pad.y }] : [{ x: pad.x, y: pad.y - half }, { x: pad.x, y: pad.y + half }]
    return Math.min(...ends.map(d)) - r
  }
  if (pad.shape === "polygon" && pad.points?.length) return Math.min(...pad.points.map(d))
  return Math.min(...rectCorners(pad).map(d))
}

interface Hole {
  owner: string
  /** Centre line of the hole: one point, or the two end centres of a slot. */
  a: Vec2
  b: Vec2
  diameter: number
}

function holesOf(items: CopperItem[], drillOf: Map<string, number>): Hole[] {
  const out: Hole[] = []
  for (const it of items) {
    if (it.kind === "via") out.push({ owner: it.id, a: it.at, b: it.at, diameter: drillOf.get(it.viaId) ?? 0 })
    if (it.kind === "pad" && it.pad.holeDiameter) {
      const ends = slotEnds(it.pad)
      out.push({ owner: it.pad.componentId, a: ends?.[0] ?? it.pad, b: ends?.[1] ?? it.pad, diameter: it.pad.holeDiameter })
    }
  }
  return out
}

/** Vias whose drill lands in an SMD pad, which the fab has to fill and cap. */
export function viasInSmdPads(project: Project, items: CopperItem[]): { via: Via; pad: WorldPad }[] {
  const smd = items.filter((it): it is Extract<CopperItem, { kind: "pad" }> => it.kind === "pad" && !it.pad.holeDiameter)
  const out: { via: Via; pad: WorldPad }[] = []
  for (const v of project.vias) {
    const hit = smd.find((p) => v.x >= p.box.minX - v.drill && v.x <= p.box.maxX + v.drill && v.y >= p.box.minY - v.drill && v.y <= p.box.maxY + v.drill && pointPadDistance(v, p.pad) < v.drill / 2)
    if (hit) out.push({ via: v, pad: hit.pad })
  }
  return out
}

/**
 * Checks a fab would reject the board for: traces below the minimum width, drills below the
 * minimum, thin annular rings, holes too close together, copper too close to the edge, vias
 * in SMD pads, and copper that belongs to no net. Pad-level problems are reported once per
 * part so a footprint with many small holes doesn't flood the list.
 */
function manufacturability(
  project: Project,
  items: CopperItem[],
  find: (i: number) => number,
  push: (v: Omit<DrcViolation, "id">) => void,
) {
  const { rules, board } = project
  const eps = 1e-6
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const owner = (id: string) => (id === BOARD_OWNER ? "Mounting holes" : (refOf.get(id) ?? "A part"))

  for (const t of project.traces) {
    if (t.width >= rules.minTraceWidth - eps || t.points.length < 2) continue
    const [a, b] = t.points
    push({
      severity: "error",
      kind: "trace-width",
      message: `Trace ${mm(t.width)} is narrower than the ${mm(rules.minTraceWidth)} minimum`,
      at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    })
  }

  // Drill and annular ring, the smallest per via or per part.
  const smallest = new Map<string, { value: number; at: Vec2; what: string }>()
  const note = (key: string, value: number, at: Vec2, what: string) => {
    const prev = smallest.get(key)
    if (!prev || value < prev.value) smallest.set(key, { value, at, what })
  }
  for (const v of project.vias) {
    // KiCad's `via_min_size`: a via narrower than the rule's minimum diameter (the rule is absent on a board drawn here)
    if (rules.minViaDiameter !== undefined && v.diameter < rules.minViaDiameter - eps) {
      push({ severity: "error", kind: "via-size", message: `Via diameter ${mm(v.diameter)} is below the ${mm(rules.minViaDiameter)} minimum`, at: { x: v.x, y: v.y } })
    }
    if (v.drill < rules.minDrill - eps) note(`drill:via:${v.id}`, v.drill, v, "Via")
    const ring = (v.diameter - v.drill) / 2
    if (ring < rules.minAnnularRing - eps) note(`ring:via:${v.id}`, ring, v, "Via")
  }
  for (const it of items) {
    if (it.kind !== "pad" || !it.pad.holeDiameter) continue
    const pad = it.pad
    const hole = it.pad.holeDiameter
    const at = { x: pad.x, y: pad.y }
    if (hole < rules.minDrill - eps) note(`drill:${pad.componentId}`, hole, at, owner(pad.componentId))
    if (isNpth(pad)) continue
    const ring = (Math.min(pad.width, pad.height) - hole) / 2
    if (ring < rules.minAnnularRing - eps) note(`ring:${pad.componentId}`, ring, at, owner(pad.componentId))
  }
  for (const [key, s] of smallest) {
    const drill = key.startsWith("drill:")
    push({
      severity: "error",
      kind: drill ? "drill" : "annular-ring",
      message: drill
        ? `${s.what} drill ${mm(s.value)} is below the ${mm(rules.minDrill)} minimum`
        : s.value < eps
          ? `${s.what} has no copper ring around its hole`
          : `${s.what} annular ring ${mm(s.value)} is below the ${mm(rules.minAnnularRing)} minimum`,
      at: s.at,
    })
  }

  // Hole to hole. A footprint's own holes are its maker's land pattern and aren't checked against each other.
  // Copper items carry a via's diameter but not its drill.
  const drillOf = new Map(project.vias.map((v) => [v.id, v.drill]))
  // Swept by left drill edge, so once one hole starts past h's reach every later one does too.
  const left = (h: Hole) => Math.min(h.a.x, h.b.x) - h.diameter / 2
  const reach = (h: Hole) => Math.max(h.a.x, h.b.x) + h.diameter / 2
  const holes = holesOf(items, drillOf).sort((p, q) => left(p) - left(q))
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i]
    for (let j = i + 1; j < holes.length; j++) {
      const k = holes[j]
      if (left(k) > reach(h) + rules.holeClearance) break
      if (h.owner === k.owner) continue
      const gap = segmentSegmentDistance(h.a, h.b, k.a, k.b) - h.diameter / 2 - k.diameter / 2
      if (gap >= rules.holeClearance - eps) continue
      push({
        severity: "error",
        kind: "hole-clearance",
        message: gap <= 0 ? "Drill holes overlap" : `Holes ${mm(gap)} apart, closer than the ${mm(rules.holeClearance)} minimum`,
        at: { x: (h.a.x + k.a.x) / 2, y: (h.a.y + k.a.y) / 2 },
      })
    }
  }

  // Copper to board edge: once per trace, via or part. Parts that overhang are already reported.
  const edgeSeen = new Set<string>()
  for (const it of items) {
    if (it.kind === "zone" || isNpthItem(it)) continue
    const d = itemEdgeDistance(board, it, rules.edgeClearance + 0.01)
    if (d >= rules.edgeClearance - eps) continue
    const key = it.kind === "segment" ? it.traceId : it.kind === "via" ? it.viaId : it.kind === "shape" ? it.shapeId : it.pad.componentId
    if (edgeSeen.has(key)) continue
    edgeSeen.add(key)
    const at = it.kind === "segment" ? (edgeDistance(board, it.a) < edgeDistance(board, it.b) ? it.a : it.b) : it.kind === "via" ? it.at : it.kind === "shape" ? { x: (it.box.minX + it.box.maxX) / 2, y: (it.box.minY + it.box.maxY) / 2 } : { x: it.pad.x, y: it.pad.y }
    const what = it.kind === "segment" ? "Trace" : it.kind === "via" ? "Via" : it.kind === "shape" ? (it.what === "text" ? "Copper text" : "Copper drawing") : `${owner(it.pad.componentId)} pad`
    push({
      severity: it.kind === "pad" ? "warning" : "error",
      kind: "edge-clearance",
      message: d < 0 ? `${what} crosses the board edge` : `${what} is ${mm(d)} from the board edge, closer than ${mm(rules.edgeClearance)}`,
      at,
    })
  }

  // Via drills in SMD pads.
  if (!rules.viaInPad) {
    for (const { via: v, pad } of viasInSmdPads(project, items)) {
      push({
        severity: "error",
        kind: "via-in-pad",
        message: `Via in a pad of ${owner(pad.componentId)}; allow via-in-pad or move it`,
        at: { x: v.x, y: v.y },
      })
    }
  }

  // Copper on no net: a trace or via whose island reaches no pad and no pour.
  const anchored = new Set<number>()
  items.forEach((it, i) => {
    if (it.kind === "pad" || it.kind === "zone") anchored.add(find(i))
  })
  const floating = new Set<number>()
  items.forEach((it, i) => {
    if (it.kind !== "segment" && it.kind !== "via") return
    const root = find(i)
    if (anchored.has(root) || floating.has(root)) return
    floating.add(root)
    push({
      severity: "warning",
      kind: "floating-copper",
      message: it.kind === "via" ? "Via isn't connected to anything" : "Trace isn't connected to anything",
      at: it.kind === "via" ? it.at : { x: (it.a.x + it.b.x) / 2, y: (it.a.y + it.b.y) / 2 },
    })
  })
}
