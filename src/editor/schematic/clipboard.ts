import { contentsOf } from "../../model/blocks"
import type { Project } from "../../model/types"
import { selectionIds } from "../../store/uiStore"

// Copy on the schematic: what a selection copies. Pasting it back is `pasteItems` in
// `model/schematicEdit.ts`, which refuses a paste that would change what the sheet's pins connect to.

/** The selected parts, wires, labels and drawings, with everything the selected blocks hold. */
export function selectedItems(p: Project, sel: string[]) {
  const held = contentsOf(p, selectionIds(sel, "b"))
  return {
    components: [...new Set([...selectionIds(sel, "c"), ...held.components])],
    labels: [...new Set([...selectionIds(sel, "l"), ...held.labels])],
    wires: [...new Set([...selectionIds(sel, "w"), ...held.wires])],
    drawings: [...new Set([...selectionIds(sel, "d"), ...held.drawings])],
  }
}
