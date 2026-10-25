import { serializeProject } from "../../projectFile"
import { crossingSentence, outlineCrossings } from "../../outlineCrossing"
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
    why: "KiCad 6 and later keep the design rules (net classes, clearances, track and via sizes) in the project file, `.kicad_pro`, not in the board. Only the board was read, so the project has the editor's default rules, except for the few the board itself states (mask and paste margins, the mask web, the paste ratio, the smallest drill and annular ring, the hole to hole distance, the zone and edge clearances). Its net classes need the project file reader, which is not built yet.",
  })
}

/** Notes on what the outline repair did, so a repaired board says so. */
function noteOutline(outline: OutlineResult, report: ImportReport) {
  const { merged, dropped, zeroLength, moved } = outline.repair
  if (merged || dropped || zeroLength || moved) {
    report.entries.push({
      code: "outline-repaired",
      severity: "changed",
      object: "the board outline",
      why: `Pieces of the outline that overlapped or touched were joined (${merged}), pieces shorter than 0.1 mm that touched nothing were dropped (${dropped}), and lines of no length were dropped (${zeroLength}). Of the pieces joined, ${moved} did not lie exactly on the line they were joined into and moved to it (by at most 0.1 mm); a piece that was joined with nothing is where the file has it.`,
      count: merged + dropped + zeroLength,
    })
  }
  const { connectors, snapped, maxGap } = outline.joins
  if (connectors || snapped) {
    report.entries.push({
      code: "outline-joined",
      severity: "changed",
      object: "the board outline",
      why: `${connectors ? `${connectors} joint${connectors === 1 ? "" : "s"} of the outline had two ends up to ${maxGap.toFixed(3)} mm apart; each is closed by a short straight piece, and no piece of the file moved. ` : ""}${snapped ? `${snapped} end${snapped === 1 ? "" : "s"} within a thousandth of a millimetre of the next piece ${snapped === 1 ? "was" : "were"} made the same point.` : ""}`.trim(),
      count: connectors + snapped,
    })
  }
  if (outline.status === "no outline") {
    report.entries.push({
      code: "outline-missing",
      severity: "note",
      object: "the board outline",
      why: "The file draws nothing on Edge.Cuts, so the board has no outline. It is kept that way: the board is marked as having none, Checks reports it as an error, and the Gerber, drill and STEP exports say so until an outline is drawn. The board's box is the parts' with a margin.",
    })
  } else if (outline.status !== "closed") {
    report.entries.push({
      code: "outline-open",
      severity: "note",
      object: "the board outline",
      why: `The outline is kept as the file draws it, ${outline.openChains} edge${outline.openChains === 1 ? "" : "s"} of it open. The board is marked as not closed, Checks reports it as an error, and the Gerber, drill and STEP exports say so until it is closed.`,
      count: outline.openChains,
    })
  }
  const crossings = outlineCrossings(outline.paths)
  if (crossings.length) {
    report.entries.push({
      code: "outline-crossing",
      severity: "note",
      object: "the board outline",
      why: `${crossings.slice(0, 3).map(crossingSentence).join("; ")}${crossings.length > 3 ? ` and ${crossings.length - 3} more` : ""}. The outline is kept as the file draws it (KiCad's own checks flag it too): Checks reports it as an error, and the Gerber, drill and STEP exports say so until it is fixed.`,
      count: crossings.length,
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
