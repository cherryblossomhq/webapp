import { ListChecks, Package, PanelRightClose, SlidersHorizontal, Sparkles } from "lucide-react"
import { lazy, Suspense, useEffect, type ReactNode } from "react"
import { PcbEditor } from "../editor/pcb/PcbEditor"
import { SchematicEditor } from "../editor/schematic/SchematicEditor"
import { stopCleanup } from "../editor/schematic/cleanupAction"
import { stopTidy } from "../editor/schematic/tidyAction"
import { stopZoneFills } from "../store/analysis"
import { isTyping } from "../editor/viewport"
import { CanvasNotice } from "../panels/CanvasNotice"
import { PcbToolbar, SchematicToolbar } from "../panels/CanvasToolbar"
import { ChecksPanel } from "../panels/ChecksPanel"
import { Inspector } from "../panels/Inspector"
import { LibraryPanel } from "../panels/LibraryPanel"
import { SaveNotice } from "../panels/SaveNotice"
import { SettingsDialog } from "../panels/SettingsDialog"
import { TopBar } from "../panels/TopBar"
import { projectApi, useProjectStore } from "../store/projectStore"
import { uiApi, useUi, type SidePanel } from "../store/uiStore"
import { IconButton, Segmented } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"

// three.js is large, and the copilot is only needed once its panel opens; load each when it does.
const Board3D = lazy(() => import("../editor/three/Board3D").then((m) => ({ default: m.Board3D })))
const CopilotPanel = lazy(() => import("../panels/CopilotPanel").then((m) => ({ default: m.CopilotPanel })))

const Loading = ({ dark = false }: { dark?: boolean }) => (
  <div className={`flex h-full items-center justify-center text-[12.5px] ${dark ? "text-ink-3" : "text-ink-2"}`}>Loading…</div>
)

function StatusBar() {
  const cursor = useUi((s) => s.cursor)
  const view = useUi((s) => s.view)
  const layer = useUi((s) => s.activeLayer)
  if (view === "3d") return null
  const unit = view === "pcb" ? "mm" : ""
  return (
    <div className="mono pointer-events-none absolute bottom-3 right-3 z-10 flex gap-3 rounded-[8px] bg-surface/90 px-2.5 py-1 text-[11.5px] text-ink-2 shadow-float">
      <span>
        {cursor ? `${cursor.x.toFixed(view === "pcb" ? 2 : 1)}, ${cursor.y.toFixed(view === "pcb" ? 2 : 1)} ${unit}` : " "}
      </span>
      <span>{view === "pcb" ? `grid 0.25 mm, ${layer} layer` : "grid 0.1"}</span>
    </div>
  )
}

/**
 * A closed panel's way back: a tab hanging off the canvas edge the panel opens from, with its
 * icon and its name written down the tab. Its outer border sits one pixel past the edge, where
 * the canvas clips it, so the tab reads as attached.
 */
function EdgeTab({
  side,
  label,
  icon,
  title,
  shortcut,
  onClick,
}: {
  side: "left" | "right"
  label: string
  icon: ReactNode
  title: string
  shortcut: string
  onClick: () => void
}) {
  return (
    <Tooltip label={title} shortcut={shortcut}>
      <button
        onClick={onClick}
        className={`pointer-events-auto flex w-8 flex-col items-center gap-2 border border-line bg-surface pb-3 pt-2.5 text-[12px] font-[600] text-ink-2 shadow-float transition-colors hover:bg-hover hover:text-ink ${
          side === "left" ? "-ml-px rounded-r-[10px]" : "-mr-px rounded-l-[10px]"
        }`}
      >
        {icon}
        <span className="leading-none [writing-mode:vertical-rl]">{label}</span>
      </button>
    </Tooltip>
  )
}

/** Below the canvas toolbars and the 3D view cube, in the upper half of the edge. */
const EDGE_TABS_TOP = "top-[max(128px,22%)]"

export function Editor() {
  const view = useUi((s) => s.view)
  const sidePanel = useUi((s) => s.sidePanel)
  const setSidePanel = useUi((s) => s.setSidePanel)
  const libraryOpen = useUi((s) => s.libraryOpen)
  const panelOpen = useUi((s) => s.panelOpen)
  const copilotOpen = useUi((s) => s.copilotOpen)
  const viewer = useProjectStore((s) => s.role === "viewer")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      // ⌘L opens and closes Sakura from anywhere, its own composer included.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault()
        useUi.getState().toggleCopilot()
        return
      }
      if (isTyping(e)) return
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) projectApi().redo()
        else projectApi().undo()
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault()
        projectApi().redo()
      } else if (!mod && !e.altKey && (e.key === "[" || e.key === "]")) {
        e.preventDefault()
        if (e.key === "[") useUi.getState().toggleLibrary()
        else useUi.getState().togglePanel()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // A tidy still running in its worker stops with the editor, and the worker with it.
  useEffect(() => stopTidy, [])
  useEffect(() => stopZoneFills, [])
  useEffect(() => stopCleanup, [])
  // A project opens on its root sheet.
  const projectId = useProjectStore((s) => s.project?.id)
  useEffect(() => uiApi().setSheet(""), [projectId])

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <SaveNotice />
      <div className="flex min-h-0 flex-1">
        {libraryOpen && <LibraryPanel />}
        {copilotOpen && (
          <aside aria-label="Sakura" className="flex w-[340px] shrink-0 flex-col border-r border-line bg-surface">
            <Suspense fallback={<Loading />}>
              <CopilotPanel />
            </Suspense>
          </aside>
        )}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {view === "schematic" && (
            <>
              <SchematicEditor />
              <SchematicToolbar />
            </>
          )}
          {view === "pcb" && (
            <>
              <PcbEditor />
              <PcbToolbar />
            </>
          )}
          {view === "3d" && (
            <div className="absolute inset-0">
              <Suspense fallback={<Loading dark />}>
                <Board3D />
              </Suspense>
            </div>
          )}
          <StatusBar />
          <CanvasNotice />
          {(!libraryOpen || !copilotOpen) && (
            <div className={`pointer-events-none absolute left-0 z-10 flex flex-col gap-2 ${EDGE_TABS_TOP}`}>
              {!libraryOpen && (
                <EdgeTab
                  side="left"
                  label="Parts"
                  icon={<Package size={16} />}
                  title="Show parts library"
                  shortcut="["
                  onClick={() => useUi.getState().toggleLibrary()}
                />
              )}
              {!copilotOpen && (
                <EdgeTab
                  side="left"
                  label="Ask AI"
                  icon={<Sparkles size={16} className="text-brand" />}
                  title="Ask Sakura"
                  shortcut="⌘L"
                  onClick={() => useUi.getState().toggleCopilot()}
                />
              )}
            </div>
          )}
          {!panelOpen && (
            <div className={`pointer-events-none absolute right-0 z-10 ${EDGE_TABS_TOP}`}>
              <EdgeTab
                side="right"
                label={sidePanel === "checks" ? "Checks" : "Inspect"}
                icon={sidePanel === "checks" ? <ListChecks size={16} /> : <SlidersHorizontal size={16} />}
                title="Show side panel"
                shortcut="]"
                onClick={() => useUi.getState().togglePanel()}
              />
            </div>
          )}
        </main>
        <aside className={`w-[340px] shrink-0 flex-col border-l border-line bg-surface ${panelOpen ? "flex" : "hidden"}`}>
          <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-1.5">
            <IconButton label="Hide side panel" shortcut="]" onClick={() => useUi.getState().togglePanel()}>
              <PanelRightClose size={16} />
            </IconButton>
            <Segmented<SidePanel>
              size="sm"
              value={sidePanel}
              onChange={setSidePanel}
              options={[
                { value: "inspector", label: "Inspect" },
                { value: "checks", label: "Checks" },
              ]}
            />
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {/* A viewer reads every value and changes none: the fieldset disables every control in it. */}
            <fieldset disabled={viewer} className="contents">
              {sidePanel === "inspector" && <Inspector />}
            </fieldset>
            {sidePanel === "checks" && <ChecksPanel />}
          </div>
        </aside>
      </div>
      <SettingsDialog />
    </div>
  )
}
