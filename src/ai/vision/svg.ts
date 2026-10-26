import type { Box } from "../../lib/geometry"
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
