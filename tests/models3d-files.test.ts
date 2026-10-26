import type { SupplierPart } from "@cherryblossom/api-contract"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import type { Occt } from "occt-import-js"
import * as THREE from "three"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { connectSupplierParts } from "../src/ai/supplierParts"
import { ModelLibrary } from "../src/editor/three/files/library"
import { occtMeshes, meshDataGroup, looksMetallic } from "../src/editor/three/files/meshData"
import { objMaterial, parseObj, readObj } from "../src/editor/three/files/obj"
import { boundsUnder, placementMatrix } from "../src/editor/three/files/placement"
import { fileModel, modelAssignment, modelFormatOf, normalizeModels, setModel, supplierModel, withModelsFrom } from "../src/model/models3d"
import { createProject } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { landTransform, moveModel, supplierModelOn } from "../src/model/supplier/model"
import type { Model3D } from "../src/model/types"

const require = createRequire(import.meta.url)
const OCCT_FILES = require.resolve("occt-import-js").replace(/dist[\\/]occt-import-js\.js$/, "test/testfiles/")

/** A box from `min` to `max`, as twelve triangles. */
function box(min: [number, number, number], max: [number, number, number]): THREE.Group {
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial()))
  return group
}

const placedBounds = (m: Model3D, object: THREE.Group) => boundsUnder(object, placementMatrix(m, object))

describe("model files", () => {
  it("reads formats from file names", () => {
    expect(modelFormatOf("SOIC-8.STEP")).toBe("step")
    expect(modelFormatOf("part.stp")).toBe("step")
    expect(modelFormatOf("R_0603.wrl")).toBe("wrl")
    expect(modelFormatOf("thing.glb")).toBe("glb")
    expect(modelFormatOf("notes.txt")).toBeNull()
    expect(modelFormatOf("no-extension")).toBeNull()
  })

  it("reads a supplier OBJ: inline materials, faces written 1//, polygons fanned", () => {
    const text = [
      "newmtl body",
      "Ka 0.25 0.25 0.25",
      "Kd 0.25 0.25 0.25",
      "Ks 0.07 0.07 0.07",
      "d 0.0",
      "endmtl",
      "newmtl pin",
      "Kd 0.9 0.9 0.9",
      "Ks 0.88 0.88 0.88",
      "d 0",
      "endmtl",
      "v 0 0 0",
      "v 1 0 0",
      "v 1 1 0",
      "v 0 1 0",
      "v 0 0 1",
      "usemtl body",
      "f 1// 2// 3// 4//",
      "usemtl pin",
      "f 1// 2// 5//",
      "f -1// -2// -3//",
    ].join("\n")
    const { meshes, materials } = readObj(text)
    expect(meshes.map((m) => [m.material, m.positions.length / 9])).toEqual([
      ["body", 2],
      ["pin", 2],
    ])
    expect(materials.get("body")).toMatchObject({ color: [0.25, 0.25, 0.25], transparency: 0 })
    expect(objMaterial(materials.get("pin")).metalness).toBeGreaterThan(0.5)
    expect(objMaterial(materials.get("body")).metalness).toBe(0)
    const group = parseObj(text)
    expect(group.children).toHaveLength(2)
    expect((group.children[0] as THREE.Mesh).geometry.getAttribute("normal")).toBeTruthy()
  })

  it("reads metal from colour when a file says nothing about it", () => {
    expect(looksMetallic(0.8, 0.8, 0.8)).toBe(true) // a pin or shield, in linear RGB
    expect(looksMetallic(0.05, 0.05, 0.05)).toBe(false) // black moulding
    expect(looksMetallic(0.75, 0.45, 0.05)).toBe(true) // gold
    expect(looksMetallic(0.02, 0.2, 0.05)).toBe(false) // green plastic
  })
})

/** A supplier source whose model files are an OBJ triangle, or whatever `answer` says. */
const TRIANGLE = new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").buffer as ArrayBuffer
function supplierAnswering(answer: () => Promise<ArrayBuffer>) {
  connectSupplierParts({
    search: async () => ({ query: "", candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }),
    part: async () => null,
    model: answer,
  })
}

describe("the model library", () => {
  afterEach(() => connectSupplierParts(null))
  const model = supplierModel({ id: "d".repeat(32), title: "Chip", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 0 } })

  it("tries a file that failed again when it is loaded, rather than keeping the failure", async () => {
    const library = new ModelLibrary()
    let calls = 0
    supplierAnswering(async () => {
      if (++calls === 1) throw new Error("offline")
      return TRIANGLE.slice(0)
    })
    await expect(library.load(model)).rejects.toThrow("offline")
    expect(library.state(model)).toBe("failed")
    await expect(library.load(model)).resolves.toBeInstanceOf(THREE.Group)
    expect(calls).toBe(2)
  })

  it("keeps a file read from bytes in hand over an older fetch that ends later", async () => {
    const library = new ModelLibrary()
    let fail: (e: Error) => void = () => {}
    const asked = new Promise<void>((resolve) =>
      supplierAnswering(
        () =>
          new Promise<ArrayBuffer>((_, reject) => {
            fail = reject
            resolve()
          }),
      ),
    )
    library.request(model)
    await asked
    await library.prime(model, TRIANGLE.slice(0))
    fail(new Error("isn't in this account"))
    await new Promise((r) => setTimeout(r, 0))
    expect(library.state(model)).toBe("ready")
  })
})

describe("placing a model on its footprint", () => {
  it("places a file by its own origin, scaled, rotated about x then y then z, then moved", () => {
    const object = box([0, 0, 0], [2, 1, 0.5])
    const m: Model3D = { ...fileModel("a".repeat(64), "x.wrl", "wrl"), rotation: { x: 90, y: 0, z: 90 }, offset: { x: 1, y: 2, z: 3 } }
    // 2.54 per unit (KiCad's VRML), x turn first (z to -y), then z (-y to x).
    const b = placedBounds(m, object)
    expect(b.min.x).toBeCloseTo(1, 5)
    expect(b.max.x).toBeCloseTo(1 + 1.27, 5)
    expect(b.min.y).toBeCloseTo(2, 5)
    expect(b.max.y).toBeCloseTo(2 + 5.08, 5)
    expect(b.min.z).toBeCloseTo(3, 5)
    expect(b.max.z).toBeCloseTo(3 + 2.54, 5)
  })

  it("centres a supplier's model on its footprint and stands it on the board, after turning it", () => {
    // A model whose own origin is off to one side and sunk into the board, as supplier files are.
    const object = box([5, 2, -4], [15, 4, 6])
    const m = supplierModel({ id: "f".repeat(32), title: "XH", center: { x: 0, y: 0.45 }, bottom: -2.5, rotation: { x: 0, y: 0, z: 180 } })
    expect(m).toMatchObject({ source: "supplier", origin: "center", format: "step" })
    const b = placedBounds(m, object)
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(0, 6)
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(0.45, 6)
    expect(b.min.z).toBeCloseTo(-2.5, 6)
    expect(b.max.x - b.min.x).toBeCloseTo(10, 6)
  })

  it("puts a supplier model's pins on the land's holes (the XH-3A rule)", () => {
    // EasyEDA's XH-3A model has its pins at x = 0, 2.5, 5 and y = 2.7 in its own frame and is
    // turned 180°; the land's holes are at x = -2.5, 0, 2.5 on y = 0, and the outline's centre is
    // at (0, 0.45). Pins as thin posts below the board, the body above.
    const object = new THREE.Group()
    const add = (g: THREE.Group) => object.add(...g.children)
    add(box([-2.5, -0.6, 0], [7.5, 5.1, 5.2]))
    for (const x of [0, 2.5, 5]) add(box([x - 0.32, 2.7 - 0.32, -4.3], [x + 0.32, 2.7 + 0.32, 0]))
    const m = supplierModel({ id: "e".repeat(32), title: "XH2.5-3A", center: { x: 0, y: 0.45 }, bottom: -2.5, rotation: { x: 0, y: 0, z: 180 } })
    const place = placementMatrix(m, object)
    const tips = object.children.slice(1).map((pin) => {
      const b = new THREE.Box3().setFromObject(pin).applyMatrix4(place)
      return b.getCenter(new THREE.Vector3())
    })
    const holes = [-2.5, 0, 2.5]
    for (const t of tips) {
      expect(Math.min(...holes.map((x) => Math.hypot(t.x - x, t.y)))).toBeLessThan(0.01)
    }
  })
})

describe("a supplier model on another land", () => {
  const vendor = [
    { number: "1", x: -0.7, y: 0 },
    { number: "2", x: 0.7, y: 0 },
  ]

  it("finds the quarter turn and move between two lands, pad by pad", () => {
    expect(landTransform(vendor, vendor)).toEqual({ quarter: 0, dx: 0, dy: 0 })
    const turned = vendor.map((p) => ({ ...p, x: -p.y + 1, y: p.x + 2 }))
    expect(landTransform(vendor, turned)).toMatchObject({ quarter: 1, dx: 1, dy: 2 })
    const reversed = vendor.map((p) => ({ ...p, x: -p.x }))
    expect(landTransform(vendor, reversed)).toMatchObject({ quarter: 2 })
    // Another package entirely.
    expect(landTransform(vendor, [{ number: "1", x: -2, y: 0 }, { number: "2", x: 2, y: 0 }])).toBeNull()
    expect(landTransform(vendor, [{ number: "1", x: 0, y: 0 }])).toBeNull()
  })

  it("moves the model with the land it is put on", () => {
    const m = supplierModel({ id: "d".repeat(32), title: "M", center: { x: 1, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 270 } })
    const moved = moveModel(m, { quarter: 1, dx: 0.5, dy: 0 })
    expect(moved.offset).toEqual({ x: 0.5, y: 1, z: 0 })
    expect(moved.rotation.z).toBe(0)
    // Placing the moved model is the same as moving the placed one.
    const object = box([0, 0, 0], [3, 1, 1])
    const a = new THREE.Matrix4().makeTranslation(0.5, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).multiply(placementMatrix(m, object))
    const b = placementMatrix(moved, object)
    for (let i = 0; i < 16; i++) expect(b.elements[i]).toBeCloseTo(a.elements[i], 6)
  })

  it("puts a supplier's chip model on the footprinter's 0603, numbered from the other end", () => {
    const part = {
      lcsc: "C1",
      mpn: "X",
      land: { pads: [{ number: "1", shape: "rect", x: 0.75, y: 0, width: 0.8, height: 0.9, layer: "top" }, { number: "2", shape: "rect", x: -0.75, y: 0, width: 0.8, height: 0.9, layer: "top" }], silk: [], from: "C1" },
      model3d: { id: "c".repeat(32), title: "C0603", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 0 } },
      provenance: { attribution: "Drawn by someone" },
    } as unknown as SupplierPart
    const m = supplierModelOn(part, "0603")!
    expect(m).toBeTruthy()
    expect(m.rotation.z).toBe(180)
    expect(m.attribution).toBe("Drawn by someone")
    expect(supplierModelOn({ ...part, model3d: null }, "0603")).toBeNull()
    expect(supplierModelOn(part, "soic8")).toBeNull()
  })
})

describe("models in the document", () => {
  const m = fileModel("b".repeat(64), "U1.step", "step")

  it("keeps one model per part and footprint", () => {
    let p = createProject("Models")
    p = setModel(p, "ne555", "soic8", m)
    expect(modelAssignment(p, "ne555", "soic8")).toEqual(m)
    expect(modelAssignment(p, "ne555", "dip8")).toBeNull()
    p = setModel(p, "ne555", "soic8", { ...m, name: "other.step" })
    expect(p.models).toHaveLength(1)
    expect(setModel(p, "ne555", "soic8", null).models).toBeUndefined()
  })

  it("copies models with pasted parts, never over the target's own", () => {
    const source = setModel(createProject("A"), "ne555", "soic8", m)
    const target = setModel(createProject("B"), "lm358", "soic8", m)
    const pasted = withModelsFrom(target, source, [{ part: "ne555", footprint: "soic8" }])
    expect(pasted.models).toHaveLength(2)
    const mine = setModel(createProject("C"), "ne555", "soic8", { ...m, name: "mine.step" })
    expect(modelAssignment(withModelsFrom(mine, source, [{ part: "ne555", footprint: "soic8" }]), "ne555", "soic8")!.name).toBe("mine.step")
  })

  it("reads models back from a project file, dropping malformed ones", () => {
    const p = setModel(createProject("Round trip"), "ne555", "soic8", m)
    const back = parseProjectFile(serializeProject(p), { id: "x" })
    expect(back.models).toEqual(p.models)
    expect(
      normalizeModels([
        { part: "a", footprint: "f", model: m },
        { part: "b", footprint: "f", model: { ...m, id: "not-a-hash" } },
        { part: "c", footprint: "f", model: { ...m, format: "dwg" } },
        { part: "d", footprint: "f" },
        "junk",
        { part: "e", footprint: "f", model: { ...m, format: "stl", scale: 25.4, offset: { x: "1" } } },
        { part: "s", footprint: "f", model: { ...m, scale: 2 } },
      ]).map((a) => [a.part, a.model.offset, a.model.scale]),
    ).toEqual([
      ["a", { x: 0, y: 0, z: 0 }, undefined],
      ["e", { x: 0, y: 0, z: 0 }, 25.4],
      // A STEP file says its own units, so a scale on one is dropped.
      ["s", { x: 0, y: 0, z: 0 }, undefined],
    ])
  })
})

describe("STEP files, read by OpenCascade", () => {
  let occt: Occt
  beforeAll(async () => {
    occt = await (require("occt-import-js") as (m?: object) => Promise<Occt>)()
  })

  it("triangulates a STEP file into coloured meshes", () => {
    const bytes = new Uint8Array(readFileSync(`${OCCT_FILES}cax-if/as1-oc-214.stp`))
    const meshes = occtMeshes(occt.ReadStepFile(bytes, null))
    expect(meshes.length).toBeGreaterThan(5)
    for (const m of meshes) {
      expect(m.index.length % 3).toBe(0)
      expect(m.groups.reduce((s, g) => s + g.count, 0)).toBe(m.index.length)
    }
    const group = meshDataGroup(meshes)
    const b = new THREE.Box3().setFromObject(group)
    expect(b.isEmpty()).toBe(false)
    const colours = new Set(meshes.flatMap((m) => m.groups.map((g) => g.color.map((c) => c.toFixed(2)).join(","))))
    expect(colours.size).toBeGreaterThan(1)
  })

  it("refuses a file that isn't STEP", () => {
    expect(() => occtMeshes(occt.ReadStepFile(new TextEncoder().encode("not a step file"), null))).toThrow()
  })
})
