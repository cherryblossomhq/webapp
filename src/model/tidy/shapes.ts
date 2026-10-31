import { round, type Box } from "../../lib/geometry"
import { componentTextBoxes } from "../blocks"
import { schematicBounds, schematicPins } from "../instances"
import { labelBox } from "../labels"
import { findPart } from "../library"
import { scoped } from "../scope"
import { fieldsInFrame, fieldsOnSheet, symbolOf } from "../symbolDrawing"
import { SCH_GRID } from "../symbols"
import type { ComponentInstance, PartDef, Rotation, SymbolPort } from "../types"

// The shapes Tidy draws with, in grid units about their own origin: a part at each of its turns,
// a power or ground port, a net label. They are measured the way the canvas and the block frames
// measure them (symbol bounds, `componentTextBoxes`, `labelBox`), so what Tidy keeps apart is
// what is drawn apart.

export type Dir = SymbolPort["dir"]

export const DIRS: Dir[] = ["right", "up", "left", "down"]
export const VEC: Record<Dir, [number, number]> = { right: [1, 0], up: [0, 1], left: [-1, 0], down: [0, -1] }
export const OPPOSITE: Record<Dir, Dir> = { right: "left", left: "right", up: "down", down: "up" }
export const isVertical = (d: Dir) => d === "up" || d === "down"

/** World units to grid units, and back. */
export const gu = (v: number) => Math.round(v / SCH_GRID)
export const world = (g: number) => round(g * SCH_GRID)
export const boxToGrid = (b: Box): Box => ({ minX: b.minX / SCH_GRID, minY: b.minY / SCH_GRID, maxX: b.maxX / SCH_GRID, maxY: b.maxY / SCH_GRID })
export const shift = (b: Box, x: number, y: number): Box => ({ minX: b.minX + x, minY: b.minY + y, maxX: b.maxX + x, maxY: b.maxY + y })

/** How far a symbol's drawing is pulled in from its pins' ends, so a wire leaving a pin is outside it. */
const BODY_INSET = 0.2

export interface PinShape {
  /**
   * The pin's number. The second pin of a number in a symbol that keeps such pins apart, standing
   * where the first does not, is "1#1": it is a pin of its own, on a net of its own, so it must not
   * be taken for the first (`tidyPinId`).
   */
  pin: string
  /** The pin's end, in grid units from the part's origin. */
  x: number
  y: number
  dir: Dir
}

export interface PartShape {
  rot: Rotation
  body: Box
  texts: Box[]
  pins: PinShape[]
}

/** By part id, which names what the scope registered (`model/scope.ts`), so the cache is the scope's too. */
const shapeCache = scoped(() => new Map<string, PartShape>())

/** Parts whose text Tidy leaves out of its shapes: only while it finds out whether that text is what leaves no room (`withoutTexts`). */
let ignoredTexts: ReadonlySet<string> = new Set()

/** Run `run` with the text of these parts (by id) not counted: their shapes are those of the bare symbol. */
export function withoutTexts<T>(ids: ReadonlySet<string>, run: () => T): T {
  const before = ignoredTexts
  ignoredTexts = ids
  try {
    return run()
  } finally {
    ignoredTexts = before
  }
}
/** The same, by component object: a tidy asks for each part's shapes many times over. */
const byInstance = new WeakMap<ComponentInstance, (PartShape | undefined)[]>()

/** A part's drawing at a turn, about its origin, in grid units. Cached by part, turn and text. */
export function partShape(c: ComponentInstance, rot: Rotation): PartShape {
  let mine = byInstance.get(c)
  if (!mine) byInstance.set(c, (mine = []))
  return (mine[rot / 90] ??= shapeOf(c, rot))
}

/**
 * What tells one drawing of a part from another on the sheet beyond its part and turn: the unit and
 * body style it draws, and whether it is mirrored. Empty for the editor's own parts.
 */
const drawingKey = (c: ComponentInstance) => `${c.unit ? `|u${c.unit}` : ""}${c.bodyStyle ? `|b${c.bodyStyle}` : ""}${c.sch.mirror ? `|m${c.sch.mirror}` : ""}`

type PlacedPin = { pin: string; slot?: number; pos: { x: number; y: number } }

/**
 * The id Tidy knows a drawn pin by. A symbol that keeps the pins of one number apart can draw two
 * of them in different places, each on a net of its own: the second is `number#slot`, which has no
 * net for Tidy (the connectivity has none for it), so Tidy leaves it alone rather than wire it to
 * the net of the first. Two stacked at one place are one pin.
 */
export function tidyPinId(part: PartDef | undefined, pin: PlacedPin, all: PlacedPin[]): string {
  if (!pin.slot || !part?.jumpers || part.jumpers.duplicates) return pin.pin
  const stacked = all.some((o) => o.pin === pin.pin && (o.slot ?? 0) < pin.slot! && o.pos.x === pin.pos.x && o.pos.y === pin.pos.y)
  return stacked ? pin.pin : `${pin.pin}#${pin.slot}`
}

/**
 * `c` standing at `to` (a place and a turn). A symbol's own field places are where they are drawn, so a
 * symbol turned to another way takes its fields with it, as KiCad's do.
 */
export function reseat(c: ComponentInstance, to: Partial<ComponentInstance["sch"]>): ComponentInstance {
  const sch = { ...c.sch, ...to }
  if (!c.fields || sch.rot === c.sch.rot) return { ...c, sch }
  return { ...c, sch, fields: fieldsOnSheet(fieldsInFrame(c.fields, c.sch), sch) }
}

function shapeOf(c: ComponentInstance, rot: Rotation): PartShape {
  const part = findPart(c.partId)
  // Turned to `rot` about its origin, mirrored as the part is.
  const at: ComponentInstance = reseat(c, { x: 0, y: 0, rot })
  const texts = ignoredTexts.has(c.id) ? [] : componentTextBoxes(at)
  const key = `${c.partId}|${rot}${drawingKey(c)}|${texts.map((t) => `${t.minX},${t.minY},${t.maxX},${t.maxY}`).join(";")}`
  const hit = shapeCache().get(key)
  if (hit) return hit
  const b = boxToGrid(schematicBounds(at, part))
  const world = schematicPins(at, part)
  const pins = world.map((p) => ({ pin: tidyPinId(part, p, world), x: gu(p.pos.x), y: gu(p.pos.y), dir: p.dir }))
  // Pull the drawing in from the pins' ends on each side that has some, so a pin's end is outside it.
  const inset = (side: (p: PinShape) => boolean) => (pins.some(side) ? BODY_INSET : 0)
  const body: Box = {
    minX: b.minX + inset((p) => p.dir === "left" && Math.abs(p.x - b.minX) < 1e-6),
    maxX: b.maxX - inset((p) => p.dir === "right" && Math.abs(p.x - b.maxX) < 1e-6),
    minY: b.minY + inset((p) => p.dir === "down" && Math.abs(p.y - b.minY) < 1e-6),
    maxY: b.maxY - inset((p) => p.dir === "up" && Math.abs(p.y - b.maxY) < 1e-6),
  }
  const shape: PartShape = { rot, body, texts: texts.map(boxToGrid), pins }
  shapeCache().set(key, shape)
  return shape
}

/** Symbols drawn as a box with pins on its sides keep the turn they were given. */
export function isBoxPart(part: PartDef | undefined): boolean {
  if (!part) return true
  return part.category === "ICs" || part.category === "Modules" || part.category === "Connectors" || part.refPrefix === "U" || part.pins.length > 4
}

/** The turns Tidy may give a part: any for small discrete parts, the given one for boxes. */
export function allowedTurns(c: ComponentInstance): Rotation[] {
  const part = findPart(c.partId)
  if (!part || isBoxPart(part) || symbolOf(part, c).ports.length === 0) return [c.sch.rot]
  return [0, 90, 180, 270]
}

export type RailKind = "power" | "ground"

/**
 * A power symbol brought in from KiCad that Tidy draws a net's ports with, in place of the editor's
 * own: its part, and the per-symbol field places of the one it took it from.
 */
export interface PortVia {
  partId: string
  fields?: ComponentInstance["fields"]
}

/** The imported port a net's ports are drawn as, by the net's name. Set for the length of one tidy (`withPortVias`). */
let portVias: ReadonlyMap<string, PortVia> = new Map()

/** Run `run` with these nets drawing their ports as the given imported power symbols. */
export function withPortVias<T>(vias: ReadonlyMap<string, PortVia>, run: () => T): T {
  const before = portVias
  portVias = vias
  try {
    return run()
  } finally {
    portVias = before
  }
}

export interface PortShape {
  partId: string
  /** The per-symbol fields of the imported port this one is drawn as. */
  fields?: ComponentInstance["fields"]
  rot: Rotation
  /** From the port's pin to its origin. */
  ox: number
  oy: number
  /** Its drawing and its name, about its pin. */
  body: Box
  text: Box
}

const portCache = scoped(() => new Map<string, PortShape>())

/** The way a wire leaves the pin of a port drawn unturned: down for a supply, up for ground, whichever the imported symbol says. */
export function portOwnDir(kind: RailKind, via?: PortVia): Dir {
  const part = via && findPart(via.partId)
  const dir = part && symbolOf(part).ports[0]?.dir
  return dir ?? (kind === "power" ? "down" : "up")
}

/** The turn that makes a port's pin face `facing`: the way back to the pin it sits on. */
function portTurn(own: Dir, facing: Dir): Rotation {
  const steps = (DIRS.indexOf(facing) - DIRS.indexOf(own) + 4) % 4
  return (steps * 90) as Rotation
}

/**
 * Why Tidy can't draw a net's ports as the imported symbol it has: nothing, or a sentence. Its one
 * pin must stand on the grid about its origin, so that a port put on a stub puts the pin on the stub's end.
 */
export function portProblem(partId: string): string | null {
  const part = findPart(partId)
  const ports = part ? symbolOf(part).ports : []
  if (!part || ports.length !== 1) return `${part?.name ?? partId} has ${ports.length} pins`
  const onGrid = (v: number) => Math.abs(v / SCH_GRID - Math.round(v / SCH_GRID)) < 1e-6
  return onGrid(ports[0].x) && onGrid(ports[0].y) ? null : `the pin of ${part.name} is off the grid`
}

/** A power or ground port standing on a pin that points `out`, pointing the same way. */
export function portShape(kind: RailKind, net: string, out: Dir): PortShape {
  const via = portVias.get(net)
  const key = via ? `${kind}|${net}|${out}|${via.partId}|${via.fields ? JSON.stringify(via.fields) : ""}` : `${kind}|${net}|${out}`
  const hit = portCache().get(key)
  if (hit) return hit
  const partId = via?.partId ?? kind
  const rot = portTurn(portOwnDir(kind, via), OPPOSITE[out])
  const c: ComponentInstance = {
    id: "port",
    partId,
    ref: "#P",
    props: { net },
    ...(via?.fields ? { fields: fieldsOnSheet(via.fields, { rot }) } : {}),
    footprint: "",
    sch: { x: 0, y: 0, rot },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
  }
  const pin = schematicPins(c)[0]
  const px = gu(pin.pos.x)
  const py = gu(pin.pos.y)
  const body = shift(boxToGrid(schematicBounds(c)), -px, -py)
  const texts = componentTextBoxes(c).map((b) => shift(boxToGrid(b), -px, -py))
  // The editor's own port has one text, its name. An imported one writes each field it shows: all of them are its text.
  const text: Box = !via ? texts[0] : texts.length ? texts.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) })) : body
  const shape: PortShape = { partId, ...(via?.fields ? { fields: fieldsOnSheet(via.fields, { rot }) } : {}), rot, ox: -px, oy: -py, body, text }
  portCache().set(key, shape)
  return shape
}

/** What the designator of a port is built from: `#GND` for the editor's ground, `#PWR` for the rest. */
export const portPrefix = (partId: string): "#PWR" | "#GND" => (partId === "ground" ? "#GND" : "#PWR")

/** A port component for a shape, standing with its pin at `at`: without an id or designator, which the caller gives. */
export function portInstance(shape: PortShape, name: string, at: { x: number; y: number }): ComponentInstance {
  const part = findPart(shape.partId)!
  return {
    id: "",
    partId: shape.partId,
    ref: "",
    props: { ...part.defaultProps, net: name },
    ...(shape.fields ? { fields: shape.fields } : {}),
    footprint: "",
    sch: { x: round(at.x + shape.ox * SCH_GRID), y: round(at.y + shape.oy * SCH_GRID), rot: shape.rot },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
  }
}

/** The turn of a label whose flag runs `dir` from its point. */
export const labelTurn = (dir: Dir): Rotation => (dir === "right" ? 0 : dir === "up" ? 90 : dir === "left" ? 180 : 270)

/** A net label's flag about its point, running `dir`, in grid units. */
export function labelShape(name: string, dir: Dir): Box {
  return boxToGrid(labelBox({ id: "", name, x: 0, y: 0, rot: labelTurn(dir) }))
}
