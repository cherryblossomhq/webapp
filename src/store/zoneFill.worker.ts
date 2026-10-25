import { computeConnectivity } from "../model/connectivity"
import { analyzePcb } from "../model/pcb"
import type { ZoneFill } from "../model/pour"
import { parseProjectFile } from "../model/projectFile"

// The zone fill off the page's thread (X3): filling a big board's pours takes seconds. The project comes as a project file, which reading
// registers its own parts and land patterns for here as it does on the page, and the fills go back as they are (plain numbers). This
// worker lives as long as the editor, so what it has filled stays kept (`model/zoneFill.ts`) and a refill after an edit makes only the
// groups of zones the edit reached.

export interface ZoneFillRequest {
  file: string
}
export type ZoneFillReply = { fills: ZoneFill[] } | { error: string }

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<ZoneFillRequest>) => void) | null; postMessage: (reply: ZoneFillReply) => void }

scope.onmessage = (e) => {
  try {
    const project = parseProjectFile(e.data.file, { id: "fill", createdAt: 0, updatedAt: 0 })
    scope.postMessage({ fills: analyzePcb(project, computeConnectivity(project)).zoneFills })
  } catch (err) {
    scope.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
