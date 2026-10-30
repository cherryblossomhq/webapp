import { uid } from "../lib/id"
import { finite } from "../lib/guards"
import { rotate90, round } from "../lib/geometry"
import { dimensionDrawing } from "./dimensions"
import { isTextLayer } from "./texts"
import type { BoardDimension, ComponentInstance, DimensionKind, PcbGroup, Project, ReferenceImage, Vec2 } from "./types"

// Editing the objects X11, X12 and X14 add: dimensions, groups and reference images. Every function returns a new project, or the same one when nothing
// changed. A selection id says what it is by its first letter, as everywhere in the PCB view: `c:` a part, `t:` a trace, `v:` a via, `g:` a drawing, `x:` a
// text, `m:` a dimension, `i:` an image. A group's members are the ids themselves, without the letter.

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })
const r6 = (n: number) => Math.round(n * 1e6) / 1e6 || 0

// ---------- dimensions ----------

/** KiCad's own default for the extension height of a new dimension: its arrow's length times the sine of the arrow's angle. */
const DEFAULT_EXT_HEIGHT = 0.586422

/** A new dimension of a kind on a layer, with the settings KiCad starts one with (millimetres with four digits, an arrow of 50 mils, the text beside its crossbar and turned with it). */
export function newDimension(kind: DimensionKind, layer: string, a: Vec2, b: Vec2, extra: { height?: number; vertical?: boolean; text?: Vec2 } = {}): Omit<BoardDimension, "id"> {
  const silk = layer.endsWith(".SilkS") || layer.endsWith(".Mask") || layer.endsWith(".Paste") || layer.endsWith(".Cu")
  const text = extra.text ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  return {
    kind,
    layer,
    a: { x: r6(a.x), y: r6(a.y) },
    b: { x: r6(b.x), y: r6(b.y) },
    ...(extra.height ? { height: r6(extra.height) } : {}),
    ...(kind === "orthogonal" && extra.vertical ? { vertical: true as const } : {}),
    extHeight: DEFAULT_EXT_HEIGHT,
    extOffset: 0,
    ...(kind === "radial" ? { leaderLength: 3.81 } : {}),
    thickness: silk ? 0.15 : 0.1,
    arrow: 1.27,
    ...(kind === "aligned" || kind === "orthogonal" || kind === "radial" ? { keep: true as const } : {}),
    units: 2,
    format: kind === "aligned" || kind === "orthogonal" ? 1 : 0,
    precision: 2,
    ...(kind === "radial" ? { prefix: "R " } : {}),
    ...(kind === "leader" ? { override: "Leader" } : {}),
    x: r6(text.x),
    y: r6(text.y),
    rot: 0,
    size: silk ? 1 : 1.5,
    tw: silk ? 0.15 : 0.15,
  }
}

/** What can be changed on a dimension. `null` clears an optional value. */
export interface DimensionPatch {
  layer?: string
  units?: number
  format?: number
  precision?: number
  zeros?: boolean
  prefix?: string | null
  suffix?: string | null
  /** The text that replaces the measured value; `null` goes back to the measured value. */
  override?: string | null
  height?: number
  extHeight?: number
  extOffset?: number
  leaderLength?: number
  thickness?: number
  arrow?: number
  inward?: boolean
  /** 0 outside the crossbar, 1 on it, 2 where the text is put by hand. */
  textMode?: 0 | 1 | 2
  keep?: boolean
  frame?: 0 | 1 | 2 | 3
  size?: number
  locked?: boolean
  vertical?: boolean
  a?: Vec2
  b?: Vec2
  x?: number
  y?: number
  rot?: number
}

const flag = (o: Record<string, unknown>, key: string, on: boolean | undefined) => {
  if (on === undefined) return
  if (on) o[key] = true
  else delete o[key]
}

const text = (o: Record<string, unknown>, key: string, v: string | null | undefined) => {
  if (v === undefined) return
  if (v === null || (v === "" && key !== "override")) delete o[key]
  else o[key] = v
}

/** A dimension with a patch applied; a value that is not valid for it is left as it was. */
export function patchDimension(d: BoardDimension, patch: DimensionPatch): BoardDimension {
  const n = { ...d } as BoardDimension & Record<string, unknown>
  if (patch.layer !== undefined && isTextLayer(patch.layer)) n.layer = patch.layer
  if (finite(patch.units) && [0, 1, 2, 3].includes(patch.units)) n.units = patch.units
  if (finite(patch.format) && [0, 1, 2].includes(patch.format)) n.format = patch.format
  if (finite(patch.precision) && Number.isInteger(patch.precision) && patch.precision >= 0 && patch.precision <= 9) n.precision = patch.precision
  flag(n, "zeros", patch.zeros)
  text(n, "prefix", patch.prefix)
  text(n, "suffix", patch.suffix)
  text(n, "override", patch.override)
  if (finite(patch.height) && (d.kind === "aligned" || d.kind === "orthogonal")) {
    if (patch.height === 0) delete n.height
    else n.height = r6(patch.height)
  }
  if (finite(patch.extHeight) && patch.extHeight >= 0) n.extHeight = r6(patch.extHeight)
  if (finite(patch.extOffset) && patch.extOffset >= 0) n.extOffset = r6(patch.extOffset)
  if (finite(patch.leaderLength) && patch.leaderLength > 0 && d.kind === "radial") n.leaderLength = r6(patch.leaderLength)
  if (finite(patch.thickness) && patch.thickness >= 0) n.thickness = r6(patch.thickness)
  if (finite(patch.arrow) && patch.arrow >= 0) n.arrow = r6(patch.arrow)
  flag(n, "inward", patch.inward)
  if (patch.textMode !== undefined) {
    if (patch.textMode === 1 || patch.textMode === 2) n.textMode = patch.textMode
    else delete n.textMode
  }
  flag(n, "keep", patch.keep)
  if (patch.frame !== undefined && d.kind === "leader") {
    if (patch.frame === 1 || patch.frame === 2 || patch.frame === 3) n.frame = patch.frame
    else delete n.frame
  }
  if (finite(patch.size) && patch.size > 0) n.size = r6(patch.size)
  flag(n, "locked", patch.locked)
  if (d.kind === "orthogonal") flag(n, "vertical", patch.vertical)
  if (patch.a && finite(patch.a.x) && finite(patch.a.y)) n.a = { x: r6(patch.a.x), y: r6(patch.a.y) }
  if (patch.b && finite(patch.b.x) && finite(patch.b.y)) n.b = { x: r6(patch.b.x), y: r6(patch.b.y) }
  if (finite(patch.x)) n.x = r6(patch.x)
  if (finite(patch.y)) n.y = r6(patch.y)
  if (finite(patch.rot)) n.rot = r6(((patch.rot % 360) + 360) % 360)
  return n
}

export function addDimension(project: Project, dimension: Omit<BoardDimension, "id">): { project: Project; dimension: BoardDimension } {
  const d = { ...dimension, id: uid("dm") } as BoardDimension
  return { project: touch({ ...project, dimensions: [...(project.dimensions ?? []), d] }), dimension: d }
}

export function updateDimensions(project: Project, ids: string[], patch: DimensionPatch): Project {
  const set = new Set(ids)
  if (!project.dimensions?.some((d) => set.has(d.id))) return project
  return touch({ ...project, dimensions: project.dimensions.map((d) => (set.has(d.id) ? patchDimension(d, patch) : d)) })
}

/** A dimension moved by (dx, dy): its points and its text with them. */
export function moveDimension(d: BoardDimension, dx: number, dy: number): BoardDimension {
  return { ...d, a: { x: r6(d.a.x + dx), y: r6(d.a.y + dy) }, b: { x: r6(d.b.x + dx), y: r6(d.b.y + dy) }, x: r6(d.x + dx), y: r6(d.y + dy) }
}

/**
 * A dimension turned a quarter turn counter-clockwise about a point (`PCB_DIM_ORTHOGONAL::Rotate` and `PCB_DIMENSION_BASE::Rotate`, pcbnew/pcb_dimension.cpp): its points and its text
 * place turn, its text turns with it, and an orthogonal one that measured along x measures along y; one that measured along y measures along x with its crossbar on the other side.
 */
export function rotateDimension(d: BoardDimension, about: Vec2): BoardDimension {
  const turn = (p: Vec2): Vec2 => {
    const r = rotate90({ x: p.x - about.x, y: p.y - about.y }, 90)
    return { x: r6(about.x + r.x), y: r6(about.y + r.y) }
  }
  const at = turn({ x: d.x, y: d.y })
  const next: BoardDimension & Record<string, unknown> = { ...d, a: turn(d.a), b: turn(d.b), x: at.x, y: at.y, rot: r6((d.rot + 90) % 360) }
  if (d.kind === "orthogonal") {
    if (d.vertical) {
      delete next.vertical
      if (d.height) next.height = r6(-d.height)
    } else next.vertical = true
  }
  return next
}

export function removeDimensions(project: Project, ids: string[]): Project {
  const set = new Set(ids)
  if (!project.dimensions?.some((d) => set.has(d.id))) return project
  const dimensions = project.dimensions.filter((d) => !set.has(d.id))
  const { dimensions: _old, ...rest } = project
  return touch({ ...rest, ...(dimensions.length ? { dimensions } : {}) })
}

/** The box a dimension takes on the board: its lines and its text's place, for selecting and for framing it. */
export function dimensionBox(d: BoardDimension): { minX: number; minY: number; maxX: number; maxY: number } {
  const draw = dimensionDrawing(d)
  const xs = [d.a.x, d.b.x, ...draw.lines.flatMap((l) => [l.a.x, l.b.x]), ...(draw.text ? [draw.text.x] : [])]
  const ys = [d.a.y, d.b.y, ...draw.lines.flatMap((l) => [l.a.y, l.b.y]), ...(draw.text ? [draw.text.y] : [])]
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

// ---------- reference images ----------

export interface ImagePatch {
  layer?: string
  scale?: number
  locked?: boolean
  x?: number
  y?: number
}

export function patchImage(m: ReferenceImage, patch: ImagePatch): ReferenceImage {
  const n = { ...m } as ReferenceImage & Record<string, unknown>
  if (patch.layer !== undefined && isTextLayer(patch.layer)) n.layer = patch.layer
  if (finite(patch.scale) && patch.scale > 0) n.scale = patch.scale
  flag(n, "locked", patch.locked)
  if (finite(patch.x)) n.x = r6(patch.x)
  if (finite(patch.y)) n.y = r6(patch.y)
  return n
}

export function addImage(project: Project, image: Omit<ReferenceImage, "id">): { project: Project; image: ReferenceImage } {
  const m = { ...image, id: uid("im") } as ReferenceImage
  return { project: touch({ ...project, images: [...(project.images ?? []), m] }), image: m }
}

export function updateImages(project: Project, ids: string[], patch: ImagePatch): Project {
  const set = new Set(ids)
  if (!project.images?.some((m) => set.has(m.id))) return project
  return touch({ ...project, images: project.images.map((m) => (set.has(m.id) ? patchImage(m, patch) : m)) })
}

export function moveImages(project: Project, ids: string[], dx: number, dy: number): Project {
  const set = new Set(ids)
  if (!project.images?.some((m) => set.has(m.id) && !m.locked) || (dx === 0 && dy === 0)) return project
  return touch({ ...project, images: project.images.map((m) => (set.has(m.id) && !m.locked ? patchImage(m, { x: m.x + dx, y: m.y + dy }) : m)) })
}

export function removeImages(project: Project, ids: string[]): Project {
  const set = new Set(ids)
  if (!project.images?.some((m) => set.has(m.id))) return project
  const images = project.images.filter((m) => !set.has(m.id))
  const { images: _old, ...rest } = project
  return touch({ ...rest, ...(images.length ? { images } : {}) })
}

/** An image's size on the board in millimetres: its pixels at its resolution, times its scale. */
export const imageSize = (m: Pick<ReferenceImage, "px" | "py" | "ppi" | "scale">): { w: number; h: number } => ({ w: (m.px / m.ppi) * 25.4 * m.scale, h: (m.py / m.ppi) * 25.4 * m.scale })

export const imageBox = (m: ReferenceImage) => {
  const s = imageSize(m)
  return { minX: m.x - s.w / 2, maxX: m.x + s.w / 2, minY: m.y - s.h / 2, maxY: m.y + s.h / 2 }
}

// ---------- groups ----------

/** The selection id of each kind of object a group may hold. */
const PREFIXES = ["c", "t", "v", "g", "x", "m", "i"] as const
export type MemberKind = (typeof PREFIXES)[number]

/** The id a selection id names: a group's member. Null for a selection id of something that is never in a group (a wire, a label, a block). */
export function memberOfSelection(id: string): string | null {
  const at = id.indexOf(":")
  if (at !== 1) return null
  return (PREFIXES as readonly string[]).includes(id[0]) ? id.slice(2) : null
}

interface Index {
  groups: Map<string, PcbGroup>
  parent: Map<string, string>
}

const indexCache = new WeakMap<PcbGroup[], Index>()

function indexOf(project: Project): Index | null {
  const list = project.groups
  if (!list?.length) return null
  let hit = indexCache.get(list)
  if (!hit) {
    const groups = new Map(list.map((g) => [g.id, g]))
    const parent = new Map<string, string>()
    for (const g of list) for (const m of g.members) parent.set(m, g.id)
    hit = { groups, parent }
    indexCache.set(list, hit)
  }
  return hit
}

/** The outermost group an object is in (a member id, or a group's id), or null when it is in none. */
export function topGroup(project: Project, member: string): PcbGroup | null {
  const idx = indexOf(project)
  if (!idx) return null
  let at = idx.parent.get(member)
  let top: string | undefined
  for (let guard = 0; at !== undefined && guard < 1000; guard++) {
    top = at
    at = idx.parent.get(at)
  }
  return top ? (idx.groups.get(top) ?? null) : null
}

/** Every object under a group, at any depth, as member ids (the groups inside it are walked, not listed). */
export function leafMembers(project: Project, group: PcbGroup): string[] {
  const idx = indexOf(project)
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (g: PcbGroup) => {
    if (seen.has(g.id)) return
    seen.add(g.id)
    for (const m of g.members) {
      const inner = idx?.groups.get(m)
      if (inner) walk(inner)
      else out.push(m)
    }
  }
  walk(group)
  return out
}

/** The selection id of a member, by what the project has under that id; null when the project has nothing by it. */
export function selectionOfMember(project: Project, id: string): string | null {
  if (project.components.some((c) => c.id === id)) return `c:${id}`
  if (project.traces.some((t) => t.id === id)) return `t:${id}`
  if (project.vias.some((v) => v.id === id)) return `v:${id}`
  if (project.graphics?.some((g) => g.id === id)) return `g:${id}`
  if (project.texts.some((t) => t.layer !== undefined && t.id === id)) return `x:${id}`
  if (project.dimensions?.some((d) => d.id === id)) return `m:${id}`
  if (project.images?.some((m) => m.id === id)) return `i:${id}`
  return null
}

/** The selection ids of everything a group holds. */
export function groupSelection(project: Project, group: PcbGroup): string[] {
  const sets = {
    c: new Set(project.components.map((c) => c.id)),
    t: new Set(project.traces.map((t) => t.id)),
    v: new Set(project.vias.map((v) => v.id)),
    g: new Set((project.graphics ?? []).map((g) => g.id)),
    x: new Set(project.texts.filter((t) => t.layer !== undefined).map((t) => t.id)),
    m: new Set((project.dimensions ?? []).map((d) => d.id)),
    i: new Set((project.images ?? []).map((m) => m.id)),
  }
  const out: string[] = []
  for (const id of leafMembers(project, group)) {
    const kind = (Object.keys(sets) as MemberKind[]).find((k) => sets[k].has(id))
    if (kind) out.push(`${kind}:${id}`)
  }
  return out
}

/** A selection with every group it touches taken whole, as KiCad selects: clicking something in a group picks the group. The same list (the same array) when no object of it is in a group. */
export function expandToGroups(project: Project, selection: string[]): string[] {
  if (!project.groups?.length) return selection
  const out = [...selection]
  const have = new Set(selection)
  const done = new Set<string>()
  let grew = false
  for (const id of selection) {
    const member = memberOfSelection(id)
    const top = member ? topGroup(project, member) : null
    if (!top || done.has(top.id)) continue
    done.add(top.id)
    for (const s of groupSelection(project, top)) {
      if (!have.has(s)) {
        have.add(s)
        out.push(s)
        grew = true
      }
    }
  }
  return grew ? out : selection
}

/** Whether any object of a selection is in a group. */
export const touchesGroup = (project: Project, selection: string[]): boolean =>
  !!project.groups?.length && selection.some((id) => {
    const m = memberOfSelection(id)
    return !!m && !!indexOf(project)?.parent.has(m)
  })

/** The ids under a locked group, at any depth: they are locked while the group is (`BOARD_ITEM::IsLocked` asks the parent group), whatever their own flag says. */
export function lockedByGroup(project: Project): Set<string> {
  const out = new Set<string>()
  if (!project.groups?.length) return out
  for (const g of project.groups) if (g.locked) for (const m of leafMembers(project, g)) out.add(m)
  return out
}

/**
 * A group of the objects selected. An object already in a group brings its outermost group in whole, so groups nest as KiCad nests them (`PCB_GROUP_TOOL::Group`).
 * Null when nothing in the selection can be in a group.
 */
export function createGroup(project: Project, selection: string[], name = ""): { project: Project; group: PcbGroup } | null {
  const members: string[] = []
  for (const id of selection) {
    const m = memberOfSelection(id)
    if (!m || selectionOfMember(project, m) === null) continue
    const top = topGroup(project, m)
    const entry = top ? top.id : m
    if (!members.includes(entry)) members.push(entry)
  }
  if (!members.length) return null
  const group: PcbGroup = { id: uid("gp"), name: name.trim(), members }
  return { project: touch({ ...project, groups: [...(project.groups ?? []), group] }), group }
}

/** Takes a group apart: what was in it goes into the group it was in, or stands alone. */
export function ungroup(project: Project, groupId: string): Project {
  const idx = indexOf(project)
  const g = idx?.groups.get(groupId)
  if (!idx || !g) return project
  const outer = idx.parent.get(groupId)
  const groups = project.groups!.flatMap((x): PcbGroup[] => {
    if (x.id === groupId) return []
    if (x.id !== outer) return [x]
    const at = x.members.indexOf(groupId)
    return [{ ...x, members: [...x.members.slice(0, at), ...g.members, ...x.members.slice(at + 1)] }]
  })
  const { groups: _old, ...rest } = project
  return touch({ ...rest, ...(groups.length ? { groups } : {}) })
}

export function setGroupLocked(project: Project, groupId: string, locked: boolean): Project {
  const g = project.groups?.find((x) => x.id === groupId)
  if (!g || (g.locked === true) === locked) return project
  return touch({ ...project, groups: project.groups!.map((x) => (x.id === groupId ? (locked ? { ...x, locked: true as const } : (({ locked: _l, ...rest }) => rest)(x)) : x)) })
}

export function renameGroup(project: Project, groupId: string, name: string): Project {
  const g = project.groups?.find((x) => x.id === groupId)
  const next = name.trim()
  if (!g || g.name === next) return project
  const groups = project.groups!.map((x) => (x.id === groupId ? { ...x, name: next } : x))
  // X20: a placement area names its group, so a group renamed takes the areas that name it along (unless another group still has the old name).
  const shared = groups.some((x) => x.id !== groupId && x.name === g.name)
  const zones = !shared && g.name !== "" && project.zones.some((z) => z.placement?.by === "group" && z.placement.name === g.name) ? project.zones.map((z) => (z.placement?.by === "group" && z.placement.name === g.name ? { ...z, placement: { ...z.placement, name: next } } : z)) : project.zones
  return touch({ ...project, groups, zones })
}

let aliveCache: { key: unknown[]; value: Set<string> } | null = null

/** Every id a group may name that the project has. Reused while the lists it is made from are the same. */
function aliveIds(project: Project): Set<string> {
  const key = [project.components, project.traces, project.vias, project.graphics, project.texts, project.dimensions, project.images]
  if (aliveCache && aliveCache.key.every((k, i) => k === key[i])) return aliveCache.value
  const value = new Set<string>()
  for (const c of project.components) value.add(c.id)
  for (const t of project.traces) value.add(t.id)
  for (const v of project.vias) value.add(v.id)
  for (const g of project.graphics ?? []) value.add(g.id)
  for (const t of project.texts) if (t.layer !== undefined) value.add(t.id)
  for (const d of project.dimensions ?? []) value.add(d.id)
  for (const m of project.images ?? []) value.add(m.id)
  aliveCache = { key, value }
  return value
}

/**
 * Takes out of the groups what is no longer in the project, and the groups left with nothing: a deleted part, track, via, drawing, text, dimension or image
 * leaves its group, and a group that held only such things goes. The same project (the same object) when no group names something that is gone.
 */
export function pruneGroups(project: Project): Project {
  const groups = project.groups
  if (!groups?.length) return project
  const alive = aliveIds(project)
  const ids = new Set(groups.map((g) => g.id))
  let members = new Map(groups.map((g) => [g.id, g.members.filter((m) => alive.has(m) || ids.has(m))]))
  // A group with nothing in it goes, and the groups that held only it.
  for (;;) {
    const empty = [...members].filter(([, list]) => list.length === 0).map(([id]) => id)
    if (!empty.length) break
    for (const id of empty) members.delete(id)
    members = new Map([...members].map(([id, list]) => [id, list.filter((m) => !empty.includes(m))]))
  }
  const changed = members.size !== groups.length || groups.some((g) => (members.get(g.id)?.length ?? -1) !== g.members.length)
  if (!changed) return project
  const next = groups.filter((g) => members.has(g.id)).map((g) => ({ ...g, members: members.get(g.id)! }))
  const { groups: _old, ...rest } = project
  return { ...rest, ...(next.length ? { groups: next } : {}) }
}

// ---------- a part's own groups ----------

/** A part's groups when the things they name by place have been removed from its land or its list of texts: the later places shift down, and a group left with nothing goes. */
export function remapPartGroups(c: ComponentInstance, kind: "p" | "s" | "t", removed: ReadonlySet<number>): ComponentInstance {
  if (!c.groups?.length || !removed.size) return c
  const shift = (i: number) => i - [...removed].filter((r) => r < i).length
  let groups = c.groups.map((g) => ({
    ...g,
    members: g.members.flatMap((m) => {
      if (m[0] !== kind || !/^\d+$/.test(m.slice(1))) return [m]
      const i = Number(m.slice(1))
      return removed.has(i) ? [] : [`${kind}${shift(i)}`]
    }),
  }))
  // Groups with nothing in them go, and with them the references to them (`g<place>`), which shift as the places do.
  for (;;) {
    const gone = new Set(groups.flatMap((g, i) => (g.members.length === 0 ? [i] : [])))
    if (!gone.size) break
    const down = (i: number) => i - [...gone].filter((r) => r < i).length
    groups = groups
      .filter((_, i) => !gone.has(i))
      .map((g) => ({ ...g, members: g.members.flatMap((m) => (m[0] === "g" && /^\d+$/.test(m.slice(1)) ? (gone.has(Number(m.slice(1))) ? [] : [`g${down(Number(m.slice(1)))}`]) : [m])) }))
  }
  const { groups: _old, ...rest } = c
  // Ids of a part's groups are their places.
  return { ...rest, ...(groups.length ? { groups: groups.map((g, i) => ({ ...g, id: `g${i}` })) } : {}) }
}

// ---------- moving and turning everything a selection holds ----------

/** The point the selection turns about: the middle of its box, on the editor's 0.25 mm grid, which is where KiCad takes it. */
export const pivotOf = (box: { minX: number; minY: number; maxX: number; maxY: number }): Vec2 => ({ x: round(Math.round((box.minX + box.maxX) / 2 / 0.25) * 0.25, 3), y: round(Math.round((box.minY + box.maxY) / 2 / 0.25) * 0.25, 3) })
