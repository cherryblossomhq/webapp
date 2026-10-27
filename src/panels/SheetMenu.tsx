import { Check, FileText } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { renameSheetUse } from "../model/sheetOps"
import { sheetUses, type SheetUse } from "../model/sheets"
import { projectApi, useProjectStore } from "../store/projectStore"
import { shownPath } from "../store/sheetScope"
import { uiApi, useUi } from "../store/uiStore"

// Every sheet of the schematic in one menu, opened from the button at the left of the sheet tabs (or ⌘B), as Excel lists its sheets
// and Figma its pages: `Main` (the root) first, then every use of a sheet in tree order. Nothing in it is a folder: the sheets on Main
// sit beside it, a sheet drawn on one of those is set in under it with a guide line, and a sheet used twice is listed once per use with
// how many uses it has. A click shows that use and closes the menu; a double-click (or F2) renames it; the arrows move between rows.

/** A row of the menu: one use of a sheet. */
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

export function SheetMenu() {
  const project = useProjectStore((s) => s.project)
  const viewer = useProjectStore((s) => s.role === "viewer")
  const sheet = useUi((s) => s.sheet)
  const [renaming, setRenaming] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const uses = useMemo(() => (project ? sheetUses(project) : []), [project])
  const rows = useMemo(() => sheetRows(uses), [uses])
  // The menu opens on the sheet shown, so the arrows start from there.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[aria-current]")?.focus()
  }, [])
  if (!project) return null
  const here = shownPath(project, sheet)
  const show = (path: string) => {
    uiApi().setSheet(path)
    uiApi().setSheetMenu(false)
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
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("li > button") ?? [])]
      const at = buttons.indexOf(e.currentTarget)
      buttons[(at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }

  return (
    <div role="dialog" aria-label="Sheets" className="absolute bottom-full left-0 z-30 mb-1.5 flex max-h-[min(440px,60vh)] w-[264px] flex-col overflow-hidden rounded-[10px] border border-line bg-surface shadow-menu">
      <div className="flex h-9 shrink-0 items-baseline gap-2 px-3 pt-2.5 text-[12px] font-[650] text-ink">
        Sheets <span className="font-normal tabular-nums text-ink-3">{uses.length}</span>
      </div>
      <ul ref={list} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1 pb-1 text-[12.5px]">
        {rows.map(({ use, indent, copies }) => {
          const current = use.path === here
          return (
            <li key={use.path || "root"} className="flex">
              {Array.from({ length: indent }, (_, i) => (
                <span key={i} aria-hidden className={GUIDE} />
              ))}
              {renaming === use.path ? (
                <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] bg-chrome px-2 ring-1 ring-brand">
                  <FileText size={14} className="shrink-0 text-ink-2" />
                  <input
                    autoFocus
                    aria-label={`Rename ${use.name}`}
                    defaultValue={use.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => e.currentTarget.dataset.cancel !== "1" && rename(use.path, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Escape gives up the new name and leaves the menu open; the field going may still say it lost focus.
                      e.stopPropagation()
                      if (e.key === "Enter") e.currentTarget.blur()
                      else if (e.key === "Escape") {
                        e.currentTarget.dataset.cancel = "1"
                        setRenaming(null)
                      }
                    }}
                    className="h-6 min-w-0 flex-1 bg-transparent text-[12.5px] font-[600] text-ink outline-none"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  title={viewer ? use.name : `${use.name}. Double-click to rename`}
                  className={`group flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-brand ${
                    current ? "bg-chrome font-[600] text-ink" : "text-ink-2 hover:bg-chrome hover:text-ink focus-visible:bg-chrome"
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
                  <Check size={13} aria-hidden className={`shrink-0 text-brand ${current ? "" : "invisible"}`} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <p className="shrink-0 border-t border-line px-3 py-2 text-[11px] leading-snug text-ink-3">{viewer ? "⌥↑ goes up a level." : "Double-click a name to rename it. ⌥↑ goes up a level."}</p>
    </div>
  )
}
