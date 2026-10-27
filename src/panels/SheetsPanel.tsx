import { FileText, PanelLeftClose } from "lucide-react"
import { useMemo, useState, type KeyboardEvent } from "react"
import { renameSheetUse } from "../model/sheetOps"
import { sheetUses, type SheetUse } from "../model/sheets"
import { projectApi, useProjectStore } from "../store/projectStore"
import { shownPath } from "../store/sheetScope"
import { uiApi, useUi } from "../store/uiStore"
import { IconButton } from "../ui/controls"

// The schematic's sheets, as Altium's Projects panel lists a project's documents: every sheet is a row, in page order, `Main` (the root)
// first. Nothing in it is a folder: the sheets on Main sit beside it as the pages of one schematic, and a sheet drawn on one of those is
// set in under it with a guide line. A sheet used twice is listed once per use, marked with how many uses it has. A click shows that
// use, a double-click (or F2) renames it. A project of one sheet has no tree: the editor does not draw the panel for it.

/** A row of the tree: one use of a sheet. */
export interface SheetRow {
  use: SheetUse
  /** How far it is set in: none for Main and the sheets on it, one more for each sheet above it after those. */
  indent: number
  /** How many uses its sheet has: more than one is a sheet drawn once and used again. */
  copies: number
}

/** The rows to draw: every use in tree order. */
export function sheetRows(uses: SheetUse[]): SheetRow[] {
  const copies = new Map<string, number>()
  for (const u of uses) copies.set(u.sheet, (copies.get(u.sheet) ?? 0) + 1)
  return uses.map((use) => ({ use, indent: Math.max(0, use.depth - 1), copies: copies.get(use.sheet)! }))
}

/** Where a guide line runs: under the middle of the icon of the row it hangs from. */
const GUIDE = "relative w-4 shrink-0 self-stretch before:absolute before:inset-y-0 before:left-[14.5px] before:w-px before:bg-line"

export function SheetsPanel() {
  const project = useProjectStore((s) => s.project)
  const viewer = useProjectStore((s) => s.role === "viewer")
  const sheet = useUi((s) => s.sheet)
  const [renaming, setRenaming] = useState<string | null>(null)
  const uses = useMemo(() => (project ? sheetUses(project) : []), [project])
  const rows = useMemo(() => sheetRows(uses), [uses])
  if (!project) return null
  const here = shownPath(project, sheet)
  const show = (path: string) => {
    uiApi().setView("schematic")
    uiApi().setSheet(path)
  }
  const rename = (path: string, name: string) => {
    setRenaming(null)
    const p = projectApi().project
    if (p && renameSheetUse(p, path, name) !== p) projectApi().commit((x) => renameSheetUse(x, path, name))
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, path: string) => {
    if (e.key === "F2" && !viewer) {
      e.preventDefault()
      setRenaming(path)
    }
  }

  return (
    <aside aria-label="Sheets" className="flex w-[240px] shrink-0 flex-col border-r border-line bg-chrome">
      <div className="flex h-11 shrink-0 items-center justify-between pl-3.5 pr-1.5">
        <h2 className="flex items-baseline gap-2 text-[13px] font-[650] text-ink">
          Sheets <span className="text-[12px] font-normal tabular-nums text-ink-3">{uses.length}</span>
        </h2>
        <IconButton label="Hide sheets" shortcut="⌘B" onClick={() => uiApi().toggleSheets()}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[12.5px]">
        {rows.map(({ use, indent, copies }) => {
          const current = use.path === here
          return (
            <li key={use.path || "root"} className="flex">
              {Array.from({ length: indent }, (_, i) => (
                <span key={i} aria-hidden className={GUIDE} />
              ))}
              {renaming === use.path ? (
                <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] bg-raised px-2 shadow-chip">
                  <FileText size={14} className="shrink-0 text-ink-2" />
                  <input
                    autoFocus
                    aria-label={`Rename ${use.name}`}
                    defaultValue={use.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => rename(use.path, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur()
                      else if (e.key === "Escape") setRenaming(null)
                    }}
                    className="h-6 min-w-0 flex-1 bg-transparent text-[12.5px] font-[600] text-ink outline-none"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  title={viewer ? `${use.name}, page ${use.page}` : `${use.name}, page ${use.page}. Double-click to rename`}
                  className={`group flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-left transition-colors ${
                    current ? "bg-raised font-[600] text-ink shadow-chip" : "text-ink-2 hover:bg-hover hover:text-ink"
                  }`}
                  onClick={() => show(use.path)}
                  onDoubleClick={() => !viewer && setRenaming(use.path)}
                  onKeyDown={(e) => onKey(e, use.path)}
                >
                  <FileText size={14} className={`shrink-0 ${current ? "text-brand" : "text-ink-3 group-hover:text-ink-2"}`} />
                  <span className="min-w-0 flex-1 truncate">{use.name}</span>
                  {copies > 1 && (
                    <span className="shrink-0 rounded-[4px] bg-chrome-2 px-1 text-[10.5px] font-medium tabular-nums text-ink-2" title={`This sheet is used ${copies} times; an edit on one use is made on every use`}>
                      ×{copies}
                    </span>
                  )}
                  <span className={`w-5 shrink-0 text-right text-[11px] font-normal tabular-nums ${current ? "text-ink-2" : "text-ink-3"}`}>{use.page}</span>
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <p className="shrink-0 border-t border-line px-3 py-2 text-[11px] leading-snug text-ink-3">
        {viewer ? "Double-click a sheet symbol to open its sheet." : "Double-click a sheet symbol to open its sheet, or a name here to rename it."} ⌥↑ goes up a level.
      </p>
    </aside>
  )
}
