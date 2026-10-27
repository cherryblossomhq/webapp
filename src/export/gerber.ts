import { boardTextStrokes, boardTextStrokeWidth, mountingHoles, ownTexts } from "../model/board"
import { isNpth, maskSides, padOnLayer, pasteSides, pcbPads, pcbSilk, type WorldPad } from "../model/instances"
import { arcOf, bareOpeningWidth, bareTraces } from "../model/arcTracks"
import { copperLayers, kicadLayerName, viaDiameterOn, viaLayers } from "../model/stack"
import { viaTentedOn } from "../model/viaRules"
import type { CopperItem } from "../model/pcb"
import { resolvedComponents } from "../model/ruleAreas"
import { maskMargin, padOpeningRings, pasteMargins } from "../model/padOpening"
import { onBoard } from "../model/partFlags"
import { designatorStrokes, placeDesignators, SILK_WIDTH } from "../model/silk"
import { polygonKit, withMaxError, type ZoneFill } from "../model/pour"
import type { CopperLayer, PcbSide, Project, Trace, Vec2 } from "../model/types"
import type { BoardShape } from "../model/types"
import { worldShapes } from "../model/shapeItems"
import { arcCircle, dashShape, drawnPaths, flattenSeg, isClosedShape, lineEndParts, segStart, shapeRings, type DashPiece, type PathSeg } from "../model/shapes"
import { textsOnLayer } from "../model/texts"
import { fractureRings } from "./fracture"
import { requireClosedOutline } from "./outlineGuard"
import { maskRegions } from "./maskMerge"
import { otherFillsOn } from "../model/nonCopperFill"

const EDGE_WIDTH = 0.1

/** Integer coordinate in 4.6 format (millimetres, 6 decimals implied). */
const coord = (mm: number) => {
  const n = Math.round(mm * 1e6)
  return String(Object.is(n, -0) ? 0 : n)
}

/** Decimal aperture parameter without exponent notation or trailing zeros. */
const num = (mm: number) => {
  const s = mm.toFixed(6).replace(/\.?0+$/, "")
  return s === "-0" || s === "" ? "0" : s
}

const xy = (p: Vec2) => `X${coord(p.x)}Y${coord(p.y)}`

export class GerberWriter {
  private apertures = new Map<string, number>()
  private body: string[] = []
  private current: number | null = null

  /** Select an aperture by template, defining it on first use. */
  use(template: string) {
    let d = this.apertures.get(template)
    if (d === undefined) {
      d = 10 + this.apertures.size
      this.apertures.set(template, d)
    }
    if (this.current !== d) {
      this.body.push(`D${d}*`)
      this.current = d
    }
  }

  flashCircle(p: Vec2, diameter: number) {
    if (diameter <= 0) return
    this.use(`C,${num(diameter)}`)
    this.body.push(`${xy(p)}D03*`)
  }

  flashRect(p: Vec2, w: number, h: number) {
    if (w <= 0 || h <= 0) return
    this.use(`R,${num(w)}X${num(h)}`)
    this.body.push(`${xy(p)}D03*`)
  }

  flashObround(p: Vec2, w: number, h: number) {
    if (w <= 0 || h <= 0) return
    this.use(`O,${num(w)}X${num(h)}`)
    this.body.push(`${xy(p)}D03*`)
  }

  stroke(points: Vec2[], width: number) {
    if (points.length < 2 || width <= 0) return
    this.use(`C,${num(width)}`)
    this.moveTo(points[0])
    for (const p of points.slice(1)) this.lineTo(p)
  }

  polarity(dark: boolean) {
    this.body.push(dark ? "%LPD*%" : "%LPC*%")
  }

  region(points: Vec2[]) {
    if (points.length < 3) return
    this.body.push("G36*")
    this.moveTo(points[0])
    for (const p of points.slice(1)) this.lineTo(p)
    this.lineTo(points[0])
    this.body.push("G37*")
  }

  moveTo(p: Vec2) {
    this.body.push(`${xy(p)}D02*`)
  }

  lineTo(p: Vec2) {
    this.body.push(`${xy(p)}D01*`)
  }

  /** Counter-clockwise arc to `p`; `offset` is the centre relative to the current point. */
  arcCcwTo(p: Vec2, offset: Vec2) {
    this.body.push("G03*")
    this.body.push(`${xy(p)}I${coord(offset.x)}J${coord(offset.y)}D01*`)
    this.body.push("G01*")
  }

  /** Clockwise arc to `p`; `offset` is the centre relative to the current point. */
  arcCwTo(p: Vec2, offset: Vec2) {
    this.body.push("G02*")
    this.body.push(`${xy(p)}I${coord(offset.x)}J${coord(offset.y)}D01*`)
    this.body.push("G01*")
  }

  /**
   * An arc from the current point `from` to `to` about `centre`, the way the model's circle goes.
   * The offset is taken between the rounded points, so the centre is the model's within 0.5 nm.
   */
  arcAbout(from: Vec2, to: Vec2, centre: Vec2, ccw: boolean) {
    const at = (n: number) => Math.round(n * 1e6)
    const i = at(centre.x) - at(from.x) || 0
    const j = at(centre.y) - at(from.y) || 0
    this.body.push(ccw ? "G03*" : "G02*")
    this.body.push(`${xy(to)}I${i}J${j}D01*`)
    this.body.push("G01*")
  }

  /** One piece of a drawing's outline, continuing from the current point: a line, an exact arc, or a curve as the points it was flattened to. */
  segTo(s: PathSeg) {
    switch (s.kind) {
      case "line":
        this.lineTo(s.b)
        return
      case "arc": {
        const a = arcCircle(s.start, s.mid, s.end)
        if (!a) this.lineTo(s.end)
        else this.arcAbout(s.start, s.end, a.c, a.sweep > 0)
        return
      }
      default: {
        const pts = flattenSeg(s)
        for (let i = 1; i < pts.length; i++) this.lineTo(pts[i])
      }
    }
  }

  /** A connected run of pieces stroked with a round aperture of `width`. */
  strokeSegs(segs: PathSeg[], width: number) {
    if (!segs.length || width <= 0) return
    this.use(`C,${num(width)}`)
    this.moveTo(segStart(segs[0]))
    for (const s of segs) this.segTo(s)
  }

  /** One dash of a dashed drawing. */
  strokePiece(piece: DashPiece, width: number) {
    if (width <= 0) return
    switch (piece.kind) {
      case "line":
        this.stroke([piece.a, piece.b], width)
        return
      case "poly":
        this.stroke(piece.pts, width)
        return
      case "arc":
        this.strokeSegs([piece], width)
    }
  }

  toString(fileFunction: string, polarity: "Positive" | "Negative" = "Positive"): string {
    const lines = [
      "G04 Cherry Blossom RS-274X export*",
      "%FSLAX46Y46*%",
      "%MOMM*%",
      "%TF.GenerationSoftware,Cherry Blossom,Cherry Blossom,0.1*%",
      `%TF.FileFunction,${fileFunction}*%`,
      `%TF.FilePolarity,${polarity}*%`,
      "%LPD*%",
      "G01*",
      "G75*",
      ...[...this.apertures].map(([template, d]) => `%ADD${d}${template}*%`),
      ...this.body,
      "M02*",
    ]
    return lines.join("\n") + "\n"
  }
}

/**
 * A convex ring with every edge moved `d` outward (inward when negative), the corners where the moved edges meet (a mitre). `[]` when the
 * ring shrinks to nothing, null when the ring is not convex.
 */
export function offsetConvexRing(pts: Vec2[], d: number): Vec2[] | null {
  const n = pts.length
  let area = 0
  for (let i = 0; i < n; i++) area += pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y
  if (Math.abs(area) < 1e-12) return null
  const ring = area > 0 ? pts : [...pts].reverse()
  const dir = (a: Vec2, b: Vec2) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    return l < 1e-12 ? null : { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
  }
  // Drop repeated points, then insist on a left turn at every corner (or none, for a point in a straight run).
  const clean = ring.filter((p, i) => dir(p, ring[(i + 1) % n]) !== null)
  const m = clean.length
  if (m < 3) return null
  const dirs = clean.map((p, i) => dir(p, clean[(i + 1) % m])!)
  for (let i = 0; i < m; i++) {
    const a = dirs[(i + m - 1) % m]
    const b = dirs[i]
    if (a.x * b.y - a.y * b.x < -1e-9) return null
  }
  // Counter-clockwise, so the outward side of an edge is on its right: the normal is (dy, -dx).
  const out: Vec2[] = []
  for (let i = 0; i < m; i++) {
    const a = dirs[(i + m - 1) % m]
    const b = dirs[i]
    const p = clean[i]
    const cross = a.x * b.y - a.y * b.x
    if (Math.abs(cross) < 1e-9) {
      out.push({ x: p.x + b.y * d, y: p.y - b.x * d })
      continue
    }
    // The corner moves along the bisector by d / cos(half the turn): (na + nb) * d / (1 + na . nb).
    const na = { x: a.y, y: -a.x }
    const nb = { x: b.y, y: -b.x }
    const k = d / (1 + na.x * nb.x + na.y * nb.y)
    out.push({ x: p.x + (na.x + nb.x) * k, y: p.y + (na.y + nb.y) * k })
  }
  if (d < 0) {
    // An edge that comes out turned around means the ring has shrunk through itself.
    for (let i = 0; i < m; i++) {
      const e = { x: out[(i + 1) % m].x - out[i].x, y: out[(i + 1) % m].y - out[i].y }
      if (e.x * dirs[i].x + e.y * dirs[i].y <= 1e-9) return []
    }
  }
  return out
}

/** Rings of a pad as regions: each outer ring with the holes inside it joined to it. */
function plotRings(w: GerberWriter, rings: Vec2[][]) {
  if (rings.length === 1) {
    w.region(rings[0])
    return
  }
  // In whole nanometres, which is the Gerber's own unit: nothing is lost to the union.
  withMaxError(
    undefined,
    () => {
      for (const poly of polygonKit.regions(polygonKit.unionEvenOdd(rings.map((r) => polygonKit.path(r))))) w.region(poly.length > 1 ? fractureRings(poly[0], poly.slice(1)) : poly[0])
    },
    1e6,
  )
}

function flashPad(w: GerberWriter, pad: WorldPad, grow = 0, growY = grow) {
  // A pad with X7 features is plotted as KiCad plots it (`padOpening.ts`): any shape but a plain circle as regions, exact to a nanometre.
  if (pad.x7 && !(pad.x7.def.shape === "circle" && !pad.x7.def.custom)) {
    const rings = padOpeningRings(pad, grow, growY)
    if (rings?.length) plotRings(w, rings)
    return
  }
  const width = pad.width + grow * 2
  const height = pad.height + growY * 2
  switch (pad.shape) {
    case "circle":
      w.flashCircle(pad, Math.max(width, height))
      return
    case "pill":
      if (Math.abs(width - height) < 1e-9) w.flashCircle(pad, width)
      else w.flashObround(pad, width, height)
      return
    case "polygon":
      if (pad.points && pad.points.length >= 3) {
        if (grow === 0) {
          w.region(pad.points)
          return
        }
        // A turned pad's opening is its outline moved out (or in) by `grow` with mitred corners, as a rectangle's is, so a part at 33 degrees
        // gets the opening it has at 0, turned. A shape with a dent is grown by a round stroke, and cannot be shrunk.
        const ring = offsetConvexRing(pad.points, grow)
        if (ring) {
          if (ring.length >= 3) w.region(ring)
          return
        }
        w.region(pad.points)
        if (grow > 0) w.stroke([...pad.points, pad.points[0]], grow * 2)
        return
      }
      w.flashRect(pad, width, height)
      return
    default:
      w.flashRect(pad, width, height)
  }
}

const physicalComponents = (project: Project) => resolvedComponents(project).filter((c) => onBoard(c))

/**
 * The pads of one layer of the plot: `copper` ones have copper there (a non-plated hole only if it has copper round it), `mask` ones an opening
 * in the solder mask on that side, `paste` ones an aperture in the stencil. A pad has the sides its kind has unless it says (`PadDef.layers`).
 */
const padsOn = (project: Project, layer: CopperLayer, what: "copper" | "mask" | "paste" = "copper", flashed?: Map<string, CopperItem>): WorldPad[] => {
  const layers = copperLayers(project.board)
  const out: WorldPad[] = []
  for (const c of physicalComponents(project)) {
    pcbPads(c, layers.length).forEach((pad, i) => {
      const on = (what === "mask" ? maskSides(pad) : what === "paste" ? pasteSides(pad) : isNpth(pad) ? (pad.ring ?? []) : pad.layers).includes(layer)
      if (!on) return
      // A pad's own tenting of the mask closes its opening on that side (X5).
      if (what === "mask" && pad.tented?.[layer === "top" ? "front" : "back"] === true && (layer === "top" || layer === "bottom")) return
      // X1: copper the pad drops on a layer nothing connects to is not plotted there (`pruneUnused`).
      if (what === "copper" && flashed && pad.unused) {
        const item = flashed.get(`pad:${c.id}:${i}`) ?? flashed.get(`pad:${c.id}:${i}@${layer}`)
        if (!item || !item.layers.includes(layer)) return
      }
      out.push(what === "copper" ? padOnLayer(pad, layer) : pad)
    })
  }
  for (const h of mountingHoles(project.board)) {
    out.push({ componentId: "#board", pin: null, padNumber: null, shape: "circle", x: h.x, y: h.y, width: h.diameter, height: h.diameter, holeDiameter: h.drill, layers: [...layers] })
  }
  return out
}

/**
 * One drawing as KiCad plots it (plot_brditems_plotter.cpp, PlotShape): a stroke of its width along its
 * outline, exact arcs and circles; a filled circle as one flash of its diameter plus the width; any
 * other fill as a region of its edge with no width added, then the outline stroked; a bezier and an
 * ellipse, which Gerber has no primitive for, as the polyline they flatten to; a dashed outline as its dashes; a line with ends (X24) stopped short under them, which follow it.
 */
function plotShape(w: GerberWriter, shape: BoardShape) {
  const filled = shape.fill === true && isClosedShape(shape)
  if (filled) {
    if (shape.type === "circle") {
      w.flashCircle(shape.c, 2 * shape.r + (shape.dash ? 0 : shape.width))
      if (!shape.dash) return
    } else {
      const rings = shapeRings(shape)
      if (rings.length) w.region(rings.length > 1 ? fractureRings(rings[0], rings.slice(1)) : rings[0])
    }
  }
  if (shape.width > 0) {
    if (shape.dash) for (const piece of dashShape(shape)) w.strokePiece(piece, shape.width)
    else for (const path of drawnPaths(shape)) w.strokeSegs(path.segs, shape.width)
  }
  // The ends of a line (`LINE_ENDING::Plot`): a closed one is a region, outlined by its own width where it has one; an open arrow is a stroke of its width.
  for (const part of lineEndParts(shape)) {
    if (!part.open) w.region(part.outline)
    if (part.open || part.width > 0) w.stroke(part.open ? part.outline : [...part.outline, part.outline[0]], part.width)
  }
}

/** The drawings on one KiCad layer that are plotted: those of parts placed on the board, and the board's own. */
function drawingsOn(project: Project, layer: string): BoardShape[] {
  return worldShapes(project).filter((s) => s.placed && s.shape.layer === layer).map((s) => s.shape)
}

/** The fills of the zones on a layer that is not copper (X29) as KiCad plots a zone's fill: one region for each polygon, its holes cut out of it (`PlotZone`, plot_brditems_plotter.cpp). */
function plotOtherZones(w: GerberWriter, project: Project, layer: string) {
  for (const f of otherFillsOn(project, layer)) for (const polygon of f.polygons) w.region(polygon.length > 1 ? fractureRings(polygon[0], polygon.slice(1)) : polygon[0])
}

/** The texts on one KiCad layer as KiCad plots them (`PlotText`, pcbnew/plot_brditems_plotter.cpp:767 of 10.0.0): strokes with a round pen, a knockout as a filled region with the letters left out, a text box's border as a stroked outline. */
function plotTexts(w: GerberWriter, project: Project, layer: string) {
  for (const t of textsOnLayer(project, layer)) {
    for (const polygon of t.fills) w.region(polygon.length > 1 ? fractureRings(polygon[0], polygon.slice(1)) : polygon[0])
    for (const stroke of t.strokes) w.stroke(stroke.length === 1 ? [stroke[0], stroke[0]] : stroke, t.pen)
    if (t.border) w.stroke([...t.border.points, t.border.points[0]], t.border.width)
  }
}

const sideName = (side: PcbSide) => (side === "top" ? "Top" : "Bot")

/** Area enclosed by a ring, whichever way it winds. */
const ringArea = (ring: Vec2[]) => {
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  return Math.abs(twice) / 2
}

/** A track as the plot draws it, `width` wide: an arc track is the arc it is, G02 or G03 about its centre (KiCad's `PlotArc`, X4), not chords. */
function strokeTrace(w: GerberWriter, t: Trace, width: number) {
  const arc = t.arc && t.points.length === 3 ? arcOf(t.points) : null
  if (arc?.circle) w.strokeSegs([{ kind: "arc", start: arc.start, mid: arc.mid, end: arc.end }], width)
  else w.stroke(arc ? [arc.start, arc.end] : t.points, width)
}

/**
 * Copper layer. Pours go first: each fill is a dark region with its holes cleared, and the
 * pads and traces drawn afterwards are dark again, so clearing never erases them.
 *
 * A clear region erases everything already drawn beneath it, not just its own polygon's copper,
 * so the pour polygons go largest first: an island inside another polygon's hole (or another
 * zone's) is always smaller, so it lands after the hole that would otherwise wipe it.
 */
export function gerberCopper(project: Project, layer: CopperLayer, fills: ZoneFill[] = [], items?: CopperItem[]): string {
  const w = new GerberWriter()
  const all = copperLayers(project.board)
  const flashed = items ? new Map(items.filter((it) => it.kind === "pad" || it.kind === "via").map((it) => [it.id, it])) : undefined
  const polygons = fills
    .filter((fill) => fill.layer === layer)
    .flatMap((fill) => fill.polygons)
    .map((polygon) => ({ polygon, area: ringArea(polygon[0]) }))
    .sort((a, b) => b.area - a.area)
  for (const { polygon } of polygons) {
    w.region(polygon[0])
    if (polygon.length > 1) {
      w.polarity(false)
      for (const hole of polygon.slice(1)) w.region(hole)
      w.polarity(true)
    }
  }
  for (const pad of padsOn(project, layer, "copper", flashed)) flashPad(w, pad)
  for (const t of project.traces) if (t.layer === layer) strokeTrace(w, t, t.width)
  // Each via on the layers of its span, at its diameter there (a via stack has its own on some layers), where the copper is not dropped for being unused.
  const viaFlashed = new Map<string, Set<CopperLayer>>()
  if (items) for (const it of items) if (it.kind === "via") viaFlashed.set(it.viaId, new Set([...(viaFlashed.get(it.viaId) ?? []), ...it.layers]))
  for (const v of project.vias) {
    const on = items ? (viaFlashed.get(v.id)?.has(layer) ?? false) : viaLayers(project.board, v).includes(layer)
    if (on) w.flashCircle(v, viaDiameterOn(v, layer))
  }
  const name = kicadLayerName(layer)
  for (const shape of drawingsOn(project, name)) plotShape(w, shape)
  plotTexts(w, project, name)
  const index = all.indexOf(layer) + 1
  return w.toString(`Copper,L${index},${layer === "top" ? "Top" : layer === "bottom" ? "Bot" : "Inr"}`)
}

/** Mask openings: pads and non-plated holes grown by the mask expansion, and vias unless they're tented. */
export function gerberMask(project: Project, side: PcbSide): string {
  const w = new GerberWriter()
  const grow = project.rules.maskExpansion
  // With a minimum mask web KiCad plots the mask as merged regions, not opening by opening (`maskMerge.ts`).
  if (project.rules.maskMinWidth !== undefined && project.rules.maskMinWidth > 0) {
    for (const poly of maskRegions(project, side, padsOn(project, side, "mask"), drawingsOn(project, side === "top" ? "F.Mask" : "B.Mask"))) w.region(poly.length > 1 ? fractureRings(poly[0], poly.slice(1)) : poly[0])
    return w.toString(`Soldermask,${sideName(side)}`, "Negative")
  }
  for (const pad of padsOn(project, side, "mask")) flashPad(w, pad, pad.x7 ? maskMargin(pad, project.rules) : grow)
  // A via has an opening on a side when its copper reaches that outer layer and it is not tented there: by its own setting, else the board's (X5).
  for (const v of project.vias) if (viaLayers(project.board, v).includes(side) && !viaTentedOn(project.rules, v, side)) w.flashCircle(v, viaDiameterOn(v, side) + grow * 2)
  // X24: a track's copper left open through the mask is an opening along it, wider by its own margin or the board's expansion on each side.
  for (const t of bareTraces(project, side)) strokeTrace(w, t, bareOpeningWidth(t, grow))
  for (const shape of drawingsOn(project, side === "top" ? "F.Mask" : "B.Mask")) plotShape(w, shape)
  plotOtherZones(w, project, side === "top" ? "F.Mask" : "B.Mask")
  plotTexts(w, project, side === "top" ? "F.Mask" : "B.Mask")
  return w.toString(`Soldermask,${sideName(side)}`, "Negative")
}

/** Stencil apertures for SMD pads, grown or shrunk by the paste expansion. Every part has its paste, do not populate parts too, as KiCad plots it. */
export function gerberPaste(project: Project, side: PcbSide): string {
  const w = new GerberWriter()
  const { pasteExpansion, pasteRatio } = project.rules
  for (const pad of padsOn(project, side, "paste")) {
    if (pad.x7) {
      // A pad with X7 features: its own margin and ratio, else the board's, as KiCad's `GetSolderPasteMargin` has them.
      const m = pasteMargins(pad, project.rules)
      flashPad(w, pad, m.x, m.y)
      continue
    }
    if (pad.holeDiameter !== undefined) continue
    if (pasteRatio === undefined) flashPad(w, pad, pasteExpansion)
    // The margin is the board's absolute one plus the ratio of the pad's size, along each side, and never takes more than half of it (`PAD::GetSolderPasteMargin`).
    else flashPad(w, pad, Math.max(pasteExpansion + pad.width * pasteRatio, -pad.width / 2), Math.max(pasteExpansion + pad.height * pasteRatio, -pad.height / 2))
  }
  for (const shape of drawingsOn(project, side === "top" ? "F.Paste" : "B.Paste")) plotShape(w, shape)
  plotOtherZones(w, project, side === "top" ? "F.Paste" : "B.Paste")
  plotTexts(w, project, side === "top" ? "F.Paste" : "B.Paste")
  return w.toString(`Paste,${sideName(side)}`)
}

export function gerberSilkscreen(project: Project, side: PcbSide): string {
  const w = new GerberWriter()
  const designators = placeDesignators(project)
  for (const c of physicalComponents(project)) {
    if (c.pcb.side !== side) continue
    for (const path of pcbSilk(c)) w.stroke(path, SILK_WIDTH)
    const d = designators.get(c.id)
    if (d) for (const stroke of designatorStrokes(d)) w.stroke(stroke, SILK_WIDTH)
  }
  for (const t of ownTexts(project)) {
    if (t.side !== side) continue
    for (const stroke of boardTextStrokes(t)) w.stroke(stroke, boardTextStrokeWidth(t))
  }
  for (const shape of drawingsOn(project, side === "top" ? "F.SilkS" : "B.SilkS")) plotShape(w, shape)
  plotOtherZones(w, project, side === "top" ? "F.SilkS" : "B.SilkS")
  plotTexts(w, project, side === "top" ? "F.SilkS" : "B.SilkS")
  return w.toString(`Legend,${sideName(side)}`)
}

/** Board outline as a rounded rectangle traced counter-clockwise. */
export function gerberEdgeCuts(project: Project): string {
  const w = new GerberWriter()
  const b = project.board
  // A board with an outline of its own: every path as drawn, arcs as arcs (G02 and G03), the cutouts and slots with it.
  if (b.outline?.paths.length) {
    for (const path of b.outline.paths) w.strokeSegs(path.segs, EDGE_WIDTH)
    plotOtherZones(w, project, "Edge.Cuts")
    plotTexts(w, project, "Edge.Cuts")
    return w.toString("Profile,NP")
  }
  const minX = b.x - b.width / 2
  const maxX = b.x + b.width / 2
  const minY = b.y - b.height / 2
  const maxY = b.y + b.height / 2
  const r = Math.max(0, Math.min(b.cornerRadius, b.width / 2, b.height / 2))
  if (r < 1e-6) {
    const corners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]
    w.stroke([...corners, corners[0]], EDGE_WIDTH)
    plotOtherZones(w, project, "Edge.Cuts")
    plotTexts(w, project, "Edge.Cuts")
    for (const shape of drawingsOn(project, "Edge.Cuts")) plotShape(w, shape)
    return w.toString("Profile,NP")
  }
  w.use(`C,${num(EDGE_WIDTH)}`)
  const line = (from: Vec2, to: Vec2) => {
    if (Math.abs(from.x - to.x) > 1e-9 || Math.abs(from.y - to.y) > 1e-9) w.lineTo(to)
  }
  w.moveTo({ x: minX + r, y: minY })
  line({ x: minX + r, y: minY }, { x: maxX - r, y: minY })
  w.arcCcwTo({ x: maxX, y: minY + r }, { x: 0, y: r })
  line({ x: maxX, y: minY + r }, { x: maxX, y: maxY - r })
  w.arcCcwTo({ x: maxX - r, y: maxY }, { x: -r, y: 0 })
  line({ x: maxX - r, y: maxY }, { x: minX + r, y: maxY })
  w.arcCcwTo({ x: minX, y: maxY - r }, { x: 0, y: -r })
  line({ x: minX, y: maxY - r }, { x: minX, y: minY + r })
  w.arcCcwTo({ x: minX + r, y: minY }, { x: r, y: 0 })
  plotOtherZones(w, project, "Edge.Cuts")
  plotTexts(w, project, "Edge.Cuts")
  for (const shape of drawingsOn(project, "Edge.Cuts")) plotShape(w, shape)
  return w.toString("Profile,NP")
}

export type GerberLayerName =
  | "F_Cu"
  | `In${number}_Cu`
  | "B_Cu"
  | "F_Mask"
  | "B_Mask"
  | "F_Silkscreen"
  | "B_Silkscreen"
  | "F_Paste"
  | "B_Paste"
  | "Edge_Cuts"

/** The name of a copper layer's Gerber file: `F_Cu`, `In1_Cu`, `B_Cu` (KiCad's own, with the dot as an underscore). */
export const gerberNameOf = (layer: CopperLayer): GerberLayerName => kicadLayerName(layer).replace(".", "_") as GerberLayerName

export function gerberLayers(project: Project, fills: ZoneFill[] = [], items?: CopperItem[]): Record<GerberLayerName, string> {
  requireClosedOutline(project, "The Gerber and drill files")
  const copper = Object.fromEntries(copperLayers(project.board).map((l) => [gerberNameOf(l), gerberCopper(project, l, fills, items)])) as Record<string, string>
  return {
    F_Cu: copper.F_Cu,
    ...Object.fromEntries(Object.entries(copper).filter(([k]) => k !== "F_Cu" && k !== "B_Cu")),
    B_Cu: copper.B_Cu,
    F_Mask: gerberMask(project, "top"),
    B_Mask: gerberMask(project, "bottom"),
    F_Silkscreen: gerberSilkscreen(project, "top"),
    B_Silkscreen: gerberSilkscreen(project, "bottom"),
    F_Paste: gerberPaste(project, "top"),
    B_Paste: gerberPaste(project, "bottom"),
    Edge_Cuts: gerberEdgeCuts(project),
  }
}
