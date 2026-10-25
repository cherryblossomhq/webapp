import type { SaveKind } from "./save"
import { WHAT, type EntryLine, type ImportSummary, type SummaryReason } from "./summary"

// The report screen as data: a title, a lead sentence and sections of lines. The editor's report
// view and the website's projects page each draw this in their own style, so the two say the same.
// `saveError` is the reason an imported board was not saved, when it was not: the screen then says
// so first, in the title, instead of calling the import done.

const TITLES: Record<SummaryReason, string> = {
  "too-large": "Too big to save",
  unsupported: "Not supported yet",
  unknown: "Something in this file is not known yet",
  inexact: "This board cannot be imported exactly",
  unreadable: "This file could not be read",
  "no-board": "No board found",
  "bad-input": "The files could not be opened",
  failed: "Something went wrong",
  cancelled: "Cancelled",
}

/** How many lines of a list the screen shows; the downloaded report has all of them. */
export const SHOWN_LINES = 25
/** How many groups of set aside files the screen shows. */
export const SHOWN_GROUPS = 6

export type Tone = "ok" | "warn" | "bad"

export interface ReportLine {
  /** The thing the line is about, shown first and stronger. */
  lead?: string
  text: string
}

export interface ReportSection {
  title: string
  /** How many items there are, when it is a list worth counting. */
  count?: number
  lines: ReportLine[]
}

/** The title says "board" in its own words; for a project or a schematic it says that instead. */
const titleFor = (reason: SummaryReason, kind: ImportSummary["kind"]) => (kind && kind !== "board" ? TITLES[reason].replace("board", WHAT[kind]) : TITLES[reason])

export const reportTitle = (s: ImportSummary, saveError?: string | null, saveKind?: SaveKind | null) =>
  saveError ? (saveKind === "uncertain" ? "Saving did not finish" : "Not saved") : s.status === "imported" ? "Imported from KiCad" : s.reason ? titleFor(s.reason, s.kind) : "Not imported"

/** The sentence under the title: the importer's own message for a refusal, the reason for a failed save. */
export const reportLead = (s: ImportSummary, saveError?: string | null) => saveError ?? s.message

/** What to do after a failed save, by what the failure means (`SaveKind`). */
export const saveNextStep = (kind?: SaveKind | null, what: ImportSummary["kind"] = "board") => {
  const it = `The ${WHAT[what ?? "board"]} itself`
  return kind === "uncertain"
    ? `${it} was read without problems. The project may be in your projects list already: look there first, and import it again only if it is not.`
    : kind === "final"
      ? `${it} was read without problems, but trying again would give the same answer. Download the report to keep what was found.`
      : `${it} was read without problems. Try again, or download the report and come back later.`
}

/** Green for an import with nothing left behind, amber when something was left out or changed, red for a refusal or a failed save. */
export const reportTone = (s: ImportSummary, saveError?: string | null): Tone =>
  saveError || s.status !== "imported" ? "bad" : s.notBrought.length || s.changed.length ? "warn" : "ok"

const more = (hidden: number) => ({ text: `and ${hidden} more, in the full report.` })

const entryLines = (list: EntryLine[]): ReportLine[] => {
  const lines = list.slice(0, SHOWN_LINES).map((l) => ({ lead: l.object, text: l.why }))
  return list.length > SHOWN_LINES ? [...lines, more(list.length - SHOWN_LINES)] : lines
}

export function reportSections(s: ImportSummary, saveError?: string | null): ReportSection[] {
  const out: ReportSection[] = []
  const add = (title: string, lines: ReportLine[], count?: number) => lines.length && out.push({ title, lines, ...(count !== undefined ? { count } : {}) })
  if (s.missing.length) {
    const what = WHAT[s.kind ?? "board"]
    add(
      `What this ${what} uses that Cherry Blossom cannot hold yet`,
      s.missing.map((m) => ({ lead: m.name, text: m.why })),
    )
    add("Nothing was imported", [{ text: `No part of the ${what} is wrong or half there. Cherry Blossom imports ${what === "board" ? "a board" : `a ${what}`} whole or not at all.` }])
  }
  if (s.status === "imported" && s.brought.length) {
    const lines: ReportLine[] = [{ text: `${s.brought.map((b) => `${b.count} ${b.label}`).join(", ")}.` }]
    if (s.accounted) lines.push({ text: `${s.accounted.imported} of the ${s.accounted.total} items in the file were brought in; ${s.accounted.notNeeded} were not needed.` })
    add(saveError ? "What was read" : "What came in", lines)
  }
  add("What was not brought in", entryLines(s.notBrought), s.notBrought.length)
  add("What changed on the way in", entryLines(s.changed), s.changed.length)
  add("Why it was not imported", entryLines(s.refusals), s.refusals.length)
  const notNeeded = s.notNeeded.slice(0, SHOWN_LINES).map((n) => ({ text: `${n.count > 1 ? `${n.count} items: ` : ""}${n.why}` }))
  add("Left out because it is not needed", s.notNeeded.length > SHOWN_LINES ? [...notNeeded, more(s.notNeeded.length - SHOWN_LINES)] : notNeeded, s.notNeeded.length)
  add("Good to know", entryLines(s.notes), s.notes.length)
  const notRead = s.notRead.slice(0, SHOWN_LINES).map((n) => ({ lead: n.file, text: n.why }))
  add("Files not read", s.notRead.length > SHOWN_LINES ? [...notRead, more(s.notRead.length - SHOWN_LINES)] : notRead, s.notRead.length)
  const groups = s.ignored.slice(0, SHOWN_GROUPS).map((g) => ({ text: `${g.count} ${g.count === 1 ? "file" : "files"}, ${g.why} (${g.examples.join(", ")}${g.count > g.examples.length ? ", ..." : ""})` }))
  const hidden = s.ignored.slice(SHOWN_GROUPS).reduce((a, i) => a + i.count, 0)
  add("Files set aside", hidden ? [...groups, { text: `and ${hidden} more files in other groups, in the full report.` }] : groups, s.ignored.reduce((a, i) => a + i.count, 0))
  return out
}
