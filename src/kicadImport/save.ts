import { serializeProject } from "../model/projectFile"
import { putImageFile } from "../store/imageFiles"
import { createStoredProject } from "../store/projectActions"
import type { ProjectStorage } from "../store/storage"
import type { ImportOutcome } from "./protocol"
import { keepReportFile, saveReport } from "./reportStore"

/**
 * What a stored project may weigh, in bytes of its file: the hosted app's storage limit,
 * and the importer's own limit. A test pins the two
 * together. It is repeated here so the page does not load the importer to know it. Up to 3 MB a
 * project is kept in a row; past that, as a file and a log, which storage sees to.
 */
export const STORED_PROJECT_LIMIT_BYTES = 32 * 1024 * 1024

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
  const { summary } = outcome
  let project = outcome.project
  if (!project || summary.status !== "imported") throw new SaveRefused("There is no imported project to save.", "final")
  const bytes = new TextEncoder().encode(serializeProject(project)).length
  if (bytes > STORED_PROJECT_LIMIT_BYTES) {
    throw new SaveRefused(`This board needs ${sizeText(bytes)} and projects hold up to ${sizeText(STORED_PROJECT_LIMIT_BYTES)}. Nothing was saved.`, "final")
  }
  // The files the project names (reference images, embedded fonts) go to the file store first, so a project is never saved naming files that are not kept (and a refused one leaves only files, which cost nothing but room).
  let modelsLost = 0
  for (const f of outcome.files ?? []) {
    const isOriginal = project?.kicad?.original?.file === f.id
    const isModel = !isOriginal && !!project?.models?.some((m) => m.model.source === "file" && m.model.id === f.id)
    try {
      const kept = await putImageFile(f.name, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
      if (kept !== f.id) throw new Error("The file was kept under another name than the project's.")
    } catch (e) {
      // The user's own KiCad files are a kindness, not what the project is: an account that cannot hold them (its files are full) still gets the project, which then exports as it always did.
      if (isOriginal && project) {
        const { original: _dropped, ...rest } = project.kicad!
        project = { ...project, kicad: Object.keys(rest).length ? rest : undefined }
        summary.notes = [...summary.notes.filter((n) => n.code !== "originals-kept"), { code: "originals-not-kept", object: "Your original KiCad files could not be kept", why: `${e instanceof Error && e.message ? e.message : "The account's files are full"} The project is saved, and export writes every file from it.` }]
        continue
      }
      // A 3D model the board came with is how a part looks, not what it is: the part keeps its model line for the export and draws its pads only.
      if (isModel) {
        modelsLost++
        if (modelsLost === 1) summary.notes.push({ code: "models-not-kept", object: "3D model files of the board", why: `${e instanceof Error && e.message ? e.message : "The account's files are full"} The parts they belong to show their pads only, and the export still names the files.` })
        continue
      }
      throw new SaveRefused(`Couldn't keep the board's files (reference images and embedded fonts)${e instanceof Error && e.message ? `: ${e.message}` : ""}. Nothing was saved.`, "again")
    }
  }
  // The report goes to the file store too, and the project names it, so it opens on any computer; a store that refuses it leaves it in this browser only.
  const report = await keepReportFile(summary, name ?? project.name)
  if (report) project = { ...project, kicad: { ...project.kicad, report } }
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
