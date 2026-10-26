import { schematicBounds, unitGroup } from "./instances"
import { findPart } from "./library"
import { polygonHitsBox } from "./polygonHits"
import { ROOT_SHEET, isHierarchical, sheetIdOf, sheetUses } from "./sheets"
import { componentFields, fieldBox } from "./symbolDrawing"
import type { Box } from "../lib/geometry"
import type { ComponentInstance, DrawingLine, PartFlags, Project, RuleAreaMark, SchematicDrawing, Vec2 } from "./types"

// S8: rule areas. A rule area is a closed polygon of a sheet (a `DrawingLine` that has `ruleArea`); KiCad 10 lets it say, for every symbol the
// polygon touches, that the symbol is not populated (`dnp`), is out of the BOM (`in_bom no`), is not on the board (`on_board no`) or is left out
// of simulation (`exclude_from_sim`), and `SCH_ITEM::ResolveDNP` and its siblings (eeschema/sch_item.cpp:374 to 457 of 10.0) are the symbol's own flag
// or any rule area's. A file written by KiCad 9 has no flag on a rule area (its parser reads nothing but the polyline: sch_io_kicad_sexpr_parser.cpp:4138
// of 9.0.0), and the flags came with file version 20250610 ("DNP, etc. flags for rule areas", sch_file_versions.h of 10.0.0), so the flags below are
// those of a file that has them and nothing is applied for a KiCad 9 one.
//
// Which symbols: those whose box (`SCH_SYMBOL::GetBoundingBox`: the body, the pins and every visible field) touches the polygon
// (`GetPolyShape().Collide( &SHAPE_RECT( box ) )`, sch_rule_area.cpp:271 of 10.0.0). KiCad 9.0.0 took every symbol whose box overlapped the area's bounding
// box (sch_rule_area.cpp:267 of 9.0.0), which mattered only for component classes, which the editor keeps and does not use.
//
// The flags belong to the part, not to one of its units (`PartFlags` is the part's set): a part with several units takes them when any of its units is inside.
// KiCad's netlist reads the one unit with the least uuid (netlist_exporter_xml.cpp:316 to 332), which the editor has no uuid to choose by.

const FLAGS = ["dnp", "excludeFromBom", "notOnBoard", "excludeFromSim"] as const

/** Whether a drawing is a rule area. */
/** A drawing that is a rule area: a closed line with its flags, on a sheet. */
export type RuleArea = DrawingLine & { sheet?: string; ruleArea: RuleAreaMark }

export const isRuleArea = (d: SchematicDrawing): d is RuleArea => d.type === "line" && !!d.ruleArea

/** Whether a rule area sets any flag. */
export const ruleAreaHasFlags = (a: RuleAreaMark) => FLAGS.some((k) => a[k])

const flagged = new WeakMap<readonly SchematicDrawing[], boolean>()
/** Whether the project has a rule area that sets a flag (cheap for a project that has none: the drawings are scanned once per list). */
export function hasFlaggedRuleAreas(project: Pick<Project, "drawings">): boolean {
  const list = project.drawings
  if (!list?.length) return false
  let hit = flagged.get(list)
  if (hit === undefined) {
    hit = list.some((d) => isRuleArea(d) && ruleAreaHasFlags(d.ruleArea))
    flagged.set(list, hit)
  }
  return hit
}

/** The box KiCad tests a symbol by: its body and pins as the editor draws them, and every field that is shown. */
export function symbolBox(c: ComponentInstance): Box {
  const part = findPart(c.partId)
  const b = { ...schematicBounds(c, part) }
  if (part) {
    for (const f of componentFields(c, part)) {
      const fb = fieldBox(c, f)
      b.minX = Math.min(b.minX, fb.minX)
      b.minY = Math.min(b.minY, fb.minY)
      b.maxX = Math.max(b.maxX, fb.maxX)
      b.maxY = Math.max(b.maxY, fb.maxY)
    }
  }
  return b
}

/** The flags each part of a project takes from the rule areas its symbols touch, by component id (every unit of a part has the entry). */
export function ruleAreaFlags(project: Project): Map<string, NonNullable<PartFlags>> {
  const out = new Map<string, NonNullable<PartFlags>>()
  if (!hasFlaggedRuleAreas(project)) return out
  const sheetOfUse = new Map(isHierarchical(project) ? sheetUses(project).map((u) => [u.path, u.sheet] as const) : [])
  const areas = (project.drawings ?? []).filter((d): d is RuleArea => isRuleArea(d) && ruleAreaHasFlags(d.ruleArea) && d.points.length >= 3)
  const bySheet = new Map<string, RuleArea[]>()
  for (const a of areas) (bySheet.get(sheetIdOf(a)) ?? bySheet.set(sheetIdOf(a), []).get(sheetIdOf(a))!).push(a)
  const taken = new Map<string, Set<(typeof FLAGS)[number]>>()
  for (const c of project.components) {
    const sheet = c.inst ? (sheetOfUse.get(c.inst) ?? ROOT_SHEET) : ROOT_SHEET
    const here = bySheet.get(sheet)
    if (!here) continue
    const part = findPart(c.partId)
    // A power port, a flag symbol and the editor's own symbols of no footprint are symbols too, and KiCad flags them like any other.
    if (!part) continue
    const box = symbolBox(c)
    for (const a of here) {
      if (!polygonHitsBox(a.points, box)) continue
      const set = taken.get(c.id) ?? taken.set(c.id, new Set()).get(c.id)!
      for (const k of FLAGS) if (a.ruleArea[k]) set.add(k)
    }
  }
  // Every unit of a part takes what any of its units took.
  const all = new Map<string, Set<(typeof FLAGS)[number]>>()
  for (const [id, set] of taken) {
    const c = project.components.find((x) => x.id === id)!
    for (const x of unitGroup(project, c)) {
      const into = all.get(x.id) ?? all.set(x.id, new Set()).get(x.id)!
      for (const k of set) into.add(k)
    }
  }
  for (const [id, set] of all) out.set(id, Object.fromEntries([...set].map((k) => [k, true as const])) as PartFlags)
  return out
}

/**
 * The project with the flags of rule areas put on the symbols they touch, as KiCad 10 resolves them (`ResolveDNP` and the others): a symbol's own
 * flag or any area's. The project itself keeps the flags on the area only; a project with no flagged rule area is returned as it is. The BOM, the
 * position file, the exports and the board read this.
 */
export function withRuleAreaFlags(project: Project): Project {
  const taken = ruleAreaFlags(project)
  if (!taken.size) return project
  let changed = false
  const components = project.components.map((c) => {
    const f = taken.get(c.id)
    if (!f) return c
    if (FLAGS.every((k) => !f[k] || c.flags?.[k])) return c
    changed = true
    return { ...c, flags: { ...c.flags, ...f } }
  })
  return changed ? { ...project, components } : project
}

/** The points of a rule area as a polygon. */
export const areaPolygon = (a: DrawingLine): Vec2[] => a.points
