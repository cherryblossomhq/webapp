import { round, type Box } from "../../lib/geometry"
import { componentTextBoxes } from "../blocks"
import { schematicBounds, schematicPins } from "../instances"
import { labelBox } from "../labels"
import { findPart } from "../library"
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

const shapeCache = new Map<string, PartShape>()
/** The same, by component object: a tidy asks for each part's shapes many times over. */
const byInstance = new WeakMap<ComponentInstance, (PartShape | undefined)[]>()

/** A part's drawing at a turn, about its origin, in grid units. Cached by part, turn and text. */
export function partShape(c: ComponentInstance, rot: Rotation): PartShape {
  let mine = byInstance.get(c)
  if (!mine) byInstance.set(c, (mine = []))
  return (mine[rot / 90] ??= shapeOf(c, rot))
}

function shapeOf(c: ComponentInstance, rot: Rotation): PartShape {
  const part = findPart(c.partId)
  const at: ComponentInstance = { ...c, sch: { x: 0, y: 0, rot } }
  const texts = componentTextBoxes(at)
  const key = `${c.partId}|${rot}|${texts.map((t) => `${t.minX},${t.minY},${t.maxX},${t.maxY}`).join(";")}`
  const hit = shapeCache.get(key)
  if (hit) return hit
  const b = boxToGrid(schematicBounds(at, part))
  const pins = schematicPins(at, part).map((p) => ({ pin: p.pin, x: gu(p.pos.x), y: gu(p.pos.y), dir: p.dir }))
  // Pull the drawing in from the pins' ends on each side that has some, so a pin's end is outside it.
  const inset = (side: (p: PinShape) => boolean) => (pins.some(side) ? BODY_INSET : 0)
  const body: Box = {
    minX: b.minX + inset((p) => p.dir === "left" && Math.abs(p.x - b.minX) < 1e-6),
    maxX: b.maxX - inset((p) => p.dir === "right" && Math.abs(p.x - b.maxX) < 1e-6),
    minY: b.minY + inset((p) => p.dir === "down" && Math.abs(p.y - b.minY) < 1e-6),
    maxY: b.maxY - inset((p) => p.dir === "up" && Math.abs(p.y - b.maxY) < 1e-6),
  }
  const shape: PartShape = { rot, body, texts: texts.map(boxToGrid), pins }
  shapeCache.set(key, shape)
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
  if (!part || isBoxPart(part) || part.symbol.ports.length === 0) return [c.sch.rot]
  return [0, 90, 180, 270]
}

export type RailKind = "power" | "ground"

export interface PortShape {
  partId: "power" | "ground"
  rot: Rotation
  /** From the port's pin to its origin. */
  ox: number
  oy: number
  /** Its drawing and its name, about its pin. */
  body: Box
  text: Box
}

const portCache = new Map<string, PortShape>()

/** The turn that makes a port's pin face `facing`: the way back to the pin it sits on. */
function portTurn(kind: RailKind, facing: Dir): Rotation {
  const own: Dir = kind === "power" ? "down" : "up"
  const steps = (DIRS.indexOf(facing) - DIRS.indexOf(own) + 4) % 4
  return (steps * 90) as Rotation
}

/** A power or ground port standing on a pin that points `out`, pointing the same way. */
export function portShape(kind: RailKind, net: string, out: Dir): PortShape {
  const key = `${kind}|${net}|${out}`
  const hit = portCache.get(key)
  if (hit) return hit
  const partId = kind
  const rot = portTurn(kind, OPPOSITE[out])
  const c: ComponentInstance = {
    id: "port",
    partId,
    ref: "#P",
    props: { net },
    footprint: "",
    sch: { x: 0, y: 0, rot },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
  }
  const pin = schematicPins(c)[0]
  const px = gu(pin.pos.x)
  const py = gu(pin.pos.y)
  const body = shift(boxToGrid(schematicBounds(c)), -px, -py)
  const [text] = componentTextBoxes(c).map((b) => shift(boxToGrid(b), -px, -py))
  const shape: PortShape = { partId, rot, ox: -px, oy: -py, body, text }
  portCache.set(key, shape)
  return shape
}

/** The turn of a label whose flag runs `dir` from its point. */
export const labelTurn = (dir: Dir): Rotation => (dir === "right" ? 0 : dir === "up" ? 90 : dir === "left" ? 180 : 270)

/** A net label's flag about its point, running `dir`, in grid units. */
export function labelShape(name: string, dir: Dir): Box {
  return boxToGrid(labelBox({ id: "", name, x: 0, y: 0, rot: labelTurn(dir) }))
}
