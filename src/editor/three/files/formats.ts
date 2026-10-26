import * as THREE from "three"
import type { Model3DFormat } from "../../../model/types"
import { cadMaterial, meshDataGroup, type MeshData } from "./meshData"
import { parseObj } from "./obj"
import { readStepInWorker } from "./step"

// One reader per format, each turning a file's bytes into meshes in the file's own units. The
// three.js loaders are imported when a file of their kind is first drawn.

/**
 * A mesh file's shapes baked into one frame and merged by colour, with plain colour materials
 * (CAD's look, not an old Phong shading model): KiCad's VRML models are dozens of shapes each.
 */
function byColour(object: THREE.Object3D): THREE.Group {
  object.updateWorldMatrix(true, true)
  const root = object.matrixWorld.clone().invert()
  const meshes: MeshData[] = []
  const m = new THREE.Matrix4()
  object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    m.multiplyMatrices(root, mesh.matrixWorld)
    const geometry = mesh.geometry.clone().applyMatrix4(m)
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals()
    const pos = geometry.getAttribute("position")
    const nor = geometry.getAttribute("normal")
    const positions = new Float32Array(pos.count * 3)
    const normals = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3)
      normals.set([nor.getX(i), nor.getY(i), nor.getZ(i)], i * 3)
    }
    const index = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i)
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const colour = (i: number): [number, number, number] => {
      const c = (materials[i] as THREE.MeshPhongMaterial | undefined)?.color
      return c ? [c.r, c.g, c.b] : [0.32, 0.32, 0.34]
    }
    const groups = geometry.groups.length
      ? geometry.groups.map((g) => ({ start: g.start, count: Math.min(g.count, index.length - g.start), color: colour(g.materialIndex ?? 0) }))
      : [{ start: 0, count: index.length, color: colour(0) }]
    meshes.push({ positions, normals, index, groups })
    geometry.dispose()
  })
  return meshDataGroup(meshes)
}

export async function parseModelFile(format: Model3DFormat, bytes: ArrayBuffer): Promise<THREE.Group> {
  switch (format) {
    case "step":
      return meshDataGroup(await readStepInWorker(bytes))
    case "obj":
      return parseObj(new TextDecoder().decode(bytes))
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js")
      const geometry = new STLLoader().parse(bytes)
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals()
      const group = new THREE.Group()
      group.add(new THREE.Mesh(geometry, cadMaterial([0.32, 0.32, 0.34])))
      return group
    }
    case "wrl": {
      const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js")
      return byColour(new VRMLLoader().parse(new TextDecoder().decode(bytes), ""))
    }
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js")
      const gltf = await new GLTFLoader().parseAsync(bytes, "")
      // glTF is y up and the board z up: stand it up, so an unturned model sits as it was drawn.
      gltf.scene.rotation.x = Math.PI / 2
      const group = new THREE.Group()
      group.add(gltf.scene)
      return group
    }
  }
}
