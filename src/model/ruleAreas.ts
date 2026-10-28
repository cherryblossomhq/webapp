import { schematicBounds, unitGroup } from "./instances"
import { findPart } from "./library"
import { polygonHitsBox } from "./polygonHits"
import { ROOT_SHEET, applySheetFlags, isHierarchical, sheetIdOf, sheetUses, withSheetFlags } from "./sheets"
import { activeVariant, markSettled, resolveVariant } from "./variants"
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
  /** The custom parts and the symbol drawings: which parts an area touches depends on how big their drawings are. */
  parts: Project["parts"]
  symbols: Project["symbols"]
  /** S9: the variants of the project and the one that is active, which the answer depends on. */
  variants: Project["variants"]
  active: string | undefined
  components: ComponentInstance[]
}
const resolved = new WeakMap<readonly ComponentInstance[], Resolved>()

/** The flags the areas set put on the parts that touch them, as an OR: a flag a part has stays. */
function orAreaFlags(project: Project, components: ComponentInstance[]): ComponentInstance[] {
  const taken = ruleAreaFlags(project)
  if (!taken.size) return components
  return components.map((c) => {
    const f = taken.get(c.id)
    if (!f || FLAGS.every((k) => !f[k] || c.flags?.[k])) return c
    return markSettled({ ...c, flags: { ...c.flags, ...f } })
  })
}

/**
 * The components of a project as KiCad 10 resolves them, in KiCad's order: the symbol's own flags with the active variant's changes (`resolveVariant`: its true or
 * false for each flag and its field overrides), then the flags of the sheet symbols above it (each use of a sheet asks its own variant, `variantSheetFlags`), then
 * the flags of the rule areas it touches (`ResolveDNP` and the others). The sheets' and the areas' flags are only ever put on (an OR): a variant that clears a
 * symbol's own flag does not clear one a sheet or an area sets. This is the one place the variant and the flags are applied: everything that reads on-board,
 * do-not-populate, in-BOM or left-out-of-simulation of a part (the BOM, the position file, the Gerber and drill files, the 3D view, the PCB editor, the checks,
 * the board and Circuit JSON exports, Sakura's tools) asks for the components here, not for `project.components`. A project with no variant active, no flagged
 * rule area and no flagged sheet symbol gets its own array back; otherwise the answer is kept for as long as the components, the drawings, the sheets and the
 * variants (and which one is active) stay the same objects, so a commit that touches none of them costs nothing and a switch of the active variant is never answered
 * with the flags of the last one.
 */
export function resolvedComponents(project: Project): ComponentInstance[] {
  const variant = activeVariant(project)
  const areas = hasFlaggedRuleAreas(project)
  const sheets = !!project.sheetSymbols?.some((x) => x.flags && Object.keys(x.flags).length)
  if (!areas && !sheets && variant === undefined) return project.components
  const hit = resolved.get(project.components)
  if (hit && hit.drawings === project.drawings && hit.sheetSymbols === project.sheetSymbols && hit.sheets === project.sheets && hit.parts === project.parts && hit.symbols === project.symbols && hit.variants === project.variants && hit.active === variant) return hit.components
  // The variant and the flags of the sheet symbols (everything on the sheets below them) first, then the areas'.
  const bySheets = applySheetFlags(resolveVariant(project), variant).components
  const components = areas ? orAreaFlags(project, bySheets) : bySheets
  resolved.set(project.components, { drawings: project.drawings, sheetSymbols: project.sheetSymbols, sheets: project.sheets, parts: project.parts, symbols: project.symbols, variants: project.variants, active: variant, components })
  return components
}

/**
 * The components as their own symbols have them under the active variant: the variant's changes and the flags of the rule areas they touch, and none a sheet
 * symbol gives (the flag of a sheet is on the sheet symbol, which KiCad applies to everything below it; the symbols of the sheet's file say only their own).
 * What a KiCad 9 sheet file says about its symbols.
 */
export function ownFlagComponents(project: Project): ComponentInstance[] {
  const bare = resolveVariant(project).components
  return hasFlaggedRuleAreas(project) ? orAreaFlags(project, bare) : bare
}

/** The project with only the rule areas' flags put on the symbols they touch: the variants and the sheet symbols' flags stay where they are (the KiCad 10 files, which write them). */
export function withRuleAreaFlagsOnly(project: Project): Project {
  if (!hasFlaggedRuleAreas(project)) return project
  const components = orAreaFlags(project, project.components)
  return components === project.components ? project : { ...project, components }
}

/** Where a part's resolved flags come from, for a tooltip: "rule area" or "sheet" for each of the four flags the part does not carry itself. */
export function flagOrigins(project: Project, c: ComponentInstance): Partial<Record<(typeof FLAGS)[number], "rule area" | "sheet">> {
  const out: Partial<Record<(typeof FLAGS)[number], "rule area" | "sheet">> = {}
  const own = c.flags
  const bySheet = withSheetFlags({ ...project, components: [c] }).components[0]
  const area = ruleAreaFlags(project).get(c.id)
  for (const k of FLAGS) {
    if (own?.[k]) continue
    if (bySheet.flags?.[k]) out[k] = "sheet"
    else if (area?.[k]) out[k] = "rule area"
  }
  return out
}

/** The project with `resolvedComponents` as its components; the project itself keeps the flags on the area only. */
export function withRuleAreaFlags(project: Project): Project {
  const components = resolvedComponents(project)
  return components === project.components ? project : { ...project, components }
}

/** The points of a rule area as a polygon. */
export const areaPolygon = (a: DrawingLine): Vec2[] => a.points
