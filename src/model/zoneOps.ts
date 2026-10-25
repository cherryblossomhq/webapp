import { uid } from "../lib/id"
import { polygonPath, zoneLayers } from "./zones"
import type { PathSeg, ShapePath } from "./shapes"
import { segEnd, segStart } from "./shapes"
import { signedArea } from "./outline"
import type { CopperLayer, Project, Vec2, Zone, ZoneKeepout } from "./types"

// Editing zones (X3): every change to a zone is a pure function returning a new project (or zone), so the PCB view's tools, the Inspector and
// Sakura's tool share one set of rules and every change can be undone. Nothing here touches a project that has no polygon zones.

/** The least corners a polygon needs. */
export const MIN_CORNERS = 3

export interface NewZoneOptions {
  net?: string
  layers?: CopperLayer[]
  priority?: number
  clearance?: number
  name?: string
  keepout?: ZoneKeepout
}

/** The zone a drawn polygon makes: on the layers given (the top layer by default), on the net given or none. Null when the polygon has too few corners or no area. */
export function makeZone(points: Vec2[], opts: NewZoneOptions = {}): Zone | null {
  const pts = dedupe(points)
  if (pts.length < MIN_CORNERS || Math.abs(signedArea(pts)) < 1e-9) return null
  const layers = opts.layers && opts.layers.length ? [...new Set(opts.layers)] : (["top"] as CopperLayer[])
  const zone: Zone = { id: uid("z"), net: opts.keepout ? "" : (opts.net ?? ""), layer: layers[0], outline: [polygonPath(pts)] }
  if (layers.length > 1) zone.layers = layers
  if (opts.priority && opts.priority > 0) zone.priority = Math.round(opts.priority)
  if (opts.clearance !== undefined && opts.clearance >= 0) zone.clearance = opts.clearance
  if (opts.name) zone.name = opts.name
  if (opts.keepout) zone.keepout = { ...opts.keepout }
  return zone
}

/** The corners without a point repeated one after the other (a double click adds the last one twice), and without the closing point. */
export function dedupe(points: Vec2[]): Vec2[] {
  const out: Vec2[] = []
  for (const p of points) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-9) out.push({ x: p.x, y: p.y })
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-9) out.pop()
  return out
}

const stamp = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

export const addZone = (project: Project, zone: Zone): Project => stamp({ ...project, zones: [...project.zones, zone] })

/** Remove zones by id; a zone not found is left alone. The project is the same object when none is there. */
export function removeZones(project: Project, ids: Iterable<string>): Project {
  const gone = new Set(ids)
  if (!project.zones.some((z) => gone.has(z.id))) return project
  return stamp({ ...project, zones: project.zones.filter((z) => !gone.has(z.id)) })
}

/** Fields a patch may set: `undefined` clears one. A locked zone refuses every change but the lock's own. */
export type ZonePatch = Partial<Omit<Zone, "id" | "outline">>

export function updateZone(project: Project, id: string, patch: ZonePatch): Project {
  const z = project.zones.find((x) => x.id === id)
  if (!z) return project
  if (z.locked && !("locked" in patch)) return project
  const next: Zone = { ...z }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as unknown as Record<string, unknown>)[k]
    else (next as unknown as Record<string, unknown>)[k] = v
  }
  // The first layer is the zone's own: a patch to `layers` keeps `layer` the first of them, and a lone layer is just `layer`.
  if (patch.layers !== undefined && patch.layers.length) {
    const layers = [...new Set(patch.layers)]
    next.layer = layers[0]
    if (layers.length > 1) next.layers = layers
    else delete next.layers
  } else if (patch.layer !== undefined && !next.layers?.includes(patch.layer)) {
    delete next.layers
  }
  // A rule area has no net; a pour that stops being one gets none.
  if (next.keepout) next.net = ""
  return stamp({ ...project, zones: project.zones.map((x) => (x.id === id ? next : x)) })
}

// ---------- the polygon ----------

export interface ZoneCorner {
  ring: number
  index: number
  at: Vec2
}

/** Every corner of a zone's polygon: where each piece of each ring starts. */
export function zoneCorners(z: Zone): ZoneCorner[] {
  const out: ZoneCorner[] = []
  z.outline?.forEach((p, ring) => p.segs.forEach((s, index) => out.push({ ring, index, at: segStart(s) })))
  return out
}

const withStart = (s: PathSeg, at: Vec2): PathSeg => {
  switch (s.kind) {
    case "line":
      return { ...s, a: at }
    case "arc":
      return { ...s, start: at }
    case "bezier":
      return { ...s, p0: at }
    default:
      return s
  }
}
const withEnd = (s: PathSeg, at: Vec2): PathSeg => {
  switch (s.kind) {
    case "line":
      return { ...s, b: at }
    case "arc":
      return { ...s, end: at }
    case "bezier":
      return { ...s, p1: at }
    default:
      return s
  }
}

/** A path with one corner moved: the piece that starts there and the piece before it that ends there. */
export function moveCorner(path: ShapePath, index: number, to: Vec2): ShapePath {
  const n = path.segs.length
  const segs = path.segs.map((s, i) => {
    let out = s
    if (i === index) out = withStart(out, to)
    if ((i + 1) % n === index) out = withEnd(out, to)
    return out
  })
  return { ...path, segs }
}

/** The zone with a corner of one of its rings moved. A locked zone, or a corner that is not there, is returned as it is. */
export function setZoneCorner(z: Zone, ring: number, index: number, to: Vec2): Zone {
  if (z.locked || !z.outline?.[ring] || index < 0 || index >= z.outline[ring].segs.length) return z
  return { ...z, outline: z.outline.map((p, i) => (i === ring ? moveCorner(p, index, to) : p)) }
}

/** The zone moved by a distance, everything in it. */
export function moveZone(z: Zone, dx: number, dy: number): Zone {
  if (z.locked || !z.outline) return z
  const m = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy })
  const seg = (s: PathSeg): PathSeg => {
    switch (s.kind) {
      case "line":
        return { kind: "line", a: m(s.a), b: m(s.b) }
      case "arc":
        return { kind: "arc", start: m(s.start), mid: m(s.mid), end: m(s.end) }
      case "bezier":
        return { kind: "bezier", p0: m(s.p0), c1: m(s.c1), c2: m(s.c2), p1: m(s.p1) }
      default:
        return { ...s, c: m(s.c) }
    }
  }
  return { ...z, outline: z.outline.map((p) => ({ ...p, segs: p.segs.map(seg) })) }
}

/** A corner added on a straight piece, where the piece is cut in two. A piece that is not straight cannot be cut here: the zone is returned as it is. */
export function insertZoneCorner(z: Zone, ring: number, index: number, at: Vec2): Zone {
  const path = z.outline?.[ring]
  const s = path?.segs[index]
  if (z.locked || !path || !s || s.kind !== "line") return z
  const segs: PathSeg[] = [...path.segs.slice(0, index), { kind: "line", a: s.a, b: at }, { kind: "line", a: at, b: s.b }, ...path.segs.slice(index + 1)]
  return { ...z, outline: z.outline!.map((p, i) => (i === ring ? { ...p, segs } : p)) }
}

/**
 * A corner removed: the pieces either side are joined by a straight one. A ring keeps its three corners (and a zone its outline): what would
 * leave fewer is returned as it is. Deleting a corner between a line and an arc keeps the arc whole and joins to its end.
 */
export function deleteZoneCorner(z: Zone, ring: number, index: number): Zone {
  const path = z.outline?.[ring]
  if (z.locked || !path || path.segs.length <= MIN_CORNERS || index < 0 || index >= path.segs.length) return z
  const n = path.segs.length
  const prev = (index + n - 1) % n
  const joined: PathSeg = { kind: "line", a: segEnd(path.segs[prev]), b: segEnd(path.segs[index]) }
  // The piece before the corner is replaced by a line from where it started to the end of the piece at the corner.
  const start = segStart(path.segs[prev])
  const segs = path.segs.flatMap((s, i) => (i === prev ? [{ ...joined, a: start }] : i === index ? [] : [s]))
  return { ...z, outline: z.outline!.map((p, i) => (i === ring ? { ...p, segs } : p)) }
}

/** The outline as a list of points (its corners), for a tool or a message; arcs are held by their ends. */
export const outlinePoints = (z: Zone): Vec2[] => (z.outline?.[0] ? z.outline[0].segs.map(segStart) : [])

/** Whether the project has any zone a tool should draw or list that is not the editor's whole-board pour. */
export const hasPolygonZones = (project: Pick<Project, "zones">): boolean => project.zones.some((z) => z.outline !== undefined)

export { zoneLayers }
