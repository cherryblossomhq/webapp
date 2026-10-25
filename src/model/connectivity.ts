import { pointOnSegment, samePoint } from "../lib/geometry"
import { numeric, plain } from "../lib/natural"
import { findPart } from "./library"
import { isSchematicPart, powerNetName, schematicPins, unitOwners, type WorldPin } from "./instances"
import { DRIVER, NO_NET, bestDriver, driverName, pinFacts, pinNetName, unitSuffix, type NameDriver, type PinFact } from "./netNames"
import type { ComponentInstance, Net, PartDef, Project, Vec2 } from "./types"

export class UnionFind {
  private parent = new Map<string, string>()
  find(a: string): string {
    if (!this.parent.has(a)) {
      this.parent.set(a, a)
      return a
    }
    let root = a
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    while (a !== root) {
      const next = this.parent.get(a)!
      this.parent.set(a, root)
      a = next
    }
    return root
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
  keys() {
    return [...this.parent.keys()]
  }
}

export interface SchematicConnectivity {
  nets: Net[]
  /** "componentId:pin" -> net id */
  pinNet: Map<string, string>
  wireNet: Map<string, string>
  labelNet: Map<string, string>
  junctions: Vec2[]
  /** Pins of physical parts not connected to anything. */
  unconnectedPins: WorldPin[]
  /** Unconnected pins marked no-connect on purpose. */
  ncPins: WorldPin[]
  /** Net names that were merged with a differently named net. */
  conflicts: { names: string[]; netId: string }[]
}

export const pinKey = (componentId: string, pin: string) => `${componentId}:${pin}`

/**
 * What to type to name a net: the text of the label or the power symbol that gives it its name, which is
 * `NAME` for the net `/NAME` of a local label. A net nothing names, or any net of a project not named as KiCad
 * names its nets, is named by its own name.
 */
export const bareName = (net: Pick<Net, "name" | "label" | "power">) => net.label?.text ?? net.power?.text ?? net.name

/** The facts of the pins of a unit as they are for naming a net after one of them, kept per component object (a component is replaced, never edited). */
const factsCache = new WeakMap<ComponentInstance, { part: PartDef; facts: PinFact[] }>()
function factsOf(c: ComponentInstance, part: PartDef): PinFact[] {
  const hit = factsCache.get(c)
  if (hit && hit.part === part) return hit.facts
  const facts = pinFacts(c, part)
  factsCache.set(c, { part, facts })
  return facts
}

/**
 * Wire segments by the line they run along: across ones by their height, up and down ones by
 * their x, so a point finds the wires through it whatever their length. Slanted ones, which the
 * editor doesn't draw but files may hold, are always looked at.
 */
export class SegmentIndex {
  private rows = new Map<number, [number, number][]>()
  private cols = new Map<number, [number, number][]>()
  private slanted: [number, number][] = []
  constructor(wires: { points: Vec2[] }[]) {
    wires.forEach((w, wi) => {
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i]
        const b = w.points[i + 1]
        if (Math.abs(a.y - b.y) < 1e-9) push(this.rows, key(a.y), [wi, i])
        else if (Math.abs(a.x - b.x) < 1e-9) push(this.cols, key(a.x), [wi, i])
        else this.slanted.push([wi, i])
      }
    })
  }
  /** Wires with a segment that could hold the point, in wire order, each with its segments in order. */
  near(p: Vec2): [number, number[]][] {
    const hits: [number, number][] = [...this.slanted]
    const ky = key(p.y)
    const kx = key(p.x)
    for (const k of [ky - 1, ky, ky + 1]) hits.push(...(this.rows.get(k) ?? []))
    for (const k of [kx - 1, kx, kx + 1]) hits.push(...(this.cols.get(k) ?? []))
    if (!hits.length) return []
    const byWire = new Map<number, number[]>()
    for (const [wi, i] of hits) {
      const list = byWire.get(wi)
      if (!list) byWire.set(wi, [i])
      else if (!list.includes(i)) list.push(i)
    }
    return [...byWire].sort((a, b) => a[0] - b[0]).map(([wi, segs]) => [wi, segs.sort((a, b) => a - b)])
  }
}

/** A coordinate to a thousandth: a point within the editor's tolerance is in this bucket or the next. */
const key = (v: number) => Math.round(v * 1000)
function push<T>(map: Map<number, T[]>, k: number, v: T) {
  const list = map.get(k)
  if (list) list.push(v)
  else map.set(k, [v])
}

const pk = (p: Vec2) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`

export function computeConnectivity(project: Project): SchematicConnectivity {
  // S2: a project named as KiCad names it picks each net's name by its driver (`netNames.ts`); any other by the editor's rule.
  const kicad = project.netNames
  /** The drivers each name text has on the sheet: labels, power symbols and hidden power pins. */
  const drivers = new Map<string, NameDriver[]>()
  const addDriver = (text: string, d: NameDriver) => {
    const list = drivers.get(text)
    if (list) list.push(d)
    else drivers.set(text, [d])
  }
  const uf = new UnionFind()
  const pins: WorldPin[] = []
  const pointOwners = new Map<string, string[]>()
  const addPointOwner = (p: Vec2, owner: string) => {
    const key = pk(p)
    const list = pointOwners.get(key)
    if (list) list.push(owner)
    else pointOwners.set(key, [owner])
  }

  // A unit of a part with several is a symbol of its own; its pins are the part's pins (see `unitOwners`).
  const owners = unitOwners(project.components)
  const ownerOf = (id: string) => owners.get(id) ?? id
  /** The node of each pin, by "componentId:pin" or, for the second pin of a number that is not jumpered, "componentId:pin#1". */
  const nodeOf = new Map<WorldPin, string>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    const power = powerNetName(c, part)
    // The editor's own parts join the pins that share a number; a KiCad symbol keeps them apart unless it says they are jumpered.
    const jumpered = !part?.jumpers || part.jumpers.duplicates
    const here = new Set<string>()
    for (const pin of schematicPins(c, part)) {
      // A pin of the type "no connect" is on no net, whatever is drawn to it (KiCad does not connect it).
      if (pin.type === "no_connect") continue
      const key = `pin:${pinKey(c.id, pin.pin)}${pin.slot && !jumpered ? `#${pin.slot}` : ""}`
      uf.find(key)
      pins.push(pin)
      nodeOf.set(pin, key)
      here.add(pin.pin)
      addPointOwner(pin.pos, key)
      // A KiCad power symbol whose Value is empty names its net nothing, which KiCad shows as `<NO NET>`.
      const portName = power === "" && kicad && part?.powerNet && part.jumpers ? NO_NET : power
      if (portName) {
        uf.union(key, `name:${portName}`)
        if (kicad) {
          const local = !!part?.powerLocal
          addDriver(portName, { prio: local ? DRIVER.localPower : DRIVER.globalPower, name: driverName(portName, local ? "local" : "global"), text: portName, kind: local ? "local" : "global", from: "power" })
        }
      }
      // A hidden power-input pin of an ordinary part is on the global net of its name (`SCH_PIN::IsGlobalPower`).
      else if (pin.hidden && pin.type === "power_in" && pin.name.trim()) {
        uf.union(key, `name:${pin.name.trim()}`)
        if (kicad) addDriver(pin.name.trim(), { prio: DRIVER.globalPower, name: pin.name.trim(), text: pin.name.trim(), kind: "global", from: "power" })
      }
    }
    // Pins of different numbers that the part joins inside itself.
    for (const group of part?.jumpers?.groups ?? []) {
      const present = group.filter((n) => here.has(n))
      for (let i = 1; i < present.length; i++) uf.union(`pin:${pinKey(c.id, present[0])}`, `pin:${pinKey(c.id, present[i])}`)
    }
  }

  // Wire vertices coincide with pins / other wire vertices.
  for (const w of project.wires) {
    const key = `wire:${w.id}`
    uf.find(key)
    for (const p of w.points) addPointOwner(p, key)
  }
  for (const l of project.labels) {
    const key = `label:${l.id}`
    uf.union(key, `name:${l.name.trim()}`)
    addPointOwner(l, key)
    if (kicad && l.name.trim()) {
      const kind = l.kind === "global" ? "global" : "local"
      addDriver(l.name.trim(), { prio: kind === "global" ? DRIVER.globalLabel : DRIVER.label, name: driverName(l.name.trim(), kind), text: l.name.trim(), kind, from: "label" })
    }
  }
  for (const owners of pointOwners.values()) {
    for (let i = 1; i < owners.length; i++) uf.union(owners[0], owners[i])
  }

  // T-junctions: a wire endpoint, pin or label lying on another wire's segment.
  const junctions: Vec2[] = []
  const junctionKeys = new Set<string>()
  const addJunction = (p: Vec2) => {
    const k = pk(p)
    if (!junctionKeys.has(k)) {
      junctionKeys.add(k)
      junctions.push(p)
    }
  }
  const probes: { p: Vec2; owner: string; isWireEnd: boolean }[] = []
  for (const w of project.wires) {
    if (w.points.length < 2) continue
    probes.push({ p: w.points[0], owner: `wire:${w.id}`, isWireEnd: true })
    probes.push({ p: w.points[w.points.length - 1], owner: `wire:${w.id}`, isWireEnd: true })
  }
  for (const l of project.labels) probes.push({ p: l, owner: `label:${l.id}`, isWireEnd: false })

  // Wire segments by the line they run along (`SegmentIndex`), so a probe only looks at wires
  // near it. Wires are still visited in order, and each wire's segments in order, as a plain scan
  // over all of them would.
  const segIndex = new SegmentIndex(project.wires)
  for (const probe of probes) {
    for (const [wi, segs] of segIndex.near(probe.p)) {
      const w = project.wires[wi]
      if (`wire:${w.id}` === probe.owner) continue
      for (const i of segs) {
        const a = w.points[i]
        const b = w.points[i + 1]
        if (!pointOnSegment(probe.p, a, b)) continue
        uf.union(probe.owner, `wire:${w.id}`)
        if (probe.isWireEnd && !samePoint(probe.p, a) && !samePoint(probe.p, b)) addJunction(probe.p)
        break
      }
    }
  }

  // A point where three or more wire ends meet also gets a dot.
  const endCount = new Map<string, { p: Vec2; n: number }>()
  for (const w of project.wires) {
    if (w.points.length < 2) continue
    for (const p of [w.points[0], w.points[w.points.length - 1]]) {
      const k = pk(p)
      const e = endCount.get(k)
      if (e) e.n++
      else endCount.set(k, { p, n: 1 })
    }
  }
  for (const { p, n } of endCount.values()) {
    const pinsHere = pointOwners.get(pk(p))?.filter((o) => o.startsWith("pin:")).length ?? 0
    if (n + pinsHere >= 3) addJunction(p)
  }

  // Group into nets.
  const groups = new Map<string, string[]>()
  for (const key of uf.keys()) {
    const root = uf.find(key)
    const g = groups.get(root)
    if (g) g.push(key)
    else groups.set(root, [key])
  }

  const nets: Net[] = []
  const pinNet = new Map<string, string>()
  const wireNet = new Map<string, string>()
  const labelNet = new Map<string, string>()
  const conflicts: SchematicConnectivity["conflicts"] = []
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const ncSet = new Set(project.components.flatMap((c) => (c.nc ?? []).map((pin) => pinKey(c.id, pin))))
  const nodeParts = new Map(project.components.map((c) => [c.id, c]))
  const labelCount = (members: string[]) => members.filter((m) => m.startsWith("label:")).length
  const physical = new Set(project.components.filter((c) => isSchematicPart(findPart(c.partId))).map((c) => c.id))
  /** The net of every pin node, including the second pin of a number. */
  const nodeNet = new Map<string, string>()
  const split = (k: string) => {
    const idx = k.lastIndexOf(":")
    const pin = k.slice(idx + 1)
    const hash = pin.indexOf("#")
    return { componentId: k.slice(0, idx), pin: hash < 0 ? pin : pin.slice(0, hash), second: hash >= 0 }
  }
  let autoIndex = 1

  const sortedGroups = [...groups.values()].sort((a, b) => plain.compare(a[0], b[0]))
  /** A unit's pins are the part's: a pin of a unit is listed under the component that is on the board. */
  const listed = (k: string) => {
    const { componentId, pin } = split(k)
    return { componentId: ownerOf(componentId), pin }
  }
  const aliased: [string, string][] = []
  for (const members of sortedGroups) {
    const pinMembers = members.filter((m) => m.startsWith("pin:")).map((m) => m.slice(4))
    const hasWire = members.some((m) => m.startsWith("wire:") || m.startsWith("label:"))
    const names = [...new Set(members.filter((m) => m.startsWith("name:")).map((m) => m.slice(5)))]
      .filter(Boolean)
      .sort()
    if (pinMembers.length === 0 && !hasWire) continue
    if (pinMembers.length === 1 && !hasWire && names.length === 0) continue

    const seenPins = new Set<string>()
    const netPins = pinMembers
      .map(listed)
      .filter((p) => {
        const k = pinKey(p.componentId, p.pin)
        if (seenPins.has(k)) return false
        seenPins.add(k)
        return physical.has(p.componentId)
      })
      .sort((a, b) => {
        const ra = refOf.get(a.componentId) ?? ""
        const rb = refOf.get(b.componentId) ?? ""
        return numeric.compare(ra, rb) || numeric.compare(a.pin, b.pin)
      })

    let name: string
    let label: Net["label"]
    let power: Net["power"]
    let named = names.length > 0
    if (kicad) {
      // The driver of the highest priority names the net; with none, a pin does.
      const here = names.flatMap((n) => drivers.get(n) ?? [])
      const best = bestDriver(here)
      if (best) {
        name = best.name
        named = true
        if (best.from === "label") label = { text: best.text, kind: best.kind }
        else power = { text: best.text, local: best.kind === "local" }
      } else {
        named = false
        name = kicadPinName(kicad, pinMembers, labelCount(members), ownerOf, nodeParts, refOf, physical, ncSet) ?? `N$${autoIndex++}`
      }
    } else if (names.length) {
      name = names[0]
    } else if (netPins.length) {
      name = `Net-(${refOf.get(netPins[0].componentId)}-${netPins[0].pin})`
    } else {
      name = `N$${autoIndex++}`
    }
    let id = `net:${name}`
    // Two nets that KiCad's rules give one name (a local and a global label of one text on no common wire) stay two nets.
    for (let i = 2; kicad && nets.some((n) => n.id === id); i++) id = `net:${name}#${i}`
    if (kicad) {
      const texts = [...new Set(names.flatMap((n) => (drivers.get(n) ?? []).map((d) => d.text)))].sort()
      if (texts.length > 1) conflicts.push({ names: texts, netId: id })
    } else if (names.length > 1) conflicts.push({ names, netId: id })
    nets.push({ id, name, named, pins: netPins, ...(label ? { label } : {}), ...(power ? { power } : {}) })
    for (const m of members) {
      if (m.startsWith("pin:")) {
        const key = m.slice(4)
        nodeNet.set(key, id)
        const { componentId, pin, second } = split(key)
        // The second pin of a number a symbol keeps apart has a key of its own, `<id>:<pin>#<slot>`.
        pinNet.set(key, id)
        if (second) continue
        // The pin of a unit is also a pin of the part on the board.
        if (ownerOf(componentId) !== componentId) aliased.push([pinKey(ownerOf(componentId), pin), id])
      } else if (m.startsWith("wire:")) wireNet.set(m.slice(5), id)
      else if (m.startsWith("label:")) labelNet.set(m.slice(6), id)
    }
  }
  // A pin the part's own symbol does not draw is the pin of the unit that does. Where both draw it, its own net stands.
  for (const [key, id] of aliased) if (!pinNet.has(key)) pinNet.set(key, id)

  const netById = new Map(nets.map((n) => [n.id, n]))
  const floating = pins.filter((p) => {
    if (!physical.has(ownerOf(p.componentId))) return false
    const netId = nodeNet.get(nodeOf.get(p)!.slice(4))
    if (!netId) return true
    const net = netById.get(netId)
    return !!net && net.pins.length < 2 && !net.named
  })
  const isNc = (p: WorldPin) => ncSet.has(pinKey(p.componentId, p.pin))
  const unconnectedPins = floating.filter((p) => !isNc(p))
  const ncPins = floating.filter(isNc)

  nets.sort((a, b) => numeric.compare(a.name, b.name))
  return { nets, pinNet, wireNet, labelNet, junctions, unconnectedPins, ncPins, conflicts }
}

/**
 * The name of a net no label or power symbol names, as KiCad makes it from its pins: the pin among the
 * net's drivers whose `Net-(R1-Pad2)` sorts first, names with `-Pad` last (`candidate_cmp`). A net with a
 * pin and nothing else on it, or a no-connect flag, is `unconnected-(...)`. A pin of a symbol that is not
 * on the board, or whose reference is `#...`, is no candidate (`ResolveDrivers`).
 */
function kicadPinName(
  rule: "kicad" | "kicad6",
  pinMembers: string[],
  labels: number,
  ownerOf: (id: string) => string,
  byId: Map<string, ComponentInstance>,
  refOf: Map<string, string>,
  physical: Set<string>,
  ncSet: Set<string>,
): string | null {
  const bare = (m: string) => m.replace(/#\d+$/, "")
  const unconnected = (pinMembers.length === 1 && labels === 0) || pinMembers.some((m) => ncSet.has(bare(m)))
  const names: string[] = []
  for (const m of pinMembers) {
    const i = m.lastIndexOf(":")
    const cid = m.slice(0, i)
    const number = bare(m.slice(i + 1))
    const c = byId.get(cid)
    const part = c && findPart(c.partId)
    if (!c || !part || !physical.has(ownerOf(cid)) || c.flags?.onBoard === false || refOf.get(cid)?.startsWith("#")) continue
    const facts = factsOf(c, part)
    const fact = facts.find((f) => f.number === number)
    if (!fact) continue
    names.push(pinNetName(rule, refOf.get(cid) ?? "", unitSuffix(c, part), fact, facts, unconnected))
  }
  if (!names.length) return null
  names.sort((a, b) => Number(a.includes("-Pad")) - Number(b.includes("-Pad")) || (a < b ? -1 : a > b ? 1 : 0))
  return names[0]
}
