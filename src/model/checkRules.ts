import type { KicadChecks, KicadSeverity, Project } from "./types"

export type { KicadChecks, KicadSeverity }

// What the checks of a project brought in from KiCad say, and how severely. Such a project is the user's KiCad design, and
// Checks should say what KiCad's own DRC and ERC say about it, at the severities the project file sets: a check the editor
// has and KiCad does not (a via in a pad, a part past the outline, a decoupling capacitor's distance, an LED with no
// resistor, a two-pin part on one net) is the editor's opinion of someone else's design and is not run there, and a check
// both have takes the project's own severity for KiCad's rule, `ignore` hiding it. A project drawn here keeps every check at
// the editor's own severity.

/** A project made from the user's KiCad files: the import keeps what it carries (`Project.kicad`), names the file's version and names its nets KiCad's way. */
export const fromKicad = (p: Pick<Project, "kicad" | "properties" | "netNames">): boolean =>
  !!p.kicad || p.netNames !== undefined || !!p.properties?.some((x) => x.key === "KiCad file version")

/**
 * KiCad's default severity of each of its rules the editor has a check for (`BOARD_DESIGN_SETTINGS` and `ERC_SETTINGS`, 10.0): every
 * rule is an error but these, which are warnings. A project file that names a rule overrides it.
 */
const DRC_DEFAULT: Record<string, KicadSeverity> = {
  clearance: "error",
  hole_clearance: "error",
  shorting_items: "error",
  unconnected_items: "error",
  courtyards_overlap: "error",
  track_width: "error",
  drill_out_of_range: "error",
  microvia_drill_out_of_range: "error",
  via_diameter: "error",
  annular_width: "error",
  // `DRCE_DRILLED_HOLES_TOO_CLOSE`, a warning since KiCad 8 renamed it from `hole_near_hole`.
  hole_to_hole: "warning",
  copper_edge_clearance: "error",
  solder_mask_bridge: "error",
  invalid_outline: "error",
  items_not_allowed: "error",
  length_out_of_range: "error",
  track_dangling: "warning",
  via_dangling: "warning",
}

const ERC_DEFAULT: Record<string, KicadSeverity> = {
  pin_not_connected: "error",
  // A pin pair's own level is the pin table's; the rule's severity only says whether it is checked (`ERC_SETTINGS::GetSeverity`).
  pin_to_pin: "warning",
  multiple_net_names: "warning",
  isolated_pin_label: "warning",
  missing_unit: "warning",
  no_connect_dangling: "warning",
  hier_label_mismatch: "error",
  net_not_bus_member: "warning",
}

/** The KiCad rules the editor maps, by KiCad's name: what the import keeps of a project file. */
export const MAPPED_DRC_RULES = Object.keys(DRC_DEFAULT)
export const MAPPED_ERC_RULES = Object.keys(ERC_DEFAULT)

/** KiCad's rule for each of the editor's board checks it has one for. A check with none on a KiCad project is run only if it is not one of `EDITOR_ONLY_DRC`. */
export const DRC_RULE: Readonly<Record<string, string>> = {
  short: "shorting_items",
  clearance: "clearance",
  unrouted: "unconnected_items",
  overlap: "courtyards_overlap",
  "trace-width": "track_width",
  drill: "drill_out_of_range",
  "annular-ring": "annular_width",
  "via-size": "via_diameter",
  "hole-clearance": "hole_to_hole",
  "edge-clearance": "copper_edge_clearance",
  outline: "invalid_outline",
  "mask-bridge": "solder_mask_bridge",
  "floating-copper": "track_dangling",
  length: "length_out_of_range",
  keepout: "items_not_allowed",
}

/** KiCad's rule for each electrical check it has one for; `unconnected-pin` is the connectivity's own list of pins left open. */
export const ERC_RULE: Readonly<Record<string, string>> = {
  "unconnected-pin": "pin_not_connected",
  "sheet-pin-unconnected": "pin_not_connected",
  "lone-label": "isolated_pin_label",
  "missing-unit": "missing_unit",
  "pin-conflict": "pin_to_pin",
  "stray-no-connect": "no_connect_dangling",
  "sheet-pin-no-label": "hier_label_mismatch",
  "label-no-sheet-pin": "hier_label_mismatch",
  "net-not-bus-member": "net_not_bus_member",
  "net-names": "multiple_net_names",
}

/** The editor's own checks KiCad has no rule for, left out on a project from KiCad: a via in an SMD pad, a part's courtyard past the outline, a decoupling capacitor's distance. */
export const EDITOR_ONLY_DRC: ReadonlySet<string> = new Set(["via-in-pad", "outside-board", "decoupling"])
/** An LED with no resistor and a two-pin part with both pins on one net: KiCad's ERC has neither. */
export const EDITOR_ONLY_ERC: ReadonlySet<string> = new Set(["bare-led", "shorted"])

const SEVERITIES = new Set<string>(["error", "warning", "ignore"])
const rowOk = (r: unknown) => typeof r === "string" && /^[012]{12}$/.test(r)

/** The kept settings, read defensively: the field is stored as the import wrote it, and a damaged file must not break Checks. */
function kept(p: Pick<Project, "kicad">): KicadChecks {
  const raw = (p.kicad as { checks?: unknown } | undefined)?.checks
  if (!raw || typeof raw !== "object") return {}
  const map = (m: unknown) => (m && typeof m === "object" ? Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "string" && SEVERITIES.has(v))) : undefined) as Record<string, KicadSeverity> | undefined
  const r = raw as { drc?: unknown; erc?: unknown; pinMap?: unknown; holeClearance?: unknown; noMinimum?: unknown }
  const none = Array.isArray(r.noMinimum) ? r.noMinimum.filter((x): x is "minTraceWidth" | "minDrill" => x === "minTraceWidth" || x === "minDrill") : []
  return {
    ...(none.length ? { noMinimum: none } : {}),
    drc: map(r.drc),
    erc: map(r.erc),
    ...(Array.isArray(r.pinMap) && r.pinMap.length === 12 && r.pinMap.every(rowOk) ? { pinMap: r.pinMap as string[] } : {}),
    ...(typeof r.holeClearance === "number" && Number.isFinite(r.holeClearance) && r.holeClearance >= 0 ? { holeClearance: r.holeClearance } : {}),
  }
}

/** The severity a KiCad project gives one of KiCad's DRC rules: the file's, else KiCad's default. */
export const drcSeverity = (p: Pick<Project, "kicad">, rule: string): KicadSeverity => kept(p).drc?.[rule] ?? DRC_DEFAULT[rule] ?? "error"
/** The severity a KiCad project gives one of KiCad's ERC rules: the file's, else KiCad's default. */
export const ercSeverity = (p: Pick<Project, "kicad">, rule: string): KicadSeverity => kept(p).erc?.[rule] ?? ERC_DEFAULT[rule] ?? "error"

/**
 * How severe a board check is on this project, or null when it is not reported: the editor's own severity on a project drawn here;
 * on one from KiCad, the project's severity for KiCad's rule (`rule` names it where one check of the editor is several of KiCad's,
 * a hole's clearance or a dangling via), nothing for a check KiCad does not have, and the editor's own for one KiCad's rules do not name.
 */
export function boardCheckSeverity(p: Pick<Project, "kicad" | "properties" | "netNames">, kind: string, own: "error" | "warning", rule?: string): "error" | "warning" | null {
  if (!fromKicad(p)) return own
  if (EDITOR_ONLY_DRC.has(kind)) return null
  const name = rule ?? DRC_RULE[kind]
  if (!name) return own
  const s = drcSeverity(p, name)
  return s === "ignore" ? null : s
}

/**
 * The same for an electrical check, whose own severity is a warning; `level` is a pin pair's level by the pin table, which the rule only turns off, and
 * `rule` KiCad's rule where it is not the kind's.
 */
export function ercCheckSeverity(p: Pick<Project, "kicad" | "properties" | "netNames">, kind: string, level?: "error" | "warning", rule?: string): "error" | "warning" | null {
  if (!fromKicad(p)) return "warning"
  if (EDITOR_ONLY_ERC.has(kind)) return null
  const name = rule ?? ERC_RULE[kind]
  if (!name) return "warning"
  const s = ercSeverity(p, name)
  if (s === "ignore") return null
  return level ?? s
}

/** How severe a pin left unconnected is (the connectivity's list, which KiCad's `pin_not_connected` is): a warning here, the project's severity on one from KiCad, null when it ignores the rule. */
export const unconnectedPinSeverity = (p: Pick<Project, "kicad" | "properties" | "netNames">): "error" | "warning" | null => ercCheckSeverity(p, "unconnected-pin")

/**
 * Whether a project from KiCad has no minimum for a rule: its file set it to 0 (none, in KiCad), which the editor's rule could not hold, and the rule is still
 * the one the import left (`KicadCarry.proRules`); a rule the user set since is checked.
 */
export const noKicadMinimum = (p: Pick<Project, "kicad" | "rules">, field: "minTraceWidth" | "minDrill"): boolean =>
  !!kept(p).noMinimum?.includes(field) && p.kicad?.proRules?.[field] === p.rules[field]

/** KiCad's least distance from a hole to copper of another net on a project from KiCad: the project's, else KiCad's default (`min_hole_clearance`, 0.25 mm). */
export const kicadHoleClearance = (p: Pick<Project, "kicad">): number => kept(p).holeClearance ?? 0.25

/** The project's own table of pin types that may share a net, as `pinPairLevel` reads it, when it has one. */
export const keptPinMap = (p: Pick<Project, "kicad">): string[] | undefined => kept(p).pinMap

/** KiCad's default table (`ERC_SETTINGS::m_defaultPinMap`) as the file writes it, so a file that keeps it is not stored again. */
export const DEFAULT_PIN_MAP = ["000000100002", "020100102222", "000000101012", "010000112112", "000000100002", "000000000002", "111110111112", "000100100002", "021200102222", "020100102002", "021100102002", "222222222222"]

/**
 * What a project file sets for the checks (`.kicad_pro`'s JSON): the severities of the mapped rules it names, its pin table when it
 * is not KiCad's default, and its least hole to copper distance. `hole_near_hole` is KiCad 7's name for `hole_to_hole`, which wins when a file has both, as KiCad 10 reads them.
 */
export function kicadChecksOf(json: Record<string, unknown>): KicadChecks | null {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const pick = (m: Record<string, unknown>, names: string[]) => {
    const out: Record<string, KicadSeverity> = {}
    for (const n of names) if (typeof m[n] === "string" && SEVERITIES.has(m[n] as string)) out[n] = m[n] as KicadSeverity
    return out
  }
  const drcRaw = obj(obj(obj(json.board).design_settings).rule_severities)
  const drc = pick(drcRaw, MAPPED_DRC_RULES)
  if (!drc.hole_to_hole && typeof drcRaw.hole_near_hole === "string" && SEVERITIES.has(drcRaw.hole_near_hole)) drc.hole_to_hole = drcRaw.hole_near_hole as KicadSeverity
  const erc = pick(obj(obj(json.erc).rule_severities), MAPPED_ERC_RULES)
  const rows = obj(json.erc).pin_map
  let pinMap: string[] | undefined
  if (Array.isArray(rows) && rows.length === 12 && rows.every((r) => Array.isArray(r) && r.length === 12 && r.every((v) => v === 0 || v === 1 || v === 2 || v === 3))) {
    // KiCad's `UNCONNECTED` (3) is no level of a pair: it is read as fine.
    const read = rows.map((r) => (r as number[]).map((v) => (v === 3 ? 0 : v)).join(""))
    if (read.some((r, i) => r !== DEFAULT_PIN_MAP[i])) pinMap = read
  }
  const rules = obj(obj(obj(json.board).design_settings).rules)
  const hole = rules.min_hole_clearance
  const holeClearance = typeof hole === "number" && Number.isFinite(hole) && hole >= 0 ? hole : undefined
  const noMinimum = (
    [
      ["min_track_width", "minTraceWidth"],
      ["min_through_hole_diameter", "minDrill"],
    ] as const
  ).flatMap(([key, field]) => (rules[key] === 0 ? [field] : []))
  const out: KicadChecks = {
    ...(Object.keys(drc).length ? { drc } : {}),
    ...(Object.keys(erc).length ? { erc } : {}),
    ...(pinMap ? { pinMap } : {}),
    ...(holeClearance !== undefined ? { holeClearance } : {}),
    ...(noMinimum.length ? { noMinimum } : {}),
  }
  return Object.keys(out).length ? out : null
}
