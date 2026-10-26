import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { generatedModel } from "../src/editor/three/buildBoard"
import { ModelMaterials, makeBuilder } from "../src/editor/three/models"
import { getFootprint } from "../src/model/footprints"
import { PARTS } from "../src/model/library"
import { createProject } from "../src/model/ops"
import type { ComponentInstance } from "../src/model/types"
import signatures from "./fixtures/library-models.json"
import { bodySignature, libraryCases } from "./library-models-signature"

// Reading bodies from package names must leave the library alone: its footprint strings carry no
// package name, so every library part on every footprint draws the body it drew before.
// `fixtures/library-models.json` was written from the code before package names were read.

describe("library parts draw as they did before package names", () => {
  it("has a signature for every library part on every footprint", () => {
    expect(Object.keys(signatures).sort()).toEqual(libraryCases.map(([id, fp]) => `${id}|${fp}`).sort())
  })

  it.each(libraryCases)("%s on %s: same builder output and body size", (id, fp) => {
    expect(bodySignature(id, fp)).toEqual((signatures as Record<string, unknown>)[`${id}|${fp}`])
  })
})

// `bodySignature` calls the builder directly. The 3D view goes through `generatedModel`, which
// reads the package (`partPackage.ts`) first, so this is the same check by that path: a library
// part gets no package, and what is drawn is what the builder alone draws.
describe("the 3D view's own path draws library parts as the builder alone does", () => {
  it.each(libraryCases)("%s on %s", (id, fp) => {
    const part = PARTS.find((p) => p.id === id)!
    const def = getFootprint(fp)
    const component: ComponentInstance = { id: "c1", partId: id, ref: "U1", props: { ...part.defaultProps }, footprint: fp, sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true } }
    const mats = new ModelMaterials()
    const group = generatedModel(createProject("x"), component, mats)
    const direct = makeBuilder({ component, part, footprint: fp, pads: def.pads.filter((p) => p.plated !== false), holes: def.pads.filter((p) => p.plated === false), courtyard: def.courtyard, boardThickness: 1.6, materials: mats }).build()
    const meshes = group ? group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh) : []
    expect(meshes.map((m) => m.material)).toHaveLength(direct.geoms.size)
    const vertices = (gs: Iterable<THREE.BufferGeometry>) => [...gs].reduce((a, g) => a + g.getAttribute("position").count, 0)
    expect(vertices(meshes.map((m) => m.geometry))).toBe(vertices(direct.geoms.values()))
  })
})
