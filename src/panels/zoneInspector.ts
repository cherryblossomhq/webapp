import type { ZoneFill } from "../model/pour"
import { signedArea } from "../model/outline"
import type { Project, Vec2, Zone } from "../model/types"
import { zoneRings } from "../model/zones"

// What the zone panel says about a zone, as pure functions.

export interface ZoneFacts {
  /** The corners of its outline (every ring). */
  corners: number
  /** The area of its polygon, holes taken out (mm²). */
  area: number
  /** The copper the editor fills it with, as polygons, on every layer. */
  copper: Vec2[][][]
  pieces: number
  empty: boolean
}

export function zoneFacts(project: Project, zone: Zone, fills: ZoneFill[]): ZoneFacts {
  const rings = zoneRings(zone)
  const area = rings.reduce((a, r, i) => a + (i === 0 ? 1 : -1) * Math.abs(signedArea(r)), 0)
  const copper = fills.filter((f) => f.zoneId === zone.id).flatMap((f) => f.polygons)
  void project
  return { corners: rings.reduce((n, r) => n + r.length, 0), area, copper, pieces: copper.length, empty: copper.length === 0 }
}

/** The area of fill polygons (outline minus holes), in mm². */
export function areaMm2OfZone(copper: Vec2[][][]): number {
  return copper.reduce((a, poly) => a + poly.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * Math.abs(signedArea(r)), 0), 0)
}
