import { parseProjectFile, serializeProject } from "../../model/projectFile"
import { tidySchematic } from "../../model/tidy"
import type { TidyRequest, TidyReply } from "./tidyAction"

// Tidy off the page's thread: the project comes as a project file, which reading registers its own
// parts and land patterns here as it does on the page, and the tidied one goes back the same way.

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<TidyRequest>) => void) | null; postMessage: (reply: TidyReply) => void }

scope.onmessage = (e) => {
  const { file, blockId } = e.data
  try {
    const project = parseProjectFile(file, { id: "tidy", createdAt: 0, updatedAt: 0 })
    const r = tidySchematic(project, { blockId })
    scope.postMessage({ ...r, project: r.changed ? serializeProject(r.project) : null })
  } catch (err) {
    scope.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
