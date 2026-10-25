import { orientPoint, type Box } from "../../lib/geometry"
import type { Mirror, Rotation, TextAnchor } from "../../model/types"
import type { PixelSize } from "./limits"

// Small helpers the picture renderers share: SVG as strings, in the editor's world space (y up).
// The renderers return text rather than React elements so they run anywhere, tests included, and
// only turning the SVG into pixels needs a browser.

export const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
export const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/** A number as short SVG text: four decimals is far below a pixel at any zoom the pictures use. */
export const n = (v: number) => String(Math.round(v * 10000) / 10000)

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export const pts = (points: { x: number; y: number }[]) => points.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")

/** Attributes as ` name="value"`, leaving out the undefined ones. */
export function attrs(a: Record<string, string | number | undefined>): string {
  let out = ""
  for (const [k, v] of Object.entries(a)) if (v !== undefined) out += ` ${k}="${typeof v === "number" ? n(v) : esc(v)}"`
  return out
}

export interface TextOptions {
  fill: string
  size: number
  /** Which way the text extends from its point, in world axes (as the editor's `WorldText`). */
  extent?: { x: number; y: number }
  vertical?: boolean
  weight?: number
  mono?: boolean
  /** A dark halo painted under the text, as on the PCB. */
  halo?: string
  /** Degrees counter-clockwise, in world space. */
  angle?: number
  italic?: boolean
}

/** World-space text, upright on screen: the same anchoring rules as the editor's `WorldText`. */
export function text(x: number, y: number, value: string, o: TextOptions): string {
  const ext = o.extent ?? { x: 0, y: 0 }
  const forward = o.vertical ? ext.y : ext.x
  const up = o.vertical ? -ext.x : ext.y
  const anchor = forward > 0 ? "start" : forward < 0 ? "end" : "middle"
  const baseline = up > 0 ? "text-after-edge" : up < 0 ? "text-before-edge" : "central"
  const turn = o.vertical ? " rotate(-90)" : o.angle ? ` rotate(${n(-o.angle)})` : ""
  return (
    `<text transform="translate(${n(x)},${n(y)}) scale(1,-1)${turn}"` +
    attrs({
      "font-size": o.size,
      "text-anchor": anchor,
      "dominant-baseline": baseline,
      fill: o.fill,
      "font-weight": o.weight ?? 500,
      "font-style": o.italic ? "italic" : undefined,
      "font-family": o.mono ? MONO : SANS,
      stroke: o.halo,
      "stroke-width": o.halo ? o.size * 0.24 : undefined,
      "stroke-linejoin": o.halo ? "round" : undefined,
      "paint-order": o.halo ? "stroke" : undefined,
    }) +
    `>${esc(value)}</text>`
  )
}

/** The outer element: a viewBox over `box` (world, y up) drawn at `size` pixels. Content is in world space. */
export function svgDocument(box: Box, size: PixelSize, background: string, body: string): string {
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  // The viewBox holds the world flipped: y runs down on the screen, so the content group flips it back.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${n(box.minX)} ${n(-box.maxY)} ${n(w)} ${n(h)}">` +
    `<rect x="${n(box.minX)}" y="${n(-box.maxY)}" width="${n(w)}" height="${n(h)}" fill="${background}"/>` +
    `<g transform="scale(1,-1)">${body}</g></svg>`
  )
}

/**
 * Text of an imported symbol on the sheet. Its angle and justification are in the symbol's own
 * frame; the symbol is turned and mirrored, and the text follows, but is kept readable as KiCad
 * keeps it: across or upward, never upside down. When the way it reads flips, its justification flips with it.
 * The anchor is where the point sits on the text (`middle_left` is at the left end), as `TextAnchor` says.
 */
export function orientText(angle: number, anchor: TextAnchor, sch: { rot: Rotation; mirror?: Mirror }): { angle: 0 | 90; anchor: TextAnchor } {
  const a = (angle * Math.PI) / 180
  const sn = (v: number) => (Math.abs(v) < 0.5 ? 0 : Math.sign(v))
  const turn = (p: { x: number; y: number }) => {
    const q = orientPoint(p, sch.rot, sch.mirror)
    return { x: sn(q.x), y: sn(q.y) }
  }
  let f = turn({ x: Math.cos(a), y: Math.sin(a) })
  let u = turn({ x: -Math.sin(a), y: Math.cos(a) })
  let [ax, ay] = ANCHOR_AXES[anchor]
  if (f.x < 0 || (f.x === 0 && f.y < 0)) {
    f = { x: -f.x, y: -f.y }
    u = { x: -u.x, y: -u.y }
    ax = -ax
    ay = -ay
  }
  // A mirror turns the text's up the other way round from the way its direction says.
  if (u.x * -f.y + u.y * f.x < 0) ay = -ay
  return { angle: f.x ? 0 : 90, anchor: anchorFromAxes(ax, ay) }
}

/** Where the point sits on the text, along its direction then its up: -1 at the start or the bottom, 1 at the end or the top. */
const ANCHOR_AXES: Record<TextAnchor, [number, number]> = {
  middle: [0, 0],
  center: [0, 0],
  middle_left: [-1, 0],
  middle_right: [1, 0],
  middle_top: [0, 1],
  middle_bottom: [0, -1],
  top_left: [-1, 1],
  top_right: [1, 1],
  bottom_left: [-1, -1],
  bottom_right: [1, -1],
}

export function anchorFromAxes(ax: number, ay: number): TextAnchor {
  if (!ax && !ay) return "center"
  if (!ay) return ax < 0 ? "middle_left" : "middle_right"
  if (!ax) return ay > 0 ? "middle_top" : "middle_bottom"
  return `${ay > 0 ? "top" : "bottom"}_${ax < 0 ? "left" : "right"}` as TextAnchor
}

/** The anchor of a KiCad justification: `h` left or right, `v` top or bottom, absent centred. */
export const justifyAnchor = (h: "left" | "right" | undefined, v: "top" | "bottom" | undefined): TextAnchor => anchorFromAxes(h === "left" ? -1 : h === "right" ? 1 : 0, v === "top" ? 1 : v === "bottom" ? -1 : 0)

/** The KiCad justification of an anchor: left or right, top or bottom, absent centred. */
export function justifyOf(anchor: TextAnchor): { h?: "left" | "right"; v?: "top" | "bottom" } {
  const [ax, ay] = ANCHOR_AXES[anchor]
  return { ...(ax < 0 ? { h: "left" as const } : ax > 0 ? { h: "right" as const } : {}), ...(ay > 0 ? { v: "top" as const } : ay < 0 ? { v: "bottom" as const } : {}) }
}
