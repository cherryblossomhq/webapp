import type { ToolVersions } from "../ai/toolKit"
import { PROJECT_FILE_VERSION } from "../model/projectFile"
import { versionLabel, type HistorySource, type HistoryState, type VersionInfo } from "./history"
import { projectApi, projectStorage, settleSaves } from "./projectStore"
import { openStoredProject, projectRecord } from "./storage"

/**
 * What the history panel and the preview banner do: show an older version of the open project in
 * place of it, read-only, make the version being shown the project's state again, fork a version
 * into a new project and delete one. Each says what went wrong in words for the user rather than throw.
 */

export type ActionResult = { ok: true } | { ok: false; message: string }

const NO_HISTORY = { ok: false, message: "This project's storage keeps no history." } as const

const openFailure = (error: unknown, doing: string) =>
  error instanceof Error && /newer|too new/i.test(error.message) ? "This version was saved by a newer editor. Reload the page to get it." : `Couldn't ${doing}. Check the connection and try again.`

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
    return { ok: false, message: openFailure(error, "open that version") }
  }
}

/** Leave the preview and go back to the project as it is. */
export const leavePreview = () => projectApi().endPreview()

/** What a fork is called: the project's name, with the version's name or when it was ("Blinky (Nov 5, 3:10 PM)"). */
export function forkName(projectName: string, version: Pick<VersionInfo, "name" | "at">): string {
  const when = new Date(version.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  return `${projectName} (${version.name ?? when})`
}

/**
 * A version of the open project as a new project of the user's own, as Duplicate makes one on the projects page: the open
 * project and its history are untouched. Anyone signed in who can open the project may, a viewer too.
 */
export async function forkVersion(version: Pick<VersionInfo, "id" | "name" | "at">): Promise<{ ok: true; id: string; name: string } | { ok: false; message: string }> {
  const storage = projectStorage()
  const project = projectApi().project
  if (!storage?.history || !project) return NO_HISTORY
  try {
    const opened = await storage.history.open(project.id, version.id)
    if (!opened) return { ok: false, message: "That version is gone. It may have been thinned out of the history." }
    const forked = openStoredProject({ id: project.id, content: opened.content, revision: opened.revision, formatVersion: opened.formatVersion, createdAt: project.createdAt, updatedAt: opened.at })
    const name = forkName(project.name, version)
    const { id } = await storage.create(projectRecord({ ...forked, name }))
    return { ok: true, id, name }
  } catch (error) {
    return { ok: false, message: openFailure(error, "fork that version") }
  }
}

/** Delete a version for good (editors and owners). The project is untouched; a preview of that version is left. */
export async function deleteVersion(versionId: string): Promise<ActionResult> {
  const source = projectStorage()?.history
  const project = projectApi().project
  if (!source || !project) return NO_HISTORY
  try {
    const outcome = await source.remove(project.id, versionId)
    if (!outcome.ok) return { ok: false, message: outcome.reason === "forbidden" ? "Only people who can edit the project can delete a version." : "That version is already gone." }
    if (projectApi().preview?.version.id === versionId) projectApi().endPreview()
    return { ok: true }
  } catch {
    return { ok: false, message: "Couldn't delete that version. Check the connection and try again." }
  }
}

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

/** How long Sakura waits for the history to answer before its tool says so: offline, a subscription never does. */
const READ_LIMIT_MS = 20_000

/** The history as it is now, read once from its subscription. */
function readHistory(source: HistorySource, projectId: string, limit: number): Promise<HistoryState | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stop: (() => void) | undefined
    const end = () => {
      clearTimeout(timer)
      stop?.()
      stop = undefined
    }
    const timer = setTimeout(() => {
      settled = true
      end()
      reject(new Error("The version history didn't answer. Check the connection and try again."))
    }, READ_LIMIT_MS)
    stop = source.watch(
      projectId,
      limit,
      (state) => {
        if (settled) return
        settled = true
        end()
        resolve(state)
      },
      (error) => {
        if (settled) return
        settled = true
        end()
        reject(error)
      },
    )
    // It answered before `watch` returned the way to stop it.
    if (settled) end()
  })
}

/**
 * The open project's history for Sakura's tools (`ToolContext.versions`): what this tab has sent lands first, so a checkpoint,
 * or the copy kept before a restore, holds Sakura's latest changes. None where storage keeps no history (this browser's).
 */
export function copilotVersions(projectId: string): ToolVersions | undefined {
  const source = projectStorage()?.history
  if (!source) return undefined
  return {
    list: (limit) => readHistory(source, projectId, limit),
    async name(name, versionId) {
      await settleSaves()
      return source.name(projectId, name, versionId)
    },
    open: (versionId) => source.open(projectId, versionId),
    async keep(versionId) {
      await settleSaves()
      return source.keep(projectId, versionId)
    },
  }
}
