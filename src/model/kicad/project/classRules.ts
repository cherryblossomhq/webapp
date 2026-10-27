import type { ComponentInstance } from "../../types"
import type { ReportEntry } from "../board/report"
import type { KicadPro } from "./pro"

// X20: the component class assignment rules of a project file (`component_class_settings` of the `.kicad_pro`). KiCad turns each into a DRC condition
// (`COMPONENT_CLASS_ASSIGNMENT_DATA::GetAssignmentInDRCLanguage`, common/project/component_class_settings.cpp of 10.0.0) and gives every footprint it holds the class,
// on top of the classes the board file lists (KiCad 10's file lists only those set from the schematic; KiCad 9's lists the effective ones, rule results too).
//
// What is worked out here is what the condition says without any doubt: a reference (one, or a list separated by commas), a footprint's library link, a side. A rule
// with a wildcard in a reference or a footprint (the engine's `==` matches `?` and `*`), a rotation, a footprint field, a sheet or a custom expression is not worked
// out, and each one is a report entry: the parts it would give the class keep the classes the board file lists, and no part is given a class by a guess.

interface Condition {
  type: string
  primary: string
  secondary: string
}

interface Assignment {
  className: string
  /** `ANY`: one condition is enough; else all of them (KiCad's default is the file's word, and a missing one is "any"). */
  any: boolean
  conditions: Condition[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The assignment rules of the project file, as it lists them (`assignments`), and whether it asks for a class for every sheet. */
export function readClassRules(pro: Pick<KicadPro, "json"> | null): { rules: Assignment[]; sheetClasses: boolean } {
  const settings = pro?.json.component_class_settings
  if (!isObject(settings)) return { rules: [], sheetClasses: false }
  const rules: Assignment[] = []
  for (const a of Array.isArray(settings.assignments) ? settings.assignments : []) {
    if (!isObject(a) || typeof a.component_class !== "string") continue
    const conditions: Condition[] = []
    if (isObject(a.conditions)) {
      for (const [key, c] of Object.entries(a.conditions)) {
        // KiCad names a second condition of one kind `REFERENCE-1`: the kind is what comes before the dash.
        const type = key.split("-")[0]
        const data = isObject(c) ? c : {}
        conditions.push({ type, primary: typeof data.primary === "string" ? data.primary : "", secondary: typeof data.secondary === "string" ? data.secondary : "" })
      }
    }
    rules.push({ className: a.component_class, any: a.conditions_operator !== "ALL", conditions })
  }
  const sheets = settings.sheet_component_classes
  return { rules, sheetClasses: isObject(sheets) && sheets.enabled === true }
}

const WILDCARD = /[?*]/

/** What a condition holds, or the words for why it cannot be worked out here. A condition KiCad leaves out (nothing to compare, a side of `Any`) is `null`: it counts for nothing. */
function conditionOf(c: Condition): ((p: ComponentInstance) => boolean) | null | string {
  const primary = c.primary.trim()
  switch (c.type) {
    case "REFERENCE": {
      const refs = primary.split(",").map((r) => r.trim())
      if (!primary) return null
      if (refs.some((r) => WILDCARD.test(r))) return "a wildcard in a reference"
      return (p) => refs.includes(p.ref)
    }
    case "FOOTPRINT":
      if (!primary) return null
      if (WILDCARD.test(primary)) return "a wildcard in a footprint"
      return (p) => p.fpid === primary
    case "SIDE":
      if (primary === "Any" || primary === "") return null
      return (p) => p.pcb.side === (primary === "Front" ? "top" : "bottom")
    case "ROTATION":
      return primary === "" || primary === "Any" ? null : "a rotation"
    case "FOOTPRINT_FIELD":
      return primary === "" || c.secondary.trim() === "" ? null : "a footprint field"
    case "SHEET_NAME":
      return primary === "" ? null : "a sheet name"
    case "CUSTOM":
      return primary === "" ? null : "a custom expression"
    default:
      return `a condition of kind ${c.type}`
  }
}

export interface ClassRulesResult {
  components: ComponentInstance[]
  entries: ReportEntry[]
}

/** The parts of the board given the classes the project file's rules say, and the report of what was and was not worked out. Nothing changes for a project file with none. */
export function applyClassRules(pro: Pick<KicadPro, "json"> | null, components: ComponentInstance[]): ClassRulesResult {
  const { rules, sheetClasses } = readClassRules(pro)
  const entries: ReportEntry[] = []
  if (!rules.length && !sheetClasses) return { components, entries }
  const given = new Map<string, string[]>()
  const parts = components.filter((c) => c.footprint !== "" && c.pcb.placed)
  let worked = 0
  for (const rule of rules) {
    // KiCad ignores a rule with no class name.
    if (!rule.className) continue
    const tests = rule.conditions.map(conditionOf)
    const why = tests.find((t): t is string => typeof t === "string")
    if (why !== undefined) {
      entries.push({
        code: "component-class-rule-not-worked-out",
        severity: "not-brought",
        object: `the component class rule for ${rule.className}`,
        why: `It uses ${why}, which the importer does not work out. The parts it would give the class keep the classes the board file lists.`,
      })
      continue
    }
    const live = tests.filter((t): t is (p: ComponentInstance) => boolean => typeof t === "function")
    worked++
    for (const p of parts) {
      const hit = live.length === 0 || (rule.any ? live.some((t) => t(p)) : live.every((t) => t(p)))
      if (hit) given.set(p.id, [...(given.get(p.id) ?? []), rule.className])
    }
  }
  if (sheetClasses) {
    entries.push({
      code: "component-class-rule-not-worked-out",
      severity: "not-brought",
      object: "the class of each sheet",
      why: "The project file asks KiCad to give the parts of each sheet a class named for the sheet, which the importer does not work out. The parts keep the classes the board file lists.",
    })
  }
  if (worked) {
    const count = given.size
    entries.push({ code: "component-class-rules", severity: "note", object: "the component class rules", why: `${worked} class rule${worked === 1 ? "" : "s"} of the project file ${worked === 1 ? "was" : "were"} worked out as KiCad does, and ${count} part${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} a class from ${worked === 1 ? "it" : "them"}.`, count })
  }
  if (!given.size) return { components, entries }
  return {
    components: components.map((c) => {
      const add = given.get(c.id)
      if (!add) return c
      const classes = [...new Set([...(c.classes ?? []), ...add])]
      return classes.length === (c.classes?.length ?? 0) ? c : { ...c, classes }
    }),
    entries,
  }
}
