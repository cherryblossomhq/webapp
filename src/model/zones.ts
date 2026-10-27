import { emptyBox, expandBox, pointSegmentDistance, segmentSegmentDistance, type Box } from "../lib/geometry"
import { outlineGeometry } from "./outline"
import { zoneClearance } from "./rules"
import { flattenPath, pathsBox, type ShapePath } from "./shapes"
import type { CopperLayer, DesignRules, Project, Vec2, Zone, ZoneConnection } from "./types"

// Zones (X3): what a zone is as geometry and as settings. The fill itself is `zoneFill.ts` (a zone with a polygon) and `pour.ts`
// (the editor's whole-board pour, which this file leaves exactly as it was): this file says which is which, resolves each setting
// from the zone or the board's rules, and holds the pure functions the editing tools, the checks and the router share.

/** The copper layers a zone is on, its own first; none for a zone that is on layers that are not copper (X29). */
export const zoneLayers = (z: Zone): CopperLayer[] => (z.layers ? z.layers : [z.layer])

/** The layers a zone is on that are not copper (X29), by KiCad's names. */
export const zoneOtherLayers = (z: Zone): readonly string[] => z.other ?? NONE

/** A zone on mask, paste, silkscreen or a user layer and no copper layer: a filled area of that layer, which the copper engine, the router and Checks have nothing to do with. */
export const isOtherZone = (z: Zone): boolean => z.other !== undefined && z.other.length > 0 && zoneLayers(z).length === 0

/** A rule area that has layers that are not copper beside, or in place of, its copper ones. */
export const hasOtherLayers = (z: Zone): boolean => z.other !== undefined && z.other.length > 0

const NONE: readonly string[] = []

/** A rule area (keepout): not a pour, with no net and no fill. */
export const isRuleArea = (z: Zone): boolean => z.keepout !== undefined

/** Whether the zone is the editor's whole-board pour: no polygon, no rule area, and none of the settings only a polygon zone has. */
export function isWholeBoardPour(z: Zone): boolean {
  return (
    z.outline === undefined &&
    z.keepout === undefined &&
    z.teardrop === undefined &&
    z.layers === undefined &&
    z.other === undefined &&
    z.name === undefined &&
    z.priority === undefined &&
    z.minWidth === undefined &&
    z.connect === undefined &&
    z.thermalGap === undefined &&
    z.spokeWidth === undefined &&
    z.smoothing === undefined &&
    z.hatch === undefined &&
    z.hatchAt === undefined &&
    z.islands === undefined &&
    z.edgeGap === undefined &&
    z.holeGap === undefined &&
    z.locked === undefined &&
    z.uuid === undefined &&
    z.unordered === undefined
  )
}

/** Whether the project has a land with zones of its own, a keepout or a pour drawn inside a footprint (X30; `partZones.ts` puts them on the board). */
export const hasPartZones = (project: Partial<Pick<Project, "footprints">>): boolean => !!project.footprints?.some((f) => f.zones?.length)

/** Whether any zone of the project needs the polygon engine; when none does, every pour is filled as the editor always filled it. A zone of a part always does. */
export const needsZoneEngine = (project: Pick<Project, "zones"> & Partial<Pick<Project, "footprints">>): boolean => project.zones.some((z) => !isWholeBoardPour(z)) || hasPartZones(project)

/** Whether the zone has a polygon of its own (every rule area does), as opposed to being the whole board. */
export const hasPolygon = (z: Zone): boolean => !!z.outline && z.outline.length > 0

/** A zone's outline as rings: the first is the outline, the others are holes in it, flattened. Empty for a zone with no polygon. */
export function zoneRings(z: Zone): Vec2[][] {
  if (!z.outline) return []
  const out: Vec2[][] = []
  for (const p of z.outline) {
    const pts = flattenPath({ ...p, closed: true })
    if (pts.length >= 3) out.push(pts)
  }
  return out
}

/** The box of a zone's polygon, or null when it has none. */
export function zoneBox(z: Zone): Box | null {
  if (!z.outline || !z.outline.length) return null
  return pathsBox(z.outline)
}

/** The box of the whole board, which a zone with no polygon covers. */
export function boardBox(b: Project["board"]): Box {
  const g = outlineGeometry(b)
  if (g) return g.box
  return { minX: b.x - b.width / 2, minY: b.y - b.height / 2, maxX: b.x + b.width / 2, maxY: b.y + b.height / 2 }
}

/** A closed straight-edged path through the points, which is how a polygon drawn with the zone tool is held. */
export function polygonPath(points: Vec2[]): ShapePath {
  return {
    closed: true,
    segs: points.map((a, i) => ({ kind: "line" as const, a: { x: a.x, y: a.y }, b: { x: points[(i + 1) % points.length].x, y: points[(i + 1) % points.length].y } })),
  }
}

/** The settings of a zone with every default resolved: what the fill and the checks use. */
export interface ZoneSettings {
  clearance: number
  minWidth: number
  connect: ZoneConnection
  thermalGap: number
  spokeWidth: number
  priority: number
  smoothing: NonNullable<Zone["smoothing"]> | null
  /** `always`, `never`, or the area (mm^2) under which an island is removed. */
  islands: "always" | "never" | number
  edgeGap: number
}

export function zoneSettings(project: Pick<Project, "rules">, z: Zone): ZoneSettings {
  const rules: DesignRules = project.rules
  const clearance = zoneClearance(project as Project, z.clearance)
  return {
    clearance,
    minWidth: Math.max(0, z.minWidth ?? rules.pourMinWidth),
    connect: z.connect ?? (rules.thermalRelief === "direct" ? "solid" : rules.thermalRelief === "relief" ? "thermal" : "tht"),
    thermalGap: z.thermalGap ?? rules.thermalGap ?? clearance,
    spokeWidth: z.spokeWidth ?? rules.thermalSpokeWidth,
    priority: z.priority ?? 0,
    smoothing: z.smoothing && z.smoothing.radius > 0 ? z.smoothing : null,
    islands: z.islands === undefined ? "always" : z.islands,
    edgeGap: z.edgeGap ?? rules.edgeClearance,
  }
}

/**
 * A KiCad uuid as the 32 lowercase hex digits KiCad compares it by (`KIID::operator>` compares the sixteen bytes, `kiid.h`), or undefined for a
 * word that is not one. A KiCad 6 file's `tstamp` is eight digits, which KiCad reads into the last four bytes (`KIID( const wxString& )`).
 */
export function kicadUuid(raw: string): string | undefined {
  const h = raw.replace(/-/g, "").toLowerCase()
  if (!/^[0-9a-f]+$/.test(h) || (h.length !== 32 && h.length !== 8)) return undefined
  return h.padStart(32, "0")
}

/**
 * Whether `a` is filled before `b` and cuts into it (KiCad's `HigherPriority`, `zone.cpp` of 6.0 to 10.0): teardrops first, then the higher
 * priority, then the greater uuid. Two zones of a board from KiCad 5 or earlier (`unordered`) have no tie-break, as 5.1's filler (`zone_filler.cpp`)
 * cut a zone only out of zones of strictly higher priority: neither is higher. A zone without a uuid that is not one of those (drawn here) goes by
 * file order, the later one first.
 */
export function higherPriority(project: Pick<Project, "zones">, a: Zone, b: Zone): boolean {
  const ta = a.teardrop !== undefined
  const tb = b.teardrop !== undefined
  if (ta !== tb) return ta
  const pa = a.priority ?? 0
  const pb = b.priority ?? 0
  if (pa !== pb) return pa > pb
  if (a.uuid !== undefined && b.uuid !== undefined && a.uuid !== b.uuid) return a.uuid > b.uuid
  if (a.unordered && b.unordered) return false
  return project.zones.indexOf(a) > project.zones.indexOf(b)
}

/** What a rule area keeps out, as a list of flags that are set. */
export const keepoutFlags = (z: Zone): string[] => (z.keepout ? (["tracks", "vias", "pads", "pour", "footprints"] as const).filter((k) => z.keepout![k]) : [])

/** Rule areas that restrict `what` on `layer`. */
export function keepoutsFor(project: Pick<Project, "zones">, what: keyof NonNullable<Zone["keepout"]>, layer: CopperLayer): Zone[] {
  return project.zones.filter((z) => z.keepout?.[what] && hasPolygon(z) && zoneLayers(z).includes(layer))
}

// ---------- A zone's polygon as an area to ask about ----------

export interface ZoneArea {
  zone: Zone
  rings: Vec2[][]
  box: Box
}

const areaCache = new WeakMap<Zone, ZoneArea | null>()

/** The area a zone with a polygon covers, kept with the zone object (an edit makes a new one). Null for a zone with no polygon. */
export function zoneArea(z: Zone): ZoneArea | null {
  if (areaCache.has(z)) return areaCache.get(z)!
  const rings = zoneRings(z)
  let area: ZoneArea | null = null
  if (rings.length) {
    const box = emptyBox()
    for (const p of rings[0]) expandBox(box, p)
    area = { zone: z, rings, box }
  }
  areaCache.set(z, area)
  return area
}

/** Whether a point is in the area (an odd number of rings round it, so a hole is not in it). */
export function areaContains(a: ZoneArea, p: Vec2): boolean {
  if (p.x < a.box.minX || p.x > a.box.maxX || p.y < a.box.minY || p.y > a.box.maxY) return false
  let inside = false
  for (const ring of a.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const u = ring[i]
      const v = ring[j]
      if (u.y > p.y !== v.y > p.y && p.x < ((v.x - u.x) * (p.y - u.y)) / (v.y - u.y) + u.x) inside = !inside
    }
  }
  return inside
}

/** How far a point is from the area: 0 inside it, else the distance to the nearest edge (Infinity beyond `limit`). */
export function areaDistance(a: ZoneArea, p: Vec2, limit = Infinity): number {
  if (areaContains(a, p)) return 0
  if (p.x < a.box.minX - limit || p.x > a.box.maxX + limit || p.y < a.box.minY - limit || p.y > a.box.maxY + limit) return Infinity
  let best = Infinity
  for (const ring of a.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, pointSegmentDistance(p, ring[j], ring[i]))
  }
  return best <= limit ? best : Infinity
}

/** Whether a polyline (or the ring of a polygon, `closed`) with the given half width touches the area: a point in it, or an edge within the width of its edge. */
export function areaTouches(a: ZoneArea, pts: Vec2[], half: number, closed = false): boolean {
  if (!pts.length) return false
  const b = emptyBox()
  for (const p of pts) expandBox(b, p)
  if (b.maxX + half < a.box.minX || b.minX - half > a.box.maxX || b.maxY + half < a.box.minY || b.minY - half > a.box.maxY) return false
  if (pts.some((p) => areaContains(a, p))) return true
  const n = closed ? pts.length : pts.length - 1
  for (let k = 0; k < Math.max(n, pts.length === 1 ? 1 : 0); k++) {
    const p = pts[k]
    const q = pts[(k + 1) % pts.length]
    for (const ring of a.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (segmentSegmentDistance(p, q, ring[j], ring[i]) <= half) return true
      }
    }
  }
  // A ring that holds the whole area (the area inside a pad, say) still touches it.
  if (closed && pts.length >= 3 && areaCornersInside(a, pts)) return true
  return false
}

function areaCornersInside(a: ZoneArea, pts: Vec2[]): boolean {
  const c = a.rings[0][0]
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const u = pts[i]
    const v = pts[j]
    if (u.y > c.y !== v.y > c.y && c.x < ((v.x - u.x) * (c.y - u.y)) / (v.y - u.y) + u.x) inside = !inside
  }
  return inside
}
