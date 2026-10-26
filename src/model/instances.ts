import { isQuarterTurn, normalizeAngle, round, transformBox, transformPoint, type Box } from "../lib/geometry"
import { getFootprint } from "./footprints"
import { findPart } from "./library"
import { flipShapeLayer } from "./shapeLayers"
import { mapShape } from "./shapes"
import type {
  BoardShape,
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
  /** See `PadDef.axisSpokes`. */
  axisSpokes?: true
  /**
   * The angle of a slotted hole's axis in degrees, [0, 180), only when it is not along x or y: a part
   * placed at an angle that is not a quarter turn. Its copper is then a polygon (`points`).
   */
  slotAxis?: number
  /**
   * A rectangular or pill pad of a part turned by other than a quarter turn: its size before the
   * turn and the angle of its width axis in degrees, [0, 180). Its copper is the polygon in `points`
   * and `width` and `height` are that polygon's extents; this is what an exporter that has a turned
   * pad of its own (Circuit JSON's `rotated_rect`, KiCad's pad angle) is given.
   */
  oriented?: { width: number; height: number; rot: number }
}

/**
 * End centres of a slotted hole, which runs along the pad's longer side; null for a round hole.
 * Works on footprint pads and on world pads, whose width and height already follow the rotation.
 */
export function slotEnds(pad: Pick<WorldPad, "x" | "y" | "width" | "height" | "holeDiameter" | "slotLength" | "slotAxis">): [Vec2, Vec2] | null {
  if (!pad.holeDiameter || !pad.slotLength || pad.slotLength <= pad.holeDiameter + 1e-6) return null
  const half = (pad.slotLength - pad.holeDiameter) / 2
  if (pad.slotAxis !== undefined) {
    const a = (pad.slotAxis * Math.PI) / 180
    const dx = Math.cos(a) * half
    const dy = Math.sin(a) * half
    return [
      { x: round(pad.x - dx), y: round(pad.y - dy) },
      { x: round(pad.x + dx), y: round(pad.y + dy) },
    ]
  }
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

/** A stadium (a pill) as a polygon: the rectangle `width` by `height` with the ends rounded, flattened to 0.0002 mm. */
function pillPolygon(width: number, height: number): Vec2[] {
  const r = Math.min(width, height) / 2
  const half = (Math.max(width, height) - 2 * r) / 2
  const horizontal = width >= height
  const steps = Math.max(4, Math.ceil(Math.PI / (2 * Math.acos(Math.max(0, 1 - 0.0002 / Math.max(r, 0.0002))))))
  const pts: Vec2[] = []
  for (const end of [1, -1]) {
    for (let i = 0; i <= steps; i++) {
      // Each cap is a half circle: the +x or +y one first, then the other, so the ring runs one way round.
      const a = (horizontal ? -Math.PI / 2 : 0) + (end === 1 ? 0 : Math.PI) + (i / steps) * Math.PI
      pts.push(horizontal ? { x: end * half + r * Math.cos(a), y: r * Math.sin(a) } : { x: r * Math.cos(a), y: end * half + r * Math.sin(a) })
    }
  }
  return pts
}

/** Pads in board coordinates, with bottom-side parts mirrored across their local Y axis. A part turned by other than a quarter turn has its rectangular and pill pads as polygons (their exact outline on the board). */
export function pcbPads(c: ComponentInstance): WorldPad[] {
  const part = findPart(c.partId)
  const fp = componentFootprint(c)
  if (!fp || !part) return []
  const mirror = c.pcb.side === "bottom"
  const quarter = isQuarterTurn(c.pcb.rot)
  const turn = normalizeAngle(c.pcb.rot)
  const swap = quarter && (turn === 90 || turn === 270)
  return fp.pads.map((pad) => {
    const center = transformPoint(pad, c.pcb, c.pcb.rot, mirror)
    const smdLayer: CopperLayer = c.pcb.side
    const layers: CopperLayer[] = pad.layer === "through" ? ["top", "bottom"] : [smdLayer]
    const padNumber = pad.pin
    const pin = pad.pin ? (part.padAlias?.[pad.pin] ?? pad.pin) : null
    const slot = pad.slotLength ? { slotLength: pad.slotLength } : {}
    const plated = { ...(pad.plated === false ? { plated: false as const } : {}), ...(pad.axisSpokes ? { axisSpokes: true as const } : {}) }
    if (quarter) {
      return {
        componentId: c.id,
        padNumber,
        pin,
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
        ...slot,
        layers,
        ...plated,
      }
    }
    const base = { componentId: c.id, padNumber, pin, holeDiameter: pad.holeDiameter, layers, ...plated }
    // Any other angle: the outline on the board is a turned rectangle or stadium, held as its corners.
    let ring: Vec2[] | null = null
    if (pad.shape === "polygon" && pad.points) ring = pad.points.map((p) => transformPoint(p, c.pcb, c.pcb.rot, mirror))
    else if (pad.shape === "rect") {
      const hw = pad.width / 2
      const hh = pad.height / 2
      ring = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => transformPoint({ x: pad.x + dx, y: pad.y + dy }, c.pcb, c.pcb.rot, mirror))
    } else if (pad.shape === "pill") ring = pillPolygon(pad.width, pad.height).map((q) => transformPoint({ x: pad.x + q.x, y: pad.y + q.y }, c.pcb, c.pcb.rot, mirror))
    const axis = pad.slotLength ? ((turn + (pad.width >= pad.height ? 0 : 90)) % 180) : undefined
    if (!ring) return { ...base, shape: pad.shape, x: round(center.x), y: round(center.y), width: pad.width, height: pad.height, ...slot, ...(axis !== undefined ? { slotAxis: round(axis, 6) } : {}) }
    const xs = ring.map((q) => q.x)
    const ys = ring.map((q) => q.y)
    return {
      ...base,
      shape: "polygon" as const,
      x: round(center.x),
      y: round(center.y),
      width: round(Math.max(...xs) - Math.min(...xs)),
      height: round(Math.max(...ys) - Math.min(...ys)),
      points: ring.map((q) => ({ x: round(q.x), y: round(q.y) })),
      ...slot,
      ...(axis !== undefined ? { slotAxis: round(axis, 6) } : {}),
      ...(pad.shape === "rect" || pad.shape === "pill" ? { oriented: { width: pad.width, height: pad.height, rot: round(turn % 180, 6) } } : {}),
    }
  })
}

export function pcbSilk(c: ComponentInstance): Vec2[][] {
  const fp = componentFootprint(c)
  if (!fp) return []
  const mirror = c.pcb.side === "bottom"
  return fp.silk.map((path) => path.map((p) => transformPoint(p, c.pcb, c.pcb.rot, mirror)))
}

// A component is replaced, never edited, so its drawings on the board stay put for as long as the object (and its land) does.
const shapeCache = new WeakMap<ComponentInstance, { fp: FootprintDef; count: number; shapes: BoardShape[] }>()

/**
 * The drawings of a component's land on the board, with a bottom-side part's mirrored and their
 * layers swapped (`F.SilkS` of a bottom part is on `B.SilkS`, and on a board of `copperCount` layers an inner layer is its mirror in the stack). Cached per component object: treat the result as read-only.
 */
export function pcbShapes(c: ComponentInstance, copperCount: number): BoardShape[] {
  const fp = componentFootprint(c)
  if (!fp?.shapes?.length) return []
  const hit = shapeCache.get(c)
  if (hit && hit.fp === fp && hit.count === copperCount) return hit.shapes
  const mirror = c.pcb.side === "bottom"
  const f = (p: Vec2) => transformPoint(p, c.pcb, c.pcb.rot, mirror)
  const shapes = fp.shapes.map((s) => {
    const m = mapShape(s, f)
    return mirror ? { ...m, layer: flipShapeLayer(m.layer, copperCount) } : m
  })
  shapeCache.set(c, { fp, count: copperCount, shapes })
  return shapes
}

/** Whether the part's land has a courtyard of its own: a logo or a drawing has none, and the checks that need one leave it out. */
export function hasCourtyard(c: ComponentInstance): boolean {
  const fp = componentFootprint(c)
  return !!fp && !fp.noCourtyard
}

/** The courtyard's corners on the board, in order: the box of the land turned and mirrored as the part is. Null for a part with no land. */
export function pcbCourtyardRing(c: ComponentInstance): Vec2[] | null {
  const fp = componentFootprint(c)
  if (!fp) return null
  const b = fp.courtyard
  const mirror = c.pcb.side === "bottom"
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ].map((q) => transformPoint(q, c.pcb, c.pcb.rot, mirror))
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
