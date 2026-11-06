import type { Project } from "../model/types"
import { projectChanges } from "../store/changes"
import { changeLines, versionBy, type NameOutcome, type VersionInfo } from "../store/history"
import { openStoredProject } from "../store/storage"
import { fail, ok, type ToolContext, type ToolSpec, type UndoReport } from "./toolKit"

// Checkpoints and going back: `save_version` names the project as it is now in its version history, `list_versions` reads
// the history, `restore_version` brings a version back, and `undo` takes back Sakura's own last changes. Before them, a
// model that wanted an earlier state rebuilt it by hand: on October 31, 110 of a session's 212 replies were Sakura moving
// parts back, clearing and redrawing a trace it had drawn 61 times, and rerouting, and some restores still missed (a board
// it said had never routed fully had, another came back off centre). Sakura said itself that none of its tools could save,
// name or snapshot the project.
//
// The history is the host's (`ToolContext.versions`: the editor's `HistorySource`, the MCP server's own). A
// restore is a change like any other, worked out from the project as it is to the version (`projectChanges`): in the
// editor one undo step, which `undo` and the user's ⌘Z take back, and over MCP one batch, which every open copy applies as
// it applies a collaborator's. The state it replaces is kept in the history first (`keep`), as "Before restoring", so it
// can be gone back to after the tab is closed too. `undo` is the editor's alone: an assistant over MCP has no undo stack.

const NO_HISTORY = "This project's storage keeps no version history here, so there are no versions to save or restore."

const NAME_REFUSED: Record<Exclude<NameOutcome, { ok: true }>["reason"], string> = {
  invalid: "Give the version a name.",
  too_many: "The project has 50 named versions, the most it keeps. Ask the user to take the name off one in the version history (the clock in the top bar), then save again.",
  forbidden: "The project is shared with the user to view, not to edit, so a version can't be saved or restored.",
  not_found: "No such version: it may have been thinned out of the history. Call list_versions for the versions there are.",
}

type Prepared<T> = { ok: true; value: T } | { ok: false; error: string }
const refused = <T>(error: string): Prepared<T> => ({ ok: false, error })

/** How long ago, in a word or two: "just now", "12 min ago", "3 h ago", "2 days ago". */
function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

const iso = (at: number) => new Date(at).toISOString()

/** A version as list_versions lists it. */
function versionRow(v: VersionInfo, now: number) {
  const by = versionBy(v)
  const changes = changeLines(v.summary).map((l) => l.text)
  return {
    version_id: v.id,
    ...(v.name && { name: v.name }),
    kind: v.kind === "auto" ? "kept while editing" : v.kind === "restore" ? "kept before a restore" : "named",
    at: iso(v.at),
    age: ago(v.at, now),
    ...(v.restoredFromAt && { restored_version_from: iso(v.restoredFromAt) }),
    ...(by && { by }),
    changed_since_previous: changes.length ? changes.join(", ") : "nothing in parts, wires or traces",
  }
}

export const saveVersionTool: ToolSpec<Prepared<{ versionId: string }>> = {
  name: "save_version",
  description:
    "Name the project as it is now in its version history: a checkpoint, kept for good, that the user sees and restore_version brings back. Save one before a change you may want to take back (re-placing or re-routing the board, clearing routing, a big rework). version_id names an older version from list_versions instead.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: 'Short name of what this state is, e.g. "All nets routed, before pours"' },
      version_id: { type: "string", description: "An older version to name, from list_versions" },
    },
    required: ["name"],
  },
  async prepare(_project, input, ctx) {
    if (!ctx.versions) return refused(NO_HISTORY)
    const versionId = typeof input.version_id === "string" && input.version_id.trim() ? input.version_id.trim() : undefined
    const named = await ctx.versions.name(String(input.name), versionId)
    return named.ok ? { ok: true, value: { versionId: named.versionId } } : refused(NAME_REFUSED[named.reason])
  },
  run(project, input, prepared) {
    if (!prepared) return fail(project, NO_HISTORY)
    if (!prepared.ok) return fail(project, prepared.error)
    const name = String(input.name).replace(/\s+/g, " ").trim()
    const what = input.version_id ? "Named that version" : "Saved the project as it is now"
    return ok(project, `${what} as "${name}" (version_id ${prepared.value.versionId}). restore_version with that id brings the project back to it.`, `Saved version "${name}"`)
  },
}

export const listVersionsTool: ToolSpec<Prepared<{ rows: ReturnType<typeof versionRow>[]; edits: number; more: boolean }>> = {
  name: "list_versions",
  description:
    "The project's version history, newest first: named checkpoints (yours or the user's) and copies kept as it was edited, each with its version_id, when, who and what changed since the one before.",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "How many, newest first (default 20, at most 50)" },
      named_only: { type: "boolean", description: "Only the named versions" },
    },
  },
  async prepare(_project, input, ctx) {
    if (!ctx.versions) return refused(NO_HISTORY)
    const limit = Math.max(1, Math.min(50, typeof input.limit === "number" ? Math.floor(input.limit) : 20))
    const state = await ctx.versions.list(input.named_only === true ? 400 : limit)
    if (!state) return refused("The project's history can't be read: the project is gone, or no longer shared with the user.")
    const now = Date.now()
    const shown = input.named_only === true ? state.versions.filter((v) => v.kind === "named").slice(0, limit) : state.versions
    return { ok: true, value: { rows: shown.map((v) => versionRow(v, now)), edits: state.current.edits, more: input.named_only === true ? false : state.more } }
  },
  run(project, input, prepared) {
    if (!prepared) return fail(project, NO_HISTORY)
    if (!prepared.ok) return fail(project, prepared.error)
    const { rows, edits, more } = prepared.value
    if (!rows.length) {
      const none = input.named_only === true ? "No version is named yet." : "No versions are kept yet: the first is kept with the project's next change."
      return { ...ok(project, `${none} save_version names the project as it is now.`, "Read the version history"), empty: true }
    }
    const answer = { current: edits ? `${edits} ${edits === 1 ? "edit" : "edits"} since the newest version` : "the same as the newest version", versions: rows, ...(more && { more: "older versions not listed: ask with a higher limit" }) }
    return ok(project, JSON.stringify(answer), `Read ${rows.length} ${rows.length === 1 ? "version" : "versions"} of the history`)
  },
}

export const restoreVersionTool: ToolSpec<Prepared<{ version: Project; at: number; kept: string }>> = {
  name: "restore_version",
  description:
    "Bring the project back exactly to a version from list_versions (every part, wire, trace, pour and setting), as one change: how to go back to an earlier state, rather than rebuilding it by hand. What it replaces is kept first, as a version you can restore in turn.",
  input_schema: {
    type: "object",
    properties: { version_id: { type: "string", description: "The version, from list_versions or save_version" } },
    required: ["version_id"],
  },
  async prepare(project, input, ctx) {
    if (!ctx.versions) return refused(NO_HISTORY)
    const versionId = String(input.version_id).trim()
    const opened = await ctx.versions.open(versionId)
    if (!opened) return refused(NAME_REFUSED.not_found)
    let version: Project
    try {
      version = openStoredProject({ id: project.id, content: opened.content, revision: opened.revision, formatVersion: opened.formatVersion, createdAt: project.createdAt, updatedAt: project.updatedAt })
    } catch (e) {
      return refused(`That version can't be read here (${e instanceof Error ? e.message : String(e)})`)
    }
    // Kept only once the version is known to read: a restore that can't happen keeps nothing.
    const kept = await ctx.versions.keep(versionId)
    if (!kept.ok) return refused(NAME_REFUSED[kept.reason])
    return { ok: true, value: { version, at: opened.at, kept: kept.kept } }
  },
  run(project, _input, prepared, ctx) {
    if (!prepared) return fail(project, NO_HISTORY)
    if (!prepared.ok) return fail(project, prepared.error)
    const { version, at, kept } = prepared.value
    const when = iso(at)
    const back = `What it replaced is kept as version ${kept}: restore_version with that id goes back to it${undoSentence(ctx)}.`
    if (!projectChanges(project, version).length) return ok(project, `The project is already as it was in that version (${when}), so nothing changed. ${back}`, "Already as that version")
    return ok(version, `Restored the project to the version of ${when}: it is exactly as it was then. ${back} Read the design again (get_design) before editing it.`, `Restored the version of ${when.slice(0, 16).replace("T", " ")}`)
  },
}

const undoSentence = (ctx?: ToolContext) => (ctx?.undo ? ", or undo takes this restore back" : "")

const UNDO_STOPPED: Record<NonNullable<UndoReport["stopped"]>, string> = {
  user: "The newest change left on the undo stack is the user's own (they edited after you), and undo only takes back yours while they are the newest. To go back further, restore a version (list_versions).",
  none: "None of your changes are left on the undo stack (the project was opened again, or the user undid them). To go back further, restore a version (list_versions).",
  paused: "Editing is paused or the project is view only, so nothing could be undone now.",
  dragging: "The user is dragging something on the canvas, so nothing was undone. Try again in a moment.",
}

export const undoTool: ToolSpec<UndoReport | null> = {
  name: "undo",
  description:
    "Take back your own last changes, newest first, as the user's Undo does (they can redo them): each tool call of yours that changed the project is one. Use it to back out of a change that made things worse rather than rebuilding by hand. It never takes back the user's own edits, and stops at one.",
  input_schema: {
    type: "object",
    properties: { steps: { type: "integer", description: "How many of your changes to take back, newest first (default 1, at most 50)" } },
  },
  // The undo is the network half's place: it changes the project before the tool's `run`, which only reports.
  async prepare(_project, input, ctx) {
    if (!ctx.undo) return null
    const steps = Math.max(1, Math.min(50, typeof input.steps === "number" ? Math.floor(input.steps) : 1))
    return ctx.undo(steps)
  },
  run(project, input, prepared) {
    if (!prepared) return fail(project, "There is no undo stack here. Restore a version instead (list_versions, restore_version).")
    const { undone, stopped } = prepared
    if (!undone.length) return fail(project, stopped ? UNDO_STOPPED[stopped] : "Nothing was undone.")
    const asked = Math.max(1, typeof input.steps === "number" ? Math.floor(input.steps) : 1)
    const list = undone.map((l) => l || "a change").join("; ")
    const short = undone.length < asked && stopped ? ` Stopped after ${undone.length} of ${asked}: ${UNDO_STOPPED[stopped]}` : ""
    const result = `Undid ${undone.length === 1 ? "your last change" : `your last ${undone.length} changes`}, newest first: ${list}. The project is as it was before ${undone.length === 1 ? "it" : "them"}.${short} Read the design again before editing.`
    return { ...ok(project, result, `Undid ${undone.length === 1 ? undone[0] || "a change" : `${undone.length} changes`}`), applied: true }
  },
}

export const VERSION_TOOLS = [saveVersionTool, listVersionsTool, restoreVersionTool, undoTool]
