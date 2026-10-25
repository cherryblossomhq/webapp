import { uid } from "../lib/id"
import { rotate90 } from "../lib/geometry"
import { findPart } from "./library"
import { isPhysical } from "./instances"
import { getDesignators, REF_SIZE, SILK_WIDTH } from "./silk"
import { flipShapeLayer } from "./shapeLayers"
import { defaultTextId } from "./textCodec"
import { isKicadText, isTextLayer, partTextWorld, type WorldText } from "./texts"
import type { BoardText, ComponentInstance, PartText, Project, Rotation, TextAttrs, Vec2 } from "./types"

// Editing texts: those on the board (`Project.texts`, the ones with a layer) and those of a part (`ComponentInstance.texts`).
// Every function returns a new project, or the same one when nothing changed, and keeps texts valid: a layer is one of KiCad's,
// a size is above zero, a width is not negative. A part's text is edited in the world (where it is on the board, which angle it is drawn at)
// and held in the land's frame, so it goes on following the part.

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })
const r6 = (n: number) => Math.round(n * 1e6) / 1e6 || 0
const norm360 = (a: number) => r6(((a % 360) + 360) % 360)

/** What can be changed on a text without changing what it is. `null` clears an optional attribute. */
export interface TextPatch {
  text?: string
  layer?: string
  size?: number
  w?: number | null
  thickness?: number | null
  bold?: boolean
  italic?: boolean
  mirror?: boolean
  knockout?: boolean
  hj?: "left" | "right" | null
  vj?: "top" | "bottom" | null
  spacing?: number | null
  /** A part's text only: false lets it turn upside down with the part. */
  upright?: boolean
  hide?: boolean
  locked?: boolean
  /** The angle on the board (degrees counter-clockwise). */
  rot?: number
  /** Where it is on the board. */
  x?: number
  y?: number
}

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n)

function setFlag<T extends object>(o: T, key: keyof TextAttrs, on: boolean | undefined, value: unknown = true) {
  if (on === undefined) return
  if (on) (o as Record<string, unknown>)[key] = value
  else delete (o as Record<string, unknown>)[key]
}

/** The attributes of a patch applied to a text's own fields (not its place, which depends on where the text is held). */
function applyAttrs<T extends BoardText | PartText>(t: T, patch: TextPatch, partSide?: "top" | "bottom"): T {
  const next = { ...t } as T & Record<string, unknown>
  if (patch.text !== undefined && (("kind" in t && t.kind === "user") || !("kind" in t))) next.text = patch.text
  if (patch.layer !== undefined && isTextLayer(patch.layer)) next.layer = partSide === "bottom" ? flipShapeLayer(patch.layer) : patch.layer
  if (finite(patch.size) && patch.size > 0) next.size = r6(patch.size)
  if (patch.w !== undefined) {
    if (patch.w === null || (finite(patch.w) && Math.abs(patch.w - next.size) < 1e-9)) delete next.w
    else if (finite(patch.w) && patch.w > 0) next.w = r6(patch.w)
  }
  if (patch.thickness !== undefined) {
    if (patch.thickness === null || (finite(patch.thickness) && patch.thickness <= 0)) delete next.thickness
    else if (finite(patch.thickness)) next.thickness = r6(patch.thickness)
  }
  setFlag(next, "bold", patch.bold)
  setFlag(next, "italic", patch.italic)
  setFlag(next, "knockout", patch.knockout)
  setFlag(next, "locked", patch.locked)
  if (patch.hj !== undefined) {
    if (patch.hj) next.hj = patch.hj
    else delete next.hj
  }
  if (patch.vj !== undefined) {
    if (patch.vj) next.vj = patch.vj
    else delete next.vj
  }
  if (patch.spacing !== undefined) {
    if (patch.spacing === null || (finite(patch.spacing) && Math.abs(patch.spacing - 1) < 1e-9)) delete next.spacing
    else if (finite(patch.spacing) && patch.spacing > 0) next.spacing = patch.spacing
  }
  if ("kind" in t) {
    if (patch.upright !== undefined) {
      if (patch.upright) delete next.upright
      else next.upright = false
    }
    setFlag(next, "hide", patch.hide)
  }
  return next
}

/** The side of the board a text on `layer` is on. */
const sideOfLayer = (layer: string): "top" | "bottom" => (layer.startsWith("B.") ? "bottom" : "top")

// ---------- on the board ----------

/** A new board text. The attributes not given are the defaults of a new text on the layer. */
export function addBoardText(project: Project, text: Omit<BoardText, "id" | "side"> & { layer: string }): { project: Project; text: BoardText } {
  const place = (project.texts ?? []).filter(isKicadText).length
  const free = (id: string) => !(project.texts ?? []).some((t) => t.id === id)
  let id = defaultTextId(place)
  for (let n = place; !free(id); n++) id = defaultTextId(n)
  if (!free(id)) id = uid("kt")
  const added = { ...text, id, side: sideOfLayer(text.layer) } as BoardText
  return { project: touch({ ...project, texts: [...(project.texts ?? []), added] }), text: added }
}

export function updateBoardTexts(project: Project, ids: string[], patch: TextPatch): Project {
  const set = new Set(ids)
  if (!project.texts?.some((t) => set.has(t.id) && isKicadText(t))) return project
  return touch({
    ...project,
    texts: project.texts.map((t) => {
      if (!set.has(t.id) || !isKicadText(t)) return t
      const next = applyAttrs(t, patch)
      if (finite(patch.rot)) next.rot = norm360(patch.rot)
      if (finite(patch.x)) next.x = r6(patch.x)
      if (finite(patch.y)) next.y = r6(patch.y)
      next.side = sideOfLayer(next.layer!)
      return next
    }),
  })
}

/** Moves the board texts that are not locked by (dx, dy). */
export function moveBoardTexts(project: Project, ids: string[], dx: number, dy: number): Project {
  const set = new Set(ids)
  if ((dx === 0 && dy === 0) || !project.texts?.some((t) => set.has(t.id) && isKicadText(t) && !t.locked)) return project
  return touch({ ...project, texts: project.texts.map((t) => (set.has(t.id) && isKicadText(t) && !t.locked ? { ...t, x: r6(t.x + dx), y: r6(t.y + dy) } : t)) })
}

export function removeBoardTexts(project: Project, ids: string[]): Project {
  const set = new Set(ids)
  if (!project.texts?.some((t) => set.has(t.id) && isKicadText(t))) return project
  return touch({ ...project, texts: project.texts.filter((t) => !(set.has(t.id) && isKicadText(t))) })
}

// ---------- in a part ----------

/** A point of the board as a point of the part's land (the part's frame, before it is turned or flipped). */
export function landPoint(c: ComponentInstance, p: Vec2): Vec2 {
  const d = { x: p.x - c.pcb.x, y: p.y - c.pcb.y }
  const r = rotate90(d, ((360 - c.pcb.rot) % 360) as Rotation)
  return { x: r6(c.pcb.side === "bottom" ? -r.x : r.x), y: r6(r.y) }
}

/** A displacement on the board as a displacement in the land's frame. */
export function landDelta(c: ComponentInstance, d: Vec2): Vec2 {
  const r = rotate90(d, ((360 - c.pcb.rot) % 360) as Rotation)
  return { x: c.pcb.side === "bottom" ? -r.x : r.x, y: r.y }
}

/** The angle in the land for an angle on the board. */
export const landAngle = (c: ComponentInstance, world: number) => norm360(c.pcb.side === "bottom" ? c.pcb.rot - world : world - c.pcb.rot)

function withTexts(project: Project, componentId: string, edit: (texts: PartText[], c: ComponentInstance) => PartText[] | null): Project {
  const c = project.components.find((x) => x.id === componentId)
  if (!c) return project
  const next = edit(c.texts ?? [], c)
  if (!next) return project
  return touch({ ...project, components: project.components.map((x) => (x.id === componentId ? { ...x, texts: next } : x)) })
}

/** Changes a part's text. Its place and angle are given on the board. */
export function updatePartText(project: Project, componentId: string, index: number, patch: TextPatch): Project {
  return withTexts(project, componentId, (texts, c) => {
    if (!texts[index]) return null
    return texts.map((t, i) => {
      if (i !== index) return t
      const next = applyAttrs(t, patch, c.pcb.side)
      // The mirror flag on the board is the land's the other way round on the bottom.
      if (patch.mirror !== undefined) {
        const landMirror = c.pcb.side === "bottom" ? !patch.mirror : patch.mirror
        if (landMirror) next.mirror = true
        else delete next.mirror
      }
      if (finite(patch.rot)) next.rot = landAngle(c, patch.rot)
      if (finite(patch.x) || finite(patch.y)) {
        const world = partTextWorld(c, t, i)
        const p = landPoint(c, { x: finite(patch.x) ? patch.x : world.x, y: finite(patch.y) ? patch.y : world.y })
        next.x = p.x
        next.y = p.y
      }
      return next
    })
  })
}

/** Moves texts of parts by a displacement on the board; texts that are locked stay. */
export function movePartTexts(project: Project, items: { component: string; index: number }[], dx: number, dy: number): Project {
  if (dx === 0 && dy === 0) return project
  let out = project
  const byComponent = new Map<string, Set<number>>()
  for (const it of items) byComponent.set(it.component, (byComponent.get(it.component) ?? new Set()).add(it.index))
  for (const [id, indices] of byComponent) {
    out = withTexts(out, id, (texts, c) => {
      if (!texts.some((t, i) => indices.has(i) && !t.locked)) return null
      const d = landDelta(c, { x: dx, y: dy })
      return texts.map((t, i) => (indices.has(i) && !t.locked ? { ...t, x: r6(t.x + d.x), y: r6(t.y + d.y) } : t))
    })
  }
  return out
}

/** Adds a text of its own to a part, at a place on the board. The part gets a list of texts if it had none, with its reference where the editor puts the designator. */
export function addPartText(project: Project, componentId: string, text: { text: string; at: Vec2; layer?: string; size?: number }): { project: Project; index: number } {
  const c = project.components.find((x) => x.id === componentId)
  if (!c) return { project, index: -1 }
  const seeded = c.texts ? project : withDesignatorText(project, componentId)
  const part = seeded.components.find((x) => x.id === componentId)!
  const p = landPoint(part, text.at)
  const layer = text.layer && isTextLayer(text.layer) ? (part.pcb.side === "bottom" ? flipShapeLayer(text.layer) : text.layer) : "F.SilkS"
  const added: PartText = { kind: "user", text: text.text, layer, x: p.x, y: p.y, size: text.size ?? REF_SIZE, rot: landAngle(part, 0), thickness: SILK_WIDTH }
  const texts = [...(part.texts ?? []), added]
  return { project: touch({ ...seeded, components: seeded.components.map((x) => (x.id === componentId ? { ...x, texts } : x)) }), index: texts.length - 1 }
}

/** Removes a part's own text (a reference or a value stays: hide it instead). */
export function removePartText(project: Project, componentId: string, index: number): Project {
  return withTexts(project, componentId, (texts) => (texts[index]?.kind === "user" ? texts.filter((_, i) => i !== index) : null))
}

/**
 * Takes the part's designator out of the editor's hands: its reference becomes a text of the part, where the editor placed it, the
 * editor's size and pen, and the part keeps that text until it is reset. Until a part is given text, `silk.ts` places its designator.
 */
export function withDesignatorText(project: Project, componentId: string): Project {
  const c = project.components.find((x) => x.id === componentId)
  if (!c || c.texts || !isPhysical(findPart(c.partId))) return project
  const d = getDesignators(project).get(c.id)
  const at = d ? landPoint(c, { x: d.x, y: d.y }) : { x: 0, y: 0 }
  // The designator is laid out centred; a vertical one reads bottom to top.
  const world = d ? d.rot : 0
  const text: PartText = {
    kind: "reference",
    layer: "F.SilkS",
    x: at.x,
    y: at.y,
    size: d?.size ?? REF_SIZE,
    rot: landAngle(c, world),
    thickness: SILK_WIDTH,
  }
  return touch({ ...project, components: project.components.map((x) => (x.id === componentId ? { ...x, texts: [text] } : x)) })
}

/** Gives the part back to the editor's designator: its texts are dropped. */
export function resetPartTexts(project: Project, componentId: string): Project {
  const c = project.components.find((x) => x.id === componentId)
  if (!c?.texts) return project
  return touch({ ...project, components: project.components.map((x) => (x.id === componentId ? (({ texts: _texts, ...rest }) => rest)(x) : x)) })
}

/** The texts a selection names, as world texts, in the order of the selection. */
export function selectedTexts(all: WorldText[], ids: string[]): WorldText[] {
  const set = new Set(ids)
  return all.filter((t) => set.has(t.id))
}

/** Applies a patch to world texts of the board and of parts, each edited where it is held. A place (`x`, `y`) is for one text. */
export function patchTexts(project: Project, texts: WorldText[], patch: TextPatch): Project {
  let out = project
  for (const t of texts) {
    if (t.kind === "board") out = updateBoardTexts(out, [(t.source as BoardText).id], patch)
    else {
      const c = out.components.find((x) => x.id === t.owner)
      if (c) out = updatePartText(out, t.owner, t.index, patch)
    }
  }
  return out
}
