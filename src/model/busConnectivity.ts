import { pointOnSegment } from "../lib/geometry"
import { SegmentIndex } from "./connectivity"
import { BusTooLarge, parseBusName, type AliasLookup, type BusName } from "./busNames"
import type { BusAlias, DrawingBus, DrawingBusEntry, SheetSymbol, NetLabel, Project, Vec2, Wire } from "./types"
import { sheetIdOf } from "./sheets"

// S3: which bus lines, bus labels and sheet pins make one bus on a sheet, and which labels name a bus at all. A bus carries the nets of its
// members (`D0` to `D7` for `D[0..7]`), and a net joins a bus only by naming one of its members: KiCad connects nets by name, so a wire with the
// label `D3` is the net `D3` of the bus whether or not a bus entry joins it. What the bus changes about the nets is where two sheets meet
// (a sheet pin and a hierarchical label of one bus name join their members by position, `connectivity.ts`) and how two labels of one
// bus join (the first of each by position). Everything here is per sheet: a sheet used twice has the same buses in both uses.

/** The label or sheet pin that names a bus. */
export interface BusItem {
  /** The label's id, or the sheet symbol's id and the pin's, `h1:p3`. */
  id: string
  /** `pin` is a pin of a sheet symbol: its bus is the one of the sheet it is drawn on. */
  kind: "local" | "global" | "hierarchical" | "pin"
  text: string
  at: Vec2
  name: BusName
  /** The sheet symbol a pin belongs to. */
  symbol?: SheetSymbol
  /** The bus it is on: an index into `SheetBuses.groups`. */
  group: number
}

/** One bus of a sheet: its lines, the labels and pins that name it, and the bus-to-bus entries that join it to others. */
export interface BusGroup {
  /** The ids of its lines (drawings of type `bus`) and of its bus-to-bus entries. */
  lines: string[]
  entries: string[]
  items: BusItem[]
  /** The item whose name the bus has: the strongest driver, then the name that sorts first. Absent on a bus nothing names. */
  driver?: BusItem
}

/** A bus entry of a wire: its two ends, and which of them touch a bus. The ends that touch none join the wires there, as a wire does. */
export interface WireEntry {
  id: string
  ends: [Vec2, Vec2]
  onBus: [boolean, boolean]
  /** The bus (an index into `groups`) the first end on a bus touches; -1 when neither does. */
  group: number
}

export interface SheetBuses {
  groups: BusGroup[]
  /** The label ids that name a bus, and what they carry. */
  busLabels: Map<string, BusItem>
  /** The sheet pins that name a bus, by `symbolId:pinId`. */
  busPins: Map<string, BusItem>
  entries: WireEntry[]
  /** The bus lines of the sheet, in order. */
  lines: DrawingBus[]
}

/** The aliases of a project as KiCad looks them up: one cache over every sheet, a later sheet's alias of the same name over an earlier one's. */
export function aliasLookup(aliases: readonly BusAlias[] | undefined): AliasLookup | undefined {
  if (!aliases?.length) return undefined
  const by = new Map<string, readonly string[]>()
  for (const a of aliases) by.set(a.name, a.members)
  return (name) => by.get(name)
}

const DRIVER_RANK: Record<BusItem["kind"], number> = { global: 7, local: 4, hierarchical: 3, pin: 2 }

/** Whether any segment of the list passes through the point. */
function touches(index: SegmentIndex, list: { points: Vec2[] }[], p: Vec2): boolean {
  for (const [wi, segs] of index.near(p)) for (const i of segs) if (pointOnSegment(p, list[wi].points[i], list[wi].points[i + 1])) return true
  return false
}

/** Every segment of the list through the point, by the list's index. */
function through(index: SegmentIndex, list: { points: Vec2[] }[], p: Vec2): number[] {
  const out: number[] = []
  for (const [wi, segs] of index.near(p)) if (segs.some((i) => pointOnSegment(p, list[wi].points[i], list[wi].points[i + 1]))) out.push(wi)
  return out
}

/** Whether a project has anything S3 reads: bus lines or entries, a bus alias, or a label or sheet pin whose name could be a bus. Cheap, so a plain project pays nothing more. */
export function mayHaveBuses(project: Pick<Project, "drawings" | "busAliases" | "labels" | "sheetSymbols">): boolean {
  if (project.drawings?.some((d) => d.type === "bus" || d.type === "busentry")) return true
  if (project.busAliases?.length) return true
  const maybe = (s: string) => s.includes("[") || s.includes("{")
  if (project.labels.some((l) => maybe(l.name))) return true
  return !!project.sheetSymbols?.some((s) => s.pins.some((p) => maybe(p.name)))
}

/**
 * The buses of one sheet. A label or sheet pin whose name is a bus and that touches no wire names a bus (one that touches a bus line, or
 * nothing at all); a bus name on a wire is a net's name, as the editor has always taken it.
 */
export function analyzeSheet(
  project: Pick<Project, "drawings">,
  sheet: string,
  wires: readonly Wire[],
  labels: readonly NetLabel[],
  symbols: readonly SheetSymbol[],
  aliases: AliasLookup | undefined,
): SheetBuses {
  const lines: DrawingBus[] = []
  const entryDrawings: DrawingBusEntry[] = []
  for (const d of project.drawings ?? []) {
    if (sheetIdOf(d) !== sheet) continue
    if (d.type === "bus") lines.push(d)
    else if (d.type === "busentry") entryDrawings.push(d)
  }
  const busIndex = lines.length ? new SegmentIndex(lines) : null
  const wireIndex = wires.length ? new SegmentIndex(wires as Wire[]) : null

  // Which labels and pins name a bus.
  const items: BusItem[] = []
  const bare = (p: Vec2) => (busIndex && touches(busIndex, lines, p)) || !(wireIndex && touches(wireIndex, wires as Wire[], p))
  const parse = (text: string): BusName | null => {
    try {
      return parseBusName(text, aliases)
    } catch (e) {
      if (e instanceof BusTooLarge) return null
      throw e
    }
  }
  for (const l of labels) {
    if (!l.name.includes("[") && !l.name.includes("{")) continue
    const text = l.name.trim()
    const name = parse(text)
    if (name && bare(l)) items.push({ id: l.id, kind: l.kind === "global" ? "global" : l.kind === "hierarchical" ? "hierarchical" : "local", text, at: l, name, group: -1 })
  }
  for (const sym of symbols) {
    for (const p of sym.pins) {
      if (!p.name.includes("[") && !p.name.includes("{")) continue
      const text = p.name.trim()
      const name = parse(text)
      if (name && bare(p)) items.push({ id: `${sym.id}:${p.id}`, kind: "pin", text, at: p, name, symbol: sym, group: -1 })
    }
  }

  // Which of them are one bus: lines that meet, a bus-to-bus entry and the buses at its ends, and the names on a line.
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    for (;;) {
      const p = parent.get(r)
      if (p === undefined || p === r) break
      r = p
    }
    if (!parent.has(k)) parent.set(k, k)
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  lines.forEach((l) => find(`l:${l.id}`))
  if (busIndex) {
    lines.forEach((l, li) => {
      // A line's ends on another line (an end on the other's side joins it, as a wire's does).
      for (const end of [l.points[0], l.points[l.points.length - 1]]) for (const oi of through(busIndex, lines, end)) if (oi !== li) union(`l:${l.id}`, `l:${lines[oi].id}`)
    })
    for (const e of entryDrawings) {
      if (!e.toBus) continue
      find(`e:${e.id}`)
      for (const end of [{ x: e.x, y: e.y }, { x: e.x + e.dx, y: e.y + e.dy }]) for (const oi of through(busIndex, lines, end)) union(`e:${e.id}`, `l:${lines[oi].id}`)
    }
    items.forEach((it, i) => {
      find(`i:${i}`)
      for (const oi of through(busIndex, lines, it.at)) union(`i:${i}`, `l:${lines[oi].id}`)
    })
  } else items.forEach((_, i) => find(`i:${i}`))

  const groupOf = new Map<string, number>()
  const groups: BusGroup[] = []
  const slot = (key: string) => {
    const r = find(key)
    let g = groupOf.get(r)
    if (g === undefined) {
      g = groups.length
      groupOf.set(r, g)
      groups.push({ lines: [], entries: [], items: [] })
    }
    return g
  }
  for (const l of lines) groups[slot(`l:${l.id}`)].lines.push(l.id)
  for (const e of entryDrawings) if (e.toBus) groups[slot(`e:${e.id}`)].entries.push(e.id)
  items.forEach((it, i) => {
    it.group = slot(`i:${i}`)
    groups[it.group].items.push(it)
  })
  for (const g of groups) {
    g.driver = g.items.slice().sort((a, b) => DRIVER_RANK[b.kind] - DRIVER_RANK[a.kind] || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))[0]
  }

  const busLabels = new Map<string, BusItem>()
  const busPins = new Map<string, BusItem>()
  for (const it of items) (it.kind === "pin" ? busPins : busLabels).set(it.id, it)

  // Entries of a wire: which end is on a bus.
  const entries: WireEntry[] = []
  for (const e of entryDrawings) {
    if (e.toBus) continue
    const ends = [{ x: e.x, y: e.y }, { x: e.x + e.dx, y: e.y + e.dy }]
    const hits = ends.map((p) => (busIndex ? through(busIndex, lines, p) : []))
    const busIdx = hits.findIndex((h) => h.length > 0)
    const group = busIdx >= 0 ? groupOf.get(find(`l:${lines[hits[busIdx][0]].id}`))! : -1
    entries.push({ id: e.id, ends: [ends[0], ends[1]], onBus: [hits[0].length > 0, hits[1].length > 0], group })
  }
  return { groups, busLabels, busPins, entries, lines }
}

/**
 * The members of two names of one bus that are the same net, as `matchBusMember` finds them: a vector's by position (the names may differ), a group's
 * by the member's own name without its group's prefix. Each pair is the two full names. With `exact`, only members of one full name (KiCad 5 joins
 * members by their names alone).
 */
export function memberPairs(a: BusName, b: BusName, exact = false): [string, string][] {
  if (exact) {
    const names = new Set(b.names)
    return a.names.filter((n) => names.has(n)).map((n) => [n, n])
  }
  if (a.kind === "vector" && b.kind === "vector") {
    const n = Math.min(a.names.length, b.names.length)
    return Array.from({ length: n }, (_, i) => [a.names[i], b.names[i]])
  }
  if (a.kind === "group" && b.kind === "group") {
    const at = new Map<string, string>()
    a.locals.forEach((l, i) => at.has(l) || at.set(l, a.names[i]))
    const out: [string, string][] = []
    b.locals.forEach((l, i) => {
      const x = at.get(l)
      if (x !== undefined) out.push([x, b.names[i]])
    })
    return out
  }
  return []
}
