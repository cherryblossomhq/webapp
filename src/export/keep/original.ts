import { kicadFontLoaded, loadKicadFont } from "../../lib/kicadFont/load"
import type { Project } from "../../model/types"
import { imageBytes, loadImage } from "../../store/imageFiles"
import { contentHash, unpackOriginal, type OriginalFile } from "./pack"
import { fileVersion } from "./sexp"
import { neutralText, patchFile, type Kind } from "./patch"

// Keeping the user's own KiCad files and writing back only what the user changed.
//
// On import the files are kept as they came, in one zip in the host's file store (`KicadOriginal` names it by its SHA-256). On export,
// the project is written as it always was (`fresh`), the project as it was imported is written the same way (`before`: the files are read
// again by the importer), and the difference between the two is carried into the user's file (`patch.ts`). Nothing changed: the
// original, byte for byte. A file the patch cannot be made for is written as before, and said.

export { MAX_ORIGINAL_BYTES, contentHash, packOriginal, unpackOriginal, type OriginalFile } from "./pack"

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

/** Where a kept file goes in the export: its path under the board's folder (`3d models/U1.step`, a footprint library's `.pretty/`), its name for one beside the board. */
function placesOf(files: OriginalFile[]): (f: OriginalFile) => string {
  const board = files.filter((f) => extOf(f.path) === ".kicad_pcb").sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0]
  const root = board && board.path.includes("/") ? board.path.slice(0, board.path.lastIndexOf("/") + 1) : ""
  return (f) => (f.path.startsWith(root) && f.path.slice(root.length).includes("/") ? f.path.slice(root.length) : baseOf(f.path))
}

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
/** Forget every project's `before` (a test of the cold export). */
export const clearOriginalCache = () => cache.clear()
const charsOf = (files: Record<string, string>) => Object.values(files).reduce((n, t) => n + t.length, 0)

/** The project read again from the user's files, and written the way `write` writes: what the export said of it before the user changed anything. */
async function writtenBefore(id: string, files: OriginalFile[], record: { name?: string; source?: string }, write: Write): Promise<Record<string, string> | string> {
  const hit = cache.get(id)
  if (hit) {
    cache.delete(id)
    cache.set(id, hit)
    return hit
  }
  // One at a time per project: an export asked for while the background one runs waits for it.
  const running = making.get(id)
  if (running) return running
  const made = makeBefore(id, files, record, write).finally(() => making.delete(id))
  making.set(id, made)
  return made
}

const making = new Map<string, Promise<Record<string, string> | string>>()

async function makeBefore(id: string, files: OriginalFile[], record: { name?: string; source?: string }, write: Write): Promise<Record<string, string> | string> {
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
  const matched = new Set<OriginalFile>()
  for (const [name, after] of Object.entries(fresh.files)) {
    const orig = originalOf(name, originals)
    // The file goes by the user's own name for it (the exporter names the board and project after the project: `fb-t2q-fresh` for `fb_t2q_fresh`).
    const out = orig && !(baseOf(orig.path) in files) ? baseOf(orig.path) : name
    if (orig) matched.add(orig)
    const was = before[name]
    const unchanged = was !== undefined && (was === after || (extOf(name) === ".kicad_pro" ? steady(was) === steady(after) : neutralText(was) === neutralText(after)))
    // A file the user did not have (a board with no schematic or project file) and the edits did not touch is not made up: the export is the user's file set. (A made-up project file also changes the sheet name a netlist gives the root.)
    if (!orig && unchanged) continue
    if (!orig || was === undefined) {
      files[out] = after
      kept.push({ file: out, mode: "written", detail: orig ? "the file was not written before" : "it is new" })
      continue
    }
    if (unchanged) {
      // Nothing of this file changed: the user's own bytes.
      files[out] = textOf(orig.data) ?? after
      exact[out] = orig.data
      kept.push({ file: out, mode: "original", detail: "unchanged" })
      continue
    }
    const text = textOf(orig.data)
    const ext = extOf(name)
    const fall = (why: string) => {
      files[out] = after
      kept.push({ file: out, mode: "written", detail: why })
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
        files[out] = text
        exact[out] = orig.data
        kept.push({ file: out, mode: "original", detail: "unchanged" })
        continue
      }
      files[out] = patched.text
      kept.push({ file: out, mode: "patched", detail: `${patched.stats.changed} changed, ${patched.stats.added} added, ${patched.stats.removed} removed, ${patched.stats.kept} untouched` })
      continue
    }
    if (ext === ".kicad_pro") {
      try {
        const parsed = JSON.parse(text)
        const merged = mergeJson(parsed, JSON.parse(was), JSON.parse(after))
        if (JSON.stringify(merged) === JSON.stringify(parsed)) {
          files[out] = text
          exact[out] = orig.data
          kept.push({ file: out, mode: "original", detail: "unchanged" })
        } else {
          files[out] = `${JSON.stringify(merged, null, 2)}${text.endsWith("\n") ? "\n" : ""}`
          kept.push({ file: out, mode: "patched", detail: "the settings that changed" })
        }
      } catch {
        fall("the project file could not be read")
      }
      continue
    }
    fall("it changed")
  }
  // The files of the user's that the editor does not write (library tables and libraries, a sheet no sheet symbol uses, the footprint library and 3D models in their folders) go back as they were.
  const seen = new Set(Object.keys(files).map((n) => n.toLowerCase()))
  const placeOf = placesOf(originals)
  for (const f of originals) {
    if (matched.has(f)) continue
    const name = placeOf(f)
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

/**
 * The export of a project that is as it was imported: the user's files, byte for byte, without writing the project at all.
 * Null unless that is certain (no record of the content, a scoped view, the files not at hand, or any difference in what is kept of the project), and then the export goes the long way.
 */
export async function unchangedExport(source: Project): Promise<KeptExport | null> {
  const record = source.kicad?.original
  if (!record?.content || source.scope !== undefined) return null
  if ((await contentHash(source)) !== record.content) return null
  await loadImage(record.file)
  const zipped = imageBytes(record.file)
  if (!zipped) return null
  let originals: OriginalFile[]
  try {
    originals = await unpackOriginal(zipped)
  } catch {
    return null
  }
  const files: Record<string, string> = {}
  const exact: Record<string, Uint8Array> = {}
  const kept: NonNullable<KeptExport["kept"]> = []
  // Two files of one name are in different folders: the one nearest the top is the project's own, as in `originalOf`.
  const depth = (f: OriginalFile) => f.path.split("/").length
  const placeOf = placesOf(originals)
  for (const f of [...originals].sort((a, b) => depth(a) - depth(b))) {
    const name = placeOf(f)
    if (name.toLowerCase() in exact || name in files) continue
    files[name] = textOf(f.data) ?? ""
    exact[name] = f.data
    kept.push({ file: name, mode: "original", detail: /^\.kicad_(pcb|sch|pro|dru)$/.test(extOf(name)) ? "unchanged" : "beside the project" })
  }
  return { files, notes: ["Your original KiCad files are written back byte for byte: nothing was changed."], exact, kept }
}

/** Write the project's `before` now, so that an export asked for later finds it (the first export of a project would write the files twice). */
export async function warmBefore(source: Project, write: Write): Promise<void> {
  const record = source.kicad?.original
  if (!record) return
  await loadImage(record.file)
  const zipped = imageBytes(record.file)
  if (!zipped) return
  await writtenBefore(record.file, await unpackOriginal(zipped), record, write)
}
