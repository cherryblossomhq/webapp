import type { PartIndexKicadModel, PartIndexPart, SupplierModel3D } from "@cherryblossom/api-contract"
import * as THREE from "three"
import { beforeAll, describe, expect, it } from "vitest"
import { fetchModelBytes } from "../src/editor/three/files/library"
import { placementMatrix } from "../src/editor/three/files/placement"
import { connectPartModels } from "../src/store/partModels"
import { useProjectStore } from "../src/store/projectStore"
import { addDraftToProject, draftFromIndexPart } from "../src/model/indexPart"
import type { Imported } from "../src/model/kicad/library"
import { createProject } from "../src/model/ops"
import { kicadModel, modelAssignment, modelFileKey, modelOrigin, normalizeModels, setModel, supplierModel } from "../src/model/models3d"
import { getFootprint } from "../src/model/footprints"
import { supplierModelOnLand } from "../src/model/supplier/model"
import { loadImported, storedPart } from "./index-part-support"

const ID = "10.0.7/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step"
const kicad = (over: Partial<PartIndexKicadModel> = {}): PartIndexKicadModel => ({
  source: "kicad",
  id: ID,
  name: "SOIC-8_3.9x4.9mm_P1.27mm",
  offset: { x: 0, y: 0, z: 0 },
  rotate: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  ...over,
})

describe("a KiCad library model as the document keeps it", () => {
  it("is a STEP file placed by its own origin", () => {
    expect(kicadModel(kicad())).toEqual({
      source: "kicad",
      id: ID,
      name: "SOIC-8_3.9x4.9mm_P1.27mm",
      format: "step",
      origin: "model",
      offset: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      attribution: "KiCad library",
    })
    expect(modelOrigin(kicadModel(kicad())!)).toBe("KiCad library model")
    expect(modelFileKey(kicadModel(kicad())!)).toBe(`kicad:${ID}`)
  })

  it("keeps KiCad's scale as a stretch, so it is drawn at the size KiCad draws it; a scale of zero or less is left out", () => {
    expect(kicadModel(kicad({ scale: { x: 0.3937, y: 0.3937, z: 0.3937 } }))?.stretch).toEqual({ x: 0.3937, y: 0.3937, z: 0.3937 })
    expect(kicadModel(kicad({ scale: { x: 1, y: 1, z: 2 } }))?.stretch).toEqual({ x: 1, y: 1, z: 2 })
    expect(kicadModel(kicad({}))?.stretch).toBeUndefined()
    expect(kicadModel(kicad({ scale: { x: 1, y: 0, z: 1 } }))).toBeNull()
  })

  // KiCad's 3D viewer takes a model's vertices through the scale, then a turn about x by -rotate.x,
  // then about y by -rotate.y, then about z by -rotate.z, then moves them by the offset. This is
  // that, written out one matrix at a time, as the reference the editor's placement is held to.
  const kicadPlaces = (m: PartIndexKicadModel, v: THREE.Vector3) =>
    v
      .clone()
      .multiply(new THREE.Vector3(m.scale.x, m.scale.y, m.scale.z))
      .applyMatrix4(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(-m.rotate.x)))
      .applyMatrix4(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-m.rotate.y)))
      .applyMatrix4(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(-m.rotate.z)))
      .add(new THREE.Vector3(m.offset.x, m.offset.y, m.offset.z))

  const ours = (m: PartIndexKicadModel, v: THREE.Vector3) => v.clone().applyMatrix4(placementMatrix(kicadModel(m)!, new THREE.Object3D()))

  it("puts a known vertex where KiCad puts it", () => {
    // x to -x by the clockwise quarter turn about z written as 180, then up and over by the offset.
    const m = kicad({ offset: { x: 1, y: 2, z: 0.5 }, rotate: { x: 90, y: 0, z: 180 } })
    const a = ours(m, new THREE.Vector3(1, 0, 0))
    expect([a.x, a.y, a.z].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0, 2, 0.5])
    // y turned down about x by the written 90, which KiCad turns clockwise: y goes to -z, not +z.
    const b = ours(kicad({ rotate: { x: 90, y: 0, z: 0 } }), new THREE.Vector3(0, 1, 0))
    expect([b.x, b.y, b.z].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0, 0, -1])
    // A model written 90 about z turns clockwise: +x goes to -y.
    const c = ours(kicad({ rotate: { x: 0, y: 0, z: 90 } }), new THREE.Vector3(1, 0, 0))
    expect([c.x, c.y, c.z].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0, -1, 0])
  })

  it("agrees with KiCad's order of turns for any angles, not only quarter turns", () => {
    const cases = [
      { rotate: { x: 30, y: 0, z: 0 }, offset: { x: 0.1, y: 0.2, z: 0.3 } },
      { rotate: { x: -90, y: 0, z: -90 }, offset: { x: -1, y: 0, z: 0 } },
      { rotate: { x: 20, y: 70, z: 110 }, offset: { x: 2.54, y: -1.27, z: 0.8 } },
      { rotate: { x: 180, y: 45, z: -30 }, offset: { x: 0, y: 0, z: 1.6 } },
    ]
    for (const c of cases) {
      const m = kicad(c)
      for (const v of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 2, 0), new THREE.Vector3(0.3, -1.1, 2.2)]) {
        const want = kicadPlaces(m, v)
        const got = ours(m, v)
        expect(got.distanceTo(want), JSON.stringify(c)).toBeLessThan(1e-9)
      }
    }
  })
})

describe("kicad models in the document", () => {
  it("normalizeModels keeps a valid one and drops one with a bad id", () => {
    const good = kicadModel(kicad())!
    const entries = (id: string, format: string = "step") => ({ part: "p", footprint: `f-${id}`, model: { ...good, id, format } })
    const kept = normalizeModels([
      entries(ID),
      entries("10.0.7/Package_SO.3dshapes/SOIC-8.stp"),
      entries("../../etc/passwd"),
      entries("10.0.7/Package_SO.3dshapes/../x.step"),
      entries("10.0.7/Package_SO/SOIC-8.step"),
      entries("latest/Package_SO.3dshapes/SOIC-8.step"),
      entries("10.0.7/Package_SO.3dshapes/a b.step"),
      entries("10.0.7/Package_SO.3dshapes/SOIC-8.wrl"),
      entries(ID, "obj"),
    ])
    expect(kept.map((e) => e.footprint)).toEqual([`f-${ID}`, "f-10.0.7/Package_SO.3dshapes/SOIC-8.stp"])
    expect(kept[0].model).toEqual(good)
  })

  it("is fetched from the host's part models as the STEP file it is, naming the open project", async () => {
    const asked: unknown[][] = []
    const bytes = new TextEncoder().encode("ISO-10303-21;").buffer as ArrayBuffer
    connectPartModels({
      supplier: async () => Promise.reject(new Error("not the supplier's")),
      kicad: async (id, _signal, projectId) => (asked.push([id, projectId]), bytes),
    })
    const m = kicadModel(kicad())!
    expect(await fetchModelBytes(m)).toBe(bytes)
    // Someone signed out has the file only through the project shared with them by link.
    useProjectStore.setState({ project: { ...createProject(), id: "p_shared" } })
    expect(await fetchModelBytes(m)).toBe(bytes)
    useProjectStore.setState({ project: null })
    expect(asked).toEqual([
      [ID, undefined],
      [ID, "p_shared"],
    ])
    await expect(fetchModelBytes(m, "obj")).rejects.toThrow(/no obj file/)
    connectPartModels(null)
    await expect(fetchModelBytes(m)).rejects.toThrow(/aren't available/)
  })
})

describe("a database part's model when it is added to a project", () => {
  let imported: Imported
  beforeAll(async () => {
    imported = await loadImported()
  })
  const add = (part: PartIndexPart) => {
    const built = draftFromIndexPart(part)
    if ("error" in built) throw new Error(built.error)
    const added = addDraftToProject(createProject("p"), built)
    if ("error" in added) throw new Error(added.error)
    return { built, ...added }
  }

  it("gives a KiCad part its KiCad model on its footprint", () => {
    const part = { ...storedPart(imported, "Interface_USB:CH340G"), model3d: kicad({ offset: { x: 0, y: 0, z: 0.1 }, rotate: { x: 0, y: 0, z: 90 } }) }
    const { project, spec } = add(part)
    const model = modelAssignment(project, spec.id, spec.footprint)
    expect(model).toMatchObject({ source: "kicad", id: ID, format: "step", origin: "model", offset: { z: 0.1 }, rotation: { z: -90 } })
    expect(draftFromIndexPart(part)).toMatchObject({ model: { source: "kicad" } })
  })

  it("gives a part with no stored model none, and the draft says so", () => {
    const part = storedPart(imported, "Interface_USB:CH340G")
    const { project, spec, built } = add(part)
    expect(built.model).toBeNull()
    expect(modelAssignment(project, spec.id, spec.footprint)).toBeNull()
    expect(project.models).toBeUndefined()
  })

  it("gives a KiCad model with a scale that isn't 1 that scale as its stretch, and leaves out one of zero", () => {
    const part = { ...storedPart(imported, "Interface_USB:CH340G"), model3d: kicad({ scale: { x: 1, y: 1, z: 1.25 } }) }
    expect(add(part).project.models?.[0].model.stretch).toEqual({ x: 1, y: 1, z: 1.25 })
    const flat = { ...storedPart(imported, "Interface_USB:CH340G"), model3d: kicad({ scale: { x: 1, y: 1, z: 0 } }) }
    expect(add(flat).project.models).toBeUndefined()
  })

  const cube: SupplierModel3D = { id: "a".repeat(32), title: "CH340G", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 90 } }

  it("gives an EasyEDA part the supplier's model, on the stored land", () => {
    const part = { ...storedPart(imported, "Interface_USB:CH340G"), source: "easyeda" as const, model3d: { source: "easyeda" as const, model: cube } }
    const { project, spec } = add(part)
    expect(modelAssignment(project, spec.id, spec.footprint)).toEqual(supplierModel(cube, part.provenance.attribution))
  })

  it("moves the supplier's model with its land when the land was swapped for the footprinter's", () => {
    // A resistor whose pads are the footprinter's 0603, numbered from the other end: the land is
    // swapped for `0603`, and the model follows the pads by a half turn.
    const pads = getFootprint("0603").pads.map((p) => ({ number: p.pin === "1" ? "2" : "1", shape: "rect" as const, x: p.x, y: p.y, width: p.width, height: p.height, layer: "top" as const }))
    const land = { pads, silk: [], from: "C1" }
    const base = storedPart(imported, "Interface_USB:CH340G")
    const part: PartIndexPart = { ...base, package: "0603", land, pins: [{ ...base.pins[0], number: "1" }, { ...base.pins[1], number: "2" }], model3d: { source: "easyeda", model: cube } }
    const { built, project, spec } = add(part)
    expect(built.land).toBeNull()
    expect(spec.footprint).toBe("0603")
    expect(modelAssignment(project, spec.id, "0603")).toEqual(supplierModelOnLand(cube, land, part.provenance.attribution, "0603"))
    expect(modelAssignment(project, spec.id, "0603")?.rotation.z).toBe(270)
    // A model on a land the footprint's pads don't match is no model rather than a wrong one.
    expect(supplierModelOnLand(cube, { ...land, pads: land.pads.slice(0, 1) }, undefined, "0603")).toBeNull()
  })

  it("keeps a model the user already chose on that footprint", () => {
    const part = { ...storedPart(imported, "Interface_USB:CH340G"), model3d: kicad() }
    const first = add(part)
    const mine = { ...kicadModel(kicad())!, offset: { x: 5, y: 0, z: 0 } }
    const chosen = setModel(first.project, first.spec.id, first.spec.footprint, mine)
    const again = addDraftToProject(chosen, first.built)
    if ("error" in again) throw new Error(again.error)
    expect(again.added).toBe(false)
    expect(modelAssignment(again.project, first.spec.id, first.spec.footprint)).toEqual(mine)
  })
})
