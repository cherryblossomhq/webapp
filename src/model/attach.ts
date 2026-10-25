import { boxesOverlap, normBox, pointOnSegment, polylineSegments, round, type Box } from "../lib/geometry"
import { SpatialHash, pointBox } from "../lib/spatialHash"
import { dirVector, powerNetName, schematicPins, unitOwners, type WorldPin } from "./instances"
import { findPart } from "./library"
import { AUTO_NET_NAME, describeGroups, groupOf, harmlessGroups, pinGroup, pinText } from "./merges"
import { addLabel, addWire, findPin, wireRoute } from "./ops"
import type { SchematicConnectivity } from "./connectivity"
import type { PinRef, Project, Rotation, Vec2 } from "./types"

/**
 * How far in front of a pin nothing else may be drawn: the shortest label stub. A wire, stub or
 * label that touches this space joins whatever the pin gets later, or leaves the pin no way out.
 */
export const PIN_CORRIDOR = 0.3
/** Straight stub lengths tried for a net label, shortest first. */
const STUB_LENGTHS = [0.3, 0.5, 0.9]
const EPS = 1e-4

/** Wires and net labels to draw. A label with no wire sits on the pin itself. */
export interface Drawn {
  wires: Vec2[][]
  labels: { name: string; at: Vec2; rot: Rotation }[]
}

/** Why a way of drawing was dropped. */
export type Block = { kind: "join"; groups: string[] } | { kind: "pin"; pin: string }

const pk = (p: Vec2) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`
const pt = (x: number, y: number): Vec2 => ({ x: round(x), y: round(y) })
const rotOf = (d: Vec2): Rotation => (d.x > 0 ? 0 : d.y > 0 ? 90 : d.x < 0 ? 180 : 270)
const pad = (b: Box, by: number): Box => ({ minX: b.minX - by, maxX: b.maxX + by, minY: b.minY - by, maxY: b.maxY + by })

/** The space in front of a pin that stays free. */
const corridorOf = (pin: WorldPin): Box => {
  const d = dirVector(pin.dir)
  return normBox(pin.pos, { x: pin.pos.x + d.x * PIN_CORRIDOR, y: pin.pos.y + d.y * PIN_CORRIDOR })
}

/**
 * Everything drawn in the schematic, indexed once, so that a way of drawing a connection can be
 * judged without computing the whole design's connectivity again: it reports the nets the new
 * wires and labels would touch, using the same rules `computeConnectivity` does (a vertex on a
 * pin, wire vertex or label; a wire end or label on a wire; a label's name).
 */
export class Drawing {
  /** Point -> the nets of whatever sits there: pins, wire vertices, labels. */
  private owners = new Map<string, string[]>()
  /** Wire ends and labels, which join a wire they lie on. */
  private probes = new SpatialHash<{ p: Vec2; group: string }>()
  private segments = new SpatialHash<{ a: Vec2; b: Vec2; group: string }>()
  private pins = new SpatialHash<WorldPin & { key: string }>()
  private names = new Map<string, Set<string>>()
  private harmless: Set<string>

  constructor(project: Project, before: SchematicConnectivity) {
    this.harmless = harmlessGroups(before)
    for (const c of project.components) {
      const power = powerNetName(c)
      const part = findPart(c.partId)
      // The second pin of a number in a symbol that keeps them apart has a net the connectivity does not
      // give by pin number: it is a group of its own, so nothing is ever drawn onto it by mistake.
      const apart = !!part?.jumpers && !part.jumpers.duplicates
      for (const pin of schematicPins(c)) {
        const key = `${c.id}:${pin.pin}`
        const group = apart && pin.slot ? `solo:${key}#${pin.slot}` : groupOf(before, key)
        this.own(pin.pos, group)
        this.pins.insert({ ...pin, key }, pointBox(pin.pos))
        if (power) this.name(power, group)
      }
    }
    for (const w of project.wires) {
      this.addWire(w.points, before.wireNet.get(w.id) ?? `wire:${w.id}`)
    }
    for (const l of project.labels) {
      const group = before.labelNet.get(l.id) ?? `label:${l.id}`
      this.addLabel(l, l.name, group)
    }
  }

  private own(p: Vec2, group: string) {
    const key = pk(p)
    const list = this.owners.get(key)
    if (list) list.push(group)
    else this.owners.set(key, [group])
  }

  private name(name: string, group: string) {
    const set = this.names.get(name) ?? new Set<string>()
    set.add(group)
    this.names.set(name, set)
  }

  private addWire(points: Vec2[], group: string) {
    for (const p of points) this.own(p, group)
    if (points.length < 2) return
    this.probes.insert({ p: points[0], group }, pointBox(points[0]))
    const last = points[points.length - 1]
    this.probes.insert({ p: last, group }, pointBox(last))
    for (const [a, b] of polylineSegments(points)) this.segments.insert({ a, b, group }, normBox(a, b))
  }

  private addLabel(at: Vec2, name: string, group: string) {
    this.own(at, group)
    this.probes.insert({ p: at, group }, pointBox(at))
    this.name(name.trim(), group)
  }

  /** The nets that carry `name` in the drawing as it is. */
  groupsNamed(name: string): string[] {
    return [...(this.names.get(name.trim()) ?? [])]
  }

  /**
   * Null when `d` can be drawn, else the first thing wrong with it. `self` are the pins it comes
   * out of (their space is theirs to use); every net it touches must be one of `allowed`, apart
   * from loose wire that carries no pin and no name. Unless `keepCorridors` is off, it may not
   * touch the space in front of any other pin either.
   */
  check(d: Drawn, self: ReadonlySet<string>, allowed: ReadonlySet<string>, keepCorridors = true): Block | null {
    const segments = d.wires.flatMap((w) => polylineSegments(w))
    const boxes = [...segments.map(([a, b]) => normBox(a, b)), ...d.labels.map((l) => pointBox(l.at))]
    for (const box of keepCorridors ? boxes : []) {
      for (const pin of this.pins.query(pad(box, PIN_CORRIDOR + EPS))) {
        if (!self.has(pin.key) && boxesOverlap(pad(corridorOf(pin), EPS), pad(box, EPS))) return { kind: "pin", pin: pin.key }
      }
    }

    const touched = new Set<string>()
    const points = [...d.wires.flat(), ...d.labels.map((l) => l.at)]
    for (const p of points) for (const g of this.owners.get(pk(p)) ?? []) touched.add(g)
    const probes = [...d.wires.filter((w) => w.length >= 2).flatMap((w) => [w[0], w[w.length - 1]]), ...d.labels.map((l) => l.at)]
    for (const p of probes) {
      for (const s of this.segments.query(pointBox(p))) if (pointOnSegment(p, s.a, s.b)) touched.add(s.group)
    }
    for (const [a, b] of segments) {
      for (const e of this.probes.query(normBox(a, b))) if (pointOnSegment(e.p, a, b)) touched.add(e.group)
    }
    for (const l of d.labels) for (const g of this.names.get(l.name.trim()) ?? []) touched.add(g)
    const bad = [...touched].filter((g) => !allowed.has(g) && !this.harmless.has(g))
    return bad.length ? { kind: "join", groups: bad } : null
  }

  /** Draw `d` in the index; what it carries is on `group`. */
  accept(d: Drawn, group: string) {
    for (const w of d.wires) this.addWire(w, group)
    for (const l of d.labels) this.addLabel(l.at, l.name, group)
  }
}

/**
 * Where a pin is drawn. A pin of a part with several units is drawn by the component that is that
 * unit, which may not be the one the reference names (the part's own): then the unit that draws it.
 */
export function drawnPin(project: Project, ref: PinRef): WorldPin | null {
  const own = findPin(project, ref)
  if (own) return own
  for (const [twin, owner] of unitOwners(project.components)) {
    if (owner !== ref.componentId) continue
    const pin = findPin(project, { componentId: twin, pin: ref.pin })
    if (pin) return pin
  }
  return null
}

export function applyDrawn(project: Project, d: Drawn): Project {
  let next = project
  for (const w of d.wires) next = addWire(next, w).project
  for (const l of d.labels) next = addLabel(next, l.name, l.at, l.rot).project
  return next
}

/** Ways to tie a net label to a pin, in the order to try them: straight stubs, bent stubs, the pin itself. */
export function labelOptions(pin: WorldPin, name: string): Drawn[] {
  const d = dirVector(pin.dir)
  const along = (len: number) => pt(pin.pos.x + d.x * len, pin.pos.y + d.y * len)
  const out: Drawn[] = []
  for (const len of STUB_LENGTHS) {
    const end = along(len)
    out.push({ wires: [[pin.pos, end]], labels: [{ name, at: end, rot: rotOf(d) }] })
  }
  const sides: Vec2[] = [
    { x: -d.y, y: d.x },
    { x: d.y, y: -d.x },
  ]
  for (const first of [0.3, 0.2, 0.1]) {
    for (const side of sides) {
      for (const second of [0.3, 0.5]) {
        const corner = along(first)
        const end = pt(corner.x + side.x * second, corner.y + side.y * second)
        out.push({ wires: [[pin.pos, corner, end]], labels: [{ name, at: end, rot: rotOf(side) }] })
      }
    }
  }
  out.push({ wires: [], labels: [{ name, at: pin.pos, rot: rotOf(d) }] })
  return out
}

/** Ways to wire two pins: the usual elbow, then the other way round. */
export function wireOptions(a: WorldPin, b: WorldPin): Drawn[] {
  const first = wireRoute(a, b)
  const second = wireRoute(a, b, !(a.dir === "left" || a.dir === "right"))
  const same = first.length === second.length && first.every((p, i) => pk(p) === pk(second[i]))
  return (same ? [first] : [first, second]).map((w) => ({ wires: [w], labels: [] }))
}

export const blockText = (project: Project, before: SchematicConnectivity, block: Block) =>
  block.kind === "join"
    ? `it would join ${describeGroups(project, before, block.groups)}`
    : `it would run over the space in front of ${pinText(project, block.pin)}`

/**
 * Nets joined under one name lose the names connect gave them on the way, so one net is not
 * written two ways. `name` is the name the join carries; with none (a drawn wire) the name a
 * caller chose among the nets joined wins, else the first made-up one.
 */
function settleNames(project: Project, before: SchematicConnectivity, pins: PinRef[], name: string): Project {
  const groups = new Set(pins.map((r) => pinGroup(before, r)))
  const names = before.nets.filter((n) => groups.has(n.id) && n.named).map((n) => n.name)
  const target = name || names.find((n) => !AUTO_NET_NAME.test(n)) || names[0]
  if (!target) return project
  const stale = new Set(
    project.labels.filter((l) => AUTO_NET_NAME.test(l.name.trim()) && l.name.trim() !== target && groups.has(before.labelNet.get(l.id) ?? "")).map((l) => l.id),
  )
  return stale.size ? { ...project, labels: project.labels.map((l) => (stale.has(l.id) ? { ...l, name: target } : l)) } : project
}

export interface ConnectPlan {
  /** The project with everything that could be drawn. */
  project: Project
  /** The net name the labels carry; empty when a drawn wire does it. */
  name: string
  wired: boolean
  /** Pins that are on the net afterwards, whether they were drawn in or already there. */
  onNet: PinRef[]
  /** Pins that could not be put on it, with what is in the way. */
  failed: { ref: PinRef; why: string }[]
  /** Why a drawn wire between two pins was not used, when it was not. */
  wireNote: string
  /** The nets the connection may join: those of the pins asked for, and the one named. */
  allowed: ReadonlySet<string>
}

export interface ConnectOptions {
  /** The name the caller asked for, or empty. */
  netName: string
  /** The name to label with when the caller gave none. */
  nameFor: () => string
  /** The name of the net a pin is on now, null when it is on none. */
  netOf: (ref: PinRef) => string | null
}

/**
 * Put `refs` on one net without joining any other. Two pins with no name get a drawn wire when one
 * can be drawn clear of everything; otherwise every pin gets a label, tried straight out, bent
 * around what is in the way, and last on the pin itself. A pin none of that works for is left out
 * and reported; the rest are connected.
 */
export function planConnect(project: Project, before: SchematicConnectivity, refs: PinRef[], opts: ConnectOptions): ConnectPlan {
  const drawing = new Drawing(project, before)
  const allowed = new Set(refs.map((r) => pinGroup(before, r)))
  if (opts.netName) {
    allowed.add(`net:${opts.netName}`)
    for (const g of drawing.groupsNamed(opts.netName)) allowed.add(g)
  }
  const keyOf = (r: PinRef) => `${r.componentId}:${r.pin}`

  let wireNote = ""
  if (!opts.netName && refs.length === 2) {
    const [a, b] = refs
    const pa = drawnPin(project, a)
    const pb = drawnPin(project, b)
    if (pa && pb && !pa.hidden && !pb.hidden) {
      const self = new Set([`${pa.componentId}:${pa.pin}`, `${pb.componentId}:${pb.pin}`])
      for (const route of wireOptions(pa, pb)) {
        const block = drawing.check(route, self, allowed)
        if (!block) return { project: settleNames(applyDrawn(project, route), before, [a, b], ""), name: "", wired: true, onNet: [a, b], failed: [], wireNote: "", allowed }
        wireNote ||= blockText(project, before, block)
      }
    }
  }

  const name = opts.netName || opts.nameFor()
  let next = project
  const onNet: PinRef[] = []
  const failed: ConnectPlan["failed"] = []
  const carrying = new Set<string>()
  for (const ref of refs) {
    const group = pinGroup(before, ref)
    // A pin on a net that already carries the name, or one with a pin of its own net labelled, is there.
    if (opts.netOf(ref) === name || carrying.has(group)) {
      onNet.push(ref)
      continue
    }
    const pin = drawnPin(project, ref)
    let last: Block | null = null
    let placed = false
    // A pin that is not drawn (a hidden power pin) is on its net by its name: nothing is wired or labelled to it.
    for (const option of pin && !pin.hidden ? labelOptions(pin, name) : []) {
      // A label on the pin itself is the last way out, so it may stand in the way of a neighbour's stub.
      const block = drawing.check(option, new Set([pin ? `${pin.componentId}:${pin.pin}` : keyOf(ref)]), allowed, option.wires.length > 0)
      if (block) {
        last = block
        continue
      }
      drawing.accept(option, group)
      next = applyDrawn(next, option)
      placed = true
      break
    }
    if (placed) {
      onNet.push(ref)
      if (!group.startsWith("solo:")) carrying.add(group)
    } else {
      failed.push({ ref, why: last ? blockText(project, before, last) : pin?.hidden ? "the pin is not drawn, and is on the net its name gives it" : "the pin was not found" })
    }
  }

  next = settleNames(next, before, onNet, name)
  return { project: next, name, wired: false, onNet, failed, wireNote, allowed }
}
