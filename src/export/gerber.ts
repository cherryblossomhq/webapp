import { boardTextStrokes, boardTextStrokeWidth, mountingHoles } from "../model/board"
import { isNpth, isPhysical, pcbPads, pcbSilk, type WorldPad } from "../model/instances"
import { designatorStrokes, placeDesignators, SILK_WIDTH } from "../model/silk"
import { findPart } from "../model/library"
import type { ZoneFill } from "../model/pour"
import type { CopperLayer, PcbSide, Project, Vec2 } from "../model/types"

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

class GerberWriter {
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

function flashPad(w: GerberWriter, pad: WorldPad, grow = 0) {
  const width = pad.width + grow * 2
  const height = pad.height + grow * 2
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
        w.region(pad.points)
        // Grow polygons by tracing their outline with a round aperture.
        if (grow > 0) w.stroke([...pad.points, pad.points[0]], grow * 2)
        return
      }
      w.flashRect(pad, width, height)
      return
    default:
      w.flashRect(pad, width, height)
  }
}

const physicalComponents = (project: Project) => project.components.filter((c) => isPhysical(findPart(c.partId)))

/** Component pads (including non-plated holes) plus the plated corner mounting holes. */
const padsOn = (project: Project, layer: CopperLayer): WorldPad[] => [
  ...physicalComponents(project)
    .flatMap((c) => pcbPads(c))
    .filter((pad) => pad.layers.includes(layer)),
  ...mountingHoles(project.board).map(
    (h): WorldPad => ({
      componentId: "#board",
      pin: null,
      padNumber: null,
      shape: "circle",
      x: h.x,
      y: h.y,
      width: h.diameter,
      height: h.diameter,
      holeDiameter: h.drill,
      layers: ["top", "bottom"],
    }),
  ),
]

const sideName = (side: PcbSide) => (side === "top" ? "Top" : "Bot")

/** Area enclosed by a ring, whichever way it winds. */
const ringArea = (ring: Vec2[]) => {
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  return Math.abs(twice) / 2
}

/**
 * Copper layer. Pours go first: each fill is a dark region with its holes cleared, and the
 * pads and traces drawn afterwards are dark again, so clearing never erases them.
 *
 * A clear region erases everything already drawn beneath it, not just its own polygon's copper,
 * so the pour polygons go largest first: an island inside another polygon's hole (or another
 * zone's) is always smaller, so it lands after the hole that would otherwise wipe it.
 */
export function gerberCopper(project: Project, layer: CopperLayer, fills: ZoneFill[] = []): string {
  const w = new GerberWriter()
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
  for (const pad of padsOn(project, layer)) if (!isNpth(pad)) flashPad(w, pad)
  for (const t of project.traces) if (t.layer === layer) w.stroke(t.points, t.width)
  for (const v of project.vias) w.flashCircle(v, v.diameter)
  return w.toString(`Copper,L${layer === "top" ? 1 : 2},${sideName(layer)}`)
}

/** Mask openings: pads and non-plated holes grown by the mask expansion, and vias unless they're tented. */
export function gerberMask(project: Project, side: PcbSide): string {
  const w = new GerberWriter()
  const grow = project.rules.maskExpansion
  for (const pad of padsOn(project, side)) flashPad(w, pad, grow)
  if (!project.rules.tentVias) for (const v of project.vias) w.flashCircle(v, v.diameter + grow * 2)
  return w.toString(`Soldermask,${sideName(side)}`, "Negative")
}

/** Stencil apertures for SMD pads, grown or shrunk by the paste expansion. Every part has its paste, do not populate parts too, as KiCad plots it. */
export function gerberPaste(project: Project, side: PcbSide): string {
  const w = new GerberWriter()
  for (const pad of padsOn(project, side)) if (pad.holeDiameter === undefined) flashPad(w, pad, project.rules.pasteExpansion)
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
  for (const t of project.texts ?? []) {
    if (t.side !== side) continue
    for (const stroke of boardTextStrokes(t)) w.stroke(stroke, boardTextStrokeWidth(t))
  }
  return w.toString(`Legend,${sideName(side)}`)
}

/** Board outline as a rounded rectangle traced counter-clockwise. */
export function gerberEdgeCuts(project: Project): string {
  const w = new GerberWriter()
  const b = project.board
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
  return w.toString("Profile,NP")
}

export type GerberLayerName =
  | "F_Cu"
  | "B_Cu"
  | "F_Mask"
  | "B_Mask"
  | "F_Silkscreen"
  | "B_Silkscreen"
  | "F_Paste"
  | "B_Paste"
  | "Edge_Cuts"

export function gerberLayers(project: Project, fills: ZoneFill[] = []): Record<GerberLayerName, string> {
  return {
    F_Cu: gerberCopper(project, "top", fills),
    B_Cu: gerberCopper(project, "bottom", fills),
    F_Mask: gerberMask(project, "top"),
    B_Mask: gerberMask(project, "bottom"),
    F_Silkscreen: gerberSilkscreen(project, "top"),
    B_Silkscreen: gerberSilkscreen(project, "bottom"),
    F_Paste: gerberPaste(project, "top"),
    B_Paste: gerberPaste(project, "bottom"),
    Edge_Cuts: gerberEdgeCuts(project),
  }
}
