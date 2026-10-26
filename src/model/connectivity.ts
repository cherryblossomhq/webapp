import { pointOnSegment, samePoint } from "../lib/geometry"
import { numeric, plain } from "../lib/natural"
import { findPart } from "./library"
import { isPhysical, powerNetName, schematicPins, type WorldPin } from "./instances"
import type { Net, Project, Vec2 } from "./types"

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
  const uf = new UnionFind()
  const pins: WorldPin[] = []
  const pointOwners = new Map<string, string[]>()
  const addPointOwner = (p: Vec2, owner: string) => {
    const key = pk(p)
    const list = pointOwners.get(key)
    if (list) list.push(owner)
    else pointOwners.set(key, [owner])
  }

  for (const c of project.components) {
    const part = findPart(c.partId)
    const power = powerNetName(c, part)
    for (const pin of schematicPins(c, part)) {
      const key = `pin:${pinKey(c.id, pin.pin)}`
      uf.find(key)
      pins.push(pin)
      addPointOwner(pin.pos, key)
      if (power) uf.union(key, `name:${power}`)
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
  const physical = new Set(project.components.filter((c) => isPhysical(findPart(c.partId))).map((c) => c.id))
  let autoIndex = 1

  const sortedGroups = [...groups.values()].sort((a, b) => plain.compare(a[0], b[0]))
  for (const members of sortedGroups) {
    const pinMembers = members.filter((m) => m.startsWith("pin:")).map((m) => m.slice(4))
    const hasWire = members.some((m) => m.startsWith("wire:") || m.startsWith("label:"))
    const names = [...new Set(members.filter((m) => m.startsWith("name:")).map((m) => m.slice(5)))]
      .filter(Boolean)
      .sort()
    if (pinMembers.length === 0 && !hasWire) continue
    if (pinMembers.length === 1 && !hasWire && names.length === 0) continue

    const netPins = pinMembers
      .map((k) => {
        const idx = k.lastIndexOf(":")
        return { componentId: k.slice(0, idx), pin: k.slice(idx + 1) }
      })
      .filter((p) => physical.has(p.componentId))
      .sort((a, b) => {
        const ra = refOf.get(a.componentId) ?? ""
        const rb = refOf.get(b.componentId) ?? ""
        return numeric.compare(ra, rb) || numeric.compare(a.pin, b.pin)
      })

    let name: string
    if (names.length) {
      name = names[0]
    } else if (netPins.length) {
      name = `Net-(${refOf.get(netPins[0].componentId)}-${netPins[0].pin})`
    } else {
      name = `N$${autoIndex++}`
    }
    const id = `net:${name}`
    if (names.length > 1) conflicts.push({ names, netId: id })
    nets.push({ id, name, named: names.length > 0, pins: netPins })
    for (const m of members) {
      if (m.startsWith("pin:")) pinNet.set(m.slice(4), id)
      else if (m.startsWith("wire:")) wireNet.set(m.slice(5), id)
      else if (m.startsWith("label:")) labelNet.set(m.slice(6), id)
    }
  }

  const netById = new Map(nets.map((n) => [n.id, n]))
  const floating = pins.filter((p) => {
    if (!physical.has(p.componentId)) return false
    const netId = pinNet.get(pinKey(p.componentId, p.pin))
    if (!netId) return true
    const net = netById.get(netId)
    return !!net && net.pins.length < 2 && !net.named
  })
  const ncSet = new Set(project.components.flatMap((c) => (c.nc ?? []).map((pin) => pinKey(c.id, pin))))
  const isNc = (p: WorldPin) => ncSet.has(pinKey(p.componentId, p.pin))
  const unconnectedPins = floating.filter((p) => !isNc(p))
  const ncPins = floating.filter(isNc)

  nets.sort((a, b) => numeric.compare(a.name, b.name))
  return { nets, pinNet, wireNet, labelNet, junctions, unconnectedPins, ncPins, conflicts }
}
