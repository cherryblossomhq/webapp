import type { Project } from "../model/types"
import type { BoardChoice } from "./pick"
import type { ImportSummary } from "./summary"

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

export type ImportOutcome = { summary: ImportSummary; project: Project | null }

export type WorkerEvent =
  | { type: "progress"; id: number; phase: Phase }
  | { type: "choose"; id: number; boards: BoardChoice[] }
  | { type: "done"; id: number; outcome: ImportOutcome }

export const PHASE_LABELS: Record<Phase | "saving", string> = {
  reading: "Reading the files",
  building: "Building the project and checking its size",
  saving: "Saving the project",
}
