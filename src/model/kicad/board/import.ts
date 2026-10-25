import { serializeProject } from "../../projectFile"
import type { Project } from "../../types"
import { accountNodes, countPaths, reportDroppedModels, reportedNodes, reportUnknown } from "./account"
import { buildKicadProject } from "./build"
import { settleFor } from "./carried"
import { BUILT_EXTENSIONS, EXTENSION_NAMES, needsOf, refusalMessage, unbuilt, type Need } from "./needs"
import { outlineOf, type OutlineResult } from "./outline"
import { readKicadBoard } from "./read"
import { refusals, type ImportReport } from "./report"
import { KicadReadError } from "./sexpr"
import type { KicadBoard } from "./types"

// The KiCad board import, start to finish: read the file, account for every node, find what the
// board needs that the editor cannot hold yet, and either refuse with the reason or build the
// project, measure it, and hand it over with the report. A board is imported exactly or not at
// all: a lossy import is worse than none, since the user would not know.

/**
 * What a stored project may weigh, in bytes of its file. The same number as `MAX_DOCUMENT_BYTES`
 * in the hosted app's storage policy (a stored row's limit is 1 MiB); a test pins the two.
 */
export const PROJECT_SIZE_LIMIT_BYTES = 900 * 1024

export interface ImportOptions {
  name?: string
  /** Where the board came from, kept as the project's "Imported from" property. */
  source?: string
  /** The extensions of the model that are built; defaults to what the editor has. Tests raise it. */
  built?: ReadonlySet<string>
  /** Largest project file, in bytes; defaults to the storage limit. */
  limitBytes?: number
}

export type KicadImportResult =
  | { status: "imported"; project: Project; report: ImportReport; board: KicadBoard; bytes: number }
  | {
      status: "refused"
      /** `unreadable`: not a board; `unsupported`: needs an extension not built; `too-large`: over the project limit; `unknown`: the file has a node or value the importer does not know; `inexact`: the generated project does not match the file. */
      reason: "unreadable" | "unsupported" | "too-large" | "unknown" | "inexact"
      message: string
      report: ImportReport
      /** What the board needs that is not built, when `unsupported`. */
      needs: Need[]
      board: KicadBoard | null
    }

/** A size in the words of the refusal: `1.4 MB`, `900 KB`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

const byteLength = (text: string) => new TextEncoder().encode(text).length

/** Import a `.kicad_pcb`, as text or bytes. Never throws for a file: what cannot be imported is a refusal with its report. */
export function importKicadBoard(input: string | Uint8Array, options: ImportOptions = {}): KicadImportResult {
  const built = options.built ?? BUILT_EXTENSIONS
  let read
  try {
    read = readKicadBoard(input)
  } catch (e) {
    const message = e instanceof KicadReadError ? e.message : `The file could not be read: ${e instanceof Error ? e.message : String(e)}`
    const report: ImportReport = { entries: [{ code: e instanceof KicadReadError ? e.code : "unreadable", severity: "refused", object: "the file", why: message }], account: null }
    return { status: "refused", reason: "unreadable", message, report, needs: [], board: null }
  }
  const { board, text, report } = read
  const outline = outlineOf(board)
  const paths = countPaths(board.tree)
  const needs = needsOf(board, { paths }, outline)
  const missing = unbuilt(needs, built)
  const account = accountNodes(board.tree, text, new Set(missing.map((n) => n.ext)), paths, settleFor(board))
  reportDroppedModels(account, board)
  report.account = account
  noteRulesFile(board, report)
  reportUnknown(account, report)
  reportedNodes(account, report)
  noteOutline(outline, report)

  for (const n of missing) {
    report.entries.push({ code: "unsupported", severity: "refused", object: EXTENSION_NAMES[n.ext] ?? n.ext, why: `${n.why} (${n.ext}); the editor cannot hold it yet.` })
  }
  const unknown = report.entries.filter((e) => e.code === "unknown-node" || e.code === "unknown-value")
  if (unknown.length) {
    const message = `This board has ${unknown.length === 1 ? "something" : "things"} this importer does not know yet: ${unknown.slice(0, 3).map((e) => e.object).join(", ")}${unknown.length > 3 ? " and more" : ""}.`
    return { status: "refused", reason: "unknown", message, report, needs: missing, board }
  }
  const unreadable = report.entries.find((e) => e.code === "unreadable-value" || e.code === "scaled-footprint")
  if (unreadable) return { status: "refused", reason: "unreadable", message: `${unreadable.object}: ${unreadable.why}`, report, needs: missing, board }
  if (missing.length) return { status: "refused", reason: "unsupported", message: refusalMessage(missing), report, needs: missing, board }

  const result = buildKicadProject(board, outline, report, { name: options.name, source: options.source })
  if (result.lossy.length || refusals(report).length) {
    const message = result.lossy.length ? `This board cannot be imported exactly: ${result.lossy.join("; ")}.` : refusals(report)[0].why
    return { status: "refused", reason: "inexact", message, report, needs: missing, board }
  }
  const bytes = byteLength(serializeProject(result.project))
  const limit = options.limitBytes ?? PROJECT_SIZE_LIMIT_BYTES
  if (bytes > limit) {
    const message = `This board needs ${formatSize(bytes)} and projects hold up to ${formatSize(limit)}.`
    report.entries.push({ code: "too-large", severity: "refused", object: "the project", why: message })
    return { status: "refused", reason: "too-large", message, report, needs: missing, board }
  }
  return { status: "imported", project: result.project, report, board, bytes }
}

/** KiCad 6 and later keep the design rules in the project file beside the board, which a board alone does not have. */
function noteRulesFile(board: KicadBoard, report: ImportReport) {
  if (board.version === null || board.version < 20211014) return
  report.entries.push({
    code: "rules-in-project-file",
    severity: "note",
    object: "the design rules",
    why: "KiCad 6 and later keep the design rules (net classes, clearances, track and via sizes) in the project file, `.kicad_pro`, not in the board. Only the board was read, so the project has the editor's default rules, except for the few the board itself states (mask and paste margins, the smallest drill and annular ring, the hole to hole distance, the zone and edge clearances).",
  })
}

/** Notes on what the outline repair did, so a repaired board says so. */
function noteOutline(outline: OutlineResult, report: ImportReport) {
  const { merged, dropped, zeroLength } = outline.repair
  if (merged || dropped || zeroLength) {
    report.entries.push({
      code: "outline-repaired",
      severity: "changed",
      object: "the board outline",
      why: `Pieces of the outline that overlapped or touched were joined (${merged}), pieces shorter than 0.1 mm that touched nothing were dropped (${dropped}), and lines of no length were dropped (${zeroLength}).`,
      count: merged + dropped + zeroLength,
    })
  }
  for (const g of outline.gaps) {
    report.entries.push({
      code: "outline-gap",
      severity: "note",
      object: "the board outline",
      why: g.to ? `The outline does not close: it stops at (${g.from.x.toFixed(2)}, ${g.from.y.toFixed(2)}) mm, ${g.width.toFixed(2)} mm from the nearest loose end at (${g.to.x.toFixed(2)}, ${g.to.y.toFixed(2)}) mm.` : `The outline does not close: an end at (${g.from.x.toFixed(2)}, ${g.from.y.toFixed(2)}) mm touches nothing.`,
    })
  }
}
