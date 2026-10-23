import { applyChanges, type Change } from "@cherryblossom/project-changes"
import type { ChangesEvent, OutgoingBatch, ProjectRole, ProjectStorage, PushOutcome, SaveOutcome } from "../src/store/storage"

/**
 * An account's storage in memory, behaving as the hosted app's storage does: it applies each batch
 * to the stored file, numbers it, logs it and tells every watcher, answers a resent batch with the
 * revision it landed at, and refuses what a viewer, an older editor or a newer format sends. Tests
 * can make a push fail, hold pushes until released, change the user's role and drop the log.
 */
export interface MemoryRow {
  content: string
  revision: number
  formatVersion: number
  role: ProjectRole
  name: string
  createdAt: number
  updatedAt: number
  log: { revision: number; clientId: string; batch: number; userId: string; changes: Change[] | null }[]
}

export function memoryStorage() {
  const rows = new Map<string, MemoryRow>()
  let next = 0
  const calls: { op: string; id?: string; clientId?: string; batch?: number; baseRevision?: number; name?: string }[] = []
  let fail: Error | null = null
  /** Pushes wait for this before they are applied. */
  let gate: Promise<void> | null = null
  /** Apply the next push, then throw as if its answer was lost. */
  let loseNextAnswer = false
  /** Don't tell watchers about pushes, as a subscription that dropped with the connection wouldn't hear. */
  let quiet = false
  const watchers = new Set<{ id: string; cursor: number; role: ProjectRole | null; listener: (e: ChangesEvent) => void }>()

  const deliver = (w: { id: string; cursor: number; role: ProjectRole | null; listener: (e: ChangesEvent) => void }) => {
    const row = rows.get(w.id)
    if (!row) return w.listener({ type: "gone" })
    const fresh = row.log.filter((e) => e.revision > w.cursor)
    if (row.revision > w.cursor && (!fresh.length || fresh[0].revision !== w.cursor + 1)) {
      watchers.delete(w)
      return w.listener({ type: "reset", role: row.role })
    }
    if (!fresh.length && w.role === row.role) return
    w.role = row.role
    if (fresh.length) w.cursor = fresh[fresh.length - 1].revision
    w.listener({ type: "batches", role: row.role, revision: row.revision, batches: fresh.map((e) => ({ ...e })) })
  }
  const notify = (id: string) => {
    for (const w of [...watchers]) if (w.id === id) deliver(w)
  }

  const storage: ProjectStorage = {
    location: "account",
    watchList: () => () => {},
    async load(id) {
      calls.push({ op: "load", id })
      if (fail) throw fail
      const row = rows.get(id)
      return row ? { id, content: row.content, revision: row.revision, formatVersion: row.formatVersion, role: row.role, createdAt: row.createdAt, updatedAt: row.updatedAt } : null
    },
    async create(r, dates) {
      calls.push({ op: "create", name: r.name })
      if (fail) throw fail
      const id = `d${next++}`
      rows.set(id, { content: r.content, revision: 1, formatVersion: r.formatVersion, role: "owner", name: r.name, createdAt: dates?.createdAt ?? 0, updatedAt: dates?.updatedAt ?? 0, log: [] })
      return { id, revision: 1 }
    },
    async push(id, batch: OutgoingBatch): Promise<PushOutcome> {
      calls.push({ op: "push", id, clientId: batch.clientId, batch: batch.batch })
      if (gate) await gate
      if (fail) throw fail
      const row = rows.get(id)
      if (!row) return { ok: false, reason: "not_found" }
      const landed = row.log.find((e) => e.clientId === batch.clientId && e.batch === batch.batch)
      if (landed) return { ok: true, revision: landed.revision }
      if (row.role === "viewer") return { ok: false, reason: "forbidden" }
      if (batch.formatVersion < row.formatVersion) return { ok: false, reason: "outdated" }
      if (batch.formatVersion > row.formatVersion) return { ok: false, reason: "conflict" }
      const file = JSON.parse(row.content)
      // Through JSON, as the wire carries it.
      file.project = applyChanges(file.project, JSON.parse(JSON.stringify(batch.changes)))
      row.content = JSON.stringify(file)
      row.name = file.project.name
      row.revision++
      row.log.push({ revision: row.revision, clientId: batch.clientId, batch: batch.batch, userId: batch.clientId, changes: JSON.parse(JSON.stringify(batch.changes)) })
      if (!quiet) notify(id)
      if (loseNextAnswer) {
        loseNextAnswer = false
        throw new Error("The connection dropped before the answer came")
      }
      return { ok: true, revision: row.revision }
    },
    async replace(id, baseRevision, r): Promise<SaveOutcome> {
      calls.push({ op: "replace", id, baseRevision, name: r.name })
      if (fail) throw fail
      const row = rows.get(id)
      if (!row) return { ok: false, reason: "not_found" }
      if (row.role === "viewer") return { ok: false, reason: "forbidden" }
      if (r.formatVersion < row.formatVersion) return { ok: false, reason: "outdated" }
      if (row.revision !== baseRevision) return { ok: false, reason: "conflict" }
      row.revision++
      row.content = r.content
      row.name = r.name
      row.formatVersion = r.formatVersion
      row.log.push({ revision: row.revision, clientId: "", batch: 0, userId: "", changes: null })
      notify(id)
      return { ok: true, revision: row.revision }
    },
    watchChanges(id, after, listener) {
      const w = { id, cursor: after, role: rows.get(id)?.role ?? null, listener }
      watchers.add(w)
      queueMicrotask(() => watchers.has(w) && deliver(w))
      return () => watchers.delete(w)
    },
    async remove(id) {
      rows.delete(id)
      notify(id)
    },
  }

  /** Someone else's tab sending a batch, straight to storage. */
  const pushAs = (clientId: string, id: string, changes: Change[], formatVersion = rows.get(id)!.formatVersion) =>
    storage.push(id, { clientId, batch: Math.floor(Math.random() * 1e9), changes, formatVersion, componentCount: 0 })

  return {
    storage,
    rows,
    calls,
    pushAs,
    setFailure: (e: Error | null) => (fail = e),
    hold() {
      let release!: () => void
      gate = new Promise((resolve) => (release = resolve))
      return () => {
        gate = null
        release()
      }
    },
    loseNextAnswer: () => (loseNextAnswer = true),
    /** Stop (or start again) telling watchers; starting again tells them what they missed. */
    setQuiet(id: string, on: boolean) {
      quiet = on
      if (!on) notify(id)
    },
    setRole(id: string, role: ProjectRole) {
      rows.get(id)!.role = role
      notify(id)
    },
    /** Forget the log, as a long absence does: watchers further back load the project again. */
    dropLog(id: string) {
      rows.get(id)!.log = []
    },
    project: (id: string) => JSON.parse(rows.get(id)!.content).project,
  }
}
