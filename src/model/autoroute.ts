import { closestPointOnSegment, pointSegmentDistance, round, samePoint, segmentSegmentDistance, simplifyPolyline, boxesOverlap, type Box } from "../lib/geometry"
import { uid } from "../lib/id"
import { computeConnectivity, type SchematicConnectivity } from "./connectivity"
import { findPart } from "./library"
import { pcbPads, slotEnds, type WorldPad } from "./instances"
import { holeCentre, padBox, padRingsOf } from "./padDistance"
import { pointShapeDistance, type ShapeCopper } from "./shapes"
import { outlineGeometry, rasterizeInside } from "./outline"
import { areaDistance, needsZoneEngine, zoneArea, zoneLayers } from "./zones"
import { withPartZones } from "./partZones"
import { analyzePcb, edgeDistance, pointPadDistance, type CopperItem, type PcbAnalysis } from "./pcb"
import { fromKicad, kicadHoleClearance } from "./checkRules"
import type { ZoneFill } from "./pour"
import { classIndex, hasClearanceRules, hasNetClasses, type ClassIndex } from "./netClasses"
import { copperLayers } from "./stack"
import type { CopperLayer, Project, Trace, Vec2, Via } from "./types"

export interface AutorouteOptions {
  /** Only route these net ids; all nets when omitted. */
  nets?: string[]
  /** Width for supply and ground nets; defaults to max(rule width, 0.4 mm). */
  powerWidth?: number
  /** Give up after this long (ms), for everything one call does, the fine-pitch retry included. Default 10 s. */
  timeLimitMs?: number
  /**
   * Net ids routed before every other net, in this order, in the one call: the way to say which nets take the room first without
   * routing them in calls of their own (the call after cannot take up what the first laid, and on a crowded board it routed less).
   */
  order?: string[]
  /**
   * Keep routing the board again in other orders and with other via costs while there is time, and keep the best (`compareResults`):
   * fewest connections open, least length narrower than its net's width, fewest vias, shortest. Without it that happens only while
   * the best so far leaves a connection open or a net narrower; a board that routes whole at its widths is routed once, as it always was.
   */
  optimize?: boolean
}

/** A connection of a net with a width of its own that went in narrower for want of room, and where. */
export interface NarrowSpan {
  /** The width it took where it had no room for the net's. */
  width: number
  /** How long the narrower stretch is, in mm, and how long the connection is altogether. */
  length: number
  total: number
  /** The connection's two ends (pad centres, or points on copper of the net). */
  a: Vec2
  b: Vec2
  /** The narrower stretch: its first and last point, and the layer of its first piece. */
  from: Vec2
  to: Vec2
  layer: CopperLayer
}

/** A connection the router left open. */
export interface OpenConnection {
  /** The net's name, and its id. */
  net: string
  netId: string
  /** Its two ends: the closest points of the two pieces of copper of the net it would join (pad centres, mostly). */
  a: Vec2
  b: Vec2
  /** One end is a fine-pitch pad (a neighbour on its part closer than 0.7 mm). */
  fine: boolean
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
  /**
   * Nets with a width of their own (`netWidths`, a class's) that have connections on the finished board routed narrower for want of room:
   * absent when none do. A neck at a pad too small for the width is not one. `spans` says where, one per connection.
   */
  narrowed?: { net: string; width: number; widths: number[]; spans: NarrowSpan[] }[]
  /** The connections still open, as many as `remaining`. */
  open: OpenConnection[]
  /** How many whole routings of the board the call made (orders, via costs, fine-pitch modes) before keeping this one. */
  tries: number
}

const FREE = -1
const BLOCKED = -2
/**
 * A grid of which net holds each cell (a net's index, or FREE, BLOCKED, CONTESTED, MIXED): two bytes a cell, four on a board of more than
 * 30,000 nets. A big board of four layers has millions of cells per layer and grid, so the grids are most of what the router takes.
 */
type Cells = Int16Array | Int32Array
/**
 * The router routes every copper layer of the board, front to back (`copperLayers`: `top`, `in1`, `in2`..., `bottom`), with one grid per layer,
 * and changes layer by a through via, which has copper on every layer: a via is allowed where it is clear on all of them, and from it the search
 * goes on on any other layer at the same cost. Inner copper is an obstacle and a place to start or end a connection like outer copper, and an
 * inner pour takes a via like an outer one. Blind, buried and micro vias are not made. A board of two layers is routed as it always was: the same
 * grids, the same moves in the same order.
 */
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
const DIR_OFFSET_X = DIRS.map(([x]) => x)
const DIR_OFFSET_Y = DIRS.map(([, y]) => y)
/** For each diagonal move, the two orthogonal neighbours it passes between, as indexes into the search's east, south, west, north. */
const DIAGONAL_SIDES: [number, number][] = [
  [0, 0],
  [0, 1],
  [0, 0],
  [2, 1],
  [0, 0],
  [2, 3],
  [0, 0],
  [0, 3],
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
/**
 * A search at two widths (`Router.route` with `narrow`): what a cell at the narrower one costs on top of its length, and a change of width.
 * A narrow stretch of length l is taken over a full-width detour shorter than 3l.
 */
const NARROW_EXTRA = 3
const WIDTH_CHANGE = 2
/** A narrower stretch out of a pad no wider than it, up to this long, is the way out of a fine-pitch row, not a narrowing (`Router.route`). */
const ESCAPE_NECK = 0.6

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
  /** The traces (by index) laid narrower than the width the search was for, where it had no room for it (`Router.route` with `narrow`). */
  narrowIdx?: number[]
}

/** What the router asks of each net: the clearance, via diameter and via drill of its net class (a board with no classes: the rules'). */
interface NetRule {
  clearance: number
  viaDiameter: number
  viaDrill: number
  /** The net, by name, when a clearance rule names it with another: its keepouts are its own then, not its class's. */
  own?: string
}

/** A trace width with the clearance of the class whose net it is for: the keepout cells around other copper depend on both. */
interface Profile {
  width: number
  clearance: number
  /** As `NetRule.own`. */
  own?: string
}

/** A via size with the clearance of its class, for the cells where one of that size may be centred. */
interface ViaProfile extends NetRule {
  owner: Cells[]
  /** Cells next to pads, where no via goes. */
  padKeep: Uint8Array
  /** Cells where a new via's drill would be too close to an existing via's: how many vias keep each (a repair takes some up again). */
  holeKeep: Uint16Array
  /** In a router that can take copper up again, the keepouts of the run's own copper. */
  laid?: Laid
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
    // Clearance rules go through the same per-net lookups as classes: a board with neither is routed as it always was.
    this.classed = hasNetClasses(project.rules) || hasClearanceRules(project.rules)
    this.index = classIndex(project.rules)
    const { clearance, viaDiameter, viaDrill, minClearance } = project.rules
    this.floor = minClearance !== undefined && minClearance > 0 ? minClearance : 0
    this.plain = { clearance, viaDiameter, viaDrill }
  }

  /** How many nets the board has, which sizes the router's grids. */
  get netCount(): number {
    return this.netNames.size
  }

  of(netId: string | null | undefined): NetRule {
    if (!this.classed) return this.plain
    const key = netId ?? null
    let r = this.cache.get(key)
    if (!r) {
      const name = key ? (this.netNames.get(key) ?? null) : null
      const v = this.index.values(name)
      r = { clearance: v.clearance, viaDiameter: v.viaDiameter, viaDrill: v.viaDrill, ...(name && this.index.ruledNets.has(name) && { own: name }) }
      this.cache.set(key, r)
    }
    return r
  }

  /** The clearance between copper of a net whose class asks for `own` and copper of `other`. */
  pairWith(own: number, other: string | null | undefined): number {
    return this.classed || this.floor ? Math.max(own, this.of(other).clearance, this.floor) : own
  }

  /**
   * The clearance a trace or via of the net `rule` is for keeps from copper of `other`: a clearance rule's for that net and `other`,
   * or for the part a pad `shape` is on, when one applies (held to the board minimum), else `pairWith`.
   */
  gap(rule: { clearance: number; own?: string }, other: string | null | undefined, shape?: Shape): number {
    if (this.index.ruledAny) {
      const part = shape?.kind === "pad" ? shape.pad.componentId : null
      const x = this.index.ruled(rule.own ?? null, other ? (this.netNames.get(other) ?? null) : null, null, part)
      if (x !== undefined) return Math.max(x, this.floor)
    }
    return this.pairWith(rule.clearance, other)
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

/** A hole as copper keeps its distance from it: a round hole as a via of the hole's size, a slot as a segment as wide as the hole. */
function holeShape(pad: WorldPad, layers: CopperLayer[]): Shape | null {
  if (!pad.holeDiameter) return null
  const ends = slotEnds(pad)
  if (ends) return { kind: "segment", a: ends[0], b: ends[1], width: pad.holeDiameter, layers }
  return { kind: "via", at: holeCentre(pad), diameter: pad.holeDiameter, layers }
}

/**
 * Copper the run laid itself, kept apart from the rest so a repair can take it up again (`Router.laid`): per layer, how many laid items' keepouts
 * cover each cell and their net (MIXED for more than one; it stays MIXED while any of them is left, which only keeps more out).
 */
interface Laid {
  cnt: Uint16Array[]
  net: Cells[]
}
const MIXED = -4
/** What a search that may cross laid copper pays per cell of another net's laid keepout, before history. */
const SOFT_PENALTY = 6
/** History added along a crossing a repair could not keep, so the next try looks elsewhere. */
const HISTORY_STEP = 3
/** A crossing that would take up more laid connections than this is not tried. */
const MAX_RIPPED = 8
/** How often a repair tries one open connection. */
const REPAIR_TRIES = 3
/** A board routed whole but with a net narrower somewhere is routed in other ways (`VARIANTS`) for at most this many times what its first routing took, and at least `EXPLORE_MIN_MS`. */
const EXPLORE_FACTOR = 4
const EXPLORE_MIN_MS = 3_000
/** Nor after this many variants in a row that did no better. */
const NARROW_PATIENCE = 6
/** The share of the time the first passes and their retries get under a limit of `REPAIR_SHARE_FROM_MS` or more; the rest is the repair's. */
const GREEDY_SHARE = 0.7
/** A shorter limit is the passes' whole (the editor's 10 s): on a big board they need all of it, and the repair runs on what they leave. */
const REPAIR_SHARE_FROM_MS = 60_000
/** The repair runs when this many connections at most are open, or this share of them; more is the passes' work, not a repair's. */
const REPAIR_MAX_OPEN = 20
const REPAIR_MAX_SHARE = 0.2
/** Nor with less time than this left: its router alone takes a second or more to build on a big board. */
const REPAIR_MIN_MS = 1_500

/** Costs of a search that may cross copper the run laid: per cell of another net's, and a history per layer that grows where crossings failed. */
interface SoftCost {
  penalty: number
  history: Float32Array[]
}

/** True when laid copper of a net other than `net` keeps the cell (on layer `li`) clear. */
const laidOther = (laid: Laid | undefined, li: number, i: number, net: number): boolean => !!laid && laid.cnt[li][i] > 0 && laid.net[li][i] !== net

/** Grid router over every copper layer. Each net index owns the keepout cells around its copper. */
class Router {
  readonly g: number
  readonly nx: number
  readonly ny: number
  /** The copper layers, front to back; a layer's index is its grid's. */
  readonly layers: readonly CopperLayer[]
  private readonly L: number
  private readonly layerAt = new Map<CopperLayer, number>()
  /**
   * On a project from KiCad, how far copper of another net (or of none) keeps from a hole: KiCad's `min_hole_clearance` (`hole_clearance`),
   * which Checks hold every hole to there. 0 elsewhere, where Checks have no such rule.
   */
  private readonly holeNeed: number
  private ox: number
  private oy: number
  private margin: number
  /** Trace keepouts per width and class clearance, per layer; `laid`, in a router that can take copper up again, those of the run's own copper. */
  private owners = new Map<string, { profile: Profile; arr: Cells[]; laid?: Laid }>()
  /** Via keepouts per size and class clearance. */
  private viaProfiles = new Map<string, ViaProfile>()
  /** Escape stubs, as "ax,ay,bx,by": a search starts from the end of one, not from beside it. */
  stubKeys = new Set<string>()
  /** Escape corridors in front of fine-pitch pads, per layer: owning net, FREE or CONTESTED. */
  private escape: Cells[]
  private stampSrc: Uint32Array[]
  private stampTgt: Uint32Array[]
  /** The stamps of a search's second width (`route` with `narrow`), made the first time one runs. */
  private stampSrc2: Uint32Array[] = []
  private stampTgt2: Uint32Array[] = []
  /** How many widths the search arrays hold at once: 1, or 2 once a search with `narrow` has run. */
  private modes = 1
  /** What a via costs a search, in cells of track: `VIA_COST`, or another for a variant of the run (`Variant.viaCost`). */
  viaCost = VIA_COST
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
    /** Keep the copper it is given as laid (`addShape` with `laid`) and the copper it routes apart, so a repair can take it up again. */
    readonly repairable = false,
  ) {
    const b = project.board
    this.layers = copperLayers(b)
    this.L = this.layers.length
    this.layers.forEach((l, i) => this.layerAt.set(l, i))
    this.holeNeed = fromKicad(project) ? kicadHoleClearance(project) : 0
    const L = this.L
    const perLayer = <T>(make: () => T): T[] => Array.from({ length: L }, make)
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
    const wide = rr.netCount > 30_000
    const cells = (): Cells => (wide ? new Int32Array(n) : new Int16Array(n)).fill(FREE)
    const laid = (): Laid | undefined => (repairable ? { cnt: perLayer(() => new Uint16Array(n)), net: perLayer(cells) } : undefined)
    for (const pr of profiles) {
      const key = this.profileKey(pr.width, pr)
      if (!this.owners.has(key)) this.owners.set(key, { profile: pr, arr: perLayer(cells), laid: laid() })
    }
    for (const net of viaNets) {
      const v = rr.of(net)
      const key = this.viaKey(v)
      if (!this.viaProfiles.has(key)) {
        this.viaProfiles.set(key, { ...v, owner: perLayer(cells), padKeep: new Uint8Array(n), holeKeep: new Uint16Array(n), laid: laid() })
      }
    }
    this.escape = perLayer(cells)
    this.stampSrc = perLayer(() => new Uint32Array(n))
    this.stampTgt = perLayer(() => new Uint32Array(n))
    this.cost = new Float32Array(n * L)
    this.parent = new Int32Array(n * L)
    this.dir = new Int8Array(n * L)
    this.seen = new Uint32Array(n * L)
    this.closed = new Uint32Array(n * L)
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
      if (shape.kind !== "pad" || shape.layers.length !== 1 || !net || this.layerIndex(shape.layers[0]) < 0) continue
      const list = byPart.get(shape.pad.componentId) ?? []
      list.push({ pad: shape.pad, net: this.netId(net), li: this.layerIndex(shape.layers[0]) })
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

  private profileKey = (width: number, rule: { clearance: number; own?: string }) => `${width}|${rule.clearance}${rule.own !== undefined ? `|${rule.own}` : ""}`
  private viaKey = (v: NetRule) => `${v.viaDiameter}|${v.viaDrill}|${v.clearance}${v.own !== undefined ? `|${v.own}` : ""}`

  /** The keepout cells for a trace of `width` on `net`, which depend on its class's clearance (and on the net, when a clearance rule names it). */
  private ownersFor(width: number, net: string | null) {
    return this.owners.get(this.profileKey(width, this.rr.of(net)))
  }

  /** The via keepouts for a via of `net`'s class. */
  viaProfileOf(net: string | null): ViaProfile {
    return this.viaProfiles.get(this.viaKey(this.rr.of(net)))!
  }

  /** The grid of a copper layer, -1 for a layer the board does not have. */
  layerIndex(layer: CopperLayer): number {
    return this.layerAt.get(layer) ?? -1
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
          if (d < this.project.rules.edgeClearance + profile.width / 2 + this.margin) for (const layer of arr) layer[i] = BLOCKED
        }
        for (const vp of this.viaProfiles.values()) {
          if (d < this.project.rules.edgeClearance + vp.viaDiameter / 2 + this.margin) for (const layer of vp.owner) layer[i] = BLOCKED
        }
      }
    }
  }

  /** Rule areas that keep tracks or vias out: a cell is blocked where the trace or via it would hold touches the area, whatever the class of the net that routes it. */
  private markKeepouts() {
    let reachLimit = 0
    for (const { profile } of this.owners.values()) reachLimit = Math.max(reachLimit, profile.width / 2)
    for (const vp of this.viaProfiles.values()) reachLimit = Math.max(reachLimit, vp.viaDiameter / 2)
    for (const z of withPartZones(this.project).zones) {
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
              if (d < profile.width / 2 + this.margin) for (const l of layers) if (this.layerIndex(l) >= 0) arr[this.layerIndex(l)][i] = BLOCKED
            }
          }
          if (z.keepout.vias) {
            for (const vp of this.viaProfiles.values()) {
              if (d < vp.viaDiameter / 2 + this.margin) for (const layer of vp.owner) layer[i] = BLOCKED
            }
          }
        }
      }
    }
  }

  private markArea(arr: Cells, box: Box, reach: number, s: Shape, net: number) {
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

  private markLaidArea(laid: Laid, li: number, box: Box, reach: number, s: Shape, net: number, delta: 1 | -1) {
    const x0 = Math.max(0, Math.floor((box.minX - reach - this.ox) / this.g))
    const x1 = Math.min(this.nx - 1, Math.ceil((box.maxX + reach - this.ox) / this.g))
    const y0 = Math.max(0, Math.floor((box.minY - reach - this.oy) / this.g))
    const y1 = Math.min(this.ny - 1, Math.ceil((box.maxY + reach - this.oy) / this.g))
    const cnt = laid.cnt[li]
    const ln = laid.net[li]
    const p = { x: 0, y: 0 }
    for (let iy = y0; iy <= y1; iy++) {
      p.y = this.cy(iy)
      for (let ix = x0; ix <= x1; ix++) {
        p.x = this.cx(ix)
        if (shapeDistance(p, s) >= reach) continue
        const i = iy * this.nx + ix
        const c = cnt[i]
        if (delta > 0) {
          ln[i] = c === 0 || ln[i] === net ? net : MIXED
          cnt[i] = c + 1
        } else if (c > 0) {
          cnt[i] = c - 1
          if (c === 1) ln[i] = FREE
        }
      }
    }
  }

  /** Lay (1) or take up (-1) the keepouts of copper the run laid, kept apart in a repairable router, with the reaches `addShape` gives other copper. */
  private markLaid(s: Shape, netName: string | null, delta: 1 | -1) {
    const net = this.netId(netName)
    const box = shapeBox(s)
    for (const layer of s.layers) {
      const at = this.layerIndex(layer)
      if (at < 0) continue
      for (const { profile, laid } of this.owners.values()) if (laid) this.markLaidArea(laid, at, box, this.rr.gap(profile, netName, s) + profile.width / 2 + this.margin, s, net, delta)
      for (const vp of this.viaProfiles.values()) {
        if (!vp.laid) continue
        const reach = Math.max(this.rr.gap(vp, netName, s) + vp.viaDiameter / 2, this.holeNeed ? this.holeNeed + vp.viaDrill / 2 : 0) + this.margin
        this.markLaidArea(vp.laid, at, box, reach, s, net, delta)
      }
    }
    if (this.holeNeed && s.kind === "via" && s.drill) {
      const hole: Shape = { kind: "via", at: s.at, diameter: s.drill, layers: s.layers }
      const hb = shapeBox(hole)
      for (const layer of hole.layers) {
        const at = this.layerIndex(layer)
        if (at < 0) continue
        for (const { profile, laid } of this.owners.values()) if (laid) this.markLaidArea(laid, at, hb, this.holeNeed + profile.width / 2 + this.margin, hole, net, delta)
        for (const vp of this.viaProfiles.values()) if (vp.laid) this.markLaidArea(vp.laid, at, hb, this.holeNeed + vp.viaDiameter / 2 + this.margin, hole, net, delta)
      }
    }
  }

  /** Take up copper the run laid (`addShape` with `laid`), in a repairable router. */
  removeLaid(s: Shape, netName: string | null) {
    if (!this.repairable) return
    this.markLaid(s, netName, -1)
    this.markViaHole(s, netName, -1)
  }

  /** Make the search arrays hold `m` widths at once (`route` with `narrow`): its nodes are a cell, a layer and a width. */
  private growModes(m: number) {
    const n = this.nx * this.ny
    const size = n * this.L * m
    this.cost = new Float32Array(size)
    this.parent = new Int32Array(size)
    this.dir = new Int8Array(size)
    this.seen = new Uint32Array(size)
    this.closed = new Uint32Array(size)
    this.stampSrc2 = Array.from({ length: this.L }, () => new Uint32Array(n))
    this.stampTgt2 = Array.from({ length: this.L }, () => new Uint32Array(n))
    this.modes = m
  }

  /** The grid spacing's half, by which every keepout is wider than its clearance. */
  get keepMargin(): number {
    return this.margin
  }

  /**
   * Search the outer layers only: no move along an inner layer and no via to one (a search that starts on inner copper vias out of it).
   * The first pass of a board of more than two layers routes so, at a board of two's speed, and what it leaves open is routed on every layer.
   */
  outerOnly = false

  /** A history for `SoftCost`, one per layer, all zero. */
  newHistory(): Float32Array[] {
    return Array.from({ length: this.L }, () => new Float32Array(this.nx * this.ny))
  }

  /** Add `amount` of history along a routed path's traces, for the cells a search that crossed there went through. */
  bumpHistory(history: Float32Array[], path: RoutedPath, amount: number) {
    for (const t of path.traces) {
      const li = this.layerIndex(t.layer)
      if (li < 0) continue
      for (let k = 1; k < t.points.length; k++) {
        const a = t.points[k - 1]
        const b = t.points[k]
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / this.g))
        for (let s = 0; s <= steps; s++) {
          const [ix, iy] = this.cellOf({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps })
          if (this.inGrid(ix, iy)) history[li][iy * this.nx + ix] += amount
        }
      }
    }
  }

  /** The shapes `commit` lays for a routed path: a segment per piece of each trace, a through via at each via. */
  pathShapes(netName: string, path: RoutedPath): Shape[] {
    const out: Shape[] = []
    for (const t of path.traces) for (let k = 0; k < t.points.length - 1; k++) out.push({ kind: "segment", a: t.points[k], b: t.points[k + 1], width: t.width, layers: [t.layer] })
    const via = this.rr.of(netName)
    for (const v of path.vias) out.push({ kind: "via", at: v, diameter: via.viaDiameter, drill: via.viaDrill, layers: [...this.layers] })
    return out
  }

  /** Mark keepouts around copper of `net`. Pads also keep vias out for every net. In a repairable router, `laid` copper is kept apart, to be taken up again. */
  addShape(s: Shape, netName: string | null, laid = false) {
    if (laid && this.repairable) {
      this.markLaid(s, netName, 1)
      this.markViaHole(s, netName, 1)
      return
    }
    const net = this.netId(netName)
    const box = shapeBox(s)
    // Keepouts are the larger of the routing net's class clearance and this copper's (its net's class; no net is Default).
    // A pad with a clearance of its own (X7, KiCad's local clearance) keeps that when it is the larger, as KiCad max's it with the classes' (drc_engine.cpp 9.0 :1451-1540, 10.0 :1982-2063).
    // A clearance rule for the routing net and this copper's, or for the part a pad is on, replaces the classes' (`RouteRules.gap`).
    const own = s.kind === "pad" && s.pad.clearance ? s.pad.clearance : 0
    for (const layer of s.layers) {
      const at = this.layerIndex(layer)
      if (at < 0) continue
      for (const { profile, arr } of this.owners.values()) this.markArea(arr[at], box, Math.max(own, this.rr.gap(profile, netName, s)) + profile.width / 2 + this.margin, s, net)
      for (const vp of this.viaProfiles.values()) {
        // A via's drill keeps KiCad's hole clearance from this copper too, where that reaches further than its own copper's clearance.
        const reach = Math.max(Math.max(own, this.rr.gap(vp, netName, s)) + vp.viaDiameter / 2, this.holeNeed ? this.holeNeed + vp.viaDrill / 2 : 0) + this.margin
        this.markArea(vp.owner[at], box, reach, s, s.kind === "pad" ? BLOCKED : net)
      }
    }
    // On a project from KiCad, copper of another net keeps the hole clearance from a hole, on every layer it goes through, and copper of every net
    // from a hole with no net (an unplated one): KiCad's `hole_clearance`, which a pad's copper ring or a via's does not always cover.
    if (this.holeNeed) {
      const hole = s.kind === "pad" ? holeShape(s.pad, [...this.layers]) : s.kind === "via" && s.drill ? ({ kind: "via", at: s.at, diameter: s.drill, layers: s.layers } as Shape) : null
      if (hole) this.markHole(hole, net)
    }
    this.markViaHole(s, netName, 1)
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

  /** Fine-pitch mode: count (1) or take back (-1) the cells where a new via's drill would come within the hole clearance of this via's. */
  private markViaHole(s: Shape, netName: string | null, delta: 1 | -1) {
    if (s.kind !== "via" || !this.strictVias) return
    // A new via's drill keeps the hole clearance from this one's, even on the same net.
    const theirs = this.rr.classed ? (s.drill ?? this.rr.of(netName).viaDrill) : undefined
    for (const vp of this.viaProfiles.values()) {
      const reach = (theirs === undefined ? vp.viaDrill : (vp.viaDrill + theirs) / 2) + this.project.rules.holeClearance + 1e-6
      const x0 = Math.max(0, Math.floor((s.at.x - reach - this.ox) / this.g))
      const x1 = Math.min(this.nx - 1, Math.ceil((s.at.x + reach - this.ox) / this.g))
      const y0 = Math.max(0, Math.floor((s.at.y - reach - this.oy) / this.g))
      const y1 = Math.min(this.ny - 1, Math.ceil((s.at.y + reach - this.oy) / this.g))
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          if (Math.hypot(this.cx(ix) - s.at.x, this.cy(iy) - s.at.y) >= reach) continue
          const i = iy * this.nx + ix
          if (delta > 0) vp.holeKeep[i]++
          else if (vp.holeKeep[i] > 0) vp.holeKeep[i]--
        }
      }
    }
  }

  /** Keep traces and vias of other nets (every net, for a hole of none) `holeNeed` from a hole's wall. */
  private markHole(hole: Shape, net: number) {
    const box = shapeBox(hole)
    for (const layer of hole.layers) {
      const at = this.layerIndex(layer)
      if (at < 0) continue
      for (const { profile, arr } of this.owners.values()) this.markArea(arr[at], box, this.holeNeed + profile.width / 2 + this.margin, hole, net)
      for (const vp of this.viaProfiles.values()) this.markArea(vp.owner[at], box, this.holeNeed + vp.viaDiameter / 2 + this.margin, hole, net)
    }
  }

  /** True when a trace of `width` may be centred on the cell, as far as other nets' copper goes. */
  cellFree(li: number, ix: number, iy: number, netName: string, width: number): boolean {
    const o = this.ownersFor(width, netName)
    if (!o || !this.inGrid(ix, iy)) return false
    const i = iy * this.nx + ix
    const v = o.arr[li][i]
    const net = this.netId(netName)
    return (v === FREE || v === net) && !laidOther(o.laid, li, i, net)
  }

  /** A through via may be centred on the cell: clear on every layer, since it has copper on all of them. Laid copper of other nets is crossed when `soft`. */
  viaAllowed(i: number, net: number, vp: ViaProfile, soft = false): boolean {
    if (vp.padKeep[i] || vp.holeKeep[i]) return false
    for (const layer of vp.owner) {
      const v = layer[i]
      if (v !== FREE && v !== net) return false
    }
    if (vp.laid && !soft) for (let li = 0; li < this.L; li++) if (laidOther(vp.laid, li, i, net)) return false
    return true
  }

  /** What a soft search pays for a via at the cell: per layer where laid copper of another net keeps vias out. */
  private viaSoftCost(i: number, net: number, vp: ViaProfile, soft: SoftCost): number {
    if (!vp.laid) return 0
    let c = 0
    for (let li = 0; li < this.L; li++) if (laidOther(vp.laid, li, i, net)) c += soft.penalty + soft.history[li][i]
    return c
  }

  /**
   * The neck a trace of `width` leaves `pad` by when no cell of the pad holds it whole (a 3 mm supply trace into a 2.6 mm pad): the
   * widest trace a cell does hold, to 0.01 mm. 0 for no neck: the trace fits, it is no wider than the default, or the pad is too
   * small for a default-width neck, where the narrower widths and the fine-pitch retry take over as before.
   */
  private neckWidth(pad: WorldPad, width: number): number {
    const { traceWidth } = this.project.rules
    if (width <= traceWidth + 1e-9) return 0
    const b = padBox(pad)
    let best = 0
    const p = { x: 0, y: 0 }
    for (let iy = Math.max(0, Math.ceil((b.minY - this.oy) / this.g)); iy <= Math.min(this.ny - 1, Math.floor((b.maxY - this.oy) / this.g)); iy++) {
      p.y = this.cy(iy)
      for (let ix = Math.max(0, Math.ceil((b.minX - this.ox) / this.g)); ix <= Math.min(this.nx - 1, Math.floor((b.maxX - this.ox) / this.g)); ix++) {
        p.x = this.cx(ix)
        if (pointPadDistance(p, pad) === 0) best = Math.max(best, padInset(p, pad))
      }
    }
    if (2 * best >= width - 2e-6) return 0
    const neck = Math.floor(2 * best * 100 + 1e-6) / 100
    return neck >= traceWidth - 1e-9 ? neck : 0
  }

  /** Stamp the cells covered by own-net copper so the search may start or end there. Pads a trace of `width` leaves by a neck are put in `necks`, with its width. */
  private stampShapes(
    target: Uint32Array[],
    shapes: Shape[],
    width: number,
    net: number,
    owner: Cells[],
    seeds?: number[],
    necks?: Map<WorldPad, number>,
    laid?: Laid,
  ): Box {
    const n = this.nx * this.ny
    const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const p = { x: 0, y: 0 }
    for (const s of shapes) {
      // A pad too small for the trace is left by a neck of its own width: the search starts where the neck fits in the pad and the wide trace would be clear.
      const neck = s.kind === "pad" && necks ? this.neckWidth(s.pad, width) : 0
      if (neck && s.kind === "pad") necks!.set(s.pad, neck)
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
          if (s.kind === "pad") ok = pointPadDistance(p, s.pad) === 0 && padInset(p, s.pad) >= (neck || width) / 2 - 1e-6
          else if (s.kind === "segment" && this.stubKeys.has(`${s.a.x},${s.a.y},${s.b.x},${s.b.y}`)) ok = Math.hypot(p.x - s.b.x, p.y - s.b.y) <= this.g * 0.5
          else if (s.kind === "segment") ok = pointSegmentDistance(p, s.a, s.b) <= Math.max(this.g * 0.5, (s.width - width) / 2)
          else if (s.kind === "drawing") ok = false
          else ok = Math.hypot(p.x - s.at.x, p.y - s.at.y) <= s.diameter / 2 - width / 2 + 1e-6
          if (!ok) continue
          for (const layer of s.layers) {
            const li = this.layerIndex(layer)
            if (li < 0) continue
            const v = owner[li][i]
            // Inside a pad by half a trace width the new copper is covered by the pad itself; a trace wider than the pad, which a neck leaves it by, is not.
            if ((s.kind !== "pad" || neck) && ((v !== FREE && v !== net) || laidOther(laid, li, i, net))) continue
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
   * A* from the source copper to the target copper on every layer. When `toPour` is set, the
   * goal is instead any cell inside a pour's fill where a via fits, on any layer that has one
   * (`inFill`, by layer index): a trace on the fill's own layer ends in it, one on another layer
   * ends in a via into it, whichever is nearer. With `soft` (a repairable router), copper the run
   * laid for other nets is crossed at a cost instead of kept clear of, and the path found is not
   * committed: the caller takes up what it crosses first.
   *
   * With `narrow`, the search runs at two widths at once: `width` wherever a trace of it fits and `narrow` only where it does not, each
   * cell at `narrow` costing `NARROW_EXTRA` more and each change of width `WIDTH_CHANGE`. A supply into a crowded corner then necks down
   * for the stretch that has no room and is full width on either side of it, where routing it at `narrow` end to end made the whole
   * connection thin (issue: a 0.4 mm VBUS laid at 0.25 mm from a decoupling capacitor to its pin, through two vias, for a gap of 0.3 mm).
   * The pieces laid at `narrow` are listed in the result's `narrowIdx`. With `dry` the path is only looked for, not laid.
   */
  route(
    netName: string,
    source: Shape[],
    target: Shape[] | null,
    width: number,
    toPour?: { inFill: (((p: Vec2) => boolean) | null)[] },
    soft?: SoftCost,
    narrow?: number,
    /** Only look: the path found is not laid. */
    dry = false,
  ): RoutedPath | null {
    if (performance.now() > this.deadline) return null
    const net = this.netId(netName)
    const narrowKeep = narrow !== undefined && narrow < width - 1e-9 ? this.ownersFor(narrow, netName) : undefined
    const M = narrowKeep ? 2 : 1
    const widthOf = [width, narrow ?? width]
    const keeps = [this.ownersFor(width, netName)!, narrowKeep ?? this.ownersFor(width, netName)!]
    const owners = keeps.map((k) => k.arr)
    const lays = keeps.map((k) => k.laid)
    const vp = this.viaProfileOf(netName)
    const nx = this.nx
    const n = nx * this.ny
    const L = this.L
    const NL = n * L
    if (M > this.modes) this.growModes(M)
    const stampSrc = [this.stampSrc, this.stampSrc2]
    const stampTgt = [this.stampTgt, this.stampTgt2]
    const srcStamps = [0, 0]
    const tgtStamps = [0, 0]
    const seeds: number[] = []
    const neckMaps = [new Map<WorldPad, number>(), new Map<WorldPad, number>()]
    let tb: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (let m = 0; m < M; m++) {
      this.stamp++
      srcStamps[m] = this.stamp
      const from: number[] = []
      this.stampShapes(stampSrc[m], source, widthOf[m], net, owners[m], from, neckMaps[m], lays[m])
      for (const node of from) seeds.push(m * NL + node)
      if (target) {
        this.stamp++
        tgtStamps[m] = this.stamp
        const b = this.stampShapes(stampTgt[m], target, widthOf[m], net, owners[m], undefined, neckMaps[m], lays[m])
        tb = { minX: Math.min(tb.minX, b.minX), minY: Math.min(tb.minY, b.minY), maxX: Math.max(tb.maxX, b.maxX), maxY: Math.max(tb.maxY, b.maxY) }
      }
    }
    if (target && !Number.isFinite(tb.minX)) return null
    const fillMemo = new Map<number, boolean>()
    const isGoal = (node: number) => {
      const m = node >= NL ? 1 : 0
      const rest = node - m * NL
      const li = (rest / n) | 0
      const i = rest - li * n
      if (target) return stampTgt[m][li][i] === tgtStamps[m]
      const inFill = toPour?.inFill[li]
      if (!inFill || !this.viaAllowed(i, net, vp)) return false
      let hit = fillMemo.get(rest)
      if (hit === undefined) {
        hit = inFill({ x: this.cx(i % nx), y: this.cy(Math.floor(i / nx)) })
        fillMemo.set(rest, hit)
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
    const outerOnly = this.outerOnly && L > 2
    const passable = (m: number, li: number, i: number) => {
      const v = owners[m][li][i]
      const laid = lays[m]
      if ((v === FREE || v === net) && !(laid !== undefined && soft === undefined && laid.cnt[li][i] > 0 && laid.net[li][i] !== net)) return true
      return stampSrc[m][li][i] === srcStamps[m] || (target !== null && stampTgt[m][li][i] === tgtStamps[m])
    }

    this.search++
    const s = this.search
    const heap = new MinHeap()
    const seen = this.seen
    const cost = this.cost
    const parent = this.parent
    const dirOf = this.dir
    const closed = this.closed
    const ny = this.ny
    const cap = (this.strictVias ? FINE_MAX_EXPANSIONS : MAX_EXPANSIONS) * M
    const viaCostBase = this.viaCost
    for (const node of seeds) {
      seen[node] = s
      cost[node] = 0
      parent[node] = -1
      dirOf[node] = -1
      heap.push(node, h(node % n))
    }
    const relax = (next: number, c: number, from: number, d: number, i: number) => {
      if (seen[next] === s && c >= cost[next]) return
      seen[next] = s
      cost[next] = c
      parent[next] = from
      dirOf[next] = d
      heap.push(next, c + h(i))
    }
    let goal = -1
    let expansions = 0
    // Whether each orthogonal neighbour may be entered (east, south, west, north: DIRS 0, 2, 4, 6), which the diagonal moves ask too.
    const orth = [false, false, false, false]
    while (heap.size) {
      const node = heap.pop()
      if (closed[node] === s) continue
      closed[node] = s
      if (isGoal(node) && parent[node] !== -1) {
        goal = node
        break
      }
      if (++expansions > cap) break
      if ((expansions & 4095) === 0 && performance.now() > this.deadline) break
      const m = node >= NL ? 1 : 0
      const rest = node - m * NL
      const li = (rest / n) | 0
      const i = rest - li * n
      const ix = i % nx
      const iy = (i - ix) / nx
      const base = cost[node]
      const d0 = dirOf[node]
      const esc = this.escape[li]
      const laid = lays[m]
      const off = m * NL
      const stay = !(outerOnly && li > 0 && li < L - 1)
      orth[0] = stay && ix + 1 < nx && passable(m, li, i + 1)
      orth[1] = stay && iy + 1 < ny && passable(m, li, i + nx)
      orth[2] = stay && ix > 0 && passable(m, li, i - 1)
      orth[3] = stay && iy > 0 && passable(m, li, i - nx)
      for (let d = 0; stay && d < 8; d++) {
        let j: number
        if ((d & 1) === 0) {
          if (!orth[d >> 1]) continue
          j = i + DIR_OFFSET_X[d] + DIR_OFFSET_Y[d] * nx
        } else {
          const jx = ix + DIR_OFFSET_X[d]
          const jy = iy + DIR_OFFSET_Y[d]
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue
          j = jy * nx + jx
          if (!passable(m, li, j)) continue
          // Diagonal moves must not squeeze between two blocked orthogonal cells.
          if (!orth[DIAGONAL_SIDES[d][0]] && !orth[DIAGONAL_SIDES[d][1]]) continue
        }
        let turn = 0
        if (d0 >= 0) {
          const diff = Math.abs(d - d0)
          turn = TURN_COST[Math.min(diff, 8 - diff)]
        }
        const e = esc[j]
        const len = (d & 1) === 1 ? Math.SQRT2 : 1
        let step = len + turn + (e >= 0 && e !== net ? ESCAPE_COST : 0)
        if (m === 1) step += len * NARROW_EXTRA
        if (soft && laidOther(laid, li, j, net)) step += soft.penalty + soft.history[li][j]
        relax(off + li * n + j, base + step, node, d, j)
      }
      // The other width on the same cell, where a trace of it may be centred too.
      if (M === 2 && passable(1 - m, li, i)) relax((1 - m) * NL + li * n + i, base + WIDTH_CHANGE, node, d0, i)
      // Layer change through a (through) via, to any other layer at one cost.
      const viaHere = this.viaAllowed(i, net, vp, soft !== undefined)
      if (viaHere) {
        const viaCost = viaCostBase + (soft ? this.viaSoftCost(i, net, vp, soft) : 0)
        for (let lj = 0; lj < L; lj++) {
          if (lj === li || (outerOnly && lj > 0 && lj < L - 1) || !passable(m, lj, i)) continue
          relax(off + lj * n + i, base + viaCost, node, -1, i)
        }
      }
      // A via here into a pour's fill on another layer ends the search.
      let into = -1
      for (let lj = 0; toPour && viaHere && into < 0 && lj < L; lj++) if (lj !== li && isGoal(off + lj * n + i)) into = off + lj * n + i
      if (into >= 0) {
        seen[into] = s
        cost[into] = base + viaCostBase
        parent[into] = node
        dirOf[into] = -1
        goal = into
        break
      }
    }
    if (goal < 0) return null

    // Walk back into cells, then split into runs: a new one at each via (a new layer) and at each change of width.
    const nodes: number[] = []
    for (let cur = goal; cur !== -1; cur = parent[cur]) nodes.push(cur)
    nodes.reverse()
    const runs: { layer: number; mode: number; pts: Vec2[] }[] = []
    const vias: Vec2[] = []
    for (const node of nodes) {
      const m = node >= NL ? 1 : 0
      const rest = node - m * NL
      const li = (rest / n) | 0
      const i = rest - li * n
      const p = { x: round(this.cx(i % nx), 4), y: round(this.cy(Math.floor(i / nx)), 4) }
      const last = runs[runs.length - 1]
      if (!last || last.layer !== li || last.mode !== m) {
        if (last && last.layer !== li) vias.push(p)
        runs.push({ layer: li, mode: m, pts: [p] })
      } else last.pts.push(p)
    }
    // Pour fanouts end in a via on the far layer; drop that empty run.
    if (toPour && runs.length > 1 && runs[runs.length - 1].pts.length === 1) runs.pop()

    // Tie the ends to the copper they started from and landed on.
    const snapEnd = (p: Vec2, shapes: Shape[], layer: CopperLayer, owner: Cells[]): Vec2 => {
      for (const sh of shapes) {
        if (!sh.layers.includes(layer)) continue
        if (sh.kind === "pad" && pointPadDistance(p, sh.pad) === 0) {
          // A trace wider than its pad would run from the pad's centre, and the keepouts around the other nets' copper were made for cell centres, not for that point:
          // with classes, where the cell at the centre is in another net's keepout, the trace starts where the search did, still inside the pad.
          if (this.rr.classed) {
            const [cx, cy] = this.cellOf({ x: sh.pad.x, y: sh.pad.y })
            const v = this.inGrid(cx, cy) ? owner[this.layerIndex(layer)][cy * nx + cx] : FREE
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
    // The pad an end leaves by a neck, found from the cell the search began or ended in, which is inside it.
    const neckAt = (p: Vec2, shapes: Shape[], layer: CopperLayer, necks: Map<WorldPad, number>): Neck | null => {
      for (const sh of shapes) if (sh.kind === "pad" && necks.has(sh.pad) && sh.layers.includes(layer) && pointPadDistance(p, sh.pad) === 0) return { pad: sh.pad, width: necks.get(sh.pad)! }
      return null
    }
    const startNeck = neckAt(first.pts[0], source, this.layers[first.layer], neckMaps[first.mode])
    const endNeck = target ? neckAt(lastRun.pts[lastRun.pts.length - 1], target, this.layers[lastRun.layer], neckMaps[lastRun.mode]) : null
    first.pts.unshift(snapEnd(first.pts[0], source, this.layers[first.layer], owners[first.mode]))
    if (target) lastRun.pts.push(snapEnd(lastRun.pts[lastRun.pts.length - 1], target, this.layers[lastRun.layer], owners[lastRun.mode]))

    // A narrower first or last stretch, of less than `ESCAPE_NECK`, from copper no wider than it (a pad of a fine-pitch row, or the neck out
    // of one) is the way out of the row: the pads beside it leave no room for the width until the trace is past them, and it is no narrower
    // than the copper it carries the current of.
    const smallPadAt = (p: Vec2, shapes: Shape[], layer: CopperLayer, w: number) =>
      shapes.some(
        (sh) =>
          sh.layers.includes(layer) &&
          ((sh.kind === "pad" && pointPadDistance(p, sh.pad) <= this.g && Math.min(sh.pad.width, sh.pad.height) <= w + 1e-6) ||
            (sh.kind === "segment" && sh.width <= w + 1e-6 && pointSegmentDistance(p, sh.a, sh.b) <= sh.width / 2 + 1e-6)),
      )
    // A connection between two pads of one part, each narrower than the width (a USB-C receptacle's two VBUS pads), carries no more than
    // those pads do: what it lays narrower between them is no narrowing either.
    const padAtEnd = (p: Vec2, shapes: Shape[], layer: CopperLayer) =>
      shapes.find((sh): sh is Extract<Shape, { kind: "pad" }> => sh.kind === "pad" && sh.layers.includes(layer) && pointPadDistance(p, sh.pad) <= this.g)?.pad
    const startPad = padAtEnd(first.pts[0], source, this.layers[first.layer])
    const endPad = target ? padAtEnd(lastRun.pts[lastRun.pts.length - 1], target, this.layers[lastRun.layer]) : undefined
    const slimPad = (pad: WorldPad | undefined) => !!pad && Math.min(pad.width, pad.height) < width - 1e-6
    const withinPart = !!startPad && !!endPad && startPad.componentId === endPad.componentId && slimPad(startPad) && slimPad(endPad)
    const traces: Omit<Trace, "id">[] = []
    const narrowIdx: number[] = []
    runs.forEach((run, k) => {
      const pts = simplifyPolyline(run.pts.filter((p, i) => i === 0 || !samePoint(p, run.pts[i - 1])))
      if (pts.length < 2) return
      const w = widthOf[run.mode]
      const layer = this.layers[run.layer]
      const escape =
        run.mode === 1 &&
        polylineLength(pts) <= ESCAPE_NECK + 1e-9 &&
        ((k === 0 && smallPadAt(pts[0], source, layer, w)) || (k === runs.length - 1 && target !== null && smallPadAt(pts[pts.length - 1], target, layer, w)))
      for (const piece of neckDown(pts, w, k === 0 ? startNeck : null, k === runs.length - 1 ? endNeck : null)) {
        // A neck at a pad too small for the width is the pad's own size, not a narrowing.
        if (run.mode === 1 && !escape && !withinPart && Math.abs(piece.width - w) < 1e-9) narrowIdx.push(traces.length)
        traces.push({ layer, ...piece })
      }
    })
    const result: RoutedPath = { traces, vias, net: netName, ...(narrowIdx.length ? { narrowIdx } : {}) }
    if (!soft && !dry) this.commit(netName, result)
    return result
  }

  /** Lay a routed path's copper; a repairable router keeps it apart, as the run's own, to be taken up again (`uncommit`). */
  commit(netName: string, path: RoutedPath) {
    for (const s of this.pathShapes(netName, path)) this.addShape(s, netName, this.repairable)
  }

  /** Take up a path `commit` laid, in a repairable router. */
  uncommit(netName: string, path: RoutedPath) {
    for (const s of this.pathShapes(netName, path)) this.removeLaid(s, netName)
  }
}

/** A pad a trace leaves by a neck, and the neck's width. */
interface Neck {
  pad: WorldPad
  width: number
}

/** The first point along `points` where a trace of `width` is clear of `pad` (its copper no longer reaches the pad), with the segment it is on; null when it never is. */
function clearOfPad(points: Vec2[], pad: WorldPad, width: number): { seg: number; at: Vec2 } | null {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02))
    for (let k = 1; k <= steps; k++) {
      const q = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps }
      if (pointPadDistance(q, pad) >= width / 2) return { seg: i, at: { x: round(q.x, 4), y: round(q.y, 4) } }
    }
  }
  return null
}

const distinct = (points: Vec2[]) => points.filter((p, i) => i === 0 || !samePoint(p, points[i - 1]))

/**
 * A routed run of `width` cut into its pieces: at an end on a pad too small for the width, a neck of the pad's own width as far as
 * the wide copper is clear of the pad, then the wide trace. The search kept the whole run clear at `width`, so the narrower necks are
 * too. A run that never clears its pad is narrow throughout.
 */
function neckDown(points: Vec2[], width: number, start: Neck | null, end: Neck | null): { width: number; points: Vec2[] }[] {
  if (!start && !end) return [{ width, points }]
  const out: { width: number; points: Vec2[] }[] = []
  let wide = points
  if (start) {
    const c = clearOfPad(wide, start.pad, width)
    if (!c) return [{ width: Math.min(start.width, end?.width ?? Infinity), points }]
    out.push({ width: start.width, points: distinct([...wide.slice(0, c.seg), c.at]) })
    wide = distinct([c.at, ...wide.slice(c.seg)])
  }
  let tail: { width: number; points: Vec2[] } | null = null
  if (end && wide.length >= 2) {
    const back = [...wide].reverse()
    const c = clearOfPad(back, end.pad, width)
    if (!c) {
      out.push({ width: end.width, points: wide })
      return out.filter((piece) => piece.points.length >= 2)
    }
    tail = { width: end.width, points: distinct([...back.slice(0, c.seg), c.at].reverse()) }
    wide = distinct([...back.slice(c.seg).reverse(), c.at])
  }
  out.push({ width, points: wide })
  if (tail) out.push(tail)
  return out.filter((piece) => piece.points.length >= 2)
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
  /** The clearance to copper of another net: the larger of the stub's class and that net's, or a clearance rule's. */
  clearanceTo: (other: string | null, shape: Shape) => number,
): Omit<Trace, "id"> | null {
  const p = pad.pad
  const layer = pad.layers[0]
  const li = Math.max(0, router.layerIndex(layer))
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
      const clearance = clearanceTo(o.net, o.shape)
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

function obstacleShapes(analysis: PcbAnalysis, drills?: Map<string, number>, skip?: (it: CopperItem) => boolean): { shape: Shape; net: string | null }[] {
  const out: { shape: Shape; net: string | null }[] = []
  for (const it of analysis.items) {
    if (skip?.(it)) continue
    const shape = shapeOf(it, drills)
    if (!shape) continue
    const root = analysis.island.get(it.id)
    const islandNet = root === undefined ? null : (analysis.islandNet.get(root) ?? null)
    const net = it.kind === "pad" ? it.netId : islandNet
    out.push({ shape, net })
  }
  return out
}

/** The board with `paths` laid on it; `laid` hears the ids each path's traces were given. */
function apply(project: Project, paths: RoutedPath[], rr: RouteRules, laid?: (path: RoutedPath, traceIds: string[], viaIds: string[]) => void): Project {
  if (!paths.length) return project
  const traces: Trace[] = []
  const vias: Via[] = []
  for (const p of paths) {
    const ids = p.traces.map(() => uid("t"))
    p.traces.forEach((t, i) => traces.push({ ...t, id: ids[i] }))
    // a via is the size of its net's class (the rules' for a board with no classes)
    const size = rr.of(p.net)
    const viaIds = p.vias.map(() => uid("v"))
    p.vias.forEach((v, i) => vias.push({ id: viaIds[i], x: v.x, y: v.y, diameter: size.viaDiameter, drill: size.viaDrill }))
    laid?.(p, ids, viaIds)
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
        if (rr.classed) slack = Math.min(slack, Math.hypot(dx, dy) - rr.gap(rr.of(it.netId), o.netId, { kind: "pad", pad: o.pad, layers: o.layers }))
      }
      const room = (Math.min(it.pad.width, it.pad.height) - minTraceWidth) / 2
      if (rr.classed ? slack + room >= -1e-6 : gap + room >= clearance - 1e-6) feasible = true
      if (!padHasSeed(it.pad, traceWidth, ox, oy)) stuck.add(r.netId)
    }
  }
  return { report: any ? { stuck, feasible } : null, analysis }
}

/** What one attempt left: the result, the nets still open, how many of those are at fine-pitch pads, and how it was routed. */
interface AttemptOutcome {
  result: AutorouteResult
  failed: string[]
  fineOpen: number
  mode: AttemptMode
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
 * Another way to route the board than the router's own: an order of the connections and a cost of vias. A greedy router lays one
 * connection at a time and keeps what it laid, so which goes first decides what the later ones find, and on a crowded board a part
 * moved 0.1 mm could leave a connection open that the same router in another order routes (a user's USB-C bridge: 26 of 37 layouts
 * from its history routed whole in the one order). `autoroute` routes the board again in these, while there is time and the best so far
 * is not clean, and keeps the best (`compareResults`).
 */
interface Variant {
  /** Nets that hold a width (a width of their own, a supply's) before the signals, so they take the room at their width. */
  wideFirst?: boolean
  /** The nets that failed in the best so far go first, as the retries do. */
  failedFirst?: boolean
  /** Longest connections first, instead of shortest. */
  longFirst?: boolean
  /** Shortest first, but each length scaled by 0.4 to 1.6, the same for the same seed and connection: a shuffled order that stays close to shortest first. */
  seed?: number
  /** What a via costs, in cells of track (`VIA_COST` is the router's own): cheaper vias let a connection hop over the copper in its way, dearer ones keep it on its layer. */
  viaCost?: number
  /**
   * A connection with no room for its net's width goes in narrower end to end, as the router did before it could neck down where it must:
   * thinner copper takes less room, and on a crowded board that room is what another connection needs.
   */
  thinFallback?: boolean
  /** On a board routed in fine-pitch mode, which of its four ways (`fineModes`: stubs staggered or not, wide or narrow) to route in; the best so far's when not said. */
  fine?: number
}

const VARIANTS: Variant[] = [
  { wideFirst: true },
  { thinFallback: true, fine: 0 },
  { wideFirst: true, failedFirst: true },
  { seed: 1 },
  { wideFirst: true, viaCost: 14 },
  { thinFallback: true, fine: 1 },
  { longFirst: true },
  { wideFirst: true, seed: 2, fine: 2 },
  { seed: 3, viaCost: 60 },
  { thinFallback: true, failedFirst: true },
  { wideFirst: true, seed: 4, viaCost: 14, fine: 1 },
  { failedFirst: true, seed: 5, fine: 3 },
  { wideFirst: true, longFirst: true, fine: 0 },
  { thinFallback: true, seed: 6, fine: 3 },
  { seed: 7, viaCost: 14 },
  { wideFirst: true, seed: 8, viaCost: 60, fine: 2 },
  { wideFirst: true, failedFirst: true, viaCost: 14, fine: 3 },
  { thinFallback: true, viaCost: 14, fine: 2 },
]

/** A number in [0, 1) for a seed and a key, the same every time. */
function jitter(seed: number, key: string): number {
  let h = (2166136261 ^ Math.imul(seed, 0x9e3779b1)) >>> 0
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function polylineLength(points: Vec2[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return sum
}

/** How much of the board is narrower than its nets' widths, in mm. */
export function narrowedLength(r: Pick<AutorouteResult, "narrowed">): number {
  return (r.narrowed ?? []).reduce((sum, n) => sum + n.spans.reduce((a, sp) => a + sp.length, 0), 0)
}

/** Whether a routing leaves nothing to improve but its vias and length: everything routed, every net at its width. */
function clean(r: AutorouteResult): boolean {
  return r.remaining === 0 && !r.narrowed?.length
}

/**
 * Which of two routings of the same board is better, negative when `a` is: fewer connections open, then less length narrower than its
 * net's width (to 0.05 mm), then fewer vias, then less track (to 0.1 mm).
 */
export function compareResults(a: AutorouteResult, b: AutorouteResult): number {
  if (a.remaining !== b.remaining) return a.remaining - b.remaining
  const na = Math.round(narrowedLength(a) * 20)
  const nb = Math.round(narrowedLength(b) * 20)
  if (na !== nb) return na - nb
  if (a.addedVias !== b.addedVias) return a.addedVias - b.addedVias
  const length = (r: AutorouteResult) => Math.round(r.project.traces.reduce((sum, t) => sum + polylineLength(t.points), 0) * 10)
  return length(a) - length(b)
}

/**
 * Route open ratsnest connections. Signal nets go first, shortest connections first; pads of
 * nets with a pour then drop a via into the pour when they are not already in it; whatever is
 * still open is routed last. Existing copper is kept and avoided. Connections left open at
 * fine-pitch pads get another go in fine-pitch mode (see `attempt`).
 */
export function autoroute(project: Project, opts: AutorouteOptions = {}): AutorouteResult {
  const sch = computeConnectivity(project)
  const start = performance.now()
  const budget = opts.timeLimitMs ?? DEFAULT_BUDGET_MS
  const end = start + budget
  // With a time limit, the passes and their retries get most of it and the repair the rest, which takes up and lays again copper for the
  // connections still open (`repair` in `attempt`). A board that routes whole never gets to the repair, so it routes as it always did.
  const deadline = Number.isFinite(budget) && budget >= REPAIR_SHARE_FROM_MS ? start + budget * GREEDY_SHARE : end
  // Open connections at fine-pitch pads: a grid router can't leave a pad that is off its grid by a
  // fraction of a cell, and wide copper joining a connector's outer pads can seal in the rest. Fine-
  // pitch mode adds escape stubs, routes those nets first and uses thinner traces, which retrying as
  // before cannot do (it would give the same answer). Not when asked for some nets only: a caller
  // routing in stages expects the rest to wait. All of it is inside the one budget.
  const { report, analysis: firstAnalysis } = opts.nets ? { report: null, analysis: undefined } : fineReport(project, sch)
  const fineModes = (nets: Set<string>): AttemptMode[] =>
    [[true, false], [true, true], [false, false], [false, true]].map(([stagger, narrow]) => ({ fine: true, narrow, stagger, nets }))
  type Attempt = ReturnType<typeof attempt>
  // Only the best attempt is kept (the first of the fewest open): each holds its board, its analyses and, for the repair, its state, which on a
  // big board of four layers is hundreds of megabytes an attempt.
  let top: Attempt | null = null
  let fineTried = false
  let tries = 0
  /** The longest one attempt took, which says whether another fits in the time left. */
  let slowest = 0
  const best = (): Attempt => top!
  /** Run one attempt; true once something routed completely. */
  const run = (priority: Set<string>, mode?: AttemptMode) => {
    const t0 = performance.now()
    const a = attempt(project, sch, opts, priority, deadline, mode, firstAnalysis)
    slowest = Math.max(slowest, performance.now() - t0)
    tries++
    if (a.mode.fine) fineTried = true
    if (!top || a.result.remaining < top.result.remaining) top = a
    return a.result.remaining === 0
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
  let out: AttemptOutcome = best()
  const repairable = (r: AutorouteResult) => r.remaining > 0 && r.remaining <= Math.max(REPAIR_MAX_OPEN, REPAIR_MAX_SHARE * (r.routed + r.remaining))
  /** The longest a repair took: one of a variant runs when that fits, which on a small board is far under `REPAIR_MIN_MS`. */
  let slowestRepair = 0
  if (repairable(out.result) && end - performance.now() >= REPAIR_MIN_MS) {
    const t0 = performance.now()
    const repaired = best().repair(end)
    slowestRepair = performance.now() - t0
    if (repaired.result.remaining <= out.result.remaining) out = repaired
  }
  top = null
  // Other orders and via costs, while the best leaves a connection open or a net narrower (or, asked to optimize, while there is time), as
  // long as another attempt fits in the time left. A board that routes clean in the router's own order never gets here, so it routes as it
  // always did. Each variant routes in the mode the best did (fine-pitch stubs, if those were what routed it) or the fine-pitch mode it names, and is repaired when it leaves
  // a few open; its repair needs a router of its own, so it runs only with time for one (as long as the longest so far, which on a small board
  // is well under `REPAIR_MIN_MS`).
  if (opts.optimize || !clean(out.result)) {
    // A board left open gets the whole time limit. One routed whole with a net narrower somewhere is worth less of it: the search stops
    // after `EXPLORE_FACTOR` times what the router's own routing took, or `NARROW_PATIENCE` variants in a row that did no better.
    // With no time limit (the examples' build, which must come out the same on every machine) only `NARROW_PATIENCE` ends it.
    const flowMs = performance.now() - start
    const narrowUntil = Number.isFinite(budget) ? Math.min(end, performance.now() + Math.max(EXPLORE_MIN_MS, flowMs * EXPLORE_FACTOR)) : Infinity
    let stale = 0
    for (const v of VARIANTS) {
      if (!opts.optimize && clean(out.result)) break
      const narrowOnly = !opts.optimize && out.result.remaining === 0
      if (narrowOnly && stale >= NARROW_PATIENCE) break
      if ((narrowOnly ? narrowUntil : end) - performance.now() < slowest * 1.5 + 20) break
      const t0 = performance.now()
      const priority = v.failedFirst ? new Set(out.failed) : new Set<string>()
      const mode = out.mode.fine && v.fine !== undefined ? fineModes(out.mode.nets)[v.fine] : out.mode
      let a: AttemptOutcome & { repair?: (until: number) => AttemptOutcome } = attempt(project, sch, opts, priority, end, mode, firstAnalysis, v)
      tries++
      if (a.mode.fine) fineTried = true
      if (repairable(a.result) && a.repair && end - performance.now() >= Math.min(REPAIR_MIN_MS, (slowestRepair || slowest * 2) * 1.5 + 50)) {
        const r0 = performance.now()
        const repaired = a.repair(end)
        slowestRepair = Math.max(slowestRepair, performance.now() - r0)
        if (repaired.result.remaining <= a.result.remaining) a = repaired
      }
      slowest = Math.max(slowest, performance.now() - t0)
      if (compareResults(a.result, out.result) < 0) {
        out = a
        stale = 0
      } else stale++
    }
  }
  return { ...out.result, finePitchTried: fineTried ? widthLadder(project).at(-1)! : null, tries }
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
  /** Another order and via cost to route in (`VARIANTS`); none is the router's own. */
  variant?: Variant,
): AttemptOutcome & { repair: (until: number) => AttemptOutcome } {
  const signalW = project.rules.traceWidth
  const powerW = Math.max(signalW, opts.powerWidth ?? 0.4)
  const netWidths = project.rules.netWidths ?? {}
  // Net classes: each net's clearance, via size and, where its class names one, its trace width (`netClasses.ts`). With none this is the rules' own.
  const rr = new RouteRules(project, new Map(sch.nets.map((n) => [n.id, n.name])))
  const classes = classIndex(project.rules)
  const classWidth = (name: string | undefined): number | undefined => (rr.classed && name !== undefined ? classes.classOf(name)?.traceWidth : undefined)
  // In fine-pitch mode, narrower widths down to the board's minimum are tried last.
  const ladder = mode.fine ? widthLadder(project) : []
  /**
   * The widths below a net's own it may go at where it has no room for it, widest last: a half and a quarter of it, then the rules'
   * preferred widths, above `floor` (the supply width or the default).
   */
  const narrowerSteps = (own: number, floor: number) =>
    [...new Set([round(own / 2, 2), round(own / 4, 2), ...project.rules.preferredWidths].filter((w) => w < own - 1e-9 && w > floor + 1e-9))].sort((a, b) => b - a)
  const ownWidths = [...Object.values(netWidths), ...(rr.classed ? (project.rules.netClasses ?? []).flatMap((c) => (c.traceWidth !== undefined ? [c.traceWidth] : [])) : [])]
  // Every width `widthsFor` can give a net, so a router built for every net (fine-pitch mode, the repair) has the keepouts of each.
  const widths = [...new Set([signalW, powerW, ...ownWidths, ...ownWidths.flatMap((w) => narrowerSteps(w, signalW)), ...ladder])]
  // Widths to try for a net, widest first: its own width, the power width, then the default.
  // A connection that can't be made wide, e.g. into a small pad, falls back to the next. The
  // fine-pitch mode adds widths down to the board's minimum, but only for a signal net with no width of
  // its own: supply nets and nets the user gave a width keep it away from the pads.
  const nameOf = (netId: string) => sch.nets.find((n) => n.id === netId)?.name
  /** The width the net was given: by name, which wins over its class's, else its class's. A net with neither has none of its own. */
  const ownWidth = (netId: string) => {
    const name = nameOf(netId)
    return name !== undefined ? (netWidths[name] ?? classWidth(name)) : undefined
  }
  const widthsFor = (netId: string) => {
    const own = ownWidth(netId)
    const out = own !== undefined ? [own] : []
    const power = isPowerNet(sch, p, netId)
    // A net with a width of its own that has no room for it goes as wide as there is room for, not straight down to the default: a half
    // and a quarter of its width, then the rules' preferred widths, down to the supply width or the default (a 9 mm net across an 8 mm
    // board went at 0.25 mm).
    if (own !== undefined) out.push(...narrowerSteps(own, Math.max(signalW, power ? powerW : 0)))
    if (power && (own === undefined || own > powerW)) out.push(powerW)
    if (!out.includes(signalW) && (own === undefined || own > signalW)) out.push(signalW)
    if (ladder.length && own === undefined && !isPowerNet(sch, p, netId)) out.push(...ladder.filter((w) => w < Math.min(...out) - 1e-9))
    return out
  }
  /**
   * Connections of nets with a width of their own that went in narrower, for want of room: the width each took, the connection's ends
   * and, once laid, the ids of its traces and of those at the narrower width (a neck at a pad is none). The result names only those still
   * on the finished board: a rip-up can take one up and lay it again at full width.
   */
  const thin = new Map<RoutedPath, { netId: string; width: number; runIds: string[]; allIds: string[]; ends?: [Vec2, Vec2] }>()
  /** Every connection this run laid, with the ids its copper was given: what a repair may take up again. */
  const runPaths: { path: RoutedPath; traceIds: string[]; viaIds: string[] }[] = []
  const laid = (path: RoutedPath, traceIds: string[], viaIds: string[]) => {
    runPaths.push({ path, traceIds, viaIds })
    const t = thin.get(path)
    if (!t) return
    const runs = path.narrowIdx?.length ? path.narrowIdx.map((i) => traceIds[i]) : traceIds.filter((_, i) => path.traces[i].width >= t.width - 1e-9)
    t.runIds = runs.length ? runs : traceIds
    t.allIds = traceIds
  }
  /** Nets whose width the router holds to where it can: a width of their own, or a supply's. They neck down only where they must. */
  const holdsWidth = (netId: string) => ownWidth(netId) !== undefined || isPowerNet(sch, p, netId)
  /**
   * The connection routed at the first of `ws` it can be, widest first, or null. A net that holds its width and has no room for it all
   * the way is searched at its width and a narrower one at once (`Router.route` with `narrow`): full width where it fits, narrower only
   * for the stretch that has no room. That search finds every path a narrower width alone would, so when it fails nothing narrower helps.
   */
  const widest = (netId: string, ws: number[], go: (w: number, narrow?: number, dry?: boolean) => RoutedPath | null, ends?: [Vec2, Vec2]): RoutedPath | null => {
    const own = ownWidth(netId)
    for (let k = 0; k < ws.length; k++) {
      const w = ws[k]
      const path = go(w)
      if (path) {
        if (own !== undefined && w < own - 1e-9) thin.set(path, { netId, width: w, runIds: [], allIds: [], ends })
        return path
      }
      if (k === 0 && ws.length > 1 && holdsWidth(netId) && !variant?.thinFallback) {
        // With widths between, the narrowest is looked for first without laying it: when even it finds no way, no width does, and a failed
        // search is the costly kind. Then the widest that does is laid.
        const last = ws[ws.length - 1]
        if (ws.length > 2 && !go(w, last, true)) return null
        for (const nw of ws.slice(1)) {
          const mixed = go(w, nw)
          if (!mixed) continue
          if (own !== undefined && mixed.narrowIdx?.length) thin.set(mixed, { netId, width: nw, runIds: [], allIds: [], ends })
          return mixed
        }
        return null
      }
    }
    return null
  }
  const wanted = opts.nets ? new Set(opts.nets) : null
  const orderRank = new Map((opts.order ?? []).map((id, k) => [id, k]))
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
    for (const n of list) {
      const rule = rr.of(n)
      for (const width of widthsFor(n)) profiles.set(`${width}|${rule.clearance}|${rule.own ?? ""}`, { width, clearance: rule.clearance, ...(rule.own !== undefined && { own: rule.own }) })
    }
    // pads and drawings with no net keep the Default class's clearance from every trace, whatever its own
    return { profiles: [...profiles.values()], viaNets: list }
  }
  const everyNet = () => sch.nets.map((n) => n.id)
  // A board from KiCad holds every hole to KiCad's hole clearance, so the router needs the drill of each via already on it.
  const kicadHoles = fromKicad(project) && kicadHoleClearance(project) > 0
  const routerFor = (analysis: PcbAnalysis, obstacles = obstacleShapes(analysis, (rr.classed && mode.fine) || kicadHoles ? new Map(p.vias.map((v) => [v.id, v.drill])) : undefined), use?: { profiles: Profile[]; viaNets: (string | null)[] }) => {
    if (mode.fine && live?.p === p) {
      // Only a pass asks for the outer layers alone (`pass` sets it again): the steps after the first pass route on every layer.
      live.router.outerOnly = false
      return live.router
    }
    const chosen = mode.fine || !use ? useFor(everyNet(), widths) : use
    const router = new Router(p, obstacles, chosen.profiles, deadline - performance.now(), mode.fine, rr, chosen.viaNets)
    if (variant?.viaCost) router.viaCost = variant.viaCost
    for (const t of p.traces) if (stubIds.has(t.id)) router.stubKeys.add(stubKey(t))
    live = mode.fine ? { router, p } : null
    return router
  }
  /** The copper of the live router has been applied to the project. */
  const synced = () => {
    if (live) live.p = p
  }

  /** One pass over the open connections `select` picks; `outerOnly`, on the outer layers alone (`Router.outerOnly`). */
  const pass = (select: (netId: string) => boolean, outerOnly = false) => {
    if (late()) return 0
    const analysis = analyze()
    let router: Router | undefined
    const getRouter = () => {
      router ??= routerFor(analysis, undefined, useFor(lines.map((l) => l.netId), needed))
      router.outerOnly = outerOnly
      return router
    }
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
      .map((r) => {
        const widths = widthsFor(r.netId)
        const len = Math.hypot(r.a.x - r.b.x, r.a.y - r.b.y)
        const first = priority.has(r.netId) || fineNets.has(r.netId)
        // The nets the caller put first, in its order; then the nets that failed before and the fine-pitch ones; then (a variant's) the wide ones.
        const rank = orderRank.get(r.netId) ?? (first ? orderRank.size : variant?.wideFirst && widths[0] > signalW + 1e-9 ? orderRank.size + 1 : orderRank.size + 2)
        const key = variant?.longFirst ? -len : variant?.seed ? len * (0.4 + 1.2 * jitter(variant.seed, `${r.netId}|${r.a.x},${r.a.y}|${r.b.x},${r.b.y}`)) : len
        return { ...r, len, widths, first, rank, key }
      })
      .sort((x, y) => x.rank - y.rank || x.key - y.key)
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
      const path = widest(line.netId, line.widths, (w, nw, dry) => getRouter().route(line.netId, src, tgt, w, undefined, undefined, nw, dry), [line.a, line.b])
      if (!path) {
        // A search kept to the outer layers says nothing of what every layer allows, so the passes after it try again.
        if (!outerOnly) failedAt.set(key, addedBoxes.length)
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
    p = apply(p, paths, rr, laid)
    noteAdded(paths)
    synced()
    for (const path of paths) {
      addedTraces += path.traces.length
      addedVias += path.vias.length
    }
    return paths.length
  }

  /** Pads of poured nets that the pour does not reach get a short trace into it, on its layer or through a via. */
  const fanout = (only?: Set<string>, stillOpen: Vec2[] = []) => {
    if (!pourNets.size || late()) return 0
    const analysis = analyze()
    // By the router's layer index (`Router.layerIndex`), which is the board's copper layers in order.
    const layers = copperLayers(p.board)
    let router: Router | undefined
    const getRouter = () => (router ??= routerFor(analysis, undefined, useFor(pourNets, [...new Set([...pourNets].flatMap(widthsFor))])))
    const poured = new Set<number>()
    for (const it of analysis.items) if (it.kind === "zone") poured.add(analysis.island.get(it.id)!)
    const openEnds = [...analysis.ratsnest.flatMap((r) => [r.a, r.b]), ...stillOpen]
    const paths: RoutedPath[] = []
    for (const [netId, entry] of islandsByNet(analysis)) {
      if ((only && !only.has(netId)) || !pourNets.has(netId) || (wanted && !wanted.has(netId))) continue
      // The pieces of the net's fill on every copper layer: a via has copper on every layer, so a pour on an inner layer (a plane)
      // takes one as an outer pour does.
      const zones = new Set(analysis.zoneFills.filter((f) => f.netId === netId).map((f) => f.zoneId))
      const pieces = analysis.items.filter((it): it is Extract<CopperItem, { kind: "zone" }> => it.kind === "zone" && zones.has(it.zoneId) && layers.includes(it.layers[0]))
      if (!pieces.length) continue
      for (const [root, shapes] of entry.shapes) {
        if (late()) break
        const pad = shapes.find((s): s is Extract<Shape, { kind: "pad" }> => s.kind === "pad")
        if (!pad) continue
        // Fine-pitch mode looks again after more copper is down: a pad that already has its via keeps it.
        if (mode.fine && shapes.some((s) => s.kind === "via")) continue
        // A pad in a scrap of pour that joins nothing is as open as one outside it (fine-pitch mode).
        if (poured.has(root) && !(mode.fine && pad.layers.length === 1 && openEnds.some((e) => samePoint(e, pad.pad)))) continue
        // One search for the nearest piece of fill on any layer, but the one the pad is in (a scrap): a pad on a pour's own layer
        // joins it by a trace on that layer, rather than by a trace over it to the next pad, and any pad joins
        // another layer's by a via, whichever is nearer.
        const inFill = layers.map((layer) => {
          const tests = pieces.filter((it) => it.layers[0] === layer && analysis.island.get(it.id) !== root).map((it) => it.contains)
          return tests.length ? (q: Vec2) => tests.some((t) => t(q)) : null
        })
        if (!inFill.some(Boolean)) continue
        const path = widest(netId, widthsFor(netId), (w, nw, dry) => getRouter().route(netId, shapes, null, w, { inFill }, undefined, nw, dry), [pad.pad, pad.pad])
        if (path) {
          paths.push(path)
          routed++
        }
      }
    }
    p = apply(p, paths, rr, laid)
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
      const stub = escapeStub(router, obstacles, it, mates, net, Math.min(widthsFor(net)[0] ?? signalW, signalW), ladder, mode.narrow, mode.stagger && turn.get(it.id)! % 2 === 1, (other, shape) => rr.gap(rr.of(net), other, shape))
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
  // The first pass keeps to the outer layers, as fast as a board of two; the passes after it route what it left on every layer.
  pass((net) => !pourNets.has(net) || priority.has(net) || fineNets.has(net) || orderRank.has(net), copperLayers(project.board).length > 2)
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
        const path = widest(r.netId, widthsFor(r.netId), (w, nw, dry) => router.route(r.netId, padShapes(pa), padShapes(pb), w, undefined, undefined, nw, dry), [r.a, r.b])
        if (path) forced.push(path)
      }
      p = apply(p, forced, rr, laid)
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

  /** The result as the board stands: copper the retries left connecting nothing taken up (fine-pitch mode), what is still open, what went in narrower. */
  const finish = (): AttemptOutcome => {
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
    const byId = new Map(p.traces.map((t) => [t.id, t]))
    const lengthOf = (ids: string[]) => ids.reduce((sum, id) => sum + polylineLength(byId.get(id)?.points ?? []), 0)
    const narrowed = new Map<string, NarrowSpan[]>()
    for (const t of thin.values()) {
      const live = t.runIds.filter((id) => byId.has(id))
      if (!live.length) continue
      const firstPiece = byId.get(live[0])!
      const lastPiece = byId.get(live[live.length - 1])!
      const all = t.allIds.filter((id) => byId.has(id))
      const ends = t.ends ?? [firstPiece.points[0], lastPiece.points[lastPiece.points.length - 1]]
      const span: NarrowSpan = {
        width: t.width,
        length: round(lengthOf(live), 2),
        total: round(Math.max(lengthOf(all), lengthOf(live)), 2),
        a: ends[0],
        b: ends[1],
        from: firstPiece.points[0],
        to: lastPiece.points[lastPiece.points.length - 1],
        layer: firstPiece.layer,
      }
      narrowed.set(t.netId, [...(narrowed.get(t.netId) ?? []), span])
    }
    const narrower = [...narrowed].map(([netId, spans]) => ({ net: nameOf(netId) ?? netId, width: ownWidth(netId)!, widths: spans.map((x) => x.width), spans }))
    const isFineEnd = (at: Vec2) => finePads.some((x) => samePoint(at, x.pad) && isFinePad(x, finePads))
    const openList: OpenConnection[] = open.map((r) => ({ net: nameOf(r.netId) ?? r.netId, netId: r.netId, a: r.a, b: r.b, fine: isFineEnd(r.a) || isFineEnd(r.b) }))
    return {
      result: {
        project: p,
        routed,
        remaining: open.length,
        addedTraces,
        addedVias,
        finePitchOpen: fineOpen,
        finePitchTried: mode.fine ? widthLadder(project).at(-1)! : null,
        ...(narrower.length ? { narrowed: narrower } : {}),
        open: openList,
        tries: 1,
      },
      failed: [...new Set(open.map((r) => r.netId))],
      fineOpen,
      mode,
    }
  }

  /**
   * The repair, after the passes, while there is time: each connection still open is searched again, crossing copper this run laid for other
   * nets at a cost per cell (`SoftCost`) instead of keeping clear of it. The connections whose copper the path found comes within a keepout of
   * are taken up, the path is laid, and those connections are routed again around it. The change stays only when fewer connections are open
   * than before it; else the board is put back as it was and the cells of the crossing cost more for the next try (history), so it looks
   * elsewhere. Copper the board had before, escape stubs and locked copper are never taken up. One router serves the whole repair: the run's
   * copper is kept apart in it (`Router.laid`), so taking some up is a count down, not a new router.
   */
  const repair = (until: number): AttemptOutcome => {
    if (performance.now() > until) return finish()
    const openLines = (a: PcbAnalysis) => a.ratsnest.filter((r) => !wanted || wanted.has(r.netId))
    let an = analyze()
    let open = openLines(an).length
    if (!open) return finish()
    const onBoard = { traces: new Set(p.traces.map((t) => t.id)), vias: new Set(p.vias.map((v) => v.id)) }
    interface Taken {
      net: string
      path: RoutedPath
      traceIds: string[]
      viaIds: string[]
      shapes: Shape[]
      box: Box
      live: boolean
    }
    const laidList: Taken[] = []
    const use = useFor(everyNet(), widths)
    const own = new Set<string>()
    for (const rp of runPaths) {
      if (!rp.path.net || !rp.traceIds.every((id) => onBoard.traces.has(id)) || !rp.viaIds.every((id) => onBoard.vias.has(id))) continue
      for (const id of [...rp.traceIds, ...rp.viaIds]) own.add(id)
    }
    const drills = kicadHoles || rr.classed ? new Map(p.vias.map((v) => [v.id, v.drill])) : undefined
    const fixed = obstacleShapes(an, drills, (it) => (it.kind === "segment" && own.has(it.traceId)) || (it.kind === "via" && own.has(it.viaId)))
    // In fine-pitch mode, as the passes' router does, a new via keeps its drill clear of every other via's.
    const router = new Router(p, fixed, use.profiles, until - performance.now(), mode.fine, rr, use.viaNets, true)
    if (variant?.viaCost) router.viaCost = variant.viaCost
    for (const t of p.traces) if (stubIds.has(t.id)) router.stubKeys.add(stubKey(t))
    const take = (rp: { path: RoutedPath; traceIds: string[]; viaIds: string[] }): Taken => {
      const shapes = router.pathShapes(rp.path.net!, rp.path)
      const box = shapes.map(shapeBox).reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }))
      return { net: rp.path.net!, path: rp.path, traceIds: rp.traceIds, viaIds: rp.viaIds, shapes, box, live: true }
    }
    for (const rp of runPaths) {
      if (!rp.path.net || !rp.traceIds.every((id) => onBoard.traces.has(id)) || !rp.viaIds.every((id) => onBoard.vias.has(id))) continue
      const t = take(rp)
      for (const s of t.shapes) router.addShape(s, t.net, true)
      laidList.push(t)
    }
    const margin = router.keepMargin
    const holeNeed = kicadHoles ? kicadHoleClearance(project) : 0
    /** Edge to edge, between two pieces of copper a router lays. */
    const apart = (a: Shape, b: Shape): number => {
      const half = (s: Shape) => (s.kind === "segment" ? s.width / 2 : s.kind === "via" ? s.diameter / 2 : 0)
      if (a.kind === "segment" && b.kind === "segment") return segmentSegmentDistance(a.a, a.b, b.a, b.b) - half(a) - half(b)
      if (a.kind === "segment" && b.kind === "via") return pointSegmentDistance(b.at, a.a, a.b) - half(a) - half(b)
      if (a.kind === "via" && b.kind === "segment") return pointSegmentDistance(a.at, b.a, b.b) - half(a) - half(b)
      if (a.kind === "via" && b.kind === "via") return Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) - half(a) - half(b)
      return Infinity
    }
    /** From a via's hole to a piece of copper (KiCad's hole clearance). */
    const fromHole = (v: Shape, b: Shape): number => {
      if (v.kind !== "via" || !v.drill) return Infinity
      return apart({ kind: "via", at: v.at, diameter: v.drill, layers: v.layers }, b)
    }
    const tooClose = (netA: string, a: Shape, netB: string, b: Shape): boolean => {
      if (!a.layers.some((l) => b.layers.includes(l))) return false
      if (apart(a, b) < rr.gap(rr.of(netA), netB) + margin) return true
      return holeNeed > 0 && (fromHole(a, b) < holeNeed + margin || fromHole(b, a) < holeNeed + margin)
    }
    /** The laid connections of other nets that a path's copper comes within a keepout of. */
    const crossed = (net: string, shapes: Shape[]): number[] => {
      const reach = 2 + holeNeed
      const box = shapes.map(shapeBox).reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }))
      const near = { minX: box.minX - reach, minY: box.minY - reach, maxX: box.maxX + reach, maxY: box.maxY + reach }
      const out: number[] = []
      laidList.forEach((t, k) => {
        if (!t.live || t.net === net || !boxesOverlap(t.box, near)) return
        if (t.shapes.some((b) => shapes.some((a) => tooClose(net, a, t.net, b)))) out.push(k)
      })
      return out
    }
    /** Route what is open on `nets` with the router as it stands, joining islands as they connect. */
    const routeOpen = (nets: Set<string>): { paths: RoutedPath[]; before: number } => {
      const a = analyze()
      const islands = islandsByNet(a)
      const parent = new Map<number, number>()
      const find = (x: number): number => {
        let r = x
        while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
        return r
      }
      const lines = openLines(a)
        .filter((r) => nets.has(r.netId))
        .sort((x, y) => Math.hypot(x.a.x - x.b.x, x.a.y - x.b.y) - Math.hypot(y.a.x - y.b.x, y.a.y - y.b.y))
      const paths: RoutedPath[] = []
      for (const line of lines) {
        if (performance.now() > until) break
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
        const path = widest(line.netId, widthsFor(line.netId), (w, nw, dry) => router.route(line.netId, src, tgt, w, undefined, undefined, nw, dry), [line.a, line.b])
        if (!path) continue
        paths.push(path)
        parent.set(ca, cb)
        entry.shapes.set(cb, [...tgt, ...src, ...router.pathShapes(line.netId, path)])
        entry.shapes.delete(ca)
      }
      return { paths, before: openLines(a).length }
    }
    const history = router.newHistory()
    const soft: SoftCost = { penalty: SOFT_PENALTY, history }
    const tries = new Map<string, number>()
    let progress = true
    while (progress && performance.now() < until && open) {
      progress = false
      an = analyze()
      const islands = islandsByNet(an)
      const lines = openLines(an).sort((x, y) => Math.hypot(x.a.x - x.b.x, x.a.y - x.b.y) - Math.hypot(y.a.x - y.b.x, y.a.y - y.b.y))
      for (const line of lines) {
        if (performance.now() > until) break
        const key = `${line.netId}|${line.a.x},${line.a.y}|${line.b.x},${line.b.y}`
        const tried = tries.get(key) ?? 0
        if (tried >= REPAIR_TRIES) continue
        tries.set(key, tried + 1)
        const entry = islands.get(line.netId)
        if (!entry) continue
        const ra = islandAt(entry, line.a)
        const rb = islandAt(entry, line.b)
        if (ra === null || rb === null || ra === rb) continue
        const src = entry.shapes.get(ra) ?? []
        const tgt = entry.shapes.get(rb) ?? []
        let path: RoutedPath | null = null
        let pathWidth = 0
        for (const w of widthsFor(line.netId)) {
          path = router.route(line.netId, src, tgt, w, undefined, soft)
          pathWidth = w
          if (path) break
        }
        if (!path) continue
        // Laid narrower than its net's own width, it is a narrowing like any the passes make (`widest`).
        const own = ownWidth(line.netId)
        if (own !== undefined && pathWidth < own - 1e-9) thin.set(path, { netId: line.netId, width: pathWidth, runIds: [], allIds: [], ends: [line.a, line.b] })
        const shapes = router.pathShapes(line.netId, path)
        const hit = crossed(line.netId, shapes)
        if (hit.length > MAX_RIPPED) {
          router.bumpHistory(history, path, HISTORY_STEP)
          continue
        }
        const snapshot = { p, routed, addedTraces, addedVias }
        const mark = runPaths.length
        // Take up what the path crosses, lay it, and route again what was taken up.
        const dropT = new Set<string>()
        const dropV = new Set<string>()
        for (const k of hit) {
          const t = laidList[k]
          t.live = false
          for (const s of t.shapes) router.removeLaid(s, t.net)
          for (const id of t.traceIds) dropT.add(id)
          for (const id of t.viaIds) dropV.add(id)
        }
        p = { ...p, traces: p.traces.filter((t) => !dropT.has(t.id)), vias: p.vias.filter((v) => !dropV.has(v.id)) }
        addedTraces -= dropT.size
        addedVias -= dropV.size
        routed -= hit.length
        router.commit(line.netId, path)
        p = apply(p, [path], rr, laid)
        routed++
        addedTraces += path.traces.length
        addedVias += path.vias.length
        const again = routeOpen(new Set(hit.map((k) => laidList[k].net)))
        p = apply(p, again.paths, rr, laid)
        routed += again.paths.length
        for (const q of again.paths) {
          addedTraces += q.traces.length
          addedVias += q.vias.length
        }
        // Each connection routed again joins two islands, one line fewer.
        const left = again.before - again.paths.length
        if (left < open) {
          open = left
          for (const rp of runPaths.slice(mark)) laidList.push(take(rp))
          progress = true
          break
        }
        // Put it all back as it was.
        router.uncommit(line.netId, path)
        for (const q of again.paths) router.uncommit(q.net!, q)
        for (const k of hit) {
          const t = laidList[k]
          t.live = true
          for (const s of t.shapes) router.addShape(s, t.net, true)
        }
        runPaths.length = mark
        ;({ p, routed, addedTraces, addedVias } = snapshot)
        router.bumpHistory(history, path, HISTORY_STEP)
      }
    }
    return finish()
  }

  // The passes are done: the router fine-pitch mode kept from step to step goes (a repair makes its own).
  live = null
  return { ...finish(), repair }
}
