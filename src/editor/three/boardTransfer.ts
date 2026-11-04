import * as THREE from "three"
import type { ZoneFill } from "../../model/pour"
import type { CopperLayer } from "../../model/types"
import type { BoardPicture } from "./boardTextures"
import type { BoardShapes } from "./buildBoard"

// What goes to the 3D board's worker (`boardBuild.worker.ts`) and back: the outer layers' fills as flat arrays, and the board's geometry and
// drawings as arrays and bitmaps, all moved rather than copied.

export interface BoardBuildRequest {
  job: number
  /** The project as the other workers read it (`projectFileOf`). */
  file: string
  fills: PackedFills
}

export type BoardBuildReply = { job: number; shapes: BoardShapesData } | { job: number; error: string }

/**
 * The fills of the outer layers, the ones the 3D board shows, as flat arrays: per fill its layer and polygons, per polygon its rings, per ring its
 * points, and the points' x and y. As objects, a big board's millions of points took the page's thread a second to copy.
 */
export interface PackedFills {
  layers: CopperLayer[]
  polygons: Uint32Array
  rings: Uint32Array
  points: Uint32Array
  xy: Float64Array
}

export function packFills(fills: readonly ZoneFill[]): PackedFills {
  const outer = fills.filter((f) => f.layer === "top" || f.layer === "bottom")
  let polygons = 0
  let rings = 0
  let points = 0
  for (const f of outer) {
    polygons += f.polygons.length
    for (const poly of f.polygons) {
      rings += poly.length
      for (const ring of poly) points += ring.length
    }
  }
  const out: PackedFills = { layers: outer.map((f) => f.layer), polygons: new Uint32Array(outer.length), rings: new Uint32Array(polygons), points: new Uint32Array(rings), xy: new Float64Array(points * 2) }
  let j = 0
  let k = 0
  let n = 0
  outer.forEach((f, i) => {
    out.polygons[i] = f.polygons.length
    for (const poly of f.polygons) {
      out.rings[j++] = poly.length
      for (const ring of poly) {
        out.points[k++] = ring.length
        for (const q of ring) {
          out.xy[n++] = q.x
          out.xy[n++] = q.y
        }
      }
    }
  })
  return out
}

/** Packed fills as the fills the board's drawing reads (their layer and polygons). */
export function unpackFills(packed: PackedFills): ZoneFill[] {
  let j = 0
  let k = 0
  let n = 0
  const ring = () => Array.from({ length: packed.points[k++] }, () => ({ x: packed.xy[n++], y: packed.xy[n++] }))
  const polygon = () => Array.from({ length: packed.rings[j++] }, ring)
  return packed.layers.map((layer, i) => ({ zoneId: "", netId: null, netName: "", layer, polygons: Array.from({ length: packed.polygons[i] }, polygon) }))
}

/** A geometry's attributes, index and groups as arrays. */
export interface GeometryData {
  attributes: Record<string, { array: Float32Array; itemSize: number }>
  index: Uint16Array | Uint32Array | null
  groups: { start: number; count: number; materialIndex?: number }[]
}

export interface BoardShapesData {
  substrate: GeometryData
  top: GeometryData
  bottom: GeometryData
  copper: GeometryData | null
  barrels: GeometryData | null
  tents: GeometryData | null
  sides: { top: { albedo: ImageBitmap; surface: ImageBitmap }; bottom: { albedo: ImageBitmap; surface: ImageBitmap } }
  drills: ImageBitmap | null
  placedCount: number
}

const geometryData = (g: THREE.BufferGeometry): GeometryData => ({
  attributes: Object.fromEntries(Object.entries(g.attributes).map(([name, a]) => [name, { array: a.array as Float32Array, itemSize: a.itemSize }])),
  index: (g.index?.array as Uint16Array | Uint32Array | undefined) ?? null,
  groups: g.groups,
})

function geometryFrom(d: GeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  for (const [name, a] of Object.entries(d.attributes)) g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize))
  if (d.index) g.setIndex(new THREE.BufferAttribute(d.index, 1))
  for (const group of d.groups) g.addGroup(group.start, group.count, group.materialIndex)
  return g
}

/** Shapes made in the worker as data to send, with what is moved rather than copied; `bitmap` turns each drawing into a bitmap. */
export async function shapesData(shapes: BoardShapes, bitmap: (picture: BoardPicture) => Promise<ImageBitmap>): Promise<{ data: BoardShapesData; moved: Transferable[] }> {
  const geometry = (g: THREE.BufferGeometry | null) => (g ? geometryData(g) : null)
  const side = async (s: BoardShapes["sides"]["top"]) => ({ albedo: await bitmap(s.albedo), surface: await bitmap(s.surface) })
  const data: BoardShapesData = {
    substrate: geometryData(shapes.substrate),
    top: geometryData(shapes.top),
    bottom: geometryData(shapes.bottom),
    copper: geometry(shapes.copper),
    barrels: geometry(shapes.barrels),
    tents: geometry(shapes.tents),
    sides: { top: await side(shapes.sides.top), bottom: await side(shapes.sides.bottom) },
    drills: shapes.drills ? await bitmap(shapes.drills) : null,
    placedCount: shapes.placedCount,
  }
  const buffers = new Set<ArrayBufferLike>()
  for (const g of [data.substrate, data.top, data.bottom, data.copper, data.barrels, data.tents]) {
    if (!g) continue
    for (const a of Object.values(g.attributes)) buffers.add(a.array.buffer)
    if (g.index) buffers.add(g.index.buffer)
  }
  const bitmaps = [data.sides.top.albedo, data.sides.top.surface, data.sides.bottom.albedo, data.sides.bottom.surface, ...(data.drills ? [data.drills] : [])]
  return { data, moved: [...(buffers as Set<ArrayBuffer>), ...bitmaps] }
}

/** The worker's shapes on the page. */
export function shapesFrom(d: BoardShapesData): BoardShapes {
  const geometry = (g: GeometryData | null) => (g ? geometryFrom(g) : null)
  return {
    substrate: geometryFrom(d.substrate),
    top: geometryFrom(d.top),
    bottom: geometryFrom(d.bottom),
    copper: geometry(d.copper),
    barrels: geometry(d.barrels),
    tents: geometry(d.tents),
    sides: d.sides,
    drills: d.drills,
    placedCount: d.placedCount,
  }
}

/** Free shapes that are not shown: a later build replaced them, or the scene is gone. */
export function disposeShapes(shapes: BoardShapes) {
  for (const g of [shapes.substrate, shapes.top, shapes.bottom, shapes.copper, shapes.barrels, shapes.tents]) g?.dispose()
  for (const p of [shapes.sides.top.albedo, shapes.sides.top.surface, shapes.sides.bottom.albedo, shapes.sides.bottom.surface, shapes.drills]) {
    if (typeof ImageBitmap !== "undefined" && p instanceof ImageBitmap) p.close()
  }
}
