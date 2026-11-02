import type { KeptFile } from "../model/kicad/board/images"
import type { Project } from "../model/types"
import type { BoardChoice } from "./pick"
import type { EntryLine, ImportSummary } from "./summary"

// The messages between the page and the import's worker. One job at a time: the page starts a job
// with `start`, the worker answers with `progress` events and ends it with one `choose` or `done`.
// Cancelling is the page ending the worker, so there is no cancel message to get wrong.

/** A file handed to the worker: the browser's own `File` (copied across without reading it) and its path inside a dropped folder. */
export interface InputEntry {
  path: string
  file: File
}

export interface StartRequest {
  type: "start"
  id: number
  files: InputEntry[]
  /** The board chosen from several, by its path; absent on the first try. */
  choice?: string
}

/** Where a job is. The importer reads and builds in one call, so building covers the size check that ends it. */
export type Phase = "reading" | "building"

/** What an import hands back: the summary, the project, and the files the project names that the host keeps (a board's reference images), by the SHA-256 the project holds them by. */
export type ImportOutcome = {
  summary: ImportSummary
  project: Project | null
  files?: KeptFile[]
  /**
   * What a board the export writes whole (KiCad 9's file) leaves out of this project, set aside from the report because the user's own files are kept and the export patches them,
   * which loses none of it. The save puts it back in the report when the files cannot be kept after all.
   */
  wholeBoard?: EntryLine[]
}

export type WorkerEvent =
  | { type: "progress"; id: number; phase: Phase }
  | { type: "choose"; id: number; boards: BoardChoice[] }
  | { type: "done"; id: number; outcome: ImportOutcome }

/** The page's own steps after the importer's: looking up the parts' LCSC numbers (when the board has any), and saving. */
export const PHASE_LABELS: Record<Phase | "matching" | "saving", string> = {
  reading: "Reading the files",
  building: "Building the project and checking its size",
  matching: "Looking up the parts' LCSC numbers",
  saving: "Saving the project",
}
