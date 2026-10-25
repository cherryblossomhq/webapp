import { isShapeLayer } from "./shapeLayers"
import { isCompactShapes, packShapes, unpackShapes } from "./shapeCodec"
import { normalizeShape } from "./shapes"
import type { BoardShape, PadDef, PadLayers, PadSides, Vec2 } from "./types"

// How a land's pads are stored and read back (X7). A pad that has none of X7's fields is stored as it always was, one object with its
// place, size, shape and hole: the same bytes as before the pad model grew, so the shipped examples and every project drawn here are
// untouched. The fields that X7 adds are optional objects and numbers, written only where they are set; the one bulky one, a custom pad's
// drawings, is written in the compact form of a land's drawings (`shapeCodec.ts`: grouped by style, a letter and a run of numbers each) as
// `custom.g` and, for the pad's proxy items, `custom.p`. Reading gives back exactly what was written.

const finite = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isPoint = (p: unknown): p is Vec2 => isObject(p) && finite(p.x, p.y)
const SIDES = new Set<string>(["top", "bottom", "both", "none"])
const ZONE = new Set<string>(["none", "thermal", "solid", "tht"])
const PROPS = new Set<string>(["bga", "fiducial_glob", "fiducial_loc", "testpoint", "castellated", "heatsink", "mechanical", "pressfit"])
const SHAPES = new Set(["rect", "circle", "pill", "polygon"])
const X7_KEYS = ["number", "rot", "round", "chamfer", "custom", "holeOffset", "holeAxis", "layers", "maskMargin", "pasteMargin", "pasteRatio", "clearance", "zoneConnect", "thermalGap", "thermalWidth", "thermalAngle", "property"] as const

/** A pad as it is stored: its custom drawings compact. */
export function packPad(pad: PadDef): unknown {
  if (!pad.custom) return pad
  const { shapes, proxy, ...rest } = pad.custom
  return { ...pad, custom: { ...rest, g: packShapes(shapes), ...(proxy?.length ? { p: packShapes(proxy) } : {}) } }
}

/** Whether a land has a pad that is stored differently from the plain one. */
export const needsPadPacking = (pads: PadDef[]) => pads.some((p) => p.custom)

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
  if (raw.zoneConnect !== undefined && !(typeof raw.zoneConnect === "string" && ZONE.has(raw.zoneConnect))) return null
  if (raw.property !== undefined && !(typeof raw.property === "string" && PROPS.has(raw.property))) return null
  const layers = readLayers(raw.layers)
  if (layers === null) return null
  if (layers) out.layers = layers
  if (raw.custom !== undefined) {
    const c = raw.custom
    if (!isObject(c) || (c.anchor !== "circle" && c.anchor !== "rect")) return null
    const shapes = readShapes(c.shapes, c.g)
    const proxy = readShapes(c.proxy, c.p)
    if (!shapes || !proxy) return null
    const { g: _g, p: _p, shapes: _s, proxy: _x, ...rest } = c
    out.custom = { ...rest, anchor: c.anchor, shapes, ...(proxy.length ? { proxy } : {}), ...(c.hull === true ? { hull: true } : {}) }
    if (c.hull !== true) delete (out.custom as Record<string, unknown>).hull
  }
  return out as unknown as PadDef
}

