import { ArrowUp, ChevronRight } from "lucide-react"
import { useMemo } from "react"
import { hasUse, isHierarchical, sheetUses } from "../model/sheets"
import { useProjectStore } from "../store/projectStore"
import { shownPath } from "../store/sheetScope"
import { uiApi, useUi } from "../store/uiStore"

// S1: where the schematic is in the tree of sheets: the sheet shown as a path from the root, a button to go up to the sheet above, and a list of
// every sheet with its page. A project of one sheet has none of it.

export function SheetNavigator() {
  const project = useProjectStore((s) => s.project)
  const sheet = useUi((s) => s.sheet)
  const uses = useMemo(() => (project && isHierarchical(project) ? sheetUses(project) : []), [project])
  if (!project || uses.length < 2) return null
  const path = hasUse(project, sheet) ? sheet : shownPath(project, sheet)
  const here = uses.find((u) => u.path === path) ?? uses[0]
  const chain = (() => {
    const out = [here]
    for (let u = here; u.parent !== null; ) {
      const parent = uses.find((x) => x.path === u.parent)
      if (!parent) break
      out.unshift(parent)
      u = parent
    }
    return out
  })()
  const label = (u: (typeof uses)[number]) => (u.path === "" ? project.name : u.name)
  return (
    <div className="pointer-events-auto flex max-w-[min(80vw,520px)] items-center gap-1 rounded-[10px] border border-line bg-surface/95 p-1 text-[12px] shadow-float backdrop-blur" aria-label="Sheets">
      <button
        type="button"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-ink-2 hover:bg-hover disabled:opacity-40"
        title="Up to the sheet above (Alt+Up)"
        aria-label="Up to the sheet above"
        disabled={here.parent === null}
        onClick={() => uiApi().setSheet(here.parent ?? "")}
      >
        <ArrowUp size={14} />
      </button>
      <ol className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        {chain.map((u, i) => (
          <li key={u.path} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <ChevronRight size={12} className="shrink-0 text-ink-3" />}
            <button type="button" className={`truncate rounded-[6px] px-1.5 py-0.5 ${u.path === here.path ? "font-[600] text-ink" : "text-ink-2 hover:bg-hover"}`} onClick={() => uiApi().setSheet(u.path)}>
              {label(u)}
            </button>
          </li>
        ))}
      </ol>
      <select
        className="field h-7 max-w-[170px] shrink-0 text-[12px]"
        aria-label="Go to a sheet"
        value={here.path}
        onChange={(e) => uiApi().setSheet(e.target.value)}
      >
        {uses.map((u) => (
          <option key={u.path || "root"} value={u.path}>
            {`${" ".repeat(u.depth)}${label(u)}  (page ${u.page})`}
          </option>
        ))}
      </select>
    </div>
  )
}
