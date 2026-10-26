import { ChevronLeft, Redo2, Settings, Undo2 } from "lucide-react"
import { useEffect, useState } from "react"
import { goHome } from "../App"
import { projectApi, useProjectStore } from "../store/projectStore"
import { useUi, type View } from "../store/uiStore"
import { IconButton, Segmented } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"
import { AccountMenu } from "./AccountMenu"
import { ExportMenu } from "./ExportMenu"
import { ThemeButton } from "./ThemeButton"
import { checkTotals, useChecks } from "./ChecksPanel"

export function TopBar() {
  const name = useProjectStore((s) => s.project?.name ?? "")
  const panelOpen = useUi((s) => s.panelOpen)
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)
  const view = useUi((s) => s.view)
  const setView = useUi((s) => s.setView)
  const sidePanel = useUi((s) => s.sidePanel)
  const setSidePanel = useUi((s) => s.setSidePanel)
  const checksShown = panelOpen && sidePanel === "checks"
  const { errors, warnings } = checkTotals(useChecks())
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <IconButton label="All projects" onClick={goHome}>
          <ChevronLeft size={18} />
        </IconButton>
        <span className="hidden items-center gap-1.5 text-[15px] font-[750] tracking-[-0.01em] text-ink lg:flex">
          <img src="/logo.svg" alt="" className="size-5" />
          Cherry Blossom
        </span>
        <span className="mx-1 hidden h-4 w-px bg-line lg:inline" />
        <input
          aria-label="Project name"
          className="h-8 min-w-0 max-w-[260px] flex-1 truncate rounded-[6px] border border-transparent bg-transparent px-2 font-[600] text-ink outline-none hover:border-line focus:border-select focus:bg-surface"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = draft.trim()
            if (v && v !== name) projectApi().commit((p) => ({ ...p, name: v, updatedAt: Date.now() }))
            else setDraft(name)
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>

      <Segmented<View>
        value={view}
        onChange={setView}
        options={[
          { value: "schematic", label: "Schematic" },
          { value: "pcb", label: "PCB" },
          { value: "3d", label: "3D" },
        ]}
      />

      <div className="flex flex-1 items-center justify-end gap-1.5">
        <IconButton label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => projectApi().undo()}>
          <Undo2 size={17} />
        </IconButton>
        <IconButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => projectApi().redo()}>
          <Redo2 size={17} />
        </IconButton>
        <span className="mx-1 h-4 w-px bg-line" />
        <Tooltip label="Design checks" hint="Problems found on the board">
          <button
            onClick={() => setSidePanel(checksShown ? "inspector" : "checks")}
            aria-pressed={checksShown}
            className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[12.5px] font-[600] ${checksShown ? "bg-chrome-2" : "hover:bg-chrome"}`}
          >
            <span className={`h-2 w-2 rounded-full ${errors ? "bg-danger" : warnings ? "bg-warn" : "bg-ok"}`} />
            <span className="text-ink">{errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : "Checks pass"}</span>
          </button>
        </Tooltip>
        <ExportMenu />
        <ThemeButton />
        <IconButton label="Settings" onClick={() => useUi.getState().setSettingsOpen(true)}>
          <Settings size={17} />
        </IconButton>
        <AccountMenu />
      </div>
    </header>
  )
}
