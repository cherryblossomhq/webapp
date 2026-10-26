import * as THREE from "three"
import type { Model3D } from "../../../model/types"
import { placementMatrix } from "./placement"

/**
 * One part's copy of a read file, placed on its footprint. Its meshes share the file's geometry
 * and materials (`userData.shared`), so disposing a board's parts must leave them alone.
 */
export function placeModel(model: Model3D, object: THREE.Group): THREE.Group {
  const group = new THREE.Group()
  group.name = model.name
  group.matrixAutoUpdate = false
  group.matrix.copy(placementMatrix(model, object))
  object.updateWorldMatrix(true, true)
  const root = object.matrixWorld.clone().invert()
  object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const copy = new THREE.Mesh(mesh.geometry, mesh.material)
    copy.matrixAutoUpdate = false
    copy.matrix.multiplyMatrices(root, mesh.matrixWorld)
    copy.castShadow = true
    copy.receiveShadow = true
    copy.userData.shared = true
    group.add(copy)
  })
  return group
}
