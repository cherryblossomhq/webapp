import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { Toolbar } from "@/components/Toolbar";
import { EditorShell } from "@/editor/EditorShell";
import { IssuesPanel } from "@/editor/IssuesPanel";
import { ShortcutsHelp } from "@/components/ShortcutsHelp";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { useWindowTitle } from "@/hooks/useWindowTitle";
import { useIsCompact, useIsTouch } from "@/hooks/useViewport";
import { useCircuitStore } from "@/store/circuitStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useEditorStore } from "@/editor/state/editorStore";
import { DEFAULT_TSX } from "@/utils/tsxTransform";
import {
  buildEditorIssues,
  countGroupedIssues,
  groupEditorIssues,
} from "@/editor/issues";
import { onBeforeAppReload } from "@/utils/appReload";
import { cn } from "@/lib/utils";

const AUTOSAVE_KEY = "cherryblossom_autosave";
const MAX_FILENAME_LENGTH = 80;

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
  const issuesOpen = useEditorStore((s) => s.issuesOpen);

  const [showHelp, setShowHelp] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showConfirmNew, setShowConfirmNew] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Notify the user only once per session about background autosave failures so
  // we don't spam them every keystroke when storage is genuinely full.
  const autosaveFailedRef = useRef(false);

  const persistProject = useCallback(
    (forReload: boolean): boolean => {
      try {
        const data = getProjectData();
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
        autosaveFailedRef.current = false;
        return true;
      } catch (err) {
        console.error("[autosave] write failed:", err);
        if (forReload) {
          toast.error("Reload paused to protect your work", {
            description: "Save the project to a file, then reload the app.",
          });
        } else if (!autosaveFailedRef.current) {
          autosaveFailedRef.current = true;
          toast.error("Autosave failed", {
            description: "Storage is unavailable or full. Save the file with Ctrl+S.",
          });
        }
        return false;
      }
    },
    [getProjectData],
  );

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

  useEffect(() => {
    const timer = setTimeout(() => {
      persistProject(false);
    }, 1000);
    return () => clearTimeout(timer);
  }, [tsxCode, metadata, manualEdits, persistProject]);

  useEffect(() =>
    onBeforeAppReload((event) => {
      const projectSaved = persistProject(true);
      const routeInProgress = useEditorStore.getState().pcbRouteDraft !== null;

      if (!projectSaved || routeInProgress) {
        event.preventDefault();
      }
      if (routeInProgress) {
        toast.info("Reload paused to protect work in progress", {
          description: "Finish or cancel the PCB route, then reload the app.",
        });
      }
    }),
  [persistProject]);

  // Sync the WebView + native window title bar with the open project's name.
  useWindowTitle(metadata.title);

  const handleNew = useCallback(() => {
    const isPristine =
      tsxCode === DEFAULT_TSX && metadata.title === "Untitled Circuit";
    if (isPristine) {
      resetCircuit();
      return;
    }
    setShowConfirmNew(true);
  }, [resetCircuit, tsxCode, metadata.title]);

  const confirmNew = useCallback(() => {
    resetCircuit();
    setShowConfirmNew(false);
    toast.success("New circuit created");
  }, [resetCircuit]);

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
      if (ctrl && e.key === "," && !e.shiftKey) {
        e.preventDefault();
        // No-op if Settings (or another modal) is already open: re-firing would
        // snap the active tab back to the first one, and we don't want to stack
        // dialogs.
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
  }, [loadProject]);

  return (
    // Safe-area insets are applied once here rather than per-panel, so every
    // descendant is already clear of the notch and the home indicator. The
    // sidebar background fills the inset strips so they don't read as gaps.
    // All four are 0px outside standalone/notched contexts.
    <div className="flex flex-col w-full h-full bg-sidebar pt-[var(--safe-top)] pr-[var(--safe-right)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]">
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
        savedFlash={savedFlash}
      />

      <div className="relative flex flex-1 overflow-hidden">
        <main className="flex-1 flex flex-col overflow-hidden bg-background min-w-0 min-h-0">
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <PanelErrorBoundary label="Circuit viewer">
              <EditorShell />
            </PanelErrorBoundary>
          </div>
          {issuesOpen && (
            <PanelErrorBoundary label="Issues panel">
              <IssuesPanel />
            </PanelErrorBoundary>
          )}
          <StatusBar />
        </main>
      </div>
    </div>
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
  const evalIssues = useCircuitStore((s) => s.evalIssues);
  const evalError = useCircuitStore((s) => s.evalError);
  const evalVersion = useCircuitStore((s) => s.evalVersion);
  const evalIssuesVersion = useCircuitStore((s) => s.evalIssuesVersion);
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const drcViolations = useCircuitStore((s) => s.drcViolations);
  const issuesOpen = useEditorStore((s) => s.issuesOpen);
  const toggleIssues = useEditorStore((s) => s.toggleIssues);
  const isCompact = useIsCompact();
  const isTouch = useIsTouch();

  const componentCount = getComponents().length;
  const board = getBoardConfig();
  const editorSelectedSize = editorSelected.size;
  const issueCounts = useMemo(
    () =>
      countGroupedIssues(
        groupEditorIssues(
          buildEditorIssues(evalIssues, drcViolations, evalError),
        ),
      ),
    [evalIssues, drcViolations, evalError],
  );
  const checkingIssues =
    evalError === null &&
    (circuitJson === null || evalIssuesVersion !== evalVersion);

  return (
    <div
      className={cn(
        "flex items-center px-3 border-t border-border bg-sidebar text-xs text-muted-foreground shrink-0 select-none relative z-50",
        // At 390px the four segments plus gap-4 overflow with no scroll, so the
        // issues button — the only actionable one — gets clipped off the end.
        // Board dimensions are the most redundant (they're in the properties
        // panel), so they're what gives way.
        isCompact ? "gap-2" : "gap-4",
        isTouch ? "h-9" : "h-6",
      )}
    >
      {!isCompact && <span>Board: {board.width} x {board.height}</span>}
      <span className="shrink-0">
        {componentCount} component{componentCount !== 1 ? "s" : ""}
      </span>
      <div className="flex-1" />
      {editorSelectedSize > 0 ? (
        <span className="font-mono text-foreground truncate">
          {editorSelectedSize} selected
        </span>
      ) : (
        selectedName && (
          <span className="font-mono text-foreground truncate">{selectedName}</span>
        )
      )}
      <button
        type="button"
        onClick={toggleIssues}
        aria-expanded={issuesOpen}
        aria-label="Open circuit issues"
        className={cn(
          "flex items-center gap-2 shrink-0 rounded hover:bg-muted hover:text-foreground",
          isTouch ? "px-2 py-1.5" : "px-1.5 py-0.5",
        )}
        title="Open circuit issues"
      >
        {checkingIssues ? (
          <span className="flex items-center gap-1">
            <Loader2 className="size-3.5 animate-spin" /> Checking issues
          </span>
        ) : issueCounts.errors === 0 && issueCounts.warnings === 0 ? (
          <span className="flex items-center gap-1 text-emerald-500">
            <CheckCircle2 className="size-3.5" /> No issues
          </span>
        ) : (
          <>
            {issueCounts.errors > 0 && (
              <span className="flex items-center gap-1 text-red-500 tabular-nums">
                <AlertCircle className="size-3.5" /> {issueCounts.errors}
              </span>
            )}
            {issueCounts.warnings > 0 && (
              <span className="flex items-center gap-1 text-amber-500 tabular-nums">
                <AlertTriangle className="size-3.5" /> {issueCounts.warnings}
              </span>
            )}
          </>
        )}
      </button>
    </div>
  );
}

