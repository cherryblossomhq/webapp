import { KICAD_MODEL_PATH } from "../../supplier/kicadModel"
import type { GivenModel, GivenModels } from "../givenModels"
import { givenModelFor } from "../givenModels"
import { STOCK_MODEL_RELEASE, stockModelExists } from "./stockModels"
import type { KicadFootprint, KicadModel } from "./types"

// Which of a footprint's 3D models the project holds. The editor keeps one model per part and
// land (`ModelAssignment`), and draws a STEP file of KiCad's stock library that its parts index
// serves (`GET /api/v1/parts/models/kicad/<release>/<library>.3dshapes/<name>.step`, streamed from
// KiCad's repository at that release's tag). Every other model of the file is named in the import
// report with why it was left out, never dropped silently.

/** The library release the parts index stores KiCad's 3D models at; a stock model's id is `<release>/<path>`. */
export const KICAD_LIBRARY_RELEASE = STOCK_MODEL_RELEASE

export interface StockPath {
  /** `<library>.3dshapes`. */
  library: string
  name: string
}

/**
 * The stock-library model a path names, or null for a path that cannot be one. KiCad 4 and 5 write
 * `Library.3dshapes/Name.wrl` relative to its model directory, KiCad 5 and later
 * `${KISYS3DMOD}/Library.3dshapes/Name.wrl` and `${KICAD6_3DMODEL_DIR}/...` and so on (`.wrl`
 * becomes the `.step` the library has since). Whether the library at the release has it is
 * `stockModelId`'s question.
 */
export function stockPath(path: string): StockPath | null {
  const m = /^(?:\$\{(?:KISYS3DMOD|KICAD\d*_3DMODEL_DIR)\}[/\\])?([^/\\]+\.3dshapes)[/\\]([^/\\]+)\.(?:wrl|step|stp|wrz)$/i.exec(path)
  return m ? { library: m[1], name: m[2] } : null
}

/** The id of a stock model at `KICAD_LIBRARY_RELEASE`, or null when the library there has no such file (or its name is not one the parts index accepts). */
export function stockModelId(path: string): string | null {
  const s = stockPath(path)
  if (!s || !stockModelExists(s.library, s.name)) return null
  const file = `${s.library}/${s.name}.step`
  return KICAD_MODEL_PATH.test(file) ? `${KICAD_LIBRARY_RELEASE}/${file}` : null
}

/**
 * The stock model of the nearest name when the library at the release has no file of this one: the name less its last `_` parts, longest first,
 * keeping at least the package and its size (`QFN-24_3x3mm_P0.4mm` for `QFN-24_3x3mm_P0.4mm_EP1.7x1.54mm`, the same body without its exposed pad's
 * size in the name). Null when none is left, so a part is never drawn as another package.
 */
export function nearestStockModel(path: string): { id: string; name: string } | null {
  const s = stockPath(path)
  if (!s) return null
  const parts = s.name.split("_")
  for (let n = parts.length - 1; n >= 3; n--) {
    const name = parts.slice(0, n).join("_")
    const file = `${s.library}/${name}.step`
    if (stockModelExists(s.library, name) && KICAD_MODEL_PATH.test(file)) return { id: `${KICAD_LIBRARY_RELEASE}/${file}`, name }
  }
  return null
}

export interface DroppedModel {
  model: KicadModel
  why: string
}

export { givenModelFor, type GivenModel, type GivenModels }

export interface ModelPlan {
  /** The model the project holds for this footprint, with its id; `file` when it is a file given with the board, not one of KiCad's stock library. */
  kept: { model: KicadModel; id: string; file?: GivenModel; /** The stock model of a nearby name drawn for one the library no longer has (`nearestStockModel`). */ nearest?: string } | null
  /** Every other model of the footprint, each with the reason it is not in the project. */
  dropped: DroppedModel[]
}

/** What the project holds of a footprint's models: the first one that can be, and a reason for each of the rest. */
export function planModels(fp: KicadFootprint, given: GivenModels = new Map()): ModelPlan {
  const plan: ModelPlan = { kept: null, dropped: [] }
  for (const model of fp.models) {
    const drop = (why: string) => plan.dropped.push({ model, why })
    const { x, y, z } = model.scale
    if (model.hidden) drop("It is hidden in KiCad, and a model the editor holds is always shown.")
    else if (!(x > 0 && y > 0 && z > 0)) drop("Its scale is zero or less on an axis, so it has no size to draw.")
    else {
      const s = stockPath(model.path)
      const file = s ? null : givenModelFor(model.path, given)
      if (file) {
        if (plan.kept) drop("The editor holds one 3D model per part and land, and this footprint has another one.")
        else plan.kept = { model, id: file.id, file }
      } else if (!s) drop("It is not a model of KiCad's stock library, and the file it names was not among the files imported.")
      else {
        const id = stockModelId(model.path)
        const near = id ? null : nearestStockModel(model.path)
        if (!id && !near) drop(`KiCad's 3D library at release ${KICAD_LIBRARY_RELEASE} has no ${s.library}/${s.name}.step, nor one of a nearby name (the libraries were renamed after KiCad 5), so the parts index cannot serve it.`)
        else if (plan.kept) drop("The editor holds one 3D model per part and land, and this footprint has another one.")
        else plan.kept = id ? { model, id } : { model, id: near!.id, nearest: near!.name }
      }
    }
  }
  return plan
}

/** A model's identity for the land it is held with: two footprints share a land only when they would share this too. */
export const modelKey = (plan: ModelPlan): string => {
  if (!plan.kept) return ""
  const { offset, rotate, scale } = plan.kept.model
  return JSON.stringify(scale.x === 1 && scale.y === 1 && scale.z === 1 ? [plan.kept.id, offset, rotate] : [plan.kept.id, offset, rotate, scale])
}
