import { useEffect, useState } from "react"
import { encodeBase64 } from "../lib/imageFacts"
import type { Project, ReferenceImage } from "../model/types"
import { modelFiles } from "./modelFiles"
import { projectApi } from "./projectStore"

// The bytes of a project's reference images, which the project names by the SHA-256 of their bytes and does not hold: the host keeps them
// in the same file store as the 3D model files (`store/modelFiles.ts`), once per account however many projects use them. This reads each
// one once and keeps it for the page, so the PCB view, Sakura's picture and the export all draw from the same copy. A file the store does
// not have (a project opened on another account, a store that is down) is drawn as an empty frame that says so, and said in the Inspector.

type Entry = { state: "loading" } | { state: "ready"; bytes: ArrayBuffer; url?: string } | { state: "missing"; why: string }

const entries = new Map<string, Entry>()
const loads = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const tell = () => listeners.forEach((l) => l())

const MIME = { png: "image/png", jpg: "image/jpeg" } as const

/** Keeps bytes the page already has (an image just added or imported), so it draws at once and is not fetched again. */
export function rememberImage(id: string, bytes: ArrayBuffer) {
  entries.set(id, { state: "ready", bytes })
  tell()
}

/** Reads a file from the host's store, once. Resolves when it is read or known to be missing; never rejects. */
export function loadImage(id: string): Promise<void> {
  const known = entries.get(id)
  if (known && known.state !== "loading") return Promise.resolve()
  const running = loads.get(id)
  if (running) return running
  entries.set(id, { state: "loading" })
  const store = modelFiles()
  const run = (async () => {
    if (!store) {
      entries.set(id, { state: "missing", why: "Files aren't available here." })
      return
    }
    try {
      // On a shared project the file is often a collaborator's, kept in their account: the project is what lets the store find it.
      const bytes = await store.get(id, undefined, projectApi().project?.id)
      entries.set(id, bytes ? { state: "ready", bytes } : { state: "missing", why: "This image's file isn't in this account, or in the account of anyone this project is shared with." })
    } catch (e) {
      entries.set(id, { state: "missing", why: e instanceof Error ? e.message : "The image's file could not be read." })
    }
  })().finally(() => {
    loads.delete(id)
    tell()
  })
  loads.set(id, run)
  return run
}

/** Keeps a file with the host, and the bytes for this page. Resolves to the file's id, which is the SHA-256 of its bytes. */
export async function putImageFile(name: string, bytes: ArrayBuffer): Promise<string> {
  const store = modelFiles()
  if (!store) throw new Error("Files aren't available here.")
  const id = await store.put({ name, bytes })
  rememberImage(id, bytes)
  return id
}

/** Loads every image of a project that is not loaded yet, for a picture or an export that wants them all. */
export async function preloadImages(project: Pick<Project, "images">): Promise<void> {
  await Promise.all((project.images ?? []).map((m) => loadImage(m.file)))
}

/** What the page knows about an image file: loading, the bytes, or why it is missing. */
export function imageState(id: string): Entry | undefined {
  return entries.get(id)
}

/** The bytes of an image the page has, or null. */
export function imageBytes(id: string): ArrayBuffer | null {
  const e = entries.get(id)
  return e?.state === "ready" ? e.bytes : null
}

/** An address the browser draws the image from, made once per file. Null while it is not loaded. */
export function imageUrl(m: Pick<ReferenceImage, "file" | "format">): string | null {
  const e = entries.get(m.file)
  if (e?.state !== "ready") return null
  if (!e.url) e.url = URL.createObjectURL(new Blob([e.bytes], { type: MIME[m.format] }))
  return e.url
}

/** The image as a `data:` address, which a picture handed to another renderer carries inside it. Null while it is not loaded. */
export function imageDataUri(m: Pick<ReferenceImage, "file" | "format">): string | null {
  const bytes = imageBytes(m.file)
  return bytes ? `data:${MIME[m.format]};base64,${encodeBase64(new Uint8Array(bytes))}` : null
}

/** Starts loading a project's images and redraws the component as each arrives. */
export function useImages(images: ReferenceImage[] | undefined) {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  useEffect(() => {
    for (const m of images ?? []) void loadImage(m.file)
  }, [images])
}
