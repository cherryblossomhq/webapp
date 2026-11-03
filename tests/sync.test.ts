import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveDesignatorClashes } from "../src/model/designators"
import { addDrawings, updateDrawings } from "../src/model/drawings"
import { addComponent, addLabel, createProject } from "../src/model/ops"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import type { Project, SchematicDrawing } from "../src/model/types"
import { projectChanges } from "../src/store/changes"
import { connectProjectStorage, isCreatedHere, onRemoteChanges, settleSaves, useProjectStore } from "../src/store/projectStore"
import { openStoredProject, projectRecord, type ProjectStorage, type PushOutcome, type RemoteBatch } from "../src/store/storage"
import { ProjectSync, type SaveStatus, type SyncHost } from "../src/store/sync"
import { memoryStorage, memoryUnsent } from "./memoryStorage"

/**
 * Live editing: the open project's edits travel as batches of changes, everyone else's arrive the
 * same way, and every copy ends up holding what storage holds. `memoryStorage` behaves as the hosted
 * app's storage does, so these pin the editor's half of the protocol.
 */

const api = () => useProjectStore.getState()
const rename = (name: string) => api().commit((p: Project) => ({ ...p, name }))
const moveFirst = (dx: number) => (p: Project): Project => ({
  ...p,
  components: p.components.map((c, i) => (i === 0 ? { ...c, sch: { ...c.sch, x: c.sch.x + dx } } : c)),
})

/** Let batches go out and come back through the log. */
const settle = () => vi.advanceTimersByTimeAsync(200)

async function opened(project = addComponent(createProject("Start"), "resistor").project) {
  const memory = memoryStorage()
  connectProjectStorage(memory.storage)
  const { id } = await memory.storage.create(projectRecord(project))
  const stored = (await memory.storage.load(id))!
  api().open(openStoredProject(stored), stored)
  await settle()
  memory.calls.length = 0
  return { memory, id }
}

describe("live editing", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    api().close()
    connectProjectStorage(null)
    vi.useRealTimers()
  })

  it("sends a burst of edits as one batch, and storage follows", async () => {
    const { memory, id } = await opened()
    rename("A")
    rename("B")
    expect(api().save.state).toBe("saving")
    await settle()
    expect(memory.calls.filter((c) => c.op === "push")).toHaveLength(1)
    expect(memory.project(id).name).toBe("B")
    expect(api().save.state).toBe("saved")
  })

  it("shows someone else's edit as it lands, under a drag in progress", async () => {
    const { memory, id } = await opened()
    const seen: RemoteBatch[][] = []
    const stop = onRemoteChanges((batches) => seen.push(batches))
    api().beginTransient()
    api().setTransient(moveFirst(3))
    const base = api().transientBase!
    await memory.pushAs("other", id, projectChanges(base, addLabel(base, "GND", { x: 9, y: 9 }).project))
    await settle()
    // Their label is there, and the part is still where the drag has it.
    expect(api().project!.labels.map((l) => l.name)).toEqual(["GND"])
    expect(api().project!.components[0].sch.x).toBe(3)
    api().endTransient()
    await settle()
    expect(memory.project(id).components[0].sch.x).toBe(3)
    expect(memory.project(id).labels).toHaveLength(1)
    expect(seen).toHaveLength(1)
    stop()
  })

  it("sends a patch made mid-drag at once, and the drag lands over it when it ends", async () => {
    const { memory, id } = await opened()
    api().beginTransient()
    api().setTransient(moveFirst(3))
    api().patch((p) => ({ ...p, components: p.components.map((c) => ({ ...c, ref: "R7" })) }))
    await settle()
    // The patch is stored before the drag ends, and the drag is not.
    expect(memory.project(id).components[0].ref).toBe("R7")
    expect(memory.project(id).components[0].sch.x).toBe(0)
    expect(api().project!.components[0]).toMatchObject({ ref: "R7", sch: { x: 3 } })
    api().endTransient()
    await settle()
    expect(memory.project(id).components[0]).toMatchObject({ ref: "R7", sch: { x: 3 } })
    // The drag is the one step, and undoing it keeps the patch.
    expect(api().past).toHaveLength(1)
    api().undo()
    expect(api().project!.components[0]).toMatchObject({ ref: "R7", sch: { x: 0 } })
  })

  it("keeps the user's own pending value over theirs, since storage applies it after", async () => {
    const { memory, id } = await opened()
    const release = memory.hold()
    rename("Mine")
    await vi.advanceTimersByTimeAsync(100)
    // Theirs lands first; ours is still on its way.
    const start = openStoredProject((await memory.storage.load(id))!)
    release()
    await memory.pushAs("other", id, projectChanges(start, { ...start, name: "Theirs" }))
    expect(api().project!.name).toBe("Mine")
    await settle()
    expect(memory.project(id).name).toBe("Mine")
    expect(api().project!.name).toBe("Mine")
  })

  it("undoes only the user's own step, leaving everyone else's edits alone", async () => {
    const { memory, id } = await opened()
    api().commit(moveFirst(5))
    await settle()
    const now = openStoredProject((await memory.storage.load(id))!)
    await memory.pushAs("other", id, projectChanges(now, addLabel(now, "VCC", { x: 1, y: 1 }).project))
    await settle()
    api().undo()
    await settle()
    expect(api().project!.components[0].sch.x).toBe(0)
    expect(api().project!.labels.map((l) => l.name)).toEqual(["VCC"])
    expect(memory.project(id).components[0].sch.x).toBe(0)
    expect(memory.project(id).labels).toHaveLength(1)
    api().redo()
    await settle()
    expect(memory.project(id).components[0].sch.x).toBe(5)
  })

  it("keeps two people's edits to different drawings, as items rather than one list", async () => {
    const { project: drawn } = addDrawings(addComponent(createProject("Start"), "resistor").project, [
      { type: "text", x: 0, y: 0, text: "Title", size: 0.3 },
      { type: "rect", x: 1, y: 1, width: 2, height: 1 },
    ])
    const { memory, id } = await opened(drawn)
    const [title, box] = drawn.drawings!
    const release = memory.hold()
    api().commit((p) => updateDrawings(p, [title.id], (d) => ({ ...d, text: "Mine" }) as typeof d))
    await vi.advanceTimersByTimeAsync(100)
    const start = openStoredProject((await memory.storage.load(id))!)
    release()
    await memory.pushAs("other", id, projectChanges(start, updateDrawings(start, [box.id], (d) => ({ ...d, color: "red" }))))
    await settle()
    const stored: SchematicDrawing[] = memory.project(id).drawings
    expect(stored.find((d) => d.id === title.id)).toMatchObject({ text: "Mine" })
    expect(stored.find((d) => d.id === box.id)).toMatchObject({ color: "red" })
    expect(api().project!.drawings).toEqual(stored)
  })

  it("leaves a part someone else deleted deleted when the user undoes their move of it", async () => {
    const { memory, id } = await opened()
    api().commit(moveFirst(5))
    await settle()
    const now = openStoredProject((await memory.storage.load(id))!)
    await memory.pushAs("other", id, projectChanges(now, { ...now, components: [] }))
    await settle()
    expect(api().project!.components).toHaveLength(0)
    api().undo()
    await settle()
    expect(api().project!.components).toHaveLength(0)
    expect(memory.project(id).components).toHaveLength(0)
  })

  it("knows a batch whose answer was lost landed when the log shows it, and doesn't send it again", async () => {
    const { memory, id } = await opened()
    memory.loseNextAnswer()
    rename("Once")
    await vi.advanceTimersByTimeAsync(1_500)
    expect(memory.calls.filter((c) => c.op === "push")).toHaveLength(1)
    expect(api().save.state).toBe("saved")
    expect(memory.project(id).name).toBe("Once")
  })

  it("sends a batch whose answer was lost again under the same number, and storage applies it once", async () => {
    const { memory, id } = await opened()
    memory.setQuiet(id, true)
    memory.loseNextAnswer()
    rename("Once")
    await settle()
    expect(api().save.state).toBe("retrying")
    await vi.advanceTimersByTimeAsync(1_500)
    const pushes = memory.calls.filter((c) => c.op === "push")
    expect(pushes).toHaveLength(2)
    expect(pushes[0].batch).toBe(pushes[1].batch)
    expect(memory.rows.get(id)!.log).toHaveLength(1)
    expect(api().save.state).toBe("saved")
    memory.setQuiet(id, false)
    await settle()
    expect(api().project!.name).toBe("Once")
  })

  it("keeps edits made offline and sends them, in order, once storage answers", async () => {
    const { memory, id } = await opened()
    memory.setFailure(new Error("offline"))
    rename("A")
    await settle()
    expect(api().save.state).toBe("retrying")
    api().commit(moveFirst(2))
    rename("B")
    memory.setFailure(null)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(memory.project(id)).toMatchObject({ name: "B" })
    expect(memory.project(id).components[0].sch.x).toBe(2)
    expect(api().save.state).toBe("saved")
  })

  it("sends the waiting edits a moment after Try again now, and has the connection sign in again first", async () => {
    const { memory, id } = await opened()
    const reconnect = vi.fn()
    memory.storage.reconnect = reconnect
    memory.setFailure(new Error("Sign in to work on projects."))
    rename("A")
    // Four tries have failed, and the next is 15 s away.
    await vi.advanceTimersByTimeAsync(13_000)
    expect(api().save.state).toBe("retrying")
    const tries = memory.calls.filter((c) => c.op === "push").length
    memory.setFailure(null)
    api().retrySave()
    expect(reconnect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(memory.calls.filter((c) => c.op === "push")).toHaveLength(tries + 1)
    expect(memory.project(id).name).toBe("A")
    expect(api().save.state).toBe("saved")
  })

  it("splits a long run of queued edits into batches, so a refusal undoes only the last few", async () => {
    const { memory, id } = await opened()
    memory.setFailure(new Error("offline"))
    for (let i = 1; i <= 20; i++) api().commit((p) => addLabel(p, `N${i}`, { x: i, y: 0 }).project)
    await settle()
    memory.setFailure(null)
    // The batch that lands first is refused; the edits after it are kept.
    memory.refuseNext("too_large")
    await vi.advanceTimersByTimeAsync(5_000)
    const stored = memory.project(id).labels.length
    expect(stored).toBeGreaterThanOrEqual(12)
    expect(stored).toBeLessThan(20)
    expect(api().project!.labels).toHaveLength(stored)
    expect(api().save).toEqual<SaveStatus>({ state: "refused", reason: "too_large" })
    // Steps worked out against edits that never landed can't be undone over other people's work.
    expect(api().past).toEqual([])
    api().dismissSaveNotice()
    expect(api().save).toEqual<SaveStatus>({ state: "saved" })
  })

  it("refuses a viewer's edits before they happen, and says so", async () => {
    const { memory, id } = await opened()
    memory.setRole(id, "viewer")
    await settle()
    expect(api().role).toBe("viewer")
    const before = api().project
    // A press is how a viewer selects: it says nothing until the pointer moves.
    api().beginTransient()
    api().endTransient()
    expect(api().refusedEdits).toBe(0)
    rename("Nope")
    api().beginTransient()
    api().setTransient(moveFirst(1))
    api().setTransient(moveFirst(2))
    expect(api().project).toBe(before)
    expect(api().refusedEdits).toBe(2)
    await settle()
    expect(memory.calls.filter((c) => c.op === "push")).toHaveLength(0)
    memory.setRole(id, "editor")
    await settle()
    expect(api().role).toBe("editor")
  })

  it("undoes an edit storage refused because the user was made a viewer meanwhile", async () => {
    const { memory, id } = await opened()
    memory.rows.get(id)!.role = "viewer"
    rename("Too late")
    await settle()
    expect(api().project!.name).toBe("Start")
    expect(api().role).toBe("viewer")
    expect(api().save).toEqual<SaveStatus>({ state: "refused", reason: "forbidden" })
    expect(api().past).toEqual([])
    // Made an editor again, the strip saying otherwise goes.
    memory.setRole(id, "editor")
    await settle()
    expect(api().save).toEqual<SaveStatus>({ state: "saved" })
  })

  it("puts the screen right when a batch that was still pending in a reloaded copy turns out to have landed", async () => {
    const { memory, id } = await opened()
    memory.setQuiet(id, true)
    const answer = memory.holdAnswer()
    rename("Mine")
    await vi.advanceTimersByTimeAsync(100)
    // Ours is stored, its answer still on its way; then theirs, and then the copy loads again.
    const now = openStoredProject((await memory.storage.load(id))!)
    await memory.pushAs("other", id, projectChanges(now, { ...now, name: "Theirs" }))
    memory.dropLog(id)
    memory.setQuiet(id, false)
    await vi.advanceTimersByTimeAsync(0)
    answer()
    await settle()
    expect(memory.project(id).name).toBe("Theirs")
    expect(api().project!.name).toBe("Theirs")
    expect(api().save.state).toBe("saved")
  })

  it("reads the log again from a fresh copy when following it fails", async () => {
    const memory = memoryStorage()
    const watch = memory.storage.watchChanges
    let failures = 1
    memory.storage.watchChanges = (id, after, listener, onError) => {
      if (failures-- > 0) {
        queueMicrotask(() => onError(new Error("Too much to read")))
        return () => {}
      }
      return watch(id, after, listener, onError)
    }
    connectProjectStorage(memory.storage)
    const { id } = await memory.storage.create(projectRecord(createProject("Start")))
    const stored = (await memory.storage.load(id))!
    api().open(openStoredProject(stored), stored)
    await settle()
    const now = openStoredProject((await memory.storage.load(id))!)
    await memory.pushAs("other", id, projectChanges(now, { ...now, name: "Theirs" }))
    await vi.advanceTimersByTimeAsync(1_500)
    expect(api().project!.name).toBe("Theirs")
    await memory.pushAs("other", id, projectChanges({ ...now, name: "Theirs" }, { ...now, name: "Again" }))
    await settle()
    expect(api().project!.name).toBe("Again")
  })

  it("keeps a designator renumbered after someone else took it through Undo and Redo", async () => {
    const { memory, id } = await opened(createProject("Empty"))
    const stop = onRemoteChanges((batches) => {
      const arrived = new Set(batches.flatMap((b) => (b.changes ?? []).flatMap((c) => (c.kind === "put" && c.collection === "components" ? [String(c.item.id)] : []))))
      api().patch((p) => resolveDesignatorClashes(p, arrived, isCreatedHere).project)
    })
    const release = memory.hold()
    api().commit((p) => addComponent(p, "resistor", { id: "c_200" }).project)
    await vi.advanceTimersByTimeAsync(100)
    const start = openStoredProject((await memory.storage.load(id))!)
    release()
    await memory.pushAs("other", id, projectChanges(start, addComponent(start, "resistor", { id: "c_100" }).project))
    await settle()
    const refOf = (componentId: string) => api().project!.components.find((c) => c.id === componentId)?.ref
    expect([refOf("c_100"), refOf("c_200")]).toEqual(["R1", "R2"])
    api().undo()
    api().redo()
    await settle()
    expect([refOf("c_100"), refOf("c_200")]).toEqual(["R1", "R2"])
    expect(memory.project(id).components.map((c: { ref: string }) => c.ref).sort()).toEqual(["R1", "R2"])
    stop()
  })

  it("loads the project again after a gap, with the user's pending edit on top", async () => {
    const { memory, id } = await opened()
    const release = memory.hold()
    rename("Pending")
    await vi.advanceTimersByTimeAsync(100)
    // Meanwhile the project was replaced whole (a rename from the projects page) and the log trimmed.
    const row = memory.rows.get(id)!
    const replaced = openStoredProject((await memory.storage.load(id))!)
    row.content = projectRecord(addComponent(replaced, "capacitor").project).content
    row.revision += 3
    memory.dropLog(id)
    release()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(api().project!.components).toHaveLength(2)
    expect(api().project!.name).toBe("Pending")
    expect(memory.project(id).name).toBe("Pending")
    expect(memory.project(id).components).toHaveLength(2)
  })

  it("writes a document stored in an older format in this editor's before sending changes to it", async () => {
    const memory = memoryStorage()
    connectProjectStorage(memory.storage)
    const old = createProject("Old")
    const { id } = await memory.storage.create(projectRecord(old))
    memory.calls.length = 0
    const row = memory.rows.get(id)!
    row.formatVersion = PROJECT_FILE_VERSION - 1
    row.content = JSON.stringify({ ...JSON.parse(row.content), version: PROJECT_FILE_VERSION - 1 })
    const stored = (await memory.storage.load(id))!
    api().open(openStoredProject(stored), stored)
    rename("New")
    await settle()
    expect(memory.calls.map((c) => c.op)).toEqual(["load", "replace", "push"])
    expect(row.formatVersion).toBe(PROJECT_FILE_VERSION)
    expect(memory.project(id).name).toBe("New")
  })

  it("marks the project gone when it is deleted while open", async () => {
    const { memory, id } = await opened()
    await memory.storage.remove(id)
    await settle()
    expect(api().gone).toBe(true)
  })

  it("lands the last edit after the project is closed", async () => {
    const { memory, id } = await opened()
    rename("Last")
    api().close()
    await settle()
    expect(memory.project(id).name).toBe("Last")
  })

  it("sends an edit at once when the editor is left, without waiting", async () => {
    const { memory, id } = await opened()
    rename("Leaving")
    let settled = false
    void settleSaves().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(memory.project(id).name).toBe("Leaving")
    expect(settled).toBe(true)
  })

  it("leaves anyway when a batch never lands", async () => {
    const { memory } = await opened()
    memory.storage.push = () => new Promise(() => {})
    rename("Offline")
    let settled = false
    void settleSaves().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(true)
  })
})

describe("edits kept in this browser until they land", () => {
  beforeEach(() => vi.useFakeTimers())
  /** The pages "closed" in a test: their syncs live on in the module, so each is told its project is gone at the end. */
  const closed: (() => void)[] = []
  afterEach(async () => {
    api().close()
    for (const end of closed.splice(0)) end()
    await vi.advanceTimersByTimeAsync(60_000)
    connectProjectStorage(null)
    vi.useRealTimers()
  })

  /**
   * A page whose pushes fail (`push`, until `close`), as they did all afternoon on November 2, 2026 for a user still signed in.
   * Closed, it never sends again, as a page reloaded or shut doesn't.
   */
  async function firstPage(push: ProjectStorage["push"] = () => Promise.reject(new Error("Sign in to work on projects."))) {
    const memory = memoryStorage()
    const kept = memoryUnsent()
    let open = true
    let end: ((outcome: PushOutcome) => void) | null = null
    let ended = false
    closed.push(() => {
      open = false
      ended = true
      end?.({ ok: false, reason: "not_found" })
    })
    connectProjectStorage({
      ...memory.storage,
      unsent: kept.unsent,
      push: (id, batch) =>
        open ? push(id, batch) : ended ? Promise.resolve({ ok: false, reason: "not_found" }) : new Promise((resolve) => (end = resolve)),
    })
    const { id } = await memory.storage.create(projectRecord(addComponent(createProject("Start"), "resistor").project))
    const stored = (await memory.storage.load(id))!
    api().open(openStoredProject(stored), stored)
    await settle()
    const clientId = api().sessionId!
    return {
      memory,
      kept,
      id,
      clientId,
      /** Reload: this page goes, and the next opens the project with storage that works. */
      async reopen() {
        open = false
        kept.closeAll()
        api().close()
        connectProjectStorage({ ...memory.storage, unsent: kept.unsent })
        memory.calls.length = 0
        const again = (await memory.storage.load(id))!
        api().open(openStoredProject(again), again)
      },
    }
  }

  const pushes = (memory: ReturnType<typeof memoryStorage>) => memory.calls.filter((c) => c.op === "push")

  it("keeps each batch that hasn't landed, as it gathers edits, and lets go of it once it lands", async () => {
    const memory = memoryStorage()
    const kept = memoryUnsent()
    connectProjectStorage({ ...memory.storage, unsent: kept.unsent })
    const { id } = await memory.storage.create(projectRecord(addComponent(createProject("Start"), "resistor").project))
    const stored = (await memory.storage.load(id))!
    api().open(openStoredProject(stored), stored)
    await settle()
    memory.setFailure(new Error("offline"))
    rename("A")
    await settle()
    api().commit(moveFirst(2))
    rename("B")
    await settle()
    // The one sent, and the one gathering the edits after it.
    expect([...kept.rows.values()].map((r) => r.changes.length)).toEqual([1, 2])
    memory.setFailure(null)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api().save.state).toBe("saved")
    expect(kept.rows.size).toBe(0)
  })

  it("sends what a reloaded page couldn't, first and under its own tab and numbers, and shows it", async () => {
    const page = await firstPage()
    rename("A")
    await settle()
    api().commit(moveFirst(2))
    rename("B")
    await settle()
    expect(api().save.state).toBe("retrying")
    expect(page.memory.project(page.id).name).toBe("Start")

    // The new page edits while it is still reading what was kept: its edit is newer, so it waits, lands after them and wins.
    const orphans = page.kept.unsent.orphans
    let read!: () => void
    const reading = new Promise<void>((resolve) => (read = resolve))
    page.kept.unsent.orphans = async (id) => {
      await reading
      return orphans(id)
    }
    await page.reopen()
    api().commit(moveFirst(5))
    await settle()
    expect(pushes(page.memory)).toHaveLength(0)
    read()
    await settle()
    expect(api().project!.name).toBe("B")
    expect(api().project!.components[0].sch.x).toBe(5)
    expect(page.memory.project(page.id)).toMatchObject({ name: "B" })
    expect(page.memory.project(page.id).components[0].sch.x).toBe(5)
    const sent = pushes(page.memory)
    expect(sent.slice(0, 2).map((c) => [c.clientId, c.batch])).toEqual([
      [page.clientId, 1],
      [page.clientId, 2],
    ])
    expect(sent[2].clientId).not.toBe(page.clientId)
    expect(page.kept.rows.size).toBe(0)
    expect(api().save.state).toBe("saved")
  })

  it("applies once a batch that landed after all, though the page never heard", async () => {
    let lose = true
    const page = await firstPage(async (id, batch) => {
      const outcome = await page.memory.storage.push(id, batch)
      if (lose) throw new Error("The connection dropped before the answer came")
      return outcome
    })
    page.memory.setQuiet(page.id, true)
    rename("Once")
    await settle()
    expect(page.kept.rows.size).toBe(1)
    lose = false

    await page.reopen()
    page.memory.setQuiet(page.id, false)
    await settle()
    expect(page.memory.rows.get(page.id)!.log).toHaveLength(1)
    expect(api().project!.name).toBe("Once")
    expect(page.kept.rows.size).toBe(0)
    expect(api().save.state).toBe("saved")
  })

  it("leaves a page still open its own edits, and edits kept by an editor of another format", async () => {
    const page = await firstPage()
    rename("Mine")
    await settle()
    page.kept.unsent.keep(page.id, { clientId: "s_old", batch: 1, changes: [{ kind: "set", set: [[["name"], "Older format"]] }], formatVersion: PROJECT_FILE_VERSION - 1, seen: 1, savedAt: 0 })
    // Another tab, while the first is open: only the old format's is anyone's to send, and it isn't this editor's.
    api().close()
    connectProjectStorage({ ...page.memory.storage, unsent: page.kept.unsent })
    const stored = (await page.memory.storage.load(page.id))!
    api().open(openStoredProject(stored), stored)
    await settle()
    expect(pushes(page.memory)).toHaveLength(0)
    expect(api().project!.name).toBe("Start")
    expect(page.kept.rows.size).toBe(2)
  })

  /** A page that couldn't save "Mine", closed; then someone else renames the project and adds a label before it opens again. */
  async function changedSince() {
    const page = await firstPage()
    rename("Mine")
    await settle()
    const stored = openStoredProject((await page.memory.storage.load(page.id))!)
    await page.memory.pushAs("other", page.id, projectChanges(stored, { ...addLabel(stored, "GND", { x: 9, y: 9 }).project, name: "Theirs" }))
    await page.reopen()
    await settle()
    return page
  }

  it("holds what a closed page kept when the project changed since, rather than send it over the newer work", async () => {
    const page = await changedSince()
    expect(api().heldEdits).not.toBeNull()
    expect(pushes(page.memory)).toHaveLength(0)
    expect(api().project!.name).toBe("Theirs")
    expect(page.kept.rows.size).toBe(1)
    // The copy to keep has them on top of what is there now.
    expect(api().heldEditsCopy()).toMatchObject({ name: "Mine", labels: [{ name: "GND" }] })

    // The page's own edits go ahead meanwhile.
    api().commit(moveFirst(3))
    await settle()
    expect(page.memory.project(page.id).components[0].sch.x).toBe(3)

    api().restoreHeldEdits()
    await settle()
    expect(api().heldEdits).toBeNull()
    expect(page.memory.project(page.id)).toMatchObject({ name: "Mine", labels: [{ name: "GND" }] })
    expect(page.memory.project(page.id).components[0].sch.x).toBe(3)
    expect(api().project!.name).toBe("Mine")
    expect(pushes(page.memory).find((c) => c.clientId === page.clientId)).toMatchObject({ batch: 1 })
    expect(page.kept.rows.size).toBe(0)
    expect(api().save.state).toBe("saved")
  })

  it("lets held edits go for good when discarded", async () => {
    const page = await changedSince()
    api().discardHeldEdits()
    await settle()
    expect(api().heldEdits).toBeNull()
    expect(page.kept.rows.size).toBe(0)
    expect(pushes(page.memory)).toHaveLength(0)
    expect(page.memory.project(page.id).name).toBe("Theirs")
  })

  it("holds them too when the log no longer reaches back to when they were kept", async () => {
    const page = await firstPage()
    rename("Mine")
    await settle()
    const stored = openStoredProject((await page.memory.storage.load(page.id))!)
    await page.memory.pushAs("other", page.id, projectChanges(stored, addLabel(stored, "GND", { x: 9, y: 9 }).project))
    page.memory.dropLog(page.id)
    await page.reopen()
    await settle()
    expect(api().heldEdits).not.toBeNull()
    expect(pushes(page.memory)).toHaveLength(0)
  })
})

describe("two tabs on one project", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A tab of its own: a sync and what it shows, without the store (which is one per page). */
  function tab(memory: ReturnType<typeof memoryStorage>, id: string, project: Project, revision: number) {
    const shown = { project, status: { state: "saved" } as SaveStatus }
    const host: SyncHost = {
      rebase: (p) => (shown.project = p),
      status: (s) => (shown.status = s),
      role: () => {},
      gone: () => {},
      refused: () => {},
      held: () => {},
    }
    const sync = new ProjectSync(id, project, revision, PROJECT_FILE_VERSION, "owner", memory.storage, host)
    sync.start()
    const edit = (fn: (p: Project) => Project) => {
      const next = fn(shown.project)
      sync.send(projectChanges(shown.project, next))
      shown.project = next
    }
    return { shown, edit, sync }
  }

  it("ends with both people's edits of one part, whoever sent first", async () => {
    const memory = memoryStorage()
    const start = addComponent(createProject("Shared"), "resistor").project
    const { id } = await memory.storage.create(projectRecord(start))
    const opened = openStoredProject((await memory.storage.load(id))!)
    const ada = tab(memory, id, opened, 1)
    const bob = tab(memory, id, opened, 1)
    await vi.advanceTimersByTimeAsync(0)
    ada.edit(moveFirst(4))
    bob.edit((p) => ({ ...p, components: p.components.map((c) => ({ ...c, props: { ...c.props, value: "4k7" } })) }))
    bob.edit((p) => addComponent(p, "capacitor").project)
    await vi.advanceTimersByTimeAsync(500)
    for (const t of [ada, bob]) {
      expect(t.shown.project.components[0].sch.x).toBe(4)
      expect(t.shown.project.components[0].props.value).toBe("4k7")
      expect(t.shown.project.components).toHaveLength(2)
      expect(t.shown.status.state).toBe("saved")
    }
    expect(memory.project(id).components).toHaveLength(2)
  })
})

describe("designators two people took at once", () => {
  it("renumbers one of the two parts, the later one, from either side", () => {
    const base = createProject("x")
    const ada = addComponent(base, "resistor", { id: "c_100" }).project
    const both = addComponent(ada, "resistor", { id: "c_200", ref: "R1" }).project
    expect(both.components.map((c) => c.ref)).toEqual(["R1", "R1"])
    // Ada's tab hears of Bob's c_200: Ada's is the earlier, so she keeps hers.
    const atAda = resolveDesignatorClashes(both, new Set(["c_200"]), (id) => id === "c_100")
    expect(atAda.renumbered).toEqual([])
    // Bob's tab hears of Ada's c_100: his is the later, so his becomes R2.
    const atBob = resolveDesignatorClashes(both, new Set(["c_100"]), (id) => id === "c_200")
    expect(atBob.renumbered).toEqual([{ componentId: "c_200", from: "R1", to: "R2" }])
    expect(atBob.project.components.map((c) => c.ref)).toEqual(["R1", "R2"])
  })

  it("leaves a designator someone typed to match alone", () => {
    const p = addComponent(addComponent(createProject("x"), "resistor", { id: "c_1" }).project, "resistor", { id: "c_2", ref: "R1" }).project
    expect(resolveDesignatorClashes(p, new Set(), () => true).renumbered).toEqual([])
  })
})
