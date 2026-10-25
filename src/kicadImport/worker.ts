import { runImport } from "./engine"
import type { StartRequest, WorkerEvent } from "./protocol"

// The import's worker: a 40 MB board takes about 13 s to import, and the page must not freeze for it.

const scope = self as unknown as { onmessage: ((e: MessageEvent<StartRequest>) => void) | null; postMessage(e: WorkerEvent): void }
scope.onmessage = (e) => {
  if (e.data.type === "start") void runImport(e.data, (event) => scope.postMessage(event))
}
