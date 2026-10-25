import JSZip from "jszip"
import { runImport, type EngineOptions } from "../src/kicadImport/engine"
import type { WorkerLike } from "../src/kicadImport/client"
import type { InputFile } from "../src/kicadImport/pick"
import type { InputEntry, StartRequest, WorkerEvent } from "../src/kicadImport/protocol"
import type { ProjectRecord, ProjectStorage } from "../src/store/storage"

// Shared by the KiCad import's tests: files, zips, a stand-in worker that runs the real job in the
// test's own thread, and a storage that records what it was asked to keep.

export const bytesOf = (text: string) => new TextEncoder().encode(text)

export const input = (path: string, text = "x"): InputFile => {
  const bytes = bytesOf(text)
  return { path, size: bytes.length, read: async () => bytes }
}

export const entry = (path: string, text = "x"): InputEntry => ({ path, file: new File([text], path.split("/").pop()!) })

/** A zip as one input file. */
export async function zipInput(name: string, files: Record<string, string>): Promise<InputFile> {
  const zip = new JSZip()
  for (const [path, text] of Object.entries(files)) zip.file(path, text)
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  return { path: name, size: bytes.length, read: async () => bytes }
}

export async function zipEntry(name: string, files: Record<string, string>): Promise<InputEntry> {
  const zip = new JSZip()
  for (const [path, text] of Object.entries(files)) zip.file(path, text)
  return { path: name, file: new File([await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })], name) }
}

export type FakeWorker = WorkerLike & { terminated: boolean; requests: StartRequest[] }

/** A worker that runs the real job on this thread and answers asynchronously, as a worker would. */
export function fakeWorkers(options: EngineOptions = {}): { create: () => FakeWorker; made: FakeWorker[] } {
  const made: FakeWorker[] = []
  return {
    made,
    create: () => {
      const w: FakeWorker = {
        terminated: false,
        requests: [],
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage(request) {
          w.requests.push(request)
          void runImport(request, (event: WorkerEvent) => setTimeout(() => !w.terminated && w.onmessage?.({ data: event } as MessageEvent<WorkerEvent>), 0), options)
        },
        terminate() {
          w.terminated = true
        },
      }
      made.push(w)
      return w
    },
  }
}

export function fakeStorage(overrides: Partial<ProjectStorage> = {}) {
  const created: ProjectRecord[] = []
  const storage: ProjectStorage = {
    location: "browser",
    watchList: () => () => {},
    load: async () => null,
    create: async (record) => {
      created.push(record)
      return { id: `p${created.length}`, revision: 1 }
    },
    save: async () => ({ ok: true, revision: 1 }),
    remove: async () => {},
    ...overrides,
  }
  return { storage, created }
}

/** `localStorage` for the report store, in a test that runs on Node. */
export function stubLocalStorage() {
  const data = new Map<string, string>()
  const stub = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = stub
  return data
}
