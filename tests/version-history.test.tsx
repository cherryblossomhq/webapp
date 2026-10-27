// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { addComponent, addWire, createProject } from "../src/model/ops"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { HistoryPanel } from "../src/panels/HistoryPanel"
import { PreviewBanner } from "../src/panels/PreviewBanner"
import { changeLines, versionLabel } from "../src/store/history"
import { connectProjectStorage, useProjectStore } from "../src/store/projectStore"
import { projectChanges } from "../src/store/changes"
import { openStoredProject, projectRecord } from "../src/store/storage"
import { ProjectSync, type SaveStatus, type SyncHost } from "../src/store/sync"
import { memoryStorage } from "./memoryStorage"

/**
 * Version history in the editor: the panel's list, a version shown read-only under a banner, and a
 * restore with two copies of the project open, which both end up on the restored state without a
 * reload. The storage is the in-memory one, which behaves as `versions.ts` does.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = () => useProjectStore.getState()
const flush = (ms = 200) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

let root: Root
let host: HTMLElement
const button = (name: RegExp | string) =>
  [...host.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "") || name.test(b.getAttribute("aria-label") ?? "")))
const click = (b: Element | undefined) => act(async () => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const rowOf = (text: string) => [...host.querySelectorAll("li > button")].find((b) => b.textContent?.includes(text))

const person = (name: string) => ({ userId: `u_${name}`, name, email: `${name.toLowerCase()}@example.com` })
const zero = () => ({ added: 0, removed: 0, changed: 0 })
const summary = (over: Record<string, Partial<{ added: number; removed: number; changed: number }>>) => ({
  parts: zero(), wires: zero(), traces: zero(), vias: zero(), zones: zero(), labels: zero(), other: zero(),
  ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, { ...zero(), ...v }])),
})

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  api().close()
  connectProjectStorage(null)
  vi.useRealTimers()
})

/** A project with one part, open in this tab, with two kept versions: the start, and a later one with a named state. */
async function setup(role: "owner" | "editor" | "viewer" = "owner") {
  const memory = memoryStorage()
  connectProjectStorage(memory.storage)
  const start = addComponent(createProject("Robot"), "resistor").project
  const { id } = await memory.storage.create(projectRecord(start))
  const first = memory.snapshot(id, { summary: summary({ parts: { added: 1 } }), editors: [person("Ada")] })
  // Two wires later, someone else's version.
  const wired = addWire(addWire(start, [{ x: 0, y: 0 }, { x: 4, y: 0 }]).project, [{ x: 0, y: 2 }, { x: 4, y: 2 }]).project
  await memory.pushAs("tab_x", id, projectChanges(start, wired))
  const second = memory.snapshot(id, { kind: "named", name: "Sent to fab v2", by: person("Bob"), summary: summary({ wires: { added: 2 }, traces: { removed: 1 }, parts: { changed: 3 } }), editors: [person("Ada"), person("Bob")] })
  memory.setRole(id, role)
  const stored = (await memory.storage.load(id))!
  api().open(openStoredProject(stored), stored)
  await flush()
  return { memory, id, start, wired, first, second }
}

describe("the history panel", () => {
  it("lists versions newest first with time, who and what changed, and the named one marked", async () => {
    await setup()
    act(() => root.render(<HistoryPanel />))
    await flush()
    const rows = [...host.querySelectorAll("li > button")].map((b) => b.textContent ?? "")
    expect(rows[0]).toContain("Current version")
    expect(rows[1]).toContain("Sent to fab v2")
    expect(rows[1]).toContain("+2 wires")
    expect(rows[1]).toContain("−1 trace")
    expect(rows[1]).toContain("~3 parts")
    expect(rows[1]).toContain("Ada, Bob")
    expect(rows[2]).toContain("+1 part")
    expect(rows[2]).toContain("Ada")
    expect(host.querySelector("[aria-label='Named version']")).not.toBeNull()
  })

  it("lets an editor name the current state, and a viewer not", async () => {
    const { memory, id } = await setup("editor")
    act(() => root.render(<HistoryPanel />))
    await flush()
    const input = host.querySelector("input[aria-label='Name the current version']") as HTMLInputElement
    expect(input).not.toBeNull()
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      set.call(input, "Before the layout")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click(button("Save"))
    await flush()
    expect(memory.versions.filter((v) => v.designId === id && v.name === "Before the layout")).toHaveLength(1)
    expect(host.textContent).toContain("Before the layout")

    // The same panel for a viewer: no way to name.
    memory.setRole(id, "viewer")
    await flush()
    expect(host.querySelector("input[aria-label='Name the current version']")).toBeNull()
  })

  it("says what a version is called and how a change reads", () => {
    expect(versionLabel({ kind: "named", name: "v1", restoredFromAt: null, at: 0 })).toBe("v1")
    expect(changeLines(summary({ parts: { added: 1, removed: 2 }, other: { changed: 1 } })).map((l) => l.text)).toEqual(["+1 part", "−2 parts", "~1 other item"])
    expect(changeLines(summary({}))).toEqual([])
  })
})

describe("previewing a version", () => {
  it("shows it read-only under a banner, without touching the project, and goes back", async () => {
    const { memory, id, start, wired } = await setup()
    act(() => root.render(<><HistoryPanel /><PreviewBanner /></>))
    await flush()
    expect(api().project!.wires).toHaveLength(2)
    memory.calls.length = 0

    await click(rowOf("+1 part"))
    await flush()
    // The first version: the project before the wires.
    expect(api().preview?.version.id).toBe("v0")
    expect(api().project!.wires).toHaveLength(0)
    expect(api().role).toBe("viewer")
    expect(host.querySelector("[aria-label='Viewing an older version']")?.textContent).toContain("Viewing")
    expect(host.textContent).toContain("Restore this version")

    // An edit is refused, and nothing is sent.
    const shown = api().project
    api().commit((p) => ({ ...p, name: "Changed in the preview" }))
    await flush(500)
    expect(api().project).toBe(shown)
    expect(memory.calls.filter((c) => c.op === "push" || c.op === "replace")).toEqual([])
    expect(memory.project(id).wires).toHaveLength(2)

    // Someone else edits while it is open: the live project moves behind it, and is there when it closes.
    const live = openStoredProject((await memory.storage.load(id))!)
    await memory.pushAs("tab_x", id, projectChanges(live, { ...live, name: "Renamed meanwhile" }))
    await flush()
    expect(api().project!.wires).toHaveLength(0)
    expect(api().preview!.live.name).toBe("Renamed meanwhile")

    await click(button("Back to current"))
    expect(api().preview).toBeNull()
    expect(api().role).toBe("owner")
    expect(api().project!.name).toBe("Renamed meanwhile")
    expect(api().project!.wires).toHaveLength(2)
    expect(host.querySelector("[aria-label='Viewing an older version']")).toBeNull()
    expect(start.wires).toHaveLength(0)
    expect(wired.wires).toHaveLength(2)
  })

  it("offers a viewer no restore, and the server refuses one anyway", async () => {
    const { memory, id } = await setup("viewer")
    act(() => root.render(<><HistoryPanel /><PreviewBanner /></>))
    await flush()
    await click(rowOf("+1 part"))
    await flush()
    expect(api().preview).not.toBeNull()
    expect(host.textContent).toContain("Back to current")
    expect(host.textContent).not.toContain("Restore this version")
    expect(await memory.storage.history!.restore(id, "v0", PROJECT_FILE_VERSION)).toEqual({ ok: false, reason: "forbidden" })
  })

  it("says so when a version is gone", async () => {
    const { memory } = await setup()
    act(() => root.render(<HistoryPanel />))
    await flush()
    memory.versions.splice(0, 1)
    await click(rowOf("+1 part"))
    await flush()
    expect(api().preview).toBeNull()
    expect(host.textContent).toContain("That version is gone")
  })
})

describe("restoring with two copies open", () => {
  /** Bob's copy of the project: a sync of its own, as in the two-copy tests. */
  function bobsTab(memory: ReturnType<typeof memoryStorage>, id: string, project: Project, revision: number) {
    const shown = { project, status: { state: "saved" } as SaveStatus }
    const hostFor: SyncHost = {
      rebase: (p) => (shown.project = p),
      status: (s) => (shown.status = s),
      role: () => {},
      gone: () => {},
      refused: () => {},
    }
    const sync = new ProjectSync(id, project, revision, PROJECT_FILE_VERSION, "editor", memory.storage, hostFor)
    sync.start()
    return { shown, sync }
  }

  it("makes the old state the live one as a new change, which both copies follow, after keeping what it replaced", async () => {
    const { memory, id, start } = await setup()
    act(() => root.render(<><HistoryPanel /><PreviewBanner /></>))
    // Bob opens the project as it is now, beside this tab.
    const stored = (await memory.storage.load(id))!
    const bob = bobsTab(memory, id, openStoredProject(stored), stored.revision)
    await flush()

    // Ada keeps working: a part, which lands.
    api().commit((p) => addComponent(p, "capacitor").project)
    await flush(500)
    expect(memory.project(id).components).toHaveLength(2)
    expect(bob.shown.project.components).toHaveLength(2)
    const revisionBefore = memory.rows.get(id)!.revision
    const versionsBefore = memory.versions.length

    // She looks at the first version and restores it.
    await click(rowOf("+1 part"))
    await flush()
    expect(api().project!.wires).toHaveLength(0)
    await click(button("Restore this version"))
    await flush(500)

    // The live state is the old one, written as the next revision of the log.
    const row = memory.rows.get(id)!
    expect(row.revision).toBe(revisionBefore + 1)
    expect(row.log[row.log.length - 1]).toMatchObject({ revision: revisionBefore + 1, changes: null })
    expect(memory.project(id).components).toHaveLength(1)
    // What it replaced is kept, as a restore version.
    expect(memory.versions).toHaveLength(versionsBefore + 1)
    const backup = memory.versions[memory.versions.length - 1]
    expect(backup).toMatchObject({ kind: "restore", restoredFromAt: memory.versions[0].at, revision: revisionBefore })
    expect(JSON.parse(backup.content).project.components).toHaveLength(2)

    // Both open copies are on it without a reload, and the preview is over.
    expect(api().preview).toBeNull()
    expect(api().role).toBe("owner")
    expect(api().project!.components).toHaveLength(1)
    expect(api().project!.wires).toHaveLength(0)
    expect(bob.shown.project.components).toHaveLength(1)
    expect(bob.shown.project.wires).toHaveLength(0)
    expect(api().save.state).toBe("saved")
    expect(bob.shown.status.state).toBe("saved")
    expect(api().past).toEqual([])
    expect(host.querySelector("[aria-label='Viewing an older version']")).toBeNull()
    expect(start.components).toHaveLength(1)

    // Bob keeps editing on top of the restored state, and Ada sees it: the history went forward.
    const edited = addComponent(bob.shown.project, "resistor").project
    bob.sync.send(projectChanges(bob.shown.project, edited))
    bob.shown.project = edited
    await flush(500)
    expect(api().project!.components).toHaveLength(2)
    expect(memory.project(id).components).toHaveLength(2)

    // And the restore can be undone: restoring the version it kept brings back Ada's capacitor.
    const undone = await memory.storage.history!.restore(id, backup.id, PROJECT_FILE_VERSION)
    expect(undone.ok).toBe(true)
    await flush(500)
    expect(api().project!.components).toHaveLength(2)
    expect(bob.shown.project.components.map((c) => c.id).sort()).toEqual(api().project!.components.map((c) => c.id).sort())
  })

  it("keeps the preview and says why when the restore is refused", async () => {
    const { memory, id } = await setup()
    act(() => root.render(<><HistoryPanel /><PreviewBanner /></>))
    await flush()
    await click(rowOf("+1 part"))
    await flush()
    // Made a viewer between looking and restoring.
    memory.rows.get(id)!.role = "viewer"
    await click(button("Restore this version"))
    await flush()
    expect(api().preview).not.toBeNull()
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Only people who can edit")
    expect(memory.rows.get(id)!.revision).toBeLessThan(10)
    expect(memory.versions.some((v) => v.kind === "restore")).toBe(false)
  })
})
