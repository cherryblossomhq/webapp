import { downloadText, projectFileName } from "../export/bundle"
import { parseProjectFile, ProjectFileError, serializeProject } from "../model/projectFile"
import type { Project } from "../model/types"
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
  const outcome = await storage.save(m.id, revision, projectRecord({ ...project, name }))
  if (!outcome.ok) throw new Error(`Couldn't rename “${m.name}”: ${RENAME_REFUSED[outcome.reason]}`)
}

export async function removeStoredProject(storage: ProjectStorage, id: string) {
  await storage.remove(id)
  previews.delete(id)
}

/** Stored projects for previews, read again only once a project has changed. */
const previews = new Map<string, { updatedAt: number; project: Promise<Project | null> }>()

/** A stored project to draw a preview of; `null` when it can't be read, which draws a placeholder. */
export function previewProject(storage: ProjectStorage, m: StoredProjectSummary): Promise<Project | null> {
  const hit = previews.get(m.id)
  if (hit?.updatedAt === m.updatedAt) return hit.project
  const project = storage
    .load(m.id)
    .then((stored) => (stored ? openStoredProject(stored) : null))
    .catch(() => null)
  previews.set(m.id, { updatedAt: m.updatedAt, project })
  return project
}
