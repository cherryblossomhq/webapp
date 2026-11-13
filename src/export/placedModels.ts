import * as THREE from "three"
import { naturalCompare } from "../lib/natural"
import { boundsUnder, isStretched, placementMatrix } from "../editor/three/files/placement"
import { componentModel, modelFileKey } from "../model/models3d"
import { onBoard } from "../model/partFlags"
import { resolvedComponents } from "../model/ruleAreas"
import type { ComponentInstance, Model3D, Model3DFormat, Project } from "../model/types"
import type { StepColor, StepMesh } from "./step"

// The 3D model of every placed part, read once for an export that carries them: the STEP assembly,
// the KiCad project and the Altium project. Each distinct model is read once however many parts
// use it. A part whose model has a STEP file (a supplier's, KiCad's, or one the user added) gets
// that file's exact bytes and where they sit on its footprint; one with a mesh file (or a model
// KiCad stretches, or a STEP file that couldn't be fetched) gets the mesh, already placed on its
// footprint. A part with no model, or whose model can't be read, gets nothing, and the notes say so.
//
// The files are reached through a `ModelReader`: the page's (`browserModelReader` in
// `editor/three/files/library.ts`) or a server's (`mcp/exportFiles.ts`), so this module imports
// nothing a server can't load.

/** How an export reaches model files. Each rejects with a sentence for the user. */
export interface ModelReader {
  /** A model file's meshes in its own frame, as the 3D view reads them: a supplier model's from its mesh. */
  meshes(m: Model3D, signal?: AbortSignal): Promise<THREE.Group>
  /** A model file's bytes in a format: a supplier's or KiCad's STEP, or the user's file as it was added. */
  bytes(m: Model3D, format: Model3DFormat, signal?: AbortSignal): Promise<ArrayBuffer>
}

/** A model as an export writes it. */
export interface ModelFile {
  /** One per distinct model as placed on its footprint. */
  key: string
  model: Model3D
  /**
   * `step`: the exact file's bytes, placed on the footprint by `matrix` (rotation and move only), with the meshes in the file's own frame to
   * use if the file can't be embedded. `mesh`: its triangles, already placed on the footprint.
   */
  shape: { kind: "step"; bytes: Uint8Array; matrix: THREE.Matrix4; fallback?: StepMesh[] } | { kind: "mesh"; meshes: StepMesh[] }
  /** The model's box in the footprint's frame, when its meshes were read. */
  box: THREE.Box3 | null
}

export interface PlacedModels {
  /** By key. */
  files: Map<string, ModelFile>
  /** The model of each part that has one that was read, as its key, by component id. */
  of: Map<string, string>
  /** Designators of the parts that have no model at all. */
  missing: string[]
  /** What didn't come across, in sentences: models that couldn't be read and STEP files written as meshes. */
  notes: string[]
}

export interface ModelProgress {
  done: number
  total: number
}

export interface ReadModelsOptions {
  /** The parts to read, by default every part on the board. */
  components?: ComponentInstance[]
  /** Models the export names rather than carries (KiCad's own library, for a KiCad project): not read, and not counted as missing. */
  skip?: (m: Model3D) => boolean
  onProgress?: (p: ModelProgress) => void
  signal?: AbortSignal
  /** Whether a part whose model can't be read is left out of the export (a STEP assembly) or only its model is (KiCad, Altium). Left out by default. */
  dropsPart?: boolean
}

/** The parts on the board, which an export with 3D models draws. */
export const placedParts = (project: Project): ComponentInstance[] => resolvedComponents(project).filter((c) => c.pcb.placed && onBoard(c))

const srgb = (c: THREE.Color): StepColor => {
  const out = { r: 0, g: 0, b: 0 }
  c.getRGB(out, THREE.SRGBColorSpace)
  return out
}

/** A model file's triangles in one frame, by material colour: a textured mesh is its texture's part too. */
export function meshesOf(object: THREE.Object3D, frame: THREE.Matrix4 = new THREE.Matrix4()): StepMesh[] {
  object.updateWorldMatrix(true, true)
  const root = object.matrixWorld.clone().invert()
  const out: StepMesh[] = []
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible) return
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined
    if (!pos) return
    m.multiplyMatrices(frame, root).multiply(mesh.matrixWorld)
    const index = mesh.geometry.getIndex()
    const vertex = (i: number) => (index ? index.getX(i) : i)
    const total = index ? index.count : pos.count
    const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: total, materialIndex: 0 }]
    for (const g of groups) {
      const material = materials[g.materialIndex ?? 0] ?? materials[0]
      if (!material) continue
      const end = Math.min(total, g.start + g.count)
      const positions = new Float32Array((end - g.start) * 3)
      for (let i = g.start, k = 0; i < end; i++, k += 3) {
        v.fromBufferAttribute(pos, vertex(i)).applyMatrix4(m)
        positions[k] = v.x
        positions[k + 1] = v.y
        positions[k + 2] = v.z
      }
      if (positions.length >= 9) out.push({ positions, color: srgb(material.color ?? new THREE.Color(0.5, 0.5, 0.5)), name: mesh.name || undefined })
    }
  })
  return out
}

/** A component's footprint frame in the board's: moved and turned, and a bottom-side part flipped onto the bottom face. The board's bottom face is z = 0. */
export function componentMatrix(project: Project, c: ComponentInstance): THREE.Matrix4 {
  const bottom = c.pcb.side === "bottom"
  const m = new THREE.Matrix4().makeTranslation(c.pcb.x, c.pcb.y, bottom ? 0 : project.board.thickness)
  m.multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(c.pcb.rot)))
  if (bottom) m.multiply(new THREE.Matrix4().makeRotationY(Math.PI))
  return m
}

/** Designators named in the left-out note before it says how many more. */
const MISSING_LISTED = 12

/** One line for every part left out for having no 3D model, so no one takes the gap for an empty spot on the board. */
export function missingNote(refs: string[]): string {
  const sorted = [...refs].sort(naturalCompare)
  const listed = sorted.slice(0, MISSING_LISTED).join(", ")
  const more = sorted.length > MISSING_LISTED ? ` and ${sorted.length - MISSING_LISTED} more` : ""
  const head = sorted.length === 1 ? "1 part has no 3D model and is left out" : `${sorted.length} parts have no 3D model and are left out`
  return `${head}: ${listed}${more}.`
}

/** Model files read in parallel at most. */
const FETCHES = 4

async function inBatches<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(FETCHES, items.length) }, async () => {
      while (next < items.length) await run(items[next++])
    }),
  )
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A file name for a model: its own name without its extension, made safe for any file system, or the fallback. */
export function modelFileStem(m: Model3D, fallback: string): string {
  const stem = m.name
    .replace(/\.(step|stp|obj|wrl|vrml|stl|glb)$/i, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 80)
  return stem || fallback
}

/**
 * Read the model of every placed part. A STEP file is fetched once per file however many footprints place it, and its meshes are read
 * beside it: they place a model the supplier centres on its footprint, stand in for a file that can't be embedded, and give its box. A
 * reader that can't read a STEP file's meshes (a server) still has the file for a model placed by its own origin.
 */
export async function readPlacedModels(project: Project, reader: ModelReader, options: ReadModelsOptions = {}): Promise<PlacedModels> {
  const parts = options.components ?? placedParts(project)
  const plans = parts.map((c) => ({ c, model: componentModel(project, c) }))
  const distinct = new Map<string, Model3D>()
  for (const p of plans) if (p.model && !options.skip?.(p.model)) distinct.set(JSON.stringify(p.model), p.model)

  const stepFiles = new Map<string, Promise<Uint8Array>>()
  const stepOf = (m: Model3D) => {
    const file = modelFileKey(m)
    let bytes = stepFiles.get(file)
    if (!bytes) stepFiles.set(file, (bytes = reader.bytes(m, "step", options.signal).then((b) => new Uint8Array(b))))
    return bytes
  }
  const read = new Map<string, { object: THREE.Group | null; objectError?: string; step: Uint8Array | null; stepError?: string }>()
  let done = 0
  options.onProgress?.({ done, total: distinct.size })
  await inBatches([...distinct], async ([key, m]) => {
    const [object, step] = await Promise.allSettled([reader.meshes(m, options.signal), m.format === "step" ? stepOf(m) : Promise.resolve(null)])
    options.signal?.throwIfAborted()
    read.set(key, {
      object: object.status === "fulfilled" ? object.value : null,
      ...(object.status === "rejected" && { objectError: message(object.reason) }),
      step: step.status === "fulfilled" ? step.value : null,
      ...(step.status === "rejected" && { stepError: message(step.reason) }),
    })
    options.onProgress?.({ done: ++done, total: distinct.size })
  })
  options.signal?.throwIfAborted()

  const files = new Map<string, ModelFile>()
  // Notes by file, since two models may share a name.
  const failed = new Map<string, { name: string; error: string; refs: string[] }>()
  const meshInstead = new Map<string, { name: string; error: string; refs: string[] }>()
  const noteFor = (into: typeof failed, file: string, name: string, error: string, ref: string) => {
    const entry = into.get(file) ?? { name, error, refs: [] }
    entry.refs.push(ref)
    into.set(file, entry)
  }
  const of = new Map<string, string>()
  const missing: string[] = []
  for (const { c, model } of plans) {
    if (!model) {
      missing.push(c.ref)
      continue
    }
    if (options.skip?.(model)) continue
    const key = JSON.stringify(model)
    const got = read.get(key)
    if (!got) continue
    let file = files.get(key)
    if (!file) {
      const object = got.object
      // A model KiCad stretches cannot be placed by a rigid transform, so it is written as its mesh, stretched.
      if (got.step && !isStretched(model) && (model.origin === "model" || object)) {
        // A model placed by its own origin needs no meshes to place it.
        const matrix = placementMatrix(model, object ?? new THREE.Group())
        file = { key, model, shape: { kind: "step", bytes: got.step, matrix, ...(object && { fallback: meshesOf(object) }) }, box: object ? boundsUnder(object, matrix) : null }
      } else if (object) {
        const matrix = placementMatrix(model, object)
        file = { key, model, shape: { kind: "mesh", meshes: meshesOf(object, matrix) }, box: boundsUnder(object, matrix) }
      }
      if (file) files.set(key, file)
    }
    if (!file) {
      noteFor(failed, modelFileKey(model), model.name, got.objectError ?? got.stepError ?? "not read", c.ref)
      continue
    }
    if (file.shape.kind === "mesh" && got.stepError) noteFor(meshInstead, modelFileKey(model), model.name, got.stepError, c.ref)
    of.set(c.id, key)
  }

  const notes: string[] = []
  const dropsPart = options.dropsPart ?? true
  for (const { name, error, refs } of failed.values()) {
    const what = dropsPart ? (refs.length === 1 ? "it is left out" : "they are left out") : `${refs.length === 1 ? "it has" : "they have"} no 3D model in the files`
    notes.push(`${refs.join(", ")}: ${name} couldn't be read (${error}), so ${what}.`)
  }
  for (const { name, error, refs } of meshInstead.values()) {
    notes.push(`${refs.join(", ")}: ${name}'s STEP file couldn't be fetched (${error}), so ${refs.length === 1 ? "it is" : "they are"} written as its mesh.`)
  }
  return { files, of, missing, notes }
}

/**
 * A rigid matrix (rotation and move) as the angles about x, then y, then z, in degrees counter-clockwise, and the move: how KiCad and
 * Altium place a model (`Rz·Ry·Rx`, x applied first).
 */
export function rigidAngles(m: THREE.Matrix4): { rotation: { x: number; y: number; z: number }; offset: { x: number; y: number; z: number } } {
  const e = new THREE.Euler().setFromRotationMatrix(m, "ZYX")
  const deg = (r: number) => {
    const d = THREE.MathUtils.radToDeg(r)
    const rounded = Math.round(d * 1e6) / 1e6
    return Object.is(rounded, -0) ? 0 : rounded
  }
  const t = new THREE.Vector3().setFromMatrixPosition(m)
  return { rotation: { x: deg(e.x), y: deg(e.y), z: deg(e.z) }, offset: { x: t.x, y: t.y, z: t.z } }
}
