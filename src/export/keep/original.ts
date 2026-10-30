import JSZip from "jszip"
import { kicadFontLoaded, loadKicadFont } from "../../lib/kicadFont/load"
import type { Project } from "../../model/types"
import { imageBytes, loadImage } from "../../store/imageFiles"
import { fileVersion } from "./sexp"
import { neutralText, patchFile, type Kind } from "./patch"

// Keeping the user's own KiCad files and writing back only what the user changed.
//
// On import the files are kept as they came, in one zip in the host's file store (`KicadOriginal` names it by its SHA-256). On export,
// the project is written as it always was (`fresh`), the project as it was imported is written the same way (`before`: the files are read
// again by the importer), and the difference between the two is carried into the user's file (`patch.ts`). Nothing changed: the
// original, byte for byte. A file the patch cannot be made for is written as before, and said.

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

// ---------- the export ----------

/** What the export of a project is, as `kicad.ts` makes it. */
export interface KeptExport {
  files: Record<string, string>
  notes: string[]
  /** The exact bytes of the files that are the user's own (when they are not text that survives being a string). */
  exact?: Record<string, Uint8Array>
  /** What became of each file, for the tests and the notes. */
  kept?: { file: string; mode: "original" | "patched" | "written"; detail: string }[]
}

type Write = (project: Project) => Promise<{ files: Record<string, string>; notes: string[] }>

// A KiCad 8 schematic (20231120) is patched too: its spelling is the one the exporter writes but for a few words, and the whole-file rewrite it would get instead is a KiCad 9 file as well, which
// also adds a symbol for every footprint the board has and the schematic does not (on 127_PCBWay that joined two pads to GND).
const MIN_VERSION: Record<Kind, number> = { board: 20241229, schematic: 20231120 }

const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const extOf = (path: string) => {
  const b = baseOf(path)
  const dot = b.lastIndexOf(".")
  return dot < 0 ? "" : b.slice(dot)
}
const stemOf = (path: string) => baseOf(path).replace(/\.[^.]+$/, "")

/** Which of the user's files an exported file stands for. */
function originalOf(name: string, files: OriginalFile[]): OriginalFile | null {
  // Two files of one name are in different folders: the one nearest the top is the project's own.
  const exact = files.filter((f) => baseOf(f.path) === name).sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0]
  if (exact) return exact
  const ext = extOf(name)
  if (ext === ".kicad_pcb" || ext === ".kicad_pro" || ext === ".kicad_dru") {
    const same = files.filter((f) => extOf(f.path) === ext)
    const byStem = same.find((f) => stemOf(f.path) === stemOf(name))
    return byStem ?? (same.length === 1 ? same[0] : null)
  }
  return null
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** The file's text, or null when it is not UTF-8 that comes back to the same bytes. */
function textOf(data: Uint8Array): string | null {
  try {
    const text = decoder.decode(data)
    const again = encoder.encode(text)
    return again.length === data.length && again.every((b, i) => b === data[i]) ? text : null
  } catch {
    return null
  }
}

/** A project file's text without what the writer makes afresh each time (the times, and the uuids made from ids). */
const steady = (text: string) => text.replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"~"').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "~")
const same = (a: unknown, b: unknown) => steady(JSON.stringify(a)) === steady(JSON.stringify(b))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** `c`'s changes since `b`, put into `o`. */
function mergeJson(o: unknown, b: unknown, c: unknown): unknown {
  if (same(b, c)) return o
  if (!isObject(o) || !isObject(b) || !isObject(c)) return c
  const out: Record<string, unknown> = { ...o }
  for (const key of new Set([...Object.keys(b), ...Object.keys(c)])) {
    if (!(key in c)) delete out[key]
    else if (!(key in b) || !(key in o)) out[key] = c[key]
    else if (!same(b[key], c[key])) out[key] = mergeJson(o[key], b[key], c[key])
  }
  return out
}

/** The last few projects' `before`, by the zip's id, so that switching between projects does not write each one again; the oldest goes first, and none is kept that is huge. */
const cache = new Map<string, Record<string, string>>()
const CACHED_PROJECTS = 3
const CACHED_CHARS = 48 * 1024 * 1024
const charsOf = (files: Record<string, string>) => Object.values(files).reduce((n, t) => n + t.length, 0)

/** The project read again from the user's files, and written the way `write` writes: what the export said of it before the user changed anything. */
async function writtenBefore(id: string, files: OriginalFile[], record: { name?: string; source?: string }, write: Write): Promise<Record<string, string> | string> {
  const hit = cache.get(id)
  if (hit) {
    cache.delete(id)
    cache.set(id, hit)
    return hit
  }
  const { importKicadProject } = await import("../../model/kicad/project")
  const board = files.find((f) => extOf(f.path) === ".kicad_pcb")
  if (board && !kicadFontLoaded()) {
    const d = board.data
    const utf16 = (d[0] === 0xff && d[1] === 0xfe) || (d[0] === 0xfe && d[1] === 0xff)
    await loadKicadFont({ cjk: utf16 || d.some((b) => b >= 0xe3 && b <= 0xef) })
  }
  const r = importKicadProject(files, { name: record.name, source: record.source, limitBytes: Number.MAX_SAFE_INTEGER })
  if (r.status !== "imported") return `the original files could not be read again (${r.message})`
  const written = await write(r.project)
  if (charsOf(written.files) <= CACHED_CHARS) {
    cache.set(id, written.files)
    while (cache.size > CACHED_PROJECTS || [...cache.values()].reduce((n, f) => n + charsOf(f), 0) > CACHED_CHARS) cache.delete(cache.keys().next().value!)
  }
  return written.files
}

/**
 * The export of a project that came from KiCad files, written into those files: what the user did not change is the file's own bytes.
 * `fresh` is the export as it is written from the project alone; `write` writes any project that way.
 */
export async function keepOriginal(source: Project, fresh: { files: Record<string, string>; notes: string[] }, write: Write): Promise<KeptExport> {
  const record = source.kicad?.original
  if (!record) return fresh
  await loadImage(record.file)
  const zipped = imageBytes(record.file)
  if (!zipped) return { ...fresh, notes: ["The KiCad files this project came from are not in this account's files, so every file is written from the project.", ...fresh.notes] }
  let originals: OriginalFile[]
  try {
    originals = await unpackOriginal(zipped)
  } catch {
    return { ...fresh, notes: ["The KiCad files this project came from could not be opened, so every file is written from the project.", ...fresh.notes] }
  }
  const before = await writtenBefore(record.file, originals, record, write).catch((e: unknown) => `the original files could not be read again (${e instanceof Error ? e.message : String(e)})`)
  if (typeof before === "string") return { ...fresh, notes: [`Every file is written from the project: ${before}.`, ...fresh.notes] }

  const files: Record<string, string> = {}
  const exact: Record<string, Uint8Array> = {}
  const kept: NonNullable<KeptExport["kept"]> = []
  for (const [name, after] of Object.entries(fresh.files)) {
    const orig = originalOf(name, originals)
    const was = before[name]
    const unchanged = was !== undefined && (was === after || (extOf(name) === ".kicad_pro" ? steady(was) === steady(after) : neutralText(was) === neutralText(after)))
    // A file the user did not have (a board with no schematic or project file) and the edits did not touch is not made up: the export is the user's file set. (A made-up project file also changes the sheet name a netlist gives the root.)
    if (!orig && unchanged) continue
    if (!orig || was === undefined) {
      files[name] = after
      kept.push({ file: name, mode: "written", detail: orig ? "the file was not written before" : "it is new" })
      continue
    }
    if (unchanged) {
      // Nothing of this file changed: the user's own bytes.
      files[name] = textOf(orig.data) ?? after
      exact[name] = orig.data
      kept.push({ file: name, mode: "original", detail: "unchanged" })
      continue
    }
    const text = textOf(orig.data)
    const ext = extOf(name)
    const fall = (why: string) => {
      files[name] = after
      kept.push({ file: name, mode: "written", detail: why })
    }
    if (text === null) {
      fall("the original is not UTF-8 text")
      continue
    }
    if (ext === ".kicad_pcb" || ext === ".kicad_sch") {
      const kind: Kind = ext === ".kicad_pcb" ? "board" : "schematic"
      const version = fileVersion(text)
      if (version === null || version < MIN_VERSION[kind]) {
        fall(`the original is an older format (version ${version ?? "unknown"}) than the one written here, so a patch would mix the two`)
        continue
      }
      const patched = patchFile(kind, text, was, after)
      if (!patched.ok) {
        fall(patched.reason ?? "no patch could be made")
        continue
      }
      if (patched.text === text) {
        files[name] = text
        exact[name] = orig.data
        kept.push({ file: name, mode: "original", detail: "unchanged" })
        continue
      }
      files[name] = patched.text
      kept.push({ file: name, mode: "patched", detail: `${patched.stats.changed} changed, ${patched.stats.added} added, ${patched.stats.removed} removed, ${patched.stats.kept} untouched` })
      continue
    }
    if (ext === ".kicad_pro") {
      try {
        const parsed = JSON.parse(text)
        const merged = mergeJson(parsed, JSON.parse(was), JSON.parse(after))
        if (JSON.stringify(merged) === JSON.stringify(parsed)) {
          files[name] = text
          exact[name] = orig.data
          kept.push({ file: name, mode: "original", detail: "unchanged" })
        } else {
          files[name] = `${JSON.stringify(merged, null, 2)}${text.endsWith("\n") ? "\n" : ""}`
          kept.push({ file: name, mode: "patched", detail: "the settings that changed" })
        }
      } catch {
        fall("the project file could not be read")
      }
      continue
    }
    fall("it changed")
  }
  // The files beside the project that the editor does not write (library tables and libraries) go back as they were.
  const seen = new Set(Object.keys(files).map((n) => n.toLowerCase()))
  for (const f of originals) {
    const ext = extOf(f.path)
    if (ext === ".kicad_pcb" || ext === ".kicad_sch" || ext === ".kicad_pro" || ext === ".kicad_dru") continue
    const name = baseOf(f.path)
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    files[name] = textOf(f.data) ?? ""
    exact[name] = f.data
    kept.push({ file: name, mode: "original", detail: "beside the project" })
  }
  const written = kept.filter((k) => k.mode === "written" && k.detail !== "it is new")
  const patched = kept.filter((k) => k.mode === "patched")
  const notes: string[] = []
  if (!patched.length && !written.length) notes.push("Your original KiCad files are written back byte for byte: nothing was changed.")
  else {
    notes.push(`Your original KiCad files are kept: ${patched.length ? `${patched.map((k) => `${k.file} (${k.detail})`).join("; ")} had only what you changed written into it` : "no file needed a change"}; everything else is your own bytes.`)
    for (const k of written) notes.push(`${k.file} was written from the project as before: ${k.detail}.`)
  }
  return { files, notes: written.length || patched.length ? [...notes, ...fresh.notes] : notes, exact, kept }
}
