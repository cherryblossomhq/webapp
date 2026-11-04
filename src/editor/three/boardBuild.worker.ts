import { parseProjectFile } from "../../model/projectFile"
import type { BoardPicture } from "./boardTextures"
import { shapesData, unpackFills, type BoardBuildReply, type BoardBuildRequest } from "./boardTransfer"
import { boardShapes } from "./buildBoard"

// A big board's 3D shapes and drawings, made off the page's thread (`BoardScene`). The drawings are made on offscreen canvases and go back as
// bitmaps, upside down: a bitmap is not turned on its way into a texture (`pictureTexture`).

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<BoardBuildRequest>) => void) | null
  postMessage: (reply: BoardBuildReply, moved: Transferable[]) => void
}

/** A drawing as a bitmap, drawn upside down onto a canvas of its own (`createImageBitmap`'s `imageOrientation` is not in every browser). */
const bitmap = async (picture: BoardPicture) => {
  const canvas = picture as OffscreenCanvas
  const turned = new OffscreenCanvas(canvas.width, canvas.height)
  const ctx = turned.getContext("2d")!
  ctx.setTransform(1, 0, 0, -1, 0, canvas.height)
  ctx.drawImage(canvas, 0, 0)
  // Reading a pixel waits here for the graphics process to finish the drawing, so the page's first frame of the board waits for less: on CERN's
  // Macbeth 1 s (its textures and buffers going in), where it waited 1.6 s.
  ctx.getImageData(0, 0, 1, 1)
  canvas.width = 0
  return turned.transferToImageBitmap()
}

scope.onmessage = async ({ data: { job, file, fills } }) => {
  try {
    const project = parseProjectFile(file, { id: "3d", createdAt: 0, updatedAt: 0 })
    const { data, moved } = await shapesData(boardShapes(project, unpackFills(fills)), bitmap)
    scope.postMessage({ job, shapes: data }, moved)
  } catch (err) {
    scope.postMessage({ job, error: err instanceof Error ? err.message : String(err) }, [])
  }
}
