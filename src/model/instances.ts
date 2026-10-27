import { isQuarterTurn, normalizeAngle, orientBox, orientPoint, rotate90, round, transformBox, transformPoint, type Box } from "../lib/geometry"
import { getFootprint } from "./footprints"
import { boardSides, nonPlatedCopper, padFaces } from "./padFaces"
import { padLocalRings } from "./padGeom"
import { findPart } from "./library"
import { flipShapeLayer } from "./shapeLayers"
import { mapShape } from "./shapes"
import { flipLayer, padInnerLayers } from "./stack"
import { symbolOf, unitCount } from "./symbolDrawing"
import type {
  BoardShape,
  ComponentInstance,
  CopperLayer,
  FootprintDef,
  PadDef,
  PadProperty,
  PartDef,
  PinType,
  Rotation,
  SymbolPort,
  Vec2,
  ZoneConnect,
} from "./types"

export interface WorldPin {
  componentId: string
  pin: string
  name: string
  pos: Vec2
  dir: SymbolPort["dir"]
  /** KiCad's electrical type for a pin of an imported symbol, with the alternate chosen on this symbol applied. */
  type?: PinType
  /** A pin that is not drawn. */
  hidden?: true
  /** Which of the pins of this number it is, from 0: the second pin of a number is drawn as a pin of its own. */
  slot?: number
}

const DIRS: SymbolPort["dir"][] = ["right", "up", "left", "down"]

export function rotateDir(dir: SymbolPort["dir"], rot: Rotation): SymbolPort["dir"] {
  return DIRS[(DIRS.indexOf(dir) + rot / 90) % 4]
}

/** The way a pin points once the symbol is turned and then mirrored. */
export function orientDir(dir: SymbolPort["dir"], sch: { rot: Rotation; mirror?: ComponentInstance["sch"]["mirror"] }): SymbolPort["dir"] {
  const d = rotateDir(dir, sch.rot)
  if (sch.mirror === "x") return d === "up" ? "down" : d === "down" ? "up" : d
  if (sch.mirror === "y") return d === "left" ? "right" : d === "right" ? "left" : d
  return d
}

export const dirVector = (dir: SymbolPort["dir"]): Vec2 =>
  dir === "right" ? { x: 1, y: 0 } : dir === "left" ? { x: -1, y: 0 } : dir === "up" ? { x: 0, y: 1 } : { x: 0, y: -1 }

// A component is replaced, never edited, so its pins stay put for as long as the object does.
const pinCache = new WeakMap<ComponentInstance, { part: PartDef; pins: WorldPin[] }>()

/** The symbol a component is drawn as: its unit's and body style's, turned and mirrored as the component is. */
export function placedSymbol(c: ComponentInstance, part = findPart(c.partId)) {
  return part ? symbolOf(part, c) : undefined
}

/** Where a component's pins are on the sheet. Cached per component object: treat the result as read-only. */
export function schematicPins(c: ComponentInstance, part = findPart(c.partId)): WorldPin[] {
  if (!part) return []
  const hit = pinCache.get(c)
  if (hit && hit.part === part) return hit.pins
  const names = new Map(part.pins.map((p) => [p.number, p.name]))
  const defs = part.pins.some((p) => p.alternates?.length) ? new Map(part.pins.map((p) => [p.number, p])) : null
  const seen = new Map<string, number>()
  const pins = symbolOf(part, c).ports.map((port) => {
    const pos = orientPoint(port, c.sch.rot, c.sch.mirror)
    const slot = seen.get(port.pin) ?? 0
    seen.set(port.pin, slot + 1)
    let name = names.get(port.pin) ?? port.pin
    let type = port.type
    // A pin switched to another function has that function's name and type.
    const alt = c.pinAlt?.[port.pin]
    if (alt && defs) {
      const f = defs.get(port.pin)?.alternates?.find((a) => a.name === alt)
      if (f) {
        name = f.name
        type = f.type
      }
    }
    return {
      componentId: c.id,
      pin: port.pin,
      name,
      pos: { x: round(c.sch.x + pos.x), y: round(c.sch.y + pos.y) },
      dir: orientDir(port.dir, c.sch),
      ...(type ? { type } : {}),
      ...(port.hidden ? { hidden: true as const } : {}),
      ...(slot ? { slot } : {}),
    }
  })
  pinCache.set(c, { part, pins })
  return pins
}

/**
 * S7: what a do-not-populate cross covers, and what a mark for a part left out of simulation is drawn
 * around: the symbol's body, turned and mirrored as it is, widened by KiCad's margins (`SCH_PAINTER::draw`
 * of a symbol, sch_painter.cpp): the longest the pins reach beyond the body, 60% of it, at least 30% of the
 * other way's.
 */
export function bodyBox(c: ComponentInstance, part = findPart(c.partId)): Box | null {
  if (!part) return null
  const symbol = symbolOf(part, c)
  return orientBox(symbol.bodyBounds ?? symbol.bounds, c.sch, c.sch.rot, c.sch.mirror)
}

export function flagMarkBox(c: ComponentInstance, part = findPart(c.partId)): Box | null {
  if (!part) return null
  const symbol = symbolOf(part, c)
  const body = symbol.bodyBounds ?? symbol.bounds
  const all = symbol.bounds
  let mx = Math.max(body.minX - all.minX, all.maxX - body.maxX)
  let my = Math.max(body.minY - all.minY, all.maxY - body.maxY)
  mx = Math.max(mx * 0.6, my * 0.3)
  my = Math.max(my * 0.6, mx * 0.3)
  return orientBox({ minX: body.minX - mx, minY: body.minY - my, maxX: body.maxX + mx, maxY: body.maxY + my }, c.sch, c.sch.rot, c.sch.mirror)
}

export function schematicBounds(c: ComponentInstance, part = findPart(c.partId)): Box {
  if (!part) return { minX: c.sch.x - 0.2, minY: c.sch.y - 0.2, maxX: c.sch.x + 0.2, maxY: c.sch.y + 0.2 }
  return orientBox(symbolOf(part, c).bounds, c.sch, c.sch.rot, c.sch.mirror)
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
  oriented?: { width: number; height: number; rot: number; corner?: number }
  // ---------- X7: present only for a pad that has them; a pad without is what it always was ----------
  /** A rectangle with rounded corners: the radius, mm. The rectangle is level (a turned one is a polygon, with `oriented.corner`). */
  corner?: number
  /** The rings of a polygon pad that has more than one (a custom pad with a hole in it, or in pieces), every ring counted even-odd; `points` is the first. */
  rings?: Vec2[][]
  /** Where the hole is when it is not the pad's centre. */
  hole?: Vec2
  /** The sides of the board the pad has its solder mask opening and its paste on, where they are not its copper's (`layers` is the copper). */
  mask?: CopperLayer[]
  paste?: CopperLayer[]
  /** The sides the pad is plotted on the silkscreen on. */
  silk?: CopperLayer[]
  /** A non-plated hole that has copper round it: the sides it has it on (its `layers` stay both, for it is an obstacle on both). */
  ring?: CopperLayer[]
  /** A non-plated hole's own pad, when it is larger than the hole or another shape: the opening it has in the solder mask. The pad's own fields are then the hole's, which is what copper keeps its clearance from. */
  opening?: PadOutline
  /** The pad's own margins, clearance and pour connection (see `PadDef`). */
  maskMargin?: number
  pasteMargin?: number
  pasteRatio?: number
  clearance?: number
  zoneConnect?: ZoneConnect
  thermalGap?: number
  thermalWidth?: number
  thermalAngle?: number
  property?: PadProperty
  /** A custom pad's pour clearance follows its convex hull. */
  hull?: true
  /** X1: what becomes of the pad's copper on a layer nothing connects to on it (see `PadDef.unused`). Absent keeps every layer. */
  unused?: "remove" | "keepEnds"
  /** X31: the copper layers a pour joins the pad on when its unused layers are removed, as the board's layers (see `PadDef.zoneLayers`). */
  zoneLayers?: CopperLayer[]
  /** X5: the pad's own tenting of the mask on the board's front and back, where it says (see `PadDef.tent`). */
  tented?: { front?: boolean; back?: boolean }
  /**
   * X1, a pad stack: the pad as a layer has it, where that is not the pad's own outline (`PadDef.stack`), by the board's layer ids. `layers` of the
   * pad lists these layers too; each entry is a whole pad of that one layer (its `layers` is `[layer]`).
   */
  variants?: Partial<Record<CopperLayer, WorldPad>>
  /** The pad of the land this is and where its part put it, for what needs the pad exactly as KiCad has it (the plot's openings, the KiCad file): a pad with X7 features only. */
  x7?: { def: PadDef; origin: Vec2; rot: number; mirror: boolean }
}

/**
 * End centres of a slotted hole, which runs along the pad's longer side; null for a round hole.
 * Works on footprint pads and on world pads, whose width and height already follow the rotation.
 */
export function slotEnds(pad: Pick<WorldPad, "x" | "y" | "width" | "height" | "holeDiameter" | "slotLength" | "slotAxis" | "hole">): [Vec2, Vec2] | null {
  if (!pad.holeDiameter || !pad.slotLength || pad.slotLength <= pad.holeDiameter + 1e-6) return null
  const half = (pad.slotLength - pad.holeDiameter) / 2
  // The hole is at the pad's centre unless the pad says where it is (X7: a hole off the copper's centre).
  const c = pad.hole ?? pad
  if (pad.slotAxis !== undefined) {
    const a = (pad.slotAxis * Math.PI) / 180
    const dx = Math.cos(a) * half
    const dy = Math.sin(a) * half
    return [
      { x: round(c.x - dx), y: round(c.y - dy) },
      { x: round(c.x + dx), y: round(c.y + dy) },
    ]
  }
  return pad.width >= pad.height
    ? [
        { x: round(c.x - half), y: c.y },
        { x: round(c.x + half), y: c.y },
      ]
    : [
        { x: c.x, y: round(c.y - half) },
        { x: c.x, y: round(c.y + half) },
      ]
}

/** The sides of the board a pad has its solder mask opening on: its copper's unless it says (X7). */
export const maskSides = (pad: Pick<WorldPad, "mask" | "layers">): CopperLayer[] => pad.mask ?? pad.layers

/** The sides a pad has paste on: its copper's, and none for a pad with a hole, unless it says (X7). */
export const pasteSides = (pad: Pick<WorldPad, "paste" | "layers" | "holeDiameter">): CopperLayer[] => pad.paste ?? (pad.holeDiameter !== undefined ? [] : pad.layers)

/** True for a non-plated (NPTH) hole, which has no copper on any layer. */
export const isNpth = (pad: { plated?: false }) => pad.plated === false

/** A part drawn from a KiCad symbol may have several units: symbols that share one designator, each drawing some of the part's pins. */
export const hasUnits = (part: PartDef | undefined): part is PartDef => !!part && (unitCount(part) > 1 || !!part.unitOf)

/** Every symbol of the part a component is a unit of, in sheet order; the component alone for a part with one unit. */
export function unitGroup(project: { components: ComponentInstance[] }, c: ComponentInstance): ComponentInstance[] {
  if (!hasUnits(findPart(c.partId))) return [c]
  return project.components.filter((x) => x.ref === c.ref && hasUnits(findPart(x.partId)))
}

export const isPhysical = (part: PartDef | undefined) => !!part && !part.powerNet && part.footprints.length > 0

/**
 * A part of the schematic that nets, the BOM and the checks count: a part with a footprint, or a symbol
 * drawn from KiCad's that has none yet (a schematic imported without its board). A power port is never
 * one, nor a virtual symbol (`#FLG`). Whatever is on a board is `isPhysical`: the board code keeps asking that.
 */
export const isSchematicPart = (part: PartDef | undefined) => !!part && !part.powerNet && (part.footprints.length > 0 || (!!part.jumpers && part.category !== "Symbols"))

export function componentFootprint(c: ComponentInstance): FootprintDef | null {
  const part = findPart(c.partId)
  if (!isPhysical(part) || !c.footprint || c.flags?.notOnBoard) return null
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

const innerIds = (count: number): CopperLayer[] => Array.from({ length: Math.max(0, count - 2) }, (_, i) => `in${i + 1}` as CopperLayer)

/** Layers in stack order: the front, the inner ones, the back. */
const stackOrder = (layers: Iterable<CopperLayer>, count: number): CopperLayer[] => {
  const have = new Set(layers)
  return (["top", ...innerIds(count), "bottom"] as CopperLayer[]).filter((l) => have.has(l))
}

/**
 * Pads in board coordinates, with bottom-side parts mirrored across their local Y axis. A part turned by other than a quarter turn has its rectangular and pill pads as polygons (their exact outline on the board).
 * `count` is the board's number of copper layers (X1): a through-hole pad has copper on the inner layers of a board that has them, and a pad that names inner layers has them as the board has them. Two, the default, is every board drawn in the editor.
 */
export function pcbPads(c: ComponentInstance, count = 2): WorldPad[] {
  const part = findPart(c.partId)
  const fp = componentFootprint(c)
  if (!fp || !part) return []
  const mirror = c.pcb.side === "bottom"
  const quarter = isQuarterTurn(c.pcb.rot)
  const turn = normalizeAngle(c.pcb.rot)
  const swap = quarter && (turn === 90 || turn === 270)
  return fp.pads.map((pad) => {
    if (isX7Pad(pad)) return x7WorldPad(c, part, pad, mirror, count)
    const center = transformPoint(pad, c.pcb, c.pcb.rot, mirror)
    const smdLayer: CopperLayer = c.pcb.side
    const layers: CopperLayer[] = pad.layer === "through" ? (count > 2 ? ["top", ...innerIds(count), "bottom"] : ["top", "bottom"]) : [smdLayer]
    const padNumber = pad.number !== undefined ? (pad.number === "" ? null : pad.number) : pad.pin
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

/** A non-plated hole whose pad is no larger than the hole itself: a round hole as a circle of its diameter, a slot as a stadium of its length (what the editor has always made of one). */
function isBareHole(pad: PadDef): boolean {
  const d = pad.holeDiameter
  if (pad.plated !== false || d === undefined) return false
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  if (pad.shape === "circle") return !pad.slotLength && near(pad.width, d)
  if (pad.shape === "pill" && pad.slotLength !== undefined) return (near(pad.width, pad.slotLength) && near(pad.height, d)) || (near(pad.height, pad.slotLength) && near(pad.width, d))
  return false
}

/** A pad with something in it beyond a plain pad's place, size, hole and number (the geometry, layers, margins and overrides of X7). */
function isX7Pad(pad: PadDef): boolean {
  // A non-plated hole with a pad round it (copper, or an opening in the mask larger than the hole) is more than the bare hole the old path draws.
  if (pad.plated === false && !isBareHole(pad)) return true
  return (
    pad.rot !== undefined ||
    pad.round !== undefined ||
    pad.chamfer !== undefined ||
    pad.custom !== undefined ||
    pad.holeOffset !== undefined ||
    pad.holeAxis !== undefined ||
    pad.layers !== undefined ||
    pad.maskMargin !== undefined ||
    pad.pasteMargin !== undefined ||
    pad.pasteRatio !== undefined ||
    pad.clearance !== undefined ||
    pad.zoneConnect !== undefined ||
    pad.thermalGap !== undefined ||
    pad.thermalWidth !== undefined ||
    pad.thermalAngle !== undefined ||
    pad.property !== undefined ||
    pad.stack !== undefined ||
    pad.unused !== undefined ||
    pad.zoneLayers !== undefined ||
    pad.tent !== undefined
  )
}

const r6 = (n: number) => round(n, 6)

/** What of a pad is its outline on the board: the shape and where it is. */
export type PadOutline = Pick<WorldPad, "shape" | "x" | "y" | "width" | "height" | "points" | "rings" | "corner" | "oriented">

/**
 * A pad's outline on the board: its shape turned by its own turn and the part's, as KiCad has it. A pad turned by a quarter turn in all
 * stays a level rectangle, which the router and the Gerber draw as flashes; any other turn, a chamfer or a custom shape is a polygon,
 * which every distance, the pour and the plot read as they read any outline.
 */
function placedOutline(c: ComponentInstance, pad: PadDef, mirror: boolean): PadOutline {
  const own = pad.rot ?? 0
  const partRot = c.pcb.rot
  const at = (p: Vec2) => transformPoint(p, c.pcb, partRot, mirror)
  const center = at(pad)
  const out: PadOutline = { shape: pad.shape, x: r6(center.x), y: r6(center.y), width: pad.width, height: pad.height }
  // The turn of the pad's width axis on the board (mod 180: a rectangle, a pill and a circle look the same turned by a half turn).
  const raw = (mirror ? partRot - own : partRot + own) % 180
  const turn = normalizeAngle(((raw % 180) + 180) % 180)
  const level = isQuarterTurn(turn)
  const swap = level && Math.abs(turn - 90) < 1e-9
  const plain = !pad.custom && !pad.chamfer && pad.shape !== "polygon"
  if (pad.shape === "circle" && plain) return out
  if (plain && level) {
    out.width = swap ? pad.height : pad.width
    out.height = swap ? pad.width : pad.height
    if (pad.shape === "rect" && pad.round) out.corner = r6(pad.round * Math.min(pad.width, pad.height))
    return out
  }
  // A polygon: every ring of the pad in the land's frame, then on the board.
  const fixed = pad.shape === "polygon" && !pad.custom
  const rings = padLocalRings(pad).map((ring) =>
    ring.map((p) => {
      const q = fixed ? p : rotate90(p, own)
      const w = at(fixed ? q : { x: pad.x + q.x, y: pad.y + q.y })
      return { x: r6(w.x), y: r6(w.y) }
    }),
  )
  const xs = rings.flatMap((r) => r.map((p) => p.x))
  const ys = rings.flatMap((r) => r.map((p) => p.y))
  out.shape = "polygon"
  out.width = r6(Math.max(...xs) - Math.min(...xs))
  out.height = r6(Math.max(...ys) - Math.min(...ys))
  out.points = rings[0]
  if (rings.length > 1) out.rings = rings
  if (plain) out.oriented = { width: pad.width, height: pad.height, rot: r6(turn), ...(pad.shape === "rect" && pad.round ? { corner: r6(pad.round * Math.min(pad.width, pad.height)) } : {}) }
  return out
}

const GEOMETRY: (keyof PadDef)[] = ["shape", "x", "y", "width", "height", "points", "rot", "round", "chamfer", "custom"]

/** The pad as a layer of its pad stack has it: the pad's, with the layer's shape in place of its own and the layer's pour settings over its own. */
export function padLayerDef(pad: PadDef, v: NonNullable<PadDef["stack"]>["layers"][CopperLayer]): PadDef {
  const out: Record<string, unknown> = { ...pad }
  delete out.stack
  if (v && "shape" in v) for (const k of GEOMETRY) delete out[k]
  return { ...out, ...v } as PadDef
}

/**
 * The layers of a pad stack that have a shape of their own, by the board's layer ids: each as a whole pad of that layer. A layer of the pad is
 * named as seen from the part's own side, so a part on the bottom turns them over.
 */
function padVariants(c: ComponentInstance, pad: PadDef, mirror: boolean, count: number, base: WorldPad): Partial<Record<CopperLayer, WorldPad>> {
  const stack = pad.stack!
  const out: Partial<Record<CopperLayer, WorldPad>> = {}
  const entries: [CopperLayer, NonNullable<typeof stack.layers.inner>][] = []
  for (const [key, v] of Object.entries(stack.layers)) {
    if (!v) continue
    if (key === "inner") for (const l of innerIds(count)) entries.push([l, v])
    else entries.push([key as CopperLayer, v])
  }
  for (const [own, v] of entries) {
    const layer = mirror ? flipLayer(own, count) : own
    if (!base.layers.includes(layer)) continue
    const variant = padLayerDef(pad, v)
    const outline = placedOutline(c, variant, mirror)
    const w: WorldPad = { ...base, ...outline, layers: [layer] }
    delete w.variants
    delete w.rings
    if (outline.rings) w.rings = outline.rings
    if (v.clearance !== undefined) w.clearance = v.clearance
    if (v.zoneConnect !== undefined) w.zoneConnect = v.zoneConnect
    if (v.thermalGap !== undefined) w.thermalGap = v.thermalGap
    if (v.thermalWidth !== undefined) w.thermalWidth = v.thermalWidth
    if (v.thermalAngle !== undefined) w.thermalAngle = v.thermalAngle
    out[layer] = w
  }
  return out
}

/** The pad as `layer` has it: its variant there, else the pad itself. */
export const padOnLayer = (pad: WorldPad, layer: CopperLayer): WorldPad => pad.variants?.[layer] ?? pad

/**
 * A pad that has X7 features, on the board: its outline, its hole where it is (an off-centre one too, at any angle for a slot), its layers
 * and its overrides. A non-plated hole with no copper round it is an obstacle the size of its hole (that is what a clearance is
 * measured from) and has its pad's outline as the opening in the solder mask (`opening`), which may be larger.
 */
function x7WorldPad(c: ComponentInstance, part: PartDef, pad: PadDef, mirror: boolean, count: number): WorldPad {
  const side = c.pcb.side
  const faces = padFaces(pad)
  const own = pad.rot ?? 0
  const partRot = c.pcb.rot
  const at = (p: Vec2) => transformPoint(p, c.pcb, partRot, mirror)
  const padNumber = pad.number !== undefined ? (pad.number === "" ? null : pad.number) : pad.pin
  const pin = pad.pin ? (part.padAlias?.[pad.pin] ?? pad.pin) : null
  const npth = pad.plated === false
  const copper = boardSides(faces.copper, side)
  // Inner copper (X1): what the pad says, else every inner layer of a through-hole pad with copper on both sides; on a board with no inner layer, none.
  const inner = count > 2 ? padInnerLayers(pad, innerIds(count), faces.copper === "both").map((l) => (mirror ? flipLayer(l, count) : l)) : []
  const layers: CopperLayer[] = npth ? stackOrder(["top", "bottom", ...innerIds(count)], count) : inner.length ? stackOrder([...copper, ...inner], count) : copper
  const outline = placedOutline(c, pad, mirror)
  const out: WorldPad = { componentId: c.id, padNumber, pin, ...outline, layers, x7: { def: pad, origin: { x: c.pcb.x, y: c.pcb.y }, rot: partRot, mirror } }
  if (npth && copper.length && nonPlatedCopper(pad)) out.ring = copper
  if (pad.layers) {
    out.mask = boardSides(faces.mask, side)
    out.paste = boardSides(faces.paste, side)
    if (faces.silk !== "none") out.silk = boardSides(faces.silk, side)
  }
  if (pad.stack && !npth) {
    const variants = padVariants(c, pad, mirror, count, out)
    if (Object.keys(variants).length) out.variants = variants
  }
  if (pad.maskMargin !== undefined) out.maskMargin = pad.maskMargin
  if (pad.pasteMargin !== undefined) out.pasteMargin = pad.pasteMargin
  if (pad.pasteRatio !== undefined) out.pasteRatio = pad.pasteRatio
  if (pad.clearance !== undefined) out.clearance = pad.clearance
  if (pad.zoneConnect !== undefined) out.zoneConnect = pad.zoneConnect
  if (pad.thermalGap !== undefined) out.thermalGap = pad.thermalGap
  if (pad.thermalWidth !== undefined) out.thermalWidth = pad.thermalWidth
  if (pad.thermalAngle !== undefined) out.thermalAngle = pad.thermalAngle
  if (pad.property !== undefined) out.property = pad.property
  if (pad.unused !== undefined) out.unused = pad.unused
  if (pad.zoneLayers !== undefined) out.zoneLayers = pad.zoneLayers.map((l) => (mirror ? flipLayer(l, count) : l))
  if (pad.tent) {
    // Sides of the pad's own part: `top` is its own side, which is the board's back for a part on the bottom.
    const front = mirror ? pad.tent.bottom : pad.tent.top
    const back = mirror ? pad.tent.top : pad.tent.bottom
    out.tented = { ...(front !== undefined ? { front } : {}), ...(back !== undefined ? { back } : {}) }
  }
  if (pad.custom?.hull) out.hull = true
  if (pad.holeDiameter !== undefined) {
    out.holeDiameter = pad.holeDiameter
    // The hole, in the land's frame: from the copper's centre by the offset, turned with the pad.
    const offset = pad.holeOffset && (pad.holeOffset.x !== 0 || pad.holeOffset.y !== 0) ? rotate90(pad.holeOffset, own) : null
    const holeLand = offset ? { x: pad.x + offset.x, y: pad.y + offset.y } : { x: pad.x, y: pad.y }
    if (offset) {
      const h = at(holeLand)
      out.hole = { x: r6(h.x), y: r6(h.y) }
    }
    let axis = 0
    if (pad.slotLength) {
      out.slotLength = pad.slotLength
      // The slot's axis in the pad's frame, turned with the pad, then mirrored and turned with the part.
      const a = (pad.holeAxis ?? (pad.width >= pad.height ? 0 : 90)) + own
      axis = r6((((mirror ? 180 - a + partRot : a + partRot) % 180) + 180) % 180)
      out.slotAxis = axis
    }
    if (npth && !out.ring) {
      const slot = pad.slotLength && pad.slotLength > pad.holeDiameter + 1e-9
      const hole: PadDef = { pin: null, shape: slot ? "pill" : "circle", x: holeLand.x, y: holeLand.y, width: slot ? pad.slotLength! : pad.holeDiameter, height: slot ? pad.holeDiameter : pad.holeDiameter, layer: "through", plated: false }
      if (slot) {
        const a = (pad.holeAxis ?? (pad.width >= pad.height ? 0 : 90)) + own
        if (a % 360 !== 0) hole.rot = a
      }
      const h = placedOutline(c, hole, mirror)
      // The opening in the mask is the pad, which differs from the hole when it is larger or not the same shape.
      const same = pad.shape === hole.shape && Math.abs(pad.width - hole.width) < 1e-9 && Math.abs(pad.height - hole.height) < 1e-9 && !pad.custom && !pad.chamfer && !pad.round
      Object.assign(out, h)
      delete out.hole
      if (!same || offset) out.opening = outline
    }
  }
  if (npth) out.plated = false
  return out
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

/**
 * The net a power port names. A power symbol from KiCad whose Value is empty names nothing (S2), where the
 * editor's own port falls back to its part's net.
 */
export const powerNetName = (c: ComponentInstance, part = findPart(c.partId)) =>
  part?.powerNet ? (c.props.net?.trim() || (part.jumpers && c.props.net !== undefined ? "" : part.powerNet)) : null

/** Unit direction a pin leaves its symbol, for wire stubs. */
export function pinStubPoint(pin: WorldPin, length = 0.2): Vec2 {
  const d = dirVector(pin.dir)
  return { x: round(pin.pos.x + d.x * length), y: round(pin.pos.y + d.y * length) }
}

// ---------- units of one part ----------

const ownerCache = new WeakMap<ComponentInstance[], Map<string, string>>()

/**
 * A part with several units is placed as several symbols that share a reference. One of them is the
 * part: it has the footprint, is on the board and is the one the BOM counts. The others are
 * placements of their part's `@sub` twin (`unitOf` names the part), which has no footprint. This
 * maps each of those to the component that is the part, the first with their reference that is not
 * a twin, so their pins are the part's pins; a unit with no part to belong to is not in the map.
 * Units go by reference and by the symbol they are drawn from: of the parts that share a reference
 * (a duplicated designator is an error KiCad lets through), a unit belongs to the one drawn from its
 * part's symbol that has not got that unit yet. Only when none is drawn from the same symbol does it
 * go to the first with the reference (KiCad keeps a copy of a symbol for each unit of some old
 * schematics, and they are one part all the same).
 */
export function unitOwners(components: ComponentInstance[]): Map<string, string> {
  let hit = ownerCache.get(components)
  if (hit) return hit
  hit = new Map()
  let primaries: Map<string, ComponentInstance[]> | null = null
  /** The units each part already has: its own, and those given to it. */
  const taken = new Map<string, Set<number>>()
  for (const c of components) {
    const twin = findPart(c.partId)
    if (!twin?.unitOf) continue
    if (!primaries) {
      primaries = new Map()
      for (const x of components) {
        if (findPart(x.partId)?.unitOf) continue
        primaries.set(x.ref, [...(primaries.get(x.ref) ?? []), x])
        taken.set(x.id, new Set([x.unit ?? 1]))
      }
    }
    const list = primaries.get(c.ref) ?? []
    const unit = c.unit ?? 1
    const same = list.filter((x) => x.partId === twin.unitOf)
    const owner = same.find((x) => !taken.get(x.id)!.has(unit)) ?? same[0] ?? list[0]
    if (!owner) continue
    taken.get(owner.id)!.add(unit)
    hit.set(c.id, owner.id)
  }
  ownerCache.set(components, hit)
  return hit
}

/** The id of the component that is the part this component is a unit of: itself unless it is another unit. */
export const unitOwner = (components: ComponentInstance[], id: string) => unitOwners(components).get(id) ?? id
