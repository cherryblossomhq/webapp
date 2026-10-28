import {
  boxesOverlap,
  closestPointOnSegment,
  dist,
  isQuarterTurn,
  pointSegmentDistance,
  segmentSegmentDistance,
  type Box,
} from "../lib/geometry"
import { resolvedComponents } from "../model/ruleAreas"
import { mountingHoles } from "./board"
import { crossingSentence, outlineCrossings } from "./outlineCrossing"
import { boxOnBoard, convexOverlap, copperEdgeClearance, outlineGeometry, outlineState, ringOnBoard } from "./outline"
import { pinKey, type SchematicConnectivity } from "./connectivity"
import { arcArcDistance, arcBox, arcOf, arcPolyline, isArcTrace, pointArcDistance, segmentArcDistance, type ArcTrack } from "./arcTracks"
import { copperLayers, layerOfKicadName, viaDiameterOn, viaLayers } from "./stack"
import { DECOUPLING_WARN_MM, decouplingGaps, decouplingPairs } from "./decoupling"
import { hasCourtyard, isNpth, maskSides, pcbCourtyard, pcbCourtyardRing, pcbPads, slotEnds, type WorldPad } from "./instances"
import { maskMargin } from "./padOpening"
import { holeCentre, padBox, padCopper, padEdgeDistance, padRingsOf, padRingWidth, pointPadDistance, segmentPadDistance } from "./padDistance"
import { classIndex, hasNetClasses } from "./netClasses"
import { onBoard } from "./partFlags"
import { keepoutViolations } from "./zoneChecks"
import { carveFills, type PendingGroup } from "./zoneFill"
import { fillTester, fillZones, fillZonesReusing, type FillPolygon, type ZoneFill } from "./pour"
import { formatLength } from "./rules"
import { netTieGroups } from "./partFlags"
import { worldShapes } from "./shapeItems"
import { segEnd, shapeCopper, shapeInkBox, shapeShapeDistance, type ShapeCopper } from "./shapes"
import { layerText, worldTexts } from "./texts"
import type { BoardDef, BoardShape, ComponentInstance, CopperLayer, Project, Vec2, Via } from "./types"

export { pointPadDistance, segmentPadDistance }

/** componentId used for board-level copper such as mounting holes. */
export const BOARD_OWNER = "#board"

export type CopperItem =
  | { kind: "pad"; id: string; pad: WorldPad; netId: string | null; layers: CopperLayer[]; box: Box; unflashed?: CopperLayer[] }
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
      /** X4: the track is this arc, from `a` to `b` through its middle point (a trace with `arc`), not the straight line between them. */
      arc?: ArcTrack
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
      /** X1: the layers of its span where the via has no copper because nothing connects there (see `pruneUnused`). */
      unflashed?: CopperLayer[]
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
    | "mask-bridge"
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

const segBox = (a: Vec2, b: Vec2, w: number): Box => ({
  minX: Math.min(a.x, b.x) - w / 2,
  minY: Math.min(a.y, b.y) - w / 2,
  maxX: Math.max(a.x, b.x) + w / 2,
  maxY: Math.max(a.y, b.y) + w / 2,
})

const inflate = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })

function padPadDistance(p: WorldPad, q: WorldPad): number {
  if (p.shape === "circle" && q.shape === "circle") return Math.max(0, dist(p, q) - p.width / 2 - q.width / 2)
  if (padRingsOf(p) || padRingsOf(q) || p.corner || q.corner) return shapeShapeDistance(padCopper(p), padCopper(q))
  const a = padBox(p)
  const b = padBox(q)
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0)
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0)
  return Math.hypot(dx, dy)
}

const copperCache = new WeakMap<CopperItem, ShapeCopper>()

/** A pad, trace, via or drawing as lines with a half width and a filled area, for measuring against a drawing. */
function itemCopper(it: CopperItem): ShapeCopper {
  if (it.kind === "shape") return it.copper
  let c = copperCache.get(it)
  if (c) return c
  if (it.kind === "segment") c = { edges: segmentChords(it), half: it.width / 2, fill: [] }
  else if (it.kind === "via") c = { edges: [[it.at, it.at]], half: it.diameter / 2, fill: [] }
  else if (it.kind === "pad") {
    c = padCopper(it.pad)
  } else c = { edges: [], half: 0, fill: [] }
  copperCache.set(it, c)
  return c
}

/** The chords of a track item: the one segment of a straight track, an arc track's curve cut to within the drawings' own tolerance. */
function segmentChords(it: Extract<CopperItem, { kind: "segment" }>): [Vec2, Vec2][] {
  if (!it.arc) return [[it.a, it.b]]
  const pts = arcPolyline([it.arc.start, it.arc.mid, it.arc.end])
  const out: [Vec2, Vec2][] = []
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]])
  return out
}

/** The distance from a point to a track's centre line. */
const pointTrackDistance = (p: Vec2, s: Extract<CopperItem, { kind: "segment" }>) => (s.arc ? pointArcDistance(p, s.arc) : pointSegmentDistance(p, s.a, s.b))

/** The distance between two tracks' centre lines (exact for arcs). */
function trackTrackDistance(x: Extract<CopperItem, { kind: "segment" }>, y: Extract<CopperItem, { kind: "segment" }>): number {
  if (x.arc && y.arc) return arcArcDistance(x.arc, y.arc)
  if (x.arc) return segmentArcDistance(y.a, y.b, x.arc)
  if (y.arc) return segmentArcDistance(x.a, x.b, y.arc)
  return segmentSegmentDistance(x.a, x.b, y.a, y.b)
}

/** Edge-to-edge distance between two copper items (0 when touching/overlapping). */
export function itemDistance(x: CopperItem, y: CopperItem): number {
  if (x.kind === "shape" || y.kind === "shape") return x.kind === "zone" || y.kind === "zone" ? Infinity : shapeShapeDistance(itemCopper(x), itemCopper(y))
  if (x.kind === "pad" && y.kind === "pad") return padPadDistance(x.pad, y.pad)
  if (x.kind === "segment" && y.kind === "segment") return Math.max(0, trackTrackDistance(x, y) - x.width / 2 - y.width / 2)
  if (x.kind === "via" && y.kind === "via") return Math.max(0, dist(x.at, y.at) - x.diameter / 2 - y.diameter / 2)
  if (x.kind === "pad" && y.kind === "segment") return Math.max(0, Math.min(...segmentChords(y).map(([a, b]) => segmentPadDistance(a, b, x.pad))) - y.width / 2)
  if (x.kind === "segment" && y.kind === "pad") return itemDistance(y, x)
  if (x.kind === "via" && y.kind === "segment") return Math.max(0, pointTrackDistance(x.at, y) - x.diameter / 2 - y.width / 2)
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
  const stack = copperLayers(project.board)
  const count = stack.length
  for (const c of resolvedComponents(project)) {
    if (!c.pcb.placed || !onBoard(c)) continue
    pcbPads(c, count).forEach((pad, i) => {
      const netId = pad.pin ? (sch.pinNet.get(pinKey(c.id, pad.pin)) ?? null) : null
      // A pad stack (X1): a layer with a shape of its own is an item of its own, joined to the rest of the pad by its pin.
      const own = pad.variants ? pad.layers.filter((l) => !pad.variants![l]) : pad.layers
      if (own.length) items.push({ kind: "pad", id: `pad:${c.id}:${i}`, pad, netId, layers: own, box: padBox(pad) })
      for (const [layer, v] of Object.entries(pad.variants ?? {}) as [CopperLayer, WorldPad][]) items.push({ kind: "pad", id: `pad:${c.id}:${i}@${layer}`, pad: v, netId, layers: [layer], box: padBox(v) })
    })
  }
  for (const t of project.traces) {
    if (isArcTrace(t)) {
      const arc = arcOf(t.points)
      items.push({
        kind: "segment",
        id: `seg:${t.id}:0`,
        traceId: t.id,
        index: 0,
        a: t.points[0],
        b: t.points[2],
        width: t.width,
        layers: [t.layer],
        box: arcBox(arc, t.width),
        arc,
        ...(t.net ? { netId: idOf(t.net) } : {}),
      })
      continue
    }
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
      layers: [...stack],
    }
    items.push({ kind: "pad", id: `pad:${BOARD_OWNER}:${h.id}`, pad, netId: null, layers: pad.layers, box: padBox(pad) })
  }
  for (const v of project.vias) {
    const span = viaLayers(project.board, v)
    // A via stack (X1) has a diameter of its own on some layers: one item for each run of layers that share one, the first with the via's own id.
    const groups = new Map<number, CopperLayer[]>()
    for (const l of span) {
      const d = viaDiameterOn(v, l)
      const g = groups.get(d)
      if (g) g.push(l)
      else groups.set(d, [l])
    }
    let k = 0
    for (const [diameter, layers] of groups) {
      const r = diameter / 2
      items.push({
        kind: "via",
        id: k === 0 ? `via:${v.id}` : `via:${v.id}#${k}`,
        viaId: v.id,
        at: { x: v.x, y: v.y },
        diameter,
        layers,
        box: { minX: v.x - r, minY: v.y - r, maxX: v.x + r, maxY: v.y + r },
        ...(v.routedNet ? { netId: idOf(v.routedNet) } : {}),
      })
      k++
    }
  }
  // Drawings on a copper layer.
  for (const w of worldShapes(project)) {
    const layer = w.placed ? layerOfKicadName(w.shape.layer) : null
    if (!layer || !stack.includes(layer)) continue
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
    const layer = wt.placed && !wt.hidden ? layerOfKicadName(wt.layer) : null
    if (!layer || !stack.includes(layer)) continue
    const t = layerText(project, wt)
    if (!t) continue
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
  pruneUnused(project, items)
  return items
}

/**
 * X1 and X5: copper a through-hole pad or a via drops on the layers nothing connects to (KiCad's `remove_unused_layers`: `PAD::FlashLayer`, pad.cpp
 * 9.0.0 `:341`, and `PCB_VIA::FlashLayer`, pcb_track.cpp 9.0.0 `:1225`). Its item then has no copper there, so no check, pour or plot sees any. A layer stays when the
 * mode keeps it (every layer; the outer ones of a pad and the two ends of a via for `keepEnds`; only the two ends for `startEnd`), when a via's `zoneLayers` list
 * it, or when a track, a via or a pad of the same net touches the item on it. A pour is not copper that connects here, as in KiCad, where the pour joins what the
 * connectivity already connected. The layers dropped are `unflashed` on the item.
 */
function pruneUnused(project: Project, items: CopperItem[]) {
  const viaOf = new Map<string, Via>()
  const candidates: number[] = []
  items.forEach((it, i) => {
    if (it.kind === "pad" && it.pad.unused && it.pad.holeDiameter !== undefined && !isNpth(it.pad)) candidates.push(i)
    else if (it.kind === "via") {
      let v = viaOf.get(it.viaId)
      if (!v) {
        v = project.vias.find((x) => x.id === it.viaId)
        if (v) viaOf.set(it.viaId, v)
      }
      if (v?.unused) candidates.push(i)
    }
  })
  if (!candidates.length) return
  const outer = new Set<CopperLayer>(["top", "bottom"])
  // The items whose boxes meet a candidate's, found once by sweeping over all of them.
  const isCandidate = new Set(candidates)
  const near = new Map<number, number[]>()
  forOverlappingPairs(items, 0, (i, j) => {
    if (isCandidate.has(i) && boxesOverlap(items[i].box, items[j].box)) near.set(i, [...(near.get(i) ?? []), j])
    if (isCandidate.has(j) && boxesOverlap(items[i].box, items[j].box)) near.set(j, [...(near.get(j) ?? []), i])
  })
  for (const i of candidates) {
    const it = items[i]
    if (it.kind !== "pad" && it.kind !== "via") continue
    const keep = new Set<CopperLayer>()
    const gone: CopperLayer[] = []
    let check: CopperLayer[] = it.layers
    if (it.kind === "pad") {
      if (it.pad.unused === "keepEnds") for (const l of it.layers) if (outer.has(l)) keep.add(l)
      check = it.layers.filter((l) => !keep.has(l))
    } else {
      const v = viaOf.get(it.viaId)!
      const span = viaLayers(project.board, v)
      const ends = [span[0], span[span.length - 1]]
      for (const l of v.zoneLayers ?? []) keep.add(l)
      if (v.unused === "keepEnds" || v.unused === "startEnd") for (const l of ends) keep.add(l)
      // KiCad 10's own mode: only the two ends, whatever touches.
      if (v.unused === "startEnd") {
        for (const l of it.layers) if (!keep.has(l)) gone.push(l)
        check = []
      } else check = it.layers.filter((l) => !keep.has(l))
    }
    for (const l of check) {
      const used = (near.get(i) ?? []).some((j) => {
        const q = items[j]
        if ((q.kind !== "segment" && q.kind !== "via" && q.kind !== "pad") || !q.layers.includes(l)) return false
        if (q.kind === "pad" && isNpth(q.pad)) return false
        // Items of one via are one piece of copper.
        if (it.kind === "via" && q.kind === "via" && q.viaId === it.viaId) return false
        const a = it.netId ?? null
        const b = q.netId ?? null
        if (a && b && a !== b) return false
        return itemDistance(it, q) <= 1e-6
      })
      if (!used) gone.push(l)
    }
    if (gone.length) {
      it.unflashed = gone
      it.layers = it.layers.filter((l) => !gone.includes(l))
    }
  }
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

  // The items of one via (a via stack with a diameter of its own on some layers) are one piece of copper.
  const viaFirst = new Map<string, number>()
  items.forEach((it, i) => {
    if (it.kind !== "via") return
    const first = viaFirst.get(it.viaId)
    if (first === undefined) viaFirst.set(it.viaId, i)
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
      const nameById = new Map(sch.nets.map((n) => [n.id, n.name]))
      zoneFills = carveFills(project, fills, copper.flatMap((it, i) => (known.has(it.id) ? [] : [{ item: it, net: netOf(i) }])), (id) => (id ? (nameById.get(id) ?? null) : null))
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
  // Two nets are checked at the larger of their classes' clearances (a board with no classes: the rules' one), so the search looks as far as the largest.
  const classes = classIndex(project.rules)
  // A pad's own clearance (X7, KiCad's local override) replaces the classes' for it, so the search looks as far as the largest of those too.
  const padOverride = items.reduce((m, it) => (it.kind === "pad" && it.pad.clearance ? Math.max(m, it.pad.clearance) : m), 0)
  const clearance = Math.max(classes.worst, padOverride)
  const netNames = new Map(sch.nets.map((n) => [n.id, n.name]))
  const nameOfNet = (id: string | null | undefined) => (id && id !== "short" ? (netNames.get(id) ?? null) : null)
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
    let need = hasNetClasses(project.rules) ? classes.pair(nameOfNet(ni), nameOfNet(nj)) : classes.worst
    // A pad's own clearance raises the classes' and never lowers it: `DRC_ENGINE::EvalRules` max's each item's local clearance with the class value
    // (drc_engine.cpp 9.0 :1451-1540, 10.0 :1982-2063) and then holds the result to the board's minimum, which `classes.worst` and `pair` already do.
    const ox = x.kind === "pad" ? x.pad.clearance : undefined
    const oy = y.kind === "pad" ? y.pad.clearance : undefined
    if (ox || oy) need = Math.max(need, ox ?? 0, oy ?? 0)
    if (d >= need - 1e-6) return
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
      message: `${holeX || holeY ? "Hole clearance" : "Clearance"} ${d.toFixed(3)} mm < ${need} mm between ${describe(x)} and ${describe(y)}`,
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
  // A part a rule area, a sheet symbol or the active variant takes off the board has no courtyard on it (the resolved flags, as the plots read them).
  const onBoardParts = resolvedComponents(project).filter((c) => onBoard(c))
  for (const c of onBoardParts) {
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
  const placed = onBoardParts
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
  return padEdgeDistance(it.pad, d)
}

interface Hole {
  owner: string
  /** Centre line of the hole: one point, or the two end centres of a slot. */
  a: Vec2
  b: Vec2
  diameter: number
  /** X5: the layers of a via's hole (a blind or buried via is drilled before the stack is pressed, so it only matters to holes it shares a layer with); absent for a hole through the board. */
  layers?: CopperLayer[]
}

function holesOf(items: CopperItem[], drillOf: Map<string, number>, project: Project): Hole[] {
  const out: Hole[] = []
  const done = new Set<string>()
  const viaOf = new Map(project.vias.map((v) => [v.id, v]))
  for (const it of items) {
    if (it.kind === "via") {
      // One hole for a via, however many items its copper is (a via stack), and none for a micro via: it is burned by a laser, which KiCad's hole to hole check leaves out (drc_test_provider_hole_to_hole.cpp 9.0.0 `:154-177`).
      if (done.has(it.viaId)) continue
      done.add(it.viaId)
      const via = viaOf.get(it.viaId)
      if (via?.kind === "micro") continue
      out.push({ owner: it.id, a: it.at, b: it.at, diameter: drillOf.get(it.viaId) ?? 0, ...(via?.kind ? { layers: viaLayers(project.board, via) } : {}) })
    }
    if (it.kind === "pad" && it.pad.holeDiameter) {
      const ends = slotEnds(it.pad)
      out.push({ owner: it.pad.componentId, a: ends?.[0] ?? holeCentre(it.pad), b: ends?.[1] ?? holeCentre(it.pad), diameter: it.pad.holeDiameter })
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
  const smallest = new Map<string, { value: number; at: Vec2; what: string; limit: number }>()
  const note = (key: string, value: number, at: Vec2, what: string, limit: number) => {
    const prev = smallest.get(key)
    if (!prev || value < prev.value) smallest.set(key, { value, at, what, limit })
  }
  // A via's smallest drill is its own rule when the board has one (KiCad's via minimum against its through hole minimum); else both are the minimum drill.
  const minViaDrill = rules.minViaDrill ?? rules.minDrill
  for (const v of project.vias) {
    const micro = v.kind === "micro"
    // KiCad's `via_min_size` (a micro via's own minimum is the board's `uvia_min_size`): a via narrower than the rule's minimum diameter (the rules are absent on a board drawn here)
    const minDiameter = micro ? rules.minMicroVia?.diameter : rules.minViaDiameter
    if (minDiameter !== undefined && v.diameter < minDiameter - eps) {
      push({ severity: "error", kind: "via-size", message: `${micro ? "Micro via" : "Via"} diameter ${mm(v.diameter)} is below the ${mm(minDiameter)} minimum`, at: { x: v.x, y: v.y } })
    }
    // A micro via is burned by a laser, so the through hole minimum is not its rule: it has the board's micro via minimum, where it has one (`DRCE_MICROVIA_DRILL_OUT_OF_RANGE`).
    const minDrillHere = micro ? rules.minMicroVia?.drill : minViaDrill
    if (minDrillHere !== undefined && v.drill < minDrillHere - eps) note(`drill:via:${v.id}`, v.drill, v, micro ? "Micro via" : "Via", minDrillHere)
    // The ring is the thinnest the via has on any layer of its span (a via stack has a diameter for each).
    const ring = Math.min(...viaLayers(board, v).map((l) => (viaDiameterOn(v, l) - v.drill) / 2))
    if (ring < rules.minAnnularRing - eps) note(`ring:via:${v.id}`, ring, v, micro ? "Micro via" : "Via", rules.minAnnularRing)
    // The board says the kind of via is not allowed (KiCad 5's `uvias_allowed` and `blind_buried_vias_allowed`).
    if ((micro && rules.microViasAllowed === false) || ((v.kind === "blind" || v.kind === "buried") && rules.blindBuriedViasAllowed === false)) {
      push({ severity: "error", kind: "via-size", message: `${micro ? "Micro vias are" : "Blind and buried vias are"} not allowed by the board's rules`, at: { x: v.x, y: v.y } })
    }
  }
  for (const it of items) {
    if (it.kind !== "pad" || !it.pad.holeDiameter) continue
    const pad = it.pad
    const hole = it.pad.holeDiameter
    const at = { ...holeCentre(pad) }
    if (hole < rules.minDrill - eps) note(`drill:${pad.componentId}`, hole, at, owner(pad.componentId), rules.minDrill)
    if (isNpth(pad)) continue
    // A pad with a hole off its centre, rounded corners or a shape of its own has the ring its outline leaves; any other, the one it always had.
    const ring = pad.hole || pad.corner || padRingsOf(pad) ? padRingWidth(pad) : (Math.min(pad.width, pad.height) - hole) / 2
    if (ring < rules.minAnnularRing - eps) note(`ring:${pad.componentId}`, ring, at, owner(pad.componentId), rules.minAnnularRing)
  }
  for (const [key, s] of smallest) {
    const drill = key.startsWith("drill:")
    push({
      severity: "error",
      kind: drill ? "drill" : "annular-ring",
      message: drill
        ? `${s.what} drill ${mm(s.value)} is below the ${mm(s.limit)} minimum`
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
  const holes = holesOf(items, drillOf, project).sort((p, q) => left(p) - left(q))
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i]
    for (let j = i + 1; j < holes.length; j++) {
      const k = holes[j]
      if (left(k) > reach(h) + rules.holeClearance) break
      if (h.owner === k.owner) continue
      // Two holes drilled before the stack is pressed that share no layer cannot meet.
      if (h.layers && k.layers && !h.layers.some((l) => k.layers!.includes(l))) continue
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

  // A solder mask opening that spans copper of two nets (KiCad's solder mask bridge): where the openings of two pads of different nets run together, or
  // leave a web thinner than the board's minimum, which the plot then removes (`maskMinWidth`). Checked on a board that carries KiCad pad data (a pad with X7 features) or
  // states a minimum web; a board drawn here has neither, so its checks are as they were.
  const web = rules.maskMinWidth ?? 0
  const padItems = items.filter((it): it is Extract<CopperItem, { kind: "pad" }> => it.kind === "pad" && !isNpthItem(it) && it.pad.componentId !== BOARD_OWNER)
  if (web > 0 || padItems.some((it) => it.pad.x7)) {
    const bySide = new Map<CopperLayer, Extract<CopperItem, { kind: "pad" }>[]>()
    for (const it of padItems) for (const side of maskSides(it.pad)) bySide.set(side, [...(bySide.get(side) ?? []), it])
    const flagged = new Map(project.components.map((c) => [c.id, !!c.flags?.allowMaskBridges]))
    const seen = new Set<string>()
    for (const [side, list] of bySide) {
      const reach = web + 2 * Math.max(rules.maskExpansion, 0, ...list.map((it) => it.pad.maskMargin ?? 0)) + 0.01
      forOverlappingPairs(list, reach, (i, j) => {
        const x = list[i]
        const y = list[j]
        if (!boxesOverlap(inflate(x.box, reach), y.box)) return
        if ((x.netId ?? null) === (y.netId ?? null)) return
        if (x.pad.componentId === y.pad.componentId && (rules.maskBridgesInParts || flagged.get(x.pad.componentId))) return
        const gap = padPadDistance(x.pad, y.pad) - maskMargin(x.pad, rules) - maskMargin(y.pad, rules)
        if (gap >= web - 1e-6) return
        const key = `${x.id}|${y.id}|${side}`
        if (seen.has(key)) return
        seen.add(key)
        const name = (p: WorldPad) => `${owner(p.componentId)}.${p.padNumber ?? p.pin ?? "pad"}`
        push({
          severity: "error",
          kind: "mask-bridge",
          message: gap <= 0 ? `The solder mask openings of ${name(x.pad)} and ${name(y.pad)} run together over two nets` : `Only ${mm(gap)} of solder mask between ${name(x.pad)} and ${name(y.pad)}, under the ${mm(web)} minimum: the plot removes it and the openings join, over two nets`,
          at: { x: (x.pad.x + y.pad.x) / 2, y: (x.pad.y + y.pad.y) / 2 },
        })
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
