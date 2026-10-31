import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { frameBox } from "../src/editor/three/framing"

// What the 3D view's camera frames: the board and the parts near it, never a part left far from it.

const box = (x: number, y: number, size: number, z = 1) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, z))
  const holder = new THREE.Group()
  holder.position.set(x, y, 0)
  holder.add(m)
  return holder
}

describe("the box the 3D view frames", () => {
  // a 38 mm board at (150, -100), as moteus c1's is, far from the drawing's origin
  const rect = { x: 150, y: -100, width: 38, height: 38 }
  const board = box(150, -100, 38, 1.6)

  it("is the board with the parts on it and hanging off its edge, not a part left at the origin", () => {
    const parts = new THREE.Group()
    parts.add(box(150, -100, 5, 3), box(172, -100, 10, 4), box(0, 0, 2, 2))
    const b = frameBox(board, parts, rect)
    expect(b.min.x).toBeCloseTo(131)
    expect(b.max.x).toBeCloseTo(177)
    expect(b.max.y).toBeCloseTo(-81)
    expect(b.max.z).toBeCloseTo(2)
  })

  it("is the board's rectangle when nothing is built yet", () => {
    const b = frameBox(null, null, rect)
    expect([b.min.x, b.max.x, b.min.y, b.max.y]).toEqual([131, 169, -119, -81])
  })
})
