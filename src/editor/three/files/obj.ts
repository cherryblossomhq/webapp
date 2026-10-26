import * as THREE from "three"
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js"

/** An OBJ material: the colour and how it reflects, as `newmtl` blocks give them. */
export interface ObjMaterial {
  color: [number, number, number]
  specular: [number, number, number]
  /** 0 is opaque. EasyEDA writes `d` as a transparency, the reverse of the OBJ spec's dissolve. */
  transparency: number
}

export interface ObjMesh {
  material: string
  positions: Float32Array
}

/**
 * Read an OBJ's triangles, grouped by material, and the materials it defines inline. Supplier
 * models (EasyEDA's) put their `newmtl ... endmtl` blocks in the OBJ itself and write faces as
 * `f 1// 2// 3//`, which three's OBJLoader warns on line by line. Faces are fanned into
 * triangles; normals, texture coordinates, groups and an external `mtllib` are ignored.
 */
export function readObj(text: string): { meshes: ObjMesh[]; materials: Map<string, ObjMaterial> } {
  const vertices: number[] = []
  const byMaterial = new Map<string, number[]>()
  const materials = new Map<string, ObjMaterial>()
  let current = ""
  let open: { name: string; m: ObjMaterial } | null = null
  const triples = (parts: string[]): [number, number, number] => [Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0]
  const closeMaterial = () => {
    if (open) materials.set(open.name, open.m)
    open = null
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split(/\s+/)
    const key = parts[0]
    if (key === "v") {
      vertices.push(Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0)
    } else if (key === "f") {
      const count = vertices.length / 3
      const idx: number[] = []
      for (let i = 1; i < parts.length; i++) {
        const n = parseInt(parts[i], 10)
        if (!Number.isFinite(n) || n === 0) continue
        idx.push(n > 0 ? n - 1 : count + n)
      }
      let out = byMaterial.get(current)
      if (!out) byMaterial.set(current, (out = []))
      for (let i = 1; i + 1 < idx.length; i++) {
        for (const k of [idx[0], idx[i], idx[i + 1]]) {
          if (k < 0 || k >= count) continue
          out.push(vertices[k * 3], vertices[k * 3 + 1], vertices[k * 3 + 2])
        }
        if (out.length % 9) out.length -= out.length % 9
      }
    } else if (key === "usemtl") {
      current = parts.slice(1).join(" ")
    } else if (key === "newmtl") {
      closeMaterial()
      open = { name: parts.slice(1).join(" "), m: { color: [0.6, 0.6, 0.6], specular: [0, 0, 0], transparency: 0 } }
    } else if (key === "endmtl") {
      closeMaterial()
    } else if (open && key === "Kd") {
      open.m.color = triples(parts)
    } else if (open && key === "Ks") {
      open.m.specular = triples(parts)
    } else if (open && key === "d") {
      open.m.transparency = Math.min(1, Math.max(0, Number(parts[1]) || 0))
    }
  }
  closeMaterial()
  const meshes = [...byMaterial].filter(([, p]) => p.length >= 9).map(([material, p]) => ({ material, positions: new Float32Array(p) }))
  return { meshes, materials }
}

/**
 * A model's own colours as physical materials. Supplier models say nothing about metal, so a
 * strong specular, or a pale grey or gold that shines, reads as metal (pins, shields, terminals);
 * everything else is moulded plastic or ceramic.
 */
export function objMaterial(m: ObjMaterial | undefined): THREE.MeshStandardMaterial {
  const [r, g, b] = m?.color ?? [0.6, 0.6, 0.6]
  const ks = m ? (m.specular[0] + m.specular[1] + m.specular[2]) / 3 : 0
  const bright = (r + g + b) / 3
  const metal = ks > 0.45 || (ks > 0.25 && bright > 0.55)
  const opacity = 1 - (m?.transparency ?? 0)
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
    metalness: metal ? 0.9 : 0,
    roughness: metal ? 0.32 : 0.55,
    transparent: opacity < 0.99,
    opacity,
    side: THREE.DoubleSide,
  })
}

/** Smooth across shallow bends, sharp at a model's real edges. */
export const CREASE_ANGLE = (35 * Math.PI) / 180

export function parseObj(text: string): THREE.Group {
  const { meshes, materials } = readObj(text)
  const group = new THREE.Group()
  for (const m of meshes) {
    const flat = new THREE.BufferGeometry()
    flat.setAttribute("position", new THREE.BufferAttribute(m.positions, 3))
    const geometry = toCreasedNormals(flat, CREASE_ANGLE)
    flat.dispose()
    const mesh = new THREE.Mesh(geometry, objMaterial(materials.get(m.material)))
    mesh.name = m.material
    group.add(mesh)
  }
  return group
}
