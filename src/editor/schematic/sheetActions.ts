import { labelBox } from "../../model/labels"
import { sheetPinGeometry } from "../../model/labelShapes"
import { lockedBlockOf } from "../../model/blocks"
import { removeItems } from "../../model/ops"
import { addSheetInFreeSpace, addSheetPin, addSheetUse, removalNote, removeSheetPin, removeSheetSymbols, syncSheetEntry, type SheetSide } from "../../model/sheetOps"
import { moveToNewSheet, type MoveToSheetResult } from "../../model/sheetRefactor"
import { commitOnUse, hasUse, sheetIdOf, useAt, usesOfSheet } from "../../model/sheets"
import type { LabelShape, Project, Vec2 } from "../../model/types"
import { projectApi } from "../../store/projectStore"
import { onShownSheet, shownPath, shownProject } from "../../store/sheetScope"
import { selectionIds, uiApi } from "../../store/uiStore"
import { selectedItems } from "./clipboard"

// Making sheets by hand: a new empty one from the tabs' +, the selection moved onto one of its own (the Inspector's button), another use of one, deleting
// one, and entries and ports kept in step. Each is one undo step. And the ways between a sheet entry and its port, and between global labels.

/** A new empty sheet below the one shown, its symbol in free space there; the editor shows it, its tab ready to be named. */
export function addNewSheet() {
  const p = projectApi().project
  if (!p) return
  const here = shownPath(p)
  // A viewer's commit is refused, and says so: nothing is made.
  let path = ""
  projectApi().commit((x) => {
    const made = addSheetInFreeSpace(x, shownPath(x, here))
    path = made.path
    return made.project
  })
  if (!path) return
  uiApi().setSheet(path)
  uiApi().setRenamingSheet(path)
}

/** The selection on the sheet shown moved onto a new sheet below it (`moveToNewSheet`): its symbol takes their place, selected, and its tab is ready to be named. */
export function moveSelectedToNewSheet() {
  if (!projectApi().project) return
  const sel = uiApi().selection
  const selection = {
    components: selectionIds(sel, "c"),
    wires: selectionIds(sel, "w"),
    labels: selectionIds(sel, "l"),
    drawings: selectionIds(sel, "d"),
    blocks: selectionIds(sel, "b"),
  }
  let result: MoveToSheetResult = { error: "" }
  projectApi().commit((x) => {
    result = moveToNewSheet(x, shownPath(x), selection)
    return "error" in result ? x : result.project
  })
  const r = result as MoveToSheetResult
  if ("error" in r) {
    if (r.error) uiApi().showNotice(r.error)
    return
  }
  // The symbol selected shows the new sheet's pins in the Inspector, which is the report; the tab waits for a name.
  uiApi().select([`h:${r.symbol.id}`])
  uiApi().setRenamingSheet(r.path)
}

/** The use of the sheet a symbol is drawn on to work from: the one shown when it is one, else the first. */
const parentUse = (p: Project, sheet: string) => {
  const here = shownPath(p)
  return useAt(p, here).sheet === sheet ? here : (usesOfSheet(p, sheet)[0]?.path ?? "")
}

/** The sheet a symbol stands for drawn again beside it, as one undo step. The new use's tab is ready to be named; the sheet shown stays. */
export function reuseSheet(symbolId: string) {
  let path = ""
  projectApi().commit((p) => {
    const sym = p.sheetSymbols?.find((s) => s.id === symbolId)
    if (!sym) return p
    const parent = parentUse(p, sym.sheet)
    const made = addSheetUse(p, parent, sym.child, { minX: sym.x + sym.w + 0.4, minY: sym.y, maxX: sym.x + sym.w * 2 + 0.4, maxY: sym.y + sym.h })
    if (!made) return p
    path = `${parent}/${made.symbol.id}`
    return made.project
  })
  if (path) uiApi().setRenamingSheet(path)
}

/**
 * Sheet symbols deleted as one undo step, with `onShown` (the rest of what the Del key deletes, on the sheet shown) in the same step. A sheet nothing else uses
 * goes with them, and the canvas says what went (`removalNote`, worked out before the edit). When the sheet shown is below one that went, its parent is shown.
 */
export function deleteSheetSymbols(ids: string[], onShown?: (view: Project) => Project) {
  const before = projectApi().project
  if (!before) return
  const note = ids.length ? removalNote(before, ids) : null
  const shown = shownPath(before)
  projectApi().commit((p) => removeSheetSymbols(onShown ? onShownSheet(onShown)(p) : p, ids))
  if (projectApi().project === before) return
  // What was selected of the symbols that went is gone too.
  uiApi().select(uiApi().selection.filter((s) => !ids.some((id) => s === `h:${id}` || s.startsWith(`e:${id}:`))))
  const segments = shown.split("/")
  const cut = segments.findIndex((s, i) => i > 0 && ids.includes(s))
  if (cut > 0) uiApi().setSheet(segments.slice(0, cut).join("/"))
  if (note) uiApi().showNotice(note)
}

/**
 * What is selected on the sheet shown deleted, as one undo step: parts, wires, labels, blocks' frames, drawings, sheet entries, and sheet symbols with what
 * `deleteSheetSymbols` says went with them. The `Del` key and the Inspector's Delete selection both run it. Parts of a locked block are refused, with a note.
 */
export function deleteSelectedHere() {
  const sel = uiApi().selection
  if (!sel.length) return
  const locked = lockedBlockOf(shownProject(), selectedItems(shownProject(), sel).components)
  if (locked) {
    uiApi().showNotice(`${locked} is locked: unlock the group to delete its parts.`)
    return
  }
  const entries = selectionIds(sel, "e").map((key) => key.split(":"))
  deleteSheetSymbols(selectionIds(sel, "h"), (v) =>
    entries.reduce(
      (q, [symbolId, pinId]) => removeSheetPin(q, symbolId, pinId),
      removeItems(v, {
        components: selectionIds(sel, "c"),
        wires: selectionIds(sel, "w"),
        labels: selectionIds(sel, "l"),
        blocks: selectionIds(sel, "b"),
        drawings: selectionIds(sel, "d"),
      }),
    ),
  )
  uiApi().clearSelection()
}

/** A list of names in words: `A`, `A and B`, `A, B and C`. */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""))

/**
 * An edit of the sheet shown (`edit`, on its view) and then the entries and the port of a name on `sheet` kept in step (`syncSheetEntry`, on the whole project),
 * as one undo step. The canvas names what was added beside the edit.
 */
function commitInStep(edit: (view: Project) => Project, sheet: (p: Project) => string, name: string, shape: LabelShape) {
  let added: ReturnType<typeof syncSheetEntry> | null = null
  let child = ""
  projectApi().commit((p) => {
    const edited = commitOnUse(p, shownPath(p), edit)
    if (edited === p) return p
    child = sheet(edited)
    added = syncSheetEntry(edited, child, name, shape)
    return added.project
  })
  const r = added as ReturnType<typeof syncSheetEntry> | null
  if (!r) return
  const p = projectApi().project!
  const sheetName = usesOfSheet(p, child)[0]?.name ?? "the sheet"
  const said = [r.entries.length ? `the entry ${name.trim()} to ${listed(r.entries)}` : "", r.port ? `the port ${name.trim()} inside ${sheetName}` : ""].filter(Boolean)
  if (said.length) uiApi().showNotice(`Added ${said.join(", and ")}.`, "info")
}

/**
 * A port made on the sheet shown (`edit` places one with the label tool, or switches a label to one in the Inspector), with its entry on every symbol of the
 * sheet, as one undo step.
 */
export function commitPort(edit: (view: Project) => Project, name: string, shape: LabelShape) {
  commitInStep(edit, (p) => useAt(p, shownPath(p)).sheet, name, shape)
}

/** An entry added to a sheet symbol on the sheet shown (on `side`, at `at` or the first free place), with its port inside the sheet, as one undo step. */
export function addSheetEntry(symbolId: string, name: string, side: SheetSide, at?: Vec2) {
  const shape: LabelShape = "bidirectional"
  commitInStep((v) => addSheetPin(v, symbolId, name, shape, side, at), (p) => p.sheetSymbols?.find((s) => s.id === symbolId)?.child ?? "", name, shape)
}

/** Show a use of a sheet with a label of it selected and in view. */
export function revealLabel(path: string, labelId: string) {
  const l = projectApi().project?.labels.find((x) => x.id === labelId)
  if (!l) return
  uiApi().setSheet(path)
  uiApi().focus("schematic", l.x, l.y, labelBox(l))
  uiApi().select([`l:${l.id}`])
}

/** Show the port an entry leads to: the use its symbol makes, with the first port of its name selected and in view, or the sheet and a note when it has none. */
export function revealPort(parentPath: string, symbolId: string, pinId: string) {
  const p = projectApi().project
  const path = `${parentPath}/${symbolId}`
  const pin = p?.sheetSymbols?.find((s) => s.id === symbolId)?.pins.find((q) => q.id === pinId)
  if (!p || !pin || !hasUse(p, path)) return
  const use = useAt(p, path)
  const port = p.labels.find((l) => l.kind === "hierarchical" && sheetIdOf(l) === use.sheet && l.name.trim() === pin.name.trim())
  if (port) return revealLabel(path, port.id)
  uiApi().setSheet(path)
  uiApi().showNotice(`${use.name} has no port ${pin.name}: add one with the label tool (Tab to Port).`)
}

/** Show the entry a port on the use at `path` leads to: the sheet above, with the entry of its name on the symbol that makes the use selected and in view. */
export function revealEntry(path: string, name: string) {
  const p = projectApi().project
  if (!p || !hasUse(p, path)) return
  const use = useAt(p, path)
  const pin = use.symbol?.pins.find((q) => q.name.trim() === name.trim())
  if (use.parent === null || !use.symbol || !pin) return
  const box = sheetPinGeometry(pin).box
  uiApi().setSheet(use.parent)
  uiApi().focus("schematic", pin.x, pin.y, box)
  uiApi().select([`e:${use.symbol.id}:${pin.id}`])
}
