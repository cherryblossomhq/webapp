import { isHierarchical, mergeSheetView, sheetUses, sheetView, syncCopies, type SheetUse } from "../model/sheets"
import type { Project } from "../model/types"
import { fail, type ToolContext, type ToolInput, type ToolOutcome, type ToolSpec } from "./toolKit"

// S1 and Sakura: `get_design`, `connect` and `tidy_schematic` take an optional sheet. A project with sheets is read and edited one use of a
// sheet at a time (a view, `model/sheets.ts`); a project with one sheet has no sheet to name, and the tools work as they always did.

/** The input every sheet-aware tool has: a sheet by its name or path. */
export const SHEET_PROPERTY = { type: "string", description: "Sheet name or path, e.g. Power or /Power/ (projects with sheets only)" } as const

const norm = (s: string) => s.trim().toLowerCase().replace(/^\/+|\/+$/g, "")

/** The sheets a project has, for a message: `/` for the root, then `/Power/`, each with its page. */
export const sheetList = (project: Project) =>
  sheetUses(project)
    .map((u) => `${u.human} (page ${u.page})`)
    .join(", ")

/** The use of a sheet a person means by a name: its path of names (`Power`, `/Power/Reg/`), its id path, `root` for the first, or its page. */
export function resolveSheet(project: Project, text: string): { use: SheetUse } | { error: string } {
  const uses = sheetUses(project)
  const want = norm(text)
  const hits = uses.filter((u) => norm(u.human) === want || norm(u.name) === want || (want !== "" && u.path === `/${want}`) || u.page === text.trim())
  const root = uses[0]
  if (!hits.length && (want === "" || want === "root" || want === norm(root.name))) hits.push(root)
  if (hits.length === 1) return { use: hits[0] }
  if (!hits.length) return { error: `No sheet ${text}. This project's sheets: ${sheetList(project)}` }
  return { error: `Several sheets are called ${text}: ${hits.map((h) => h.human).join(", ")}. Give the path.` }
}

/**
 * Runs a tool on the sheet it is given, as that sheet alone, and puts the result back in the project (with the other uses of a reused sheet
 * made alike). With no sheet, `infer` may find it from the input (the sheet of the pins a connection names); a project with sheets and no
 * way to tell is an error that lists them.
 */
export function onSheet(
  spec: ToolSpec,
  project: Project,
  input: ToolInput,
  prepared: unknown,
  ctx: ToolContext,
  infer?: (project: Project) => string | { error: string } | undefined,
): ToolOutcome {
  const given = typeof input.sheet === "string" ? input.sheet.trim() : ""
  if (!isHierarchical(project)) {
    if (given && "error" in resolveSheet(project, given)) return fail(project, `This project has one sheet, so there is no sheet called ${given}.`)
    return spec.run(project, input, prepared, ctx)
  }
  let path: string
  if (given) {
    const r = resolveSheet(project, given)
    if ("error" in r) return fail(project, r.error)
    path = r.use.path
  } else {
    const found = infer?.(project)
    if (typeof found === "object") return fail(project, found.error)
    if (found === undefined) return fail(project, `This project has sheets: ${sheetList(project)}. Say which one with sheet.`)
    path = found
  }
  const view = sheetView(project, path)
  const start = ctx.start && isHierarchical(ctx.start) ? sheetView(ctx.start, path) : ctx.start
  const out = spec.run(view, input, prepared, { ...ctx, ...(start ? { start } : {}) })
  if (out.project === view) return { ...out, project }
  return { ...out, project: syncCopies(mergeSheetView(project, view, out.project), path) }
}
