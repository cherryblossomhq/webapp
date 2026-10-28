import { closestPointOnSegment, pointSegmentDistance, round, samePoint, simplifyPolyline, boxesOverlap, type Box } from "../lib/geometry"
import { uid } from "../lib/id"
import { computeConnectivity, type SchematicConnectivity } from "./connectivity"
import { findPart } from "./library"
import { pcbPads, type WorldPad } from "./instances"
import { padBox, padRingsOf } from "./padDistance"
import { pointShapeDistance, type ShapeCopper } from "./shapes"
import { outlineGeometry, rasterizeInside } from "./outline"
import { areaDistance, needsZoneEngine, zoneArea, zoneLayers } from "./zones"
import { analyzePcb, edgeDistance, pointPadDistance, type CopperItem, type PcbAnalysis } from "./pcb"
import { fillTester, type ZoneFill } from "./pour"
import { classIndex, hasNetClasses, type ClassIndex } from "./netClasses"
import { copperLayers } from "./stack"
import type { CopperLayer, Project, Trace, Vec2, Via } from "./types"

export interface AutorouteOptions {
  /** Only route these net ids; all nets when omitted. */
  nets?: string[]
  /** Width for supply and ground nets; defaults to max(rule width, 0.4 mm). */
  powerWidth?: number
  /** Give up after this long (ms), for everything one call does, the fine-pitch retry included. Default 10 s. */
  timeLimitMs?: number
}

export interface AutorouteResult {
  project: Project
  /** Connections routed or joined to a pour. */
  routed: number
  /** Ratsnest lines still open afterwards. */
  remaining: number
  addedTraces: number
  addedVias: number
  /** Of the connections still open, how many end at a fine-pitch pad (a neighbour on its part closer than 0.7 mm). */
  finePitchOpen: number
  /** The thinnest trace width (mm) the fine-pitch retry went down to, or null when it did not run. */
  finePitchTried: number | null
}

const FREE = -1
const BLOCKED = -2
const LAYERS: CopperLayer[] = ["top", "bottom"]
/**
 * X1: the router routes the two outer layers of a board of any number (its grids, searches and vias are two layers deep) and leaves the inner ones
 * as they are. What is on an inner layer is an obstacle it keeps clear of where a via of its own would reach it: a through via has copper on every
 * layer, so a via is kept out of foreign inner copper by the same cells that keep it from the outer layers'. Inner copper is no place to start or
 * end a connection, and no track keeps out of it. A board of two layers is what it was.
 */
const outerIndex = (layer: CopperLayer): 0 | 1 | -1 => (layer === "top" ? 0 : layer === "bottom" ? 1 : -1)
const DIRS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]
const TURN_COST = [0, 3, 9, 40, 1e9]
const VIA_COST = 28
/** Extra cost per cell for crossing another net's pad escape corridor. */
const ESCAPE_COST = 8
/** SMD pads closer than this to a neighbour on the same part get an escape corridor. */
const FINE_PITCH = 0.7
const ESCAPE_LEN = 1.2
const CONTESTED = -3
const MAX_EXPANSIONS = 700_000
/** Fine-pitch mode gives up on a search sooner: it runs several, inside one budget, and a failed one floods the free area. */
const FINE_MAX_EXPANSIONS = 150_000
/** A fine-pitch escape stub ends this far past its pad's end at the least, and at most. */
const ESCAPE_STUB_MIN = 0.35
const ESCAPE_STUB_MAX = 2.5
/** Copper this close to a connection that stayed open is taken up for one retry. */
const RIPUP_REACH = 1.5

const POWER_NAME = /^(gnd|agnd|dgnd|pgnd|vcc|vdd|vss|vin|vbus|vbat|v\+|[0-9]+v[0-9]*|[0-9]+v|3v3|5v|12v|1v8|2v5)$/i

/** How far a point inside a pad is from the pad's edge (0 outside). */
function padInset(p: Vec2, pad: WorldPad): number {
  const rings = padRingsOf(pad)
  if (rings) {
    // A turned rectangle or pill of a part at an angle, a chamfered or custom pad (with its holes): inside it, the distance to its nearest side.
    if (pointPadDistance(p, pad) > 0) return 0
    let best = Infinity
    for (const ring of rings) for (let i = 0; i < ring.length; i++) best = Math.min(best, pointSegmentDistance(p, ring[i], ring[(i + 1) % ring.length]))
    return best
  }
  if (pad.corner) {
    // A rounded rectangle is its inner rectangle grown by the radius: the room round a point is the radius less its distance from that rectangle, or the radius and the rectangle's own room inside it.
    const inner = { ...pad, corner: undefined, width: Math.max(0, pad.width - 2 * pad.corner), height: Math.max(0, pad.height - 2 * pad.corner) }
    const d = pointPadDistance(p, inner)
    return d > 0 ? Math.max(0, pad.corner - d) : pad.corner + Math.min(inner.width / 2 - Math.abs(p.x - pad.x), inner.height / 2 - Math.abs(p.y - pad.y))
  }
  if (pad.shape === "circle") return Math.max(0, pad.width / 2 - Math.hypot(p.x - pad.x, p.y - pad.y))
  if (pad.shape === "pill") {
    const r = Math.min(pad.width, pad.height) / 2
    const half = Math.max(pad.width, pad.height) / 2 - r
    const horizontal = pad.width >= pad.height
    const a = horizontal ? { x: pad.x - half, y: pad.y } : { x: pad.x, y: pad.y - half }
    const b = horizontal ? { x: pad.x + half, y: pad.y } : { x: pad.x, y: pad.y + half }
    return Math.max(0, r - pointSegmentDistance(p, a, b))
  }
  return Math.max(0, Math.min(pad.width / 2 - Math.abs(p.x - pad.x), pad.height / 2 - Math.abs(p.y - pad.y)))
}

/** Copper item reduced to what the router needs. */
type Shape =
  | { kind: "pad"; pad: WorldPad; layers: CopperLayer[] }
  | { kind: "segment"; a: Vec2; b: Vec2; width: number; layers: CopperLayer[] }
  | { kind: "via"; at: Vec2; diameter: number; layers: CopperLayer[]; drill?: number }
  /** A drawing on a copper layer: an obstacle, never a place to start or end a connection. */
  | { kind: "drawing"; copper: ShapeCopper; box: Box; layers: CopperLayer[] }

function shapeOf(it: CopperItem, drills?: Map<string, number>): Shape | null {
  if (it.kind === "shape") return { kind: "drawing", copper: it.copper, box: it.box, layers: it.layers }
  if (it.kind === "pad") return { kind: "pad", pad: it.pad, layers: it.layers }
  if (it.kind === "segment") return { kind: "segment", a: it.a, b: it.b, width: it.width, layers: it.layers }
  if (it.kind === "via") return { kind: "via", at: it.at, diameter: it.diameter, layers: it.layers, ...(drills?.has(it.viaId) ? { drill: drills.get(it.viaId) } : {}) }
  return null
}

/** Distance from p to the copper edge of a shape (0 inside). */
function shapeDistance(p: Vec2, s: Shape): number {
  if (s.kind === "drawing") return pointShapeDistance(p, s.copper)
  if (s.kind === "pad") return pointPadDistance(p, s.pad)
  if (s.kind === "segment") return Math.max(0, pointSegmentDistance(p, s.a, s.b) - s.width / 2)
  return Math.max(0, Math.hypot(p.x - s.at.x, p.y - s.at.y) - s.diameter / 2)
}

function shapeBox(s: Shape): Box {
  if (s.kind === "drawing") return s.box
  if (s.kind === "pad") return padBox(s.pad)
  if (s.kind === "segment") {
    const r = s.width / 2
    return { minX: Math.min(s.a.x, s.b.x) - r, maxX: Math.max(s.a.x, s.b.x) + r, minY: Math.min(s.a.y, s.b.y) - r, maxY: Math.max(s.a.y, s.b.y) + r }
  }
  const r = s.diameter / 2
  return { minX: s.at.x - r, maxX: s.at.x + r, minY: s.at.y - r, maxY: s.at.y + r }
}

class MinHeap {
  private ids: number[] = []
  private keys: number[] = []
  get size() {
    return this.ids.length
  }
  push(id: number, key: number) {
    const ids = this.ids
    const keys = this.keys
    let i = ids.length
    ids.push(id)
    keys.push(key)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      ids[i] = ids[p]
      keys[i] = keys[p]
      i = p
    }
    ids[i] = id
    keys[i] = key
  }
  pop(): number {
    const ids = this.ids
    const keys = this.keys
    const top = ids[0]
    const lastId = ids.pop()!
    const lastKey = keys.pop()!
    const n = ids.length
    if (n > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const r = l + 1
        const c = r < n && keys[r] < keys[l] ? r : l
        if (keys[c] >= lastKey) break
        ids[i] = ids[c]
        keys[i] = keys[c]
        i = c
      }
      ids[i] = lastId
      keys[i] = lastKey
    }
    return top
  }
}

interface RoutedPath {
  traces: Omit<Trace, "id">[]
  vias: Vec2[]
  /** The net the path is on (a net id), for the size of its vias: a net's class sets it. */
  net?: string
}

/** What the router asks of each net: the clearance, via diameter and via drill of its net class (a board with no classes: the rules'). */
interface NetRule {
  clearance: number
  viaDiameter: number
  viaDrill: number
}

/** A trace width with the clearance of the class whose net it is for: the keepout cells around other copper depend on both. */
interface Profile {
  width: number
  clearance: number
}

/** A via size with the clearance of its class, for the cells where one of that size may be centred. */
interface ViaProfile extends NetRule {
  owner: Int32Array[]
  /** Cells next to pads, where no via goes. */
  padKeep: Uint8Array
  /** Cells where a new via's drill would be too close to an existing via's. */
  holeKeep: Uint8Array
}

/**
 * Net classes as the router needs them (`netClasses.ts`): per net id, the clearance and via size of its class, and the clearance two nets keep.
 * With no classes every net has the rules' own, and `pairWith` is the rules' clearance: the router is then what it was.
 */
class RouteRules {
  readonly classed: boolean
  private readonly index: ClassIndex
  private readonly cache = new Map<string | null, NetRule>()
  private readonly plain: NetRule
  /** The board's minimum clearance, which no pair goes below. */
  readonly floor: number

  constructor(
    project: Project,
    private netNames: Map<string, string>,
  ) {
    this.classed = hasNetClasses(project.rules)
    this.index = classIndex(project.rules)
    const { clearance, viaDiameter, viaDrill, minClearance } = project.rules
    this.floor = minClearance !== undefined && minClearance > 0 ? minClearance : 0
    this.plain = { clearance, viaDiameter, viaDrill }
  }

  of(netId: string | null | undefined): NetRule {
    if (!this.classed) return this.plain
    const key = netId ?? null
    let r = this.cache.get(key)
    if (!r) {
      const v = this.index.values(key ? (this.netNames.get(key) ?? null) : null)
      r = { clearance: v.clearance, viaDiameter: v.viaDiameter, viaDrill: v.viaDrill }
      this.cache.set(key, r)
    }
    return r
  }

  /** The clearance between copper of a net whose class asks for `own` and copper of `other`. */
  pairWith(own: number, other: string | null | undefined): number {
    return this.classed || this.floor ? Math.max(own, this.of(other).clearance, this.floor) : own
  }
}

/** True when some SMD pad has a neighbour on the same part closer than FINE_PITCH. */
function hasFinePitch(shapes: { shape: Shape }[]): boolean {
  const byPart = new Map<string, WorldPad[]>()
  for (const { shape } of shapes) {
    if (shape.kind !== "pad" || shape.layers.length !== 1) continue
    const list = byPart.get(shape.pad.componentId) ?? []
    list.push(shape.pad)
    byPart.set(shape.pad.componentId, list)
  }
  for (const pads of byPart.values()) {
    for (let i = 0; i < pads.length; i++)
      for (let j = i + 1; j < pads.length; j++) if (Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y) < FINE_PITCH) return true
  }
  return false
}

/** Two-layer grid router. Each net index owns the keepout cells around its copper. */
class Router {
  readonly g: number
  readonly nx: number
  readonly ny: number
  private ox: number
  private oy: number
  private margin: number
  /** Trace keepouts per width and class clearance, per layer. */
  private owners = new Map<string, { profile: Profile; arr: Int32Array[] }>()
  /** Via keepouts per size and class clearance. */
  private viaProfiles = new Map<string, ViaProfile>()
  /** Escape stubs, as "ax,ay,bx,by": a search starts from the end of one, not from beside it. */
  stubKeys = new Set<string>()
  /** Escape corridors in front of fine-pitch pads, per layer: owning net, FREE or CONTESTED. */
  private escape: Int32Array[]
  private stampSrc: Uint32Array[]
  private stampTgt: Uint32Array[]
  private stamp = 0
  private cost: Float32Array
  private parent: Int32Array
  private dir: Int8Array
  private seen: Uint32Array
  private closed: Uint32Array
  private search = 0
  private netIndex = new Map<string, number>()
  readonly deadline: number

  constructor(
    private project: Project,
    shapes: { shape: Shape; net: string | null }[],
    profiles: Profile[],
    timeLimitMs: number,
    /** Fine-pitch mode: a new via keeps its drill clear of every existing via's. */
    private strictVias = false,
    readonly rr: RouteRules = new RouteRules(project, new Map()),
    /** The nets whose vias will be routed, so the keepouts for each via size are made (a board with no classes has one). */
    viaNets: (string | null)[] = [null],
  ) {
    const b = project.board
    const area = b.width * b.height
    // Fine-pitch rows leave a channel of about pitch - pad - 2 x clearance in front of each
    // pad; a coarse grid often has no cell centre in it, so they force the finest grid.
    const fine = hasFinePitch(shapes)
    this.g = fine || area <= 2500 ? 0.1 : area > 6000 ? 0.2 : 0.15
    // Keepouts are exact at cell centres; a step between two free centres can only pass
    // sqrt(c^2 + g^2/2) - c closer to copper (c = clearance + half width), under 0.06 mm for
    // any c >= 0.15 at g = 0.2. Much more than half a cell seals 0.65 mm pitch pads in.
    this.margin = this.g * 0.5
    this.ox = b.x - b.width / 2
    this.oy = b.y - b.height / 2
    this.nx = Math.ceil(b.width / this.g) + 1
    this.ny = Math.ceil(b.height / this.g) + 1
    const n = this.nx * this.ny
    for (const pr of profiles) {
      const key = this.profileKey(pr.width, pr.clearance)
      if (!this.owners.has(key)) this.owners.set(key, { profile: pr, arr: [new Int32Array(n).fill(FREE), new Int32Array(n).fill(FREE)] })
    }
    for (const net of viaNets) {
      const v = rr.of(net)
      const key = this.viaKey(v)
      if (!this.viaProfiles.has(key)) {
        this.viaProfiles.set(key, { ...v, owner: [new Int32Array(n).fill(FREE), new Int32Array(n).fill(FREE)], padKeep: new Uint8Array(n), holeKeep: new Uint8Array(n) })
      }
    }
    this.escape = [new Int32Array(n).fill(FREE), new Int32Array(n).fill(FREE)]
    this.stampSrc = [new Uint32Array(n), new Uint32Array(n)]
    this.stampTgt = [new Uint32Array(n), new Uint32Array(n)]
    this.cost = new Float32Array(n * 2)
    this.parent = new Int32Array(n * 2)
    this.dir = new Int8Array(n * 2)
    this.seen = new Uint32Array(n * 2)
    this.closed = new Uint32Array(n * 2)
    this.deadline = performance.now() + timeLimitMs
    this.markEdge()
    this.markKeepouts()
    for (const s of shapes) this.addShape(s.shape, s.net)
    this.reserveEscapes(shapes)
  }

  /**
   * Keep the cells straight out from each fine-pitch SMD pad (along its long axis, away from
   * the part) costly for other nets. Without this, the first trace out of a 0.65 mm pitch row
   * bends across its neighbours' pad ends and seals them in.
   */
  private reserveEscapes(shapes: { shape: Shape; net: string | null }[]) {
    const byPart = new Map<string, { pad: WorldPad; net: number; li: number }[]>()
    for (const { shape, net } of shapes) {
      if (shape.kind !== "pad" || shape.layers.length !== 1 || !net || outerIndex(shape.layers[0]) < 0) continue
      const list = byPart.get(shape.pad.componentId) ?? []
      list.push({ pad: shape.pad, net: this.netId(net), li: outerIndex(shape.layers[0]) })
      byPart.set(shape.pad.componentId, list)
    }
    for (const pads of byPart.values()) {
      if (pads.length < 3) continue
      const cx = pads.reduce((a, p) => a + p.pad.x, 0) / pads.length
      const cy = pads.reduce((a, p) => a + p.pad.y, 0) / pads.length
      for (const { pad, net, li } of pads) {
        if (net === BLOCKED || Math.abs(pad.width - pad.height) < 0.2) continue
        const fine = pads.some((o) => o.pad !== pad && o.li === li && Math.hypot(o.pad.x - pad.x, o.pad.y - pad.y) < FINE_PITCH)
        if (!fine) continue
        const alongX = pad.width > pad.height
        const sign = alongX ? Math.sign(pad.x - cx) : Math.sign(pad.y - cy)
        if (!sign) continue
        const half = (alongX ? pad.width : pad.height) / 2
        const across = (alongX ? pad.height : pad.width) / 2
        const a0 = (alongX ? pad.x : pad.y) + sign * half
        const a1 = a0 + sign * ESCAPE_LEN
        const box: Box = alongX
          ? { minX: Math.min(a0, a1), maxX: Math.max(a0, a1), minY: pad.y - across, maxY: pad.y + across }
          : { minX: pad.x - across, maxX: pad.x + across, minY: Math.min(a0, a1), maxY: Math.max(a0, a1) }
        const x0 = Math.max(0, Math.ceil((box.minX - this.ox) / this.g))
        const x1 = Math.min(this.nx - 1, Math.floor((box.maxX - this.ox) / this.g))
        const y0 = Math.max(0, Math.ceil((box.minY - this.oy) / this.g))
        const y1 = Math.min(this.ny - 1, Math.floor((box.maxY - this.oy) / this.g))
        const arr = this.escape[li]
        for (let iy = y0; iy <= y1; iy++) {
          for (let ix = x0; ix <= x1; ix++) {
            const i = iy * this.nx + ix
            arr[i] = arr[i] === FREE || arr[i] === net ? net : CONTESTED
          }
        }
      }
    }
  }

  private profileKey = (width: number, clearance: number) => `${width}|${clearance}`
  private viaKey = (v: NetRule) => `${v.viaDiameter}|${v.viaDrill}|${v.clearance}`

  /** The keepout cells for a trace of `width` on `net`, which depend on its class's clearance. */
  private ownersFor(width: number, net: string | null) {
    return this.owners.get(this.profileKey(width, this.rr.of(net).clearance))
  }

  /** The via keepouts for a via of `net`'s class. */
  viaProfileOf(net: string | null): ViaProfile {
    return this.viaProfiles.get(this.viaKey(this.rr.of(net)))!
  }

  netId(net: string | null): number {
    if (!net || net === "short") return BLOCKED
    let i = this.netIndex.get(net)
    if (i === undefined) {
      i = this.netIndex.size
      this.netIndex.set(net, i)
    }
    return i
  }

  cx = (ix: number) => this.ox + ix * this.g
  cy = (iy: number) => this.oy + iy * this.g
  cellOf(p: Vec2): [number, number] {
    return [Math.round((p.x - this.ox) / this.g), Math.round((p.y - this.oy) / this.g)]
  }
  inGrid = (ix: number, iy: number) => ix >= 0 && iy >= 0 && ix < this.nx && iy < this.ny

  private markEdge() {
    const b = this.project.board
    // A board with an outline of its own: which cells are on it is scan-filled once, and only the edges near a cell are measured.
    const g = outlineGeometry(b)
    const onBoard = g?.rings.length ? rasterizeInside(g, this.ox, this.oy, this.nx, this.ny, this.g) : null
    // How far from a cell the nearest edge can matter: the widest trace or via (of any class) that is routed.
    let reachLimit = this.project.rules.edgeClearance + this.margin + 1e-6
    for (const { profile } of this.owners.values()) reachLimit = Math.max(reachLimit, this.project.rules.edgeClearance + profile.width / 2 + this.margin + 1e-6)
    for (const vp of this.viaProfiles.values()) reachLimit = Math.max(reachLimit, this.project.rules.edgeClearance + vp.viaDiameter / 2 + this.margin + 1e-6)
    for (let iy = 0; iy < this.ny; iy++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const at = { x: this.cx(ix), y: this.cy(iy) }
        const d = g ? (onBoard && !onBoard[iy * this.nx + ix] ? -1 : g.nearest(at, reachLimit)) : edgeDistance(b, at)
        const i = iy * this.nx + ix
        for (const { profile, arr } of this.owners.values()) {
          if (d < this.project.rules.edgeClearance + profile.width / 2 + this.margin) {
            arr[0][i] = BLOCKED
            arr[1][i] = BLOCKED
          }
        }
        for (const vp of this.viaProfiles.values()) {
          if (d < this.project.rules.edgeClearance + vp.viaDiameter / 2 + this.margin) {
            vp.owner[0][i] = BLOCKED
            vp.owner[1][i] = BLOCKED
          }
        }
      }
    }
  }

  /** Rule areas that keep tracks or vias out: a cell is blocked where the trace or via it would hold touches the area, whatever the class of the net that routes it. */
  private markKeepouts() {
    let reachLimit = 0
    for (const { profile } of this.owners.values()) reachLimit = Math.max(reachLimit, profile.width / 2)
    for (const vp of this.viaProfiles.values()) reachLimit = Math.max(reachLimit, vp.viaDiameter / 2)
    for (const z of this.project.zones) {
      if (!z.keepout || !(z.keepout.tracks || z.keepout.vias)) continue
      const area = zoneArea(z)
      if (!area) continue
      const layers = zoneLayers(z)
      const reach = reachLimit + this.margin + 1e-6
      const x0 = Math.max(0, Math.floor((area.box.minX - reach - this.ox) / this.g))
      const x1 = Math.min(this.nx - 1, Math.ceil((area.box.maxX + reach - this.ox) / this.g))
      const y0 = Math.max(0, Math.floor((area.box.minY - reach - this.oy) / this.g))
      const y1 = Math.min(this.ny - 1, Math.ceil((area.box.maxY + reach - this.oy) / this.g))
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          const d = areaDistance(area, { x: this.cx(ix), y: this.cy(iy) }, reach)
          if (!Number.isFinite(d)) continue
          const i = iy * this.nx + ix
          if (z.keepout.tracks) {
            for (const { profile, arr } of this.owners.values()) {
              if (d < profile.width / 2 + this.margin) for (const l of layers) if (outerIndex(l) >= 0) arr[outerIndex(l)][i] = BLOCKED
            }
          }
          if (z.keepout.vias) {
            for (const vp of this.viaProfiles.values()) {
              if (d < vp.viaDiameter / 2 + this.margin) {
                vp.owner[0][i] = BLOCKED
                vp.owner[1][i] = BLOCKED
              }
            }
          }
        }
      }
    }
  }

  private markArea(arr: Int32Array, box: Box, reach: number, s: Shape, net: number) {
    const x0 = Math.max(0, Math.floor((box.minX - reach - this.ox) / this.g))
    const x1 = Math.min(this.nx - 1, Math.ceil((box.maxX + reach - this.ox) / this.g))
    const y0 = Math.max(0, Math.floor((box.minY - reach - this.oy) / this.g))
    const y1 = Math.min(this.ny - 1, Math.ceil((box.maxY + reach - this.oy) / this.g))
    const p = { x: 0, y: 0 }
    for (let iy = y0; iy <= y1; iy++) {
      p.y = this.cy(iy)
      for (let ix = x0; ix <= x1; ix++) {
        p.x = this.cx(ix)
        if (shapeDistance(p, s) >= reach) continue
        const i = iy * this.nx + ix
        const v = arr[i]
        if (v === FREE) arr[i] = net
        else if (v !== net) arr[i] = BLOCKED
      }
    }
  }

  /** Mark keepouts around copper of `net`. Pads also keep vias out for every net. */
  addShape(s: Shape, netName: string | null) {
    const net = this.netId(netName)
    const box = shapeBox(s)
    // Keepouts are the larger of the routing net's class clearance and this copper's (its net's class; no net is Default).
    // A pad with a clearance of its own (X7, KiCad's local clearance) keeps that when it is the larger, as KiCad max's it with the classes' (drc_engine.cpp 9.0 :1451-1540, 10.0 :1982-2063).
    const own = s.kind === "pad" && s.pad.clearance ? s.pad.clearance : 0
    for (const layer of s.layers) {
      const at = outerIndex(layer)
      // Copper on an inner layer keeps vias away (a via has copper there too) and keeps no track, which never goes there.
      if (at >= 0) for (const { profile, arr } of this.owners.values()) this.markArea(arr[at], box, Math.max(own, this.rr.pairWith(profile.clearance, netName)) + profile.width / 2 + this.margin, s, net)
      for (const vp of this.viaProfiles.values()) {
        const reach = Math.max(own, this.rr.pairWith(vp.clearance, netName)) + vp.viaDiameter / 2 + this.margin
        for (const li of at >= 0 ? [at] : [0, 1]) this.markArea(vp.owner[li], box, reach, s, s.kind === "pad" ? BLOCKED : net)
      }
    }
    if (s.kind === "via" && this.strictVias) {
      // A new via's drill keeps the hole clearance from this one's, even on the same net.
      const theirs = this.rr.classed ? (s.drill ?? this.rr.of(netName).viaDrill) : undefined
      for (const vp of this.viaProfiles.values()) {
        const reach = (theirs === undefined ? vp.viaDrill : (vp.viaDrill + theirs) / 2) + this.project.rules.holeClearance + 1e-6
        const x0 = Math.max(0, Math.floor((s.at.x - reach - this.ox) / this.g))
        const x1 = Math.min(this.nx - 1, Math.ceil((s.at.x + reach - this.ox) / this.g))
        const y0 = Math.max(0, Math.floor((s.at.y - reach - this.oy) / this.g))
        const y1 = Math.min(this.ny - 1, Math.ceil((s.at.y + reach - this.oy) / this.g))
        for (let iy = y0; iy <= y1; iy++) {
          for (let ix = x0; ix <= x1; ix++) if (Math.hypot(this.cx(ix) - s.at.x, this.cy(iy) - s.at.y) < reach) vp.holeKeep[iy * this.nx + ix] = 1
        }
      }
    }
    if (s.kind === "pad") {
      // Vias never go in or right next to pads, even on the same net.
      for (const vp of this.viaProfiles.values()) {
        const reach = vp.viaDiameter / 2 + 0.1
        const x0 = Math.max(0, Math.floor((box.minX - reach - this.ox) / this.g))
        const x1 = Math.min(this.nx - 1, Math.ceil((box.maxX + reach - this.ox) / this.g))
        const y0 = Math.max(0, Math.floor((box.minY - reach - this.oy) / this.g))
        const y1 = Math.min(this.ny - 1, Math.ceil((box.maxY + reach - this.oy) / this.g))
        for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) vp.padKeep[iy * this.nx + ix] = 1
      }
    }
  }

  /** True when a trace of `width` may be centred on the cell, as far as other nets' copper goes. */
  cellFree(li: number, ix: number, iy: number, netName: string, width: number): boolean {
    const arr = this.ownersFor(width, netName)?.arr
    if (!arr || !this.inGrid(ix, iy)) return false
    const v = arr[li][iy * this.nx + ix]
    return v === FREE || v === this.netId(netName)
  }

  viaAllowed(i: number, net: number, vp: ViaProfile): boolean {
    if (vp.padKeep[i] || vp.holeKeep[i]) return false
    const a = vp.owner[0][i]
    const b = vp.owner[1][i]
    return (a === FREE || a === net) && (b === FREE || b === net)
  }

  /** Stamp the cells covered by own-net copper so the search may start or end there. */
  private stampShapes(
    target: Uint32Array[],
    shapes: Shape[],
    width: number,
    net: number,
    owner: Int32Array[],
    seeds?: number[],
  ): Box {
    const n = this.nx * this.ny
    const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const p = { x: 0, y: 0 }
    for (const s of shapes) {
      const sb = shapeBox(s)
      const x0 = Math.max(0, Math.floor((sb.minX - this.ox) / this.g))
      const x1 = Math.min(this.nx - 1, Math.ceil((sb.maxX - this.ox) / this.g))
      const y0 = Math.max(0, Math.floor((sb.minY - this.oy) / this.g))
      const y1 = Math.min(this.ny - 1, Math.ceil((sb.maxY - this.oy) / this.g))
      for (let iy = y0; iy <= y1; iy++) {
        p.y = this.cy(iy)
        for (let ix = x0; ix <= x1; ix++) {
          p.x = this.cx(ix)
          const i = iy * this.nx + ix
          let ok: boolean
          if (s.kind === "pad") ok = pointPadDistance(p, s.pad) === 0 && padInset(p, s.pad) >= width / 2 - 1e-6
          else if (s.kind === "segment" && this.stubKeys.has(`${s.a.x},${s.a.y},${s.b.x},${s.b.y}`)) ok = Math.hypot(p.x - s.b.x, p.y - s.b.y) <= this.g * 0.5
          else if (s.kind === "segment") ok = pointSegmentDistance(p, s.a, s.b) <= Math.max(this.g * 0.5, (s.width - width) / 2)
          else if (s.kind === "drawing") ok = false
          else ok = Math.hypot(p.x - s.at.x, p.y - s.at.y) <= s.diameter / 2 - width / 2 + 1e-6
          if (!ok) continue
          for (const layer of s.layers) {
            const li = outerIndex(layer)
            if (li < 0) continue
            const v = owner[li][i]
            // Inside a pad by half a trace width the new copper is covered by the pad itself.
            if (s.kind !== "pad" && v !== FREE && v !== net) continue
            if (target[li][i] !== this.stamp) seeds?.push(li * n + i)
            target[li][i] = this.stamp
          }
          box.minX = Math.min(box.minX, ix)
          box.maxX = Math.max(box.maxX, ix)
          box.minY = Math.min(box.minY, iy)
          box.maxY = Math.max(box.maxY, iy)
        }
      }
    }
    return box
  }

  /**
   * A* from the source copper to the target copper on two layers. When `toPour` is set, the
   * goal is instead any cell on the pour's layer index where a via fits inside the fill.
   */
  route(
    netName: string,
    source: Shape[],
    target: Shape[] | null,
    width: number,
    toPour?: { layer: number; inFill: (p: Vec2) => boolean },
  ): RoutedPath | null {
    if (performance.now() > this.deadline) return null
    const net = this.netId(netName)
    const owner = this.ownersFor(width, netName)!.arr
    const vp = this.viaProfileOf(netName)
    const nx = this.nx
    const n = nx * this.ny
    this.stamp++
    const srcStamp = this.stamp
    const seeds: number[] = []
    this.stampShapes(this.stampSrc, source, width, net, owner, seeds)
    let tb: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    let tgtStamp = 0
    if (target) {
      this.stamp++
      tgtStamp = this.stamp
      tb = this.stampShapes(this.stampTgt, target, width, net, owner)
      if (!Number.isFinite(tb.minX)) return null
    }
    const fillMemo = new Map<number, boolean>()
    const isGoal = (node: number) => {
      const li = node >= n ? 1 : 0
      const i = node - li * n
      if (target) return this.stampTgt[li][i] === tgtStamp
      if (!toPour || li !== toPour.layer || !this.viaAllowed(i, net, vp)) return false
      let hit = fillMemo.get(i)
      if (hit === undefined) {
        hit = toPour.inFill({ x: this.cx(i % nx), y: this.cy(Math.floor(i / nx)) })
        fillMemo.set(i, hit)
      }
      return hit
    }
    const h = (i: number) => {
      if (!target) return 0
      const ix = i % nx
      const iy = (i - ix) / nx
      const dx = Math.max(tb.minX - ix, 0, ix - tb.maxX)
      const dy = Math.max(tb.minY - iy, 0, iy - tb.maxY)
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
    }
    const passable = (li: number, i: number) => {
      const v = owner[li][i]
      return v === FREE || v === net || this.stampSrc[li][i] === srcStamp || (target !== null && this.stampTgt[li][i] === tgtStamp)
    }

    this.search++
    const s = this.search
    const heap = new MinHeap()
    for (const node of seeds) {
      this.seen[node] = s
      this.cost[node] = 0
      this.parent[node] = -1
      this.dir[node] = -1
      heap.push(node, h(node % n))
    }
    let goal = -1
    let expansions = 0
    while (heap.size) {
      const node = heap.pop()
      if (this.closed[node] === s) continue
      this.closed[node] = s
      if (isGoal(node) && this.parent[node] !== -1) {
        goal = node
        break
      }
      if (++expansions > (this.strictVias ? FINE_MAX_EXPANSIONS : MAX_EXPANSIONS)) break
      if ((expansions & 4095) === 0 && performance.now() > this.deadline) break
      const li = node >= n ? 1 : 0
      const i = node - li * n
      const ix = i % nx
      const iy = (i - ix) / nx
      const base = this.cost[node]
      const d0 = this.dir[node]
      for (let d = 0; d < 8; d++) {
        const jx = ix + DIRS[d][0]
        const jy = iy + DIRS[d][1]
        if (!this.inGrid(jx, jy)) continue
        const j = jy * nx + jx
        if (!passable(li, j)) continue
        // Diagonal moves must not squeeze between two blocked orthogonal cells.
        if (d % 2 === 1 && !passable(li, iy * nx + jx) && !passable(li, jy * nx + ix)) continue
        let turn = 0
        if (d0 >= 0) {
          const diff = Math.abs(d - d0)
          turn = TURN_COST[Math.min(diff, 8 - diff)]
        }
        const esc = this.escape[li][j]
        const step = (d % 2 === 1 ? Math.SQRT2 : 1) + turn + (esc >= 0 && esc !== net ? ESCAPE_COST : 0)
        const next = li * n + j
        const c = base + step
        if (this.seen[next] === s && c >= this.cost[next]) continue
        this.seen[next] = s
        this.cost[next] = c
        this.parent[next] = node
        this.dir[next] = d
        heap.push(next, c + h(j))
      }
      // Layer change through a via.
      if (this.viaAllowed(i, net, vp)) {
        const other = (1 - li) * n + i
        if (passable(1 - li, i)) {
          const c = base + VIA_COST
          if (!(this.seen[other] === s && c >= this.cost[other])) {
            this.seen[other] = s
            this.cost[other] = c
            this.parent[other] = node
            this.dir[other] = -1
            heap.push(other, c + h(i))
          }
        }
      }
      if (toPour && this.viaAllowed(i, net, vp) && isGoal((1 - li) * n + i)) {
        const other = (1 - li) * n + i
        this.seen[other] = s
        this.cost[other] = base + VIA_COST
        this.parent[other] = node
        this.dir[other] = -1
        goal = other
        break
      }
    }
    if (goal < 0) return null

    // Walk back into cells, then split into per-layer runs at vias.
    const nodes: number[] = []
    for (let cur = goal; cur !== -1; cur = this.parent[cur]) nodes.push(cur)
    nodes.reverse()
    const runs: { layer: number; pts: Vec2[] }[] = []
    const vias: Vec2[] = []
    for (const node of nodes) {
      const li = node >= n ? 1 : 0
      const i = node - li * n
      const p = { x: round(this.cx(i % nx), 4), y: round(this.cy(Math.floor(i / nx)), 4) }
      const last = runs[runs.length - 1]
      if (!last || last.layer !== li) {
        if (last) vias.push(p)
        runs.push({ layer: li, pts: [p] })
      } else last.pts.push(p)
    }
    // Pour fanouts end in a via on the far layer; drop that empty run.
    if (toPour && runs.length > 1 && runs[runs.length - 1].pts.length === 1) runs.pop()

    // Tie the ends to the copper they started from and landed on.
    const snapEnd = (p: Vec2, shapes: Shape[], layer: CopperLayer): Vec2 => {
      for (const sh of shapes) {
        if (!sh.layers.includes(layer)) continue
        if (sh.kind === "pad" && pointPadDistance(p, sh.pad) === 0) {
          // A trace wider than its pad would run from the pad's centre, and the keepouts around the other nets' copper were made for cell centres, not for that point:
          // with classes, where the cell at the centre is in another net's keepout, the trace starts where the search did, still inside the pad.
          if (this.rr.classed) {
            const [cx, cy] = this.cellOf({ x: sh.pad.x, y: sh.pad.y })
            const v = this.inGrid(cx, cy) ? owner[layer === "top" ? 0 : 1][cy * nx + cx] : FREE
            if (v !== FREE && v !== net) return p
          }
          return { x: sh.pad.x, y: sh.pad.y }
        }
        if (sh.kind === "via" && Math.hypot(p.x - sh.at.x, p.y - sh.at.y) <= sh.diameter / 2) return sh.at
        if (sh.kind === "segment" && pointSegmentDistance(p, sh.a, sh.b) <= sh.width / 2) {
          const q = closestPointOnSegment(p, sh.a, sh.b)
          return { x: round(q.x, 4), y: round(q.y, 4) }
        }
      }
      return p
    }
    const first = runs[0]
    const lastRun = runs[runs.length - 1]
    first.pts.unshift(snapEnd(first.pts[0], source, LAYERS[first.layer]))
    if (target) lastRun.pts.push(snapEnd(lastRun.pts[lastRun.pts.length - 1], target, LAYERS[lastRun.layer]))

    const traces: Omit<Trace, "id">[] = []
    for (const run of runs) {
      const pts = simplifyPolyline(run.pts.filter((p, k) => k === 0 || !samePoint(p, run.pts[k - 1])))
      if (pts.length >= 2) traces.push({ layer: LAYERS[run.layer], width, points: pts })
    }
    const result = { traces, vias, net: netName }
    this.commit(netName, result)
    return result
  }

  commit(netName: string, path: RoutedPath) {
    for (const t of path.traces) {
      for (let k = 0; k < t.points.length - 1; k++) {
        this.addShape({ kind: "segment", a: t.points[k], b: t.points[k + 1], width: t.width, layers: [t.layer] }, netName)
      }
    }
    const via = this.rr.of(netName)
    for (const v of path.vias) this.addShape({ kind: "via", at: v, diameter: via.viaDiameter, drill: via.viaDrill, layers: [...copperLayers(this.project.board)] }, netName)
  }
}

type PadItem = Extract<CopperItem, { kind: "pad" }>

/** A fine-pitch SMD pad: another pad of its part on the same layer is closer than FINE_PITCH. */
function isFinePad(it: PadItem, pads: PadItem[]): boolean {
  if (it.layers.length !== 1 || it.pad.holeDiameter) return false
  return pads.some(
    (o) => o !== it && o.pad.componentId === it.pad.componentId && o.layers.length === 1 && o.layers[0] === it.layers[0] && Math.hypot(o.pad.x - it.pad.x, o.pad.y - it.pad.y) < FINE_PITCH,
  )
}

/** Widths to try below the default, widest first: the default, halfway to the board's minimum, and the minimum. */
function widthLadder(project: Project): number[] {
  const { traceWidth, minTraceWidth } = project.rules
  const mid = round((traceWidth + minTraceWidth) / 2, 3)
  return [...new Set([traceWidth, mid, minTraceWidth].filter((w) => w >= minTraceWidth - 1e-9 && w <= traceWidth + 1e-9))].sort((a, b) => b - a)
}

/**
 * A short straight stub from a fine-pitch pad's centre, away from its part, to a cell centre of
 * the router's grid. A pad that sits a fraction of a cell off the grid has no cell centre of its
 * own in the channel in front of it, so the grid search cannot leave it; the stub's exact
 * geometry can. Its width comes from `ladder` (widest first, or narrowest first with `narrow`),
 * never above `cap`: the widest the clearance to everything beside it allows. Null when no stub fits.
 */
function escapeStub(
  router: Router,
  obstacles: { shape: Shape; net: string | null }[],
  pad: PadItem,
  mates: PadItem[],
  netId: string,
  cap: number,
  ladder: number[],
  narrow: boolean,
  inward: boolean,
  /** The clearance to copper of another net: the larger of the stub's class and that net's. */
  clearanceTo: (other: string | null) => number,
): Omit<Trace, "id"> | null {
  const p = pad.pad
  const layer = pad.layers[0]
  const li = outerIndex(layer) < 0 ? 0 : outerIndex(layer)
  const cx = mates.reduce((a, o) => a + o.pad.x, 0) / mates.length
  const cy = mates.reduce((a, o) => a + o.pad.y, 0) / mates.length
  const alongX = Math.abs(p.width - p.height) >= 0.1 ? p.width > p.height : Math.abs(p.x - cx) > Math.abs(p.y - cy)
  const out = Math.sign(alongX ? p.x - cx : p.y - cy)
  if (!out) return null
  const g = router.g
  const origin = alongX ? router.cx(0) : router.cy(0)
  const [cellX, cellY] = router.cellOf(p)
  const widths = ladder.filter((w) => w <= cap + 1e-9)
  if (narrow) widths.reverse()
  const clears = (a: Vec2, b: Vec2, w: number): boolean => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02))
    for (const o of obstacles) {
      if (o.net === netId || !o.shape.layers.includes(layer)) continue
      const clearance = clearanceTo(o.net)
      const reach = clearance + w / 2
      const bx = shapeBox(o.shape)
      if (bx.maxX < Math.min(a.x, b.x) - reach || bx.minX > Math.max(a.x, b.x) + reach || bx.maxY < Math.min(a.y, b.y) - reach || bx.minY > Math.max(a.y, b.y) + reach) continue
      for (let k = 0; k <= steps; k++) {
        const q = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps }
        if (shapeDistance(q, o.shape) - w / 2 < clearance + 0.002) return false
      }
    }
    return true
  }
  // Away from the part first, or, staggered, back over it first: alternate pads of a row going
  // opposite ways leave twice the room each, and a part's body has no copper under it to hit.
  for (const dir of inward ? [-out, out] : [out, -out]) {
    const edge = (alongX ? p.x : p.y) + (dir * (alongX ? p.width : p.height)) / 2
    const first = Math.round((edge - origin) / g)
    for (const w of widths) {
      for (let k = 0; k <= Math.ceil(ESCAPE_STUB_MAX / g) + 2; k++) {
        const j = first + dir * k
        const reach = (origin + j * g - edge) * dir
        if (reach < ESCAPE_STUB_MIN) continue
        if (reach > ESCAPE_STUB_MAX) break
        const ix = alongX ? j : cellX
        const iy = alongX ? cellY : j
        if (!router.cellFree(li, ix, iy, netId, w)) continue
        const end = { x: round(router.cx(ix), 4), y: round(router.cy(iy), 4) }
        if (clears({ x: p.x, y: p.y }, end, w)) return { layer, width: w, points: [{ x: p.x, y: p.y }, end] }
      }
    }
  }
  return null
}

interface NetIslands {
  /** Root island id -> shapes */
  shapes: Map<number, Shape[]>
}

function islandsByNet(analysis: PcbAnalysis): Map<string, NetIslands> {
  const out = new Map<string, NetIslands>()
  for (const it of analysis.items) {
    const root = analysis.island.get(it.id)
    if (root === undefined || it.kind === "shape") continue
    const net = analysis.islandNet.get(root)
    if (!net || net === "short") continue
    const shape = shapeOf(it)
    if (!shape) continue
    const entry = out.get(net) ?? { shapes: new Map() }
    const list = entry.shapes.get(root) ?? []
    list.push(shape)
    entry.shapes.set(root, list)
    out.set(net, entry)
  }
  return out
}

function islandAt(entry: NetIslands, p: Vec2): number | null {
  for (const [root, shapes] of entry.shapes) {
    for (const s of shapes) {
      if (s.kind === "pad" && samePoint(p, s.pad)) return root
      if (s.kind === "via" && samePoint(p, s.at)) return root
      if (s.kind === "segment" && (samePoint(p, s.a) || samePoint(p, s.b))) return root
    }
  }
  return null
}

function isPowerNet(sch: SchematicConnectivity, project: Project, netId: string): boolean {
  const net = sch.nets.find((n) => n.id === netId)
  if (!net) return false
  if (POWER_NAME.test(net.name)) return true
  return net.pins.some((p) => {
    const c = project.components.find((x) => x.id === p.componentId)
    return !!c && !!findPart(c.partId)?.powerNet
  })
}

function obstacleShapes(analysis: PcbAnalysis, drills?: Map<string, number>): { shape: Shape; net: string | null }[] {
  const out: { shape: Shape; net: string | null }[] = []
  for (const it of analysis.items) {
    const shape = shapeOf(it, drills)
    if (!shape) continue
    const root = analysis.island.get(it.id)
    const islandNet = root === undefined ? null : (analysis.islandNet.get(root) ?? null)
    const net = it.kind === "pad" ? it.netId : islandNet
    out.push({ shape, net })
  }
  return out
}

function apply(project: Project, paths: RoutedPath[], rr: RouteRules): Project {
  if (!paths.length) return project
  const traces: Trace[] = []
  const vias: Via[] = []
  for (const p of paths) {
    for (const t of p.traces) traces.push({ ...t, id: uid("t") })
    // a via is the size of its net's class (the rules' for a board with no classes)
    const size = rr.of(p.net)
    for (const v of p.vias) {
      vias.push({ id: uid("v"), x: v.x, y: v.y, diameter: size.viaDiameter, drill: size.viaDrill })
    }
  }
  return { ...project, updatedAt: Date.now(), traces: [...project.traces, ...traces], vias: [...project.vias, ...vias] }
}

/** Time for one route, in total: the normal pass and the fine-pitch pass share it. */
const DEFAULT_BUDGET_MS = 10_000

interface FineReport {
  /** Nets with a pad at the end of an open connection that no grid cell can start from. */
  stuck: Set<string>
  /** False when no such pad could take a trace at the board's rules, so no stub would help. */
  feasible: boolean
}

/** Whether a trace of `width` could start from some cell centre of a 0.1 mm grid inside the pad. */
function padHasSeed(pad: WorldPad, width: number, ox: number, oy: number): boolean {
  const g = 0.1
  const box = padBox(pad)
  const x0 = Math.ceil((box.minX - ox) / g)
  const x1 = Math.floor((box.maxX - ox) / g)
  const y0 = Math.ceil((box.minY - oy) / g)
  const y1 = Math.floor((box.maxY - oy) / g)
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const q = { x: ox + ix * g, y: oy + iy * g }
      if (pointPadDistance(q, pad) === 0 && padInset(q, pad) >= width / 2 - 1e-6) return true
    }
  }
  return false
}

/**
 * What the fine-pitch pads at the ends of open connections look like before anything is routed;
 * null when the board has no fine-pitch pads or none of them is at an open connection. A pad is
 * `stuck` when the grid has no cell to leave it from, which no amount of retrying changes. It is
 * hopeless (`feasible` false) when a minimum-width trace straight out of every such pad would
 * still be closer than the clearance to the next pad.
 */
function fineReport(project: Project, sch: SchematicConnectivity): { report: FineReport | null; analysis?: PcbAnalysis } {
  const physical = project.components.filter((c) => c.pcb.placed).flatMap((c) => pcbPads(c))
  if (!hasFinePitch(physical.map((pad) => ({ shape: { kind: "pad", pad, layers: pad.layers } as Shape })))) return { report: null }
  const analysis = analyzePcb(project, sch)
  const pads = analysis.items.filter((it): it is PadItem => it.kind === "pad")
  const b = project.board
  const ox = b.x - b.width / 2
  const oy = b.y - b.height / 2
  const { clearance, traceWidth, minTraceWidth } = project.rules
  const rr = new RouteRules(project, new Map(sch.nets.map((n) => [n.id, n.name])))
  const stuck = new Set<string>()
  let any = false
  let feasible = false
  for (const r of analysis.ratsnest) {
    for (const at of [r.a, r.b]) {
      const it = pads.find((x) => x.netId === r.netId && samePoint(at, x.pad))
      if (!it || !isFinePad(it, pads)) continue
      any = true
      // The gap to the nearest pad of another net on its part and layer, and what a minimum-width trace leaves of it.
      let gap = Infinity
      // with net classes, how far the tightest neighbour is past the clearance it asks for
      let slack = Infinity
      for (const o of pads) {
        if (o === it || o.netId === it.netId || o.pad.componentId !== it.pad.componentId || o.layers[0] !== it.layers[0]) continue
        const dx = Math.max(Math.abs(o.pad.x - it.pad.x) - (o.pad.width + it.pad.width) / 2, 0)
        const dy = Math.max(Math.abs(o.pad.y - it.pad.y) - (o.pad.height + it.pad.height) / 2, 0)
        gap = Math.min(gap, Math.hypot(dx, dy))
        if (rr.classed) slack = Math.min(slack, Math.hypot(dx, dy) - rr.pairWith(rr.of(it.netId).clearance, o.netId))
      }
      const room = (Math.min(it.pad.width, it.pad.height) - minTraceWidth) / 2
      if (rr.classed ? slack + room >= -1e-6 : gap + room >= clearance - 1e-6) feasible = true
      if (!padHasSeed(it.pad, traceWidth, ox, oy)) stuck.add(r.netId)
    }
  }
  return { report: any ? { stuck, feasible } : null, analysis }
}

interface AttemptMode {
  /** Fine-pitch mode: escape stubs, fine-pitch nets first, trace widths down to the board's minimum. */
  fine: boolean
  /** Stubs as narrow as allowed rather than as wide. */
  narrow: boolean
  /** Alternate pads of a row leave in opposite directions. */
  stagger: boolean
  /** The nets whose fine-pitch pads get stubs: the ones that stayed open without. */
  nets: Set<string>
}

/**
 * Route open ratsnest connections. Signal nets go first, shortest connections first; pads of
 * nets with a pour then drop a via into the pour when they are not already in it; whatever is
 * still open is routed last. Existing copper is kept and avoided. Connections left open at
 * fine-pitch pads get another go in fine-pitch mode (see `attempt`).
 */
export function autoroute(project: Project, opts: AutorouteOptions = {}): AutorouteResult {
  const sch = computeConnectivity(project)
  const deadline = performance.now() + (opts.timeLimitMs ?? DEFAULT_BUDGET_MS)
  // Open connections at fine-pitch pads: a grid router can't leave a pad that is off its grid by a
  // fraction of a cell, and wide copper joining a connector's outer pads can seal in the rest. Fine-
  // pitch mode adds escape stubs, routes those nets first and uses thinner traces, which retrying as
  // before cannot do (it would give the same answer). Not when asked for some nets only: a caller
  // routing in stages expects the rest to wait. All of it is inside the one budget.
  const { report, analysis: firstAnalysis } = opts.nets ? { report: null, analysis: undefined } : fineReport(project, sch)
  const fineModes = (nets: Set<string>): AttemptMode[] =>
    [[true, false], [true, true], [false, false], [false, true]].map(([stagger, narrow]) => ({ fine: true, narrow, stagger, nets }))
  type Attempt = ReturnType<typeof attempt>
  const tried: Attempt[] = []
  const best = () => tried.reduce((a, b) => (b.result.remaining < a.result.remaining ? b : a))
  /** Run one attempt; true once something routed completely. */
  const run = (priority: Set<string>, mode?: AttemptMode) => {
    tried.push(attempt(project, sch, opts, priority, deadline, mode, firstAnalysis))
    return tried[tried.length - 1].result.remaining === 0
  }
  const fineFrom = (nets: Set<string>) => {
    for (const mode of fineModes(nets)) {
      if (performance.now() > deadline) return
      if (run(new Set(), mode)) return
    }
  }
  // A pad with no grid cell to leave from can't be routed the normal way, so there is no point in
  // spending the budget on a normal pass first: fine-pitch mode goes first.
  if (report?.feasible && report.stuck.size) {
    fineFrom(report.stuck)
    if (best().result.remaining && performance.now() < deadline) run(new Set())
  } else {
    run(new Set())
    if (best().result.remaining && best().fineOpen && report?.feasible) fineFrom(new Set(best().failed))
  }
  // Rip up and retry: nets that failed get routed first next time, while there is time.
  const priority = new Set<string>()
  for (let k = 0; k < 4 && best().failed.length && performance.now() < deadline; k++) {
    const before = priority.size
    for (const net of best().failed) priority.add(net)
    if (priority.size === before && k > 0) break
    run(priority, best().mode)
  }
  return { ...best().result, finePitchTried: tried.some((t) => t.mode.fine) ? widthLadder(project).at(-1)! : null }
}

function attempt(
  project: Project,
  sch: SchematicConnectivity,
  opts: AutorouteOptions,
  priority: Set<string>,
  deadline: number,
  mode: AttemptMode = { fine: false, narrow: false, stagger: false, nets: new Set() },
  /** The analysis of `project`, when the caller has it already. */
  first?: PcbAnalysis,
): { result: AutorouteResult; failed: string[]; fineOpen: number; mode: AttemptMode } {
  const signalW = project.rules.traceWidth
  const powerW = Math.max(signalW, opts.powerWidth ?? 0.4)
  const netWidths = project.rules.netWidths ?? {}
  // Net classes: each net's clearance, via size and, where its class names one, its trace width (`netClasses.ts`). With none this is the rules' own.
  const rr = new RouteRules(project, new Map(sch.nets.map((n) => [n.id, n.name])))
  const classes = classIndex(project.rules)
  const classWidth = (name: string | undefined): number | undefined => (rr.classed && name !== undefined ? classes.classOf(name)?.traceWidth : undefined)
  // In fine-pitch mode, narrower widths down to the board's minimum are tried last.
  const ladder = mode.fine ? widthLadder(project) : []
  const widths = [...new Set([signalW, powerW, ...Object.values(netWidths), ...(rr.classed ? (project.rules.netClasses ?? []).flatMap((c) => (c.traceWidth !== undefined ? [c.traceWidth] : [])) : []), ...ladder])]
  // Widths to try for a net, widest first: its own width, the power width, then the default.
  // A connection that can't be made wide, e.g. into a small pad, falls back to the next. The
  // fine-pitch mode adds widths down to the board's minimum, but only for a signal net with no width of
  // its own: supply nets and nets the user gave a width keep it away from the pads.
  const widthsFor = (netId: string) => {
    const name = sch.nets.find((n) => n.id === netId)?.name
    // a width given to the net by name wins over its class's, which is what a net with neither gets from the rules
    const own = name !== undefined ? (netWidths[name] ?? classWidth(name)) : undefined
    const out = own !== undefined ? [own] : []
    if (isPowerNet(sch, p, netId) && (own === undefined || own > powerW)) out.push(powerW)
    if (!out.includes(signalW) && (own === undefined || own > signalW)) out.push(signalW)
    if (ladder.length && own === undefined && !isPowerNet(sch, p, netId)) out.push(...ladder.filter((w) => w < Math.min(...out) - 1e-9))
    return out
  }
  const wanted = opts.nets ? new Set(opts.nets) : null
  const pourNets = new Set(
    project.zones.map((z) => sch.nets.find((n) => n.name === z.net)?.id).filter((x): x is string => !!x),
  )
  let p = project
  let routed = 0
  let addedTraces = 0
  let addedVias = 0
  const fineNets = new Set<string>()
  const stubIds = new Set<string>()
  const late = () => performance.now() > deadline
  // The analysis of the board as it is now: copper only changes when `p` does, so steps that added nothing share it.
  // The copper of a polygon zone (X3) takes seconds to fill on a big board, so the steps in between share the fill the board had when this
  // attempt began with the copper this run adds cut out of it (`exact` false), and the analyses the result is judged by (`exact`) fill it again,
  // from what the zones kept.
  const zoned = needsZoneEngine(project)
  let start: { fills: ZoneFill[]; known: Set<string> } | null = zoned && first ? { fills: first.zoneFills, known: new Set(first.items.map((it) => it.id)) } : null
  let memo: { p: Project; a: PcbAnalysis; exact: boolean } | null = first ? { p: project, a: first, exact: true } : null
  const analyze = (exact = false) => {
    if (memo?.p === p && (memo.exact || !exact)) return memo.a
    if (zoned && !exact) {
      if (!start) {
        const a = analyzePcb(project, sch)
        start = { fills: a.zoneFills, known: new Set(a.items.map((it) => it.id)) }
      }
      memo = { p, a: analyzePcb(p, sch, { carve: start }), exact: false }
    } else memo = { p, a: analyzePcb(p, sch), exact: true }
    return memo.a
  }
  /** A router over the board as `analysis` has it, told which traces are escape stubs. */
  const addedBoxes: Box[] = []
  const failedAt = new Map<string, number>()
  /** Remember where copper went down, for the failed connections' sake. */
  const noteAdded = (paths: RoutedPath[]) => {
    for (const path of paths) {
      for (const t of path.traces) for (const q of t.points) addedBoxes.push({ minX: q.x - 0.5, maxX: q.x + 0.5, minY: q.y - 0.5, maxY: q.y + 0.5 })
      for (const v of path.vias) addedBoxes.push({ minX: v.x - 0.5, maxX: v.x + 0.5, minY: v.y - 0.5, maxY: v.y + 0.5 })
    }
  }
  const stubKey = (t: Omit<Trace, "id">) => `${t.points[0].x},${t.points[0].y},${t.points[1].x},${t.points[1].y}`
  // Fine-pitch mode keeps one router from step to step: every copper this run adds is committed to it
  // as it is routed, so it already holds the board as the next step finds it and need not be built again.
  let live: { router: Router; p: Project } | null = null
  /** The keepout profiles a router needs for these nets: each width a net may take with its class's clearance (a board with no classes: each width with the rules'), and the via sizes. */
  const useFor = (nets: Iterable<string>, ws: number[]): { profiles: Profile[]; viaNets: (string | null)[] } => {
    if (!rr.classed) return { profiles: ws.map((width) => ({ width, clearance: rr.of(null).clearance })), viaNets: [null] }
    const list = [...nets]
    const profiles = new Map<string, Profile>()
    for (const n of list) for (const width of widthsFor(n)) profiles.set(`${width}|${rr.of(n).clearance}`, { width, clearance: rr.of(n).clearance })
    // pads and drawings with no net keep the Default class's clearance from every trace, whatever its own
    return { profiles: [...profiles.values()], viaNets: list }
  }
  const everyNet = () => sch.nets.map((n) => n.id)
  const routerFor = (analysis: PcbAnalysis, obstacles = obstacleShapes(analysis, rr.classed && mode.fine ? new Map(p.vias.map((v) => [v.id, v.drill])) : undefined), use?: { profiles: Profile[]; viaNets: (string | null)[] }) => {
    if (mode.fine && live?.p === p) return live.router
    const chosen = mode.fine || !use ? useFor(everyNet(), widths) : use
    const router = new Router(p, obstacles, chosen.profiles, deadline - performance.now(), mode.fine, rr, chosen.viaNets)
    for (const t of p.traces) if (stubIds.has(t.id)) router.stubKeys.add(stubKey(t))
    live = mode.fine ? { router, p } : null
    return router
  }
  /** The copper of the live router has been applied to the project. */
  const synced = () => {
    if (live) live.p = p
  }

  const pass = (select: (netId: string) => boolean) => {
    if (late()) return 0
    const analysis = analyze()
    let router: Router | undefined
    const getRouter = () => (router ??= routerFor(analysis, undefined, useFor(lines.map((l) => l.netId), needed)))
    const islands = islandsByNet(analysis)
    // Union-find over islands so later lines see copper added for earlier ones.
    const parent = new Map<number, number>()
    const find = (x: number): number => {
      let r = x
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
      return r
    }
    const lines = analysis.ratsnest
      .filter((r) => select(r.netId) && (!wanted || wanted.has(r.netId)))
      .map((r) => ({
        ...r,
        len: Math.hypot(r.a.x - r.b.x, r.a.y - r.b.y),
        widths: widthsFor(r.netId),
        first: priority.has(r.netId) || fineNets.has(r.netId),
      }))
      .sort((x, y) => Number(y.first) - Number(x.first) || x.len - y.len)
    const needed = [...new Set(lines.flatMap((l) => l.widths))]
    const paths: RoutedPath[] = []
    for (const line of lines) {
      if (late()) break
      const entry = islands.get(line.netId)
      if (!entry) continue
      const ra = islandAt(entry, line.a)
      const rb = islandAt(entry, line.b)
      if (ra === null || rb === null) continue
      const ca = find(ra)
      const cb = find(rb)
      if (ca === cb) continue
      const src = entry.shapes.get(ca) ?? []
      const tgt = entry.shapes.get(cb) ?? []
      // Fine-pitch mode does not search again for a connection that failed unless copper has gone
      // down near it since: a failed search floods the whole free area, and that is where the time goes.
      const key = `${line.netId}|${line.a.x},${line.a.y}|${line.b.x},${line.b.y}`
      if (mode.fine) {
        const at = failedAt.get(key)
        const zone: Box = { minX: Math.min(line.a.x, line.b.x) - 3, maxX: Math.max(line.a.x, line.b.x) + 3, minY: Math.min(line.a.y, line.b.y) - 3, maxY: Math.max(line.a.y, line.b.y) + 3 }
        if (at !== undefined && !addedBoxes.slice(at).some((b) => boxesOverlap(b, zone))) continue
      }
      let path: RoutedPath | null = null
      for (const w of line.widths) if ((path = getRouter().route(line.netId, src, tgt, w))) break
      if (!path) {
        failedAt.set(key, addedBoxes.length)
        continue
      }
      paths.push(path)
      routed++
      parent.set(ca, cb)
      const merged = [...tgt, ...src]
      for (const t of path.traces) {
        for (let k = 0; k < t.points.length - 1; k++) {
          merged.push({ kind: "segment", a: t.points[k], b: t.points[k + 1], width: t.width, layers: [t.layer] })
        }
      }
      const via = rr.of(line.netId)
      for (const v of path.vias) merged.push({ kind: "via", at: v, diameter: via.viaDiameter, drill: via.viaDrill, layers: [...copperLayers(p.board)] })
      entry.shapes.set(cb, merged)
      entry.shapes.delete(ca)
    }
    p = apply(p, paths, rr)
    noteAdded(paths)
    synced()
    for (const path of paths) {
      addedTraces += path.traces.length
      addedVias += path.vias.length
    }
    return paths.length
  }

  /** Pads of poured nets that the pour does not reach get a short trace and a via into it. */
  const fanout = (only?: Set<string>, stillOpen: Vec2[] = []) => {
    if (!pourNets.size || late()) return 0
    const analysis = analyze()
    let router: Router | undefined
    const getRouter = () => (router ??= routerFor(analysis, undefined, useFor(pourNets, [...new Set([...pourNets].flatMap(widthsFor))])))
    const poured = new Set<number>()
    for (const it of analysis.items) if (it.kind === "zone") poured.add(analysis.island.get(it.id)!)
    const openEnds = [...analysis.ratsnest.flatMap((r) => [r.a, r.b]), ...stillOpen]
    const paths: RoutedPath[] = []
    for (const [netId, entry] of islandsByNet(analysis)) {
      if ((only && !only.has(netId)) || !pourNets.has(netId) || (wanted && !wanted.has(netId))) continue
      const fills = analysis.zoneFills.filter((f) => f.netId === netId)
      for (const [root, shapes] of entry.shapes) {
        if (late()) break
        const pad = shapes.find((s): s is Extract<Shape, { kind: "pad" }> => s.kind === "pad")
        if (!pad) continue
        // Fine-pitch mode looks again after more copper is down: a pad that already has its via keeps it.
        if (mode.fine && shapes.some((s) => s.kind === "via")) continue
        // A pad in a scrap of pour that joins nothing is as open as one outside it (fine-pitch mode).
        if (poured.has(root) && !(mode.fine && pad.layers.length === 1 && openEnds.some((e) => samePoint(e, pad.pad)))) continue
        for (const fill of fills) {
          // A pour on an inner layer is no place for a via to reach: the router vias to the outer pours only.
          if (outerIndex(fill.layer) < 0) continue
          const li = outerIndex(fill.layer)
          if (pad.layers.includes(fill.layer) && pad.layers.length === 1) continue
          const testers = fill.polygons.map(fillTester)
          const inFill = (q: Vec2) => testers.some((t) => t(q))
          let path: RoutedPath | null = null
          for (const w of widthsFor(netId)) if ((path = getRouter().route(netId, shapes, null, w, { layer: li, inFill }))) break
          if (path) {
            paths.push(path)
            routed++
            break
          }
        }
      }
    }
    p = apply(p, paths, rr)
    noteAdded(paths)
    synced()
    for (const path of paths) {
      addedTraces += path.traces.length
      addedVias += path.vias.length
    }
    return paths.length
  }

  /**
   * Fine-pitch mode: gives the fine-pitch pads `want` picks an escape stub (see escapeStub). A pad
   * only gets one if its net has something to connect and its pour does not reach it.
   */
  const addStubs = (want: (it: PadItem) => boolean) => {
    if (late()) return
    const analysis = analyze()
    const pads = analysis.items.filter((it): it is PadItem => it.kind === "pad")
    const poured = new Set<number>()
    for (const it of analysis.items) if (it.kind === "zone") poured.add(analysis.island.get(it.id)!)
    const obstacles = obstacleShapes(analysis)
    const stubs: Omit<Trace, "id">[] = []
    const openEnds = analysis.ratsnest.flatMap((r) => [r.a, r.b])
    const wantsStub = (it: PadItem) =>
      !!it.netId && (!wanted || wanted.has(it.netId)) && isFinePad(it, pads) && (!poured.has(analysis.island.get(it.id)!) || openEnds.some((e) => samePoint(e, it.pad))) && analysis.ratsnest.some((r) => r.netId === it.netId) && want(it)
    if (!pads.some(wantsStub)) return
    const router = routerFor(analysis, obstacles)
    // Rows of fine-pitch pads in order along the row, to alternate their directions.
    const turn = new Map<string, number>()
    const rows = new Map<string, PadItem[]>()
    for (const it of pads.filter(wantsStub)) {
      const key = `${it.pad.componentId}|${it.layers[0]}|${it.pad.width > it.pad.height}|${round(it.pad.width > it.pad.height ? it.pad.x : it.pad.y, 2)}`
      rows.set(key, [...(rows.get(key) ?? []), it])
    }
    for (const row of rows.values()) {
      const lateral = (it: PadItem) => (it.pad.width > it.pad.height ? it.pad.y : it.pad.x)
      row.sort((x, y) => lateral(x) - lateral(y)).forEach((it, i) => turn.set(it.id, i))
    }
    for (const it of pads) {
      if (!wantsStub(it)) continue
      const net = it.netId!
      const mates = pads.filter((o) => o.pad.componentId === it.pad.componentId && o.layers[0] === it.layers[0])
      const stub = escapeStub(router, obstacles, it, mates, net, Math.min(widthsFor(net)[0] ?? signalW, signalW), ladder, mode.narrow, mode.stagger && turn.get(it.id)! % 2 === 1, (other) => rr.pairWith(rr.of(net).clearance, other))
      if (!stub) continue
      stubs.push(stub)
      fineNets.add(net)
      router.commit(net, { traces: [stub], vias: [] })
      obstacles.push({ shape: { kind: "segment", a: stub.points[0], b: stub.points[1], width: stub.width, layers: [stub.layer] }, net })
    }
    if (!stubs.length) return
    const before = p.traces.length
    p = apply(p, [{ traces: stubs, vias: [] }], rr)
    for (const t of p.traces.slice(before)) stubIds.add(t.id)
    for (const s of stubs) live?.router.stubKeys.add(stubKey(s))
    noteAdded([{ traces: stubs, vias: [] }])
    synced()
    addedTraces += stubs.length
  }
  // Before anything is routed, the pads of the nets that stayed open get theirs, and those nets go
  // first, so that wide copper joining a connector's outer pads cannot seal in the signal pads between them.
  // A pour net's pads wait: the pour usually reaches them, and a stub there only gets in its way.
  if (mode.fine) addStubs((it) => mode.nets.has(it.netId!) && !pourNets.has(it.netId!))

  // A supply net that failed before gets its pads into the pour first, before signals take their room.
  if (priority.size) fanout(priority)
  pass((net) => !pourNets.has(net) || priority.has(net) || fineNets.has(net))
  fanout()
  for (let i = 0; i < 2; i++) if (!pass(() => true)) break
  // Signals leaving a fine-pitch part can cut its ground pads off from the pour they were in
  // when the vias were placed: look again.
  if (mode.fine && !late() && fanout()) pass(() => true)

  /**
   * Fine-pitch mode, one rip-up: what is still open was often walled in or cut off by copper this
   * run laid close by (a trace through the one channel a pad's pour reached it by). That copper
   * goes, the open connections are routed first, and the rest is routed again; the result stays
   * only if fewer connections are open. Stubs, locked copper and what was there before stay, and
   * the pads of the open connections get stubs now, if they have none.
   */
  if (mode.fine && !late()) {
    const open = analyze().ratsnest.filter((r) => !wanted || wanted.has(r.netId))
    if (open.length) {
      const snapshot = { p, routed, addedTraces, addedVias, left: open.length }
      const ends = open.flatMap((r) => [r.a, r.b])
      const hasStub = (it: PadItem) => p.traces.some((t) => stubIds.has(t.id) && samePoint(t.points[0], it.pad))
      addStubs((it) => ends.some((e) => samePoint(e, it.pad)) && !hasStub(it))
      const near = (a: Vec2, b: Vec2, width: number) => ends.some((e) => pointSegmentDistance(e, a, b) - width / 2 < RIPUP_REACH)
      const dropTrace = (t: Trace, i: number) => i >= project.traces.length && !stubIds.has(t.id) && !t.locked && t.points.some((q, k) => k > 0 && near(t.points[k - 1], q, t.width))
      const dropVia = (v: Via, i: number) => i >= project.vias.length && !v.locked && ends.some((e) => Math.hypot(e.x - v.x, e.y - v.y) < RIPUP_REACH)
      const dropped = p.traces.filter(dropTrace)
      const droppedVias = p.vias.filter(dropVia)
      p = { ...p, traces: p.traces.filter((t, i) => !dropTrace(t, i)), vias: p.vias.filter((v, i) => !dropVia(v, i)) }
      addedTraces -= dropped.length
      addedVias -= droppedVias.length
      const now = new Set(open.map((r) => r.netId))
      for (const n of now) fineNets.add(n)
      // The copper is gone, and a pad whose pour reached it again counts as joined, so the
      // connection goes in as a trace first, pad to pad, before the others find their way.
      const an = analyze()
      const router = routerFor(an)
      const forced: RoutedPath[] = []
      const padShapes = (it: PadItem): Shape[] => [
        shapeOf(it)!,
        ...p.traces
          .filter((t) => stubIds.has(t.id) && samePoint(t.points[0], it.pad))
          .map((t): Shape => ({ kind: "segment", a: t.points[0], b: t.points[1], width: t.width, layers: [t.layer] })),
      ]
      for (const r of open) {
        const pads = an.items.filter((it): it is PadItem => it.kind === "pad" && it.netId === r.netId)
        const pa = pads.find((x) => samePoint(r.a, x.pad))
        const pb = pads.find((x) => samePoint(r.b, x.pad))
        if (!pa || !pb) continue
        let path: RoutedPath | null = null
        for (const w of widthsFor(r.netId)) if ((path = router.route(r.netId, padShapes(pa), padShapes(pb), w))) break
        if (path) forced.push(path)
      }
      p = apply(p, forced, rr)
      noteAdded(forced)
      failedAt.clear()
      synced()
      routed += forced.length
      fanout(now, ends)
      pass((net) => !pourNets.has(net) || now.has(net))
      fanout()
      for (let i = 0; i < 2; i++) if (!pass(() => true)) break
      const left = analyze().ratsnest.filter((r) => !wanted || wanted.has(r.netId)).length
      if (left >= snapshot.left) ({ p, routed, addedTraces, addedVias } = snapshot)
    }
  }

  let final = analyze(true)
  if (mode.fine) {
    // Copper the retries left connecting no pad (a trace and its vias cut loose by a rip-up) goes.
    const alive = new Set<number>()
    for (const it of final.items) if (it.kind === "pad" || it.kind === "zone") alive.add(final.island.get(it.id)!)
    const deadTraces = new Set<string>()
    const deadVias = new Set<string>()
    for (const it of final.items) {
      if (alive.has(final.island.get(it.id)!)) continue
      if (it.kind === "segment") deadTraces.add(it.traceId)
      if (it.kind === "via") deadVias.add(it.viaId)
    }
    const before = { traces: new Set(project.traces.map((t) => t.id)), vias: new Set(project.vias.map((v) => v.id)) }
    const gone = (t: { id: string; locked?: boolean }, dead: Set<string>, old: Set<string>) => dead.has(t.id) && !old.has(t.id) && !t.locked
    const traces = p.traces.filter((t) => !gone(t, deadTraces, before.traces))
    const vias = p.vias.filter((v) => !gone(v, deadVias, before.vias))
    if (traces.length !== p.traces.length || vias.length !== p.vias.length) {
      addedTraces -= p.traces.length - traces.length
      addedVias -= p.vias.length - vias.length
      p = { ...p, traces, vias }
      final = analyze(true)
    }
  }
  const open = final.ratsnest.filter((r) => !wanted || wanted.has(r.netId))
  const finePads = final.items.filter((it): it is PadItem => it.kind === "pad")
  const fineOpen = open.filter((r) => [r.a, r.b].some((at) => finePads.some((x) => samePoint(at, x.pad) && isFinePad(x, finePads)))).length
  return {
    result: { project: p, routed, remaining: open.length, addedTraces, addedVias, finePitchOpen: fineOpen, finePitchTried: mode.fine ? widthLadder(project).at(-1)! : null },
    failed: [...new Set(open.map((r) => r.netId))],
    fineOpen,
    mode,
  }
}
