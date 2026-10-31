import * as THREE from "three"

// What the camera frames: the board, and the parts on it or hanging off its edge (a connector, a heatsink). A part far from the board (one a
// board brought in from KiCad left at the drawing's origin, say) is drawn where it is, but not framed: framing it would put the board in a
// corner of a view zoomed out to take both in, which is what KiCad's 3D viewer does not do either.

/** The box the camera frames: the board's, with every part whose box comes within half the board's larger side of the board. */
export function frameBox(board: THREE.Object3D | null, parts: THREE.Object3D | null, rect: { x: number; y: number; width: number; height: number }): THREE.Box3 {
  const box = new THREE.Box3()
  if (board) box.expandByObject(board)
  const margin = Math.max(rect.width, rect.height) / 2
  const near = new THREE.Box3(new THREE.Vector3(rect.x - rect.width / 2 - margin, rect.y - rect.height / 2 - margin, -Infinity), new THREE.Vector3(rect.x + rect.width / 2 + margin, rect.y + rect.height / 2 + margin, Infinity))
  for (const holder of parts?.children ?? []) {
    const b = new THREE.Box3().setFromObject(holder)
    if (!b.isEmpty() && b.intersectsBox(near)) box.union(b)
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(rect.x - rect.width / 2, rect.y - rect.height / 2, -1), new THREE.Vector3(rect.x + rect.width / 2, rect.y + rect.height / 2, 1))
  return box
}
