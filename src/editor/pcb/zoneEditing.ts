import { pointSegmentDistance } from "../../lib/geometry"
import type { ZoneFill } from "../../model/pour"
import { fillTester } from "../../model/pour"
import { segEnd, segStart } from "../../model/shapes"
import { areaContains, zoneArea, zoneLayers } from "../../model/zones"
import { zoneCorners, type ZoneCorner } from "../../model/zoneOps"
import type { CopperLayer, Project, Vec2, Zone } from "../../model/types"

// The pure parts of picking and editing zones in the PCB view, kept out of the component so they can be tested without a browser.

export const zoneSelectionId = (id: string) => `z:${id}`

/** The zone ids of a selection. */
export const selectedZoneIds = (selection: string[]): string[] => selection.filter((s) => s.startsWith("z:")).map((s) => s.slice(2))

/** The nearest distance from a point to a zone's outline (any ring), Infinity for a zone with none. */
function edgeDistance(z: Zone, at: Vec2): number {
  const area = zoneArea(z)
  if (!area) return Infinity
  let best = Infinity
  for (const ring of area.rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, pointSegmentDistance(at, ring[j], ring[i]))
  return best
}

/**
 * The zone under a point: one whose outline is within `tol` of it, or, where nothing else is, one whose copper or (for a rule area) whose
 * area holds it, on the layer shown. Later zones win, as they are drawn on top.
 */
export function zoneHit(project: Project, at: Vec2, tol: number, layer: CopperLayer, fills: ZoneFill[]): string | null {
  const polygons = project.zones.filter((z) => z.outline)
  for (let i = polygons.length - 1; i >= 0; i--) if (edgeDistance(polygons[i], at) <= tol * 0.5) return polygons[i].id
  for (let i = polygons.length - 1; i >= 0; i--) {
    const z = polygons[i]
    if (!zoneLayers(z).includes(layer)) continue
    const area = zoneArea(z)
    if (z.keepout) {
      // X20: a placement area that keeps nothing out is picked by its edge only: it usually holds half the board, and the board's own edge and the parts inside it would be out of reach.
      if (z.placement && Object.keys(z.keepout).length === 0) continue
      if (area && areaContains(area, at)) return z.id
      continue
    }
    for (const f of fills) if (f.zoneId === z.id && f.layer === layer && f.polygons.some((poly) => fillTester(poly)(at))) return z.id
  }
  return null
}

/** The corner of a zone within `reach` of a point. */
export function cornerAt(z: Zone, at: Vec2, reach: number): ZoneCorner | null {
  return zoneCorners(z).find((c) => Math.hypot(c.at.x - at.x, c.at.y - at.y) <= reach) ?? null
}

/** The middle of a straight piece within `reach` of a point: where dragging adds a corner. */
export function midpointAt(z: Zone, at: Vec2, reach: number): { ring: number; index: number; at: Vec2 } | null {
  let found: { ring: number; index: number; at: Vec2 } | null = null
  z.outline?.forEach((p, ring) =>
    p.segs.forEach((s, index) => {
      if (found || s.kind !== "line") return
      const m = { x: (segStart(s).x + segEnd(s).x) / 2, y: (segStart(s).y + segEnd(s).y) / 2 }
      if (Math.hypot(m.x - at.x, m.y - at.y) <= reach) found = { ring, index, at: m }
    }),
  )
  return found
}

/** Whether the next click of the zone tool closes the polygon: it lands on the first corner of three or more. */
export const closesPolygon = (points: Vec2[], at: Vec2, reach: number): boolean => points.length >= 3 && Math.hypot(points[0].x - at.x, points[0].y - at.y) <= reach

export const ZONE_TOOL_KEY = "Z"
export const KEEPOUT_TOOL_KEY = "K"
export const PLACEMENT_TOOL_KEY = "J"
