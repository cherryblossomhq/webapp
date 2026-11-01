import { computeConnectivity } from "./connectivity"
import { buildCustomPart, customPartId, customPartProblems } from "./customParts"
import { registerProjectFootprints } from "./footprints"
import { schematicPins } from "./instances"
import { findPart, registerPart, unitTwinId } from "./library"
import { schematicEditProblems } from "./merges"
import { modelAssignment, setModel } from "./models3d"
import { removeItems } from "./ops"
import type { Guard } from "./schematicEdit"
import type { ComponentInstance, CustomPartSpec, Model3D, PartDef, PartSource, Project } from "./types"

// The project's own parts as a library the user keeps, as Altium's project library is: which
// components each part is placed as, taking out the parts a project no longer needs, and editing
// one, every component placed from it following. Pure functions on the project; the library panel
// and the part editor (`panels/PartEditor.tsx`) commit what they return as one undo step.

/** What the part editor changes: everything in a spec but its id, which follows from the rest, and its provenance, which follows from what changed. */
export type PartDraft = Omit<CustomPartSpec, "id" | "source">

/** The part a component stands for: a lone unit is placed as its part's `@sub` twin. */
const partOf = (c: Pick<ComponentInstance, "partId">) => (c.partId.endsWith("@sub") ? c.partId.slice(0, -4) : c.partId)

/** The components placed from a project part, its other units included. */
export function partUsers(project: Pick<Project, "components">, partId: string): ComponentInstance[] {
  return project.components.filter((c) => partOf(c) === partId)
}

/** The project's parts that no component is placed from. */
export function unusedParts(project: Pick<Project, "parts"> & { components: Pick<ComponentInstance, "partId">[] }): CustomPartSpec[] {
  const used = new Set(project.components.map(partOf))
  return (project.parts ?? []).filter((s) => !used.has(s.id))
}

/**
 * The land patterns, symbol drawings and 3D models that only the parts `gone` named, dropped: a
 * project keeps what something in it still uses, and nothing else of a part it no longer has.
 */
function withoutLeftovers(project: Project, gone: CustomPartSpec[]): Project {
  const parts = project.parts ?? []
  const ids = new Set(parts.map((s) => s.id))
  const goneIds = new Set(gone.map((s) => s.id).filter((id) => !ids.has(id)))
  const named = new Set([...parts.map((s) => s.footprint), ...project.components.map((c) => c.footprint)])
  const lands = new Set(gone.map((s) => s.footprint).filter((f) => !named.has(f)))
  const drawn = new Set(parts.flatMap((s) => (s.drawing ? [s.drawing] : [])))
  const drawings = gone.flatMap((s) => (s.drawing && !drawn.has(s.drawing) ? [s.drawing] : []))
  const placed = new Set(project.components.map((c) => `${partOf(c)}|${c.footprint}`))
  const footprints = project.footprints?.filter((f) => !lands.has(f.name))
  const models = project.models?.filter((m) => !goneIds.has(m.part) && (!lands.has(m.footprint) || placed.has(`${m.part}|${m.footprint}`)))
  let symbols = project.symbols
  if (symbols && drawings.length) {
    symbols = { ...symbols }
    for (const key of drawings) delete symbols[key]
  }
  return {
    ...project,
    ...(project.footprints && { footprints: footprints?.length ? footprints : undefined }),
    ...(project.models && { models: models?.length ? models : undefined }),
    ...(project.symbols && { symbols: symbols && Object.keys(symbols).length ? symbols : undefined }),
  }
}

/**
 * Take parts out of the project, with every component placed from them (as deleting those
 * components does: their blocks and the nets named after their pins follow), their 3D models, and
 * the land patterns and symbol drawings nothing else in the project names.
 */
export function removeParts(project: Project, ids: Iterable<string>): Project {
  const wanted = new Set(ids)
  const gone = (project.parts ?? []).filter((s) => wanted.has(s.id))
  if (!gone.length) return project
  const users = gone.flatMap((s) => partUsers(project, s.id).map((c) => c.id))
  const cleared = users.length ? removeItems(project, { components: users }) : project
  const parts = (cleared.parts ?? []).filter((s) => !wanted.has(s.id))
  return withoutLeftovers({ ...cleared, parts: parts.length ? parts : undefined, updatedAt: Date.now() }, gone)
}

/** A spec's fields in one order, its optional ones left out when empty, so a draft saved unchanged is the same part and two edits that agree make one id. */
export function normalizeDraft(d: PartDraft): PartDraft {
  const props: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.props)) if (k.trim() && v.trim()) props[k.trim()] = v.trim()
  const keywords = (d.keywords ?? []).map((k) => k.trim()).filter(Boolean)
  const padAlias = Object.fromEntries(Object.entries(d.padAlias ?? {}).filter(([pad, pin]) => pad.trim() && pin.trim()))
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    category: d.category,
    refPrefix: d.refPrefix.trim(),
    footprint: d.footprint.trim(),
    pins: d.pins.map((p) => ({ ...p, number: p.number.trim(), name: p.name.trim() })),
    ...(d.symbol && { symbol: d.symbol }),
    ...(d.drawing !== undefined && { drawing: d.drawing }),
    props,
    // Kept whether or not the part gives it a default: a part brought in from KiCad shows each component's own `value`.
    ...(d.valueProp?.trim() && { valueProp: d.valueProp.trim() }),
    ...(Object.keys(padAlias).length && { padAlias }),
    ...(keywords.length && { keywords }),
  }
}

/** The spec as the part editor starts from it. */
export function draftOf(spec: CustomPartSpec): PartDraft {
  const { id: _id, source: _source, ...draft } = spec
  return normalizeDraft(draft)
}

/** A value's JSON with its keys sorted, so two drafts compare by what they say rather than the order they say it in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  )
}

/** Whether a draft says anything its spec doesn't. */
export const draftChanged = (spec: CustomPartSpec, draft: PartDraft) => canonical(draftOf(spec)) !== canonical(normalizeDraft(draft))

const pinMap = (pins: PartDraft["pins"]) => canonical([...pins].map((p) => [p.number, p.name]).sort(([a], [b]) => a.localeCompare(b)))

/** Whether the pins (their numbers and names) or the land (the footprint and the pads shared between pins) of a part differ. */
export function physicalChanges(before: PartDraft, after: PartDraft): { pins: boolean; land: boolean } {
  return {
    pins: pinMap(before.pins) !== pinMap(after.pins),
    land: before.footprint !== after.footprint || canonical(before.padAlias ?? {}) !== canonical(after.padAlias ?? {}),
  }
}

/**
 * A part's provenance after the user edits it. Its name, description, parameters and symbol are the
 * user's to change and say nothing about where its pins and land came from. Its pins or land
 * changed by hand are the user's (`user`), as a part imported from their own files is their word
 * for the part, except on a part made from memory, which stays unverified until a supplier settles
 * it. A check or a datasheet reading of what was there before no longer speaks for the part.
 */
export function editedSource(source: PartSource | undefined, changed: { pins: boolean; land: boolean }): PartSource | undefined {
  if (!source || (!changed.pins && !changed.land)) return source
  const out: PartSource = { ...source }
  if (changed.pins && source.pins !== "memory") out.pins = "user"
  if (changed.land && source.land !== "memory") out.land = "user"
  delete out.check
  if (changed.pins) delete out.datasheet
  return out
}

export type PartEditResult =
  | { ok: true; project: Project; id: string; /** Components whose pins are now elsewhere on the sheet: their wiring is worth a look. */ moved: string[] }
  | { ok: false; problems: string[] }

/** Whether two models are the same file placed the same way. */
export const sameModel = (a: Model3D | null, b: Model3D | null) => canonical(a) === canonical(b)

/** A part's model on a footprint set, or the project itself when it already has that one. */
function withModel(project: Project, part: string, footprint: string, model: Model3D | null): Project {
  return sameModel(modelAssignment(project, part, footprint), model) ? project : setModel(project, part, footprint, model)
}

/**
 * Save an edit of a project part. Its id follows from its definition, so the edited part is a new
 * spec in the old one's place in the list, and every component placed from it switches over: to
 * its footprint too, unless it was given another, and to its parameters where it still has the
 * old ones (a value set on one component stays). Its 3D models follow it while the footprint
 * stays; `model`, when given, is the one it has on its footprint after the edit (null for none of
 * its own). Refused with the reasons when the spec can't be built, or when its pins would
 * land on the wires of other nets on the sheet.
 */
export function editPart(project: Project, id: string, draft: PartDraft, o: Guard & { model?: Model3D | null } = {}): PartEditResult {
  const old = project.parts?.find((s) => s.id === id)
  if (!old) return { ok: false, problems: ["This part is no longer in the project: someone may have changed or removed it."] }
  const next = normalizeDraft(draft)
  if (!draftChanged(old, next)) return { ok: true, project: o.model === undefined ? project : withModel(project, id, old.footprint, o.model), id, moved: [] }
  const source = editedSource(old.source, physicalChanges(draftOf(old), next))
  const definition: Omit<CustomPartSpec, "id"> = { ...next, ...(source && { source }) }
  registerProjectFootprints(project)
  const problems = customPartProblems({ ...definition, id: "" }, project.symbols)
  if (problems.length) return { ok: false, problems }
  const spec: CustomPartSpec = { id: customPartId(definition), ...definition }
  let part: PartDef
  try {
    part = buildCustomPart(spec, project.symbols)
  } catch (e) {
    return { ok: false, problems: [e instanceof Error ? e.message : String(e)] }
  }
  const oldPart = findPart(id)
  registerPart(part)

  // A parameter a component still has at the part's old default follows the part; one set on the component stays.
  const was = oldPart?.defaultProps ?? old.props
  const now = part.defaultProps
  const follow = (props: Record<string, string>) => {
    const out = { ...props }
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (props[key] !== was[key] || now[key] === was[key]) continue
      if (now[key] === undefined) delete out[key]
      else out[key] = now[key]
    }
    return canonical(out) === canonical(props) ? props : out
  }
  const footprintChanged = old.footprint !== spec.footprint
  const switched: string[] = []
  const components = project.components.map((c) => {
    if (partOf(c) !== id) return c
    switched.push(c.id)
    const twin = c.partId !== id
    return {
      ...c,
      partId: twin ? unitTwinId(spec.id) : spec.id,
      props: follow(c.props),
      ...(c.footprint === old.footprint && !twin && { footprint: spec.footprint }),
    }
  })
  // An edit that comes out as a part the project already has (the same definition) is that part.
  const exists = spec.id !== id && project.parts!.some((s) => s.id === spec.id)
  const parts = exists ? project.parts!.filter((s) => s.id !== id) : project.parts!.map((s) => (s.id === id ? spec : s))
  const models = project.models
    ?.filter((m) => !(m.part === id && footprintChanged && m.footprint === old.footprint))
    .map((m) => (m.part === id && !exists ? { ...m, part: spec.id } : m))
  const kept = withoutLeftovers({ ...project, parts, components, ...(project.models && { models: models?.length ? models : undefined }), updatedAt: Date.now() }, [old])
  const edited = o.model === undefined ? kept : withModel(kept, spec.id, spec.footprint, o.model)

  if (!switched.length) return { ok: true, project: edited, id: spec.id, moved: [] }
  const conn = o.conn ?? computeConnectivity
  const joined = schematicEditProblems(project, edited, conn(project), conn(edited), new Set())
  if (joined.length) return { ok: false, problems: [`With its new symbol, ${joined.join("; ")}. Move the parts or their wires first.`] }
  const where = (c: ComponentInstance, p = findPart(c.partId)) => canonical(schematicPins(c, p).map((w) => [w.pin, w.pos.x, w.pos.y]))
  const moved = switched.flatMap((cid) => {
    const before = project.components.find((c) => c.id === cid)!
    const after = edited.components.find((c) => c.id === cid)!
    const prior = before.partId === id ? oldPart : findPart(before.partId)
    return prior && where(before, prior) !== where(after) ? [after.ref] : []
  })
  return { ok: true, project: edited, id: spec.id, moved: [...new Set(moved)] }
}
