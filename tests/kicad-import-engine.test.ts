import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { startImport } from "../src/kicadImport/client"
import { runImport, type BoardImporter, type ProjectBytes, type ProjectImporter } from "../src/kicadImport/engine"
import type { Phase, WorkerEvent } from "../src/kicadImport/protocol"
import { PLAIN_NAMES } from "../src/kicadImport/summary"
import { EXTENSION_NAMES as SCHEMATIC_NAMES } from "../src/model/kicad/schematic"
import { board, footprint, pad, REFUSED_BOARD } from "./kicad-board-fixtures"
import { entry, fakeWorkers, zipEntry } from "./kicad-import-helpers"
import { divider, LIB_R, schematic } from "./kicad-schematic-fixtures"
import { ALL } from "./kicad-test-helpers"

// The job and its worker protocol, with the real importer behind it: every outcome the report
// screen has to draw (imported, imported with report entries, refused for missing extensions,
// refused for size, unreadable with a named error, no board, a bad zip, a failure), the order of
// the messages, cancel, and the importer's code staying out of the page's modules.

const empty = board({})
const withPart = board({ body: [footprint({ pads: [pad({ at: "-1 0" }), pad({ number: "2", at: "1 0" })] })] })

async function run(files: ReturnType<typeof entry>[], options = {}, choice?: string) {
  const events: WorkerEvent[] = []
  await runImport({ type: "start", id: 1, files, choice }, (e) => events.push(e), options)
  return events
}
const last = (events: WorkerEvent[]) => events[events.length - 1]
const outcomeOf = (events: WorkerEvent[]) => {
  const e = last(events)
  if (e.type !== "done") throw new Error(`the job ended with ${e.type}`)
  return e.outcome
}

describe("the outcomes", () => {
  it("imported: a board that needs nothing the editor lacks becomes a project, with its notes", async () => {
    const o = outcomeOf(await run([entry("empty.kicad_pcb", empty)]))
    expect(o.summary.status).toBe("imported")
    expect(o.summary.reason).toBeNull()
    expect(o.project?.name).toBe("empty")
    expect(o.summary.stamp).toBe(20240108)
    expect(o.summary.notes.some((n) => n.code === "rules-in-project-file")).toBe(true)
    expect(o.summary.projectBytes).toBeGreaterThan(0)
    expect(o.summary.boardBytes).toBe(empty.length)
  })

  it("imported with parts and report entries (every extension counted as built, for the test)", async () => {
    const o = outcomeOf(await run([entry("p.kicad_pcb", withPart)], { importOptions: { built: ALL } }))
    expect(o.summary.status).toBe("imported")
    // the part's reference and value come in as the part's own texts
    expect(o.summary.brought).toEqual([{ label: "parts", count: 1 }, { label: "texts of parts (references, values, labels)", count: 2 }])
    expect(o.project?.components.length).toBe(1)
  })

  it("refused for missing extensions: they are named, in plain words, and no project is made", async () => {
    const o = outcomeOf(await run([entry("p.kicad_pcb", REFUSED_BOARD)]))
    expect(o.project).toBeNull()
    expect(o.summary.status).toBe("refused")
    expect(o.summary.reason).toBe("unsupported")
    expect(o.summary.missing).toEqual([{ id: "X26", name: PLAIN_NAMES.X26, why: expect.stringMatching(/creepage/) }])
  })

  it("refused for size: the message names the size and the limit, and nothing is built for saving", async () => {
    const o = outcomeOf(await run([entry("e.kicad_pcb", empty)], { importOptions: { limitBytes: 100 } }))
    expect(o.project).toBeNull()
    expect(o.summary.reason).toBe("too-large")
    expect(o.summary.message).toMatch(/^This board needs \d+ KB and projects hold up to 0 KB\.$/)
  })

  it("failed to read: a file that is not a board is named as such, with the reader's own words", async () => {
    const o = outcomeOf(await run([entry("junk.kicad_pcb", "(kicad_pcb (version")]))
    expect(o.summary.reason).toBe("unreadable")
    expect(o.summary.message).toMatch(/cut short|stops/i)
  })

  it("a legacy .brd is refused with its version message", async () => {
    const o = outcomeOf(await run([entry("old.brd", "PCBNEW-BOARD Version 1 date 17/04/2010\n$GENERAL\n")]))
    expect(o.summary.reason).toBe("unreadable")
    expect(o.summary.message).toMatch(/before version 4.+PCBNEW-BOARD Version 1/)
  })

  it("a file with a node the importer does not know is refused, and says so", async () => {
    const o = outcomeOf(await run([entry("u.kicad_pcb", board({ body: ["(frobnicate 1 2)"] }))]))
    expect(o.summary.status).toBe("refused")
    expect(o.summary.reason).toBe("unknown")
  })

  it("no board among the files", async () => {
    const o = outcomeOf(await run([entry("notes.txt")]))
    expect(o.summary.reason).toBe("no-board")
    expect(o.summary.message).toMatch(/no KiCad board/)
  })

  it("a corrupt zip is a refusal that names the zip", async () => {
    const o = outcomeOf(await run([entry("broken.zip", "this is not a zip")]))
    expect(o.summary.reason).toBe("bad-input")
    expect(o.summary.message).toMatch(/^broken\.zip could not be opened/)
  })

  it("a zip with a board is imported, named for its project file", async () => {
    const zip = await zipEntry("proj.zip", { "proj/my-design.kicad_pcb": empty, "proj/my-design.kicad_pro": "{}" })
    const o = outcomeOf(await run([zip]))
    expect(o.summary.status).toBe("imported")
    expect(o.project?.name).toBe("my-design")
  })

  it("an unexpected break is a sentence for the user, with no stack, and nothing saved", async () => {
    const o = outcomeOf(await run([entry("e.kicad_pcb", empty)], { loadBoardImporter: async () => { throw new Error("out of memory\n    at foo (bar.js:1:1)") } }))
    expect(o.summary.reason).toBe("failed")
    expect(o.project).toBeNull()
    // A plain sentence and a next step on screen; the error itself only in `detail`, for the download.
    expect(o.summary.message).toBe("The import stopped before it finished. Nothing was saved. Reload the page and try again; if it keeps happening, download this report and contact us at trycherryblossom.com/contact.")
    expect(o.summary.detail).toBe("out of memory")
    expect(JSON.stringify(o.summary)).not.toMatch(/ at foo/)
  })

  it("a zip entry that unpacks past the limit says so in plain words, not Something went wrong", async () => {
    const zip = await zipEntry("p.zip", { "p.kicad_pcb": "x".repeat(20000) })
    const o = outcomeOf(await run([zip], { readLimit: 10000 }))
    expect(o.summary.reason).toBe("bad-input")
    expect(o.summary.message).toBe("p.kicad_pcb is larger than 0 MB once unpacked, and this import does not read files that big.")
    expect(o.summary.detail).toBeNull()
  })

  it("a board over the read limit is refused before it is read", async () => {
    const big = { path: "big.kicad_pcb", file: { name: "big.kicad_pcb", size: 300 * 1024 * 1024, arrayBuffer: async () => { throw new Error("must not be read") } } as unknown as File }
    const o = outcomeOf(await run([big]))
    expect(o.summary.reason).toBe("bad-input")
    expect(o.summary.message).toMatch(/300 MB.+64 MB/)
  })
})

describe("several boards", () => {
  it("the first run answers with the choices, the second with the board chosen", async () => {
    const files = [entry("a.kicad_pcb", empty), entry("b.kicad_pcb", empty)]
    const first = last(await run(files))
    expect(first.type).toBe("choose")
    if (first.type === "choose") expect(first.boards.map((b) => b.path)).toEqual(["a.kicad_pcb", "b.kicad_pcb"])
    const o = outcomeOf(await run(files, {}, "b.kicad_pcb"))
    expect(o.project?.name).toBe("b")
  })
})

describe("the schematic and project importer", () => {
  const U1 = "11111111-0000-4000-8000-000000000001"
  const U2 = "11111111-0000-4000-8000-000000000002"
  /** R1 and R2 of the divider on a board, on the nets the schematic gives them. */
  const dividerBoard = board({
    nets: ['(net 0 "")', '(net 1 "VCC")', '(net 2 "/MID")', '(net 3 "GND")'],
    body: [
      footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "VCC")' }), pad({ number: "2", at: "1 0", net: '(net 2 "/MID")' })], extra: `(path "/${U1}")` }),
      footprint({ ref: "R2", at: "15 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 2 "/MID")' }), pad({ number: "2", at: "1 0", net: '(net 3 "GND")' })], extra: `(path "/${U2}")` }),
    ],
  })
  const files = () => [entry("demo.kicad_pcb", dividerBoard), entry("demo.kicad_pro", "{}"), entry("demo.kicad_sch", divider())]

  it("a board, its project file and its schematic import as one project, and the report says so", async () => {
    const o = outcomeOf(await run(files()))
    expect(o.summary.status).toBe("imported")
    expect(o.summary.kind).toBe("project")
    expect(o.summary.message).toBe("The project came in, its board and its schematic, and is ready to open.")
    expect(o.project?.name).toBe("demo")
    expect(o.project?.components.map((c) => c.ref).sort()).toEqual(["#PWR01", "#PWR02", "R1", "R2"])
    expect(o.project?.wires.length).toBeGreaterThan(0)
    expect(o.summary.brought).toEqual(expect.arrayContaining([{ label: "wires on the schematic", count: 5 }, { label: "net labels", count: 1 }]))
    expect(o.summary.used.sort()).toEqual(["demo.kicad_pcb", "demo.kicad_pro", "demo.kicad_sch"])
    expect(o.summary.notRead).toEqual([])
    expect(o.summary.boardBytes).toBe(dividerBoard.length)
    expect(o.summary.stamp).toBe(20240108)
  })

  it("a zip of the project folder imports the board and the schematic together", async () => {
    const zip = await zipEntry("demo.zip", { "demo/demo.kicad_pcb": dividerBoard, "demo/demo.kicad_sch": divider(), "demo/demo.kicad_pro": "{}", "demo/notes.txt": "x" })
    const o = outcomeOf(await run([zip]))
    expect(o.summary.status).toBe("imported")
    expect(o.summary.kind).toBe("project")
    expect(o.project?.components.map((c) => c.ref).sort()).toEqual(["#PWR01", "#PWR02", "R1", "R2"])
    expect(o.summary.ignored.map((i) => i.examples)).toEqual([["notes.txt"]])
  })

  it("a dropped folder (its files, each with its path) is the same", async () => {
    const dropped = [entry("demo/demo.kicad_pcb", dividerBoard), entry("demo/demo.kicad_sch", divider()), entry("demo/demo.kicad_pro", "{}"), entry("demo/demo-backups/demo-2024.kicad_pcb", "old")]
    const o = outcomeOf(await run(dropped))
    expect(o.summary.kind).toBe("project")
    expect(o.project?.components.some((c) => c.ref === "R1")).toBe(true)
  })

  it("a schematic whose cache lacks its symbols is imported from the sym-lib-table and the .kicad_sym files dropped with it (S12)", async () => {
    const lib = `(kicad_symbol_lib (version 20231120) (generator "kicad_symbol_editor")
${LIB_R.replace('"Device:R"', '"R"')}
)`
    const text = schematic({ libs: [], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }], labels: ["A 50.8 46.99 0", "B 50.8 54.61 0"] })
    const table = '(sym_lib_table (version 7) (lib (name "Device")(type "KiCad")(uri "${KIPRJMOD}/libs/Device.kicad_sym")(options "")(descr "")))'
    const files = [entry("p/p.kicad_sch", text), entry("p/sym-lib-table", table), entry("p/libs/Device.kicad_sym", lib)]
    const o = outcomeOf(await run(files))
    expect(o.summary.status).toBe("imported")
    expect(o.project?.components.map((c) => c.ref)).toEqual(["R1"])
    expect(o.summary.used).toEqual(expect.arrayContaining(["sym-lib-table", "Device.kicad_sym"]))
    // Without them the same schematic is refused, naming the symbol and what to add.
    const alone = outcomeOf(await run([entry("p/p.kicad_sch", text)]))
    expect(alone.summary.status).toBe("refused")
    expect(alone.project).toBeNull()
  })

  it("a lone .kicad_sch is a schematic-only project, said in its own words", async () => {
    const o = outcomeOf(await run([entry("demo.kicad_sch", divider())]))
    expect(o.summary.status).toBe("imported")
    expect(o.summary.kind).toBe("schematic")
    expect(o.summary.message).toBe("The schematic came in and is ready to open.")
    expect(o.project?.name).toBe("demo")
    expect(o.project?.components.map((c) => c.ref).sort()).toEqual(["#PWR01", "#PWR02", "R1", "R2"])
    // no board was read: the file's own stamp is the schematic's
    expect(o.summary.stamp).toBe(20230121)
    expect(o.summary.boardBytes).toBe(0)
    expect(o.summary.used).toEqual(["demo.kicad_sch"])
    expect(o.project?.traces).toEqual([])
    expect(o.summary.brought.map((b) => b.label)).toEqual(expect.arrayContaining(["parts", "wires on the schematic", "net labels"]))
  })

  it("a schematic with its project file says the project file's settings wait for a board", async () => {
    const o = outcomeOf(await run([entry("demo.kicad_sch", divider()), entry("demo.kicad_pro", "{}")]))
    expect(o.summary.kind).toBe("schematic")
    expect(o.summary.notRead).toEqual([{ file: "demo.kicad_pro", why: expect.stringMatching(/belong to the board/) }])
  })

  it("sheets inside sheets are imported: one project with a sheet for each file", async () => {
    const hierarchical = schematic({
      body: [`(sheet (at 10 10) (size 20 10) (uuid s1) (property "Sheetname" "Power" (at 0 0 0)) (property "Sheetfile" "power.kicad_sch" (at 0 0 0)))`],
    })
    const power = schematic({})
    const o = outcomeOf(await run([entry("top.kicad_sch", hierarchical), entry("power.kicad_sch", power)]))
    expect(o.summary.kind).toBe("schematic")
    expect(o.summary.status).toBe("imported")
    expect(o.project?.sheetSymbols).toHaveLength(1)
    expect(o.project?.sheets?.map((s) => s.id)).toEqual(["root", "s1"])
  })

  it("a refusal of the project's board or schematic says project, with the board's own reason", async () => {
    const o = outcomeOf(await run([entry("demo.kicad_pcb", board({ nets: ['(net 0 "")', '(net 1 "VCC")'], setup: "(setup (pad_to_mask_clearance 0) (creepage 1.5))" })), entry("demo.kicad_sch", divider())]))
    expect(o.summary.kind).toBe("project")
    expect(o.summary.reason).toBe("unsupported")
    expect(o.summary.message).toBe("This project uses 1 thing Cherry Blossom cannot hold yet, listed below.")
    expect(o.summary.missing[0].name).toBe(PLAIN_NAMES.X26)
  })

  it("KiCad 5's schematic beside a board is set aside with its reason, and the board imports alone", async () => {
    const o = outcomeOf(await run([entry("p.kicad_pcb", empty), entry("p.sch", "EESchema Schematic File Version 4"), entry("p.pro", "update=1")]))
    expect(o.summary.status).toBe("imported")
    expect(o.summary.kind).toBeUndefined()
    expect(o.summary.notRead.map((n) => n.file).sort()).toEqual(["p.pro", "p.sch"])
    expect(o.summary.notRead.every((n) => /KiCad 5/.test(n.why))).toBe(true)
  })

  it("a schematic that is not a schematic is refused with the reader's words", async () => {
    const o = outcomeOf(await run([entry("junk.kicad_sch", "(kicad_sch (version")]))
    expect(o.summary.kind).toBe("schematic")
    expect(o.summary.reason).toBe("unreadable")
  })

  it("every extension of the schematic importer has a plain name, so no report shows a bare id", () => {
    for (let n = 1; n <= 12; n++) expect(PLAIN_NAMES[`S${n}`], `S${n}`).toBeTruthy()
    for (const id of Object.keys(SCHEMATIC_NAMES)) expect(PLAIN_NAMES[id], id).not.toMatch(/S\d+/)
  })

  it("once plugged in by a test, it is called instead of the board importer, with every file read and its path", async () => {
    const board$ = vi.fn()
    const project: ProjectImporter = vi.fn(async (f: ProjectBytes) => {
      expect(f.projectFile?.name).toBe("p.kicad_pro")
      expect(f.schematics.map((s) => [s.name, s.path])).toEqual([["p.kicad_sch", "p.kicad_sch"]])
      expect(f.boardPath).toBe("p.kicad_pcb")
      return (await import("../src/model/kicad/board")).importKicadBoard(f.board!)
    })
    const three = [entry("p.kicad_pcb", empty), entry("p.kicad_pro", "{}"), entry("p.kicad_sch", "(kicad_sch)")]
    const o = outcomeOf(await run(three, { loadBoardImporter: async () => ({ importKicadBoard: board$ }) as unknown as BoardImporter, loadProjectImporter: async () => project }))
    expect(project).toHaveBeenCalledTimes(1)
    expect(board$).not.toHaveBeenCalled()
    expect(o.summary.status).toBe("imported")
    expect(o.summary.used.sort()).toEqual(["p.kicad_pcb", "p.kicad_pro", "p.kicad_sch"])
    expect(o.summary.notRead).toEqual([])
  })

  it("a board alone never loads the project importer", async () => {
    const load = vi.fn()
    await run([entry("p.kicad_pcb", empty)], { loadProjectImporter: load })
    expect(load).not.toHaveBeenCalled()
  })

  it("with no project importer plugged in, a board's schematic and project file are said not to be read, and the board imports alone", async () => {
    const o = outcomeOf(await run([entry("p.kicad_pcb", empty), entry("p.kicad_pro", "{}"), entry("p.kicad_sch", "(kicad_sch)")], { loadProjectImporter: null }))
    expect(o.summary.status).toBe("imported")
    expect(o.summary.notRead.map((n) => n.file).sort()).toEqual(["p.kicad_pro", "p.kicad_sch"])
  })
})

describe("the importer loads when a job starts", () => {
  it("the board importer is not asked for until the job has read its files", async () => {
    const load = vi.fn(async () => (await import("../src/model/kicad/board")) as unknown as BoardImporter)
    const events: WorkerEvent[] = []
    const job = runImport({ type: "start", id: 1, files: [entry("notes.txt")] }, (e) => events.push(e), { loadBoardImporter: load })
    await job
    expect(load).not.toHaveBeenCalled()
    await runImport({ type: "start", id: 2, files: [entry("e.kicad_pcb", empty)] }, (e) => events.push(e), { loadBoardImporter: load })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("no module of the page imports the importer's code except as a type; only the engine loads it, dynamically", () => {
    const dir = join(__dirname, "../src/kicadImport")
    const root = join(__dirname, "../src")
    const offenders: string[] = []
    const scan = (file: string) => {
      const text = readFileSync(file, "utf8")
      for (const m of text.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]*model\/kicad\/board[^"]*)"/gm)) if (!m[2]) offenders.push(`${file}: ${m[0].slice(0, 60)}`)
      for (const m of text.matchAll(/import\("([^"]*model\/kicad\/board[^"]*)"\)/g)) if (!file.endsWith("engine.ts")) offenders.push(`${file}: dynamic ${m[1]}`)
    }
    for (const f of readdirSync(dir)) scan(join(dir, f))
    // And nothing else in the editor reaches into the importer by a plain import.
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name)
        if (f.isDirectory()) f.name !== "kicad" && walk(p)
        else if (/\.(ts|tsx)$/.test(f.name) && !p.includes("kicadImport")) {
          const text = readFileSync(p, "utf8")
          if (/from\s+"[^"]*model\/kicad\/board[^"]*"/.test(text.replace(/^import type .*$/gm, ""))) offenders.push(p)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

describe("the worker protocol, from the page", () => {
  const phases = (start: Parameters<typeof startImport>) => {
    const seen: Phase[] = []
    const w = fakeWorkers()
    const job = startImport(start[0], { ...start[1], createWorker: w.create, onProgress: (p) => seen.push(p) })
    return { seen, job, w }
  }

  it("reports reading, then building, then the result with how long it took", async () => {
    const { seen, job, w } = phases([[entry("e.kicad_pcb", empty)], {}])
    const r = await job.result
    expect(seen).toEqual(["reading", "building"])
    expect(r.kind).toBe("done")
    if (r.kind === "done") expect(r.outcome.summary.status).toBe("imported")
    expect(w.made[0].terminated).toBe(true)
    expect(w.made[0].requests[0]).toMatchObject({ type: "start", choice: undefined })
  })

  it("answers a choice and ends the worker", async () => {
    const { job, w } = phases([[entry("a.kicad_pcb", empty), entry("b.kicad_pcb", empty)], {}])
    const r = await job.result
    expect(r.kind).toBe("choose")
    expect(w.made[0].terminated).toBe(true)
  })

  it("cancel ends the worker, answers cancelled, and a late answer changes nothing", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => (release = res))
    const w = fakeWorkers({ loadBoardImporter: async () => (await gate, (await import("../src/model/kicad/board")) as unknown as BoardImporter) })
    const seen: Phase[] = []
    const job = startImport([entry("e.kicad_pcb", empty)], { createWorker: w.create, onProgress: (p) => seen.push(p) })
    await vi.waitFor(() => expect(seen).toContain("building"))
    job.cancel()
    expect(w.made[0].terminated).toBe(true)
    expect(await job.result).toEqual({ kind: "cancelled" })
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(await job.result).toEqual({ kind: "cancelled" })
  })

  it("a worker that fails to load is a failure with words, not a hang", async () => {
    const worker = { terminated: false, onmessage: null, onerror: null, onmessageerror: null, postMessage() { setTimeout(() => (worker.onerror as unknown as (e: object) => void)?.({ preventDefault() {} })) }, terminate() { worker.terminated = true } }
    const job = startImport([entry("e.kicad_pcb", empty)], { createWorker: () => worker })
    const r = await job.result
    expect(r.kind === "done" && r.outcome.summary.reason).toBe("failed")
    expect(r.kind === "done" && r.outcome.summary.message).toMatch(/could not load/)
    expect(worker.terminated).toBe(true)
  })

  it("a worker that cannot be made is a failure with words", async () => {
    const r = await startImport([entry("e.kicad_pcb", empty)], { createWorker: () => { throw new Error("no workers") } }).result
    expect(r.kind === "done" && r.outcome.summary.reason).toBe("failed")
  })

  it("an answer that cannot be read is a failure with words", async () => {
    const worker = { terminated: false, onmessage: null, onerror: null, onmessageerror: null, postMessage() { setTimeout(() => (worker.onmessageerror as unknown as () => void)?.()) }, terminate() { worker.terminated = true } }
    const r = await startImport([entry("e.kicad_pcb", empty)], { createWorker: () => worker }).result
    expect(r.kind === "done" && r.outcome.summary.reason).toBe("failed")
  })

  it("answers meant for another job are ignored", async () => {
    const worker = {
      terminated: false,
      onmessage: null as ((e: MessageEvent<WorkerEvent>) => void) | null,
      onerror: null,
      onmessageerror: null,
      postMessage(req: { id: number }) {
        setTimeout(() => worker.onmessage?.({ data: { type: "choose", id: req.id + 100, boards: [] } } as unknown as MessageEvent<WorkerEvent>))
        setTimeout(() => worker.onmessage?.({ data: { type: "choose", id: req.id, boards: [] } } as unknown as MessageEvent<WorkerEvent>), 5)
      },
      terminate() {
        worker.terminated = true
      },
    }
    const r = await startImport([entry("e.kicad_pcb", empty)], { createWorker: () => worker }).result
    expect(r).toEqual({ kind: "choose", boards: [] })
  })

  it("with no worker at all, the same job runs on the page", async () => {
    const r = await startImport([entry("e.kicad_pcb", empty)], { createWorker: null }).result
    expect(r.kind === "done" && r.outcome.summary.status).toBe("imported")
  })
})
