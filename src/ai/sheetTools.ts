import { round } from "../lib/geometry"
import { schematicBounds } from "../model/instances"
import { kicadRulesShown } from "../model/kicadJoin"
import { addLabel } from "../model/ops"
import { addMissingPins, addSheet, addSheetPin, addSheetUse, moveSheetSymbols, removalNote, removeSheetPin, removeSheetSymbols, resizeSheetSymbol, setSheetSymbol, sheetEditProblems } from "../model/sheetOps"
import { ROOT_SHEET, isHierarchical, mergeSheetView, sheetUses, sheetView, syncCopies, useAt, type SheetUse } from "../model/sheets"
import type { LabelShape, Project, SheetSymbol } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { fail, ok, type JsonSchema, type ToolContext, type ToolInput, type ToolOutcome, type ToolSpec } from "./toolKit"

// S1 and Sakura: `get_design`, `connect` and `tidy_schematic` take an optional sheet. A project with sheets is read and edited one use of a
// sheet at a time (a view, `model/sheets.ts`); a project with one sheet has no sheet to name, and the tools work as they always did.

/** The input every sheet-aware tool has: a sheet by its name or path. */
export const SHEET_PROPERTY = { type: "string", description: "Sheet name or path, e.g. Power or /Power/ (projects with sheets only)" } as const

/** The same input, for the tools that build on a sheet (`add_component`, `group_parts`, `edit_block`, `draw`): the sheets are explained once, in `SHEETS_NOTE`. */
export const SHEET_ARG = { type: "string", description: "Sheet name or path (default: the sheet shown)" } as const

const norm = (s: string) => s.trim().toLowerCase().replace(/^\/+|\/+$/g, "")

/** The sheets a project has, for a message: `/` for the root, then `/Power/`. */
export const sheetList = (project: Project) =>
  sheetUses(project)
    .map((u) => u.human)
    .join(", ")

/** The use of a sheet a person means by a name: its path of names (`Power`, `/Power/Reg/`), its id path, or `root` or its own name (`Main`) for the first. */
export function resolveSheet(project: Project, text: string): { use: SheetUse } | { error: string } {
  const uses = sheetUses(project)
  const want = norm(text)
  const hits = uses.filter((u) => norm(u.human) === want || norm(u.name) === want || (want !== "" && u.path === `/${want}`))
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

// ---------- Sakura builds sheets ----------
//
// The tools below do what the editor's Sheet tool and the sheet inspectors do, through the same functions (`model/sheetOps.ts`), one undo step each:
// a refusal returns the project it was given, so nothing is half made. Two of them place labels with `connect`, so they are made from it:
// `tools.ts` defines it, and imports this file.

const GRID = 0.1
const onGrid = (v: number) => round(Math.round(v / GRID) * GRID, 4)
const SIDES = ["left", "right", "top", "bottom"] as const
const SHAPES = ["input", "output", "bidirectional", "tri_state", "passive"] as const
type Side = (typeof SIDES)[number]
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const text = (v: unknown) => (typeof v === "string" ? v.trim() : undefined)
const isRoot = (u: SheetUse) => u.symbol === null

/** The sheet a tool means, by its name or path; with none given, the one the editor shows (the root where nothing shows one). */
function sheetArg(project: Project, given: unknown, ctx: ToolContext | undefined): { use: SheetUse } | { error: string } {
  const name = text(given)
  if (name) return resolveSheet(project, name)
  return shownUse(project, ctx)
}

/** The sheet the editor shows, or an error when it is a sheet that no longer exists: a write must not fall back to the root without saying so. */
export function shownUse(project: Project, ctx: ToolContext | undefined): { use: SheetUse } | { error: string } {
  const path = ctx?.sheet?.shown() ?? ""
  const use = useAt(project, path)
  if (path && use.path !== path) return { error: `The sheet shown in the editor (${path}) no longer exists, so nothing was written to the root sheet by mistake. Say which sheet with sheet, or call show_sheet first. Sheets: ${sheetList(project)}` }
  return { use }
}

/** A sheet symbol's use: the root has none, so it can't be renamed, moved or deleted. */
function symbolArg(project: Project, input: ToolInput): { use: SheetUse; sym: SheetSymbol } | { error: string } {
  const given = text(input.sheet)
  if (!given) return { error: `Say which sheet with sheet. This project's sheets: ${sheetList(project)}` }
  const r = resolveSheet(project, given)
  if ("error" in r) return r
  if (isRoot(r.use)) return { error: `${given} is the root sheet: it is not drawn as a sheet symbol on another sheet, so it has none to change.` }
  return { use: r.use, sym: r.use.symbol! }
}

const nameTaken = (project: Project, parentSheet: string, name: string, except?: string) =>
  (project.sheetSymbols ?? []).some((s) => s.sheet === parentSheet && s.id !== except && s.name.trim().toLowerCase() === name.trim().toLowerCase())

/** The first free place on a sheet: right of everything on it, level with the lowest thing. */
function freeSheetSpot(project: Project, parent: SheetUse): { x: number; y: number } {
  const view = sheetView(project, parent.path)
  const xs: number[] = []
  const ys: number[] = []
  for (const c of view.components) {
    const b = schematicBounds(c)
    xs.push(b.maxX)
    ys.push(b.minY)
  }
  for (const s of project.sheetSymbols ?? []) {
    if (s.sheet !== parent.sheet) continue
    xs.push(s.x + s.w)
    ys.push(s.y)
  }
  for (const w of view.wires) {
    for (const q of w.points) {
      xs.push(q.x)
      ys.push(q.y)
    }
  }
  for (const l of view.labels) {
    xs.push(l.x)
    ys.push(l.y)
  }
  return xs.length ? { x: onGrid(Math.max(...xs) + 2), y: onGrid(Math.min(...ys)) } : { x: 0, y: 0 }
}

const sheetProp: JsonSchema = { type: "string", description: "Sheet name or path, e.g. /Power/" }

const addSheetTool: ToolSpec = {
  name: "add_sheet",
  description:
    "Add a sheet: a symbol on a parent sheet plus the empty sheet it stands for. reuse (an existing sheet's name) adds another use of that sheet instead, with its own references. A sheet can't hold itself; names are unique per parent. x, y, w, h: box lower-left corner and size, default free space.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      parent: { type: "string", description: "Default the sheet shown" },
      reuse: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      w: { type: "number" },
      h: { type: "number" },
    },
  },
  run: (project, input, _prepared, ctx) => {
    const name = text(input.name)
    const parentR = sheetArg(project, input.parent, ctx)
    if ("error" in parentR) return fail(project, parentR.error)
    const parent = parentR.use
    const w = num(input.w) ?? 10
    const h = num(input.h) ?? 8
    if (w < GRID * 4 || h < GRID * 2) return fail(project, "The sheet's w and h are too small to draw: use at least 0.4 by 0.2, and 8 by 6 or more to fit pins.")
    if (name !== undefined && !name) return fail(project, "name is empty")
    if (name && nameTaken(project, parent.sheet, name)) return fail(project, `${parent.human} already has a sheet called ${name}. Names are unique on a sheet: pick another.`)
    const spot = freeSheetSpot(project, parent)
    const x = num(input.x) ?? spot.x
    const y = num(input.y) ?? spot.y
    const box = { minX: x, minY: y, maxX: x + w, maxY: y + h }
    let made: { project: Project; symbol: SheetSymbol }
    const reuse = text(input.reuse)
    if (reuse) {
      const r = resolveSheet(project, reuse)
      if ("error" in r) return fail(project, r.error)
      if (isRoot(r.use)) return fail(project, "The root sheet can't be used again.")
      const again = addSheetUse(project, parent.path, r.use.sheet, box, name)
      if (!again) return fail(project, `${r.use.human} can't go on ${parent.human}: a sheet can't hold itself, directly or through the sheets inside it.`)
      made = again
    } else {
      made = addSheet(project, parent.path, box, name)
    }
    const next = made.project
    const use = useAt(next, `${parent.path}/${made.symbol.id}`)
    const what = reuse ? `another use of ${reuse}` : "a new empty sheet"
    return ok(
      next,
      `Added ${made.symbol.name} on ${parent.human}: ${what}, ${use.human}, box x ${made.symbol.x} y ${made.symbol.y}, ${made.symbol.w} by ${made.symbol.h}. Fill it with add_component, connect and group_parts (sheet "${use.human}").`,
      `Added sheet ${made.symbol.name}`,
    )
  },
}

const editSheetTool: ToolSpec = {
  name: "edit_sheet",
  description:
    "Change a sheet symbol: rename, move (x, y lower-left), resize (w, h), add_pins, remove_pins, or delete. Deleting the last use of a sheet deletes its contents; undo restores. A refused call changes nothing.",
  input_schema: {
    type: "object",
    properties: {
      sheet: sheetProp,
      name: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      w: { type: "number" },
      h: { type: "number" },
      add_pins: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, shape: { type: "string", enum: [...SHAPES] }, side: { type: "string", enum: [...SIDES] } }, required: ["name"] },
        description: "Only for pins whose label comes later; else add_hier_label. Default bidirectional",
      },
      remove_pins: { type: "array", items: { type: "string" } },
      delete: { type: "boolean" },
    },
    required: ["sheet"],
  },
  run: (project, input) => {
    const r = symbolArg(project, input)
    if ("error" in r) return fail(project, r.error)
    const { use, sym } = r
    if (input.delete === true) {
      const others = Object.keys(input).filter((k) => k !== "sheet" && k !== "delete")
      if (others.length) return fail(project, `Delete can't be combined with ${others.join(", ")}: say one or the other.`)
      const next = removeSheetSymbols(project, [sym.id])
      return ok(next, removalNote(project, [sym.id]) ?? `Deleted the sheet ${sym.name}.`, `Deleted sheet ${sym.name}`)
    }
    let next = project
    const done: string[] = []
    const name = text(input.name)
    if (name !== undefined) {
      if (!name) return fail(project, "name is empty")
      if (nameTaken(project, sym.sheet, name, sym.id)) return fail(project, `${useAt(project, use.parent ?? "").human} already has a sheet called ${name}. Names are unique on a sheet: pick another.`)
      next = setSheetSymbol(next, sym.id, { name })
      done.push(`renamed to ${name}`)
    }
    const w = num(input.w)
    const h = num(input.h)
    if ((w !== undefined && w < GRID * 4) || (h !== undefined && h < GRID * 2)) return fail(project, "The sheet's w and h are too small: use at least 0.4 by 0.2.")
    if (w !== undefined || h !== undefined) {
      next = resizeSheetSymbol(next, sym.id, w ?? sym.w, h ?? sym.h)
      done.push(`resized to ${w ?? sym.w} by ${h ?? sym.h}`)
    }
    const x = num(input.x)
    const y = num(input.y)
    if (x !== undefined || y !== undefined) {
      const to = { x: onGrid(x ?? sym.x), y: onGrid(y ?? sym.y) }
      // S11: on a sheet joined by KiCad's rules the symbol may be off the grid, and it lands on the grid point asked for to six digits.
      const digits = kicadRulesShown(next) ? 6 : 4
      next = moveSheetSymbols(next, [sym.id], { x: round(to.x - sym.x, digits), y: round(to.y - sym.y, digits) })
      done.push(`moved to x ${to.x}, y ${to.y}`)
    }
    // The wires follow the pins of a sheet that is resized or moved; what that still cannot keep (a wire that would run onto another net) is refused, with nothing changed.
    if (w !== undefined || h !== undefined || x !== undefined || y !== undefined) {
      const problems = sheetEditProblems(project, next, sym.sheet, getConnectivity)
      if (problems.length) {
        const shown = problems.slice(0, 3).join("; ") + (problems.length > 3 ? `; and ${problems.length - 3} more` : "")
        return fail(project, `Didn't ${w !== undefined || h !== undefined ? "resize" : "move"} the sheet ${sym.name}: ${shown}. Nothing was changed. Resize or move it where the wires at its pins can follow, or delete those wires first.`)
      }
    }
    const have = () => next.sheetSymbols!.find((s) => s.id === sym.id)!
    for (const n of (input.remove_pins as string[] | undefined) ?? []) {
      const pin = have().pins.find((p) => p.name.trim() === n.trim())
      if (!pin) return fail(project, `${sym.name} has no pin ${n}. Its pins: ${have().pins.map((p) => p.name).join(", ") || "none"}`)
      next = removeSheetPin(next, sym.id, pin.id)
      done.push(`pin ${n} removed`)
    }
    for (const spec of (input.add_pins as { name: string; shape?: LabelShape; side?: Side }[] | undefined) ?? []) {
      const pinName = spec.name.trim()
      if (!pinName) return fail(project, "A pin needs a name")
      if (have().pins.some((p) => p.name.trim() === pinName)) return fail(project, `${sym.name} already has a pin ${pinName}.`)
      const shape = spec.shape ?? "bidirectional"
      next = addSheetPin(next, sym.id, pinName, shape, spec.side ?? (shape === "output" ? "right" : "left"))
      done.push(`pin ${pinName} added`)
    }
    if (!done.length) return fail(project, "Nothing to change: give name, x, y, w, h, add_pins, remove_pins or delete.")
    return ok(next, `${sym.name}: ${done.join(", ")}.`, `Changed sheet ${sym.name}`)
  },
}

/** The two tools that place labels with `connect`: a net leaving a sheet, and a sheet pin wired to the parts beside its symbol. */
export function sheetWiringTools(connect: ToolSpec): ToolSpec[] {
  const addHierLabel: ToolSpec = {
    name: "add_hier_label",
    description:
    "Make a net leave a sheet: connect the pins with a hierarchical label of this name on that sheet, and add the matching pin to each sheet symbol that stands for it. Then wire_sheet_pin on the parent.",
    input_schema: {
      type: "object",
      properties: {
        sheet: sheetProp,
        name: { type: "string" },
        pins: { type: "array", items: { type: "string" }, minItems: 1 },
        shape: { type: "string", enum: [...SHAPES] },
      },
      required: ["sheet", "name", "pins"],
    },
    run: (project, input, prepared, ctx = {}) => {
      if (!isHierarchical(project)) return fail(project, "This project has no sheets yet. Make one with add_sheet first.")
      const r = sheetArg(project, input.sheet, ctx)
      if ("error" in r) return fail(project, r.error)
      const use = r.use
      if (isRoot(use)) return fail(project, "The root sheet has no sheet above it to leave: put hierarchical labels on a sheet made with add_sheet.")
      const name = String(input.name).trim()
      if (!name) return fail(project, "name is empty")
      const shape = (text(input.shape) as LabelShape | undefined) ?? "bidirectional"
      const already = project.labels.some((l) => l.kind === "hierarchical" && (l.sheet ?? ROOT_SHEET) === use.sheet && l.name.trim() === name)
      const out = onSheet(connect, project, { pins: input.pins, net_name: name, sheet: use.human }, prepared, ctx)
      if (out.isError) return out
      let next = out.project
      const known = new Set(project.labels.map((l) => l.id))
      const fresh = next.labels.filter((l) => !known.has(l.id) && l.name.trim() === name)
      if (!already) {
        if (!fresh.length) return fail(project, `Those pins are already on a net, and no label of ${name} was placed. Pick pins that are not connected yet.`)
        next = { ...next, labels: next.labels.map((l) => (l.id === fresh[0].id ? { ...l, kind: "hierarchical" as const, shape } : l)) }
      }
      let pins = 0
      for (const sym of next.sheetSymbols ?? []) {
        if (sym.child !== use.sheet) continue
        const before = sym.pins.length
        next = addMissingPins(next, sym.id)
        pins += next.sheetSymbols!.find((s) => s.id === sym.id)!.pins.length - before
      }
      const note = already ? `${name} already has a hierarchical label on ${use.human}, so the pins joined it` : `${name} is a hierarchical label on ${use.human}`
      return ok(next, `${out.result} ${note}; ${pins} sheet pin${pins === 1 ? "" : "s"} added to the sheet's symbols.`, `Hierarchical label ${name} on ${use.human}`)
    },
  }

  const wireSheetPin: ToolSpec = {
    name: "wire_sheet_pin",
    description:
      "Wire a sheet pin to parts on the sheet its symbol is on, as connect does: the pin's name is the net, or net_name.",
    input_schema: {
      type: "object",
      properties: {
        sheet: sheetProp,
        pin: { type: "string" },
        to: { type: "array", items: { type: "string" }, minItems: 1 },
        net_name: { type: "string" },
      },
      required: ["sheet", "pin", "to"],
    },
    run: (project, input, prepared, ctx = {}) => {
      const r = symbolArg(project, input)
      if ("error" in r) return fail(project, r.error)
      const { use, sym } = r
      const pinName = String(input.pin).trim()
      const pin = sym.pins.find((p) => p.name.trim() === pinName)
      if (!pin) return fail(project, `${sym.name} has no pin ${pinName}. Its pins: ${sym.pins.map((p) => p.name).join(", ") || "none"}. Make the pin with add_hier_label on the net inside the sheet (it adds the sheet pin and the label); edit_sheet add_pins is only for pins whose label comes later.`)
      const net = text(input.net_name) || pinName
      const parent = useAt(project, use.parent ?? "")
      const out = onSheet(connect, project, { pins: input.to, net_name: net, sheet: parent.human }, prepared, ctx)
      if (out.isError) return out
      let next = out.project
      const placed = next.labels.some((l) => (l.sheet ?? ROOT_SHEET) === sym.sheet && l.name.trim() === net && Math.abs(l.x - pin.x) < 1e-4 && Math.abs(l.y - pin.y) < 1e-4)
      if (!placed) {
        const made = addLabel(next, net, pin, pin.rot)
        next = { ...made.project, labels: made.project.labels.map((l) => (l.id === made.label.id && sym.sheet !== ROOT_SHEET ? { ...l, sheet: sym.sheet } : l)) }
      }
      return ok(next, `${out.result} Sheet pin ${pinName} of ${sym.name} is on ${net}.`, `Wired sheet pin ${pinName} of ${sym.name}`)
    },
  }

  return [addHierLabel, wireSheetPin]
}

const showSheetTool: ToolSpec = {
  name: "show_sheet",
  description: "Show a sheet in the editor, or \"up\" for the sheet above. Changes only what the user sees.",
  input_schema: { type: "object", properties: { sheet: { type: "string", description: "Sheet or \"up\"" } }, required: ["sheet"] },
  run: (project, input, _prepared, ctx) => {
    if (!ctx?.sheet) return fail(project, "No schematic is open to show a sheet in.")
    const want = String(input.sheet).trim()
    const shownR = want.toLowerCase() === "up" ? shownUse(project, ctx) : { use: useAt(project, ctx.sheet.shown()) }
    if ("error" in shownR) return fail(project, shownR.error)
    const shown = shownR.use
    let target: SheetUse
    if (want.toLowerCase() === "up") {
      if (shown.parent === null) return fail(project, `${shown.human} is the root sheet: there is no sheet above it.`)
      target = useAt(project, shown.parent)
    } else {
      const r = resolveSheet(project, want)
      if ("error" in r) return fail(project, r.error)
      target = r.use
    }
    if (target.path !== shown.path) ctx.sheet.show(target.path)
    return ok(project, `Showing ${target.human}.`, `Showing sheet ${target.human}`)
  },
}

export const sheetEditTools: ToolSpec[] = [addSheetTool, editSheetTool, showSheetTool]
