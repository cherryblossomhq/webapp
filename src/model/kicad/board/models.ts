import { KICAD_MODEL_PATH } from "../../supplier/kicadModel"
import { givenModelFor, type GivenModel, type GivenModels } from "../givenModels"
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

/**
 * Model files named for a package KiCad has since renamed, or named by a
 * library of someone's own that spells a standard package another way.
 *
 * **Why this is not a body we invented.** KiCad's 3D library ships one model
 * per *package*, shared by every part in it: every 0603 chip resistor is drawn
 * with `R_0603_1608Metric`. So a board of KiCad 4's asking for
 * `Resistors_SMD/R_0603.wrl`, and one whose author kept their own
 * `smd/resistors/R0603.wrl`, are both naming that same package under the name
 * their KiCad had for it. Resolving the name reads what the author wrote; it
 * does not choose a body for them. Nothing here maps a part number, a
 * footprint or a pin count to a model, only a package's own name to that
 * package.
 *
 * Which is why every entry is a *package*, never a part. `SOT-23` is a shape.
 * `SOT-523`, which several community boards ask for, is a shape KiCad's
 * library does not have, and it stays missing rather than being drawn as its
 * larger cousin: a model of the wrong size on somebody else's published board
 * is the thing this table exists to avoid.
 *
 * The key is a path's bare file name without its extension, lower case, so the
 * folder it sat in does not matter. `tests/stock-aliases.test.ts` fails if a
 * target is not in the library at `KICAD_LIBRARY_RELEASE`, so an entry cannot
 * rot into a silent miss.
 */
const STOCK_ALIASES: Record<string, string> = {
  // Chip resistors: KiCad 4 and 5 named them by the imperial code alone.
  r_0402: "Resistor_SMD.3dshapes/R_0402_1005Metric",
  r0402: "Resistor_SMD.3dshapes/R_0402_1005Metric",
  r_0603: "Resistor_SMD.3dshapes/R_0603_1608Metric",
  r0603: "Resistor_SMD.3dshapes/R_0603_1608Metric",
  r_0805: "Resistor_SMD.3dshapes/R_0805_2012Metric",
  r0805: "Resistor_SMD.3dshapes/R_0805_2012Metric",
  r_1206: "Resistor_SMD.3dshapes/R_1206_3216Metric",
  r1206: "Resistor_SMD.3dshapes/R_1206_3216Metric",
  // Chip capacitors, the same.
  c_0402: "Capacitor_SMD.3dshapes/C_0402_1005Metric",
  c0402: "Capacitor_SMD.3dshapes/C_0402_1005Metric",
  c_0603: "Capacitor_SMD.3dshapes/C_0603_1608Metric",
  c0603: "Capacitor_SMD.3dshapes/C_0603_1608Metric",
  c_0805: "Capacitor_SMD.3dshapes/C_0805_2012Metric",
  c0805: "Capacitor_SMD.3dshapes/C_0805_2012Metric",
  c_1206: "Capacitor_SMD.3dshapes/C_1206_3216Metric",
  c1206: "Capacitor_SMD.3dshapes/C_1206_3216Metric",
  c_2220: "Capacitor_SMD.3dshapes/C_2220_5750Metric",
  c2220: "Capacitor_SMD.3dshapes/C_2220_5750Metric",
  // Chip LEDs. A colour in the name (Olimex writes `LED_0603_B` and `_O`) is
  // the part's colour, not its shape, and the library has one body per package.
  led_0603: "LED_SMD.3dshapes/LED_0603_1608Metric",
  led_0805: "LED_SMD.3dshapes/LED_0805_2012Metric",
  "led-5mm": "LED_THT.3dshapes/LED_D5.0mm",
  led_5mm: "LED_THT.3dshapes/LED_D5.0mm",
  // Small-outline transistor packages.
  sot23: "Package_TO_SOT_SMD.3dshapes/SOT-23",
  "sot-23": "Package_TO_SOT_SMD.3dshapes/SOT-23",
  cms_sot23: "Package_TO_SOT_SMD.3dshapes/SOT-23",
  sot223: "Package_TO_SOT_SMD.3dshapes/SOT-223",
  "sot-223": "Package_TO_SOT_SMD.3dshapes/SOT-223",
  // Small-outline ICs. SO-8 is the narrow-body 3.9 mm SOIC wherever it is written that way.
  "so-8": "Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm",
  so8: "Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm",
  // `Diodes_SMD` was renamed `Diode_SMD`, and its SMA model lost the suffix.
  sma_handsoldering: "Diode_SMD.3dshapes/D_SMA",
  d_sma_handsoldering: "Diode_SMD.3dshapes/D_SMA",
}

/** A colour letter on a chip LED (`LED_0603_B`) names the part, not the package, so it comes off before the lookup. */
const LED_COLOUR = /^(led_\d{4})_[a-z]{1,2}$/

/**
 * The stock model a legacy or foreign package name means, or null when the
 * name is not one this table knows or the library no longer has its target.
 */
export function aliasStockModel(path: string): { id: string; name: string } | null {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? ""
  const stem = file.replace(/\.[^.]*$/, "").toLowerCase()
  const target = STOCK_ALIASES[stem] ?? STOCK_ALIASES[LED_COLOUR.exec(stem)?.[1] ?? ""]
  if (!target) return null
  const [library, name] = target.split("/")
  if (!stockModelExists(library, name)) return null
  const path3d = `${library}/${name}.step`
  return KICAD_MODEL_PATH.test(path3d) ? { id: `${KICAD_LIBRARY_RELEASE}/${path3d}`, name } : null
}

/** Every alias target, for the test that holds them to being real files of the library. */
export const STOCK_ALIAS_TARGETS = Object.values(STOCK_ALIASES)

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
      } else {
        const id = s ? stockModelId(model.path) : null
        const near = !id && s ? nearestStockModel(model.path) : null
        // The name under another spelling, which is the only way a path from
        // outside the stock library resolves to one (`STOCK_ALIASES`).
        const alias = !id && !near ? aliasStockModel(model.path) : null
        if (!id && !near && !alias) {
          drop(
            s
              ? `KiCad's 3D library at release ${KICAD_LIBRARY_RELEASE} has no ${s.library}/${s.name}.step, nor one of a nearby name (the libraries were renamed after KiCad 5), so the parts index cannot serve it.`
              : "It is not a model of KiCad's stock library, and the file it names was not among the files imported.",
          )
        } else if (plan.kept) drop("The editor holds one 3D model per part and land, and this footprint has another one.")
        else if (id) plan.kept = { model, id }
        else if (near) plan.kept = { model, id: near.id, nearest: near.name }
        else plan.kept = { model, id: alias!.id, nearest: alias!.name }
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
