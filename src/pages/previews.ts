import { computeConnectivity } from "../model/connectivity"
import { parseProjectFile } from "../model/projectFile"
import { boardPreviewSvg, previewFills } from "./boardPreviewSvg"
import type { PreviewReply, PreviewRequest } from "./preview.worker"

/**
 * Board previews for a projects page, as SVG text (`boardPreviewSvg`), drawn in a worker and kept.
 *
 * A stored project's preview is kept in this browser (IndexedDB) under its id with the time it was last
 * changed, so a project that hasn't changed since the last visit is neither downloaded nor drawn again:
 * a project can be 32 MB, and the page used to download every one in view on every visit.
 * Downloads go two at a time, and the worker draws one at a time, so a page of cards fills in steadily
 * instead of all at once. Where there is no worker (tests, an old browser) it draws on the page's thread.
 */

/** One preview: the project file comes from `file` only when no kept preview is current. */
export interface PreviewSource {
  key: string
  /** When the project last changed, for a stored project: its preview is kept in the browser under it. Absent: kept for the visit only. */
  updatedAt?: number
  file: () => Promise<string | null> | string | null
}

const memory = new Map<string, { updatedAt?: number; svg: Promise<string | null> }>()

/** The preview of `source`, or `null` when it can't be read or drawn (the page shows a placeholder). */
export function boardPreview(source: PreviewSource): Promise<string | null> {
  const hit = memory.get(source.key)
  if (hit && hit.updatedAt === source.updatedAt) return hit.svg
  const svg = make(source).catch(() => null)
  memory.set(source.key, { updatedAt: source.updatedAt, svg })
  return svg
}

/** The preview already drawn this visit for `key` as it was at `updatedAt`, if there is one: nothing is downloaded or drawn. */
export function drawnPreview(key: string, updatedAt: number): Promise<string | null> | undefined {
  const hit = memory.get(key)
  return hit && hit.updatedAt === updatedAt ? hit.svg : undefined
}

/** Forget a project's preview, here and in the browser: it was deleted. */
export function forgetPreview(key: string) {
  memory.delete(key)
  void kept.remove(key)
}

async function make(source: PreviewSource): Promise<string | null> {
  if (source.updatedAt !== undefined) {
    const old = await kept.get(source.key)
    if (old && old.updatedAt === source.updatedAt) return old.svg
  }
  const file = await downloads.run(async () => source.file())
  if (file === null) return null
  const svg = await draw(source.key, file)
  if (source.updatedAt !== undefined && svg.length < KEEP_LIMIT) void kept.set(source.key, { updatedAt: source.updatedAt, svg })
  return svg
}

/** A preview this long (a board of thousands of parts) is drawn each visit rather than kept. */
const KEEP_LIMIT = 4_000_000

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

// ---------- A picture to keep ----------

/** The width of a kept picture: twice a card's, for sharp screens. */
const PICTURE_WIDTH = 640
/** Kept pictures stay under the server's limit (the hosted app's, 256 KB). */
const PICTURE_BYTES = 240 * 1024

/**
 * A preview as a small WebP (PNG where the browser can't write WebP) to keep with the project, or null where
 * there is no page to draw it on, or it can't be made small enough. Drawn from the SVG once, off the critical
 * path: the browser decodes the SVG as an image, and one canvas draw rasterises it.
 */
export async function rasterize(svg: string): Promise<Blob | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const box = /viewBox="[^"]*?([\d.]+) ([\d.]+)"/.exec(svg)
    const aspect = box ? Number(box[2]) / Number(box[1]) : 0.75
    for (const width of [PICTURE_WIDTH, PICTURE_WIDTH * 0.75]) {
      const canvas = document.createElement("canvas")
      canvas.width = Math.round(width)
      canvas.height = Math.max(1, Math.round(width * (Number.isFinite(aspect) && aspect > 0 ? Math.min(aspect, 3) : 0.75)))
      const g = canvas.getContext("2d")
      if (!g) return null
      g.drawImage(img, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/webp", 0.82))
      if (blob && blob.size <= PICTURE_BYTES) return blob
    }
    return null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ---------- Drawing ----------

let worker: Worker | null | undefined
const pending = new Map<string, { resolve: (svg: string) => void; reject: (e: Error) => void }[]>()

function previewWorker(): Worker | null {
  if (worker !== undefined) return worker
  if (typeof Worker === "undefined") return (worker = null)
  try {
    // The literal `new Worker(new URL(..., import.meta.url))` is what the bundler looks for.
    worker = new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" })
  } catch {
    return (worker = null)
  }
  worker.onmessage = (e: MessageEvent<PreviewReply>) => {
    const waiters = pending.get(e.data.key) ?? []
    pending.delete(e.data.key)
    for (const w of waiters) "svg" in e.data ? w.resolve(e.data.svg) : w.reject(new Error(e.data.error))
  }
  worker.onerror = () => {
    // A worker that dies (a board too big for its memory, say) fails what it was asked, which shows placeholders, and the next
    // preview starts a new one. Never the page's thread: that is the freeze this file exists to avoid.
    for (const waiters of pending.values()) for (const w of waiters) w.reject(new Error("The preview worker stopped."))
    pending.clear()
    worker?.terminate()
    worker = undefined
  }
  return worker
}

function draw(key: string, file: string): Promise<string> {
  const w = previewWorker()
  if (!w) return Promise.resolve().then(() => drawHere(key, file))
  return new Promise<string>((resolve, reject) => {
    const waiters = pending.get(key)
    if (waiters) waiters.push({ resolve, reject })
    else {
      pending.set(key, [{ resolve, reject }])
      w.postMessage({ key, file } satisfies PreviewRequest)
    }
  })
}

/** What the worker does, on this thread. */
export function drawHere(key: string, file: string): string {
  const project = parseProjectFile(file, { id: key, createdAt: 0, updatedAt: 0 })
  return boardPreviewSvg(project, previewFills(project, computeConnectivity(project)))
}

// ---------- Kept in the browser ----------

interface Kept {
  updatedAt: number
  svg: string
}

const DB = "cherryblossom-previews"
const STORE = "previews"

let db: Promise<IDBDatabase | null> | undefined

function openDb(): Promise<IDBDatabase | null> {
  if (db) return db
  db = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null)
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      // Private windows and blocked site data refuse storage; previews are then drawn each visit.
      resolve(null)
    }
  })
  return db
}

function request<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDb().then(
    (d) =>
      new Promise<T | undefined>((resolve) => {
        if (!d) return resolve(undefined)
        try {
          const req = act(d.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

const kept = {
  get: (key: string) =>
    request<Kept | undefined>("readonly", (s) => s.get(key) as IDBRequest<Kept | undefined>).then((v) =>
      v && typeof v.updatedAt === "number" && typeof v.svg === "string" ? v : undefined,
    ),
  set: (key: string, value: Kept) => request("readwrite", (s) => s.put(value, key)),
  remove: (key: string) => request("readwrite", (s) => s.delete(key)),
}
