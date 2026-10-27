import { PROJECT_FILE_VERSION } from "../model/projectFile"
import { versionLabel, type VersionInfo } from "./history"
import { projectApi, projectStorage, settleSaves } from "./projectStore"
import { openStoredProject } from "./storage"

/**
 * What the history panel and the preview banner do: show an older version of the open project in
 * place of it, read-only, and make the version being shown the project's state again. Both say
 * what went wrong in words for the user rather than throw.
 */

export type ActionResult = { ok: true } | { ok: false; message: string }

const NO_HISTORY: ActionResult = { ok: false, message: "This project's storage keeps no history." }

/** Open a version of the open project in the canvas, without changing the project. */
export async function previewVersion(version: Pick<VersionInfo, "id" | "name" | "kind" | "restoredFromAt" | "at">): Promise<ActionResult> {
  const source = projectStorage()?.history
  const project = projectApi().project
  if (!source || !project) return NO_HISTORY
  try {
    const opened = await source.open(project.id, version.id)
    if (!opened) return { ok: false, message: "That version is gone. It may have been thinned out of the history." }
    const shown = openStoredProject({ id: project.id, content: opened.content, revision: opened.revision, formatVersion: opened.formatVersion, createdAt: project.createdAt, updatedAt: opened.at })
    // The project may have been closed or switched while the version loaded.
    if (projectApi().project?.id !== project.id) return { ok: true }
    projectApi().startPreview(shown, { id: version.id, at: version.at, name: version.name, label: versionLabel(version) })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error && /newer|too new/i.test(error.message) ? "This version was saved by a newer editor. Reload the page to get it." : "Couldn't open that version. Check the connection and try again." }
  }
}

/** Leave the preview and go back to the project as it is. */
export const leavePreview = () => projectApi().endPreview()

const RESTORE_REFUSED: Record<string, string> = {
  not_found: "That version, or the project, is gone.",
  forbidden: "Only people who can edit the project can restore a version.",
  outdated: "This version was saved by a newer editor. Reload the page to restore it.",
  too_large: "This version is too large to restore.",
}

/**
 * Make the version being previewed the project's state. The edits this tab has sent are let land
 * first, so they are in what is kept as "before the restore"; the restore is then a new change in
 * the log, which every open copy (this one too) loads and carries on from.
 */
export async function restorePreview(): Promise<ActionResult> {
  const source = projectStorage()?.history
  const { project, preview } = projectApi()
  if (!source || !project || !preview) return NO_HISTORY
  if (preview.liveRole === "viewer") return { ok: false, message: RESTORE_REFUSED.forbidden }
  try {
    await settleSaves()
    const outcome = await source.restore(project.id, preview.version.id, PROJECT_FILE_VERSION)
    if (!outcome.ok) return { ok: false, message: RESTORE_REFUSED[outcome.reason] }
    // The log's entry for the restore makes every copy, this one too, load the restored document at once.
    projectApi().endPreview()
    projectApi().clearHistory()
    return { ok: true }
  } catch {
    return { ok: false, message: "Couldn't restore. Check the connection and try again." }
  }
}
