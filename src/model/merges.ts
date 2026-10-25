import { pointOnSegment } from "../lib/geometry"
import { SpatialHash, pointBox } from "../lib/spatialHash"
import { findPart } from "./library"
import { isSchematicPart, powerNetName, schematicPins, unitOwners } from "./instances"
import type { SchematicConnectivity } from "./connectivity"
import type { Net, PinRef, Project } from "./types"

/** The names connect gives a net it labels itself: they stand for no one's choice and may be replaced. */
export const AUTO_NET_NAME = /^NET\d+$/

/**
 * The pins each component draws, as "componentId:pin", for a sheet that has parts with several
 * units; null for one that has none. The connectivity lists a pin of a unit under the part's own
 * component too, which does not draw it: a loop over `pinNet` would take that for a second pin.
 */
function drawnKeys(project: Project): Set<string> | null {
  if (!unitOwners(project.components).size) return null
  const keys = new Set<string>()
  for (const c of project.components) for (const p of schematicPins(c)) keys.add(`${c.id}:${p.pin}`)
  return keys
}

/** Whether a component's pins are checked as physical ones: a part on the board, or a unit of one. */
function countsAsPhysical(project: Project, c: Project["components"][number]): boolean {
  if (isSchematicPart(findPart(c.partId))) return true
  const owner = unitOwners(project.components).get(c.id)
  return !!owner && isSchematicPart(findPart(project.components.find((x) => x.id === owner)?.partId ?? ""))
}

/** The net a pin was on before an edit; a pin on no net is a group of its own. */
export const groupOf = (before: SchematicConnectivity, key: string) => before.pinNet.get(key) ?? `solo:${key}`

export const pinGroup = (before: SchematicConnectivity, ref: PinRef) => groupOf(before, `${ref.componentId}:${ref.pin}`)

/** "R1.2" or "U1.VIN" for a pin key ("componentId:pin"). */
export function pinText(project: Project, key: string) {
  const i = key.lastIndexOf(":")
  const c = project.components.find((x) => x.id === key.slice(0, i))
  const pin = key.slice(i + 1)
  const part = c ? findPart(c.partId) : undefined
  const name = part?.pins.find((p) => p.number === pin)?.name
  const text = `${c?.ref ?? "?"}.${name && name !== pin ? name : pin}`
  // Pins that share a name (U4's VCC, 7 and 20) are told apart by number, or a list would repeat itself.
  return name && name !== pin && part!.pins.filter((p) => p.name === name).length > 1 ? `${text} (pin ${pin})` : text
}

/** A pin as `pinText` writes it, inside a sentence: `U1.THR`, `U4.VCC (pin 7)`, `#GND3.1`. */
const PIN_TEXT = /\b[A-Z#]+\d*\.[A-Za-z0-9+\-/']+(?: \(pin \d+\))?/g

/** "A", "A and B", "A, B, and C", "A, B, C, and 3 more": the first `max` of `items` in a sentence. */
function listOf(items: string[], max: number): string {
  const shown = items.slice(0, max)
  const more = items.length - shown.length
  const all = more > 0 ? [...shown, `${more} more`] : shown
  return all.length <= 2 ? all.join(" and ") : `${all.slice(0, -1).join(", ")}, and ${all[all.length - 1]}`
}

/** Nets of no pin and no name: loose wire that joining to anything changes nothing about. */
export function harmlessGroups(before: SchematicConnectivity): Set<string> {
  return new Set(before.nets.filter((n) => !n.named && n.pins.length === 0).map((n) => n.id))
}

const isPort = (project: Project, key: string) => {
  const c = project.components.find((x) => x.id === key.slice(0, key.lastIndexOf(":")))
  return !!findPart(c?.partId ?? "")?.powerNet
}

/** One net as a person would name it: "VIN (U1.VIN, U2.VIN)", or the pins alone for an unnamed one. */
export function describeGroup(project: Project, before: SchematicConnectivity, group: string): string {
  const net = before.nets.find((n) => n.id === group)
  const keys = net ? net.pins.map((p) => `${p.componentId}:${p.pin}`) : group.startsWith("solo:") ? [group.slice(5)] : []
  const pins = keys.filter((k) => !isPort(project, k))
  const shown = pins.slice(0, 4).map((k) => pinText(project, k)).join(", ") + (pins.length > 4 ? `, and ${pins.length - 4} more` : "")
  const name = net?.name
  if (name && !name.startsWith("Net-(") && !name.startsWith("N$")) return `${name}${shown ? ` (${shown})` : " (a label with no pins on it)"}`
  return shown || "a loose wire"
}

export const describeGroups = (project: Project, before: SchematicConnectivity, groups: Iterable<string>) =>
  [...groups].map((g) => describeGroup(project, before, g)).join(" and ")

/**
 * Whether merging these groups joins two nets that each stand for something: that already have a
 * name, or already hold 2+ pins. A pin on nothing, a loose wire, or a net that holds one pin and
 * no name merges into the other as a person drawing it would mean: the pin goes on the net, the
 * net takes the name.
 */
export function bridgesTwoNets(groups: Iterable<string>, byId: ReadonlyMap<string, Net>): boolean {
  let standing = 0
  for (const g of groups) {
    const net = byId.get(g)
    if (net && (net.named || net.pins.length >= 2)) standing++
  }
  return standing >= 2
}

/**
 * Nets of `after` that join nets of `before` which the edit was not meant to join: a net may only
 * merge with another when `allowed` names it (the nets of the pins being connected). Pins, wires
 * and labels all count, so a stray label that is absorbed (its name now on a net) is reported like
 * a pin would be. Also reports net names that now collide. Returns one sentence per problem,
 * naming pins; empty when the edit changed nothing but what was asked for.
 */
export function unrequestedMerges(
  project: Project,
  before: SchematicConnectivity,
  after: SchematicConnectivity,
  allowed: ReadonlySet<string>,
  opts: { lenient?: boolean } = {},
): string[] {
  const harmless = harmlessGroups(before)
  const byId = opts.lenient ? new Map(before.nets.map((n) => [n.id, n])) : null
  const byNet = new Map<string, Set<string>>()
  const add = (netId: string | undefined, group: string | undefined) => {
    if (!netId || !group) return
    const groups = byNet.get(netId) ?? new Set<string>()
    groups.add(group)
    byNet.set(netId, groups)
  }
  const drawn = drawnKeys(project)
  for (const [key, netId] of after.pinNet) if (!drawn || drawn.has(key)) add(netId, groupOf(before, key))
  for (const w of project.wires) add(after.wireNet.get(w.id), before.wireNet.get(w.id))
  for (const l of project.labels) add(after.labelNet.get(l.id), before.labelNet.get(l.id))

  const problems: string[] = []
  const reported = new Set<string>()
  for (const [netId, all] of byNet) {
    const groups = [...all].filter((g) => !harmless.has(g))
    if (groups.length < 2) continue
    if (groups.every((g) => allowed.has(g))) continue
    if (byId && !bridgesTwoNets(groups, byId)) continue
    reported.add(netId)
    problems.push(describeGroups(project, before, groups))
  }
  const hadConflict = new Set(before.conflicts.map((c) => c.names.join()))
  for (const conflict of after.conflicts) {
    if (hadConflict.has(conflict.names.join()) || reported.has(conflict.netId)) continue
    // Two names from callers are a short; a name connect made up for itself is not.
    if (conflict.names.filter((n) => !AUTO_NET_NAME.test(n)).length < 2) continue
    const net = after.nets.find((n) => n.id === conflict.netId)
    const pins = (net?.pins ?? []).slice(0, 4).map((p) => pinText(project, `${p.componentId}:${p.pin}`)).join(", ")
    problems.push(`${conflict.names.join(" and ")}${pins ? ` (${pins})` : ""}`)
  }
  return problems
}

/**
 * Pins that sit on a wire or label of a net they are not on. They are not connected here, but a
 * schematic reader (and KiCad) sees them as joined, so an edit must not create one.
 */
export function pinsUnderOtherNets(project: Project, conn: SchematicConnectivity): { pin: string; net: string }[] {
  const wires = new SpatialHash<{ id: string; a: { x: number; y: number }; b: { x: number; y: number } }>()
  for (const w of project.wires) {
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1]
      const b = w.points[i]
      wires.insert({ id: w.id, a, b }, { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) })
    }
  }
  const labels = new SpatialHash<{ id: string; x: number; y: number }>()
  for (const l of project.labels) labels.insert(l, pointBox(l))
  const netName = (id: string) => conn.nets.find((n) => n.id === id)?.name ?? id

  const out: { pin: string; net: string }[] = []
  for (const c of project.components) {
    // The second pin of a number in a symbol that keeps them apart is on a net the connectivity does not name by pin: it is not judged by the first one's.
    const apart = !!findPart(c.partId)?.jumpers && !findPart(c.partId)!.jumpers!.duplicates
    for (const pin of schematicPins(c)) {
      if (apart && pin.slot) continue
      const key = `${c.id}:${pin.pin}`
      const own = conn.pinNet.get(key)
      const box = pointBox(pin.pos)
      for (const w of wires.query(box)) {
        const net = conn.wireNet.get(w.id)
        if (net && net !== own && pointOnSegment(pin.pos, w.a, w.b)) out.push({ pin: key, net: netName(net) })
      }
      for (const l of labels.query(box)) {
        const net = conn.labelNet.get(l.id)
        if (net && net !== own && pointOnSegment(pin.pos, l, l)) out.push({ pin: key, net: netName(net) })
      }
    }
  }
  return out
}

/**
 * What an edit to the schematic did that nobody asked for: nets it joined, names it put on a net,
 * and pins it left under another net's wire (pins that already were are not its doing).
 */
export function schematicEditProblems(
  project: Project,
  next: Project,
  before: SchematicConnectivity,
  after: SchematicConnectivity,
  allowed: ReadonlySet<string>,
  opts: { lenient?: boolean } = {},
): string[] {
  const problems = unrequestedMerges(next, before, after, allowed, opts).map((m) => `it would join ${m}`)
  const had = new Set(pinsUnderOtherNets(project, before).map((h) => `${h.pin}|${h.net}`))
  // One sentence a pin, naming every net whose wire it would sit under: a pin is named once.
  const under = new Map<string, string[]>()
  for (const hit of pinsUnderOtherNets(next, after)) {
    if (had.has(`${hit.pin}|${hit.net}`)) continue
    const nets = under.get(hit.pin) ?? []
    if (!nets.includes(hit.net)) nets.push(hit.net)
    under.set(hit.pin, nets)
  }
  for (const [pin, nets] of under) {
    problems.push(
      nets.length === 1
        ? `${pinText(next, pin)} would sit under the wire of ${nets[0]}, which looks connected`
        : `${pinText(next, pin)} would sit under the wires of ${listOf(nets, 4)}, which look connected`,
    )
  }
  return problems
}

/**
 * Pins that were on a net with others before an edit and no longer are, in sentences: a part taken
 * out of a wire that others hang from cuts them loose, and so does a wire stretched off its pin.
 */
export function connectionsLost(
  project: Project,
  next: Project,
  before: SchematicConnectivity,
  after: SchematicConnectivity,
): string[] {
  const alive = new Set(next.components.map((c) => c.id))
  const drawn = drawnKeys(project)
  const byNet = new Map<string, string[]>()
  for (const [key, netId] of before.pinNet) {
    if (!alive.has(key.slice(0, key.lastIndexOf(":"))) || (drawn && !drawn.has(key))) continue
    byNet.set(netId, [...(byNet.get(netId) ?? []), key])
  }
  const out: string[] = []
  for (const [netId, pins] of byNet) {
    if (pins.length < 2) continue
    const net = before.nets.find((n) => n.id === netId)
    const parts = new Map<string, string[]>()
    for (const key of pins) {
      const g = after.pinNet.get(key) ?? `solo:${key}`
      parts.set(g, [...(parts.get(g) ?? []), key])
    }
    if (parts.size < 2) continue
    const [main, ...rest] = [...parts.values()].sort((a, b) => b.length - a.length)
    const lost = rest.flat()
    const label = net?.named && !net.name.startsWith("Net-(") ? net.name : pinText(project, main[0])
    out.push(`${lost.slice(0, 4).map((k) => pinText(project, k)).join(", ")}${lost.length > 4 ? `, and ${lost.length - 4} more` : ""} no longer on ${label}`)
  }
  return out
}

/** The names written on each net: net labels, and the rail of each power symbol. */
function namesByNet(project: Project, conn: SchematicConnectivity): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (net: string | undefined, name: string) => {
    if (!net || !name) return
    const set = out.get(net) ?? new Set<string>()
    set.add(name)
    out.set(net, set)
  }
  for (const l of project.labels) add(conn.labelNet.get(l.id), l.name.trim())
  for (const c of project.components) {
    const rail = powerNetName(c)
    if (rail) for (const pin of schematicPins(c)) add(conn.pinNet.get(`${c.id}:${pin.pin}`), rail)
  }
  return out
}

/**
 * Pins of parts that an edit took off the net they were on: a pin that lost one of the pins it
 * was wired to, or a name (a net label, a power symbol) it was on. A move that leaves a supply
 * symbol or a label behind does this to the pins that hung from it. One sentence per net, naming
 * the pins; empty when every pin kept its net. Pins that join something are `schematicEditProblems`'.
 */
export function pinsCutOff(
  project: Project,
  next: Project,
  before: SchematicConnectivity,
  after: SchematicConnectivity,
  skip: ReadonlySet<string> = new Set(),
  /** Pins (as `pinText` writes them) the notice already names, not to be named again. */
  named: ReadonlySet<string> = new Set(),
): string[] {
  const beforeNames = namesByNet(project, before)
  const afterNames = namesByNet(next, after)
  const mates = (conn: SchematicConnectivity, netId: string | undefined) => new Set(conn.nets.find((n) => n.id === netId)?.pins.map((p) => `${p.componentId}:${p.pin}`))
  const lostBy = new Map<string, string[]>()
  for (const c of next.components) {
    // The units of a part with several are components of their own, and their pins are the part's.
    if (!countsAsPhysical(next, c)) continue
    for (const pin of schematicPins(c)) {
      const key = `${c.id}:${pin.pin}`
      const was = before.pinNet.get(key)
      if (!was || skip.has(was)) continue
      const now = after.pinNet.get(key)
      const keptNames = [...(beforeNames.get(was) ?? [])].every((n) => !!now && !!afterNames.get(now)?.has(n))
      const have = mates(after, now)
      const keptMates = [...mates(before, was)].every((k) => have.has(k) || !next.components.some((x) => x.id === k.slice(0, k.lastIndexOf(":"))))
      if (keptNames && keptMates) continue
      lostBy.set(was, [...(lostBy.get(was) ?? []), key])
    }
  }
  const out: string[] = []
  for (const [netId, all] of lostBy) {
    const keys = all.filter((k) => !named.has(pinText(next, k)))
    // Every pin it would cut is named already, among the nets it would join: one notice, each pin once.
    if (!keys.length) continue
    const shown = listOf(keys.map((k) => pinText(next, k)), 6)
    const net = before.nets.find((n) => n.id === netId)
    const name = net?.named && !net.name.startsWith("Net-(") ? net.name : null
    // What they are cut off: the net's name, else the pins of it that stay together; with none left, the net just falls apart.
    const lost = new Set(all)
    const rest = (net?.pins ?? [])
      .map((p) => `${p.componentId}:${p.pin}`)
      .filter((k) => !lost.has(k) && !named.has(pinText(next, k)) && next.components.some((x) => x.id === k.slice(0, k.lastIndexOf(":"))))
    const others = listOf(rest.map((k) => pinText(next, k)), 4)
    out.push(name ? `it would cut ${shown} off ${name}` : rest.length ? `it would cut ${shown} off ${others}` : `it would split ${shown} apart`)
  }
  return out
}

/** Everything that makes a move or a turn of a part wrong: nets it would join, and pins it would cut off theirs. */
export function moveProblems(
  project: Project,
  next: Project,
  before: SchematicConnectivity,
  after: SchematicConnectivity,
  allowed: ReadonlySet<string>,
  opts: { netsChange?: boolean; lenient?: boolean; cutAllowed?: ReadonlySet<string> } = {},
): string[] {
  const problems = schematicEditProblems(project, next, before, after, allowed, opts)
  if (!opts.netsChange) problems.push(...pinsCutOff(project, next, before, after, opts.cutAllowed, new Set(problems.flatMap((p) => p.match(PIN_TEXT) ?? []))))
  return problems
}
