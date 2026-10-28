import { newAccount } from "../schematic/account"
import type { ImportReport, NodeAccount } from "../board/report"
import { decodeBytes } from "../board/sexpr"

// The project file (`.kicad_pro`, JSON, KiCad 6 and later): the net classes and their assignments,
// the design rules, the text variables and the many settings KiCad keeps beside a design. It is read
// into a typed object that keeps the whole JSON, and every key of it is accounted for by a row of
// the table below: imported, not needed with its reason, or pending an extension. Net classes and
// rules are not mapped into the editor's model from here (X10), so they are pending and never
// dropped; a key that no row covers is unknown, and the project is refused.

export class KicadProjectFileError extends Error {
  constructor(
    readonly code: "empty" | "not-json" | "not-an-object",
    message: string,
  ) {
    super(message)
  }
}

export interface KicadNetClass {
  name: string
  /** KiCad 6 and later: the class's sizes, as the file has them. */
  json: Record<string, unknown>
}

export interface KicadPro {
  /** The file's own `meta.filename`, `name.kicad_pro`. */
  filename: string | null
  version: number | null
  netClasses: KicadNetClass[]
  /** Net names with a class assigned, and the patterns that assign one. */
  netclassAssignments: Record<string, unknown>
  netclassPatterns: { netclass: string; pattern: string }[]
  textVariables: Record<string, string>
  /** `sheets`: (uuid, name) pairs, the project's own list of sheets. */
  sheets: [string, string][]
  /** The whole file. */
  json: Record<string, unknown>
}

export interface ProReadResult {
  pro: KicadPro
  text: string
  notes: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Reads a `.kicad_pro`, as text or bytes. Throws `KicadProjectFileError` for a file that is not JSON or not an object. */
export function readKicadPro(input: string | Uint8Array): ProReadResult {
  let text: string
  let notes: string[] = []
  if (typeof input === "string") text = input
  else {
    const decoded = decodeBytes(input)
    text = decoded.text
    notes = decoded.notes
  }
  if (!text.trim()) throw new KicadProjectFileError("empty", "The project file is empty.")
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^﻿/, ""))
  } catch (e) {
    throw new KicadProjectFileError("not-json", `The project file is not valid JSON (${e instanceof Error ? e.message : String(e)}); it looks damaged or cut short.`)
  }
  if (!isObject(json)) throw new KicadProjectFileError("not-an-object", "The project file is JSON, but not the object a KiCad project file is.")
  const meta = isObject(json.meta) ? json.meta : {}
  const ns = isObject(json.net_settings) ? json.net_settings : {}
  const classes = Array.isArray(ns.classes) ? ns.classes.filter(isObject) : []
  const patterns = Array.isArray(ns.netclass_patterns) ? ns.netclass_patterns.filter(isObject) : []
  const vars = isObject(json.text_variables) ? json.text_variables : {}
  return {
    pro: {
      filename: typeof meta.filename === "string" ? meta.filename : null,
      version: typeof meta.version === "number" ? meta.version : null,
      netClasses: classes.map((c) => ({ name: typeof c.name === "string" ? c.name : "", json: c })),
      netclassAssignments: isObject(ns.netclass_assignments) ? ns.netclass_assignments : {},
      netclassPatterns: patterns.map((p) => ({ netclass: String(p.netclass ?? ""), pattern: String(p.pattern ?? "") })),
      textVariables: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])),
      sheets: Array.isArray(json.sheets) ? json.sheets.filter((s): s is [string, string] => Array.isArray(s) && typeof s[0] === "string").map((s) => [s[0], String(s[1] ?? "")] as [string, string]) : [],
      json,
    },
    text,
    notes,
  }
}

// ---------- the table ----------

export interface ProRule {
  /** A regular expression over the whole key path: object keys joined by `>`, each array element `[]`. */
  re: RegExp
  decision: "not-needed" | "pending" | "used"
  /** For `pending`: the extension of the model the key needs. */
  ext?: string
  note: string
}

const rule = (path: string, decision: ProRule["decision"], note: string, ext?: string): ProRule => ({ re: new RegExp(`^(?:${path})$`), decision, note, ...(ext ? { ext } : {}) })
/** The key itself, or anything below it: a key of an object (`>`) or an element of an array (`[]`). */
const SUB = "(?:[>\\[].*)?"

export const PRO_RULES: ProRule[] = [
  rule(`meta${SUB}`, "not-needed", "the file's own name and version"),
  // What a program writes about the file and the session that saved it (our own export writes these too): no design in them.
  rule(`(?:version|head)${SUB}`, "not-needed", "the file's version and the program that wrote it"),
  rule(`board>(?:meta|last_opened_board)${SUB}`, "not-needed", "the board section's version and the board that was open last"),
  rule(`schematic>last_opened_files${SUB}`, "not-needed", "the sheets that were open last"),
  rule("net_settings>last_net_id", "not-needed", "the last number KiCad gave a net"),
  // The objects that hold the settings below: each key under them has a row of its own.
  rule("board|board>design_settings|net_settings|schematic", "not-needed", "a group of settings, each of which is accounted for below it"),
  // ---- net classes, rules and what hangs on them: X10 ----
  rule(`net_settings>classes${SUB}`, "pending", "net classes: clearance, track and via sizes, differential pair sizes", "X10"),
  rule(`net_settings>(?:netclass_assignments|netclass_patterns)${SUB}`, "pending", "which nets are in which net class", "X10"),
  rule(`net_settings>(?:net_chain_classes|net_chain_netclasses)${SUB}`, "pending", "net chains and their classes (KiCad 11 development)", "X21"),
  rule(`net_settings>(?:net_colors|hidden_nets)${SUB}`, "not-needed", "how KiCad colours and hides nets on screen"),
  rule(`net_settings>meta${SUB}`, "not-needed", "the section's version"),
  rule(`board>design_settings>(?:rules|defaults|track_widths|via_dimensions|diff_pair_dimensions|via_stack_presets)${SUB}`, "pending", "design rules, the sizes new items get, and the track and via sizes KiCad offers", "X10"),
  rule(`board>design_settings>(?:teardrop_options|teardrop_parameters|zones_allow_external_fillets|zones_use_no_outline)${SUB}`, "pending", "teardrop and copper zone settings", "X3"),
  rule(`board>design_settings>tuning_pattern_settings${SUB}`, "pending", "length tuning patterns", "X21"),
  rule(`board>design_settings>(?:rule_severities|rule_severitieslegacy_[a-z_]+)${SUB}`, "not-needed", "how severe KiCad's own design rule checks are: the editor's checks have their own"),
  rule(`board>design_settings>drc_exclusions${SUB}`, "not-needed", "design rule check markers the user dismissed in KiCad"),
  rule(`board>design_settings>(?:meta|bom_[a-z_]+)${SUB}`, "not-needed", "a version and bill of materials presets"),
  rule(`component_class_settings${SUB}`, "pending", "component classes", "X20"),
  rule(`(?:tuning_profiles|time_domain_parameters)${SUB}`, "pending", "length and delay tuning profiles", "X21"),
  rule(`kicad_routing_tools${SUB}`, "not-needed", "settings of KiCad's interactive router"),
  // ---- the schematic's own settings ----
  rule(`schematic>bus_aliases${SUB}`, "used", "the bus aliases of the project (KiCad 10 keeps them here, for the whole schematic: `SCHEMATIC::loadBusAliasesFromProject`; KiCad 9 and before keep a `bus_alias` in each schematic file and write this key empty)"),
  rule(`schematic>variants${SUB}`, "pending", "schematic variants", "S9"),
  rule(`schematic>top_level_sheets${SUB}`, "pending", "the sheets at the top of the hierarchy", "S1"),
  rule(`text_variables${SUB}`, "pending", "the text variables that text and title blocks can use", "S4"),
  rule(`sheets${SUB}`, "pending", "the project's list of sheets", "S1"),
  rule(`schematic>drawing${SUB}`, "not-needed", "the sizes KiCad gives to items drawn later (text, lines, junctions, intersheet references)"),
  rule(`schematic>(?:bom_[a-z_]+|annotat[a-z_]+|reuse_designators|used_designators|subpart_[a-z_]+)${SUB}`, "not-needed", "bill of materials and annotation settings"),
  rule(`schematic>(?:ngspice|spice_[a-z_]+)${SUB}`, "not-needed", "KiCad's simulator settings"),
  rule(`schematic>(?:compare_symbols|connection_grid_size|space_save_all_events|net_format_name|page_layout_descr_file|plot_directory|legacy_lib_dir|legacy_lib_list|meta)${SUB}`, "not-needed", "editing, plotting and legacy library settings of KiCad's schematic editor"),
  // ---- erc, libraries, caches and view state ----
  rule(`erc${SUB}`, "not-needed", "KiCad's electrical rule check settings and dismissed markers: the editor has its own checks"),
  rule(`libraries${SUB}`, "not-needed", "the libraries the user pinned in KiCad"),
  rule(`cvpcb${SUB}`, "not-needed", "the footprint assignment tool's equivalence files"),
  rule(`legacy${SUB}`, "not-needed", "settings of KiCad 5 files"),
  rule(`pcbnew${SUB}`, "not-needed", "the board editor's last used paths and searches"),
  rule(`boards${SUB}`, "not-needed", "the project's list of boards"),
  rule(`board>(?:3dviewports|viewports|layer_presets|layer_pairs|idf_export|ipc2581)${SUB}`, "not-needed", "saved views, layer presets and export settings"),
]

const rules = PRO_RULES

/** The key paths of a JSON value with their counts. Object keys are joined by `>`, each array element is `[]`. */
export function countKeyPaths(json: unknown): Map<string, number> {
  const out = new Map<string, number>()
  const stack: [unknown, string][] = [[json, ""]]
  while (stack.length) {
    const [v, path] = stack.pop()!
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x !== null && typeof x === "object") stack.push([x, `${path}[]`])
        else if (typeof x !== "object") {
          const p = `${path}[]`
          out.set(p, (out.get(p) ?? 0) + 1)
        }
      }
    } else if (isObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}>${k}` : k
        out.set(p, (out.get(p) ?? 0) + 1)
        if (x !== null && typeof x === "object") stack.push([x, p])
      }
    }
  }
  return out
}

const cache = new Map<string, ProRule | null>()
export function proRuleFor(path: string): ProRule | null {
  let r = cache.get(path)
  if (r === undefined) {
    r = rules.find((x) => x.re.test(path)) ?? null
    cache.set(path, r)
  }
  return r
}

/**
 * Account for every key of a project file. Net classes and rules are pending X10 whatever they say:
 * whether they hold anything the project would lose is `proNeeds`'s question, and the account only
 * says where each key went.
 */
export function accountPro(json: unknown): NodeAccount {
  const paths = countKeyPaths(json)
  const account = newAccount()
  account.paths = paths
  for (const [path, count] of paths) {
    account.total += count
    const r = proRuleFor(path)
    if (!r) account.unknownPaths.set(path, count)
    else if (r.decision === "pending") account.pending.set(r.ext!, (account.pending.get(r.ext!) ?? 0) + count)
    else if (r.decision === "used") {
      account.imported += count
      account.importedPaths.set(path, count)
    } else account.notNeeded.set(r.note, (account.notNeeded.get(r.note) ?? 0) + count)
  }
  return account
}

/**
 * S3: the bus aliases a project file lists (`schematic.bus_aliases`, an object of name to members), as KiCad 10 reads them
 * (`PROJECT_FILE`'s "schematic.bus_aliases": a name and each member are stripped of spaces, an empty one is dropped, a value that is
 * not a list is skipped). They are the project's aliases before those of its schematic files.
 */
export function proBusAliases(pro: Pick<KicadPro, "json"> | null): { name: string; members: string[] }[] {
  const aliases = pro && isObject(pro.json.schematic) ? (pro.json.schematic as Record<string, unknown>).bus_aliases : undefined
  if (!isObject(aliases)) return []
  const out: { name: string; members: string[] }[] = []
  for (const [key, value] of Object.entries(aliases)) {
    const name = key.trim()
    if (!name || !Array.isArray(value)) continue
    out.push({ name, members: value.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean) })
  }
  return out
}

/** Report entries for the keys the table does not know. */
export function reportUnknownPro(account: NodeAccount, report: ImportReport, file: string) {
  for (const [path, count] of account.unknownPaths) {
    // What is inside a key the table does not know is covered by the key's own entry.
    const cut = path.search(/(>|\[\])[^>\[]*$/)
    if (cut > 0 && account.unknownPaths.has(path.slice(0, cut))) continue
    report.entries.push({ code: "unknown-key", severity: "refused", object: `the key "${path}" in ${file}`, why: "KiCad's project file has a setting this importer does not know. Nothing is guessed: the project is not imported until the importer learns it.", count })
  }
}

// ---------- which design settings say something the editor's rules do not ----------

/** The values a `DesignRules` field of the editor has by default (`model/rules.ts`), by the project file's key. A different value is something the project would lose until X10 builds it. */
const EDITOR_RULE_DEFAULTS: Record<string, number> = {
  // the Default net class
  clearance: 0.2,
  track_width: 0.25,
  via_diameter: 0.6,
  via_drill: 0.3,
  // board>design_settings>rules
  min_track_width: 0.15,
  min_through_hole_diameter: 0.2,
  min_via_annular_width: 0.13,
  min_hole_to_hole: 0.25,
  min_copper_edge_clearance: 0.4,
  solder_mask_clearance: 0.05,
}

/** KiCad's own value of a setting the editor has no field for: the project says nothing more by it. */
const KICAD_DEFAULTS: Record<string, unknown> = {
  // net class
  bus_width: 12,
  wire_width: 6,
  line_style: 0,
  diff_pair_gap: 0.25,
  diff_pair_via_gap: 0.25,
  diff_pair_width: 0.2,
  microvia_diameter: 0.3,
  microvia_drill: 0.1,
  pcb_color: "rgba(0, 0, 0, 0.000)",
  schematic_color: "rgba(0, 0, 0, 0.000)",
  priority: 2147483647,
  tuning_profile: "",
  // rules
  max_error: 0.005,
  min_clearance: 0,
  min_connection: 0,
  min_groove_width: 0,
  min_hole_clearance: 0.25,
  min_microvia_diameter: 0.2,
  min_microvia_drill: 0.1,
  min_resolved_spokes: 2,
  min_silk_clearance: 0,
  min_text_height: 0.8,
  min_text_thickness: 0.08,
  min_via_diameter: 0.5,
  solder_mask_to_copper_clearance: 0,
  solder_mask_min_width: 0,
  solder_paste_clearance: 0,
  solder_paste_margin_ratio: 0,
  use_height_for_length_calcs: true,
  allow_blind_buried_vias: false,
  allow_microvias: false,
}

const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b))

/**
 * The settings of a project file that differ from what the editor's project has, each as a sentence.
 * A key the editor has a field for is compared with the editor's default, one it has not with KiCad's
 * (`Default` net class and `board.design_settings.rules`); the lists of track, via and pair sizes must
 * be empty or KiCad's one placeholder; the sizes new items get (`defaults`) are tool presets with no
 * counterpart, and count only where they are not the value of the most common releases. This is X10's
 * rule from the board side: whatever the editor's rules cannot say is the extension.
 */
export function designSettingsNeeds(json: Record<string, unknown>): string[] {
  const out: string[] = []
  const diff = (where: string, obj: unknown, extraKnown: Record<string, unknown[]> = {}) => {
    if (!isObject(obj)) return
    const odd: string[] = []
    for (const [k, v] of Object.entries(obj)) {
      if (k === "name" || k === "nets") continue
      if (k in EDITOR_RULE_DEFAULTS) {
        if (!same(v, EDITOR_RULE_DEFAULTS[k])) odd.push(`${k} ${JSON.stringify(v)}`)
      } else if (k in KICAD_DEFAULTS) {
        if (!same(v, KICAD_DEFAULTS[k])) odd.push(`${k} ${JSON.stringify(v)}`)
      } else if (k in extraKnown) {
        if (!extraKnown[k].some((x) => same(v, x))) odd.push(`${k} ${JSON.stringify(v)}`)
      } else odd.push(`${k} ${JSON.stringify(v)}`)
    }
    if (odd.length) out.push(`${where}: ${odd.slice(0, 3).join(", ")}${odd.length > 3 ? ", ..." : ""}`)
  }
  const ns = isObject(json.net_settings) ? json.net_settings : {}
  const classes = Array.isArray(ns.classes) ? ns.classes.filter(isObject) : []
  const def = classes.find((c) => c.name === "Default")
  if (def) diff("the default net class", def)
  const ds = isObject((json.board as Record<string, unknown> | undefined)?.design_settings) ? ((json.board as Record<string, unknown>).design_settings as Record<string, unknown>) : {}
  diff("the design rules", ds.rules)
  // The sizes new items get: the two most common values of each in the corpus's files (KiCad 6 to 10).
  diff("the sizes new items get", ds.defaults, {
    apply_defaults_to_fp_fields: [false],
    apply_defaults_to_fp_shapes: [false],
    apply_defaults_to_fp_text: [false],
    apply_defaults_to_fp_barcodes: [false],
    apply_defaults_to_fp_dimensions: [false],
    board_outline_line_width: [0.05, 0.1],
    copper_line_width: [0.2],
    copper_text_italic: [false],
    copper_text_size_h: [1.5],
    copper_text_size_v: [1.5],
    copper_text_thickness: [0.3],
    copper_text_upright: [false],
    courtyard_line_width: [0.05],
    dimension_precision: [4],
    dimension_units: [3],
    fab_line_width: [0.1],
    fab_text_italic: [false],
    fab_text_size_h: [1],
    fab_text_size_v: [1],
    fab_text_thickness: [0.15],
    fab_text_upright: [false],
    other_line_width: [0.1, 0.15],
    other_text_italic: [false],
    other_text_size_h: [1],
    other_text_size_v: [1],
    other_text_thickness: [0.15],
    other_text_upright: [false],
    silk_line_width: [0.1, 0.15],
    silk_text_italic: [false],
    silk_text_size_h: [1],
    silk_text_size_v: [1],
    silk_text_thickness: [0.1, 0.15],
    silk_text_upright: [false],
    dimensions: [{ arrow_length: 1270000, extension_offset: 500000, keep_text_aligned: true, suppress_zeroes: false, text_position: 0, units_format: 1 }, { arrow_length: 1270000, extension_offset: 500000, keep_text_aligned: true, suppress_zeroes: true, text_position: 0, units_format: 0 }],
    pads: [{ drill: 0.762, height: 1.524, width: 1.524 }, { drill: 0.8, height: 1.27, width: 2.54 }],
    zones: [{ min_clearance: 0.5 }, { "45_degree_only": false, min_clearance: 0.508 }],
  })
  const list = (name: string, placeholder: unknown) => {
    const v = ds[name]
    if (Array.isArray(v) && v.length && !(v.length === 1 && same(v[0], placeholder))) out.push(`the ${name.replace(/_/g, " ")} KiCad offers: ${JSON.stringify(v).slice(0, 60)}`)
  }
  list("track_widths", 0)
  list("via_dimensions", { diameter: 0, drill: 0 })
  list("diff_pair_dimensions", { gap: 0, via_gap: 0, width: 0 })
  list("via_stack_presets", undefined)
  return out
}
