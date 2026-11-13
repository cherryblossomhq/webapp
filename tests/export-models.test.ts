import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Occt, OcctResult } from "occt-import-js"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { browserModelReader, modelLibrary } from "../src/editor/three/files/library"
import { inflateSync } from "node:zlib"
import { altiumFiles } from "../src/export/altium"
import { altiumChecksum } from "../src/export/altium/models"
import { kicadFiles } from "../src/export/kicad"
import { isKicadBoardProject } from "../src/export/kicadBoard"
import { importKicadBoard } from "../src/model/kicad/board/import"
import { KICAD_MODEL_FOLDER } from "../src/export/kicadModels"
import { placedParts } from "../src/export/placedModels"
import { stepFile } from "../src/export/step3d"
import { EXAMPLES } from "../src/model/examples"
import { setModel, supplierModel } from "../src/model/models3d"
import { connectModelFiles } from "../src/store/modelFiles"
import { connectPartModels } from "../src/store/partModels"
import type { Model3D, Project } from "../src/model/types"
import { binaryRecords, propRecords, readStreams } from "./altium/read"

// The parts' 3D models in the KiCad and Altium exports: every model is a file of the export, placed on its footprint as the 3D
// view and the STEP export place it. With KiCad installed (`KICAD_CLI`, else where its installer puts it on a Mac), KiCad's own
// STEP export of each written board is held to ours, part by part: the proof that KiCad reads the placements as we mean them.

class InPlaceStepWorker {
  private static occt: Promise<Occt> | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage({ id, bytes }: { id: number; bytes: ArrayBuffer }) {
    InPlaceStepWorker.occt ??= (createRequire(import.meta.url)("occt-import-js") as () => Promise<Occt>)()
    void InPlaceStepWorker.occt.then(async (occt) => {
      const { occtMeshes } = await import("../src/editor/three/files/meshData")
      this.onmessage?.({ data: { id, meshes: occtMeshes(occt.ReadStepFile(new Uint8Array(bytes), null)) } })
    })
  }
  terminate() {}
}
vi.stubGlobal("Worker", InPlaceStepWorker)

const require = createRequire(import.meta.url)
const CUBE = require.resolve("occt-import-js").replace(/dist[\\/]occt-import-js\.js$/, "test/testfiles/cube-10x10mm/Cube 10x10.stp")
const KICAD_CLI = process.env.KICAD_CLI ?? "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
const withKicad = existsSync(KICAD_CLI)

/** A lopsided OBJ, 4 by 6 by 2 mm off its origin, so a wrong turn or flip shows in its box. */
const BRICK_OBJ = (() => {
  const v: string[] = []
  for (const x of [1, 5]) for (const y of [0, 6]) for (const z of [0, 2]) v.push(`v ${x} ${y} ${z}`)
  const faces = ["1 2 4 3", "5 7 8 6", "1 5 6 2", "3 4 8 7", "1 3 7 5", "2 6 8 4"]
  return ["newmtl body", "Kd 0.6 0.2 0.2", "endmtl", ...v, "usemtl body", ...faces.map((f) => `f ${f}`)].join("\n")
})()

/** The OBJ a supplier ships with the cube: the same box in the same frame. */
const CUBE_OBJ = (() => {
  const v: string[] = []
  for (const x of [0, 10]) for (const y of [0, 10]) for (const z of [0, 10]) v.push(`v ${x} ${y} ${z}`)
  const faces = ["1 2 4 3", "5 7 8 6", "1 5 6 2", "3 4 8 7", "1 3 7 5", "2 6 8 4"]
  return ["newmtl body", "Kd 0.2 0.2 0.2", "endmtl", ...v, "usemtl body", ...faces.map((f) => `f ${f}`)].join("\n")
})()

const buffer = (b: Buffer | Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const cube = () => buffer(readFileSync(CUBE))

let occt: Occt
beforeAll(async () => {
  occt = await (require("occt-import-js") as () => Promise<Occt>)()
  connectPartModels({ supplier: async (_id, format) => (format === "step" ? cube() : buffer(Buffer.from(CUBE_OBJ))), kicad: async () => cube() })
  connectModelFiles({ put: async () => "", get: async (id) => (id === "brick" ? buffer(Buffer.from(BRICK_OBJ)) : cube()) })
})
afterEach(() => modelLibrary.retryFailed())

const file = (id: string, format: Model3D["format"], placement: Partial<Model3D>): Model3D => ({
  source: "file",
  id,
  name: `${id}.${format}`,
  format,
  origin: "model",
  offset: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  ...placement,
})

/**
 * The blinker with its parts turned every way and some on the bottom, each kind of model on one of them: a supplier's (centred on its
 * footprint), a STEP file placed by its own origin, turned on every axis, a mesh file centred and turned, and KiCad's library models.
 */
function turnedBoard(): Project {
  const p = structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project)
  const turns = [0, 90, 30, 180, 270, 45]
  return { ...p, components: p.components.map((c, i) => (c.pcb.placed ? { ...c, pcb: { ...c.pcb, rot: turns[i % turns.length], side: i % 3 === 2 ? "bottom" : c.pcb.side } } : c)) }
}

function testBoard(base: Project = turnedBoard()): Project {
  let p = base
  const parts = placedParts(p)
  // U1 on top; C1 on the bottom at 45 degrees; the three 0603 resistors on top at 90, 180 and 270.
  const [a, b, c] = [parts.find((x) => x.ref === "U1")!, parts.find((x) => x.ref === "C1")!, parts.find((x) => x.ref === "R1")!]
  p = setModel(p, a.partId, a.footprint, supplierModel({ id: "s".repeat(32), title: "Cube", center: { x: 0.5, y: -0.5 }, bottom: 0, rotation: { x: 0, y: 0, z: 90 } }))
  p = setModel(p, b.partId, b.footprint, file("cube", "step", { rotation: { x: 90, y: 20, z: 30 }, offset: { x: 1, y: 2, z: 0.5 } }))
  p = setModel(p, c.partId, c.footprint, file("brick", "obj", { origin: "center", rotation: { x: 0, y: 0, z: 45 }, offset: { x: -1, y: 0, z: 0 } }))
  return p
}

const run = (args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(KICAD_CLI, args, { maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(out))))

type Box = { min: number[]; max: number[] }

function boxOf(r: OcctResult, meshes: number[]): Box {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const i of meshes) {
    const p = r.meshes[i].attributes.position.array
    for (let j = 0; j < p.length; j += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], p[j + k])), (max[k] = Math.max(max[k], p[j + k]))
  }
  return { min, max }
}

/** The box of every leaf product's meshes in a STEP file, the largest (the board) first. */
function leafBoxes(r: OcctResult): Box[] {
  const out: Box[] = []
  const walk = (n: OcctResult["root"]) => {
    if (n.meshes.length) out.push(boxOf(r, n.meshes))
    n.children.forEach(walk)
  }
  walk(r.root)
  const size = (b: Box) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1])
  return out.sort((x, y) => size(y) - size(x))
}

/**
 * Whether two boxes are one, `a` moved by (dx, dy). Up the board within 0.1 mm: KiCad's STEP export makes the board as thick as its stackup
 * (1.51 mm for 1.6) and stands the parts on its copper, which moves them by less than that; a model turned or flipped wrongly is millimetres off.
 */
const sameBox = (a: Box, b: Box, dx: number, dy: number) =>
  [0, 1, 2].every((k) => {
    const tol = k === 2 ? 0.1 : 0.02
    const d = k === 0 ? dx : k === 1 ? dy : 0
    return Math.abs(a.min[k] + d - b.min[k]) < tol && Math.abs(a.max[k] + d - b.max[k]) < tol
  })

describe("3D models in the KiCad export", () => {
  it("writes every model as a file of the project and names it from its footprint", async () => {
    const p = testBoard()
    const { files, models, notes } = await kicadFiles(p, { models: { reader: browserModelReader, copyLibrary: true } })
    const board = Object.entries(files).find(([n]) => n.endsWith(".kicad_pcb"))![1]
    const named = [...board.matchAll(/\(model "\$\{KIPRJMOD\}\/([^"]+)"/g)].map((m) => m[1])
    expect(named.length).toBe(placedParts(p).length)
    expect(new Set(named)).toEqual(new Set(Object.keys(models ?? {})))
    for (const path of Object.keys(models!)) expect(path.startsWith(`${KICAD_MODEL_FOLDER}/`)).toBe(true)
    // The supplier's and the user's STEP files go in byte for byte.
    expect(Object.values(models!).some((b) => Buffer.from(b).equals(readFileSync(CUBE)))).toBe(true)
    expect(board).not.toMatch(/KICAD9_3DMODEL_DIR/)
    expect(notes.join(" ")).toMatch(/3dmodels folder/)
  })

  it("names KiCad's own models from KiCad's library unless asked to copy them", async () => {
    const p = testBoard()
    const { files, models } = await kicadFiles(p, { models: { reader: browserModelReader } })
    const board = Object.entries(files).find(([n]) => n.endsWith(".kicad_pcb"))![1]
    expect(board).toMatch(/\(model "\$\{KICAD9_3DMODEL_DIR\}\//)
    expect(Object.keys(models!)).toHaveLength(3)
    // Named or copied, a model sits the same way on its footprint (on the bottom too, which the converter turns over the other way round).
    const copied = Object.entries((await kicadFiles(p, { models: { reader: browserModelReader, copyLibrary: true } })).files).find(([n]) => n.endsWith(".kicad_pcb"))![1]
    const placement = (text: string, ref: string) => {
      const block = text.split(/\(footprint /).find((b) => b.includes(`"Reference" "${ref}"`))!
      const model = block.slice(block.indexOf("(model "))
      return ["offset", "scale", "rotate"].map((k) => model.match(new RegExp(`\\(${k} \\(xyz ([^)]*)\\)`))?.[1])
    }
    for (const ref of ["D1", "J1", "C2"]) expect(placement(board, ref), ref).toEqual(placement(copied, ref))
  })

  /** KiCad's STEP export of the board `kicadFiles` writes for `p`, held to ours part by part. */
  async function heldToKicad(p: Project) {
    const work = mkdtempSync(join(tmpdir(), "kicad-models-"))
    const { files, models } = await kicadFiles(p, { models: { reader: browserModelReader, copyLibrary: true } })
    for (const [name, content] of Object.entries({ ...files, ...models })) {
      mkdirSync(dirname(join(work, name)), { recursive: true })
      writeFileSync(join(work, name), content)
    }
    const pcb = Object.keys(files).find((n) => n.endsWith(".kicad_pcb"))!
    await run(["pcb", "export", "step", "--force", "-o", join(work, "kicad.step"), join(work, pcb)])
    const theirs = leafBoxes(occt.ReadStepFile(readFileSync(join(work, "kicad.step")), null))
    const ours = leafBoxes(occt.ReadStepFile(new TextEncoder().encode((await stepFile(p, browserModelReader)).text), null))
    expect(theirs.length).toBe(ours.length)
    // KiCad puts the board where its page has it: the boards' boxes give the move between the two.
    const dx = theirs[0].min[0] - ours[0].min[0]
    const dy = theirs[0].min[1] - ours[0].min[1]
    expect(sameBox(ours[0], theirs[0], dx, dy)).toBe(true)
    const unmatched = ours.slice(1).filter((b) => !theirs.slice(1).some((t) => sameBox(b, t, dx, dy)))
    expect(unmatched).toEqual([])
  }

  it.skipIf(!withKicad)("places every model where our STEP export does, as KiCad's STEP export reads the board", { timeout: 120_000 }, async () => {
    await heldToKicad(testBoard())
  })

  it.skipIf(!withKicad)("places them so on a board from KiCad too, which is written natively", { timeout: 120_000 }, async () => {
    // The blinker taken through KiCad: a project of a KiCad board, whose board the native writer writes.
    const { files } = await kicadFiles(turnedBoard())
    const read = importKicadBoard(Object.entries(files).find(([n]) => n.endsWith(".kicad_pcb"))![1])
    expect(read.status).toBe("imported")
    if (read.status !== "imported") return
    expect(isKicadBoardProject(read.project)).toBe(true)
    await heldToKicad(testBoard(read.project))
  })
})

describe("3D models in the Altium export", () => {
  it("embeds each model once as a zlib STEP stream and gives every part with one a body naming it", async () => {
    const p = testBoard()
    const { files, notes } = await altiumFiles(p, { models: { reader: browserModelReader } })
    const doc = Object.entries(files).find(([n]) => n.endsWith(".PcbDoc"))![1] as Uint8Array
    const streams = readStreams(doc)
    const models = propRecords(streams.get("Models/Data")!)
    expect(models.length).toBeGreaterThan(0)
    expect(new DataView(streams.get("Models/Header")!.buffer).getUint32(0, true)).toBe(models.length)
    for (const [i, m] of models.entries()) {
      expect(m.get("EMBED")).toBe("TRUE")
      const step = inflateSync(streams.get(`Models/${i}`)!)
      expect(new TextDecoder().decode(step.subarray(0, 13))).toBe("ISO-10303-21;")
      expect(Number(m.get("CHECKSUM"))).toBe(altiumChecksum(step))
    }
    // The supplier's cube goes in byte for byte.
    expect(models.some((_, i) => inflateSync(streams.get(`Models/${i}`)!).equals(readFileSync(CUBE)))).toBe(true)
    const bodies = binaryRecords(streams.get("ComponentBodies6/Data")!)
    expect(bodies.length).toBe(placedParts(p).length)
    expect(bodies.every((b) => b.type === 12)).toBe(true)
    expect(notes.join(" ")).toMatch(/embedded in the board as STEP files/)
  })

  it.skipIf(!withKicad)("places every model where our STEP export does, as KiCad reads the board", { timeout: 120_000 }, async () => {
    const p = testBoard()
    const work = mkdtempSync(join(tmpdir(), "altium-models-"))
    const { files } = await altiumFiles(p, { models: { reader: browserModelReader } })
    const name = Object.keys(files).find((n) => n.endsWith(".PcbDoc"))!
    writeFileSync(join(work, name), files[name])
    await run(["pcb", "import", "--format", "altium", "-o", join(work, "board.kicad_pcb"), join(work, name)])
    await run(["pcb", "export", "step", "--force", "-o", join(work, "kicad.step"), join(work, "board.kicad_pcb")])
    const theirs = leafBoxes(occt.ReadStepFile(readFileSync(join(work, "kicad.step")), null))
    const ours = leafBoxes(occt.ReadStepFile(new TextEncoder().encode((await stepFile(p, browserModelReader)).text), null))
    expect(theirs.length).toBe(ours.length)
    const dx = theirs[0].min[0] - ours[0].min[0]
    const dy = theirs[0].min[1] - ours[0].min[1]
    expect(sameBox(ours[0], theirs[0], dx, dy)).toBe(true)
    const unmatched = ours.slice(1).filter((b) => !theirs.slice(1).some((t) => sameBox(b, t, dx, dy)))
    if (unmatched.length) console.log(JSON.stringify({ unmatched: unmatched.map((b) => [...b.min, ...b.max].map((v) => +v.toFixed(2))), theirs: theirs.slice(1).map((b) => [b.min[0] - dx, b.min[1] - dy, b.min[2], b.max[0] - dx, b.max[1] - dy, b.max[2]].map((v) => +v.toFixed(2))) }))
    expect(unmatched).toEqual([])
  })
})
