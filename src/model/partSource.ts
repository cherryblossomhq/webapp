import type { CustomPartSpec, PartSource } from "./types"

// Where a project part came from, as the line the Inspector shows under its description. The same
// provenance the copilot reads (`describeSource` in `ai/partTools.ts`), in words for the person
// using the part, with the credit its data asks for: KiCad's libraries are CC BY-SA 4.0 and ask to
// be credited wherever their data is shown, and the supplier records the database kept (EasyEDA's)
// ask for their own credit.

export interface SourceLine {
  /** The short name of the source: "KiCad library", "LCSC C6186", "From memory". */
  label: string
  /** What else is known: the library part and release, how many drawings agree. */
  detail: string
  /** The credit and licence the data asks for; absent for data that asks for none here. */
  credit?: string
}

const CONFIDENCE: Record<string, string> = {
  curated: "pins checked by hand",
  consensus: "supplier drawings agree",
  single_source: "one supplier drawing",
  disputed: "supplier drawings disagree",
}

export function partSourceLine(spec: CustomPartSpec | undefined): SourceLine | null {
  const s = spec?.source
  if (!spec) return null
  if (!s || s.pins === "memory") {
    // A memory part a check settled says so, as Checks does (`partFindings`).
    const check = s?.check
    const against = `LCSC ${check?.lcsc ?? "supplier data"}`
    if (check?.verdict === "agrees") return { label: "From memory", detail: `Checked against ${against}: it agrees.` }
    if (check?.verdict === "renamed") return { label: "From memory", detail: `Checked against ${against}: it agrees, under the supplier's pin names.` }
    if (check?.verdict === "contradicted") {
      return { label: "From memory", detail: `Contradicted by ${against}${check.findings[0] ? `: ${check.findings[0]}` : "."}` }
    }
    return { label: "From memory", detail: s?.note ?? "Pins and footprint not checked against a supplier." }
  }
  const line = builtLine(s)
  // A supplier's record that disagrees with the drawing is said wherever the drawing came from.
  if (line && s.check?.verdict === "contradicted") return { ...line, detail: `${line.detail}. Disagrees with ${s.check.lcsc ? `LCSC ${s.check.lcsc}` : "the supplier's records"}` }
  return line
}

/** The source of a part built from data: the database's KiCad or supplier record, or a supplier's own. */
function builtLine(s: PartSource): SourceLine | null {
  const d = s.database
  if (d) {
    const credit = [d.attribution, d.licence && `Licence: ${d.licence}.`].filter(Boolean).join(" ") || undefined
    if (d.origin === "kicad") return { label: "KiCad library", detail: `${d.key}${d.release ? `, release ${d.release}` : ""}`, credit }
    return { label: `LCSC ${d.key}`, detail: "A supplier record the parts database kept", credit }
  }
  if (s.supplier) {
    return { label: `LCSC ${s.supplier.lcsc}`, detail: CONFIDENCE[s.supplier.confidence] ?? "supplier data", ...(s.supplier.attribution && { credit: s.supplier.attribution }) }
  }
  return null
}
