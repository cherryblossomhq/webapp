import { partUsers, removeParts } from "../model/projectParts"
import { projectApi } from "../store/projectStore"
import { uiApi } from "../store/uiStore"

// What the library panel and the part editor do to the project's own parts, the same from either.

/** The designators of the components placed from a part, each once (a part's units share one). */
export const partRefs = (ids: string[]) => {
  const project = projectApi().project
  return project ? [...new Set(ids.flatMap((id) => partUsers(project, id).map((c) => c.ref)))] : []
}

/** A list in words, the first `most` of it: "U1, U2 and U3", "U1, U2, U3 and 5 more". */
export function listed(items: string[], most = 6) {
  if (items.length > most) return `${items.slice(0, most).join(", ")} and ${items.length - most} more`
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/**
 * Take parts out of the project, with the components placed from them, as one undo step: a part
 * being placed stops, and the selection loses what went. The line over the canvas says what was
 * removed, since the panel row it was clicked on is gone.
 */
export function removeProjectParts(ids: string[]) {
  const project = projectApi().project
  if (!project || !ids.length) return
  const names = (project.parts ?? []).filter((s) => ids.includes(s.id)).map((s) => s.name)
  const refs = partRefs(ids)
  projectApi().commit((p) => removeParts(p, ids))
  if (projectApi().project === project) return
  const ui = uiApi()
  const placing = ui.placing?.partId.replace(/@sub$/, "")
  if (placing && ids.includes(placing)) ui.stopPlacing()
  const left = new Set(projectApi().project!.components.map((c) => `c:${c.id}`))
  if (ui.selection.some((s) => s.startsWith("c:") && !left.has(s))) ui.select(ui.selection.filter((s) => !s.startsWith("c:") || left.has(s)))
  const what = names.length === 1 ? names[0] : `${names.length} parts`
  ui.showNotice(`Removed ${what}${refs.length ? ` and ${listed(refs)}` : ""} from the project. Undo brings ${names.length === 1 && !refs.length ? "it" : "them"} back.`)
}
