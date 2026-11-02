import { isShapeLayer } from "./shapeLayers"
import { isCompactShapes, packShapes, unpackShapes } from "./shapeCodec"
import { normalizeShape } from "./shapes"
import { isCopperLayerId } from "./stack"
import { readBackdrill, readPost } from "./viaCodec"
import type { BoardShape, CopperLayer, PadDef, PadLayers, PadLayerShape, PadSides, PadStack, Vec2 } from "./types"
import { isObject } from "../lib/guards"

// How a land's pads are stored and read back (X7). A pad that has none of X7's fields is stored as it always was, one object with its
// place, size, shape and hole: the same bytes as before the pad model grew, so the shipped examples and every project drawn here are
// untouched. The fields that X7 adds are optional objects and numbers, written only where they are set; the one bulky one, a custom pad's
// drawings, is written in the compact form of a land's drawings (`shapeCodec.ts`: grouped by style, a letter and a run of numbers each) as
// `custom.g` and, for the pad's proxy items, `custom.p`. Reading gives back exactly what was written.

const finite = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x))
const isPoint = (p: unknown): p is Vec2 => isObject(p) && finite(p.x, p.y)
const SIDES = new Set<string>(["top", "bottom", "both", "none"])
const ZONE = new Set<string>(["none", "thermal", "solid", "tht"])
const PROPS = new Set<string>(["bga", "fiducial_glob", "fiducial_loc", "testpoint", "castellated", "heatsink", "mechanical", "pressfit"])
const SHAPES = new Set(["rect", "circle", "pill", "polygon"])
const X7_KEYS = ["number", "rot", "round", "chamfer", "custom", "holeOffset", "holeAxis", "layers", "maskMargin", "pasteMargin", "pasteRatio", "clearance", "zoneConnect", "thermalGap", "thermalWidth", "thermalAngle", "property", "stack", "zoneLayers", "backdrill", "tertiary", "post", "dieLength", "dieDelay", "connector"] as const

function packCustom(custom: NonNullable<PadDef["custom"]>): unknown {
  const { shapes, proxy, ...rest } = custom
  return { ...rest, g: packShapes(shapes), ...(proxy?.length ? { p: packShapes(proxy) } : {}) }
}

/** A pad as it is stored: its custom drawings compact, and those of its pad stack's layers too. */
export function packPad(pad: PadDef): unknown {
  const stack = pad.stack && Object.values(pad.stack.layers).some((v) => v?.custom) ? { ...pad.stack, layers: Object.fromEntries(Object.entries(pad.stack.layers).map(([k, v]) => [k, v?.custom ? { ...v, custom: packCustom(v.custom) } : v])) } : pad.stack
  if (!pad.custom && stack === pad.stack) return pad
  return { ...pad, ...(pad.custom ? { custom: packCustom(pad.custom) } : {}), ...(stack ? { stack } : {}) }
}

/** Whether a land has a pad that is stored differently from the plain one. */
export const needsPadPacking = (pads: PadDef[]) => pads.some((p) => p.custom || (p.stack && Object.values(p.stack.layers).some((v) => v?.custom)))

function readShapes(raw: unknown, compact: unknown): BoardShape[] | null {
  if (compact !== undefined) {
    if (!isCompactShapes(compact)) return null
    return unpackShapes(compact)
  }
  if (!Array.isArray(raw)) return []
  const out: BoardShape[] = []
  for (const item of raw) {
    const s = normalizeShape(item, isShapeLayer)
    if (!s) return null
    out.push(s)
  }
  return out
}

function readLayers(raw: unknown): PadLayers | null | undefined {
  if (raw === undefined) return undefined
  if (!isObject(raw)) return null
  const out: PadLayers = {}
  for (const k of ["copper", "mask", "paste", "silk"] as const) {
    const v = raw[k]
    if (v === undefined) continue
    if (typeof v !== "string" || !SIDES.has(v)) return null
    out[k] = v as PadSides
  }
  if (raw.inner !== undefined) {
    if (!Array.isArray(raw.inner) || !raw.inner.every(isCopperLayerId) || raw.inner.includes("top") || raw.inner.includes("bottom") || new Set(raw.inner).size !== raw.inner.length) return null
    out.inner = raw.inner as CopperLayer[]
  }
  if (raw.other !== undefined) {
    if (!Array.isArray(raw.other) || !raw.other.every((n) => typeof n === "string" && n.length > 0 && n.length < 64)) return null
    if (raw.other.length) out.other = raw.other as string[]
  }
  return out
}

/**
 * A stored pad, as the editor reads it, or null when it is malformed (the land it is in is then dropped whole, since a missing pad is a
 * board that cannot be built). A pad with none of X7's fields is returned as it is.
 */
export function normalizePad(raw: unknown): PadDef | null {
  if (!isObject(raw)) return null
  if (!(raw.pin === null || typeof raw.pin === "string")) return null
  if (!SHAPES.has(raw.shape as string)) return null
  if (raw.layer !== "top" && raw.layer !== "through") return null
  if (!finite(raw.x, raw.y, raw.width, raw.height)) return null
  if (raw.points !== undefined && !(Array.isArray(raw.points) && raw.points.every(isPoint))) return null
  if (raw.holeDiameter !== undefined && !finite(raw.holeDiameter)) return null
  if (raw.slotLength !== undefined && !finite(raw.slotLength)) return null
  if (!X7_KEYS.some((k) => raw[k] !== undefined)) return raw as unknown as PadDef
  const out = { ...raw } as Record<string, unknown>
  if (raw.number !== undefined && typeof raw.number !== "string") return null
  for (const k of ["rot", "holeAxis", "maskMargin", "pasteMargin", "pasteRatio", "clearance", "thermalGap", "thermalWidth", "thermalAngle"] as const) if (raw[k] !== undefined && !finite(raw[k])) return null
  if (raw.round !== undefined && !(finite(raw.round) && (raw.round as number) >= 0 && (raw.round as number) <= 0.5)) return null
  if (raw.chamfer !== undefined) {
    const c = raw.chamfer
    if (!isObject(c) || !finite(c.ratio, c.corners) || !Number.isInteger(c.corners) || (c.corners as number) < 0 || (c.corners as number) > 15 || (c.ratio as number) < 0) return null
  }
  if (raw.holeOffset !== undefined && !isPoint(raw.holeOffset)) return null
  // X22 and X21: a backdrill needs layers of the pad's stack, a post-machining its mode; a length or delay is a number above zero.
  for (const k of ["dieLength", "dieDelay"] as const) if (raw[k] !== undefined && !(finite(raw[k]) && (raw[k] as number) > 0)) return null
  for (const k of ["backdrill", "tertiary"] as const) {
    const b = readBackdrill(raw[k])
    if (b === null) return null
    if (b) out[k] = b
  }
  const post = readPost(raw.post)
  if (post === null) return null
  if (post) out.post = post
  if (raw.zoneConnect !== undefined && !(typeof raw.zoneConnect === "string" && ZONE.has(raw.zoneConnect))) return null
  if (raw.connector !== undefined && raw.connector !== true) return null
  if (raw.property !== undefined && !(typeof raw.property === "string" && PROPS.has(raw.property))) return null
  // X31: a list of copper layers, each once; the empty list is a setting too.
  if (raw.zoneLayers !== undefined && !(Array.isArray(raw.zoneLayers) && raw.zoneLayers.every(isCopperLayerId) && new Set(raw.zoneLayers).size === raw.zoneLayers.length)) return null
  const layers = readLayers(raw.layers)
  if (layers === null) return null
  if (layers) out.layers = layers
  if (raw.custom !== undefined) {
    const custom = readCustom(raw.custom)
    if (!custom) return null
    out.custom = custom
  }
  if (raw.stack !== undefined) {
    const stack = readStack(raw.stack)
    if (!stack) return null
    out.stack = stack
  }
  return out as unknown as PadDef
}

function readCustom(c: unknown): PadDef["custom"] | null {
  if (!isObject(c) || (c.anchor !== "circle" && c.anchor !== "rect")) return null
  const shapes = readShapes(c.shapes, c.g)
  const proxy = readShapes(c.proxy, c.p)
  if (!shapes || !proxy) return null
  const { g: _g, p: _p, shapes: _s, proxy: _x, ...rest } = c
  const out = { ...rest, anchor: c.anchor, shapes, ...(proxy.length ? { proxy } : {}), ...(c.hull === true ? { hull: true } : {}) } as NonNullable<PadDef["custom"]>
  if (c.hull !== true) delete (out as unknown as Record<string, unknown>).hull
  return out
}

const LAYER_SHAPE_NUMBERS = ["x", "y", "width", "height", "rot", "clearance", "thermalGap", "thermalWidth", "thermalAngle"] as const

/** One layer of a pad stack: its shape and size, and its pour settings, each read as a pad's own are. Null when any does not read. */
function readLayerShape(raw: unknown): PadLayerShape | null {
  if (!isObject(raw)) return null
  const out: Record<string, unknown> = {}
  if (raw.shape !== undefined) {
    if (!(typeof raw.shape === "string" && SHAPES.has(raw.shape))) return null
    out.shape = raw.shape
  }
  for (const k of LAYER_SHAPE_NUMBERS) {
    if (raw[k] === undefined) continue
    if (!finite(raw[k])) return null
    out[k] = raw[k]
  }
  if (raw.points !== undefined) {
    if (!(Array.isArray(raw.points) && raw.points.every(isPoint))) return null
    out.points = raw.points
  }
  if (raw.round !== undefined) {
    if (!(finite(raw.round) && (raw.round as number) >= 0 && (raw.round as number) <= 0.5)) return null
    out.round = raw.round
  }
  if (raw.chamfer !== undefined) {
    const c = raw.chamfer
    if (!isObject(c) || !finite(c.ratio, c.corners) || !Number.isInteger(c.corners) || (c.corners as number) < 0 || (c.corners as number) > 15 || (c.ratio as number) < 0) return null
    out.chamfer = c
  }
  if (raw.zoneConnect !== undefined) {
    if (!(typeof raw.zoneConnect === "string" && ZONE.has(raw.zoneConnect))) return null
    out.zoneConnect = raw.zoneConnect
  }
  if (raw.custom !== undefined) {
    const custom = readCustom(raw.custom)
    if (!custom) return null
    out.custom = custom
  }
  return out as PadLayerShape
}

/** A pad stack as stored; null when it does not read (the land is then dropped, as for any malformed pad). */
function readStack(raw: unknown): PadStack | null {
  if (!isObject(raw) || (raw.mode !== "front_inner_back" && raw.mode !== "custom") || !isObject(raw.layers)) return null
  const layers: Record<string, PadLayerShape> = {}
  for (const [k, v] of Object.entries(raw.layers)) {
    if (k !== "inner" && !isCopperLayerId(k)) return null
    if (k === "top") return null
    if (k === "inner" && raw.mode !== "front_inner_back") return null
    const shape = readLayerShape(v)
    if (!shape) return null
    layers[k] = shape
  }
  return { mode: raw.mode, layers: layers as PadStack["layers"] }
}

