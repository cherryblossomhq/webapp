import type { Box } from "../../lib/geometry"
import { naturalCompare } from "../../lib/natural"
import { findPart } from "../library"
import type { ComponentInstance, Rotation, Vec2 } from "../types"
import type { NetInfo } from "./nets"
import { along, BEND, corners, Heap, route, type RouteStart, type RouteTarget } from "./route"
import {
  allowedTurns,
  isBoxPart,
  DIRS,
  isVertical,
  labelShape,
  labelTurn,
  OPPOSITE,
  partShape,
  portShape,
  shift,
  VEC,
  world,
  type Dir,
  type PartShape,
  type RailKind,
} from "./shapes"
import { boxesTouch, inflate, nodeKey, nodeX, nodeY, Space, type Item, type ItemKind } from "./space"

// One cluster of a block laid out on its own (`clusters.ts` splits a block into them), about its
// main part: the chip goes in the middle, then its decoupling capacitors in rows above it, then
// chains on neighbouring pins fanned out into columns, then every other part next to what it
// connects to, nearest first, at the spot that costs least. Every candidate spot is tried for
// real: the part is drawn there, its wires are routed and its labels and ports found room for, and
// the spot is refused if anything would touch something already drawn. So a cluster comes out
// with nothing overlapping and no wire crossing another, whatever the circuit; a part nothing near
// can take goes further out, unwired, its nets reached by labels.
//
// - Supply rails are not wired: each pin on one gets a power or ground port, pointing up or down
//   where the pin allows, on a short stub that turns aside where it must. Never a label. The
//   exception is a supply the block wires (`wiredSupplyPins`): its pins are wired like a signal's,
//   and each wired piece gets one port where a signal's would get a label.
// - Other nets are wired between the cluster's own pins, as short as they can be; a net that also
//   leaves the cluster, that has a name, or that couldn't be wired whole gets a label on each of
//   its pieces. A net still waiting for parts keeps room for a label meanwhile.
// - Pins side by side on one net are joined first by a short comb, which then takes one port or
//   label for all of them.
// - Some parts are drawn to a pattern about their chip first (templates): a crystal and its load
//   capacitors, a 555's timing parts, a pull-up and button on one pin, a supply's capacitors on
//   its wire. A pattern that doesn't draw whole leaves its parts to be placed like any other.

export interface BlockContext {
  nets: NetInfo
  /** Whether a net has pins outside this block, so it needs a label to reach them. */
  external: (net: string) => boolean
  /** The text of a net's labels. Names an unnamed net the first time it is asked. */
  labelName: (net: string) => string
  /** The way a label of this net would rather run: in from the left, out to the right. */
  facing?: (net: string) => Dir | null
  /** Supply pins, as "componentId:pin", wired like a signal's rather than given a port each. */
  wired?: (key: string) => boolean
  /** A net's other names, which it had before and keeps: each drawn as a label of its own. */
  aliases?: (net: string) => string[]
}

export interface DrawnLabel {
  /** The net the label is on, by id, and the text it shows. */
  net: string
  name: string
  x: number
  y: number
  rot: Rotation
}

export interface DrawnPort {
  partId: "power" | "ground"
  /** The net, by id, and the name the port shows. */
  net: string
  name: string
  /** The port's origin, in world units. */
  x: number
  y: number
  rot: Rotation
}

export interface BlockDrawing {
  /** Where each part goes and how it is turned, in world units about the block's main part. */
  parts: Map<string, { x: number; y: number; rot: Rotation }>
  wires: { net: string; points: Vec2[] }[]
  labels: DrawnLabel[]
  ports: DrawnPort[]
  /** The box around everything drawn, in world units. */
  extent: Box
}

type Pt = [number, number]

interface PinState {
  comp: string
  pin: string
  x: number
  y: number
  dir: Dir
  /** Net id, or null for a pin on nothing. */
  net: string | null
  kind: "signal" | "rail" | "free"
  /** A wire already ends here. */
  wired: boolean
}

interface Slot {
  /** From the wire or pin it hangs on to the label's point. */
  stub: Pt[]
  dir: Dir
  items: number[]
  /** Its stub is drawn as a wire already (a label found by `escape`), to be taken out with it. */
  wire?: boolean
}

interface Group {
  net: string
  pins: PinState[]
  /** Each wire as its run of grid points. */
  wires: Pt[][]
  slot: Slot | null
  /** Labels of the net's other names, which go with the slot of one group of the net. */
  extra?: { name: string; slot: Slot }[]
}

/** What an attempt changed, to put back if it is undone. */
interface Tx {
  groups: Map<string, Group[]>
  placed: string[]
  rails: number
  pinStates: string[]
}

/** How a cluster is drawn; see the constructor. */
export type LayoutStyle = "full" | "plain" | "first"

/** Where a template puts a part. */
interface Spot {
  c: ComponentInstance
  x: number
  y: number
  rot: Rotation
}

interface RailTerminal {
  net: string
  wires: Pt[][]
  port?: { kind: RailKind; at: Pt; out: Dir }
}

/** Room left between unrelated things. */
const GAP = 0.4
/** Between labels, ports and slots: labels on neighbouring pins sit 0.03 apart. */
const GAP_TERMINAL = 0.2
/** Wires keep this far from text and drawings. */
const WIRE_CLEAR = 0.5

const W_GROW = 0.6
const W_FAIL = 80
const W_ORIENT = 8
const W_DIST = 0.3
/** Spots drawn for a part that goes unwired before giving up on the tidy. */
const MAX_UNWIRED = 400
/** How far from what it connects to a part is looked for. */
const REACH = 10
/** Spots tried for one part before taking the best so far. */
const MAX_TRIES = 4
/** Spots wired, whole or not, before taking the best so far. */
const MAX_WIRED = 14
/** Spots looked at for one part, most of them refused at once, before taking the best so far. */
const MAX_LOOKS = 10000
/** Arrangements of one template drawn, before its parts are placed like any other. */
const MAX_TEMPLATE_TRIES = 24
/** Arrangements of one template looked at, most of them on top of something, before the same. */
const MAX_TEMPLATE_LOOKS = 400
/** How far round a template's parts the main part's labels and ports are moved out of its way. */
const TEMPLATE_REACH = 6

const isTerminalKind = (k: ItemKind) => k === "label" || k === "port" || k === "slot"
const isPinKind = (k: ItemKind) => k === "tip" || k === "exit"

/** Whether two items may not overlap. */
function clash(a: { kind: ItemKind; net: string | null; owner: string }, b: Item): boolean {
  if (a.owner === b.owner) {
    if (a.kind === "body" || b.kind === "body") return false
    if (a.kind === "mark" || b.kind === "mark") return false
    if (a.kind === "text" && b.kind === "text") return false
    if (isPinKind(a.kind) || isPinKind(b.kind)) return false
    if (a.net && a.net === b.net) return false
    return true
  }
  if (a.net && a.net === b.net) {
    if (isPinKind(a.kind) && (isPinKind(b.kind) || isTerminalKind(b.kind))) return false
    if (isPinKind(b.kind) && isTerminalKind(a.kind)) return false
  }
  return true
}

function gapFor(a: ItemKind, b: ItemKind, first: boolean) {
  if (isPinKind(a) || isPinKind(b)) return 0
  // A port beside a label on the next pin: a port is a little taller than a label is high.
  if ((a === "port") !== (b === "port") && isTerminalKind(a) && isTerminalKind(b)) return 0.1
  if (isTerminalKind(a) && isTerminalKind(b)) return GAP_TERMINAL
  // Drawn as first, a label or port may come closer to a no-connect cross than to anything else.
  if (first && ((isTerminalKind(a) && b === "mark") || (isTerminalKind(b) && a === "mark"))) return GAP_TERMINAL
  return GAP
}

const union = (a: Box | null, b: Box): Box =>
  a ? { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) } : { ...b }
/** How much a box grows the width plus height of another. */
const growth = (a: Box | null, b: Box) => {
  if (!a) return b.maxX - b.minX + (b.maxY - b.minY)
  const u = union(a, b)
  return u.maxX - u.minX + (u.maxY - u.minY) - (a.maxX - a.minX + (a.maxY - a.minY))
}
const ptBox = (x: number, y: number): Box => ({ minX: x, minY: y, maxX: x, maxY: y })
const sq = (x: number, y: number, r: number): Box => ({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r })
const byRef = (a: ComponentInstance, b: ComponentInstance) => naturalCompare(a.ref, b.ref)

/** Every order of a few items; just the given order past three. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1 || items.length > 3) return [items]
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]))
}

/** A small part wired to the pins it serves: a passive, a diode, a transistor, a crystal. */
const isHelper = (c: ComponentInstance) => {
  const part = findPart(c.partId)
  return !!part && !isBoxPart(part) && part.pins.length >= 2
}

/** Visits candidates cheapest first without sorting them all: their costs are small numbers. */
class Buckets<T> {
  private b: T[][] = []
  private lo = Infinity
  size = 0
  add(cost: number, v: T) {
    const i = Math.max(0, Math.floor(cost * 4))
    ;(this.b[i] ??= []).push(v)
    this.lo = Math.min(this.lo, i)
    this.size++
  }
  /** The cheapest left and a lower bound of its cost, in the order added among equals. */
  next(): { v: T; lb: number } | null {
    for (let i = Number.isFinite(this.lo) ? this.lo : this.b.length; i < this.b.length; i++) {
      const bucket = this.b[i]
      if (bucket?.length) {
        this.lo = i
        return { v: bucket.shift()!, lb: i / 4 }
      }
    }
    return null
  }
}

export class BlockLayout {
  readonly space = new Space()
  private groups = new Map<string, Group[]>()
  private placed = new Map<string, { x: number; y: number; rot: Rotation }>()
  private pinStates = new Map<string, PinState[]>()
  private rails: RailTerminal[] = []
  private bbox: Box | null = null
  /** During an attempt: what to put back if it is undone. */
  private tx: Tx | null = null
  /** Attempts kept inside larger ones (a whole fan, a template), so they can all be undone. */
  private outer: { txs: Tx[]; mark: number; bbox: Box | null }[] = []
  /** During an attempt: the box around what it has drawn. */
  private drawn: Box | null = null
  private parts: Map<string, ComponentInstance>
  /** Supply pins already given a decoupling part to sit beside, by net. */
  private railUse = new Map<string, number>()
  private affinityCache = new Map<string, Pt>()
  /** The last attempt couldn't draw one of the wires it needed. */
  private partial = false
  /** Ports only straight out of their pins, the rail's way: decoupling rows keep to that. */
  private straightRails = false
  /** Place without wiring: the last resort, where only labels reach. */
  private noWire = false
  /** Why the last attempt failed. */
  private why = ""
  /** The last attempt got as far as wiring. */
  private wired = false
  /** While a net's other name is drawn: the text of its label. */
  private alias: string | null = null
  /** Labels only where they read across, ports only not upside down: while a template is drawn. */
  private acrossOnly = false
  /** Ports on a pin on a side turned aside first, as before a port stood up on a stub: the fallback. */
  private sidewaysFirst = false

  private fail(what: string): null {
    this.why = `no room for ${what}`
    return null
  }

  constructor(
    parts: ComponentInstance[],
    private ctx: BlockContext,
    /**
     * How it is drawn: "full", with templates, ports standing up on stubs and labels turned off
     * wires; "plain", the same without templates; "first", as Tidy drew before any of that. A
     * cluster that can't be drawn one way is drawn the next.
     */
    private style: LayoutStyle = "full",
  ) {
    this.parts = new Map([...parts].sort(byRef).map((c) => [c.id, c]))
  }

  // ---------- Nets of pins ----------

  private kinds = new Map<string, { net: string | null; kind: PinState["kind"] }>()
  private pinKind(c: ComponentInstance, pin: string): { net: string | null; kind: PinState["kind"] } {
    const key = `${c.id}:${pin}`
    let hit = this.kinds.get(key)
    if (!hit) this.kinds.set(key, (hit = this.kindOf(key)))
    return hit
  }

  private kindOf(key: string): { net: string | null; kind: PinState["kind"] } {
    const net = this.ctx.nets.pinNet.get(key) ?? null
    if (!net) return { net: null, kind: "free" }
    const info = this.ctx.nets.nets.get(net)!
    if (info.rail) return { net, kind: this.ctx.wired?.(key) ? "signal" : "rail" }
    // A pin alone on an unnamed net is on nothing.
    if (!info.named && info.pins.length === 1) return { net: null, kind: "free" }
    return { net, kind: "signal" }
  }

  /** A supply: its wired pieces end in a port, not a label. */
  private isSupply(net: string) {
    return !!this.ctx.nets.nets.get(net)!.rail
  }

  /**
   * A piece's terminal at a point, running `dir`: its label, or a supply's port pointing that way.
   * The ids of what it put, or null when it doesn't fit (the caller rolls back).
   */
  private putTerminal(net: string, x: number, y: number, dir: Dir): number[] | null {
    const info = this.ctx.nets.nets.get(net)!
    const owner = `flag:${net}:${x},${y}`
    if (!info.rail || this.alias) {
      const id = this.put(shift(labelShape(this.alias ?? this.ctx.labelName(net), dir), x, y), "slot", owner, net)
      return id === null ? null : [id]
    }
    const ps = portShape(info.rail, info.name, dir)
    const body = this.put(shift(ps.body, x, y), "slot", owner, net)
    if (body === null) return null
    const text = this.put(shift(ps.text, x, y), "slot", owner, net)
    return text === null ? null : [body, text]
  }

  /** What a terminal running `dir` costs beyond its stub: a label read sideways, a port the wrong way. */
  private terminalCost(net: string, dir: Dir): number {
    const rail = this.alias ? null : this.ctx.nets.nets.get(net)!.rail
    if (!rail) {
      const prefer = this.ctx.facing?.(net) ?? null
      return (isVertical(dir) ? 3 : 0) + (prefer && prefer !== dir ? 1.5 : 0)
    }
    const canonical: Dir = rail === "ground" ? "down" : "up"
    return dir === canonical ? 0 : dir === OPPOSITE[canonical] ? 12 : 2
  }

  /** Whether a terminal of the net running `dir` reads across: a label not up or down, a port not upside down. */
  private across(net: string, dir: Dir): boolean {
    const rail = this.alias ? null : this.ctx.nets.nets.get(net)!.rail
    if (!rail) return !isVertical(dir)
    return dir !== (rail === "ground" ? "up" : "down")
  }

  /** Every group of a named net, a net leaving the cluster, or a net split in pieces has a label. */
  private needsLabel(net: string, final = false) {
    const info = this.ctx.nets.nets.get(net)!
    // While parts are placed, a name Tidy gave the net last time counts for nothing, so this tidy
    // places them as that one did; once all are placed, every group of a named net gets its label.
    // Drawn as before, every name counts throughout.
    return (final || this.style === "first" ? info.named : info.given) || this.ctx.external(net) || (this.groups.get(net)?.length ?? 0) > 1 || this.pending(net)
  }

  /**
   * Whether parts of the block on this net are still to be placed. Its pins keep room for a label
   * meanwhile, so a part that can't be wired in later can still be reached.
   */
  private pending(net: string) {
    return this.ctx.nets.nets.get(net)!.pins.some((k) => {
      const id = k.slice(0, k.lastIndexOf(":"))
      return this.parts.has(id) && !this.placed.has(id)
    })
  }

  private orientPenalty(c: ComponentInstance, shape: PartShape): number {
    let p = 0
    let signals = 0
    for (const pin of shape.pins) {
      const { net, kind } = this.pinKind(c, pin.pin)
      if (kind === "signal") signals++
      if (kind !== "rail" || !net) continue
      const want: Dir = this.ctx.nets.nets.get(net)!.rail === "ground" ? "down" : "up"
      if (pin.dir === want) continue
      // A port turned upside down reads worse than two turned aside.
      p += pin.dir === OPPOSITE[want] ? W_ORIENT * 2.5 : W_ORIENT
    }
    // Two-terminal parts in a signal path lie across.
    if (shape.pins.length === 2 && signals === 2 && isVertical(shape.pins[0].dir)) p += 2
    return p
  }

  // ---------- Attempts, and undoing them ----------

  private begin() {
    this.tx = { groups: new Map(), placed: [], rails: this.rails.length, pinStates: [] }
    this.drawn = null
    return this.space.mark()
  }

  private undo(mark: number) {
    this.space.rollback(mark)
    this.revert(this.tx!)
    this.tx = null
    this.drawn = null
  }

  private revert(tx: Tx) {
    for (const [net, old] of tx.groups) {
      if (old) this.groups.set(net, old)
      else this.groups.delete(net)
    }
    for (const id of tx.placed) this.placed.delete(id)
    for (const id of tx.pinStates) this.pinStates.delete(id)
    this.rails.length = tx.rails
  }

  private keep() {
    const o = this.outer[this.outer.length - 1]
    if (o) o.txs.push(this.tx!)
    else this.space.commit()
    if (this.drawn) this.bbox = union(this.bbox, this.drawn)
    this.tx = null
    this.drawn = null
  }

  /** Begin attempts that stand or fall together; inside others, they fall with those too. */
  private beginAll() {
    this.outer.push({ txs: [], mark: this.space.mark(), bbox: this.bbox && { ...this.bbox } })
  }

  /** Keep them all, or undo them all. */
  private endAll(keep: boolean) {
    const o = this.outer.pop()!
    const parent = this.outer[this.outer.length - 1]
    if (keep) {
      if (parent) parent.txs.push(...o.txs)
      else this.space.commit()
      return
    }
    this.space.rollback(o.mark)
    for (const tx of [...o.txs].reverse()) this.revert(tx)
    this.bbox = o.bbox
  }

  /** The groups of a net, copied on first touch inside an attempt so it can be undone. */
  private touch(net: string): Group[] {
    const cur = this.groups.get(net)
    if (this.tx && !this.tx.groups.has(net)) {
      this.tx.groups.set(net, cur as Group[])
      const copy = (cur ?? []).map((g) => ({ ...g, pins: g.pins.map((p) => ({ ...p })), wires: [...g.wires] }))
      this.groups.set(net, copy)
      return copy
    }
    if (!cur) this.groups.set(net, [])
    return this.groups.get(net)!
  }

  private grow(b: Box) {
    this.drawn = union(this.drawn, b)
  }

  // ---------- Drawing into the space ----------

  /** Add an item if it touches nothing it may not; its id, or null. */
  private put(box: Box, kind: ItemKind, owner: string, net: string | null): number | null {
    const probe = { kind, net, owner }
    // A port or label of a part's own pin may stand right at its drawing.
    const railAt = kind === "port" || kind === "label" ? owner.indexOf(":rail:") : -1
    const ownPart = railAt > 0 ? owner.slice(0, railAt) : ""
    const gap = (it: Item) => (ownPart && it.owner === ownPart && it.kind === "body" ? 0.05 : gapFor(kind, it.kind, this.style === "first"))
    if (this.space.some(box.minX - GAP, box.minY - GAP, box.maxX + GAP, box.maxY + GAP, (it) => clash(probe, it) && boxesTouch(box, it.box, gap(it)))) {
      return null
    }
    const solid = kind === "body" || kind === "text" || kind === "mark"
    if (this.space.wireIn(isPinKind(kind) ? box : inflate(box, 0.3), solid ? "\u0000" : net)) return null
    // A label or port lies off its own wires, touching them only at its point.
    if ((kind === "label" || kind === "slot" || kind === "port") && this.ownWireInside(box)) return null
    const id = this.space.add(box, kind, owner, net)
    if (kind !== "exit") this.grow(box)
    return id
  }

  /**
   * Whether a symbol's drawing could go here at all: nothing solid touches it, no wire runs
   * through. With `unless`, the labels and ports of those nets, and the wires to them, are taken
   * as gone (a template's look before it moves them), so only what stays is asked about.
   */
  private roomFor(box: Box, unless?: Set<string>): boolean {
    const g = GAP
    const skip = (it: Item) => it.kind === "exit" || it.kind === "tip" || (!!unless && it.kind === "slot" && !!it.net && unless.has(it.net))
    if (this.space.some(box.minX - g, box.minY - g, box.maxX + g, box.maxY + g, (it) => !skip(it) && boxesTouch(box, it.box, isTerminalKind(it.kind) ? GAP_TERMINAL : g))) return false
    return !!unless || !this.space.wireIn(box, "\u0000")
  }

  /** Whether any wire, its own net's included, runs into the box anywhere but along its edge. */
  private ownWireInside(box: Box): boolean {
    return this.space.wireIn(inflate(box, -0.01), "\u0000")
  }

  /**
   * Whether a wire of `net` may not pass a grid point: another wire is there, or a pin's end or
   * front, or it is too near text, a symbol, a label or a port. `allow` lets through given points.
   */
  private blockedFor(net: string, x: number, y: number, allow?: Set<number>): boolean {
    const k = nodeKey(x, y)
    if (allow?.has(k)) return false
    if (this.space.nodes.has(k)) return true
    const e = 1e-6
    return this.space.some(x - WIRE_CLEAR, y - WIRE_CLEAR, x + WIRE_CLEAR, y + WIRE_CLEAR, (it) => {
      const b = it.box
      if (isPinKind(it.kind)) return x > b.minX - e && x < b.maxX + e && y > b.minY - e && y < b.maxY + e
      if (it.kind === "slot" && it.net === net && it.owner.startsWith("slot:")) return false
      const r = WIRE_CLEAR + e
      return x > b.minX - r && x < b.maxX + r && y > b.minY - r && y < b.maxY + r
    })
  }

  private penaltyFor(net: string) {
    return (x: number, y: number) => {
      let p = 0
      for (const d of DIRS) {
        const [dx, dy] = VEC[d]
        const n = this.space.nodes.get(nodeKey(x + dx, y + dy))
        if (n && n.net !== net) p += 0.5
      }
      return p
    }
  }

  private addWire(nodes: Pt[], net: string) {
    this.space.addWire(nodes, net)
    let b: Box | null = null
    for (const [x, y] of nodes) b = union(b, ptBox(x, y))
    if (b) this.grow(b)
  }

  // ---------- Groups: the wired pieces of a net ----------

  /**
   * Points of a wire where another may meet it, nothing else there yet, and the ways a wire may
   * leave them: straight through, across; at a bend, the two ways it doesn't go (a tee at a
   * corner), but not right in front of a pin.
   */
  private plainNodes(g: Group): { at: Pt; free: Dir[] }[] {
    const out: { at: Pt; free: Dir[] }[] = []
    const fronts = new Set(g.pins.map((p) => nodeKey(p.x + VEC[p.dir][0], p.y + VEC[p.dir][1])))
    const stubs = this.stubStarts(g)
    for (const w of g.wires) {
      const cs = new Set(corners(w).map(([x, y]) => nodeKey(x, y)))
      for (let i = 1; i < w.length - 1; i++) {
        const k = nodeKey(...w[i])
        const n = this.space.nodes.get(k)
        if (!n || n.ends > 0 || n.through > 1) continue
        // Two junctions never a step apart: their dots would run together.
        if (this.style !== "first" && (this.junctionNear(w[i - 1], g) || this.junctionNear(w[i + 1], g) || stubs.has(k))) continue
        if (cs.has(k)) {
          if (this.style === "first" || fronts.has(k)) continue
          out.push({ at: w[i], free: DIRS.filter((d) => !this.hasEdge(w[i][0], w[i][1], d)) })
          continue
        }
        out.push({ at: w[i], free: w[i - 1][1] === w[i][1] ? ["up", "down"] : ["left", "right"] })
      }
    }
    return out
  }

  /** Where the group's label and port stubs leave its wires. */
  private stubStarts(g: Group): Set<number> {
    const out = new Set<number>()
    for (const sl of [g.slot, ...(g.extra ?? []).map((e) => e.slot)]) if (sl && sl.stub.length > 1) out.add(nodeKey(...sl.stub[0]))
    return out
  }

  /**
   * Whether a point of a wire is a junction already: three wires meet there, or a stub leaves it.
   * Not right in front of a pin: pins side by side on one net are joined there, a step from the
   * bar between them, and that is where their supply's wire has to tee in.
   */
  private junctionNear(at: Pt, g: Group): boolean {
    const n = this.space.nodes.get(nodeKey(...at))
    if (!n) return false
    if (g.pins.some((p) => p.x + VEC[p.dir][0] === at[0] && p.y + VEC[p.dir][1] === at[1])) return false
    return DIRS.filter((d) => this.hasEdge(at[0], at[1], d)).length >= 3 || this.stubStarts(g).has(nodeKey(...at))
  }

  private targetsOf(g: Group): Map<number, RouteTarget> {
    const out = new Map<number, RouteTarget>()
    for (const p of g.pins) {
      if (p.wired) continue
      const [dx, dy] = VEC[p.dir]
      out.set(nodeKey(p.x + dx, p.y + dy), { arrive: "any", then: { x: p.x, y: p.y, dir: OPPOSITE[p.dir] } })
    }
    // Arriving the only ways it can: along a free way in, which the wire's own nodes block otherwise.
    for (const { at, free } of this.plainNodes(g)) out.set(nodeKey(...at), { arrive: free.length === 2 && free.every(isVertical) ? "v" : free.length === 2 && !free.some(isVertical) ? "h" : "any" })
    return out
  }

  private startsOf(g: Group): RouteStart[] {
    const out: RouteStart[] = []
    for (const p of g.pins) if (!p.wired) out.push({ x: p.x, y: p.y, dir: p.dir })
    for (const { at, free } of this.plainNodes(g)) {
      for (const d of free) out.push({ x: at[0], y: at[1], dir: d })
    }
    return out
  }

  /** Wire group `a` to another group of its net. Returns the wire's cost, or null. */
  private join(net: string, a: Group, budget = Infinity): number | null {
    const groups = this.touch(net)
    const targets = new Map<number, RouteTarget>()
    const owner = new Map<number, Group>()
    for (const g of groups) {
      if (g === a) continue
      for (const [k, t] of this.targetsOf(g)) {
        targets.set(k, t)
        owner.set(k, g)
      }
    }
    const starts = this.startsOf(a)
    if (!starts.length || !targets.size) return null
    // A wire leaving a pin starts through the pin's own front.
    const fronts = new Set(a.pins.filter((p) => !p.wired).map((p) => nodeKey(p.x + VEC[p.dir][0], p.y + VEC[p.dir][1])))
    // A detour of more than a few grid squares is never worth it: another spot will do better.
    let area: Box | null = null
    for (const s of starts) area = union(area, ptBox(s.x, s.y))
    let tb: Box | null = null
    for (const k of targets.keys()) tb = union(tb, ptBox(nodeX(k), nodeY(k)))
    const near = Math.min(...starts.map((s) => Math.max(0, tb!.minX - s.x, s.x - tb!.maxX) + Math.max(0, tb!.minY - s.y, s.y - tb!.maxY)))
    const r = route({
      from: starts,
      targets,
      blocked: (x, y) => this.blockedFor(net, x, y, fronts),
      penalty: this.penaltyFor(net),
      limit: inflate(union(area!, tb!), 4),
      maxCost: Math.min(budget, near + 10),
    })
    if (!r) return null
    // A wire straight from pin to pin leaves nothing for the net's other parts to tee off.
    const pending = this.ctx.nets.nets.get(net)!.pins.some((k) => {
      const id = k.slice(0, k.lastIndexOf(":"))
      return this.parts.has(id) && !this.placed.has(id)
    })
    const extra = pending && r.nodes.length <= 3 ? 4 : 0
    this.addWire(r.nodes, net)
    const n = r.nodes.length
    const first = r.nodes[0]
    const end = r.nodes[n - 1]
    const into = owner.get(nodeKey(...end)) ?? owner.get(nodeKey(...r.nodes[n - 2]))!
    for (const p of [...a.pins, ...into.pins]) {
      if ((p.x === first[0] && p.y === first[1]) || (p.x === end[0] && p.y === end[1])) p.wired = true
    }
    into.pins.push(...a.pins)
    into.wires.push(...a.wires, r.nodes)
    groups.splice(groups.indexOf(a), 1)
    return r.cost + extra
  }

  private dropSlot(g: Group) {
    for (const e of g.extra ?? []) this.dropOne(g.net, e.slot)
    g.extra = undefined
    if (!g.slot) return
    this.dropOne(g.net, g.slot)
    g.slot = null
  }

  /** A label's or port's room taken out, and the wire to it where it had one of its own. */
  private dropOne(net: string, slot: Slot) {
    for (const id of slot.items) this.space.remove(id)
    // Drawn as first, the wire stays behind, unused, as it did then.
    if (slot.wire && this.style !== "first") this.space.removeWire(slot.stub, net)
  }

  /**
   * A net's other names this cluster draws (the cluster with the net's first pin) that no group of
   * the net has drawn yet.
   */
  private aliasesOf(net: string): string[] {
    const names = this.ctx.aliases?.(net) ?? []
    if (!names.length) return []
    const key = this.ctx.nets.nets.get(net)!.key
    const first = key.slice(key.indexOf("|") + 1)
    if (!this.parts.has(first.slice(0, first.lastIndexOf(":")))) return []
    const drawn = new Set((this.groups.get(net) ?? []).flatMap((x) => (x.extra ?? []).map((e) => e.name)))
    return names.filter((n) => !drawn.has(n))
  }

  /**
   * The labels of the net's other names not drawn yet, beside a group's slot: drawn as the slot is,
   * so they take room as the drawing grows. How many found no room here: another group of the net
   * takes them, or failing that a pin of the net once the sheet is drawn (`index.ts`).
   */
  private placeAliases(g: Group, reach: number[]): number {
    let missing = 0
    for (const name of this.aliasesOf(g.net)) {
      this.alias = name
      const ok = this.placeSlot(g, reach) !== null || this.escape(g)
      this.alias = null
      if (!ok) missing++
    }
    return missing
  }

  private hasEdge(x: number, y: number, d: Dir): boolean {
    const [dx, dy] = VEC[d]
    if (dy === 0) return this.space.hEdges.has(nodeKey(Math.min(x, x + dx), y))
    return this.space.vEdges.has(nodeKey(x, Math.min(y, y + dy)))
  }

  /**
   * Room for the group's label (a supply's port): on a free pin or off its wires, as near and as
   * short as it goes. A label reads across: off a pin pointing up or down, its stub turns aside.
   */
  private placeSlot(g: Group, reach = [1, 2, 3, 4, 6]): number | null {
    /** A stub out `dir`, turning `t` steps `side` where given, to a terminal running `out`. */
    type Cand = { from: Pt; dir: Dir; base: number; side?: Dir; t?: number; out?: Dir }
    const cands: Cand[] = []
    const rail = this.alias ? null : this.ctx.nets.nets.get(g.net)!.rail
    const canonical: Dir = rail === "ground" ? "down" : "up"
    for (const p of g.pins) {
      if (p.wired) continue
      const from: Pt = [p.x, p.y]
      cands.push({ from, dir: p.dir, base: 0 })
      if (!rail) {
        if (isVertical(p.dir)) for (const side of ["left", "right"] as Dir[]) for (const t of [1, 2]) cands.push({ from, dir: p.dir, base: 1 + t, side, t })
        continue
      }
      // A port the rail's way at the end of a stub out of a pin on a side; or, out of a pin on the
      // top or bottom between others, on a stub that turns aside to where it has room.
      if (!isVertical(p.dir)) cands.push({ from, dir: p.dir, base: 1.5, out: canonical })
      else {
        for (const side of ["left", "right"] as Dir[]) {
          for (const t of [2, 3, 4]) {
            cands.push({ from, dir: p.dir, base: 2 + 0.5 * t, side, t, out: canonical }, { from, dir: p.dir, base: 3.5 + 0.5 * t, side, t, out: side })
          }
        }
      }
    }
    const tips = new Set(g.pins.map((p) => nodeKey(p.x, p.y)))
    for (const w of g.wires) {
      const cs = new Set(corners(w).map(([x, y]) => nodeKey(x, y)))
      for (const [x, y] of w) {
        const k = nodeKey(x, y)
        if (tips.has(k)) continue
        const n = this.space.nodes.get(k)
        if (!n || n.ends + n.through > 2) continue
        // Not a step from a junction: its dot and this one would run together.
        if (this.style !== "first" && DIRS.some((d) => this.hasEdge(x, y, d) && this.junctionNear([x + VEC[d][0], y + VEC[d][1]], g))) continue
        for (const d of DIRS) {
          if (this.hasEdge(x, y, d)) continue
          const base = cs.has(k) ? 0.5 : 1.5
          cands.push({ from: [x, y], dir: d, base })
          // A label off a wire across, on a stub that turns aside so it reads across too.
          if (!rail && isVertical(d) && this.style !== "first") for (const side of ["left", "right"] as Dir[]) for (const t of [1, 2]) cands.push({ from: [x, y], dir: d, base: base + 1 + t, side, t })
        }
      }
    }
    let best: { c: Cand; s: number; cost: number } | null = null
    const runs = (c: Cand) => c.out ?? c.side ?? c.dir
    const least = (c: Cand) => c.base + reach[0] + this.terminalCost(g.net, runs(c))
    cands.sort((a, b) => least(a) - least(b))
    for (const c of cands) {
      if (this.acrossOnly && !this.across(g.net, runs(c))) continue
      if (best && least(c) >= best.cost) break
      // A label's turned stub runs out at least two steps first, so its turn reads as a turn.
      for (const s of c.side && !rail ? reach.filter((r) => r >= 2) : reach) {
        const cost = c.base + s + this.terminalCost(g.net, runs(c))
        if (best && cost >= best.cost) break
        if (this.slotAt(g, c.from, c.dir, s, true, c.side, c.t, c.out)) {
          best = { c, s, cost }
          break
        }
      }
    }
    if (!best) return null
    this.slotAt(g, best.c.from, best.c.dir, best.s, false, best.c.side, best.c.t, best.c.out)
    // A name with no room here costs, so a spot with room for it wins, but never refuses the part.
    if (!this.alias) return best.cost + W_FAIL * this.placeAliases(g, reach)
    return best.cost
  }

  /**
   * A label (a supply's port) `s` steps out from `from`, then `t` steps `side` where given, running
   * `out` (the way the stub ends, unless given): with `probe`, only whether it fits.
   */
  private slotAt(g: Group, from: Pt, dir: Dir, s: number, probe: boolean, side?: Dir, t = 0, out?: Dir): boolean {
    const [dx, dy] = VEC[dir]
    const stub: Pt[] = []
    for (let i = 0; i <= s; i++) stub.push([from[0] + dx * i, from[1] + dy * i])
    if (side) {
      const [sx, sy] = VEC[side]
      const [bx, by] = stub[stub.length - 1]
      for (let i = 1; i <= t; i++) stub.push([bx + sx * i, by + sy * i])
    }
    // From a pin, the stub starts through the pin's own front.
    const front = g.pins.some((p) => p.x === from[0] && p.y === from[1]) ? this.exitOf(from, dir) : undefined
    for (let i = 1; i < stub.length; i++) if (this.blockedFor(g.net, stub[i][0], stub[i][1], front)) return false
    const [lx, ly] = stub[stub.length - 1]
    const runs = out ?? side ?? dir
    const info = this.ctx.nets.nets.get(g.net)!
    if (info.rail && !this.alias) {
      // A port's name never sits on its own stub.
      const text = inflate(shift(portShape(info.rail, info.name, runs).text, lx, ly), 0.1)
      if (stub.slice(0, -1).some(([x, y]) => x > text.minX && x < text.maxX && y > text.minY && y < text.maxY)) return false
    }
    const owner = `slot:${g.net}:${lx},${ly}`
    const mark = this.space.mark()
    const drawn = this.drawn
    const terminal = this.putTerminal(g.net, lx, ly, runs)
    if (terminal === null || probe) {
      this.space.rollback(mark)
      this.drawn = drawn
      return terminal !== null
    }
    // The stub's own room, so nothing else is drawn across it before it is.
    let sb: Box | null = null
    for (const [x, y] of stub.slice(1)) sb = union(sb, ptBox(x, y))
    const items = [...terminal]
    if (sb) items.push(this.space.add(inflate(sb, 0.2), "slot", owner, g.net))
    if (this.alias) g.extra = [...(g.extra ?? []), { name: this.alias, slot: { stub, dir: runs, items } }]
    else g.slot = { stub, dir: runs, items }
    return true
  }

  // ---------- Rails ----------

  /**
   * A power or ground port for a rail on a pin's end or the middle of a comb: straight out where
   * it can, else on a short stub that turns aside, pointing the rail's way (power up, ground down)
   * where it fits. Never a label: a supply spelled out on one reads as a signal.
   */
  private placeRail(net: string, from: Pt, out: Dir, isTip: boolean, owner: string): number | null {
    const info = this.ctx.nets.nets.get(net)!
    const kind = info.rail!
    const canonical: Dir = kind === "ground" ? "down" : "up"
    /** A stub of `s` steps out, then `t` steps `side`, ending in a port pointing `portOut`. */
    type Cand = { cost: number; s: number; side?: Dir; t: number; portOut: Dir }
    const cands: Cand[] = []
    const first = isTip ? 0 : 1
    const sides: Dir[] = isVertical(out) ? ["left", "right"] : ["up", "down"]
    if (out === canonical) {
      const reach = this.sidewaysFirst ? 2 : 5
      for (let s = first; s <= first + reach; s++) cands.push({ cost: s - first, s, t: 0, portOut: out })
    } else if (out === OPPOSITE[canonical]) {
      for (const s of [1, 2, 3]) cands.push({ cost: 12 + s, s, t: 0, portOut: out })
    } else {
      // Out of a pin on a side: the port stands the rail's way at the end of a short stub, or of
      // one that bends that way, before it is turned aside to stand on the pin.
      if (this.sidewaysFirst) {
        cands.push({ cost: 2, s: first, t: 0, portOut: out }, { cost: 3, s: first + 1, t: 0, portOut: out })
        for (const s of [1, 2, 3, 4, 5, 6, 8]) cands.push({ cost: 1.5 + 0.6 * s, s, t: 0, portOut: canonical })
      } else {
        cands.push({ cost: 4, s: first, t: 0, portOut: out }, { cost: 4.5, s: first + 1, t: 0, portOut: out })
        for (const s of [1, 2, 3, 4, 5, 6, 8]) cands.push({ cost: 1 + 0.4 * s, s, t: 0, portOut: canonical })
        for (const s of [1, 2, 3]) for (const t of [1, 2, 3]) cands.push({ cost: 1.2 + 0.4 * s + 0.4 * t, s, side: canonical, t, portOut: canonical })
      }
    }
    // Turned aside: two ports on neighbouring pins, or a port that would face back over its part.
    if (isVertical(out)) {
      for (const s of [1, 2, 3]) {
        for (const side of sides) {
          for (const t of [2, 3, 4]) {
            const base = (out === canonical ? 3 : 5) + 0.5 * s + 0.5 * t
            cands.push({ cost: base, s, side, t, portOut: canonical }, { cost: base + (this.sidewaysFirst ? 1.5 : 10), s, side, t, portOut: side })
            if (out !== canonical) cands.push({ cost: base + 2.5, s, side, t, portOut: out })
          }
        }
      }
    }
    cands.sort((a, b) => a.cost - b.cost)
    for (const c of cands) {
      if (this.straightRails && (c.t || c.portOut !== canonical || out !== canonical)) continue
      const path: Pt[] = [from]
      const [dx, dy] = VEC[out]
      for (let i = 1; i <= c.s; i++) path.push([from[0] + dx * i, from[1] + dy * i])
      if (c.side) {
        const [sx, sy] = VEC[c.side]
        const [bx, by] = path[path.length - 1]
        for (let i = 1; i <= c.t; i++) path.push([bx + sx * i, by + sy * i])
      }
      let blocked = false
      for (let i = 1; i < path.length && !blocked; i++) blocked = this.blockedFor(net, path[i][0], path[i][1], i === 1 && isTip ? this.exitOf(from, out) : undefined)
      if (blocked) continue
      const [ex, ey] = path[path.length - 1]
      const mark = this.space.mark()
      const drawn = this.drawn
      const own = `${owner}:rail:${ex},${ey}`
      const ps = portShape(kind, info.name, c.portOut)
      // Its name never sits on its own stub.
      const text = inflate(shift(ps.text, ex, ey), 0.1)
      const ok =
        !path.slice(0, -1).some(([x, y]) => x > text.minX && x < text.maxX && y > text.minY && y < text.maxY) &&
        this.put(shift(ps.body, ex, ey), "port", own, net) !== null &&
        this.put(shift(ps.text, ex, ey), "port", own, net) !== null
      if (!ok) {
        this.space.rollback(mark)
        this.drawn = drawn
        continue
      }
      const wire = path.length > 1 ? along(corners(path)) : null
      if (wire) this.addWire(wire, net)
      this.rails.push({ net, wires: wire ? [wire] : [], port: { kind, at: [ex, ey] as Pt, out: c.portOut } })
      return c.cost
    }
    return null
  }

  private exitOf(tip: Pt, dir: Dir): Set<number> {
    const [dx, dy] = VEC[dir]
    return new Set([nodeKey(tip[0] + dx, tip[1] + dy)])
  }

  // ---------- Parts ----------

  /** Runs of neighbouring pins on one side of a part with one net, in order along the side. */
  private runs(pins: PinState[]): PinState[][] {
    const out: PinState[][] = []
    for (const d of DIRS) {
      const side = pins.filter((p) => p.dir === d).sort((a, b) => (isVertical(d) ? a.x - b.x : b.y - a.y))
      let run: PinState[] = []
      for (const p of side) {
        const last = run[run.length - 1]
        const inLine = last && (isVertical(d) ? p.y === last.y : p.x === last.x)
        const near = last && Math.abs(isVertical(d) ? p.x - last.x : p.y - last.y) <= 4
        if (last && inLine && near && p.kind !== "free" && last.net === p.net) run.push(p)
        else {
          if (run.length && run[0].kind !== "free") out.push(run)
          run = [p]
        }
      }
      if (run.length && run[0].kind !== "free") out.push(run)
    }
    return out
  }

  /** The wires joining a run of pins: out from each, and along their fronts. */
  private comb(run: PinState[]): { wires: Pt[][]; at: Pt; own: Set<number> } {
    const d = run[0].dir
    const [dx, dy] = VEC[d]
    const first = run[0]
    const last = run[run.length - 1]
    const main = along([
      [first.x, first.y],
      [first.x + dx, first.y + dy],
      [last.x + dx, last.y + dy],
      [last.x, last.y],
    ])
    const wires: Pt[][] = [main]
    for (const p of run.slice(1, -1)) {
      wires.push([
        [p.x, p.y],
        [p.x + dx, p.y + dy],
      ])
    }
    // The terminal hangs off the bar between two pins, never where a pin's own wire meets it.
    const fronts = new Set(run.map((p) => nodeKey(p.x + dx, p.y + dy)))
    const bar = main.slice(1, -1).filter(([x, y]) => !fronts.has(nodeKey(x, y)))
    const mid = isVertical(d) ? (first.x + last.x) / 2 : (first.y + last.y) / 2
    const off = (p: Pt) => Math.abs((isVertical(d) ? p[0] : p[1]) - mid)
    bar.sort((a, b) => off(a) - off(b) || a[0] - b[0] || a[1] - b[1])
    const own = new Set(run.flatMap((p) => [nodeKey(p.x, p.y), nodeKey(p.x + dx, p.y + dy)]))
    return { wires, at: bar[0] ?? [first.x + dx, first.y + dy], own }
  }

  /** Draw a comb's wires if nothing is in their way. */
  private drawComb(run: PinState[], net: string): { wires: Pt[][]; at: Pt } | null {
    const comb = this.comb(run)
    for (const w of comb.wires) {
      for (const [wx, wy] of w) {
        if (!comb.own.has(nodeKey(wx, wy)) && this.blockedFor(net, wx, wy)) {
          return null
        }
      }
    }
    for (const w of comb.wires) this.addWire(w, net)
    for (const p of run) p.wired = true
    return comb
  }

  /** Wire each of a part's groups on these nets into the rest of its net, in this order. */
  private joinAll(c: ComponentInstance, order: string[], budget: number): { failed: number; cost: number } {
    let failed = 0
    let cost = 0
    for (const net of order) {
      for (const g of [...this.touch(net)]) {
        if (!g.pins.some((p) => p.comp === c.id)) continue
        if (this.touch(net).length < 2 || !this.touch(net).includes(g)) continue
        const joined = this.join(net, g, budget - cost)
        if (joined === null) failed++
        cost += joined === null ? W_FAIL : joined
      }
    }
    return { failed, cost }
  }

  /** A copy of these nets' groups, to put back with `restoreGroups`. */
  private saveGroups(nets: string[]): Map<string, Group[]> {
    const out = new Map<string, Group[]>()
    for (const net of nets) out.set(net, this.touch(net).map((g) => ({ ...g, pins: g.pins.map((p) => ({ ...p })), wires: [...g.wires] })))
    return out
  }

  private restoreGroups(saved: Map<string, Group[]>) {
    for (const [net, groups] of saved) this.groups.set(net, groups.map((g) => ({ ...g, pins: g.pins.map((p) => ({ ...p })), wires: [...g.wires] })))
  }

  /**
   * Draw a part at (x, y) turned `rot`, wire it to what it connects to, and find room for its
   * labels and ports. Returns what it costs, or null when it doesn't fit or costs `budget` or
   * more. Undone unless `keep`.
   */
  attempt(c: ComponentInstance, x: number, y: number, rot: Rotation, keep: boolean, budget = Infinity): number | null {
    const mark = this.begin()
    const result = this.draw(c, x, y, rot, budget)
    if (result === null || !keep) this.undo(mark)
    else this.keep()
    return result
  }

  private draw(c: ComponentInstance, x: number, y: number, rot: Rotation, budget: number): number | null {
    const shape = partShape(c, rot)
    let cost = this.orientPenalty(c, shape)
    // The labels of its own nets move out of its way: they are found room again once it is wired.
    const own: string[] = []
    for (const p of shape.pins) {
      const { net, kind } = this.pinKind(c, p.pin)
      if (kind === "signal" && net && !own.includes(net)) own.push(net)
    }
    for (const net of own) for (const g of this.touch(net)) this.dropSlot(g)
    if (this.put(shift(shape.body, x, y), "body", c.id, null) === null) return this.fail("its symbol")
    for (const t of shape.texts) if (this.put(shift(t, x, y), "text", c.id, null) === null) return this.fail("its text")

    const pins: PinState[] = shape.pins.map((p) => {
      const { net, kind } = this.pinKind(c, p.pin)
      return { comp: c.id, pin: p.pin, x: p.x + x, y: p.y + y, dir: p.dir, net, kind, wired: false }
    })
    for (const p of pins) {
      if (this.put(sq(p.x, p.y, 0.2), "tip", c.id, p.net) === null) return this.fail(`pin ${p.pin}`)
      if (p.kind === "free") {
        if (this.put(sq(p.x, p.y, 0.7), "mark", c.id, null) === null) return this.fail(`pin ${p.pin}'s mark`)
      } else {
        const [dx, dy] = VEC[p.dir]
        if (this.put(sq(p.x + dx, p.y + dy, 0.2), "exit", c.id, p.net) === null) return this.fail(`the front of pin ${p.pin}`)
      }
    }
    this.placed.set(c.id, { x, y, rot })
    this.tx!.placed.push(c.id)
    this.pinStates.set(c.id, pins)
    this.tx!.pinStates.push(c.id)
    if (this.drawn && cost + growth(this.bbox, this.drawn) * W_GROW >= budget) return null

    this.wired = true
    const runs = this.runs(pins)
    // Signal pins: each run is a group of its net, to be joined to the rest of it.
    const touched: string[] = []
    for (const run of runs) {
      if (run[0].kind !== "signal") continue
      const net = run[0].net!
      const groups = this.touch(net)
      if (!touched.includes(net)) touched.push(net)
      // Each pin object lives in one group from here on: the group's copy.
      const g: Group = { net, pins: run, wires: [], slot: null }
      if (run.length > 1) {
        const comb = this.drawComb(run, net)
        if (!comb) return this.fail(`the wires joining pins ${run.map((p) => p.pin).join(", ")}`)
        g.wires.push(...comb.wires)
      }
      groups.push(g)
    }
    // Rails: the combs joining neighbouring pins first, so nothing is drawn where they go.
    const terminals: { net: string; at: Pt; dir: Dir; isTip: boolean }[] = []
    for (const run of runs) {
      if (run[0].kind !== "rail") continue
      const net = run[0].net!
      if (run.length === 1) {
        terminals.push({ net, at: [run[0].x, run[0].y], dir: run[0].dir, isTip: true })
        continue
      }
      const comb = this.drawComb(run, net)
      if (!comb) return this.fail(`the wires joining pins ${run.map((p) => p.pin).join(", ")}`)
      this.rails.push({ net, wires: comb.wires })
      terminals.push({ net, at: comb.at, dir: run[0].dir, isTip: false })
    }
    // Only small parts are wired in; chips and connectors reach each other through labels, but
    // for a supply the block wires. One wire can take the way another needs, so a part wired on
    // several nets tries each order.
    const wiring = isHelper(c) ? touched : touched.filter((n) => this.isSupply(n))
    if (wiring.length && !this.noWire) {
      const orders = permutations(wiring)
      let best: { order: string[]; failed: number; cost: number } | null = null
      let kept = false
      for (const order of orders) {
        const mark = this.space.mark()
        const drawn = this.drawn
        const saved = this.saveGroups(wiring)
        const r = this.joinAll(c, order, budget - cost)
        if (!best || r.failed < best.failed || (r.failed === best.failed && r.cost < best.cost)) best = { order, ...r }
        // The first order that wires everything is kept as drawn; otherwise every order is tried.
        if (r.failed === 0 && order === orders[0]) {
          kept = true
          break
        }
        if (orders.length > 1) {
          this.space.rollback(mark)
          this.drawn = drawn
          this.restoreGroups(saved)
        } else kept = true
      }
      if (!kept) best = { order: best!.order, ...this.joinAll(c, best!.order, budget - cost) }
      cost += best!.cost
      if (best!.failed) {
        this.why = "a wire it needs"
        this.partial = true
      }
      if (cost >= budget) return this.fail(`a cheaper spot than this`)
    }
    // Labels of signals, then the rails' ports, then the ports of supplies wired here, which turn
    // aside more readily than a rail's.
    const slots = (supplies: boolean): number | null => {
      for (const net of touched) {
        if (this.isSupply(net) !== supplies || !this.needsLabel(net)) continue
        for (const g of this.touch(net)) {
          if (g.slot) continue
          const s = this.placeSlot(g)
          if (s === null) return this.fail(`a ${supplies ? "port" : "label"} of ${this.ctx.labelName(net)}`)
          cost += s
          if (cost >= budget) return null
        }
      }
      return cost
    }
    if (slots(false) === null) return null
    // Those that can stand straight out the rail's way go first: the others can turn aside.
    const straight = (t: (typeof terminals)[number]) => t.dir === (this.ctx.nets.nets.get(t.net)!.rail === "ground" ? "down" : "up")
    terminals.sort((a, b) => Number(straight(b)) - Number(straight(a)))
    // Ports stand the rail's way where they can; where one standing so leaves no room for the next,
    // they all go back on the pins, turned aside, as they would have.
    const railMark = this.space.mark()
    const railCount = this.rails.length
    const drawnBefore = this.drawn
    const costBefore = cost
    for (const sideways of this.style === "first" ? [true] : [false, true]) {
      this.sidewaysFirst = sideways
      let failed: string | null = null
      for (const t of terminals) {
        const r = this.placeRail(t.net, t.at, t.dir, t.isTip, c.id)
        if (r === null) {
          failed = this.ctx.nets.nets.get(t.net)!.name
          break
        }
        cost += r * 0.5
      }
      this.sidewaysFirst = false
      if (failed === null) break
      this.space.rollback(railMark)
      this.rails.length = railCount
      this.drawn = drawnBefore
      cost = costBefore
      if (sideways) return this.fail(`a port of ${failed}`)
    }
    if (cost >= budget) return null
    if (slots(true) === null) return null
    if (this.drawn) cost += growth(this.bbox, this.drawn) * W_GROW
    return cost
  }

  // ---------- Placing ----------

  /** Lay out the parts, the main one first, and draw everything. */
  layout(): BlockDrawing {
    const parts = [...this.parts.values()]
    if (!parts.length) return { parts: new Map(), wires: [], labels: [], ports: [], extent: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }
    const main = pickMain(parts, (c) => this.links(c).length)
    const turns = allowedTurns(main)
    const ranked = [...turns].sort((a, b) => this.orientPenalty(main, partShape(main, a)) - this.orientPenalty(main, partShape(main, b)) || turns.indexOf(a) - turns.indexOf(b))
    if (!ranked.some((rot) => this.attempt(main, 0, 0, rot, true) !== null)) throw new Error(`Tidy: no room for ${main.ref}: ${this.why}`)
    const done = this.fanOut(main)
    for (const id of this.decouplingRow(main, parts)) done.add(id)
    for (const id of this.templates(main, parts, done)) done.add(id)
    for (const c of this.order(main, parts)) {
      if (done.has(c.id)) continue
      this.placePart(c)
      // Another chip of the cluster (a regulator beside its switch) gets its templates once placed.
      if (isBoxPart(findPart(c.partId))) for (const id of this.templates(c, parts, done)) done.add(id)
    }
    return this.finish()
  }

  // ---------- Templates: what an engineer draws the same way every time ----------

  /**
   * Parts drawn to a fixed pattern about a chip, before the rest: a crystal with its load
   * capacitors, a 555's timing parts, a pin's pull-up and button, the capacitors on a wired supply
   * hanging off its wire. Each is drawn with the chip's labels and ports near it out of the way,
   * which then find room again, reading across; a pattern that doesn't fit whole, every wire drawn,
   * is undone, and its parts are placed like any other.
   */
  private templates(main: ComponentInstance, parts: ComponentInstance[], done: Set<string>): string[] {
    const out: string[] = []
    if (this.style !== "full") return out
    const free = (c: ComponentInstance) => !done.has(c.id) && !this.placed.has(c.id)
    for (const make of [
      () => this.crystalSpots(main, parts.filter(free)),
      () => this.archSpots(main, parts.filter(free)),
      () => this.pullSpots(main, parts.filter(free)),
      () => this.busSpots(main, parts.filter(free)),
    ]) {
      const placed = this.arrange(main, make())
      if (placed) out.push(...placed)
    }
    return out
  }

  /**
   * The first of these arrangements that draws whole: every part wired to all it needs, and the
   * main part's labels and ports given room again after. Null when none does; nothing is left of
   * those that didn't.
   */
  private arrange(main: ComponentInstance, candidates: Iterable<Spot[]>): string[] | null {
    this.acrossOnly = true
    try {
      return this.arrangeFirst(main, candidates)
    } finally {
      this.acrossOnly = false
    }
  }

  private arrangeFirst(main: ComponentInstance, candidates: Iterable<Spot[]>): string[] | null {
    const nets = new Set(this.mainNets(main))
    let tried = 0
    let looked = 0
    for (const steps of candidates) {
      if (tried >= MAX_TEMPLATE_TRIES || ++looked > MAX_TEMPLATE_LOOKS) break
      // Most arrangements put a part on top of something: a cheap look at them all before drawing,
      // the main part's labels and ports aside since they make room.
      const fits = steps.every((s) => {
        const sh = partShape(s.c, s.rot)
        return this.roomFor(shift(sh.body, s.x, s.y), nets) && sh.texts.every((t) => this.roomFor(shift(t, s.x, s.y), nets))
      })
      if (!fits) continue
      tried++
      this.beginAll()
      this.dropMainSlots(main, steps)
      let ok = true
      for (const s of steps) {
        if (!ok) break
        this.partial = false
        ok = this.attempt(s.c, s.x, s.y, s.rot, true) !== null && !this.partial
      }
      ok = ok && this.replaceSlots(main) && this.readsAcross([...this.mainNets(main), ...steps.flatMap((s) => this.links(s.c))])
      this.endAll(ok)
      if (ok) return steps.map((s) => s.c.id)
    }
    return null
  }

  /** The nets of the main part's pins that are wired: signals, and supplies the block wires. */
  private mainNets(main: ComponentInstance): string[] {
    const nets: string[] = []
    for (const p of this.pinStates.get(main.id) ?? []) if (p.kind === "signal" && p.net && !nets.includes(p.net)) nets.push(p.net)
    const key = (net: string) => this.ctx.nets.nets.get(net)!.key
    return nets.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  }

  /** Take the labels and ports of the main part's nets off, so a template can be drawn where they were. */
  private dropMainSlots(main: ComponentInstance, steps: Spot[]) {
    // Only those near where the template goes: the rest stay as they are, and cost nothing.
    let region: Box | null = null
    for (const s of steps) {
      const sh = partShape(s.c, s.rot)
      region = union(region, shift(sh.texts.reduce((b, t) => union(b, t), sh.body), s.x, s.y))
    }
    const near = inflate(region!, TEMPLATE_REACH)
    const hit = (slot: Slot) => slot.items.some((id) => {
      const it = this.space.item(id)
      return !!it && boxesTouch(it.box, near)
    })
    this.begin()
    for (const net of this.mainNets(main)) {
      for (const g of this.touch(net)) if ((g.slot && hit(g.slot)) || (g.extra ?? []).some((e) => hit(e.slot))) this.dropSlot(g)
    }
    this.keep()
  }

  /** Room again for the labels and ports of the main part's nets that have none: false if one finds none. */
  private replaceSlots(main: ComponentInstance): boolean {
    const mark = this.begin()
    for (const supplies of [false, true]) {
      for (const net of this.mainNets(main)) {
        if (this.isSupply(net) !== supplies || !this.needsLabel(net)) continue
        for (const g of [...this.touch(net)]) {
          if (g.slot) continue
          if (this.placeSlot(g) === null && !this.escape(g)) {
            this.undo(mark)
            return false
          }
        }
      }
    }
    this.keep()
    return true
  }

  /** Whether every label of these nets reads across and every port of theirs stands the rail's way or aside. */
  private readsAcross(nets: string[]): boolean {
    for (const net of new Set(nets)) {
      const rail = this.ctx.nets.nets.get(net)!.rail
      for (const g of this.groups.get(net) ?? []) {
        if (g.slot && (rail ? g.slot.dir === (rail === "ground" ? "up" : "down") : isVertical(g.slot.dir))) return false
        if ((g.extra ?? []).some((e) => isVertical(e.slot.dir))) return false
      }
    }
    return true
  }

  /** A turn of a two-pin part that points its pin on `net` `dir`; undefined if none does. */
  private turnWith(c: ComponentInstance, net: string, dir: Dir): Rotation | undefined {
    return allowedTurns(c).find((rot) => partShape(c, rot).pins.some((p) => this.pinKind(c, p.pin).net === net && p.dir === dir))
  }

  /** A part's spot that puts its pin on `net` at (x, y), turned `rot`. */
  private spotWithPin(c: ComponentInstance, net: string, rot: Rotation, x: number, y: number): Spot {
    const pin = partShape(c, rot).pins.find((p) => this.pinKind(c, p.pin).net === net)!
    return { c, x: x - pin.x, y: y - pin.y, rot }
  }

  /** The part from `net` to ground among these, a load or decoupling capacitor: the first by designator. */
  private toGround(parts: ComponentInstance[], net: string): ComponentInstance | undefined {
    return parts.find((c) => {
      const pins = findPart(c.partId)?.pins ?? []
      if (pins.length !== 2 || isBoxPart(findPart(c.partId))) return false
      const k = pins.map((p) => this.pinKind(c, p.number))
      return k.some((x) => x.kind === "signal" && x.net === net) && k.some((x) => x.kind === "rail" && this.ctx.nets.nets.get(x.net!)!.rail === "ground")
    })
  }

  /**
   * A crystal (any two-pin part) across two neighbouring pins on a side of the main part, with a
   * capacitor to ground on either pin: the crystal lies across below the pins, out from the side,
   * each capacitor hangs to ground under the wire from its pin, and the crystal's pins tee
   * straight into those wires. Spots nearest the pins first.
   */
  private *crystalSpots(main: ComponentInstance, parts: ComponentInstance[]): Generator<Spot[]> {
    const pins = this.pinStates.get(main.id) ?? []
    for (const y of this.bridges(main, parts)) {
      const nets = this.links(y)
      const yPins = findPart(y.partId)?.pins ?? []
      if (yPins.length !== 2 || nets.length !== 2) continue
      const on = nets.map((n) => pins.filter((p) => p.net === n))
      if (on.some((x) => x.length !== 1)) continue
      const [a, b] = on.map((x) => x[0])
      if (a.dir !== b.dir || isVertical(a.dir) || a.x !== b.x || Math.abs(a.y - b.y) > 4) continue
      // Each net is the pin alone so far: nothing else of it drawn yet.
      if (nets.some((n) => (this.groups.get(n) ?? []).some((g) => g.pins.length > 1 || g.wires.length))) continue
      const upper = a.y > b.y ? a : b
      const lower = upper === a ? b : a
      const sx = VEC[a.dir][0]
      const inward = OPPOSITE[a.dir]
      const rot = this.turnWith(y, lower.net!, inward)
      if (rot === undefined) continue
      const sh = partShape(y, rot)
      const inPin = sh.pins.find((p) => this.pinKind(y, p.pin).net === lower.net)!
      const outPin = sh.pins.find((p) => p !== inPin)!
      const span = Math.abs(outPin.x - inPin.x)
      const others = parts.filter((c) => c !== y)
      const capLow = this.toGround(others, lower.net!)
      const capUp = this.toGround(others.filter((c) => c !== capLow), upper.net!)
      const upright = (c: ComponentInstance | undefined, net: string) => (c ? this.turnWith(c, net, "up") : undefined)
      const rotLow = upright(capLow, lower.net!)
      const rotUp = upright(capUp, upper.net!)
      // Without a capacitor it is a part across two pins like any other.
      if ((!capLow || rotLow === undefined) && (!capUp || rotUp === undefined)) continue
      // Out `g` from the pins and down `m` below them, nearest first; two steps of wire from each
      // of the crystal's pins to the tee. The wires come down past the pins below, so out past the
      // labels those pins need first.
      const below = pins.filter((p) => p.dir === a.dir && p.y < lower.y && p.y >= lower.y - 12 && p.kind === "signal" && p.net && this.needsLabel(p.net))
      const clear = Math.max(0, ...below.map((p) => Math.ceil(labelShape(this.ctx.labelName(p.net!), p.dir).maxX - labelShape(this.ctx.labelName(p.net!), p.dir).minX))) + 2
      const cands: { g: number; m: number }[] = []
      for (let g = 2; g <= 16; g++) for (let m = 2; m <= 10; m++) cands.push({ g, m })
      const far = (g: number) => Number(g < clear)
      cands.sort((p, q) => far(p.g) - far(q.g) || p.g + p.m - (q.g + q.m) || p.m - q.m || p.g - q.g)
      for (const { g, m } of cands) {
        const yc = lower.y - m
        const a2 = lower.x + sx * g
        const xIn = a2 + sx * 2
        const xOut = xIn + sx * span
        const a1 = xOut + sx * 2
        const steps: Spot[] = []
        // The capacitors first, each wired up its own column to its pin; the crystal tees into both.
        if (capLow && rotLow !== undefined) steps.push(this.spotWithPin(capLow, lower.net!, rotLow, a2, yc - 2))
        if (capUp && rotUp !== undefined) steps.push(this.spotWithPin(capUp, upper.net!, rotUp, a1, yc - 2))
        steps.push(this.spotWithPin(y, lower.net!, rot, xIn, yc))
        yield steps
      }
    }
  }

  /**
   * A part between two of the main part's nets on one side, where the lower net also has a part to a
   * supply and the upper one a part to ground: a 555's timing resistors and capacitor. Stacked in
   * one column, their taps would cross, so they stand side by side: the part to the supply, its
   * wire along the lower pin's row; the part to ground outermost, wired over the top to the upper
   * pins; the part between the nets nearest the pins, teeing into both wires.
   */
  private *archSpots(main: ComponentInstance, parts: ComponentInstance[]): Generator<Spot[]> {
    const pins = this.pinStates.get(main.id) ?? []
    const twoPin = (c: ComponentInstance) => (findPart(c.partId)?.pins.length ?? 0) === 2 && !isBoxPart(findPart(c.partId))
    const kinds = (c: ComponentInstance) => (findPart(c.partId)?.pins ?? []).map((x) => this.pinKind(c, x.number))
    const railTo = (c: ComponentInstance, net: string, rail: RailKind) =>
      twoPin(c) && kinds(c).some((x) => x.kind === "signal" && x.net === net) && kinds(c).some((x) => x.kind === "rail" && this.ctx.nets.nets.get(x.net!)!.rail === rail)
    for (const b of parts) {
      if (!twoPin(b)) continue
      const nets = this.links(b)
      if (nets.length !== 2 || kinds(b).some((x) => x.kind !== "signal")) continue
      const on = nets.map((n) => pins.filter((p) => p.net === n))
      if (on.some((x) => !x.length)) continue
      const all = on.flat()
      const side = all[0].dir
      if (isVertical(side) || all.some((p) => p.dir !== side || p.x !== all[0].x)) continue
      // The lower net on one pin, the upper net's pins all above it.
      const [lowNet, highNet] = Math.max(...on[0].map((p) => p.y)) < Math.min(...on[1].map((p) => p.y)) ? nets : [nets[1], nets[0]]
      const low = pins.filter((p) => p.net === lowNet)
      const high = pins.filter((p) => p.net === highNet)
      if (low.length !== 1 || Math.max(...low.map((p) => p.y)) >= Math.min(...high.map((p) => p.y))) continue
      if ([lowNet, highNet].some((n) => (this.groups.get(n) ?? []).some((g) => g.pins.some((p) => p.comp !== main.id)))) continue
      const others = parts.filter((c) => c !== b)
      const pull = others.find((c) => railTo(c, lowNet, "power"))
      const cap = others.find((c) => railTo(c, highNet, "ground"))
      if (!pull || !cap) continue
      const rb = this.turnWith(b, lowNet, "down")
      const rp = this.turnWith(pull, lowNet, "down")
      const rc = this.turnWith(cap, highNet, "up")
      if (rb === undefined || rp === undefined || rc === undefined) continue
      const d = low[0]
      const sx = VEC[side][0]
      const width = (c: ComponentInstance, rot: Rotation) => {
        const sh = partShape(c, rot)
        const e = sh.texts.reduce((acc, t) => union(acc, t), sh.body)
        return Math.ceil(e.maxX - e.minX)
      }
      const pitch = Math.max(width(b, rb), width(pull, rp), width(cap, rc)) + 2
      const top = (c: ComponentInstance, rot: Rotation, net: string) => {
        const sh = partShape(c, rot)
        const at = sh.pins.find((p) => this.pinKind(c, p.pin).net === net)!
        return sh.pins.find((p) => p !== at)!.y - at.y
      }
      const bTop = d.y + 2 + top(b, rb, lowNet)
      const pTop = d.y + 2 + top(pull, rp, lowNet)
      for (let g = 3; g <= 10; g++) {
        for (let h = 2; h <= 10; h++) {
          const arch = Math.max(bTop, pTop + 3) + h
          const xb = d.x + sx * g
          const xp = xb + sx * pitch
          const xc = xp + sx * pitch
          yield [
            this.spotWithPin(pull, lowNet, rp, xp, d.y + 2),
            this.spotWithPin(cap, highNet, rc, xc, arch - 2),
            this.spotWithPin(b, lowNet, rb, xb, d.y + 2),
          ]
        }
      }
    }
  }

  /**
   * Parts from one pin of the main part to the rails (a reset pin's pull-up and its button): the
   * pin's wire runs straight out, the parts to a supply stand up off it and those to ground hang
   * down, or the outermost goes on in line with its port at the end. The outermost is wired first,
   * so the rest tee into its wire.
   */
  private *pullSpots(main: ComponentInstance, parts: ComponentInstance[]): Generator<Spot[]> {
    for (const p of this.pinStates.get(main.id) ?? []) {
      if (p.kind !== "signal" || !p.net || isVertical(p.dir) || this.isSupply(p.net)) continue
      const net = p.net
      if ((this.groups.get(net) ?? []).some((g) => g.pins.length > 1 || g.wires.length)) continue
      const pulls = parts.filter((c) => {
        const pins = findPart(c.partId)?.pins ?? []
        if (pins.length !== 2 || isBoxPart(findPart(c.partId))) return false
        const k = pins.map((x) => this.pinKind(c, x.number))
        return k.some((x) => x.kind === "signal" && x.net === net) && k.some((x) => x.kind === "rail")
      })
      if (pulls.length < 2 || pulls.length > 3) continue
      const railOf = (c: ComponentInstance) => {
        const k = (findPart(c.partId)?.pins ?? []).map((x) => this.pinKind(c, x.number)).find((x) => x.kind === "rail")!
        return this.ctx.nets.nets.get(k.net!)!.rail!
      }
      const sx = VEC[p.dir][0]
      const ext = (c: ComponentInstance) => {
        const sh = partShape(c, 90)
        const b = sh.texts.reduce((acc, t) => union(acc, t), sh.body)
        return Math.ceil(Math.max(b.maxX - b.minX, b.maxY - b.minY))
      }
      const pitch = Math.max(...pulls.map(ext)) + 2
      // Supplies up first, nearest the pin; ground beyond them.
      const order = [...pulls].sort((a, b) => Number(railOf(a) === "ground") - Number(railOf(b) === "ground") || byRef(a, b))
      const cands: { g: number; inLine: boolean }[] = []
      for (let g = 3; g <= 16; g++) for (const inLine of [false, true]) cands.push({ g, inLine })
      for (const { g, inLine } of cands) {
        const steps: Spot[] = []
        let ok = true
        order.forEach((c, i) => {
          const x = p.x + sx * (g + i * pitch)
          const last = i === order.length - 1
          if (inLine && last) {
            const rot = this.turnWith(c, net, OPPOSITE[p.dir])
            if (rot === undefined) ok = false
            else steps.push(this.spotWithPin(c, net, rot, p.x + sx * (g + (i - 1) * pitch + 4), p.y))
            return
          }
          const up = railOf(c) !== "ground"
          const rot = this.turnWith(c, net, up ? "down" : "up")
          if (rot === undefined) ok = false
          else steps.push(this.spotWithPin(c, net, rot, x, p.y + (up ? 2 : -2)))
        })
        if (ok) yield steps.reverse()
      }
    }
  }

  /**
   * The capacitors on a supply the block wires to the main part's pins on its top, hanging off one
   * bus: the supply's wire runs up from the pins and across, each capacitor upright under it with
   * ground below, beside the pins. The outermost is wired first, so the rest tee into its wire.
   */
  private *busSpots(main: ComponentInstance, parts: ComponentInstance[]): Generator<Spot[]> {
    const pins = this.pinStates.get(main.id) ?? []
    const supply = (p: PinState) => p.kind === "signal" && !!p.net && this.isSupply(p.net)
    // A supply on one pin on a side: its wire runs straight out, the capacitors hanging off it.
    for (const p of pins) {
      if (!supply(p) || isVertical(p.dir) || pins.filter((q) => q.net === p.net).length !== 1) continue
      const net = p.net!
      const caps: ComponentInstance[] = []
      for (let c = this.toGround(parts, net); c && caps.length < 4; c = this.toGround(parts.filter((x) => !caps.includes(x) && x !== c), net)) caps.push(c)
      const rots = caps.map((c) => this.turnWith(c, net, "up"))
      if (!caps.length || rots.some((r) => r === undefined)) continue
      const width = (c: ComponentInstance, rot: Rotation) => {
        const sh = partShape(c, rot)
        const e = sh.texts.reduce((b, t) => union(b, t), sh.body)
        return Math.ceil(e.maxX - e.minX)
      }
      const pitch = Math.max(...caps.map((c, i) => width(c, rots[i]!))) + 2
      const sx = VEC[p.dir][0]
      for (let off = 3; off <= 12; off++) {
        for (let h = 2; h <= 4; h++) {
          yield caps.map((c, i) => this.spotWithPin(c, net, rots[i]!, p.x + sx * (off + i * pitch), p.y - h)).reverse()
        }
      }
    }
    const nets = [...new Set(pins.filter((p) => p.dir === "up" && supply(p)).map((p) => p.net!))]
    for (const net of nets) {
      const caps: ComponentInstance[] = []
      for (let c = this.toGround(parts, net); c && caps.length < 4; c = this.toGround(parts.filter((x) => !caps.includes(x) && x !== c), net)) caps.push(c)
      if (!caps.length) continue
      const rots = caps.map((c) => this.turnWith(c, net, "up"))
      if (rots.some((r) => r === undefined)) continue
      const top = pins.filter((p) => p.net === net && p.dir === "up")
      const ext = (c: ComponentInstance, rot: Rotation) => {
        const sh = partShape(c, rot)
        return sh.texts.reduce((b, t) => union(b, t), sh.body)
      }
      const pitch = Math.max(...caps.map((c, i) => Math.ceil(ext(c, rots[i]!).maxX - ext(c, rots[i]!).minX))) + 2
      const barY = top[0].y + 1
      const cands: { side: number; h: number; off: number }[] = []
      for (const side of [-1, 1]) for (let h = 1; h <= 14; h++) for (let off = 2; off <= 10; off++) cands.push({ side, h, off })
      cands.sort((p, q) => p.h + p.off - (q.h + q.off) || p.side - q.side || p.h - q.h)
      for (const { side, h, off } of cands) {
        const edge = side < 0 ? Math.min(...top.map((p) => p.x)) : Math.max(...top.map((p) => p.x))
        // The outermost first: its wire is the bus the others tee into.
        const steps = caps.map((c, i) => this.spotWithPin(c, net, rots[i]!, edge + side * (off + i * pitch), barY + h)).reverse()
        yield steps
      }
    }
  }

  /**
   * The chain of small parts hanging off a pin alone: each a two-pin part whose net goes on to
   * the next and nothing else, ending at a rail, at a net that goes on elsewhere, or nowhere.
   */
  private chainFrom(pin: PinState, taken: Set<string>): { parts: ComponentInstance[]; end: RailKind | "net" } | null {
    const inCluster = (net: string) => this.ctx.nets.nets.get(net)!.pins.filter((k) => this.parts.has(k.slice(0, k.lastIndexOf(":"))))
    const out: ComponentInstance[] = []
    let net = pin.net!
    let from = `${pin.comp}:${pin.pin}`
    for (let depth = 0; depth < 3; depth++) {
      const here = inCluster(net).filter((k) => k !== from)
      if (here.length !== 1) break
      const id = here[0].slice(0, here[0].lastIndexOf(":"))
      const c = this.parts.get(id)!
      const pins = findPart(c.partId)?.pins ?? []
      if (pins.length !== 2 || isBoxPart(findPart(c.partId)) || taken.has(id) || this.placed.has(id) || this.isDecoupling(c)) break
      out.push(c)
      const other = pins.find((p) => `${id}:${p.number}` !== here[0])!
      const k = this.pinKind(c, other.number)
      if (k.kind === "rail") return { parts: out, end: this.ctx.nets.nets.get(k.net!)!.rail! }
      if (k.kind === "free" || !k.net) return { parts: out, end: "net" }
      from = `${id}:${other.number}`
      net = k.net
      // A net that goes on to more than one other pin, or out of the cluster, ends the chain.
      if (this.ctx.external(net) || inCluster(net).filter((x) => x !== from).length !== 1) return { parts: out, end: "net" }
    }
    return out.length ? { parts: out, end: "net" } : null
  }

  /**
   * Neighbouring pins on one side of the main part, each with a chain of its own (an LED and its
   * resistor, a pull-down), fanned out into upright columns beside that side: the top pin's
   * column furthest out, so no wire crosses another. Chains to ground hang down, to a supply
   * stand up. Parts that won't go where the fan puts them are left to be placed one by one.
   */
  private fanOut(main: ComponentInstance): Set<string> {
    const done = new Set<string>()
    const pins = this.pinStates.get(main.id) ?? []
    const taken = new Set<string>()
    for (const side of ["right", "left"] as Dir[]) {
      const along = pins.filter((p) => p.dir === side).sort((a, b) => b.y - a.y)
      // Runs of pins in a row, skipping unused ones, whose chains end the same way.
      type Item = { pin: PinState; chain: { parts: ComponentInstance[]; end: RailKind | "net" } }
      const runs: Item[][] = []
      let run: Item[] = []
      for (const p of along) {
        if (p.kind === "free") continue
        const chain = p.kind === "signal" && !p.wired ? this.chainFrom(p, taken) : null
        const way = (e: RailKind | "net") => (e === "power" ? "up" : "down")
        if (chain && (!run.length || way(run[0].chain.end) === way(chain.end))) {
          run.push({ pin: p, chain })
          for (const c of chain.parts) taken.add(c.id)
          continue
        }
        if (run.length) runs.push(run)
        run = chain ? [{ pin: p, chain }] : []
        if (chain) for (const c of chain.parts) taken.add(c.id)
      }
      if (run.length) runs.push(run)
      for (const r of runs) {
        if (r.length < 2) {
          for (const it of r) for (const c of it.chain.parts) taken.delete(c.id)
          continue
        }
        for (const id of this.fan(side, r)) done.add(id)
      }
    }
    return done
  }

  /** One fan: columns beside the side, outermost for the pin furthest from where they stand. */
  private fan(side: Dir, items: { pin: PinState; chain: { parts: ComponentInstance[]; end: RailKind | "net" } }[]): Set<string> {
    const done = new Set<string>()
    const up = items[0].chain.end === "power"
    // Columns stand below the run going down, above it going up; the pin nearest them is innermost.
    const ordered = up ? [...items].reverse() : items
    const sx = side === "right" ? 1 : -1
    // Upright turns for each part: the pin towards the main part pointing that way.
    const turnFor = (c: ComponentInstance, net: string): Rotation | undefined =>
      allowedTurns(c).find((rot) => partShape(c, rot).pins.every((p) => (this.pinKind(c, p.pin).net === net) === (p.dir === (up ? "down" : "up"))))
    const widths: number[] = []
    for (const it of items) {
      for (const c of it.chain.parts) {
        const sh = partShape(c, 90)
        const b = sh.texts.reduce((acc, t) => union(acc, t), sh.body)
        widths.push(b.maxX - b.minX)
      }
    }
    const pitch = Math.ceil(Math.max(...widths)) + 2
    // Clear of everything on this side of the main part but the fan's own labels, which go.
    const nets = new Set(items.map((it) => it.pin.net!))
    const box = this.bbox!
    const near = this.space
      .query({ minX: box.minX - 1, minY: box.minY - 1, maxX: box.maxX + 1, maxY: box.maxY + 1 })
      .filter((it) => it.kind !== "exit" && !(it.net && nets.has(it.net) && (it.kind === "slot" || it.kind === "tip")))
    let edge = side === "right" ? -Infinity : Infinity
    for (const it of near) edge = side === "right" ? Math.max(edge, it.box.maxX) : Math.min(edge, it.box.minX)
    for (const k of this.space.nodes.keys()) if (!nets.has(this.space.nodes.get(k)!.net)) edge = side === "right" ? Math.max(edge, nodeX(k)) : Math.min(edge, nodeX(k))
    edge = side === "right" ? Math.ceil(edge) : Math.floor(edge)
    const ys = items.map((it) => it.pin.y)
    const start = up ? Math.max(...ys) + 2 : Math.min(...ys) - 2
    for (let shiftOut = 0; shiftOut <= 12; shiftOut += 2) {
      this.beginAll()
      let ok = true
      ordered.forEach((it, i) => {
        if (!ok) return
        const col = ordered.length - 1 - i
        const x = edge + sx * (4 + shiftOut + Math.round(pitch / 2) + col * pitch)
        let y = start
        let net = it.pin.net!
        for (const c of it.chain.parts) {
          const rot = turnFor(c, net)
          if (rot === undefined) {
            ok = false
            return
          }
          const sh = partShape(c, rot)
          const top = sh.pins.find((p) => this.pinKind(c, p.pin).net === net)!
          const other = sh.pins.find((p) => p !== top)!
          // The pin towards the main part lands on `y`; the next part starts two steps on.
          const cy = y - top.y
          if (this.attempt(c, x, cy, rot, true) === null) {
            ok = false
            return
          }
          y = cy + other.y + (up ? 2 : -2)
          net = this.pinKind(c, other.pin).net ?? net
        }
      })
      this.endAll(ok)
      if (ok) {
        for (const it of items) for (const c of it.chain.parts) done.add(c.id)
        return done
      }
    }
    return done
  }

  /** Whether a part sits between a supply and ground and nothing else: a decoupling capacitor. */
  private isDecoupling(c: ComponentInstance): boolean {
    const k = (findPart(c.partId)?.pins ?? []).map((p) => this.pinKind(c, p.number))
    const rail = (x: { net: string | null }) => (x.net ? this.ctx.nets.nets.get(x.net)!.rail : null)
    return k.length === 2 && k.every((x) => x.kind === "rail") && k.some((x) => rail(x) === "power") && k.some((x) => rail(x) === "ground")
  }

  /**
   * Decoupling capacitors in rows above the main part, each upright with its supply's port on top
   * and ground's below, in the order of the supplies they serve; or, for a cluster of nothing else,
   * in a row beside the first. Rows wrap at about the main part's width. Those that won't fit are
   * left to be placed like any other part.
   */
  private decouplingRow(main: ComponentInstance, parts: ComponentInstance[]): Set<string> {
    const placed = new Set<string>()
    const railOf = (net: string | null) => (net ? this.ctx.nets.nets.get(net)!.rail : null)
    const caps = parts.filter((c) => c !== main && this.isDecoupling(c))
    if (!caps.length) return placed
    // Upright: the supply pin pointing up.
    const upright = (c: ComponentInstance) =>
      allowedTurns(c).find((rot) => partShape(c, rot).pins.every((p) => (railOf(this.pinKind(c, p.pin).net) === "power" ? p.dir === "up" : p.dir === "down")))
    const supply = (c: ComponentInstance) => (findPart(c.partId)?.pins ?? []).map((p) => this.pinKind(c, p.number).net!).find((n) => railOf(n) === "power")!
    // The supplies in the order the main part's pins on them run, left to right.
    const mainPins = this.pinStates.get(main.id) ?? []
    const at = (net: string) => {
      const xs = mainPins.filter((p) => p.net === net).map((p) => p.x)
      return xs.length ? Math.min(...xs) : Infinity
    }
    const row = caps
      .map((c) => ({ c, rot: upright(c) }))
      .filter((x): x is { c: ComponentInstance; rot: Rotation } => x.rot !== undefined)
      .sort((a, b) => at(supply(a.c)) - at(supply(b.c)) || (supply(a.c) < supply(b.c) ? -1 : supply(a.c) > supply(b.c) ? 1 : 0) || byRef(a.c, b.c))
    if (!row.length) return placed
    const ext = (x: { c: ComponentInstance; rot: Rotation }) => {
      const sh = partShape(x.c, x.rot)
      return sh.texts.reduce((b, t) => union(b, t), sh.body)
    }
    const pitch = Math.max(...row.map((x) => Math.ceil(ext(x).maxX - ext(x).minX))) + 2
    const at0 = this.placed.get(main.id)!
    const body = shift(partShape(main, at0.rot).body, at0.x, at0.y)
    const alone = this.isDecoupling(main)
    const perRow = alone ? row.length : Math.max(6, Math.ceil((body.maxX - body.minX) / pitch) + 1)
    let y: number | null = alone ? at0.y : null
    let floor = Math.ceil(this.bbox!.maxY) + 6
    this.straightRails = true
    for (let r = 0; r < row.length; r += perRow) {
      const line = row.slice(r, r + perRow)
      let x = alone && r === 0 ? at0.x + pitch : Math.round((body.minX + body.maxX) / 2 - ((line.length - 1) * pitch) / 2)
      if (!alone) y = null
      for (const item of line) {
        let done = false
        // The first of a row finds its height, as low as it goes; the rest keep to it.
        const ys: number[] = y === null ? Array.from({ length: 24 }, (_, i) => floor + i) : [y]
        for (const yy of ys) {
          for (let dx = 0; dx <= 24 && !done; dx++) {
            if (!this.roomFor(shift(partShape(item.c, item.rot).body, x + dx, yy))) continue
            // The row's first stands a step above the lowest it could, so its ground port and
            // the main part's supply port below have air between their names.
            const at = y === null && this.attempt(item.c, x + dx, yy + 1, item.rot, false) !== null ? yy + 1 : yy
            if (this.attempt(item.c, x + dx, at, item.rot, true) === null) continue
            placed.add(item.c.id)
            x += dx + pitch
            y = at
            done = true
          }
          if (done) break
        }
      }
      // The next row up clears this one's supply ports with the same air as the first.
      if (y !== null) floor = y + 14
    }
    this.straightRails = false
    return placed
  }

  /** Nets this part shares with other parts of the block, other than rails. */
  private links(c: ComponentInstance): string[] {
    const out: string[] = []
    for (const p of findPart(c.partId)?.pins ?? []) {
      const { net, kind } = this.pinKind(c, p.number)
      if (kind !== "signal" || !net || out.includes(net)) continue
      const others = this.ctx.nets.nets.get(net)!.pins.some((k) => !k.startsWith(`${c.id}:`) && this.parts.has(k.slice(0, k.lastIndexOf(":"))))
      if (others) out.push(net)
    }
    return out
  }

  /**
   * Parts across two of the main part's own nets (a crystal across its oscillator pins, a resistor
   * between two of its pins). They go first, so they sit right at those pins and their own small
   * parts hang off them.
   */
  private bridges(main: ComponentInstance, parts: ComponentInstance[]): ComponentInstance[] {
    const mainNets = new Set(this.links(main))
    return parts.filter((c) => c !== main && isHelper(c) && this.links(c).length >= 2 && this.links(c).every((n) => mainNets.has(n))).sort(byRef)
  }

  /** Parts in the order they are placed: along what connects them to the placed ones, depth first. */
  private order(main: ComponentInstance, parts: ComponentInstance[]): ComponentInstance[] {
    const seen = new Set([main.id])
    const out: ComponentInstance[] = []
    // On each net, the parts that bridge to other nets (a crystal, a series resistor) go first,
    // so they sit across the pins they join and the rest hangs off them.
    const byNet = new Map<string, ComponentInstance[]>()
    const linkCount = new Map(parts.map((c) => [c.id, this.links(c).length]))
    for (const c of parts) for (const n of this.links(c)) byNet.set(n, [...(byNet.get(n) ?? []), c])
    for (const list of byNet.values()) list.sort((a, b) => linkCount.get(b.id)! - linkCount.get(a.id)! || byRef(a, b))
    const visit = (c: ComponentInstance) => {
      for (const port of findPart(c.partId)?.symbol.ports ?? []) {
        const { net, kind } = this.pinKind(c, port.pin)
        if (kind !== "signal" || !net) continue
        for (const o of byNet.get(net) ?? []) {
          if (seen.has(o.id)) continue
          seen.add(o.id)
          out.push(o)
          visit(o)
        }
      }
    }
    const bridges = this.bridges(main, parts)
    for (const b of bridges) {
      seen.add(b.id)
      out.push(b)
    }
    for (const b of bridges) visit(b)
    visit(main)
    // What is left reaches the rest only through rails or other blocks: decoupling first.
    const railOnly = (c: ComponentInstance) => (findPart(c.partId)?.pins ?? []).every((p) => this.pinKind(c, p.number).kind !== "signal")
    const rest = parts.filter((c) => !seen.has(c.id)).sort((a, b) => Number(railOnly(b)) - Number(railOnly(a)) || byRef(a, b))
    for (const c of rest) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push(c)
      visit(c)
    }
    return out
  }

  /** What a part costs at least at a turn, wherever it goes: its turn and a label per net leaving the cluster. */
  private fixedCost(c: ComponentInstance, shape: PartShape): number {
    const nets = new Set<string>()
    for (const p of shape.pins) {
      const { net, kind } = this.pinKind(c, p.pin)
      // Nets that leave the cluster: a net Tidy names because it had to label it costs nothing
      // here, so naming it can't change where a second tidy puts things.
      if (kind === "signal" && net && this.ctx.external(net)) nets.add(net)
    }
    return this.orientPenalty(c, shape) + nets.size
  }

  /** The turns of a two-pin part with a port that stand it upright: ground down, a supply up. */
  private uprightTurns(c: ComponentInstance): Rotation[] {
    if ((findPart(c.partId)?.pins.length ?? 0) !== 2) return []
    const rails = (findPart(c.partId)?.pins ?? []).filter((p) => this.pinKind(c, p.number).kind === "rail")
    if (!rails.length) return []
    return allowedTurns(c).filter((rot) =>
      partShape(c, rot).pins.every((p) => {
        const k = this.pinKind(c, p.pin)
        if (k.kind !== "rail") return true
        return p.dir === (this.ctx.nets.nets.get(k.net!)!.rail === "ground" ? "down" : "up")
      }),
    )
  }

  private placePart(c: ComponentInstance) {
    // Upright where it can be, even with a port where a wire would have been; any way where it can't.
    const upright = this.uprightTurns(c)
    if (upright.length && upright.length < allowedTurns(c).length && this.placeAt(c, upright, true)) return
    // A capacitor from a supply to ground never lies on its side: unwired and upright, if it must.
    if (upright.length && this.supplyToGround(c)) return this.placeUnwired(c, upright)
    if (this.placeAt(c, allowedTurns(c), true)) return
    this.placeUnwired(c)
  }

  /** A two-pin part from a supply (wired or not) to ground. */
  private supplyToGround(c: ComponentInstance): boolean {
    const pins = findPart(c.partId)?.pins ?? []
    if (pins.length !== 2) return false
    const rails = pins.map((p) => {
      const net = this.pinKind(c, p.number).net
      return net ? this.ctx.nets.nets.get(net)!.rail : null
    })
    return rails.includes("ground") && rails.includes("power")
  }

  /**
   * The cheapest spot at these turns near what the part connects to, taken; false if none fits.
   * With `partly`, a spot where one of its wires can't be drawn will do when no other can.
   */
  private placeAt(c: ComponentInstance, turns: Rotation[], partly: boolean): boolean {
    const links = (isHelper(c) ? this.links(c) : this.links(c).filter((n) => this.isSupply(n))).filter((n) => this.groups.get(n)?.length)
    type Cand = { x: number; y: number; rot: Rotation; extra: number }
    const queue = new Buckets<Cand>()
    const bbox = this.bbox!
    const extent = (shape: PartShape) => shape.texts.reduce((b, t) => union(b, t), shape.body)
    if (links.length) {
      // Around what it connects to: each linked net costs at least the distance from the nearest
      // front of its pins on that net to the nearest point it could be wired to.
      const targets: Pt[] = []
      for (const n of links) for (const g of this.groups.get(n)!) for (const k of this.targetsOf(g).keys()) targets.push([nodeX(k), nodeY(k)])
      if (targets.length) {
        const field = new DistanceField(targets, REACH + 4)
        for (const rot of turns) {
          const shape = partShape(c, rot)
          const fixed = this.fixedCost(c, shape)
          const ext = extent(shape)
          const byNet = links
            .map((n) => shape.pins.filter((p) => this.pinKind(c, p.pin).net === n).map((p) => [p.x + VEC[p.dir][0], p.y + VEC[p.dir][1]] as Pt))
            .filter((f) => f.length)
          const lead = byNet[0][0]
          const limit = (REACH + 1) * byNet.length
          const span = bbox.maxX - bbox.minX + (bbox.maxY - bbox.minY)
          for (let gx = field.box.minX; gx <= field.box.maxX; gx++) {
            for (let gy = field.box.minY; gy <= field.box.maxY; gy++) {
              // The lead pin's own distance first: most spots are out of reach on it alone.
              if (field.at(gx, gy) > REACH) continue
              const ox = gx - lead[0]
              const oy = gy - lead[1]
              let dist = 0
              for (const fronts of byNet) {
                let d = Infinity
                for (const [fx, fy] of fronts) d = Math.min(d, field.at(fx + ox, fy + oy))
                dist += d + 1
              }
              if (dist > limit) continue
              const grow =
                Math.max(bbox.maxX, ext.maxX + ox) - Math.min(bbox.minX, ext.minX + ox) + (Math.max(bbox.maxY, ext.maxY + oy) - Math.min(bbox.minY, ext.minY + oy)) - span
              queue.add(fixed + dist + grow * W_GROW, { x: ox, y: oy, rot, extra: 0 })
            }
          }
        }
      }
    }
    if (!links.length || !queue.size) {
      const [ax, ay] = this.affinity(c)
      for (const rot of turns) {
        const shape = partShape(c, rot)
        const fixed = this.fixedCost(c, shape)
        const ext = extent(shape)
        const R = 12
        const span = bbox.maxX - bbox.minX + (bbox.maxY - bbox.minY)
        for (let gx = ax - R; gx <= ax + R; gx++) {
          for (let gy = ay - R; gy <= ay + R; gy++) {
            const extra = (Math.abs(gx - ax) + Math.abs(gy - ay)) * W_DIST
            const grow =
              Math.max(bbox.maxX, ext.maxX + gx) - Math.min(bbox.minX, ext.minX + gx) + (Math.max(bbox.maxY, ext.maxY + gy) - Math.min(bbox.minY, ext.minY + gy)) - span
            queue.add(fixed + extra + grow * W_GROW, { x: gx, y: gy, rot, extra })
          }
        }
      }
    }
    let best: { c: Cand; cost: number } | null = null
    let tries = 0
    let looked = 0
    let wiredTries = 0
    /** The best spot where one of its wires couldn't be drawn: taken only if none can have all. */
    let partial: { c: Cand; cost: number } | null = null
    for (let next = queue.next(); next; next = queue.next()) {
      const { v: cand, lb } = next
      if (best && lb >= best.cost) break
      if (tries > MAX_TRIES && best) break
      if (wiredTries > MAX_WIRED && (best || partial)) break
      if (++looked > MAX_LOOKS && (best || partial)) break
      // Most spots are on top of something: a cheap look before drawing anything.
      if (!this.roomFor(shift(partShape(c, cand.rot).body, cand.x, cand.y))) continue
      this.wired = false
      this.partial = false
      const cost = this.attempt(c, cand.x, cand.y, cand.rot, false, best ? best.cost - cand.extra : Infinity)
      // Only spots wired whole count against the budget; most are refused at once.
      if (this.wired) wiredTries++
      if (cost === null) continue
      if (this.partial) {
        if (!partial || cost + cand.extra < partial.cost) partial = { c: cand, cost: cost + cand.extra }
        continue
      }
      tries++
      if (!best || cost + cand.extra < best.cost) best = { c: cand, cost: cost + cand.extra }
    }
    if (partly) best ??= partial
    return !!best && this.attempt(c, best.c.x, best.c.y, best.c.rot, true) !== null
  }

  /** Nothing near fits: the nearest free spot around where it would like to be, unwired, its nets reached by labels. */
  private placeUnwired(c: ComponentInstance, turns = allowedTurns(c)) {
    const [ax, ay] = this.affinity(c)
    // Upright first: power ports up, ground down.
    const upright = [...turns].sort((a, b) => this.orientPenalty(c, partShape(c, a)) - this.orientPenalty(c, partShape(c, b)))
    // Spots drawn for real, at most: a part that fits nowhere near fails in a moment, not a minute.
    let tries = 0
    for (let r = 0; r < 400 && tries < MAX_UNWIRED; r += 2) {
      for (const [dx, dy] of ring(r)) {
        for (const rot of upright) {
          if (!this.roomFor(shift(partShape(c, rot).body, ax + dx, ay + dy))) continue
          if (++tries > MAX_UNWIRED) break
          this.noWire = true
          const ok = this.attempt(c, ax + dx, ay + dy, rot, true) !== null
          this.noWire = false
          if (ok) return
        }
      }
    }
    throw new Error(`Tidy: no room for ${c.ref}: ${this.why}`)
  }

  /**
   * Where a part with nothing wired to it would like to be: a decoupling capacitor beside a pin
   * on its supply (the pins taken in turn, so caps spread over them), anything else below.
   */
  private affinity(c: ComponentInstance): Pt {
    const hit = this.affinityCache.get(c.id)
    if (hit) return hit
    let at: Pt | null = null
    // Beside the pins it shares nets with, out past them.
    const own = new Set((findPart(c.partId)?.pins ?? []).map((p) => this.pinKind(c, p.number)).filter((k) => k.kind === "signal").map((k) => k.net!))
    const near = [...this.pinStates.values()].flat().filter((p) => p.comp !== c.id && p.net && own.has(p.net))
    if (near.length) {
      let mx = 0
      let my = 0
      let dx = 0
      let dy = 0
      for (const p of near) {
        mx += p.x / near.length
        my += p.y / near.length
        dx += VEC[p.dir][0]
        dy += VEC[p.dir][1]
      }
      const out = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)]
      at = [Math.round(mx + out[0] * 12), Math.round(my + out[1] * 12)]
    }
    const supplies = (findPart(c.partId)?.pins ?? [])
      .map((p) => this.pinKind(c, p.number))
      .filter((k) => k.kind === "rail" && this.ctx.nets.nets.get(k.net!)!.rail === "power")
      .map((k) => k.net!)
    for (const net of at ? [] : supplies) {
      const pins = [...this.pinStates.values()].flat().filter((p) => p.net === net && p.comp !== c.id)
      if (!pins.length) continue
      const used = this.railUse.get(net) ?? 0
      this.railUse.set(net, used + 1)
      const p = pins[used % pins.length]
      const [dx, dy] = VEC[p.dir]
      at = [p.x + dx * 6, p.y + dy * 6]
      break
    }
    if (!at) {
      const b = this.bbox!
      at = [Math.round((b.minX + b.maxX) / 2), Math.round(b.minY) - 6]
    }
    this.affinityCache.set(c.id, at)
    return at
  }

  // ---------- Finishing ----------

  private finish(): BlockDrawing {
    // Groups left apart, and nets that need naming, each get a label.
    const key = (net: string) => this.ctx.nets.nets.get(net)!.key
    const nets = [...this.groups.keys()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    for (const net of nets) {
      const groups = this.groups.get(net)!
      if (!this.needsLabel(net, true)) {
        for (const g of groups) this.dropSlot(g)
        continue
      }
      for (const g of [...groups]) {
        if (g.slot) continue
        if (this.placeSlot(g, [1, 2, 3, 4, 5, 6, 8, 10, 12]) !== null || this.escape(g)) continue
        // Boxed in: its wires go, and each pin gets a label of its own instead.
        for (const w of g.wires) this.space.removeWire(w, net)
        groups.splice(groups.indexOf(g), 1)
        for (const p of g.pins) {
          p.wired = false
          const single: Group = { net, pins: [p], wires: [], slot: null }
          groups.push(single)
          if (this.placeSlot(single, [1, 2, 3, 4, 5, 6, 8, 10, 12]) === null && !this.escape(single)) {
            throw new Error(`Tidy: no room for a label of ${this.ctx.labelName(net)}`)
          }
        }
      }
      // The net's other names still without room: on any of its groups, further out.
      for (const g of groups) {
        if (!this.aliasesOf(net).length) break
        this.placeAliases(g, [1, 2, 3, 4, 5, 6, 8, 10, 12])
      }
    }
    if (this.style !== "first") this.labelsAcross(nets)
    this.space.commit()
    const parts = new Map<string, { x: number; y: number; rot: Rotation }>()
    for (const [id, p] of this.placed) parts.set(id, { x: world(p.x), y: world(p.y), rot: p.rot })
    const wires: BlockDrawing["wires"] = []
    const labels: DrawnLabel[] = []
    const ports: DrawnPort[] = []
    const toWorld = (pts: Pt[]) => corners(pts).map(([x, y]) => ({ x: world(x), y: world(y) }))
    for (const net of nets) {
      for (const g of this.groups.get(net)!) {
        for (const w of g.wires) wires.push({ net, points: toWorld(w) })
        if (!g.slot) continue
        const { stub, dir } = g.slot
        if (stub.length > 1) wires.push({ net, points: toWorld(stub) })
        const [lx, ly] = stub[stub.length - 1]
        const info = this.ctx.nets.nets.get(net)!
        if (info.rail) {
          const ps = portShape(info.rail, info.name, dir)
          ports.push({ partId: ps.partId, net, name: info.name, x: world(lx + ps.ox), y: world(ly + ps.oy), rot: ps.rot })
        } else labels.push({ net, name: this.ctx.labelName(net), x: world(lx), y: world(ly), rot: labelTurn(dir) })
      }
    }
    for (const net of nets) {
      for (const g of this.groups.get(net)!) {
        for (const a of g.extra ?? []) {
          const { stub, dir } = a.slot
          if (stub.length > 1) wires.push({ net, points: toWorld(stub) })
          const [lx, ly] = stub[stub.length - 1]
          labels.push({ net, name: a.name, x: world(lx), y: world(ly), rot: labelTurn(dir) })
        }
      }
    }
    for (const r of this.rails) {
      const name = this.ctx.nets.nets.get(r.net)!.name
      for (const w of r.wires) wires.push({ net: r.net, points: toWorld(w) })
      if (r.port) {
        const ps = portShape(r.port.kind, name, r.port.out)
        ports.push({ partId: ps.partId, net: r.net, name, x: world(r.port.at[0] + ps.ox), y: world(r.port.at[1] + ps.oy), rot: ps.rot })
      }
    }
    const b = this.space.bounds() ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    const extent = { minX: world(Math.floor(b.minX)), minY: world(Math.floor(b.minY)), maxX: world(Math.ceil(b.maxX)), maxY: world(Math.ceil(b.maxY)) }
    return { parts, wires, labels, ports, extent }
  }

  /**
   * Labels that ended up reading down, once everything is drawn: each found room again where it
   * reads across, further out or on a wire of its own if need be; left as it was where none has.
   */
  private labelsAcross(nets: string[]) {
    for (const net of nets) {
      if (this.ctx.nets.nets.get(net)!.rail) continue
      for (const g of this.groups.get(net) ?? []) {
        const slot = g.slot
        if (!slot || !isVertical(slot.dir)) continue
        const mark = this.space.mark()
        this.dropOne(net, slot)
        g.slot = null
        this.acrossOnly = true
        const ok = this.placeSlot(g, [1, 2, 3, 4, 5, 6, 8, 10, 12]) !== null || this.escape(g)
        this.acrossOnly = false
        if (ok) continue
        this.space.rollback(mark)
        g.slot = slot
      }
    }
  }

  /**
   * Whether a terminal at the end of `path`, running `dir`, would lie over the path itself: a way
   * that doubles back under its own label. The wire is drawn only once the label has room, so the
   * label's own check can't see it.
   */
  private overOwnStub(net: string, path: Pt[], dir: Dir): boolean {
    if (this.style === "first") return false
    const [x, y] = path[path.length - 1]
    const rail = this.alias ? null : this.ctx.nets.nets.get(net)!.rail
    const boxes = rail ? [portShape(rail, this.ctx.nets.nets.get(net)!.name, dir).body, portShape(rail, this.ctx.nets.nets.get(net)!.name, dir).text] : [labelShape(this.alias ?? this.ctx.labelName(net), dir)]
    return path.slice(0, -1).some(([px, py]) => boxes.some((b) => px > b.minX + x - 0.1 && px < b.maxX + x + 0.1 && py > b.minY + y - 0.1 && py < b.maxY + y + 0.1))
  }

  /** A label (a supply's port) on a wire of its own, wherever the nearest room is, for a group boxed in where it is. */
  private escape(g: Group): boolean {
    const starts = this.startsOf(g)
    // A net's other name may start anywhere on its wires that a wire could leave from.
    if (this.alias) {
      const tips = new Set(g.pins.map((p) => nodeKey(p.x, p.y)))
      for (const w of g.wires) for (const [x, y] of w) if (!tips.has(nodeKey(x, y))) for (const d of DIRS) if (!this.hasEdge(x, y, d)) starts.push({ x, y, dir: d })
      // Or off the stub of one of its labels or ports, across it.
      const stubs = [g.slot?.stub, ...(g.extra ?? []).map((a) => a.slot.stub)]
      for (const stub of stubs) {
        if (!stub || stub.length < 3) continue
        for (let i = 1; i < stub.length - 1; i++) {
          const across: Dir[] = stub[i][0] === stub[i - 1][0] ? ["left", "right"] : ["up", "down"]
          for (const d of across) starts.push({ x: stub[i][0], y: stub[i][1], dir: d })
        }
      }
    }
    const fronts = new Set(g.pins.filter((p) => !p.wired).map((p) => nodeKey(p.x + VEC[p.dir][0], p.y + VEC[p.dir][1])))
    // Cheapest first over the free grid, trying the label at every point reached, running on.
    const heap = new Heap()
    const seen = new Map<number, { cost: number; from: number | null; x: number; y: number; d: number }>()
    const stateKey = (x: number, y: number, d: number) => nodeKey(x, y) * 4 + d
    for (const st of starts) {
      const [dx, dy] = VEC[st.dir]
      const x = st.x + dx
      const y = st.y + dy
      if (this.blockedFor(g.net, x, y, fronts)) continue
      const k = stateKey(x, y, DIRS.indexOf(st.dir))
      seen.set(k, { cost: 1, from: null, x: st.x, y: st.y, d: DIRS.indexOf(st.dir) })
      heap.push(1, k)
    }
    let expansions = 0
    while (heap.size && expansions++ < 4000) {
      const [cost, k] = heap.pop()!
      const node = Math.floor(k / 4)
      const d = k % 4
      const x = nodeX(node)
      const y = nodeY(node)
      if (seen.get(k)!.cost < cost) continue
      const dir = DIRS[d]
      const owner = `slot:${g.net}:${x},${y}`
      const mark = this.space.mark()
      const drawn = this.drawn
      // The way here, from where it left the group.
      const path: Pt[] = []
      for (let s: number | null = k; s !== null; ) {
        const st: { from: number | null; x: number; y: number } = seen.get(s)!
        path.push([nodeX(Math.floor(s / 4)), nodeY(Math.floor(s / 4))])
        if (st.from === null) path.push([st.x, st.y])
        s = st.from
      }
      path.reverse()
      const terminal = (this.acrossOnly && !this.across(g.net, dir)) || this.overOwnStub(g.net, path, dir) ? null : this.putTerminal(g.net, x, y, dir)
      if (terminal !== null) {
        this.addWire(path, g.net)
        let sb: Box | null = null
        for (const [px, py] of path.slice(1)) sb = union(sb, ptBox(px, py))
        const items = [...terminal]
        if (sb) items.push(this.space.add(inflate(sb, 0.2), "slot", owner, g.net))
        if (this.alias) g.extra = [...(g.extra ?? []), { name: this.alias, slot: { stub: path, dir, items, wire: true } }]
        else g.slot = { stub: path, dir, items, wire: true }
        return true
      }
      this.space.rollback(mark)
      this.drawn = drawn
      if (cost > 40) continue
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (d + 2) % 4) continue
        const [vx, vy] = VEC[DIRS[nd]]
        const nx = x + vx
        const ny = y + vy
        if (this.blockedFor(g.net, nx, ny)) continue
        const nk = stateKey(nx, ny, nd)
        const nc = cost + 1 + (nd === d ? 0 : BEND)
        if ((seen.get(nk)?.cost ?? Infinity) <= nc) continue
        seen.set(nk, { cost: nc, from: k, x, y, d: nd })
        heap.push(nc, nk)
      }
    }
    return false
  }
}

/** Offsets at Chebyshev distance `r`, every other grid point, nearest the axes first. */
function ring(r: number): Pt[] {
  if (r === 0) return [[0, 0]]
  const out: Pt[] = []
  for (let i = -r; i <= r; i += 2) out.push([i, -r], [i, r])
  for (let i = -r + 2; i <= r - 2; i += 2) out.push([-r, i], [r, i])
  return out.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])) || a[1] - b[1] || a[0] - b[0])
}

/** Manhattan distance to the nearest of some points, over a window around them. */
class DistanceField {
  readonly box: Box
  private w: number
  private d: Float64Array
  constructor(points: Pt[], reach: number) {
    let b: Box | null = null
    for (const [x, y] of points) b = union(b, ptBox(x, y))
    this.box = inflate(b!, reach)
    this.w = this.box.maxX - this.box.minX + 1
    const h = this.box.maxY - this.box.minY + 1
    const d = new Float64Array(this.w * h).fill(Infinity)
    for (const [x, y] of points) d[(y - this.box.minY) * this.w + (x - this.box.minX)] = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1)
        if (y > 0) d[i] = Math.min(d[i], d[i - this.w] + 1)
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = this.w - 1; x >= 0; x--) {
        const i = y * this.w + x
        if (x < this.w - 1) d[i] = Math.min(d[i], d[i + 1] + 1)
        if (y < h - 1) d[i] = Math.min(d[i], d[i + this.w] + 1)
      }
    }
    this.d = d
  }
  at(x: number, y: number) {
    if (x < this.box.minX || x > this.box.maxX || y < this.box.minY || y > this.box.maxY) return 1e6
    return this.d[(y - this.box.minY) * this.w + (x - this.box.minX)]
  }
}

/** The part a block is drawn around: the most pins, a chip before a connector before a discrete part. */
export function pickMain(parts: ComponentInstance[], links: (c: ComponentInstance) => number): ComponentInstance {
  const pins = (c: ComponentInstance) => findPart(c.partId)?.pins.length ?? 0
  const rank = (c: ComponentInstance) => {
    const p = findPart(c.partId)
    return p && (p.category === "ICs" || p.category === "Modules") ? 2 : p?.category === "Connectors" ? 1 : 0
  }
  return [...parts].sort((a, b) => pins(b) - pins(a) || rank(b) - rank(a) || links(b) - links(a) || byRef(a, b))[0]
}
