import { round } from "../lib/geometry"
import { removeItems, stretchEnd } from "./ops"
import { ROOT_SHEET, hasUse, sheetUses, syncCopies, useAt, usesOfSheet, type SheetUse } from "./sheets"
import type { LabelShape, NetLabel, Project, Rotation, SchematicSheet, SheetPin, SheetSymbol, Vec2 } from "./types"

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

const slug = (name: string) => name.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "sheet"

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
  const sheet: SchematicSheet = { id, file: `${slug(title)}.kicad_sch` }
  const symbol: SheetSymbol = {
    id: symbolId,
    sheet: parentSheet,
    child: id,
    x: snap(box.minX),
    y: snap(box.minY),
    w: Math.max(snap(box.maxX - box.minX), GRID * 4),
    h: Math.max(snap(box.maxY - box.minY), GRID * 2),
    name: title,
    file: sheet.file!,
    pins: [],
  }
  return { project: touch({ ...project, sheets: [...sheets, sheet], sheetSymbols: [...(project.sheetSymbols ?? []), symbol] }), symbol }
}

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
    file: first?.file ?? sheet.file ?? `${slug(child)}.kicad_sch`,
    // The pins are those of the sheet, as on its first symbol, along the same edges.
    pins: (first?.pins ?? []).map((p) => ({ ...p, id: p.id, x: p.x - first!.x + snap(box.minX), y: p.y - first!.y + snap(box.minY), uuid: undefined })),
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

/** Everything that was drawn on sheets and uses that are no longer in the tree goes with the sheet symbol that made them. */
function dropUnusedSheets(project: Project): Project {
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
  const symbols = (project.sheetSymbols ?? []).filter((s) => live.has(s.sheet) && live.has(s.child))
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

/** Sheet symbols moved by `delta`, with their pins and the wires and labels at the pins (their ends follow). */
export function moveSheetSymbols(project: Project, ids: string[], delta: Vec2): Project {
  const move = new Set(ids)
  const symbols = (project.sheetSymbols ?? []).filter((s) => move.has(s.id))
  if (!symbols.length || (delta.x === 0 && delta.y === 0)) return project
  const sameSheet = (a: string | undefined, b: string) => (a ?? ROOT_SHEET) === b
  const ends = (sheet: string) => symbols.filter((s) => s.sheet === sheet).flatMap((s) => s.pins.map((p) => ({ x: p.x, y: p.y })))
  const at = (p: Vec2, list: Vec2[]) => list.some((q) => Math.abs(q.x - p.x) < 1e-4 && Math.abs(q.y - p.y) < 1e-4)
  const wires = project.wires.map((w) => {
    const list = ends(w.sheet ?? ROOT_SHEET)
    if (!list.length) return w
    let points = w.points
    // A wire that is moved with the symbol on both ends is not stretched.
    const first = at(points[0], list)
    const last = points.length > 1 && at(points[points.length - 1], list)
    if (first && last) return { ...w, points: points.map((p) => ({ x: round(p.x + delta.x, 4), y: round(p.y + delta.y, 4) })) }
    if (first) points = stretchEnd(points, 0, { x: round(points[0].x + delta.x, 4), y: round(points[0].y + delta.y, 4) })
    if (last) points = stretchEnd(points, points.length - 1, { x: round(points[points.length - 1].x + delta.x, 4), y: round(points[points.length - 1].y + delta.y, 4) })
    return points === w.points ? w : { ...w, points }
  })
  const labels = project.labels.map((l) => {
    const list = ends(l.sheet ?? ROOT_SHEET)
    return list.length && at(l, list) ? { ...l, x: round(l.x + delta.x, 4), y: round(l.y + delta.y, 4) } : l
  })
  void sameSheet
  return touch({
    ...project,
    wires,
    labels,
    sheetSymbols: project.sheetSymbols!.map((s) => (move.has(s.id) ? { ...s, x: round(s.x + delta.x, 4), y: round(s.y + delta.y, 4), pins: s.pins.map((p) => ({ ...p, x: round(p.x + delta.x, 4), y: round(p.y + delta.y, 4) })) } : s)),
  })
}

/** What a person may change about a sheet symbol: its name and file (the sheet's too), its flags and its look. */
export function setSheetSymbol(project: Project, id: string, patch: { name?: string; file?: string; flags?: Partial<Record<"dnp" | "excludeFromBom" | "notOnBoard" | "excludeFromSim", boolean>> | null; fill?: SheetSymbol["fill"] | null; stroke?: SheetSymbol["stroke"] | null; page?: { use: string; page: string } }): Project {
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
  if (patch.file !== undefined) {
    next.file = patch.file
    if (next.fields) next.fields = next.fields.map((f) => (f.name === "Sheetfile" ? { ...f, value: patch.file! } : f))
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
  if (patch.page) next.pages = { ...next.pages, [patch.page.use]: patch.page.page }
  let sheets = project.sheets
  // The file name is the sheet's: the sheets the symbol stands for have it.
  if (patch.file !== undefined) sheets = (project.sheets ?? []).map((s) => (s.id === sym.child ? { ...s, file: patch.file } : s))
  return touch({ ...project, ...(sheets ? { sheets } : {}), sheetSymbols: project.sheetSymbols!.map((s) => (s.id === id ? next : s)) })
}

/** A sheet symbol made bigger or smaller: the pins on the far edges go with them. */
export function resizeSheetSymbol(project: Project, id: string, w: number, h: number): Project {
  const sym = project.sheetSymbols?.find((s) => s.id === id)
  if (!sym) return project
  const nw = Math.max(snap(w), GRID * 4)
  const nh = Math.max(snap(h), GRID * 2)
  const pins = sym.pins.map((p) => {
    if (p.rot === 0) return { ...p, x: round(sym.x + nw, 4), y: Math.min(p.y, sym.y + nh) }
    if (p.rot === 90) return { ...p, y: round(sym.y + nh, 4), x: Math.min(p.x, sym.x + nw) }
    return { ...p, x: Math.min(p.x, sym.x + nw), y: Math.min(p.y, sym.y + nh) }
  })
  return touch({ ...project, sheetSymbols: project.sheetSymbols!.map((s) => (s.id === id ? { ...s, w: nw, h: nh, pins } : s)) })
}

const SIDE_ROT: Record<"left" | "right" | "top" | "bottom", Rotation> = { right: 0, top: 90, left: 180, bottom: 270 }

/** The first free place along an edge of a symbol, a grid step in from the corner and a grid step apart. */
function freeSpot(sym: SheetSymbol, side: keyof typeof SIDE_ROT): Vec2 {
  const rot = SIDE_ROT[side]
  const taken = sym.pins.filter((p) => p.rot === rot)
  const horizontal = side === "top" || side === "bottom"
  const length = horizontal ? sym.w : sym.h
  for (let step = 2; step * GRID < length; step += 2) {
    const along = step * GRID
    const spot = side === "left" ? { x: sym.x, y: sym.y + sym.h - along } : side === "right" ? { x: sym.x + sym.w, y: sym.y + sym.h - along } : side === "top" ? { x: sym.x + along, y: sym.y + sym.h } : { x: sym.x + along, y: sym.y }
    if (!taken.some((p) => Math.hypot(p.x - spot.x, p.y - spot.y) < GRID * 1.5)) return { x: round(spot.x, 4), y: round(spot.y, 4) }
  }
  return side === "left" ? { x: sym.x, y: sym.y } : side === "right" ? { x: sym.x + sym.w, y: sym.y } : side === "top" ? { x: sym.x, y: sym.y + sym.h } : { x: sym.x, y: sym.y }
}

/** A pin on a sheet symbol, on the edge named, at the first free place along it. */
export function addSheetPin(project: Project, symbolId: string, name: string, shape: LabelShape = "bidirectional", side: keyof typeof SIDE_ROT = "left", at?: Vec2): Project {
  const sym = project.sheetSymbols?.find((s) => s.id === symbolId)
  if (!sym || !name.trim()) return project
  const spot = at ?? freeSpot(sym, side)
  const pin: SheetPin = { id: nextId(sym.pins.map((p) => p.id), "p"), name: name.trim(), shape, x: spot.x, y: spot.y, rot: SIDE_ROT[side] }
  return touch({ ...project, sheetSymbols: project.sheetSymbols!.map((s) => (s.id === symbolId ? { ...s, pins: [...s.pins, pin] } : s)) })
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

/** Whether a path names a use of a sheet the project has: what the editor checks before it shows one. */
export const knownUse = (project: Project, path: string): SheetUse | null => (hasUse(project, path) ? useAt(project, path) : null)

