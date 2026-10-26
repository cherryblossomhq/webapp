import { withPartChecks } from "../ai/partTools"
import type { SupplierPartsSource } from "../ai/supplierParts"
import { supplierVerdict, type PartCheckResult } from "../ai/supplierVerdict"
import type { CustomPartSpec, Project } from "./types"

// A KiCad part placed from the library panel is compared with the supplier's record of the same
// number in the background, so a drawing that disagrees with the real part (a supply on a ground
// pin) shows up as an error in Checks without anyone asking. Parts from the supplier's own record
// (EasyEDA) were built from it and are not compared with themselves.

export interface PlacedPartCheck {
  source: SupplierPartsSource | null
  spec: CustomPartSpec
  /** The project the part was added to. */
  projectId: string
  /** The project open right now, or null when none is. */
  open: () => Project | null
  /** Writes the verdict into the project, saved but not an undo step. */
  record: (edit: (p: Project) => Project) => void
  signal?: AbortSignal
}

/**
 * Asks the supplier for its verdict (`supplierVerdict`, what verify_parts and create_part ask, by pins
 * only, since a KiCad land is drawn with other pads than a supplier's) and records it on the part,
 * when the project is still the open one. The part may have been undone meanwhile: the verdict
 * still goes to `record`, which writes it into the snapshots Redo brings back (the store's `patch`),
 * so a part redone is not a part never checked. A lookup that failed records `pending`, so
 * verify_parts and the Checks button take it up once the supplier is back. Answers what was
 * recorded, or null when nothing was: a part that isn't KiCad's or was checked already, or a project
 * that closed or changed meanwhile. Never throws.
 */
export async function checkPlacedPart({ source, spec, projectId, open, record, signal }: PlacedPartCheck): Promise<PartCheckResult | null> {
  if (!source || spec.source?.database?.origin !== "kicad" || spec.source.check) return null
  let result: PartCheckResult
  try {
    const got = await supplierVerdict(source, spec, { lands: false, signal })
    result = "failed" in got ? { at: new Date().toISOString(), verdict: "pending", findings: [got.failed] } : got.result
  } catch {
    return null
  }
  if (signal?.aborted) return null
  const now = open()
  if (!now || now.id !== projectId) return null
  record((p) => withPartChecks(p, new Map([[spec.id, result]])))
  return result
}
