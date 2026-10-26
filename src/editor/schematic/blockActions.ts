import { groupSelection, ungroupSelection } from "../../model/blocks"
import { projectApi } from "../../store/projectStore"
import { selectionIds, uiApi } from "../../store/uiStore"

// Grouping by hand, for the ⌘G and ⇧⌘G shortcuts and the Inspector's buttons alike.

/** ⌘G: the selected parts, and those of the selected blocks, join the first selected block or a new one, which is then selected. */
export function groupSelected() {
  const sel = uiApi().selection
  const components = selectionIds(sel, "c")
  const blocks = selectionIds(sel, "b")
  if (!components.length && !blocks.length) return
  const { project, blockId } = groupSelection(projectApi().project!, components, blocks)
  projectApi().commit(() => project)
  if (blockId) uiApi().select([`b:${blockId}`])
}

/** ⇧⌘G: the selected blocks go and the selected parts leave theirs. Whatever was freed is selected. */
export function ungroupSelected() {
  const sel = uiApi().selection
  const components = selectionIds(sel, "c")
  const blocks = selectionIds(sel, "b")
  if (!components.length && !blocks.length) return
  const before = projectApi().project!
  const freed = (before.blocks ?? []).filter((b) => blocks.includes(b.id)).flatMap((b) => b.components)
  projectApi().commit(() => ungroupSelection(before, components, blocks))
  uiApi().select([...new Set([...sel.filter((id) => !id.startsWith("b:")), ...freed.map((id) => `c:${id}`)])])
}
