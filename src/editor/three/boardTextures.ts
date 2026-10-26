import * as THREE from "three"
import { boardColors, boardFinish, boardTextStrokes, boardTextStrokeWidth, finishMetal, mountingHoles } from "../../model/board"
import { isNpth, pcbCourtyard, pcbSilk, type WorldPad } from "../../model/instances"
import { designatorStrokes, getDesignators, SILK_WIDTH } from "../../model/silk"
import type { ZoneFill } from "../../model/pour"
import type { ComponentInstance, CopperLayer, Project, Vec2 } from "../../model/types"

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
  /** sRGB colour: mask, copper seen through the mask, silkscreen, baked contact shadows. */
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
  if (pad.shape === "polygon" && pad.points && pad.points.length >= 3) {
    ctx.moveTo(pad.points[0].x, pad.points[0].y)
    for (const p of pad.points.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
    return
  }
  const r = pad.shape === "pill" ? Math.min(w, h) / 2 : Math.min(w, h) * 0.12
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
    for (const p of pads) if (p.layers.includes(layer) && !isNpth(p)) padPath(ctx, p)
  }
  for (const v of project.vias) {
    ctx.moveTo(v.x + v.diameter / 2, v.y)
    ctx.arc(v.x, v.y, v.diameter / 2, 0, Math.PI * 2)
  }
  for (const h of mountingHoles(project.board)) {
    ctx.moveTo(h.x + h.diameter / 2, h.y)
    ctx.arc(h.x, h.y, h.diameter / 2, 0, Math.PI * 2)
  }
  ctx.fill()
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
  for (const t of input.project.texts ?? []) {
    if (t.side === side && t.text.trim()) out.push({ paths: boardTextStrokes(t), width: boardTextStrokeWidth(t) })
  }
  return out
}

/** Openings over plated copper; non-plated holes are bare drills with no finish to show. */
function maskOpenings(ctx: CanvasRenderingContext2D, input: TextureInput, side: CopperLayer, grow: number) {
  ctx.beginPath()
  for (const pads of input.padsByComponent.values()) {
    for (const p of pads) if (p.layers.includes(side) && !isNpth(p)) padPath(ctx, p, grow)
  }
  const rings = [...mountingHoles(input.project.board), ...(input.project.rules.tentVias ? [] : input.project.vias)]
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

  // Contact shadows where bodies sit close to the board.
  a.ctx.save()
  a.ctx.filter = blurPx(0.55)
  a.ctx.fillStyle = "rgba(0,0,0,0.32)"
  a.ctx.beginPath()
  for (const c of input.placed) {
    if (c.pcb.side !== side) continue
    const box = pcbCourtyard(c)
    if (!box) continue
    const bw = (box.maxX - box.minX) * 0.82
    const bh = (box.maxY - box.minY) * 0.82
    const cx = (box.minX + box.maxX) / 2
    const cy = (box.minY + box.maxY) / 2
    a.ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, Math.min(bw, bh) * 0.2)
  }
  a.ctx.fill()
  a.ctx.restore()

  const silkSets = silkStrokes(input, side)
  a.ctx.strokeStyle = silk
  for (const s of silkSets) strokePolylines(a.ctx, s.paths, s.width)

  // Exposed pads are separate metal meshes; the thin rim of the mask opening shows the finish.
  a.ctx.fillStyle = RIM[finishMetal(boardFinish(b))]
  maskOpenings(a.ctx, input, side, input.project.rules.maskExpansion)
  a.ctx.fill()

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
