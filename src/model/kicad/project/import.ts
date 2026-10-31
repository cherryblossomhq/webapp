import { round, snap } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { bareName, computeConnectivity, pinKey } from "../../connectivity"
import { registerProjectParts } from "../../customParts"
import { isSchematicPart, pinStubPoint, schematicBounds, schematicPins } from "../../instances"
import { joinFlags } from "../../partFlags"
import { labelBox } from "../../labels"
import { findPart, isRegistered, projectPartIds, unregisterPart } from "../../library"
import { SCH_GRID } from "../../symbols"
import { isHierarchical, sheetView, useAt, usesOfSheet } from "../../sheets"
import { serializeProject } from "../../projectFile"
import type { ComponentInstance, NetLabel, PartFlags, Project, Rotation, SchematicBlock, Wire } from "../../types"
import type { KeptFile } from "../board/images"
import { dropKeptFills, importKicadBoard, PROJECT_SIZE_LIMIT_BYTES, formatSize, type KicadImportResult } from "../board/import"
import { hasKeptFills } from "../../zoneKeep"
import { signKeptFills } from "../../zoneKeepSign"
import { buildKicadProject } from "../board/build"
import type { GivenModels } from "../board/models"
import { outlineOf } from "../board/outline"
import { readKicadBoard } from "../board/read"
import { KicadReadError } from "../board/sexpr"
import { BUILT_EXTENSIONS as BOARD_BUILT, EXTENSION_NAMES as BOARD_EXTENSION_NAMES } from "../board/needs"
import { decodeNetName } from "../board/read"
import { refusals, type ImportReport, type NodeAccount, type ReportEntry } from "../board/report"
import type { KicadBoard, KicadFootprint } from "../board/types"
import { netLabelNames } from "../board/build"
import { settleImportedLabelClasses } from "../../directives"
import { flagOrigins, reportRuleAreaUnits, resolvedComponents } from "../../ruleAreas"
import { joinOverrides, normalizeProjectVariants } from "../../variants"
import { buildSchematicProject, releaseBuild, type SchematicBuild } from "../schematic/build"
import { flagVoice } from "../schematic/read"
import { finishSchematic, gateSchematic } from "../schematic/import"
import { legacyWarnings, librarySymbols, symbolRef } from "../schematic/legacy/report"
import { linkFootprints, type LinkResult, type SymbolRecord } from "../schematic/link"
import { BUILT_EXTENSIONS as SCHEMATIC_BUILT, EXTENSION_NAMES as SCHEMATIC_EXTENSION_NAMES, refusalMessage, unbuilt, type Need } from "../schematic/needs"
import { normalizePath, type SchematicTree } from "../schematic/tree"
import { KicadRulesFileError, accountRules, readKicadRules, reportUnknownRules, type KicadRules } from "./dru"
import { LegacyProFileError, accountLegacyPro, readLegacyPro, reportUnknownLegacyPro } from "./legacyPro"
import { applyClassRules } from "./classRules"
import { applyProRules, lostRuleSettings } from "./rules"
import { KicadProjectFileError, accountPro, designSettingsNeeds, proBusAliases, readKicadPro, reportUnknownPro, type KicadPro } from "./pro"
import { isMarkedHole, restoreMountingHoles } from "../mountingHoles"

// The KiCad project import: a `.kicad_pro`, the `.kicad_sch` sheets and the `.kicad_pcb`, as one
// project. The board is imported by the board importer, which draws a generated schematic (a label
// on every pad); that schematic is then replaced by the real one, and each footprint is linked to
// its symbol (section 4 of docs/kicad-import-schematic.md). The nets of the two are then compared
// pad by pad: a board that has not been updated from its schematic is a list of differences by part
// and pin, not a guess.
//
// A project is imported exactly or not at all: if the schematic is refused but the board is fine,
// the whole project is refused, and the message says that importing the `.kicad_pcb` alone gives the
// board with a generated schematic.

export interface ProjectFile {
  /** Path inside the folder or archive the user dropped, `/` or `\` separated. */
  path: string
  data: string | Uint8Array
}

export interface ProjectImportOptions {
  name?: string
  source?: string
  /** The extensions of the model that are built, of the board and of the schematic; defaults to what the editor has. Tests raise it. */
  built?: ReadonlySet<string>
  limitBytes?: number
  /**
   * Build a board the editor cannot hold exactly, approximating what the model lacks (the board builder's
   * `allowLossy`). For measurement and tests only: the importer never imports such a board.
   */
  allowLossyBoard?: boolean
  /** S12: symbols of the parts database by `lib_id`, as the text of each one's `.kicad_sym` file; see `SchematicImportOptions.databaseSymbols`. */
  databaseSymbols?: ReadonlyMap<string, string>
  /** The 3D model files given with the board, which its footprints' models may name (the board builder's `models`). */
  models?: GivenModels
}

/** One pad whose net on the board is not the net of its pin in the schematic. */
export interface NetDifference {
  /** The part's reference. */
  ref: string
  /** The pad and pin number. */
  pin: string
  /** The net the board gives the pad, or null for none. */
  board: string | null
  /** The net the schematic gives the pin, or null for none. */
  schematic: string | null
  why: string
  /** The same pads on both sides, only the net's name differs: the report says these in one line, not one per pin. */
  nameOnly?: true
}

export type KicadProjectResult =
  | {
      status: "imported"
      project: Project
      report: ImportReport
      /** Pads whose board net is not their pin's net in the schematic: a board not updated from its schematic. */
      differences: NetDifference[]
      link: LinkResult | null
      board: KicadBoard
      tree: SchematicTree | null
      pro: KicadPro | null
      rules: KicadRules | null
      /** What became of every node or key of each file: the board's, the schematic sheets' together, the project file's and the rules file's. */
      accounts: { board: NodeAccount | null; schematic: NodeAccount | null; pro: NodeAccount | null; rules: NodeAccount | null }
      bytes: number
      /** The files the board brings that are kept beside the project, not in it (reference images). */
      files?: KeptFile[]
    }
  | {
      status: "refused"
      /** `no-board`: no `.kicad_pcb` among the files; the others are those of the board and schematic importers. */
      reason: "no-board" | "unreadable" | "unsupported" | "too-large" | "unknown" | "inexact"
      message: string
      report: ImportReport
      needs: Need[]
      /** The board imports on its own (with a generated schematic) when only the schematic or the project file is what is refused. */
      boardAloneImports: boolean
    }

const NAMES = { ...BOARD_EXTENSION_NAMES, ...SCHEMATIC_EXTENSION_NAMES }
const byteLength = (text: string) => new TextEncoder().encode(text).length

const extOf = (path: string) => path.slice(path.lastIndexOf(".")).toLowerCase()
const stemOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "")
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")

/** The root schematic, the board and the project files among a set of files. */
export function pickProjectFiles(files: ProjectFile[]) {
  const all = files.map((f) => ({ path: normalizePath(f.path), data: f.data }))
  const of = (ext: string) => all.filter((f) => extOf(f.path) === ext)
  const boards = of(".kicad_pcb")
  const pros = of(".kicad_pro")
  const legacyPros = of(".pro")
  const modernSheets = of(".kicad_sch")
  const legacySheets = of(".sch")
  // A KiCad 5 schematic: `.sch` sheets and no `.kicad_sch`. Its project file is a `.pro`, or a `.kicad_pro` (a KiCad 6 board and project over a KiCad 5 schematic).
  const legacy = !modernSheets.length && legacySheets.length > 0
  const sheets = legacy ? legacySheets : modernSheets
  const dru = of(".kicad_dru")
  const notes: string[] = []
  // The project's name is the project file's, else the board's.
  const anchor = legacy && !pros.length ? (boards[0] ?? legacyPros[0]) : (pros[0] ?? boards[0])
  const stem = anchor ? stemOf(anchor.path) : ""
  const dir = anchor ? dirOf(anchor.path) : ""
  const board = boards.find((b) => stemOf(b.path) === stem && dirOf(b.path) === dir) ?? boards.find((b) => stemOf(b.path) === stem) ?? boards[0]
  if (boards.length > 1) notes.push(`There are ${boards.length} boards among the files; ${board.path} was imported.`)
  const pro = legacy && !pros.length ? (legacyPros.find((p) => stemOf(p.path) === stem && dirOf(p.path) === dir) ?? legacyPros.find((p) => stemOf(p.path) === stem) ?? legacyPros.find((p) => dirOf(p.path) === dir)) : (pros.find((p) => dirOf(p.path) === dirOf(board?.path ?? "")) ?? pros[0])
  // The root schematic: same name and folder as the board or project, else the one no other sheet names.
  const base = stemOf((pro ?? board)?.path ?? "")
  const folder = dirOf((pro ?? board)?.path ?? "")
  let root = sheets.find((s) => stemOf(s.path) === base && dirOf(s.path) === folder) ?? sheets.find((s) => stemOf(s.path) === base)
  if (!root && sheets.length) {
    const text = (d: string | Uint8Array) => (typeof d === "string" ? d : new TextDecoder().decode(d))
    const named = new Set<string>()
    for (const s of sheets) {
      // A KiCad 6 sheet names its file in a property; a KiCad 5 sheet in its `F1` line.
      const re = legacy ? /^F1\s+"([^"]+)"/gm : /\(property\s+"(?:Sheetfile|Sheet file|File)"\s+"([^"]+)"/g
      for (const m of text(s.data).matchAll(re)) named.add(normalizePath(`${dirOf(s.path)}/${m[1]}`).toLowerCase())
    }
    const heads = sheets.filter((s) => !named.has(s.path.toLowerCase()))
    root = heads.find((s) => dirOf(s.path) === folder) ?? heads[0] ?? sheets[0]
    if (heads.length > 1) notes.push(`There are ${heads.length} schematics that no other sheet uses; ${root.path} was taken as the root.`)
  }
  const rules = dru.find((d) => dirOf(d.path) === dirOf(board?.path ?? "")) ?? dru[0]
  // A KiCad 5 schematic is read with the libraries beside it: every file of the project goes to the reader.
  return { board, pro, proIsLegacy: !!pro && legacy && !pros.length, root, rules, legacy, sheets: new Map((legacy ? all : [...sheets, ...all.filter((f) => /(^|\/)sym-lib-table$/i.test(f.path) || /\.(kicad_sym|lib)$/i.test(f.path))]).map((s) => [s.path, s.data] as const)), all, notes }
}

const AUTO_NET = /^(?:Net-\(|unconnected-\()/

/**
 * Compares every pad's board net with its pin's net in the schematic: the pads that disagree, by part
 * and pin. A pad's pin is on the symbol linked to its footprint, or on another unit of the same part.
 * Two pads agree when the same pads are on their nets on both sides, and when a net the user named
 * has the same name.
 */
function compareNets(project: Project, pairs: { fp: KicadFootprint; components: ComponentInstance[] }[]): NetDifference[] {
  const { nets, pinNet } = computeConnectivity(project)
  const netName = new Map(nets.map((n) => [n.id, n]))
  // How many pins of any part are on each net, power ports and parts with no footprint included.
  const pinCount = new Map<string, number>()
  for (const id of pinNet.values()) pinCount.set(id, (pinCount.get(id) ?? 0) + 1)
  const key = (componentId: string, pad: string) => `${componentId}\u0000${pad}`
  type PadFact = { component: ComponentInstance; pad: string; boardNet: string | null; schematic: ReturnType<typeof netName.get> | undefined; hasPin: boolean }
  const facts: PadFact[] = []
  for (const { fp, components } of pairs) {
    // Pads of one number are one pin: if they disagree among themselves, the board's own import says so and they are left out here.
    const nets = new Map<string, Set<string | null>>()
    for (const p of fp.pads) (nets.get(p.number) ?? nets.set(p.number, new Set()).get(p.number)!).add(p.netRaw)
    const seen = new Set<string>()
    for (const p of fp.pads) {
      if (!p.number || p.type === "np_thru_hole" || seen.has(p.number) || (nets.get(p.number)?.size ?? 0) > 1) continue
      seen.add(p.number)
      const raw = p.netRaw && !/^$/.test(p.netRaw) ? p.netRaw : null
      const owner = components.find((c) => findPart(c.partId)?.pins.some((q) => q.number === p.number))
      const component = owner ?? components[0]
      const id = owner ? pinNet.get(pinKey(owner.id, p.number)) : undefined
      const net = id ? netName.get(id) : undefined
      // A net of one pin that no label or power port names is no net: the pin is unconnected.
      const real = net && (net.named || (pinCount.get(net.id) ?? 0) > 1) ? net : undefined
      facts.push({ component, pad: p.number, boardNet: raw && !/^unconnected-\(/.test(raw) ? raw : null, schematic: real, hasPin: !!owner })
    }
  }
  // The pads on each net, on both sides, so a pad's neighbours can be compared.
  const boardMembers = new Map<string, string[]>()
  const schMembers = new Map<string, string[]>()
  for (const f of facts) {
    if (!f.hasPin) continue
    if (f.boardNet) (boardMembers.get(f.boardNet) ?? boardMembers.set(f.boardNet, []).get(f.boardNet)!).push(key(f.component.id, f.pad))
    if (f.schematic) (schMembers.get(f.schematic.id) ?? schMembers.set(f.schematic.id, []).get(f.schematic.id)!).push(key(f.component.id, f.pad))
  }
  // What each pad's net is called on the other side, so a refusal can name the two real names (`GND` and `gnd`) and not one twice.
  const schNameOf = new Map<string, string>()
  const boardNameOf = new Map<string, string>()
  for (const f of facts) {
    if (!f.hasPin) continue
    if (f.schematic) schNameOf.set(key(f.component.id, f.pad), f.schematic.name)
    if (f.boardNet) boardNameOf.set(key(f.component.id, f.pad), decodeNetName(f.boardNet))
  }
  const namesOf = (members: string[] | undefined, of: Map<string, string>) => [...new Set((members ?? []).map((m) => of.get(m)).filter((n): n is string => !!n))].sort()
  const sig = (list: string[] | undefined, self: string) => (list && list.length ? [...list].sort().join("\u0001") : self)
  const out: NetDifference[] = []
  for (const f of facts) {
    const ref = f.component.ref
    const boardName = f.boardNet ? decodeNetName(f.boardNet) : null
    if (!f.hasPin) {
      // A pad the symbol has no pin for: a difference only when the board gives it a net.
      if (boardName) out.push({ ref, pin: f.pad, board: boardName, schematic: null, why: `${ref} pad ${f.pad}: the board puts it on ${boardName}, but the symbol has no pin ${f.pad}. The board has not been updated from its schematic.` })
      continue
    }
    const self = key(f.component.id, f.pad)
    const b = sig(f.boardNet ? boardMembers.get(f.boardNet) : undefined, self)
    const s = sig(f.schematic ? schMembers.get(f.schematic.id) : undefined, self)
    const schName = f.schematic ? f.schematic.name : null
    if (b !== s) {
      // Where one net on a side is several on the other, say which: `GND` on the board is `GND` and `gnd` in the schematic.
      const inSchematic = namesOf(f.boardNet ? boardMembers.get(f.boardNet) : undefined, schNameOf)
      const onBoard = namesOf(f.schematic ? schMembers.get(f.schematic.id) : undefined, boardNameOf)
      const spans = [
        boardName && inSchematic.length > 1 ? ` The board net ${boardName} is ${inSchematic.join(" and ")} in the schematic.` : "",
        schName && onBoard.length > 1 ? ` The schematic net ${schName} is ${onBoard.join(" and ")} on the board.` : "",
      ].join("")
      out.push({ ref, pin: f.pad, board: boardName, schematic: schName, why: `${ref} pin ${f.pad}: the board puts it ${boardName ? `on ${boardName}` : "on no net"}, the schematic ${schName ? `on ${schName}` : "on no net"}.${spans} The board has not been updated from its schematic.` })
      continue
    }
    // The same pads on both sides: a name the user gave must agree too, as KiCad writes it (`/NAME` for a local label). A name KiCad made up (`Net-(R1-Pad2)`) depends on the release that wrote the board, so it is not compared.
    if (f.schematic?.named && boardName && !AUTO_NET.test(boardName) && boardName !== f.schematic.name) {
      out.push({ ref, pin: f.pad, board: boardName, schematic: schName, why: `${ref} pin ${f.pad}: the net is called ${boardName} on the board and ${schName} in the schematic. The board has not been updated from its schematic.`, nameOnly: true })
    }
  }
  return out
}

/** The report's one line for nets the board and the schematic name differently with the same pins on each, every net in `items`. */
export function netNamesEntry(renamed: NetDifference[]): ReportEntry {
  const nets = new Map<string, { board: string; schematic: string; pins: string[] }>()
  for (const d of renamed) {
    const k = `${d.board}\u0001${d.schematic}`
    const net = nets.get(k) ?? nets.set(k, { board: d.board ?? "", schematic: d.schematic ?? "", pins: [] }).get(k)!
    net.pins.push(`${d.ref}.${d.pin}`)
  }
  const list = [...nets.values()]
  // The usual case: a board written without the sheet path a local label's name has in KiCad (`S5` on the board, `/S5` in the schematic).
  const sheetPathOnly = list.every((n) => n.schematic.replace(/^\/+/, "") === n.board.replace(/^\/+/, ""))
  const example = list[0]
  const why = sheetPathOnly
    ? `The board names these nets without the sheet path the schematic gives them (${example.board} on the board, ${example.schematic} in the schematic). The same pins are on each net on both sides, so nothing is connected differently; the board has not been updated from its schematic.`
    : `The board and the schematic name these nets differently (${example.board} on the board, ${example.schematic} in the schematic). The same pins are on each net on both sides, so nothing is connected differently; the board has not been updated from its schematic.`
  return {
    code: "board-net-names-differ",
    severity: "changed",
    object: `${list.length} net${list.length > 1 ? "s" : ""} named differently on the board (${renamed.length} pin${renamed.length > 1 ? "s" : ""})`,
    why,
    count: list.length,
    items: list.map((n) => `${n.board} on the board, ${n.schematic} in the schematic: ${n.pins.join(", ")}`),
  }
}

/**
 * What the project file and the rules file say that the project does not hold, once the project file's net classes and design rules are in
 * (`applyProRules`): the settings the editor has no field for, and the custom rules of a `.kicad_dru`, which the editor does not apply.
 */
function noteRulesLeft(report: ImportReport, pro: KicadPro | null, rules: KicadRules | null, legacyPro: boolean) {
  if (pro && !legacyPro) {
    const lost = lostRuleSettings(pro)
    if (lost.length) {
      report.entries.push({
        code: "rules-not-brought",
        severity: "note",
        object: "design settings with no counterpart",
        why: `The project file sets ${lost.slice(0, 4).join(", ")}${lost.length > 4 ? ", ..." : ""}, which the editor has no setting for, so the project keeps its own.`,
        count: lost.length,
      })
    }
  }
  if (rules && rules.rules.length) {
    report.entries.push({
      code: "custom-rules-not-applied",
      severity: "note",
      object: `${rules.rules.length} custom design rule${rules.rules.length > 1 ? "s" : ""} (.kicad_dru)`,
      why: `The rules file is read and every rule is accounted for (${rules.rules.slice(0, 3).map((r) => JSON.stringify(r.name)).join(", ")}${rules.rules.length > 3 ? ", ..." : ""}), but the editor has no language for custom rules, so Checks do not apply them. KiCad would.`,
      count: rules.rules.length,
    })
  }
}

/** The labels the board's nets have in the project, as the board builder makes them. */
function boardNetLabels(board: KicadBoard): Map<string, string> {
  const all = new Set<string>()
  for (const f of board.footprints) for (const p of f.pads) if (p.netRaw) all.add(p.netRaw)
  for (const o of [...board.segments, ...board.arcTracks, ...board.vias, ...board.shapes, ...board.footprints.flatMap((f) => f.shapes), ...board.zones]) if (o.netRaw) all.add(o.netRaw)
  return netLabelNames(new Map(), { entries: [], account: null }, all)
}

/** The board as the board builder makes it with every approximation allowed: for measurement only. */
function importBoardLossy(data: string | Uint8Array, options: ProjectImportOptions): KicadImportResult {
  let read
  try {
    read = readKicadBoard(data)
  } catch (e) {
    const message = e instanceof KicadReadError ? e.message : `The file could not be read: ${e instanceof Error ? e.message : String(e)}`
    return { status: "refused", reason: "unreadable", message, report: { entries: [{ code: "unreadable", severity: "refused", object: "the file", why: message }], account: null }, needs: [], board: null }
  }
  const outline = outlineOf(read.board)
  const result = buildKicadProject(read.board, outline, read.report, { name: options.name, source: options.source, allowLossy: true, models: options.models })
  return { status: "imported", project: result.project, report: read.report, board: read.board, bytes: byteLength(serializeProject(result.project)), files: result.files, footprintComponents: result.footprintComponents }
}

/** Imports a KiCad project from its files. Never throws for a file: what cannot be imported is a refusal with its report. */
export function importKicadProject(files: ProjectFile[], options: ProjectImportOptions = {}): KicadProjectResult {
  const built = options.built ?? new Set([...BOARD_BUILT, ...SCHEMATIC_BUILT])
  const picked = pickProjectFiles(files)
  const report: ImportReport = { entries: [], account: null }
  // The board importer registers the board's parts in memory; a project that is refused after it takes them out again.
  let boardParts: string[] = []
  const refuse = (reason: Extract<KicadProjectResult, { status: "refused" }>["reason"], message: string, needs: Need[] = [], boardAloneImports = false): KicadProjectResult => {
    for (const id of boardParts) unregisterPart(id)
    boardParts = []
    if (boardAloneImports) report.entries.push({ code: "board-alone-imports", severity: "note", object: "the .kicad_pcb", why: "Importing the .kicad_pcb alone gives the board with a schematic generated from its nets." })
    return { status: "refused", reason, message, report, needs, boardAloneImports }
  }
  for (const n of picked.notes) report.entries.push({ code: "choice", severity: "note", object: "the files", why: n })
  if (!picked.board) return refuse("no-board", "This project has no board (.kicad_pcb). A schematic alone can be imported by itself.")

  // ---------- the project file and the rules ----------
  let pro: KicadPro | null = null
  let rules: KicadRules | null = null
  let proNeeds: Need[] = []
  let proAccount: NodeAccount | null = null
  let rulesAccount: NodeAccount | null = null
  if (picked.pro && picked.proIsLegacy) {
    // A KiCad 5 `.pro`: an ini file. Its library list is read again by the schematic's reader, from the files; here it is accounted for and its design settings judged as a `.kicad_pro`'s are.
    try {
      const read = readLegacyPro(picked.pro.data)
      pro = read.legacy.pro
      for (const why of read.notes) report.entries.push({ code: "encoding", severity: "note", object: picked.pro.path, why })
      const account = accountLegacyPro(read.legacy)
      proAccount = account
      reportUnknownLegacyPro(account, report, picked.pro.path)
      proNeeds = projectNeeds(read.legacy.pro, null)
    } catch (e) {
      if (!(e instanceof LegacyProFileError)) throw e
      report.entries.push({ code: e.code, severity: "refused", object: picked.pro.path, why: e.message })
      return refuse("unreadable", `${picked.pro.path}: ${e.message}`)
    }
  } else if (picked.pro) {
    try {
      const read = readKicadPro(picked.pro.data)
      pro = read.pro
      for (const why of read.notes) report.entries.push({ code: "encoding", severity: "note", object: picked.pro.path, why })
      const account = accountPro(read.pro.json)
      proAccount = account
      reportUnknownPro(account, report, picked.pro.path)
      proNeeds = projectNeeds(read.pro, null)
    } catch (e) {
      if (!(e instanceof KicadProjectFileError)) throw e
      report.entries.push({ code: e.code, severity: "refused", object: picked.pro.path, why: e.message })
      return refuse("unreadable", `${picked.pro.path}: ${e.message}`)
    }
  }
  if (picked.rules) {
    try {
      const read = readKicadRules(picked.rules.data)
      rules = read.rules
      const account = accountRules(read.rules.tree)
      rulesAccount = account
      reportUnknownRules(account, report, picked.rules.path)
      proNeeds = [...proNeeds, ...projectNeeds(null, read.rules)].filter((n, i, all) => all.findIndex((m) => m.ext === n.ext) === i)
    } catch (e) {
      if (!(e instanceof KicadRulesFileError)) throw e
      report.entries.push({ code: e.code, severity: "refused", object: picked.rules.path, why: e.message })
      return refuse("unreadable", `${picked.rules.path}: ${e.message}`)
    }
  }
  const unknownKeys = report.entries.filter((e) => e.code === "unknown-key" || (e.code === "unknown-node" && /design rules file/.test(e.why)))
  if (unknownKeys.length) return refuse("unknown", `This project's settings have ${unknownKeys.length === 1 ? "something" : "things"} this importer does not know yet: ${unknownKeys.slice(0, 3).map((e) => e.object).join(", ")}${unknownKeys.length > 3 ? " and more" : ""}.`)

  // ---------- the board ----------
  const partsBefore = new Set(projectPartIds())
  const boardResult = options.allowLossyBoard ? importBoardLossy(picked.board.data, options) : importKicadBoard(picked.board.data, { name: options.name, source: options.source, built, limitBytes: options.limitBytes, signFills: false, models: options.models })
  // The board importer notes that KiCad 6's rules live in a project file it did not read; the project file was read here, and says its own.
  report.entries.push(...boardResult.report.entries.filter((e) => !((pro || rules) && e.code === "rules-in-project-file")))
  boardParts = projectPartIds().filter((id) => !partsBefore.has(id))
  if (boardResult.status === "refused") return refuse(boardResult.reason, boardResult.message, boardResult.needs)
  const kicadBoard = boardResult.board

  // ---------- the schematic ----------
  if (!picked.root) {
    report.entries.push({ code: "no-schematic", severity: "note", object: "the project", why: "There is no schematic among the files, so the board came with a schematic generated from its nets." })
    report.account = boardResult.report.account
    // X20: the class rules of the project file, worked out for the footprints.
    const classed = applyClassRules(pro, boardResult.project.components)
    report.entries.push(...classed.entries)
    let boardProject = classed.components === boardResult.project.components ? boardResult.project : { ...boardResult.project, components: classed.components }
    noteRulesLeft(report, pro, rules, !!picked.proIsLegacy)
    if (pro && !picked.proIsLegacy) {
      const withRules = applyProRules(boardProject, pro, kicadBoard, boardNetLabels(kicadBoard), report)
      if (withRules.problems.length) return refuse("inexact", `The project file's net classes cannot be brought in exactly: ${withRules.problems.slice(0, 3).join("; ")}${withRules.problems.length > 3 ? "; ..." : ""}. Nothing is guessed, so the project is not imported.`)
      boardProject = withRules.project
    }
    boardProject = signKeptFills(carryProjectFiles(boardProject, picked, pro, report))
    if (hasKeptFills(boardProject) && byteLength(serializeProject(boardProject)) > (options.limitBytes ?? PROJECT_SIZE_LIMIT_BYTES)) boardProject = dropKeptFills(boardProject, report)
    return { status: "imported", project: boardProject, report, differences: [], link: null, board: kicadBoard, tree: null, pro, rules, accounts: { board: boardResult.report.account, schematic: null, pro: proAccount, rules: rulesAccount }, bytes: boardResult.bytes, files: boardResult.files }
  }
  const gated = gateSchematic({ files: picked.sheets, root: picked.root.path }, { built, name: options.name, source: options.source, limitBytes: options.limitBytes, databaseSymbols: options.databaseSymbols })
  const boardAlone = "importing the .kicad_pcb alone gives the board with a schematic generated from its nets"
  if ("refused" in gated) {
    report.entries.push(...gated.refused.report.entries)
    return refuse(gated.refused.reason, `${gated.refused.message} The project is not imported; ${boardAlone}.`, gated.refused.needs, true)
  }
  const { gate } = gated
  report.entries.push(...gate.report.entries)
  const missingPro = unbuilt(proNeeds, built)
  if (missingPro.length) {
    for (const n of missingPro) report.entries.push({ code: "unsupported", severity: "refused", object: NAMES[n.ext] ?? n.ext, why: `${n.why} (${n.ext}); the editor cannot hold it yet.` })
    return refuse("unsupported", `${refusalMessage(missingPro, "This project's settings use", NAMES)} The project is not imported; ${boardAlone}.`, missingPro, true)
  }
  noteRulesLeft(report, pro, rules, !!picked.proIsLegacy)

  // The footprints of the board, linked to the symbols of the schematic.
  const link = linkFootprints(gate.tree, kicadBoard.footprints.map((f) => ({ ref: f.ref, path: f.path })))
  // The board builder says which component each footprint became (every footprint is one, a padless logo too), so nothing is guessed from a reference and a place.
  const byId = new Map(boardResult.project.components.map((c) => [c.id, c]))
  const componentOf = new Map<number, ComponentInstance>([...boardResult.footprintComponents].flatMap(([i, id]) => (byId.has(id) ? [[i, byId.get(id)!] as const] : [])))
  const symbolFootprint = new Map<SymbolRecord, { land: string; pcb: ComponentInstance["pcb"]; index: number }>()
  const notOnBoardNote = (ref: string, via: string) => ({ code: "symbol-not-on-board", severity: "note" as const, object: `${ref || "a symbol"}`, why: `${via} marks ${ref || "this symbol"} as not on the board, but the board has its footprint. The footprint is kept as a part of the board, not linked to the symbol.` })
  for (const l of link.links) {
    if (!l.record) continue
    const c = componentOf.get(l.footprint)
    // One footprint belongs to one symbol: the other symbols of its unit group have none.
    // A symbol marked not on the board has no footprint (S7): the board's footprint, if it has one, stays a part of the board with its own nets.
    if (c && l.record.symbol.onBoard === false) {
      report.entries.push(notOnBoardNote(l.record.reference, "The schematic"))
      continue
    }
    if (c && !symbolFootprint.has(l.record)) symbolFootprint.set(l.record, { land: c.footprint, pcb: c.pcb, index: l.footprint })
  }
  const buildOptions = { name: options.name, source: options.source, built, busAliases: proBusAliases(pro), variants: proVariants(pro), footprintFor: (r: SymbolRecord) => symbolFootprint.get(r) }
  const entriesBeforeBuild = gate.report.entries.length
  let sch = buildSchematicProject(gate.tree, gate.report, buildOptions)
  // A symbol a rule area, a sheet symbol or the active variant takes off the board is not on it either, whichever way the flag arrives: its footprint is kept as a part of the board, as for the symbol's own flag.
  // (The resolved flags are known only from the built schematic, so a build that finds such a symbol is thrown away and made again without that link.)
  const takenOff = [...symbolFootprint.keys()].flatMap((r) => {
    const c = sch.byRecord.get(r)
    const resolved = c ? resolvedComponents(sch.project).find((x) => x.id === c.id) : undefined
    return c && resolved?.flags?.notOnBoard ? [{ record: r, via: flagOrigins(sch.project, c).notOnBoard } as const] : []
  })
  if (takenOff.length) {
    releaseBuild(sch)
    gate.report.entries.length = entriesBeforeBuild
    for (const { record, via } of takenOff) {
      symbolFootprint.delete(record)
      report.entries.push(notOnBoardNote(record.reference, via === "rule area" ? "A rule area of the schematic" : via === "sheet" ? "The sheet symbol the symbol is on" : "The active variant"))
    }
    sch = buildSchematicProject(gate.tree, gate.report, buildOptions)
  }
  const finished = finishSchematic(gate, sch, { limitBytes: options.limitBytes, built })
  if (finished.status === "refused") {
    report.entries.push(...gate.report.entries.filter((e) => !report.entries.includes(e)))
    return refuse(finished.reason, `${finished.message} The project is not imported; ${boardAlone}.`, finished.needs, true)
  }
  // What the build and the last checks added to the schematic's report is the project's too.
  report.entries.push(...gate.report.entries.filter((e) => !report.entries.includes(e)))
  // From here the build's parts, and later the board's, are registered; a refusal takes them out again.
  const lateParts: string[] = []
  const refuseBuilt: typeof refuse = (...args) => {
    releaseBuild(sch)
    for (const id of lateParts) unregisterPart(id)
    return refuse(...args)
  }

  // ---------- one project: the board's copper and lands, the schematic's parts, wires and labels ----------
  const merged = mergeProjects(boardResult.project, sch, link, componentOf, symbolFootprint, kicadBoard, report)
  // A symbol that is no power symbol but has a hidden power-input pin names its net by that pin; the export writes it as the power symbol it acts as.
  const hiddenPowers = merged.project.components.filter((c) => {
    const part = findPart(c.partId)
    return !!part && !part.powerNet && !isSchematicPart(part) && schematicPins(c, part).some((p) => p.hidden && p.type === "power_in" && p.name.trim())
  })
  if (hiddenPowers.length) {
    report.entries.push({ code: "hidden-power-symbol", severity: "changed", object: `${hiddenPowers.length} symbol${hiddenPowers.length > 1 ? "s" : ""} with a hidden power pin and no power flag (${[...new Set(hiddenPowers.map((c) => c.ref))].slice(0, 4).join(", ")}${hiddenPowers.length > 4 ? ", ..." : ""})`, why: "Each names its net by its hidden pin. The export writes it as a power symbol of that net, so the net and the wires keep their meaning; KiCad's own Electrical Rules Check may report the power input as not driven.", count: hiddenPowers.length })
  }
  // The corner mounting holes the editor wrote (four marked footprints) are the board's own setting again.
  const holes = restoreMountingHoles(merged.project, merged.loose.filter((l) => isMarkedHole(l.fp)))
  if (holes.restored.size) {
    merged.project = holes.project
    merged.loose = merged.loose.filter((l) => !holes.restored.has(l.fp))
    report.entries.push({ code: "mounting-holes", severity: "note", object: "the board's 4 corner mounting holes", why: "They are the board's own mounting holes again, as the editor writes them, and not four parts." })
  }
  // X10: the project file's net classes and design rules, before the classes the schematic's labels give.
  if (pro && !picked.proIsLegacy) {
    const withRules = applyProRules(merged.project, pro, kicadBoard, boardNetLabels(kicadBoard), report)
    if (withRules.problems.length) return refuseBuilt("inexact", `The project file's net classes cannot be brought in exactly: ${withRules.problems.slice(0, 3).join("; ")}${withRules.problems.length > 3 ? "; ..." : ""}. Nothing is guessed, so the project is not imported.`, [], true)
    merged.project = withRules.project
  }
  // S8: the net classes the schematic's labels give, on top of the project file's.
  merged.project = settleImportedLabelClasses(merged.project, report)
  // X20: the class rules of the project file, worked out for the footprints.
  const classed = applyClassRules(pro, merged.project.components)
  report.entries.push(...classed.entries)
  if (classed.components !== merged.project.components) merged.project = { ...merged.project, components: classed.components }
  reportRuleAreaUnits(merged.project, report)
  lateParts.push(...(merged.project.parts ?? []).filter((p) => !isRegistered(p.id)).map((p) => p.id))
  registerProjectParts(merged.project)
  const pairs = link.links.flatMap((l) => {
    const rec = l.record
    if (!rec) return []
    const c = sch.byRecord.get(rec)
    const owner = symbolFootprint.get(rec)
    if (!c || !owner || owner.index !== l.footprint) return []
    // The other units of the part are components too: a pad may be a pin of any of them.
    const units = l.units.map((u) => sch.byRecord.get(u)).filter((x): x is ComponentInstance => !!x)
    return [{ fp: kicadBoard.footprints[l.footprint], components: [c, ...units.filter((x) => x !== c)] }]
  })
  // Every other footprint is a part of the board with its own nets, labelled as the board's generated schematic labels them: its pads are compared too.
  for (const { fp, component } of merged.loose) pairs.push({ fp, components: [component] })
  const differences = compareNets(merged.project, pairs)
  // A pad alone on a net of the board (`unconnected-(R1-Pad2)`) is on no net of the project: it keeps its net's name, for the export to write back.
  merged.project = withLoneNets(merged.project, pairs)
  // A symbol taken from a library of a KiCad 5 project, not from the schematic's cache, may have other pin numbers than the drawing the wires were made for: a renumbered part shows as a pad whose net is not its pin's, and the difference says where the symbol came from.
  const fromLibrary = new Map(librarySymbols(gate.tree).map((s) => [symbolRef(s), s] as const))
  for (const d of differences) {
    if (d.nameOnly) continue
    const lib = fromLibrary.get(d.ref)
    if (lib) d.why += ` The symbol ${d.ref} comes from a library of the project, not from the drawing the sheet was saved with, so its pin numbers may differ from the ones its wires were drawn to.`
    report.entries.push({ code: "board-differs-from-schematic", severity: "changed", object: `${d.ref} pin ${d.pin}`, why: d.why })
  }
  // Names alone are one line: the pins are wired the same on both sides, so a pin by pin list (67 lines on a board an older export wrote) says one thing many times.
  const renamed = differences.filter((d) => d.nameOnly)
  if (renamed.length) report.entries.push(netNamesEntry(renamed))
  const covered = new Set<object>()
  for (const l of link.links) {
    if (!l.record || !sch.byRecord.has(l.record)) continue
    const owner = symbolFootprint.get(l.record)
    if (!owner || owner.index !== l.footprint) continue
    covered.add(l.record.symbol)
    for (const u of l.units) covered.add(u.symbol)
  }
  const libraryWarnings = legacyWarnings(gate.tree, covered)
  if (libraryWarnings.length) report.warnings = libraryWarnings
  reportLinks(report, link, kicadBoard, sch, symbolFootprint, holes.restored)

  merged.project = signKeptFills(carryProjectFiles(merged.project, picked, pro, report))
  let bytes = byteLength(serializeProject(merged.project))
  const limit = options.limitBytes ?? PROJECT_SIZE_LIMIT_BYTES
  if (bytes > limit && hasKeptFills(merged.project)) {
    merged.project = dropKeptFills(merged.project, report)
    bytes = byteLength(serializeProject(merged.project))
  }
  if (bytes > limit) {
    const message = `This project needs ${formatSize(bytes)} and projects hold up to ${formatSize(limit)}.`
    report.entries.push({ code: "too-large", severity: "refused", object: "the project", why: message })
    return refuseBuilt("too-large", message)
  }
  if (refusals(report).length) return refuseBuilt("inexact", refusals(report)[0].why)
  report.account = gate.report.account
  return { status: "imported", project: merged.project, report, differences, link, board: kicadBoard, tree: gate.tree, pro, rules, accounts: { board: boardResult.report.account, schematic: gate.report.account, pro: proAccount, rules: rulesAccount }, bytes, files: boardResult.files }
}

/** The nets a board gave pads that no net of the project holds, by part and pin (`ComponentInstance.loneNets`). */
function withLoneNets(project: Project, pairs: { fp: KicadFootprint; components: ComponentInstance[] }[]): Project {
  const { nets, pinNet } = computeConnectivity(project)
  const count = new Map<string, number>()
  for (const id of pinNet.values()) count.set(id, (count.get(id) ?? 0) + 1)
  const named = new Map(nets.map((n) => [n.id, n.named]))
  const lone = new Map<string, Record<string, string>>()
  for (const { fp, components } of pairs) {
    for (const p of fp.pads) {
      if (!p.number || p.type === "np_thru_hole" || !p.netRaw) continue
      const owner = components.find((c) => findPart(c.partId)?.pins.some((q) => q.number === p.number)) ?? components[0]
      const id = pinNet.get(pinKey(owner.id, p.number))
      // on a net of the project that has other pins, or a name of its own: it is on that net
      if (id && ((count.get(id) ?? 0) > 1 || named.get(id))) continue
      ;(lone.get(owner.id) ?? lone.set(owner.id, {}).get(owner.id)!)[p.number] = p.netRaw
    }
  }
  return lone.size ? { ...project, components: project.components.map((c) => (lone.has(c.id) ? { ...c, loneNets: { ...c.loneNets, ...lone.get(c.id) } } : c)) } : project
}

/** The most of a project file or rules file the project keeps for the export (the project holds up to 900 KB in all). */
const CARRIED_FILE_LIMIT = 200 * 1024

/**
 * The project file's settings and the custom rules file, kept as the files had them for the export (`KicadCarry`): the editor holds the net classes and the design rules it models and the export
 * writes those from the project, over the rest, which it writes back unchanged (the severities of each check, the default sizes the router offers, the text sizes of a new item, the BOM and ERC settings...).
 */
function carryProjectFiles(project: Project, picked: { pro?: { data: string | Uint8Array } | null; proIsLegacy?: boolean; rules?: { data: string | Uint8Array } | null }, pro: KicadPro | null, report: ImportReport): Project {
  const kicad: NonNullable<Project["kicad"]> = { ...project.kicad }
  const text = (data: string | Uint8Array) => (typeof data === "string" ? data : new TextDecoder().decode(data)).replace(/^﻿/, "")
  if (pro && !picked.proIsLegacy) {
    const json = JSON.stringify(pro.json)
    if (json.length <= CARRIED_FILE_LIMIT) {
      kicad.pro = json
      const r = project.rules
      kicad.proRules = { minClearance: r.minClearance ?? null, minTraceWidth: r.minTraceWidth, minDrill: r.minDrill, minViaDiameter: r.minViaDiameter ?? null, minAnnularRing: r.minAnnularRing, holeClearance: r.holeClearance, edgeClearance: r.edgeClearance, clearance: r.clearance }
    }
    else report.entries.push({ code: "pro-too-large-to-keep", severity: "not-brought", object: "the project file's settings", why: `The project file is ${Math.round(json.length / 1024)} KB, more than the ${CARRIED_FILE_LIMIT / 1024} KB the project keeps for the export, so the settings the editor has no field for are not written back.` })
  }
  if (picked.rules) {
    const body = text(picked.rules.data)
    if (body.length <= CARRIED_FILE_LIMIT) kicad.dru = body
    else report.entries.push({ code: "dru-too-large-to-keep", severity: "not-brought", object: "the custom rules file", why: `The rules file is ${Math.round(body.length / 1024)} KB, more than the ${CARRIED_FILE_LIMIT / 1024} KB the project keeps for the export, so it is not written back.` })
  }
  return Object.keys(kicad).length ? { ...project, kicad } : project
}

/** S9: the variants the project file lists (`schematic.variants`: a name and, in newer files, a description each). */
function proVariants(pro: KicadPro | null): { name: string; description?: string }[] {
  const list = ((pro?.json.schematic ?? {}) as { variants?: unknown }).variants
  if (!Array.isArray(list)) return []
  return list.flatMap((v) => {
    const name = (v as { name?: unknown } | null)?.name
    const description = (v as { description?: unknown } | null)?.description
    return typeof name === "string" && name.trim() ? [{ name, ...(typeof description === "string" && description ? { description } : {}) }] : []
  })
}

/** What the project file and the rules file need that is not built: customised net classes, assignments, patterns and rules, and anything of the schematic's settings that is more than empty. */
export function projectNeeds(pro: KicadPro | null, rules: KicadRules | null): Need[] {
  const out: Need[] = []
  const need = (ext: string, why: string) => out.push({ ext, why, source: "importer" })
  if (pro) {
    const custom = pro.netClasses.filter((c) => c.name !== "Default")
    if (custom.length) need("X10", `${custom.length} net class${custom.length > 1 ? "es" : ""} besides the default (${custom.slice(0, 3).map((c) => c.name).join(", ")})`)
    else if (Object.keys(pro.netclassAssignments).length || pro.netclassPatterns.length) need("X10", "nets assigned to net classes")
    else if (pro.netClasses.some((c) => Array.isArray(c.json.nets) && c.json.nets.length)) need("X10", "nets listed in a net class")
    // The Default class, the design rules, the sizes KiCad offers and new items get: what differs from what the editor's project has is X10's.
    for (const why of designSettingsNeeds(pro.json)) need("X10", why)
    const j = pro.json
    const schematic = (j.schematic ?? {}) as Record<string, unknown>
    const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "object" && v !== null ? Object.keys(v).length > 0 : false)
    if (nonEmpty(schematic.variants)) need("S9", "schematic variants in the project file")
    // One top level sheet is the root the importer already picks; several are KiCad 10's virtual root, which the sheet tree does not have yet.
    if (Array.isArray(schematic.top_level_sheets) && schematic.top_level_sheets.length > 1) need("S1T", "several top level sheets")
    if (Object.keys(pro.textVariables).length) need("S4", "text variables")
    // X20 is built: the class rules are worked out (`classRules.ts`) or reported one by one; only the tuning profiles are still pending.
    const tuning = j.tuning_profiles as Record<string, unknown> | undefined
    if (tuning && nonEmpty((tuning as { tuning_profiles_impedance_geometric?: unknown }).tuning_profiles_impedance_geometric)) need("X21", "tuning profiles")
  }
  if (rules && rules.rules.length) need("X10", `${rules.rules.length} custom design rule${rules.rules.length > 1 ? "s" : ""}`)
  // One need per extension, with every reason.
  const merged = new Map<string, Need>()
  for (const n of out) {
    const had = merged.get(n.ext)
    merged.set(n.ext, had ? { ...had, why: `${had.why}; ${n.why}` } : n)
  }
  return [...merged.values()]
}

function reportLinks(report: ImportReport, link: LinkResult, board: KicadBoard, sch: SchematicBuild, symbolFootprint: Map<object, unknown>, restored: ReadonlySet<KicadFootprint> = new Set()) {
  const c = link.counts
  report.entries.push({
    code: "footprint-links",
    severity: "note",
    object: "the footprints",
    why: `${c.path + c.timestamp} of ${c.footprints} footprints were linked to their symbol by path, ${c.reference} by reference designator, and ${c.none} have no symbol${c.none ? ` (${c.noneNoPath} placed by hand with no link, ${c.noneWithPath} with a link to a symbol that is not in the schematic)` : ""}.`,
    count: c.footprints,
  })
  const loose = link.links.filter((l) => !l.record && !/\*/.test(l.ref) && !restored.has(board.footprints[l.footprint]))
  if (loose.length) {
    report.entries.push({ code: "footprint-without-symbol", severity: "note", object: `${loose.length} footprint${loose.length > 1 ? "s" : ""} (${loose.slice(0, 5).map((l) => l.ref || "(no reference)").join(", ")}${loose.length > 5 ? ", ..." : ""})`, why: "No symbol in the schematic claims them. They stay parts with a footprint and no symbol: mounting holes, logos, or parts the schematic no longer has. The export writes the schematic with a generated symbol for each one that is not a mounting hole, so KiCad's netlist and BOM list them and its \"Update PCB from Schematic\" finds them.", count: loose.length })
  }
  const unplaced = [...sch.byRecord].filter(([r, comp]) => !symbolFootprint.has(r) && comp.footprint === "" && r.symbol.props.some((p) => p.name === "Footprint" && p.value !== ""))
  if (unplaced.length) {
    report.entries.push({ code: "symbol-without-footprint", severity: "note", object: `${unplaced.length} symbol${unplaced.length > 1 ? "s" : ""} (${unplaced.slice(0, 5).map(([, c]) => c.ref).join(", ")}${unplaced.length > 5 ? ", ..." : ""})`, why: "The schematic gives these a footprint, but the board has no footprint linked to them: they are parts of the schematic that are not on the board.", count: unplaced.length })
  }
  void board
}

/**
 * Parts with no symbol: each keeps its board nets, as the board's generated schematic gives them (a stub
 * and a label of the net's name on every connected pad), and the parts are packed in rows below the
 * schematic with room for their symbols and labels, so no pin of one touches another. A net that also has linked
 * pads is labelled with the name the schematic gives it (`rename`: the board's `/MID` is the schematic's `MID`),
 * so a loose pad is on the same net in the schematic as on the board.
 */
function placeLoose(project: Project, parts: { c: ComponentInstance; fp: KicadFootprint }[], rename: ReadonlyMap<string, string>, kindOf: ReadonlyMap<string, "local" | "global">, report: ImportReport): { components: ComponentInstance[]; wires: Wire[]; labels: NetLabel[] } {
  const padNets = new Map<string, Map<string, string>>()
  for (const { c, fp } of parts) {
    const m = new Map<string, string>()
    for (const p of fp.pads) if (p.number && p.type !== "np_thru_hole" && p.netRaw && !m.has(p.number)) m.set(p.number, rename.get(p.netRaw) ?? p.netRaw)
    padNets.set(c.id, m)
  }
  const labelText = netLabelNames(padNets, report)
  const at0 = parts.map(({ c }) => ({ ...c, sch: { x: 0, y: 0, rot: 0 as Rotation } }))
  const margin = 0.4
  const extents = at0.map((c) => {
    const s = schematicBounds(c)
    const b = { minX: s.minX - 0.45, minY: s.minY - 0.25, maxX: s.maxX + 0.45, maxY: s.maxY + 0.25 }
    for (const pin of schematicPins(c)) {
      const net = padNets.get(c.id)?.get(pin.pin)
      if (!net) continue
      const stub = pinStubPoint(pin, SCH_GRID * 3)
      const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
      const l = labelBox({ id: "", name: labelText.get(net) ?? net, x: stub.x, y: stub.y, rot })
      b.minX = Math.min(b.minX, l.minX)
      b.minY = Math.min(b.minY, l.minY)
      b.maxX = Math.max(b.maxX, l.maxX)
      b.maxY = Math.max(b.maxY, l.maxY)
    }
    return b
  })
  // Below everything the root sheet has, from its left edge (the parts with no symbol are placed on the root sheet).
  const rootSheet = sheetView(project, "")
  let top = 0
  let left = 0
  let seen = false
  const grow = (x: number, y: number) => {
    top = seen ? Math.min(top, y) : y
    left = seen ? Math.min(left, x) : x
    seen = true
  }
  for (const c of rootSheet.components) {
    const b = schematicBounds(c)
    grow(b.minX, b.minY)
  }
  for (const w of rootSheet.wires) for (const p of w.points) grow(p.x, p.y)
  for (const l of rootSheet.labels) {
    const b = labelBox(l)
    grow(b.minX, b.minY)
  }
  const total = extents.reduce((a, e) => a + (e.maxX - e.minX + margin) * (e.maxY - e.minY + margin), 0)
  const rowWidth = Math.max(40, Math.sqrt(total) * 1.6)
  let x = 0
  let y = 0
  let rowHeight = 0
  const place: { x: number; y: number }[] = []
  extents.forEach((e) => {
    const w = e.maxX - e.minX + margin
    const h = e.maxY - e.minY + margin
    if (x > 0 && x + w > rowWidth) {
      x = 0
      y -= rowHeight
      rowHeight = 0
    }
    place.push({ x: snap(left + x - e.minX, SCH_GRID), y: snap((seen ? top : 0) - 1 + y - e.maxY, SCH_GRID) })
    x += w
    rowHeight = Math.max(rowHeight, h)
  })
  const components = at0.map((c, i) => ({ ...c, sch: { x: round(place[i].x, 4), y: round(place[i].y, 4), rot: 0 as Rotation } }))
  const wires: Wire[] = []
  const labels: NetLabel[] = []
  for (const c of components) {
    const pins = new Map(schematicPins(c).map((p) => [p.pin, p]))
    for (const [number, net] of padNets.get(c.id) ?? []) {
      const pin = pins.get(number)
      if (!pin) continue
      const stub = pinStubPoint(pin, SCH_GRID * 3)
      const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
      wires.push({ id: uid("w"), points: [pin.pos, stub] })
      const text = labelText.get(net) ?? net
      const kind = project.netNames ? (kindOf.get(text) ?? "global") : undefined
      labels.push({ id: uid("l"), name: text, x: round(stub.x, 4), y: round(stub.y, 4), rot, ...(kind ? { kind, ...(kind === "global" ? { shape: "bidirectional" as const } : {}) } : {}) })
    }
  }
  return { components, wires, labels }
}

/** The board's project with its generated schematic replaced by the real one, and the parts with no symbol kept with their nets. */
function mergeProjects(boardProject: Project, sch: SchematicBuild, link: LinkResult, componentOf: Map<number, ComponentInstance>, symbolFootprint: Map<object, { index: number }>, board: KicadBoard, report: ImportReport): { project: Project; loose: { fp: KicadFootprint; component: ComponentInstance }[] } {
  const linkedBoard = new Set<string>()
  for (const l of link.links) {
    if (!l.record) continue
    const owner = symbolFootprint.get(l.record)
    if (owner && owner.index === l.footprint) {
      const c = componentOf.get(l.footprint)
      if (c) linkedBoard.add(c.id)
    }
  }
  const fpOf = new Map([...componentOf].map(([i, c]) => [c.id, board.footprints[i]]))
  const looseParts = boardProject.components.filter((c) => !linkedBoard.has(c.id) && fpOf.has(c.id)).map((c) => ({ c, fp: fpOf.get(c.id)! }))
  // The schematic's name for each board net that has a linked pad.
  const { nets: schNets, pinNet: schPinNet } = computeConnectivity(sch.project)
  const schName = new Map(schNets.map((n) => [n.id, bareName(n)]))
  // A label that joins a net of the schematic is of the kind that net's own label is (a local label joins by its text); any other is a global one, which names a net exactly as written.
  const kindOf = new Map<string, "local" | "global">(schNets.flatMap((n) => (n.label ? [[n.label.text, n.label.kind === "global" ? "global" : "local"] as const] : [])))
  const rename = new Map<string, string>()
  /** The nets of the schematic that no label or power symbol names and that a loose pad of the board is on: each needs a label of its name on the schematic side, so the pad joins it. */
  const anchored = new Map<string, { name: string; pin: { componentId: string; pin: string } }>()
  const schNetOf = new Map(schNets.map((n) => [n.id, n]))
  for (const l of link.links) {
    if (!l.record) continue
    const owner = symbolFootprint.get(l.record)
    if (!owner || owner.index !== l.footprint) continue
    const comps = [sch.byRecord.get(l.record), ...l.units.map((u) => sch.byRecord.get(u))].filter((x): x is ComponentInstance => !!x)
    for (const pad of board.footprints[l.footprint].pads) {
      if (!pad.number || !pad.netRaw || rename.has(pad.netRaw)) continue
      for (const c of comps) {
        const name = schName.get(schPinNet.get(pinKey(c.id, pad.number)) ?? "")
        if (name) {
          rename.set(pad.netRaw, name)
          const id = schPinNet.get(pinKey(c.id, pad.number)) ?? ""
          const net = schNetOf.get(id)
          if (net && !net.named && !anchored.has(id) && looseParts.some((x) => x.fp.pads.some((q) => q.netRaw === pad.netRaw))) anchored.set(id, { name, pin: { componentId: c.id, pin: pad.number } })
          break
        }
      }
    }
  }
  const anchors = anchorLabels(sch.project, [...anchored.values()])
  const laid = placeLoose(anchors, looseParts, rename, kindOf, report)
  laid.wires.unshift(...anchors.wires.slice(sch.project.wires.length))
  laid.labels.unshift(...anchors.labels.slice(sch.project.labels.length))
  const placed = laid.components
  // Their parts are the board's: keep the specs that loose parts name.
  const used = new Set(placed.map((c) => c.partId))
  // The schematic's parts and the drawings they are drawn from, then the board's parts that loose footprints use.
  const parts = [...(sch.project.parts ?? []), ...(boardProject.parts ?? []).filter((p) => used.has(p.id))]
  const lands = new Set([...placed, ...sch.project.components].map((c) => c.footprint).filter(Boolean))
  const footprints = (boardProject.footprints ?? []).filter((f) => lands.has(f.name))
  const blocks: SchematicBlock[] | undefined = sch.project.blocks
  const properties = [...(boardProject.properties ?? [])]
  for (const p of sch.project.properties ?? []) if (!properties.some((q) => q.key === p.key)) properties.push(p)
  // A 3D model belongs to a part and a footprint: a linked part has a new id, so its model moves to it.
  const models: NonNullable<Project["models"]> = []
  const newPartOf = new Map<string, string>()
  for (const l of link.links) {
    if (!l.record) continue
    const owner = symbolFootprint.get(l.record)
    const old = componentOf.get(l.footprint)
    const next = sch.byRecord.get(l.record)
    if (owner && old && next && owner.index === l.footprint) newPartOf.set(`${old.partId}|${old.footprint}`, next.partId)
  }
  for (const m of boardProject.models ?? []) {
    if (placed.some((c) => c.partId === m.part && c.footprint === m.footprint)) models.push(m)
    const moved = newPartOf.get(`${m.part}|${m.footprint}`)
    if (moved && !models.some((x) => x.part === moved && x.footprint === m.footprint)) models.push({ ...m, part: moved })
  }
  // A linked symbol is the schematic's part on the board's footprint: the footprint's own text and KiCad name come over, and its flags are joined with the symbol's
  // (the symbol wins only for the flags its file's KiCad copies to a footprint, see `joinFlags`). The flags are the part's, so every unit of a part carries them, as `setFlags` leaves them.
  const boardOf = new Map<string, ComponentInstance>()
  const joinedOf = new Map<string, PartFlags | undefined>()
  const differing: { ref: string; words: string[] }[] = []
  for (const l of link.links) {
    if (!l.record) continue
    const owner = symbolFootprint.get(l.record)
    const next = sch.byRecord.get(l.record)
    const old = componentOf.get(l.footprint)
    if (!owner || !next || !old || owner.index !== l.footprint) continue
    boardOf.set(next.id, old)
    const { flags, differ } = joinFlags(next.flags, old.flags, flagVoice(l.record.symbol))
    if (differ.length) differing.push({ ref: next.ref, words: differ })
    joinedOf.set(next.id, flags)
    for (const u of l.units) {
      const unit = sch.byRecord.get(u)
      if (unit && unit !== next) joinedOf.set(unit.id, flags)
    }
  }
  // A part's `sheetPath` is only read when the part has no instance and the schematic is flat (`partSheet`), so it is stored only then.
  const hierarchical = isHierarchical(sch.project)
  const linkedComponents = sch.project.components.map((c) => {
    if (!joinedOf.has(c.id)) return c
    const flags = joinedOf.get(c.id)
    const b = boardOf.get(c.id)
    const { flags: _symbolFlags, ...rest } = c
    void _symbolFlags
    // X23: the footprint's units and points come over, and what the footprint's variants say that the symbol's do not (the symbol's own word stands, as its flags do, flag by flag and field by field).
    const variants = joinOverrides(b?.variants, c.variants)
    return { ...rest, ...(flags ? { flags } : {}), ...(variants ? { variants } : {}), ...(b?.texts ? { texts: b.texts.map((t) => (t.kind === "value" && t.text === undefined && b.props.value !== undefined && b.props.value !== c.props.value ? { ...t, text: b.props.value } : t)) } : {}), ...(b?.fpid ? { fpid: b.fpid } : {}), ...(b?.classes ? { classes: b.classes } : {}), ...(b?.sheetPath && c.inst === undefined && !hierarchical ? { sheetPath: b.sheetPath } : {}), ...(b?.units ? { units: b.units } : {}), ...(b?.points ? { points: b.points } : {}), ...(b?.loneNets ? { loneNets: b.loneNets } : {}), ...(b?.modelRefs ? { modelRefs: b.modelRefs } : {}), ...(b?.fpProps ? { fpProps: b.fpProps } : {}), ...(b?.sheetFile ? { sheetFile: b.sheetFile } : {}) }
  })
  if (differing.length) {
    report.entries.push({
      code: "symbol-footprint-flags-differ",
      severity: "changed",
      object: `${differing.length} part${differing.length > 1 ? "s" : ""} (${differing.slice(0, 5).map((d) => d.ref).join(", ")}${differing.length > 5 ? ", ..." : ""})`,
      why: `The symbol and the footprint disagree about a flag that this file's KiCad copies from the symbol to the footprint; the symbol's is kept, as KiCad would after updating the board from the schematic: ${differing.slice(0, 3).map((d) => `${d.ref} ${d.words.join(", ")}`).join("; ")}${differing.length > 3 ? "; ..." : ""}.`,
      count: differing.length,
      items: differing.map((d) => d.ref),
    })
  }
  // The variants the schematic lists and the ones only the board does; the schematic's description of one stands.
  const variants = normalizeProjectVariants({ list: [...(sch.project.variants?.list ?? []), ...(boardProject.variants?.list ?? [])], active: sch.project.variants?.active }, [...linkedComponents, ...placed], sch.project.sheetSymbols)
  const project: Project = {
    ...boardProject,
    components: [...linkedComponents, ...placed],
    wires: [...sch.project.wires, ...laid.wires],
    labels: [...sch.project.labels, ...laid.labels],
    ...(sch.project.netNames ? { netNames: sch.project.netNames } : {}),
    ...(sch.project.sheets ? { sheets: sch.project.sheets } : {}),
    ...(variants ? { variants } : {}),
    ...(sch.project.sheetSymbols ? { sheetSymbols: sch.project.sheetSymbols } : {}),
    ...(sch.project.drawings ? { drawings: sch.project.drawings } : {}),
    ...(sch.project.busAliases ? { busAliases: sch.project.busAliases } : {}),
    parts: parts.length ? parts : undefined,
    ...(sch.project.symbols ? { symbols: sch.project.symbols } : {}),
    footprints: footprints.length ? footprints : undefined,
    models: models.length ? models : undefined,
    properties,
    ...(blocks ? { blocks } : {}),
  }
  return { project, loose: placed.map((component, i) => ({ fp: looseParts[i].fp, component })) }
}


/**
 * A label on a pin of each net that nothing names, in its KiCad name (`Net-(D1-K)`), on a short wire off the pin: a loose pad of the
 * board that is on that net is labelled with the same name, and joins the net by it. The label is global, so the net keeps its name.
 */
function anchorLabels(project: Project, anchors: { name: string; pin: { componentId: string; pin: string } }[]): Project {
  if (!anchors.length || !project.netNames) return project
  const wires: Wire[] = [...project.wires]
  const labels: NetLabel[] = [...project.labels]
  for (const a of anchors) {
    const c = project.components.find((x) => x.id === a.pin.componentId)
    const pin = c && schematicPins(c).find((p) => p.pin === a.pin.pin)
    if (!c || !pin) continue
    // The label goes on the sheet the pin is on; a sheet used more than once would carry it in every use, which would join the uses, so such a pin is left to be reported.
    const use = useAt(project, c.inst ?? "")
    if (usesOfSheet(project, use.sheet).length > 1) continue
    const here = use.sheet === "root" ? {} : { sheet: use.sheet }
    const stub = pinStubPoint(pin, SCH_GRID * 3)
    const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
    wires.push({ id: uid("w"), ...here, points: [pin.pos, stub] })
    labels.push({ id: uid("l"), ...here, name: a.name, x: round(stub.x, 4), y: round(stub.y, 4), rot, kind: "global", shape: "bidirectional" })
  }
  return { ...project, wires, labels }
}
