import { emptyBox, expandBox, pointOnSegment, round, transformPoint, type Box } from "../lib/geometry"
import { uid } from "../lib/id"
import { SegmentIndex, UnionFind } from "./connectivity"
import { drawnInside } from "./drawings"
import { findPart } from "./library"
import { powerNetName, schematicBounds, schematicPins, valueText } from "./instances"
import { labelBox } from "./labels"
import { componentFields, fieldBox, hasFieldPlaces } from "./symbolDrawing"
import { anchorToExtent, rotateExtent, SCH_GRID, SCH_TEXT } from "./symbols"
import type { ComponentInstance, Project, SchematicBlock, Vec2 } from "./types"

// Schematic blocks: named groups of parts (USB-C INPUT, 3.3V POWER, MCU) drawn as titled frames, as
// on an engineering sheet. A block stores its name and its components and nothing else; its frame
// is worked out from where they are, so it follows them when they move and a layout pass only
// ever moves parts.
//
// A block also takes along what is drawn for its parts alone: the wires between them, the net
// labels on those wires, and the power and ground ports on them that no other part shares. Those
// sit inside the frame and move with the block, and so do the drawings inside the frame (a note on
// the circuit, say; see `drawnInside`), though they don't stretch it.

/** Height of a block's title, three times a designator's. */
export const BLOCK_TITLE = SCH_TEXT * 3
/** Room between a block's frame and what it holds. */
export const BLOCK_PADDING = 0.3
/** From the frame's top-left corner to the title. */
const TITLE_INSET = 0.15
/** Between the title and the parts under it. */
const TITLE_GAP = 0.15

/** Rough advance of a character, as a share of the text height. */
const MONO_ADVANCE = 0.62
const SANS_ADVANCE = 0.6
const TITLE_ADVANCE = 0.68

/** What moves with a block: its components, the ports, wires and labels drawn for them alone, and the drawings inside its frame. */
export interface BlockContents {
  components: string[]
  wires: string[]
  labels: string[]
  drawings: string[]
}

export interface BlockFrame {
  id: string
  name: string
  /** The frame, on the 0.1 grid. */
  box: Box
  /** Top-left corner of the title. */
  title: Vec2
  /** Where a click picks the block up: the title. */
  titleBox: Box
  contents: BlockContents
}

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })
const withBlocks = (p: Project, blocks: SchematicBlock[]): Project => touch({ ...p, blocks: blocks.length ? blocks : undefined })

/** A block name as typed: trimmed, with runs of spaces made one. */
export const cleanBlockName = (name: string) => name.trim().replace(/\s+/g, " ")

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The block a component is in, if any. */
export const blockOf = (project: Project, componentId: string) => project.blocks?.find((b) => b.components.includes(componentId))

/** The block a component is in, unless it is only Tidy's OTHER block for loose parts: those parts count as in no block. */
export const groupOf = (project: Project, componentId: string) => {
  const b = blockOf(project, componentId)
  return b && !b.leftover ? b : undefined
}

/** A block found by name, ignoring case. */
export const findBlock = (project: Project, name: string) => project.blocks?.find((b) => sameName(b.name, cleanBlockName(name)))

/** `name`, or `name 2`, `name 3`... when another block has it already. */
export function uniqueBlockName(project: Project, name: string, except?: string): string {
  const taken = (n: string) => (project.blocks ?? []).some((b) => b.id !== except && sameName(b.name, n))
  const base = cleanBlockName(name) || "BLOCK"
  if (!taken(base)) return base
  let i = 2
  while (taken(`${base} ${i}`)) i++
  return `${base} ${i}`
}

/** The first free BLOCK n, the name a block grouped by hand starts with. */
export function nextBlockName(project: Project): string {
  let i = 1
  while ((project.blocks ?? []).some((b) => sameName(b.name, `BLOCK ${i}`))) i++
  return `BLOCK ${i}`
}

/** Blocks with these components taken out of them; a block left empty goes. */
function without(blocks: SchematicBlock[], ids: Set<string>): SchematicBlock[] {
  return blocks
    .map((b) => (b.components.some((id) => ids.has(id)) ? { ...b, components: b.components.filter((id) => !ids.has(id)) } : b))
    .filter((b) => b.components.length)
}

/** The project's ids among these, once each and in order. */
function existing(project: Project, componentIds: string[]): string[] {
  const ids = new Set(project.components.map((c) => c.id))
  return [...new Set(componentIds)].filter((id) => ids.has(id))
}

/**
 * A new block of these components, taken out of any block they were in. The name is made unique
 * among the blocks; no block is made when none of the components exist.
 */
export function createBlock(project: Project, name: string, componentIds: string[]): { project: Project; block: SchematicBlock | null } {
  const members = existing(project, componentIds)
  if (!members.length) return { project, block: null }
  const block: SchematicBlock = { id: uid("b"), name: uniqueBlockName(project, name), components: members }
  return { project: withBlocks(project, [...without(project.blocks ?? [], new Set(members)), block]), block }
}

/** Put components in a block, taking them out of the one they were in. */
export function addToBlock(project: Project, blockId: string, componentIds: string[]): Project {
  const target = project.blocks?.find((b) => b.id === blockId)
  const ids = existing(project, componentIds).filter((id) => !target?.components.includes(id))
  if (!target || !ids.length) return project
  // The target keeps what it had, so taking the newcomers out of their blocks can't empty it.
  const blocks = without(project.blocks!, new Set(ids)).map((b) => (b.id === blockId ? { ...b, components: [...b.components, ...ids] } : b))
  return withBlocks(project, blocks)
}

/** Take components out of whatever block they are in; a block left empty goes. */
export function removeFromBlocks(project: Project, componentIds: string[]): Project {
  const ids = new Set(componentIds)
  if (!project.blocks?.some((b) => b.components.some((id) => ids.has(id)))) return project
  return withBlocks(project, without(project.blocks, ids))
}

/** Rename a block. An empty name changes nothing; a taken one gets a number. */
export function renameBlock(project: Project, blockId: string, name: string): Project {
  const block = project.blocks?.find((b) => b.id === blockId)
  if (!block || !cleanBlockName(name)) return project
  const unique = uniqueBlockName(project, name, blockId)
  if (unique === block.name) return project
  // Someone naming the block of leftovers has made it their own.
  return withBlocks(project, project.blocks!.map((b) => (b.id === blockId ? { id: b.id, name: unique, components: b.components } : b)))
}

/** Remove blocks. Their parts stay where they are, in no block. */
export function deleteBlocks(project: Project, blockIds: string[]): Project {
  const ids = new Set(blockIds)
  if (!project.blocks?.some((b) => ids.has(b.id))) return project
  return withBlocks(project, project.blocks.filter((b) => !ids.has(b.id)))
}

/** Blocks once these components are deleted, absent when none are left. */
export function blocksWithout(blocks: SchematicBlock[], componentIds: Set<string>): SchematicBlock[] | undefined {
  const left = without(blocks, componentIds)
  return left.length ? left : undefined
}

/**
 * Group a selection: its components and the parts of its blocks join the first selected block, or
 * a new one when no block is selected. Returns the block they are in now.
 */
export function groupSelection(project: Project, componentIds: string[], blockIds: string[]): { project: Project; blockId: string | null } {
  const selected = blockIds.map((id) => project.blocks?.find((b) => b.id === id)).filter((b): b is SchematicBlock => !!b)
  const ids = [...selected.flatMap((b) => b.components), ...componentIds]
  if (selected.length) return { project: addToBlock(project, selected[0].id, ids), blockId: selected[0].id }
  const { project: next, block } = createBlock(project, nextBlockName(project), ids)
  return { project: next, blockId: block?.id ?? null }
}

/** Ungroup a selection: its blocks go, and its components leave the blocks they were in. */
export function ungroupSelection(project: Project, componentIds: string[], blockIds: string[]): Project {
  return removeFromBlocks(deleteBlocks(project, blockIds), componentIds)
}

// ---------- Frames ----------

/** Where a component's designator and value are drawn; both stay upright whatever the turn. */
export function componentTextBoxes(c: ComponentInstance): Box[] {
  const part = findPart(c.partId)
  if (!part) return []
  if (hasFieldPlaces(part)) return fieldBoxes(c, part)
  const ref = powerNetName(c, part) ?? c.ref
  const value = part.powerNet ? "" : valueText(c, part)
  const out: Box[] = []
  for (const p of part.symbol.primitives) {
    if (p.type !== "text" || (p.role !== "ref" && p.role !== "value")) continue
    const text = p.role === "ref" ? ref : value
    if (!text) continue
    const size = p.size ?? SCH_TEXT
    const width = text.length * size * (p.role === "ref" ? MONO_ADVANCE : SANS_ADVANCE)
    const at = transformPoint(p, c.sch, c.sch.rot)
    const e = rotateExtent(anchorToExtent(p.anchor), c.sch.rot)
    const x0 = e.x > 0 ? at.x : e.x < 0 ? at.x - width : at.x - width / 2
    const y0 = e.y > 0 ? at.y : e.y < 0 ? at.y - size : at.y - size / 2
    out.push({ minX: x0, minY: y0, maxX: x0 + width, maxY: y0 + size })
  }
  return out
}

/**
 * The text of an imported part: a box for each field it shows, where the field says, however the
 * symbol is turned or mirrored (a field's place is its own, as KiCad has it). A text that reads up
 * the sheet is tall, not wide. The width is estimated as for the editor's own texts.
 */
function fieldBoxes(c: ComponentInstance, part: NonNullable<ReturnType<typeof findPart>>): Box[] {
  return componentFields(c, part).map((f) => fieldBox(c, f, f.name === "Reference" ? MONO_ADVANCE : SANS_ADVANCE))
}

/**
 * What is drawn joined, island by island: wires that touch, with the pins and labels on them. Unlike
 * a net, two labels of one name don't join their islands, since the drawing doesn't.
 */
export interface Islands {
  /** Component ids with a pin in each island. */
  components: Map<string, Set<string>>
  wires: Map<string, string[]>
  labels: Map<string, string[]>
}

const pointKey = (p: Vec2) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`

export function drawnIslands(project: Project): Islands {
  const uf = new UnionFind()
  const at = new Map<string, string[]>()
  const put = (p: Vec2, key: string) => {
    uf.find(key)
    const k = pointKey(p)
    at.set(k, [...(at.get(k) ?? []), key])
  }
  for (const c of project.components) for (const pin of schematicPins(c)) put(pin.pos, `c:${c.id}:${pin.pin}`)
  for (const w of project.wires) for (const p of w.points) put(p, `w:${w.id}`)
  for (const l of project.labels) put(l, `l:${l.id}`)
  for (const keys of at.values()) for (const key of keys.slice(1)) uf.union(keys[0], key)
  // A wire end or label on another wire's run is a T-junction.
  const probes: [Vec2, string][] = [
    ...project.wires.flatMap((w): [Vec2, string][] => (w.points.length < 2 ? [] : [[w.points[0], `w:${w.id}`], [w.points[w.points.length - 1], `w:${w.id}`]])),
    ...project.labels.map((l): [Vec2, string] => [l, `l:${l.id}`]),
  ]
  const index = new SegmentIndex(project.wires)
  for (const [p, owner] of probes) {
    for (const [wi, segs] of index.near(p)) {
      const w = project.wires[wi]
      if (`w:${w.id}` === owner) continue
      if (segs.some((i) => pointOnSegment(p, w.points[i], w.points[i + 1]))) uf.union(owner, `w:${w.id}`)
    }
  }
  const islands: Islands = { components: new Map(), wires: new Map(), labels: new Map() }
  for (const key of uf.keys()) {
    const root = uf.find(key)
    const id = key.slice(2)
    if (key.startsWith("c:")) {
      const set = islands.components.get(root) ?? new Set()
      islands.components.set(root, set.add(id.slice(0, id.lastIndexOf(":"))))
    } else {
      const map = key.startsWith("w:") ? islands.wires : islands.labels
      map.set(root, [...(map.get(root) ?? []), id])
    }
  }
  return islands
}

/**
 * What each block holds: its components, then every island drawn only between them and power or
 * ground ports of no block, with those ports. An island that reaches any other part stays outside,
 * and is what stretches when the block moves.
 */
function blockContents(project: Project, islands: Islands): Map<string, BlockContents> {
  const blocked = new Set((project.blocks ?? []).flatMap((b) => b.components))
  const port = new Set(project.components.filter((c) => findPart(c.partId)?.powerNet).map((c) => c.id))
  const out = new Map<string, BlockContents>()
  for (const block of project.blocks ?? []) {
    const members = new Set(block.components)
    const components = new Set(block.components)
    const wires: string[] = []
    const labels: string[] = []
    for (const [root, touched] of islands.components) {
      const ids = [...touched]
      if (!ids.some((id) => members.has(id))) continue
      if (!ids.every((id) => members.has(id) || (port.has(id) && !blocked.has(id)))) continue
      for (const id of ids) components.add(id)
      wires.push(...(islands.wires.get(root) ?? []))
      labels.push(...(islands.labels.get(root) ?? []))
    }
    out.set(block.id, { components: [...components], wires, labels, drawings: [] })
  }
  return out
}

const floorGrid = (n: number) => round(Math.floor(n / SCH_GRID + 1e-6) * SCH_GRID)
const ceilGrid = (n: number) => round(Math.ceil(n / SCH_GRID - 1e-6) * SCH_GRID)

const frameCache = new WeakMap<Project, BlockFrame[]>()

/**
 * Each block's frame: around its parts with their designators and values, and the wires, labels
 * and ports it holds, padded, with room for the title above, snapped out to the grid. A block whose
 * parts are all gone has none.
 */
export function blockFrames(project: Project): BlockFrame[] {
  if (!project.blocks?.length) return []
  const hit = frameCache.get(project)
  if (hit) return hit
  const contents = blockContents(project, drawnIslands(project))
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const wireById = new Map(project.wires.map((w) => [w.id, w]))
  const labelById = new Map(project.labels.map((l) => [l.id, l]))
  const frames: BlockFrame[] = []
  for (const block of project.blocks) {
    const holds = contents.get(block.id)!
    const content = emptyBox()
    const add = (b: Box) => {
      expandBox(content, { x: b.minX, y: b.minY })
      expandBox(content, { x: b.maxX, y: b.maxY })
    }
    for (const id of holds.components) {
      const c = byId.get(id)
      if (!c) continue
      add(schematicBounds(c))
      componentTextBoxes(c).forEach(add)
    }
    for (const id of holds.wires) for (const p of wireById.get(id)?.points ?? []) expandBox(content, p)
    for (const id of holds.labels) {
      const l = labelById.get(id)
      if (l) add(labelBox(l))
    }
    if (!Number.isFinite(content.minX)) continue

    const titleWidth = block.name.length * BLOCK_TITLE * TITLE_ADVANCE
    const minX = floorGrid(content.minX - BLOCK_PADDING)
    const minY = floorGrid(content.minY - BLOCK_PADDING)
    const maxX = ceilGrid(Math.max(content.maxX + BLOCK_PADDING, content.minX - BLOCK_PADDING + titleWidth + TITLE_INSET * 2))
    const maxY = ceilGrid(content.maxY + TITLE_GAP + BLOCK_TITLE + TITLE_INSET)
    const title = { x: round(minX + TITLE_INSET), y: round(maxY - TITLE_INSET) }
    const box = { minX, minY, maxX, maxY }
    frames.push({
      id: block.id,
      name: block.name,
      box,
      title,
      titleBox: { minX, minY: round(title.y - BLOCK_TITLE - TITLE_INSET / 2), maxX: round(Math.min(maxX, title.x + titleWidth + TITLE_INSET)), maxY },
      contents: { ...holds, drawings: (project.drawings ?? []).filter((d) => drawnInside(d, box)).map((d) => d.id) },
    })
  }
  frameCache.set(project, frames)
  return frames
}

/**
 * Frames while parts are being dragged, without working them out again on every step: as they
 * were before the drag, those whose parts all move shifted with them, the rest as they stood.
 * They are worked out properly once the drag ends.
 */
export function framesDuringDrag(base: Project, moving: string[], delta: Vec2): BlockFrame[] {
  const ids = new Set(moving)
  const shift = (b: Box): Box => ({ minX: round(b.minX + delta.x), minY: round(b.minY + delta.y), maxX: round(b.maxX + delta.x), maxY: round(b.maxY + delta.y) })
  return blockFrames(base).map((f) =>
    f.contents.components.some((id) => !ids.has(id))
      ? f
      : { ...f, box: shift(f.box), titleBox: shift(f.titleBox), title: { x: round(f.title.x + delta.x), y: round(f.title.y + delta.y) } },
  )
}

/** Everything the given blocks hold, to move or copy them whole. */
export function contentsOf(project: Project, blockIds: string[]): BlockContents {
  const ids = new Set(blockIds)
  const frames = blockFrames(project).filter((f) => ids.has(f.id))
  const merged = (key: keyof BlockContents) => [...new Set(frames.flatMap((f) => f.contents[key]))]
  return { components: merged("components"), wires: merged("wires"), labels: merged("labels"), drawings: merged("drawings") }
}

/**
 * S4: the name of the first locked group (KiCad's locked group) that holds any of these parts, or null.
 * Its parts cannot be moved, turned or deleted on the sheet until the group is unlocked.
 */
export function lockedBlockOf(project: Project, componentIds: string[]): string | null {
  const ids = new Set(componentIds)
  return project.blocks?.find((b) => b.locked && b.components.some((id) => ids.has(id)))?.name ?? null
}
