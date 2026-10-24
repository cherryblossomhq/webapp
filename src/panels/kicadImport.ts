import { registerProjectFootprints } from "../model/footprints"
import { addDraftToProject } from "../model/indexPart"
import { baseName, importKicadFiles, isFootprintFile, isSymbolFile, type KicadImportPart } from "../model/kicadImport"
import { fileModel, MODEL_FILE_ACCEPT, modelFormatOf } from "../model/models3d"
import type { FootprintDef, Model3D, Project } from "../model/types"
import { MAX_MODEL_FILE_BYTES, modelFileId, modelFiles } from "../store/modelFiles"

// The library panel's "Import KiCad part": the files a user picks or drops (a symbol library, its
// footprints, their 3D models, or a vendor's zip of all three) read into project parts by
// `model/kicadImport.ts`, their model files kept as the Inspector keeps one, and the parts added
// to the open project as one undo step.

/** What the file picker offers: KiCad's symbol and footprint files, model files, and zips of them. */
export const KICAD_IMPORT_ACCEPT = `.kicad_sym,.kicad_mod,.zip,${MODEL_FILE_ACCEPT}`

/** A zip larger than this isn't opened: a vendor's download of one part is a few megabytes. */
const MAX_ZIP_BYTES = 100 * 1024 * 1024
/** Symbol and footprint files are text, and one part's are small. */
const MAX_TEXT_BYTES = 10 * 1024 * 1024

export interface GivenFile {
  /** The file's name, or its path in the zip it came in (a `.kicad_symdir` directory names the library). */
  name: string
  bytes: ArrayBuffer
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e))
const wanted = (name: string) => isSymbolFile(name) || isFootprintFile(name) || modelFormatOf(name) !== null

/**
 * The files to read, with zips opened: what in them is a KiCad or model file, wherever it is in
 * the zip (vendors nest them in folders per tool). Files that are neither say why.
 */
export async function unpackFiles(files: File[]): Promise<{ files: GivenFile[]; problems: string[] }> {
  const out: GivenFile[] = []
  const problems: string[] = []
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      if (file.size > MAX_ZIP_BYTES) {
        problems.push(`${file.name} is over ${MAX_ZIP_BYTES / 1024 / 1024} MB.`)
        continue
      }
      const { default: JSZip } = await import("jszip")
      let zip
      try {
        zip = await JSZip.loadAsync(await file.arrayBuffer())
      } catch {
        problems.push(`${file.name} isn't a zip that can be opened.`)
        continue
      }
      const entries = Object.values(zip.files).filter((e) => !e.dir && !e.name.startsWith("__MACOSX/") && !baseName(e.name).startsWith("._") && wanted(e.name))
      if (!entries.length) problems.push(`${file.name} holds no KiCad symbol, footprint or 3D model file.`)
      for (const e of entries) out.push({ name: e.name, bytes: await e.async("arraybuffer") })
    } else if (wanted(file.name)) {
      out.push({ name: file.name, bytes: await file.arrayBuffer() })
    } else if (/\.(lib|mod|dcm)$/i.test(file.name)) {
      problems.push(`${file.name} is a KiCad 5 library, which isn't read. Save it from KiCad 6 or later, or download the part for KiCad 6+.`)
    } else {
      problems.push(`${file.name} isn't a KiCad symbol (.kicad_sym), footprint (.kicad_mod) or 3D model file.`)
    }
  }
  return { files: out, problems }
}

export interface ImportOutcome {
  /** The parts now in the project from these files, new or already there. */
  partIds: string[]
  /** Their names, for the line the panel shows. */
  names: string[]
  /** What didn't come in, or came in without its model, one sentence each. */
  problems: string[]
}

/**
 * A model file given for a part, kept and placed: read first, so a file that doesn't read is neither
 * stored nor assigned (as in the Inspector), then fitted to the part's land.
 */
async function keepModel(file: GivenFile, part: KicadImportPart): Promise<Model3D> {
  const format = modelFormatOf(file.name)
  const name = baseName(file.name)
  if (!format) throw new Error(`${name} isn't a model file this editor reads.`)
  if (file.bytes.byteLength > MAX_MODEL_FILE_BYTES) throw new Error(`${name} is over ${MAX_MODEL_FILE_BYTES / 1024 / 1024} MB.`)
  const store = modelFiles()
  if (!store) throw new Error("model files can't be kept in this editor.")
  const placed = part.modelFile?.placement
  const drafted: Model3D = { ...fileModel(await modelFileId(file.bytes), name, format), ...placed }
  const { modelLibrary } = await import("../editor/three/files/library")
  const object = await modelLibrary.prime(drafted, file.bytes.slice(0))
  await store.put({ name, bytes: file.bytes })
  const { fitToFootprint } = await import("../editor/three/files/fit")
  return fitToFootprint(drafted, object, part.draft.footprint)
}

/**
 * Reads the files into parts and adds them to the project `projectId` names, which must still be
 * the open one when they are ready (a model file can take seconds to read and keep).
 */
export async function importKicadPart(given: File[], projectId: string, commit: (edit: (p: Project) => Project) => void): Promise<ImportOutcome> {
  const { files, problems } = await unpackFiles(given)
  const decoder = new TextDecoder()
  const texts = files
    .filter((f) => isSymbolFile(f.name) || isFootprintFile(f.name))
    .flatMap((f) => {
      if (f.bytes.byteLength <= MAX_TEXT_BYTES) return [{ name: f.name, text: decoder.decode(f.bytes) }]
      problems.push(`${baseName(f.name)} is over ${MAX_TEXT_BYTES / 1024 / 1024} MB.`)
      return []
    })
  const models = files.filter((f) => modelFormatOf(f.name))
  if (!texts.length) {
    problems.push(models.length ? "A 3D model file alone isn't a part: add the part's symbol and footprint, or add the model to a placed part in the Inspector." : "No KiCad symbol or footprint file was given.")
    return { partIds: [], names: [], problems }
  }

  const found = importKicadFiles(texts, models.map((m) => m.name))
  problems.push(...found.problems)
  // The lands first: fitting a model to its land needs the land to be known.
  registerProjectFootprints({ footprints: found.parts.map((p) => p.land).filter((l): l is FootprintDef => l !== null) })
  const kept = new Map<string, Promise<Model3D>>()
  const built: KicadImportPart[] = []
  for (const part of found.parts) {
    const ref = part.modelFile
    const file = ref && models.find((m) => m.name === ref.name)
    if (!file) {
      built.push(part)
      continue
    }
    // One file shared by several parts on one footprint is read and kept once.
    const key = `${file.name}|${part.draft.footprint}`
    if (!kept.has(key)) kept.set(key, keepModel(file, part))
    try {
      built.push({ ...part, model: await kept.get(key)! })
    } catch (e) {
      problems.push(`${part.draft.name} came in without its 3D model: ${messageOf(e)}`)
      built.push(part)
    }
  }

  const partIds: string[] = []
  const names: string[] = []
  let landed = false
  commit((p) => {
    if (p.id !== projectId) return p
    landed = true
    let next = p
    for (const part of built) {
      const added = addDraftToProject(next, part)
      if ("error" in added) {
        problems.push(added.error)
        continue
      }
      next = added.project
      partIds.push(added.spec.id)
      names.push(added.spec.name)
    }
    return next
  })
  if (built.length && !landed) problems.push("The project was closed before the parts were ready.")
  return { partIds, names, problems }
}
