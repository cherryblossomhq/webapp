import { Clipper, FillRule, JoinType, type Paths64 } from "@countertype/clipper2-ts"
import type { FillPolygon } from "./pour"
import type { Project, Vec2, Zone } from "./types"
import { boardLoops, difference, inflate, intersect, toVec, union } from "./zoneGeom"
import { withPartZones } from "./partZones"
import { groupsOf, outlinePaths, smoothPaths } from "./zoneFill"
import { hasPolygon, isOtherZone, isRuleArea, zoneRings } from "./zones"

// The fill of a zone on layers that are not copper (X29), as KiCad's `ZONE_FILLER::fillNonCopperZone` makes it (pcbnew/zone_filler.cpp, KiCad 9.0 :1881 and 10.0 :3242; `ZONE::BuildSmoothedPoly`,
// zone.cpp 9.0 :1419). A zone on the mask, the paste, the silkscreen or a user layer has no net, no clearance and no pads to keep from, so its fill is, per layer it is on:
//
//   1. its polygon, with the polygons of the other zones on that layer it overlaps (none is on a net, so every one is the same net), kept inside the board's outline, its corners smoothed,
//      and the result kept inside the zone's own polygon
//   2. minus the rule areas that keep pours out and are on that layer
//   3. the minimum width: the shape shrunk by half of it less a thousandth of a millimetre (bevelled corners) and grown back (rounded corners), which takes away anything thinner
//
// Text and drawings that are knocked out of a zone on their layer (`IsKnockout`) are not subtracted: the model has no knockout item that overlaps a filled zone (a text's knockout is its own fill).
// A zone has the fill on every layer it is on; the layer's Gerber, the editor's drawing and the KiCad export read it from here.

export interface OtherFill {
  zoneId: string
  /** KiCad's name of the layer: `F.Mask`, `B.SilkS`, `User.3`... */
  layer: string
  polygons: FillPolygon[]
}

/** A thousandth of a millimetre, which KiCad takes off the shrinking so a feature exactly as wide as the minimum survives. */
const EPSILON_MM = 0.001

const toPolygons = (paths: Paths64): FillPolygon[] => groupsOf(paths).map((g) => g.paths.map(toVec))

/** The zone's smoothed outline on a layer: what its fill starts from, and what the solder mask is built from when the board has a minimum web (`TransformSmoothedOutlineToPolygon`). */
export function smoothedOtherOutline(project: Project, zone: Zone, layer: string): Paths64 {
  const flat = outlinePaths(project, zone)
  if (!flat.length) return []
  let joined = flat
  for (const other of project.zones) {
    if (other === zone || !isOtherZone(other) || isRuleArea(other) || !other.other!.includes(layer)) continue
    const o = outlinePaths(project, other)
    if (o.length && intersect(flat, o).length) joined = union(joined, o)
  }
  const inside = intersect(joined, boardLoops(project.board))
  const smoothed = zone.smoothing && zone.smoothing.radius > 0 ? smoothPaths(inside, zone.smoothing.kind, zone.smoothing.radius) : inside
  return intersect(smoothed, flat)
}

/** `smoothedOtherOutline` as rings in millimetres (the outline and its holes, each flat). */
export const smoothedOtherRings = (project: Project, zone: Zone, layer: string): Vec2[][] => smoothedOtherOutline(project, zone, layer).map(toVec)

function fillOne(project: Project, zone: Zone, layer: string): Paths64 {
  let fill = smoothedOtherOutline(project, zone, layer)
  if (!fill.length) return []
  const areas = project.zones.filter((o) => o !== zone && o.keepout?.pour === true && o.other?.includes(layer) && hasPolygon(o))
  if (areas.length) fill = difference(fill, union(areas.flatMap((a) => outlinePaths(project, a))))
  const minWidth = Math.max(0, zone.minWidth ?? project.rules.pourMinWidth)
  const shrink = minWidth / 2 - EPSILON_MM
  if (shrink > 0 && fill.length) fill = inflate(fill, -shrink, JoinType.Square)
  if (shrink > EPSILON_MM && fill.length) fill = inflate(fill, shrink)
  return fill.length ? Clipper.union(fill, [], FillRule.NonZero) : []
}

/** Whether the project has a zone that is filled on a layer that is not copper. */
export const hasOtherZones = (project: Pick<Project, "zones">): boolean => project.zones.some((z) => isOtherZone(z) && !isRuleArea(z))

const cache = new WeakMap<readonly Zone[], WeakMap<Project["board"], WeakMap<Project["rules"], OtherFill[]>>>()
const NONE: OtherFill[] = []

/**
 * The fills of every zone on layers that are not copper, in the order the zones are stored and, for a zone, the order of its layers. The same array comes back for the same zones, board and
 * rules, and `[]` (one shared array) for a project with no such zone, so a board drawn in the editor does nothing here.
 */
export function nonCopperFills(project: Project): OtherFill[] {
  // A filled area drawn inside a part is the part's, where the part stands (X30).
  project = withPartZones(project)
  if (!hasOtherZones(project)) return NONE
  let byBoard = cache.get(project.zones)
  if (!byBoard) cache.set(project.zones, (byBoard = new WeakMap()))
  let byRules = byBoard.get(project.board)
  if (!byRules) byBoard.set(project.board, (byRules = new WeakMap()))
  const hit = byRules.get(project.rules)
  if (hit) return hit
  const out: OtherFill[] = []
  for (const zone of project.zones) {
    if (!isOtherZone(zone) || isRuleArea(zone) || zoneRings(zone).length === 0) continue
    for (const layer of zone.other!) out.push({ zoneId: zone.id, layer, polygons: toPolygons(fillOne(project, zone, layer)) })
  }
  byRules.set(project.rules, out)
  return out
}

/** The fills on one layer (`F.Mask`, `B.SilkS`...). */
export const otherFillsOn = (project: Project, layer: string): OtherFill[] => {
  const all = nonCopperFills(project)
  return all === NONE ? NONE : all.filter((f) => f.layer === layer)
}
