import type { MeshData } from "./meshData"

// STEP files triangulated before, in this browser's IndexedDB. Triangulating a STEP file takes
// about a second a megabyte, every time a board is opened; a file's id is its content, so what
// it triangulates to never goes stale. The version is the triangulation's: bump it when the
// reader or its settings change.

const DB = "cherryblossom-step-meshes"
const STORE = "meshes"
const VERSION = "occt-0.0.23:1"

let db: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  return (db ??= new Promise((resolve) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    // A browser that won't keep it (private mode) just triangulates every time.
    req.onerror = () => resolve(null)
  }))
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (d) =>
      d
        ? new Promise<T | null>((resolve) => {
            try {
              const tx = d.transaction(STORE, mode)
              const req = work(tx.objectStore(STORE))
              tx.oncomplete = () => resolve(req.result)
              tx.onerror = tx.onabort = () => resolve(null)
            } catch {
              resolve(null)
            }
          })
        : null,
  )
}

export const cachedMeshes = (id: string) => run<MeshData[] | undefined>("readonly", (s) => s.get(`${VERSION}:${id}`)).then((v) => v ?? null)

export const cacheMeshes = (id: string, meshes: MeshData[]) => run("readwrite", (s) => s.put(meshes, `${VERSION}:${id}`)).then(() => undefined)
