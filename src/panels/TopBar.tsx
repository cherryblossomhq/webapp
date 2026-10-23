import { ChevronLeft, Eye, Redo2, Settings, Undo2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { goHome } from "../App"
import { usePresence } from "../store/presence"
import { projectApi, projectStorage, useProjectStore } from "../store/projectStore"
import { useUi, type View } from "../store/uiStore"
import { IconButton, Segmented } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"
import { AccountMenu } from "./AccountMenu"
import { Collaborators, OfflinePill } from "./Collaborators"
import { ExportMenu } from "./ExportMenu"
import { ThemeButton } from "./ThemeButton"
import { checkTotals, useChecks } from "./ChecksPanel"
import { ShareButton, ShareDialog } from "./ShareDialog"

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
  const viewer = useProjectStore((s) => s.role === "viewer")
  const together = usePresence((s) => s.peers.length > 0)
  const [draft, setDraft] = useState(name)
  // Someone else's rename shows at once, except over a name the user is typing: theirs lands, then
  // the user's when they press Enter, as with any other value two people edit at once.
  const typing = useRef(false)
  // Whether a key was pressed in the field: a click in and out commits nothing, or the name it
  // showed when it was focused would land over someone else's rename made meanwhile.
  const typed = useRef(false)
  useEffect(() => {
    if (!typing.current) setDraft(name)
  }, [name])
  const [sharing, setSharing] = useState(false)
  const canShare = !!projectStorage()?.sharing

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
          readOnly={viewer}
          className={`h-8 min-w-0 max-w-[260px] flex-1 truncate rounded-[6px] border border-transparent bg-transparent px-2 font-[600] text-ink outline-none ${viewer ? "" : "hover:border-line focus:border-select focus:bg-surface"}`}
          value={draft}
          onChange={(e) => {
            typed.current = true
            setDraft(e.target.value)
          }}
          onFocus={() => {
            typing.current = true
            typed.current = false
          }}
          onBlur={() => {
            typing.current = false
            const v = draft.trim()
            if (typed.current && v && v !== name) projectApi().commit((p) => ({ ...p, name: v, updatedAt: Date.now() }))
            else setDraft(name)
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {viewer && (
          <Tooltip label="View only" hint="You can look around, select, run checks and export. Ask the owner for edit access to change it.">
            <span className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-chrome-2 px-2 text-[11.5px] font-[600] text-ink-2">
              <Eye size={12} />
              View only
            </span>
          </Tooltip>
        )}
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
        <OfflinePill />
        <Collaborators />
        {canShare && <ShareButton onClick={() => setSharing(true)} />}
        {(canShare || viewer) && <span className="mx-1 h-4 w-px bg-line" />}
        <IconButton label="Undo" shortcut="⌘Z" hint={together ? "Undoes your own changes, not other people's" : undefined} disabled={!canUndo || viewer} onClick={() => projectApi().undo()}>
          <Undo2 size={17} />
        </IconButton>
        <IconButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo || viewer} onClick={() => projectApi().redo()}>
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
      {sharing && <ShareDialog onClose={() => setSharing(false)} />}
    </header>
  )
}
