/// <reference lib="webworker" />
/// <reference path="./occt.d.ts" />
// Reads STEP files off the main thread: OpenCascade (occt-import-js, LGPL-2.1, its own 7.6 MB
// WebAssembly file) triangulates the B-rep, and the triangles go back as transferred buffers.
// It is only fetched the first time a STEP model is drawn.
import occtimportjs, { type Occt } from "occt-import-js"
import { meshBuffers, occtMeshes } from "./meshData"

const wasm = new URL("occt-import-js/dist/occt-import-js.wasm", import.meta.url).href
let occt: Promise<Occt> | null = null

self.onmessage = async (e: MessageEvent<{ id: number; bytes: ArrayBuffer }>) => {
  const { id, bytes } = e.data
  try {
    occt ??= occtimportjs({ locateFile: () => wasm })
    const result = (await occt).ReadStepFile(new Uint8Array(bytes), null)
    const meshes = occtMeshes(result)
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, meshes }, meshBuffers(meshes))
  } catch (error) {
    // A failed read leaves OpenCascade in no known state: start a fresh one for the next file.
    occt = null
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
