import { emptyBox, expandBox, round } from "../lib/geometry"
import { strokeText } from "../lib/strokeFont"
import type { BoardDef, BoardText, MountingHoles, SurfaceFinish, Vec2 } from "./types"

/** Solder mask green, the colour fabs make by default. */
export const DEFAULT_MASK_COLOR = "#1f6b3a"

const WHITE_SILK = "#f4f4f0"
const BLACK_SILK = "#1a1a1a"

/** Relative luminance of a #rrggbb colour, 0 to 1. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255)
}

/** Silkscreen a fab pairs with a mask colour: white, or black on a light mask such as white or yellow. */
export const defaultSilkColor = (mask: string) => (luminance(mask) > 0.35 ? BLACK_SILK : WHITE_SILK)

export function boardFinish(b: BoardDef): SurfaceFinish {
  return b.finish ?? "enig"
}

export const SURFACE_FINISHES: { value: SurfaceFinish; label: string; title: string }[] = [
  { value: "enig", label: "ENIG", title: "Electroless nickel, immersion gold: flat pads for fine pitch" },
  { value: "lf-hasl", label: "Lead-free HASL", title: "Hot-air solder levelled with lead-free solder" },
  { value: "hasl", label: "HASL", title: "Hot-air solder levelled with tin-lead solder" },
  { value: "osp", label: "OSP", title: "Organic coating over bare copper" },
]

/** What the pads look like: gold, solder-coated, or bare copper. */
export function finishMetal(f: SurfaceFinish): "gold" | "tin" | "copper" {
  return f === "enig" ? "gold" : f === "osp" ? "copper" : "tin"
}

export function boardColors(b: BoardDef): { mask: string; silk: string } {
  const mask = b.maskColor ?? DEFAULT_MASK_COLOR
  return { mask, silk: b.silkColor ?? defaultSilkColor(mask) }
}

export interface MountingHole extends Vec2 {
  id: string
  drill: number
  diameter: number
}

/** Corner mounting holes, skipped when the board is too small to hold them. */
export function mountingHoles(b: BoardDef): MountingHole[] {
  const m = b.mountingHoles
  if (!m) return []
  const halfW = b.width / 2 - m.inset
  const halfH = b.height / 2 - m.inset
  if (halfW < m.diameter / 2 || halfH < m.diameter / 2) return []
  return [
    { id: "mh-bl", x: b.x - halfW, y: b.y - halfH },
    { id: "mh-br", x: b.x + halfW, y: b.y - halfH },
    { id: "mh-tr", x: b.x + halfW, y: b.y + halfH },
    { id: "mh-tl", x: b.x - halfW, y: b.y + halfH },
  ].map((p) => ({ ...p, drill: m.drill, diameter: m.diameter }))
}

export const M3_HOLES = { drill: 3.2, diameter: 6, inset: 3.5 }

/** Corner holes for common screws: clearance drill, plated ring and edge inset. */
export const MOUNTING_HOLE_PRESETS: { id: string; label: string; holes: MountingHoles }[] = [
  { id: "m2", label: "M2", holes: { drill: 2.2, diameter: 4.4, inset: 2.8 } },
  { id: "m2.5", label: "M2.5", holes: { drill: 2.7, diameter: 5, inset: 3.2 } },
  { id: "m3", label: "M3", holes: M3_HOLES },
  { id: "m4", label: "M4", holes: { drill: 4.3, diameter: 8, inset: 4.5 } },
]

/** Silkscreen strokes for a board text, mirrored on the bottom so it reads from below. */
export function boardTextStrokes(t: BoardText): Vec2[][] {
  return strokeText(t.text, { x: t.x, y: t.y, size: t.size, rotation: t.rot, mirror: t.side === "bottom" })
}

export const boardTextStrokeWidth = (t: BoardText) => Math.max(0.15, t.size * 0.14)

/**
 * The outline of a rounded rectangle, counter-clockwise from the bottom right corner, each corner
 * in a few segments: what a board with rounded corners is in Circuit JSON, which has no radius.
 */
export function roundedOutline(minX: number, minY: number, maxX: number, maxY: number, r: number): Vec2[] {
  const steps = 6
  const corners: [number, number, number][] = [
    [maxX - r, minY + r, -90],
    [maxX - r, maxY - r, 0],
    [minX + r, maxY - r, 90],
    [minX + r, minY + r, 180],
  ]
  return corners.flatMap(([cx, cy, start]) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const a = ((start + (i * 90) / steps) * Math.PI) / 180
      return { x: round(cx + r * Math.cos(a)), y: round(cy + r * Math.sin(a)) }
    }),
  )
}

/** The corner radius of an outline that is a rounded rectangle of `roundedOutline`'s making, else null; 0 for a plain rectangle. */
export function outlineRadius(outline: Vec2[]): number | null {
  const b = emptyBox()
  for (const p of outline) expandBox(b, p)
  const near = (a: number, c: number) => Math.abs(a - c) < 1e-3
  if (outline.length <= 5 && outline.every((p) => (near(p.x, b.minX) || near(p.x, b.maxX)) && (near(p.y, b.minY) || near(p.y, b.maxY)))) return 0
  const onLeft = outline.filter((p) => near(p.x, b.minX)).map((p) => p.y - b.minY)
  const r = Math.min(...onLeft.filter((d) => d > 1e-3))
  if (!Number.isFinite(r)) return null
  const expected = roundedOutline(b.minX, b.minY, b.maxX, b.maxY, r)
  const same = expected.length === outline.length && expected.every((p, i) => Math.abs(p.x - outline[i].x) < 0.01 && Math.abs(p.y - outline[i].y) < 0.01)
  return same ? round(r) : null
}
