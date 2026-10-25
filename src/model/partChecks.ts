import type { CustomPartSpec, Project } from "./types"

// What the Checks panel and run_checks say about a project's own parts: which ones were built from
// a supplier's data, which the copilot wrote from memory, and which were checked and found wrong.
//
// A part from memory is a warning, not an error: most are right, and the board may be a sketch.
// A part checked against a supplier and contradicted (a supply on a ground pin, a land whose
// pads miss the leads) is an error, because that board is dead whatever else is right with it.
// A part built from a single supplier drawing is not reported: it was built from data, and the
// copilot says how many drawings agreed when it makes the part. Nor is a part placed from the parts
// index (KiCad's libraries): its symbol and footprint were paired pin for pad when it was stored.

export interface PartFinding {
  partId: string
  severity: "error" | "warning"
  message: string
  /** The components that use the part, so the panel can step through them. */
  componentIds: string[]
}

/**
 * A part made from memory that no supplier check has settled: never checked, or only made while
 * the lookup was failing. A part from a supplier's record or the parts index was built from data,
 * and needs one only when its comparison with the supplier is still pending (the lookup failed
 * when it was built or placed).
 */
export const needsCheck = (spec: CustomPartSpec) =>
  (!spec.source || spec.source.pins === "memory" || (spec.source.pins === "database" && spec.source.check?.verdict === "pending")) &&
  (!spec.source?.check || spec.source.check.verdict === "pending")

const isPolarized = (spec: CustomPartSpec) => spec.pins.length === 2 && spec.pins.some((p) => /^(A|K|C|\+|-|ANODE|CATHODE)$/i.test(p.name.trim()))

export function partFindings(project: Project): PartFinding[] {
  const out: PartFinding[] = []
  for (const spec of project.parts ?? []) {
    const users = project.components.filter((c) => c.partId === spec.id)
    if (!users.length) continue
    const refs = users.map((c) => c.ref).join(", ")
    const label = `${refs} (${spec.name})`
    const ids = users.map((c) => c.id)
    const add = (severity: PartFinding["severity"], message: string) => out.push({ partId: spec.id, severity, message, componentIds: ids })
    const src = spec.source
    const check = src?.check

    if (check?.verdict === "contradicted") {
      add("error", `${label} doesn't match LCSC ${check.lcsc ?? "the supplier"}. ${check.findings.slice(0, 2).join(" ")}`)
    } else if (!src || src.pins === "memory") {
      const verified = check?.verdict === "agrees" || check?.verdict === "renamed"
      if (!verified) {
        const why =
          check?.verdict === "no_record"
            ? // "No supplier record for X." is the plain case; a sentence saying records exist (none names pins) is kept.
              /^No supplier record for [^ ]+\.$/.test(check.findings[0] ?? "") || !check.findings[0]
              ? `no supplier record was found for ${spec.name}`
              : `${check.findings[0][0].toLowerCase()}${check.findings[0].slice(1).replace(/\.$/, "")}`
            : check?.verdict === "different_part"
              ? `supplier parts are numbered like ${spec.name} but none has its pin count (${check.findings[0] ?? "other parts"})`
              : check?.verdict === "ambiguous"
                ? `${spec.name} matches several supplier parts (${check.findings[0] ?? "rebuild it from one"})`
                : check?.verdict === "pending"
                  ? `made while the supplier lookup was failing, and not checked since (${check.findings[0] ?? src?.note ?? "run the check again"})`
                  : src?.note
                    ? `made from memory (${src.note})`
                    : "made from memory"
        // Sakura's read of a datasheet is said, and does not settle it: it is not a supplier check.
        const sheet = src?.datasheet ? `; Sakura compared its pins with the datasheet (p.${src.datasheet.pages.join(", ")}, LCSC ${src.datasheet.lcsc}), which is not a supplier check` : ""
        if (spec.pins.length > 2 || isPolarized(spec)) add("warning", `${label}: pinout and footprint not verified against a supplier; ${why}${sheet}`)
        else add("warning", `${label}: footprint ${spec.footprint} not checked against a supplier land; ${why}`)
      }
    } else if (src.supplier) {
      if (src.supplier.confidence === "disputed") {
        add("warning", `${label}: supplier drawings of LCSC ${src.supplier.lcsc} disagree about its pins: ${src.supplier.disputes?.[0] ?? "check the datasheet"}`)
      }
      if (src.supplier.userUpload) {
        add("warning", `${label}: LCSC ${src.supplier.lcsc} is an EasyEDA user's upload, not a catalogue part: check its pinout and land against the datasheet`)
      }
      if (src.land === "memory") {
        add("warning", `${label}: footprint ${spec.footprint} not checked against a supplier land (LCSC ${src.supplier.lcsc} has none)`)
      }
    }

    // A checked land swapped on a component for one nobody checked.
    if (src && src.land !== "memory" && src.land !== "import") {
      for (const c of users) {
        if (c.footprint && c.footprint !== spec.footprint) {
          out.push({
            partId: spec.id,
            severity: "warning",
            message: `${c.ref} (${spec.name}): footprint changed to ${c.footprint}, which wasn't checked against ${src.database ? "its stored land" : "the supplier's land"}`,
            componentIds: [c.id],
          })
        }
      }
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
}
