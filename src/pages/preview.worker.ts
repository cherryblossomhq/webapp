import { computeConnectivity } from "../model/connectivity"
import { parseProjectFile } from "../model/projectFile"
import { boardPreviewSvg, previewFills } from "./boardPreviewSvg"

// A projects page's previews, drawn off the page's thread. The project comes as its file, which reading registers its
// parts and land patterns for here, one request at a time, so each is drawn with its own.

export interface PreviewRequest {
  key: string
  file: string
}
export type PreviewReply = { key: string; svg: string } | { key: string; error: string }

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<PreviewRequest>) => void) | null; postMessage: (reply: PreviewReply) => void }

scope.onmessage = (e) => {
  const { key, file } = e.data
  try {
    const project = parseProjectFile(file, { id: key, createdAt: 0, updatedAt: 0 })
    scope.postMessage({ key, svg: boardPreviewSvg(project, previewFills(project, computeConnectivity(project))) })
  } catch (err) {
    scope.postMessage({ key, error: err instanceof Error ? err.message : String(err) })
  }
}
