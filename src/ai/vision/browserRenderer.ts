import { getZoneFills } from "../../store/analysis"
import { BoardScene } from "../../editor/three/boardScene"
import { encodeWithinBytes, type Board3dView, type LookImage, type LookRenderer } from "./encode"
import type { PixelSize } from "./limits"

// The browser half of looking: an SVG drawn on a canvas, and the 3D board drawn by a scene of its
// own in a box off screen. Neither touches the page the user is looking at: no view changes, no
// camera moves, and the scene and its WebGL context are gone when the picture is made.

function loadImage(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }))
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("The drawing could not be turned into a picture."))
    }
    img.src = url
  })
}

function svg(source: string, size: PixelSize, maxBytes: number): Promise<LookImage> {
  let image: Promise<HTMLImageElement> | null = null
  return encodeWithinBytes(async (scale) => {
    image ??= loadImage(source)
    const img = await image
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(size.width * scale))
    canvas.height = Math.max(1, Math.round(size.height * scale))
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("This browser can't draw the picture.")
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  }, maxBytes)
}

async function board3d(project: Parameters<LookRenderer["board3d"]>[0], view: Board3dView, size: PixelSize, maxBytes: number): Promise<LookImage> {
  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${size.width}px;height:${size.height}px;pointer-events:none;`
  document.body.appendChild(host)
  let scene: BoardScene | null = null
  try {
    try {
      scene = new BoardScene(host, null)
    } catch {
      throw new Error("The 3D view needs WebGL, and this browser has it turned off.")
    }
    scene.setProject(project, getZoneFills(project))
    // Real model files the user's own view has read are drawn at once; others get a moment.
    await scene.modelsReady(4000)
    scene.view(view, false)
    // The scene is drawn once per scale: it is gone before the encoder asks for another.
    const live = scene
    return await encodeWithinBytes(async (scale) => live.capture(Math.round(size.width * scale)), maxBytes)
  } finally {
    scene?.dispose()
    host.remove()
  }
}

export const browserRenderer: LookRenderer = { svg, board3d }
