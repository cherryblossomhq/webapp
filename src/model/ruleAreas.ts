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

/** The flags each symbol takes from the rule areas it touches itself, by component id (a unit that touches none has no entry). */
function unitFlags(project: Project): Map<string, Set<(typeof FLAGS)[number]>> {
  if (!hasFlaggedRuleAreas(project)) return new Map()
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
  return taken
}

/**
 * The parts that have several units where the units do not take the same flags from the areas, by reference. KiCad's netlist reads the one unit with
 * the least uuid (netlist_exporter_xml.cpp:316 to 332), which the editor has no uuid to choose by, so it gives the part the flags of any unit that is
 * in an area; when the units disagree, which way KiCad goes cannot be said, and an import reports it.
 */
export function ruleAreaUnitSplits(project: Project): string[] {
  const taken = unitFlags(project)
  if (!taken.size) return []
  const refs = new Set<string>()
  const byRef = new Map<string, ComponentInstance[]>()
  for (const c of project.components) if (taken.has(c.id)) (byRef.get(c.ref) ?? byRef.set(c.ref, []).get(c.ref)!).push(c)
  for (const [ref, touched] of byRef) {
    const units = unitGroup(project, touched[0])
    if (units.length < 2) continue
    const key = (id: string) => [...(taken.get(id) ?? [])].sort().join(",")
    if (units.some((u) => key(u.id) !== key(units[0].id))) refs.add(ref)
  }
  return [...refs]
}

/** Says in an import report which multi-unit parts have units that disagree about the flags of the rule areas (said once for a part). */
export function reportRuleAreaUnits(project: Project, report: { entries: { code: string; severity: string; object: string; why: string; count?: number }[] }): void {
  for (const ref of ruleAreaUnitSplits(project)) {
    const object = `the part ${ref}`
    if (report.entries.some((x) => x.code === "rule-area-units" && x.object === object)) continue
    report.entries.push({
      code: "rule-area-units",
      severity: "changed",
      object,
      why: "Some of this part's units are inside a rule area that sets do not populate, not in the BOM, not on the board or not simulated, and others are not. KiCad takes the flags of the unit with the least uuid, which the editor cannot choose by: it gives the part the flags of every unit that is inside an area, so the part may be flagged here where KiCad does not flag it.",
    })
  }
}

/** The flags each part of a project takes from the rule areas its symbols touch, by component id (every unit of a part has the entry). */
export function ruleAreaFlags(project: Project): Map<string, NonNullable<PartFlags>> {
  const out = new Map<string, NonNullable<PartFlags>>()
  const taken = unitFlags(project)
  if (!taken.size) return out
  // Every unit of a part takes what any of its units took.
  const all = new Map<string, Set<(typeof FLAGS)[number]>>()
  const byId = new Map(project.components.map((x) => [x.id, x] as const))
  for (const [id, set] of taken) {
    const c = byId.get(id)!
    for (const x of unitGroup(project, c)) {
      const into = all.get(x.id) ?? all.set(x.id, new Set()).get(x.id)!
      for (const k of set) into.add(k)
    }
  }
  for (const [id, set] of all) out.set(id, Object.fromEntries([...set].map((k) => [k, true as const])) as PartFlags)
  return out
}

interface Resolved {
  drawings: Project["drawings"]
  sheetSymbols: Project["sheetSymbols"]
  sheets: Project["sheets"]
  components: ComponentInstance[]
}
const resolved = new WeakMap<readonly ComponentInstance[], Resolved>()

/**
 * The components of a project with the flags of rule areas put on the symbols they touch, as KiCad 10 resolves them (`ResolveDNP` and the others):
 * a symbol's own flag or any area's. This is the one place the area flags are applied: everything that reads on-board, do-not-populate, in-BOM or
 * left-out-of-simulation of a part (the BOM, the position file, the Gerber and drill files, the 3D view, the PCB editor, the checks, the board and
 * Circuit JSON exports, Sakura's tools) asks for the components here, not for `project.components`. A project with no flagged rule area gets its own
 * array back; otherwise the answer is kept for as long as the components, the drawings and the sheets stay the same objects, so a commit that
 * touches none of them costs nothing and one that does costs one pass over the symbols that sit on a sheet with a flagged area.
 */
export function resolvedComponents(project: Project): ComponentInstance[] {
  if (!hasFlaggedRuleAreas(project)) return project.components
  const hit = resolved.get(project.components)
  if (hit && hit.drawings === project.drawings && hit.sheetSymbols === project.sheetSymbols && hit.sheets === project.sheets) return hit.components
  const taken = ruleAreaFlags(project)
  let components = project.components
  if (taken.size) {
    components = project.components.map((c) => {
      const f = taken.get(c.id)
      if (!f || FLAGS.every((k) => !f[k] || c.flags?.[k])) return c
      return { ...c, flags: { ...c.flags, ...f } }
    })
  }
  resolved.set(project.components, { drawings: project.drawings, sheetSymbols: project.sheetSymbols, sheets: project.sheets, components })
  return components
}

/** The project with `resolvedComponents` as its components; the project itself keeps the flags on the area only. */
export function withRuleAreaFlags(project: Project): Project {
  const components = resolvedComponents(project)
  return components === project.components ? project : { ...project, components }
}

/** The points of a rule area as a polygon. */
export const areaPolygon = (a: DrawingLine): Vec2[] => a.points
