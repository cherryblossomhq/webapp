import JSZip from "jszip"
import { givenModelFor, type GivenModel, type GivenModels } from "../../model/kicad/givenModels"
import { modelFormatOf } from "../../model/models3d"
import { serializeProject } from "../../model/projectFile"
import type { Model3DFormat, Project } from "../../model/types"

// The user's own KiCad files as one zip, apart from `original.ts`: the import packs them in its worker, and `original.ts` reaches the
// project store (for the zip's bytes), which a worker has no page for.

export interface OriginalFile {
  path: string
  data: Uint8Array
}

/** What the zip may hold: more is not kept (a project folder is megabytes, the store's file is 40 MB). */
export const MAX_ORIGINAL_BYTES = 36 * 1024 * 1024

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")

/** The files as one zip: the same files always make the same bytes, so the same import is kept once. */
export async function packOriginal(files: OriginalFile[]): Promise<{ id: string; bytes: Uint8Array }> {
  const zip = new JSZip()
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) zip.file(f.path, f.data, { date: new Date(0), createFolders: false, binary: true })
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } })
  return { id: await sha256Hex(bytes), bytes }
}

export async function unpackOriginal(bytes: ArrayBuffer | Uint8Array): Promise<OriginalFile[]> {
  const zip = await JSZip.loadAsync(bytes)
  const out: OriginalFile[] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    out.push({ path, data: await entry.async("uint8array") })
  }
  return out
}

/** A file the board's footprints name as their 3D model, read: its place among the files, its bytes, and the id the file store keeps it by. */
export interface BoardModelFile {
  path: string
  name: string
  format: Model3DFormat
  id: string
  data: Uint8Array
}

/** What a model file may weigh: the host's file store keeps files up to 40 MB. */
const MAX_MODEL_BYTES = 40 * 1024 * 1024

/**
 * The 3D model files among `files` that the board's footprints name (`(model "${KIPRJMOD}/3d models/U1.step" ...)`), read and hashed for the
 * file store, and the index the board builder finds them in (`GivenModels`). Only files under the board's folder, of a format the editor draws, up
 * to 40 MB; a file no footprint names is not read.
 */
export async function boardModels(files: { path: string; size: number | null; read(): Promise<Uint8Array> }[], boardPath: string, board: Uint8Array): Promise<{ given: GivenModels; files: BoardModelFile[] }> {
  const root = boardPath.includes("/") ? boardPath.slice(0, boardPath.lastIndexOf("/") + 1) : ""
  const candidates = new Map<string, (typeof files)[number]>()
  for (const f of files) {
    if (!f.path.startsWith(root) || !modelFormatOf(f.path) || (f.size !== null && f.size > MAX_MODEL_BYTES)) continue
    candidates.set(f.path.slice(root.length).toLowerCase(), f)
  }
  const given = new Map<string, GivenModel>()
  const out: BoardModelFile[] = []
  if (!candidates.size) return { given, files: out }
  const text = new TextDecoder().decode(board)
  const named = new Set([...text.matchAll(/\(model\s+(?:"((?:[^"\\]|\\.)*)"|([^\s()]+))/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1")))
  for (const path of named) {
    const f = givenModelFor(path, candidates)
    if (!f) continue
    const key = f.path.slice(root.length).toLowerCase()
    if (given.has(key)) continue
    const data = await f.read()
    if (data.length > MAX_MODEL_BYTES) continue
    const name = f.path.slice(f.path.lastIndexOf("/") + 1)
    const model: GivenModel = { id: await sha256Hex(data), name: name.replace(/\.[^.]+$/, ""), format: modelFormatOf(name)! }
    given.set(key, model)
    out.push({ path: f.path, name, format: model.format, id: model.id, data })
  }
  return { given, files: out }
}

/** The SHA-256 of some bytes as lowercase hex: the id the host's file store keeps a file by. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer))
}

/**
 * What is kept of a project, hashed: its stored text without the record of the files or of the report (the ids, the times and the sheet it is scoped to are not in it), with the keys
 * of every object in order, since a project read back from storage holds the same values with its keys in the order the reader writes them.
 */
export async function contentHash(project: Project): Promise<string> {
  // The report the import kept beside the project is named after this is worked out, and is not what the project is.
  const { original: _original, report: _report, ...rest } = project.kicad ?? {}
  const text = canonical(JSON.parse(serializeProject({ ...project, kicad: Object.keys(rest).length ? rest : undefined })))
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
}

/** JSON with every object's keys sorted. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`
}
