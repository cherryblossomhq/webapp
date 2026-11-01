import { ListChecks, Package, PanelRightClose, SlidersHorizontal, Sparkles } from "lucide-react"
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react"
import { PcbEditor } from "../editor/pcb/PcbEditor"
import { SchematicEditor } from "../editor/schematic/SchematicEditor"
import { stopCleanup } from "../editor/schematic/cleanupAction"
import { stopTidy } from "../editor/schematic/tidyAction"
import { stopZoneFills } from "../store/analysis"
import { isTyping } from "../editor/viewport"
import { CanvasNotice } from "../panels/CanvasNotice"
import { ImportedNote } from "../kicadImport/ImportedNote"
import { PcbToolbar, SchematicToolbar } from "../panels/CanvasToolbar"
import { ChecksPanel } from "../panels/ChecksPanel"
import { CollabNotices } from "../panels/CollabNotices"
import { FollowFrame } from "../panels/Collaborators"
import { Inspector } from "../panels/Inspector"
import { HistoryPanel } from "../panels/HistoryPanel"
import { LibraryPanel } from "../panels/LibraryPanel"
import { PartEditor } from "../panels/PartEditor"
import { PreviewBanner } from "../panels/PreviewBanner"
import { SaveNotice } from "../panels/SaveNotice"
import { SettingsDialog } from "../panels/SettingsDialog"
import { SheetTabs } from "../panels/SheetTabs"
import { TopBar } from "../panels/TopBar"
import { useEditorAccount } from "../store/account"
import { startBoardLease } from "../store/boardLease"
import { useCopilot } from "../store/copilotStore"
import { followLeader, guestName, guestUserId, startPresence, stopFollowing, usePresence } from "../store/presence"
import { projectApi, projectStorage, useProjectStore } from "../store/projectStore"
import { sheetUses } from "../model/sheets"
import { clampLayer } from "../model/stack"
import { uiApi, useUi, type SidePanel } from "../store/uiStore"
import { IconButton, Segmented } from "../ui/controls"
import { ReadOnly } from "../ui/form"
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

/**
 * Be on the open project with everyone else who has it open: say what this tab is doing, draw
 * them (`store/presence.ts`), and mirror whoever the user follows.
 */
function useCollaboration() {
  const account = useEditorAccount()
  const accountRef = useRef(account)
  accountRef.current = account
  const projectId = useProjectStore((s) => s.project?.id)
  const sessionId = useProjectStore((s) => s.sessionId)
  const userId = account ? (account.user?.id ?? null) : guestUserId()
  useEffect(() => {
    const source = projectStorage()?.presence
    if (!projectId || !sessionId || !source) return
    const me = () => {
      const user = accountRef.current?.user
      return user ? { name: user.name || user.email, pictureUrl: user.pictureUrl ?? undefined } : { name: guestName() }
    }
    return startPresence(projectId, sessionId, source, me, userId)
  }, [projectId, sessionId, userId])
  // Who holds the board lease (a whole-board action running in some tab), and this tab's way to take it.
  useEffect(() => {
    const source = projectStorage()?.locks
    if (!projectId || !sessionId || !source) return
    return startBoardLease(projectId, sessionId, source, () => ({ name: accountRef.current?.user?.name || accountRef.current?.user?.email || guestName() }), userId)
  }, [projectId, sessionId, userId])
  useEffect(followLeader, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && usePresence.getState().following) stopFollowing()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}

/** Below the canvas toolbars and the 3D view cube, in the upper half of the edge. */
const EDGE_TABS_TOP = "top-[max(128px,22%)]"

export function Editor() {
  useCollaboration()
  const view = useUi((s) => s.view)
  const sidePanel = useUi((s) => s.sidePanel)
  const setSidePanel = useUi((s) => s.setSidePanel)
  const libraryOpen = useUi((s) => s.libraryOpen)
  const panelOpen = useUi((s) => s.panelOpen)
  const copilotOpen = useUi((s) => s.copilotOpen)
  const viewer = useProjectStore((s) => s.role === "viewer")
  const historyOpen = useUi((s) => s.historyOpen) && !!projectStorage()?.history

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      // ⌘L opens and closes Sakura from anywhere, its own composer included.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault()
        useUi.getState().toggleCopilot()
        return
      }
      // ⌘B opens and closes the menu of sheets, when the project has sheets, going to the schematic for it.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        const p = projectApi().project
        if (p && sheetUses(p).length > 1) {
          e.preventDefault()
          const ui = useUi.getState()
          ui.setView("schematic")
          ui.setSheetMenu(!ui.sheetMenuOpen)
        }
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

  // The active copper layer is one the board has: a project switch, a smaller layer count or an undo of a layer add would leave it on a layer that is gone.
  useEffect(() => {
    const fit = () => {
      const p = projectApi().project
      const ui = useUi.getState()
      if (p && clampLayer(p.board, ui.activeLayer) !== ui.activeLayer) ui.setActiveLayer(clampLayer(p.board, ui.activeLayer))
    }
    fit()
    return useProjectStore.subscribe(fit)
  }, [])

  // A tidy still running in its worker stops with the editor, and the worker with it.
  useEffect(() => stopTidy, [])
  useEffect(() => stopZoneFills, [])
  useEffect(() => stopCleanup, [])
  // Made a viewer while working: put down the drawing tools and stop what would only be refused.
  useEffect(() => {
    if (!viewer) return
    const ui = useUi.getState()
    ui.setSchTool("select")
    ui.setPcbTool("select")
    ui.stopPlacing()
    useCopilot.getState().stop()
    stopTidy()
    stopCleanup()
  }, [viewer])

  // A project opens on its root sheet, with no other project's part open in the part editor.
  const projectId = useProjectStore((s) => s.project?.id)
  useEffect(() => {
    uiApi().setSheet("")
    uiApi().openPartEditor(null)
  }, [projectId])

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <SaveNotice />
      <div className="flex min-h-0 flex-1">
        {historyOpen && <HistoryPanel />}
        {libraryOpen && <LibraryPanel />}
        {copilotOpen && (
          <aside aria-label="Sakura" className="flex w-[340px] shrink-0 flex-col border-r border-line bg-surface">
            <Suspense fallback={<Loading />}>
              <CopilotPanel />
            </Suspense>
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1 overflow-hidden">
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
            <FollowFrame />
            <CollabNotices />
            <CanvasNotice />
            <ImportedNote />
            <PreviewBanner />
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
          </div>
          {/* A project with sheets below Main: the sheets as tabs under the schematic, which open and close the tree (⌘B) too. */}
          {view === "schematic" && <SheetTabs />}
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
            {/* A viewer reads every value and changes none: each section disables its controls. */}
            <ReadOnly.Provider value={viewer}>{sidePanel === "inspector" && <Inspector />}</ReadOnly.Provider>
            {sidePanel === "checks" && <ChecksPanel />}
          </div>
        </aside>
      </div>
      <SettingsDialog />
      <PartEditor />
    </div>
  )
}
