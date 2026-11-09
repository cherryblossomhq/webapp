import type { DatasheetSection, WebPageResponse, WebSearchResponse } from "@cherryblossom/api-contract"
import type { Model3D } from "../model/types"

// Where Sakura reads the web: a search, the text of a page or a PDF at a link, and a 3D model file
// at a link. The host provides it, as it does the supplier parts source: the website's is
// `/api/v1/web/*` with the signed-in user's token,
// which needs a plan with managed AI, like Sakura itself. Without one (the harness, a test, an
// assistant over MCP, which has the web of its own) the web tools say they aren't available.

/** A model file the server fetched and checked: a STEP, WRL, OBJ, STL or GLB file, or a zip that holds one. */
export interface WebModelFile {
  /** The address it came from, after redirects. */
  url: string
  name: string
  kind: "step" | "wrl" | "obj" | "stl" | "glb" | "zip"
  bytes: ArrayBuffer
}

export interface WebSource {
  /** Pages a web search finds, best first, each with an excerpt of its text. */
  search(query: string, options: { site?: string }, signal?: AbortSignal): Promise<WebSearchResponse>
  /** A few pages of the text at a link: a PDF by its pages (and sections, as a datasheet), a web page cut into pages. */
  page(url: string, request: { section?: DatasheetSection; page?: number; offset?: number; find?: string }, signal?: AbortSignal): Promise<WebPageResponse>
  /** The 3D model file at a link. Failures throw an Error whose message is a sentence for the user. */
  file(url: string, signal?: AbortSignal): Promise<WebModelFile>
}

/**
 * What the editor does with a model file's bytes for `set_3d_model`: open a zip, read the file (one
 * that doesn't read is neither kept nor used), keep it in the account like a file the user added,
 * and place it on the footprint's pads. The page's (`editor/three/files/addModelFile.ts`), handed to
 * the tool by the copilot: it needs three.js, which the MCP server can't load.
 */
export type AddModelFile = (file: WebModelFile, footprint: string, signal?: AbortSignal) => Promise<{ model: Model3D; note?: string }>

let source: WebSource | null = null

export function connectWebSource(next: WebSource | null | undefined) {
  source = next ?? null
}

export const webSource = () => source
