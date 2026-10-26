import { ChevronDown, ChevronRight, FileText, PanelLeftClose } from "lucide-react"
import { useMemo, useState } from "react"
import { sheetUses, type SheetUse } from "../model/sheets"
import { useProjectStore } from "../store/projectStore"
import { shownPath } from "../store/sheetScope"
import { uiApi, useUi } from "../store/uiStore"
import { IconButton } from "../ui/controls"

// The schematic's sheets as a tree on the left, like a file tree: the root sheet, and under it each sheet symbol's use of a sheet, so a sheet
// used twice is listed once under each symbol that uses it. A click shows that use (the navigator's own `setSheet`). A project of one sheet has
// no tree: the editor does not draw the panel for it.

/** A row of the tree: one use of a sheet, with whether it has uses under it. */
export interface SheetRow {
  use: SheetUse
  hasChildren: boolean
  collapsed: boolean
}

/** The rows to draw: every use in tree order, leaving out the ones under a use in `collapsed` (paths). */
export function sheetRows(uses: SheetUse[], collapsed: ReadonlySet<string>): SheetRow[] {
  const parents = new Set(uses.map((u) => u.parent))
  const hidden = new Set<string>()
  const rows: SheetRow[] = []
  for (const use of uses) {
    if (use.parent !== null && (hidden.has(use.parent) || collapsed.has(use.parent))) {
      hidden.add(use.path)
      continue
    }
    rows.push({ use, hasChildren: parents.has(use.path), collapsed: collapsed.has(use.path) })
  }
  return rows
}

export function SheetsPanel() {
  const project = useProjectStore((s) => s.project)
  const sheet = useUi((s) => s.sheet)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const uses = useMemo(() => (project ? sheetUses(project) : []), [project])
  const rows = useMemo(() => sheetRows(uses, collapsed), [uses, collapsed])
  if (!project) return null
  const here = shownPath(project, sheet)
  const fold = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(path)) next.add(path)
      return next
    })
  const show = (path: string) => {
    uiApi().setView("schematic")
    uiApi().setSheet(path)
  }

  return (
    <aside aria-label="Sheets" className="flex w-[240px] shrink-0 flex-col border-r border-line bg-chrome">
      <div className="flex h-11 shrink-0 items-center justify-between pl-3.5 pr-1.5">
        <h2 className="text-[13px] font-[650] text-ink">Sheets</h2>
        <IconButton label="Hide sheets" shortcut="⌘B" onClick={() => uiApi().toggleSheets()}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 text-[12.5px]">
        {rows.map(({ use, hasChildren, collapsed: folded }) => {
          const current = use.path === here
          const name = use.path === "" ? project.name : use.name
          return (
            <li key={use.path || "root"} className="flex items-center" style={{ paddingLeft: use.depth * 14 }}>
              {hasChildren ? (
                <button
                  type="button"
                  className="grid h-6 w-5 shrink-0 place-items-center rounded-[5px] text-ink-3 hover:bg-hover hover:text-ink"
                  aria-label={`${folded ? "Show" : "Hide"} the sheets under ${name}`}
                  aria-expanded={!folded}
                  onClick={() => fold(use.path)}
                >
                  {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                title={`${name}  (page ${use.page})`}
                className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 text-left ${current ? "bg-active font-[600] text-on-active" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
                onClick={() => show(use.path)}
              >
                <FileText size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className={`shrink-0 text-[11px] ${current ? "opacity-80" : "text-ink-3"}`}>{use.page}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
