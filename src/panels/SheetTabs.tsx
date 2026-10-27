import { ListTree } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { sheetUses, type SheetUse } from "../model/sheets"
import { useProjectStore } from "../store/projectStore"
import { shownPath } from "../store/sheetScope"
import { uiApi, useUi } from "../store/uiStore"
import { IconButton, useDismiss } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"
import { SheetMenu } from "./SheetMenu"

// The schematic's sheets as tabs docked under the canvas, as Altium's document tabs and a spreadsheet's sheet tabs are: one per use of
// a sheet, in tree order, the one shown raised. A tab says where its sheet is in the tree when it is pointed at; the button at the left
// (⌘B) opens the menu of every sheet. A project of one sheet has no tabs.

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

export function SheetTabs() {
  const project = useProjectStore((s) => s.project)
  const sheet = useUi((s) => s.sheet)
  const menuOpen = useUi((s) => s.sheetMenuOpen)
  const menu = useRef<HTMLDivElement>(null)
  useDismiss(menu, menuOpen, () => uiApi().setSheetMenu(false))
  // The menu goes with the tabs (another view, another project).
  useEffect(() => () => uiApi().setSheetMenu(false), [])
  const uses = useMemo(() => (project ? sheetUses(project) : []), [project])
  const byPath = useMemo(() => new Map(uses.map((u) => [u.path, u])), [uses])
  const copies = useMemo(() => {
    const n = new Map<string, number>()
    for (const u of uses) n.set(u.sheet, (n.get(u.sheet) ?? 0) + 1)
    return n
  }, [uses])
  const strip = useRef<HTMLDivElement>(null)
  const here = project ? shownPath(project, sheet) : ""
  // The tab of the sheet shown is in view, however it was opened (the tree, a sheet symbol, ⌥↑). The strip is scrolled itself:
  // `scrollIntoView` would scroll the canvas's clipped boxes too.
  useEffect(() => {
    const box = strip.current
    const tab = box?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!box || !tab) return
    if (tab.offsetLeft < box.scrollLeft) box.scrollLeft = tab.offsetLeft
    else if (tab.offsetLeft + tab.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = tab.offsetLeft + tab.offsetWidth - box.clientWidth
  }, [here, uses])
  if (!project || uses.length < 2) return null

  return (
    <nav aria-label="Sheet tabs" className="relative flex h-9 shrink-0 items-center gap-1 border-t border-line bg-chrome pl-1 pr-2">
      <div ref={menu} className="relative">
        <IconButton label="All sheets" shortcut="⌘B" active={menuOpen} aria-haspopup="dialog" aria-expanded={menuOpen} className="h-7 w-7" onClick={() => uiApi().setSheetMenu(!menuOpen)}>
          <ListTree size={15} />
        </IconButton>
        {menuOpen && <SheetMenu />}
      </div>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
      <div
        ref={strip}
        role="tablist"
        aria-label="Sheets"
        className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        // A mouse wheel scrolls the tabs sideways.
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {uses.map((u) => {
          const current = u.path === here
          const n = copies.get(u.sheet) ?? 1
          return (
            <Tooltip key={u.path || "root"} label={trail(byPath, u)} hint={n > 1 ? `One of ${n} uses of this sheet` : undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={current}
                onClick={() => uiApi().setSheet(u.path)}
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
    </nav>
  )
}
