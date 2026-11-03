import { downloadText, projectFileName } from "../export/bundle"
import { forgetReport } from "../kicadImport/reportStore"
import type { Example } from "../model/examples"
import { parseProjectFile, ProjectFileError, serializeProject } from "../model/projectFile"
import type { Project } from "../model/types"
import { boardPreview, drawnPreview, forgetPreview, queue, rasterize } from "../pages/previews"
import { openStoredProject, projectRecord, type ProjectStorage, type SaveRefusal, type StoredProjectSummary } from "./storage"

/**
 * What a projects page does to stored projects: the editor's own dashboard and the website's
 * `/projects` both run these, so the two can't disagree about what duplicating or renaming means.
 * Each throws an `Error` whose message is a sentence for the page's error line (see `actionFailure`);
 * opening a project is the caller's, since only it knows where the editor is.
 */

/** What went wrong, in a sentence for a projects page's error line. */
export const actionFailure = (error: unknown, doing: string) =>
  error instanceof ProjectFileError ? error.message : error instanceof Error && error.message.startsWith("Couldn't") ? error.message : `Couldn't ${doing}. Check your connection and try again.`

const RENAME_REFUSED: Record<SaveRefusal, string> = {
  conflict: "it changed somewhere else meanwhile. Try again.",
  not_found: "it was deleted elsewhere.",
  too_large: "it is too large to save.",
  outdated: "a newer version of Cherry Blossom saved it. Reload the page, then try again.",
  forbidden: "it is shared with you to view, not to change.",
}

/** A project as it will be stored, new: its own id and dates come from storage. Resolves to its id. */
export async function createStoredProject(storage: ProjectStorage, project: Project): Promise<string> {
  const { id } = await storage.create(projectRecord(project))
  return id
}

/** The stored project, opened; throws when it is gone. */
async function read(storage: ProjectStorage, m: StoredProjectSummary) {
  const stored = await storage.load(m.id)
  if (!stored) throw new Error(`Couldn't find “${m.name}”: it was deleted elsewhere.`)
  return { project: openStoredProject(stored), revision: stored.revision }
}

/** A downloaded project file, stored as a new project. Resolves to its id. */
export async function importProjectFile(storage: ProjectStorage, file: File): Promise<string> {
  let project: Project
  try {
    project = parseProjectFile(await file.text(), { id: "import" })
  } catch (e) {
    if (e instanceof ProjectFileError && e.problem === "too_new") throw e
    throw new Error(`Couldn't import ${file.name}: it isn't a Cherry Blossom project file.`)
  }
  return createStoredProject(storage, project)
}

export async function duplicateStoredProject(storage: ProjectStorage, m: StoredProjectSummary): Promise<string> {
  const { project } = await read(storage, m)
  return createStoredProject(storage, { ...project, name: `${project.name} copy` })
}

export async function downloadStoredProject(storage: ProjectStorage, m: StoredProjectSummary) {
  const { project } = await read(storage, m)
  downloadText(serializeProject(project, { pretty: true }), projectFileName(project, "json"), "application/json")
}

export async function renameStoredProject(storage: ProjectStorage, m: StoredProjectSummary, name: string) {
  const { project, revision } = await read(storage, m)
  const outcome = await storage.replace(m.id, revision, projectRecord({ ...project, name }))
  if (!outcome.ok) throw new Error(`Couldn't rename “${m.name}”: ${RENAME_REFUSED[outcome.reason]}`)
}

export async function removeStoredProject(storage: ProjectStorage, id: string) {
  await storage.remove(id)
  forgetPreview(id)
  forgetReport(id)
}

/**
 * A stored project's preview, as SVG text for an image; `null` when it can't be read, which draws a placeholder.
 * Downloaded and drawn only when the one kept in this browser is older than the project (`pages/previews.ts`).
 */
export function previewProject(storage: ProjectStorage, m: StoredProjectSummary): Promise<string | null> {
  return boardPreview({ key: m.id, updatedAt: m.updatedAt, file: async () => (await storage.load(m.id))?.content ?? null })
}

/** An example's preview, as SVG text for an image, drawn once a visit. */
export function examplePreview(example: Example): Promise<string | null> {
  return boardPreview({ key: `example:${example.id}`, file: () => serializeProject(example.project) })
}

/** A preview to show: a kept picture's link, or SVG text drawn here. */
export type PreviewPicture = { url: string } | { svg: string }

/**
 * What a projects page shows for a project. The picture kept with it, at once, when there is one: the list
 * hands out its link, so nothing else is downloaded. Otherwise the preview is drawn here (`previewProject`).
 *
 * For someone who may edit the project, a picture that is missing, or older than the project, is drawn here and kept
 * (`storage.saveThumbnail`) in the background, one at a time, so the next visit, theirs or a collaborator's, shows it
 * at once. A stale picture is shown meanwhile: it is the board as it was, which beats nothing.
 */
export function projectPicture(storage: ProjectStorage, m: StoredProjectSummary): Promise<PreviewPicture | null> {
  const keeps = !!storage.saveThumbnail && (m.role ?? "owner") !== "viewer"
  if (m.thumbnail) {
    if (keeps && m.thumbnail.madeAt < m.updatedAt) void previewProject(storage, m).then((svg) => svg && keepPicture(storage, m, svg))
    // The picture this page just drew and kept: the card already shows it, so it stays as it is rather than
    // swapping to the same board fetched back from storage.
    const drawn = m.thumbnail.madeAt >= m.updatedAt ? drawnPreview(m.id, m.updatedAt) : undefined
    const url = m.thumbnail.url
    if (drawn) return drawn.then((svg): PreviewPicture => (svg ? { svg } : { url }))
    return Promise.resolve({ url })
  }
  return previewProject(storage, m).then((svg) => {
    if (svg && keeps) keepPicture(storage, m, svg)
    return svg ? { svg } : null
  })
}

const pictureUploads = queue(1)
/** Pictures asked to be kept this visit, by project and change: each is tried once. */
const keeping = new Set<string>()

function keepPicture(storage: ProjectStorage, m: StoredProjectSummary, svg: string) {
  const key = `${m.id}@${m.updatedAt}`
  if (keeping.has(key)) return
  keeping.add(key)
  void pictureUploads.run(async () => {
    const picture = await rasterize(svg)
    if (picture) await storage.saveThumbnail?.(m.id, picture, m.updatedAt).catch(() => false)
  })
}
