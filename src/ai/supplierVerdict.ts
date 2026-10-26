import { checkAgainstSupplier } from "../model/supplier/verify"
import type { CustomPartSpec, PartSource } from "../model/types"
import { resolvePartName } from "./partLookup"
import type { SupplierPartsSource } from "./supplierParts"

// What the supplier says about a project part's drawing, in one place: verify_parts, create_part
// database_id and the library panel's check of a KiCad part all ask it, so a part gets the same
// verdict whoever asks.

export type PartCheckResult = NonNullable<PartSource["check"]>

/**
 * The supplier's verdict on a part: its record by the part's LCSC number when it has one, else what
 * its name resolves to, with the drawing's pins and footprint narrowing the package first (so a
 * KiCad SOT-223 is compared with LCSC's SOT-223, not with a SOT-89 its pins happen to fit). `lands`
 * compares the drawn footprint pad by pad too: right for a part drawn from memory, wrong for a
 * stored part's own land, which a supplier draws with other pads for the same package. A lookup
 * that failed is `failed`, never a verdict.
 */
export async function supplierVerdict(
  source: SupplierPartsSource,
  spec: Pick<CustomPartSpec, "name" | "pins" | "footprint" | "props">,
  { lands, signal }: { lands: boolean; signal?: AbortSignal },
): Promise<{ result: PartCheckResult } | { failed: string }> {
  const at = new Date().toISOString()
  const pins = spec.pins.map((p) => ({ number: p.number, name: p.name }))
  const lcsc = spec.props.lcsc?.trim().toUpperCase()
  let part = null
  if (lcsc) {
    try {
      part = await source.part(lcsc, signal)
    } catch (e) {
      if (signal?.aborted) throw e
    }
  }
  if (!part) {
    const found = await resolvePartName(source, spec.props.mpn || spec.name, { pins, footprint: spec.footprint }, signal)
    if (found.kind === "failed") return { failed: found.text }
    if (found.kind === "ambiguous") return { result: { at, verdict: "ambiguous", findings: [found.text] } }
    // The drawn pins contradict every supplier part the name could mean: a wrong part.
    if (found.kind === "contradicted") return { result: { at, lcsc: found.candidate.lcsc, verdict: "contradicted", findings: found.briefs } }
    if (found.kind === "different") return { result: { at, verdict: "different_part", findings: [`${found.note[0].toUpperCase()}${found.note.slice(1)}.`] } }
    if (found.kind === "none") return { result: { at, verdict: "no_record", findings: [found.text] } }
    part = found.part
  }
  const c = checkAgainstSupplier({ pins, footprint: lands ? spec.footprint : null }, part)
  const verdict: PartCheckResult["verdict"] = c.refusals.length ? "contradicted" : c.pins?.verdict === "renamed" || c.notes.length ? "renamed" : "agrees"
  // Short lines: they are shown in the Checks panel as they are.
  return { result: { at, lcsc: part.lcsc, verdict, findings: c.refusals.length ? c.briefs : c.notes } }
}
