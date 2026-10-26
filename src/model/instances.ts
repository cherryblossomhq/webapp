import { round, transformBox, transformPoint, type Box } from "../lib/geometry"
import { getFootprint } from "./footprints"
import { findPart } from "./library"
import type {
  ComponentInstance,
  CopperLayer,
  FootprintDef,
  PadDef,
  PartDef,
  Rotation,
  SymbolPort,
  Vec2,
} from "./types"

export interface WorldPin {
  componentId: string
  pin: string
  name: string
  pos: Vec2
  dir: SymbolPort["dir"]
}

const DIRS: SymbolPort["dir"][] = ["right", "up", "left", "down"]

export function rotateDir(dir: SymbolPort["dir"], rot: Rotation): SymbolPort["dir"] {
  return DIRS[(DIRS.indexOf(dir) + rot / 90) % 4]
}

export const dirVector = (dir: SymbolPort["dir"]): Vec2 =>
  dir === "right" ? { x: 1, y: 0 } : dir === "left" ? { x: -1, y: 0 } : dir === "up" ? { x: 0, y: 1 } : { x: 0, y: -1 }

// A component is replaced, never edited, so its pins stay put for as long as the object does.
const pinCache = new WeakMap<ComponentInstance, { part: PartDef; pins: WorldPin[] }>()

/** Where a component's pins are on the sheet. Cached per component object: treat the result as read-only. */
export function schematicPins(c: ComponentInstance, part = findPart(c.partId)): WorldPin[] {
  if (!part) return []
  const hit = pinCache.get(c)
  if (hit && hit.part === part) return hit.pins
  const names = new Map(part.pins.map((p) => [p.number, p.name]))
  const pins = part.symbol.ports.map((port) => {
    const pos = transformPoint(port, c.sch, c.sch.rot)
    return {
      componentId: c.id,
      pin: port.pin,
      name: names.get(port.pin) ?? port.pin,
      pos: { x: round(pos.x), y: round(pos.y) },
      dir: rotateDir(port.dir, c.sch.rot),
    }
  })
  pinCache.set(c, { part, pins })
  return pins
}

export function schematicBounds(c: ComponentInstance, part = findPart(c.partId)): Box {
  if (!part) return { minX: c.sch.x - 0.2, minY: c.sch.y - 0.2, maxX: c.sch.x + 0.2, maxY: c.sch.y + 0.2 }
  return transformBox(part.symbol.bounds, c.sch, c.sch.rot)
}

export interface WorldPad {
  componentId: string
  /** Electrical pin after pad aliasing; null for mechanical pads. */
  pin: string | null
  padNumber: string | null
  shape: PadDef["shape"]
  x: number
  y: number
  width: number
  height: number
  points?: Vec2[]
  holeDiameter?: number
  /** Slotted hole: overall length along the pad's longer side (see PadDef). */
  slotLength?: number
  layers: CopperLayer[]
  /** False for a non-plated hole: no copper, no net, width = height = drill. */
  plated?: false
}

/**
 * End centres of a slotted hole, which runs along the pad's longer side; null for a round hole.
 * Works on footprint pads and on world pads, whose width and height already follow the rotation.
 */
export function slotEnds(pad: Pick<WorldPad, "x" | "y" | "width" | "height" | "holeDiameter" | "slotLength">): [Vec2, Vec2] | null {
  if (!pad.holeDiameter || !pad.slotLength || pad.slotLength <= pad.holeDiameter + 1e-6) return null
  const half = (pad.slotLength - pad.holeDiameter) / 2
  return pad.width >= pad.height
    ? [
        { x: round(pad.x - half), y: pad.y },
        { x: round(pad.x + half), y: pad.y },
      ]
    : [
        { x: pad.x, y: round(pad.y - half) },
        { x: pad.x, y: round(pad.y + half) },
      ]
}

/** True for a non-plated (NPTH) hole, which has no copper on any layer. */
export const isNpth = (pad: { plated?: false }) => pad.plated === false

export const isPhysical = (part: PartDef | undefined) => !!part && !part.powerNet && part.footprints.length > 0

export function componentFootprint(c: ComponentInstance): FootprintDef | null {
  const part = findPart(c.partId)
  if (!isPhysical(part) || !c.footprint) return null
  return getFootprint(c.footprint)
}

/** Pads in board coordinates, with bottom-side parts mirrored across their local Y axis. */
export function pcbPads(c: ComponentInstance): WorldPad[] {
  const part = findPart(c.partId)
  const fp = componentFootprint(c)
  if (!fp || !part) return []
  const mirror = c.pcb.side === "bottom"
  const swap = c.pcb.rot === 90 || c.pcb.rot === 270
  return fp.pads.map((pad) => {
    const center = transformPoint(pad, c.pcb, c.pcb.rot, mirror)
    const smdLayer: CopperLayer = c.pcb.side
    return {
      componentId: c.id,
      padNumber: pad.pin,
      pin: pad.pin ? (part.padAlias?.[pad.pin] ?? pad.pin) : null,
      shape: pad.shape,
      x: round(center.x),
      y: round(center.y),
      width: swap ? pad.height : pad.width,
      height: swap ? pad.width : pad.height,
      points: pad.points?.map((p) => {
        const w = transformPoint(p, c.pcb, c.pcb.rot, mirror)
        return { x: round(w.x), y: round(w.y) }
      }),
      holeDiameter: pad.holeDiameter,
      ...(pad.slotLength ? { slotLength: pad.slotLength } : {}),
      layers: pad.layer === "through" ? ["top", "bottom"] : [smdLayer],
      ...(pad.plated === false ? { plated: false as const } : {}),
    }
  })
}

export function pcbSilk(c: ComponentInstance): Vec2[][] {
  const fp = componentFootprint(c)
  if (!fp) return []
  const mirror = c.pcb.side === "bottom"
  return fp.silk.map((path) => path.map((p) => transformPoint(p, c.pcb, c.pcb.rot, mirror)))
}

export function pcbCourtyard(c: ComponentInstance): Box | null {
  const fp = componentFootprint(c)
  if (!fp) return null
  return transformBox(fp.courtyard, c.pcb, c.pcb.rot, c.pcb.side === "bottom")
}

export function valueText(c: ComponentInstance, part = findPart(c.partId)): string {
  if (!part) return ""
  if (part.valueProp) return c.props[part.valueProp] ?? ""
  return ""
}

export const powerNetName = (c: ComponentInstance, part = findPart(c.partId)) =>
  part?.powerNet ? (c.props.net?.trim() || part.powerNet) : null

/** Unit direction a pin leaves its symbol, for wire stubs. */
export function pinStubPoint(pin: WorldPin, length = 0.2): Vec2 {
  const d = dirVector(pin.dir)
  return { x: round(pin.pos.x + d.x * length), y: round(pin.pos.y + d.y * length) }
}
