import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import type { Occt, OcctResult } from "occt-import-js"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { connectSupplierParts } from "../src/ai/supplierParts"
import { modelLibrary } from "../src/editor/three/files/library"
import * as THREE from "three"
import { approximateNote, meshesOf, stepFile } from "../src/export/step3d"
import { EXAMPLES } from "../src/model/examples"
import { placedComponents } from "../src/editor/three/buildBoard"
import { kicadModel, setModel, supplierModel } from "../src/model/models3d"
import type { Project } from "../src/model/types"

// The 3D view reads a STEP file in a Web Worker, which node has none of: here OpenCascade reads it in place.
vi.mock("../src/editor/three/files/step", async () => {
  const { occtMeshes } = await import("../src/editor/three/files/meshData")
  const load = createRequire(import.meta.url)("occt-import-js") as () => Promise<Occt>
  let ready: Promise<Occt> | null = null
  return { readStepInWorker: async (bytes: ArrayBuffer) => occtMeshes((await (ready ??= load())).ReadStepFile(new Uint8Array(bytes), null)) }
})

const require = createRequire(import.meta.url)
const CUBE = require.resolve("occt-import-js").replace(/dist[\\/]occt-import-js\.js$/, "test/testfiles/cube-10x10mm/Cube 10x10.stp")

/** The OBJ that goes with the cube STEP file: the same 10 mm box in the same frame, as a supplier ships both. */
const CUBE_OBJ = (() => {
  const v: string[] = []
  for (const x of [-5, 5]) for (const y of [0, 10]) for (const z of [-5, 5]) v.push(`v ${x} ${y} ${z}`)
  // Corners indexed x*4 + y*2 + z + 1.
  const faces = ["1 2 4 3", "5 7 8 6", "1 5 6 2", "3 4 8 7", "1 3 7 5", "2 6 8 4"]
  return ["newmtl body", "Kd 0.2 0.2 0.2", "endmtl", ...v, "usemtl body", ...faces.map((f) => `f ${f}`)].join("\n")
})()

let occt: Occt
beforeAll(async () => {
  occt = await (require("occt-import-js") as () => Promise<Occt>)()
})
afterEach(() => connectSupplierParts(null))

const read = (text: string): OcctResult => {
  const r = occt.ReadStepFile(new TextEncoder().encode(text), null)
  expect(r.success).toBe(true)
  return r
}

function bounds(r: OcctResult, meshes?: number[]) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const [i, m] of r.meshes.entries()) {
    if (meshes && !meshes.includes(i)) continue
    const p = m.attributes.position.array
    for (let j = 0; j < p.length; j += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], p[j + k])), (max[k] = Math.max(max[k], p[j + k]))
  }
  return { min, max }
}

/**
 * The assembly's instances in order, each with the meshes under it: the board, then one per placed
 * part in the project's order. OpenCascade's reader names a node after its product (the model),
 * not its instance, so designators are checked in the text.
 */
function instances(r: OcctResult) {
  const all = (n: OcctResult["root"]): number[] => [...n.meshes, ...n.children.flatMap(all)]
  return r.root.children[0].children.map((n) => ({ name: n.name, meshes: all(n) }))
}

const designated = (text: string, ref: string) => text.includes(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${ref}','${ref}'`)

const example = (id: string): Project => structuredClone(EXAMPLES.find((e) => e.id === id)!.project)

/** The note for the parts that stay generated bodies: every placed part but the ones given a model. */
const approximate = (p: Project, modelled: string[] = []) => approximateNote(placedComponents(p).map((c) => c.ref).filter((r) => !modelled.includes(r)))

describe("the STEP export", () => {
  it("writes the board and every placed part, each named by its designator", async () => {
    const p = example("blinker")
    const { text, notes } = await stepFile(p)
    // Every part here is a generated body, and the notes say so.
    expect(notes).toEqual([approximate(p)])
    const r = read(text)
    const b = bounds(r)
    const board = p.board
    expect(b.min[0]).toBeLessThanOrEqual(board.x - board.width / 2 + 1e-3)
    expect(b.max[0]).toBeGreaterThanOrEqual(board.x + board.width / 2 - 1e-3)
    // The board's bottom face is z = 0, and parts stand on its top.
    const placed = placedComponents(p)
    for (const c of placed) expect(designated(text, c.ref), c.ref).toBe(true)
    const [pcb, ...parts] = instances(r)
    expect(pcb.name).toBe("PCB")
    expect(parts).toHaveLength(placed.length)
    for (const part of parts) expect(part.meshes.length).toBeGreaterThan(0)
    const pb = bounds(r, pcb.meshes)
    expect(pb.min[2]).toBeCloseTo(0, 3)
    expect(pb.max[2]).toBeCloseTo(board.thickness, 3)
  })

  it("writes a supplier's STEP model exactly, where the 3D view draws it", async () => {
    const p0 = example("blinker")
    const u1 = p0.components.find((c) => c.ref === "U1")!
    const model = supplierModel({ id: "a".repeat(32), title: "Cube", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 0 } })
    const p = setModel(p0, u1.partId, u1.footprint, model)
    const asked: string[] = []
    connectSupplierParts({
      search: async () => ({ query: "", candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }),
      part: async () => null,
      model: async (id, format) => {
        asked.push(`${id}.${format}`)
        const bytes = format === "step" ? readFileSync(CUBE) : Buffer.from(CUBE_OBJ)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
    })
    const { text, notes } = await stepFile(p)
    expect(notes).toEqual([approximate(p, ["U1"])])
    expect(asked.sort()).toEqual([`${"a".repeat(32)}.obj`, `${"a".repeat(32)}.step`])
    const r = read(text)
    expect(designated(text, "U1")).toBe(true)
    const node = instances(r)[1 + placedComponents(p).findIndex((c) => c.ref === "U1")]
    expect(node.name).toBe("Cube")
    const b = bounds(r, node.meshes)
    // Centred on U1 and standing on the board's top face, whichever way U1 is turned.
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(u1.pcb.x, 3)
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(u1.pcb.y, 3)
    expect(b.min[2]).toBeCloseTo(p.board.thickness, 3)
    expect(b.max[2] - b.min[2]).toBeCloseTo(10, 3)
    modelLibrary.retryFailed()
  })

  it("writes one STEP file once, however many footprints place it", async () => {
    const p0 = example("blinker")
    const [a, b] = placedComponents(p0).filter((c, i, all) => all.findIndex((x) => x.partId === c.partId && x.footprint === c.footprint) === i)
    const sharing = placedComponents(p0)
      .filter((c) => [a, b].some((m) => m.partId === c.partId && m.footprint === c.footprint))
      .map((c) => c.ref)
    const cube = { id: "e".repeat(32), title: "Cube", bottom: 0, rotation: { x: 0, y: 0, z: 0 } }
    let p = setModel(p0, a.partId, a.footprint, supplierModel({ ...cube, center: { x: 0, y: 0 } }))
    p = setModel(p, b.partId, b.footprint, supplierModel({ ...cube, center: { x: 1, y: 0 } }))
    const asked: string[] = []
    connectSupplierParts({
      search: async () => ({ query: "", candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }),
      part: async () => null,
      model: async (_id, format) => {
        asked.push(format)
        const bytes = format === "step" ? readFileSync(CUBE) : Buffer.from(CUBE_OBJ)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
    })
    const { text, notes } = await stepFile(p)
    expect(notes).toEqual([approximate(p, sharing)])
    expect(asked.filter((f) => f === "step")).toHaveLength(1)
    expect(text.match(/PRODUCT\('Cube'/g)).toHaveLength(1)
    expect(designated(text, a.ref) && designated(text, b.ref)).toBe(true)
    read(text)
    modelLibrary.retryFailed()
  })

  it("keeps a model file's textured meshes, and leaves out a generated body's decals", () => {
    const group = new THREE.Group()
    const texture = new THREE.Texture()
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: texture })))
    expect(meshesOf(group)).toHaveLength(0)
    expect(meshesOf(group, undefined, true).length).toBeGreaterThan(0)
  })

  it("writes a supplier model as its mesh when its STEP file can't be fetched, and says so", async () => {
    const p0 = example("blinker")
    const u1 = p0.components.find((c) => c.ref === "U1")!
    const model = supplierModel({ id: "c".repeat(32), title: "Cube", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 0 } })
    const p = setModel(p0, u1.partId, u1.footprint, model)
    connectSupplierParts({
      search: async () => ({ query: "", candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }),
      part: async () => null,
      model: async (_id, format) => {
        if (format === "step") throw new Error("Model file limit reached.")
        const bytes = Buffer.from(CUBE_OBJ)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
    })
    const { text, notes } = await stepFile(p)
    expect(notes).toEqual(["U1: Cube's STEP file couldn't be fetched (Model file limit reached.), so it is written as its mesh.", approximate(p, ["U1"])])
    const r = read(text)
    const node = instances(r)[1 + placedComponents(p).findIndex((c) => c.ref === "U1")]
    expect(node.name).toBe("Cube")
    const b = bounds(r, node.meshes)
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(u1.pcb.x, 3)
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(u1.pcb.y, 3)
    expect(b.min[2]).toBeCloseTo(p.board.thickness, 3)
    modelLibrary.retryFailed()
  })

  it("writes a part whose model can't be read as its generated body, and says so", async () => {
    const p0 = example("blinker")
    const u1 = p0.components.find((c) => c.ref === "U1")!
    const model = supplierModel({ id: "b".repeat(32), title: "Missing", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 0 } })
    const p = setModel(p0, u1.partId, u1.footprint, model)
    connectSupplierParts({
      search: async () => ({ query: "", candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }),
      part: async () => null,
      model: async () => {
        throw new Error("The parts supplier answered 404 (model).")
      },
    })
    const { text, notes } = await stepFile(p)
    expect(notes.join(" ")).toMatch(/U1: Missing couldn't be read \(The parts supplier answered 404/)
    read(text)
    expect(designated(text, "U1")).toBe(true)
    modelLibrary.retryFailed()
  })

  it("writes a KiCad library model by asking the parts index for its STEP file, copied whole and placed by its origin", async () => {
    const p0 = example("blinker")
    const u1 = p0.components.find((c) => c.ref === "U1")!
    const id = "10.0.7/Package_DIP.3dshapes/DIP-8_W7.62mm.step"
    const kicad = { source: "kicad" as const, id, name: "DIP-8_W7.62mm", offset: { x: 0, y: 0, z: 0 }, rotate: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    const asked: string[] = []
    const host = () =>
      connectSupplierParts({
        search: async () => ({ query: "", candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }),
        part: async () => null,
        index: {
          search: async () => ({ query: "", hits: [], credits: [], fetchedAt: "" }) as never,
          part: async () => null,
          model: async (asking) => {
            asked.push(asking)
            const bytes = readFileSync(CUBE)
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          },
        },
      })
    host()
    const at = async (x: number) => {
      const p = setModel(p0, u1.partId, u1.footprint, { ...kicadModel(kicad)!, offset: { x, y: 0, z: 0 } })
      const { text, notes } = await stepFile(p)
      expect(notes).toEqual([approximate(p, ["U1"])])
      const r = read(text)
      const node = instances(r)[1 + placedComponents(p).findIndex((c) => c.ref === "U1")]
      expect(designated(text, "U1")).toBe(true)
      return bounds(r, node.meshes)
    }
    const a = await at(0)
    const b = await at(3)
    // Always the one STEP file (the view's read, then the exact copy; the second export has the read already),
    // and the offset moves it along the footprint's x.
    expect(asked).toEqual([id, id, id])
    expect(a.max[2] - a.min[2]).toBeCloseTo(10, 3)
    const turn = (u1.pcb.rot * Math.PI) / 180
    expect(b.min[0] - a.min[0]).toBeCloseTo(3 * Math.cos(turn), 3)
    modelLibrary.retryFailed()
  })

  it("writes a KiCad model the parts index can't give as its generated body, and says so", async () => {
    const p0 = example("blinker")
    const u1 = p0.components.find((c) => c.ref === "U1")!
    const kicad = { source: "kicad" as const, id: "10.0.7/Package_SO.3dshapes/Gone.step", name: "Gone", offset: { x: 0, y: 0, z: 0 }, rotate: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    const p = setModel(p0, u1.partId, u1.footprint, kicadModel(kicad)!)
    connectSupplierParts({
      search: async () => ({ query: "", candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }),
      part: async () => null,
      index: {
        search: async () => ({ query: "", hits: [], credits: [], fetchedAt: "" }) as never,
        part: async () => null,
        model: async () => {
          throw new Error("The parts index answered 404 (model).")
        },
      },
    })
    const { text, notes } = await stepFile(p)
    expect(notes[0]).toMatch(/^U1: Gone couldn't be read \(The parts index answered 404/)
    // A model that couldn't be read is a generated body too, so the last note counts it with the rest.
    expect(notes[notes.length - 1]).toBe(approximate(p))
    read(text)
    modelLibrary.retryFailed()
  })

  it("lists the approximate parts in one note, capped, with how many more", () => {
    expect(approximateNote(["R1"])).toBe("1 part is an approximate body, not its real model: R1.")
    expect(approximateNote(["R1", "R2", "U3"])).toBe("3 parts are approximate bodies, not their real models: R1, R2, U3.")
    const many = Array.from({ length: 20 }, (_, i) => `R${i + 1}`)
    expect(approximateNote(many)).toBe(`20 parts are approximate bodies, not their real models: ${many.slice(0, 12).join(", ")} and 8 more.`)
  })
})
