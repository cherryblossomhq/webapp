import { normalizeAngle, rotate90, round } from "../../../lib/geometry"
import { defaultFaces } from "../../padFaces"
import { flipShapeLayer } from "../../shapeLayers"
import { DEFAULT_SHAPE_WIDTH, isClosedShape, mapShape } from "../../shapes"
import { flipLayer } from "../../stack"
import type { BoardShape, CopperLayer, PadDef, PadLayerShape, PadLayers, PadProperty, PadSides, Vec2, ZoneConnect } from "../../types"
import { backdrill, ownLayer, postMachining } from "./build22"
import { layerMapOf, layersOfNames } from "./layers"
import { quarterTurns, rotK } from "./geometry"
import { rawGeometry } from "./graphics"
import { padLayers, type Face } from "./needs"
import type { KicadBoard, KicadFootprint, KicadPad, KicadPadLayer, KicadShape, PadLocal } from "./types"
import { kid } from "./sexpr"
import { padUnusedOf } from "./read"

// X7: a KiCad pad as a pad of the land of its footprint (`PadDef`), in the editor's frame, exactly.
//
// The editor is y up and KiCad y down. The land is the library's footprint, with no turn and on the top side, so one
// footprint has one land on whichever side a board puts it; the part's turn and mirror put it where the file has it.
// KiCad flips a footprint about its own x axis (`FOOTPRINT::Flip`, footprint.cpp 10.0.0 `:3504`): `PAD::Flip` (pad.cpp
// `:1442`) mirrors the pad's place, its shape offset, a trapezoid's delta and its drawings' y, negates its turn within the
// footprint, and swaps the chamfered corners top for bottom; the file keeps that flipped state. So a vector of the pad's own
// frame (a drill offset, a custom pad's drawing) is `(x, -y)` in the land of a top footprint and `(x, y)` in a bottom one: the
// stored frame has y down, the library's has it flipped back on the bottom, and the land negates once more. That is `s * y`
// with `s` = -1 on top and +1 on the bottom, the same factor the pad's place has had since slice 1a.
//
// KiCad's own rules for a pad, as the parser leaves it (parsePAD, pcb_io_kicad_sexpr_parser.cpp 10.0.0 `:5723`):
// - the hole is at the pad's `at`; `(drill ... (offset x y))` is where the copper is from the hole (`ShapePos`, pad.cpp `:1536`);
// - a `chamfer_ratio` above zero or any `chamfer` corner makes it a chamfered rectangle (`:6044-6086`), whatever shape the file says;
// - a rounded rectangle without `roundrect_rratio` has the ratio 0.25, a chamfer without a ratio 0.2, a custom pad's anchor is a
//   circle unless it says rect (the `PAD` constructor, pad.cpp `:80-110`);
// - a pad of no size (`<= 0` either way) is 1 micron square (`:6411`; 9.0.0 `:5485`; 5.1.12 has no such rule).

/** KiCad's size for a pad whose width or height is zero or less. */
const ZERO_SIZE = 0.001

/** The size a pad has once KiCad has read it. */
export function padSize(pad: Pick<KicadPad, "w" | "h">): { w: number; h: number } {
  return pad.w <= 0 || pad.h <= 0 ? { w: ZERO_SIZE, h: ZERO_SIZE } : { w: pad.w, h: pad.h }
}

/** The shape KiCad draws for a pad: a chamfer word makes any shape a chamfered rectangle. */
export type EffectiveShape = "circle" | "rect" | "oval" | "trapezoid" | "roundrect" | "chamfered" | "custom"

export function effectiveShape(pad: Pick<KicadPad, "shape" | "chamferRatio" | "chamferCorners">): EffectiveShape | null {
  if ((pad.chamferRatio ?? 0) > 0 || (pad.chamferCorners ?? 0) !== 0) return "chamfered"
  return pad.shape === "circle" || pad.shape === "rect" || pad.shape === "oval" || pad.shape === "trapezoid" || pad.shape === "roundrect" || pad.shape === "custom" ? pad.shape : null
}

/** The corner radius ratio KiCad has for a pad: the file's, clamped to 0 to 0.5, or 0.25. */
export const roundRatio = (pad: Pick<KicadPad, "roundrectRatio">) => Math.max(0, Math.min(0.5, pad.roundrectRatio ?? 0.25))

/** A trapezoid's corners in the pad's own frame (y down, before its turn), as `TransformTrapezoidToPolygon` has them with `delta` the delta halved. */
function trapezoidCorners(w: number, h: number, dx: number, dy: number): Vec2[] {
  const hx = w / 2
  const hy = h / 2
  const ddx = dx / 2
  const ddy = dy / 2
  return [
    { x: -hx - ddy, y: hy + ddx },
    { x: -hx + ddy, y: -hy - ddx },
    { x: hx - ddy, y: -hy + ddx },
    { x: hx + ddy, y: hy - ddx },
  ]
}

const r6 = (n: number) => round(n, 6)

export interface LandPad {
  def: PadDef
  /** What the model cannot hold of the pad, as words; absent for a pad held exactly. */
  lossy?: string
  /** What was kept that the editor does not draw, or changed as KiCad does, for the report. */
  notes: string[]
}

/** The pin and number a pad is given in its part. */
export interface PadIds {
  /** The part's pin the pad is on; null for a pad with none. */
  pin: string | null
  /** The number the file gives it, when that is not the pin's. */
  number?: string
}

/** The drill KiCad's `PAD` constructor starts with (30 mils), which a non-plated hole with no `drill` node keeps. */
const DEFAULT_DRILL = 0.762

/** Which sides of a part a set of KiCad's faces is on: a face on the bottom of the board is on the part's own side when the part is. */
function sidesOf(faces: Iterable<Face>, bottom: boolean): PadSides {
  const set = new Set(faces)
  const own = set.has(bottom ? "B" : "F")
  const other = set.has(bottom ? "F" : "B")
  return own && other ? "both" : own ? "top" : other ? "bottom" : "none"
}

/** The faces a list of KiCad's layer names puts a silkscreen layer on. */
const silkFaces = (names: string[]): Face[] => names.flatMap((n) => (n === "F.SilkS" ? (["F"] as Face[]) : n === "B.SilkS" ? (["B"] as Face[]) : n === "*.SilkS" ? (["F", "B"] as Face[]) : []))

/** The pad's own layers, for the ones that differ from what its kind has; undefined when none does. */
function layersOf(pad: KicadPad, board: KicadBoard, bottom: boolean): PadLayers | undefined {
  const lay = padLayers(pad, board)
  const kind = defaultFaces({ layer: pad.type === "smd" || pad.type === "connect" ? "top" : "through", ...(pad.type === "np_thru_hole" ? { plated: false as const } : {}) })
  const got = {
    copper: sidesOf(lay.copper, bottom),
    mask: sidesOf(lay.mask, bottom),
    paste: sidesOf(lay.paste, bottom),
    silk: sidesOf(silkFaces(pad.layers), bottom),
  }
  const out: PadLayers = {}
  for (const k of ["copper", "mask", "paste", "silk"] as const) if (got[k] !== kind[k]) out[k] = got[k]
  // X1: the inner copper layers the pad is on, by the part's own side. A through-hole pad with copper on both sides has every one unless it says otherwise.
  const map = layerMapOf(board)
  const innerOf = (ids: CopperLayer[]) => ids.filter((l) => l !== "top" && l !== "bottom")
  const inner = innerOf(layersOfNames(map, pad.layers))
  const own = (bottom ? inner.map((l) => flipLayer(l, map.count)) : inner).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
  const all = innerOf(map.ids)
  const byDefault = kind.copper === "both" && got.copper === "both" ? all : []
  if (own.length !== byDefault.length || own.some((l, i) => l !== byDefault[i])) out.inner = own
  const other = lay.other.map((n) => (bottom ? flipShapeLayer(n, map.count) : n))
  if (other.length) out.other = other
  return Object.keys(out).length ? out : undefined
}

const ZONE_CONNECT: Record<number, ZoneConnect> = { 0: "none", 1: "thermal", 2: "solid", 3: "tht" }
const PROPERTY: Record<string, PadProperty> = {
  pad_prop_bga: "bga",
  pad_prop_fiducial_glob: "fiducial_glob",
  pad_prop_fiducial_loc: "fiducial_loc",
  pad_prop_testpoint: "testpoint",
  pad_prop_castellated: "castellated",
  pad_prop_heatsink: "heatsink",
  pad_prop_mechanical: "mechanical",
  pad_prop_pressfit: "pressfit",
}

/** What a pad sets for itself, over what its footprint sets: a pad that sets none of a kind takes the footprint's (`PAD::GetSolderMaskExpansion` and the others ask the footprint). */
export const mergedLocal = (pad: PadLocal, fp: PadLocal): PadLocal => ({ ...fp, ...pad })

/** A drawing of a custom pad as an editor shape in the pad's frame as the land has it (`s * y`), or null when it makes no shape. */
function primitive(s: KicadShape, sgn: number): BoardShape | null {
  const geom = rawGeometry(s)
  if (!geom) return null
  const mapped = mapShape(geom, (p) => ({ x: r6(p.x), y: r6(sgn * p.y) }))
  const closed = isClosedShape(mapped)
  // KiCad gives a drawn shape of no width the default one; a filled one may have none (parsePCB_SHAPE, parser `:3577`).
  const width = s.width <= 0 && !(s.filled && closed) ? DEFAULT_SHAPE_WIDTH : s.width
  const dash = s.dash && ["dash", "dot", "dash_dot", "dash_dot_dot"].includes(s.dash) ? (s.dash as "dash" | "dot" | "dash_dot" | "dash_dot_dot") : undefined
  return { ...mapped, layer: "F.Cu", width: r6(Math.max(0, width)), ...(s.filled && closed ? { fill: true as const } : {}), ...(dash ? { dash } : {}) }
}

/**
 * A pad as a pad of the land of its footprint, in the editor's frame, and what the model cannot hold of it (nothing, but a pad
 * whose shape word KiCad does not know). `bottom` is whether the footprint is on the bottom of the board; `board` brings the layers.
 */
export function landPad(fp: KicadFootprint, pad: KicadPad, bottom: boolean, ids?: PadIds, board?: KicadBoard): LandPad {
  return pad.stack && board ? landPadStacked(fp, pad, bottom, ids, board) : landPadPlain(fp, pad, bottom, ids, board)
}

const GEOMETRY = ["shape", "x", "y", "width", "height", "points", "rot", "round", "chamfer", "custom"] as const
const POUR = ["clearance", "zoneConnect", "thermalGap", "thermalWidth", "thermalAngle"] as const

/** The pad as one layer of its pad stack has it: the pad's own (front) properties, over which the layer's entry puts what it says (a layer reads through to the front for what it does not say, padstack.cpp 9.0.0 `:830-870`). */
function layerPad(pad: KicadPad, l: KicadPadLayer): KicadPad {
  const out: KicadPad = { ...pad, stack: null, padstack: false }
  if (l.shape !== undefined) out.shape = l.shape
  if (l.w !== undefined) out.w = l.w
  if (l.h !== undefined) out.h = l.h
  if (l.rectDelta) out.rectDelta = l.rectDelta
  if (l.roundrectRatio !== undefined) out.roundrectRatio = l.roundrectRatio
  if (l.chamferRatio !== undefined) out.chamferRatio = l.chamferRatio
  if (l.chamferCorners !== undefined) out.chamferCorners = l.chamferCorners
  if (l.anchor) out.anchor = l.anchor
  if (l.hull) out.hull = true
  if (kid(l.node, "primitives")) {
    out.primitives = l.primitives
    out.proxies = l.proxies
  }
  if (l.offset) out.drill = pad.drill ? { ...pad.drill, offset: l.offset } : { oval: false, w: 0, h: 0, offset: l.offset }
  const local: PadLocal = { ...pad.local }
  if (l.clearance !== undefined) local.clearance = l.clearance
  if (l.zoneConnect !== undefined) local.zoneConnect = l.zoneConnect
  if (l.thermalGap !== undefined) local.thermalGap = l.thermalGap
  if (l.thermalWidth !== undefined) local.thermalWidth = l.thermalWidth
  if (l.thermalAngle !== undefined) local.thermalAngle = l.thermalAngle
  out.local = local
  return out
}

/** What a layer's pad has that the base pad does not: its geometry whole when any of it differs, and each pour setting that differs. Absent when it is the same pad. */
function variantOf(def: PadDef, base: PadDef): PadLayerShape | null {
  const out: Record<string, unknown> = {}
  const d = def as unknown as Record<string, unknown>
  const b = base as unknown as Record<string, unknown>
  if (GEOMETRY.some((k) => JSON.stringify(d[k]) !== JSON.stringify(b[k]))) for (const k of GEOMETRY) if (d[k] !== undefined) out[k] = d[k]
  for (const k of POUR) if (JSON.stringify(d[k]) !== JSON.stringify(b[k]) && d[k] !== undefined) out[k] = d[k]
  return Object.keys(out).length ? (out as PadLayerShape) : null
}

/**
 * A pad with a pad stack (X1, KiCad 9's `padstack`): the pad of the part's own side, and the shape of each other layer where it differs. The file's
 * front layer is the top-level shape and size; a part on the bottom has its own side there at the file's back layer, so its base is that entry and
 * the file's front layer is its far side.
 */
function landPadStacked(fp: KicadFootprint, pad0: KicadPad, bottom: boolean, ids: PadIds | undefined, board: KicadBoard): LandPad {
  const map = layerMapOf(board)
  const stack = pad0.stack!
  // An entry for the front layer itself changes the front's own properties (a file KiCad does not write).
  const frontEntry = stack.layers.find((l) => map.of(l.name) === "top")
  const pad = frontEntry ? layerPad(pad0, frontEntry) : { ...pad0, stack: null, padstack: false }
  const keyed = stack.layers.filter((l) => l !== frontEntry).map((l) => ({ l, id: l.name === "Inner" ? ("inner" as const) : map.of(l.name) }))
  const backEntry = bottom ? keyed.find((k) => k.id === "bottom") : undefined
  const base = landPadPlain(fp, backEntry ? layerPad(pad, backEntry.l) : pad, bottom, ids, board)
  const notes = [...base.notes]
  const layers: Record<string, PadLayerShape> = {}
  const add = (key: string, from: KicadPad) => {
    const made = landPadPlain(fp, from, bottom, ids, board)
    for (const n of made.notes) if (!notes.includes(n)) notes.push(n)
    const v = variantOf(made.def, base.def)
    if (v) layers[key] = v
  }
  for (const k of keyed) {
    // A layer the board has no copper on (`In9.Cu` on a board of four layers) has no place in the stack: say so, the entry is left out.
    if (k.id === null) {
      const why = `a pad stack entry for ${k.l.name}, which is not a copper layer of the board, so the entry is left out`
      if (!notes.includes(why)) notes.push(why)
    }
    if (k === backEntry || k.id === null) continue
    const own: string = k.id === "inner" ? "inner" : bottom ? flipLayer(k.id, map.count) : k.id
    add(own, layerPad(pad, k.l))
  }
  // On the bottom the file's front layer is the part's far side.
  if (bottom && backEntry) add("bottom", pad)
  const def: PadDef = { ...base.def, stack: { mode: stack.mode, layers: layers as NonNullable<PadDef["stack"]>["layers"] } }
  return { def, ...(base.lossy ? { lossy: base.lossy } : {}), notes }
}

function landPadPlain(fp: KicadFootprint, pad: KicadPad, bottom: boolean, ids?: PadIds, board?: KicadBoard): LandPad {
  const notes: string[] = []
  let lossy: string | undefined
  const sgn = bottom ? 1 : -1
  const pin = ids ? ids.pin : pad.number ? pad.number : null
  const size = padSize(pad)
  const effective = effectiveShape(pad)
  if (effective === null) lossy = `a pad of the shape ${pad.shape}`
  // The hole's place in the land (the pad's `at`), and the pad's own turn within the part as the library has it: the stored (absolute)
  // angle minus the footprint's, and the other way round on the bottom, where `PAD::Flip` negated it.
  const hole0: Vec2 = { x: r6(pad.at.x), y: r6(sgn * pad.at.y) }
  const turn = bottom ? fp.angle - pad.angle : pad.angle - fp.angle
  const q = quarterTurns(turn, Math.hypot(size.w, size.h) / 2)
  const offset = pad.drill?.offset && (pad.drill.offset.x !== 0 || pad.drill.offset.y !== 0) ? pad.drill.offset : null
  // The shape offset (the copper from the hole) in the pad's frame, and the copper's centre: the hole's moved by it, turned with the pad (`ShapePos`).
  const oLand: Vec2 = offset ? { x: offset.x, y: sgn * offset.y } : { x: 0, y: 0 }
  const moved = rotate90(oLand, turn)
  const centre: Vec2 = { x: r6(hole0.x + moved.x), y: r6(hole0.y + moved.y) }
  // A pad that looks the same turned by a half turn, and by a quarter turn with its sides swapped, keeps the land it had before (no turn of its own);
  // any other is held with its turn. The land's frame is turned by the whole turn from the file's in the first case, by none in the second.
  const asymmetric = !!offset || effective === "custom" || (effective === "chamfered" && (pad.chamferCorners ?? 0) !== 0)
  const normalized = !asymmetric && q !== null
  const turnOut = q !== null ? q * 90 : normalizeAngle(turn)
  const swap = normalized && (q === 1 || q === 3)
  const frameTurn = normalized ? turnOut : 0
  const w = swap ? size.h : size.w
  const h = swap ? size.w : size.h
  const npth = pad.type === "np_thru_hole"
  const through = pad.type === "thru_hole"
  const out: PadDef = { pin, shape: "rect", x: centre.x, y: centre.y, width: r6(w), height: r6(h), layer: npth || through ? "through" : "top" }
  if (ids?.number !== undefined) out.number = ids.number
  // ---- the hole ----
  const drill = npth ? (pad.drill ?? { oval: false, w: DEFAULT_DRILL, h: DEFAULT_DRILL, offset: null }) : through ? pad.drill : null
  let holeAxis = 0
  if (drill) {
    const hw = drill.w
    const hh = drill.oval ? drill.h : drill.w
    if (hw <= 0 || hh <= 0) notes.push("a through-hole pad with a drill of no size, which KiCad makes a hole of a nanometre; the project has no hole in it")
    else {
      out.holeDiameter = r6(Math.min(hw, hh))
      if (drill.oval && Math.abs(hw - hh) > 1e-6) {
        out.slotLength = r6(Math.max(hw, hh))
        // The slot runs along x of the pad's own frame when the drill is wider than it is high.
        holeAxis = hw >= hh ? 0 : 90
      }
    }
  } else if (through) notes.push("a through-hole pad with no drill, which KiCad makes a hole of a nanometre; the project has no hole in it")
  if (npth) out.plated = false
  // ---- the shape ----
  let polygonCentre: Vec2 | null = null
  switch (effective) {
    case "trapezoid": {
      // The outline in the pad's own frame, turned by its stored turn within the footprint, about the copper's centre in the stored frame, then into the land.
      const d = pad.rectDelta ?? { x: 0, y: 0 }
      const corners = trapezoidCorners(size.w, size.h, d.x, d.y)
      const storedTurn = pad.angle - fp.angle
      const sc = offset ? rotK(offset.x, offset.y, storedTurn) : { x: 0, y: 0 }
      const points = corners.map((c) => {
        const t = rotK(c.x, c.y, storedTurn)
        return { x: r6(pad.at.x + sc.x + t.x), y: r6(sgn * (pad.at.y + sc.y + t.y)) }
      })
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      Object.assign(out, { shape: "polygon", points, x: r6((Math.min(...xs) + Math.max(...xs)) / 2), y: r6((Math.min(...ys) + Math.max(...ys)) / 2), width: r6(Math.max(...xs) - Math.min(...xs)), height: r6(Math.max(...ys) - Math.min(...ys)) })
      polygonCentre = { x: out.x, y: out.y }
      break
    }
    case "custom": {
      const anchor: "circle" | "rect" = pad.anchor ?? "circle"
      // The pad stays its anchor, a rectangle or circle, with drawings added; a circle anchor's size is the width.
      Object.assign(out, { shape: anchor, width: r6(size.w), height: r6(anchor === "rect" ? size.h : size.w) })
      const shapes: BoardShape[] = []
      for (const s of pad.primitives) {
        const p = primitive(s, sgn)
        if (p) shapes.push(p)
        else notes.push("a drawing of a custom pad whose numbers make no shape")
      }
      out.custom = { anchor, shapes, ...(pad.hull ? { hull: true as const } : {}) }
      const proxy = pad.proxies.map((s) => primitive(s, sgn)).filter((p): p is BoardShape => p !== null)
      if (proxy.length) out.custom.proxy = proxy
      break
    }
    case "circle":
      // A circle with an oval drill of a non-plated hole keeps its copper in KiCad even where the drill covers it, so it stays a stadium of equal sides.
      Object.assign(out, { shape: npth && drill?.oval ? "pill" : "circle", width: r6(size.w), height: r6(size.w) })
      break
    case "oval":
      // A round oval of a non-plated hole stays a stadium: KiCad flashes its copper even where a round drill covers it (a circle's is dropped, pad.cpp `FlashLayer`).
      if (Math.abs(size.w - size.h) < 1e-6 && !(npth && drill && !drill.oval)) Object.assign(out, { shape: "circle", width: r6(size.w), height: r6(size.w) })
      else out.shape = "pill"
      break
    case "rect":
    case "roundrect":
    case "chamfered": {
      const ratio = effective === "rect" ? 0 : roundRatio(pad)
      if (ratio > 0) out.round = r6(ratio)
      const corners = effective === "chamfered" ? (pad.chamferCorners ?? 0) : 0
      if (corners !== 0) {
        // The corners as the land has them: `PAD::Flip` swapped top for bottom, so a bottom footprint's library corners are the stored ones swapped back, and the land keeps them as the library has them.
        const tl = corners & 1
        const tr = corners & 2
        const br = corners & 4
        const bl = corners & 8
        const land = bottom ? (bl ? 1 : 0) | (br ? 2 : 0) | (tr ? 4 : 0) | (tl ? 8 : 0) : corners
        out.chamfer = { ratio: r6(pad.chamferRatio ?? 0.2), corners: land }
      }
      break
    }
  }
  // A circle is the same turned, unless the frame decides where its hole or its drawings are.
  if (effective !== "trapezoid" && !normalized && turnOut !== 0 && !(out.shape === "circle" && effective !== "custom" && !offset)) out.rot = turnOut
  // ---- the hole's place from the copper's centre, and a slot's axis, in the pad's frame ----
  if (out.holeDiameter !== undefined) {
    if (polygonCentre) {
      // A polygon has no turn: its hole is where the file puts it, from the polygon's own centre, in the land's frame.
      const dx = hole0.x - polygonCentre.x
      const dy = hole0.y - polygonCentre.y
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) out.holeOffset = { x: r6(dx), y: r6(dy) }
    } else if (offset) out.holeOffset = { x: r6(-oLand.x), y: r6(-oLand.y) }
    if (out.slotLength !== undefined) {
      // Along the slot in the pad's frame as the land has it: the file's axis turned by whatever the land's frame turned from the file's.
      const axis = (((holeAxis + (polygonCentre ? turn : frameTurn)) % 180) + 180) % 180
      const normal = out.width >= out.height ? 0 : 90
      const diff = Math.abs(axis - normal)
      // A square or round pad has no longer side for the slot to follow when the part turns, so its axis is always written.
      const square = Math.abs(out.width - out.height) < 1e-9
      if (square || (diff > 1e-6 && Math.abs(diff - 180) > 1e-6)) out.holeAxis = r6(axis)
    }
  }
  // ---- layers, margins, overrides ----
  if (board) {
    const layers = layersOf(pad, board, bottom)
    if (layers) out.layers = layers
  }
  const local = mergedLocal(pad.local, fp.local)
  if (local.maskMargin !== undefined) out.maskMargin = r6(local.maskMargin)
  if (local.pasteMargin !== undefined) out.pasteMargin = r6(local.pasteMargin)
  if (local.pasteRatio !== undefined) out.pasteRatio = r6(local.pasteRatio)
  if (local.clearance !== undefined) out.clearance = r6(local.clearance)
  if (local.zoneConnect !== undefined && ZONE_CONNECT[local.zoneConnect]) out.zoneConnect = ZONE_CONNECT[local.zoneConnect]
  // A pad's own thermal gap and spoke width only: the footprint's are read and dropped by KiCad (parser `:5371`).
  if (pad.local.thermalGap !== undefined) out.thermalGap = r6(pad.local.thermalGap)
  if (pad.local.thermalWidth !== undefined) out.thermalWidth = r6(pad.local.thermalWidth)
  if (pad.local.thermalAngle !== undefined) out.thermalAngle = r6(pad.local.thermalAngle)
  const prop = pad.properties.map((p) => PROPERTY[p]).find(Boolean)
  if (prop) out.property = prop
  if (pad.type === "connect") out.connector = true
  // X1 and X5: what becomes of the copper on layers nothing connects to, and the pad's own tenting of the mask (sides as the part has them: the file's front is the far side of a part on the bottom).
  const unused = padUnusedOf(pad.node)
  if (unused) out.unused = unused
  // X31: the layers a pour joins the pad on, as the part's own side has them (a part on the bottom has its inner layers the other way round); the node with no layer is `[]`.
  if (pad.zoneLayers && board) {
    const map = layerMapOf(board)
    const own = layersOfNames(map, pad.zoneLayers).map((l) => (bottom ? flipLayer(l, map.count) : l))
    out.zoneLayers = map.ids.filter((l) => own.includes(l))
  }
  if (pad.tenting && (pad.tenting.front !== undefined || pad.tenting.back !== undefined)) {
    const own = bottom ? pad.tenting.back : pad.tenting.front
    const far = bottom ? pad.tenting.front : pad.tenting.back
    out.tent = { ...(own !== undefined ? { top: own } : {}), ...(far !== undefined ? { bottom: far } : {}) }
  }
  // X22: backdrills and post-machining, by the part's own side: `PAD::Flip` (via `PADSTACK::FlipLayers`, padstack.cpp 10.0.0 `:1550`) flips the drills' layers and swaps the front and back post-machining, and the file keeps that state.
  if (board && (pad.backdrill || pad.tertiary)) {
    const map = layerMapOf(board)
    const own = ownLayer(bottom, map.count)
    for (const [from, key] of [[pad.backdrill, "backdrill"], [pad.tertiary, "tertiary"]] as const) {
      if (!from) continue
      const drill = backdrill(from, map, own)
      if (!drill) {
        notes.push(`a ${key === "backdrill" ? "backdrill" : "tertiary drill"} between ${from.start} and ${from.end}, which are not both copper layers of the board (KiCad ignores it too)`)
        continue
      }
      out[key] = drill
    }
  }
  if (pad.post) {
    const own = bottom ? pad.post.back : pad.post.front
    const far = bottom ? pad.post.front : pad.post.back
    const post: NonNullable<PadDef["post"]> = {}
    if (own) post.front = postMachining(own)
    if (far) post.back = postMachining(far)
    out.post = post
  }
  if (pad.pinFunction) out.pinFunction = pad.pinFunction
  if (pad.pinType) out.pinType = pad.pinType
  if (pad.dieLength !== undefined) out.dieLength = r6(pad.dieLength)
  if (pad.dieDelay !== undefined) out.dieDelay = round(pad.dieDelay, 6)
  return { def: out, ...(lossy ? { lossy } : {}), notes }
}
