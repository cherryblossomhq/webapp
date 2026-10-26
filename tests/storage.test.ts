import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { addComponent, createProject } from "../src/model/ops"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { connectProjectStorage, settleSaves, useProjectStore } from "../src/store/projectStore"
import {
  browserProjectStorage,
  movedProjectId,
  moveBrowserProjects,
  openStoredProject,
  projectRecord,
  type ProjectRecord,
  type ProjectStorage,
  type SaveOutcome,
  type StoredProjectSummary,
} from "../src/store/storage"

/** The browser globals the stores reach for, in a node test: a Map-backed Storage and a window to dispatch on. */
function installBrowser() {
  const items = new Map<string, string>()
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k),
    clear: () => items.clear(),
    key: (i: number) => [...items.keys()][i] ?? null,
    get length() {
      return items.size
    },
  }
  vi.stubGlobal("localStorage", storage)
  vi.stubGlobal("window", new EventTarget())
  return items
}

const record = (name: string): ProjectRecord => projectRecord(addComponent(createProject(name), "resistor").project)

describe("this browser's project storage", () => {
  let items: Map<string, string>
  beforeEach(() => {
    items = installBrowser()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("creates, lists, loads and opens a project", async () => {
    const storage = browserProjectStorage()
    const { id, revision } = await storage.create(record("One"))
    expect(revision).toBe(1)
    let listed: StoredProjectSummary[] | null = null
    storage.watchList((l) => (listed = l), () => {})
    expect(listed!.map((p) => [p.id, p.name, p.componentCount])).toEqual([[id, "One", 1]])
    const stored = (await storage.load(id))!
    expect(stored.revision).toBe(1)
    const project = openStoredProject(stored)
    expect(project.id).toBe(id)
    expect(project.name).toBe("One")
  })

  it("saves on top of the revision it was loaded at, and refuses a stale one", async () => {
    const storage = browserProjectStorage()
    const { id } = await storage.create(record("One"))
    expect(await storage.save(id, 1, record("Two"))).toEqual({ ok: true, revision: 2 })
    expect(await storage.save(id, 1, record("Three"))).toEqual({ ok: false, reason: "conflict" })
    expect(openStoredProject((await storage.load(id))!).name).toBe("Two")
    expect(await storage.save("missing", 0, record("x"))).toEqual({ ok: false, reason: "not_found" })
  })

  it("tells a watcher about every change, and forgets a removed project", async () => {
    const storage = browserProjectStorage()
    const seen: string[][] = []
    storage.watchList((l) => seen.push((l ?? []).map((p) => p.name)), () => {})
    const { id } = await storage.create(record("One"))
    await storage.create(record("Two"))
    await storage.remove(id)
    expect(seen.at(-1)).toEqual(["Two"])
    expect(await storage.load(id)).toBeNull()
    expect([...items.keys()].some((k) => k.endsWith(id))).toBe(false)
  })

  it("still opens a project written before the envelope and revisions", async () => {
    const bare = { ...createProject("Legacy"), id: "p_legacy", createdAt: 10, updatedAt: 20 }
    items.set("cherryblossom:editor:project:p_legacy", JSON.stringify(bare))
    items.set("cherryblossom:editor:index", JSON.stringify([{ id: "p_legacy", name: "Legacy", description: "", updatedAt: 20, componentCount: 0 }]))
    const storage = browserProjectStorage()
    const stored = (await storage.load("p_legacy"))!
    expect(stored.revision).toBe(0)
    expect(openStoredProject(stored).name).toBe("Legacy")
    expect(await storage.save("p_legacy", 0, record("Renamed"))).toEqual({ ok: true, revision: 1 })
  })
})

/** An account's storage, in memory, recording what it was asked. */
function accountStorage() {
  const rows = new Map<string, { content: string; revision: number; createdAt: number; updatedAt: number; name: string }>()
  let next = 0
  const calls: { op: string; id?: string; baseRevision?: number; name?: string }[] = []
  let fail: Error | null = null
  const storage: ProjectStorage = {
    location: "account",
    watchList: () => () => {},
    async load(id) {
      const row = rows.get(id)
      return row ? { id, ...row } : null
    },
    async create(r, dates) {
      calls.push({ op: "create", name: r.name })
      if (fail) throw fail
      const id = `d${next++}`
      rows.set(id, { content: r.content, revision: 1, createdAt: dates?.createdAt ?? 0, updatedAt: dates?.updatedAt ?? 0, name: r.name })
      return { id, revision: 1 }
    },
    async save(id, baseRevision, r): Promise<SaveOutcome> {
      calls.push({ op: "save", id, baseRevision, name: r.name })
      if (fail) throw fail
      const row = rows.get(id)
      if (!row) return { ok: false, reason: "not_found" }
      if (row.revision !== baseRevision) return { ok: false, reason: "conflict" }
      row.revision++
      row.content = r.content
      row.name = r.name
      return { ok: true, revision: row.revision }
    },
    async remove(id) {
      rows.delete(id)
    },
  }
  return { storage, rows, calls, setFailure: (e: Error | null) => (fail = e) }
}

describe("moving this browser's projects into the account", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("uploads each one in the current format, keeps its dates, and only then deletes it here", async () => {
    const items = installBrowser()
    const bare = { ...addComponent(createProject("Mine"), "resistor").project, id: "p_a", createdAt: 111, updatedAt: 222 }
    items.set("cherryblossom:editor:project:p_a", JSON.stringify(bare))
    items.set("cherryblossom:editor:index", JSON.stringify([{ id: "p_a", name: "Mine", description: "", updatedAt: 222, componentCount: 1 }]))
    const account = accountStorage()
    expect(await moveBrowserProjects(account.storage)).toBe(1)
    const [row] = [...account.rows.values()]
    expect(row.name).toBe("Mine")
    expect(row.createdAt).toBe(111)
    expect(row.updatedAt).toBe(222)
    expect(JSON.parse(row.content).version).toBe(PROJECT_FILE_VERSION)
    expect(items.has("cherryblossom:editor:project:p_a")).toBe(false)
    expect(JSON.parse(items.get("cherryblossom:editor:index")!)).toEqual([])
    // A link that still names it by its browser id can find it.
    expect(movedProjectId("p_a")).toBe([...account.rows.keys()][0])
    expect(movedProjectId("p_other")).toBeUndefined()
  })

  it("leaves everything in place when the upload fails, for the next visit", async () => {
    const items = installBrowser()
    const local = browserProjectStorage()
    await local.create(record("One"))
    await local.create(record("Two"))
    const account = accountStorage()
    account.setFailure(new Error("offline"))
    expect(await moveBrowserProjects(account.storage)).toBe(0)
    expect(account.rows.size).toBe(0)
    expect(JSON.parse(items.get("cherryblossom:editor:index")!)).toHaveLength(2)
  })

  it("moves the rest when the account refuses one", async () => {
    const items = installBrowser()
    const local = browserProjectStorage()
    // Newest first in the index, so the refused one is met first.
    await local.create(record("Small"))
    await local.create(record("Huge"))
    const account = accountStorage()
    const create = account.storage.create
    account.storage.create = async (r, dates) => {
      if (r.name === "Huge") throw new Error("Couldn't save the project: it is too large to store in your account.")
      return create(r, dates)
    }
    expect(await moveBrowserProjects(account.storage)).toBe(1)
    expect([...account.rows.values()].map((r) => r.name)).toEqual(["Small"])
    expect(JSON.parse(items.get("cherryblossom:editor:index")!).map((e: { name: string }) => e.name)).toEqual(["Huge"])
  })

  it("keeps a project it can't read rather than destroying it", async () => {
    const items = installBrowser()
    items.set("cherryblossom:editor:project:p_bad", "{not json")
    items.set("cherryblossom:editor:index", JSON.stringify([{ id: "p_bad", name: "Bad", description: "", updatedAt: 1, componentCount: 0 }]))
    const account = accountStorage()
    expect(await moveBrowserProjects(account.storage)).toBe(0)
    expect(items.has("cherryblossom:editor:project:p_bad")).toBe(true)
  })
})

describe("autosave", () => {
  const api = () => useProjectStore.getState()
  const rename = (name: string) => api().commit((p: Project) => ({ ...p, name }))

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    api().close()
    connectProjectStorage(null)
    vi.useRealTimers()
  })

  async function opened() {
    const account = accountStorage()
    connectProjectStorage(account.storage)
    const { id } = await account.storage.create(record("Start"))
    api().open(openStoredProject((await account.storage.load(id))!), 1)
    account.calls.length = 0
    return { account, id }
  }

  it("saves once edits pause, as one save, on top of the revision it opened", async () => {
    const { account, id } = await opened()
    rename("A")
    rename("B")
    expect(api().save.state).toBe("saving")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(account.calls).toEqual([{ op: "save", id, baseRevision: 1, name: "B" }])
    expect(api().save.state).toBe("saved")
    rename("C")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(account.calls.at(-1)).toMatchObject({ baseRevision: 2, name: "C" })
  })

  it("stops on a conflict, and saves over it only when the user keeps their copy", async () => {
    const { account, id } = await opened()
    account.rows.get(id)!.revision = 5
    rename("Mine")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(api().save).toEqual({ state: "refused", reason: "conflict" })
    rename("Mine again")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(account.calls.filter((c) => c.op === "save")).toHaveLength(1)
    await api().keepMine()
    expect(account.calls.at(-1)).toMatchObject({ baseRevision: 5, name: "Mine again" })
    expect(api().save.state).toBe("saved")
  })

  it("keeps trying a save that didn't arrive, and sends the newest edit when it does", async () => {
    const { account } = await opened()
    account.setFailure(new Error("offline"))
    rename("A")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(api().save.state).toBe("retrying")
    rename("B")
    account.setFailure(null)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(account.calls.at(-1)).toMatchObject({ op: "save", name: "B" })
    expect(api().save.state).toBe("saved")
  })

  it("lands the last edit's save after the project is closed", async () => {
    const { account } = await opened()
    rename("Last")
    api().close()
    await vi.advanceTimersByTimeAsync(0)
    expect(account.calls.at(-1)).toMatchObject({ op: "save", name: "Last" })
  })

  it("sends an edit at once when the editor is left, without waiting for edits to pause", async () => {
    const { account } = await opened()
    rename("Leaving")
    let settled = false
    void settleSaves().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(account.calls).toEqual([expect.objectContaining({ op: "save", name: "Leaving" })])
    expect(settled).toBe(true)
    expect(api().save.state).toBe("saved")
  })

  it("leaves anyway when a save never lands", async () => {
    const { account } = await opened()
    account.storage.save = () => new Promise(() => {})
    rename("Offline")
    let settled = false
    void settleSaves().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(true)
  })
})
