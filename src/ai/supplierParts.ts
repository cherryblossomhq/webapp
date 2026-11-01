import type { DatasheetResponse, DatasheetSection, PartIndexPart, PartIndexSearchResponse, PartSearchResponse, SupplierPart } from "@cherryblossom/api-contract"

// Where the editor gets supplier part data: pins and land patterns from a supplier's records, so
// the copilot builds a part from data instead of from memory. The host provides it, as it does the
// managed-AI session and project storage: the website's is `/api/v1/parts` with the signed-in
// user's token. Without one (the harness, a test) the copilot falls back to memory and says so.

/**
 * The parts index: parts our own database stores (KiCad's libraries now), searched as the user
 * types and placed without a supplier read. The website's is `/api/v1/parts/index/*`.
 */
export interface PartsIndexSource {
  /** Stored parts that answer a part number or a few words, best first; `full` keeps only parts stored whole. */
  search(query: string, options: { limit?: number; full?: boolean }, signal?: AbortSignal): Promise<PartIndexSearchResponse>
  /** One part whole by its index id; null when it isn't stored whole. Failures throw as `part` does. */
  part(id: string, signal?: AbortSignal): Promise<PartIndexPart | null>
  /**
   * A KiCad 3D model's STEP file, by `PartIndexKicadModel.id`. Absent in a host that can't: parts
   * with a KiCad model, the built-in ones included, then show only their pads. Failures throw as `part` does.
   */
  model?(id: string, signal?: AbortSignal): Promise<ArrayBuffer>
}

export interface SupplierPartsSource {
  /** Candidates for a part number or a few words, best first. */
  search(query: string, signal?: AbortSignal): Promise<PartSearchResponse>
  /**
   * One part's pins and land by LCSC number; null when no supplier has that number. Failures
   * throw an Error whose message is a sentence for the user ("Sign in again to look parts up").
   */
  part(lcsc: string, signal?: AbortSignal): Promise<SupplierPart | null>
  /**
   * A few pages of the part's datasheet as text, read by the server from the PDF the supplier
   * links (`read_datasheet`). Absent in a host that can't: the copilot then says so. Failures throw
   * as `part` does, including "no datasheet" for a part whose record links none.
   */
  datasheet?(lcsc: string, request: { section?: DatasheetSection; page?: number; offset?: number }, signal?: AbortSignal): Promise<DatasheetResponse>
  /**
   * The supplier's 3D model of a part, by the model id a part's record names
   * (`SupplierPart.model3d.id`): `obj`, a mesh, to draw, and `step`, exact, to export. Absent in a
   * host that can't: those parts then show only their pads. Failures throw as `part` does.
   */
  model?(id: string, format: "obj" | "step", signal?: AbortSignal): Promise<ArrayBuffer>
  /** The parts index; a host without one leaves it out, and the library panel searches only the built-in library. */
  index?: PartsIndexSource
}

let source: SupplierPartsSource | null = null

export function connectSupplierParts(next: SupplierPartsSource | null | undefined) {
  source = next ?? null
}

export const supplierParts = () => source

/** A failed lookup as the copilot and the user read it. */
export const lookupFailure = (e: unknown) => (e instanceof Error && e.message ? e.message : `The supplier lookup failed: ${String(e)}`)
