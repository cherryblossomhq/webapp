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

type Box = { minX: number; minY: number; maxX: number; maxY: number }

function boxOf(paths: Paths64): Box | null {
  let box: Box | null = null
  for (const path of paths) {
    for (const p of path) {
      if (!box) box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
      else {
        if (p.x < box.minX) box.minX = p.x
        if (p.x > box.maxX) box.maxX = p.x
        if (p.y < box.minY) box.minY = p.y
        if (p.y > box.maxY) box.maxY = p.y
      }
    }
  }
  return box
}

const overlaps = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

/**
 * What the fills of one project's non-copper zones share, made once rather than once per zone: each zone's outline and its box, the board's loops,
 * the zones of each layer that join and the rule areas that keep pours out. A board converted from EAGLE had 8,827 zones on its solder mask, and
 * each one's fill went over every other zone's outline: 78 million tests and 11 minutes for its Gerbers.
 */
class OtherZones {
  private readonly outlines = new Map<Zone, { paths: Paths64; box: Box | null }>()
  private readonly joinable = new Map<string, Zone[]>()
  private readonly keepouts = new Map<string, Paths64>()
  private boardPaths: Paths64 | null = null
  constructor(private readonly project: Project) {}

  outline(zone: Zone) {
    let o = this.outlines.get(zone)
    if (!o) {
      const paths = outlinePaths(this.project, zone)
      this.outlines.set(zone, (o = { paths, box: boxOf(paths) }))
    }
    return o
  }

  board(): Paths64 {
    return (this.boardPaths ??= boardLoops(this.project.board))
  }

  /** The zones a zone on `layer` may join. KiCad's `GetInteractingZones` looks only at `board->Zones()`: a zone that belongs to a part is never joined to a board zone's outline. */
  joining(layer: string): Zone[] {
    let zones = this.joinable.get(layer)
    if (!zones) this.joinable.set(layer, (zones = this.project.zones.filter((o) => !o.part && isOtherZone(o) && !isRuleArea(o) && o.other!.includes(layer))))
    return zones
  }

  /** The rule areas on `layer` that keep pours out, as one shape. */
  keptOut(layer: string): Paths64 {
    let paths = this.keepouts.get(layer)
    if (!paths) {
      const areas = this.project.zones.filter((o) => o.keepout?.pour === true && o.other?.includes(layer) && hasPolygon(o))
      this.keepouts.set(layer, (paths = areas.length ? union(areas.flatMap((a) => this.outline(a).paths)) : []))
    }
    return paths
  }
}

const contexts = new WeakMap<Project, OtherZones>()
const contextOf = (project: Project): OtherZones => {
  let ctx = contexts.get(project)
  if (!ctx) contexts.set(project, (ctx = new OtherZones(project)))
  return ctx
}

/** The zone's smoothed outline on a layer: what its fill starts from, and what the solder mask is built from when the board has a minimum web (`TransformSmoothedOutlineToPolygon`). */
export function smoothedOtherOutline(project: Project, zone: Zone, layer: string): Paths64 {
  const ctx = contextOf(project)
  const own = ctx.outline(zone)
  const flat = own.paths
  if (!flat.length) return []
  let joined = flat
  for (const other of ctx.joining(layer)) {
    if (other === zone) continue
    const o = ctx.outline(other)
    // A zone whose box is apart from this one's can't overlap it; the polygons decide for the rest.
    if (!o.paths.length || !own.box || !o.box || !overlaps(own.box, o.box)) continue
    if (intersect(flat, o.paths).length) joined = union(joined, o.paths)
  }
  const inside = intersect(joined, ctx.board())
  const smoothed = zone.smoothing && zone.smoothing.radius > 0 ? smoothPaths(inside, zone.smoothing.kind, zone.smoothing.radius) : inside
  return intersect(smoothed, flat)
}

/** `smoothedOtherOutline` as rings in millimetres (the outline and its holes, each flat). */
export const smoothedOtherRings = (project: Project, zone: Zone, layer: string): Vec2[][] => smoothedOtherOutline(project, zone, layer).map(toVec)

function fillOne(project: Project, zone: Zone, layer: string): Paths64 {
  let fill = smoothedOtherOutline(project, zone, layer)
  if (!fill.length) return []
  // The zone itself is never one of them: a rule area has no fill of its own.
  const keptOut = contextOf(project).keptOut(layer)
  if (keptOut.length) fill = difference(fill, keptOut)
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
