import type { Box } from "../../lib/geometry"
import { PCB } from "../../editor/theme"
import { boardTextStrokes, boardTextStrokeWidth } from "../../model/board"
import { isPhysical, pcbCourtyard, pcbSilk, slotEnds, type WorldPad } from "../../model/instances"
import { findPart } from "../../model/library"
import { BOARD_OWNER } from "../../model/pcb"
import { designatorStrokes, getDesignators, SILK_WIDTH } from "../../model/silk"
import type { CopperLayer, Project } from "../../model/types"
import { getPcbAnalysis } from "../../store/analysis"
import type { PixelSize } from "./limits"
import type { PcbMeasure } from "./measure"
import { n, pts, svgDocument, text } from "./svg"

// The PCB as the editor draws it (EDA colours: red top, blue bottom, both opaque over a black
// board, the front layer on top), as an SVG string, so it can be drawn off screen. The pad, hole
// and label drawing follows `PcbEditor.tsx`.

export type PcbSide = "top" | "bottom" | "both"
export type PcbExtra = "silkscreen" | "courtyards" | "ratsnest" | "labels" | "pours"

export const PCB_EXTRAS: PcbExtra[] = ["silkscreen", "courtyards", "ratsnest", "labels", "pours"]
/** What is drawn when the model says nothing: everything but courtyards, which crowd the picture. */
export const DEFAULT_PCB_EXTRAS: PcbExtra[] = ["silkscreen", "ratsnest", "labels", "pours"]

export interface PcbViewOptions {
  side: PcbSide
  extras: ReadonlySet<PcbExtra>
}

const CHAR_W = 0.62

function pad(p: WorldPad, color: string, px: number): string {
  let shape: string
  if (p.shape === "circle") shape = `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.width / 2)}" fill="${color}"/>`
  else if (p.shape === "polygon" && p.points) shape = `<polygon points="${pts(p.points)}" fill="${color}"/>`
  else {
    const rr = p.shape === "pill" ? Math.min(p.width, p.height) / 2 : Math.min(p.width, p.height) * 0.12
    shape = `<rect x="${n(p.x - p.width / 2)}" y="${n(p.y - p.height / 2)}" width="${n(p.width)}" height="${n(p.height)}" rx="${n(rr)}" fill="${color}"/>`
  }
  if (!p.holeDiameter) return shape
  const d = p.holeDiameter
  const sw = Math.min(d * 0.12, Math.max(0.05, 1.2 * px))
  const ends = slotEnds(p)
  if (!ends) return shape + `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(d / 2)}" fill="${PCB.hole}" stroke="${PCB.plating}" stroke-width="${n(sw)}"/>`
  const [a, b] = ends
  return (
    shape +
    `<g stroke-linecap="round"><line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${PCB.plating}" stroke-width="${n(d + sw)}"/>` +
    `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${PCB.hole}" stroke-width="${n(d - sw)}"/></g>`
  )
}

/** Pad label: the pin name when it says more than the number, otherwise the pad number. */
function padLabel(p: WorldPad, names: Map<string, string>): string {
  const raw = p.pin ? names.get(`${p.componentId}:${p.pin}`) : undefined
  const name = raw?.split("/")[0].trim()
  if (name && name !== p.padNumber && !/^[~\d]*$/.test(name)) return name
  return p.padNumber ?? ""
}

function padLabels(items: ReturnType<typeof getPcbAnalysis>["items"], names: Map<string, string>, scale: number, front: CopperLayer, shown: ReadonlySet<CopperLayer>): string {
  // Big pads are labelled even with the whole board in view, as long as the text is legible.
  if (scale < 3) return ""
  let out = ""
  for (const it of items) {
    if (it.kind !== "pad" || it.pad.componentId === BOARD_OWNER) continue
    const p = it.pad
    if (p.layers.length === 1 && (p.layers[0] !== front || !shown.has(p.layers[0]))) continue
    const label = padLabel(p, names)
    if (!label) continue
    const fit = (along: number, across: number) => Math.min(across * 0.6, (along * 0.92) / Math.max(1, label.length) / CHAR_W)
    const d = Math.min(p.width, p.height)
    const across = fit(p.width, p.height)
    const upright = fit(p.height, p.width)
    const vertical = !p.holeDiameter && p.height > p.width * 1.15 && upright > across * 1.15
    const size = p.holeDiameter ? Math.min(d * 0.42, (d * 0.96) / Math.max(1, label.length) / CHAR_W) : vertical ? upright : across
    if (size * scale < 5.5) continue
    out += text(p.x, p.y, label, { fill: PCB.label, size, halo: PCB.labelHalo, weight: 650, mono: true, angle: vertical ? 90 : 0 })
  }
  return out
}

function outline(b: Box, color: string, px: number, grow = 0.2): string {
  return `<rect x="${n(b.minX - grow)}" y="${n(b.minY - grow)}" width="${n(b.maxX - b.minX + grow * 2)}" height="${n(b.maxY - b.minY + grow * 2)}" fill="none" stroke="${color}" stroke-width="${n(Math.max(0.1, 1.6 * px))}" stroke-dasharray="${n(5 * px)} ${n(3 * px)}"/>`
}

/** The board over `box` at `size` pixels. */
export function pcbSvg(project: Project, box: Box, size: PixelSize, opts: PcbViewOptions, m: PcbMeasure): string {
  const scale = size.width / (box.maxX - box.minX)
  const px = 1 / scale
  const pcb = getPcbAnalysis(project)
  const bd = project.board
  const board: Box = { minX: bd.x - bd.width / 2, maxX: bd.x + bd.width / 2, minY: bd.y - bd.height / 2, maxY: bd.y + bd.height / 2 }
  const r = Math.min(bd.cornerRadius, bd.width / 2, bd.height / 2)
  const shown: CopperLayer[] = opts.side === "both" ? ["bottom", "top"] : [opts.side]
  const shownSet = new Set(shown)
  const front: CopperLayer = opts.side === "bottom" ? "bottom" : "top"
  const placed = project.components.filter((c) => c.pcb.placed && isPhysical(findPart(c.partId)))
  const has = (x: PcbExtra) => opts.extras.has(x)

  let body = `<rect x="${n(board.minX)}" y="${n(board.minY)}" width="${n(bd.width)}" height="${n(bd.height)}" rx="${n(r)}" fill="${PCB.board}" stroke="${PCB.edge}" stroke-width="${n(Math.max(0.15, 2 * px))}"/>`

  for (const l of shown) {
    if (has("pours")) {
      for (const f of pcb.zoneFills) {
        if (f.layer !== l) continue
        const d = f.polygons.flatMap((poly) => poly.map((ring) => `M${ring.map((p) => `${n(p.x)},${n(p.y)}`).join("L")}Z`)).join("")
        if (d) body += `<path d="${d}" fill="${l === "top" ? PCB.topPour : PCB.bottomPour}" fill-rule="evenodd"/>`
      }
    }
    for (const t of project.traces) {
      if (t.layer !== l) continue
      body += `<polyline points="${pts(t.points)}" fill="none" stroke="${l === "top" ? PCB.topCopper : PCB.bottomCopper}" stroke-width="${n(t.width)}" stroke-linecap="round" stroke-linejoin="round"/>`
    }
    for (const it of pcb.items) {
      if (it.kind === "pad" && it.layers.length === 1 && it.layers[0] === l) body += pad(it.pad, l === front ? PCB.pad : PCB.padBack, px)
    }
  }
  for (const it of pcb.items) if (it.kind === "pad" && it.layers.length === 2) body += pad(it.pad, PCB.pad, px)
  for (const v of project.vias) {
    body += `<circle cx="${n(v.x)}" cy="${n(v.y)}" r="${n(v.diameter / 2)}" fill="${PCB.via}"/><circle cx="${n(v.x)}" cy="${n(v.y)}" r="${n(v.drill / 2)}" fill="${PCB.hole}"/>`
  }

  if (has("silkscreen")) {
    const designators = getDesignators(project)
    const line = (path: { x: number; y: number }[], color: string, width: number) =>
      `<polyline points="${pts(path)}" fill="none" stroke="${color}" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"/>`
    for (const c of placed) {
      if (!shownSet.has(c.pcb.side)) continue
      const color = c.pcb.side === "top" ? PCB.silk : PCB.silkBottom
      body += `<g opacity="${c.pcb.side === front ? 1 : 0.55}">`
      for (const path of pcbSilk(c)) body += line(path, color, SILK_WIDTH)
      const d = designators.get(c.id)
      if (d) for (const path of designatorStrokes(d)) body += line(path, color, SILK_WIDTH)
      body += "</g>"
    }
    for (const tx of project.texts ?? []) {
      if (!shownSet.has(tx.side)) continue
      for (const path of boardTextStrokes(tx)) body += line(path, tx.side === "top" ? PCB.silk : PCB.silkBottom, boardTextStrokeWidth(tx))
    }
  }

  if (has("labels")) {
    const names = new Map<string, string>()
    for (const c of project.components) for (const p of findPart(c.partId)?.pins ?? []) names.set(`${c.id}:${p.number}`, p.name)
    body += padLabels(pcb.items, names, scale, front, shownSet)
  }

  if (has("courtyards")) {
    for (const c of placed) {
      const cy = pcbCourtyard(c)
      if (!cy || !shownSet.has(c.pcb.side)) continue
      body += `<rect x="${n(cy.minX)}" y="${n(cy.minY)}" width="${n(cy.maxX - cy.minX)}" height="${n(cy.maxY - cy.minY)}" fill="none" stroke="${PCB.courtyard}" stroke-width="${n(1.2 * px)}"/>`
    }
  }

  // A part marked do not populate keeps a dashed courtyard even where courtyards are off, as in the editor.
  if (!has("courtyards")) {
    for (const c of placed) {
      const cy = c.flags?.dnp ? pcbCourtyard(c) : null
      if (cy && shownSet.has(c.pcb.side)) body += outline(cy, PCB.courtyard, px, 0)
    }
  }

  if (has("ratsnest")) {
    for (const rl of pcb.ratsnest) {
      body += `<line x1="${n(rl.a.x)}" y1="${n(rl.a.y)}" x2="${n(rl.b.x)}" y2="${n(rl.b.y)}" stroke="${PCB.ratsnest}" stroke-width="${n(px)}" stroke-dasharray="${n(5 * px)} ${n(3 * px)}"/>`
    }
  }

  // Check errors, as the editor marks them, and what the numbers name: overlaps and parts off the board.
  for (const v of pcb.violations) {
    if (v.severity !== "error" || v.kind === "net-conflict") continue
    body += `<circle cx="${n(v.at.x)}" cy="${n(v.at.y)}" r="${n(Math.max(0.35, 7 * px))}" fill="none" stroke="${PCB.danger}" stroke-width="${n(1.6 * px)}"/><circle cx="${n(v.at.x)}" cy="${n(v.at.y)}" r="${n(Math.max(0.08, 1.6 * px))}" fill="${PCB.danger}"/>`
  }
  for (const o of m.overlaps) body += outline(o.box, PCB.warn, px)
  for (const ref of m.offBoard) {
    const cy = placed.filter((c) => c.ref === ref).map(pcbCourtyard)[0]
    if (cy) body += outline(cy, PCB.danger, px)
  }
  return svgDocument(box, size, PCB.outside, body)
}
