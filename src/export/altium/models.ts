import * as THREE from "three"
import { modelFileKey } from "../../model/models3d"
import type { ComponentInstance, Project } from "../../model/types"
import { componentMatrix, modelFileStem, readPlacedModels, type ModelProgress, type ModelReader } from "../placedModels"
import { writeStepModel } from "../step"
import { guid } from "./records"

// The parts' 3D models embedded in the `.PcbDoc`, as Altium keeps a model it was given: the `Models` storage holds each STEP file once, zlib
// compressed in a stream of its own (`0`, `1`...) and named in its `Data` (id, name, checksum), and each part has a body in `ComponentBodies6` that
// names the model by its id and says where it sits on the board. Altium has no KiCad library, so every model is embedded, KiCad's own included;
// a mesh file is written as a STEP file placed on its footprint, since Altium takes STEP models. The layouts are those KiCad's Altium importer
// reads (`ParseModelsData`, `ACOMPONENTBODY6`) and AltiumSharp writes (Apache 2.0).

export interface AltiumModelOptions {
  /** How model files are read: the page's or a server's. */
  reader: ModelReader
  onProgress?: (p: ModelProgress) => void
  signal?: AbortSignal
}

/** A STEP file in the board's `Models` storage. */
export interface AltiumModel {
  /** Its GUID, which a body names it by. */
  id: string
  /** Its file name, `.step`, which KiCad's importer embeds it as. */
  name: string
  /** Altium's checksum of the uncompressed file (`altiumChecksum`), as the signed 32-bit number it writes. */
  checksum: number
  /** The file, zlib compressed. */
  data: Uint8Array
}

export interface AltiumModels {
  /** In the order of their streams. */
  models: AltiumModel[]
  /** Each part's model and where it sits on its footprint (the editor's frame), by component id; its box there when its meshes were read. */
  bodies: Map<string, { model: AltiumModel; matrix: THREE.Matrix4; box: THREE.Box3 | null }>
  notes: string[]
}

/** Altium's checksum of a model file: each byte times its position (the first byte once), summed in 32 bits (AltiumSharp's `ComputeChecksum`). */
export function altiumChecksum(bytes: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * (i === 0 ? 1 : i)) >>> 0
  return sum | 0
}

/** zlib (RFC 1950), which Altium's model streams are: `CompressionStream`'s "deflate", in the browser and in Node alike. */
export async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Read the placed parts' models and make each a STEP file of the board's. */
export async function altiumModels(project: Project, options: AltiumModelOptions): Promise<AltiumModels> {
  const found = await readPlacedModels(project, options.reader, { onProgress: options.onProgress, signal: options.signal, dropsPart: false })
  const notes = [...found.notes]
  const models: AltiumModel[] = []
  const byFile = new Map<string, AltiumModel | null>()
  const taken = new Set<string>()
  const encoder = new TextEncoder()
  const add = async (fileKey: string, stem: string, bytes: Uint8Array) => {
    let name = `${stem}.step`
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem}_${i}.step`
    taken.add(name.toLowerCase())
    const model = { id: guid(`model:${fileKey}`), name, checksum: altiumChecksum(bytes), data: await zlib(bytes) }
    models.push(model)
    return model
  }
  const bodies: AltiumModels["bodies"] = new Map()
  for (const [cid, key] of found.of) {
    const file = found.files.get(key)!
    // One file however many footprints place it; a mesh is written once per placement, already on its footprint.
    const fileKey = file.shape.kind === "step" ? `step:${modelFileKey(file.model)}` : `mesh:${key}`
    let model = byFile.get(fileKey)
    if (model === undefined) {
      const stem = modelFileStem(file.model, "model")
      if (file.shape.kind === "step") model = await add(fileKey, stem, file.shape.bytes)
      else {
        const text = writeStepModel(stem, file.shape.meshes)
        model = text ? await add(fileKey, stem, encoder.encode(text)) : null
        if (!text) notes.push(`${file.model.name} has no triangles, so it is not written.`)
      }
      byFile.set(fileKey, model)
    }
    if (model) bodies.set(cid, { model, matrix: file.shape.kind === "step" ? file.shape.matrix : new THREE.Matrix4(), box: file.box })
  }
  return { models, bodies, notes }
}

const deg = (r: number) => {
  const d = Math.round(THREE.MathUtils.radToDeg(r) * 1000) / 1000
  return Object.is(d, -0) ? 0 : d
}

/**
 * Where a part's body puts its model, in the board's frame (mm, y up), as KiCad's Altium importer reads a body: `MODEL.2D.X` and `Y` are where the
 * model's origin is on the board, `MODEL.3D.DZ` how far it is from the part's side of the board, and `MODEL.3D.ROTX`, `ROTY` and `ROTZ` the turns
 * about x, then y, then z. On the top they turn the model on the board; on the bottom (`BODYPROJECTION` 1) they turn it on the part's footprint as
 * the footprint is turned over (about its x axis, a half turn from the editor's), less the part's own turn.
 */
export function bodyPlacement(project: Project, c: ComponentInstance, matrix: THREE.Matrix4): { x: number; y: number; dz: number; rotation: { x: number; y: number; z: number }; projection: 0 | 1 } {
  const world = componentMatrix(project, c).multiply(matrix)
  const at = new THREE.Vector3().setFromMatrixPosition(world)
  const bottom = c.pcb.side === "bottom"
  const turns = bottom ? new THREE.Matrix4().makeRotationZ(Math.PI - THREE.MathUtils.degToRad(c.pcb.rot)).multiply(matrix) : world
  const e = new THREE.Euler().setFromRotationMatrix(turns, "ZYX")
  const dz = bottom ? new THREE.Vector3().setFromMatrixPosition(matrix).z : at.z - project.board.thickness
  return { x: at.x, y: at.y, dz, rotation: { x: deg(e.x), y: deg(e.y), z: deg(e.z) }, projection: bottom ? 1 : 0 }
}
