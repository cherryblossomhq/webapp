import { serializeProject } from "../model/projectFile"
import { createStoredProject } from "../store/projectActions"
import type { ProjectStorage } from "../store/storage"
import type { ImportOutcome } from "./protocol"
import { saveReport } from "./reportStore"

/**
 * What a stored project may weigh, in bytes of its file: `MAX_DOCUMENT_BYTES` in
 * the hosted app's storage policy, and the importer's own limit. A test pins the three
 * together. It is repeated here so the page does not load the importer to know it.
 */
export const STORED_PROJECT_LIMIT_BYTES = 900 * 1024

/** A size in the words of the refusal: `1.4 MB`, `900 KB`. */
export const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`)

/**
 * What a failed save means for what the user can do next:
 * - `again`: nothing was saved and trying again may work (a dropped connection that said so);
 * - `final`: nothing was saved and trying again gives the same answer (too big, browser storage full);
 * - `uncertain`: the save may have gone through (a timeout), so trying again could make a second project.
 */
export type SaveKind = "again" | "final" | "uncertain"

/** A failed save, with its sentence and what to do next. */
export class SaveRefused extends Error {
  constructor(
    message: string,
    readonly kind: SaveKind,
  ) {
    super(message)
  }
}

/** Storage's own refusals that no retry will change. */
const FINAL = /too large|full or blocked/

/**
 * Store an imported project as a new project, through the same path the `.json` import uses
 * (`createStoredProject`), and keep its report beside it. The size is measured here again, on the
 * very text that would be stored, before anything is sent, so a project over the limit is refused
 * with nothing saved; storage itself makes the project in one call, so there is no half saved one.
 * Resolves to the new project's id.
 */
export async function saveImported(storage: ProjectStorage, outcome: ImportOutcome, name?: string): Promise<string> {
  const { project, summary } = outcome
  if (!project || summary.status !== "imported") throw new SaveRefused("There is no imported project to save.", "final")
  const bytes = new TextEncoder().encode(serializeProject(project)).length
  if (bytes > STORED_PROJECT_LIMIT_BYTES) {
    throw new SaveRefused(`This board needs ${sizeText(bytes)} and projects hold up to ${sizeText(STORED_PROJECT_LIMIT_BYTES)}. Nothing was saved.`, "final")
  }
  let id: string
  try {
    id = await createStoredProject(storage, project)
  } catch (e) {
    // A refusal storage explains itself (its storage is full) means nothing was written. Any other
    // failure may be a timeout after the write went through, so it does not claim that.
    if (e instanceof Error && e.message.startsWith("Couldn't")) throw new SaveRefused(`${e.message} Nothing was saved.`, FINAL.test(e.message) ? "final" : "again")
    throw new SaveRefused("Couldn't tell whether the project was saved. Check your projects list before importing the board again.", "uncertain")
  }
  saveReport(id, summary, name ?? project.name)
  return id
}
