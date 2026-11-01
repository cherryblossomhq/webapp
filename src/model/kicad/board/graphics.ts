import { emptyBox, expandBox, round } from "../../../lib/geometry"
import { flipShapeLayer, isShapeLayer, shapeLayerInfo } from "../../shapeLayers"
import { DEFAULT_SHAPE_WIDTH, isClosedShape, mapShape, shapeBox } from "../../shapes"
import type { BoardShape, ShapeDash, ShapeGeometry, ShapePoint, Vec2 } from "../../types"
import type { KicadBoard, KicadFootprint, KicadShape, Pt } from "./types"

// KiCad's drawings (`gr_line`, `fp_arc`, `gr_poly`... and `target` marks) as the editor's shapes.
// Everything is read in KiCad's own frame (y down) as the geometry the file describes, then sent
// through one map into the editor's (y up; a footprint's own frame for a land), so a shape is the
// same shape and nothing about an arc, a curve or an ellipse is rederived: an arc stays its three
// points, a circle its centre and radius, an ellipse its radii and angles (the map turns an
// ellipse's angle and flips its sweep when it mirrors).

/**
 * KiCad's own translated layer names of old boards (Italian, Polish and French, which is all that
 * KiCad's parser maps: `createOldLayerMapping`, pcb_io_kicad_sexpr_parser.cpp) to its names.
 */
export const TRANSLATED_LAYER_NAMES: Record<string, string> = {
  "Adesivo.Retro": "B.Adhes",
  "Adesivo.Fronte": "F.Adhes",
  "Pasta.Retro": "B.Paste",
  "Pasta.Fronte": "F.Paste",
  "Serigrafia.Retro": "B.SilkS",
  "Serigrafia.Fronte": "F.SilkS",
  "Maschera.Retro": "B.Mask",
  "Maschera.Fronte": "F.Mask",
  Grafica: "Dwgs.User",
  Commenti: "Cmts.User",
  Eco1: "Eco1.User",
  Eco2: "Eco2.User",
  "Contorno.scheda": "Edge.Cuts",
  Kleju_Dolna: "B.Adhes",
  Kleju_Gorna: "F.Adhes",
  Pasty_Dolna: "B.Paste",
  Pasty_Gorna: "F.Paste",
  Opisowa_Dolna: "B.SilkS",
  Opisowa_Gorna: "F.SilkS",
  Maski_Dolna: "B.Mask",
  Maski_Gorna: "F.Mask",
  Rysunkowa: "Dwgs.User",
  Komentarzy: "Cmts.User",
  ECO1: "Eco1.User",
  ECO2: "Eco2.User",
  Krawedziowa: "Edge.Cuts",
  "Dessous.Adhes": "B.Adhes",
  "Dessus.Adhes": "F.Adhes",
  "Dessous.Pate": "B.Paste",
  "Dessus.Pate": "F.Paste",
  "Dessous.SilkS": "B.SilkS",
  "Dessus.SilkS": "F.SilkS",
  "Dessous.Masque": "B.Mask",
  "Dessus.Masque": "F.Mask",
  "Dessin.User": "Dwgs.User",
  "Contours.Ci": "Edge.Cuts",
}

export type LayerKind = "layer" | "edge" | "inner" | "unknown"

export interface ResolvedLayer {
  kind: LayerKind
  /** KiCad's name of the layer for `layer`: `F.Cu`, `B.SilkS`, `User.3`. */
  name: string
  /** For `edge`: the file's name is not `Edge.Cuts` itself but a translation of it, which the outline does not read. */
  translatedEdge?: boolean
}

/**
 * The layer a file's name stands for: the board's front and back copper (named as its table
 * names them), KiCad's own names, and the translated names KiCad itself maps in an old file
 * (Italian, Polish and French). Inner copper and any other name are told apart so a board that
 * needs the layer stack (X1) or has a layer that is none of KiCad's can say so.
 */
export function resolveLayer(board: Pick<KicadBoard, "copper">, name: string): ResolvedLayer {
  if (name === board.copper.front) return { kind: "layer", name: "F.Cu" }
  if (name === board.copper.back) return { kind: "layer", name: "B.Cu" }
  if (name === "Edge.Cuts") return { kind: "edge", name }
  // The copper layers the table lists, by place (X1): the third one is `In2.Cu` whatever the file calls it.
  const at = board.copper.names.indexOf(name)
  if (at > 0 && at < board.copper.names.length - 1) return { kind: "layer", name: `In${at}.Cu` }
  if (isShapeLayer(name) && !/^In\d+\.Cu$/.test(name)) return { kind: "layer", name }
  // A name that is KiCad's own for an inner layer the board has none of is nothing.
  if (/^In\d+\.Cu$/.test(name)) return { kind: "inner", name }
  const t = TRANSLATED_LAYER_NAMES[name]
  if (t === "Edge.Cuts") return { kind: "edge", name: t, translatedEdge: true }
  if (t) return { kind: "layer", name: t }
  return { kind: "unknown", name }
}

const r6 = (n: number) => round(n, 6)

/** Every number of a shape's geometry rounded to a millionth (a nanometre, KiCad's own unit), and `-0` made `0`. */
function roundGeometry<T extends ShapeGeometry>(g: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "number") return r6(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(g) as T
}

/** A negative stroke width of less than this much (mm) is no width: a file written with -0.000001 means zero. A larger one shrinks the fill when KiCad plots it, which is X24's. */
export const NEGLIGIBLE_WIDTH = 1e-4

const same = (p: Pt, q: Pt) => Math.abs(p.x - q.x) < 1e-7 && Math.abs(p.y - q.y) < 1e-7

/** A KiCad polygon's outline as corners, an arc item being a straight edge to its start where the chain is not already there, then the arc. */
function polygonPoints(s: KicadShape): ShapePoint[] {
  const out: ShapePoint[] = []
  const items = s.polyItems ?? (s.pts ?? []).map((p) => ({ xy: p }))
  for (const item of items) {
    if ("xy" in item) out.push({ x: item.xy.x, y: item.xy.y })
    else {
      const { start, mid, end } = item.arc
      const last = out[out.length - 1]
      if (!last || !same(last, start)) out.push({ x: start.x, y: start.y })
      out.push({ x: end.x, y: end.y, mid: { x: mid.x, y: mid.y } })
    }
  }
  // A closing arc that ends on the first corner makes the edge into the first corner an arc.
  // (Only when three corners are left: KiCad draws a polygon of three points that names one twice as the line it is.)
  if (out.length > 3 && same(out[0], out[out.length - 1])) {
    const last = out.pop()!
    if (last.mid) out[0] = { ...out[0], mid: last.mid }
  }
  return out
}

/** The geometry a KiCad shape describes, in KiCad's frame, or null when the file's numbers do not make a shape. */
export function rawGeometry(s: KicadShape): ShapeGeometry | null {
  switch (s.kind) {
    case "line":
      return s.start && s.end ? { type: "line", a: s.start, b: s.end } : null
    case "arc":
      return s.start && s.mid && s.end ? { type: "arc", start: s.start, mid: s.mid, end: s.end } : null
    case "circle":
      return s.center && s.end ? { type: "circle", c: s.center, r: Math.hypot(s.end.x - s.center.x, s.end.y - s.center.y) } : null
    case "rect":
    case "bbox":
      return s.start && s.end ? { type: "rect", a: s.start, b: s.end, ...(s.radius > 0 ? { radius: s.radius } : {}) } : null
    case "poly": {
      const pts = polygonPoints(s)
      return pts.length >= 3 ? { type: "polygon", pts } : null
    }
    case "curve": {
      const p = s.pts ?? []
      return p.length === 4 ? { type: "curve", p0: p[0], c1: p[1], c2: p[2], p1: p[3] } : null
    }
    case "ellipse":
    case "ellipse_arc": {
      const e = s.ellipse
      if (!e || !(e.major > 0) || !(e.minor > 0)) return null
      return { type: "ellipse", c: e.center, rx: e.major, ry: e.minor, rot: e.rotation, ...(e.start !== undefined && e.end !== undefined ? { from: e.start, to: e.end } : {}) }
    }
  }
}

export interface GraphicsContext {
  board: KicadBoard
  /** Where a point of KiCad's frame goes: y negated, or kept for a footprint on the bottom (see `landPad`). */
  map: (p: Vec2) => Vec2
  /** The layer of the land or the board for the layer a file names (a bottom footprint's sides are swapped). */
  layerOf: (resolved: string) => string
  /** The project's name for a net by the file's spelling. */
  netName: (raw: string) => string | undefined
  /** What cannot be held, by reason (the builder turns these into a refusal). */
  lose: (what: string) => void
  /** Shapes the file has that KiCad draws nothing for (a polygon of fewer than three corners). */
  degenerate: string[]
  /** Copper drawings that name a net number the board's net table lacks, which KiCad loads with no net: where each is, and the number. */
  badNets: string[]
  /** Layers the footprint keeps private (KiCad shows and plots nothing on them). */
  privateLayers?: string[]
  /** Where each target mark drawn on Edge.Cuts was, which the board keeps on Dwgs.User instead (`convertTarget`). */
  edgeTargets?: string[]
  /** A label for messages: where the shape is. */
  where: string
}

const DASHES: Record<string, ShapeDash> = { dash: "dash", dot: "dot", dash_dot: "dash_dot", dash_dot_dot: "dash_dot_dot" }
const COPPER_FACE: Record<string, string> = { "F.Cu": "F.Mask", "B.Cu": "B.Mask" }

/**
 * A KiCad shape as editor shapes: one per layer it is on. A shape on an outer copper layer and its
 * own side's mask is the copper shape and an opening in the mask outlined as KiCad plots it (the
 * stroke grown by twice the shape's mask margin, or the board's). A shape on the board's edge is the
 * outline's and gives none.
 */
export function convertShape(s: KicadShape, cx: GraphicsContext): BoardShape[] {
  const resolved = s.layers.map((n) => ({ file: n, r: resolveLayer(cx.board, n) }))
  const geom = rawGeometry(s)
  const out: BoardShape[] = []
  const layers: string[] = []
  for (const { file, r } of resolved) {
    if (r.kind === "edge") continue
    if (cx.privateLayers?.includes(file)) continue
    if (r.kind === "unknown") {
      cx.lose(`a drawing on the layer "${file}", which is not one of KiCad's`)
      continue
    }
    if (r.kind === "inner") {
      cx.lose(`a drawing on ${file}, a copper layer the board's layer table does not list`)
      continue
    }
    layers.push(r.name)
  }
  if (!layers.length) return out
  if (!geom) {
    // A polygon of fewer than three corners is not drawn or plotted by KiCad, so there is nothing to bring; it is counted.
    if (s.kind === "poly") cx.degenerate.push(cx.where)
    else cx.lose(`a ${s.kind} whose numbers do not make a shape (${cx.where})`)
    return out
  }
  if (s.badNet !== undefined) cx.badNets.push(`${cx.where}: net ${s.badNet}`)
  // X24 holds a pour's hatch, not a drawing's: the hatch lines KiCad 10 computes for a filled drawing are not held, so the board is not imported with the fill missing.
  if (s.hatched) {
    cx.lose(`a drawing filled with a hatch (${cx.where})`)
    return out
  }
  const closed = isClosedShape(geom)
  const net = s.netRaw ? cx.netName(s.netRaw) : undefined
  const mapped = roundGeometry(mapShape(geom, cx.map))
  const base = (width: number, layer: string): BoardShape => ({
    ...mapped,
    layer: cx.layerOf(layer),
    width: r6(width),
    ...(DASHES[s.dash ?? ""] ? { dash: DASHES[s.dash!] } : {}),
    ...(s.filled && closed ? { fill: true as const } : {}),
    ...(net ? { net } : {}),
    ...(s.locked ? { locked: true as const } : {}),
    ...(s.ends ? { ends: s.ends } : {}),
    ...(s.color ? { color: s.color } : {}),
  })
  // KiCad gives a drawn (unfilled) shape with no width the default one; a filled one may have none.
  let width = s.width <= 0 && !(s.filled && closed) ? DEFAULT_SHAPE_WIDTH : s.width
  // A filled shape's negative width shrinks its fill in KiCad's plot; a nanometre of it (some files have -0.000001) is none, and more is not held.
  if (width < 0) {
    if (width > -NEGLIGIBLE_WIDTH) width = 0
    else cx.lose(`a filled drawing with a negative width (${cx.where})`)
  }
  const copperWithMask = layers.filter((l) => COPPER_FACE[l] && layers.includes(COPPER_FACE[l]))
  for (const layer of layers) {
    const maskOf = Object.entries(COPPER_FACE).find(([, mask]) => mask === layer)?.[0]
    if (maskOf && copperWithMask.includes(maskOf)) {
      const margin = s.maskMargin ?? cx.board.setup.pad_to_mask_clearance ?? 0
      const shape = base(Math.max(width + 2 * margin, 0), layer)
      // The mask opening has no net: it is not copper.
      delete shape.net
      out.push(shape)
    } else out.push(base(width, layer))
  }
  return out
}

/** A `target` mark as shapes: a circle, and a cross or an X through it, as KiCad plots one (`PlotPcbTarget`). */
export function convertTarget(t: KicadBoard["targets"][number], cx: GraphicsContext): BoardShape[] {
  let r = resolveLayer(cx.board, t.layer)
  // KiCad leaves a target out of the board's outline (it is no shape) and plots it on Edge.Cuts. The editor reads every drawing on Edge.Cuts as the
  // outline, so a mark there is kept beside it, on Dwgs.User, and the import says where (fabs and labs draw alignment marks on the edge layer).
  if (r.kind === "edge") {
    if (!cx.edgeTargets) {
      cx.lose(`a target mark on ${t.layer} at (${t.at.x}, ${t.at.y}) (an alignment mark drawn on the board outline's layer, which the editor reads as the outline)`)
      return []
    }
    cx.edgeTargets.push(`(${t.at.x}, ${t.at.y})`)
    r = { kind: "layer", name: "Dwgs.User" }
  }
  if (r.kind === "unknown" || r.kind === "inner") {
    cx.lose(r.kind === "inner" ? `a target on ${t.layer}, a copper layer the board's layer table does not list` : `a target on the layer "${t.layer}", which is not one of KiCad's`)
    return []
  }
  const width = t.width <= 0 ? DEFAULT_SHAPE_WIDTH : t.width
  const circleR = t.shape === "x" ? t.size / 2 : t.size / 3
  const h = t.size / 2
  const at = t.at
  const lines: [Pt, Pt][] =
    t.shape === "x"
      ? [
          [{ x: at.x - h, y: at.y - h }, { x: at.x + h, y: at.y + h }],
          [{ x: at.x - h, y: at.y + h }, { x: at.x + h, y: at.y - h }],
        ]
      : [
          [{ x: at.x - h, y: at.y }, { x: at.x + h, y: at.y }],
          [{ x: at.x, y: at.y - h }, { x: at.x, y: at.y + h }],
        ]
  const geoms: ShapeGeometry[] = [{ type: "circle", c: at, r: circleR }, ...lines.map(([a, b]): ShapeGeometry => ({ type: "line", a, b }))]
  return geoms.map((g) => ({ ...roundGeometry(mapShape(g, cx.map)), layer: cx.layerOf(r.name), width: r6(width) }))
}

/** The shapes of one footprint as a land's, in the land's frame, and the box of those on the part's own courtyard layer. */
export function landShapes(fp: KicadFootprint, board: KicadBoard, bottom: boolean, netName: (raw: string) => string | undefined, lose: (what: string) => void, degenerate: string[], badNets: string[]): { shapes: BoardShape[]; privateCount: number; origins: number[] } {
  const cx: GraphicsContext = {
    board,
    // The land is the library's: the same on both sides (see `landPad`), so a bottom footprint's y is kept as it is stored and its layers are swapped.
    map: bottom ? (p) => ({ x: p.x, y: p.y }) : (p) => ({ x: p.x, y: -p.y }),
    layerOf: bottom ? (l) => flipShapeLayer(l, board.copper.names.length || 2) : (l) => l,
    netName,
    lose,
    degenerate,
    badNets,
    privateLayers: fp.privateLayers,
    where: `${fp.ref || fp.name || "a footprint"}`,
  }
  const shapes: BoardShape[] = []
  /** For each drawing of the land, the place of the file's drawing it came from (a drawing may come out as none, or as several). */
  const origins: number[] = []
  let privateCount = 0
  fp.shapes.forEach((s, i) => {
    if (s.layers.some((n) => fp.privateLayers.includes(n))) privateCount++
    const made = convertShape(s, cx)
    shapes.push(...made)
    for (let k = 0; k < made.length; k++) origins.push(i)
  })
  return { shapes, privateCount, origins }
}

/** The courtyard of a land: the box of its drawings on its own courtyard layer, or null when it has none. */
export function courtyardBox(shapes: BoardShape[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const b = emptyBox()
  let any = false
  for (const s of shapes) {
    if (s.layer !== "F.CrtYd") continue
    const sb = shapeBox(s)
    expandBox(b, { x: sb.minX, y: sb.minY })
    expandBox(b, { x: sb.maxX, y: sb.maxY })
    any = true
  }
  return any ? { minX: r6(b.minX), minY: r6(b.minY), maxX: r6(b.maxX), maxY: r6(b.maxY) } : null
}

/** The box of every drawing of a land that is not a courtyard, fabrication or adhesive layer's or on the other side: what it looks like. */
export function drawingBox(shapes: BoardShape[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const b = emptyBox()
  let any = false
  for (const s of shapes) {
    const kind = shapeLayerInfo(s.layer)?.kind
    if (kind === "courtyard") continue
    const sb = shapeBox(s)
    expandBox(b, { x: sb.minX, y: sb.minY })
    expandBox(b, { x: sb.maxX, y: sb.maxY })
    any = true
  }
  return any ? { minX: r6(b.minX), minY: r6(b.minY), maxX: r6(b.maxX), maxY: r6(b.maxY) } : null
}
