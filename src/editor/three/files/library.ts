import { useSyncExternalStore } from "react"
import type * as THREE from "three"
import { supplierParts } from "../../../ai/supplierParts"
import { modelFileKey } from "../../../model/models3d"
import type { Model3D, Model3DFormat } from "../../../model/types"
import { MAX_MODEL_FILE_BYTES, modelFiles } from "../../../store/modelFiles"
import { projectApi, useProjectStore } from "../../../store/projectStore"

// The model files the 3D view has read, for the page: a file is fetched and read once however many
// parts, boards and views use it, and every part is a cheap copy sharing its geometry. A part
// whose file isn't read yet shows only its pads, and is drawn when it is.

/** The format the 3D view draws: a supplier model's mesh, since its STEP is the slow, exact copy. */
export const drawnFormat = (m: Model3D): Model3DFormat => (m.source === "supplier" ? "obj" : m.format)

/** A file's bytes from wherever the host keeps it, in the format asked for. */
export async function fetchModelBytes(m: Model3D, format: Model3DFormat = drawnFormat(m), signal?: AbortSignal): Promise<ArrayBuffer> {
  let bytes: ArrayBuffer | null
  if (m.source === "supplier") {
    const source = supplierParts()
    if (!source?.model) throw new Error("Supplier models aren't available here.")
    if (format !== "obj" && format !== "step") throw new Error(`The supplier has no ${format} file of this model.`)
    bytes = await source.model(m.id, format, signal)
  } else if (m.source === "kicad") {
    const index = supplierParts()?.index
    if (!index?.model) throw new Error("KiCad's 3D models aren't available here.")
    if (format !== "step") throw new Error(`KiCad's library has no ${format} file of this model.`)
    bytes = await index.model(m.id, signal)
  } else {
    const store = modelFiles()
    if (!store) throw new Error("Model files aren't available here.")
    bytes = await store.get(m.id, signal, projectApi().project?.id)
    if (!bytes) throw new Error(`${m.name} isn't in this account, or in the account of anyone this project is shared with. Add the file again.`)
  }
  if (bytes.byteLength > MAX_MODEL_FILE_BYTES) throw new Error(`${m.name} is over ${MAX_MODEL_FILE_BYTES / 1024 / 1024} MB.`)
  return bytes
}

type Entry = { state: "loading" } | { state: "ready"; object: THREE.Group } | { state: "failed"; error: string }

/**
 * A file's meshes, from bytes in hand or fetched. A STEP file is triangulated once per browser:
 * after that its triangles come from the cache, and the file isn't even fetched.
 */
async function readModel(m: Model3D, given?: ArrayBuffer): Promise<THREE.Group> {
  // The readers and three.js come with the first file read: the Inspector uses this module too,
  // and the editor's first load shouldn't carry a 3D engine.
  const [{ parseModelFile }, { meshDataGroup }, { readStepInWorker }, { cacheMeshes, cachedMeshes }] = await Promise.all([
    import("./formats"),
    import("./meshData"),
    import("./step"),
    import("./stepCache"),
  ])
  const format = drawnFormat(m)
  if (format !== "step") return parseModelFile(format, given ?? (await fetchModelBytes(m)))
  const cached = await cachedMeshes(m.id)
  if (cached) return meshDataGroup(cached)
  const meshes = await readStepInWorker(given ?? (await fetchModelBytes(m)))
  void cacheMeshes(m.id, meshes)
  return meshDataGroup(meshes)
}

export class ModelLibrary {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()

  private key = (m: Model3D) => `${modelFileKey(m)}:${drawnFormat(m)}`

  /** Called whenever a file finishes loading or fails. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  state(m: Model3D): Entry["state"] | "idle" {
    return this.entries.get(this.key(m))?.state ?? "idle"
  }

  error(m: Model3D): string | null {
    const e = this.entries.get(this.key(m))
    return e?.state === "failed" ? e.error : null
  }

  /** The file's meshes if they are read, in the file's own frame. */
  peek(m: Model3D): THREE.Group | null {
    const e = this.entries.get(this.key(m))
    return e?.state === "ready" ? e.object : null
  }

  /** Start reading a file unless it is read, being read, or has failed. */
  request(m: Model3D) {
    const key = this.key(m)
    if (this.entries.has(key)) return
    const loading: Entry = { state: "loading" }
    this.entries.set(key, loading)
    void readModel(m).then(
      (object) => this.settle(key, loading, { state: "ready", object }),
      (error: unknown) => this.settle(key, loading, { state: "failed", error: error instanceof Error ? error.message : String(error) }),
    )
  }

  /** Read a file from bytes in hand (one just added), so it isn't fetched back from where it was put. */
  prime(m: Model3D, bytes: ArrayBuffer): Promise<THREE.Group> {
    const key = this.key(m)
    const e = this.entries.get(key)
    if (e?.state === "ready") return Promise.resolve(e.object)
    const loading: Entry = { state: "loading" }
    this.entries.set(key, loading)
    this.emit()
    return readModel(m, bytes).then(
      (object) => {
        this.settle(key, loading, { state: "ready", object })
        return object
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.settle(key, loading, { state: "failed", error: message })
        throw new Error(message)
      },
    )
  }

  /**
   * The file's meshes, read now if they need to be. One that failed before is tried again: an
   * export or a picture shouldn't leave a part out because the connection dropped once.
   */
  async load(m: Model3D): Promise<THREE.Group> {
    if (this.entries.get(this.key(m))?.state === "failed") this.entries.delete(this.key(m))
    this.request(m)
    const ready = () => {
      const e = this.entries.get(this.key(m))
      if (e?.state === "ready") return e.object
      if (e?.state === "failed") throw new Error(e.error)
      return null
    }
    const now = ready()
    if (now) return now
    return new Promise((resolve, reject) => {
      const stop = this.subscribe(() => {
        try {
          const object = ready()
          if (!object) return
          stop()
          resolve(object)
        } catch (error) {
          stop()
          reject(error)
        }
      })
    })
  }

  /** Forget files that failed, so the next draw tries them again. */
  retryFailed() {
    for (const [key, e] of this.entries) if (e.state === "failed") this.entries.delete(key)
    this.emit()
  }

  /** Record how a read ended, unless a newer read (or a retry) has taken its place. */
  private settle(key: string, from: Entry, entry: Entry) {
    if (this.entries.get(key) !== from) return
    this.entries.set(key, entry)
    this.emit()
  }

  private emit() {
    for (const l of [...this.listeners]) l()
  }
}

export const modelLibrary = new ModelLibrary()

// A user's file is read through the open project (a collaborator's is found through it), so one that
// failed on one project may read on the next: open another, and failures are tried again.
useProjectStore.subscribe((s, prev) => {
  if (s.project?.id !== prev.project?.id) modelLibrary.retryFailed()
})

/** A model file's state, kept current as it loads. */
export function useModelState(m: Model3D | null): { state: ReturnType<ModelLibrary["state"]>; error: string | null } {
  const state = useSyncExternalStore(
    (l) => modelLibrary.subscribe(l),
    () => (m ? `${modelLibrary.state(m)}\n${modelLibrary.error(m) ?? ""}` : "idle\n"),
  )
  const [s, error] = state.split("\n")
  return { state: s as ReturnType<ModelLibrary["state"]>, error: error || null }
}
