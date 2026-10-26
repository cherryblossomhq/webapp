import { settleImportedLabelClasses } from "../../directives"
import { serializeProject } from "../../projectFile"
import type { Project } from "../../types"
import { PROJECT_SIZE_LIMIT_BYTES, formatSize } from "../board/import"
import { refusals, type ImportReport } from "../board/report"
import { accountNodes, countPaths, mergeAccounts, reportedNodes, reportUnknown } from "./account"
import { buildSchematicProject, releaseBuild, type SchematicBuild } from "./build"
import { plainnessOf, settleFor } from "./carried"
import { BUILT_EXTENSIONS, EXTENSION_NAMES, needsOfFile, needsOfProject, refusalMessage, unbuilt, type Need } from "./needs"
import { legacyEntries, legacyWarnings } from "./legacy/report"
import { isMiss } from "./libraries"
import { KicadSchematicReadError } from "./read"
import { readSchematicTree, type KicadFiles, type SchematicTree } from "./tree"

// The KiCad schematic import, start to finish: read the sheets, account for every node, find what
// the schematic needs that the editor cannot hold yet, and either refuse with the reason or build
// the project, check it, and hand it over with the report. A schematic is imported exactly or not
// at all: a lossy import is worse than none, since the user would not know.

export interface SchematicImportOptions {
  name?: string
  /** Where the schematic came from, kept as the project's "Imported from" property. */
  source?: string
  /** The extensions of the model that are built; defaults to what the editor has. Tests raise it. */
  built?: ReadonlySet<string>
  /** Largest project file, in bytes; defaults to the storage limit. */
  limitBytes?: number
  /** Most drawn objects (wires, symbols, labels, junctions, flags, text...) a schematic may hold; defaults to `MAX_SCHEMATIC_OBJECTS`. */
  maxObjects?: number
  /**
   * S12: symbols of the parts database, by `lib_id`, as the text of each symbol's own `.kicad_sym` file; the last place a symbol the schematic's cache lacks is
   * looked for, after the project's own libraries. A host that has such a source passes what it fetched for the symbols a first import found missing.
   */
  databaseSymbols?: ReadonlyMap<string, string>
  /** The budgets of `readCost`; default to `MAX_LINE_STEPS` and `MAX_CELL_STEPS`. */
  maxLineSteps?: number
  maxCellSteps?: number
}

/**
 * The most drawn objects a schematic may have. A project over 900 KiB is refused anyway, and a hostile
 * file of hundreds of thousands of wires would take minutes to read the nets of before it could be
 * measured; the corpus's largest project (the `video` demo, all its sheets) has 4,607.
 */
export const MAX_SCHEMATIC_OBJECTS = 25000

/**
 * What reading the nets of one sheet may cost, in steps. The editor looks for the wires near each wire end
 * and label among all those that run along the same line (`SegmentIndex` in `connectivity.ts`), and the
 * build cuts each wire into 2 mm cells to find what it crosses, so many wires on one line, or very long ones,
 * cost far more than their number says: 2,000 wires end to end take 4.5 s, 4,000 take 18 s. A sheet over
 * either budget is refused before the build; the corpus's most costly sheet is far below both.
 */
export const MAX_LINE_STEPS = 3_000_000
export const MAX_CELL_STEPS = 2_000_000

export type SchematicImportResult =
  | { status: "imported"; project: Project; report: ImportReport; tree: SchematicTree; build: SchematicBuild; bytes: number }
  | {
      status: "refused"
      /** `unreadable`: not a schematic, or a sheet that cannot be read; `unsupported`: needs an extension not built; `too-large`: over the project limit; `unknown`: the file has a node or value the importer does not know; `inexact`: the built project does not match the file. */
      reason: "unreadable" | "unsupported" | "too-large" | "unknown" | "inexact"
      message: string
      report: ImportReport
      /** What the schematic needs that is not built, when it could be worked out. */
      needs: Need[]
      tree: SchematicTree | null
    }

const byteLength = (text: string) => new TextEncoder().encode(text).length

/** The two costs of a sheet, in steps (see `MAX_LINE_STEPS`): the wires along each line, summed over every probe, and the 2 mm cells the wires cover. */
export function readCost(sch: { wires: { pts: { x: number; y: number }[] }[]; labels: { at: { x: number; y: number } }[] }): { line: number; cells: number } {
  const key = (mm: number) => Math.round((mm / 12.7) * 1000)
  const rows = new Map<number, number>()
  const cols = new Map<number, number>()
  let slanted = 0
  let cells = 0
  for (const w of sch.wires) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i]
      const b = w.pts[i + 1]
      cells += Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2) + 1
      if (Math.abs(a.y - b.y) < 1e-9 * 12.7) rows.set(key(a.y), (rows.get(key(a.y)) ?? 0) + 1)
      else if (Math.abs(a.x - b.x) < 1e-9 * 12.7) cols.set(key(a.x), (cols.get(key(a.x)) ?? 0) + 1)
      else slanted++
    }
  }
  let line = 0
  const probe = (p: { x: number; y: number }) => {
    const ky = key(p.y)
    const kx = key(p.x)
    line += slanted + (rows.get(ky - 1) ?? 0) + (rows.get(ky) ?? 0) + (rows.get(ky + 1) ?? 0) + (cols.get(kx - 1) ?? 0) + (cols.get(kx) ?? 0) + (cols.get(kx + 1) ?? 0) + 1
  }
  for (const w of sch.wires) if (w.pts.length >= 2) { probe(w.pts[0]); probe(w.pts[w.pts.length - 1]) }
  for (const l of sch.labels) probe(l.at)
  return { line, cells }
}

const ROOT_NAME = "schematic.kicad_sch"

/** What `readSchematicTree` is given: the root file's text or bytes alone, or every file of the project with the root's path. */
export type SchematicInput = string | Uint8Array | { files: KicadFiles; root: string }

/** What `gateSchematic` found out about a schematic that can be built: its sheets, the report so far, what it needs and what of that is not built. */
export interface SchematicGate {
  tree: SchematicTree
  report: ImportReport
  needs: Need[]
  missing: Need[]
}

/**
 * Read a schematic and its sheets, account for every node, find what it needs, and say whether it
 * can be built: a refusal when it cannot, or the tree and report to build from. The project import
 * runs this and builds with the footprints it has linked.
 */
export function gateSchematic(input: SchematicInput, options: SchematicImportOptions = {}): { refused: Extract<SchematicImportResult, { status: "refused" }> } | { gate: SchematicGate } {
  const built = options.built ?? BUILT_EXTENSIONS
  const files: KicadFiles = typeof input === "string" || input instanceof Uint8Array ? new Map([[ROOT_NAME, input]]) : input.files
  const rootPath = typeof input === "string" || input instanceof Uint8Array ? ROOT_NAME : input.root
  let tree: SchematicTree
  try {
    tree = readSchematicTree(files, rootPath, { databaseSymbols: options.databaseSymbols })
  } catch (e) {
    const message = e instanceof KicadSchematicReadError ? e.message : `The file could not be read: ${e instanceof Error ? e.message : String(e)}`
    // A record of a legacy file that the importer does not know is refused by name, as an unknown node of a `.kicad_sch` is.
    if (e instanceof KicadSchematicReadError && e.code === "unknown-record") {
      const report: ImportReport = { entries: [{ code: "unknown-node", severity: "refused", object: `the record "${e.path ?? "?"}"`, why: `${message} Nothing is guessed: the schematic is not imported until the importer learns it.` }], account: null }
      return { refused: { status: "refused", reason: "unknown", message, report, needs: [], tree: null } }
    }
    const report: ImportReport = { entries: [{ code: e instanceof KicadSchematicReadError ? e.code : "unreadable", severity: "refused", object: "the file", why: message }], account: null }
    return { refused: { status: "refused", reason: "unreadable", message, report, needs: [], tree: null } }
  }
  const report = tree.report
  report.entries.push(...legacyEntries(tree))
  // A schematic alone has no board to check the pins of a library symbol against: the warning is the import's, shown above the entries.
  const libraryWarnings = legacyWarnings(tree, null)
  if (libraryWarnings.length) report.warnings = libraryWarnings
  const list = [...tree.files.values()]
  const limit = options.maxObjects ?? MAX_SCHEMATIC_OBJECTS
  const objects = list.reduce((n, f) => n + f.schematic.wires.length + f.schematic.buses.length + f.schematic.symbols.length + f.schematic.labels.length + f.schematic.junctions.length + f.schematic.noConnects.length + f.schematic.busEntries.length + Object.values(f.schematic.others).reduce((m, l) => m + l.length, 0), 0)
  const costly = list.map((f) => ({ f, cost: readCost(f.schematic) })).find((c) => c.cost.line > (options.maxLineSteps ?? MAX_LINE_STEPS) || c.cost.cells > (options.maxCellSteps ?? MAX_CELL_STEPS))
  if (costly && objects <= limit) {
    const message = `This schematic is too large to import: it has wires that run along the same lines in such numbers, or are so long, that the editor would need minutes to read its nets, and a sheet this big would be over the 900 KB project limit anyway (${costly.f.path}: ${costly.cost.line.toLocaleString("en-US")} and ${costly.cost.cells.toLocaleString("en-US")} steps against ${(options.maxLineSteps ?? MAX_LINE_STEPS).toLocaleString("en-US")} and ${(options.maxCellSteps ?? MAX_CELL_STEPS).toLocaleString("en-US")}).`
    report.entries.push({ code: "too-costly", severity: "refused", object: "the schematic", why: message })
    return { refused: { status: "refused", reason: "too-large", message, report, needs: [], tree } }
  }
  if (objects > limit) {
    const message = `This schematic is too large to import: it has ${objects.toLocaleString("en-US")} drawn objects (wires, symbols, labels, junctions, text and the rest) and the editor reads up to ${limit.toLocaleString("en-US")}; a sheet this big would be over the 900 KB project limit anyway.`
    report.entries.push({ code: "too-many-objects", severity: "refused", object: "the schematic", why: message, count: objects })
    return { refused: { status: "refused", reason: "too-large", message, report, needs: [], tree } }
  }
  const root = tree.files.get(tree.root)!.schematic
  const plain = plainnessOf(list, root.uuid, tree.root)
  const counted = new Map(list.map((f) => [f.path, countPaths(f.schematic.tree)]))
  const needs = needsOfProject(list.map((f) => needsOfFile(f.schematic, counted.get(f.path)!, plain, (id) => !isMiss(tree.libraries.find(id)))))
  const missing = unbuilt(needs, built)
  const needed = new Set(missing.map((n) => n.ext))
  const account = mergeAccounts(list.map((f) => accountNodes(f.schematic.tree, f.text, needed, counted.get(f.path), settleFor(plain))))
  report.account = account
  reportUnknown(account, report)
  reportedNodes(account, report)
  for (const f of list) {
    for (const e of f.schematic.embeddedFiles) {
      report.entries.push({ code: "embedded-file-not-brought", severity: "not-brought", object: `the embedded file ${e.name}${e.type ? ` (${e.type})` : ""} in ${f.path}`, why: "Files packed inside a KiCad schematic are not brought across for now." })
    }
  }
  // A sheet that several projects share keeps each project's own references in its symbols; only this project's are read.
  let foreign = 0
  for (const f of list) for (const sym of f.schematic.symbols) foreign += sym.instances.filter((i) => root.uuid && i.path !== `/${root.uuid}` && !i.path.startsWith(`/${root.uuid}/`)).length
  if (foreign) {
    report.entries.push({ code: "other-projects-instances", severity: "note", object: `${foreign} use${foreign > 1 ? "s" : ""} of symbols by other KiCad projects`, why: "The symbols keep the references they have in other projects that share these sheets. Only this project's own are read.", count: foreign })
  }
  // Instance data for a use of a sheet that the project does not have (a sheet symbol that was deleted since), and a page for one: the symbols keep their own references.
  const validPaths = new Map<string, Set<string>>()
  for (const inst of tree.instances) (validPaths.get(inst.file) ?? validPaths.set(inst.file, new Set()).get(inst.file)!).add(inst.path)
  let stray = 0
  for (const f of list) {
    const ok = validPaths.get(f.path) ?? new Set<string>()
    for (const sym of f.schematic.symbols) stray += sym.instances.filter((i) => root.uuid && (i.path === `/${root.uuid}` || i.path.startsWith(`/${root.uuid}/`)) && !ok.has(i.path)).length
  }
  if (stray) {
    report.entries.push({ code: "instance-of-no-sheet", severity: "note", object: `${stray} use${stray > 1 ? "s" : ""} of symbols on sheets the project does not have`, why: "The symbols name a use of a sheet that no sheet symbol makes any more. Those uses are left out; a symbol keeps the reference of the uses that exist.", count: stray })
  }
  const boardPaths = new Set(tree.instances.map((i) => (i.chain.length ? `/${i.chain.join("/")}` : "/")))
  const pageless = root.sheetInstances.filter((i) => i.path !== "/" && i.path !== `/${root.uuid}` && !boardPaths.has(i.path) && !tree.instances.some((x) => x.path === i.path))
  if (pageless.length) {
    report.entries.push({ code: "page-of-no-sheet", severity: "note", object: `${pageless.length} page number${pageless.length > 1 ? "s" : ""} of sheets the project does not have`, why: "The root sheet lists pages for sheets that no sheet symbol makes.", count: pageless.length })
  }
  for (const err of tree.errors) {
    report.entries.push({ code: `sheet-${err.code}`, severity: "refused", object: err.sheet ? `the sheet "${err.sheet}" (${err.file})` : `a sheet in ${err.parent}`, why: err.message })
  }
  for (const n of missing) {
    report.entries.push({ code: "unsupported", severity: "refused", object: EXTENSION_NAMES[n.ext] ?? n.ext, why: `${n.why} (${n.ext}); the editor cannot hold it yet.` })
  }
  const refuse = (reason: Extract<SchematicImportResult, { status: "refused" }>["reason"], message: string) => ({ refused: { status: "refused" as const, reason, message, report, needs: missing, tree } })

  const sheetError = tree.errors[0]
  if (sheetError) return refuse("unreadable", sheetError.message)
  const unknown = report.entries.filter((e) => e.code === "unknown-node" || e.code === "unknown-value")
  if (unknown.length) {
    return refuse("unknown", `This schematic has ${unknown.length === 1 ? "something" : "things"} this importer does not know yet: ${unknown.slice(0, 3).map((e) => e.object).join(", ")}${unknown.length > 3 ? " and more" : ""}.`)
  }
  if (missing.length) return refuse("unsupported", refusalMessage(missing))
  return { gate: { tree, report, needs, missing } }
}

/** Whether a built schematic is exact and fits the project limit: the last checks, shared with the project import. */
export function finishSchematic(gate: SchematicGate, result: SchematicBuild, options: SchematicImportOptions = {}): SchematicImportResult {
  const { tree, report, missing } = gate
  const built = options.built ?? BUILT_EXTENSIONS
  // What the build found that the model cannot hold exactly is an extension the schematic needs: not built, it is refused as the others are.
  const found = unbuilt(result.lossy, built)
  if (found.length) {
    releaseBuild(result)
    for (const n of found) report.entries.push({ code: "unsupported", severity: "refused", object: EXTENSION_NAMES[n.ext] ?? n.ext, why: `${n.why} (${n.ext}); the editor cannot hold it yet.` })
    const needs = needsOfProject([missing, found])
    return { status: "refused", reason: "unsupported", message: refusalMessage(needs), report, needs, tree }
  }
  // A need that is named built but that the build still cannot hold exactly (measurement runs name extensions built that are not): said, so nothing reads the result as exact.
  for (const n of result.lossy) {
    if (built.has(n.ext) && !report.entries.some((e) => e.code === "lossy-measured" && e.why === n.why)) {
      report.entries.push({ code: "lossy-measured", severity: "not-brought", object: EXTENSION_NAMES[n.ext] ?? n.ext, why: `${n.why} (${n.ext}); the project is only as exact as the built extension.` })
    }
  }
  // S8: the net classes the sheet's labels give.
  result.project = settleImportedLabelClasses(result.project, report)
  if (refusals(report).length) {
    releaseBuild(result)
    return { status: "refused", reason: "inexact", message: refusals(report)[0].why, report, needs: missing, tree }
  }
  const bytes = byteLength(serializeProject(result.project))
  const limit = options.limitBytes ?? PROJECT_SIZE_LIMIT_BYTES
  if (bytes > limit) {
    releaseBuild(result)
    const message = `This schematic needs ${formatSize(bytes)} and projects hold up to ${formatSize(limit)}.`
    report.entries.push({ code: "too-large", severity: "refused", object: "the project", why: message })
    return { status: "refused", reason: "too-large", message, report, needs: missing, tree }
  }
  return { status: "imported", project: result.project, report, tree, build: result, bytes }
}

/** Import a `.kicad_sch` (with its sheets when `files` are given). Never throws for a file: what cannot be imported is a refusal with its report. */
export function importKicadSchematic(input: SchematicInput, options: SchematicImportOptions = {}): SchematicImportResult {
  const gated = gateSchematic(input, options)
  if ("refused" in gated) return gated.refused
  const result = buildSchematicProject(gated.gate.tree, gated.gate.report, { name: options.name, source: options.source, built: options.built })
  return finishSchematic(gated.gate, result, options)
}
