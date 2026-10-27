import { ListTree, Plus } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { addNewSheet } from "../editor/schematic/sheetActions"
import { renameSheetUse } from "../model/sheetOps"
import { sheetUses, type SheetUse } from "../model/sheets"
import { projectApi, useProjectStore } from "../store/projectStore"
import { shownPath } from "../store/sheetScope"
import { uiApi, useUi } from "../store/uiStore"
import { IconButton, useDismiss } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"
import { SheetMenu } from "./SheetMenu"

// The schematic's sheets as tabs docked under the canvas, as Altium's document tabs and a spreadsheet's sheet tabs are: one per use of
// a sheet, in tree order, the one shown raised. A tab says where its sheet is in the tree when it is pointed at, and a double-click
// renames it. The + after them makes a new sheet (its symbol in free space on the sheet shown) and opens it, its tab ready to be named;
// the button at the left (⌘B) opens the menu of every sheet once there are two. A viewer of a project of one sheet has no tabs.

/** The names from Main down to a use: `Main › MCU › LED driver`. */
function trail(byPath: Map<string, SheetUse>, use: SheetUse): string {
  const names = [use.name]
  for (let u = use; u.parent !== null; ) {
    const parent = byPath.get(u.parent)
    if (!parent) break
    names.unshift(parent.name)
    u = parent
  }
  return names.join(" › ")
}

const rename = (path: string, name: string) => {
  uiApi().setRenamingSheet(null)
  const p = projectApi().project
  if (p && renameSheetUse(p, path, name) !== p) projectApi().commit((x) => renameSheetUse(x, path, name))
}

export function SheetTabs() {
  const project = useProjectStore((s) => s.project)
  const viewer = useProjectStore((s) => s.role === "viewer")
  const sheet = useUi((s) => s.sheet)
  const menuOpen = useUi((s) => s.sheetMenuOpen)
  const renaming = useUi((s) => s.renamingSheet)
  const menu = useRef<HTMLDivElement>(null)
  useDismiss(menu, menuOpen, () => uiApi().setSheetMenu(false))
  // The menu and a rename go with the tabs (another view, another project).
  useEffect(
    () => () => {
      uiApi().setSheetMenu(false)
      uiApi().setRenamingSheet(null)
    },
    [],
  )
  const uses = useMemo(() => (project ? sheetUses(project) : []), [project])
  const byPath = useMemo(() => new Map(uses.map((u) => [u.path, u])), [uses])
  const copies = useMemo(() => {
    const n = new Map<string, number>()
    for (const u of uses) n.set(u.sheet, (n.get(u.sheet) ?? 0) + 1)
    return n
  }, [uses])
  const strip = useRef<HTMLDivElement>(null)
  const here = project ? shownPath(project, sheet) : ""
  // The tab of the sheet shown is in view, however it was opened (the menu, a sheet symbol, ⌥↑, the +). The strip is scrolled itself:
  // `scrollIntoView` would scroll the canvas's clipped boxes too.
  useEffect(() => {
    const box = strip.current
    const tab = box?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!box || !tab) return
    if (tab.offsetLeft < box.scrollLeft) box.scrollLeft = tab.offsetLeft
    else if (tab.offsetLeft + tab.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = tab.offsetLeft + tab.offsetWidth - box.clientWidth
  }, [here, uses, renaming])
  if (!project || (viewer && uses.length < 2)) return null
  const several = uses.length > 1

  return (
    <nav aria-label="Sheet tabs" className="relative flex h-9 shrink-0 items-center gap-1 border-t border-line bg-chrome pl-1 pr-2">
      {several && (
        <>
          <div ref={menu} className="relative">
            <IconButton label="All sheets" shortcut="⌘B" active={menuOpen} aria-haspopup="dialog" aria-expanded={menuOpen} className="h-7 w-7" onClick={() => uiApi().setSheetMenu(!menuOpen)}>
              <ListTree size={15} />
            </IconButton>
            {menuOpen && <SheetMenu />}
          </div>
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
        </>
      )}
      <div
        ref={strip}
        role="tablist"
        aria-label="Sheets"
        className="relative flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        // A mouse wheel scrolls the tabs sideways.
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {uses.map((u) => {
          const current = u.path === here
          const n = copies.get(u.sheet) ?? 1
          if (renaming === u.path && !viewer)
            return (
              <input
                key={u.path || "root"}
                role="tab"
                aria-selected={current}
                autoFocus
                aria-label={`Rename ${u.name}`}
                defaultValue={u.name}
                onFocus={(e) => e.currentTarget.select()}
                // Escape gives the name up; a browser may still say the field lost focus as it goes, which must not keep what was typed.
                onBlur={(e) => e.currentTarget.dataset.cancel !== "1" && rename(u.path, e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === "Enter") e.currentTarget.blur()
                  else if (e.key === "Escape") {
                    e.currentTarget.dataset.cancel = "1"
                    uiApi().setRenamingSheet(null)
                  }
                }}
                className="h-7 min-w-[64px] max-w-[220px] shrink-0 rounded-[6px] bg-raised px-3 text-[12px] font-[600] text-ink shadow-chip outline-none ring-1 ring-brand [field-sizing:content]"
              />
            )
          return (
            <Tooltip key={u.path || "root"} label={trail(byPath, u)} hint={n > 1 ? `One of ${n} uses of this sheet` : viewer ? undefined : "Double-click to rename"}>
              <button
                type="button"
                role="tab"
                aria-selected={current}
                onClick={() => uiApi().setSheet(u.path)}
                onDoubleClick={() => !viewer && uiApi().setRenamingSheet(u.path)}
                className={`flex h-7 shrink-0 items-center rounded-[6px] px-3 text-[12px] transition-colors ${
                  current ? "bg-raised font-[600] text-ink shadow-chip" : "font-medium text-ink-2 hover:bg-hover hover:text-ink"
                }`}
              >
                <span className="max-w-[180px] truncate">{u.name}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
      {!viewer && (
        <IconButton label="New sheet" hint="An empty sheet, drawn as a sheet symbol on the sheet shown" className="h-7 w-7 shrink-0" onClick={addNewSheet}>
          <Plus size={15} />
        </IconButton>
      )}
    </nav>
  )
}
