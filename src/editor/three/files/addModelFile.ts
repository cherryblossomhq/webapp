import type { AddModelFile } from "../../../ai/webSource"
import { fileModel, modelFormatOf } from "../../../model/models3d"
import type { Model3DFormat } from "../../../model/types"
import { MAX_MODEL_FILE_BYTES, modelFileId, modelFiles } from "../../../store/modelFiles"
import { projectApi } from "../../../store/projectStore"
import { fitToFootprint } from "./fit"
import { modelLibrary } from "./library"

/**
 * A model file Sakura fetched (`set_3d_model url`), taken as the Inspector takes a file the user adds
 * (`panels/ModelSection.tsx`): read first, so a file that doesn't read is neither kept nor used; kept
 * in the account under the project's owner; placed by its own origin, or centred on the footprint
 * when that would leave it off its pads (`fitToFootprint`). A zip is opened here and its best model
 * taken: STEP before the meshes, then the largest, since a vendor's zip often carries a STEP and a
 * WRL of the same part, or a model per variant.
 */

const PREFERENCE: Model3DFormat[] = ["step", "wrl", "glb", "obj", "stl"]
/** Entries a zip may hold for it to be opened: a part's download, not a library. */
const MAX_ZIP_ENTRIES = 200

async function fromZip(bytes: ArrayBuffer): Promise<{ name: string; bytes: ArrayBuffer; format: Model3DFormat; note?: string }> {
  const { default: JSZip } = await import("jszip")
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name))
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`The zip holds ${entries.length} files: that's a library, not a part's model. Find the one part's file.`)
  const models = entries
    .map((f) => ({ f, format: modelFormatOf(f.name), size: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0 }))
    .filter((m): m is { f: (typeof entries)[number]; format: Model3DFormat; size: number } => m.format !== null)
    .sort((a, b) => PREFERENCE.indexOf(a.format) - PREFERENCE.indexOf(b.format) || b.size - a.size)
  const pick = models[0]
  if (!pick) throw new Error("The zip holds no model file this editor reads (STEP, WRL, OBJ, STL or GLB).")
  if (pick.size > MAX_MODEL_FILE_BYTES) throw new Error(`${pick.f.name} is over ${MAX_MODEL_FILE_BYTES / 1024 / 1024} MB.`)
  const inner = await pick.f.async("arraybuffer")
  const name = pick.f.name.split("/").pop() ?? pick.f.name
  const others = models.length - 1
  return { name, bytes: inner, format: pick.format, ...(others ? { note: `The zip held ${models.length} model files; ${name} was used (${others > 1 ? "the others are" : "the other is"} ${models.slice(1, 4).map((m) => m.f.name.split("/").pop()).join(", ")}${others > 3 ? ", ..." : ""}).` } : {}) }
}

export const addModelFile: AddModelFile = async (file, footprint, signal) => {
  const opened = file.kind === "zip" ? await fromZip(file.bytes) : { name: file.name, bytes: file.bytes, format: file.kind as Model3DFormat }
  if (signal?.aborted) throw signal.reason
  if (opened.bytes.byteLength > MAX_MODEL_FILE_BYTES) throw new Error(`${opened.name} is over ${MAX_MODEL_FILE_BYTES / 1024 / 1024} MB.`)
  const store = modelFiles()
  if (!store) throw new Error("Model files can't be kept in this editor.")
  const drafted = fileModel(await modelFileId(opened.bytes), opened.name, opened.format)
  let object
  try {
    // The reader may take its bytes (a STEP file goes to a worker), so it gets a copy.
    object = await modelLibrary.prime(drafted, opened.bytes.slice(0))
  } catch (e) {
    throw new Error(`${opened.name} came down but doesn't read as a ${opened.format.toUpperCase()} model (${e instanceof Error ? e.message : String(e)}).`)
  }
  await store.put({ name: opened.name, bytes: opened.bytes }, signal, projectApi().project?.id)
  return { model: fitToFootprint(drafted, object, footprint), ...(opened.note ? { note: opened.note } : {}) }
}
