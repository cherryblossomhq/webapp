import { followSheetNames } from "./placementAreas"
import { boxesOverlap, emptyBox, expandBox, round, type Box } from "../lib/geometry"
import { drawingBounds } from "./drawings"
import { schematicBounds } from "./instances"
import { computeConnectivity, type SchematicConnectivity } from "./connectivity"
import { kicadRulesShown, settleKicadSheet } from "./kicadJoin"
import { labelBox } from "./labels"
import { moveProblems } from "./merges"
import { addLabel, removeItems, stretchEnd } from "./ops"
import { MAIN_SHEET_NAME, ROOT_SHEET, hasUse, sheetIdOf, sheetsOf, sheetUses, sheetView, symbolsOnSheet, syncCopies, useAt, usesOfSheet, type SheetUse } from "./sheets"
import type { LabelShape, NetLabel, Project, Rotation, SchematicSheet, SheetPin, SheetSymbol, Vec2, Wire } from "./types"

// S1: editing the sheets of a schematic: adding a sheet (a sheet symbol on a sheet, with the sheet it stands for), using a sheet again,
// moving, resizing and deleting sheet symbols, and their pins. Every function takes and returns a whole project and works by ids, so it
// may be run on a view of one sheet (`commitOnUse`) or on the project.

const GRID = 0.1
const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })
const snap = (v: number) => round(Math.round(v / GRID) * GRID, 4)

/** The next number for a prefix among the ids a project has: `s3` when `s1` and `s2` are there. */
function nextId(ids: Iterable<string>, prefix: string): string {
  let max = 0
  for (const id of ids) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}

const sheetIds = (p: Project) => [...(p.sheets ?? []).map((s) => s.id)]
const symbolIds = (p: Project) => (p.sheetSymbols ?? []).map((s) => s.id)

/** A name for a new sheet that no sheet symbol has: `Sheet`, `Sheet2`... */
function freshName(p: Project, base: string): string {
  const taken = new Set((p.sheetSymbols ?? []).map((s) => s.name.toLowerCase()))
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}${i}`
  return name
}

export interface BoxLike {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A sheet and the sheet symbol that stands for it, drawn on the use of a sheet at `parent`, in a box of the sheet. */
export function addSheet(project: Project, parent: string, box: BoxLike, name?: string): { project: Project; symbol: SheetSymbol } {
  const parentSheet = useAt(project, parent).sheet
  const sheets = project.sheets?.length ? project.sheets : [{ id: ROOT_SHEET }]
  const id = nextId(sheetIds({ ...project, sheets }), "s")
  const symbolId = nextId(symbolIds(project), "h")
  const title = name?.trim() || freshName(project, "Sheet")
  const sheet: SchematicSheet = { id }
  const symbol: SheetSymbol = {
    id: symbolId,
    sheet: parentSheet,
    child: id,
    x: snap(box.minX),
    y: snap(box.minY),
    w: Math.max(snap(box.maxX - box.minX), GRID * 4),
    h: Math.max(snap(box.maxY - box.minY), GRID * 2),
    name: title,
    pins: [],
  }
  return { project: touch({ ...project, sheets: [...sheets, sheet], sheetSymbols: [...(project.sheetSymbols ?? []), symbol] }), symbol }
}

/** The first free place on the sheet of a use: right of everything on it, level with the lowest thing. */
export function freeSheetSpot(project: Project, parent: string): Vec2 {
  const use = useAt(project, parent)
  const view = sheetView(project, use.path)
  const xs: number[] = []
  const ys: number[] = []
  for (const c of view.components) {
    const b = schematicBounds(c)
    xs.push(b.maxX)
    ys.push(b.minY)
  }
  for (const s of project.sheetSymbols ?? []) {
    if (s.sheet !== use.sheet) continue
    xs.push(s.x + s.w)
    ys.push(s.y)
  }
  for (const w of view.wires) {
    for (const q of w.points) {
      xs.push(q.x)
      ys.push(q.y)
    }
  }
  for (const l of view.labels) {
    xs.push(l.x)
    ys.push(l.y)
  }
  return xs.length ? { x: snap(Math.max(...xs) + 2), y: snap(Math.min(...ys)) } : { x: 0, y: 0 }
}

/** A new empty sheet, its symbol drawn in free space on the use of a sheet at `parent` at the size KiCad gives a new one. */
export function addSheetInFreeSpace(project: Project, parent: string, name?: string): { project: Project; symbol: SheetSymbol; path: string } {
  const at = freeSheetSpot(project, parent)
  const made = addSheet(project, parent, { minX: at.x, minY: at.y, maxX: at.x + NEW_SHEET_W, maxY: at.y + NEW_SHEET_H }, name)
  return { ...made, path: `${useAt(project, parent).path}/${made.symbol.id}` }
}

/** The size of a sheet symbol the editor draws for a new sheet: 2 by 1.2 (1000 by 600 mil). */
export const NEW_SHEET_W = 2
export const NEW_SHEET_H = 1.2

/** Another use of a sheet that is already there: a second symbol for it, the parts of the sheet copied to the new use with references of their own. */
export function addSheetUse(project: Project, parent: string, child: string, box: BoxLike, name?: string): { project: Project; symbol: SheetSymbol } | null {
  const sheet = (project.sheets ?? []).find((s) => s.id === child)
  const parentSheet = useAt(project, parent).sheet
  if (!sheet || child === ROOT_SHEET) return null
  // A sheet cannot be used inside itself, directly or below.
  const below = (s: string, seen = new Set<string>()): boolean => s === parentSheet || (!seen.has(s) && (seen.add(s), (project.sheetSymbols ?? []).some((x) => x.sheet === s && below(x.child, seen))))
  if (below(child)) return null
  const first = (project.sheetSymbols ?? []).find((s) => s.child === child)
  const symbol: SheetSymbol = {
    id: nextId(symbolIds(project), "h"),
    sheet: parentSheet,
    child,
    x: snap(box.minX),
    y: snap(box.minY),
    w: first?.w ?? Math.max(snap(box.maxX - box.minX), GRID * 4),
    h: first?.h ?? Math.max(snap(box.maxY - box.minY), GRID * 2),
    name: name?.trim() || freshName(project, first?.name ?? "Sheet"),
    // The pins are those of the sheet, as on its first symbol, along the same edges.
    pins: (first?.pins ?? []).map((p) => ({ ...p, id: p.id, x: p.x - first!.x + snap(box.minX), y: p.y - first!.y + snap(box.minY) })),
  }
  const before = new Set(sheetUses(project).map((u) => u.path))
  let next = touch({ ...project, sheetSymbols: [...(project.sheetSymbols ?? []), symbol] })
  // Every sheet that has a new use gets its parts there, copied from a use it already had.
  const fresh = sheetUses(next).filter((u) => !before.has(u.path))
  for (const sheetId of new Set(fresh.map((u) => u.sheet))) {
    const source = usesOfSheet(next, sheetId).find((u) => before.has(u.path))
    if (source) next = syncCopies(next, source.path)
  }
  return { project: next, symbol }
}

/**
 * What a sheet symbol keeps by the path of a use (the variants of its flags on each use of its parent sheet) goes when that use does: a symbol added later
 * takes the id of one removed, so its uses would otherwise start with the removed one's variants.
 */
function forgetGoneUses(symbols: SheetSymbol[], live: Set<string>): SheetSymbol[] {
  return symbols.map((s) => {
    if (!s.variants || Object.keys(s.variants).every((k) => live.has(k))) return s
    const kept = Object.fromEntries(Object.entries(s.variants).filter(([use]) => live.has(use)))
    const { variants: _gone, ...rest } = s
    return Object.keys(kept).length ? { ...s, variants: kept } : rest
  })
}

/** Everything that was drawn on sheets and uses that are no longer in the tree goes with the sheet symbol that made them. */
export function dropUnusedSheets(project: Project): Project {
  const uses = sheetUses(project)
  const paths = new Set(uses.map((u) => u.path))
  const live = new Set(uses.map((u) => u.sheet))
  const sheetOf = (item: { sheet?: string }) => item.sheet ?? ROOT_SHEET
  const gone = (project.components ?? []).filter((c) => c.inst !== undefined && !paths.has(c.inst))
  let next: Project = {
    ...project,
    wires: project.wires.filter((w) => live.has(sheetOf(w))),
    labels: project.labels.filter((l) => live.has(sheetOf(l))),
    ...(project.drawings ? { drawings: project.drawings.filter((d) => live.has(sheetOf(d))) } : {}),
  }
  if (project.drawings && !next.drawings?.length) delete next.drawings
  // S3: a bus alias belongs to its sheet's file and goes with it.
  if (project.busAliases) {
    const aliases = project.busAliases.filter((a) => live.has(sheetOf(a)))
    if (aliases.length) next = { ...next, busAliases: aliases }
    else delete next.busAliases
  }
  const symbols = forgetGoneUses((project.sheetSymbols ?? []).filter((s) => live.has(s.sheet) && live.has(s.child)), paths)
  const sheets = (project.sheets ?? []).filter((x) => x.id === ROOT_SHEET || live.has(x.id))
  // A project with no sheet left but a plain root is a project of one sheet.
  const plainRoot = sheets.length === 1 && Object.keys(sheets[0]).length === 1
  next = { ...next, sheetSymbols: symbols.length ? symbols : undefined, sheets: sheets.length && !plainRoot ? sheets : undefined }
  // Their parts, and the blocks of those parts.
  return gone.length ? removeItems(next, { components: gone.map((c) => c.id) }) : next
}

/** Delete sheet symbols. A sheet no symbol stands for any more goes with everything drawn on it, and so do the parts of the uses that go. */
export function removeSheetSymbols(project: Project, ids: string[]): Project {
  const drop = new Set(ids)
  if (!project.sheetSymbols?.some((s) => drop.has(s.id))) return project
  const left = project.sheetSymbols.filter((s) => !drop.has(s.id))
  return touch(dropUnusedSheets({ ...project, sheetSymbols: left.length ? left : undefined }))
}

/** A sheet pin that is going from one place to another: the wires and labels at it follow. */
interface PinMove {
  sheet: string
  from: Vec2
  to: Vec2
}

const samePlace = (p: Vec2, q: Vec2) => Math.abs(q.x - p.x) < 1e-4 && Math.abs(q.y - p.y) < 1e-4

/**
 * The wires and labels of the sheets after sheet pins have moved: a wire that ends on a pin is stretched to its new place (`stretchEnd`, the stretch a part's pin makes
 * of the wires on it, so a wire stays upright and a sheet joined by KiCad's rules keeps its points, S11: six digits and the exact stretch), and a label that sits on a pin goes with it. A wire
 * with both ends on pins that move the same way is moved whole.
 */
function followPins(project: Project, moves: PinMove[], digits: number): { wires: Wire[]; labels: NetLabel[] } {
  const exact = digits > 4
  const bySheet = new Map<string, PinMove[]>()
  for (const m of moves) (bySheet.get(m.sheet) ?? bySheet.set(m.sheet, []).get(m.sheet)!).push(m)
  const at = (sheet: string, p: Vec2) => bySheet.get(sheet)?.find((m) => samePlace(m.from, p))
  const wires = project.wires.map((w) => {
    const list = bySheet.get(w.sheet ?? ROOT_SHEET)
    if (!list || w.points.length < 2) return w
    const first = at(w.sheet ?? ROOT_SHEET, w.points[0])
    const last = at(w.sheet ?? ROOT_SHEET, w.points[w.points.length - 1])
    if (!first && !last) return w
    const to = (m: PinMove) => ({ x: round(m.to.x, digits), y: round(m.to.y, digits) })
    // A wire that is moved with the symbol on both ends is not stretched.
    if (first && last && Math.abs(first.to.x - first.from.x - (last.to.x - last.from.x)) < 1e-9 && Math.abs(first.to.y - first.from.y - (last.to.y - last.from.y)) < 1e-9) {
      const dx = first.to.x - first.from.x
      const dy = first.to.y - first.from.y
      return { ...w, points: w.points.map((p) => ({ x: round(p.x + dx, digits), y: round(p.y + dy, digits) })) }
    }
    let points = w.points
    if (first) points = stretchEnd(points, 0, to(first), exact)
    if (last) points = stretchEnd(points, points.length - 1, to(last), exact)
    return { ...w, points }
  })
  const labels = project.labels.map((l) => {
    const m = at(l.sheet ?? ROOT_SHEET, l)
    return m ? { ...l, x: round(m.to.x, digits), y: round(m.to.y, digits) } : l
  })
  return { wires, labels }
}

/** Sheet symbols moved by `delta`, with their pins and the wires and labels at the pins (their ends follow). */
export function moveSheetSymbols(project: Project, ids: string[], delta: Vec2): Project {
  const move = new Set(ids)
  // S11: a sheet joined by KiCad's rules keeps its points to six digits, so what was at one point stays at one.
  const digits = kicadRulesShown(project) ? 6 : 4
  const symbols = (project.sheetSymbols ?? []).filter((s) => move.has(s.id))
  if (!symbols.length || (delta.x === 0 && delta.y === 0)) return project
  const shift = (p: Vec2): Vec2 => ({ x: round(p.x + delta.x, digits), y: round(p.y + delta.y, digits) })
  const { wires, labels } = followPins(project, symbols.flatMap((s) => s.pins.map((p) => ({ sheet: s.sheet, from: { x: p.x, y: p.y }, to: shift(p) }))), digits)
  return settleKicadSheet(project, touch({
    ...project,
    wires,
    labels,
    sheetSymbols: project.sheetSymbols!.map((s) => (move.has(s.id) ? { ...s, x: round(s.x + delta.x, digits), y: round(s.y + delta.y, digits), pins: s.pins.map((p) => ({ ...p, ...shift(p) })) } : s)),
  }))
}

/** What a person may change about a sheet symbol: its name, its flags and its look. */
export function setSheetSymbol(project: Project, id: string, patch: { name?: string; flags?: Partial<Record<"dnp" | "excludeFromBom" | "notOnBoard" | "excludeFromSim", boolean>> | null; fill?: SheetSymbol["fill"] | null; stroke?: SheetSymbol["stroke"] | null }): Project {
  const sym = project.sheetSymbols?.find((s) => s.id === id)
  if (!sym) return project
  const next: SheetSymbol = { ...sym }
  if (patch.name !== undefined) {
    // Sheets on one sheet have names of their own: two of one name would make two nets of one name below them.
    const taken = new Set((project.sheetSymbols ?? []).filter((s) => s.id !== id && s.sheet === sym.sheet).map((s) => s.name.toLowerCase()))
    let name = patch.name
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${patch.name}${i}`
    next.name = name
    if (next.fields) next.fields = next.fields.map((f) => (f.name === "Sheetname" ? { ...f, value: name } : f))
  }
  if (patch.flags === null) delete next.flags
  else if (patch.flags) {
    const merged: Partial<Record<"dnp" | "excludeFromBom" | "notOnBoard" | "excludeFromSim", boolean>> = { ...next.flags, ...patch.flags }
    const flags: NonNullable<SheetSymbol["flags"]> = {}
    for (const k of ["dnp", "excludeFromBom", "notOnBoard", "excludeFromSim"] as const) if (merged[k]) flags[k] = true
    if (Object.keys(flags).length) next.flags = flags
    else delete next.flags
  }
  if (patch.fill === null) delete next.fill
  else if (patch.fill) next.fill = patch.fill
  if (patch.stroke === null) delete next.stroke
  else if (patch.stroke) next.stroke = patch.stroke
  const changed = touch({ ...project, sheetSymbols: project.sheetSymbols!.map((s) => (s.id === id ? next : s)) })
  // X20: a placement area names its sheet by path, which a new name changes.
  return patch.name !== undefined ? followSheetNames(project, changed) : changed
}

/**
 * The sheet a use shows, renamed as the tree and the tabs name it: the root by its own name (none for `Main`), a sheet below it by the
 * symbol that makes the use, as the Inspector renames it.
 */
export function renameSheetUse(project: Project, path: string, name: string): Project {
  const title = name.trim()
  const use = knownUse(project, path)
  if (!title || !use || title === use.name) return project
  if (use.symbol) return setSheetSymbol(project, use.symbol.id, { name: title })
  const sheets = sheetsOf(project)
  const root = sheets.find((s) => s.id === ROOT_SHEET)!
  const { name: _old, ...plain } = root
  const renamed = title === MAIN_SHEET_NAME ? plain : { ...plain, name: title }
  return touch({ ...project, sheets: sheets.map((s) => (s === root ? renamed : s)) })
}

/**
 * A sheet symbol made bigger or smaller: the pins on the far edges go with them, and a pin past an edge that came in is held on it. The wires and labels at a pin
 * follow it, as they do when the symbol is moved, so no pin is cut off the net it was on.
 */
export function resizeSheetSymbol(project: Project, id: string, w: number, h: number): Project {
  const sym = project.sheetSymbols?.find((s) => s.id === id)
  if (!sym) return project
  const digits = kicadRulesShown(project) ? 6 : 4
  const nw = Math.max(snap(w), GRID * 4)
  const nh = Math.max(snap(h), GRID * 2)
  const pins = sym.pins.map((p) => {
    if (p.rot === 0) return { ...p, x: round(sym.x + nw, digits), y: Math.min(p.y, sym.y + nh) }
    if (p.rot === 90) return { ...p, y: round(sym.y + nh, digits), x: Math.min(p.x, sym.x + nw) }
    return { ...p, x: Math.min(p.x, sym.x + nw), y: Math.min(p.y, sym.y + nh) }
  })
  const moves = pins.flatMap((p, i) => (samePlace(p, sym.pins[i]) ? [] : [{ sheet: sym.sheet, from: { x: sym.pins[i].x, y: sym.pins[i].y }, to: { x: p.x, y: p.y } }]))
  const followed = moves.length ? followPins(project, moves, digits) : { wires: project.wires, labels: project.labels }
  return settleKicadSheet(project, touch({ ...project, wires: followed.wires, labels: followed.labels, sheetSymbols: project.sheetSymbols!.map((s) => (s.id === id ? { ...s, w: nw, h: nh, pins } : s)) }))
}

/**
 * What an edit of sheet symbols (a move, a resize) would change about the connections even with the wires following the pins, in words, one sentence each: nets it
 * would join and pins it would cut off theirs. Empty when every pin is on the net it was on. The sheet the symbols are drawn on is looked at alone (its first use: the
 * parts of other sheets are at places of their own), `sheet` being its id. `conn` is the connectivity of a project, when the caller keeps one.
 */
export function sheetEditProblems(before: Project, after: Project, sheet: string, conn: (p: Project) => SchematicConnectivity = computeConnectivity): string[] {
  const path = usesOfSheet(before, sheet)[0]?.path
  if (path === undefined || before.scope !== undefined) return moveProblems(before, after, conn(before), conn(after), new Set(), { lenient: true })
  const was = sheetView(before, path)
  const now = sheetView(after, path)
  return moveProblems(was, now, conn(was), conn(now), new Set(), { lenient: true })
}

const SIDE_ROT: Record<"left" | "right" | "top" | "bottom", Rotation> = { right: 0, top: 90, left: 180, bottom: 270 }

/** An edge of a sheet symbol. */
export type SheetSide = keyof typeof SIDE_ROT

/** S11: the digits a sheet symbol's pins keep: six on a sheet joined by KiCad's rules, so what was at one point stays at one, else the editor's four. */
const pinDigits = (project: Project, sym: SheetSymbol) => (project.sheets?.some((s) => s.id === sym.sheet && s.kicadRules) ? 6 : 4)

/** The first free place along an edge of a symbol, a grid step in from the corner and a grid step apart. */
function freeSpot(sym: SheetSymbol, side: SheetSide, digits = 4): Vec2 {
  const rot = SIDE_ROT[side]
  const taken = sym.pins.filter((p) => p.rot === rot)
  const horizontal = side === "top" || side === "bottom"
  const length = horizontal ? sym.w : sym.h
  for (let step = 2; step * GRID < length; step += 2) {
    const along = step * GRID
    const spot = side === "left" ? { x: sym.x, y: sym.y + sym.h - along } : side === "right" ? { x: sym.x + sym.w, y: sym.y + sym.h - along } : side === "top" ? { x: sym.x + along, y: sym.y + sym.h } : { x: sym.x + along, y: sym.y }
    if (!taken.some((p) => Math.hypot(p.x - spot.x, p.y - spot.y) < GRID * 1.5)) return { x: round(spot.x, digits), y: round(spot.y, digits) }
  }
  return side === "left" ? { x: sym.x, y: sym.y } : side === "right" ? { x: sym.x + sym.w, y: sym.y } : side === "top" ? { x: sym.x, y: sym.y + sym.h } : { x: sym.x, y: sym.y }
}

/** A pin on a sheet symbol, on the edge named, at the first free place along it (or at `at`, on that edge). */
export function addSheetPin(project: Project, symbolId: string, name: string, shape: LabelShape = "bidirectional", side: SheetSide = "left", at?: Vec2): Project {
  const sym = project.sheetSymbols?.find((s) => s.id === symbolId)
  if (!sym || !name.trim()) return project
  const spot = at ?? freeSpot(sym, side, pinDigits(project, sym))
  const pin: SheetPin = { id: nextId(sym.pins.map((p) => p.id), "p"), name: name.trim(), shape, x: spot.x, y: spot.y, rot: SIDE_ROT[side] }
  return touch({ ...project, sheetSymbols: project.sheetSymbols!.map((s) => (s.id === symbolId ? { ...s, pins: [...s.pins, pin] } : s)) })
}

/** How far from a sheet symbol's edge a click still lands on it. */
export const EDGE_REACH = GRID * 2.5

/**
 * The place on a sheet symbol's edges nearest to `p` that a pin can have: on the grid, a grid step in from each corner at least, with the edge it is on.
 * Null when `p` is further than `reach` from every such place (or an edge is too short to have one).
 */
export function edgeSpot(sym: SheetSymbol, p: Vec2, { reach = EDGE_REACH, digits = 4 }: { reach?: number; digits?: number } = {}): { side: SheetSide; at: Vec2 } | null {
  // Along an edge from `from` of `length`: the grid point nearest `v` with a grid step to each end.
  const along = (from: number, length: number, v: number): number | null => {
    const lo = Math.ceil(round((from + GRID) / GRID, 6)) * GRID
    const hi = Math.floor(round((from + length - GRID) / GRID, 6)) * GRID
    return hi < lo - 1e-9 ? null : round(Math.min(hi, Math.max(lo, Math.round(v / GRID) * GRID)), 4)
  }
  const ys = along(sym.y, sym.h, p.y)
  const xs = along(sym.x, sym.w, p.x)
  const spots: { side: SheetSide; at: Vec2 }[] = []
  if (ys !== null) spots.push({ side: "left", at: { x: sym.x, y: ys } }, { side: "right", at: { x: sym.x + sym.w, y: ys } })
  if (xs !== null) spots.push({ side: "bottom", at: { x: xs, y: sym.y } }, { side: "top", at: { x: xs, y: sym.y + sym.h } })
  let best: { side: SheetSide; at: Vec2 } | null = null
  let dist = reach
  for (const s of spots) {
    const d = Math.hypot(s.at.x - p.x, s.at.y - p.y)
    if (d <= dist) [best, dist] = [s, d]
  }
  return best && { side: best.side, at: { x: round(best.at.x, digits), y: round(best.at.y, digits) } }
}

/** Where a pin of a sheet symbol (`pinId`, or a new one for null) would go for a point: its `edgeSpot`, unless another pin of the symbol is there. */
export function sheetPinSpot(project: Project, symbolId: string, pinId: string | null, to: Vec2, reach = EDGE_REACH): { side: SheetSide; at: Vec2 } | null {
  const sym = project.sheetSymbols?.find((s) => s.id === symbolId)
  const spot = sym && edgeSpot(sym, to, { reach, digits: pinDigits(project, sym) })
  if (!sym || !spot) return null
  return sym.pins.some((q) => q.id !== pinId && Math.hypot(q.x - spot.at.x, q.y - spot.at.y) < GRID / 2) ? null : spot
}

/**
 * A pin of a sheet symbol slid along its edges to the place nearest `to` (`edgeSpot`, at any distance): round a corner it changes side and turns with it.
 * A place another pin of the symbol has is skipped (the project comes back as it was). The wires and labels at the pin follow it, as they do a moved symbol.
 */
export function moveSheetPin(project: Project, symbolId: string, pinId: string, to: Vec2): Project {
  const sym = project.sheetSymbols?.find((s) => s.id === symbolId)
  const pin = sym?.pins.find((q) => q.id === pinId)
  const spot = sheetPinSpot(project, symbolId, pinId, to, Infinity)
  if (!sym || !pin || !spot || (samePlace(spot.at, pin) && SIDE_ROT[spot.side] === pin.rot)) return project
  const { wires, labels } = followPins(project, [{ sheet: sym.sheet, from: { x: pin.x, y: pin.y }, to: spot.at }], pinDigits(project, sym))
  const moved: SheetPin = { ...pin, ...spot.at, rot: SIDE_ROT[spot.side] }
  return settleKicadSheet(project, touch({ ...project, wires, labels, sheetSymbols: project.sheetSymbols!.map((s) => (s.id === symbolId ? { ...s, pins: s.pins.map((q) => (q.id === pinId ? moved : q)) } : s)) }))
}

/** A pin changed: its name, its shape. */
export function setSheetPin(project: Project, symbolId: string, pinId: string, patch: { name?: string; shape?: LabelShape }): Project {
  return touch({ ...project, sheetSymbols: (project.sheetSymbols ?? []).map((s) => (s.id === symbolId ? { ...s, pins: s.pins.map((p) => (p.id === pinId ? { ...p, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.shape ? { shape: patch.shape } : {}) } : p)) } : s)) })
}

export function removeSheetPin(project: Project, symbolId: string, pinId: string): Project {
  return touch({ ...project, sheetSymbols: (project.sheetSymbols ?? []).map((s) => (s.id === symbolId ? { ...s, pins: s.pins.filter((p) => p.id !== pinId) } : s)) })
}

/** The hierarchical labels of a symbol's sheet that the symbol has no pin for, by name and shape. */
export function missingPins(project: Project, symbolId: string): { name: string; shape: LabelShape }[] {
  const sym = project.sheetSymbols?.find((s) => s.id === symbolId)
  if (!sym) return []
  const have = new Set(sym.pins.map((p) => p.name.trim()))
  const out = new Map<string, LabelShape>()
  for (const l of project.labels as NetLabel[]) {
    if (l.kind !== "hierarchical" || (l.sheet ?? ROOT_SHEET) !== sym.child) continue
    const name = l.name.trim()
    if (name && !have.has(name) && !out.has(name)) out.set(name, l.shape ?? "bidirectional")
  }
  return [...out].map(([name, shape]) => ({ name, shape }))
}

/** A pin on the symbol for every hierarchical label of its sheet that has none: inputs on the left, outputs on the right, the rest on the left. */
export function addMissingPins(project: Project, symbolId: string): Project {
  let next = project
  for (const m of missingPins(project, symbolId)) next = addSheetPin(next, symbolId, m.name, m.shape, m.shape === "output" ? "right" : "left")
  return next
}

/** The box of what is drawn on a sheet (a view of one use of it), its ports left out: they stand in columns beside it. Null for an empty sheet. */
function drawnBox(view: Project): Box | null {
  const b = emptyBox()
  const add = (box: Box) => {
    expandBox(b, { x: box.minX, y: box.minY })
    expandBox(b, { x: box.maxX, y: box.maxY })
  }
  for (const c of view.components) add(schematicBounds(c))
  for (const w of view.wires) for (const q of w.points) expandBox(b, q)
  for (const l of view.labels) if (l.kind !== "hierarchical") add(labelBox(l))
  for (const d of view.drawings ?? []) add(drawingBounds(d))
  for (const s of symbolsOnSheet(view, useAt(view, view.scope ?? "").sheet)) add({ minX: s.x, minY: s.y, maxX: s.x + s.w, maxY: s.y + s.h })
  return Number.isFinite(b.minX) ? b : null
}

/** How far a port's point stands from the drawing, and how far apart ports are down their column. */
const PORT_GAP = GRID * 4
const PORT_STEP = GRID * 2

/**
 * A port (a hierarchical label) of a name on a sheet, where nothing is: in a column left of the sheet's drawing pointing left, or for an output right of
 * it pointing right, down from the drawing's top, clear of the sheet's other labels; on an empty sheet, down from the origin.
 */
function placePort(project: Project, sheetId: string, name: string, shape: LabelShape): Project {
  const use = usesOfSheet(project, sheetId)[0]
  const box = use ? drawnBox(sheetView(project, use.path)) : null
  const out = shape === "output"
  const rot: Rotation = out ? 0 : 180
  const x = box ? snap(out ? box.maxX + PORT_GAP : box.minX - PORT_GAP) : 0
  const others = project.labels.filter((l) => sheetIdOf(l) === sheetId).map((l) => labelBox(l))
  const clear = (y: number) => {
    const b = labelBox({ id: "", name, x, y, rot, kind: "hierarchical", shape })
    return !others.some((o) => boxesOverlap({ minX: b.minX - GRID / 2, minY: b.minY - GRID / 2, maxX: b.maxX + GRID / 2, maxY: b.maxY + GRID / 2 }, o))
  }
  let y = box ? snap(box.maxY) : 0
  while (!clear(y)) y = round(y - PORT_STEP, 4)
  const made = addLabel(project, name, { x, y }, rot, { kind: "hierarchical", shape })
  return { ...made.project, labels: made.project.labels.map((l) => (l.id === made.label.id ? { ...l, sheet: sheetId } : l)) }
}

/**
 * Altium's Synchronize Sheet Entries and Ports, adding only: every sheet symbol that stands for `sheetId` gets an entry of the name where it has none (an
 * output on the right, the rest on the left), and the sheet gets a port of the name where it has none (`placePort`). Says what it added: the names of the
 * symbols that got the entry, and whether the port was placed. Runs on the whole project, never on a view of one sheet: a port made for another sheet
 * inside a view would be put back on the view's sheet.
 */
export function syncSheetEntry(project: Project, sheetId: string, name: string, shape: LabelShape): { project: Project; entries: string[]; port: boolean } {
  if (project.scope !== undefined) throw new Error("syncSheetEntry runs on the whole project, not on a view of one sheet")
  const text = name.trim()
  if (!text || sheetId === ROOT_SHEET) return { project, entries: [], port: false }
  let next = project
  const entries: string[] = []
  for (const sym of project.sheetSymbols ?? []) {
    if (sym.child !== sheetId || sym.pins.some((p) => p.name.trim() === text)) continue
    next = addSheetPin(next, sym.id, text, shape, shape === "output" ? "right" : "left")
    entries.push(sym.name)
  }
  const port = !project.labels.some((l) => l.kind === "hierarchical" && sheetIdOf(l) === sheetId && l.name.trim() === text)
  if (port) next = placePort(next, sheetId, text, shape)
  return { project: next, entries, port }
}

/** Whether a path names a use of a sheet the project has: what the editor checks before it shows one. */
export const knownUse = (project: Project, path: string): SheetUse | null => (hasUse(project, path) ? useAt(project, path) : null)

/**
 * What deleting sheet symbols takes with them, in words: a sheet no other symbol stands for goes with everything drawn on it, and so do the
 * parts of the uses that go. Null when only the symbols go.
 */
export function removalNote(p: Project, ids: string[]): string | null {
  const next = removeSheetSymbols(p, ids)
  const parts = p.components.length - next.components.length
  const sheets = (p.sheets ?? []).filter((x) => x.id !== "root").length - (next.sheets ?? []).filter((x) => x.id !== "root").length
  if (!parts && !sheets) return null
  const names = (p.sheetSymbols ?? []).filter((s) => ids.includes(s.id)).map((s) => s.name)
  return `Deleted ${names.length > 1 ? "the sheets" : "the sheet"} ${names.join(", ")}${parts ? ` with ${parts} part${parts > 1 ? "s" : ""}` : ""}${sheets > 0 ? `, and ${sheets} sheet${sheets > 1 ? "s" : ""} that nothing else uses` : ""}. Undo brings ${parts > 1 || sheets > 1 ? "them" : "it"} back.`
}
