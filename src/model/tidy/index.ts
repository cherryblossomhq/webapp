import { emptyBox, expandBox, pointOnSegment, round, samePoint, snap, type Box } from "../../lib/geometry"
import { renameChainNets } from "../netChains"
import { renameStoredNets } from "../copperNets"
import { renameClassNets } from "../netClasses"
import { blockFrames, blocksWithout, componentTextBoxes, drawnIslands, uniqueBlockName } from "../blocks"
import { blockPorts, readingOrder } from "../blockPorts"
import { bareName, computeConnectivity, pinKey } from "../connectivity"
import { drawingBounds, moveDrawing } from "../drawings"
import { hasDirectives } from "../directives"
import { hasFlaggedRuleAreas } from "../ruleAreas"
import { settleKicadSheet } from "../kicadJoin"
import { isExact } from "../sheetItems"
import { isSchematicPart, pinStubPoint, schematicBounds, schematicPins, unitOwners } from "../instances"
import { labelBox } from "../labels"
import { findPart } from "../library"
import { componentFields, hasFieldPlaces } from "../symbolDrawing"
import { naturalCompare } from "../../lib/natural"
import { SCH_GRID } from "../symbols"
import type { ComponentInstance, NetLabel, Project, Rotation, SchematicBlock, SchematicDrawing, Vec2, Wire } from "../types"
import type { BlockDrawing } from "./block"
import { layoutBlock } from "./clusters"
import { cutAtBlock, deadRuns, type Cut } from "./cut"
import { flowOrder, packRows } from "./flow"
import { isArranged, madeUpNets, nameForNet, netInfo, type NetInfo } from "./nets"
import { Room, type Terminal } from "./room"
import { portInstance, portPrefix, portShape, reseat, tidyPinId, withoutTexts, withPortVias, type Dir, type PortVia, type RailKind } from "./shapes"

// Tidy: the schematic redrawn as titled blocks in reading order (`flow.ts`), each split into a
// drawing per chip with the parts that serve it (`clusters.ts`) and laid out about it (`block.ts`),
// with every net that leaves a block labelled at its pins. It runs only when asked (the toolbar
// button, `T`, or Sakura's `tidy_schematic`), on the whole sheet or on one block, and is one undo
// step. One block is tidied where it is, and only the drawing that served it alone is drawn anew
// (`cut.ts`).
//
// It never changes what is connected: the netlist is compared pin for pin before and after, and
// a tidy that would change it is refused with the project as it was. Parts keep their pins where
// their symbols have them; only positions and turns change, and wires, labels and ports are drawn
// anew. Wires, labels and ports that reach no part, and wire from a pin to nowhere, are kept as
// they are drawn (by a whole-sheet tidy, moved below the blocks) and counted in the message. A
// named net keeps the name it goes by, and every other name it had is drawn as a label of its own;
// a name there is no room for anywhere is the only one left out, and the message says so. An
// unnamed net that has to be labelled is named after its most telling pin (the way boards imported
// from tscircuit are), and a pour, via or trace width that named it by its old name follows the
// new one. A name `connect` made up (`NET3`) counts as none: it stays only on the labels the net
// needs, and what the board kept under it follows the net where it goes.

export interface TidyOptions {
  /** Tidy only this block, where it is; the whole sheet when absent. */
  blockId?: string
}

export interface TidyResult {
  project: Project
  /** False when nothing was done: nothing to tidy, already tidy, or it would have changed a connection. */
  changed: boolean
  ok: boolean
  /** One sentence for the user. */
  message: string
  /** Unnamed nets that were named for their labels, by their old name. */
  renamed: Record<string, string>
  /** Nets that had more than one name, with the names no longer drawn: the net keeps `net`. */
  dropped: { net: string; names: string[] }[]
  /** Wires, labels and ports that reach no part, kept and moved below the blocks. */
  loose: { wires: number; labels: number; ports: number }
  /** What went wrong, for a refused tidy. */
  problems: string[]
  /**
   * Blocks a whole-sheet tidy couldn't lay out, kept exactly as they were drawn while the rest was
   * tidied around them, with why. Absent means none, so a result built elsewhere needn't name it.
   */
  kept?: { block: string; why: string }[]
}

/** Between block frames. */
export const BLOCK_GAP = 0.5

const NONE = { wires: 0, labels: 0, ports: 0 }

const fail = (project: Project, message: string, problems: string[] = []): TidyResult => ({
  project,
  changed: false,
  ok: false,
  message,
  renamed: {},
  dropped: [],
  loose: NONE,
  problems,
  kept: [],
})

const sameSch = (a: ComponentInstance["sch"], b: ComponentInstance["sch"]) => a.x === b.x && a.y === b.y && a.rot === b.rot

/**
 * The OTHER block of a tidied sheet remembers where every part was drawn before (`origins`), so that
 * Clean up can still tell which chip a capacitor stood beside. Positions an earlier tidy
 * remembered are kept while they still describe the whole sheet; otherwise the sheet as it was
 * before this tidy is what is remembered.
 */
function rememberOrigins(before: Project, after: Project, kept: TidyResult["kept"] = []): Project {
  const leftover = after.blocks?.find((b) => b.leftover)
  if (!leftover) return after
  // A block Tidy kept exactly as drawn was not laid out: what it remembers stays as it was.
  if (kept.some((k) => k.block === leftover.name)) return after
  const remembered = new Map<string, NonNullable<SchematicBlock["origins"]>[string]>()
  for (const b of before.blocks ?? []) if (b.leftover) for (const [id, o] of Object.entries(b.origins ?? {})) remembered.set(id, o)
  const was = new Map(before.components.map((c) => [c.id, c]))
  const arranged = after.components.filter((c) => isArranged(c.partId) && was.has(c.id))
  const carried = arranged.every((c) => {
    const o = remembered.get(c.id)
    return !!o && sameSch(was.get(c.id)!.sch, o.to)
  })
  const origins: NonNullable<SchematicBlock["origins"]> = {}
  for (const c of arranged) origins[c.id] = { from: carried ? remembered.get(c.id)!.from : was.get(c.id)!.sch, to: c.sch }
  return { ...after, blocks: after.blocks!.map((b) => (b === leftover ? { ...b, origins } : b)) }
}

/**
 * The drawings inside a block's frame (a note on its circuit) go where the block went, by its
 * frame's top-left corner, as they do when the block is dragged. The others stay where they are.
 */
function carryDrawings(before: Project, after: Project): Project {
  if (!before.drawings?.length) return after
  const now = new Map(blockFrames(after).map((f) => [f.id, f.box]))
  const by = new Map<string, Vec2>()
  for (const f of blockFrames(before)) {
    const to = now.get(f.id)
    if (!to) continue
    const d = { x: round(snap(to.minX - f.box.minX, SCH_GRID)), y: round(snap(to.maxY - f.box.maxY, SCH_GRID)) }
    if (d.x || d.y) for (const id of f.contents.drawings) if (!by.has(id)) by.set(id, d)
  }
  if (!by.size) return after
  return { ...after, drawings: after.drawings?.map((d) => (by.has(d.id) ? moveDrawing(d, by.get(d.id)!) : d)) }
}

/** Tidy the schematic: the whole sheet, or one block. */
export function tidySchematic(project: Project, options: TidyOptions = {}): TidyResult {
  const result = tidyCore(project, options)
  if (!result.ok || !result.changed) return result
  const project2 = carryDrawings(project, rememberOrigins(project, result.project, result.kept))
  return project2 === result.project ? result : { ...result, project: project2 }
}

function tidyCore(project: Project, options: TidyOptions = {}): TidyResult {
  // S8: a directive label is on a wire or a pin, and a rule area's flags belong to the parts inside it: Tidy draws every wire anew and moves the parts, which would leave
  // the labels on nothing and change which parts the areas hold. It leaves such a sheet as it is, and says why.
  if (hasDirectives(project) || hasFlaggedRuleAreas(project)) return fail(project, "Tidy draws the wires again and moves the parts, and this sheet has directive labels or rule areas that belong to the wires and parts where they are, so nothing was changed. Arrange the parts by hand, or delete those first.")
  // S3: Tidy redraws every wire and leaves the drawings where they are, so a bus entry would stay where it was and the wire that met it would go: a sheet with buses is left as drawn, and the nets are the same by name either way.
  if (project.drawings?.some((d) => d.type === "bus" || d.type === "busentry")) return fail(project, "Tidy can't arrange a sheet with buses yet: it redraws the wires, and a bus entry would be left where it was with its wire gone, so nothing was changed.")
  const info = netInfo(project)
  // Where a net has a power symbol brought in from KiCad, its ports are that symbol, not the editor's own.
  const vias = new Map<string, PortVia>()
  const stuck: string[] = []
  for (const net of info.nets.values()) {
    if (!net.port) continue
    if (net.portProblem) stuck.push(`${net.name}: ${net.portProblem}`)
    else vias.set(net.name, net.port)
  }
  // A power symbol Tidy can't redraw is left as drawn, and so is the whole sheet: it draws every port anew.
  if (stuck.length) return fail(project, `Tidy can't redraw the power symbol on ${stuck.length === 1 ? "a net" : "some nets"}, so nothing was changed.`, stuck)
  const unrouted = pinsKeptApart(project)
  if (unrouted.length) return fail(project, "Tidy can't arrange a part with two pins of one number wired apart, so nothing was changed.", unrouted)
  return withPortVias(vias, () => tidyRun(project, options, info))
}

/** The refusal for a block with no room: when it is the text of parts that leaves none, it says whose. */
const noRoom = (text?: string | null) => `Tidy couldn't find room for everything; nothing was changed.${text ? ` ${text[0].toUpperCase()}${text.slice(1)}.` : ""}`

/**
 * Whether the text of KiCad-drawn parts is what leaves a block no room: a part's fields stay where its
 * file puts them, and Tidy can't move them clear of the wires and ports it draws. Found by laying the
 * block out again with the text of the part that is named (or of all of them) not counted; when that
 * works, the answer names the parts and the fields.
 */
function textInTheWay(parts: ComponentInstance[], lay: (parts: ComponentInstance[]) => unknown, why: string): string | null {
  const drawn = parts.filter((c) => {
    const part = findPart(c.partId)
    return !!part && hasFieldPlaces(part) && componentTextBoxes(c).length > 0
  })
  if (!drawn.length) return null
  const named = /no room for ([^:]+):/.exec(why)?.[1]
  const first = drawn.filter((c) => c.ref === named)
  for (const group of first.length && first.length < drawn.length ? [first, drawn] : [drawn]) {
    const ids = new Set(group.map((c) => c.id))
    try {
      withoutTexts(ids, () => lay(parts.map((c) => (ids.has(c.id) ? { ...c } : c))))
    } catch {
      continue
    }
    const list = group.slice(0, 4).map((c) => `${c.ref} (${componentFields(c, findPart(c.partId)!).map((f) => f.name).join(", ")})`)
    return `the text of ${list.join(", ")}${group.length > 4 ? ` and ${group.length - 4} more` : ""} is where KiCad drew it, and Tidy can't move it clear of the wires`
  }
  return null
}

function tidyRun(project: Project, options: TidyOptions, info: NetInfo): TidyResult {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const arranged = (id: string) => {
    const c = byId.get(id)
    return !!c && isArranged(c.partId)
  }

  // ---------- What is tidied ----------
  let blocks: SchematicBlock[] = (project.blocks ?? []).map((b) => ({ ...b }))
  let scope: SchematicBlock[]
  if (options.blockId) {
    const target = blocks.find((b) => b.id === options.blockId)
    if (!target) return fail(project, "That block is gone.")
    scope = [target]
  } else {
    // Parts in no block go into one, so nothing floats.
    const inBlock = new Set(blocks.flatMap((b) => b.components))
    const loose = project.components.filter((c) => isArranged(c.partId) && !inBlock.has(c.id)).map((c) => c.id)
    const existing = blocks.find((b) => b.leftover)
    if (loose.length && existing) {
      // Parts added since an earlier tidy join the block it made for the ones it could not place.
      blocks = blocks.map((b) => (b === existing ? { ...b, components: [...b.components, ...loose] } : b))
    } else if (loose.length) {
      const ids = new Set(blocks.map((b) => b.id))
      let id = "b_other"
      for (let i = 2; ids.has(id); i++) id = `b_other_${i}`
      blocks = [...blocks, { id, name: uniqueBlockName(project, "OTHER"), components: loose, leftover: true }]
    }
    scope = blocks
  }
  const members = new Map(scope.map((b) => [b.id, b.components.filter(arranged).map((id) => byId.get(id)!)]))
  if (![...members.values()].some((m) => m.length)) return fail(project, "There is nothing to tidy.")
  const blockOf = new Map<string, string>()
  for (const b of blocks) for (const id of b.components) blockOf.set(id, b.id)

  // ---------- Names ----------
  /** In a project named as KiCad names its nets, the style each label text has: the labels Tidy draws are of it. */
  const styles = project.netNames ? labelStyles(project, info) : null
  const taken = new Set([...info.nets.values()].map((n) => n.name))
  for (const l of project.labels) taken.add(l.name.trim())
  const assigned = new Map<string, string>()
  const labelName = (net: string) => {
    const n = info.nets.get(net)!
    if (n.named) return n.name
    // A project named as KiCad names its nets keeps the name KiCad gave a net nothing names: the label Tidy draws for it is a global one of that name.
    if (project.netNames) return n.name
    let name = assigned.get(net)
    if (!name) assigned.set(net, (name = nameForNet(project, n, taken)))
    return name
  }

  // A net's other names (a 5V label and a VCC port on one net) are kept: each drawn as a label.
  const aliases = new Map<string, string[]>()
  for (const c of info.conn.conflicts) {
    const net = info.nets.get(c.netId)
    if (net) aliases.set(c.netId, c.names.filter((n) => n !== net.name))
  }

  // ---------- Each block on its own ----------
  const withBlocks: Project = { ...project, blocks }
  const drawings = new Map<string, BlockDrawing>()
  const order = readingOrder(withBlocks, info)
  // A block of a whole-sheet tidy that can't be laid out is kept as it was drawn, and the rest is
  // tidied around it; one block tidied on its own, or a sheet none of whose blocks can be, is refused.
  const kept: { id: string; name: string; why: string }[] = []
  for (const b of scope) {
    const parts = members.get(b.id)!
    if (!parts.length) continue
    const ports = blockPorts(withBlocks, b.id, info, order)
    const facing = new Map(ports.map((p) => [p.net, p.direction === "in" ? ("left" as Dir) : p.direction === "out" ? ("right" as Dir) : null]))
    const external = (net: string) =>
      info.nets.get(net)!.pins.some((k) => {
        const id = k.slice(0, k.lastIndexOf(":"))
        return arranged(id) && blockOf.get(id) !== b.id
      })
    const lay = (list: ComponentInstance[]) => layoutBlock(list, { nets: info, external, labelName, facing: (net) => facing.get(net) ?? null, aliases: (net) => aliases.get(net) ?? [] })
    try {
      drawings.set(b.id, lay(parts))
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const text = textInTheWay(parts, lay, raw)
      const why = text ?? raw
      if (options.blockId) return fail(project, noRoom(text), [why])
      kept.push({ id: b.id, name: b.name, why })
    }
  }
  if (!drawings.size) return fail(project, noRoom(kept.find((k) => k.why.startsWith("the text of"))?.why), kept.map((k) => k.why))
  /** The parts of kept blocks: they stay where they are, with all of the drawing that is theirs alone. */
  const keptParts = new Set(kept.flatMap((k) => members.get(k.id)!.map((c) => c.id)))

  // ---------- What is drawn anew ----------
  const removed = { wires: new Set<string>(), labels: new Set<string>(), comps: new Set<string>() }
  /** Pins outside the tidied block that lose a wire into it, and get a port or label of their own. */
  const outside: Outside[] = []
  /** Wires, labels and ports that reach no part: kept as drawn, and moved below the blocks. */
  const loose: Island[] = []
  /** What is left of wires a one-block tidy cut, and the points on them that need a label or port. */
  const pieces: Vec2[][] = []
  const taps: Cut["taps"] = []
  /** Wire to nowhere a whole-sheet tidy keeps, below the blocks: by id, and runs of wires cut from it. */
  const stubs: { wires: string[]; pieces: Vec2[][] }[] = []
  const islands = drawnIslands(project)
  /** Drawing that reaches a kept block's parts and no others: it stays exactly as it is, by id. */
  const keptDrawing = { wires: new Set<string>(), labels: new Set<string>(), comps: new Set<string>() }
  if (!options.blockId) {
    const roots = new Set([...islands.components.keys(), ...islands.wires.keys(), ...islands.labels.keys()])
    /** Drawing shared by a kept block and tidied ones: cut where it leaves the tidied parts, as one block's tidy is. */
    const shared: Island[] = []
    for (const root of roots) {
      const comps = [...(islands.components.get(root) ?? [])]
      const wires = islands.wires.get(root) ?? []
      const labels = islands.labels.get(root) ?? []
      if (!comps.some(arranged)) {
        loose.push({ wires, labels, comps })
        continue
      }
      if (comps.some((id) => keptParts.has(id))) {
        if (comps.some((id) => arranged(id) && !keptParts.has(id))) shared.push({ wires, labels, comps })
        else {
          for (const id of wires) keptDrawing.wires.add(id)
          for (const id of labels) keptDrawing.labels.add(id)
          for (const id of comps) keptDrawing.comps.add(id)
        }
        continue
      }
      // Wire from a pin to nowhere (a stub, a branch off a labelled pin's wire) is kept as drawn too.
      const dead = deadRuns(project, wires, labels, comps)
      stubs.push(...dead)
      const kept = new Set(dead.flatMap((s) => s.wires))
      for (const id of wires) if (!kept.has(id)) removed.wires.add(id)
      for (const id of labels) removed.labels.add(id)
      for (const id of comps) if (!arranged(id)) removed.comps.add(id)
    }
    if (shared.length) {
      const wires = new Set(shared.flatMap((i) => i.wires))
      const labels = new Set(shared.flatMap((i) => i.labels))
      const comps = new Set(shared.flatMap((i) => i.comps))
      const only: Project = {
        ...project,
        components: project.components.filter((c) => arranged(c.id) || comps.has(c.id)),
        wires: project.wires.filter((w) => wires.has(w.id)),
        labels: project.labels.filter((l) => labels.has(l.id)),
      }
      const inside = new Set(project.components.filter((c) => arranged(c.id) && !keptParts.has(c.id)).map((c) => c.id))
      const cut = cutAtBlock(only, inside, info, arranged)
      for (const id of cut.wires) removed.wires.add(id)
      for (const id of cut.labels) removed.labels.add(id)
      for (const id of cut.comps) removed.comps.add(id)
      outside.push(...cut.outside)
      pieces.push(...cut.pieces)
      taps.push(...cut.taps)
    }
  } else {
    // Only the wire from the block's pins to the first junction or other part goes.
    const inside = new Set(members.get(options.blockId)!.map((c) => c.id))
    for (const id of scope[0].components) if (!arranged(id) && byId.has(id)) removed.comps.add(id)
    const cut = cutAtBlock(project, inside, info, arranged)
    for (const id of cut.wires) removed.wires.add(id)
    for (const id of cut.labels) removed.labels.add(id)
    for (const id of cut.comps) removed.comps.add(id)
    outside.push(...cut.outside)
    pieces.push(...cut.pieces)
    taps.push(...cut.taps)
  }

  // A cut at a point off the grid (wire drawn off it) would put its label there too: it moves along
  // its wire to the grid first.
  const onGridTaps = snapCutTaps(project, removed, pieces, taps)

  // ---------- What stays, and what a one-block tidy adds around the block ----------
  const ids = new IdAllocator(project, removed)
  const counters = { "#PWR": refBase(project, removed, "#PWR"), "#GND": refBase(project, removed, "#GND") }
  const stubWires: Wire[] = []
  for (const s of stubs) {
    const made = s.pieces.map((points) => ({ id: ids.next("w"), points }))
    stubWires.push(...made)
    loose.push({ wires: [...s.wires, ...made.map((w) => w.id)], labels: [], comps: [] })
  }
  let base: Project = {
    ...project,
    components: project.components.filter((c) => !removed.comps.has(c.id)),
    wires: [...project.wires.filter((w) => !removed.wires.has(w.id)), ...pieces.map((points) => ({ id: ids.next("w"), points })), ...stubWires],
    labels: project.labels.filter((l) => !removed.labels.has(l.id)),
  }
  // What a one-block tidy adds around the block goes where there is room for it.
  const room = outside.length || taps.length ? new Room(base) : null
  // Pins outside a tidied block that its wires reached: a port each on a supply, else a label.
  for (const r of outside) {
    const net = info.nets.get(r.net)!
    base = markOutside(base, r, net.rail, net.rail ? net.name : labelName(r.net), ids, counters, room!)
  }
  // Wire left behind where a one-block tidy cut it: a label or port where the cut was, or on a
  // short stub off it where that is crowded. Every wire end the cut made gets one; a piece cut only
  // where its wires go on gets one where it has room.
  /** A mark where it has room (or anyway, if `always`), with the bit of wire that leads there. */
  const tapLed = (p: Project, t: GridTap, rail: RailKind | null, name: string, always: boolean) => {
    const next = tapAt(p, t, rail, name, ids, counters, room!, always)
    return next !== p && t.lead ? { ...next, wires: [...next.wires, { id: ids.next("w"), points: t.lead }] } : next
  }
  const pieceNos = [...new Set(taps.map((t) => t.piece))]
  for (const no of pieceNos) {
    const mine = taps.filter((t) => t.piece === no)
    const ends = mine.filter((t) => t.end)
    const net = info.nets.get(mine[0].net)!
    const name = net.rail ? net.name : labelName(mine[0].net)
    if (ends.length) {
      for (const t of ends) {
        const was = base
        for (const g of onGridTaps.get(t) ?? []) if (base === was) base = tapLed(base, g, net.rail, name, false)
        if (base === was) base = tapAt(base, t, net.rail, name, ids, counters, room!, true)
      }
      continue
    }
    let placed = false
    // On the grid first, where a cut off it has a spot there with room.
    for (const t of [...mine.flatMap((t) => onGridTaps.get(t) ?? []), ...mine]) {
      const next = tapLed(base, t, net.rail, name, false)
      if (next === base) continue
      base = next
      placed = true
      break
    }
    if (!placed) base = tapAt(base, mine[0], net.rail, name, ids, counters, room!, true)
  }

  // ---------- Where each block goes ----------
  const frames = new Map<string, Box>()
  for (const [id, d] of drawings) frames.set(id, frameOf(project, blocks.find((b) => b.id === id)!, d, styles))
  const offsets = new Map<string, Vec2>()
  /** What a whole-sheet tidy keeps where it is: what is kept below the blocks goes below this too. */
  let keptArea: Box | null = null
  if (!options.blockId) {
    const order = flowOrder(withBlocks, scope.filter((b) => drawings.has(b.id)), info)
    const packed = packRows(
      order.map((f) => ({ id: f.id, width: round(frames.get(f.id)!.maxX - frames.get(f.id)!.minX), height: round(frames.get(f.id)!.maxY - frames.get(f.id)!.minY) })),
      BLOCK_GAP,
      // A short frame goes under the one before it where the row is tall enough, rather than
      // alone on a row of its own.
      true,
    )
    // Beside what is kept, where a block was: the tidied blocks go together beside all of it.
    let corner: Vec2 | null = sheetCorner(project)
    if (kept.length) {
      const fixed = fixedDrawing(base, new Set(kept.map((k) => k.id)), new Set([...drawings.keys()].flatMap((id) => members.get(id)!.map((c) => c.id))), loose)
      corner = besideKept(fixed, packed, frames)
      if (!corner) return fail(project, `Tidy couldn't find room around ${kept.map((k) => k.name).join(" and ")}, which it had to keep as drawn; nothing was changed.`, kept.map((k) => k.why))
      keptArea = fixed.box
    }
    for (const [id, at] of packed) {
      const f = frames.get(id)!
      offsets.set(id, { x: round(corner.x + at.x - f.minX), y: round(corner.y + at.y - f.maxY) })
    }
    // What a KiCad sheet drew (its text, shapes and pictures) stays where it is: what is tidied goes below those it would cover.
    const fixedDrawings = sheetFixed(project)
    if (fixedDrawings.length && !kept.length) {
      const dy = clearOfItems(fixedDrawings, [...offsets].map(([id, o]) => ({ f: frames.get(id)!, o })))
      if (dy) for (const [id, o] of offsets) offsets.set(id, { x: o.x, y: round(o.y + dy) })
    }
  } else {
    const id = options.blockId
    const before = blockFrames(project).find((f) => f.id === id)
    const f = frames.get(id)
    if (f) {
      const corner = before ? { x: before.box.minX, y: before.box.maxY } : { x: f.minX, y: f.maxY }
      // Clear of everything that stays, what was just added around it included, so a second tidy
      // finds it where the first put it.
      offsets.set(id, freeSpot(base, { wires: new Set(), labels: new Set(), comps: new Set() }, id, f, corner, []))
    }
  }

  // ---------- The project, drawn anew ----------
  const moved = new Map<string, { x: number; y: number; rot: Rotation }>()
  const newWires: { net: string; points: Vec2[] }[] = []
  const newLabels: NetLabel[] = []
  const newPorts: ComponentInstance[] = []
  for (const b of scope) {
    const d = drawings.get(b.id)
    const off = offsets.get(b.id)
    if (!d || !off) continue
    const at = (p: Vec2) => ({ x: round(p.x + off.x), y: round(p.y + off.y) })
    for (const [id, p] of d.parts) moved.set(id, { ...at(p), rot: p.rot })
    for (const w of d.wires) newWires.push({ net: w.net, points: w.points.map(at) })
    for (const l of d.labels) newLabels.push({ id: ids.next("l"), name: l.name, ...at(l), rot: l.rot })
    for (const p of d.ports) {
      const part = findPart(p.partId)!
      const prefix = portPrefix(p.partId)
      newPorts.push({
        id: ids.next("c"),
        partId: p.partId,
        ref: `${prefix}${++counters[prefix]}`,
        props: { ...part.defaultProps, net: p.name },
        ...(p.fields ? { fields: p.fields } : {}),
        footprint: "",
        sch: { ...at(p), rot: p.rot },
        pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
      })
    }
  }
  const wires: Wire[] = splitAtJunctions(newWires).map((points) => ({ id: ids.next("w"), points }))

  // What reaches no part keeps its drawing, in a row below the blocks.
  const stowed = new Map<string, Vec2>()
  if (!options.blockId && loose.length) {
    const area = emptyBox()
    for (const [id, off] of offsets) {
      const f = frames.get(id)!
      expandBox(area, { x: f.minX + off.x, y: f.minY + off.y })
      expandBox(area, { x: f.maxX + off.x, y: f.maxY + off.y })
    }
    if (keptArea) {
      expandBox(area, { x: keptArea.minX, y: keptArea.minY })
      expandBox(area, { x: keptArea.maxX, y: keptArea.maxY })
    }
    if (Number.isFinite(area.minX)) stowLoose(base, loose, area, stowed)
  }
  const stow = <T extends Vec2>(p: T, by: Vec2 | undefined): T => (by ? { ...p, x: round(p.x + by.x), y: round(p.y + by.y) } : p)

  let next: Project = {
    ...base,
    components: [
      // A part keeps its mirror: Tidy picks where it stands and which way it is turned, nothing else.
      ...base.components.map((c) => (moved.has(c.id) ? reseat(c, moved.get(c.id)!) : { ...c, sch: stow(c.sch, stowed.get(`c:${c.id}`)) })),
      ...newPorts,
    ],
    wires: [...base.wires.map((w) => ({ ...w, points: w.points.map((p) => stow(p, stowed.get(`w:${w.id}`))) })), ...wires],
    labels: [...base.labels.map((l) => stow(l, stowed.get(`l:${l.id}`))), ...newLabels],
    blocks: blocksWithout(blocks, removed.comps),
  }
  if (kept.length) {
    // A kept block stays as it was; the block Tidy makes for loose parts isn't made when it is kept.
    const was = new Map((project.blocks ?? []).map((b) => [b.id, b]))
    const keptIds = new Set(kept.map((k) => k.id))
    next = { ...next, blocks: (next.blocks ?? []).flatMap((b) => (!keptIds.has(b.id) ? [b] : was.has(b.id) ? [was.get(b.id)!] : [])) }
  }

  // S11: on a sheet joined by KiCad's rules a T that Tidy drew joins nothing until the wire is cut there, so the wires are cut where they meet, as KiCad cuts them.
  next = settleKicadSheet(project, next)

  // A project named as KiCad names its nets: the labels Tidy drew take the kind, shape, size and style of the labels they stand for.
  if (styles) next = { ...next, labels: restyleLabels(next.labels, styles) }

  // ---------- Names, and the check ----------
  // A named net keeps its name. An unnamed net that got a label goes by the label's name.
  const connName = new Map(info.conn.nets.map((n) => [n.id, n.name]))
  const candidates: Record<string, string> = {}
  for (const [net, name] of assigned) candidates[connName.get(net)!] = name
  // A net's other name no block found room for: a label where there is room, off a pin of the net
  // that moved or off the net's wires. A name with no room anywhere is the one thing left out, and
  // the message says so (`dropped`).
  let connAfter = computeConnectivity(next)
  let nameRoom: Room | null = null
  // Never on a kept block's wires, nor on wire that reaches no part: a name hung there would be
  // stowed with it next time, and the second tidy would move it.
  const nameKeep = new Set([...keptDrawing.wires, ...loose.flatMap((i) => i.wires)])
  for (const [net, names] of aliases) {
    const pins = info.nets
      .get(net)!
      .pins.map((k) => ({ componentId: k.slice(0, k.lastIndexOf(":")), pin: k.slice(k.lastIndexOf(":") + 1) }))
      .filter((p) => moved.has(p.componentId))
      .sort((a, b) => naturalCompare(pinKey(a.componentId, a.pin), pinKey(b.componentId, b.pin)))
    const id = pins.map((p) => connAfter.pinNet.get(pinKey(p.componentId, p.pin))).find((x) => !!x)
    if (!id) continue
    const named = connAfter.nets.find((n) => n.id === id)
    const now = new Set(connAfter.conflicts.find((c) => c.netId === id)?.names ?? [named ? bareName(named) : ""])
    const missing = names.filter((n) => !now.has(n))
    if (!missing.length) continue
    nameRoom ??= new Room(next)
    for (const name of missing) {
      const t = nameSpot(next, nameRoom, pins, id, connAfter, name, terminalIds(ids, counters), nameKeep)
      if (t) next = withTerminal(next, t, ids)
    }
    connAfter = computeConnectivity(next)
  }
  // A junction dot of its own size or colour that no wires meet at any more is gone with them; a second tidy finds none.
  let droppedDots = 0
  if (next.drawings?.some((d) => d.type === "junction")) {
    const dots = new Set(connAfter.junctions.map((j) => `${j.x.toFixed(3)},${j.y.toFixed(3)}`))
    const kept = next.drawings.filter((d) => d.type !== "junction" || dots.has(`${d.x.toFixed(3)},${d.y.toFixed(3)}`))
    droppedDots = next.drawings.length - kept.length
    if (droppedDots) next = { ...next, drawings: kept.length ? kept : undefined }
  }
  const before = physicalNetlist(project, info.conn)
  const after = physicalNetlist(next, connAfter)
  const renamed: Record<string, string> = {}
  // A net that loses its made-up name (`NET3`) with its labels: what the board kept under that name follows it too.
  const madeUp = new Set([...info.nets.values()].filter((n) => n.madeUp).map((n) => n.name))
  const unnamed: Record<string, string> = {}
  for (const [k, x] of before) {
    const y = after.get(k)
    if (!y || y.net === x.net) continue
    if (candidates[x.net] === y.net) renamed[x.net] = y.net
    else if (madeUp.has(x.net) && !y.named) unnamed[x.net] = y.net
  }
  if (Object.keys(renamed).length || Object.keys(unnamed).length) next = renameNets(next, { ...renamed, ...unnamed })
  const problems = compareNetlists(before, after, renamed, next)
  if (problems.length) return fail(project, "Tidy would have changed a connection, so nothing was changed.", withOffGridNote(project, problems))
  if (kept.length) {
    const wrong = keptProblems(project, next, kept, keptDrawing)
    if (wrong.length) return fail(project, `Tidy couldn't tidy around ${kept.map((k) => k.name).join(" and ")}, which it had to keep as drawn; nothing was changed.`, wrong)
  }
  const keptOut = kept.map((k) => ({ block: k.name, why: k.why.replace(/^Tidy: /, "") }))
  const keptSaid = keptNotes(keptOut)

  if (sameDrawing(project, next)) return { project, changed: false, ok: true, message: ["Already tidy.", ...keptSaid].join(" "), renamed: {}, dropped: [], loose: NONE, problems: [], kept: keptOut }
  const dropped = droppedNames(info, connAfter)
  // One block: wire to nowhere that hung off its drawing stays where it was drawn, and is counted.
  const stayed = options.blockId
    ? newlyLoose(project, next)
    : {
        wires: loose.reduce((a, i) => a + i.wires.length, 0),
        labels: loose.reduce((a, i) => a + i.labels.length, 0),
        ports: loose.reduce((a, i) => a + i.comps.length, 0),
      }
  const count = [...drawings.keys()].reduce((a, id) => a + members.get(id)!.length, 0)
  const notes = [
    options.blockId ? `Tidied ${scope[0].name}.` : `Tidied ${count} part${count === 1 ? "" : "s"} into ${drawings.size} block${drawings.size === 1 ? "" : "s"}.`,
    ...keptSaid,
    ...tidyNotes(renamed, dropped, stayed, !options.blockId),
    ...(droppedDots ? [`${droppedDots} junction dot${droppedDots === 1 ? "" : "s"} of ${droppedDots === 1 ? "its" : "their"} own size or colour ${droppedDots === 1 ? "was" : "were"} left out where no wires meet any more.`] : []),
  ]
  return { project: { ...next, updatedAt: Date.now() }, changed: true, ok: true, message: notes.join(" "), renamed, dropped, loose: stayed, problems: [], kept: keptOut }
}

/**
 * What a tidy that kept blocks did to them, which should be nothing: their parts, their block and
 * the drawing that is theirs alone exactly as they were, and no tidied block's frame on any of it.
 */
function keptProblems(before: Project, after: Project, kept: { id: string; name: string }[], drawing: { wires: Set<string>; labels: Set<string>; comps: Set<string> }): string[] {
  const out: string[] = []
  const same = <T extends { id: string }>(a: T[], b: T[], ids: Set<string>, what: string) => {
    const now = new Map(b.filter((x) => ids.has(x.id)).map((x) => [x.id, JSON.stringify(x)]))
    for (const x of a) if (ids.has(x.id) && now.get(x.id) !== JSON.stringify(x)) out.push(`${what} ${x.id} of a kept block changed`)
  }
  const keptIds = new Set(kept.map((k) => k.id))
  const parts = new Set([...(before.blocks ?? []).filter((b) => keptIds.has(b.id)).flatMap((b) => b.components), ...drawing.comps])
  same(before.components, after.components, parts, "part")
  same(before.wires, after.wires, drawing.wires, "wire")
  same(before.labels, after.labels, drawing.labels, "label")
  for (const b of before.blocks ?? []) {
    if (!keptIds.has(b.id)) continue
    const now = after.blocks?.find((x) => x.id === b.id)
    if (JSON.stringify(now) !== JSON.stringify(b)) out.push(`block ${b.name} changed`)
  }
  // Loose parts of a block Tidy would have made stay where they were too.
  const keptBoxes: Box[] = []
  for (const c of after.components) if (parts.has(c.id)) keptBoxes.push(schematicBounds(c))
  const frames = blockFrames(after)
  for (const f of frames) if (keptIds.has(f.id)) keptBoxes.push(f.box)
  for (const f of frames) {
    if (keptIds.has(f.id)) continue
    if (keptBoxes.some((o) => o.minX < f.box.maxX && o.maxX > f.box.minX && o.minY < f.box.maxY && o.maxY > f.box.minY)) out.push(`${f.name} would be drawn over a kept block`)
  }
  return out
}

interface Outside {
  componentId: string
  pin: string
  net: string
}

/** Wires, labels and ports drawn together, by id. */
interface Island {
  wires: string[]
  labels: string[]
  comps: string[]
}

/** Wires, labels and ports that reach no part in `after` and didn't in `before`: what a one-block tidy left unhooked. */
function newlyLoose(before: Project, after: Project): TidyResult["loose"] {
  const count = (p: Project) => {
    const isl = drawnIslands(p)
    const byId = new Map(p.components.map((c) => [c.id, c]))
    const out = { wires: 0, labels: 0, ports: 0 }
    for (const root of new Set([...isl.components.keys(), ...isl.wires.keys(), ...isl.labels.keys()])) {
      const comps = [...(isl.components.get(root) ?? [])]
      if (comps.some((id) => isArranged(byId.get(id)!.partId))) continue
      out.wires += (isl.wires.get(root) ?? []).length
      out.labels += (isl.labels.get(root) ?? []).length
      out.ports += comps.length
    }
    return out
  }
  const a = count(before)
  const b = count(after)
  return { wires: Math.max(0, b.wires - a.wires), labels: Math.max(0, b.labels - a.labels), ports: Math.max(0, b.ports - a.ports) }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** What else the user should hear about a tidy: names given or dropped, and what reaches no part. */
export function tidyNotes(renamed: Record<string, string>, dropped: TidyResult["dropped"], loose: TidyResult["loose"], stowed = true): string[] {
  const notes: string[] = []
  const named = Object.keys(renamed).length
  if (named) notes.push(`Named ${plural(named, "unnamed net")} for ${named === 1 ? "its label" : "their labels"}.`)
  for (const d of dropped) notes.push(`${d.net} was also called ${d.names.join(" and ")}; it keeps the name ${d.net}.`)
  const kinds = [plural(loose.labels, "label"), plural(loose.ports, "port"), plural(loose.wires, "wire")].filter((x) => !x.startsWith("0 "))
  if (kinds.length) {
    const list = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}`
    const one = loose.labels + loose.ports + loose.wires === 1
    notes.push(`Kept ${list} that ${one ? "reaches" : "reach"} no part, ${stowed ? "below the blocks" : one ? "where it was drawn" : "where they were drawn"}.`)
  }
  return notes
}

/** What the user hears about blocks a whole-sheet tidy kept as they were drawn: one sentence each. */
export function keptNotes(kept: TidyResult["kept"] = []): string[] {
  return kept.map((k) => `Kept ${k.block} as it was drawn: ${k.why}.`)
}

/** Names a net had before that are no longer drawn: a second label or port name Tidy left out. */
function droppedNames(info: NetInfo, after: ReturnType<typeof computeConnectivity>): TidyResult["dropped"] {
  const out: TidyResult["dropped"] = []
  const afterNets = new Map(after.nets.map((n) => [n.id, n]))
  const afterNames = new Map(after.conflicts.map((c) => [c.netId, c.names]))
  const beforeNets = new Map(info.conn.nets.map((n) => [n.id, n]))
  for (const c of info.conn.conflicts) {
    const pin = beforeNets.get(c.netId)?.pins[0]
    const id = pin && after.pinNet.get(pinKey(pin.componentId, pin.pin))
    const net = id ? afterNets.get(id) : undefined
    if (!net) continue
    const now = afterNames.get(net.id) ?? (net.named ? [bareName(net)] : [])
    const gone = c.names.filter((n) => !now.includes(n))
    if (gone.length) out.push({ net: net.name, names: gone })
  }
  return out
}

// ---------- Frames and placing blocks ----------

/** The frame a block's drawing gets, in the drawing's own coordinates. */
function frameOf(project: Project, block: SchematicBlock, d: BlockDrawing, styles: Map<string, Partial<NetLabel>> | null = null): Box {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const components: ComponentInstance[] = []
  for (const [id, p] of d.parts) components.push(reseat(byId.get(id)!, p))
  d.ports.forEach((p, i) => {
    components.push({
      id: `port${i}`,
      partId: p.partId,
      ref: "#P",
      props: { net: p.name },
      ...(p.fields ? { fields: p.fields } : {}),
      footprint: "",
      sch: { x: p.x, y: p.y, rot: p.rot },
      pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
    })
  })
  const temp: Project = {
    ...project,
    components,
    wires: d.wires.map((w, i) => ({ id: `w${i}`, points: w.points })),
    labels: ((labels) => (styles ? restyleLabels(labels, styles) : labels))(d.labels.map((l, i) => ({ id: `l${i}`, name: l.name, x: l.x, y: l.y, rot: l.rot }))),
    blocks: [{ id: block.id, name: block.name, components: [...d.parts.keys()] }],
  }
  return blockFrames(temp)[0].box
}

/** The top-left corner of what is on the sheet now, so a tidied sheet stays where it was. */
function sheetCorner(project: Project): Vec2 {
  const b = emptyBox()
  for (const c of project.components) {
    const s = schematicBounds(c)
    expandBox(b, { x: s.minX, y: s.minY })
    expandBox(b, { x: s.maxX, y: s.maxY })
  }
  for (const f of blockFrames(project)) {
    expandBox(b, { x: f.box.minX, y: f.box.minY })
    expandBox(b, { x: f.box.maxX, y: f.box.maxY })
  }
  if (!Number.isFinite(b.minX)) return { x: 0, y: 0 }
  return { x: round(snap(b.minX, SCH_GRID)), y: round(snap(b.maxY, SCH_GRID)) }
}

/** Where a block tidied on its own goes: its old corner, or the nearest spot clear of the rest. */
function freeSpot(
  project: Project,
  removed: { wires: Set<string>; labels: Set<string>; comps: Set<string> },
  blockId: string,
  frame: Box,
  corner: Vec2,
  pieces: Vec2[][],
): Vec2 {
  const obstacles: Box[] = []
  const own = new Set(project.blocks?.find((b) => b.id === blockId)?.components ?? [])
  // The other frames as they are once this block's parts have gone from where they were: drawing
  // they shared with it is then theirs alone, and their frames take it in, so a second tidy finds
  // the room the first one did.
  const without: Project = { ...project, components: project.components.filter((c) => !own.has(c.id)) }
  for (const f of blockFrames(without)) if (f.id !== blockId) obstacles.push(f.box)
  for (const c of project.components) {
    if (own.has(c.id) || removed.comps.has(c.id)) continue
    obstacles.push(schematicBounds(c), ...componentTextBoxes(c))
  }
  for (const l of project.labels) if (!removed.labels.has(l.id)) obstacles.push(labelBox(l))
  // What a KiCad sheet drew stays where it is, and a block goes clear of it.
  for (const d of sheetFixed(project)) obstacles.push(drawingBounds(d))
  for (const points of [...project.wires.filter((w) => !removed.wires.has(w.id)).map((w) => w.points), ...pieces]) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]
      const b = points[i + 1]
      obstacles.push({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) })
    }
  }
  const w = frame.maxX - frame.minX
  const h = frame.maxY - frame.minY
  const fits = (x: number, y: number) => {
    const box = { minX: x - 0.3, minY: y - h - 0.3, maxX: x + w + 0.3, maxY: y + 0.3 }
    return !obstacles.some((o) => o.minX < box.maxX && o.maxX > box.minX && o.minY < box.maxY && o.maxY > box.minY)
  }
  for (let r = 0; r <= 200; r++) {
    // The ring at distance r, in a fixed order: right, down, left, up of the old corner.
    const spots: Vec2[] = []
    for (let i = -r; i <= r; i++) spots.push({ x: r, y: -i }, { x: i, y: -r }, { x: -r, y: i }, { x: -i, y: r })
    for (const s of spots) {
      const x = round(corner.x + s.x)
      const y = round(corner.y + s.y)
      if (fits(x, y)) return { x: round(x - frame.minX), y: round(y - frame.maxY) }
    }
  }
  return { x: round(corner.x - frame.minX), y: round(corner.y - frame.maxY) }
}

/** What stays where it is while a whole sheet is tidied around kept blocks: as boxes, and all of it. */
interface Fixed {
  boxes: Box[]
  box: Box
}

/**
 * Everything of `project` a whole-sheet tidy leaves where it is: the kept blocks' frames, their
 * parts and the drawing that is theirs, and what is left where shared drawing was cut. Not the
 * parts being tidied, nor what reaches no part (`loose`), which goes below the blocks.
 */
function fixedDrawing(project: Project, keptBlocks: Set<string>, moving: Set<string>, loose: Island[]): Fixed {
  const stowed = { wires: new Set(loose.flatMap((i) => i.wires)), labels: new Set(loose.flatMap((i) => i.labels)), comps: new Set(loose.flatMap((i) => i.comps)) }
  const boxes: Box[] = []
  const box = emptyBox()
  const add = (b: Box) => {
    boxes.push(b)
    expandBox(box, { x: b.minX, y: b.minY })
    expandBox(box, { x: b.maxX, y: b.maxY })
  }
  for (const c of project.components) {
    if (moving.has(c.id) || stowed.comps.has(c.id)) continue
    add(schematicBounds(c))
    componentTextBoxes(c).forEach(add)
  }
  for (const l of project.labels) if (!stowed.labels.has(l.id)) add(labelBox(l))
  for (const d of sheetFixed(project)) add(drawingBounds(d))
  for (const w of project.wires) {
    if (stowed.wires.has(w.id)) continue
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1]
      const b = w.points[i]
      add({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) })
    }
  }
  // The kept frames as they will be: without the parts being tidied, which still stand where they
  // were drawn and would leave out of a frame what the cut left touching them. A second tidy finds
  // them gone from there, so the frame, and where the rest goes, is the same both times.
  const staying = { ...project, components: project.components.filter((c) => !moving.has(c.id)) }
  for (const f of blockFrames(staying)) if (keptBlocks.has(f.id)) add(f.box)
  return { boxes, box }
}

const ceilGrid = (n: number) => round(Math.ceil(n / SCH_GRID - 1e-6) * SCH_GRID)
const floorGrid = (n: number) => round(Math.floor(n / SCH_GRID + 1e-6) * SCH_GRID)

/**
 * Where the tidied blocks go, packed as they are (`packed`, top-left corners from (0, 0)), when
 * some are kept: to the right of everything kept, tops level, or below it, lefts level, whichever
 * makes the smaller sheet. Only what is kept decides it, so a second tidy puts them where the first
 * did. Null when neither is clear of what is kept.
 */
function besideKept(fixed: Fixed, packed: Map<string, Vec2>, frames: Map<string, Box>): Vec2 | null {
  const group = emptyBox()
  for (const [id, at] of packed) {
    const f = frames.get(id)!
    expandBox(group, { x: at.x, y: at.y })
    expandBox(group, { x: at.x + f.maxX - f.minX, y: at.y - (f.maxY - f.minY) })
  }
  const F = fixed.box
  const spots: Vec2[] = [
    { x: ceilGrid(F.maxX + BLOCK_GAP), y: ceilGrid(F.maxY) },
    { x: floorGrid(F.minX), y: floorGrid(F.minY - BLOCK_GAP) },
  ]
  const clear = (s: Vec2) =>
    [...packed].every(([id, at]) => {
      const f = frames.get(id)!
      const b = { minX: s.x + at.x - BLOCK_GAP, maxX: s.x + at.x + f.maxX - f.minX + BLOCK_GAP, maxY: s.y + at.y + BLOCK_GAP, minY: s.y + at.y - (f.maxY - f.minY) - BLOCK_GAP }
      return !fixed.boxes.some((o) => o.minX < b.maxX && o.maxX > b.minX && o.minY < b.maxY && o.maxY > b.minY)
    })
  const size = (s: Vec2) => {
    const w = Math.max(F.maxX, s.x + group.maxX) - Math.min(F.minX, s.x + group.minX)
    const h = Math.max(F.maxY, s.y + group.maxY) - Math.min(F.minY, s.y + group.minY)
    return w * h
  }
  const ok = spots.filter(clear)
  if (!ok.length) return null
  return ok.reduce((a, b) => (size(b) < size(a) - 1e-9 ? b : a))
}

// ---------- Ids ----------

/** New ids that are the same on every run: wt_0, wt_1... skipping any still in use. */
class IdAllocator {
  private used = new Set<string>()
  private n = new Map<string, number>()
  constructor(project: Project, removed: { wires: Set<string>; labels: Set<string>; comps: Set<string> }) {
    for (const w of project.wires) if (!removed.wires.has(w.id)) this.used.add(w.id)
    for (const l of project.labels) if (!removed.labels.has(l.id)) this.used.add(l.id)
    for (const c of project.components) if (!removed.comps.has(c.id)) this.used.add(c.id)
  }
  next(prefix: string) {
    let i = this.n.get(prefix) ?? 0
    while (this.used.has(`${prefix}t_${i}`)) i++
    this.n.set(prefix, i + 1)
    const id = `${prefix}t_${i}`
    this.used.add(id)
    return id
  }
}

/** The highest number among the refs of a prefix that stay, so new ports count on from it. */
function refBase(project: Project, removed: { comps: Set<string> }, prefix: string): number {
  let max = 0
  const re = new RegExp(`^${prefix.replace(/[#$]/g, "\\$&")}(\\d+)$`)
  for (const c of project.components) {
    if (removed.comps.has(c.id)) continue
    const m = c.ref.match(re)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

// ---------- Wires ----------

/**
 * Wires split wherever another wire of the net ends on one of their corners, so every junction
 * is wire ends meeting and gets its dot.
 */
function splitAtJunctions(wires: { net: string; points: Vec2[] }[]): Vec2[][] {
  let list = wires.map((w) => ({ ...w, points: w.points.map((p) => ({ ...p })) }))
  for (let changed = true; changed; ) {
    changed = false
    const ends = list.flatMap((w) => [w.points[0], w.points[w.points.length - 1]].map((p) => ({ p, net: w.net })))
    const out: typeof list = []
    for (const w of list) {
      const cut = w.points.findIndex((p, i) => i > 0 && i < w.points.length - 1 && ends.some((e) => e.net === w.net && samePoint(e.p, p)))
      if (cut < 0) {
        out.push(w)
        continue
      }
      out.push({ net: w.net, points: w.points.slice(0, cut + 1) }, { net: w.net, points: w.points.slice(cut) })
      changed = true
    }
    list = out
  }
  return list.map((w) => w.points)
}

/** Ids and designators for what `Room.place` adds. */
function terminalIds(ids: IdAllocator, counters: Record<"#PWR" | "#GND", number>) {
  return {
    label: () => ids.next("l"),
    port: (partId: string) => {
      const prefix = portPrefix(partId)
      return { id: ids.next("c"), ref: `${prefix}${++counters[prefix]}` }
    },
  }
}

/** A label or port `Room.place` found, with its stub, added to the project. */
function withTerminal(project: Project, t: Terminal, ids: IdAllocator): Project {
  return {
    ...project,
    wires: t.path.length > 1 ? [...project.wires, { id: ids.next("w"), points: t.path }] : project.wires,
    labels: t.label ? [...project.labels, t.label] : project.labels,
    components: t.port ? [...project.components, t.port] : project.components,
  }
}

/** Room for a net's other name: on a stub off one of `pins`, else off a point of the net's wires. */
function nameSpot(
  project: Project,
  room: Room,
  pins: { componentId: string; pin: string }[],
  netId: string,
  conn: ReturnType<typeof computeConnectivity>,
  name: string,
  ids: ReturnType<typeof terminalIds>,
  /** Wires to leave alone: a kept block's, and what reaches no part. */
  keep: Set<string> = new Set(),
): Terminal | null {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  for (const p of pins) {
    const c = byId.get(p.componentId)
    const pin = c && schematicPins(c).find((q) => q.pin === p.pin)
    // A pin the symbol doesn't draw (a hidden power pin) is on its net by its name: nothing is hung on it.
    if (!pin || pin.hidden) continue
    const t = room.place(pin.pos, [pin.dir], [2, 3, 4, 6, 8], null, name, ids)
    if (t) return t
  }
  const points = new Map<string, Vec2>()
  for (const w of project.wires) if (!keep.has(w.id) && conn.wireNet.get(w.id) === netId) for (const q of w.points) points.set(`${round(q.x)},${round(q.y)}`, q)
  const sorted = [...points.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, q]) => q)
  for (const len of [1, 2, 3, 4]) {
    for (const q of sorted) {
      const t = room.place(q, ["right", "left", "up", "down"], [len], null, name, ids)
      if (t) return t
    }
  }
  return null
}

/**
 * A pin left behind by a tidied block, on a stub that touches nothing else: a power or ground port
 * when its net is a supply, as the block draws its own, else a label. Where it has room, as near as
 * it can be; out a fixed way when nothing has.
 */
function markOutside(
  project: Project,
  r: Outside,
  rail: RailKind | null,
  name: string,
  ids: IdAllocator,
  counters: Record<"#PWR" | "#GND", number>,
  room: Room,
): Project {
  const c = project.components.find((x) => x.id === r.componentId)
  const pin = c && schematicPins(c).find((p) => p.pin === r.pin)
  // A pin the symbol doesn't draw is on its net by its name: it needs no wire, port or label.
  if (!pin || pin.hidden) return project
  const found = room.place(pin.pos, [pin.dir], rail ? [2, 3, 1, 4, 5, 6, 8, 10] : [3, 2, 4, 1, 5, 6, 8, 10], rail, name, terminalIds(ids, counters))
  if (found) return withTerminal(project, found, ids)
  const taken = (p: Vec2) =>
    project.wires.some((w) => w.points.some((q, i) => i > 0 && pointOnSegment(p, w.points[i - 1], q))) ||
    project.labels.some((l) => samePoint(l, p)) ||
    project.components.some((o) => o.id !== c!.id && schematicPins(o).some((q) => samePoint(q.pos, p)))
  let stub = pinStubPoint(pin, SCH_GRID * 3)
  for (const len of rail ? [2, 3, 1, 4, 5, 6] : [3, 2, 4, 1, 5, 6]) {
    const s = pinStubPoint(pin, SCH_GRID * len)
    if (!taken(s)) {
      stub = s
      break
    }
  }
  const wire = { id: ids.next("w"), points: [pin.pos, stub] }
  if (rail) {
    const shape = portShape(rail, name, pin.dir)
    const prefix = portPrefix(shape.partId)
    const port: ComponentInstance = { ...portInstance(shape, name, stub), id: ids.next("c"), ref: `${prefix}${++counters[prefix]}` }
    return { ...project, wires: [...project.wires, wire], components: [...project.components, port] }
  }
  const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
  return {
    ...project,
    wires: [...project.wires, wire],
    labels: [...project.labels, { id: ids.next("l"), name, x: stub.x, y: stub.y, rot }],
  }
}

const onGrid = (n: number) => Math.abs(n / SCH_GRID - Math.round(n / SCH_GRID)) < 1e-6

type Tap = Cut["taps"][number]
/** A spot on the grid for what marks a cut off it, with the bit of wire that leads there, if any. */
type GridTap = Tap & { lead?: [Vec2, Vec2] }

/**
 * Cuts off the grid (on wire drawn off it), onto it, so what marks them can be on the grid too.
 * Along a straight run out of the cut that lies on a grid line, to the first grid point short of
 * the run's far end: a piece that ends at the cut is drawn back to there and the cut moves with it;
 * where wire goes on from the cut, that spot on the run is one to try. And out of the cut the way
 * its mark would point, to the first grid point, on a bit of wire of its own. The spots to try come
 * back by cut, to be tried before the cut itself. Only where nothing else is on that bit of wire or
 * at that point, so no connection changes.
 */
function snapCutTaps(project: Project, removed: { wires: Set<string>; comps: Set<string> }, pieces: Vec2[][], taps: Tap[]): Map<Tap, GridTap[]> {
  const out = new Map<Tap, GridTap[]>()
  const touches: Vec2[] = []
  for (const c of project.components) if (!removed.comps.has(c.id)) for (const p of schematicPins(c)) touches.push(p.pos)
  for (const l of project.labels) touches.push(l)
  const segments: [Vec2, Vec2][] = []
  for (const w of project.wires) if (!removed.wires.has(w.id)) for (let i = 1; i < w.points.length; i++) segments.push([w.points[i - 1], w.points[i]])
  for (const t of taps) {
    if (onGrid(t.at.x) && onGrid(t.at.y)) continue
    const all = [...segments, ...pieces.flatMap((p) => p.slice(1).map((b, i): [Vec2, Vec2] => [p[i], b]))]
    const tries: GridTap[] = []
    for (const run of all.filter(([a, b]) => samePoint(a, t.at) || samePoint(b, t.at))) {
      const far = samePoint(run[0], t.at) ? run[1] : run[0]
      const along = round(far.y) === round(t.at.y) ? "x" : round(far.x) === round(t.at.x) ? "y" : null
      if (!along || !onGrid(t.at[along === "x" ? "y" : "x"])) continue
      const step = far[along] > t.at[along] ? 1 : -1
      const v = round((step > 0 ? Math.ceil(t.at[along] / SCH_GRID - 1e-6) : Math.floor(t.at[along] / SCH_GRID + 1e-6)) * SCH_GRID)
      // Short of the run's far end, so the wire keeps its shape.
      if ((v - far[along]) * step >= -1e-9) continue
      const q = { ...t.at, [along]: v } as Vec2
      // Nothing at the new point but this run and wire drawn over it (on its line and overlapping
      // it, so joined to it already).
      const across = along === "x" ? "y" : "x"
      const lo1 = Math.min(t.at[along], far[along])
      const hi1 = Math.max(t.at[along], far[along])
      const overRun = ([a, b]: [Vec2, Vec2]) =>
        Math.abs(a[across] - t.at[across]) < 1e-6 && Math.abs(b[across] - t.at[across]) < 1e-6 && Math.max(a[along], b[along]) > lo1 + 1e-6 && Math.min(a[along], b[along]) < hi1 - 1e-6
      if (touches.some((p) => samePoint(p, q))) continue
      if (all.some((x) => x !== run && !overRun(x) && pointOnSegment(q, x[0], x[1]))) continue
      if (t.end) {
        // The bit of run given up has nothing else on it, or at the cut.
        const lo = { x: Math.min(t.at.x, q.x), y: Math.min(t.at.y, q.y) }
        const hi = { x: Math.max(t.at.x, q.x), y: Math.max(t.at.y, q.y) }
        const within = (p: Vec2) => p.x >= lo.x - 1e-6 && p.x <= hi.x + 1e-6 && p.y >= lo.y - 1e-6 && p.y <= hi.y + 1e-6
        if (touches.some(within)) continue
        if (all.some((x) => x !== run && (within(x[0]) || within(x[1]) || pointOnSegment(t.at, x[0], x[1])))) continue
        // The one run out of the cut: its piece is drawn back along it.
        const piece = pieces.find((p) => (samePoint(p[0], t.at) && samePoint(p[1], far)) || (samePoint(p[p.length - 1], t.at) && samePoint(p[p.length - 2], far)))
        if (!piece) continue
        if (samePoint(piece[0], t.at)) piece[0] = q
        else piece[piece.length - 1] = q
        t.at = q
      } else {
        // Wire goes on both ways from there, so what marks it points across the run.
        tries.push({ ...t, at: q, free: along === "x" ? ["up", "down"] : ["left", "right"] })
      }
      break
    }
    if (onGrid(t.at.x) && onGrid(t.at.y)) continue
    // Straight out of the cut the way its mark points, on a bit of wire of its own.
    const leads: GridTap[] = []
    for (const d of t.free) {
      const along = d === "left" || d === "right" ? "x" : "y"
      if (!onGrid(t.at[along === "x" ? "y" : "x"])) continue
      const up = d === "right" || d === "up"
      const v = round((up ? Math.ceil(t.at[along] / SCH_GRID - 1e-6) : Math.floor(t.at[along] / SCH_GRID + 1e-6)) * SCH_GRID)
      const q = { ...t.at, [along]: v } as Vec2
      const lo = { x: Math.min(t.at.x, q.x), y: Math.min(t.at.y, q.y) }
      const hi = { x: Math.max(t.at.x, q.x), y: Math.max(t.at.y, q.y) }
      const within = (p: Vec2) => !samePoint(p, t.at) && p.x >= lo.x - 1e-6 && p.x <= hi.x + 1e-6 && p.y >= lo.y - 1e-6 && p.y <= hi.y + 1e-6
      if (touches.some(within)) continue
      // No wire on the bit of wire or across it: wire from the cut itself only the other ways.
      const meets = ([a, b]: [Vec2, Vec2]) =>
        Math.max(a.x, b.x) >= lo.x - 1e-6 && Math.min(a.x, b.x) <= hi.x + 1e-6 && Math.max(a.y, b.y) >= lo.y - 1e-6 && Math.min(a.y, b.y) <= hi.y + 1e-6
      const fromCut = ([a, b]: [Vec2, Vec2]) => {
        const far = samePoint(a, t.at) ? b : samePoint(b, t.at) ? a : null
        return !!far && !within(far) && !pointOnSegment(q, a, b)
      }
      if (all.some((s) => meets(s) && !fromCut(s))) continue
      leads.push({ ...t, at: q, free: [d], lead: [t.at, q] })
    }
    out.set(t, [...leads, ...tries])
  }
  return out
}

/**
 * A label (a port, on a supply) on wire left where a cut was, pointing where no wire goes: right at
 * the cut where it has room, else on a short stub out of it; unless `always`, the project as it
 * was when neither has room.
 */
function tapAt(
  project: Project,
  t: Cut["taps"][number],
  rail: RailKind | null,
  name: string,
  ids: IdAllocator,
  counters: Record<"#PWR" | "#GND", number>,
  room: Room,
  always: boolean,
): Project {
  const prefer: Dir[] = rail ? [rail === "ground" ? "down" : "up", "right", "left", rail === "ground" ? "up" : "down"] : ["right", "left", "up", "down"]
  const found = room.place(t.at, prefer.filter((d) => t.free.includes(d)), [0, 1, 2, 3, 4, 6], rail, name, terminalIds(ids, counters))
  if (found) return withTerminal(project, found, ids)
  if (!always) return project
  const dir = prefer.find((d) => t.free.includes(d)) ?? prefer[0]
  if (rail) {
    const shape = portShape(rail, name, dir)
    const prefix = portPrefix(shape.partId)
    const port: ComponentInstance = { ...portInstance(shape, name, t.at), id: ids.next("c"), ref: `${prefix}${++counters[prefix]}` }
    return { ...project, components: [...project.components, port] }
  }
  const rot: Rotation = dir === "left" ? 180 : dir === "up" ? 90 : dir === "down" ? 270 : 0
  return { ...project, labels: [...project.labels, { id: ids.next("l"), name, x: t.at.x, y: t.at.y, rot }] }
}

/** Between the blocks and what is kept below them. */
const STOW_GAP = 1

/**
 * Where each island that reaches no part goes: left to right in rows below `area`, by what it shows
 * (its names, then its shape) rather than where it was, and moved by whole grid steps so it stays on
 * the grid. A second tidy finds each where the first put it.
 */
function stowLoose(project: Project, given: Island[], area: Box, out: Map<string, Vec2>) {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const wireById = new Map(project.wires.map((w) => [w.id, w]))
  const labelById = new Map(project.labels.map((l) => [l.id, l]))
  // In the pieces that hang together, as the next tidy finds them: wire cut from one drawing can
  // be two pieces apart, and each then goes where that tidy would put it.
  const wires = new Set(given.flatMap((i) => i.wires))
  const labels = new Set(given.flatMap((i) => i.labels))
  const comps = new Set(given.flatMap((i) => i.comps))
  const isl = drawnIslands({
    ...project,
    components: project.components.filter((c) => comps.has(c.id)),
    wires: project.wires.filter((w) => wires.has(w.id)),
    labels: project.labels.filter((l) => labels.has(l.id)),
  })
  const loose: Island[] = [...new Set([...isl.components.keys(), ...isl.wires.keys(), ...isl.labels.keys()])].map((root) => ({
    wires: isl.wires.get(root) ?? [],
    labels: isl.labels.get(root) ?? [],
    comps: [...(isl.components.get(root) ?? [])],
  }))
  const boxed = loose.map((island) => {
    const box = emptyBox()
    const add = (b: Box) => {
      expandBox(box, { x: b.minX, y: b.minY })
      expandBox(box, { x: b.maxX, y: b.maxY })
    }
    for (const id of island.wires) for (const p of wireById.get(id)!.points) expandBox(box, p)
    for (const id of island.labels) add(labelBox(labelById.get(id)!))
    for (const id of island.comps) {
      const c = byId.get(id)!
      add(schematicBounds(c))
      for (const t of componentTextBoxes(c)) add(t)
    }
    const at = (p: Vec2) => `${round(p.x - box.minX)},${round(p.y - box.minY)}`
    const key = JSON.stringify([
      island.labels.map((id) => labelById.get(id)!).map((l) => `${l.name} ${l.rot} ${at(l)}`).sort(),
      island.comps.map((id) => byId.get(id)!).map((c) => `${c.props.net ?? ""} ${c.partId} ${c.sch.rot} ${at(c.sch)}`).sort(),
      island.wires.map((id) => wireById.get(id)!.points.map(at).join(" ")).sort(),
    ])
    // Islands that show the same thing look the same in either order; ids, which a tidy keeps, settle it.
    return { island, box, key, ids: [...island.labels, ...island.comps, ...island.wires].sort().join(" ") }
  })
  boxed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.ids < b.ids ? -1 : a.ids > b.ids ? 1 : 0))
  const right = Math.max(area.maxX, area.minX + 8)
  const steps = (v: number, up: boolean) => round((up ? Math.ceil(v / SCH_GRID - 1e-6) : Math.floor(v / SCH_GRID + 1e-6)) * SCH_GRID)
  let x = area.minX
  let top = area.minY - STOW_GAP
  let row = 0
  for (const { island, box } of boxed) {
    const w = box.maxX - box.minX
    const h = box.maxY - box.minY
    // Fits within a hair: the same island fits the same way however far it was moved to get here.
    if (x > area.minX + 1e-6 && x + w > right + 1e-6) {
      top -= row + BLOCK_GAP
      x = area.minX
      row = 0
    }
    const by = { x: steps(x - box.minX, true), y: steps(top - box.maxY, false) }
    for (const id of island.wires) out.set(`w:${id}`, by)
    for (const id of island.labels) out.set(`l:${id}`, by)
    for (const id of island.comps) out.set(`c:${id}`, by)
    x = round(box.maxX + by.x + BLOCK_GAP)
    row = Math.max(row, h)
  }
}

// ---------- Names ----------

/** Pours, stitching vias, trace widths and the net of imported traces and vias that named a net by its old name follow it to the new one. */
export function renameNets(project: Project, renamed: Record<string, string>): Project {
  const zones = project.zones.map((z) => (renamed[z.net] ? { ...z, net: renamed[z.net] } : z))
  const vias = project.vias.map((v) => (v.net && renamed[v.net] ? { ...v, net: renamed[v.net] } : v))
  const widths = project.rules.netWidths
  const netWidths = widths ? Object.fromEntries(Object.entries(widths).map(([k, v]) => [renamed[k] ?? k, v])) : undefined
  // a net class lists its nets by name too, so it follows a net that was renamed
  const rules = renameClassNets(netWidths ? { ...project.rules, netWidths } : project.rules, renamed)
  return renameChainNets(renameStoredNets({ ...project, zones, vias, rules }, renamed), renamed)
}

// ---------- The check ----------

/**
 * Pins Tidy can't wire: the second pin of a number in a symbol that keeps such pins apart, standing
 * where the first does not, with a wire, label or pin on it. Each is on a net of its own and the
 * connectivity names no net for it, so Tidy could neither draw it to its net nor check it was. (One
 * left alone is no trouble: Tidy keeps it as it is.)
 */
function pinsKeptApart(project: Project): string[] {
  const out: string[] = []
  const all = project.components.flatMap((c) => schematicPins(c))
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part?.jumpers || part.jumpers.duplicates) continue
    const pins = schematicPins(c, part)
    for (const pin of pins) {
      if (!pin.slot || tidyPinId(part, pin, pins) === pin.pin) continue
      const touched =
        project.wires.some((w) => w.points.some((q, i) => samePoint(q, pin.pos) || (i > 0 && pointOnSegment(pin.pos, w.points[i - 1], q)))) ||
        project.labels.some((l) => samePoint(l, pin.pos)) ||
        all.some((o) => !(o.componentId === c.id && o.pin === pin.pin && o.slot === pin.slot) && samePoint(o.pos, pin.pos))
      if (touched) out.push(`${c.ref} pin ${pin.pin} (the second of that number) is wired`)
    }
  }
  return out
}

/**
 * Each physical pin's net, by name, for pins on a net that connects something or is named. A name
 * `connect` made up (`NET3`) counts as none: Tidy may let it go.
 */
export function physicalNetlist(project: Project, conn = computeConnectivity(project)): Map<string, { net: string; named: boolean }> {
  const byNet = new Map(conn.nets.map((n) => [n.id, n]))
  const madeUp = madeUpNets(conn)
  const out = new Map<string, { net: string; named: boolean }>()
  const owners = unitOwners(project.components)
  const byComponent = new Map(project.components.map((c) => [c.id, c]))
  for (const c of project.components) {
    // The units of a part with several are components of their own; their pins are the part's, so they are checked too.
    const owner = owners.get(c.id)
    if (!isSchematicPart(findPart(c.partId)) && !(owner && isSchematicPart(findPart(byComponent.get(owner)?.partId ?? "")))) continue
    for (const pin of schematicPins(c)) {
      const id = conn.pinNet.get(pinKey(c.id, pin.pin))
      const net = id ? byNet.get(id) : undefined
      const named = !!net?.named && !madeUp.has(net.id)
      if (!net || (!named && net.pins.length < 2)) continue
      out.set(pinKey(c.id, pin.pin), { net: net.name, named })
    }
  }
  return out
}

/**
 * How two projects' netlists differ, pin for pin: the same pins together on every net, and every
 * named net under its name. An unnamed net may have been given one of `renamed`'s names.
 */
export function netlistChanges(before: Project, after: Project, renamed: Record<string, string> = {}): string[] {
  return compareNetlists(physicalNetlist(before), physicalNetlist(after), renamed, after)
}

/**
 * The parts among those a refusal names whose pins are not on the editor's 0.1 grid: KiCad lets a symbol
 * sit anywhere, and the editor draws its wires on a grid, so moving such a part would cut its pins off
 * their nets. Null when none is.
 */
export function offGridNote(project: Project, problems: string[]): string | null {
  const off: string[] = []
  for (const c of project.components) {
    if (!problems.some((p) => p.startsWith(`${c.ref}.`)) || off.includes(c.ref)) continue
    const part = findPart(c.partId)
    if (schematicPins(c, part).some((p) => Math.abs(p.pos.x * 10 - Math.round(p.pos.x * 10)) > 1e-6 || Math.abs(p.pos.y * 10 - Math.round(p.pos.y * 10)) > 1e-6)) off.push(c.ref)
  }
  if (!off.length) return null
  return `The pins of ${off.slice(0, 3).join(", ")}${off.length > 3 ? " and others" : ""} are not on the editor's 0.1 grid (KiCad drew the part off its own grid), and the wires Tidy draws are, so it would cut them off their nets.`
}

/** The refusal's problems with the grid's note first when it is the cause: the toolbar shows the first. */
export function withOffGridNote(project: Project, problems: string[]): string[] {
  const note = offGridNote(project, problems)
  return note ? [note, ...problems] : problems
}

function compareNetlists(
  a: Map<string, { net: string; named: boolean }>,
  b: Map<string, { net: string; named: boolean }>,
  renamed: Record<string, string>,
  after: Project,
): string[] {
  const refOf = new Map(after.components.map((c) => [c.id, c.ref]))
  const pinName = (k: string) => `${refOf.get(k.slice(0, k.lastIndexOf(":"))) ?? "?"}.${k.slice(k.lastIndexOf(":") + 1)}`
  const problems: string[] = []
  const forward = new Map<string, string>()
  const backward = new Map<string, string>()
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k)
    const y = b.get(k)
    if (!x || !y) {
      problems.push(`${pinName(k)} was ${x ? `on ${x.net}` : "unconnected"} and is ${y ? `on ${y.net}` : "unconnected"}`)
      continue
    }
    const want = renamed[x.net] ?? (x.named ? x.net : undefined)
    if (want ? y.net !== want : !(y.net === x.net || !y.named)) problems.push(`${pinName(k)} moved from ${x.net} to ${y.net}`)
    if ((forward.get(x.net) ?? y.net) !== y.net || (backward.get(y.net) ?? x.net) !== x.net) problems.push(`${pinName(k)}: nets ${x.net} and ${y.net} were split or merged`)
    forward.set(x.net, y.net)
    backward.set(y.net, x.net)
  }
  return problems
}

/**
 * Whether two projects draw the same schematic: the same parts in the same places, and the same
 * wires, labels and ports, whatever their ids and order. Tidy draws wires, labels and ports anew,
 * so a sheet already tidy comes back drawn the same with new ids, and is left as it was.
 */
function sameDrawing(a: Project, b: Project): boolean {
  const pick = (p: Project) => {
    const parts: string[] = []
    const ports: string[] = []
    for (const c of p.components) {
      if (findPart(c.partId)?.powerNet) ports.push(JSON.stringify([c.partId, c.props.net ?? "", c.sch]))
      else parts.push(JSON.stringify([c.id, c.ref, c.partId, c.sch, c.props]))
    }
    const wires = p.wires.map((w) => {
      const pts = w.points.map((q) => `${round(q.x)},${round(q.y)}`)
      const back = [...pts].reverse()
      return (pts.join(" ") < back.join(" ") ? pts : back).join(" ")
    })
    const labels = p.labels.map((l) => JSON.stringify([l.name, round(l.x), round(l.y), l.rot]))
    return JSON.stringify({
      parts: parts.sort(),
      ports: ports.sort(),
      wires: wires.sort(),
      labels: labels.sort(),
      blocks: (p.blocks ?? []).map((x) => [x.id, x.name, [...x.components].sort()]),
      zones: p.zones,
      widths: p.rules.netWidths ?? null,
      ...(p.rules.netClasses ? { classes: p.rules.netClasses } : {}),
    })
  }
  return pick(a) === pick(b)
}

export type { NetInfo }

/**
 * The drawings a KiCad sheet gave (`isExact`) that are not inside a block's frame: they stay where they are in a
 * tidy. The drawings of the drawing tools, and any drawing inside a frame, go with their block (`carryDrawings`).
 */
function sheetFixed(project: Project): SchematicDrawing[] {
  if (!project.drawings?.length) return []
  const carried = new Set(blockFrames(project).flatMap((f) => f.contents.drawings))
  return project.drawings.filter((d) => isExact(d) && !carried.has(d.id))
}

/** Where the tidied blocks must move, in y, to be clear of the sheet's drawings: below the lowest one they would cover, repeatedly; 0 when none is in the way. */
function clearOfItems(items: SchematicDrawing[], drawn: { f: Box; o: Vec2 }[]): number {
  const area = emptyBox()
  for (const { f, o } of drawn) {
    expandBox(area, { x: f.minX + o.x, y: f.minY + o.y })
    expandBox(area, { x: f.maxX + o.x, y: f.maxY + o.y })
  }
  if (!Number.isFinite(area.minX)) return 0
  const boxes = items.filter((it) => it.type !== "junction" && it.type !== "noconnect").map(drawingBounds)
  let dy = 0
  for (let i = 0; i < 50; i++) {
    const a = { minX: area.minX, maxX: area.maxX, minY: area.minY + dy, maxY: area.maxY + dy }
    const hit = boxes.filter((b) => b.minX < a.maxX && b.maxX > a.minX && b.minY < a.maxY && b.maxY > a.minY)
    if (!hit.length) break
    const lowest = Math.min(...hit.map((b) => b.minY))
    // On the grid, and no further down than the room needs.
    dy = round(Math.floor((lowest - BLOCK_GAP - area.maxY) / SCH_GRID + 1e-9) * SCH_GRID)
  }
  return dy
}

/** The kind, shape, size and style each label text has on the sheet: the first label with that text, and for a net nothing names the global label of its KiCad name. */
function labelStyles(project: Project, info: NetInfo): Map<string, Partial<NetLabel>> {
  const out = new Map<string, Partial<NetLabel>>()
  const unnamed = new Set<string>()
  for (const n of info.nets.values()) {
    if (n.named) continue
    out.set(n.name, { kind: "global", shape: "bidirectional" })
    unnamed.add(n.name)
  }
  for (const l of project.labels) {
    const text = l.name.trim()
    // Tidy draws one label for each text, so it is the one of the highest priority: a global label over a local one of the same text.
    const had = out.get(text)
    if (!l.kind || (had && !(RANK[had.kind ?? "local"] < RANK[l.kind] && !unnamed.has(text)))) continue
    // The justification a label has beyond the default belongs to the way it pointed, which is not the way the new one does.
    const look = l.look ? (({ h: _h, v: _v, ...rest }) => (Object.keys(rest).length ? rest : undefined))(l.look) : undefined
    out.set(text, { kind: l.kind, ...(l.shape ? { shape: l.shape } : {}), ...(look ? { look } : {}), ...(l.fields ? { fields: l.fields } : {}), ...(l.fieldsAutoplaced ? { fieldsAutoplaced: true as const } : {}) })
  }
  return out
}

/** Which label a text takes its style from where it has several: a global one, then a hierarchical one (the sheet's way out), then a local one. */
const RANK = { local: 0, hierarchical: 1, global: 2 } as const

/**
 * The labels Tidy drew, with the style of their text; a text that is on the sheet nowhere else is a local label. Of the labels drawn for a
 * text whose style is a hierarchical label the first is one and the rest are local labels of the same text, which join it by name: the sheet has
 * its one way out and every pin that needs the name has a label, as a second Tidy draws them (a sheet pin joins every hierarchical label of its name).
 */
function restyleLabels(labels: NetLabel[], styles: Map<string, Partial<NetLabel>>): NetLabel[] {
  const first = new Set<string>()
  return labels.map((l) => {
    if (l.kind) return l
    const text = l.name.trim()
    const style = styles.get(text) ?? { kind: "local" as const }
    if (style.kind !== "hierarchical") return { ...l, ...style }
    if (!first.has(text)) {
      first.add(text)
      return { ...l, ...style }
    }
    const { kind: _kind, shape: _shape, fields: _fields, fieldsAutoplaced: _auto, ...rest } = style
    void _kind
    void _shape
    void _fields
    void _auto
    return { ...l, ...rest, kind: "local" as const }
  })
}
