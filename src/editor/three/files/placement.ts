import * as THREE from "three"
import type { Model3D } from "../../../model/types"

// Where a model file's points go on its footprint (`Model3D`): scaled, rotated about x, then y,
// then z, then, for a supplier's model, centred on its footprint and stood on the board, then
// moved by the offset. Millimetres in the footprint's frame, z up from the board's top surface.

const DEG = Math.PI / 180

/** Scale (the file's units, then KiCad's stretch per axis of the file) and rotation, before any move. */
export function rotationScale(model: Pick<Model3D, "rotation" | "scale" | "stretch">): THREE.Matrix4 {
  const s = model.scale && model.scale > 0 ? model.scale : 1
  const k = model.stretch ?? { x: 1, y: 1, z: 1 }
  // Euler order ZYX is Rz·Ry·Rx: x is applied first.
  const r = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG, "ZYX"))
  return r.multiply(new THREE.Matrix4().makeScale(s * k.x, s * k.y, s * k.z))
}

/** Whether a model is stretched by axis, which a STEP assembly cannot place (its transforms are rigid): it is written as its mesh. */
export const isStretched = (model: Pick<Model3D, "stretch">): boolean => !!model.stretch && (model.stretch.x !== 1 || model.stretch.y !== 1 || model.stretch.z !== 1)

/** The exact bounding box of an object's vertices under a matrix (not of its box's corners). */
export function boundsUnder(object: THREE.Object3D, matrix: THREE.Matrix4): THREE.Box3 {
  const box = new THREE.Box3()
  const v = new THREE.Vector3()
  const m = new THREE.Matrix4()
  object.updateWorldMatrix(true, true)
  const root = object.matrixWorld.clone().invert()
  object.traverse((o) => {
    const mesh = o as THREE.Mesh
    const pos = mesh.isMesh ? (mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined) : undefined
    if (!pos) return
    m.multiplyMatrices(matrix, root).multiply(mesh.matrixWorld)
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m))
  })
  return box
}

const centring = new WeakMap<THREE.Object3D, Map<string, THREE.Vector3>>()

/** The point a `center` model stands on after rotation: the middle of its footprint, at its bottom. */
function standPoint(object: THREE.Object3D, rs: THREE.Matrix4, key: string): THREE.Vector3 {
  let byKey = centring.get(object)
  if (!byKey) centring.set(object, (byKey = new Map()))
  let p = byKey.get(key)
  if (!p) {
    const b = boundsUnder(object, rs)
    p = b.isEmpty() ? new THREE.Vector3() : new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z)
    byKey.set(key, p)
  }
  return p
}

/** The model file's frame to the footprint's frame. */
export function placementMatrix(model: Model3D, object: THREE.Object3D): THREE.Matrix4 {
  const rs = rotationScale(model)
  const move = new THREE.Vector3(model.offset.x, model.offset.y, model.offset.z)
  if (model.origin === "center") {
    const key = `${model.rotation.x},${model.rotation.y},${model.rotation.z},${model.scale ?? 1},${model.stretch ? `${model.stretch.x},${model.stretch.y},${model.stretch.z}` : ""}`
    move.sub(standPoint(object, rs, key))
  }
  return new THREE.Matrix4().makeTranslation(move.x, move.y, move.z).multiply(rs)
}
