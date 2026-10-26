import type { Project } from "../model/types"
import type { SupplierPartsSource } from "./supplierParts"
import type { LookImage } from "./vision/encode"
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
