import { applyChanges, type Change } from "@cherryblossom/project-changes"
import type { HistoryState, HistorySource, VersionInfo, VersionSummary } from "../src/store/history"
import type { ChangesEvent, KeptBatch, OutgoingBatch, ProjectRole, ProjectStorage, PushOutcome, SaveOutcome, UnsentEdits } from "../src/store/storage"

/**
 * An account's storage in memory, behaving as the hosted app's storage does: it applies each batch
 * to the stored file, numbers it, logs it and tells every watcher, answers a resent batch with the
 * revision it landed at, and refuses what a viewer, an older editor or a newer format sends. Tests
 * can make a push fail, hold pushes (or their answers) until released, change the user's role and
 * drop the log.
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
  /** Apply the next push, then wait for this before answering it. */
  let answerGate: Promise<void> | null = null
  /** Don't tell watchers about pushes, as a subscription that dropped with the connection wouldn't hear. */
  let quiet = false
  /** Refuse the next push with this reason. */
  let refuseNext: "too_large" | "invalid" | null = null
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

  // ---------- Version history, as `versions.ts` keeps it: a copy of the document per version ----------
  const zero = () => ({ added: 0, removed: 0, changed: 0 })
  const noChanges = (): VersionSummary => ({ parts: zero(), wires: zero(), traces: zero(), vias: zero(), zones: zero(), labels: zero(), other: zero() })
  interface StoredVersion extends VersionInfo {
    content: string
    designId: string
  }
  const versions: StoredVersion[] = []
  const historyWatchers = new Set<{ id: string; limit: number; listener: (s: HistoryState | null) => void }>()
  let versionCount = 0
  let clock = 1_000_000
  const stateOf = (id: string, limit: number): HistoryState | null => {
    const row = rows.get(id)
    if (!row) return null
    const mine = versions.filter((v) => v.designId === id).sort((a, b) => b.at - a.at)
    return {
      role: row.role,
      revision: row.revision,
      updatedAt: row.updatedAt,
      current: { edits: 0, editors: [] },
      versions: mine.slice(0, limit).map(({ content: _c, designId: _d, ...info }) => info),
      more: mine.length > limit,
    }
  }
  const tell = (id: string) => {
    for (const w of historyWatchers) if (w.id === id) w.listener(stateOf(id, w.limit))
  }
  /** A version of a project as it is now, as the server keeps one before an edit after a pause. */
  const snapshot = (id: string, extra: Partial<Pick<VersionInfo, "kind" | "name" | "summary" | "by" | "editors" | "restoredFromAt">> = {}) => {
    const row = rows.get(id)!
    const version: StoredVersion = {
      id: `v${versionCount++}`,
      designId: id,
      at: (clock += 60_000),
      revision: row.revision,
      kind: "auto",
      name: null,
      restoredFromAt: null,
      by: null,
      editors: [],
      formatVersion: row.formatVersion,
      size: row.content.length,
      summary: noChanges(),
      content: row.content,
      ...extra,
    }
    versions.push(version)
    tell(id)
    return version
  }
  const history: HistorySource = {
    watch(id, limit, listener) {
      const w = { id, limit, listener }
      historyWatchers.add(w)
      queueMicrotask(() => historyWatchers.has(w) && listener(stateOf(id, limit)))
      return () => historyWatchers.delete(w)
    },
    async open(id, versionId) {
      calls.push({ op: "history.open", id })
      const v = versions.find((x) => x.id === versionId && x.designId === id)
      return v ? { content: v.content, formatVersion: v.formatVersion, revision: v.revision, at: v.at } : null
    },
    async name(id, name, versionId) {
      const row = rows.get(id)
      if (!row) return { ok: false, reason: "not_found" }
      if (row.role === "viewer") return { ok: false, reason: "forbidden" }
      if (!name.trim()) return { ok: false, reason: "invalid" }
      const v = versionId ? versions.find((x) => x.id === versionId && x.designId === id) : snapshot(id)
      if (!v) return { ok: false, reason: "not_found" }
      v.kind = "named"
      v.name = name.trim()
      tell(id)
      return { ok: true, versionId: v.id }
    },
    async unname(id, versionId) {
      const row = rows.get(id)
      if (!row) return { ok: false, reason: "not_found" }
      if (row.role === "viewer") return { ok: false, reason: "forbidden" }
      const v = versions.find((x) => x.id === versionId && x.designId === id)
      if (!v) return { ok: false, reason: "not_found" }
      v.kind = "auto"
      v.name = null
      tell(id)
      return { ok: true }
    },
    async restore(id, versionId, formatVersion) {
      calls.push({ op: "history.restore", id })
      const row = rows.get(id)
      const v = versions.find((x) => x.id === versionId && x.designId === id)
      if (!row || !v) return { ok: false, reason: "not_found" }
      if (row.role === "viewer") return { ok: false, reason: "forbidden" }
      if (formatVersion < v.formatVersion) return { ok: false, reason: "outdated" }
      // What is replaced is kept first, so the restore can be undone.
      snapshot(id, { kind: "restore", restoredFromAt: v.at })
      row.revision++
      row.content = v.content
      row.name = JSON.parse(v.content).project.name
      row.formatVersion = v.formatVersion
      row.log.push({ revision: row.revision, clientId: "restore", batch: 0, userId: "", changes: null })
      notify(id)
      return { ok: true, revision: row.revision }
    },
  }

  const storage: ProjectStorage = {
    location: "account",
    history,
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
      if (refuseNext) {
        const reason = refuseNext
        refuseNext = null
        return { ok: false, reason }
      }
      const file = JSON.parse(row.content)
      // Through JSON, as the wire carries it.
      file.project = applyChanges(file.project, JSON.parse(JSON.stringify(batch.changes)))
      row.content = JSON.stringify(file)
      row.name = file.project.name
      row.revision++
      row.log.push({ revision: row.revision, clientId: batch.clientId, batch: batch.batch, userId: batch.clientId, changes: JSON.parse(JSON.stringify(batch.changes)) })
      if (!quiet) notify(id)
      if (answerGate) {
        const held = answerGate
        answerGate = null
        await held
      }
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
    versions,
    snapshot,
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
    /** Apply the next push at once and hold back its answer until released. */
    holdAnswer() {
      let release!: () => void
      answerGate = new Promise((resolve) => (release = resolve))
      return release
    },
    refuseNext: (reason: "too_large" | "invalid") => (refuseNext = reason),
    /** Stop (or start again) telling watchers; starting again tells them what they missed. */
    setQuiet(id: string, on: boolean) {
      quiet = on
      if (!on) notify(id)
    },
    setRole(id: string, role: ProjectRole) {
      rows.get(id)!.role = role
      notify(id)
      tell(id)
    },
    /** Forget the log, as a long absence does: watchers further back load the project again. */
    dropLog(id: string) {
      rows.get(id)!.log = []
    },
    project: (id: string) => JSON.parse(rows.get(id)!.content).project,
  }
}

/**
 * This browser's kept edits (`UnsentEdits`) in memory, copied in and out as IndexedDB does. A page is open while its claim is
 * held; `closeAll` lets go of every claim, as a reload or closing the tabs does.
 */
export function memoryUnsent() {
  const rows = new Map<string, KeptBatch & { projectId: string }>()
  const open = new Set<string>()
  const key = (projectId: string, clientId: string, batch: number) => `${projectId}/${clientId}/${batch}`
  const unsent: UnsentEdits = {
    claim: (clientId) => void open.add(clientId),
    // In the order they were first kept, which is each page's in order.
    orphans: async (projectId) =>
      [...rows.values()].filter((r) => r.projectId === projectId && !open.has(r.clientId)).map(({ projectId: _, ...kept }) => structuredClone(kept)),
    keep: (projectId, batch) => void rows.set(key(projectId, batch.clientId, batch.batch), structuredClone({ ...batch, projectId })),
    drop: (projectId, clientId, batch) => void rows.delete(key(projectId, clientId, batch)),
  }
  return { unsent, rows, closeAll: () => open.clear() }
}
