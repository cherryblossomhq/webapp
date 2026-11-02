import { pointOnSegment, round, samePoint } from "../lib/geometry"
import { uid } from "../lib/id"
import { computeConnectivity, pinKey, type SchematicConnectivity } from "./connectivity"
import { createBlock } from "./blocks"
import { copyDrawings } from "./drawings"
import { withPartsFrom } from "./customParts"
import { withModelsFrom } from "./models3d"
import { rekeyAutoNets } from "./rekeyNets"
import { isSchematicPart, schematicPins } from "./instances"
import { findPart, unitTwinId } from "./library"
import { kicadRulesShown, settleKicadSheet } from "./kicadJoin"
import { moveProblems } from "./merges"
import {
  addComponent,
  cleanupWires,
  dragPlan,
  mirrorComponent,
  moveSchematicItems,
  nextRef,
  partFollowers,
  rotateComponent,
  updateComponent,
  type AddComponentOptions,
} from "./ops"
import { bodyStyleCount, fieldPlaceOf, fieldPlacesOf, unitCount } from "./symbolDrawing"
import { repairUnits } from "./units"
import type { LabelKind, ComponentInstance, FieldPlace, LabelShape, Mirror, NetLabel, Project, Rotation, TextLook, Vec2, Wire } from "./types"

/**
 * The canvas edits that move things without meaning to connect them: turning a part (R, the
 * Inspector), dragging, pasting, duplicating, placing. What goes where a part goes is `ops.ts`'s
 * (`partFollowers`, `dragPlan`, `rotateComponent`); what is wrong with the result is `merges.ts`'s
 * (`moveProblems`). This is where the two meet for the canvas: each edit is built, checked against
 * the sheet it came from, and either returned or refused with a sentence and nothing changed.
 *
 * What is refused is what a person drawing would not mean: two nets that each stand for something
 * (both named, or both unnamed with 2+ pins) joined, a pin cut off its net, a pin left lying on
 * another net's wire. A pin or loose wire meeting an unnamed net, a label naming a wire, a power
 * symbol dropped on a pin or a wire end are drawing, and go through.
 */

/** `note` says what was done differently from what was asked (a turn that went further than a quarter). */
export type EditResult = { ok: true; project: Project; note?: string; inline?: boolean } | { ok: false; message: string; reasons?: string[] }

/** Memoised connectivity for the sheet, when the caller has one (the store's `getConnectivity`). */
export interface Guard {
  conn?: (p: Project) => SchematicConnectivity
}

interface CheckOptions extends Guard {
  /** The edit only adds things: nothing can have been cut off its net. */
  adds?: boolean
  /** Nets of the sheet that the edit cut on purpose (a wire cut to put a part in line). */
  cutOnPurpose?: ReadonlySet<string>
  /** A part was wired in line on a wire. */
  inline?: boolean
}

/** What to do about a problem, from how it is worded in `merges.ts`. */
function adviceFor(problems: string[]): string {
  if (problems.some((p) => p.includes("would sit under the wire"))) return "Cut the wire first, or move it off the wire."
  if (problems.some((p) => p.startsWith("it would join"))) return "Move it off the other part's pins and wires, or join them with the wire tool if you mean to."
  return "Move or turn it where its wires can follow, or delete the wires you mean to drop first."
}

function check(before: Project, after: Project, what: string, o: CheckOptions = {}): EditResult {
  const conn = o.conn ?? computeConnectivity
  const problems = moveProblems(before, after, conn(before), conn(after), new Set(), { lenient: true, netsChange: o.adds, cutAllowed: o.cutOnPurpose })
  if (!problems.length) return { ok: true, project: after, ...(o.inline ? { inline: true } : {}) }
  const shown = problems.slice(0, 3).join("; ") + (problems.length > 3 ? `; and ${problems.length - 3} more` : "")
  return { ok: false, message: `Didn't ${what}: ${shown}. Nothing was changed. ${adviceFor(problems)}`, reasons: problems }
}

const refsOf = (project: Project, ids: string[]) => {
  const refs = ids.map((id) => project.components.find((c) => c.id === id)?.ref).filter(Boolean) as string[]
  return refs.length === 1 ? refs[0] : refs.length ? `${refs.length} parts` : "the selection"
}

// ---------- putting a part in line on a wire ----------

/**
 * A two-pin part dropped with both pins on the middle of one wire is wired in line: the wire is
 * cut at its pins and the stretch under the part is dropped, so the net runs through the part, as
 * drawing it by hand would. Only a part with nothing on its pins, on a wire with nothing else
 * touching that stretch; otherwise it is left to the check, which says to cut the wire first.
 * `cut` are the wires that were cut.
 */
export function spliceInline(project: Project, ids: string[]): { project: Project; cut: string[] } {
  let wires = project.wires
  const cut: string[] = []
  for (const id of ids) {
    const c = project.components.find((x) => x.id === id)
    const pins = c && isSchematicPart(findPart(c.partId)) ? schematicPins(c) : []
    if (pins.length !== 2) continue
    const [a, b] = pins.map((p) => p.pos)
    const free = (p: Vec2) =>
      !wires.some((w) => w.points.some((q) => samePoint(q, p))) &&
      !project.labels.some((l) => samePoint(l, p)) &&
      !project.components.some((x) => x.id !== id && schematicPins(x).some((q) => samePoint(q.pos, p)))
    if (!free(a) || !free(b)) continue
    for (const w of wires) {
      const at = (p: Vec2) => w.points.findIndex((q, i) => i > 0 && pointOnSegment(p, w.points[i - 1], q))
      const ia = at(a)
      const ib = at(b)
      if (ia < 1 || ib < 1) continue
      // Walk from the wire's start: whichever pin comes first ends the first piece.
      const dist = (i: number, p: Vec2) => Math.hypot(p.x - w.points[i - 1].x, p.y - w.points[i - 1].y)
      const aFirst = ia < ib || (ia === ib && dist(ia, a) <= dist(ib, b))
      const [i1, p1, i2, p2] = aFirst ? [ia, a, ib, b] : [ib, b, ia, a]
      const stretch = [p1, ...w.points.slice(i1, i2), p2]
      const touched =
        wires.some((x) => x.id !== w.id && [x.points[0], x.points[x.points.length - 1]].some((q) => stretch.some((s, k) => k > 0 && pointOnSegment(q, stretch[k - 1], s)))) ||
        project.labels.some((l) => stretch.some((s, k) => k > 0 && pointOnSegment(l, stretch[k - 1], s)))
      if (touched) continue
      const first: Wire = { ...w, points: [...w.points.slice(0, i1), p1] }
      const second: Wire = { id: uid("w"), points: [p2, ...w.points.slice(i2)] }
      wires = wires.flatMap((x) => (x.id === w.id ? [first, second] : [x]))
      cut.push(w.id)
      break
    }
  }
  return cut.length ? { project: { ...project, wires, updatedAt: Date.now() }, cut } : { project, cut }
}

/** The nets (of the sheet before) that cutting these wires cut on purpose. */
const netsOfWires = (before: SchematicConnectivity, wires: string[]) => new Set(wires.map((w) => before.wireNet.get(w)).filter(Boolean) as string[])

// ---------- turning ----------

/**
 * The one sentence that says a part went `by` degrees and why 90 would not do. `problems` are
 * the check's clauses, each starting "it would ..." or "<pin> would ...", so each follows "at 90
 * degrees" as it is; the first is the reason, and a list cut short ("...") is worded out.
 */
export function turnNote(ref: string, by: number, problems: string[]): string {
  const reason = (problems[0] ?? "it would change a net").replace(/,? \.\.\.\)/g, ", and others)").replace(/[.;,\s]+$/, "")
  return `Turned ${ref} ${by} degrees instead of 90, because at 90 degrees ${reason}.`
}

/** Turn each of `ids` by `by` degrees, in place; labels of the selection a quarter turn. */
function turnBy(project: Project, ids: { components: string[]; labels: string[] }, by: 90 | 180 | 270, o: Guard): EditResult {
  let next = project
  const carried = new Set<string>()
  for (const id of ids.components) {
    const c = next.components.find((x) => x.id === id)
    if (!c) continue
    for (const l of partFollowers(next, [id]).labels) carried.add(l)
    // A mirrored part's own turn runs the other way: what goes counter-clockwise on screen is a step back in its placement.
    next = rotateComponent(next, id, ((((c.sch.mirror ? c.sch.rot - by : c.sch.rot + by) % 360) + 360) % 360) as Rotation, next === project ? o.conn?.(project) : undefined)
  }
  const turned = new Set(ids.labels.filter((l) => !carried.has(l)))
  if (turned.size) next = { ...next, labels: next.labels.map((l) => (turned.has(l.id) ? { ...l, rot: ((l.rot + 90) % 360) as Rotation } : l)) }
  if (next === project) return { ok: true, project }
  return check(project, settleKicadSheet(project, cleanupWires(next)), `turn ${refsOf(project, ids.components)}`, o)
}

/**
 * Turn the selected parts a quarter turn each, in place, and the selected labels with them. What
 * hangs off a part's pins alone turns with it and wires to other parts follow its pins
 * (`rotateComponent`). When that can't be done without changing what is connected, nothing is
 * turned and the result says why. A single part whose next position is blocked goes to the next
 * one that is not (a half turn, then three quarters) and says so in `note`, so R is never stuck.
 */
export function rotateSelection(project: Project, ids: { components: string[]; labels: string[] }, o: Guard = {}): EditResult {
  const first = turnBy(project, ids, 90, o)
  if (first.ok || ids.components.length !== 1) return first
  for (const by of [180, 270] as const) {
    const other = turnBy(project, ids, by, o)
    if (!other.ok) continue
    return { ok: true, project: other.project, note: turnNote(refsOf(project, ids.components), by, first.reasons ?? []) }
  }
  return first
}

/**
 * Mirror each selected part, `x` top to bottom and `y` left to right, in place; what hangs off a
 * part's pins alone goes with it. Refused, with nothing changed, when that would change what is connected.
 */
export function mirrorSelection(project: Project, ids: { components: string[] }, axis: Mirror, o: Guard = {}): EditResult {
  let next = project
  for (const id of ids.components) {
    if (!next.components.some((x) => x.id === id)) continue
    next = mirrorComponent(next, id, axis, next === project ? o.conn?.(project) : undefined)
  }
  if (next === project) return { ok: true, project }
  return check(project, settleKicadSheet(project, cleanupWires(next)), `mirror ${refsOf(project, ids.components)}`, o)
}

// ---------- units, body styles and alternates ----------

/**
 * Change which unit or body style a placed symbol is, or which function one of its pins has. The symbol
 * is redrawn with its pins where the new drawing has them; wires do not follow, so this is refused,
 * with nothing changed, when it would cut a pin off its net or put one on another.
 */
export function setSymbolVariant(project: Project, id: string, change: { unit?: number; bodyStyle?: number; pinAlt?: { pin: string; alternate: string | null } }, o: Guard = {}): EditResult {
  const c = project.components.find((x) => x.id === id)
  const part = c && findPart(c.partId)
  if (!c || !part) return { ok: false, message: "That part is gone." }
  const patch: Partial<ComponentInstance> = {}
  if (change.unit !== undefined) {
    if (!Number.isInteger(change.unit) || change.unit < 1 || change.unit > unitCount(part)) return { ok: false, message: `${c.ref} has ${unitCount(part)} unit${unitCount(part) === 1 ? "" : "s"}, so there is no unit ${change.unit}.` }
    patch.unit = change.unit > 1 ? change.unit : undefined
  }
  if (change.bodyStyle !== undefined) {
    if (!Number.isInteger(change.bodyStyle) || change.bodyStyle < 1 || change.bodyStyle > bodyStyleCount(part)) return { ok: false, message: `${c.ref} has ${bodyStyleCount(part)} body style${bodyStyleCount(part) === 1 ? "" : "s"}, so there is no style ${change.bodyStyle}.` }
    patch.bodyStyle = change.bodyStyle > 1 ? change.bodyStyle : undefined
  }
  if (change.pinAlt) {
    const pin = part.pins.find((p) => p.number === change.pinAlt!.pin)
    if (!pin) return { ok: false, message: `${c.ref} has no pin ${change.pinAlt.pin}.` }
    const alt = change.pinAlt.alternate
    if (alt !== null && !pin.alternates?.some((a) => a.name === alt)) return { ok: false, message: `Pin ${pin.number} of ${c.ref} has no function called ${alt}.` }
    const alts = { ...c.pinAlt }
    if (alt === null) delete alts[pin.number]
    else alts[pin.number] = alt
    patch.pinAlt = Object.keys(alts).length ? alts : undefined
  }
  const comps = project.components.map((x) => {
    if (x.id !== id) return x
    const next: ComponentInstance = { ...x, ...patch }
    for (const key of ["unit", "bodyStyle", "pinAlt"] as const) if (next[key] === undefined) delete next[key]
    return next
  })
  const next = { ...project, components: comps, updatedAt: Date.now() }
  return check(project, next, `change ${c.ref}`, o)
}

/**
 * Put another unit of a part on the sheet, as a symbol of the same reference with no footprint of its own, `at` a place.
 * `from` is a component of the part, or one of its other units.
 */
export function addUnit(project: Project, from: string, unit: number, at: Vec2, o: Guard = {}): { ok: true; project: Project; component: ComponentInstance } | { ok: false; message: string } {
  const c = project.components.find((x) => x.id === from)
  const part = c && findPart(c.partId)
  if (!c || !part) return { ok: false, message: "That part is gone." }
  const base = part.unitOf ?? part.id
  const twin = findPart(unitTwinId(base)) ?? part
  if (unitCount(part) < 2) return { ok: false, message: `${c.ref} has one unit.` }
  if (!Number.isInteger(unit) || unit < 1 || unit > unitCount(part)) return { ok: false, message: `${c.ref} has ${unitCount(part)} units, so there is no unit ${unit}.` }
  if (project.components.some((x) => x.ref === c.ref && (x.unit ?? 1) === unit && findPart(x.partId)?.units)) return { ok: false, message: `Unit ${unit} of ${c.ref} is already on the sheet.` }
  const res = placeComponent(project, twin.id, { ref: c.ref, sch: { ...at, rot: 0 }, props: { ...c.props } }, o)
  if (!res.ok) return res
  const placed = { ...res.component, ...(unit > 1 ? { unit } : {}), footprint: "" }
  return { ok: true, component: placed, project: { ...res.project, components: res.project.components.map((x) => (x.id === placed.id ? placed : x)) } }
}

/** Where the fields of a placed symbol are written: change the place of one, its size, whether it shows. */
export function setFieldPlace(project: Project, id: string, name: string, patch: Partial<FieldPlace> | null): Project {
  const c = project.components.find((x) => x.id === id)
  const part = c && findPart(c.partId)
  if (!c || !part) return project
  const was = fieldPlaceOf(c, part, name)
  // The part's places are in the symbol's frame: a symbol that has none of its own takes them as they are drawn.
  const fields = fieldPlacesOf(c, part)
  if (patch === null) delete fields[name]
  else {
    const merged: FieldPlace = { x: 0, y: 0, angle: 0, ...was, ...patch }
    // An absent flag is false: a field that is shown again drops `hidden`.
    for (const key of ["hidden", "bold", "italic", "showName"] as const) if (patch[key] === undefined && key in patch) delete merged[key]
    fields[name] = merged
  }
  return updateComponent(project, id, { fields: Object.keys(fields).length ? fields : undefined })
}

/** Rename a part's reference: every unit of it shares the name. */
export function renameReference(project: Project, id: string, ref: string): Project {
  const c = project.components.find((x) => x.id === id)
  const part = c && findPart(c.partId)
  if (!c || !part) return project
  const same = new Set(unitCount(part) > 1 ? project.components.filter((x) => x.ref === c.ref && !!findPart(x.partId)?.units).map((x) => x.id) : [c.id])
  const renamed = { ...project, components: project.components.map((x) => (same.has(x.id) ? { ...x, ref } : x)), updatedAt: Date.now() }
  return rekeyAutoNets(project, renamed)
}

export { rekeyAutoNets }

// ---------- dragging ----------

/**
 * A drag of `picked` that ended with `dropped` on screen: the sheet to keep, or the refusal that
 * puts it back where it started. A two-pin part dropped on the middle of a wire is wired in line.
 */
export function guardDrop(start: Project, dropped: Project, picked: { components: string[] }, o: Guard = {}): EditResult {
  const conn = o.conn ?? computeConnectivity
  const before = conn(start)
  let next = settleKicadSheet(start, cleanupWires(dropped))
  // Only a part that was on nothing goes in line; one with wires on it keeps them and is checked as it is.
  const loose = picked.components.filter((id) => {
    const c = start.components.find((x) => x.id === id)
    return !!c && schematicPins(c).every((p) => !before.pinNet.has(pinKey(id, p.pin)))
  })
  const spliced = spliceInline(next, loose)
  next = spliced.project
  return check(start, next, `move ${refsOf(start, picked.components)}`, { ...o, cutOnPurpose: netsOfWires(before, spliced.cut), inline: spliced.cut.length > 0 })
}

/** Drag the selection by `delta` the way the canvas does, and drop it. */
export function dragSelection(project: Project, picked: { components: string[]; labels: string[]; wires: string[] }, delta: Vec2, o: Guard = {}): EditResult {
  const { ids, bands } = dragPlan(project, picked)
  return guardDrop(project, moveSchematicItems(project, ids, delta, bands, o.conn?.(project)), picked, o)
}

// ---------- adding ----------

export interface Clipboard {
  project: Project
  components: string[]
  wires: string[]
  labels: string[]
  drawings?: string[]
  /** Copied whole, so the paste is a block of the copies with the same name. */
  blocks: string[]
}

export type PasteResult = { ok: true; project: Project; selection: string[]; inline?: boolean } | { ok: false; message: string }

/** What an edit that only adds parts comes to: their in-line splices, then the check. */
function checkAdded(before: Project, added: Project, newParts: string[], what: string, o: Guard): EditResult {
  const conn = o.conn ?? computeConnectivity
  const spliced = spliceInline(added, newParts)
  // S11: on a sheet joined by KiCad's rules the wires an edit put on another's side are cut there before the edit is judged, as KiCad cuts them.
  spliced.project = settleKicadSheet(before, spliced.project)
  return check(before, spliced.project, what, { ...o, adds: true, cutOnPurpose: netsOfWires(conn(before), spliced.cut), inline: spliced.cut.length > 0 })
}

/**
 * Copy the clipboard's items into `project`, `offset` away from where they were. A copy that
 * would join nets or lie on another net's wire is refused, so a paste can't short anything.
 */
export function pasteItems(project: Project, clip: Clipboard, offset: Vec2, what = "paste", o: Guard = {}): PasteResult {
  let next = project
  const selection: string[] = []
  const added: string[] = []
  const copies = new Map<string, string>()
  const unitRefs = new Map<string, string>()
  // S11: a sheet joined by KiCad's rules keeps its points at six digits, so a copy keeps what was at one point at one point.
  const digits = kicadRulesShown(project) ? 6 : 4
  const by = digits > 4 ? { x: round(offset.x), y: round(offset.y) } : offset
  const sh = (pt: Vec2) => ({ x: round(pt.x + by.x, digits), y: round(pt.y + by.y, digits) })
  for (const id of clip.components) {
    const c = clip.project.components.find((x) => x.id === id)
    const part = c && findPart(c.partId)
    if (!c || !part) continue
    next = withPartsFrom(next, clip.project, part.custom ? [c.partId] : [], [c.footprint])
    next = withModelsFrom(next, clip.project, [{ part: c.partId, footprint: c.footprint }])
    // The units of one part are copied under one new reference.
    const unitsRef = part.units ? `${part.unitOf ?? part.id}|${c.ref}` : null
    const ref = (unitsRef && unitRefs.get(unitsRef)) || nextRef(next, part.refPrefix)
    if (unitsRef) unitRefs.set(unitsRef, ref)
    // S9: a copy is a new symbol, not another use of one: it keeps none of the variants the copied one had on its use, nor the copy key it was kept alike by.
    // A copy is another footprint to KiCad: it does not take the original's uuids.
    const { variants: _variants, tpl: _tpl, fpUuid: _fpUuid, padUuids: _padUuids, ...kept } = c
    void _variants
    void _tpl
    void _fpUuid
    void _padUuids
    const copy = {
      ...kept,
      id: uid("c"),
      ref,
      props: { ...c.props },
      sch: { ...c.sch, ...sh(c.sch) },
      // A copy is not on the board yet, and a lock keeps a part in place, so the copy starts unlocked.
      pcb: { ...c.pcb, placed: false, locked: undefined },
    }
    next = { ...next, components: [...next.components, copy] }
    selection.push(`c:${copy.id}`)
    added.push(copy.id)
    copies.set(c.id, copy.id)
  }
  for (const id of clip.wires) {
    const w = clip.project.wires.find((x) => x.id === id)
    if (!w) continue
    const copy = { id: uid("w"), points: w.points.map(sh), ...(w.look ? { look: w.look } : {}) }
    next = { ...next, wires: [...next.wires, copy] }
    selection.push(`w:${copy.id}`)
  }
  for (const id of clip.labels) {
    const l = clip.project.labels.find((x) => x.id === id)
    if (!l) continue
    const copy = { ...l, id: uid("l"), ...sh(l) }
    next = { ...next, labels: [...next.labels, copy] }
    selection.push(`l:${copy.id}`)
  }
  const drawn = (clip.drawings ?? []).flatMap((id) => clip.project.drawings?.find((x) => x.id === id) ?? [])
  if (drawn.length) {
    const copied = copyDrawings(drawn, offset)
    next = { ...next, drawings: [...(next.drawings ?? []), ...copied] }
    selection.push(...copied.map((d) => `d:${d.id}`))
  }
  // A copied block comes back as a new block around the copies of its parts; parts copied without
  // their block land in none.
  for (const id of clip.blocks) {
    const b = clip.project.blocks?.find((x) => x.id === id)
    const made = b && createBlock(next, b.name, b.components.flatMap((m) => copies.get(m) ?? []))
    if (!made?.block) continue
    next = made.project
    selection.push(`b:${made.block.id}`)
  }
  // A unit copied without its part is a part of its own.
  next = { ...next, components: repairUnits(next.components) }
  const res = checkAdded(project, { ...next, updatedAt: Date.now() }, added, what, o)
  return res.ok ? { ok: true, project: res.project, selection, inline: res.inline } : res
}

/** Put a new part on the sheet. Dropped across a wire it goes in line; where it would join nets it is refused. */
export function placeComponent(
  project: Project,
  partId: string,
  opts: AddComponentOptions,
  o: Guard = {},
): { ok: true; project: Project; component: ComponentInstance; inline?: boolean } | { ok: false; message: string } {
  const { project: next, component } = addComponent(project, partId, opts)
  const res = checkAdded(project, next, [component.id], `place ${component.ref}`, o)
  return res.ok ? { ok: true, project: res.project, component, inline: res.inline } : res
}

// ---------- S2, S4: labels and groups ----------

/** A label's kind, shape, size and style changed. A global label has a shape; a local one has none. */
export function setLabelStyle(project: Project, id: string, change: { name?: string; kind?: LabelKind; shape?: LabelShape; look?: Partial<TextLook> | null; turn?: Rotation }): Project {
  const l = project.labels.find((x) => x.id === id)
  if (!l) return project
  const next: NetLabel = { ...l }
  if (change.name !== undefined) next.name = change.name
  if (change.kind) next.kind = change.kind
  if (next.kind === "global" || next.kind === "hierarchical") next.shape = change.shape ?? next.shape ?? "bidirectional"
  else delete next.shape
  if (change.turn !== undefined) {
    next.rot = change.turn
    // The justification KiCad writes follows the turn: one that was the default stays the default.
    if (next.look) {
      const { h, v, ...rest } = next.look
      next.look = Object.keys(rest).length ? rest : undefined
      void h
      void v
    }
  }
  if (change.look === null) delete next.look
  else if (change.look) {
    const look: TextLook = { ...next.look, ...change.look }
    for (const k of Object.keys(look) as (keyof TextLook)[]) if (look[k] === undefined || (look[k] as unknown) === false) delete look[k]
    if (Object.keys(look).length) next.look = look
    else delete next.look
  }
  if (!next.look) delete next.look
  return { ...project, updatedAt: Date.now(), labels: project.labels.map((x) => (x.id === id ? next : x)) }
}

/** A group locked or unlocked. */
export function setBlockLocked(project: Project, id: string, locked: boolean): Project {
  return {
    ...project,
    updatedAt: Date.now(),
    blocks: project.blocks?.map((b) => {
      if (b.id !== id) return b
      const { locked: _was, ...rest } = b
      void _was
      return locked ? { ...rest, locked: true as const } : rest
    }),
  }
}
