import { commitOnUse, hasUse, sheetView } from "../model/sheets"
import type { Project } from "../model/types"
import { projectApi } from "./projectStore"
import { uiApi } from "./uiStore"

// S1 in the editor: the schematic shows one use of a sheet at a time (`uiStore.sheet`, a path of sheet symbols, "" for the root). What it
// draws and what it edits is a view of that use (`model/sheets.ts`); an edit is made on the view and put back in the project, with the other
// uses of a sheet used twice made alike. For a project of one sheet the view is the project and an edit is the edit: nothing changes.

/** The use of a sheet shown, as a path that exists in the project (the root when the one that was shown went with a deleted sheet symbol). */
export const shownPath = (p: Project, path = uiApi().sheet) => (hasUse(p, path) ? path : "")

/** The project as the sheet shown has it. */
export const shownProject = (p: Project = projectApi().project!, path?: string) => sheetView(p, shownPath(p, path))

/** An edit of the sheet shown: `fn` gets and returns a view of it, and the change is put back in the whole project. */
export const onShownSheet = (fn: (view: Project) => Project) => (p: Project) => commitOnUse(p, shownPath(p), fn)

/** Undoable edit of the sheet shown. */
export const commitHere = (fn: (view: Project) => Project) => projectApi().commit(onShownSheet(fn))
/** A change of the sheet shown during a drag. */
export const dragHere = (fn: (view: Project) => Project) => projectApi().setTransient(onShownSheet(fn))
/** End a drag, with the sheet shown's final state. */
export const dropHere = (fn: (view: Project) => Project) => projectApi().endTransient(onShownSheet(fn))

/** The use of a sheet a part is on (the root for a part that is not on a sheet the project has). */
const pathOfPart = (p: Project, id: string) => {
  const inst = p.components.find((c) => c.id === id)?.inst ?? ""
  return hasUse(p, inst) ? inst : ""
}

/** The project as the sheet a part is on has it: what an edit of that part works on, whichever sheet is shown. */
export const viewFor = (id: string, p: Project = projectApi().project!) => sheetView(p, pathOfPart(p, id))

/** Undoable edit of the sheet a part is on. */
export const commitFor = (id: string, fn: (view: Project) => Project) => projectApi().commit((p) => commitOnUse(p, pathOfPart(p, id), fn))

