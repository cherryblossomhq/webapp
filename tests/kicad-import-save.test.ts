import { beforeEach, describe, expect, it, vi } from "vitest"
import { KicadImportController, type ImportState } from "../src/kicadImport/controller"
import { loadReport } from "../src/kicadImport/reportStore"
import { saveImported, SaveRefused, sizeText, STORED_PROJECT_LIMIT_BYTES } from "../src/kicadImport/save"
import { stoppedSummary, summarize } from "../src/kicadImport/summary"
import { connectAnalytics } from "../src/kicadImport/analytics"
import { forgetReport } from "../src/kicadImport/reportStore"
import { createProject } from "../src/model/ops"
import { PROJECT_SIZE_LIMIT_BYTES, formatSize, importKicadBoard } from "../src/model/kicad/board"
import { board, footprint, pad, REFUSED_BOARD } from "./kicad-board-fixtures"
import { entry, fakeStorage, fakeWorkers, stubLocalStorage } from "./kicad-import-helpers"
import type { ImportOutcome } from "../src/kicadImport/protocol"
import { ALL } from "./kicad-test-helpers"

// Saving: the size is checked before anything is stored, a refusal leaves nothing behind, and the
// flow from files to a saved project and its report goes through the same storage call as a
// project file's import.

const empty = board({})

const outcomeOf = (text: string, options = {}): ImportOutcome => {
  const result = importKicadBoard(text, options)
  return { summary: summarize(result, { used: ["b.kicad_pcb"], notRead: [], ignored: [], boardBytes: text.length }), project: result.status === "imported" ? result.project : null }
}

beforeEach(() => {
  stubLocalStorage()
  connectAnalytics(null)
})

describe("the limit", () => {
  it("is the one number in the importer, the storage policy and here", () => {
    expect(STORED_PROJECT_LIMIT_BYTES).toBe(3 * 1024 * 1024)
    expect(PROJECT_SIZE_LIMIT_BYTES).toBe(STORED_PROJECT_LIMIT_BYTES)
  })

  it("is worded the way the importer words it", () => {
    for (const n of [0, 1500, 900 * 1024, 1.4 * 1024 * 1024, 41 * 1024 * 1024]) expect(sizeText(n)).toBe(formatSize(n))
  })
})

describe("saving an imported project", () => {
  it("creates the project once, through storage's create, and keeps its report", async () => {
    const { storage, created } = fakeStorage()
    const outcome = outcomeOf(empty)
    const id = await saveImported(storage, outcome)
    expect(id).toBe("p1")
    expect(created).toHaveLength(1)
    expect(created[0].name).toBe(outcome.project!.name)
    expect(loadReport("p1")?.summary.status).toBe("imported")
  })

  it("measures the stored text before anything is sent: a project over the limit stores nothing", async () => {
    const { storage, created } = fakeStorage()
    const outcome = outcomeOf(empty)
    // A project that is fine for the importer and over the limit by the time it is stored.
    const fat = { ...outcome.project!, properties: [{ key: "Notes", value: "x".repeat(STORED_PROJECT_LIMIT_BYTES) }] }
    const err = await saveImported(storage, { ...outcome, project: fat }).catch((e) => e)
    expect(err).toBeInstanceOf(SaveRefused)
    expect(err.kind).toBe("final")
    expect(err.message).toMatch(/^This board needs 3\.0 MB and/)
    expect(err.message).toMatch(/projects hold up to 3\.0 MB\. Nothing was saved\.$/)
    expect(created).toHaveLength(0)
    expect(loadReport("p1")).toBeNull()
  })

  it("a refusal from the importer has nothing to save, and saving it is refused", async () => {
    const { storage, created } = fakeStorage()
    const refused = outcomeOf(REFUSED_BOARD)
    await expect(saveImported(storage, refused)).rejects.toBeInstanceOf(SaveRefused)
    expect(created).toHaveLength(0)
  })

  it("a storage failure is a sentence, says nothing was saved, and keeps no report", async () => {
    const { storage } = fakeStorage({ create: async () => { throw new Error("fetch failed: ECONNRESET at foo (bar.js:1:1)") } })
    const err = await saveImported(storage, outcomeOf(empty)).catch((e) => e)
    // A failure that could be a timeout after the write went through does not claim nothing was saved.
    expect(err.message).toBe("Couldn't tell whether the project was saved. Check your projects list before importing the board again.")
    expect(err.kind).toBe("uncertain")
    expect(err.message).not.toMatch(/ECONNRESET|bar\.js/)
    expect(loadReport("p1")).toBeNull()
  })

  it("a storage that explains itself in its own words is believed", async () => {
    const { storage } = fakeStorage({ create: async () => { throw new Error("Couldn't save the project: this browser's storage is full or blocked.") } })
    const err = await saveImported(storage, outcomeOf(empty)).catch((e) => e)
    expect(err.message).toBe("Couldn't save the project: this browser's storage is full or blocked. Nothing was saved.")
    expect(err.kind).toBe("final")
  })

  it("deleting a project forgets its report", async () => {
    const { storage } = fakeStorage()
    const id = await saveImported(storage, outcomeOf(empty))
    expect(loadReport(id)).not.toBeNull()
    forgetReport(id)
    expect(loadReport(id)).toBeNull()
  })

  it("a full browser keeps the project and loses only the report", async () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => { throw new Error("quota") }, removeItem: () => {} }
    const { storage, created } = fakeStorage()
    await expect(saveImported(storage, outcomeOf(empty))).resolves.toBe("p1")
    expect(created).toHaveLength(1)
  })

  it("keeps a long report short enough to store, and says so", async () => {
    const { storage } = fakeStorage()
    const outcome = outcomeOf(empty)
    outcome.summary.notBrought = Array.from({ length: 2000 }, (_, i) => ({ code: "model-not-brought", object: `3D model ${i}`, why: "not in the library" }))
    const id = await saveImported(storage, outcome)
    const kept = loadReport(id)!.summary.notBrought
    expect(kept.length).toBe(301)
    expect(kept[300].why).toMatch(/shortened/)
  })
})

describe("the flow, from files to a saved project", () => {
  const states = (c: KicadImportController) => {
    const seen: string[] = []
    c.subscribe(() => seen.push(c.state.step === "working" ? `working:${c.state.phase}` : c.state.step))
    return seen
  }
  const settled = (c: KicadImportController, step: ImportState["step"]) => vi.waitFor(() => expect(c.state.step).toBe(step))

  it("imports, saves, and shows the report with the new project's id", async () => {
    const { storage, created } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    const seen = states(c)
    c.start([entry("p.kicad_pcb", empty)])
    await settled(c, "report")
    expect(seen).toEqual(["working:reading", "working:building", "working:saving", "report"])
    expect(c.state).toMatchObject({ step: "report", projectId: "p1", saveError: null })
    expect(created).toHaveLength(1)
  })

  it("a refusal shows the report and stores nothing", async () => {
    const { storage, created } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    c.start([entry("p.kicad_pcb", REFUSED_BOARD)])
    await settled(c, "report")
    expect(c.state).toMatchObject({ step: "report", projectId: null })
    expect(c.state.step === "report" && c.state.summary.reason).toBe("unsupported")
    expect(created).toHaveLength(0)
  })

  it("a refusal for size stores nothing", async () => {
    const { storage, created } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers({ importOptions: { limitBytes: 200 } }).create })
    c.start([entry("p.kicad_pcb", empty)])
    await settled(c, "report")
    expect(c.state.step === "report" && c.state.summary.reason).toBe("too-large")
    expect(created).toHaveLength(0)
  })

  it("two boards ask first; the choice runs the import", async () => {
    const { storage, created } = fakeStorage()
    const workers = fakeWorkers()
    const c = new KicadImportController(storage, { worker: workers.create })
    c.start([entry("a.kicad_pcb", empty), entry("b.kicad_pcb", empty)])
    await settled(c, "choose")
    expect(created).toHaveLength(0)
    c.choose("b.kicad_pcb")
    await settled(c, "report")
    expect(created[0].name).toBe("b")
  })

  it("a storage that fails after a good import shows the board's report with the reason, saved nowhere", async () => {
    const { storage } = fakeStorage({ create: async () => { throw new Error("offline") } })
    const events: string[] = []
    connectAnalytics((name, props) => events.push(`${name}:${props.outcome}`))
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    c.start([entry("p.kicad_pcb", empty)])
    await settled(c, "report")
    expect(c.state).toMatchObject({ step: "report", projectId: null, saveKind: "uncertain", saveError: expect.stringMatching(/whether the project was saved/) })
    expect(events).toEqual(["kicad_import:save_failed"])
  })

  it("cancel while building ends the import, saves nothing, and returns to the start", async () => {
    const { storage, created } = fakeStorage()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const workers = fakeWorkers({ loadBoardImporter: async () => (await gate, (await import("../src/model/kicad/board")) as never) })
    const events: string[] = []
    connectAnalytics((name, props) => events.push(`${name}:${props.outcome}`))
    const c = new KicadImportController(storage, { worker: workers.create })
    c.start([entry("p.kicad_pcb", empty)])
    await vi.waitFor(() => expect(c.state).toEqual({ step: "working", phase: "building" }))
    c.cancel()
    expect(c.state).toEqual({ step: "idle" })
    expect(workers.made[0].terminated).toBe(true)
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(c.state).toEqual({ step: "idle" })
    expect(created).toHaveLength(0)
    expect(events).toEqual(["kicad_import:cancelled"])
  })

  it("a second start while one is running is ignored", async () => {
    const { storage, created } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    c.start([entry("p.kicad_pcb", empty)])
    c.start([entry("q.kicad_pcb", empty)])
    await settled(c, "report")
    expect(created).toHaveLength(1)
  })

  it("closing a report returns to the start", async () => {
    const { storage } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    c.start([entry("notes.txt")])
    await settled(c, "report")
    c.close()
    expect(c.state).toEqual({ step: "idle" })
  })

  it("reports every import's outcome once, with no names", async () => {
    const { storage } = fakeStorage()
    const seen: Record<string, unknown>[] = []
    connectAnalytics((_, props) => seen.push(props))
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    c.start([entry("secret-name.kicad_pcb", empty)])
    await settled(c, "report")
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toMatch(/secret/)
    expect(seen[0]).toMatchObject({ outcome: "imported", kicad_stamp: "20240108", kicad_release: "kicad8", missing_extensions: [] })
    // `stoppedSummary` is what a cancel reports: no board was read.
    expect(stoppedSummary("cancelled", "x").stamp).toBeNull()
  })

  it("imported with every extension built also works end to end", async () => {
    const { storage, created } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers({ importOptions: { built: ALL } }).create })
    c.start([entry("p.kicad_pcb", board({ body: [footprint({ pads: [pad({ at: "0 0" })] })] }))])
    await settled(c, "report")
    expect(created).toHaveLength(1)
    expect(createProject().name).toBeTruthy()
  })
})
