import { useRef, useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Toolbar } from "@/components/Toolbar";
import { EditorShell } from "@/editor/EditorShell";
import { ChatPanel } from "@/components/ChatPanel";
import { ShortcutsHelp } from "@/components/ShortcutsHelp";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { useWindowTitle } from "@/hooks/useWindowTitle";
import { useCircuitStore } from "@/store/circuitStore";
import { useChatStore } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useEditorStore } from "@/editor/state/editorStore";
import { DEFAULT_TSX } from "@/utils/tsxTransform";
import {
  clampChatWidth,
  snapChatWidth,
  CHAT_DEFAULT_WIDTH,
} from "@/lib/clampChatWidth";

const AUTOSAVE_KEY = "cherryblossom_autosave";
const MAX_FILENAME_LENGTH = 80;
// There's no left column in the editor — the canvas + chat split the whole
// flex row. The chat-rail clamp still takes a sidebar-width arg for generality;
// we always pass 0.
const SIDEBAR_OVERLAY_WIDTH = 0;

function sanitizeFilename(title: string): string {
  // Replace anything that isn't safe in a filename across macOS/Linux/Windows.
  // Path separators, control chars, and reserved Windows chars: \ / : * ? " < > |
  const safe = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, MAX_FILENAME_LENGTH);
  return safe || "untitled";
}

export function EditorView() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const metadata = useCircuitStore((s) => s.metadata);
  const resetCircuit = useCircuitStore((s) => s.resetCircuit);
  const undo = useCircuitStore((s) => s.undo);
  const redo = useCircuitStore((s) => s.redo);
  const getProjectData = useCircuitStore((s) => s.getProjectData);
  const loadProject = useCircuitStore((s) => s.loadProject);
  // Subscribe to manualEdits so the autosave effect re-fires on drag-moves
  // (component positions + wire waypoints). Without this, sidecar-only edits
  // never reach localStorage and silently disappear on reload.
  const manualEdits = useEditorStore((s) => s.manualEdits);

  const chatOpen = useChatStore((s) => s.chatOpen);
  const toggleChat = useChatStore((s) => s.toggleChat);
  const clearChatHistory = useChatStore((s) => s.clearHistory);

  const [showHelp, setShowHelp] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showConfirmNew, setShowConfirmNew] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let saved: string | null;
    try {
      saved = localStorage.getItem(AUTOSAVE_KEY);
    } catch (err) {
      console.error("[autosave] read failed:", err);
      toast.error("Couldn't access autosave", {
        description: "localStorage is unavailable in this session.",
      });
      return;
    }
    if (!saved) return;

    try {
      const data = JSON.parse(saved);
      if (data && data.tsxCode) {
        loadProject(data);
      }
    } catch (err) {
      console.error("[autosave] parse failed:", err);
      toast.error("Couldn't restore previous session", {
        description: "Autosave was corrupted and has been cleared.",
      });
      try {
        localStorage.removeItem(AUTOSAVE_KEY);
      } catch {
        /* nothing more we can do */
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify the user only once per session about autosave failures so we don't
  // spam them every keystroke when storage is genuinely full.
  const autosaveFailedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const data = getProjectData();
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
        autosaveFailedRef.current = false;
      } catch (err) {
        console.error("[autosave] write failed:", err);
        if (!autosaveFailedRef.current) {
          autosaveFailedRef.current = true;
          toast.error("Autosave failed", {
            description:
              err instanceof DOMException && err.name === "QuotaExceededError"
                ? "Storage is full. Save the file with Ctrl+S to keep your work."
                : "Save the file with Ctrl+S to keep your work.",
          });
        }
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [tsxCode, metadata, manualEdits, getProjectData]);

  // Sync the WebView + native window title bar with the open project's name.
  useWindowTitle(metadata.title);

  const handleNew = useCallback(() => {
    const isPristine =
      tsxCode === DEFAULT_TSX && metadata.title === "Untitled Circuit";
    if (isPristine) {
      resetCircuit();
      clearChatHistory();
      return;
    }
    setShowConfirmNew(true);
  }, [resetCircuit, clearChatHistory, tsxCode, metadata.title]);

  const confirmNew = useCallback(() => {
    resetCircuit();
    clearChatHistory();
    setShowConfirmNew(false);
    toast.success("New circuit created");
  }, [resetCircuit, clearChatHistory]);

  const handleOpen = useCallback(() => fileInputRef.current?.click(), []);

  const handleSave = useCallback(() => {
    try {
      const data = getProjectData();
      const filename = `${sanitizeFilename(metadata.title)}.cherryblossom.json`;
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      console.error("[save] failed:", err);
      toast.error("Save failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [getProjectData, metadata.title]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (
        e.key === "?" &&
        !ctrl &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        setShowHelp((v) => !v);
        return;
      }
      if (ctrl && (e.key === "s" || e.key === "S") && !e.shiftKey) {
        e.preventDefault();
        handleSave();
        return;
      }
      if (ctrl && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        handleOpen();
        return;
      }
      if (ctrl && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        handleNew();
        return;
      }
      if (ctrl && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        // While a pcb route draft is active, Ctrl+Z is OWNED by the draft —
        // even after every corner has been popped, the next Ctrl+Z is a no-op
        // rather than rolling back unrelated tsx history. The user bails out
        // with Esc; otherwise it'd be too easy to "over-undo" and silently
        // destroy the previous committed route.
        const ed = useEditorStore.getState();
        if (ed.pcbRouteDraft) {
          ed.popPcbRoutePoint();
        } else {
          undo();
        }
        return;
      }
      if (ctrl && (e.key === "z" || e.key === "Z") && e.shiftKey) {
        e.preventDefault();
        // Symmetric to undo: redo is also owned by any active draft so
        // it can't accidentally re-apply a committed step the user has
        // mentally moved past.
        const ed = useEditorStore.getState();
        if (ed.pcbRouteDraft) return;
        redo();
        return;
      }
      if (ctrl && (e.key === "l" || e.key === "L") && !e.shiftKey) {
        e.preventDefault();
        toggleChat();
        return;
      }
      if (ctrl && e.key === "," && !e.shiftKey) {
        e.preventDefault();
        // No-op if Settings (or another modal) is already open: re-firing would
        // snap the active tab back to "ai", and we don't want to stack dialogs.
        if (
          useSettingsStore.getState().open ||
          showHelp ||
          showExport ||
          showConfirmNew
        ) {
          return;
        }
        useSettingsStore.getState().openSettings();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    handleSave,
    handleOpen,
    handleNew,
    undo,
    redo,
    toggleChat,
    showHelp,
    showExport,
    showConfirmNew,
  ]);

  const handleExport = useCallback(() => setShowExport(true), []);

  const handleFileSelected = useCallback(async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.tsxCode) {
        loadProject(data);
        clearChatHistory();
        toast.success("Project loaded", { description: file.name });
      } else {
        toast.error("Unrecognized file format", {
          description: "Expected a Cherry Blossom project file.",
        });
      }
    } catch (error) {
      console.error("[load] failed:", error);
      toast.error("Couldn't load file", {
        description:
          error instanceof Error ? error.message : String(error),
      });
    }
    event.target.value = "";
  }, [loadProject, clearChatHistory]);

  return (
    <div className="flex flex-col w-full h-full">
      <ShortcutsHelp open={showHelp} onOpenChange={setShowHelp} />
      <SettingsDialog />
      <ExportDialog open={showExport} onOpenChange={setShowExport} />
      <ConfirmDialog
        open={showConfirmNew}
        onOpenChange={setShowConfirmNew}
        title="Create a new circuit?"
        message="Your current circuit will be discarded. This cannot be undone — save first if you want to keep it."
        confirmLabel="Discard and create new"
        cancelLabel="Keep working"
        destructive
        onConfirm={confirmNew}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        onChange={handleFileSelected}
        className="hidden"
      />

      <Toolbar
        onNew={handleNew}
        onOpen={handleOpen}
        onSave={handleSave}
        onExport={handleExport}
        onHelp={() => setShowHelp(true)}
        onToggleChat={toggleChat}
        chatOpen={chatOpen}
        savedFlash={savedFlash}
      />

      <div ref={rowRef} className="flex flex-1 overflow-hidden">
        <main className="flex-1 flex flex-col overflow-hidden bg-background min-w-0 min-h-0">
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PanelErrorBoundary label="Circuit viewer">
              <EditorShell />
            </PanelErrorBoundary>
          </div>
          <StatusBar />
        </main>

        <RightRail rowRef={rowRef} />
      </div>
    </div>
  );
}

// Right rail — chat only. Closed chat → no rail (the canvas spans the full row;
// component properties float over it via EditorShell's PropertiesDrawer). Open
// chat → chat is the rail, drag-resizable from its left border. Width is
// hand-rolled (one resizable boundary) and driven by direct DOM writes during
// the drag so the message list doesn't re-render every frame; the store is
// updated once on release (clamped + snapped, and persisted).
function RightRail({
  rowRef,
}: {
  rowRef: React.RefObject<HTMLDivElement | null>;
}) {
  const chatOpen = useChatStore((s) => s.chatOpen);
  const chatWidth = useChatStore((s) => s.chatWidth);
  const setChatWidth = useChatStore((s) => s.setChatWidth);
  const setChatResizing = useChatStore((s) => s.setChatResizing);
  // No left column — the canvas + chat split the whole row. The clamp keeps its
  // sidebar-width arg for generality; we always feed it 0.
  const sidebarWidth = SIDEBAR_OVERLAY_WIDTH;

  const asideRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Safety net: if RightRail unmounts mid-drag (e.g. chat closed via Cmd+L while
  // the pointer is down and pointerup/cancel never arrives at the detached
  // grip), tear down any live drag listeners and clear the global resizing flag
  // so it can't stick true and permanently disable the chat autoscroll lock.
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      if (useChatStore.getState().chatResizing) setChatResizing(false);
    },
    [setChatResizing]
  );

  // Reclamp the stored width into the valid range for the current geometry. The
  // resizable region is the whole row (there's no left column), so this only
  // needs the row's own size — the ResizeObserver below covers window/row
  // resizes. Skip a 0-width row so a
  // pre-layout measurement never collapses the width to its minimum, and skip
  // entirely during an active drag — the width is being driven imperatively
  // then, and a setChatWidth here would stomp it with a visible jump.
  const reclamp = useCallback(() => {
    const row = rowRef.current;
    if (!row || !chatOpen) return;
    if (useChatStore.getState().chatResizing) return;
    const rw = row.getBoundingClientRect().width;
    if (rw < 1) return;
    const cur = useChatStore.getState().chatWidth;
    const next = clampChatWidth(cur, rw, sidebarWidth);
    if (next !== cur) setChatWidth(next);
  }, [rowRef, chatOpen, sidebarWidth, setChatWidth]);

  // On mount + whenever the geometry inputs (sidebar width, open state) change.
  useEffect(() => {
    reclamp();
  }, [reclamp]);

  // On window / row resize.
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !chatOpen) return;
    const ro = new ResizeObserver(() => reclamp());
    ro.observe(row);
    return () => ro.disconnect();
  }, [reclamp, rowRef, chatOpen]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const row = rowRef.current;
      const aside = asideRef.current;
      if (!row || !aside) return;
      const grip = e.currentTarget as HTMLElement;
      // Pointer capture guarantees pointerup fires on the grip even if the
      // cursor leaves the window; the pointercancel teardown covers the gesture
      // being stolen (OS, context menu, blur) so we never leak the window
      // listeners or get stuck with chatResizing=true (which would permanently
      // disable the chat's autoscroll lock).
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture unsupported in some environments */
      }
      setChatResizing(true);
      aside.style.transition = "none";

      // Read geometry live on every move/release so a window resize DURING the
      // drag clamps against the real region, not a snapshot captured at
      // pointerdown. There's no left column, so the sidebar reserves no width
      // here.
      const geom = () => ({
        rowRect: row.getBoundingClientRect(),
        sidebar: SIDEBAR_OVERLAY_WIDTH,
      });

      function teardown() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        dragCleanupRef.current = null;
      }
      function onMove(ev: PointerEvent) {
        const { rowRect, sidebar } = geom();
        const desired = rowRect.right - ev.clientX;
        aside!.style.width = `${clampChatWidth(desired, rowRect.width, sidebar)}px`;
      }
      function finish() {
        teardown();
        aside!.style.transition = "";
        const { rowRect, sidebar } = geom();
        const finalW =
          parseInt(aside!.style.width, 10) || useChatStore.getState().chatWidth;
        const snapped = snapChatWidth(finalW, rowRect.width, sidebar);
        // Reconcile the imperative inline width with the committed value so the
        // DOM and store can't disagree — when `snapped` equals the current store
        // width, React bails on the no-op setState and would otherwise leave the
        // inline drag width in place.
        aside!.style.width = `${snapped}px`;
        setChatResizing(false);
        setChatWidth(snapped);
      }

      dragCleanupRef.current = teardown;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [rowRef, setChatWidth, setChatResizing]
  );

  const resetWidth = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    setChatWidth(
      clampChatWidth(CHAT_DEFAULT_WIDTH, row.getBoundingClientRect().width, sidebarWidth)
    );
  }, [rowRef, sidebarWidth, setChatWidth]);

  // Chat closed → no rail; the canvas spans the full row and component
  // properties float over it via EditorShell's PropertiesDrawer overlay. Chat
  // open → chat is the rail (drag-resizable from its left border).
  if (!chatOpen) return null;

  return (
    <aside
      ref={asideRef}
      className="relative flex flex-col border-l border-border bg-sidebar overflow-hidden shrink-0 transition-[width] duration-200 ease-out"
      style={{ width: chatWidth }}
    >
      <div
        onPointerDown={startDrag}
        onDoubleClick={resetWidth}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel (double-click to reset)"
        className="group/grip absolute inset-y-0 left-0 z-20 flex w-2 -translate-x-1/2 cursor-col-resize items-center justify-center"
      >
        <div className="h-full w-px bg-border transition-all group-hover/grip:w-0.5 group-hover/grip:bg-primary" />
      </div>
      <PanelErrorBoundary label="Chat panel">
        <ChatPanel />
      </PanelErrorBoundary>
    </aside>
  );
}

function StatusBar() {
  const getComponents = useCircuitStore((s) => s.getComponents);
  const getBoardConfig = useCircuitStore((s) => s.getBoardConfig);
  const selectedName = useCircuitStore((s) => s.selectedComponentName);
  // Phase 0: editorStore.selectedKeys is the future-canonical selection — it
  // will become the only source of truth once Phase 1 replaces RunFrame's
  // schematic tab. Until then the legacy `selectedComponentName` from
  // circuitStore is still the live channel for RunFrame click events, so we
  // prefer the editorStore count when populated and fall back to the legacy
  // single-name display otherwise.
  const editorSelected = useEditorStore((s) => s.selectedKeys);

  const componentCount = getComponents().length;
  const board = getBoardConfig();
  const editorSelectedSize = editorSelected.size;

  return (
    <div className="flex items-center h-6 px-3 border-t border-border bg-sidebar text-xs text-muted-foreground shrink-0 gap-4 select-none relative z-50">
      <span>Board: {board.width} x {board.height}</span>
      <span>{componentCount} component{componentCount !== 1 ? "s" : ""}</span>
      <div className="flex-1" />
      {editorSelectedSize > 0 ? (
        <span className="font-mono text-foreground">
          {editorSelectedSize} selected
        </span>
      ) : (
        selectedName && (
          <span className="font-mono text-foreground">{selectedName}</span>
        )
      )}
    </div>
  );
}
