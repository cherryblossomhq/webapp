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
import { componentFootprint, hasCourtyard, isNpth, maskSides, pcbCourtyard, pcbCourtyardRing, pcbPads, pcbShapes, slotEnds, type WorldPad } from "./instances"
import { maskMargin } from "./padOpening"
import { holeCentre, padBox, padCopper, padEdgeDistance, padRingsOf, padRingWidth, pointPadDistance, segmentPadDistance } from "./padDistance"
import { classIndex, hasNetClasses } from "./netClasses"
import { onBoard } from "./partFlags"
import { keepoutViolations } from "./zoneChecks"
import { withPartZones } from "./partZones"
import { areaNames, placementProblems } from "./placementAreas"
import { areaContains, isRuleArea, zoneArea, zoneLayers } from "./zones"
import { carveFills, type PendingGroup } from "./zoneFill"
import { hasKeptFills, keptContext, keptFills, mergeKept, needsOwnFill } from "./zoneKeep"
import { fillTester, padJoinsFillBySamples, fillZones, fillZonesReusing, type FillPolygon, type ZoneFill } from "./pour"
import { formatLength } from "./rules"
import { netTieGroups } from "./partFlags"
import { worldShapes } from "./shapeItems"
import { isClosedShape, pointInRings, segEnd, shapeCopper, shapeInkBox, shapePolylines, shapeRings, shapeShapeDistance, type ShapeCopper } from "./shapes"
import { layerText, worldTexts } from "./texts"
import type { BoardDef, BoardShape, ComponentInstance, CopperLayer, Project, Vec2, Via } from "./types"
import { lengthFindings } from "./netLengths"
import { courtyardAllowance } from "./courtyardRules"
import { holeCuts, padInBoardFrame } from "./machining"
import { boardCheckDismissed, boardCheckSeverity, fromKicad, kicadHoleClearance, noKicadMinimum } from "./checkRules"

export { pointPadDistance, segmentPadDistance }

/**
 * How far under a clearance a gap may be and pass (KiCad's `DRCEpsilon`, 0.5 um, `advanced_config.cpp` 10.0 :247, which its copper, edge and hole to
 * hole tests take off the rule: `sub_e` in drc_test_provider_copper_clearance.cpp). Its sums are in whole nanometres, so a track at 45 degrees laid at
 * the clearance can land a nanometre or two under it, which no fab can tell; the editor's sums are in floating millimetres and land under it the same way.
 */
const DRC_EPSILON = 0.0005

/**
 * On a project from KiCad, the tolerance is wider by what the import's rounding can move a distance (`round`, to 0.1 um: each end of a gap up to 0.07 um):
 * a gap KiCad passes by a few nanometres must not fail here for that alone. 0.2 um, which no fab can tell either.
 */
const IMPORT_SLACK = 0.0002
/** A project drawn here keeps the editor's own floating-point slack (1 nm), as its checks always had: KiCad's half micrometre is for a project from KiCad. */
const tolerance = (kicad: boolean) => (kicad ? DRC_EPSILON + IMPORT_SLACK : 1e-6)

/** componentId used for board-level copper such as mounting holes. */
export const BOARD_OWNER = "#board"

export type CopperItem =
  | { kind: "pad"; id: string; pad: WorldPad; netId: string | null; layers: CopperLayer[]; box: Box; unflashed?: CopperLayer[]; cut?: Partial<Record<CopperLayer, number>> }
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
      /** X22: the layers where a backdrill or post-machining cuts the via's copper, with the size of the hole there (`holeCuts`). */
      cut?: Partial<Record<CopperLayer, number>>
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
    | "tuning"
    | "decoupling"
    | "keepout"
    | "placement-area"
  message: string
  at: Vec2
  /** The items the check is about, where it says (`c:<part>`, `pad:<part>:<index>`, `z:<zone>`): what a check the user dismissed in KiCad is matched by (`boardCheckDismissed`). */
  items?: string[]
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

/** Edge-to-edge distance between two pads; with a `limit`, a pad drawn as a polygon is measured exactly only below it (`shapeShapeDistance`). */
function padPadDistance(p: WorldPad, q: WorldPad, limit = Infinity): number {
  if (p.shape === "circle" && q.shape === "circle") return Math.max(0, dist(p, q) - p.width / 2 - q.width / 2)
  if (padRingsOf(p) || padRingsOf(q) || p.corner || q.corner) return shapeShapeDistance(padCopper(p), padCopper(q), limit)
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

/** How near two items are measured exactly when the question is whether they touch: well past the 1e-6 mm that counts as touching. */
const TOUCH = 1e-3

/**
 * Edge-to-edge distance between two copper items (0 when touching/overlapping). With a `limit`, a drawing's distance is exact only below it, and
 * at least the limit otherwise (`shapeShapeDistance`): what a check that asks "touching?" or "nearer than the clearance?" needs.
 */
export function itemDistance(x: CopperItem, y: CopperItem, limit = Infinity): number {
  if (x.kind === "shape" || y.kind === "shape") return x.kind === "zone" || y.kind === "zone" ? Infinity : shapeShapeDistance(itemCopper(x), itemCopper(y), limit)
  if (x.kind === "pad" && y.kind === "pad") return padPadDistance(x.pad, y.pad, limit)
  if (x.kind === "segment" && y.kind === "segment") return Math.max(0, trackTrackDistance(x, y) - x.width / 2 - y.width / 2)
  if (x.kind === "via" && y.kind === "via") return Math.max(0, dist(x.at, y.at) - x.diameter / 2 - y.diameter / 2)
  if (x.kind === "pad" && y.kind === "segment") return Math.max(0, Math.min(...segmentChords(y).map(([a, b]) => segmentPadDistance(a, b, x.pad))) - y.width / 2)
  if (x.kind === "segment" && y.kind === "pad") return itemDistance(y, x, limit)
  if (x.kind === "via" && y.kind === "segment") return Math.max(0, pointTrackDistance(x.at, y) - x.diameter / 2 - y.width / 2)
  if (x.kind === "segment" && y.kind === "via") return itemDistance(y, x, limit)
  if (x.kind === "via" && y.kind === "pad") return Math.max(0, pointPadDistance(x.at, y.pad) - x.diameter / 2)
  if (x.kind === "pad" && y.kind === "via") return itemDistance(y, x, limit)
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
  const machined = !!project.footprints?.some((f) => f.pads.some((p) => p.backdrill || p.tertiary || p.post))
  for (const c of resolvedComponents(project)) {
    if (!c.pcb.placed || !onBoard(c)) continue
    const landPads = machined ? componentFootprint(c)?.pads : undefined
    pcbPads(c, count).forEach((pad, i) => {
      const netId = pad.pin ? (sch.pinNet.get(pinKey(c.id, pad.pin)) ?? null) : null
      // A pad stack (X1): a layer with a shape of its own is an item of its own, joined to the rest of the pad by its pin.
      const own = pad.variants ? pad.layers.filter((l) => !pad.variants![l]) : pad.layers
      // X22: where a backdrill or post-machining cuts the pad's copper round its hole.
      const land = landPads?.[i]
      const cut = land && (land.backdrill || land.tertiary || land.post) ? holeCuts(project.board, { drill: land.holeDiameter ?? 0, ...padInBoardFrame(land, c.pcb.side === "bottom", count) }, own) : undefined
      if (own.length) items.push({ kind: "pad", id: `pad:${c.id}:${i}`, pad, netId, layers: own, box: padBox(pad), ...(cut ? { cut } : {}) })
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
    // X22: where a backdrill or post-machining cuts the via's copper.
    const cut = v.backdrill || v.tertiary || v.post ? holeCuts(project.board, { drill: v.drill, backdrill: v.backdrill, tertiary: v.tertiary, post: v.post }, span) : undefined
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
        ...(cut ? { cut: Object.fromEntries(Object.entries(cut).filter(([l]) => layers.includes(l as CopperLayer))) as NonNullable<typeof cut> } : {}),
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
 * mode keeps it (every layer; the outer ones of a pad and the two ends of a via for `keepEnds`; only the two ends for `startEnd`), when a pad's or via's `zoneLayers` list
 * it (X31, X5), or when a track, a via or a pad of the same net touches the item on it. A pour is not copper that connects here, as in KiCad, where the pour joins what the
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
      // X31: a layer a pour joins the pad on keeps its copper (KiCad's `ZLO_FORCE_FLASHED`, which `PAD::FlashLayer` honours before it asks the connectivity).
      for (const l of it.pad.zoneLayers ?? []) keep.add(l)
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
        return itemDistance(it, q, TOUCH) <= 1e-6
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

/**
 * Whether a pad's or via's copper meets a fill (KiCad's `CN_VISITOR::checkZoneItemConnection`: a pad or via joins a zone whose fill collides with its
 * shape, which is how a thermal spoke joins a pad whose centre is in the relief's gap). A point of the copper in the fill, a point of the fill in the
 * copper, or an edge of the fill within the copper's reach of its centre line.
 */
function copperMeetsFill(c: ShapeCopper, box: Box, polygon: FillPolygon, contains: (p: Vec2) => boolean): boolean {
  for (const [a] of c.edges) if (contains(a)) return true
  const meets = ([p, q]: FillEdge) => {
    if (Math.max(p.x, q.x) < box.minX || Math.min(p.x, q.x) > box.maxX || Math.max(p.y, q.y) < box.minY || Math.min(p.y, q.y) > box.maxY) return false
    if (c.fill.length && pointInRings(p, c.fill)) return true
    for (const [a, b] of c.edges) if (segmentSegmentDistance(p, q, a, b) <= c.half + 1e-9) return true
    return false
  }
  const grid = fillEdgeGrid(polygon)
  if (grid.long.some(meets)) return true
  for (let ix = Math.floor(box.minX / FILL_EDGE_CELL); ix <= Math.floor(box.maxX / FILL_EDGE_CELL); ix++) {
    for (let iy = Math.floor(box.minY / FILL_EDGE_CELL); iy <= Math.floor(box.maxY / FILL_EDGE_CELL); iy++) {
      const edges = grid.cells.get(cellKey(ix, iy))
      if (edges?.some(meets)) return true
    }
  }
  return false
}

type FillEdge = readonly [Vec2, Vec2]

/**
 * The items whose boxes reach a box, by the 2 mm cells of a grid: `boxGrid(entries)(box)` lists each entry (once) whose box shares a cell with it, a
 * superset of those it overlaps. An item whose box covers more cells than `FILL_EDGE_MAX_CELLS` is one every query lists.
 */
function boxGrid(entries: readonly (readonly [number, Box])[]): (box: Box) => number[] {
  const cells = new Map<number, number[]>()
  const long: number[] = []
  for (const [id, b] of entries) {
    const x0 = Math.floor(b.minX / FILL_EDGE_CELL)
    const x1 = Math.floor(b.maxX / FILL_EDGE_CELL)
    const y0 = Math.floor(b.minY / FILL_EDGE_CELL)
    const y1 = Math.floor(b.maxY / FILL_EDGE_CELL)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > FILL_EDGE_MAX_CELLS) {
      long.push(id)
      continue
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = cellKey(ix, iy)
        const cell = cells.get(key)
        if (cell) cell.push(id)
        else cells.set(key, [id])
      }
    }
  }
  return (box) => {
    const out = new Set(long)
    for (let ix = Math.floor(box.minX / FILL_EDGE_CELL); ix <= Math.floor(box.maxX / FILL_EDGE_CELL); ix++) {
      for (let iy = Math.floor(box.minY / FILL_EDGE_CELL); iy <= Math.floor(box.maxY / FILL_EDGE_CELL); iy++) for (const id of cells.get(cellKey(ix, iy)) ?? []) out.add(id)
    }
    return [...out]
  }
}

/** The cells of the grid a fill's edges are kept by (mm), and the most cells an edge is kept in before it is one every query asks. */
const FILL_EDGE_CELL = 2
const FILL_EDGE_MAX_CELLS = 64
const cellKey = (ix: number, iy: number) => (ix + 32768) * 65536 + (iy + 32768)

/**
 * A fill's edges by the cells of a grid their boxes reach, made once for each fill: a pad or via asks only the edges near it (`copperMeetsFill`), where
 * it went through every edge of the fill. A ground pour of tens of thousands of edges, for each of the thousands of pads and vias of its net, was 6.5 s
 * of the checks of a board of 1,566 parts.
 */
const fillEdgeGrids = new WeakMap<FillPolygon, { cells: Map<number, FillEdge[]>; long: FillEdge[] }>()
function fillEdgeGrid(polygon: FillPolygon) {
  let grid = fillEdgeGrids.get(polygon)
  if (grid) return grid
  grid = { cells: new Map(), long: [] }
  for (const ring of polygon) {
    for (let k = 0; k < ring.length; k++) {
      const edge: FillEdge = [ring[k], ring[(k + 1) % ring.length]]
      const [p, q] = edge
      const x0 = Math.floor(Math.min(p.x, q.x) / FILL_EDGE_CELL)
      const x1 = Math.floor(Math.max(p.x, q.x) / FILL_EDGE_CELL)
      const y0 = Math.floor(Math.min(p.y, q.y) / FILL_EDGE_CELL)
      const y1 = Math.floor(Math.max(p.y, q.y) / FILL_EDGE_CELL)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > FILL_EDGE_MAX_CELLS) {
        grid.long.push(edge)
        continue
      }
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const key = cellKey(ix, iy)
          const cell = grid.cells.get(key)
          if (cell) cell.push(edge)
          else grid.cells.set(key, [edge])
        }
      }
    }
  }
  fillEdgeGrids.set(polygon, grid)
  return grid
}

/** Whether two fills overlap: a corner of either outline inside the other (KiCad's `CN_VISITOR::checkZoneZoneConnection`). */
const fillsOverlap = (x: Extract<CopperItem, { kind: "zone" }>, y: Extract<CopperItem, { kind: "zone" }>) => x.polygon[0].some((p) => y.contains(p)) || y.polygon[0].some((p) => x.contains(p))

/**
 * Union-find over copper items: touching copper on a shared layer, aliased pads, and pour anchors. `samePin` says which parts' pads of one pin are one
 * piece of copper inside the part (all of them, unless it is given): KiCad joins pads of one number only on a footprint that says they are jumpers.
 * `fillNet` is the net of each fill by its item's id (`ZoneFill.netId`): a pad or via of that net that the fill meets joins it, as does a fill of the net it overlaps.
 * `loneNet` is the net of its own a board file gave a pad whose pin is on no net of the schematic (`ComponentInstance.loneNets`).
 */
function connectItems(
  items: CopperItem[],
  ties: NetTies | null = null,
  samePin?: (componentId: string) => boolean,
  fillNet?: Map<string, string | null>,
  loneNet?: (pad: WorldPad) => string | undefined,
): Islands {
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
  const lone = (it: CopperItem) => (it.kind === "pad" && !it.netId ? loneNet?.(it.pad) : undefined)

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
      if (z.kind !== "zone") return
      // Two fills of one net that overlap are one piece of copper (a zone of a higher priority over a plane, two zones drawn over each other).
      const net = fillNet?.get(z.id)
      if (o.kind === "zone") {
        if (net && net === fillNet?.get(o.id) && fillsOverlap(z, o)) union(i, j)
        return
      }
      if (anchorPoints(o).some((p) => z.contains(p)) || (o.kind === "pad" && !!o.pad.holeDiameter && padJoinsFillBySamples(o.pad, z.contains))) union(i, j)
      // A pad or via of the fill's own net that the fill reaches only by a spoke or an edge: KiCad joins only items of one net this way, so it never makes a short.
      else if ((o.kind === "pad" || o.kind === "via") && net && o.netId === net && copperMeetsFill(itemCopper(o), o.box, z.polygon, z.contains)) union(i, j)
      return
    }
    // Pads of one part are joined by their pin (below). On a project from KiCad, where they are not, pads of one part that touch on one net are one piece
    // of copper, as KiCad joins any copper of a net that touches (a terminal's pad ringed by the small pads that stitch it to the inner layers), the net of
    // their own the file gave a pin on none of the schematic's included (a module's castellated pad over its through-hole pad, on `unconnected-(U1-GPIO0-Pad1)`).
    if (sameComponentPads(x, y) && !(samePin && ((x.netId && x.netId === y.netId) || (lone(x) !== undefined && lone(x) === lone(y))))) return
    if (itemDistance(x, y, TOUCH) > 1e-6) return
    if (ties && tieExempt(ties, x, y)) return
    union(i, j)
  })

  // Same-pin pads of a component (aliases like SOT-223 tab) are internally connected.
  const padByPin = new Map<string, number>()
  items.forEach((it, i) => {
    if (it.kind !== "pad" || !it.pad.pin || (samePin && !samePin(it.pad.componentId))) return
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
/**
 * The point of an item nearest a place, which stands for where it meets another item there: the place itself when the item's copper covers it,
 * as a pad of another part under a net tie's bridge covers the bridge (KiCad's collision point lies in both).
 */
function nearestPointOf(it: CopperItem, ref: Vec2): Vec2 {
  if (it.kind === "segment") return closestPointOnSegment(ref, it.a, it.b)
  if (it.kind === "via") return it.at
  if (it.kind === "pad" || it.kind === "shape") {
    const c = itemCopper(it)
    if (c.fill.length && pointInRings(ref, c.fill)) return ref
    let best: Vec2 = itemCenter(it)
    let d = Infinity
    for (const [a, b] of c.edges) {
      const q = closestPointOnSegment(ref, a, b)
      const gap = Math.hypot(ref.x - q.x, ref.y - q.y)
      // Within the stroke's half width of its centre line, the place is on the copper; else the copper's edge towards it.
      if (gap <= c.half) return ref
      if (gap - c.half < d) {
        d = gap - c.half
        best = { x: q.x + ((ref.x - q.x) * c.half) / gap, y: q.y + ((ref.y - q.y) * c.half) / gap }
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
      if (own === p.item || itemDistance(foreign, p.item, TOUCH) > 1e-6 || itemDistance(own, p.item, TOUCH) > 1e-6) continue
      // ... and the meeting is inside that pad: the foreign copper where it is nearest the tie's other copper lies in the pad.
      const at = nearestPointOf(foreign, itemCenter(own))
      if (p.item.kind === "pad" && pointPadDistance(at, p.item.pad) <= 1e-6) return true
    }
  }
  return false
}

/**
 * Zones as conductors. Copper that touches no pad has no net of its own, but a trace or via that lies inside a copper zone's
 * polygon, on a layer the zone is on, is joined to that zone's pour and so is on its net (KiCad's stitching vias, which sit
 * in a pour and touch nothing else). Only zones with a polygon and a net count: a zone on no net connects nothing, a rule area is
 * no pour, and the editor's whole-board pour, which has no polygon, leaves copper as it was. The polygon is used, not the editor's fill:
 * the fill is cut round copper by its net, which is what is being derived; with `keptFills`, a zone
 * brought in from KiCad is its stored fill instead, KiCad's own copper, which no net of the editor's went into. Copper that touches pads of a net keeps it (a via of
 * another net inside a pour is a clearance matter, not a change of net), and copper under two zones of different nets stays
 * with no net. `islandNet` is returned as a new map when anything changed.
 *
 * Only what the editor derives uses this (`derivedCopperNets`: the net an item brought in from KiCad is compared with, and the net an
 * exported via with none is written with). Checks do not: there copper that names no net stays another net's copper to a pour, cleared
 * round by its clearance, and copper brought in from KiCad names its net (`Trace.net`, `Via.routedNet`), which joins it to its pour.
 */
function withZoneNets(project: Project, sch: SchematicConnectivity, items: CopperItem[], find: (i: number) => number, islandNet: Map<number, string | null>, keptFills = false): Map<number, string | null> {
  const zones = project.zones.flatMap((z) => {
    if (!z.net || isRuleArea(z) || z.teardrop) return []
    const net = sch.nets.find((n) => n.name === z.net)?.id
    const area = zoneArea(z)
    // KiCad's own fill of the zone, when it is asked for: the copper the board will have, cut round other nets' copper by KiCad. A via in a +24V zone's
    // outline on the top and in the ground planes below sits in a hole of the +24V fill, so it is on the ground planes alone.
    const fill = keptFills && z.kept ? new Map(z.kept.layers.map((l) => [l.layer, l.rings])) : null
    return net && area ? [{ net, area, layers: zoneLayers(z), fill }] : []
  })
  if (!zones.length) return islandNet
  const found = new Map<number, Set<string>>()
  items.forEach((it, i) => {
    if (it.kind !== "segment" && it.kind !== "via") return
    const root = find(i)
    if (islandNet.get(root) !== null && islandNet.get(root) !== undefined) return
    const points = anchorPoints(it)
    for (const z of zones) {
      const shared = it.layers.filter((l) => z.layers.includes(l))
      if (!shared.length) continue
      const fill = z.fill
      if (fill ? !shared.some((l) => points.some((p) => pointInRings(p, fill.get(l) ?? []))) : !points.some((p) => areaContains(z.area, p))) continue
      const set = found.get(root) ?? found.set(root, new Set()).get(root)!
      set.add(z.net)
    }
  })
  if (!found.size) return islandNet
  const out = new Map(islandNet)
  for (const [root, nets] of found) if (nets.size === 1) out.set(root, [...nets][0])
  return out
}

/**
 * Which net each trace and via is on from what it touches alone, ignoring the nets a trace or via
 * says it is on: what the editor derives, to compare with what a board brought in from KiCad says.
 * "short" for copper that touches pads of two nets, null for copper that touches none.
 */
export function derivedCopperNets(project: Project, sch: SchematicConnectivity, opts: { keptFills?: boolean } = {}): { traceNet: Map<string, string | null>; viaNet: Map<string, string | null> } {
  const items = buildCopperItems(project, sch, false)
  const connected = connectItems(items, netTies(project, items))
  const { find } = connected
  const islandNet = withZoneNets(project, sch, items, find, connected.islandNet, opts.keptFills)
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
 * The analysis of a board while something on it is dragged: `from`, the analysis of `base` (the board as the drag began), with the copper of what
 * moved where it is now. Its connections, checks and pours stay those of the start (the drop analyses the board again, and refills its pours), and
 * an unrouted connection that ends on a pad that moved follows the pad. CERN's Macbeth (1,566 parts) took 18 s a frame to analyse whole.
 */
export function followDrag(from: PcbAnalysis, base: Project, project: Project, sch: SchematicConnectivity): PcbAnalysis {
  const before = new Map(base.components.map((c) => [c.id, c]))
  const components = project.components.filter((c) => before.get(c.id) !== c)
  const traces = new Set(base.traces)
  const vias = new Set(base.vias)
  const movedTraces = project.traces.filter((t) => !traces.has(t))
  const movedVias = project.vias.filter((v) => !vias.has(v))
  if (!components.length && !movedTraces.length && !movedVias.length) return from
  // The copper of what moved: its parts' pads, drawings and texts, its tracks and vias (not the board's own, which the build makes too).
  const parts = new Set(components.map((c) => c.id))
  const tracks = new Set(movedTraces.map((t) => t.id))
  const drilled = new Set(movedVias.map((v) => v.id))
  const ownMoved = (it: CopperItem) =>
    it.kind === "pad" ? parts.has(it.pad.componentId) : it.kind === "segment" ? tracks.has(it.traceId) : it.kind === "via" ? drilled.has(it.viaId) : it.kind === "shape" ? parts.has(it.owner) : false
  const fresh = new Map(
    buildCopperItems({ ...project, components, traces: movedTraces, vias: movedVias }, sch)
      .filter(ownMoved)
      .map((it) => [it.id, it]),
  )
  // Where each pad that moved was, and is: an unrouted connection's end is a pad's centre (`itemPoint`).
  const moves = new Map<string, Vec2>()
  const items = from.items.map((it) => {
    const now = fresh.get(it.id)
    if (!now) return it
    if (it.kind === "pad" && now.kind === "pad" && (it.pad.x !== now.pad.x || it.pad.y !== now.pad.y)) moves.set(`${it.pad.x},${it.pad.y}`, { x: now.pad.x, y: now.pad.y })
    return now
  })
  const had = new Set(from.items.map((it) => it.id))
  for (const [id, it] of fresh) if (!had.has(id)) items.push(it)
  const follow = (q: Vec2) => moves.get(`${q.x},${q.y}`) ?? q
  return { ...from, items, ratsnest: moves.size ? from.ratsnest.map((r) => ({ ...r, a: follow(r.a), b: follow(r.b) })) : from.ratsnest }
}

/** The net id of each copper item (by index) as the copper alone connects it, which is what a pour is filled against (and what a kept fill's signature reads, `zoneKeep.ts`). */
export function copperNetOf(project: Project, sch: SchematicConnectivity, copper: CopperItem[]): (i: number) => string | null {
  const pre = connectItems(copper, netTies(project, copper))
  // A stitching via touches nothing but the pours, so it carries its net itself.
  const viaNetName = new Map(project.vias.filter((v) => v.net).map((v) => [v.id, v.net!]))
  return (i: number) => {
    const net = pre.islandNet.get(pre.find(i)) ?? null
    const it = copper[i]
    if (net === null && it.kind === "via" && viaNetName.has(it.viaId)) {
      return sch.nets.find((n) => n.name === viaNetName.get(it.viaId))?.id ?? null
    }
    return net === "short" ? null : net
  }
}

/**
 * The connections that join a net's islands (each a list of points): a minimum spanning tree, grown from the first island by joining the island
 * nearest to the tree at its nearest pair of points (Prim's). Ties go as the plain search over every pair broke them: the island joined to the
 * earliest island of the tree, then the island listed first, then the points in order. Each island keeps its nearest pair to the tree, updated as
 * an island joins, so the time grows with the square of the net's points and not the cube of its islands: a 2,970-part board opened while its
 * pours were still filling had each ground pad an island of its own, and the plain search held the editor for hours.
 */
export function spanningLines(groups: Vec2[][]): { a: Vec2; b: Vec2 }[] {
  const n = groups.length
  const lines: { a: Vec2; b: Vec2 }[] = []
  const joined = new Uint8Array(n)
  const bestD = new Float64Array(n).fill(Infinity)
  const bestT = new Int32Array(n)
  const bestA: (Vec2 | null)[] = new Array(n).fill(null)
  const bestB: (Vec2 | null)[] = new Array(n).fill(null)
  // Island `t` joins the tree as its `order`th island: the islands still out take its points where they are nearer.
  const join = (t: number, order: number) => {
    joined[t] = 1
    for (let g = 0; g < n; g++) {
      if (joined[g]) continue
      for (const a of groups[t]) {
        for (const b of groups[g]) {
          // A pair whose squared distance is clearly past the nearest so far can't be nearer, so `dist` (exact, and slow) is taken only near it.
          const dx = a.x - b.x
          const dy = a.y - b.y
          if (dx * dx + dy * dy > bestD[g] * bestD[g] * (1 + 1e-9)) continue
          const d = dist(a, b)
          if (d < bestD[g]) {
            bestD[g] = d
            bestT[g] = order
            bestA[g] = a
            bestB[g] = b
          }
        }
      }
    }
  }
  join(0, 0)
  for (let order = 1; order < n; order++) {
    let next = -1
    for (let g = 0; g < n; g++) {
      if (joined[g] || !bestA[g]) continue
      if (next < 0 || bestD[g] < bestD[next] || (bestD[g] === bestD[next] && bestT[g] < bestT[next])) next = g
    }
    if (next < 0) break
    lines.push({ a: bestA[next]!, b: bestB[next]! })
    join(next, order)
  }
  return lines
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
    /** Stop at the fills: the rest of the analysis (islands, ratsnest, checks) is empty (`zoneFillsOf`). */
    fillsOnly?: boolean
  } = {},
): PcbAnalysis {
  // X30: the zones of the parts are zones of the board here (a keepout of a part keeps out, a pour of a part is filled).
  project = withPartZones(project)
  const copper = buildCopperItems(project, sch)
  // Pours need each item's net, which comes from copper connectivity without the pours.
  let zoneFills: ZoneFill[] = opts.fills ?? []
  let pending: PendingGroup[] = []
  if (project.zones.length && !opts.fills) {
    const netOf = copperNetOf(project, sch, copper)
    // A zone brought in from KiCad keeps KiCad's own fill while nothing that could change it has (`zoneKeep.ts`); only the other zones are filled here.
    let kept: Map<string, ZoneFill[]> | null = null
    if (hasKeptFills(project)) {
      const names = new Map(sch.nets.map((n) => [n.id, n.name]))
      kept = keptFills(project, keptContext(project, copper, netOf, (id) => (id ? (names.get(id) ?? null) : null)), sch)
      if (!kept.size) kept = null
    }
    if (opts.carve) {
      const { fills, known } = opts.carve
      const nameById = new Map(sch.nets.map((n) => [n.id, n.name]))
      zoneFills = carveFills(project, fills, copper.flatMap((it, i) => (known.has(it.id) ? [] : [{ item: it, net: netOf(i) }])), (id) => (id ? (nameById.get(id) ?? null) : null))
    } else if (kept && !project.zones.some((z) => needsOwnFill(z, kept!))) zoneFills = mergeKept(project, kept, [])
    else if (opts.reuseOnly) {
      const r = fillZonesReusing(project, sch, { items: copper, netOf, keepIslands: opts.keepIslands }, opts.reuseOnly.stale)
      zoneFills = kept ? mergeKept(project, kept, r.fills) : r.fills
      pending = r.missing
    } else {
      const made = fillZones(project, sch, { items: copper, netOf, keepIslands: opts.keepIslands })
      zoneFills = kept ? mergeKept(project, kept, made) : made
    }
  }
  if (opts.fillsOnly) return { items: copper, island: new Map(), islandNet: new Map(), traceNet: new Map(), viaNet: new Map(), ratsnest: [], violations: [], zoneFills }
  const items = zoneFills.length ? [...copper, ...zoneItems(zoneFills)] : copper
  // Net ties: a net tie footprint's own copper may overlap itself, and a track is excused where it enters a tie pad of its own net.
  const ties = netTies(project, items)
  // On a project from KiCad, pads that share a number are one piece of copper only on a footprint that says they are jumpers (KiCad 9's
  // `duplicate_pad_numbers_are_jumpers`): KiCad draws a connection to make between the others, as between any two pads of a net.
  const jumpered = new Set(project.components.filter((c) => c.flags?.jumperDuplicates).map((c) => c.id))
  const fillNet = new Map(zoneFills.flatMap((f) => f.polygons.map((_, i) => [`zone:${f.zoneId}:${i}`, f.netId] as const)))
  const loneOf = new Map(project.components.filter((c) => c.loneNets).map((c) => [c.id, c.loneNets!]))
  const { find, islandNets, islandNet } = connectItems(
    items,
    ties,
    fromKicad(project) ? (id) => jumpered.has(id) : undefined,
    fillNet,
    loneOf.size ? (pad) => (pad.pin ? loneOf.get(pad.componentId)?.[pad.pin] : undefined) : undefined,
  )

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
  // On a project from KiCad a finding takes the project's severity for KiCad's rule (`rule` names it where the kind alone does not), and a rule set to
  // ignore, or a check KiCad does not have, is not reported (`model/checkRules.ts`); a project drawn here keeps the editor's own.
  const kicad = fromKicad(project)
  const push = (v: Omit<DrcViolation, "id">, rule?: string) => {
    if (kicad && v.items && boardCheckDismissed(project, v.kind, v.at, v.items, rule)) return
    const severity = kicad ? boardCheckSeverity(project, v.kind, v.severity, rule) : v.severity
    if (severity) violations.push({ ...v, severity, id: `drc${vid++}` })
  }

  // Shorts: one for each piece of copper that joins nets. On a project from KiCad, one for each two items that touch on different nets (or one on none),
  // as KiCad counts them, with the clearances below; then a piece none of whose items says its net (copper drawn here) whole.
  const islandShort = (root: number) => {
    const names = [...islandNets.get(root)!].map((id) => sch.nets.find((x) => x.id === id)?.name ?? id)
    const idx = items.findIndex((_, i) => find(i) === root && items[i].kind === "segment")
    const at = itemCenter(items[idx >= 0 ? idx : items.findIndex((_, i) => find(i) === root)])
    push({ severity: "error", kind: "short", message: `Short between ${names.join(", ")}`, at })
  }
  if (!kicad) for (const [root, nets] of islandNets) if (nets.size >= 2) islandShort(root)

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
    for (const { a, b } of spanningLines(groups)) ratsnest.push({ netId, a, b })
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
  // On a project from KiCad, the pads of one number of a part whose pin is on no net of the schematic but that the board file put on a net of their own
  // (`unconnected-(J1-MountPin-PadMP)`, kept as `loneNets`) are one net to KiCad, and copper must join them: one connection to make for each piece of copper past
  // the first. Pads the file left on no net need none. They draw no line (there is no net of the project's to draw it for).
  if (kicad) {
    const groups = new Map<string, number[]>()
    const lone = new Map(project.components.filter((c) => c.loneNets).map((c) => [c.id, c.loneNets!]))
    items.forEach((it, i) => {
      if (it.kind !== "pad" || it.netId || !it.pad.pin || !lone.get(it.pad.componentId)?.[it.pad.pin] || isNpth(it.pad)) return
      const k = `${it.pad.componentId}|${it.pad.pin}`
      groups.set(k, [...(groups.get(k) ?? []), i])
    })
    for (const [k, list] of groups) {
      const roots = [...new Set(list.map(find))]
      if (roots.length < 2) continue
      const cut = k.indexOf("|")
      const componentId = k.slice(0, cut)
      const pin = k.slice(cut + 1)
      const name = lone.get(componentId)![pin]
      for (let n = 1; n < roots.length; n++) {
        const a = items[list.find((i) => find(i) === roots[n - 1])!]
        const b = items[list.find((i) => find(i) === roots[n])!]
        const pa = itemCenter(a)
        const pb = itemCenter(b)
        push({ severity: "warning", kind: "unrouted", message: `Unrouted connection on ${name}`, at: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } })
      }
    }
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
  const padPart = (it: CopperItem) => (it.kind === "pad" ? it.pad.componentId : null)
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
  // On a project from KiCad, the net each item says it is on: a pad's, and a track's or via's from the file, null for one the file put on no net (`noNet`);
  // undefined for copper drawn here, which is of whatever it touches.
  const noNetTraces = new Set(project.traces.filter((t) => t.noNet).map((t) => t.id))
  const noNetVias = new Set(project.vias.filter((v) => v.noNet).map((v) => v.id))
  const ownNet = (it: CopperItem): string | null | undefined =>
    it.kind === "pad" ? (it.netId ?? null) : it.kind === "segment" ? (noNetTraces.has(it.traceId) ? null : (it.netId ?? undefined)) : it.kind === "via" ? (noNetVias.has(it.viaId) ? null : (it.netId ?? undefined)) : undefined
  const shorted = new Set<number>()
  forOverlappingPairs(items, clearance, (i, j) => {
    const x = items[i]
    const y = items[j]
    if (x.kind === "zone" || y.kind === "zone") return
    if (!shareLayer(x, y)) return
    // The pads of a part are its maker's land pattern, not checked against each other (KiCad 10 reports none on the boards measured either: a solder
    // jumper's two pads 0.25 mm apart under a 0.28 mm class pass there). Their holes are checked against them below, on a project from KiCad.
    if (x.kind === "pad" && y.kind === "pad" && x.pad.componentId === y.pad.componentId) return
    // Hole-to-hole spacing is a drill rule, not a copper clearance. On a project from KiCad a hole with no copper is held to the board's hole clearance below.
    const holeX = isNpthItem(x)
    const holeY = isNpthItem(y)
    if (holeX && holeY) return
    if (kicad && (holeX || holeY)) return
    if (!boxesOverlap(inflate(x.box, clearance), y.box)) return
    const ri = find(i)
    const rj = find(j)
    if (kicad && ri === rj) {
      // KiCad's `shorting_items`: two items that say their nets, touching on different ones ("nets <no net> and GND" when one says none).
      const a = ownNet(x)
      const c = ownNet(y)
      if (a !== undefined && c !== undefined && a !== c && itemDistance(x, y, TOUCH) <= 1e-6 && !(ties && tieExempt(ties, x, y))) {
        shorted.add(ri)
        const [netted, bare] = a ? [x, y] : [y, x]
        const at = nearestPointOf(bare, itemCenter(netted))
        const names = [nameOfNet(a) ?? a, nameOfNet(c) ?? c].sort()
        push({ severity: "error", kind: "short", message: a && c ? `Short between ${names.join(", ")} (${describe(x)} touches ${describe(y)})` : `Short between ${nameOfNet(ownNet(netted)) ?? "a net"} and ${describe(bare)}, which has no net`, at: { x: at.x, y: at.y } })
      }
    }
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
      // KiCad leaves a part's own drawings alone against each other, and a net tie's against its pads; a part's other pads it checks against its drawings.
      if (ox !== null && ox === ownerOf(y) && ox !== BOARD_OWNER && (!kicad || (x.kind === "shape" && y.kind === "shape") || ties?.pads.has(ox))) return
    }
    // A clearance rule for a pad's part, or for the two nets, replaces the classes' (`ClassIndex.pair`); a board with neither is the rules' one.
    let need = hasNetClasses(project.rules) || classes.ruledAny ? classes.pair(nameOfNet(ni), nameOfNet(nj), padPart(x), padPart(y)) : classes.worst
    // A pad's own clearance raises the classes' and never lowers it: `DRC_ENGINE::EvalRules` max's each item's local clearance with the class value
    // (drc_engine.cpp 9.0 :1451-1540, 10.0 :1982-2063) and then holds the result to the board's minimum, which `classes.worst` and `pair` already do.
    const ox = x.kind === "pad" ? x.pad.clearance : undefined
    const oy = y.kind === "pad" ? y.pad.clearance : undefined
    if (ox || oy) need = Math.max(need, ox ?? 0, oy ?? 0)
    // Exact below the clearance, which is all the check reads.
    const d = itemDistance(x, y, need)
    // A gap within KiCad's half micrometre of the clearance passes (`DRC_EPSILON`).
    if (d >= need - tolerance(kicad)) return
    // Once for two pieces of copper that touch nothing else in common. On a project from KiCad, once for each track or via, which KiCad stops testing at
    // its first finding (`testTrackClearances`), and once for each other pair of items, as KiCad counts them.
    const track = (it: CopperItem) => it.kind === "segment" || it.kind === "via"
    const key = !kicad ? `${Math.min(ri, rj)}:${Math.max(ri, rj)}` : track(x) && track(y) ? (x.id < y.id ? x.id : y.id) : track(x) ? x.id : track(y) ? y.id : `${x.id}|${y.id}`
    if (reported.has(key)) return
    reported.add(key)
    const at =
      x.kind === "segment"
        ? closestPointOnSegment(itemCenter(y), x.a, x.b)
        : y.kind === "segment"
          ? closestPointOnSegment(itemCenter(x), y.a, y.b)
          : itemCenter(x)
    push(
      {
        severity: "error",
        kind: "clearance",
        message: `${holeX || holeY ? "Hole clearance" : "Clearance"} ${d.toFixed(3)} mm < ${need} mm between ${describe(x)} and ${describe(y)}`,
        at,
      },
      holeX || holeY ? "hole_clearance" : undefined,
    )
  })

  if (kicad) for (const [root, nets] of islandNets) if (nets.size >= 2 && !shorted.has(root)) islandShort(root)

  // On a project from KiCad, every hole against copper of another net (or of none) on the layers it goes through, at the board's least hole clearance
  // (KiCad's `hole_clearance`, `min_hole_clearance`): a hole with no copper of its own, and a plated one whose copper is less than that wider than the hole.
  if (kicad) for (const v of holeClearanceViolations(project, items, find, islandNet, describe, kicadHoleClearance(project), ties)) push(v, "hole_clearance")

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
  // KiCad has no check of a part past the outline (its courtyard may overhang, as a connector's does), so a project from KiCad is not checked for one.
  for (const c of kicad ? [] : onBoardParts) {
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

  // Courtyard overlap. A land with courtyard drawings (a footprint from KiCad) is tested by the outlines they close, on each side it has one,
  // as KiCad does (`DRC_TEST_PROVIDER_COURTYARD_CLEARANCE`); on a project from KiCad a land with none has no courtyard, as in KiCad, where
  // `missing_courtyard` is its own rule. The editor's own lands are their courtyard's box on their own side.
  const copperCount = copperLayers(project.board).length
  const placed = onBoardParts
    .map((c) => {
      if (!c.pcb.placed || !hasCourtyard(c)) return null
      const drawn = drawnCourtyards(c, copperCount)
      if (!drawn && kicad) return null
      const box = pcbCourtyard(c)
      return box ? { c, box, drawn } : null
    })
    .filter((x): x is { c: (typeof project.components)[number]; box: Box; drawn: { top: Vec2[][]; bottom: Vec2[][] } | null } => !!x)
  // A custom rule of a project from KiCad may let courtyards overlap near a part (a module over other parts, `courtyardRules.ts`).
  const allowed = kicad ? courtyardAllowance(project, placed.map((x) => x.c), (c) => placed.find((x) => x.c === c)?.drawn ?? null, copperCount) : null
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i]
      const q = placed[j]
      if (p.drawn || q.drawn) {
        const sides = (x: typeof p) => x.drawn ?? (x.c.pcb.side === "bottom" ? { top: [], bottom: [pcbCourtyardRing(x.c)!] } : { top: [pcbCourtyardRing(x.c)!], bottom: [] })
        const a = sides(p)
        const b = sides(q)
        const top = courtyardsOverlap(a.top, b.top) && !allowed?.(p.c, q.c, "top")
        if (!top && !(courtyardsOverlap(a.bottom, b.bottom) && !allowed?.(p.c, q.c, "bottom"))) continue
        push({ severity: "warning", kind: "overlap", message: `${p.c.ref} overlaps ${q.c.ref}`, at: { x: (p.c.pcb.x + q.c.pcb.x) / 2, y: (p.c.pcb.y + q.c.pcb.y) / 2 }, items: [`c:${p.c.id}`, `c:${q.c.id}`] })
        continue
      }
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
        items: [`c:${p.c.id}`, `c:${q.c.id}`],
      })
    }
  }

  // Rule areas that keep tracks, vias, pads or parts out.
  if (project.zones.length) for (const v of keepoutViolations(project, items)) push(v)
  // X20: a part outside the placement area that picks it (nothing for a project with no placement area).
  if (project.zones.some((z) => z.placement)) {
    for (const p of placementProblems(project)) push({ severity: "error", kind: "placement-area", message: `${p.component.ref} is outside ${areaNames(p.areas)}, where it has to sit`, at: p.at })
  }

  // Decoupling capacitors far from the supply pin they serve. Where several chips share the rail,
  // a capacitor beside the supply pin of any of them is fine, so only one far from all is reported. The editor's rule of thumb, not KiCad's: not on a project from KiCad.
  for (const d of kicad ? [] : decouplingGaps(project, decouplingPairs(project, sch))) {
    // Judged as the message rounds it, so "3.0 mm" never reads as over 3 mm.
    if (Number(d.gap.toFixed(1)) <= DECOUPLING_WARN_MM) continue
    push({
      severity: "warning",
      kind: "decoupling",
      message: `${d.cap.ref} is ${d.gap.toFixed(1)} mm from ${d.chip.ref} pin ${d.pin} (${d.pinName}); aim for under ${DECOUPLING_WARN_MM} mm`,
      at: { x: d.cap.pcb.x, y: d.cap.pcb.y },
    })
  }

  // X21: a tuning pattern whose net is no longer the length it was tuned to. The editor's own check: KiCad's DRC judges a length only by a rule's
  // `length` constraint, never by a tuning pattern's target (CERN's Macbeth has 21 such nets, some with the 1,000,000 mm placeholder, and kicad-cli
  // reports none), so a project from KiCad does not have it.
  if (project.groups?.some((g) => g.gen?.kind === "tuning_pattern")) {
    for (const f of lengthFindings(project, sch, traceNet, viaNet)) {
      push({ severity: "warning", kind: "tuning", message: `Net ${f.net} is ${f.total.toFixed(3)} mm (${f.detail}); its tuning pattern wants ${f.min.toFixed(3)} to ${f.max.toFixed(3)} mm`, at: f.at })
    }
  }

  manufacturability(project, items, find, push, kicad)

  return { items, island, islandNet, traceNet, viaNet, ratsnest, violations, zoneFills, ...(pending.length ? { zonesPending: pending } : {}) }
}

// ---------- Holes against copper (a project from KiCad) ----------

/**
 * KiCad's hole clearance (`DRC_TEST_PROVIDER_COPPER_CLEARANCE`'s hole tests): the hole of a pad or via against the copper of every item on a layer the hole
 * goes through that is not on its net (a defined net waives the test, as in KiCad), taken from the hole's wall. The pad's own copper and the pads of its number
 * are its own; a via's hole counts only on the layers it spans. One finding for each hole and item, less than `need` (less KiCad's half micrometre) apart.
 */
function holeClearanceViolations(
  project: Project,
  items: CopperItem[],
  find: (i: number) => number,
  islandNet: Map<number, string | null>,
  describe: (it: CopperItem) => string,
  need: number,
  ties: NetTies | null = null,
): Omit<DrcViolation, "id">[] {
  if (need <= 0) return []
  const out: Omit<DrcViolation, "id">[] = []
  const viaOf = new Map(project.vias.map((v) => [v.id, v]))
  const holes: { item: number; copper: ShapeCopper; box: Box; layers: readonly CopperLayer[] }[] = []
  const done = new Set<string>()
  items.forEach((it, i) => {
    if (it.kind === "pad" && it.pad.holeDiameter) {
      const ends = slotEnds(it.pad)
      const c = ends ? { a: ends[0], b: ends[1] } : { a: holeCentre(it.pad), b: holeCentre(it.pad) }
      const r = it.pad.holeDiameter / 2
      holes.push({ item: i, copper: { edges: [[c.a, c.b]], half: r, fill: [] }, box: { minX: Math.min(c.a.x, c.b.x) - r, minY: Math.min(c.a.y, c.b.y) - r, maxX: Math.max(c.a.x, c.b.x) + r, maxY: Math.max(c.a.y, c.b.y) + r }, layers: copperLayers(project.board) })
    } else if (it.kind === "via" && !done.has(it.viaId)) {
      done.add(it.viaId)
      const v = viaOf.get(it.viaId)
      if (!v) return
      const r = v.drill / 2
      holes.push({ item: i, copper: { edges: [[it.at, it.at]], half: r, fill: [] }, box: { minX: it.at.x - r, minY: it.at.y - r, maxX: it.at.x + r, maxY: it.at.y + r }, layers: viaLayers(project.board, v) })
    }
  })
  if (!holes.length) return out
  const netOf = (i: number) => {
    const it = items[i]
    const n = it.kind === "zone" ? null : (it.netId ?? islandNet.get(find(i)) ?? null)
    return n === "short" ? null : n
  }
  const reported = new Set<string>()
  const order = items.map((_, i) => i).filter((i) => items[i].kind !== "zone").sort((a, b) => items[a].box.minX - items[b].box.minX)
  // The items near a hole, found by the cells of a grid their boxes reach and taken in the order above: each hole went through every item to its
  // left, 1.9 s of the checks of a board of 8,000 holes.
  const rank = new Int32Array(items.length)
  order.forEach((j, k) => (rank[j] = k))
  const near = boxGrid(order.map((j) => [j, items[j].box] as const))
  for (const h of holes) {
    const hole = items[h.item]
    const own = netOf(h.item)
    const reach = { minX: h.box.minX - need, minY: h.box.minY - need, maxX: h.box.maxX + need, maxY: h.box.maxY + need }
    for (const j of near(reach).sort((a, b) => rank[a] - rank[b])) {
      const it = items[j]
      if (it.box.minX > h.box.maxX + need) continue
      if (j === h.item || it.box.maxX < h.box.minX - need || it.box.maxY < h.box.minY - need || it.box.minY > h.box.maxY + need) continue
      if (!it.layers.some((l) => h.layers.includes(l))) continue
      // Its own copper: the pad itself (and a pad stack's other layers), the via's other items, the pads of its number on its part.
      if (hole.kind === "pad" && it.kind === "pad" && it.pad.componentId === hole.pad.componentId && (it.id.startsWith(`${hole.id}@`) || (it.pad.padNumber ?? null) === (hole.pad.padNumber ?? null))) continue
      if (hole.kind === "via" && it.kind === "via" && it.viaId === hole.viaId) continue
      // A net tie's drawing is the tie: it reaches into the tie's pads, holes and all. KiCad's DRC passes the hole of a tie pad against the tie's own copper
      // (`IsNetTieExclusion` at the hole's centre, drc_test_provider_copper_clearance.cpp 9.0); another pad of the tie is held to the clearance still.
      if (ties && hole.kind === "pad" && it.kind === "shape" && it.owner === hole.pad.componentId && ties.pads.get(it.owner)?.some((p) => p.item === hole)) continue
      if (isNpthItem(it)) continue
      const net = netOf(j)
      if (own && net && own === net) continue
      const d = holeDistance(h.copper, it)
      if (d >= need - tolerance(true)) continue
      // Copper connected to the hole's own (a track into the pad, a via in its pad) is one conductor with it.
      if (find(j) === find(h.item)) continue
      const key = `${hole.kind === "via" ? hole.viaId : hole.id}|${it.kind === "segment" ? it.traceId : it.kind === "via" ? it.viaId : it.id}`
      if (reported.has(key)) continue
      reported.add(key)
      out.push({
        severity: "error",
        kind: "clearance",
        message: `Hole clearance ${Math.max(0, d).toFixed(3)} mm < ${need} mm between the hole of ${describe(hole)} and ${describe(it)}`,
        at: hole.kind === "via" ? hole.at : hole.kind === "pad" ? { x: holeCentre(hole.pad).x, y: holeCentre(hole.pad).y } : itemCenter(hole),
      })
    }
  }
  return out
}

/** From a hole's wall (its centre line, a point or a slot's two ends, and its radius) to an item's copper, exactly for round copper: a polygon's would be off by its flattening. */
function holeDistance(hole: ShapeCopper, it: CopperItem): number {
  const [a, b] = hole.edges[0]
  const r = hole.half
  if (it.kind === "via") return Math.max(0, pointSegmentDistance(it.at, a, b) - r - it.diameter / 2)
  if (it.kind === "segment") return Math.max(0, (it.arc ? segmentArcDistance(a, b, it.arc) : segmentSegmentDistance(a, b, it.a, it.b)) - r - it.width / 2)
  if (it.kind === "pad") return Math.max(0, segmentPadDistance(a, b, it.pad) - r)
  return shapeShapeDistance(hole, itemCopper(it))
}

// ---------- Courtyards drawn as KiCad draws them ----------

/** KiCad's reach for joining the ends of a courtyard's pieces into an outline (`FOOTPRINT::BuildCourtyardCaches`: 0.02 mm). */
const COURTYARD_CHAIN = 0.02

/**
 * A part's courtyards from its land's drawings on `F.CrtYd` and `B.CrtYd`, placed on the board (a bottom part's are on the other side), by the side they are on:
 * the closed drawings' outlines, and the outlines lines and arcs close end to end. Null for a land with no courtyard drawing. Pieces that close nothing are left out,
 * as KiCad leaves a malformed courtyard out of the overlap test.
 */
function drawnCourtyards(c: ComponentInstance, copperCount: number): { top: Vec2[][]; bottom: Vec2[][] } | null {
  const shapes = pcbShapes(c, copperCount).filter((x) => x.layer === "F.CrtYd" || x.layer === "B.CrtYd")
  if (!shapes.length) return null
  const out = { top: [] as Vec2[][], bottom: [] as Vec2[][] }
  for (const side of ["F.CrtYd", "B.CrtYd"] as const) {
    const rings = side === "F.CrtYd" ? out.top : out.bottom
    const open: Vec2[][] = []
    for (const x of shapes) {
      if (x.layer !== side) continue
      if (isClosedShape(x)) rings.push(...shapeRings(x).slice(0, 1))
      else open.push(...shapePolylines(x).filter((l) => l.length >= 2))
    }
    // Chain the open pieces: from each unused one, take the piece whose end meets its last point until the outline is back at its start.
    const used = new Set<number>()
    const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) <= COURTYARD_CHAIN
    for (let i = 0; i < open.length; i++) {
      if (used.has(i)) continue
      used.add(i)
      const ring = [...open[i]]
      for (;;) {
        if (ring.length > 2 && near(ring[ring.length - 1], ring[0])) {
          ring.pop()
          if (ring.length >= 3) rings.push(ring)
          break
        }
        const last = ring[ring.length - 1]
        const k = open.findIndex((l, n) => !used.has(n) && (near(l[0], last) || near(l[l.length - 1], last)))
        if (k < 0) break
        used.add(k)
        const next = near(open[k][0], last) ? open[k] : [...open[k]].reverse()
        ring.push(...next.slice(1))
      }
    }
  }
  return out
}

const ringBox = (r: Vec2[]): Box => ({ minX: Math.min(...r.map((p) => p.x)), minY: Math.min(...r.map((p) => p.y)), maxX: Math.max(...r.map((p) => p.x)), maxY: Math.max(...r.map((p) => p.y)) })

/** Whether two segments cross at a point inside both, not where one only ends on or runs along the other. */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const eps = 1e-9 * Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(d.x - c.x, d.y - c.y), 1e-9)
  const d1 = o(a, b, c)
  const d2 = o(a, b, d)
  const d3 = o(c, d, a)
  const d4 = o(c, d, b)
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
}

/**
 * Whether two sets of courtyard outlines overlap with some area, as KiCad's polygon collision at a clearance of 0 finds: outlines that only touch, along an
 * edge or at a corner, do not. An edge of one crossing an edge of the other, or a corner or the middle of an edge of one inside the other.
 */
function courtyardsOverlap(a: Vec2[][], b: Vec2[][]): boolean {
  const eps = 1e-6
  const strictlyIn = (p: Vec2, r: Vec2[]) => pointInRings(p, [r]) && !r.some((q, i) => pointSegmentDistance(p, q, r[(i + 1) % r.length]) <= eps)
  for (const x of a) {
    for (const y of b) {
      const bx = ringBox(x)
      const by = ringBox(y)
      if (bx.maxX <= by.minX + eps || by.maxX <= bx.minX + eps || bx.maxY <= by.minY + eps || by.maxY <= bx.minY + eps) continue
      for (let i = 0; i < x.length; i++) for (let k = 0; k < y.length; k++) if (segmentsCross(x[i], x[(i + 1) % x.length], y[k], y[(k + 1) % y.length])) return true
      for (const [r, other] of [[x, y], [y, x]] as const) {
        for (let i = 0; i < r.length; i++) {
          const p = r[i]
          const q = r[(i + 1) % r.length]
          if (strictlyIn(p, other) || strictlyIn({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, other)) return true
        }
      }
    }
  }
  return false
}

const analyses = new WeakMap<Project, PcbAnalysis>()
const givenFills = new WeakMap<Project, ZoneFill[]>()

/**
 * Give a copy of a project the project's pour fills, for its analysis to take rather than fill again: a copy an export writes from (the KiCad export's,
 * with the rule areas' flags on its symbols, and each sheet's view of it) has the project's board. Its fills could be judged anew otherwise, and one
 * zone that is not current refills every zone (a KiCad 5 board's export took 5 minutes, after its checks had taken 2 seconds on the project).
 */
export function useFillsOf(copy: Project, fills: ZoneFill[]): void {
  if (!analyses.has(copy)) givenFills.set(copy, fills)
}

/** `analyzePcb` of the project as it is, kept for as long as the project object is (an export asks for it more than once, and a pour's fill is seconds). */
export function analyzePcbOnce(project: Project, sch: SchematicConnectivity): PcbAnalysis {
  let made = analyses.get(project)
  if (!made) {
    const fills = givenFills.get(project)
    analyses.set(project, (made = analyzePcb(project, sch, fills ? { fills } : {})))
  }
  return made
}

/** The pour fills of the project: those of its analysis when that is made already, or given it (`useFillsOf`), else made without the rest of an analysis. */
export function zoneFillsOf(project: Project, sch: () => SchematicConnectivity): ZoneFill[] {
  return (analyses.get(project)?.zoneFills ?? givenFills.get(project) ?? analyzePcb(project, sch(), { fillsOnly: true }).zoneFills)
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
  push: (v: Omit<DrcViolation, "id">, rule?: string) => void,
  kicad = false,
) {
  const { rules, board } = project
  const eps = 1e-6
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const owner = (id: string) => (id === BOARD_OWNER ? "Mounting holes" : (refOf.get(id) ?? "A part"))

  // A KiCad project whose file sets no minimum track width or hole has none (`noKicadMinimum`).
  const anyWidth = kicad && noKicadMinimum(project, "minTraceWidth")
  const anyDrill = kicad && noKicadMinimum(project, "minDrill")
  for (const t of anyWidth ? [] : project.traces) {
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
    if (minDrillHere !== undefined && !(anyDrill && !micro && rules.minViaDrill === undefined) && v.drill < minDrillHere - eps) note(`drill:${micro ? "micro" : "via"}:${v.id}`, v.drill, v, micro ? "Micro via" : "Via", minDrillHere)
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
    if (!anyDrill && hole < rules.minDrill - eps) note(`drill:${pad.componentId}`, hole, at, owner(pad.componentId), rules.minDrill)
    if (isNpth(pad)) continue
    // A pad with a hole off its centre, rounded corners or a shape of its own has the ring its outline leaves; any other, the one it always had.
    const ring = pad.hole || pad.corner || padRingsOf(pad) ? padRingWidth(pad) : (Math.min(pad.width, pad.height) - hole) / 2
    if (ring < rules.minAnnularRing - eps) note(`ring:${pad.componentId}`, ring, at, owner(pad.componentId), rules.minAnnularRing)
  }
  for (const [key, s] of smallest) {
    const drill = key.startsWith("drill:")
    push(
      {
      severity: "error",
      kind: drill ? "drill" : "annular-ring",
      message: drill
        ? `${s.what} drill ${mm(s.value)} is below the ${mm(s.limit)} minimum`
        : s.value < eps
          ? `${s.what} has no copper ring around its hole`
          : `${s.what} annular ring ${mm(s.value)} is below the ${mm(rules.minAnnularRing)} minimum`,
        at: s.at,
      },
      key.startsWith("drill:micro:") ? "microvia_drill_out_of_range" : undefined,
    )
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
      if (gap >= rules.holeClearance - tolerance(kicad)) continue
      push({
        severity: "error",
        kind: "hole-clearance",
        message: gap <= 0 ? "Drill holes overlap" : `Holes ${mm(gap)} apart, closer than the ${mm(rules.holeClearance)} minimum`,
        at: { x: (h.a.x + k.a.x) / 2, y: (h.a.y + k.a.y) / 2 },
      })
    }
  }

  // Copper to board edge: once per trace, via or part. Parts that overhang are already reported. A KiCad board that draws nothing on Edge.Cuts has no edge
  // to keep from (KiCad reports none, and the missing outline is its own error); the editor's own board is its rectangle then.
  const edgeSeen = new Set<string>()
  for (const it of kicad && outlineState(board) === "missing" ? [] : items) {
    if (it.kind === "zone" || isNpthItem(it)) continue
    const d = itemEdgeDistance(board, it, rules.edgeClearance + 0.01)
    if (d >= rules.edgeClearance - tolerance(kicad)) continue
    // Once per trace, via, drawing or part; on a project from KiCad once per piece of copper (a track's segment, a pad), as KiCad counts them.
    const key = kicad ? it.id : it.kind === "segment" ? it.traceId : it.kind === "via" ? it.viaId : it.kind === "shape" ? it.shapeId : it.pad.componentId
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

  // Via drills in SMD pads: the editor's own rule, which KiCad does not have (a project from KiCad is not checked for it).
  if (!rules.viaInPad && !kicad) {
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
        const margins = maskMargin(x.pad, rules) + maskMargin(y.pad, rules)
        const gap = padPadDistance(x.pad, y.pad, web + margins) - margins
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
    push(
      {
        severity: "warning",
        kind: "floating-copper",
        message: it.kind === "via" ? "Via isn't connected to anything" : "Trace isn't connected to anything",
        at: it.kind === "via" ? it.at : { x: (it.a.x + it.b.x) / 2, y: (it.a.y + it.b.y) / 2 },
      },
      it.kind === "via" ? "via_dangling" : "track_dangling",
    )
  })
}
