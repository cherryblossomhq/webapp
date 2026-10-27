import { addSheetInFreeSpace } from "../../model/sheetOps"
import { moveToNewSheet, type MoveToSheetResult } from "../../model/sheetRefactor"
import { projectApi } from "../../store/projectStore"
import { shownPath } from "../../store/sheetScope"
import { selectionIds, uiApi } from "../../store/uiStore"

// Making sheets by hand: a new empty one from the tabs' +, and the selection moved onto one of its own (the Inspector's button). Each is one undo
// step, and the new sheet's tab is then ready to be named.

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
