import { applyChanges, type Change } from "@cherryblossom/project-changes"
import { uid } from "../lib/id"
import { parseProjectFile, PROJECT_FILE_VERSION, serializeProject, summarizeProject, type ProjectSummary } from "../model/projectFile"
import type { Project } from "../model/types"
import type { HistorySource } from "./history"
import type { LockSource } from "./boardLease"
import type { PresenceSource } from "./presence"
import type { SharingSource } from "./sharing"

/**
 * Where projects are kept. The editor holds no backend of its own: the host hands it one, the
 * way it hands it a managed-AI session. The website's is the signed-in account;
 * `browserProjectStorage` below is this browser's `localStorage`, for the development harness and
 * the tests.
 *
 * Every implementation stores the same thing, a project file (`model/projectFile.ts`) as text
 * with its summary beside it, so the editor can list projects without opening them. Storage
 * moves text and never reads the project's model; the editor is the only reader and writer of
 * the format.
 *
 * **Several people (or tabs) edit one project at once.** An open project sends what each edit
 * changed as a batch of `Change`s (`push`, from `@cherryblossom/project-changes`), and storage
 * applies the batch to the stored file and numbers it with the project's next revision. Every open
 * copy follows those batches as they land (`watchChanges`) and applies them in the same order, so
 * every copy ends up holding the same project. `store/sync.ts` is the editor's side of that.
 */
export interface ProjectStorage {
  /** Where the user's projects live, for the copy that says so. */
  location: "account" | "browser"
  /** The user's projects and the ones shared with them, newest first, now and whenever they change; `null` while loading. */
  watchList(listener: (projects: StoredProjectSummary[] | null) => void, onError: (error: Error) => void): () => void
  /** One project's file, or null when there is no such project for this user. */
  load(id: string): Promise<StoredProject | null>
  create(record: ProjectRecord, dates?: { createdAt?: number; updatedAt?: number }): Promise<{ id: string; revision: number }>
  /** Apply one batch of changes from an open copy. Refusals are answers; a fault (offline) is a rejected promise. */
  push(id: string, batch: OutgoingBatch): Promise<PushOutcome>
  /**
   * Write a project whole over `baseRevision`, the revision it was read at: an upgrade to a newer
   * file format, or a rename from a projects page. Refused (`conflict`) when it changed since, so
   * it never writes over an edit it didn't see; open copies load it again.
   */
  replace(id: string, baseRevision: number, record: ProjectRecord): Promise<SaveOutcome>
  /**
   * Every batch applied to a project after revision `after`, in order, as it lands, until the
   * returned function is called. The listener is also told the caller's role on every answer, so a
   * copy hears at once that it was made read-only.
   */
  watchChanges(id: string, after: number, listener: (event: ChangesEvent) => void, onError: (error: Error) => void): () => void
  /** Whether storage can be reached now, as it changes: an open project says when edits are waiting for the connection. */
  watchConnection?(listener: (online: boolean) => void): () => void
  /** Delete a project: the owner deletes it for everyone, anyone else leaves it. */
  remove(id: string): Promise<void>
  /** Sharing by email (the Share dialog). Absent where projects are one person's, as in this browser's storage. */
  sharing?: SharingSource
  /** Who else has a project open (faces, cursors, selections). */
  presence?: PresenceSource
  /** Version history: copies kept as the project is edited, named, previewed and restored. Absent where projects are one browser's. */
  history?: HistorySource
  /** The board lease: one tab at a time runs a whole-board action (route, re-place, tidy). Absent where projects are one person's: every action goes ahead. */
  locks?: LockSource
}

/** What someone may do to a project: the owner and editors edit it, viewers look. */
export type ProjectRole = "owner" | "editor" | "viewer"

/** A project as written to storage. */
export interface ProjectRecord extends ProjectSummary {
  /** The project file (`serializeProject`). */
  content: string
  /** The file's `version`, kept beside it so storage can find old documents without parsing them. */
  formatVersion: number
}

export interface StoredProjectSummary extends ProjectSummary {
  id: string
  createdAt: number
  updatedAt: number
  /** The user's role on it; the owner's when storage doesn't say. */
  role?: ProjectRole
  /** People besides its owner who have it. */
  sharedWith?: number
  /** What anyone signed in with its link may do, while it is shared by link. */
  link?: "editor" | "viewer"
  /** Who shared it, on a project the user doesn't own. */
  owner?: { name: string; email: string; pictureUrl?: string }
}

export interface StoredProject {
  id: string
  content: string
  revision: number
  /** The stored file's format version: older than the editor's, and the editor upgrades it before editing. */
  formatVersion?: number
  role?: ProjectRole
  createdAt: number
  updatedAt: number
}

/**
 * One batch of changes from an open copy. `clientId` is the copy's (one per open project per tab)
 * and `batch` its own count of batches: a batch whose answer never came is sent again under the
 * same number, and storage answers one that landed with its revision rather than applying it twice.
 */
export interface OutgoingBatch {
  clientId: string
  batch: number
  changes: Change[]
  formatVersion: number
  /** Parts on the board after it, for the projects list. */
  componentCount: number
}

/**
 * Why a batch was turned away. Answers, not faults:
 *
 * - `not_found`: deleted, or no longer shared with this user.
 * - `forbidden`: shared with them to view, not to edit.
 * - `outdated`: stored in a newer format than this editor writes.
 * - `conflict`: stored in an older format than this editor writes: the copy loads it again and
 *   upgrades it.
 * - `too_large`: it would take the project over what one project may store.
 * - `invalid`: not changes storage could apply.
 */
export type PushRefusal = "not_found" | "forbidden" | "outdated" | "conflict" | "too_large" | "invalid"

export type PushOutcome = { ok: true; revision: number } | { ok: false; reason: PushRefusal }

/** A batch as storage applied it. `changes` is null when it replaced the project whole: load it again. */
export interface RemoteBatch {
  revision: number
  clientId: string
  batch: number
  /** Who sent it. */
  userId: string
  changes: Change[] | null
}

export type ChangesEvent =
  /** Batches after the last one delivered (perhaps none, when only the role is news). */
  | { type: "batches"; role: ProjectRole; revision: number; batches: RemoteBatch[] }
  /** The log no longer reaches back to where this copy is: load the project again. */
  | { type: "reset"; role: ProjectRole }
  /** Deleted, or no longer shared with this user. */
  | { type: "gone" }

/**
 * Why a whole write was turned away:
 *
 * - `conflict`: changed somewhere else since it was read.
 * - `not_found`: deleted, or no longer shared.
 * - `too_large`: over what one project may store.
 * - `outdated`: stored in a newer format than this editor writes.
 * - `forbidden`: shared with this user to view.
 */
export type SaveRefusal = "conflict" | "not_found" | "too_large" | "outdated" | "forbidden"

export type SaveOutcome = { ok: true; revision: number } | { ok: false; reason: SaveRefusal }

export function projectRecord(project: Project): ProjectRecord {
  return { ...summarizeProject(project), content: serializeProject(project), formatVersion: PROJECT_FILE_VERSION }
}

/** Read a stored project into the editor. Throws `ProjectFileError` for one it can't read. */
export const openStoredProject = (stored: StoredProject): Project => parseProjectFile(stored.content, stored)

// ---------- This browser's storage ----------

const INDEX_KEY = "cherryblossom:editor:index"
const projectKey = (id: string) => `cherryblossom:editor:project:${id}`
const CHANGED = "cherryblossom:editor:projects-changed"

/** An index entry. Entries written before revisions existed have none, and read as revision 0. */
interface IndexEntry extends StoredProjectSummary {
  revision?: number
}

const STORAGE_FULL = "Couldn't save the project: this browser's storage is full or blocked."

function readIndex(): IndexEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter((e): e is IndexEntry => !!e && typeof e.id === "string") : []
  } catch {
    return []
  }
}

function writeIndex(index: IndexEntry[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  window.dispatchEvent(new Event(CHANGED))
}

const summaryOf = (e: IndexEntry): StoredProjectSummary => ({
  id: e.id,
  name: e.name,
  description: e.description ?? "",
  componentCount: e.componentCount ?? 0,
  createdAt: e.createdAt ?? e.updatedAt,
  updatedAt: e.updatedAt,
})

const listIndex = () => readIndex().map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt)

function put(entry: IndexEntry, content: string) {
  try {
    // A project before its index entry: an entry for a project that didn't save would list a
    // board that can't be opened.
    localStorage.setItem(projectKey(entry.id), content)
    writeIndex([entry, ...readIndex().filter((e) => e.id !== entry.id)])
  } catch {
    throw new Error(STORAGE_FULL)
  }
}

/**
 * The latest batches applied to each project in this browser, the log other tabs follow. Kept
 * short: a tab further behind than this loads the project again.
 */
const logKey = (id: string) => `cherryblossom:editor:log:${id}`
const LOG_LENGTH = 200

interface LogEntry {
  revision: number
  clientId: string
  batch: number
  /** `Change[]` as JSON, or null for a whole write. */
  changes: string | null
}

function readLog(id: string): LogEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(logKey(id)) ?? "[]") as unknown
    return Array.isArray(raw) ? (raw as LogEntry[]) : []
  } catch {
    return []
  }
}

/** Log a batch. Its revision isn't in the index yet; one left by a write that then failed is replaced. */
function appendLog(id: string, entry: LogEntry) {
  try {
    const log = readLog(id).filter((e) => e.revision < entry.revision)
    localStorage.setItem(logKey(id), JSON.stringify([...log, entry].slice(-LOG_LENGTH)))
  } catch {
    // Full: the other tabs find a gap and load the project again.
    localStorage.removeItem(logKey(id))
  }
}

/** A stored file's format version, without reading the project: 0 for a bare project from before the envelope. */
function fileVersion(content: string): number {
  try {
    const version = (JSON.parse(content) as { version?: unknown }).version
    return typeof version === "number" ? version : 0
  } catch {
    return 0
  }
}

export function browserProjectStorage(): ProjectStorage {
  return {
    location: "browser",
    watchList(listener) {
      const emit = () => listener(listIndex())
      emit()
      const onStorage = (e: StorageEvent) => e.key === INDEX_KEY && emit()
      window.addEventListener(CHANGED, emit)
      window.addEventListener("storage", onStorage)
      return () => {
        window.removeEventListener(CHANGED, emit)
        window.removeEventListener("storage", onStorage)
      }
    },
    async load(id) {
      const entry = readIndex().find((e) => e.id === id)
      const content = localStorage.getItem(projectKey(id))
      if (!entry || content === null) return null
      const { createdAt, updatedAt } = summaryOf(entry)
      return { id, content, revision: entry.revision ?? 0, formatVersion: fileVersion(content), role: "owner", createdAt, updatedAt }
    },
    async create(record, dates) {
      const now = Date.now()
      const entry: IndexEntry = { ...summaryEntry(record), id: uid("p"), createdAt: dates?.createdAt ?? now, updatedAt: dates?.updatedAt ?? now, revision: 1 }
      put(entry, record.content)
      return { id: entry.id, revision: 1 }
    },
    async push(id, batch) {
      const entry = readIndex().find((e) => e.id === id)
      const content = localStorage.getItem(projectKey(id))
      if (!entry || content === null) return { ok: false, reason: "not_found" }
      const log = readLog(id)
      const landed = log.find((e) => e.clientId === batch.clientId && e.batch === batch.batch)
      if (landed) return { ok: true, revision: landed.revision }
      let file: { version?: unknown; project?: unknown }
      try {
        file = JSON.parse(content)
      } catch {
        return { ok: false, reason: "invalid" }
      }
      const version = typeof file.version === "number" ? file.version : 0
      if (batch.formatVersion < version) return { ok: false, reason: "outdated" }
      if (batch.formatVersion > version || !file.project || typeof file.project !== "object") return { ok: false, reason: "conflict" }
      const project = applyChanges(file.project as Record<string, unknown>, batch.changes)
      const revision = (entry.revision ?? 0) + 1
      // The log entry before the index that numbers it, so a watcher never sees a revision it can't
      // read; and taken back if the project doesn't store, or a resend would read it as landed.
      const before = localStorage.getItem(logKey(id))
      appendLog(id, { revision, clientId: batch.clientId, batch: batch.batch, changes: JSON.stringify(batch.changes) })
      try {
        put(
          {
            ...entry,
            name: typeof project.name === "string" ? project.name : entry.name,
            description: typeof project.description === "string" ? project.description : (entry.description ?? ""),
            componentCount: batch.componentCount,
            updatedAt: Date.now(),
            revision,
          },
          JSON.stringify({ ...file, project }),
        )
      } catch (error) {
        try {
          if (before === null) localStorage.removeItem(logKey(id))
          else localStorage.setItem(logKey(id), before)
        } catch {
          // Too full even for the old log: without one, other tabs load the project again.
          localStorage.removeItem(logKey(id))
        }
        throw error
      }
      return { ok: true, revision }
    },
    async replace(id, baseRevision, record) {
      const entry = readIndex().find((e) => e.id === id)
      if (!entry) return { ok: false, reason: "not_found" }
      if ((entry.revision ?? 0) !== baseRevision) return { ok: false, reason: "conflict" }
      const revision = baseRevision + 1
      appendLog(id, { revision, clientId: "", batch: 0, changes: null })
      put({ ...entry, ...summaryEntry(record), updatedAt: Date.now(), revision }, record.content)
      return { ok: true, revision }
    },
    watchChanges(id, after, listener) {
      let cursor = after
      let closed = false
      const deliver = () => {
        if (closed) return
        const entry = readIndex().find((e) => e.id === id)
        if (!entry) return listener({ type: "gone" })
        const revision = entry.revision ?? 0
        if (revision === cursor) return
        const log = readLog(id).filter((e) => e.revision > cursor)
        if (revision < cursor || !log.length || log[0].revision !== cursor + 1) {
          closed = true
          return listener({ type: "reset", role: "owner" })
        }
        cursor = log[log.length - 1].revision
        listener({
          type: "batches",
          role: "owner",
          revision: cursor,
          batches: log.map((e) => ({ revision: e.revision, clientId: e.clientId, batch: e.batch, userId: "", changes: e.changes === null ? null : (JSON.parse(e.changes) as Change[]) })),
        })
      }
      const onStorage = (e: StorageEvent) => (e.key === INDEX_KEY || e.key === logKey(id)) && deliver()
      window.addEventListener(CHANGED, deliver)
      window.addEventListener("storage", onStorage)
      queueMicrotask(deliver)
      return () => {
        closed = true
        window.removeEventListener(CHANGED, deliver)
        window.removeEventListener("storage", onStorage)
      }
    },
    async remove(id) {
      try {
        localStorage.removeItem(projectKey(id))
        localStorage.removeItem(logKey(id))
        writeIndex(readIndex().filter((e) => e.id !== id))
      } catch {
        // storage unavailable; nothing to remove
      }
    },
  }
}

const summaryEntry = ({ name, description, componentCount }: ProjectRecord) => ({ name, description, componentCount })

const MOVED_KEY = "cherryblossom:editor:moved"

function readMoved(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(MOVED_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * The id a project moved into the account has now, for a link that still names it by the id it
 * had in this browser (a bookmark of `/app/v2#/p/<id>`, say).
 */
export function movedProjectId(id: string): string | undefined {
  if (typeof localStorage === "undefined") return undefined
  const to = readMoved()[id]
  return typeof to === "string" ? to : undefined
}

/** Before the envelope, a project carried its own creation date, and the index didn't. */
function legacyCreatedAt(content: string): number | undefined {
  try {
    const raw = JSON.parse(content) as { createdAt?: unknown }
    return typeof raw.createdAt === "number" ? raw.createdAt : undefined
  } catch {
    return undefined
  }
}

/**
 * Move projects left in this browser's storage into `target`, the user's account.
 *
 * Projects lived in `localStorage` until they were saved to accounts (October 2026), so whoever
 * used the editor before then has their work here and nowhere else. Each one is uploaded in the
 * current format and only then deleted from the browser: one that fails to upload stays, and the
 * next visit tries again. One that can't be read at all stays too, rather than being destroyed by
 * a migration that didn't understand it.
 *
 * Held under a Web Lock, so two tabs opened together don't upload everything twice.
 */
export async function moveBrowserProjects(target: ProjectStorage): Promise<number> {
  if (typeof localStorage === "undefined" || !readIndex().length) return 0
  const move = async () => {
    let moved = 0
    // Read again under the lock: another tab may have moved them while this one waited.
    for (const entry of readIndex()) {
      const content = localStorage.getItem(projectKey(entry.id))
      if (content === null) continue
      let project: Project
      try {
        project = parseProjectFile(content, { id: entry.id })
      } catch {
        continue
      }
      let created: { id: string }
      try {
        created = await target.create(projectRecord(project), { createdAt: entry.createdAt ?? legacyCreatedAt(content), updatedAt: entry.updatedAt })
      } catch {
        // Signed out, or refused (too large to store): this one stays for the next visit, and
        // one the account won't take must not hold back the ones after it.
        continue
      }
      try {
        localStorage.setItem(MOVED_KEY, JSON.stringify({ ...readMoved(), [entry.id]: created.id }))
      } catch {
        // storage full: the project moved all the same, and only an old link to it is lost
      }
      localStorage.removeItem(projectKey(entry.id))
      writeIndex(readIndex().filter((e) => e.id !== entry.id))
      moved++
    }
    return moved
  }
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  return locks ? locks.request("cherryblossom:editor:move-browser-projects", move) : move()
}
