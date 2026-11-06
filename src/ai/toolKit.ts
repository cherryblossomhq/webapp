import type { Project } from "../model/types"
import type { HistoryState, KeepOutcome, NameOutcome, OpenedVersion } from "../store/history"
import type { SupplierPartsSource } from "./supplierParts"
import type { LookImage, LookRenderer } from "./vision/encode"
import type { LookBudget } from "./vision/limits"

// What every copilot tool is made of. In a module of its own so tools can live in more than one
// file (the part tools are in `partTools.ts`) without importing each other.

export type ToolInput = Record<string, unknown>

export interface ToolOutcome {
  project: Project
  /** Text returned to the model as the tool result. */
  result: string
  /** One line for the transcript, e.g. "Added R1 (Resistor, 10k)". */
  summary: string
  isError: boolean
  /** Pictures for the model to see, sent with the next request (see `look`). */
  images?: LookImage[]
  /**
   * The call worked but came back with nothing to use (a section not found, no text). It counts
   * toward the repeat guard like a failure, so the same empty read isn't asked again and again.
   */
  empty?: boolean
  /**
   * The tool changed the project itself, with nothing for its caller to commit (`undo`, which takes back steps on the
   * user's undo stack): `project` is the one it was given, and the transcript still shows a change.
   */
  applied?: boolean
}

export type JsonSchema = {
  type: "object" | "string" | "number" | "integer" | "array" | "boolean"
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  enum?: (string | number)[]
  minItems?: number
}

/**
 * What a tool may reach beyond the project: the supplier parts source, the run's stop signal, and
 * what it may know about the request it runs in.
 */
export interface ToolContext {
  parts?: SupplierPartsSource | null
  signal?: AbortSignal
  /** The pictures this request may still take; without one a tool may not take any. */
  looks?: LookBudget
  /** The editor's selection ids (`c:` parts, `w:` wires, `l:` labels, `b:` blocks, `d:` drawings, `t:` traces, `v:` vias), read when asked. */
  selection?: () => string[]
  /** The project as it was when the user sent the request, before any tool ran. */
  start?: Project
  /**
   * An AI assistant of the user's own, over MCP: each call is a request of its own and what came
   * before it is unknown (`start` is the call's), so a tool asks to be told what the request made
   * rather than guess; and a picture comes back in the call's own result.
   */
  standalone?: boolean
  /** What draws `look`'s pictures where there is no page to draw on (the MCP server's); without one, the page's. */
  renderer?: LookRenderer
  /** The schematic's view of the sheet tree: the use shown (a path of sheet symbols, "" for the root), and a way to show another. Absent where no editor shows one. */
  sheet?: { shown(): string; show(path: string): void }
  /** The project's version history, which `save_version`, `list_versions` and `restore_version` reach. Absent where storage keeps none (the harness). */
  versions?: ToolVersions
  /** Sakura's own changes on the user's undo stack, which `undo` takes back. Absent where there is none (an assistant over MCP). */
  undo?: (steps: number) => UndoReport
}

/**
 * The open project's history as a tool reaches it: the host's `HistorySource` for the project the request is about, with
 * whatever the host must do first (the editor lets this tab's edits land, so a checkpoint holds them).
 */
export interface ToolVersions {
  /** The newest `limit` versions, and the state now; null when the project can't be read. */
  list(limit: number): Promise<HistoryState | null>
  /** Name the project as it is now, or an older version. */
  name(name: string, versionId?: string): Promise<NameOutcome>
  /** A version's project file, to restore. */
  open(versionId: string): Promise<OpenedVersion | null>
  /** Keep the project as it is now before `versionId` is restored as changes (`HistorySource.keep`). */
  keep(versionId: string): Promise<KeepOutcome>
}

/** What `undo` did: the labels of the steps taken back, newest first, and why it stopped short of what it was asked, if it did. */
export interface UndoReport {
  undone: string[]
  /** `user`: the newest step left is the user's own; `none`: no steps of Sakura's are left; `paused`: editing is paused or read-only; `dragging`: the user is mid-drag. */
  stopped: "user" | "none" | "paused" | "dragging" | null
}

export interface ToolSpec<Prepared = unknown> {
  name: string
  description: string
  input_schema: JsonSchema & { type: "object" }
  // Methods rather than function-typed fields, so a tool with its own `Prepared` still fits a
  // list of `ToolSpec`s.
  /**
   * The network half of a tool, run first and awaited: lookups that don't change the project.
   * Its result is handed to `run`, which applies the change to the project as it is once the
   * lookups are done, so an edit the user made meanwhile is never overwritten.
   */
  prepare?(project: Project, input: ToolInput, ctx: ToolContext): Promise<Prepared>
  /** `ctx` is the same context `prepare` had, for a tool that needs to know about the request. */
  run(project: Project, input: ToolInput, prepared?: Prepared, ctx?: ToolContext): ToolOutcome
}

export const ok = (project: Project, result: string, summary: string): ToolOutcome => ({
  project,
  result,
  summary,
  isError: false,
})

export const fail = (project: Project, message: string): ToolOutcome => ({
  project,
  result: `Error: ${message}`,
  summary: message,
  isError: true,
})

export function stringProps(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v)
    else return null
  }
  return out
}

export const pinList = (pins: { number: string; name: string }[]) =>
  pins.map((p) => (p.name === p.number ? p.number : `${p.number}:${p.name}`)).join(" ")
