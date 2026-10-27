import { arcLength, arcOf, isArcTrace } from "./arcTracks"
import { pinKey, type SchematicConnectivity } from "./connectivity"
import { componentFootprint, pcbPads } from "./instances"
import { layerDistance } from "./machining"
import { onBoard } from "./partFlags"
import { resolvedComponents } from "./ruleAreas"
import { copperLayers, kicadLayerName, viaLayers } from "./stack"
import type { PcbGroup, Project, Vec2 } from "./types"

// X21: the length of a net. KiCad's length report (Net Inspector, the tuning tool) adds three things: the copper of the net's tracks, the height of its vias through the stackup, and the length of wire
// inside each package from the pad to the die (`die_length`, and `die_delay` for time) of the net's pads. A tuning pattern says the length it was tuned to; Checks compares it with the length the net has now.

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d

/** A pad's package length and delay: only the pads that have one. */
export interface PadDie {
  ref: string
  pad: string
  length: number
  delay?: number
  componentId: string
  pin: string | null
}

/** Every pad of a part on the board that has a length or a delay inside its package. */
export function padDieTimes(project: Project): PadDie[] {
  const out: PadDie[] = []
  for (const c of resolvedComponents(project)) {
    if (!onBoard(c)) continue
    const fp = componentFootprint(c)
    if (!fp || !fp.pads.some((p) => p.dieLength !== undefined || p.dieDelay !== undefined)) continue
    const world = pcbPads(c)
    fp.pads.forEach((pad, i) => {
      if (pad.dieLength === undefined && pad.dieDelay === undefined) return
      const w = world[i]
      out.push({ ref: c.ref, pad: w.padNumber ?? w.pin ?? "", length: pad.dieLength ?? 0, ...(pad.dieDelay !== undefined ? { delay: pad.dieDelay } : {}), componentId: c.id, pin: w.pin })
    })
  }
  return out
}

export interface NetLength {
  net: string
  /** The copper of the tracks, arcs by their length. */
  tracks: number
  /** The height of the vias: the stackup between the layers each runs between. */
  vias: number
  viaCount: number
  /** The wire inside the packages of the net's pads. */
  package: number
  /** In picoseconds: the delay inside the packages (the delay of the copper depends on the dielectric, which this does not know). */
  packageDelay: number
  total: number
  /** The net's pads, so a net with two is a point to point one. */
  pads: number
  /** Whether the copper is one run from end to end: no track end has more than two tracks or a via on it, which is what a tuning target can be compared with. */
  simple: boolean
}

const trackLength = (t: Project["traces"][number]): number => {
  if (isArcTrace(t)) return arcLength(arcOf(t.points))
  let sum = 0
  for (let i = 1; i < t.points.length; i++) sum += Math.hypot(t.points[i].x - t.points[i - 1].x, t.points[i].y - t.points[i - 1].y)
  return sum
}

const key = (layer: string, p: Vec2) => `${layer}:${Math.round(p.x * 1e3)},${Math.round(p.y * 1e3)}`

/**
 * The length of every net that has copper or a package length, by the net's name, from the analysis's own idea of which net each track and via is on (`traceNet`, `viaNet`).
 * Names are the nets' names in `conn`; copper that is on no net is left out. A project with no track, no via and no package length has none.
 */
export function netLengths(project: Project, conn: SchematicConnectivity, traceNet: ReadonlyMap<string, string | null>, viaNet: ReadonlyMap<string, string | null>): NetLength[] {
  const name = new Map(conn.nets.map((n) => [n.id, n.name]))
  const by = new Map<string, NetLength & { ends: Map<string, number> }>()
  const get = (id: string | null | undefined) => {
    if (!id || id === "short") return null
    const n = name.get(id)
    if (n === undefined) return null
    let e = by.get(n)
    if (!e) {
      e = { net: n, tracks: 0, vias: 0, viaCount: 0, package: 0, packageDelay: 0, total: 0, pads: 0, simple: true, ends: new Map() }
      by.set(n, e)
    }
    return e
  }
  for (const t of project.traces) {
    const e = get(traceNet.get(t.id))
    if (!e) continue
    e.tracks += trackLength(t)
    const ends = isArcTrace(t) ? [t.points[0], t.points[2]] : t.points.length > 1 ? [t.points[0], t.points[t.points.length - 1]] : []
    for (const p of ends) e.ends.set(key(t.layer, p), (e.ends.get(key(t.layer, p)) ?? 0) + 1)
    // a bend inside a polyline is no junction, but a polyline that crosses another trace's end would not be one run either
    for (const p of t.points.slice(1, -1)) e.ends.set(key(t.layer, p), (e.ends.get(key(t.layer, p)) ?? 0) + 2)
  }
  const all = copperLayers(project.board)
  for (const v of project.vias) {
    const e = get(viaNet.get(v.id))
    if (!e) continue
    const l = viaLayers(project.board, v)
    e.vias += layerDistance(project.board, l[0], l[l.length - 1])
    e.viaCount++
    // a via has a track end on each layer it joins; two tracks and a via on a point is a junction only if a third thing is there, so a via counts one on every layer
    for (const layer of all.length > 2 ? l : [l[0], l[l.length - 1]]) e.ends.set(key(layer, v), (e.ends.get(key(layer, v)) ?? 0) + 1)
  }
  for (const c of resolvedComponents(project)) {
    if (!onBoard(c)) continue
    const world = pcbPads(c)
    const fp = componentFootprint(c)
    world.forEach((w, i) => {
      if (!w.pin) return
      const e = get(conn.pinNet.get(pinKey(c.id, w.pin)))
      if (!e) return
      e.pads++
      const pad = fp?.pads[i]
      if (pad?.dieLength) e.package += pad.dieLength
      if (pad?.dieDelay) e.packageDelay += pad.dieDelay
    })
  }
  const out: NetLength[] = []
  for (const e of by.values()) {
    if (!e.tracks && !e.viaCount && !e.package && !e.packageDelay) continue
    const { ends, ...rest } = e
    const simple = [...ends.values()].every((n) => n <= 2)
    out.push({ ...rest, tracks: round(e.tracks), vias: round(e.vias), package: round(e.package), packageDelay: round(e.packageDelay), total: round(e.tracks + e.vias + e.package), simple })
  }
  return out.sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0))
}

// ---------- tuning patterns ----------

export interface TuningPattern {
  group: PcbGroup
  name: string
  /** The layer's KiCad name. */
  layer: string
  /** The length it was tuned to (`target_length`), and the least and most it may have; null where the pattern does not say. */
  target: number | null
  min: number | null
  max: number | null
  /** KiCad's own words of the last tuning (`last_tuning`: "75.9800 mm (too short)"). */
  last: string | null
  /** A pattern tuned in time (`is_time_domain`) is checked by its delay, which this does not measure. */
  time: boolean
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** The tuning patterns of the board, as KiCad's `tuning_pattern` generators; none for a board with no generated item. */
export function tuningPatterns(project: Pick<Project, "groups">): TuningPattern[] {
  const out: TuningPattern[] = []
  for (const g of project.groups ?? []) {
    if (g.gen?.kind !== "tuning_pattern") continue
    const p = g.gen.props
    out.push({
      group: g,
      name: g.name,
      layer: kicadLayerName(g.gen.layer),
      target: num(p.target_length),
      min: num(p.target_length_min),
      max: num(p.target_length_max),
      last: typeof p.last_tuning === "string" ? p.last_tuning : null,
      time: p.is_time_domain === true,
    })
  }
  return out
}

/** A finding of the length check: a tuning pattern whose net is not the length it was tuned to. */
export interface LengthFinding {
  net: string
  total: number
  min: number
  max: number
  detail: string
  at: Vec2
}

/**
 * The tuning patterns whose net has drifted out of the range they were tuned to: the net's length now (tracks, vias and the lengths inside its pads' packages, `netLengths`) against the pattern's least
 * and most. Only a net with two pads and one unbranched run of copper is judged (a net with branches has no one length), and only a pattern tuned in length, not in time.
 */
export function lengthFindings(project: Project, conn: SchematicConnectivity, traceNet: ReadonlyMap<string, string | null>, viaNet: ReadonlyMap<string, string | null>): LengthFinding[] {
  const patterns = tuningPatterns(project).filter((t) => !t.time && t.min !== null && t.max !== null)
  if (!patterns.length) return []
  const lengths = new Map(netLengths(project, conn, traceNet, viaNet).map((n) => [n.net, n]))
  const names = new Map(conn.nets.map((n) => [n.id, n.name]))
  const traces = new Map(project.traces.map((t) => [t.id, t]))
  const out: LengthFinding[] = []
  for (const t of patterns) {
    const member = t.group.members.map((m) => traces.get(m)).find((x) => x !== undefined)
    const id = member ? traceNet.get(member.id) : null
    const net = id && id !== "short" ? names.get(id) : undefined
    const l = net ? lengths.get(net) : undefined
    if (!net || !l || !l.simple || l.pads !== 2) continue
    // judged as the message rounds it, so a length shown as the limit is never called outside it
    const total = Number(l.total.toFixed(3))
    if (total >= Number(t.min!.toFixed(3)) && total <= Number(t.max!.toFixed(3))) continue
    const origin = t.group.gen!.props.origin
    const at = origin && typeof origin === "object" && "xy" in origin ? { x: origin.xy[0], y: origin.xy[1] } : (member?.points[0] ?? { x: 0, y: 0 })
    const parts = [`tracks ${l.tracks.toFixed(3)} mm`, ...(l.viaCount ? [`${l.viaCount} via${l.viaCount === 1 ? "" : "s"} ${l.vias.toFixed(3)} mm`] : []), ...(l.package ? [`packages ${l.package.toFixed(3)} mm`] : [])]
    out.push({ net, total, min: t.min!, max: t.max!, detail: parts.join(", "), at })
  }
  return out
}
