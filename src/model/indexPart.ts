import type { PartIndexPart } from "@cherryblossom/api-contract"
import { buildCustomPart, CUSTOM_CATEGORIES, customPartId, customPartProblems, DEFAULT_REF_PREFIX } from "./customParts"
import { registerProjectFootprints } from "./footprints"
import { registerPart } from "./library"
import { kicadModel, modelAssignment, setModel, supplierModel } from "./models3d"
import { landForSupplierPart, supplierPins } from "./supplier/build"
import { supplierModelOnLand } from "./supplier/model"
import type { CustomPartSpec, FootprintDef, Model3D, PartCategory, PartDatabaseSource, Project } from "./types"

// Parts the parts index stores whole (KiCad's libraries) as project parts.
// Their pins and land are in the supplier's shapes, so a part is built the way a supplier's is: its
// pins by role, its land as a project land pattern.

/** A land's name part for a stored part: its key at the source as a slug, so two parts never share a land. */
export const indexLandKey = (part: Pick<PartIndexPart, "source" | "sourceKey">) =>
  `${part.source}_${part.sourceKey}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)

/** Where a project part made from this stored part says it came from. */
export function indexOrigin(part: PartIndexPart): PartDatabaseSource {
  const p = part.provenance
  return {
    origin: part.source,
    key: part.sourceKey,
    ...(p.release && { release: p.release }),
    ...(p.footprint && { footprint: p.footprint }),
    licence: p.licence,
    attribution: p.attribution,
  }
}

export interface IndexDraft {
  draft: Omit<CustomPartSpec, "id">
  /** The project land pattern the part sits on, when it isn't a footprinter name. */
  land: FootprintDef | null
  /** The real 3D model the part is drawn with on that land, when the index stores one and it sits on it. */
  model: Model3D | null
}

const categoryOf = (part: PartIndexPart): PartCategory =>
  (CUSTOM_CATEGORIES as string[]).includes(part.category ?? "") ? (part.category as PartCategory) : "ICs"

/** A stored part as the spec a project keeps. */
export function draftFromIndexPart(part: PartIndexPart): IndexDraft | { error: string } {
  const category = categoryOf(part)
  const chosen = landForSupplierPart({ land: part.land, package: part.package, lcsc: indexLandKey(part) })
  if (!chosen) return { error: `${part.mpn} has no land pattern` }
  if (!part.pins.length) return { error: `${part.mpn} has no pins` }
  const props: Record<string, string> = { mpn: part.mpn }
  if (part.manufacturer) props.manufacturer = part.manufacturer
  if (part.datasheet) props.datasheet = part.datasheet
  if (part.lcsc) props.lcsc = part.lcsc
  const keywords = [...new Set(part.keywords)].slice(0, 24)
  const draft: Omit<CustomPartSpec, "id"> = {
    name: part.mpn,
    description: part.description || part.mpn,
    category,
    refPrefix: part.refPrefix || DEFAULT_REF_PREFIX[category],
    footprint: chosen.footprint,
    pins: supplierPins(
      part.pins,
      part.pins.map((pin) => ({ number: pin.number, name: pin.name, kind: pin.kind, side: pin.side })),
    ),
    props,
    valueProp: "mpn",
    ...(keywords.length && { keywords }),
    source: { pins: "database", land: chosen.matched ? "checked" : "database", database: indexOrigin(part) },
  }
  return { draft, land: chosen.def, model: modelOf(part, chosen) }
}

/**
 * The stored 3D model as the document keeps it. KiCad's is placed on the footprint's own land. A
 * supplier's is placed on the supplier's land: when the land was swapped for a footprinter name
 * (a resistor's `0603`), it follows the pads there, or is left out when they don't match.
 */
function modelOf(part: PartIndexPart, chosen: { footprint: string; def: FootprintDef | null }): Model3D | null {
  const m = part.model3d
  if (!m) return null
  if (m.source === "kicad") return kicadModel(m)
  if (chosen.def) return supplierModel(m.model, part.provenance.attribution)
  return supplierModelOnLand(m.model, part.land, part.provenance.attribution, chosen.footprint)
}

/**
 * The project with the part added, or what stops it. The land pattern is registered first, as
 * `create_part` does, because the part's own check needs to resolve it. A part already in the
 * project (the same drawing placed before) is reused rather than added twice, and its model is
 * left as it is: a part that has none there was taken back to its generated body on purpose.
 */
export function addDraftToProject(project: Project, built: IndexDraft): { project: Project; spec: CustomPartSpec; added: boolean } | { error: string } {
  if (built.land) registerProjectFootprints({ footprints: [built.land] })
  const problems = customPartProblems({ ...built.draft, id: "" })
  if (problems.length) return { error: `Can't make ${built.draft.name}: ${problems.join("; ")}` }
  const spec: CustomPartSpec = { id: customPartId(built.draft), ...built.draft }
  const existing = project.parts?.find((s) => s.id === spec.id)
  if (existing) return { project, spec: existing, added: false }
  registerPart(buildCustomPart(spec))
  const land = built.land
  const footprints = land && !project.footprints?.some((f) => f.name === land.name) ? [...(project.footprints ?? []), land] : project.footprints
  return { project: withModel({ ...project, parts: [...(project.parts ?? []), spec], footprints, updatedAt: Date.now() }, spec, built.model), spec, added: true }
}

/** A new part's model on its footprint, unless it has one already (a model kept from before, say). */
const withModel = (project: Project, spec: CustomPartSpec, model: Model3D | null): Project =>
  model && !modelAssignment(project, spec.id, spec.footprint) ? setModel(project, spec.id, spec.footprint, model) : project
