import type { KeptFile } from "../model/kicad/board/images"
import type { Project } from "../model/types"
// Types only: the importer itself is loaded when an import starts (see `engine.ts`), never here.
import type { KicadBoard } from "../model/kicad/board/types"
import type { ImportReport, ReportEntry } from "../model/kicad/board/report"
import type { Need } from "../model/kicad/schematic/needs"
import { baseName, type IgnoredFile } from "./pick"

// What an import tells the user, as plain data: built where the import runs, sent across the
// worker boundary, shown on the report screen, downloaded, and kept with the project. Nothing in
// it is a class, a Map or a stack trace.

/** The one table from the importer's extension ids to words a maker knows. */
export const PLAIN_NAMES: Record<string, string> = {
  X1: "more than two copper layers, or a layer stackup",
  X2: "a board outline that is not a plain or rounded rectangle (cutouts, curves, polygons), or that is open or missing",
  X3: "copper pours, keepouts, rule areas or teardrops",
  X4: "curved tracks",
  X5: "blind, buried or micro vias, via stacks, or via options (tenting, free vias, removing unused layers)",
  X6: "parts turned by an angle that is not a multiple of 90 degrees",
  X7: "special pads (turned, rounded, chamfered, custom, drilled off centre or slotted, on unusual layers, with their own margins, properties or nets, or whose mask and paste differ from the editor's)",
  X8: "drawings beyond plain silkscreen lines on any layer (fabrication, courtyard, user), or parts with no pads",
  X9: "text on any layer: the reference and value of every part, part text and text on the board",
  X10: "net classes beyond the default, custom design rules, or two different smallest drill sizes",
  X11: "dimensions",
  X12: "groups of parts",
  X13: "tracks and vias that carry a net",
  X14: "reference images",
  X15: "part flags (virtual, board only, not in the parts list or position files, do not populate) and net ties",
  X19: "fonts embedded in a schematic file (a board's are built)",
  X20: "placement rule areas and component classes",
  X21: "tuning patterns, pad lengths and net chains",
  X22: "via protection, backdrill and post-machining",
  X23: "variants, units and points",
  X23X: "custom properties on board objects in a KiCad 11 development file",
  X24: "hatched fills, line end shapes, colours on drawings, filled drawings with a negative width and tracks exposed through the solder mask",
  X25: "tables, barcodes and drill charts, text boxes inside parts, and text with expressions or variables the editor cannot fill in",
  S1: "sheets inside sheets (hierarchical sheets, sheet pins and hierarchical labels)",
  S1T: "several top level sheets in one project (a KiCad 10 feature)",
  S2: "net labels as KiCad has them (local and global labels, their shapes and styles) and KiCad's own net names",
  S3: "buses (bus wires, bus entries and bus aliases)",
  S3B: "bus names the importer cannot read exactly (a bus name on a wire, a name KiCad 9 and 10 read differently, a bus too large)",
  S4: "notes, shapes, pictures and tables on the sheet, and wires and junctions with a look of their own",
  S5: "symbols with several units, mirrored symbols, hidden power pins, pins that share a number and fields placed by hand",
  S6: "symbol drawings with arcs, curves, fills and line styles",
  S7: "flags set on a symbol (do not populate, not in the parts list, not on the board, left out of simulation)",
  S8: "directive labels and rule areas",
  S9: "schematic variants",
  S10: "symbols kept inside the project",
  S9X: "symbol overrides and custom properties in a KiCad 11 development file",
  S11L: "KiCad 5's own rules for a no-connect pin and for label names",
  S11: "KiCad's own rules for what a wire joins (a wire end on the side of another wire, a label on a pin, points a hair apart)",
  S12: "symbols from the project's own libraries or the parts database",
  X26: "a creepage rule (the shortest distance along a surface between copper of different nets), which Checks cannot test yet",
  X27: "dimensions inside parts",
  X28: "reference images in a format other than PNG or JPEG",
  X29: "filled zones on layers that are not copper (solder mask, paste, silkscreen or user layers)",
  X30: "zones that belong to a part (a keepout or a pour drawn inside a footprint)",
  X31: "a pad that joins a pour on some copper layers and not others",
}

/** The plain name of an extension; one the table does not know is still named, never shown as a bare id. */
export const plainName = (id: string) => PLAIN_NAMES[id] ?? `a feature the editor does not have yet (${id})`

/** What was imported: a board alone, a project (a board and its schematic), or a schematic alone. */
export type ImportKind = "board" | "project" | "schematic"

/** The word a message uses for it. */
export const WHAT: Record<ImportKind, string> = { board: "board", project: "project", schematic: "schematic" }

export type SummaryReason =
  /** Refused for good: the project is over the storage limit. */
  | "too-large"
  /** The board or the schematic uses something the editor cannot hold yet. */
  | "unsupported"
  /** The file has something the importer does not know, or does not match exactly. */
  | "unknown"
  | "inexact"
  /** The file could not be read as a board (including a legacy `.brd`). */
  | "unreadable"
  /** No board among the files. */
  | "no-board"
  /** A zip that could not be opened, or a file too large to read. */
  | "bad-input"
  /** Something broke that should not have; the message says what, without a stack. */
  | "failed"
  | "cancelled"

export interface EntryLine {
  code: string
  object: string
  why: string
  count?: number
}

/**
 * What an import came to, whichever importer ran: the board's, the project's or the schematic's. The
 * board's result is one of these as it is; the project's and the schematic's are put in this shape by
 * `engine.ts`, which knows both.
 */
export type ImportResult =
  | {
      status: "imported"
      project: Project
      report: ImportReport
      bytes: number
      /** The board that was read, when there was one. */
      board?: KicadBoard | null
      /** The stamp and release of the file that was read, when there is no board to say them. */
      file?: { stamp: number | null; era: string | null; generator: string | null }
      kind?: ImportKind
      /** The files kept beside the project (reference images), when the board brought any. */
      files?: KeptFile[]
    }
  | {
      status: "refused"
      reason: Exclude<SummaryReason, "bad-input" | "failed" | "cancelled">
      message: string
      report: ImportReport
      needs: Need[]
      board?: KicadBoard | null
      file?: { stamp: number | null; era: string | null; generator: string | null }
      kind?: ImportKind
    }

export interface ImportSummary {
  /** What was imported; a summary from before the schematic import has none, and is a board's. */
  kind?: ImportKind
  status: "imported" | "refused"
  reason: SummaryReason | null
  /** The one sentence for the top of the screen. */
  message: string
  /** The technical line behind a failure, for the download only; never on screen. */
  detail: string | null
  /** The board's `(version N)` stamp and the release it is from, when a board was read. */
  stamp: number | null
  era: string | null
  generator: string | null
  boardBytes: number
  /** The size of the project file, when one was built. */
  projectBytes: number | null
  /** The extensions the board or schematic needs that the editor lacks: the id, the name in words, and what in the file needs it. */
  missing: { id: string; name: string; why: string }[]
  /** What the new project holds, when imported. */
  brought: { label: string; count: number }[]
  /** How many things in the file were accounted for, and how. */
  accounted: { total: number; imported: number; notNeeded: number; waiting: number; reported: number } | null
  /** What was left out because the editor works it out itself, with the reason. */
  notNeeded: { why: string; count: number }[]
  notBrought: EntryLine[]
  changed: EntryLine[]
  notes: EntryLine[]
  refusals: EntryLine[]
  /** The files read, and the files set aside with the reason. */
  used: string[]
  notRead: { file: string; why: string }[]
  ignored: { why: string; count: number; examples: string[] }[]
}

/** What the import knows about the files, for the report. Names stay on the user's side: analytics never sees them. */
export interface FileContext {
  used: string[]
  notRead: { file: string; why: string }[]
  ignored: IgnoredFile[]
  boardBytes: number
}

export const emptyContext = (): FileContext => ({ used: [], notRead: [], ignored: [], boardBytes: 0 })

const clean = (text: string) => text.replace(/`/g, "")
const line = (e: ReportEntry): EntryLine => ({ code: e.code, object: clean(e.object), why: clean(e.why), ...(e.count !== undefined ? { count: e.count } : {}) })

function groupIgnored(ignored: IgnoredFile[]): ImportSummary["ignored"] {
  const by = new Map<string, string[]>()
  for (const f of ignored) by.set(f.why, [...(by.get(f.why) ?? []), baseName(f.path)])
  return [...by].map(([why, names]) => ({ why, count: names.length, examples: names.slice(0, 5) })).sort((a, b) => b.count - a.count)
}

function broughtOf(p: Project): ImportSummary["brought"] {
  // A part of the schematic that is a symbol only (a power port, a flag) is not counted as a part.
  const drawings = p.drawings ?? []
  const directives = drawings.filter((d) => d.type === "directive").length
  const areas = drawings.filter((d) => d.type === "line" && d.ruleArea).length
  return [
    { label: "parts", count: p.components.length },
    { label: "wires on the schematic", count: p.wires.length },
    { label: "net labels", count: p.labels.length },
    { label: "notes, shapes and pictures on the sheet", count: drawings.length - directives - areas },
    { label: "directive labels (net classes)", count: directives },
    { label: "rule areas", count: areas },
    { label: "tracks", count: p.traces.length },
    { label: "vias", count: p.vias.length },
    { label: "pours", count: p.zones.length },
    { label: "pieces of board text", count: p.texts.length },
    { label: "texts of parts (references, values, labels)", count: p.components.reduce((n, c) => n + (c.texts?.length ?? 0), 0) },
  ].filter((b) => b.count > 0)
}

/** The summary of an import result. Pass the project's own size, which the importer measured. */
export function summarize(result: ImportResult, files: FileContext): ImportSummary {
  const board = result.board
  const kind: ImportKind = result.kind ?? "board"
  const entries = result.report.entries
  const account = result.report.account
  const base = {
    ...(kind !== "board" ? { kind } : {}),
    stamp: board?.version ?? result.file?.stamp ?? null,
    era: board?.era ?? result.file?.era ?? null,
    generator: board?.generatorVersion ?? board?.generator ?? result.file?.generator ?? null,
    boardBytes: files.boardBytes,
    accounted: account
      ? {
          total: account.total,
          imported: account.imported,
          notNeeded: [...account.notNeeded.values()].reduce((a, b) => a + b, 0),
          waiting: [...account.pending.values()].reduce((a, b) => a + b, 0),
          reported: account.reported,
        }
      : null,
    notNeeded: account ? [...account.notNeeded].map(([why, count]) => ({ why: clean(why), count })).sort((a, b) => b.count - a.count) : [],
    notBrought: entries.filter((e) => e.severity === "not-brought").map(line),
    changed: entries.filter((e) => e.severity === "changed").map(line),
    notes: entries.filter((e) => e.severity === "note").map(line),
    // What the missing list or the message already says is not said twice.
    refusals: entries
      .filter((e) => e.severity === "refused" && e.code !== "unsupported" && e.code !== "too-large")
      .filter((e) => !(result.status === "refused" && (result.message.includes(e.why) || e.why.includes(result.message))))
      .map(line),
    used: files.used,
    notRead: files.notRead,
    ignored: groupIgnored(files.ignored),
  }
  if (result.status === "imported") {
    return { ...base, status: "imported", reason: null, message: importedMessage(kind), detail: null, projectBytes: result.bytes, missing: [], brought: broughtOf(result.project) }
  }
  return {
    ...base,
    status: "refused",
    reason: result.reason,
    message: result.reason === "unsupported" ? unsupportedLead(result.needs.length, kind) : result.message,
    detail: null,
    projectBytes: null,
    missing: result.needs.map((n) => ({ id: n.ext, name: plainName(n.ext), why: clean(n.why) })),
    brought: [],
  }
}

/** A summary for an import that stopped before a board was read: no board, a bad zip, a failure, a cancel. */
export function stoppedSummary(reason: SummaryReason, message: string, files: FileContext = emptyContext(), detail: string | null = null): ImportSummary {
  return {
    status: "refused",
    reason,
    message,
    detail,
    stamp: null,
    era: null,
    generator: null,
    boardBytes: files.boardBytes,
    projectBytes: null,
    missing: [],
    brought: [],
    accounted: null,
    notNeeded: [],
    notBrought: [],
    changed: [],
    notes: [],
    refusals: [],
    used: files.used,
    notRead: files.notRead,
    ignored: groupIgnored(files.ignored),
  }
}

/** The one sentence for a refusal over missing extensions; the list below it says which, and why. */
export const unsupportedLead = (count: number, kind: ImportKind = "board") => `This ${WHAT[kind]} uses ${count === 1 ? "1 thing" : `${count} things`} Cherry Blossom cannot hold yet, listed below.`

/** The one sentence at the top of a report for something that came in. */
export const importedMessage = (kind: ImportKind = "board") => (kind === "project" ? "The project came in, its board and its schematic, and is ready to open." : `The ${WHAT[kind]} came in and is ready to open.`)

/** The full report as text, for the download. */
export function reportText(s: ImportSummary, projectName: string): string {
  const out: string[] = []
  const section = (title: string, lines: string[]) => lines.length && out.push("", title, ...lines.map((l) => `  ${l}`))
  const entry = (e: EntryLine) => `${e.object}: ${e.why}`
  out.push(`KiCad import report: ${projectName}`, s.status === "imported" ? "Result: imported." : "Result: not imported.", s.message)
  if (s.stamp !== null) out.push(`KiCad file version: ${s.stamp}${s.generator ? ` (written by KiCad ${s.generator})` : ""}`)
  if (s.detail) out.push(`Technical detail: ${s.detail}`)
  if (s.projectBytes !== null) out.push(`Project size: ${(s.projectBytes / 1024).toFixed(0)} KB`)
  section("Brought in", s.brought.map((b) => `${b.count} ${b.label}`))
  if (s.accounted) section("The file, item by item", [`${s.accounted.total} items in the file: ${s.accounted.imported} brought in, ${s.accounted.notNeeded} not needed, ${s.accounted.waiting} waiting for a feature, ${s.accounted.reported} reported below`])
  section(`Used by this ${WHAT[s.kind ?? "board"]} and not supported yet`, s.missing.map((m) => `${m.name} (${m.id}): ${m.why}`))
  section("Not needed", s.notNeeded.map((n) => `${n.count} x ${n.why}`))
  section("Not brought in", s.notBrought.map(entry))
  section("Changed on the way in", s.changed.map(entry))
  section("Why it was refused", s.refusals.map(entry))
  section("Good to know", s.notes.map(entry))
  section("Files read", s.used)
  section("Files not read", s.notRead.map((n) => `${n.file}: ${n.why}`))
  section("Files set aside", s.ignored.map((i) => `${i.count} x ${i.why} (${i.examples.join(", ")}${i.count > i.examples.length ? ", ..." : ""})`))
  return `${out.join("\n")}\n`
}

/** The full report as JSON, for the download. */
export const reportJson = (s: ImportSummary, projectName: string) => JSON.stringify({ project: projectName, ...s }, null, 2)

/** What to call a report whose project was not made: the first file's name without its extension. */
export const reportName = (s: ImportSummary) => (s.used[0] ?? `KiCad ${WHAT[s.kind ?? "board"]}`).replace(/\.[^.]+$/, "")
