import { round, snap } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { computeConnectivity, pinKey } from "../../connectivity"
import { registerProjectParts } from "../../customParts"
import { pinStubPoint, schematicBounds, schematicPins } from "../../instances"
import { labelBox } from "../../labels"
import { findPart, isRegistered, projectPartIds, unregisterPart } from "../../library"
import { SCH_GRID } from "../../symbols"
import { serializeProject } from "../../projectFile"
import type { ComponentInstance, NetLabel, Project, Rotation, SchematicBlock, Wire } from "../../types"
import { importKicadBoard, PROJECT_SIZE_LIMIT_BYTES, formatSize, type KicadImportResult } from "../board/import"
import { buildKicadProject } from "../board/build"
import { outlineOf } from "../board/outline"
import { readKicadBoard } from "../board/read"
import { KicadReadError } from "../board/sexpr"
import { BUILT_EXTENSIONS as BOARD_BUILT, EXTENSION_NAMES as BOARD_EXTENSION_NAMES } from "../board/needs"
import { decodeNetName } from "../board/read"
import { refusals, type ImportReport, type NodeAccount } from "../board/report"
import type { KicadBoard, KicadFootprint } from "../board/types"
import { netLabelNames } from "../board/build"
import { buildSchematicProject, releaseBuild, type SchematicBuild } from "../schematic/build"
import { finishSchematic, gateSchematic } from "../schematic/import"
import { linkFootprints, type LinkResult } from "../schematic/link"
import { BUILT_EXTENSIONS as SCHEMATIC_BUILT, EXTENSION_NAMES as SCHEMATIC_EXTENSION_NAMES, refusalMessage, unbuilt, type Need } from "../schematic/needs"
import { normalizePath, type SchematicTree } from "../schematic/tree"
import { KicadRulesFileError, accountRules, readKicadRules, reportUnknownRules, type KicadRules } from "./dru"
import { KicadProjectFileError, accountPro, designSettingsNeeds, readKicadPro, reportUnknownPro, type KicadPro } from "./pro"

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
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" })
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
  const sheets = of(".kicad_sch")
  const dru = of(".kicad_dru")
  const notes: string[] = []
  // The project's name is the project file's, else the board's.
  const anchor = pros[0] ?? boards[0]
  const stem = anchor ? stemOf(anchor.path) : ""
  const dir = anchor ? dirOf(anchor.path) : ""
  const board = boards.find((b) => stemOf(b.path) === stem && dirOf(b.path) === dir) ?? boards.find((b) => stemOf(b.path) === stem) ?? boards[0]
  if (boards.length > 1) notes.push(`There are ${boards.length} boards among the files; ${board.path} was imported.`)
  const pro = pros.find((p) => dirOf(p.path) === dirOf(board?.path ?? "")) ?? pros[0]
  // The root schematic: same name and folder as the board or project, else the one no other sheet names.
  const base = stemOf((pro ?? board)?.path ?? "")
  const folder = dirOf((pro ?? board)?.path ?? "")
  let root = sheets.find((s) => stemOf(s.path) === base && dirOf(s.path) === folder) ?? sheets.find((s) => stemOf(s.path) === base)
  if (!root && sheets.length) {
    const text = (d: string | Uint8Array) => (typeof d === "string" ? d : new TextDecoder().decode(d))
    const named = new Set<string>()
    for (const s of sheets) {
      for (const m of text(s.data).matchAll(/\(property\s+"(?:Sheetfile|Sheet file|File)"\s+"([^"]+)"/g)) named.add(normalizePath(`${dirOf(s.path)}/${m[1]}`).toLowerCase())
    }
    const heads = sheets.filter((s) => !named.has(s.path.toLowerCase()))
    root = heads.find((s) => dirOf(s.path) === folder) ?? heads[0] ?? sheets[0]
    if (heads.length > 1) notes.push(`There are ${heads.length} schematics that no other sheet uses; ${root.path} was taken as the root.`)
  }
  const rules = dru.find((d) => dirOf(d.path) === dirOf(board?.path ?? "")) ?? dru[0]
  return { board, pro, root, rules, sheets: new Map(sheets.map((s) => [s.path, s.data] as const)), all, notes }
}

/**
 * The component each footprint of the board became. The board builder makes them in the order of the
 * footprints' references, so that is tried first, and each pair is checked by place, side and reference.
 * When a footprint made no part (one with no pads) or the order has changed, they are matched by place,
 * side and reference together (a part's reference is the footprint's, or its rename: `R1_2`, or a made-up
 * one for a footprint that has none); a footprint that matches none has no part, and one that two parts
 * match is `ambiguous`, which the importer refuses.
 */
function componentsByFootprint(project: Project, board: KicadBoard): { map: Map<number, ComponentInstance>; ambiguous: string[] } {
  const stripped = (fp: KicadFootprint) => fp.ref.trim().replace(/\*/g, "")
  // A footprint with no reference has a made-up one in the part: it is matched by its place in the board builder's order, never by a search (it would fit any part there).
  const refOk = (fp: KicadFootprint, c: ComponentInstance, byOrder: boolean) => {
    const ref = stripped(fp)
    return ref === "" ? byOrder : c.ref === ref || c.ref.startsWith(`${ref}_`)
  }
  const same = (fp: KicadFootprint, c: ComponentInstance, byOrder = false) => c.pcb.x === round(fp.at.x, 4) && c.pcb.y === round(-fp.at.y, 4) && c.pcb.side === fp.side && refOk(fp, c, byOrder)
  // The board builder makes a part of each footprint that has a numbered pad that is not a non-plated hole, and none of the others.
  const makesPart = (fp: KicadFootprint) => fp.pads.some((p) => p.number && p.type !== "np_thru_hole")
  const order = board.footprints.map((fp, i) => ({ fp, i })).filter(({ fp }) => makesPart(fp)).sort((a, b) => natural.compare(a.fp.ref, b.fp.ref))
  const out = new Map<number, ComponentInstance>()
  if (order.length === project.components.length && order.every(({ fp }, k) => same(fp, project.components[k], true))) {
    order.forEach(({ i }, k) => out.set(i, project.components[k]))
    return { map: out, ambiguous: [] }
  }
  const taken = new Set<string>()
  const ambiguous: string[] = []
  for (const { fp, i } of order) {
    const found = project.components.filter((x) => !taken.has(x.id) && same(fp, x))
    if (found.length > 1 && new Set(found.map((x) => x.ref)).size === 1 && found.length === order.filter((o) => same(o.fp, found[0])).length) {
      // Several footprints and several parts at one place with one reference: taken in order.
      taken.add(found[0].id)
      out.set(i, found[0])
    } else if (found.length > 1) ambiguous.push(fp.ref || "(no reference)")
    else if (found.length === 1) {
      taken.add(found[0].id)
      out.set(i, found[0])
    }
  }
  return { map: out, ambiguous }
}

const AUTO_NET = /^(?:Net-\(|unconnected-\()/

/**
 * Compares every pad's board net with its pin's net in the schematic: the pads that disagree, by part
 * and pin. A pad's pin is on the symbol linked to its footprint, or on another unit of the same part.
 * Two pads agree when the same pads are on their nets on both sides, and when a net the user named
 * has the same name.
 */
function compareNets(project: Project, pairs: { fp: KicadFootprint; components: ComponentInstance[] }[], namesNeedS2 = false): NetDifference[] {
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
      out.push({ ref, pin: f.pad, board: boardName, schematic: schName, why: `${ref} pin ${f.pad}: the board puts it ${boardName ? `on ${boardName}` : "on no net"}, the schematic ${schName ? `on ${schName}` : "on no net"}. The board has not been updated from its schematic.` })
      continue
    }
    // The same pads on both sides: a name the user gave must agree too (the root sheet's labels are `/NAME` on a board).
    if (f.schematic?.named && boardName && !AUTO_NET.test(boardName) && boardName.replace(/^\//, "") !== f.schematic.name) {
      out.push({ ref, pin: f.pad, board: boardName, schematic: schName, why: `${ref} pin ${f.pad}: the net is called ${boardName} on the board and ${schName} in the schematic. ${namesNeedS2 ? "The editor names this net by its own rule, not KiCad's (the names are S2), so the board may well be up to date." : "The board has not been updated from its schematic."}` })
    }
  }
  return out
}

function noteRulesFile(report: ImportReport) {
  report.entries.push({
    code: "rules-in-project-file",
    severity: "note",
    object: "the design rules",
    why: "The project file's net classes and design rules are read and accounted for, but not brought into the project yet: they are pending the net class and rules extension (X10). The project has the editor's default rules.",
  })
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
  const result = buildKicadProject(read.board, outline, read.report, { name: options.name, source: options.source, allowLossy: true })
  return { status: "imported", project: result.project, report: read.report, board: read.board, bytes: byteLength(serializeProject(result.project)) }
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
  if (picked.pro) {
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
  const boardResult = options.allowLossyBoard ? importBoardLossy(picked.board.data, options) : importKicadBoard(picked.board.data, { name: options.name, source: options.source, built, limitBytes: options.limitBytes })
  // The board importer notes that KiCad 6's rules live in a project file it did not read; the project file was read here, and says its own.
  report.entries.push(...boardResult.report.entries.filter((e) => !((pro || rules) && e.code === "rules-in-project-file")))
  boardParts = projectPartIds().filter((id) => !partsBefore.has(id))
  if (boardResult.status === "refused") return refuse(boardResult.reason, boardResult.message, boardResult.needs)
  const kicadBoard = boardResult.board

  // ---------- the schematic ----------
  if (!picked.root) {
    report.entries.push({ code: "no-schematic", severity: "note", object: "the project", why: "There is no schematic among the files, so the board came with a schematic generated from its nets." })
    report.account = boardResult.report.account
    return { status: "imported", project: boardResult.project, report, differences: [], link: null, board: kicadBoard, tree: null, pro, rules, accounts: { board: boardResult.report.account, schematic: null, pro: proAccount, rules: rulesAccount }, bytes: boardResult.bytes }
  }
  const gated = gateSchematic({ files: picked.sheets, root: picked.root.path }, { built, name: options.name, source: options.source, limitBytes: options.limitBytes })
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
  if (pro || rules) noteRulesFile(report)

  // The footprints of the board, linked to the symbols of the schematic.
  const link = linkFootprints(gate.tree, kicadBoard.footprints.map((f) => ({ ref: f.ref, path: f.path })))
  const mapped = componentsByFootprint(boardResult.project, kicadBoard)
  if (mapped.ambiguous.length) {
    const message = `The footprints ${mapped.ambiguous.slice(0, 4).join(", ")}${mapped.ambiguous.length > 4 ? " and more" : ""} cannot be told apart from the parts the board importer made, so they cannot be linked to symbols.`
    report.entries.push({ code: "footprint-parts-ambiguous", severity: "refused", object: "the footprints", why: message })
    return refuse("inexact", message)
  }
  const componentOf = mapped.map
  const symbolFootprint = new Map<object, { land: string; pcb: ComponentInstance["pcb"]; index: number }>()
  for (const l of link.links) {
    if (!l.record) continue
    const c = componentOf.get(l.footprint)
    // One footprint belongs to one symbol: the other symbols of its unit group have none.
    if (c && !symbolFootprint.has(l.record.symbol)) symbolFootprint.set(l.record.symbol, { land: c.footprint, pcb: c.pcb, index: l.footprint })
  }
  const sch = buildSchematicProject(gate.tree, gate.report, { name: options.name, source: options.source, built, footprintFor: (s) => symbolFootprint.get(s) })
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
  lateParts.push(...(merged.project.parts ?? []).filter((p) => !isRegistered(p.id)).map((p) => p.id))
  registerProjectParts(merged.project)
  const pairs = link.links.flatMap((l) => {
    const rec = l.record
    if (!rec) return []
    const c = sch.bySymbol.get(rec.symbol)
    const owner = symbolFootprint.get(rec.symbol)
    if (!c || !owner || owner.index !== l.footprint) return []
    // The other units of the part are components too: a pad may be a pin of any of them.
    const units = l.units.map((u) => sch.bySymbol.get(u.symbol)).filter((x): x is ComponentInstance => !!x)
    return [{ fp: kicadBoard.footprints[l.footprint], components: [c, ...units.filter((x) => x !== c)] }]
  })
  // Every other footprint is a part of the board with its own nets, labelled as the board's generated schematic labels them: its pads are compared too.
  for (const { fp, component } of merged.loose) pairs.push({ fp, components: [component] })
  const differences = compareNets(merged.project, pairs, sch.lossy.some((n) => n.ext === "S2"))
  for (const d of differences) report.entries.push({ code: "board-differs-from-schematic", severity: "changed", object: `${d.ref} pin ${d.pin}`, why: d.why })
  reportLinks(report, link, kicadBoard, sch, symbolFootprint)

  const bytes = byteLength(serializeProject(merged.project))
  const limit = options.limitBytes ?? PROJECT_SIZE_LIMIT_BYTES
  if (bytes > limit) {
    const message = `This project needs ${formatSize(bytes)} and projects hold up to ${formatSize(limit)}.`
    report.entries.push({ code: "too-large", severity: "refused", object: "the project", why: message })
    return refuseBuilt("too-large", message)
  }
  if (refusals(report).length) return refuseBuilt("inexact", refusals(report)[0].why)
  report.account = gate.report.account
  return { status: "imported", project: merged.project, report, differences, link, board: kicadBoard, tree: gate.tree, pro, rules, accounts: { board: boardResult.report.account, schematic: gate.report.account, pro: proAccount, rules: rulesAccount }, bytes }
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
    if (nonEmpty(schematic.bus_aliases)) need("S3", "bus aliases in the project file")
    if (nonEmpty(schematic.variants)) need("S9", "schematic variants in the project file")
    if (nonEmpty(schematic.top_level_sheets)) need("S1", "several top level sheets")
    if (pro.sheets.length > 1) need("S1", "the project's list of sheets")
    if (Object.keys(pro.textVariables).length) need("S4", "text variables")
    for (const k of ["component_class_settings", "tuning_profiles"]) {
      const v = j[k] as Record<string, unknown> | undefined
      if (k === "component_class_settings" && v && nonEmpty((v as { assignments?: unknown }).assignments)) need("X20", "component classes")
      if (k === "tuning_profiles" && v && nonEmpty((v as { tuning_profiles_impedance_geometric?: unknown }).tuning_profiles_impedance_geometric)) need("X21", "tuning profiles")
    }
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

function reportLinks(report: ImportReport, link: LinkResult, board: KicadBoard, sch: SchematicBuild, symbolFootprint: Map<object, unknown>) {
  const c = link.counts
  report.entries.push({
    code: "footprint-links",
    severity: "note",
    object: "the footprints",
    why: `${c.path + c.timestamp} of ${c.footprints} footprints were linked to their symbol by path, ${c.reference} by reference designator, and ${c.none} have no symbol${c.none ? ` (${c.noneNoPath} placed by hand with no link, ${c.noneWithPath} with a link to a symbol that is not in the schematic)` : ""}.`,
    count: c.footprints,
  })
  const loose = link.links.filter((l) => !l.record && !/\*/.test(l.ref))
  if (loose.length) {
    report.entries.push({ code: "footprint-without-symbol", severity: "note", object: `${loose.length} footprint${loose.length > 1 ? "s" : ""} (${loose.slice(0, 5).map((l) => l.ref || "(no reference)").join(", ")}${loose.length > 5 ? ", ..." : ""})`, why: "No symbol in the schematic claims them. They stay parts with a footprint and no symbol: mounting holes, logos, or parts the schematic no longer has.", count: loose.length })
  }
  const unplaced = [...sch.bySymbol].filter(([s, comp]) => !symbolFootprint.has(s) && comp.footprint === "" && s.props.some((p) => p.name === "Footprint" && p.value !== ""))
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
function placeLoose(project: Project, parts: { c: ComponentInstance; fp: KicadFootprint }[], rename: ReadonlyMap<string, string>, report: ImportReport): { components: ComponentInstance[]; wires: Wire[]; labels: NetLabel[] } {
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
  // Below everything the schematic has, from its left edge.
  let top = 0
  let left = 0
  let seen = false
  const grow = (x: number, y: number) => {
    top = seen ? Math.min(top, y) : y
    left = seen ? Math.min(left, x) : x
    seen = true
  }
  for (const c of project.components) {
    const b = schematicBounds(c)
    grow(b.minX, b.minY)
  }
  for (const w of project.wires) for (const p of w.points) grow(p.x, p.y)
  for (const l of project.labels) {
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
      labels.push({ id: uid("l"), name: labelText.get(net) ?? net, x: round(stub.x, 4), y: round(stub.y, 4), rot })
    }
  }
  return { components, wires, labels }
}

/** The board's project with its generated schematic replaced by the real one, and the parts with no symbol kept with their nets. */
function mergeProjects(boardProject: Project, sch: SchematicBuild, link: LinkResult, componentOf: Map<number, ComponentInstance>, symbolFootprint: Map<object, { index: number }>, board: KicadBoard, report: ImportReport): { project: Project; loose: { fp: KicadFootprint; component: ComponentInstance }[] } {
  const linkedBoard = new Set<string>()
  for (const l of link.links) {
    if (!l.record) continue
    const owner = symbolFootprint.get(l.record.symbol)
    if (owner && owner.index === l.footprint) {
      const c = componentOf.get(l.footprint)
      if (c) linkedBoard.add(c.id)
    }
  }
  const fpOf = new Map([...componentOf].map(([i, c]) => [c.id, board.footprints[i]]))
  const looseParts = boardProject.components.filter((c) => !linkedBoard.has(c.id) && fpOf.has(c.id)).map((c) => ({ c, fp: fpOf.get(c.id)! }))
  // The schematic's name for each board net that has a linked pad.
  const { nets: schNets, pinNet: schPinNet } = computeConnectivity(sch.project)
  const schName = new Map(schNets.map((n) => [n.id, n.name]))
  const rename = new Map<string, string>()
  for (const l of link.links) {
    if (!l.record) continue
    const owner = symbolFootprint.get(l.record.symbol)
    if (!owner || owner.index !== l.footprint) continue
    const comps = [sch.bySymbol.get(l.record.symbol), ...l.units.map((u) => sch.bySymbol.get(u.symbol))].filter((x): x is ComponentInstance => !!x)
    for (const pad of board.footprints[l.footprint].pads) {
      if (!pad.number || !pad.netRaw || rename.has(pad.netRaw)) continue
      for (const c of comps) {
        const name = schName.get(schPinNet.get(pinKey(c.id, pad.number)) ?? "")
        if (name) {
          rename.set(pad.netRaw, name)
          break
        }
      }
    }
  }
  const laid = placeLoose(sch.project, looseParts, rename, report)
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
    const owner = symbolFootprint.get(l.record.symbol)
    const old = componentOf.get(l.footprint)
    const next = sch.bySymbol.get(l.record.symbol)
    if (owner && old && next && owner.index === l.footprint) newPartOf.set(`${old.partId}|${old.footprint}`, next.partId)
  }
  for (const m of boardProject.models ?? []) {
    if (placed.some((c) => c.partId === m.part && c.footprint === m.footprint)) models.push(m)
    const moved = newPartOf.get(`${m.part}|${m.footprint}`)
    if (moved && !models.some((x) => x.part === moved && x.footprint === m.footprint)) models.push({ ...m, part: moved })
  }
  const project: Project = {
    ...boardProject,
    components: [...sch.project.components, ...placed],
    wires: [...sch.project.wires, ...laid.wires],
    labels: [...sch.project.labels, ...laid.labels],
    parts: parts.length ? parts : undefined,
    ...(sch.project.symbols ? { symbols: sch.project.symbols } : {}),
    footprints: footprints.length ? footprints : undefined,
    models: models.length ? models : undefined,
    properties,
    ...(blocks ? { blocks } : {}),
  }
  return { project, loose: placed.map((component, i) => ({ fp: looseParts[i].fp, component })) }
}

