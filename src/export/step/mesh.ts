// Triangle meshes as STEP faces. Vertices are welded, flat regions merged into polygons (a box is
// six faces, not twelve), and each connected piece written as a solid when it is closed (every
// edge shared by exactly two faces) or as surfaces when it isn't. Faces are planar polygons with
// POLY_LOOP bounds, which OCCT reads as real faces: no edge curves to write, so a mesh costs
// about 175 bytes a triangle.

import { str } from "./format"
import type { StepMesh } from "./types"
import { refs, type Shape, type StepWriter } from "./writer"

/** The welding grid, per millimetre: vertices on one point of it are one. */
const GRID = 1e6
const WELD = 1 / GRID
/**
 * Neighbouring triangles are one face when every vertex is this close to its plane: the welding
 * grid, plus float32's rounding at the mesh's size (about 1e-7 of a coordinate), so a quad that
 * is flat in the source merges even far from the origin.
 */
const flatness = (p: Float64Array) => {
  let max = 0
  for (let i = 0; i < p.length; i++) max = Math.max(max, Math.abs(p[i]))
  return WELD + 2e-7 * max
}
/** ...and their normals this close (about 0.08 degrees apart). */
const FLAT_COS = 1 - 1e-6

export interface MeshFace {
  /** Vertex indices: the outer loop counter-clockwise about `normal`, then holes clockwise. */
  loops: number[][]
  normal: [number, number, number]
}

export interface MeshBody {
  faces: MeshFace[]
  /** Every edge shared by exactly two faces, consistently oriented: a solid. */
  closed: boolean
}

export interface MeshBodies {
  /** Welded vertex positions, on the welding grid. */
  positions: Float64Array
  bodies: MeshBody[]
  triangles: number
}

/** Merges vertices on the welding grid; returns the welded index of each input vertex (-1 if not finite). */
function weld(src: Float32Array): { remap: Int32Array; positions: Float64Array } {
  const n = Math.floor(src.length / 3)
  const remap = new Int32Array(n)
  const keys = new Map<string, number>()
  const out = new Float64Array(n * 3)
  let count = 0
  for (let i = 0; i < n; i++) {
    const x = src[i * 3]
    const y = src[i * 3 + 1]
    const z = src[i * 3 + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      remap[i] = -1
      continue
    }
    const ix = Math.round(x * GRID)
    const iy = Math.round(y * GRID)
    const iz = Math.round(z * GRID)
    const key = `${ix},${iy},${iz}`
    let id = keys.get(key)
    if (id === undefined) {
      id = count++
      keys.set(key, id)
      out[id * 3] = ix / GRID
      out[id * 3 + 1] = iy / GRID
      out[id * 3 + 2] = iz / GRID
    }
    remap[i] = id
  }
  return { remap, positions: out.slice(0, count * 3) }
}

/** For each half-edge (3t + k runs from corner k to corner k + 1), the other one of its edge, or -1. */
function twins(tris: Int32Array, nv: number): Int32Array {
  const m = tris.length
  const first = new Map<number, number>()
  const count = new Map<number, number>()
  const key = (h: number) => {
    const a = tris[h]
    const b = tris[h % 3 === 2 ? h - 2 : h + 1]
    return a < b ? a * nv + b : b * nv + a
  }
  for (let h = 0; h < m; h++) {
    const k = key(h)
    const c = count.get(k)
    if (c === undefined) {
      first.set(k, h)
      count.set(k, 1)
    } else {
      count.set(k, c + 1)
    }
  }
  const twin = new Int32Array(m).fill(-1)
  for (let h = 0; h < m; h++) {
    const k = key(h)
    if (count.get(k) !== 2) continue
    const f = first.get(k)!
    if (f !== h) {
      twin[h] = f
      twin[f] = h
    }
  }
  return twin
}

const nextOf = (h: number) => (h % 3 === 2 ? h - 2 : h + 1)

/** Splits a mesh into connected bodies of planar faces. */
export function meshBodies(mesh: StepMesh): MeshBodies {
  const { remap, positions: p } = weld(mesh.positions)
  const nv = p.length / 3
  const index = mesh.index
  const inputTris = Math.floor((index ? index.length : remap.length) / 3)
  const list: number[] = []
  const seen = new Set<string>()
  for (let t = 0; t < inputTris; t++) {
    const ia = index ? index[t * 3] : t * 3
    const ib = index ? index[t * 3 + 1] : t * 3 + 1
    const ic = index ? index[t * 3 + 2] : t * 3 + 2
    const a = remap[ia] ?? -1
    const b = remap[ib] ?? -1
    const c = remap[ic] ?? -1
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue
    const ux = p[b * 3] - p[a * 3]
    const uy = p[b * 3 + 1] - p[a * 3 + 1]
    const uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3]
    const vy = p[c * 3 + 1] - p[a * 3 + 1]
    const vz = p[c * 3 + 2] - p[a * 3 + 2]
    const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    const longest = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz)
    if (cross <= 1e-12 * longest) continue
    // The same triangle twice, in the same turn, is one triangle.
    const key = a < b && a < c ? `${a},${b},${c}` : b < c ? `${b},${c},${a}` : `${c},${a},${b}`
    if (seen.has(key)) continue
    seen.add(key)
    list.push(a, b, c)
  }
  const tris = Int32Array.from(list)
  const m = tris.length / 3

  // Connected pieces, each turned consistently, as the solid's outside or the mesh's majority.
  let twin = twins(tris, nv)
  const comp = new Int32Array(m).fill(-1)
  const flip = new Uint8Array(m)
  const pieces: { tris: number[]; closed: boolean }[] = []
  for (let seed = 0; seed < m; seed++) {
    if (comp[seed] >= 0) continue
    const c = pieces.length
    const members = [seed]
    comp[seed] = c
    let closed = true
    for (let q = 0; q < members.length; q++) {
      const t = members[q]
      for (let k = 0; k < 3; k++) {
        const h = t * 3 + k
        const o = twin[h]
        if (o < 0) {
          closed = false
          continue
        }
        const u = (o / 3) | 0
        const opposite = tris[h] === tris[nextOf(o)]
        const want = flip[t] ^ (opposite ? 0 : 1)
        if (comp[u] < 0) {
          comp[u] = c
          flip[u] = want
          members.push(u)
        } else if (flip[u] !== want) {
          closed = false
        }
      }
    }
    let turn = 0
    if (closed) {
      let volume = 0
      for (const t of members) {
        const [a, b, cc] = flip[t] ? [tris[t * 3], tris[t * 3 + 2], tris[t * 3 + 1]] : [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]]
        volume +=
          p[a * 3] * (p[b * 3 + 1] * p[cc * 3 + 2] - p[b * 3 + 2] * p[cc * 3 + 1]) -
          p[a * 3 + 1] * (p[b * 3] * p[cc * 3 + 2] - p[b * 3 + 2] * p[cc * 3]) +
          p[a * 3 + 2] * (p[b * 3] * p[cc * 3 + 1] - p[b * 3 + 1] * p[cc * 3])
      }
      turn = volume < 0 ? 1 : 0
    } else {
      let flipped = 0
      for (const t of members) flipped += flip[t]
      turn = flipped * 2 > members.length ? 1 : 0
    }
    for (const t of members) {
      if (flip[t] ^ turn) {
        const b = tris[t * 3 + 1]
        tris[t * 3 + 1] = tris[t * 3 + 2]
        tris[t * 3 + 2] = b
      }
    }
    pieces.push({ tris: members, closed })
  }
  twin = twins(tris, nv)

  const normal = new Float64Array(m * 3)
  const area = new Float64Array(m)
  for (let t = 0; t < m; t++) {
    const a = tris[t * 3]
    const b = tris[t * 3 + 1]
    const c = tris[t * 3 + 2]
    const ux = p[b * 3] - p[a * 3]
    const uy = p[b * 3 + 1] - p[a * 3 + 1]
    const uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3]
    const vy = p[c * 3 + 1] - p[a * 3 + 1]
    const vz = p[c * 3 + 2] - p[a * 3 + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    area[t] = l / 2
    normal[t * 3] = nx / l
    normal[t * 3 + 1] = ny / l
    normal[t * 3 + 2] = nz / l
  }

  // Flat regions, grown from the biggest triangles, every vertex checked against the seed's plane.
  const flat = flatness(p)
  const region = new Int32Array(m).fill(-1)
  const bodies: MeshBody[] = []
  for (const piece of pieces) {
    const order = piece.tris.slice().sort((s, t) => area[t] - area[s] || s - t)
    const faces: MeshFace[] = []
    for (const seed of order) {
      if (region[seed] >= 0) continue
      const id = seed
      region[seed] = id
      const nx = normal[seed * 3]
      const ny = normal[seed * 3 + 1]
      const nz = normal[seed * 3 + 2]
      const a0 = tris[seed * 3]
      const d = nx * p[a0 * 3] + ny * p[a0 * 3 + 1] + nz * p[a0 * 3 + 2]
      const members = [seed]
      for (let q = 0; q < members.length; q++) {
        const t = members[q]
        for (let k = 0; k < 3; k++) {
          const o = twin[t * 3 + k]
          if (o < 0) continue
          const u = (o / 3) | 0
          if (region[u] >= 0) continue
          if (nx * normal[u * 3] + ny * normal[u * 3 + 1] + nz * normal[u * 3 + 2] < FLAT_COS) continue
          let onPlane = true
          for (let j = 0; j < 3 && onPlane; j++) {
            const v = tris[u * 3 + j]
            onPlane = Math.abs(nx * p[v * 3] + ny * p[v * 3 + 1] + nz * p[v * 3 + 2] - d) <= flat
          }
          if (!onPlane) continue
          region[u] = id
          members.push(u)
        }
      }
      const n: [number, number, number] = [nx, ny, nz]
      const loops = members.length === 1 ? [[tris[seed * 3], tris[seed * 3 + 1], tris[seed * 3 + 2]]] : boundary(members, id)
      if (loops) {
        faces.push({ loops, normal: n })
      } else {
        for (const t of members) {
          faces.push({
            loops: [[tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]]],
            normal: [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]],
          })
        }
      }
    }
    bodies.push({ faces, closed: piece.closed })
  }

  /** A region's outline and holes, or null when they aren't simple loops (it touches itself at a vertex). */
  function boundary(members: number[], id: number): number[][] | null {
    const out = new Map<number, number>()
    for (const t of members) {
      for (let k = 0; k < 3; k++) {
        const h = t * 3 + k
        const o = twin[h]
        if (o >= 0 && region[(o / 3) | 0] === id) continue
        const from = tris[h]
        if (out.has(from)) return null
        out.set(from, tris[nextOf(h)])
      }
    }
    const loops: number[][] = []
    const used = new Set<number>()
    for (const start of out.keys()) {
      if (used.has(start)) continue
      const loop: number[] = []
      let v = start
      while (!used.has(v)) {
        used.add(v)
        loop.push(v)
        const next = out.get(v)
        if (next === undefined) return null
        v = next
      }
      if (v !== start) return null
      loops.push(loop)
    }
    const [nx, ny, nz] = [normal[members[0] * 3], normal[members[0] * 3 + 1], normal[members[0] * 3 + 2]]
    const signed = loops.map((loop) => {
      let sx = 0
      let sy = 0
      let sz = 0
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]
        const b = loop[(i + 1) % loop.length]
        sx += p[a * 3 + 1] * p[b * 3 + 2] - p[a * 3 + 2] * p[b * 3 + 1]
        sy += p[a * 3 + 2] * p[b * 3] - p[a * 3] * p[b * 3 + 2]
        sz += p[a * 3] * p[b * 3 + 1] - p[a * 3 + 1] * p[b * 3]
      }
      return sx * nx + sy * ny + sz * nz
    })
    const outer = signed.filter((s) => s > 0).length
    if (outer !== 1) return null
    const o = signed.findIndex((s) => s > 0)
    return [loops[o], ...loops.filter((_, i) => i !== o)]
  }

  dropCollinear(bodies, p, flat)
  return { positions: p, bodies, triangles: m }
}

/**
 * Takes out loop vertices that sit on a straight edge between two faces (or on an open edge of
 * one), where merging left them: both faces drop them together, so the edge stays shared.
 */
function dropCollinear(bodies: MeshBody[], p: Float64Array, flat: number): void {
  const loops = bodies.flatMap((b) => b.faces.flatMap((f) => f.loops))
  const uses = new Map<number, { loop: number; at: number }[]>()
  loops.forEach((loop, l) =>
    loop.forEach((v, at) => {
      const list = uses.get(v)
      if (list) list.push({ loop: l, at })
      else uses.set(v, [{ loop: l, at }])
    }),
  )
  const around = (u: { loop: number; at: number }) => {
    const loop = loops[u.loop]
    return [loop[(u.at + loop.length - 1) % loop.length], loop[(u.at + 1) % loop.length]]
  }
  const onLine = (a: number, v: number, b: number) => {
    const dx = p[b * 3] - p[a * 3]
    const dy = p[b * 3 + 1] - p[a * 3 + 1]
    const dz = p[b * 3 + 2] - p[a * 3 + 2]
    const l2 = dx * dx + dy * dy + dz * dz
    if (l2 === 0) return false
    const t = ((p[v * 3] - p[a * 3]) * dx + (p[v * 3 + 1] - p[a * 3 + 1]) * dy + (p[v * 3 + 2] - p[a * 3 + 2]) * dz) / l2
    if (t <= 0 || t >= 1) return false
    const ex = p[a * 3] + dx * t - p[v * 3]
    const ey = p[a * 3 + 1] + dy * t - p[v * 3 + 1]
    const ez = p[a * 3 + 2] + dz * t - p[v * 3 + 2]
    return ex * ex + ey * ey + ez * ez <= flat * flat
  }
  const drop = new Set<number>()
  for (const [v, list] of uses) {
    if (list.length > 2) continue
    const [prev, next] = around(list[0])
    if (!onLine(prev, v, next)) continue
    if (list.length === 2) {
      const [prev2, next2] = around(list[1])
      if (prev2 !== next || next2 !== prev) continue
    }
    drop.add(v)
  }
  // A loop can't go below three vertices; if one would, its vertices stay everywhere.
  for (let changed = true; changed; ) {
    changed = false
    for (const loop of loops) {
      let left = 0
      for (const v of loop) if (!drop.has(v)) left++
      if (left >= 3) continue
      for (const v of loop) if (drop.delete(v)) changed = true
    }
  }
  if (!drop.size) return
  for (const body of bodies) {
    for (const face of body.faces) face.loops = face.loops.map((loop) => loop.filter((v) => !drop.has(v)))
  }
}

export interface MeshModel {
  shape: Shape
  /** Pieces written as surfaces because they aren't closed. */
  open: number
  solids: number
}

/**
 * Writes a model made of meshes as a product: closed pieces are FACETED_BREPs, open ones
 * SHELL_BASED_SURFACE_MODELs, each styled in its mesh's colour. Null when no mesh has a triangle.
 */
export function writeMeshModel(w: StepWriter, meshes: StepMesh[], name: string): MeshModel | null {
  const items: number[] = []
  const styled: number[] = []
  let open = 0
  let solids = 0
  for (const mesh of meshes) {
    const { positions: p, bodies } = meshBodies(mesh)
    const points = new Int32Array(p.length / 3)
    const point = (v: number) => points[v] || (points[v] = w.point(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]))
    const label = str(mesh.name || name)
    for (const body of bodies) {
      if (!body.faces.length) continue
      const faces = body.faces.map((face) => {
        const bounds = face.loops.map((loop, i) => {
          const poly = w.add(`POLY_LOOP('',${refs(loop.map(point))})`)
          return w.add(`${i ? "FACE_BOUND" : "FACE_OUTER_BOUND"}('',#${poly},.T.)`)
        })
        const at = w.placement(point(face.loops[0][0]), w.dir(...face.normal), null)
        const plane = w.add(`PLANE('',#${at})`)
        return w.add(`FACE_SURFACE('',${refs(bounds)},#${plane},.T.)`)
      })
      let item: number
      if (body.closed) {
        const shell = w.add(`CLOSED_SHELL('',${refs(faces)})`)
        item = w.add(`FACETED_BREP(${label},#${shell})`)
        solids++
      } else {
        const shell = w.add(`OPEN_SHELL('',${refs(faces)})`)
        item = w.add(`SHELL_BASED_SURFACE_MODEL(${label},(#${shell}))`)
        open++
      }
      items.push(item)
      styled.push(w.style(item, mesh.color))
    }
  }
  if (!items.length) return null
  const origin = w.origin()
  const ctx = w.contexts.geometry
  // FACETED_BREP_SHAPE_REPRESENTATION allows faceted solids only; surfaces need the general one.
  const type = open ? "SHAPE_REPRESENTATION" : "FACETED_BREP_SHAPE_REPRESENTATION"
  const rep = w.add(`${type}(${str(name)},${refs([origin, ...items])},#${ctx})`)
  w.presentation(styled, ctx)
  const product = w.product(name)
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${product.shape},#${rep})`)
  return { shape: { definition: product.definition, rep, origin }, open, solids }
}
