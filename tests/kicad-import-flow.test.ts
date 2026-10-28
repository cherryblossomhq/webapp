import { beforeEach, describe, expect, it, vi } from "vitest"
import { startImport } from "../src/kicadImport/client"
import { KicadImportController } from "../src/kicadImport/controller"
import { entriesFromDrop, entriesFromFiles, isProjectFileDrop } from "../src/kicadImport/dropped"
import { runImport } from "../src/kicadImport/engine"
import type { WorkerEvent } from "../src/kicadImport/protocol"
import { forgetReport, loadReport, MAX_REPORT_CHARS, MAX_REPORTS, saveReport } from "../src/kicadImport/reportStore"
import { summarize, type ImportSummary } from "../src/kicadImport/summary"
import { connectAnalytics } from "../src/kicadImport/analytics"
import { importKicadBoard } from "../src/model/kicad/board"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { entry, fakeStorage, fakeWorkers, stubLocalStorage } from "./kicad-import-helpers"
import { ALL } from "./kicad-test-helpers"

// The paths around the import: a board that is not KiCad's, an outcome crossing the worker, a
// worker that goes silent, drops (folders, empty, unreadable), retry after a failed save, and the
// bounds on what is kept in the browser.

const empty = board({})
const ctx = { used: ["b.kicad_pcb"], notRead: [], ignored: [], boardBytes: 1 }

beforeEach(() => {
  stubLocalStorage()
  connectAnalytics(null)
})

describe("a .brd that is not KiCad's", () => {
  const outcome = async (text: string) => {
    const events: WorkerEvent[] = []
    await runImport({ type: "start", id: 1, files: [entry("old.brd", text)] }, (e) => events.push(e))
    const e = events.at(-1)!
    if (e.type !== "done") throw new Error("not done")
    return e.outcome
  }

  it("an EAGLE board says so", async () => {
    const o = await outcome('<?xml version="1.0" encoding="utf-8"?><!DOCTYPE eagle SYSTEM "eagle.dtd"><eagle version="9.6.2">')
    expect(o.summary.reason).toBe("unreadable")
    expect(o.summary.message).toBe("This is an EAGLE board. EAGLE boards are not supported yet.")
  })

  it("any other .brd says it is not a KiCad board", async () => {
    expect((await outcome("something else entirely")).summary.message).toBe("This .brd file is not a KiCad board, so it cannot be imported.")
  })

  it("a KiCad .brd still gets the importer's version message", async () => {
    expect((await outcome("PCBNEW-BOARD Version 1 date 17/04/2010\n")).summary.message).toMatch(/before version 4/)
  })
})

describe("what crosses the worker", () => {
  it("an imported outcome with its project survives structuredClone, as postMessage does", async () => {
    const events: WorkerEvent[] = []
    const text = board({ body: [footprint({ pads: [pad({ at: "-1 0" }), pad({ number: "2", at: "1 0" })] })] })
    await runImport({ type: "start", id: 1, files: [entry("p.kicad_pcb", text)] }, (e) => events.push(e), { importOptions: { built: ALL } })
    const done = events.at(-1)!
    expect(done.type).toBe("done")
    if (done.type !== "done") return
    expect(done.outcome.project?.components.length).toBe(1)
    expect(structuredClone(done)).toEqual(done)
  })

  it("so does a refusal, and a choice", async () => {
    for (const files of [[entry("a.kicad_pcb", board({ body: [footprint({ pads: [pad({ at: "0 0" })] })] }))], [entry("a.kicad_pcb", empty), entry("b.kicad_pcb", empty)]]) {
      const events: WorkerEvent[] = []
      await runImport({ type: "start", id: 2, files }, (e) => events.push(e))
      const last = events.at(-1)!
      expect(structuredClone(last)).toEqual(last)
    }
  })
})

describe("a worker that goes silent", () => {
  it("is ended after the watchdog's time, with a plain message and the reason in the detail", async () => {
    const worker = { terminated: false, onmessage: null, onerror: null, onmessageerror: null, postMessage() {}, terminate() { worker.terminated = true } }
    const r = await startImport([entry("e.kicad_pcb", empty)], { createWorker: () => worker, watchdogMs: 30 }).result
    expect(worker.terminated).toBe(true)
    expect(r.kind).toBe("done")
    if (r.kind !== "done") return
    expect(r.outcome.summary.reason).toBe("failed")
    expect(r.outcome.summary.message).toBe("The import stopped answering and was ended. Nothing was saved. Try again, or try a smaller board.")
    expect(r.outcome.summary.detail).toMatch(/no answer from the worker/)
  })

  it("is not ended while it keeps answering", async () => {
    const w = fakeWorkers()
    const r = await startImport([entry("e.kicad_pcb", empty)], { createWorker: w.create, watchdogMs: 5000 }).result
    expect(r.kind).toBe("done")
    expect(r.kind === "done" && r.outcome.summary.status).toBe("imported")
  })
})

describe("no worker, and the import's code will not load", () => {
  it("is an error on screen, not a spinner", async () => {
    vi.resetModules()
    vi.doMock("../src/kicadImport/engine", () => {
      throw new Error("Failed to fetch dynamically imported module: https://x.test/chunk.js")
    })
    const { startImport: fresh } = await import("../src/kicadImport/client")
    const r = await fresh([entry("e.kicad_pcb", empty)], { createWorker: null }).result
    vi.doUnmock("../src/kicadImport/engine")
    vi.resetModules()
    expect(r.kind).toBe("done")
    if (r.kind !== "done") return
    expect(r.outcome.summary.reason).toBe("failed")
    expect(r.outcome.summary.message).toBe("The import could not load. Reload the page and try again.")
    expect(JSON.stringify([r.outcome.summary.message])).not.toContain("https://")
    expect(r.outcome.summary.detail).toBeTruthy()
  })
})

describe("a drop", () => {
  const fileEntry = (name: string, path: string): FileSystemFileEntry =>
    ({ isFile: true, isDirectory: false, name, fullPath: path, file: (ok: (f: File) => void) => ok(new File(["x"], name)) }) as unknown as FileSystemFileEntry
  /** A directory that hands out its children 2 at a time, as browsers hand out 100. */
  const dirEntry = (name: string, path: string, children: FileSystemEntry[]): FileSystemDirectoryEntry =>
    ({
      isFile: false,
      isDirectory: true,
      name,
      fullPath: path,
      createReader: () => {
        let at = 0
        return {
          readEntries: (ok: (b: FileSystemEntry[]) => void) => {
            const batch = children.slice(at, at + 2)
            at += 2
            ok(batch)
          },
        }
      },
    }) as unknown as FileSystemDirectoryEntry
  const drop = (entries: (FileSystemEntry | null)[], files: File[] = []) =>
    ({ items: entries.map((e) => ({ kind: "file", webkitGetAsEntry: () => e })), files }) as unknown as DataTransfer

  it("walks a dropped folder, its subfolders and every batch the browser hands out", async () => {
    const tree = dirEntry("proj", "/proj", [
      fileEntry("p.kicad_pcb", "/proj/p.kicad_pcb"),
      fileEntry("p.kicad_pro", "/proj/p.kicad_pro"),
      dirEntry("sheets", "/proj/sheets", [fileEntry("a.kicad_sch", "/proj/sheets/a.kicad_sch")]),
      fileEntry("notes.txt", "/proj/notes.txt"),
      dirEntry(".git", "/proj/.git", [fileEntry("HEAD", "/proj/.git/HEAD")]),
      dirEntry("node_modules", "/proj/node_modules", [fileEntry("x.js", "/proj/node_modules/x.js")]),
    ])
    const got = await entriesFromDrop(drop([tree]))
    expect(got.map((g) => g.path).sort()).toEqual(["proj/notes.txt", "proj/p.kicad_pcb", "proj/p.kicad_pro", "proj/sheets/a.kicad_sch"])
  })

  it("takes the entries before its first await, as the browser empties a drop when the handler returns", async () => {
    const data = drop([fileEntry("a.kicad_pcb", "/a.kicad_pcb")])
    const promise = entriesFromDrop(data)
    ;(data as unknown as { items: unknown[] }).items = []
    expect((await promise).map((g) => g.path)).toEqual(["a.kicad_pcb"])
  })

  it("without the entry API, takes the plain files", async () => {
    const f = new File(["x"], "a.kicad_pcb")
    expect((await entriesFromDrop(drop([null], [f]))).map((g) => g.path)).toEqual(["a.kicad_pcb"])
  })

  it("an empty folder is no files", async () => {
    expect(await entriesFromDrop(drop([dirEntry("empty", "/empty", [])]))).toEqual([])
  })

  it("files picked in a folder picker keep their folder", () => {
    const f = new File(["x"], "a.kicad_pcb")
    Object.defineProperty(f, "webkitRelativePath", { value: "proj/a.kicad_pcb" })
    expect(entriesFromFiles([f]).map((e) => e.path)).toEqual(["proj/a.kicad_pcb"])
  })

  it("only a drop of .json files is the project file import; two of them still are, as before", () => {
    const j = (n: string) => ({ name: n })
    expect(isProjectFileDrop([j("a.json")])).toBe(true)
    expect(isProjectFileDrop([j("a.json"), j("B.JSON")])).toBe(true)
    expect(isProjectFileDrop([j("a.json"), j("b.kicad_pcb")])).toBe(false)
    expect(isProjectFileDrop([j("board.kicad_pcb")])).toBe(false)
    expect(isProjectFileDrop([])).toBe(false)
  })
})

describe("the controller and a drop", () => {
  const make = () => {
    const { storage, created } = fakeStorage()
    return { c: new KicadImportController(storage, { worker: fakeWorkers().create }), created }
  }
  const settled = (c: KicadImportController, step: string) => vi.waitFor(() => expect(c.state.step).toBe(step))

  it("shows the progress at once while a folder is walked, then imports what it held", async () => {
    const { c, created } = make()
    let release: (f: ReturnType<typeof entriesFor>) => void = () => {}
    const entriesFor = () => [entry("p.kicad_pcb", empty)]
    c.startFromDrop(new Promise((res) => (release = res)))
    expect(c.state).toEqual({ step: "working", phase: "reading" })
    release(entriesFor())
    await settled(c, "report")
    expect(created).toHaveLength(1)
  })

  it("an empty drop ends in a report that says so", async () => {
    const { c, created } = make()
    c.startFromDrop(Promise.resolve([]))
    await settled(c, "report")
    expect(c.state.step === "report" && c.state.summary.reason).toBe("no-board")
    expect(c.state.step === "report" && c.state.summary.message).toMatch(/no files in what you dropped/)
    expect(created).toHaveLength(0)
  })

  it("a folder that cannot be read ends in a report that says so", async () => {
    const { c } = make()
    c.startFromDrop(Promise.reject(new Error("NotAllowedError")))
    await settled(c, "report")
    expect(c.state.step === "report" && c.state.summary.reason).toBe("bad-input")
    expect(c.state.step === "report" && c.state.summary.message).toMatch(/could not be read.+Import KiCad/)
  })

  it("cancel while the folder is walked ends it, and the walk's result is ignored", async () => {
    const { c, created } = make()
    let release: (f: ReturnType<typeof entry>[]) => void = () => {}
    c.startFromDrop(new Promise((res) => (release = res)))
    c.cancel()
    expect(c.state).toEqual({ step: "idle" })
    release([entry("p.kicad_pcb", empty)])
    await new Promise((r) => setTimeout(r, 40))
    expect(c.state).toEqual({ step: "idle" })
    expect(created).toHaveLength(0)
  })
})

describe("retry after a failed save", () => {
  it("runs the import again from the same files and saves it when storage has recovered", async () => {
    let fail = true
    const created: unknown[] = []
    const { storage } = fakeStorage({
      create: async (record) => {
        if (fail) throw new Error("Couldn't save the project: the connection dropped.")
        created.push(record)
        return { id: "p1", revision: 1 }
      },
    })
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    c.start([entry("p.kicad_pcb", empty)])
    await vi.waitFor(() => expect(c.state.step).toBe("report"))
    expect(c.state.step === "report" && c.state.saveKind).toBe("again")
    expect(c.state.step === "report" && c.state.projectId).toBeNull()
    fail = false
    c.retry()
    await vi.waitFor(() => expect(c.state.step === "report" && c.state.projectId).toBe("p1"))
    expect(c.state.step === "report" && c.state.saveError).toBeNull()
    expect(created).toHaveLength(1)
  })

  it("does nothing after a report that has no save error", async () => {
    const { storage } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers().create })
    c.start([entry("notes.txt")])
    await vi.waitFor(() => expect(c.state.step).toBe("report"))
    const before = c.state
    c.retry()
    expect(c.state).toBe(before)
  })
})

describe("what is kept in the browser", () => {
  const summary = (): ImportSummary => summarize(importKicadBoard(empty), ctx)

  it("keeps the last 20 reports and forgets the older ones", () => {
    for (let i = 0; i < MAX_REPORTS + 5; i++) saveReport(`p${i}`, summary(), `n${i}`)
    expect(loadReport("p0")).toBeNull()
    expect(loadReport("p4")).toBeNull()
    expect(loadReport("p5")?.name).toBe("n5")
    expect(loadReport(`p${MAX_REPORTS + 4}`)).not.toBeNull()
  })

  it("saving a project's report again does not push another out", () => {
    for (let i = 0; i < MAX_REPORTS; i++) saveReport(`p${i}`, summary(), `n${i}`)
    saveReport("p0", summary(), "again")
    expect(loadReport("p0")?.name).toBe("again")
    expect(loadReport("p1")).not.toBeNull()
  })

  it("a deleted project frees its place", () => {
    for (let i = 0; i < MAX_REPORTS; i++) saveReport(`p${i}`, summary(), `n${i}`)
    forgetReport("p3")
    saveReport("new", summary(), "new")
    expect(loadReport("p0")).not.toBeNull()
    expect(loadReport("new")).not.toBeNull()
  })

  it("cuts long lists, long text, and the lists of files, so one report stays small", () => {
    const long = "x".repeat(5000)
    const s: ImportSummary = {
      ...summary(),
      notBrought: Array.from({ length: 1000 }, (_, i) => ({ code: "x", object: `${long}${i}`, why: long })),
      notNeeded: Array.from({ length: 500 }, (_, i) => ({ why: `${long}${i}`, count: 1 })),
      notRead: Array.from({ length: 500 }, (_, i) => ({ file: `${long}${i}`, why: long })),
      ignored: Array.from({ length: 500 }, (_, i) => ({ why: `${i}`, count: 1, examples: Array.from({ length: 50 }, () => long) })),
    }
    saveReport("big", s, long)
    const kept = loadReport("big")!
    expect(kept.summary.notBrought.length).toBeLessThanOrEqual(301)
    expect(kept.summary.notNeeded.length).toBeLessThanOrEqual(50)
    expect(kept.summary.notRead.length).toBeLessThanOrEqual(50)
    expect(kept.summary.ignored.length).toBeLessThanOrEqual(20)
    expect(kept.summary.ignored[0]?.examples.length ?? 0).toBeLessThanOrEqual(5)
    expect(kept.name.length).toBeLessThan(410)
    expect(kept.summary.notBrought[0].why.length).toBeLessThan(410)
    // One report is bounded whatever it holds, so 20 of them stay well under a browser's 5 million characters.
    expect(localStorage.getItem("cherryblossom:editor:kicad-report:big")!.length).toBeLessThanOrEqual(MAX_REPORT_CHARS)
    expect(MAX_REPORTS * MAX_REPORT_CHARS).toBeLessThan(2_500_000)
  })

  it("a report that is too big is cut harder until it fits, and says how many lines it left out", () => {
    const s: ImportSummary = { ...summary(), notBrought: Array.from({ length: 300 }, (_, i) => ({ code: "x", object: `${"y".repeat(390)}${i}`, why: "z".repeat(390) })) }
    saveReport("fat", s, "n")
    const kept = loadReport("fat")!.summary.notBrought
    expect(kept.length).toBeLessThan(300)
    expect(kept.at(-1)!.code).toBe("shortened")
    expect(localStorage.getItem("cherryblossom:editor:kicad-report:fat")!.length).toBeLessThanOrEqual(MAX_REPORT_CHARS)
  })

  it("the index is written before the report, so a failed index write strands no report", () => {
    const data = stubLocalStorage()
    const real = localStorage.setItem
    localStorage.setItem = (k: string, v: string) => {
      if (k === "cherryblossom:editor:kicad-report-index") throw new Error("quota")
      real(k, v)
    }
    saveReport("p1", summary(), "n")
    expect([...data.keys()]).toEqual([])
    expect(loadReport("p1")).toBeNull()
  })
})

describe("a save that waits for the connection", () => {
  /** A storage whose create settles when the test says. */
  function held() {
    let finish: (v: { id: string; revision: number }) => void = () => {}
    let fail: (e: Error) => void = () => {}
    const created: unknown[] = []
    const { storage } = fakeStorage({
      create: (record) =>
        new Promise((res, rej) => {
          created.push(record)
          finish = res
          fail = rej
        }),
    })
    return { storage, created, finish: (id = "p1") => finish({ id, revision: 1 }), fail: (m: string) => fail(new Error(m)) }
  }
  const make = (storage: ReturnType<typeof held>["storage"], slowSaveMs = 20) => new KicadImportController(storage, { worker: fakeWorkers().create, slowSaveMs })
  const state = (c: KicadImportController) => c.state

  it("cannot be closed at first, then says it is still saving and can be", async () => {
    const h = held()
    const c = make(h.storage, 300)
    c.start([entry("p.kicad_pcb", empty)])
    await vi.waitFor(() => expect(state(c)).toEqual({ step: "working", phase: "saving" }))
    c.cancel()
    expect(state(c)).toEqual({ step: "working", phase: "saving" })
    await vi.waitFor(() => expect(state(c)).toEqual({ step: "working", phase: "saving", slow: true }))
    h.finish()
    await vi.waitFor(() => expect(state(c).step).toBe("report"))
  })

  it("closed while slow, the save is left to finish: it lands later, shows nothing, and is counted once", async () => {
    const h = held()
    const events: string[] = []
    connectAnalytics((name, props) => events.push(`${name}:${props.outcome}`))
    const c = make(h.storage)
    c.start([entry("p.kicad_pcb", empty)])
    await vi.waitFor(() => expect(state(c)).toMatchObject({ phase: "saving", slow: true }))
    c.close()
    expect(state(c)).toEqual({ step: "idle" })
    expect(events).toEqual([])
    h.finish("p9")
    await new Promise((r) => setTimeout(r, 30))
    expect(state(c)).toEqual({ step: "idle" })
    expect(h.created).toHaveLength(1)
    expect(events).toEqual(["kicad_import:imported"])
    expect(loadReport("p9")?.summary.status).toBe("imported")
  })

  it("a save that fails after the dialog was closed on it shows nothing either", async () => {
    const h = held()
    const c = make(h.storage)
    c.start([entry("p.kicad_pcb", empty)])
    await vi.waitFor(() => expect(state(c)).toMatchObject({ slow: true }))
    c.cancel()
    h.fail("offline")
    await new Promise((r) => setTimeout(r, 30))
    expect(state(c)).toEqual({ step: "idle" })
  })

  it("never offers a second save while the first may still land: retry does nothing after an uncertain or a final failure", async () => {
    for (const [message, kind] of [["fetch failed", "uncertain"], ["Couldn't save the project: it is too large to store in your account.", "final"], ["Couldn't save the project: this browser's storage is full or blocked.", "final"]] as const) {
      const { storage } = fakeStorage({ create: async () => { throw new Error(message) } })
      const c = new KicadImportController(storage, { worker: fakeWorkers().create })
      c.start([entry("p.kicad_pcb", empty)])
      await vi.waitFor(() => expect(c.state.step).toBe("report"))
      expect(c.state.step === "report" && c.state.saveKind).toBe(kind)
      const before = c.state
      c.retry()
      expect(c.state).toBe(before)
    }
  })

  it("the size refusal is final: nothing is stored and there is no retry", async () => {
    const { storage, created } = fakeStorage()
    const c = new KicadImportController(storage, { worker: fakeWorkers({ importOptions: { limitBytes: 100 } }).create })
    c.start([entry("p.kicad_pcb", empty)])
    await vi.waitFor(() => expect(c.state.step).toBe("report"))
    expect(created).toHaveLength(0)
    c.retry()
    expect(c.state.step).toBe("report")
  })
})
