import { mapKicadProjectNetClasses, type KicadProjectNetClass } from "../../netClasses"
import type { DesignRules, DiffPairSize, Project, ViaSize } from "../../types"
import type { ImportReport } from "../board/report"
import type { KicadBoard } from "../board/types"
import { KICAD_MAX_ERROR } from "../board/netClassImport"
import type { KicadPro } from "./pro"
import { isObject } from "../../../lib/guards"

// X10 from the project file side: the net classes, their nets and patterns, and the board's design rules of a KiCad 6 or later
// `.kicad_pro`, written into `Project.rules` the way a KiCad 4 or 5 board's own classes are (`board/netClassImport.ts`).
//
//   net_settings.classes             the Default class is the rules' clearance, track width, via size and drill (and `defaultClass` for
//                                    what else it says); every other class is a `NetClass`, in priority order (`mapKicadProjectNetClasses`)
//   net_settings.netclass_assignments, netclass_patterns   the nets and patterns of each class
//   board.design_settings.rules      min_clearance, min_track_width, min_through_hole_diameter, min_via_diameter, min_via_annular_width,
//                                    min_hole_to_hole, min_copper_edge_clearance, max_error; the micro via minimums on a board that has micro vias
//   board.design_settings.track_widths, via_dimensions, diff_pair_dimensions   the sizes offered while routing (KiCad keeps them at the
//                                    top of design_settings; our own exporter and some writers put them under `defaults`)
//
// What the project file says that the editor has no field for (`min_hole_clearance`, the silk and text minimums, ...) is listed in one
// note by `lostRuleSettings`, not dropped quietly. `.kicad_dru` custom rules are not applied (the editor has no rule language): the
// project import says so in a note of their own.

/** The keys of `board.design_settings.rules` that are carried into `DesignRules` (the rows of `PRO_RULES` that say "used" name the same). */
export const CARRIED_RULE_KEYS = ["min_clearance", "min_track_width", "min_through_hole_diameter", "min_via_diameter", "min_via_annular_width", "min_hole_to_hole", "min_copper_edge_clearance", "max_error", "min_microvia_diameter", "min_microvia_drill", "allow_microvias", "allow_blind_buried_vias"] as const

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0
const nonNegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0

interface ProRulesResult {
  project: Project
  /** What the project file says that could not be kept exactly (a class two others share a net with, a pattern naming a class the file lacks); empty when nothing was lost. */
  problems: string[]
}

/**
 * The project with the rules of its `.kicad_pro` set. `labelText` maps a net's raw name in the board to the label it has in the project;
 * a class lists nets by the project's label. Nothing is changed when the file says nothing the project has not got already.
 */
export function applyProRules(project: Project, pro: KicadPro, board: KicadBoard, labelText: Map<string, string>, report: ImportReport): ProRulesResult {
  const rules: DesignRules = { ...project.rules }
  const said: string[] = []
  const settings = isObject(pro.json.board) && isObject((pro.json.board as Record<string, unknown>).design_settings) ? ((pro.json.board as Record<string, unknown>).design_settings as Record<string, unknown>) : {}

  // ---- net classes ----
  let problems: string[] = []
  const classes: KicadProjectNetClass[] = pro.netClasses.map((c) => ({ ...(c.json as object), name: c.name }) as KicadProjectNetClass)
  // A board that carries classes of its own (a KiCad 5 board under a KiCad 6 project file) has already put them in the rules.
  if (classes.length && !board.netClasses.length) {
    const assignments: Record<string, string | string[] | null> = {}
    for (const [net, cls] of Object.entries(pro.netclassAssignments)) assignments[labelText.get(net) ?? net] = (cls as string | string[] | null) ?? null
    const mapped = mapKicadProjectNetClasses({ classes, patterns: pro.netclassPatterns, assignments }, rules, labelText.values())
    problems = mapped.problems
    if (!problems.length && mapped.notes.length) {
      report.entries.push({ code: "net-classes-as-kicad", severity: "note", object: "the net classes", why: `Held as KiCad resolves them: ${mapped.notes.join("; ")}.` })
    }
    if (!problems.length) {
      const m = mapped.rules
      const before = { clearance: rules.clearance, traceWidth: rules.traceWidth, viaDiameter: rules.viaDiameter, viaDrill: rules.viaDrill }
      rules.clearance = m.clearance
      rules.traceWidth = m.traceWidth
      rules.viaDiameter = m.viaDiameter
      rules.viaDrill = m.viaDrill
      if (m.defaultClass) rules.defaultClass = m.defaultClass
      if (m.netClasses?.length) rules.netClasses = m.netClasses
      const def = classes.find((c) => c.name === "Default")
      if (def && (before.clearance !== m.clearance || before.traceWidth !== m.traceWidth || before.viaDiameter !== m.viaDiameter || before.viaDrill !== m.viaDrill)) {
        said.push(`the Default net class: clearance ${m.clearance} mm, track ${m.traceWidth} mm, via ${m.viaDiameter}/${m.viaDrill} mm`)
      }
      if (m.netClasses?.length) {
        const nets = m.netClasses.reduce((n, c) => n + c.nets.length, 0)
        const patterns = m.netClasses.reduce((n, c) => n + (c.patterns?.length ?? 0), 0)
        const parts = [nets ? `${nets} listed net${nets === 1 ? "" : "s"}` : "", patterns ? `${patterns} pattern${patterns === 1 ? "" : "s"}` : ""].filter(Boolean)
        said.push(`${m.netClasses.length} more net class${m.netClasses.length > 1 ? "es" : ""} (${m.netClasses.slice(0, 3).map((c) => c.name).join(", ")}${m.netClasses.length > 3 ? ", ..." : ""})${parts.length ? ` with ${parts.join(" and ")}` : ""}`)
      }
    }
  }

  // ---- the board's design rules ----
  const r = isObject(settings.rules) ? settings.rules : {}
  const carried: string[] = []
  const take = (key: string, field: "minClearance" | "minTraceWidth" | "minDrill" | "minViaDiameter" | "minAnnularRing" | "holeClearance" | "edgeClearance", ok: (n: unknown) => n is number, label: string) => {
    const v = r[key]
    if (ok(v) && rules[field] !== v) {
      rules[field] = v
      carried.push(`${label} ${v} mm`)
    }
  }
  take("min_clearance", "minClearance", positive, "smallest clearance")
  take("min_track_width", "minTraceWidth", positive, "smallest track")
  take("min_through_hole_diameter", "minDrill", positive, "smallest drill")
  take("min_via_diameter", "minViaDiameter", positive, "smallest via")
  take("min_via_annular_width", "minAnnularRing", nonNegative, "smallest annular ring")
  take("min_hole_to_hole", "holeClearance", nonNegative, "hole to hole")
  take("min_copper_edge_clearance", "edgeClearance", nonNegative, "copper to board edge")
  if (positive(r.max_error) && Math.abs(r.max_error - KICAD_MAX_ERROR) > 1e-12 && rules.maxError !== r.max_error) {
    rules.maxError = r.max_error
    carried.push(`curve error ${r.max_error} mm`)
  }
  // Micro and blind vias: the numbers say nothing on a board with only through vias.
  if (board.vias.some((v) => v.kind !== "through")) {
    if (positive(r.min_microvia_diameter) && positive(r.min_microvia_drill)) rules.minMicroVia = { diameter: r.min_microvia_diameter, drill: r.min_microvia_drill }
    if (typeof r.allow_microvias === "boolean") rules.microViasAllowed = r.allow_microvias
    if (typeof r.allow_blind_buried_vias === "boolean") rules.blindBuriedViasAllowed = r.allow_blind_buried_vias
  }
  if (carried.length) said.push(`the board's rules: ${carried.join(", ")}`)

  // ---- sizes offered while routing ----
  const defaults = isObject(settings.defaults) ? settings.defaults : {}
  const listOf = (name: string): unknown[] => (Array.isArray(settings[name]) ? (settings[name] as unknown[]) : Array.isArray(defaults[name]) ? (defaults[name] as unknown[]) : [])
  const widths = listOf("track_widths").filter(positive)
  if (widths.length) {
    const next = [...new Set([rules.traceWidth, ...widths])].sort((a, b) => a - b)
    if (JSON.stringify(next) !== JSON.stringify(rules.preferredWidths)) {
      rules.preferredWidths = next
      said.push(`${widths.length} track width${widths.length > 1 ? "s" : ""} offered while routing`)
    }
  }
  const vias: ViaSize[] = []
  for (const v of listOf("via_dimensions")) {
    if (!isObject(v) || !positive(v.diameter) || !positive(v.drill)) continue
    if ((v.diameter === rules.viaDiameter && v.drill === rules.viaDrill) || vias.some((x) => x.diameter === v.diameter && x.drill === v.drill)) continue
    vias.push({ diameter: v.diameter, drill: v.drill })
  }
  if (vias.length) {
    rules.viaSizes = vias
    said.push(`${vias.length} via size${vias.length > 1 ? "s" : ""} offered while routing`)
  }
  const pairs: DiffPairSize[] = []
  for (const d of listOf("diff_pair_dimensions")) {
    if (!isObject(d) || !positive(d.width) || !positive(d.gap)) continue
    const viaGap = positive(d.via_gap) ? d.via_gap : undefined
    if (!pairs.some((x) => x.width === d.width && x.gap === d.gap && x.viaGap === viaGap)) pairs.push({ width: d.width, gap: d.gap, ...(viaGap !== undefined ? { viaGap } : {}) })
  }
  if (pairs.length) {
    rules.diffPairSizes = pairs
    said.push(`${pairs.length} differential pair size${pairs.length > 1 ? "s" : ""} offered while routing`)
  }

  if (said.length) {
    report.entries.push({
      code: "rules-from-project-file",
      severity: "note",
      object: "the design rules",
      why: `Brought in from the project file (.kicad_pro): ${said.join("; ")}.`,
    })
  }
  return { project: JSON.stringify(rules) === JSON.stringify(project.rules) ? project : { ...project, rules }, problems }
}

/** The keys of `design_settings` that the project file sets and the editor has no field for, each as a sentence; they differ from KiCad's own value. */
export function lostRuleSettings(pro: KicadPro): string[] {
  const design = isObject(pro.json.board) ? (pro.json.board as Record<string, unknown>).design_settings : undefined
  const r = isObject(design) && isObject(design.rules) ? design.rules : {}
  const carried = new Set<string>(CARRIED_RULE_KEYS)
  // KiCad's own value of each: a project file at the value says nothing more.
  const kicad: Record<string, number | boolean> = {
    min_connection: 0,
    min_groove_width: 0,
    min_hole_clearance: 0.25,
    min_resolved_spokes: 2,
    min_silk_clearance: 0,
    min_text_height: 0.8,
    min_text_thickness: 0.08,
    solder_mask_to_copper_clearance: 0,
    solder_mask_min_width: 0,
    solder_paste_clearance: 0,
    solder_paste_margin_ratio: 0,
    use_height_for_length_calcs: true,
  }
  const out: string[] = []
  for (const [k, v] of Object.entries(r)) {
    if (carried.has(k)) continue
    if (k in kicad && typeof v === typeof kicad[k] && (typeof v === "number" ? Math.abs((v as number) - (kicad[k] as number)) < 1e-6 : v === kicad[k])) continue
    out.push(`${k} ${JSON.stringify(v)}`)
  }
  return out
}
