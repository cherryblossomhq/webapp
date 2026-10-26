import { uid } from "../lib/id"
import { parseProjectFile, PROJECT_FILE_VERSION, serializeProject, summarizeProject, type ProjectSummary } from "../model/projectFile"
import type { Project } from "../model/types"

/**
 * Where projects are kept. The editor holds no backend of its own: the host hands it one, the
 * way it hands it a managed-AI session. The website's is the signed-in account;
 * `browserProjectStorage` below is this browser's `localStorage`, for the development harness and
 * the tests.
 *
 * Every implementation stores the same thing, a project file (`model/projectFile.ts`) as text
 * with its summary beside it, so the editor can list projects without opening them. Storage
 * moves text and never parses it; the editor is the only reader and writer of the format.
 *
 * A save names the revision it was made from, and a stale one is refused rather than written
 * over a newer copy: two tabs, or two computers, on one project would otherwise each keep
 * replacing the other's work, silently, on every autosave.
 */
export interface ProjectStorage {
  /** Where the user's projects live, for the copy that says so. */
  location: "account" | "browser"
  /** The user's projects, newest first, now and whenever they change; `null` while loading. */
  watchList(listener: (projects: StoredProjectSummary[] | null) => void, onError: (error: Error) => void): () => void
  /** One project's file, or null when there is no such project for this user. */
  load(id: string): Promise<StoredProject | null>
  create(record: ProjectRecord, dates?: { createdAt?: number; updatedAt?: number }): Promise<{ id: string; revision: number }>
  save(id: string, baseRevision: number, record: ProjectRecord): Promise<SaveOutcome>
  remove(id: string): Promise<void>
}

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
}

export interface StoredProject {
  id: string
  content: string
  revision: number
  createdAt: number
  updatedAt: number
}

/**
 * Why a save was turned away. These are answers, not faults, and each asks something different
 * of the user; a fault (offline, signed out) is a rejected promise instead.
 *
 * - `conflict`: saved somewhere else since this copy was loaded.
 * - `not_found`: deleted somewhere else.
 * - `too_large`: over what one project may store.
 * - `outdated`: stored in a newer format than this editor writes.
 */
export type SaveRefusal = "conflict" | "not_found" | "too_large" | "outdated"

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
      return { id, content, revision: entry.revision ?? 0, createdAt, updatedAt }
    },
    async create(record, dates) {
      const now = Date.now()
      const entry: IndexEntry = { ...summaryEntry(record), id: uid("p"), createdAt: dates?.createdAt ?? now, updatedAt: dates?.updatedAt ?? now, revision: 1 }
      put(entry, record.content)
      return { id: entry.id, revision: 1 }
    },
    async save(id, baseRevision, record) {
      const entry = readIndex().find((e) => e.id === id)
      if (!entry) return { ok: false, reason: "not_found" }
      if ((entry.revision ?? 0) !== baseRevision) return { ok: false, reason: "conflict" }
      const revision = baseRevision + 1
      put({ ...entry, ...summaryEntry(record), updatedAt: Date.now(), revision }, record.content)
      return { ok: true, revision }
    },
    async remove(id) {
      try {
        localStorage.removeItem(projectKey(id))
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
