import { viaLayers } from "../../model/stack"
import { viaTentedOn } from "../../model/viaRules"
import * as THREE from "three"
import { boardColors, boardFinish, boardTextStrokes, boardTextStrokeWidth, finishMetal, mountingHoles, ownTexts } from "../../model/board"
import { isNpth, maskSides, pcbSilk, type WorldPad } from "../../model/instances"
import { maskMargin, padOpeningRings } from "../../model/padOpening"
import { designatorStrokes, getDesignators, SILK_WIDTH } from "../../model/silk"
import type { ZoneFill } from "../../model/pour"
import { worldShapes } from "../../model/shapeItems"
import { dashShape, lineEndParts, shapeCanvasPath } from "../../model/shapes"
import { textsOnLayer } from "../../model/texts"
import type { BoardShape, ComponentInstance, CopperLayer, Project, Vec2 } from "../../model/types"

/** The finish seen at the thin rim of a mask opening. */
const RIM = { gold: "#b08a4e", tin: "#8f9196", copper: "#a8704c" }

// Matches the Gerber legend so the 3D board shows what the fab prints.

/** Pixels per millimetre: sharp up close, bounded so large boards stay within GPU memory. */
export function texelsPerMm(width: number, height: number): number {
  const byEdge = 4096 / Math.max(width, height, 1)
  const byArea = Math.sqrt(9e6 / Math.max(width * height, 1))
  return Math.max(6, Math.min(44, byEdge, byArea))
}

export interface SideTextures {
  /** sRGB colour: mask, copper seen through the mask, silkscreen. */
  albedo: THREE.CanvasTexture
  /** Linear data: R = height (bump), G = roughness. */
  surface: THREE.CanvasTexture
}

export interface BoardTextureSet {
  top: SideTextures
  bottom: SideTextures
  dispose(): void
}

export interface TextureInput {
  project: Project
  placed: ComponentInstance[]
  padsByComponent: Map<string, WorldPad[]>
  fills: ZoneFill[]
  anisotropy: number
}

// ---------- colour helpers ----------

const css = ([r, g, b]: [number, number, number]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`

/**
 * Copper under a coat of mask reads lighter than mask over bare laminate, with a slight warm
 * shift; dark masks hide it more. Works in HSL so every preset keeps its own hue.
 */
function maskShades(mask: string) {
  const base = new THREE.Color(mask)
  const hsl = { h: 0, s: 0, l: 0 }
  base.getHSL(hsl)
  const dark = hsl.l < 0.12
  const light = hsl.l > 0.6
  // Nudge the hue a little towards copper orange along the shorter way round.
  const copperHue = 0.08
  let dh = copperHue - hsl.h
  if (dh > 0.5) dh -= 1
  if (dh < -0.5) dh += 1
  const over = new THREE.Color().setHSL(
    (hsl.h + Math.sign(dh) * Math.min(Math.abs(dh), 0.014) + 1) % 1,
    Math.min(1, hsl.s * (light ? 1.15 : 0.96)),
    Math.min(0.92, hsl.l * (dark ? 1.5 : light ? 0.94 : 1.36) + (dark ? 0.035 : 0)),
  )
  const under = new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l * (light ? 0.97 : 0.86))
  const rgb = (c: THREE.Color): [number, number, number] => [c.r * 255, c.g * 255, c.b * 255]
  return { laminate: rgb(under), overCopper: rgb(over) }
}

// ---------- path helpers (world mm, y up; the context transform maps to pixels) ----------

function padPath(ctx: CanvasRenderingContext2D, pad: WorldPad, grow = 0) {
  const w = pad.width + grow * 2
  const h = pad.height + grow * 2
  if (pad.shape === "circle") {
    ctx.moveTo(pad.x + w / 2, pad.y)
    ctx.arc(pad.x, pad.y, w / 2, 0, Math.PI * 2)
    return
  }
  if (pad.rings && pad.rings.length > 1) {
    // A custom pad with a hole in it or in pieces: the rings are counted even-odd, so the context fills with "evenodd".
    ringsPath(ctx, pad.rings)
    return
  }
  if (pad.shape === "polygon" && pad.points && pad.points.length >= 3) {
    ctx.moveTo(pad.points[0].x, pad.points[0].y)
    for (const p of pad.points.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
    return
  }
  const r = pad.shape === "pill" ? Math.min(w, h) / 2 : pad.x7 ? Math.max(0, (pad.corner ?? 0) + grow) : Math.min(w, h) * 0.12
  ctx.roundRect(pad.x - w / 2, pad.y - h / 2, w, h, r)
}

function ringsPath(ctx: CanvasRenderingContext2D, rings: Vec2[][]) {
  for (const ring of rings) {
    if (ring.length < 3) continue
    ctx.moveTo(ring[0].x, ring[0].y)
    for (const p of ring.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
  }
}

function strokePolylines(ctx: CanvasRenderingContext2D, paths: Vec2[][], width: number) {
  ctx.lineWidth = width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.beginPath()
  for (const path of paths) {
    if (path.length < 2) continue
    ctx.moveTo(path[0].x, path[0].y)
    for (const p of path.slice(1)) ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
}

/** The drawings of the board and of its placed parts on one layer (`F.SilkS`, `B.Cu`...); none for a board that has none. */
function drawingsOn(project: Project, layer: string): BoardShape[] {
  return worldShapes(project).filter((d) => d.placed && d.shape.layer === layer).map((d) => d.shape)
}

/** Draw drawings with the context's fill and stroke style: filled ones filled, every one stroked by its width (in dashes when dashed). */
function drawShapes(ctx: CanvasRenderingContext2D, shapes: BoardShape[]) {
  if (!shapes.length) return
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  for (const shape of shapes) {
    if (shape.fill) {
      ctx.beginPath()
      shapeCanvasPath(ctx, shape)
      ctx.fill("evenodd")
    }
    // the ends of a line (X24): a closed one filled and outlined by its own width, an open arrow stroked
    for (const part of lineEndParts(shape)) {
      ctx.beginPath()
      ctx.moveTo(part.outline[0].x, part.outline[0].y)
      for (const q of part.outline.slice(1)) ctx.lineTo(q.x, q.y)
      if (!part.open) {
        ctx.closePath()
        ctx.fill()
      }
      if (part.open || part.width > 0) {
        ctx.lineWidth = part.width
        ctx.stroke()
      }
    }
    if (shape.width <= 0) continue
    ctx.lineWidth = shape.width
    ctx.beginPath()
    if (shape.dash) {
      for (const piece of dashShape(shape)) {
        if (piece.kind === "line") {
          ctx.moveTo(piece.a.x, piece.a.y)
          ctx.lineTo(piece.b.x, piece.b.y)
        } else if (piece.kind === "arc") shapeCanvasPath(ctx, { type: "arc", start: piece.start, mid: piece.mid, end: piece.end })
        else {
          ctx.moveTo(piece.pts[0].x, piece.pts[0].y)
          for (const q of piece.pts.slice(1)) ctx.lineTo(q.x, q.y)
        }
      }
    } else shapeCanvasPath(ctx, shape)
    ctx.stroke()
  }
}

/** The KiCad texts on one layer with the context's fill and stroke style: a knockout filled with its letters left out, strokes with their pen, a text box's border. */
function drawTexts(ctx: CanvasRenderingContext2D, project: Project, layer: string, style?: () => void) {
  const texts = textsOnLayer(project, layer)
  // Nothing is asked of the context for a board with no text on the layer, so a board drawn here is drawn as it was.
  if (!texts.length) return
  ctx.save()
  style?.()
  for (const t of texts) {
    if (t.fills.length) {
      ctx.beginPath()
      for (const polygon of t.fills) ringsPath(ctx, polygon)
      ctx.fill("evenodd")
    }
    if (t.strokes.length) strokePolylines(ctx, t.strokes.map((s) => (s.length === 1 ? [s[0], s[0]] : s)), t.pen)
    if (t.border) strokePolylines(ctx, [[...t.border.points, t.border.points[0]]], t.border.width)
  }
  ctx.restore()
}

// ---------- layer content ----------

/** Fill every copper shape on one layer with the current fill/stroke style. */
function drawCopper(ctx: CanvasRenderingContext2D, input: TextureInput, layer: CopperLayer) {
  const { project, padsByComponent, fills } = input
  for (const fill of fills) {
    if (fill.layer !== layer) continue
    ctx.beginPath()
    for (const poly of fill.polygons) ringsPath(ctx, poly)
    ctx.fill("evenodd")
  }
  for (const t of project.traces) {
    if (t.layer === layer) strokePolylines(ctx, [t.points], t.width)
  }
  ctx.beginPath()
  for (const pads of padsByComponent.values()) {
    for (const p of pads) if ((isNpth(p) ? (p.ring ?? []) : p.layers).includes(layer)) padPath(ctx, p)
  }
  for (const v of project.vias) {
    if (!viaLayers(project.board, v).includes(layer)) continue
    ctx.moveTo(v.x + v.diameter / 2, v.y)
    ctx.arc(v.x, v.y, v.diameter / 2, 0, Math.PI * 2)
  }
  for (const h of mountingHoles(project.board)) {
    ctx.moveTo(h.x + h.diameter / 2, h.y)
    ctx.arc(h.x, h.y, h.diameter / 2, 0, Math.PI * 2)
  }
  ctx.fill()
  drawShapes(ctx, drawingsOn(project, layer === "top" ? "F.Cu" : "B.Cu"))
  drawTexts(ctx, project, layer === "top" ? "F.Cu" : "B.Cu")
}

/** Silkscreen polylines and their stroke widths for one side. */
function silkStrokes(input: TextureInput, side: CopperLayer): { paths: Vec2[][]; width: number }[] {
  const out: { paths: Vec2[][]; width: number }[] = []
  const parts: Vec2[][] = []
  const designators = getDesignators(input.project)
  for (const c of input.placed) {
    if (c.pcb.side !== side) continue
    parts.push(...pcbSilk(c))
    const d = designators.get(c.id)
    if (d) parts.push(...designatorStrokes(d))
  }
  out.push({ paths: parts, width: SILK_WIDTH })
  for (const t of ownTexts(input.project)) {
    if (t.side === side && t.text.trim()) out.push({ paths: boardTextStrokes(t), width: boardTextStrokeWidth(t) })
  }
  return out
}

/** Openings over plated copper; non-plated holes are bare drills with no finish to show. */
function maskOpenings(ctx: CanvasRenderingContext2D, input: TextureInput, side: CopperLayer, grow: number) {
  ctx.beginPath()
  for (const pads of input.padsByComponent.values()) {
    for (const p of pads) {
      if (!maskSides(p).includes(side) || isNpth(p)) continue
      // A pad with X7 features has the opening KiCad plots for it, with its own margin.
      const rings = p.x7 ? padOpeningRings(p, maskMargin(p, input.project.rules)) : null
      if (rings) ringsPath(ctx, rings)
      else padPath(ctx, p, grow)
    }
  }
  const rings = [...mountingHoles(input.project.board), ...input.project.vias.filter((v) => viaLayers(input.project.board, v).includes(side) && !viaTentedOn(input.project.rules, v, side as "top" | "bottom"))]
  for (const h of rings) {
    ctx.moveTo(h.x + h.diameter / 2 + grow, h.y)
    ctx.arc(h.x, h.y, h.diameter / 2 + grow, 0, Math.PI * 2)
  }
}

// ---------- canvases ----------

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d", { willReadFrequently: false })
  if (!ctx) throw new Error("2D canvas unavailable")
  return { canvas, ctx }
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean, anisotropy: number) {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = anisotropy
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}

// Height levels (0-255) in the surface map's red channel.
const H_LAMINATE = 70
const H_COPPER = 190
const H_SILK = 40
// Roughness (green channel): satin mask, matte ink.
const R_MASK = 105
const R_SILK = 255

function buildSide(input: TextureInput, side: CopperLayer, ppm: number): SideTextures {
  const b = input.project.board
  const minX = b.x - b.width / 2
  const maxY = b.y + b.height / 2
  const w = Math.max(2, Math.round(b.width * ppm))
  const h = Math.max(2, Math.round(b.height * ppm))
  const sx = w / b.width
  const sy = h / b.height
  const world = (ctx: CanvasRenderingContext2D) => ctx.setTransform(sx, 0, 0, -sy, -minX * sx, maxY * sy)
  const blurPx = (mm: number) => `blur(${Math.max(0.5, mm * ppm).toFixed(2)}px)`

  const { mask, silk } = boardColors(b)
  const shades = maskShades(mask)

  // Albedo
  const a = makeCanvas(w, h)
  a.ctx.fillStyle = css(shades.laminate)
  a.ctx.fillRect(0, 0, w, h)
  world(a.ctx)
  a.ctx.fillStyle = css(shades.overCopper)
  a.ctx.strokeStyle = css(shades.overCopper)
  a.ctx.filter = blurPx(0.02)
  drawCopper(a.ctx, input, side)
  a.ctx.filter = "none"

  const silkSets = silkStrokes(input, side)
  const silkShapes = drawingsOn(input.project, side === "top" ? "F.SilkS" : "B.SilkS")
  a.ctx.strokeStyle = silk
  for (const s of silkSets) strokePolylines(a.ctx, s.paths, s.width)
  if (silkShapes.length) {
    a.ctx.save()
    a.ctx.fillStyle = silk
    drawShapes(a.ctx, silkShapes)
    a.ctx.restore()
  }
  const silkLayer = side === "top" ? "F.SilkS" : "B.SilkS"
  drawTexts(a.ctx, input.project, silkLayer, () => (a.ctx.fillStyle = silk))

  // Exposed pads are separate metal meshes; the thin rim of the mask opening shows the finish.
  a.ctx.fillStyle = RIM[finishMetal(boardFinish(b))]
  maskOpenings(a.ctx, input, side, input.project.rules.maskExpansion)
  a.ctx.fill()
  // Drawings on the mask layer are openings too, shown in the finish's colour.
  const maskShapes = drawingsOn(input.project, side === "top" ? "F.Mask" : "B.Mask")
  if (maskShapes.length) {
    a.ctx.save()
    a.ctx.strokeStyle = a.ctx.fillStyle
    drawShapes(a.ctx, maskShapes)
    a.ctx.restore()
  }
  drawTexts(a.ctx, input.project, side === "top" ? "F.Mask" : "B.Mask", () => (a.ctx.strokeStyle = a.ctx.fillStyle))

  // Surface: height + roughness
  const s = makeCanvas(w, h)
  s.ctx.fillStyle = `rgb(${H_LAMINATE},${R_MASK},0)`
  s.ctx.fillRect(0, 0, w, h)
  world(s.ctx)
  // Mask flows over copper edges, so soften the step.
  s.ctx.filter = blurPx(0.05)
  s.ctx.fillStyle = `rgb(${H_COPPER},${R_MASK},0)`
  s.ctx.strokeStyle = s.ctx.fillStyle
  drawCopper(s.ctx, input, side)
  s.ctx.filter = blurPx(0.015)
  s.ctx.globalCompositeOperation = "lighter"
  s.ctx.strokeStyle = `rgb(${H_SILK},${R_SILK - R_MASK},0)`
  for (const set of silkSets) strokePolylines(s.ctx, set.paths, set.width)
  if (silkShapes.length) {
    s.ctx.save()
    s.ctx.fillStyle = s.ctx.strokeStyle
    drawShapes(s.ctx, silkShapes)
    s.ctx.restore()
  }
  drawTexts(s.ctx, input.project, silkLayer, () => (s.ctx.fillStyle = s.ctx.strokeStyle))
  s.ctx.globalCompositeOperation = "source-over"
  s.ctx.filter = "none"

  return { albedo: toTexture(a.canvas, true, input.anisotropy), surface: toTexture(s.canvas, false, input.anisotropy) }
}

export function buildBoardTextures(input: TextureInput): BoardTextureSet {
  const b = input.project.board
  const ppm = texelsPerMm(b.width, b.height)
  const top = buildSide(input, "top", ppm)
  const bottom = buildSide(input, "bottom", ppm)
  return {
    top,
    bottom,
    dispose() {
      for (const t of [top.albedo, top.surface, bottom.albedo, bottom.surface]) t.dispose()
    },
  }
}
