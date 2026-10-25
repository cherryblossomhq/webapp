import type { EntryLine, ImportSummary } from "./summary"

// The report of a KiCad import, kept in this browser beside the project it made, so the project's
// panel can show it again. It is not part of the project file: a project opened on another
// computer, or after the browser's data is cleared, has no report, and says nothing about one.
// What is kept is bounded: the last 20 reports, each cut to a size a browser can hold. The
// download of the import has all of it.

const key = (projectId: string) => `cherryblossom:editor:kicad-report:${projectId}`
const INDEX = "cherryblossom:editor:kicad-report-index"
/** How many projects keep a report. A project deleted here forgets its own (`forgetReport`). */
export const MAX_REPORTS = 20
/** Entries kept per list. */
const MAX_ENTRIES = 300
const MAX_NOT_READ = 50
const MAX_NOT_NEEDED = 50
const MAX_IGNORED = 20
/** Longest text kept for one line. */
const MAX_TEXT = 400

export interface StoredReport {
  name: string
  summary: ImportSummary
}

const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text)

function shorten(list: EntryLine[], max = MAX_ENTRIES): EntryLine[] {
  const kept = list.slice(0, max).map((l) => ({ ...l, object: cut(l.object), why: cut(l.why) }))
  return list.length <= max ? kept : [...kept, { code: "shortened", object: `${list.length - max} more`, why: "The list was shortened to fit in this browser. Download the report when you import to keep all of it." }]
}

function readIndex(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(INDEX) ?? "[]")
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** The most one report may take in the browser, in characters of its JSON: 20 of them stay under 2 million, well inside the 5 million a browser gives a site. */
export const MAX_REPORT_CHARS = 100_000

/** The summary as it is kept, with every list cut to `entries` lines (and the file lists to a fraction of that). */
function shortened(summary: ImportSummary, entries: number): ImportSummary {
  const files = Math.max(0, Math.min(entries, 50))
  return {
    ...summary,
    notBrought: shorten(summary.notBrought, entries),
    changed: shorten(summary.changed, entries),
    notes: shorten(summary.notes, entries),
    refusals: shorten(summary.refusals, entries),
    notNeeded: summary.notNeeded.slice(0, Math.min(files, MAX_NOT_NEEDED)).map((n) => ({ ...n, why: cut(n.why) })),
    notRead: summary.notRead.slice(0, Math.min(files, MAX_NOT_READ)).map((n) => ({ file: cut(n.file), why: cut(n.why) })),
    ignored: summary.ignored.slice(0, Math.min(files, MAX_IGNORED)).map((g) => ({ ...g, why: cut(g.why), examples: g.examples.slice(0, 5).map(cut) })),
    missing: summary.missing.map((m) => ({ ...m, why: cut(m.why) })),
  }
}

export function saveReport(projectId: string, summary: ImportSummary, name: string) {
  try {
    // Cut again, harder, until the one report is small enough.
    let text = ""
    for (const entries of [MAX_ENTRIES, 100, 30, 10, 0]) {
      text = JSON.stringify({ name: cut(name), summary: shortened(summary, entries) } satisfies StoredReport)
      if (text.length <= MAX_REPORT_CHARS) break
    }
    // The index first: if it cannot be written nothing is stored, and a report is never one the index does not know,
    // which is what lets the oldest be found and forgotten.
    const index = [...readIndex().filter((id) => id !== projectId), projectId]
    const drop = index.splice(0, Math.max(0, index.length - MAX_REPORTS))
    localStorage.setItem(INDEX, JSON.stringify(index))
    for (const old of drop) localStorage.removeItem(key(old))
    localStorage.setItem(key(projectId), text)
  } catch {
    // storage full or blocked: the project is saved all the same, only its report is not kept
  }
}

export function loadReport(projectId: string): StoredReport | null {
  try {
    const raw = localStorage.getItem(key(projectId))
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<StoredReport>
    return stored.summary && typeof stored.name === "string" && Array.isArray(stored.summary.notBrought) ? (stored as StoredReport) : null
  } catch {
    return null
  }
}

export function forgetReport(projectId: string) {
  try {
    localStorage.removeItem(key(projectId))
    localStorage.setItem(INDEX, JSON.stringify(readIndex().filter((id) => id !== projectId)))
  } catch {
    // nothing to do
  }
}
