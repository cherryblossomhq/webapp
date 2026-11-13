import * as THREE from "three"
import { isStretched } from "../editor/three/files/placement"
import { modelFileKey } from "../model/models3d"
import type { Model3D, Project } from "../model/types"
import { modelFileStem, readPlacedModels, rigidAngles, type ModelProgress, type ModelReader } from "./placedModels"
import { writeStepModel } from "./step"

// The parts' 3D models as files of the KiCad project (`3dmodels/` beside the board), each footprint naming its own by
// `${KIPRJMOD}`, which KiCad resolves to the project's folder: the supplier's models, the files the user added, and, when
// asked, KiCad's own library models too, which are otherwise named in KiCad's library (`${KICAD9_3DMODEL_DIR}`), where an
// installed KiCad has them. A STEP file goes in as it is, placed on its footprint by the footprint's `(model ...)` offset and
// rotation; a mesh file (OBJ, STL, GLB, VRML) is written as a STEP file already placed on its footprint, since KiCad reads
// STEP and VRML only and its STEP export only STEP.

/** The folder of the project the model files are in. */
export const KICAD_MODEL_FOLDER = "3dmodels"

export interface KicadModelOptions {
  /** How model files are read: the page's or a server's. */
  reader: ModelReader
  /** Copy KiCad's own library models into the project too, so it shows them where KiCad's 3D library isn't installed. */
  copyLibrary?: boolean
  onProgress?: (p: ModelProgress) => void
  signal?: AbortSignal
}

export interface CarriedModels {
  /** Each part whose model is a file of the project: the file, and where it sits on the footprint in the editor's frame, by component id. */
  placed: Map<string, { path: string; matrix: THREE.Matrix4 }>
  /** The files they name, by path in the project's folder. */
  files: Map<string, Uint8Array>
  notes: string[]
}

const mm6 = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6
  return String(Object.is(r, -0) ? 0 : r)
}
const flip = (v: number) => (v === 0 ? 0 : -v)

/** A footprint's `(model ...)` lines for a file of the project placed on it by a rigid matrix: KiCad turns a model clockwise by the written angles, so they are negated. */
export function projectModelLines(path: string, matrix: THREE.Matrix4): string[] {
  const { rotation, offset } = rigidAngles(matrix)
  return [
    `(model "\${KIPRJMOD}/${path}"`,
    `  (offset (xyz ${mm6(offset.x)} ${mm6(offset.y)} ${mm6(offset.z)}))`,
    "  (scale (xyz 1 1 1))",
    `  (rotate (xyz ${mm6(flip(rotation.x))} ${mm6(flip(rotation.y))} ${mm6(flip(rotation.z))}))`,
    ")",
  ]
}

/**
 * Read the placed parts' models and make them files of the project. A KiCad library model stays named in KiCad's library unless
 * `copyLibrary`, and one KiCad stretches always does (KiCad's own scale places it there exactly).
 */
export async function carriedKicadModels(project: Project, options: KicadModelOptions): Promise<CarriedModels> {
  const named = (m: Model3D) => m.source === "kicad" && (!options.copyLibrary || isStretched(m))
  const found = await readPlacedModels(project, options.reader, { skip: named, onProgress: options.onProgress, signal: options.signal, dropsPart: false })
  const files = new Map<string, Uint8Array>()
  const taken = new Set<string>()
  const pathOf = new Map<string, string>()
  const encoder = new TextEncoder()
  const nameFor = (m: Model3D) => {
    const stem = modelFileStem(m, "model")
    let name = `${stem}.step`
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem}_${i}.step`
    taken.add(name.toLowerCase())
    return `${KICAD_MODEL_FOLDER}/${name}`
  }
  const notes = [...found.notes]
  const placed = new Map<string, { path: string; matrix: THREE.Matrix4 }>()
  const meshPaths = new Map<string, string | null>()
  for (const [cid, key] of found.of) {
    const file = found.files.get(key)!
    if (file.shape.kind === "step") {
      // One file however many footprints place it: the placement is each footprint's own.
      const fileKey = `step:${modelFileKey(file.model)}`
      let path = pathOf.get(fileKey)
      if (!path) {
        path = nameFor(file.model)
        pathOf.set(fileKey, path)
        files.set(path, file.shape.bytes)
      }
      placed.set(cid, { path, matrix: file.shape.matrix })
      continue
    }
    let path = meshPaths.get(key)
    if (path === undefined) {
      path = nameFor(file.model)
      const text = writeStepModel(path.slice(KICAD_MODEL_FOLDER.length + 1, -5), file.shape.meshes)
      if (text) files.set(path, encoder.encode(text))
      else {
        notes.push(`${file.model.name} has no triangles, so it is not written.`)
        path = null
      }
      meshPaths.set(key, path)
    }
    // A mesh is written already placed on its footprint.
    if (path) placed.set(cid, { path, matrix: new THREE.Matrix4() })
  }
  return { placed, files, notes }
}

/**
 * A footprint on the bottom as the KiCad converter writes it is turned over about its x axis at the editor's angle, where the editor turns a part over
 * about its y axis (its pads mirrored left to right): the two differ by a half turn about z, which a model's placement on the footprint takes up. The
 * native board writer turns the footprint itself instead (its angle less half a turn, `kicadBoard.ts`), and needs none of this.
 */
export const HALF_TURN = new THREE.Matrix4().makeRotationZ(Math.PI)

/** The `(model ...)` lines of a carried model, half turned for a bottom footprint of the converter's (`HALF_TURN`). */
export const carriedModelLines = (entry: { path: string; matrix: THREE.Matrix4 }, halfTurn = false): string[] =>
  projectModelLines(entry.path, halfTurn ? HALF_TURN.clone().multiply(entry.matrix) : entry.matrix)

/** A model of KiCad's library placed by its own origin, half turned about z (`HALF_TURN`): the outermost turn and the offset take it. */
export function halfTurned(model: Model3D): Model3D {
  const z = model.rotation.z + 180
  return { ...model, offset: { x: -model.offset.x || 0, y: -model.offset.y || 0, z: model.offset.z }, rotation: { ...model.rotation, z: z > 180 ? z - 360 : z } }
}
