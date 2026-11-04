/**
 * Where the 3D models parts come with are fetched from: the supplier's (`Model3D` with `source:
 * "supplier"`) and KiCad's (`source: "kicad"`, the built-in parts' included). They stay where they
 * were published and are fetched by id; the files a user adds are `ModelFileStore`'s
 * (`store/modelFiles.ts`). The website's is `/api/v1/parts/models`.
 *
 * Apart from `SupplierPartsSource` on purpose: looking parts up is editing, and needs an account,
 * where drawing a board's parts is looking at it, which someone signed out on a project shared by
 * link does too. So a host gives this one wherever it shows a project, and each fetch names the
 * project it is drawn on, which is how the host lets someone signed out have it.
 *
 * Failures throw an Error whose message is a sentence for the user. Without a source, as in the
 * harness, those parts show only their pads.
 */
export interface PartModelSource {
  /**
   * The supplier's model of a part, by the model id its record names (`SupplierPart.model3d.id`):
   * `obj`, a mesh, to draw, and `step`, exact, to export.
   */
  supplier(id: string, format: "obj" | "step", signal?: AbortSignal, projectId?: string): Promise<ArrayBuffer>
  /** A KiCad 3D model's STEP file, by `<release>/<path>` (`PartIndexKicadModel.id`). */
  kicad(id: string, signal?: AbortSignal, projectId?: string): Promise<ArrayBuffer>
}

let source: PartModelSource | null = null

export function connectPartModels(next: PartModelSource | null | undefined) {
  source = next ?? null
}

export const partModels = () => source
