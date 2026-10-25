import { newAccount } from "../schematic/account"
import type { ImportReport, NodeAccount } from "../board/report"
import { decodeLegacy } from "../schematic/legacy/text"
import type { KicadPro } from "./pro"

// The legacy project file (`name.pro`, KiCad 4 and 5): an ini file of `[section]` headings and
// `key=value` lines. It is read into a typed object that keeps every line, and every line is
// accounted for by a row of the table below: used (the library list, the library search path, the
// root sheet), pending an extension (net classes, the design rules and the sizes KiCad offers, the
// sheet names, text variables), or not needed with its reason (view state, plot and export
// settings). A line no row covers is unknown, and the project is not imported. Net classes and the
// design rules are pending X10, as the `.kicad_pro` reader has them.

export class LegacyProFileError extends Error {
  constructor(
    readonly code: "empty" | "not-ini" | "bad-line",
    message: string,
  ) {
    super(message)
  }
}

export interface LegacyProEntry {
  section: string
  key: string
  value: string
}

export interface LegacyPro {
  entries: LegacyProEntry[]
  /** The libraries the schematic uses, by name, in the order the project lists them (`LibName1`, `LibName2`...). */
  libNames: string[]
  /** The folders libraries are searched in (`LibDir=`, separated by `;`), in the order the file gives them. */
  libDirs: string[]
  /** The root schematic's file name when the file names one (`RootSch=`). */
  rootSch: string | null
  /** The project as the `.kicad_pro` reader holds one: net classes, sheets and text variables, and the settings in the shape `designSettingsNeeds` reads. */
  pro: KicadPro
}

export interface LegacyProReadResult {
  legacy: LegacyPro
  text: string
  notes: string[]
}

/** Whether a text looks like a legacy project file. */
export const looksLikeLegacyPro = (text: string) => !/^\s*[{[]\s*"/.test(text) && /^\s*(update|version|last_client|\[[^\]]+\])/m.test(text)

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined
  const x = Number(v)
  return Number.isFinite(x) ? x : undefined
}

/** Reads a `.pro`, as text or bytes. Throws `LegacyProFileError` for a file that is not an ini file. */
export function readLegacyPro(input: string | Uint8Array): LegacyProReadResult {
  let text: string
  let notes: string[] = []
  if (typeof input === "string") text = input
  else {
    const d = decodeLegacy(input)
    text = d.text
    notes = d.notes
  }
  // An empty project file is KiCad's own default: no settings.
  if (/^\s*\{/.test(text)) throw new LegacyProFileError("not-ini", "This project file is JSON (a KiCad 6 project, `.kicad_pro`), not a KiCad 5 `.pro`.")
  const entries: LegacyProEntry[] = []
  let section = ""
  let n = 0
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    n++
    const line = raw
    if (line.trim() === "") continue
    const h = /^\[(.*)\]\s*$/.exec(line)
    if (h) {
      section = h[1]
      entries.push({ section, key: "", value: "" })
      continue
    }
    const eq = line.indexOf("=")
    if (eq <= 0) throw new LegacyProFileError("bad-line", `Line ${n} of the project file is not \`key=value\` (${JSON.stringify(line.slice(0, 50))}).`)
    entries.push({ section, key: line.slice(0, eq), value: line.slice(eq + 1) })
  }
  const get = (sec: RegExp, key: RegExp) => entries.filter((e) => e.key !== "" && sec.test(e.section) && key.test(e.key))
  const libNames = get(/^eeschema\/libraries$/i, /^LibName\d+$/)
    .map((e) => ({ i: Number(e.key.slice(7)), v: e.value.trim() }))
    .sort((a, b) => a.i - b.i)
    .map((e) => e.v)
    .filter((v) => v !== "")
  const libDirs = (get(/^eeschema$/, /^LibDir$/)[0]?.value ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
  const rootSch = get(/^general$/, /^RootSch$/)[0]?.value.trim() || null

  // The settings in the shape the `.kicad_pro` reader's rules are written for.
  const sec = (name: RegExp) => Object.fromEntries(entries.filter((e) => e.key !== "" && name.test(e.section)).map((e) => [e.key, e.value]))
  const pcb = sec(/^pcbnew$/)
  const classes: KicadPro["netClasses"] = []
  const asClass = (c: Record<string, string>) => {
    const out: Record<string, unknown> = { name: c.Name ?? "" }
    const map: [string, string][] = [
      ["Clearance", "clearance"],
      ["TrackWidth", "track_width"],
      ["ViaDiameter", "via_diameter"],
      ["ViaDrill", "via_drill"],
      ["uViaDiameter", "microvia_diameter"],
      ["uViaDrill", "microvia_drill"],
      ["dPairWidth", "diff_pair_width"],
      ["dPairGap", "diff_pair_gap"],
      ["dPairViaGap", "diff_pair_via_gap"],
    ]
    for (const [k, to] of map) if (num(c[k]) !== undefined) out[to] = num(c[k])
    return out
  }
  const classSections = [...new Set(entries.filter((e) => /^pcbnew\/Netclasses\/.+/.test(e.section)).map((e) => e.section))]
  for (const s of classSections.sort((a, b) => (a.endsWith("/Default") ? -1 : b.endsWith("/Default") ? 1 : 0))) {
    const c = sec(new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`))
    classes.push({ name: c.Name ?? s.slice(s.lastIndexOf("/") + 1), json: asClass(c) })
  }
  const rules: Record<string, unknown> = {}
  const ruleMap: [string, string][] = [
    ["MinTrackWidth", "min_track_width"],
    ["MinViaDiameter", "min_via_diameter"],
    ["MinViaDrill", "min_through_hole_diameter"],
    ["MinMicroViaDiameter", "min_microvia_diameter"],
    ["MinMicroViaDrill", "min_microvia_drill"],
    ["MinHoleToHole", "min_hole_to_hole"],
    ["CopperEdgeClearance", "min_copper_edge_clearance"],
    ["SolderMaskClearance", "solder_mask_clearance"],
    ["SolderMaskMinWidth", "solder_mask_min_width"],
    ["SolderPasteClearance", "solder_paste_clearance"],
    ["SolderPasteRatio", "solder_paste_margin_ratio"],
  ]
  for (const [k, to] of ruleMap) if (num(pcb[k]) !== undefined) rules[to] = num(pcb[k])
  const defaults: Record<string, unknown> = {}
  const defaultMap: [string, string, "num" | "bool"][] = [
    ["SilkLineWidth", "silk_line_width", "num"],
    ["SilkTextSizeH", "silk_text_size_h", "num"],
    ["SilkTextSizeV", "silk_text_size_v", "num"],
    ["SilkTextSizeThickness", "silk_text_thickness", "num"],
    ["SilkTextItalic", "silk_text_italic", "bool"],
    ["SilkTextUpright", "silk_text_upright", "bool"],
    ["CopperLineWidth", "copper_line_width", "num"],
    ["CopperTextSizeH", "copper_text_size_h", "num"],
    ["CopperTextSizeV", "copper_text_size_v", "num"],
    ["CopperTextThickness", "copper_text_thickness", "num"],
    ["CopperTextItalic", "copper_text_italic", "bool"],
    ["CopperTextUpright", "copper_text_upright", "bool"],
    ["OthersLineWidth", "other_line_width", "num"],
    ["OthersTextSizeH", "other_text_size_h", "num"],
    ["OthersTextSizeV", "other_text_size_v", "num"],
    ["OthersTextSizeThickness", "other_text_thickness", "num"],
    ["OthersTextItalic", "other_text_italic", "bool"],
    ["OthersTextUpright", "other_text_upright", "bool"],
    ["CourtyardLineWidth", "courtyard_line_width", "num"],
    ["EdgeCutLineWidth", "board_outline_line_width", "num"],
  ]
  for (const [k, to, kind] of defaultMap) {
    const v = num(pcb[k])
    if (v !== undefined) defaults[to] = kind === "bool" ? v !== 0 : v
  }
  const listOf = (re: RegExp) =>
    Object.keys(pcb)
      .map((k) => re.exec(k))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b)
  const trackWidths = listOf(/^TrackWidth(\d+)$/).map((i) => num(pcb[`TrackWidth${i}`]) ?? 0)
  const vias = listOf(/^ViaDiameter(\d+)$/).map((i) => ({ diameter: num(pcb[`ViaDiameter${i}`]) ?? 0, drill: num(pcb[`ViaDrill${i}`]) ?? 0 }))
  const pairs = listOf(/^dPairWidth(\d+)$/).map((i) => ({ gap: num(pcb[`dPairGap${i}`]) ?? 0, via_gap: num(pcb[`dPairViaGap${i}`]) ?? 0, width: num(pcb[`dPairWidth${i}`]) ?? 0 }))
  const sheets = entries.filter((e) => e.section === "sheetnames" && e.key !== "").map((e) => [e.key, e.value] as [string, string])
  const textVariables = Object.fromEntries(entries.filter((e) => e.section === "text_variables" && e.key !== "").map((e) => [e.key, e.value]))
  const json: Record<string, unknown> = {
    net_settings: { classes: classes.map((c) => c.json) },
    board: { design_settings: { rules, defaults, ...(trackWidths.length ? { track_widths: [0, ...trackWidths] } : {}), ...(vias.length ? { via_dimensions: [{ diameter: 0, drill: 0 }, ...vias] } : {}), ...(pairs.length ? { diff_pair_dimensions: [{ gap: 0, via_gap: 0, width: 0 }, ...pairs] } : {}) } },
  }
  const pro: KicadPro = { filename: null, version: num(entries.find((e) => e.section === "" && e.key === "version")?.value) ?? null, netClasses: classes, netclassAssignments: {}, netclassPatterns: [], textVariables, sheets, json }
  return { legacy: { entries, libNames, libDirs, rootSch, pro }, text, notes }
}

// ---------- the table ----------

export interface LegacyProRule {
  section: RegExp
  /** Matches the key; absent for the section heading itself. */
  key?: RegExp
  decision: "used" | "not-needed" | "pending"
  ext?: string
  note: string
}

const rule = (section: string, key: string | undefined, decision: LegacyProRule["decision"], note: string, ext?: string): LegacyProRule => ({
  section: new RegExp(`^(?:${section})$`, "i"),
  ...(key !== undefined ? { key: new RegExp(`^(?:${key})$`) } : {}),
  decision,
  note,
  ...(ext ? { ext } : {}),
})

export const LEGACY_PRO_RULES: LegacyProRule[] = [
  // the file's own lines, before any section
  rule("", "update|version|last_client", "not-needed", "when the file was saved and by which program"),
  rule("general", "version|BoardNm", "not-needed", "the file's version and the board's name (the board file is picked by its own name)"),
  rule("general", "RootSch", "used", "the root schematic the project names"),
  // libraries
  rule("eeschema/libraries", "LibName\\d+", "used", "the libraries the schematic's symbols are searched in, in this order"),
  rule("eeschema", "LibDir", "used", "the folders the libraries are searched in"),
  rule("eeschema", "version|LabSize|NetFmt|NetFmtName|PenMin|HPGLDm|HPGLNum|HPGLSpd|RptD_X|RptD_Y|RptLab|SimCmd|UseNetN|offX_[A-E]|offY_[A-E]|offX_A\\d+|offY_A\\d+", "not-needed", "plotting, netlist and simulation settings of KiCad's schematic editor"),
  rule("pcbnew/libraries", "LibDir|LibName\\d+", "not-needed", "the footprint libraries of the board editor"),
  rule("cvpcb/libraries", "EquName\\d+", "not-needed", "the footprint assignment tool's equivalence files"),
  rule("cvpcb", ".*", "not-needed", "the footprint assignment tool's settings"),
  rule("common", ".*", "not-needed", "the folder KiCad writes netlists to"),
  // the schematic editor
  rule("schematic_editor", "ERC_[A-Za-z]+|LabSize|LineThickness|BusThickness|WireThickness|JunctionSize|TextOffsetRatio|NetFmtName|PageLayoutDescrFile|PlotDirectoryName|SpiceAjustPassiveValues|SpiceForceRefPrefix|SpiceUseNetNumbers|SubpartFirstId|SubpartIdSeparator|FieldNameTemplates|version", "not-needed", "the sizes KiCad gives items drawn later, its electrical rule check, plotting and annotation settings"),
  rule("sheetnames", "\\d+", "pending", "the names of the project's sheets", "S1"),
  rule("text_variables", "\\d+", "pending", "the text variables that text and title blocks can use", "S4"),
  // the board's settings
  rule("pcbnew/Netclasses(?:/.+)?", "Name|Clearance|TrackWidth|ViaDiameter|ViaDrill|uViaDiameter|uViaDrill|dPairWidth|dPairGap|dPairViaGap|AddNet\\d*", "pending", "net classes: clearance, track and via sizes, differential pair sizes", "X10"),
  rule("pcbnew", "Min(?:TrackWidth|ViaDiameter|ViaDrill|MicroViaDiameter|MicroViaDrill|HoleToHole)|CopperEdgeClearance|Solder(?:MaskClearance|MaskMinWidth|PasteClearance|PasteRatio)|TrackWidth\\d+|ViaDiameter\\d+|ViaDrill\\d+|dPair(?:Width|Gap|ViaGap)\\d+", "pending", "design rules, and the track, via and pair sizes KiCad offers", "X10"),
  rule("pcbnew", "(?:Silk|Copper|Others)(?:LineWidth|TextSize[HV]|TextSizeThickness|TextThickness|TextItalic|TextUpright)|CourtyardLineWidth|EdgeCutLineWidth|BoardOutlineThickness|ModuleOutlineThickness|ModuleText[A-Za-z]+|DrawSegmentWidth|PcbText[A-Za-z]+|PadSize[HV]|PadDrill(?:OvalY)?|Dimension(?:Precision|Units)", "pending", "the sizes new items get", "X10"),
  rule("pcbnew", "AllowBlindVias|AllowMicroVias|BoardThickness|CopperLayerCount|RequireCourtyardDefinitions|ProhibitOverlappingCourtyards|PageLayoutDescrFile|version|LastNetListRead|LastGenCADExportPath|LastIDFExportPath|LastSTEPExportPath|LastSpecctraDSNExportPath|LastVRMLExportPath|LibDir|UseCmpFile|Countlayer|DivGrPc|DrawLar|EdgeLar|ForPlot|Segm\\d+|Racc\\d+|SgPcb\\d+|GERBfmt|GERBmin|GridX|GridY|HPGLSpd|HPGLnum|HPGLorg|HPGLrec|HPGdiam|Isol|Lpiste|MSegLar|MaxLnkS|Mlayer|ModAffC|ModAffT|NetType|NewAffG|PadAffG|PadAttr|PadDimH|PadDimV|PadDril|PadDrlX|PadFill|PadForm|PadMask|PadOfDH|PadOfDV|PadOrie|PadSNum|PcbAffT|Pltmarg|RaccN|RouteBo|RouteTo|SegAffG|SegFill|SegmN|Sel_Mod|SgPcbN|ShowMRa|ShowRat|TimeOut|TxtLar|TxtModH|TxtModV|TxtModW|TxtPcbH|TxtPcbV|TypeVia|Unite|UserGrU|UserGrX|UserGrY|VEgarde|ViaDiam|ViaDril|WpenSer", "not-needed", "the board editor's layer count, display, plotting and export settings (the board file keeps the real ones)"),
  rule("pcbnew/Layer\\.[A-Za-z.]+(?:\\d+)?\\.?[A-Za-z]*", "Enabled|Name|Type", "not-needed", "which layers the board editor shows (the board file keeps the real layers)"),
  // view state
  rule("LibeditFrame|ModEditFrame|PcbFrame|SchematicFrame|P\\d*N?LIB_TREE_MODEL_ADAPTER", "version|PinnedItems\\d+", "not-needed", "the libraries the user pinned in KiCad's editors"),
]

const rules = LEGACY_PRO_RULES
const sectionHeading = new Set<string>()
void sectionHeading

/** The row for one line of the file, or null. A section heading is covered by any row of its section. */
export function legacyProRuleFor(section: string, key: string): LegacyProRule | null {
  for (const r of rules) {
    if (!r.section.test(section)) continue
    if (key === "") return r
    if (r.key?.test(key)) return r
  }
  return null
}

/** Account for every line of a legacy project file. */
export function accountLegacyPro(legacy: LegacyPro): NodeAccount {
  const account = newAccount()
  for (const e of legacy.entries) {
    const path = e.key === "" ? `[${e.section}]` : `[${e.section.replace(/\d+/g, "N")}] ${e.key.replace(/\d+/g, "N")}`
    account.paths.set(path, (account.paths.get(path) ?? 0) + 1)
    account.total++
    const r = legacyProRuleFor(e.section, e.key)
    if (!r) account.unknownPaths.set(path, (account.unknownPaths.get(path) ?? 0) + 1)
    else if (e.key === "") account.notNeeded.set("a section heading: each key below it is accounted for on its own line", (account.notNeeded.get("a section heading: each key below it is accounted for on its own line") ?? 0) + 1)
    else if (r.decision === "pending") account.pending.set(r.ext!, (account.pending.get(r.ext!) ?? 0) + 1)
    else if (r.decision === "used") {
      account.imported++
      account.importedPaths.set(path, (account.importedPaths.get(path) ?? 0) + 1)
    } else account.notNeeded.set(r.note, (account.notNeeded.get(r.note) ?? 0) + 1)
  }
  return account
}

/** Report entries for the lines the table does not know. */
export function reportUnknownLegacyPro(account: NodeAccount, report: ImportReport, file: string) {
  for (const [path, count] of account.unknownPaths) {
    report.entries.push({ code: "unknown-key", severity: "refused", object: `the setting "${path}" in ${file}`, why: "KiCad's project file has a setting this importer does not know. Nothing is guessed: the project is not imported until the importer learns it.", count })
  }
}
