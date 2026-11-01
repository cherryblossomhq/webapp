import { libraryModel } from "./libraryModels"
import { KICAD_MODEL_ID } from "./supplier/kicadModel"
import type { PartIndexKicadModel, SupplierModel3D } from "@cherryblossom/api-contract"
import type { ComponentInstance, Model3D, Model3DFormat, ModelAssignment, Project } from "./types"

// 3D models in the document: which file a part is drawn with on a footprint. The files
// themselves are the host's (`store/modelFiles.ts`, `SupplierPartsSource.model`); the project
// names them and says where they sit on the footprint.

export const MODEL_FORMATS: readonly Model3DFormat[] = ["step", "obj", "wrl", "stl", "glb"]

/** File extensions the editor reads, by format. */
const EXTENSIONS: Record<string, Model3DFormat> = {
  step: "step",
  stp: "step",
  obj: "obj",
  wrl: "wrl",
  vrml: "wrl",
  stl: "stl",
  glb: "glb",
}

export const MODEL_FILE_ACCEPT = Object.keys(EXTENSIONS)
  .map((e) => `.${e}`)
  .join(",")

/** A file's format from its name, or null when it isn't one the editor reads. */
export function modelFormatOf(fileName: string): Model3DFormat | null {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return (ext && EXTENSIONS[ext]) || null
}

/**
 * Units of a file when it doesn't say: KiCad's VRML models are in tenths of an inch, glTF is
 * in metres, and everything else in practice millimetres. STEP files carry their own units.
 */
export function defaultModelScale(format: Model3DFormat): number {
  if (format === "wrl") return 2.54
  if (format === "glb") return 1000
  return 1
}

/** The model the project gives a part on a footprint, or null when it gives none. */
export function modelAssignment(project: Pick<Project, "models">, part: string, footprint: string): Model3D | null {
  return project.models?.find((m) => m.part === part && m.footprint === footprint)?.model ?? null
}

/**
 * The model a component is drawn with: the project's for its part on its footprint, else the
 * built-in one (`libraryModels.ts`), else null, and the 3D view and the STEP export draw only its pads.
 */
export const componentModel = (project: Pick<Project, "models">, c: Pick<ComponentInstance, "partId" | "footprint">) =>
  modelAssignment(project, c.partId, c.footprint) ?? libraryModel(c.partId, c.footprint)

/** Give a part on a footprint a model, or take it away (`null`): it is drawn with its built-in model then, if it has one. */
export function setModel(project: Project, part: string, footprint: string, model: Model3D | null): Project {
  const rest = (project.models ?? []).filter((m) => !(m.part === part && m.footprint === footprint))
  const models = model ? [...rest, { part, footprint, model }] : rest
  return { ...project, updatedAt: Date.now(), models: models.length ? models : undefined }
}

/** Copy the models of these parts on these footprints from another project, as paste does. */
export function withModelsFrom(target: Project, source: Project, pairs: Iterable<{ part: string; footprint: string }>): Project {
  let next = target
  for (const { part, footprint } of pairs) {
    if (modelAssignment(next, part, footprint)) continue
    const model = modelAssignment(source, part, footprint)
    if (model) next = { ...next, models: [...(next.models ?? []), { part, footprint, model }] }
  }
  return next
}

/** A supplier's model as the document keeps it. */
export function supplierModel(m: SupplierModel3D, attribution?: string): Model3D {
  return {
    source: "supplier",
    id: m.id,
    name: m.title,
    format: "step",
    origin: "center",
    offset: { x: m.center.x, y: m.center.y, z: m.bottom },
    rotation: { ...m.rotation },
    ...(attribution ? { attribution } : {}),
  }
}

/**
 * A KiCad library model as the document keeps it, or null when it can't be drawn right. KiCad's
 * 3D viewer scales a model, turns it about x, then y, then z by the written angles *clockwise*
 * (so the negatives here, ours being counter-clockwise), then moves it by `offset`, which is in
 * millimetres from the footprint's origin with z up: the footprint's frame, as `footprint.ts`
 * reads it. That is `origin: "model"`. A STEP file says its own units, so a scale other than 1
 * (which KiCad's own library never writes for STEP) leaves no model rather than a wrong one.
 */
export function kicadModel(m: PartIndexKicadModel): Model3D | null {
  const { x, y, z } = m.scale
  if (x !== 1 || y !== 1 || z !== 1) return null
  const flip = (v: number) => (v === 0 ? 0 : -v)
  return {
    source: "kicad",
    id: m.id,
    name: m.name,
    format: "step",
    origin: "model",
    offset: { x: m.offset.x, y: m.offset.y, z: m.offset.z },
    rotation: { x: flip(m.rotate.x), y: flip(m.rotate.y), z: flip(m.rotate.z) },
    attribution: "KiCad library",
  }
}

/** A file the user added, placed by its own origin as KiCad places one. */
export function fileModel(id: string, name: string, format: Model3DFormat): Model3D {
  const scale = defaultModelScale(format)
  return {
    source: "file",
    id,
    name,
    format,
    origin: "model",
    offset: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    ...(scale !== 1 ? { scale } : {}),
  }
}

/** Where a model's bytes come from, as a cache key: one file, whatever parts use it. */
export const modelFileKey = (m: Pick<Model3D, "source" | "id">) => `${m.source}:${m.id}`

/** How the model is credited, in a few words for the Inspector. */
export function modelOrigin(m: Model3D): string {
  if (m.source === "kicad") return "KiCad library model"
  return m.source === "supplier" ? "Supplier model" : `${m.format === "step" ? "STEP" : m.format.toUpperCase()} file`
}

// ---------- Reading ----------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback)
const vec = (v: unknown) => (isRecord(v) ? { x: num(v.x), y: num(v.y), z: num(v.z) } : { x: 0, y: 0, z: 0 })

function normalizeModel(raw: unknown): Model3D | null {
  if (!isRecord(raw)) return null
  const source = raw.source === "file" || raw.source === "supplier" || raw.source === "kicad" ? raw.source : null
  const format = MODEL_FORMATS.includes(raw.format as Model3DFormat) ? (raw.format as Model3DFormat) : null
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  if (!source || !format || !id) return null
  if (source === "file" && !/^[0-9a-f]{64}$/.test(id)) return null
  if (source === "kicad" && (format !== "step" || !KICAD_MODEL_ID.test(id))) return null
  const scale = num(raw.scale, 1)
  return {
    source,
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    format,
    origin: raw.origin === "center" ? "center" : "model",
    offset: vec(raw.offset),
    rotation: vec(raw.rotation),
    ...(scale > 0 && scale !== 1 && format !== "step" ? { scale } : {}),
    ...(typeof raw.attribution === "string" && raw.attribution ? { attribution: raw.attribution } : {}),
  }
}

/** The models of a file: a malformed entry is dropped, not fatal; the last of two for one part and footprint wins. */
export function normalizeModels(raw: unknown): ModelAssignment[] {
  if (!Array.isArray(raw)) return []
  const byKey = new Map<string, ModelAssignment>()
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.part !== "string" || typeof entry.footprint !== "string") continue
    const model = normalizeModel(entry.model)
    if (model) byKey.set(`${entry.part}\n${entry.footprint}`, { part: entry.part, footprint: entry.footprint, model })
  }
  return [...byKey.values()]
}
