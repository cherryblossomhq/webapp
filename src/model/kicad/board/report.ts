// The import report: what a KiCad import did with the file, in words for whoever imported it.
// Every node of the file is in one of three states (imported, deliberately not needed with its
// reason, or reported), and anything the reader does not know is an entry here, never a skip and
// never a crash.

export type ReportSeverity =
  /** The board is not imported, and the entry says why. */
  | "refused"
  /** Something in the file is not in the project, named, with the reason. */
  | "not-brought"
  /** Something came across changed (a renamed part, a repaired outline), named. */
  | "changed"
  /** Information: what was read, what is recomputed. */
  | "note"

export interface ReportEntry {
  /** A short stable word for tests and for grouping: `unknown-node`, `unsupported`, `renamed-ref`... */
  code: string
  severity: ReportSeverity
  /** The object, named: `footprint R12, pad 3`, `3D model of U1`, `the board`. */
  object: string
  /** Why, in plain words. */
  why: string
  /** How many objects the entry stands for, when it groups several. */
  count?: number
}

/** What became of the nodes of the file, by the decision table (`decisions.ts`). */
export interface NodeAccount {
  /** Every list of the file by its path from the root (`footprint>pad>at`), with its count. */
  paths: Map<string, number>
  total: number
  /** Nodes written into the project by the builder (the table says native, or an extension the board does not need and the builder carries). */
  imported: number
  /** The same, by path: what a test checks against the built project. */
  importedPaths: Map<string, number>
  /** Nodes deliberately not needed, by their reason. */
  notNeeded: Map<string, number>
  /** Nodes that need an extension of the editor that is not built yet, by extension. */
  pending: Map<string, number>
  /** Nodes that cannot be represented even with every extension; they are in the report. */
  reported: number
  /** Paths the decision table has no row for. */
  unknownPaths: Map<string, number>
  /** Bare words at a place the table knows but not this word, as `footprint>pad hexagon`. */
  unknownAtoms: Map<string, number>
}

export interface ImportReport {
  entries: ReportEntry[]
  account: NodeAccount | null
}

export const newReport = (): ImportReport => ({ entries: [], account: null })

export const refusals = (report: ImportReport) => report.entries.filter((e) => e.severity === "refused")
