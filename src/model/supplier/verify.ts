import type { SupplierPart } from "@cherryblossom/api-contract"
import { getFootprint, isValidFootprint } from "../footprints"
import { landPads, packageFamily, supplierLandPads } from "./build"
import { footprintNameProblem } from "./footprintGuard"
import { compareLands, describeLand, summarizeLand, type LandComparison } from "./land"
import { comparePins, numberRange, type DrawnPin, type PinComparison } from "./pinmap"

// A drawing (pins and a footprint) checked against a supplier record. One function for both
// places that need it: create_part, before a part exists, and the check of parts that already do.

export interface SupplierCheck {
  pins: PinComparison | null
  land: LandComparison | null
  /** Sentences that mean the drawing is wrong, each with its pin numbers or millimetres. */
  refusals: string[]
  /** The same, one short line each, for a list such as the Checks panel. */
  briefs: string[]
  /** Sentences that only note a difference: spellings, polarity, pins the drawing left out. */
  notes: string[]
}

/**
 * `landLabel` names a land given whole (create_part's `land`) in the sentences, where its registered
 * name would mean nothing to whoever gave it.
 */
export function checkAgainstSupplier(drawn: { pins: DrawnPin[] | null; footprint: string | null; landLabel?: string }, part: SupplierPart): SupplierCheck {
  const refusals: string[] = []
  const briefs: string[] = []
  const notes: string[] = []
  let pins: PinComparison | null = null
  let land: LandComparison | null = null

  if (drawn.pins?.length && part.pins) {
    pins = comparePins(drawn.pins, part.pins)
    if (pins.verdict === "contradicted") {
      refusals.push(
        `${pins.fatal.length} pin${pins.fatal.length === 1 ? "" : "s"} contradict LCSC ${part.lcsc} (${part.mpn}): ` +
          `${pins.fatal.slice(0, 6).map((f) => f.text).join("; ")}${pins.fatal.length > 6 ? `; and ${pins.fatal.length - 6} more` : ""}.`,
      )
      briefs.push(
        `${pins.fatal.length} pin${pins.fatal.length === 1 ? "" : "s"} wrong: ${pins.fatal.slice(0, 2).map((f) => f.text).join("; ")}${pins.fatal.length > 2 ? `; and ${pins.fatal.length - 2} more` : ""}.`,
      )
    }
    if (pins.polaritySwapped) {
      notes.push(`The supplier numbers this part the other way round: pin 1 is its ${part.pins.find((p) => p.number === "1")?.name ?? "first"} end.`)
    }
    if (pins.renamed.length) {
      notes.push(
        `${pins.renamed.length} pin name${pins.renamed.length === 1 ? " differs" : "s differ"} from the supplier's: ` +
          `${pins.renamed.slice(0, 6).map((f) => `pin ${f.number} is ${f.vendor}, not ${f.drawn}`).join("; ")}${pins.renamed.length > 6 ? "; ..." : ""}.`,
      )
    }
    if (pins.missing.length) {
      notes.push(`The supplier's part also has pin${pins.missing.length === 1 ? "" : "s"} ${pins.missing.map((p) => `${p.number}:${p.name}`).join(", ")}.`)
    }
  } else if (drawn.pins?.length && !part.pins && part.land) {
    // No named pinout to compare: the count, at least, has to fit the land.
    const pads = new Set(part.land.pads.filter((p) => p.number).map((p) => p.number))
    const extra = drawn.pins.filter((p) => !pads.has(p.number))
    if (extra.length) {
      const text = `LCSC ${part.lcsc}'s land has pads ${numberRange([...pads].map((n) => ({ number: n })))}; pin${extra.length === 1 ? "" : "s"} ${extra.map((p) => p.number).join(", ")} ${extra.length === 1 ? "has" : "have"} no pad.`
      refusals.push(text)
      briefs.push(text)
    }
  }

  if (drawn.footprint) {
    const vendor = supplierLandPads(part)
    if (vendor.length && isValidFootprint(drawn.footprint)) {
      land = compareLands(landPads(getFootprint(drawn.footprint).pads), vendor)
      if (!land.ok) {
        const what = drawn.landLabel ?? `Footprint ${drawn.footprint}`
        refusals.push(
          `${what} doesn't fit LCSC ${part.lcsc}'s ${part.package ?? "package"}: ${land.problems.join(" ")} ` +
            `Leave ${drawn.landLabel ? "land" : "footprint"} out to use the supplier's land (${describeLand(land.vendor)}).`,
        )
        briefs.push(`${what} doesn't fit its land: ${land.brief}.`)
      }
    } else if (!vendor.length) {
      const named = footprintNameProblem(drawn.footprint)
      if (named) {
        refusals.push(named)
        briefs.push(named)
      }
    }
  }
  return { pins, land, refusals, briefs, notes }
}

/** The family a footprint name draws, in `packageFamily`'s terms, to match it against a supplier's package. */
export function footprintFamily(footprint: string): string {
  const fp = footprint.trim().toLowerCase()
  const m = fp.match(/^([a-z]+)(\d+)?(?:_(\d)(?![.\d]))?/)
  if (!m) return /^\d{4,5}$/.test(fp) ? fp : "land"
  const [, word, n, sub] = m
  if (word === "sot" && n === "23") return sub ? `sot23_${sub}` : "sot23_3"
  if (word === "msop" || word === "vssop") return `vssop${n ?? ""}`
  if (word === "sop" || word === "soic" || word === "so") return `soic${n ?? ""}`
  if (word === "son") return `dfn${n ?? ""}`
  if (word === "tqfp" || word === "qfp") return `lqfp${n ?? ""}`
  return `${word}${n ?? ""}`
}

/** The family a supplier package is in, with SOT-23's bare and three-lead names made one. */
export function supplierFamily(pkg: string | null): string {
  const f = packageFamily(pkg)
  return f === "sot23" ? "sot23_3" : f
}

/** One line per candidate for a refusal: what each is and how to ask for it. */
export const candidateLine = (c: { lcsc: string; mpn: string; package: string | null; pinCount: number | null; stock: number | null }) =>
  `${c.lcsc} ${c.mpn}, ${c.package ?? "package unknown"}${c.pinCount !== null ? `, ${c.pinCount} pins` : ""}${c.stock !== null ? `, ${c.stock} in stock` : ""}`

export { describeLand, summarizeLand }
