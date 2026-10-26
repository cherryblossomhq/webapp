/// <reference path="./occt.d.ts" />
import type { OcctResult } from "occt-import-js"
import * as THREE from "three"

/**
 * Triangles of a model file, as plain typed arrays: what the STEP worker sends back (transferred,
 * not copied) and what becomes three.js geometry. Colours are linear RGB, three's working space.
 */
export interface MeshData {
  positions: Float32Array
  normals: Float32Array | null
  index: Uint32Array
  /** Ranges of `index` (in indices) by colour. */
  groups: { start: number; count: number; color: [number, number, number] }[]
}

/** A part with no colour of its own: a neutral moulded grey. */
const UNCOLOURED: [number, number, number] = [0.32, 0.32, 0.34]

const sameColor = (a: [number, number, number], b: [number, number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-4

const rgb = (c: number[] | null | undefined): [number, number, number] | null =>
  c && c.length >= 3 && c.every((v) => Number.isFinite(v)) ? [c[0], c[1], c[2]] : null

/** OpenCascade's meshes, with each B-rep face's colour as a group (falling back to the shape's). */
export function occtMeshes(result: OcctResult): MeshData[] {
  if (!result.success) throw new Error("This STEP file couldn't be read.")
  const out: MeshData[] = []
  for (const m of result.meshes) {
    const positions = Float32Array.from(m.attributes.position.array)
    const index = Uint32Array.from(m.index.array)
    if (positions.length < 9 || index.length < 3) continue
    const normals = m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null
    const base = rgb(m.color) ?? UNCOLOURED
    const groups: MeshData["groups"] = []
    const faces = m.brep_faces?.length ? m.brep_faces : [{ first: 0, last: index.length / 3 - 1, color: null }]
    for (const f of faces) {
      const color = rgb(f.color) ?? base
      const start = f.first * 3
      const count = (f.last - f.first + 1) * 3
      if (count <= 0) continue
      const prev = groups[groups.length - 1]
      if (prev && prev.start + prev.count === start && sameColor(prev.color, color)) prev.count += count
      else groups.push({ start, count, color })
    }
    out.push({ positions, normals, index, groups })
  }
  if (!out.length) throw new Error("This STEP file has no shapes in it.")
  return out
}

/** The typed arrays to transfer to another thread. */
export const meshBuffers = (meshes: MeshData[]): ArrayBuffer[] =>
  meshes.flatMap((m) => [m.positions.buffer, m.index.buffer, ...(m.normals ? [m.normals.buffer] : [])]) as ArrayBuffer[]

/**
 * Whether a colour reads as metal. CAD files rarely say, so pale greys and whites (pins, cans,
 * shells) and golds are metal and everything else is moulded or ceramic.
 */
export function looksMetallic(r: number, g: number, b: number): boolean {
  const c = new THREE.Color(r, g, b)
  const hsl = c.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace)
  if (hsl.s < 0.12 && hsl.l > 0.62) return true
  return hsl.h > 0.08 && hsl.h < 0.16 && hsl.s > 0.35 && hsl.l > 0.4
}

/** A material for one colour of a CAD model. */
export function cadMaterial(color: [number, number, number]): THREE.MeshStandardMaterial {
  const metal = looksMetallic(...color)
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(...color),
    metalness: metal ? 0.9 : 0,
    roughness: metal ? 0.32 : 0.55,
    side: THREE.DoubleSide,
  })
}

/**
 * Mesh data as a group of meshes, one per colour: a STEP file's shapes and faces merged, so a part
 * costs a draw call per colour however many faces its file has.
 */
export function meshDataGroup(meshes: MeshData[]): THREE.Group {
  const byColor: { color: [number, number, number]; positions: number[]; normals: number[]; index: number[]; smooth: boolean }[] = []
  const bucket = (color: [number, number, number]) => {
    let b = byColor.find((x) => sameColor(x.color, color))
    if (!b) byColor.push((b = { color, positions: [], normals: [], index: [], smooth: true }))
    return b
  }
  for (const m of meshes) {
    const hasNormals = !!m.normals && m.normals.length === m.positions.length
    for (const g of m.groups) {
      const b = bucket(g.color)
      if (!hasNormals) b.smooth = false
      // Copy the vertices this range uses, renumbered from the bucket's own.
      const remap = new Map<number, number>()
      for (let i = g.start; i < g.start + g.count; i++) {
        const v = m.index[i]
        let at = remap.get(v)
        if (at === undefined) {
          at = b.positions.length / 3
          remap.set(v, at)
          b.positions.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2])
          if (hasNormals) b.normals.push(m.normals![v * 3], m.normals![v * 3 + 1], m.normals![v * 3 + 2])
        }
        b.index.push(at)
      }
    }
  }
  const group = new THREE.Group()
  for (const b of byColor) {
    if (b.index.length < 3) continue
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3))
    if (b.smooth && b.normals.length === b.positions.length) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(b.normals, 3))
    geometry.setIndex(b.positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(b.index, 1) : new THREE.Uint16BufferAttribute(b.index, 1))
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals()
    group.add(new THREE.Mesh(geometry, cadMaterial(b.color)))
  }
  return group
}
