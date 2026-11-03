import { PROJECT_FILE_VERSION } from "../model/projectFile"
import type { KeptBatch } from "./sync"

/**
 * Edits that hadn't reached storage when the page went, kept in this browser tab's
 * `sessionStorage` so a reload doesn't lose them: the next page in the tab opens the project with
 * them on top and sends them first (`ProjectSync.start`). It is written only as the page goes
 * (`pagehide`, or the save strip's Reload), never per edit, and only a tab's own next page reads
 * it, so two open tabs never take each other's edits. A closed tab takes its `sessionStorage` with
 * it, which is why leaving still asks first.
 */

const PREFIX = "cherryblossom:unsent:"

interface Kept {
  /** Changes are worked out on the project in this editor's format, and mean something else in another. */
  formatVersion: number
  batches: KeptBatch[]
}

const written = new Set<string>()

function store(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    // Storage blocked for the site.
    return null
  }
}

/** Keep each project's unsent batches for the next page in this tab. False when some couldn't be kept (no storage, or full). */
export function keepEdits(byProject: Map<string, KeptBatch[]>): boolean {
  if (!byProject.size) return true
  const session = store()
  if (!session) return false
  let kept = true
  for (const [id, batches] of byProject) {
    try {
      session.setItem(PREFIX + id, JSON.stringify({ formatVersion: PROJECT_FILE_VERSION, batches } satisfies Kept))
      written.add(PREFIX + id)
    } catch {
      kept = false
    }
  }
  return kept
}

/** The batches the page before this one in the tab kept for a project, taken: they are the sync's from now on. */
export function takeKeptEdits(id: string): KeptBatch[] {
  const session = store()
  const text = session?.getItem(PREFIX + id)
  if (!session || !text) return []
  session.removeItem(PREFIX + id)
  try {
    const kept = JSON.parse(text) as Kept
    return kept.formatVersion === PROJECT_FILE_VERSION && Array.isArray(kept.batches) ? kept.batches : []
  } catch {
    return []
  }
}

/** The page came back from the browser's back-forward cache with its edits still in memory: what it kept as it went is stale. */
export function forgetKeptEdits() {
  const session = store()
  for (const key of written) session?.removeItem(key)
  written.clear()
}
