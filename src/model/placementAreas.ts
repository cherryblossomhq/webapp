import { emptyBox, expandBox, type Box } from "../lib/geometry"
import { pcbCourtyardRing } from "./instances"
import { onBoard } from "./partFlags"
import { resolvedComponents } from "./ruleAreas"
import { isHierarchical, sheetUses, useAt } from "./sheets"
import { areaContains, areaDistance, hasPolygon, zoneArea, zoneLayers, type ZoneArea } from "./zones"
import type { ComponentInstance, PcbSide, Project, Vec2, Zone, ZonePlacement } from "./types"

// X20: placement rule areas. A rule area with a `placement` says where the parts it picks must sit: the parts of a sheet, of a component class,
// or the members of a PCB group (KiCad 9's multichannel placement areas, and KiCad 10's group source). The parts it picks stay inside its polygon
// (`autoplace.ts`), Sakura's placement tools keep them there, and Checks reports one that is outside.
//
// Which parts an area picks, and where they have to be:
// - A sheet area picks the parts on that sheet use, by KiCad's sheet path (`/Power/`, `SheetUse.human`), which is what a footprint's `sheetname` says. A board brought
//   in without its schematic has no sheets: the footprint's own `sheetname` is kept on the part (`sheetPath`).
// - A class area picks the parts that have the class among their `classes`; a group area, the parts in a PCB group of that name, directly or through a group in it.
// - An area applies to the parts on a side it is on (`zoneLayers`): an area on the top layer says nothing of the parts on the bottom.
// - A part sits in an area when its courtyard lies inside the polygon (the box of its drawings when it has no courtyard of its own), a hole of the polygon
//   not covered. A part picked by several areas has to sit in one of them: where an area is full, another of the same target takes the rest.
// - A switched off area (`placement.off`) or one with no target name picks nothing.

/** How far (mm) a part may stick out of its area and still sit in it: positions are written to 0.01 mm, which a boundary flush part is rounded across. */
const AREA_TOLERANCE = 0.01

/** The colour of a placement rule area on the board and in the pictures Sakura is given: not the keepout's red, not a layer's copper. */
export const PLACEMENT_COLOR = "#4aa8ff"

export const PLACEMENT_BY: { value: ZonePlacement["by"]; label: string }[] = [
  { value: "sheet", label: "Parts of a sheet" },
  { value: "class", label: "Parts of a class" },
  { value: "group", label: "Parts in a group" },
]

/** Whether the zone is a rule area with a target that is switched on. */
const placesParts = (z: Zone): boolean => !!z.keepout && !!z.placement && !z.placement.off && z.placement.name !== ""

/** What an area holds, in words: `the parts of sheet /Power/`. */
export function placementWords(p: ZonePlacement): string {
  const name = p.name === "" ? "(no name yet)" : p.name
  return p.by === "sheet" ? `the parts of sheet ${name}` : p.by === "class" ? `the parts of class ${name}` : `the parts of group ${name}`
}

/** The short text drawn on the board for an area: its target. */
export function placementLabel(p: ZonePlacement): string {
  const name = p.name === "" ? "?" : p.name
  return p.by === "sheet" ? `sheet ${name}` : p.by === "class" ? `class ${name}` : `group ${name}`
}

/** The areas of a project that place parts now: rule areas with a polygon, a target and the placement on. */
export function placementAreas(project: Pick<Project, "zones">): Zone[] {
  return project.zones.some((z) => z.placement) ? project.zones.filter((z) => placesParts(z) && hasPolygon(z)) : []
}

/** The sheet paths a sheet area can name: the schematic's sheets, then the sheets that parts of a board brought in without its schematic say they are on (`sheetPath`). */
export function sheetNames(project: Project): string[] {
  const names = sheetUses(project).map((u) => u.human)
  for (const c of project.components) if (c.sheetPath !== undefined && !names.includes(c.sheetPath)) names.push(c.sheetPath)
  return names
}

/** The target a new placement area starts with: the sheet of the part that is selected, else the first sheet that has no area yet (the root sheet of a design with one). */
export function defaultPlacement(project: Project, selectedIds: readonly string[]): ZonePlacement {
  const sel = project.components.find((c) => selectedIds.includes(c.id))
  if (sel) return { by: "sheet", name: partSheet(project, sel) }
  const taken = new Set(project.zones.flatMap((z) => (z.placement?.by === "sheet" ? [z.placement.name] : [])))
  const names = sheetNames(project)
  return { by: "sheet", name: names.find((n) => !taken.has(n)) ?? names[0] }
}

// ---------- which parts an area picks ----------

/** The sheet path a part is on, as KiCad writes a footprint's `sheetname`: `/` for the root sheet. */
export function partSheet(project: Pick<Project, "sheets" | "sheetSymbols" | "name">, c: ComponentInstance): string {
  if (c.inst !== undefined || isHierarchical(project)) return useAt(project, c.inst ?? "").human
  return c.sheetPath ?? "/"
}

const groupCache = new WeakMap<object, Map<string, Set<string>>>()

/** The names of the PCB groups a board object is in, directly or through a group that holds that group. */
export function groupNamesOf(project: Pick<Project, "groups">, id: string): Set<string> {
  const groups = project.groups
  const out = new Set<string>()
  if (!groups?.length) return out
  let parents = groupCache.get(groups)
  if (!parents) {
    parents = new Map()
    for (const g of groups) for (const m of g.members) (parents.get(m) ?? parents.set(m, new Set()).get(m)!).add(g.id)
    groupCache.set(groups, parents)
  }
  const byId = new Map(groups.map((g) => [g.id, g]))
  const seen = new Set<string>()
  const walk = (member: string) => {
    for (const gid of parents!.get(member) ?? []) {
      if (seen.has(gid)) continue
      seen.add(gid)
      const g = byId.get(gid)
      if (g) out.add(g.name)
      walk(gid)
    }
  }
  walk(id)
  return out
}

/** Whether the area's target picks the part (before the side is looked at). */
export function picks(project: Project, z: Zone, c: ComponentInstance): boolean {
  const p = z.placement
  if (!p || p.off || p.name === "") return false
  switch (p.by) {
    case "sheet":
      return partSheet(project, c) === p.name
    case "class":
      return !!c.classes && c.classes.includes(p.name)
    case "group":
      return groupNamesOf(project, c.id).has(p.name)
  }
}

/** The areas a part has to sit in one of: those that pick it and are on its side. Empty for a part no area picks. */
export function areasOfPart(project: Project, c: ComponentInstance, areas: Zone[] = placementAreas(project), side: PcbSide = c.pcb.side): Zone[] {
  return areas.filter((z) => picks(project, z, c) && zoneLayers(z).includes(side))
}

// ---------- where a part is ----------

/** The ring the part occupies: its courtyard as placed. */
const partRing = (c: ComponentInstance): Vec2[] | null => pcbCourtyardRing(c)

const centroid = (pts: Vec2[]): Vec2 => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length })

/** The ring drawn in towards its middle by `d`, so a part a rounding's breadth over the edge still sits inside. */
function shrunk(ring: Vec2[], d: number): Vec2[] {
  const m = centroid(ring)
  return ring.map((p) => {
    const l = Math.hypot(p.x - m.x, p.y - m.y)
    return l <= d ? m : { x: p.x + ((m.x - p.x) * d) / l, y: p.y + ((m.y - p.y) * d) / l }
  })
}

const orient = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/** Whether two segments cross at a point inside both (touching or running along one another does not count). */
function properCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  const e = 1e-9
  return ((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) && ((o3 > e && o4 < -e) || (o3 < -e && o4 > e))
}

const insideOrOn = (a: ZoneArea, p: Vec2) => areaContains(a, p) || areaDistance(a, p, 1e-7) <= 1e-7

function pointInRing(ring: Vec2[], p: Vec2): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const u = ring[i]
    const v = ring[j]
    if (u.y > p.y !== v.y > p.y && p.x < ((v.x - u.x) * (p.y - u.y)) / (v.y - u.y) + u.x) inside = !inside
  }
  return inside
}

/** Whether a closed ring of points lies inside the area (its outline, round its holes), within `AREA_TOLERANCE`. */
export function ringInArea(area: ZoneArea, ring: Vec2[], tolerance = AREA_TOLERANCE): boolean {
  if (ring.length < 3) return false
  const pts = tolerance > 0 ? shrunk(ring, tolerance) : ring
  const b = emptyBox()
  for (const p of pts) expandBox(b, p)
  if (b.minX < area.box.minX - 1e-9 || b.maxX > area.box.maxX + 1e-9 || b.minY < area.box.minY - 1e-9 || b.maxY > area.box.maxY + 1e-9) return false
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    if (!insideOrOn(area, p) || !insideOrOn(area, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })) return false
    for (const r of area.rings) {
      for (let k = 0, j = r.length - 1; k < r.length; j = k++) if (properCross(p, q, r[j], r[k])) return false
    }
  }
  for (let h = 1; h < area.rings.length; h++) if (pointInRing(pts, area.rings[h][0])) return false
  return true
}

const boxRing = (b: Box): Vec2[] => [
  { x: b.minX, y: b.minY },
  { x: b.maxX, y: b.minY },
  { x: b.maxX, y: b.maxY },
  { x: b.minX, y: b.maxY },
]
export const boxInArea = (area: ZoneArea, b: Box, tolerance?: number) => ringInArea(area, boxRing(b), tolerance)

/** Whether the part sits in one of the areas, as it stands or as it would at a pose. */
export function partInAreas(c: ComponentInstance, areas: Zone[], pose?: Partial<Pick<ComponentInstance["pcb"], "x" | "y" | "rot" | "side">>): boolean {
  const at = pose ? { ...c, pcb: { ...c.pcb, ...pose } } : c
  const ring = partRing(at)
  if (!ring) return true
  return areas.some((z) => {
    const a = zoneArea(z)
    return !!a && ringInArea(a, ring)
  })
}

// ---------- the check ----------

interface PlacementProblem {
  component: ComponentInstance
  /** The areas that pick it, none of which it sits in. */
  areas: Zone[]
  at: Vec2
}

/** Placed parts that sit outside every area that picks them. Nothing for a project with no placement area. */
export function placementProblems(project: Project): PlacementProblem[] {
  const areas = placementAreas(project)
  if (!areas.length) return []
  const out: PlacementProblem[] = []
  for (const c of resolvedComponents(project)) {
    if (!c.pcb.placed || !onBoard(c) || !c.footprint) continue
    const mine = areasOfPart(project, c, areas)
    if (!mine.length || partInAreas(c, mine)) continue
    out.push({ component: c, areas: mine, at: { x: c.pcb.x, y: c.pcb.y } })
  }
  return out
}

/** A placement area names its sheet by path, so a sheet renamed (or the sheet above it) takes the areas that name it along. `after` is the project once the sheets are renamed. */
export function followSheetNames(before: Pick<Project, "sheets" | "sheetSymbols" | "name">, after: Project): Project {
  if (!after.zones.some((z) => z.placement?.by === "sheet")) return after
  const was = new Map(sheetUses(before).map((u) => [u.path, u.human]))
  const rename = new Map<string, string>()
  for (const u of sheetUses(after)) {
    const old = was.get(u.path)
    if (old !== undefined && old !== u.human) rename.set(old, u.human)
  }
  if (!rename.size) return after
  return { ...after, zones: after.zones.map((z) => (z.placement?.by === "sheet" && rename.has(z.placement.name) ? { ...z, placement: { ...z.placement, name: rename.get(z.placement.name)! } } : z)) }
}

/** What an area does now: how many placed parts it picks, and which of them sit outside every area that picks them. */
export function areaReport(project: Project, z: Zone): { picked: number; outside: string[] } {
  if (!placesParts(z)) return { picked: 0, outside: [] }
  const areas = placementAreas(project)
  let picked = 0
  const outside: string[] = []
  for (const c of resolvedComponents(project)) {
    if (!c.pcb.placed || !onBoard(c) || !c.footprint || !picks(project, z, c) || !zoneLayers(z).includes(c.pcb.side)) continue
    picked++
    if (!partInAreas(c, areasOfPart(project, c, areas))) outside.push(c.ref)
  }
  return { picked, outside }
}

/** How the areas are named in a message: by name where it has one, else by its target. */
function areaName(z: Zone): string {
  const target = z.placement ? placementWords(z.placement) : "parts"
  return z.name ? `placement area ${z.name} (${target})` : `a placement area for ${target}`
}

// ---------- keeping a part in its area ----------

/**
 * The nearest pose for the part, in one of the areas, to where it was asked to go: the same turn and side, a position moved the least. Null when no position fits it (the area
 * is smaller than the part). It is the asked position itself when that already fits.
 */
export function nearestInAreas(c: ComponentInstance, areas: Zone[], want: { x: number; y: number; rot?: number; side?: PcbSide }): { x: number; y: number } | null {
  const pose = { ...c.pcb, rot: want.rot ?? c.pcb.rot, side: want.side ?? c.pcb.side }
  const at = (x: number, y: number) => ({ ...c, pcb: { ...pose, x, y } })
  const origin = partRing(at(0, 0))
  if (!origin) return { x: want.x, y: want.y }
  const lo = { x: Math.min(...origin.map((p) => p.x)), y: Math.min(...origin.map((p) => p.y)) }
  const hi = { x: Math.max(...origin.map((p) => p.x)), y: Math.max(...origin.map((p) => p.y)) }
  const fits = (a: ZoneArea, x: number, y: number) => ringInArea(a, origin.map((p) => ({ x: p.x + x, y: p.y + y })))
  const held: { best: { x: number; y: number; d: number } | null } = { best: null }
  const closer = (x: number, y: number) => !held.best || Math.hypot(x - want.x, y - want.y) < held.best.d
  const take = (x: number, y: number) => {
    if (closer(x, y)) held.best = { x, y, d: Math.hypot(x - want.x, y - want.y) }
  }
  for (const z of areas) {
    const a = zoneArea(z)
    if (!a) continue
    // The positions the part's box can have inside the area's box.
    const x0 = a.box.minX - lo.x
    const x1 = a.box.maxX - hi.x
    const y0 = a.box.minY - lo.y
    const y1 = a.box.maxY - hi.y
    if (x0 > x1 + 1e-9 || y0 > y1 + 1e-9) continue
    const cx = Math.min(Math.max(want.x, x0), Math.max(x0, x1))
    const cy = Math.min(Math.max(want.y, y0), Math.max(y0, y1))
    if (fits(a, want.x, want.y)) return { x: want.x, y: want.y }
    // A rectangle: its corner or edge is the nearest.
    if (fits(a, cx, cy)) {
      take(cx, cy)
      continue
    }
    // Any other shape: a grid over the positions the box allows, the nearest that fits.
    const step = Math.max(0.25, Math.sqrt(((x1 - x0) * (y1 - y0)) / 8000))
    for (let x = x0; x <= x1 + 1e-9; x += step) {
      for (let y = y0; y <= y1 + 1e-9; y += step) if (closer(x, y) && fits(a, x, y)) take(x, y)
    }
  }
  const found = held.best
  if (!found) return null
  // A position written to 0.01 mm sits in the area within the tolerance; round towards where the part was asked to be.
  return { x: Math.round(found.x * 100) / 100, y: Math.round(found.y * 100) / 100 }
}

/** The area names of a part, as a message lists them. */
export const areaNames = (areas: Zone[]): string => (areas.length === 1 ? areaName(areas[0]) : `${areaName(areas[0])} or ${areas.length - 1} more`)

