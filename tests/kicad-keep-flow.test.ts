import { beforeEach, describe, expect, it } from "vitest"
import { kicadFiles, kicadZip } from "../src/export/kicad"
import { keepOriginal, unchangedExport } from "../src/export/keep/original"
import { runImport } from "../src/kicadImport/engine"
import type { ImportOutcome, WorkerEvent } from "../src/kicadImport/protocol"
import { saveImported } from "../src/kicadImport/save"
import { connectAnalytics } from "../src/kicadImport/analytics"
import type { Project } from "../src/model/types"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { connectModelFiles, modelFileId, type ModelFileStore } from "../src/store/modelFiles"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { entry, fakeStorage, stubLocalStorage } from "./kicad-import-helpers"
import { importKept } from "./kicad-keep-corpus.test"

// The whole way of the user's own files: the import keeps them, the project saves them beside its file, and the export of the saved project writes them back,
// byte for byte when nothing changed and with only the change when something did.

const text = board({
  version: 20241229,
  body: [
    footprint({ ref: "R1", at: "5 5", pads: [pad({ at: "-1 0", size: "1 1" }), pad({ number: "2", at: "1 0", size: "1 1" })], extra: '(model "${KICAD9_3DMODEL_DIR}/R.step" (offset (xyz 0 0 0.3)))' }),
    footprint({ ref: "R2", at: "12 5", pads: [pad({ at: "-1 0", size: "1 1" }), pad({ number: "2", at: "1 0", size: "1 1" })] }),
  ],
})

/** A file store that keeps bytes in memory and counts what it was given. */
function memoryFiles() {
  const kept = new Map<string, { name: string; bytes: ArrayBuffer }>()
  const store: ModelFileStore = {
    async put(file) {
      const id = await modelFileId(file.bytes)
      kept.set(id, file)
      return id
    },
    async get(id) {
      return kept.get(id)?.bytes ?? null
    },
  }
  return { store, kept }
}

async function imported(): Promise<ImportOutcome> {
  const events: WorkerEvent[] = []
  await runImport({ type: "start", id: 1, files: [entry("blink.kicad_pcb", text)] }, (e) => events.push(e))
  const done = events.find((e) => e.type === "done")
  if (!done || done.type !== "done") throw new Error("the import did not finish")
  return done.outcome
}

beforeEach(() => {
  stubLocalStorage()
  connectAnalytics(null)
})

describe("the user's own files go with the project", () => {
  it("the import keeps them as one zip, says so in the report and names it in the project", async () => {
    const outcome = await imported()
    expect(outcome.project?.kicad?.original).toMatchObject({ size: expect.any(Number), name: "blink" })
    const zip = outcome.files?.find((f) => f.name === "kicad-original.zip")
    expect(zip?.id).toBe(outcome.project!.kicad!.original!.file)
    expect(outcome.summary.notes.some((n) => n.object === "Your original KiCad files are kept" && n.why === "export writes back only what you change.")).toBe(true)
    // the project file stays small: it holds the record and not the files
    expect(serializeProject(outcome.project!).length).toBeLessThan(serializeProject({ ...outcome.project!, kicad: { ...outcome.project!.kicad, original: undefined } }).length + 300)
  })

  it("saved, reopened and exported with no change, it is the original file byte for byte", async () => {
    const { store, kept } = memoryFiles()
    connectModelFiles(store)
    const { storage, created } = fakeStorage()
    await saveImported(storage, await imported())
    expect(kept.size).toBe(1)
    const reopened = parseProjectFile(created[0].content, { id: "p1", createdAt: 0, updatedAt: 0 })
    const out = await kicadFiles(reopened)
    expect(out.files["blink.kicad_pcb"]).toBe(text)
    // a board with no schematic or project file is exported as just that: no file is made up
    expect(Object.keys(out.files)).toEqual(["blink.kicad_pcb"])
    expect(new TextDecoder().decode(out.exact!["blink.kicad_pcb"])).toBe(text)
    expect(out.notes[0]).toMatch(/byte for byte/)
    const zip = await kicadZip(reopened)
    expect(zip.blob.size).toBeGreaterThan(0)
  })

  it("a project nobody changed is known to be so, without writing it; any change, or a project with no record of its content, is not", async () => {
    const { store } = memoryFiles()
    connectModelFiles(store)
    const { storage, created } = fakeStorage()
    await saveImported(storage, await imported())
    const p = parseProjectFile(created[0].content, { id: "p1", createdAt: 0, updatedAt: 0 })
    expect(p.kicad?.original?.content).toMatch(/^[0-9a-f]{64}$/)
    expect((await unchangedExport(p))?.exact?.["blink.kicad_pcb"]).toBeDefined()
    // the project's id and the time of an edit do not count; a part's place, its name and the sheet the view is on do
    expect(await unchangedExport({ ...p, id: "other", updatedAt: 5 })).not.toBeNull()
    const first = p.components.find((c) => c.ref === "R1")!
    expect(await unchangedExport({ ...p, components: p.components.map((c) => (c === first ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + 0.001 } } : c)) })).toBeNull()
    expect(await unchangedExport({ ...p, name: "renamed" })).toBeNull()
    expect(await unchangedExport({ ...p, scope: "x" } as Project)).toBeNull()
    expect(await unchangedExport({ ...p, kicad: { ...p.kicad, original: { ...p.kicad!.original!, content: undefined } } })).toBeNull()
  })

  it("after a move, only the footprint's place is written into the original", async () => {
    const { store } = memoryFiles()
    connectModelFiles(store)
    const { storage, created } = fakeStorage()
    await saveImported(storage, await imported())
    const p = parseProjectFile(created[0].content, { id: "p1", createdAt: 0, updatedAt: 0 })
    const first = p.components.find((c) => c.ref === "R1")!
    const moved = { ...p, components: p.components.map((c) => (c === first ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + 2 } } : c)) }
    const out = await kicadFiles(moved)
    const pcb = out.files["blink.kicad_pcb"]
    expect(out.kept?.find((k) => k.file === "blink.kicad_pcb")?.mode).toBe("patched")
    expect(pcb).toBe(text.replace('(at 5 5)', '(at 7 5)'))
    expect(pcb).toContain("KICAD9_3DMODEL_DIR")
    expect(Object.keys(out.files)).toEqual(["blink.kicad_pcb"])
  })

  it("a project made in the editor has no original and exports as before", async () => {
    const outcome = await imported()
    const own = { ...outcome.project!, kicad: { ...outcome.project!.kicad, original: undefined } }
    const out = await kicadFiles(own)
    expect(out.kept).toBeUndefined()
    expect(out.exact).toBeUndefined()
  })

  it("when the files are not in the account, every file is written from the project and it says so", async () => {
    const { store } = memoryFiles()
    connectModelFiles(store)
    const outcome = await imported()
    const p = { ...outcome.project!, kicad: { ...outcome.project!.kicad, original: { ...outcome.project!.kicad!.original!, file: "0".repeat(64) } } }
    const out = await kicadFiles(p)
    expect(out.notes[0]).toMatch(/not in this account's files/)
    expect(out.files["blink.kicad_pcb"]).toBeDefined()
  })
})

describe("an account that cannot hold the files", () => {
  it("still gets the project, which exports as it always did", async () => {
    connectModelFiles({ put: async () => Promise.reject(new Error("Your account already keeps 200 files.")), get: async () => null })
    const { storage, created } = fakeStorage()
    await saveImported(storage, await imported())
    const p = parseProjectFile(created[0].content, { id: "p1", createdAt: 0, updatedAt: 0 })
    expect(p.kicad?.original).toBeUndefined()
    const out = await kicadFiles(p)
    expect(out.kept).toBeUndefined()
  })
})

describe("a KiCad 8 schematic", () => {
  it("is patched, not written whole as a KiCad 9 file (which would add a symbol for each footprint it lacks)", async () => {
    const sch = ["(kicad_sch", "\t(version 20231120)", '\t(generator "eeschema")', '\t(uuid "aaaaaaaa-0000-4000-8000-0000000000ff")', '\t(paper "A4")', "\t(lib_symbols)", ")", ""].join("\n")
    const p = await importKept([
      { path: "blink.kicad_pcb", data: text },
      { path: "blink.kicad_sch", data: sch },
    ])
    expect(typeof p).toBe("object")
    const was = sch.replace("20231120", "20250114")
    const wire = '\t(wire (pts (xy 1 1) (xy 5 1)) (uuid "bbbbbbbb-0000-4000-8000-000000000001"))\n'
    const out = await keepOriginal(p as Project, { files: { "blink.kicad_sch": was.replace("\n)\n", `\n${wire})\n`), "blink.kicad_pcb": text }, notes: [] }, async () => ({ files: { "blink.kicad_sch": was, "blink.kicad_pcb": text }, notes: [] }))
    expect(out.kept?.find((k) => k.file === "blink.kicad_sch")?.mode).toBe("patched")
    expect(out.files["blink.kicad_sch"]).toBe(sch.replace("\n)\n", `\n${wire})\n`))
  })
})

describe("the user's folder", () => {
  it("comes back whole: the footprint library and 3D models in their folders, KiCad's local settings, and no backups", async () => {
    const { store } = memoryFiles()
    connectModelFiles(store)
    const step = new Uint8Array([73, 83, 79, 45, 49, 48, 51, 48, 51, 45, 50, 49, 59, 0, 255, 1])
    const events: WorkerEvent[] = []
    await runImport(
      {
        type: "start",
        id: 1,
        files: [
          entry("cube/blink.kicad_pcb", text),
          entry("cube/blink.kicad_prl", "{}"),
          entry("cube/fp-lib-table", "(fp_lib_table)"),
          entry("cube/blink.pretty/R.kicad_mod", "(footprint R)"),
          { path: "cube/3d models/R.step", file: new File([step], "R.step") },
          entry("cube/blink-backups/blink-2026-10-30.zip", "x"),
          entry("cube/~blink.kicad_pcb.lck", "x"),
        ],
      },
      (e) => events.push(e),
    )
    const done = events.find((e) => e.type === "done")
    if (!done || done.type !== "done") throw new Error("the import did not finish")
    const { storage, created } = fakeStorage()
    await saveImported(storage, done.outcome)
    const out = await kicadFiles(parseProjectFile(created[0].content, { id: "p1", createdAt: 0, updatedAt: 0 }))
    expect(Object.keys(out.files).sort()).toEqual(["3d models/R.step", "blink.kicad_pcb", "blink.kicad_prl", "blink.pretty/R.kicad_mod", "fp-lib-table"])
    expect(out.exact!["3d models/R.step"]).toEqual(step)
    expect(out.files["blink.kicad_pcb"]).toBe(text)
  })
})

describe("the user's file set", () => {
  it("goes back under the user's own names, with a sheet no sheet symbol uses", async () => {
    const own = text.replace("(at 5 5)", "(at 3 5)")
    const stray = '(kicad_sch (version 20250114) (generator "eeschema") (uuid "aaaaaaaa-0000-4000-8000-0000000000fe") (paper "A4") (lib_symbols))\n'
    const p = (await importKept([
      { path: "my_board.kicad_pcb", data: own },
      { path: "notes.kicad_sch", data: stray },
    ])) as Project
    const files = { "my-board.kicad_pcb": own }
    const out = await keepOriginal(p, { files, notes: [] }, async () => ({ files, notes: [] }))
    expect(Object.keys(out.files).sort()).toEqual(["my_board.kicad_pcb", "notes.kicad_sch"])
    expect(out.files["notes.kicad_sch"]).toBe(stray)
  })
})

describe("the export as it was before the user changed anything", () => {
  it("is kept for the last few projects, so going back to one does not write it again", async () => {
    let writes = 0
    const write = async () => {
      writes++
      return { files: { "blink.kicad_pcb": text }, notes: [] }
    }
    const a = (await importKept([{ path: "blink.kicad_pcb", data: text.replace("(at 5 5)", "(at 4 5)") }])) as Project
    const b = (await importKept([{ path: "blink.kicad_pcb", data: text.replace("(at 5 5)", "(at 6 5)") }])) as Project
    for (const p of [a, b, a, b, a]) await keepOriginal(p, { files: { "blink.kicad_pcb": text }, notes: [] }, write)
    expect(writes).toBe(2)
  })
})
