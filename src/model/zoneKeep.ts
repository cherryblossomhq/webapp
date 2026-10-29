import type { CopperItem } from "./pcb"
import type { SchematicConnectivity } from "./connectivity"
import { polygonKit, type FillPolygon, type ZoneFill } from "./pour"
import { hashText } from "./zoneFill"
import { zoneLayers } from "./zones"
import type { CopperLayer, Project, Vec2, Zone } from "./types"

// KiCad's stored fill of a zone, kept until an edit would change it (`Zone.kept`).
//
// KiCad keeps a zone's fill in the file and does not make it again until the user refills. A board brought in from KiCad does the same here: the zone's `kept` is the
// copper KiCad filled it with, and while it is valid the zone's fill IS that copper: it is drawn, checked (connectivity, ratsnest, Checks) and written back to a KiCad
// file exactly as it was, point for point.
//
// Valid means the zone's signature (`zoneSignature`) is still the one it had when the board was brought in. The signature is a hash of everything that can change the
// fill of ONE zone, and of nothing else:
//   - the zone itself (its outline, layers, net, priority, clearance, minimum width, pad connection, thermal gap and spokes, smoothing, island rule, hatch, teardrop, locks),
//   - the design rules a fill reads (pour clearance and minimum width, thermal relief, edge and hole clearance, the net classes, the board's minimum clearance, the arc error),
//   - the copper on the zone's layers whose box touches the zone's box grown by the widest gap: each pad (shape, size, hole, clearance, thermal settings, layers), track,
//     via, copper drawing and text, with the net it is on (a net change of an item inside the zone changes the signature),
//   - the other zones (pours, keepouts and rule areas) on a layer the zone is on, whose box touches it,
//   - the board's outline pieces near it (the whole shape of a board with no outline of its own), and the number of copper layers.
// So an edit far from a zone, on another layer, or to something no fill reads, leaves its signature as it was and the zone keeps KiCad's fill; an edit on or near it makes the
// signatures differ, and that zone (only) is filled by the editor again. The test is a box and layer test per item, so it costs one pass over the copper.
//
// Nothing has to be told about an edit: undo, a moved part, a renamed net, a changed rule are all seen the same way, because the signature is read from what the project is.
// (An edit undone to what it was gives KiCad's fill back, which is right: the inputs are KiCad's again.) `refillZones` (model/zoneOps.ts) lets go of the kept fills on demand.

interface Box4 {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** JSON with the keys of every object in order and the undefined ones left out, so what a project says and not how it was read decides the signature (a stored project keeps its keys in another order). */
function J(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "u"
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : J(x))).join(",")}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${J(o[k])}`)
    .join(",")}}`
}

function pointsOf(v: unknown, out: Vec2[]): void {
  if (!v || typeof v !== "object") return
  if (Array.isArray(v)) {
    for (const x of v) pointsOf(x, out)
    return
  }
  const o = v as Record<string, unknown>
  if (typeof o.x === "number" && typeof o.y === "number") out.push({ x: o.x, y: o.y })
  else for (const k of Object.keys(o)) pointsOf(o[k], out)
}

function boxOfPoints(pts: Vec2[]): Box4 | null {
  if (!pts.length) return null
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const p of pts) {
    if (p.x < b.minX) b.minX = p.x
    if (p.x > b.maxX) b.maxX = p.x
    if (p.y < b.minY) b.minY = p.y
    if (p.y > b.maxY) b.maxY = p.y
  }
  return b
}

const touches = (a: Box4, b: Box4, d = 0) => a.minX <= b.maxX + d && a.maxX >= b.minX - d && a.minY <= b.maxY + d && a.maxY >= b.minY - d

/** The zone's own fields that a fill reads: all of them but the kept fill itself. */
const zoneText = (() => {
  const cache = new WeakMap<Zone, { text: string; box: Box4 | null }>()
  return (z: Zone, project: Project): { text: string; box: Box4 | null } => {
    let hit = cache.get(z)
    if (!hit) {
      const text = J({ ...z, kept: undefined })
      const pts: Vec2[] = []
      pointsOf(z.outline, pts)
      const box = z.outline?.length ? boxOfPoints(pts) : null
      hit = { text, box }
      cache.set(z, hit)
    }
    if (hit.box) return hit
    // A zone with no polygon of its own is the whole board.
    const b = project.board
    return { text: hit.text, box: { minX: b.x - b.width / 2, minY: b.y - b.height / 2, maxX: b.x + b.width / 2, maxY: b.y + b.height / 2 } }
  }
})()

/** What a fill reads of the design rules. */
function rulesText(project: Project): string {
  const r = project.rules
  return J([r.clearance, r.pourClearance, r.pourMinWidth, r.thermalRelief, r.thermalSpokes, r.thermalSpokeWidth, r.thermalSpokeAngle, r.edgeClearance, r.holeClearance, r.minClearance, r.maxError, r.netClasses, r.defaultClass, r.netWidths ? 1 : 0, project.board.stack?.copper.length ?? 2])
}

const itemTexts = new WeakMap<CopperItem, string>()

/** What a fill reads of one copper item, without its net. */
function itemText(it: CopperItem): string {
  let t = itemTexts.get(it)
  if (t === undefined) {
    switch (it.kind) {
      case "pad":
        t = `p${J([it.pad, it.layers, it.unflashed, it.cut])}`
        break
      case "segment":
        t = `s${J([it.a, it.b, it.width, it.layers, it.arc])}`
        break
      case "via":
        t = `v${J([it.at, it.diameter, it.layers, it.unflashed, it.cut])}`
        break
      case "shape":
        t = `h${J([it.shape, it.box, it.layers, it.what, it.conducts, it.owner])}`
        break
      default:
        t = ""
    }
    itemTexts.set(it, t)
  }
  return t
}

/** The boxes of the pieces of the board's outline (an arc or curve by its points), with the text of each. */
function outlinePieces(project: Project): { box: Box4; text: string }[] {
  const out: { box: Box4; text: string }[] = []
  const paths = project.board.outline?.paths ?? []
  for (const p of paths) {
    for (const s of p.segs) {
      const pts: Vec2[] = []
      pointsOf(s, pts)
      const box = boxOfPoints(pts)
      if (box) out.push({ box, text: J(s) })
    }
  }
  return out
}

export interface KeptContext {
  /** The signature of a zone now. */
  sigOf(zone: Zone): string
}

/**
 * The signatures of the zones of a project, as the project is now. `copper` and `netOf` are what the analysis has built (`analyzePcb`: the copper items and the net id of
 * each, by index), `netName` the name of a net id; one pass over the copper per zone that has a kept fill.
 */
export function keptContext(project: Project, copper: CopperItem[], netOf: (i: number) => string | null, netName: (id: string | null) => string | null): KeptContext {
  const rules = rulesText(project)
  const pieces = project.board.outline?.paths?.length ? outlinePieces(project) : null
  const rect = pieces ? "" : J([project.board.x, project.board.y, project.board.width, project.board.height, project.board.cornerRadius])
  const nets = copper.map((_, i) => netName(netOf(i)) ?? "")
  const zones = project.zones.map((z) => ({ z, ...zoneText(z, project) }))
  // A fill keeps at least its clearance from copper of another net, so what is farther than the widest gap of the zone, the rules or a pad's own cannot change it.
  const padReach = copper.reduce((m, it) => (it.kind === "pad" && it.pad.clearance ? Math.max(m, it.pad.clearance) : m), 0)
  return {
    sigOf(zone) {
      const own = zoneText(zone, project)
      const layers = new Set(zoneLayers(zone))
      const reach = 1 + Math.max(zone.clearance ?? 0, project.rules.clearance, project.rules.pourClearance, project.rules.edgeClearance, project.rules.holeClearance, project.rules.minClearance ?? 0, zone.edgeGap ?? 0, zone.holeGap ?? 0, zone.thermalGap ?? 0, padReach, ...(project.rules.netClasses ?? []).map((c) => c.clearance ?? 0))
      const parts: string[] = [rules, own.text]
      if (!own.box) return hashText(parts.join("|"))
      const box = own.box
      const items: string[] = []
      for (let i = 0; i < copper.length; i++) {
        const it = copper[i]
        if (it.kind === "zone" || !touches(it.box, box, reach) || !it.layers.some((l) => layers.has(l))) continue
        items.push(`${itemText(it)}@${nets[i]}`)
      }
      items.sort()
      parts.push(`i${items.length}`, ...items)
      const near: string[] = []
      for (const o of zones) {
        if (o.z === zone || o.z.id === zone.id || !o.box || !touches(o.box, box, reach)) continue
        if (!zoneLayers(o.z).some((l) => layers.has(l))) continue
        near.push(o.text)
      }
      near.sort()
      parts.push(`z${near.length}`, ...near)
      if (pieces) {
        const edge = pieces.filter((p) => touches(p.box, box, reach)).map((p) => p.text)
        parts.push(`e${pieces.length}`, ...edge)
      } else parts.push(rect)
      return hashText(parts.join("|")) + hashText(`${parts.length}:${parts.join("\n")}`)
    },
  }
}

const strokedCache = new WeakMap<object, Map<string, FillPolygon[]>>()

/** A kept fill's copper on one layer as the editor's polygons: KiCad's rings as they are, or grown by half the minimum width for a fill KiCad drew with a pen that wide. */
function polygonsOf(zone: Zone, minWidth: number, layer: CopperLayer): FillPolygon[] {
  const kept = zone.kept!
  const on = kept.layers.find((l) => l.layer === layer)
  if (!on) return []
  if (!kept.stroked || !(minWidth > 0)) return on.rings.map((ring) => [ring])
  let cache = strokedCache.get(kept)
  if (!cache) strokedCache.set(kept, (cache = new Map()))
  const key = `${layer}|${minWidth}`
  let hit = cache.get(key)
  if (!hit) {
    hit = polygonKit.regions(polygonKit.inflate(polygonKit.union(on.rings.map((r) => polygonKit.path(r))), minWidth / 2))
    cache.set(key, hit)
  }
  return hit
}

/**
 * The fill of every zone whose kept fill is still valid, by zone id, in the editor's form (`fromFile` set): one entry for each copper layer of the zone, in the zone's order.
 * Empty when no zone has one.
 */
export function keptFills(project: Project, ctx: KeptContext, sch: SchematicConnectivity): Map<string, ZoneFill[]> {
  const out = new Map<string, ZoneFill[]>()
  for (const z of project.zones) {
    if (!z.kept?.sig || z.keepout || z.part || !z.outline || ctx.sigOf(z) !== z.kept.sig) continue
    const netId = z.net ? (sch.nets.find((n) => n.name === z.net)?.id ?? null) : null
    const minWidth = z.minWidth ?? project.rules.pourMinWidth
    out.set(
      z.id,
      zoneLayers(z).map((layer) => ({ zoneId: z.id, netId, netName: z.net, layer, polygons: polygonsOf(z, minWidth, layer), fromFile: true as const })),
    )
  }
  return out
}

/** Whether any zone of the project holds a kept fill (the common case, a project drawn here, is one cheap pass). */
export const hasKeptFills = (project: Project): boolean => project.zones.some((z) => z.kept)

/** The fills of a project, in the order of its zones and their layers, with a kept zone's fill where it is valid and the editor's where it is not. */
export function mergeKept(project: Project, kept: Map<string, ZoneFill[]>, made: ZoneFill[]): ZoneFill[] {
  const out: ZoneFill[] = []
  const byZone = new Map<string, ZoneFill[]>()
  for (const f of made) (byZone.get(f.zoneId) ?? byZone.set(f.zoneId, []).get(f.zoneId)!).push(f)
  for (const z of project.zones) out.push(...(kept.get(z.id) ?? byZone.get(z.id) ?? []))
  return out
}

/** Whether the editor still has to fill a zone: a pour on copper whose fill is not a kept one. */
export const needsOwnFill = (z: Zone, kept: Map<string, ZoneFill[]>): boolean => !z.keepout && !kept.has(z.id) && zoneLayers(z).length > 0

/** A project with every kept fill signed as the project is (the signature is what the zone and its surroundings are now), or without those that cannot be signed. */
export function signKept(project: Project, ctx: KeptContext): Project {
  if (!hasKeptFills(project)) return project
  return { ...project, zones: project.zones.map((z) => (z.kept ? { ...z, kept: { ...z.kept, sig: ctx.sigOf(z) } } : z)) }
}

/** A project that lets go of the kept fills of the zones given (all of them when none are): those zones are filled by the editor from now on. */
export function withoutKept(project: Project, ids?: Iterable<string>): Project {
  const only = ids ? new Set(ids) : null
  if (!project.zones.some((z) => z.kept && (!only || only.has(z.id)))) return project
  return { ...project, zones: project.zones.map((z) => (z.kept && (!only || only.has(z.id)) ? (({ kept, ...rest }) => rest)(z) : z)) }
}
