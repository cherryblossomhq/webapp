import type { SupplierPart } from "@cherryblossom/api-contract"
import { DEFAULT_REF_PREFIX } from "./customParts"
import { registerProjectFootprints } from "./footprints"
import type { IndexDraft } from "./indexPart"
import { landForSupplierPart, supplierPins } from "./supplier/build"
import { supplierModelOn } from "./supplier/model"
import type { CustomPartSpec, PartCategory } from "./types"

// A supplier's record (LCSC, read through `/api/v1/parts`) as the spec a project keeps, for the
// library panel's "From LCSC" rows. It is what Sakura's `create_part` with `lcsc` builds when it has
// no drawing of its own to compare: the supplier's pins and land, where they came from, and the
// supplier's 3D model on that land. `addDraftToProject` (`model/indexPart.ts`) adds it.

/**
 * The category a record's description points at; the supplier's record has none of its own. A word
 * for the chip itself (regulator, driver, controller, IC) wins over the device it works with: a
 * MOSFET driver is an IC, not a transistor, and an LED driver is not a diode.
 */
function categoryOf(part: SupplierPart): PartCategory {
  const text = `${part.description ?? ""} ${part.mpn}`.toLowerCase()
  if (/\b(resistors?|capacitors?|inductors?|ferrite|crystals?|oscillators?|fuses?)\b/.test(text)) return "Passives"
  if (/\b(regulators?|ldo)\b/.test(text)) return "Power"
  if (/\b(drivers?|controllers?|ics?)\b/.test(text)) return "ICs"
  if (/\b(diodes?|leds?|tvs|zener|rectifiers?|schottky)\b/.test(text)) return "Diodes"
  if (/\b(transistors?|mosfets?|bjt|igbt)\b/.test(text)) return "Transistors"
  if (/\b(regulators?|ldo|converters?|buck|boost|chargers?)\b/.test(text)) return "Power"
  if (/\b(connectors?|headers?|sockets?|receptacles?)\b/.test(text)) return "Connectors"
  if (/\b(switch(es)?|buttons?|relays?)\b/.test(text)) return "Electromechanical"
  if (/\bmodules?\b/.test(text)) return "Modules"
  return "ICs"
}

/** A supplier record as a draft of a project part, with its land and 3D model; or what stops it. */
export function draftFromSupplierPart(part: SupplierPart): IndexDraft | { error: string } {
  let pins: CustomPartSpec["pins"]
  if (part.pins) {
    pins = supplierPins(part.pins)
  } else {
    // A symbol that only numbers its pins is a pinout for a two-pad part (its ends) and nothing bigger.
    const pads = [...new Set((part.land?.pads ?? []).map((p) => p.number).filter(Boolean))]
    if (!pads.length || pads.length > 2) return { error: `LCSC ${part.lcsc} numbers its ${pads.length || "?"} pins without naming them, so there is no pinout to build from.` }
    pins = pads.map((n) => ({ number: n, name: n }))
  }
  const chosen = landForSupplierPart(part)
  if (!chosen) return { error: `LCSC ${part.lcsc} has no land pattern.` }
  const props: Record<string, string> = { mpn: part.mpn }
  if (part.manufacturer) props.manufacturer = part.manufacturer
  if (part.datasheet) props.datasheet = part.datasheet
  props.lcsc = part.lcsc
  const category = categoryOf(part)
  const draft: Omit<CustomPartSpec, "id"> = {
    name: part.mpn,
    description: part.description || part.mpn,
    category,
    refPrefix: DEFAULT_REF_PREFIX[category],
    footprint: chosen.footprint,
    pins,
    props,
    valueProp: "mpn",
    source: {
      pins: "supplier",
      land: chosen.matched ? "checked" : "supplier",
      supplier: {
        lcsc: part.lcsc,
        mpn: part.mpn,
        confidence: part.provenance.confidence,
        vendors: part.provenance.vendors,
        fetchedAt: part.provenance.fetchedAt,
        ...(part.provenance.disputes.length && { disputes: part.provenance.disputes }),
        ...(part.provenance.userUpload && { userUpload: true }),
        ...(part.provenance.attribution && { attribution: part.provenance.attribution }),
      },
    },
  }
  // The model is placed by matching pads with the land it sits on, so the land has to resolve first.
  if (chosen.def) registerProjectFootprints({ footprints: [chosen.def] })
  return { draft, land: chosen.def, model: supplierModelOn(part, chosen.footprint) }
}
