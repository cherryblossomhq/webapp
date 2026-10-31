import JSZip from "jszip"
import { serializeProject } from "../../model/projectFile"
import type { Project } from "../../model/types"

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
  const id = hex(await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer))
  return { id, bytes }
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

/** What is kept of a project, hashed: its stored text without the record of the files (the ids, the times and the sheet it is scoped to are not in it). */
export async function contentHash(project: Project): Promise<string> {
  const { original: _original, ...rest } = project.kicad ?? {}
  const text = serializeProject({ ...project, kicad: Object.keys(rest).length ? rest : undefined })
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
}
