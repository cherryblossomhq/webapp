import type { Project } from "../../model/types"
import type { PixelSize } from "./limits"

// Turning a drawing into a picture the model can be sent. The only browser-dependent part is the
// `LookRenderer` (an SVG drawn on a canvas, the 3D scene drawn with WebGL); the byte cap and the
// encoding steps are plain code, and a test can install a renderer of its own.

export interface LookImage {
  mediaType: "image/png" | "image/jpeg"
  base64: string
  width: number
  height: number
  /** Encoded size, before base64. */
  bytes: number
}

/** What a canvas offers the encoder, so a fake can stand in for one. */
export interface DrawnCanvas {
  width: number
  height: number
  toDataURL(type?: string, quality?: number): string
}

export type Board3dView = "home" | "top" | "bottom"

export interface LookRenderer {
  /** Draw an SVG at `size` pixels and encode it under `maxBytes`. */
  svg(svg: string, size: PixelSize, maxBytes: number): Promise<LookImage>
  /** Draw the 3D board off screen from a preset view and encode it under `maxBytes`. */
  board3d(project: Project, view: Board3dView, size: PixelSize, maxBytes: number): Promise<LookImage>
}

let installed: LookRenderer | null | undefined
let browser: (() => Promise<LookRenderer>) | null = null

/** Use this renderer instead of the browser's, or none (`null`). Tests install a fake. */
export function setLookRenderer(renderer: LookRenderer | null | undefined) {
  installed = renderer
}

/**
 * Where the browser's renderer is loaded from, said by the editor's entry (`src/index.ts`) rather
 * than imported here: it draws the 3D board with three.js, and the tools that use this module also
 * run on a server (the hosted app's MCP server), whose bundle must not take the whole 3D scene, nor its React hooks.
 */
export function registerBrowserRenderer(load: () => Promise<LookRenderer>) {
  browser = load
}

/** The installed renderer, else the browser's when there is a page to draw on, else null. */
export async function lookRenderer(): Promise<LookRenderer | null> {
  if (installed !== undefined) return installed
  if (typeof document === "undefined" || !browser) return null
  return browser()
}

/** Bytes behind a base64 string. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0)

/** Redraw smaller each time the picture is still too heavy; a picture is never sent over the cap. */
export const SCALE_STEPS = [1, 0.8, 0.64, 0.5, 0.4] as const
/** After PNG, which is exact and best for drawings, JPEG at falling quality, for the photographic 3D view. */
export const JPEG_QUALITIES = [0.88, 0.72] as const

export function parseDataUrl(url: string): { mediaType: LookImage["mediaType"]; base64: string } | null {
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(url)
  return m ? { mediaType: m[1] as LookImage["mediaType"], base64: m[2] } : null
}

/**
 * Encode what `draw` makes at the largest scale whose picture fits `maxBytes`: PNG first, then
 * JPEG, then a smaller drawing. Throws when nothing fits, which only a canvas gone wrong does.
 */
export async function encodeWithinBytes(draw: (scale: number) => Promise<DrawnCanvas>, maxBytes: number): Promise<LookImage> {
  for (const scale of SCALE_STEPS) {
    const canvas = await draw(scale)
    const attempts: [string, number | undefined][] = [["image/png", undefined], ...JPEG_QUALITIES.map((q): [string, number] => ["image/jpeg", q])]
    for (const [type, quality] of attempts) {
      const parsed = parseDataUrl(canvas.toDataURL(type, quality))
      if (!parsed) continue
      const bytes = base64Bytes(parsed.base64)
      if (bytes <= maxBytes) return { ...parsed, width: canvas.width, height: canvas.height, bytes }
    }
  }
  throw new Error(`The picture could not be made smaller than ${Math.round(maxBytes / 1000)} KB.`)
}
