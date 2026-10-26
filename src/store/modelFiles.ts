/**
 * Where the 3D model files a user adds are kept (`Model3D` with `source: "file"`). A STEP file is
 * often megabytes, far more than a project may hold, so a project names its files by the SHA-256
 * of their bytes and the host keeps the bytes: the website's is the signed-in account, and `browserModelFiles` below is this browser's IndexedDB, for the development harness.
 *
 * A file is kept once per account however many projects use it, and never changes: its id is its
 * content. A project file downloaded and opened on another account names files that account
 * doesn't have, and those parts are drawn with their generated bodies until a file is added again.
 */
export interface ModelFileStore {
  /** Keep a file. Resolves to its id, the SHA-256 of its bytes as lowercase hex. */
  put(file: { name: string; bytes: ArrayBuffer }, signal?: AbortSignal): Promise<string>
  /** A kept file's bytes, or null when there is none with that id here. */
  get(id: string, signal?: AbortSignal): Promise<ArrayBuffer | null>
}

/** The largest model file the editor accepts (bytes). */
export const MAX_MODEL_FILE_BYTES = 40 * 1024 * 1024

/** The SHA-256 of some bytes, as lowercase hex: a model file's id. */
export async function modelFileId(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

let store: ModelFileStore | null = null

export function connectModelFiles(next: ModelFileStore | null | undefined) {
  store = next ?? null
}

export const modelFiles = () => store

// ---------- This browser's store ----------

const DB_NAME = "cherryblossom-models"
const FILES = "files"

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(FILES)) req.result.createObjectStore(FILES)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("This browser wouldn't open its model store."))
  })
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (files: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILES, mode)
    const req = run(tx.objectStore(FILES))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error ?? new Error("This browser's model store failed."))
    tx.onabort = () => reject(tx.error ?? new Error("This browser's model store failed."))
  })
}

/** Model files kept in this browser's IndexedDB. */
export function browserModelFiles(): ModelFileStore {
  let db: Promise<IDBDatabase> | null = null
  const open = () => (db ??= openDb())
  return {
    async put({ bytes }) {
      const id = await modelFileId(bytes)
      await request(await open(), "readwrite", (files) => files.put(bytes, id))
      return id
    },
    async get(id) {
      const bytes = await request<unknown>(await open(), "readonly", (files) => files.get(id))
      return bytes instanceof ArrayBuffer ? bytes : null
    },
  }
}
