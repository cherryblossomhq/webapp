import {
  boxesOverlap,
  closestPointOnSegment,
  dist,
  pointSegmentDistance,
  segmentSegmentDistance,
  segmentsIntersect,
  type Box,
} from "../lib/geometry"
import { mountingHoles } from "./board"
import { pinKey, type SchematicConnectivity } from "./connectivity"
import { DECOUPLING_WARN_MM, decouplingGaps, decouplingPairs } from "./decoupling"
import { findPart } from "./library"
import { isNpth, isPhysical, pcbCourtyard, pcbPads, slotEnds, type WorldPad } from "./instances"
import { fillTester, fillZones, type FillPolygon, type ZoneFill } from "./pour"
import { formatLength } from "./rules"
import type { BoardDef, CopperLayer, Project, Vec2, Via } from "./types"

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
    }
  | { kind: "via"; id: string; viaId: string; at: Vec2; diameter: number; layers: CopperLayer[]; box: Box }
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
    | "hole-clearance"
    | "edge-clearance"
    | "via-in-pad"
    | "floating-copper"
    | "decoupling"
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

/** Distance from point to a pad's copper (0 inside). */
export function pointPadDistance(p: Vec2, pad: WorldPad): number {
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
  const a = padBox(p)
  const b = padBox(q)
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0)
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0)
  return Math.hypot(dx, dy)
}

/** Edge-to-edge distance between two copper items (0 when touching/overlapping). */
export function itemDistance(x: CopperItem, y: CopperItem): number {
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

function itemPoint(item: CopperItem): Vec2[] {
  if (item.kind === "pad") return [{ x: item.pad.x, y: item.pad.y }]
  if (item.kind === "via") return [item.at]
  if (item.kind === "zone") return []
  return [item.a, item.b]
}

function itemCenter(item: CopperItem): Vec2 {
  if (item.kind === "pad") return { x: item.pad.x, y: item.pad.y }
  if (item.kind === "via") return item.at
  if (item.kind === "zone") return item.polygon[0][0]
  return { x: (item.a.x + item.b.x) / 2, y: (item.a.y + item.b.y) / 2 }
}

/** Points that join an item to a pour when they lie inside the fill. */
const anchorPoints = (item: CopperItem): Vec2[] => itemPoint(item)

export function buildCopperItems(project: Project, sch: SchematicConnectivity): CopperItem[] {
  const items: CopperItem[] = []
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
    })
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
function connectItems(items: CopperItem[]): Islands {
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
    if (x.kind === "zone" || y.kind === "zone") {
      const [z, o] = x.kind === "zone" ? [x, y] : [y, x]
      if (z.kind === "zone" && o.kind !== "zone" && anchorPoints(o).some((p) => z.contains(p))) union(i, j)
      return
    }
    if (sameComponentPads(x, y)) return
    if (itemDistance(x, y) <= 1e-6) union(i, j)
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

  const islandNets = new Map<number, Set<string>>()
  items.forEach((it, i) => {
    if (it.kind !== "pad" || !it.netId) return
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

/**
 * Connectivity, ratsnest and DRC for the board. `fills` reuses earlier pour fills instead of
 * recomputing them, which keeps drags responsive.
 */
export function analyzePcb(project: Project, sch: SchematicConnectivity, opts: { fills?: ZoneFill[]; keepIslands?: boolean } = {}): PcbAnalysis {
  const copper = buildCopperItems(project, sch)
  // Pours need each item's net, which comes from copper connectivity without the pours.
  let zoneFills: ZoneFill[] = opts.fills ?? []
  if (project.zones.length && !opts.fills) {
    const pre = connectItems(copper)
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
    zoneFills = fillZones(project, sch, { items: copper, netOf, keepIslands: opts.keepIslands })
  }
  const items = zoneFills.length ? [...copper, ...zoneItems(zoneFills)] : copper
  const { find, islandNets, islandNet } = connectItems(items)

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
  const board: Box = { minX: b.x - b.width / 2, minY: b.y - b.height / 2, maxX: b.x + b.width / 2, maxY: b.y + b.height / 2 }
  const outside = (box: Box) => box.minX < board.minX || box.maxX > board.maxX || box.minY < board.minY || box.maxY > board.maxY
  for (const c of project.components) {
    const cy = c.pcb.placed ? pcbCourtyard(c) : null
    if (cy && outside(cy)) {
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
    .map((c) => ({ c, box: c.pcb.placed ? pcbCourtyard(c) : null }))
    .filter((x): x is { c: (typeof project.components)[number]; box: Box } => !!x.box)
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i]
      const q = placed[j]
      if (p.c.pcb.side !== q.c.pcb.side) continue
      if (!boxesOverlap(inflate(p.box, -0.05), inflate(q.box, -0.05))) continue
      push({
        severity: "warning",
        kind: "overlap",
        message: `${p.c.ref} overlaps ${q.c.ref}`,
        at: { x: (p.c.pcb.x + q.c.pcb.x) / 2, y: (p.c.pcb.y + q.c.pcb.y) / 2 },
      })
    }
  }

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

  return { items, island, islandNet, traceNet, viaNet, ratsnest, violations, zoneFills }
}

// ---------- Manufacturability ----------

const mm = (v: number) => formatLength(v, "mm", true)

/** Distance from a point inside the board to its (rounded) outline; negative outside. */
export function edgeDistance(b: BoardDef, p: Vec2): number {
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
function itemEdgeDistance(b: BoardDef, it: CopperItem): number {
  const d = (p: Vec2) => edgeDistance(b, p)
  if (it.kind === "segment") return Math.min(d(it.a), d(it.b)) - it.width / 2
  if (it.kind === "via") return d(it.at) - it.diameter / 2
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
    const d = itemEdgeDistance(board, it)
    if (d >= rules.edgeClearance - eps) continue
    const key = it.kind === "segment" ? it.traceId : it.kind === "via" ? it.viaId : it.pad.componentId
    if (edgeSeen.has(key)) continue
    edgeSeen.add(key)
    const at = it.kind === "segment" ? (edgeDistance(board, it.a) < edgeDistance(board, it.b) ? it.a : it.b) : it.kind === "via" ? it.at : { x: it.pad.x, y: it.pad.y }
    const what = it.kind === "segment" ? "Trace" : it.kind === "via" ? "Via" : `${owner(it.pad.componentId)} pad`
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
