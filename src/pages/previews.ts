import { computeConnectivity } from "../model/connectivity"
import { parseProjectFile } from "../model/projectFile"
import { boardPreviewSvg, previewFills } from "./boardPreviewSvg"
import type { PreviewReply, PreviewRequest } from "./preview.worker"

/**
 * Board previews for a projects page, as SVG text drawn in a worker: two downloads at a time, one drawing at a
 * time, once per project change and visit. Where there is no worker (tests) it draws on this thread.
 */

/** One preview: `file` is read only when this visit hasn't drawn the project at `updatedAt` yet. */
export interface PreviewSource {
  key: string
  updatedAt?: number
  file: () => Promise<string | null> | string | null
}

const drawn = new Map<string, { updatedAt?: number; svg: Promise<string | null> }>()

/** The preview of `source`, or `null` when it can't be read or drawn (the page shows nothing). */
export function boardPreview(source: PreviewSource): Promise<string | null> {
  const hit = drawn.get(source.key)
  if (hit && hit.updatedAt === source.updatedAt) return hit.svg
  const svg = downloads
    .run(async () => source.file())
    .then((file) => (file === null ? null : draw(source.key, file)))
    .catch(() => null)
  drawn.set(source.key, { updatedAt: source.updatedAt, svg })
  return svg
}

/** The preview this visit already drew for `key` at `updatedAt`, if any: nothing is downloaded or drawn. */
export function drawnPreview(key: string, updatedAt: number): Promise<string | null> | undefined {
  const hit = drawn.get(key)
  return hit?.updatedAt === updatedAt ? hit.svg : undefined
}

/** At most `limit` tasks at once, the rest in order. */
export function queue(limit: number) {
  let running = 0
  const waiting: (() => void)[] = []
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= limit) await new Promise<void>((go) => waiting.push(go))
      running++
      try {
        return await task()
      } finally {
        running--
        waiting.shift()?.()
      }
    },
  }
}
const downloads = queue(2)

let worker: Worker | null | undefined
const pending = new Map<string, { resolve: (svg: string) => void; reject: (e: Error) => void }>()

function draw(key: string, file: string): Promise<string> {
  if (worker === undefined) worker = startWorker()
  const w = worker
  if (!w) return Promise.resolve().then(() => drawHere(key, file))
  return new Promise((resolve, reject) => {
    pending.set(key, { resolve, reject })
    w.postMessage({ key, file } satisfies PreviewRequest)
  })
}

function startWorker(): Worker | null {
  if (typeof Worker === "undefined") return null
  // The literal `new Worker(new URL(..., import.meta.url))` is what the bundler looks for.
  const w = new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" })
  w.onmessage = (e: MessageEvent<PreviewReply>) => {
    const waiter = pending.get(e.data.key)
    pending.delete(e.data.key)
    if ("svg" in e.data) waiter?.resolve(e.data.svg)
    else waiter?.reject(new Error(e.data.error))
  }
  // A worker that dies (a board too big for its memory) fails what it was drawing, and the next preview starts a new one.
  w.onerror = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("The preview worker stopped."))
    pending.clear()
    w.terminate()
    worker = undefined
  }
  return w
}

function drawHere(key: string, file: string): string {
  const project = parseProjectFile(file, { id: key, createdAt: 0, updatedAt: 0 })
  return boardPreviewSvg(project, previewFills(project, computeConnectivity(project)))
}

/**
 * A preview as a WebP of a card's width at twice the pixels, to keep with the project; null without a page to draw on, or
 * past `MAX_THUMBNAIL_BYTES` (the hosted app's limit).
 */
export async function rasterize(svg: string): Promise<Blob | null> {
  if (typeof document === "undefined") return null
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement("canvas")
    canvas.width = 640
    canvas.height = Math.max(1, Math.round((640 * img.naturalHeight) / Math.max(1, img.naturalWidth)))
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/webp", 0.82))
    return blob && blob.size <= 256 * 1024 ? blob : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
