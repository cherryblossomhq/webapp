import type { MeshData } from "./meshData"

// The STEP reader's worker, started on first use and kept for the page: OpenCascade takes a
// moment to start, and a board's models are read one after another.

let worker: Worker | null = null
let next = 0
const pending = new Map<number, { resolve: (m: MeshData[]) => void; reject: (e: Error) => void }>()

function start(): Worker {
  const w = new Worker(new URL("./step.worker.ts", import.meta.url), { type: "module" })
  w.onmessage = (e: MessageEvent<{ id: number; meshes?: MeshData[]; error?: string }>) => {
    const job = pending.get(e.data.id)
    if (!job) return
    pending.delete(e.data.id)
    if (e.data.meshes) job.resolve(e.data.meshes)
    else job.reject(new Error(e.data.error || "This STEP file couldn't be read."))
  }
  w.onerror = (e) => {
    // The worker itself failed (its WebAssembly didn't load, say): every waiting read fails with it.
    e.preventDefault()
    const error = new Error("The STEP reader couldn't start in this browser.")
    for (const job of pending.values()) job.reject(error)
    pending.clear()
    w.terminate()
    if (worker === w) worker = null
  }
  return w
}

/** Triangulate a STEP file in the worker. The bytes are transferred, so the caller's copy is emptied. */
export function readStepInWorker(bytes: ArrayBuffer): Promise<MeshData[]> {
  worker ??= start()
  const id = ++next
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, bytes }, [bytes])
  })
}
