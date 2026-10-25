import { createGroup, expandToGroups, memberOfSelection, setGroupLocked, topGroup, ungroup } from "../../model/boardObjects"
import type { PcbGroup, Project } from "../../model/types"
import { projectApi } from "../../store/projectStore"
import { uiApi } from "../../store/uiStore"

// What the PCB view does with groups, from the keys, the Inspector and the menus: group the selection, take a group apart, lock it. Each is one undo step.

/** The outermost groups the selection is in, each once. */
export function selectedGroups(project: Project, selection: string[]): PcbGroup[] {
  const out = new Map<string, PcbGroup>()
  for (const s of selection) {
    const m = memberOfSelection(s)
    const top = m ? topGroup(project, m) : null
    if (top) out.set(top.id, top)
  }
  return [...out.values()]
}

/** Groups what is selected (Ctrl or Cmd G); the new group is selected whole. */
export function groupSelected(name = ""): boolean {
  const p = projectApi().project
  if (!p) return false
  const res = createGroup(p, uiApi().selection, name)
  if (!res) {
    uiApi().showNotice("Select something on the board to group")
    return false
  }
  projectApi().commit(() => res.project)
  uiApi().select(expandToGroups(res.project, uiApi().selection))
  return true
}

/** Takes apart the outermost groups the selection is in (Ctrl or Cmd Shift G): what was in each stays selected and goes on its own, or into the group the group was in. */
export function ungroupSelected(): boolean {
  const p = projectApi().project
  if (!p) return false
  const tops = selectedGroups(p, uiApi().selection)
  if (!tops.length) return false
  projectApi().commit((x) => tops.reduce((acc, g) => ungroup(acc, g.id), x))
  return true
}

/** Locks or unlocks the groups the selection is in: everything in a locked group stays where it is. */
export function lockSelectedGroups(locked: boolean): boolean {
  const p = projectApi().project
  if (!p) return false
  const tops = selectedGroups(p, uiApi().selection)
  if (!tops.length) return false
  projectApi().commit((x) => tops.reduce((acc, g) => setGroupLocked(acc, g.id, locked), x))
  return true
}
