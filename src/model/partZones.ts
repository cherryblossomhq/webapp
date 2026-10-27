import { transformPoint } from "../lib/geometry"
import { componentFootprint } from "./instances"
import { onBoard } from "./partFlags"
import { flipShapeLayer } from "./shapeLayers"
import type { PathSeg, ShapePath } from "./shapes"
import { copperLayers, flipLayer, layerAt } from "./stack"
import type { ComponentInstance, FootprintDef, Project, Vec2, Zone } from "./types"
import { anchorSide, orderedOtherLayers } from "./zoneLayers"
import { hasPartZones } from "./zones"

// The zones that belong to a part (X30): a keepout or a pour drawn inside a footprint. They live on the part's land, in the land's frame (`FootprintDef.zones`), and so move, turn and
// flip with every part that has the land. Everything that reads the board's zones (the fill, Checks, the router, the exports, the views) reads these through `withPartZones`: the
// project with the board's copy of each added to its zones. A project with no part that has zones is returned as it is, the very same object, so a board drawn in the editor does
// nothing here.

/** The id of a zone of a part on the board: the part's id and the zone's place in its land. */
export const partZoneId = (componentId: string, zone: Zone) => `${componentId}~${zone.id}`

export { hasPartZones }

const mapSeg = (s: PathSeg, f: (p: Vec2) => Vec2): PathSeg => {
  switch (s.kind) {
    case "line":
      return { kind: "line", a: f(s.a), b: f(s.b) }
    case "arc":
      return { kind: "arc", start: f(s.start), mid: f(s.mid), end: f(s.end) }
    case "bezier":
      return { kind: "bezier", p0: f(s.p0), c1: f(s.c1), c2: f(s.c2), p1: f(s.p1) }
    default:
      return { ...s, c: f(s.c) }
  }
}

const mapPath = (p: ShapePath, f: (v: Vec2) => Vec2): ShapePath => ({ ...p, segs: p.segs.map((s) => mapSeg(s, f)) })

/** A zone of a land as the board has it for a part: placed, turned and mirrored as the part is, on the layers the part's side puts it on. */
export function placedZone(c: ComponentInstance, zone: Zone, copper: number): Zone {
  const mirror = c.pcb.side === "bottom"
  const f = (p: Vec2) => transformPoint(p, c.pcb, c.pcb.rot, mirror)
  const own = zone.layers ?? [zone.layer]
  const stack = Array.from({ length: copper }, (_, i) => layerAt(i, copper))
  const layers = mirror ? stack.filter((l) => own.includes(flipLayer(l, copper))) : own
  const other = zone.other && mirror ? orderedOtherLayers(zone.other.map((n) => flipShapeLayer(n, copper))) : zone.other
  const out: Zone = { ...zone, id: partZoneId(c.id, zone), part: c.id, layer: layers[0] ?? anchorSide(other ?? []), outline: zone.outline?.map((p) => mapPath(p, f)) }
  delete out.layers
  delete out.other
  if (layers.length !== 1) out.layers = [...layers]
  if (other?.length) out.other = other
  return out
}

interface Entry {
  footprints: Project["footprints"]
  board: Project["board"]
  value: Zone[]
}
const cache = new WeakMap<Project["components"], Entry>()
const NONE: Zone[] = []

/** The zones of every placed part on the board, in the board's frame, in the order of the parts and of their lands' zones. The same array comes back while the parts, the lands and the board are the same. */
export function worldPartZones(project: Project): Zone[] {
  if (!hasPartZones(project)) return NONE
  const hit = cache.get(project.components)
  if (hit && hit.footprints === project.footprints && hit.board === project.board) return hit.value
  const copper = copperLayers(project.board).length
  const out: Zone[] = []
  for (const c of project.components) {
    if (!c.pcb.placed || !onBoard(c)) continue
    const land: FootprintDef | null = componentFootprint(c)
    for (const z of land?.zones ?? []) if (z.outline?.length) out.push(placedZone(c, z, copper))
  }
  cache.set(project.components, { footprints: project.footprints, board: project.board, value: out })
  return out
}

const zonesCache = new WeakMap<Project["zones"], WeakMap<Zone[], Zone[]>>()
const viewCache = new WeakMap<Project, Project>()
/** The projects that are views already: a view of a view is the view. */
const views = new WeakSet<Project>()

/**
 * The project with the zones of its parts among its zones (the board's own first), for what reads zones to read them all. Not for what edits: a zone of a part is the part's, and
 * the tools that change zones change the board's. The same project comes back for a project with no zone in a part, and the same zones array for the same zones and parts.
 */
export function withPartZones(project: Project): Project {
  if (views.has(project)) return project
  const parts = worldPartZones(project)
  if (parts.length === 0) return project
  const hit = viewCache.get(project)
  if (hit) return hit
  let byParts = zonesCache.get(project.zones)
  if (!byParts) zonesCache.set(project.zones, (byParts = new WeakMap()))
  let zones = byParts.get(parts)
  if (!zones) byParts.set(parts, (zones = [...project.zones, ...parts]))
  const view = { ...project, zones }
  viewCache.set(project, view)
  views.add(view)
  return view
}
