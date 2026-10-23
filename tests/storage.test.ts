import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { addComponent, createProject } from "../src/model/ops"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import { projectChanges } from "../src/store/changes"
import {
  browserProjectStorage,
  movedProjectId,
  moveBrowserProjects,
  openStoredProject,
  projectRecord,
  type ChangesEvent,
  type ProjectRecord,
  type StoredProjectSummary,
} from "../src/store/storage"
import { memoryStorage } from "./memoryStorage"

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

  it("applies a batch of changes to the stored file, once, and logs it for other tabs", async () => {
    const storage = browserProjectStorage()
    const { id } = await storage.create(record("One"))
    const before = openStoredProject((await storage.load(id))!)
    const changes = projectChanges(before, { ...before, name: "Two" })
    const batch = { clientId: "s1", batch: 1, changes, formatVersion: PROJECT_FILE_VERSION, componentCount: 1 }
    expect(await storage.push(id, batch)).toEqual({ ok: true, revision: 2 })
    // A resend of the same batch is answered, not applied again.
    expect(await storage.push(id, batch)).toEqual({ ok: true, revision: 2 })
    expect(openStoredProject((await storage.load(id))!).name).toBe("Two")
    const events: ChangesEvent[] = []
    const stop = storage.watchChanges(id, 1, (e) => events.push(e), () => {})
    await Promise.resolve()
    expect(events).toEqual([{ type: "batches", role: "owner", revision: 2, batches: [{ revision: 2, clientId: "s1", batch: 1, userId: "", changes }] }])
    stop()
    expect(await storage.push("missing", batch)).toEqual({ ok: false, reason: "not_found" })
    expect(await storage.push(id, { ...batch, batch: 2, formatVersion: PROJECT_FILE_VERSION - 1 })).toEqual({ ok: false, reason: "outdated" })
  })

  it("replaces a project whole on top of the revision it was read at, and refuses a stale one", async () => {
    const storage = browserProjectStorage()
    const { id } = await storage.create(record("One"))
    expect(await storage.replace(id, 1, record("Two"))).toEqual({ ok: true, revision: 2 })
    expect(await storage.replace(id, 1, record("Three"))).toEqual({ ok: false, reason: "conflict" })
    expect(openStoredProject((await storage.load(id))!).name).toBe("Two")
    expect(await storage.replace("missing", 0, record("x"))).toEqual({ ok: false, reason: "not_found" })
    // A tab following from before the replacement loads the project again.
    const events: ChangesEvent[] = []
    storage.watchChanges(id, 1, (e) => events.push(e), () => {})
    await Promise.resolve()
    expect(events).toEqual([{ type: "batches", role: "owner", revision: 2, batches: [{ revision: 2, clientId: "", batch: 0, userId: "", changes: null }] }])
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
    expect(stored.formatVersion).toBe(0)
    expect(openStoredProject(stored).name).toBe("Legacy")
    expect(await storage.replace("p_legacy", 0, record("Renamed"))).toEqual({ ok: true, revision: 1 })
  })
})

/** An account's storage, in memory, with a failure to switch on. */
function accountStorage() {
  const memory = memoryStorage()
  return { storage: memory.storage, rows: memory.rows, calls: memory.calls, setFailure: memory.setFailure }
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
