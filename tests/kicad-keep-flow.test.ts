import { beforeEach, describe, expect, it } from "vitest"
import { kicadFiles, kicadZip } from "../src/export/kicad"
import { runImport } from "../src/kicadImport/engine"
import type { ImportOutcome, WorkerEvent } from "../src/kicadImport/protocol"
import { saveImported } from "../src/kicadImport/save"
import { connectAnalytics } from "../src/kicadImport/analytics"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { connectModelFiles, modelFileId, type ModelFileStore } from "../src/store/modelFiles"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { entry, fakeStorage, stubLocalStorage } from "./kicad-import-helpers"

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
