// EditorShell — top-level editor container.
//
// Routing:
//   - schematic : read-only @tscircuit/schematic-viewer (consumes circuitJson;
//                 the Code tab owns structure, PropertiesPanel owns scalars)
//   - pcb       : standalone PcbCanvas (circuitJson + manualEdits, manual
//                 routing — the PHYSICAL artifact stays hand-editable)
//   - cad       : @tscircuit/3d-viewer (consumes circuitJson)
//   - bom       : simple table view (consumes circuitJson)
//
// The schematic / PCB / 3D / BOM tabs all read circuitJson from circuitStore,
// kept fresh by useBackgroundEvaluator(), which runs @tscircuit/eval on every
// tsx + manualEdits change.

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore, type EditorTab } from "@/editor/state/editorStore";
import { selectionIsSingleComponent } from "@/editor/shared/componentSelection";
import { useSettingsStore } from "@/store/settingsStore";
import { useIsCompact, useIsTouch } from "@/hooks/useViewport";
import { SchematicReadonlyView } from "@/editor/schematic/SchematicReadonlyView";
import { PcbCanvas } from "@/editor/pcb/PcbCanvas";
import { overlayManualRoutes } from "@/editor/pcb/circuitJsonMerge";
import { PCB_STATUS_BAR_CLEARANCE } from "@/editor/pcb/StatusBar";
import { useBackgroundEvaluator } from "@/editor/services/useBackgroundEvaluator";
import { usePcbDrc } from "@/editor/services/usePcbDrc";
import { PropertiesPanel } from "@/editor/PropertiesPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { CircuitLoading } from "@/components/CircuitLoading";
import { cn } from "@/lib/utils";
import { reloadApp } from "@/utils/appReload";

// ─── Default the 3D engine to JSCAD ────────────────────────────────────────
// @tscircuit/3d-viewer reads window.localStorage["cadViewerEngine"] in
// CadViewerInner's useState lazy initializer (fixed upstream in v0.0.560 —
// previously a race between read/write effects meant any seed got clobbered).
// We write "jscad" once per install via a versioned migration key so first
// mount lands on JSCAD; the in-app context-menu toggle still writes to the
// same key, so a user who flips to Manifold has that choice persist.
const CAD_ENGINE_SEED_KEY = "cherryblossom:cadEngineSeeded";
const CAD_ENGINE_SEED_VERSION = "1";
const CAD_IMPORT_RELOAD_KEY = "cherryblossom:cadImportReloaded";
const CAD_TAB_RESTORE_KEY = "cherryblossom:restoreCadTab";
const CAD_FAILED_IMPORT_URLS_KEY = "cherryblossom:failedCadImportUrls";
let cadImportInProgress = false;
if (typeof window !== "undefined") {
  try {
    if (
      window.localStorage.getItem(CAD_ENGINE_SEED_KEY) !==
      CAD_ENGINE_SEED_VERSION
    ) {
      window.localStorage.setItem("cadViewerEngine", "jscad");
      window.localStorage.setItem(CAD_ENGINE_SEED_KEY, CAD_ENGINE_SEED_VERSION);
    }
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
}

function rememberFailedCadImport(event: Event): void {
  if (!cadImportInProgress || !(event.target instanceof HTMLLinkElement)) return;
  if (event.target.rel !== "modulepreload" || !event.target.href) return;
  try {
    const saved = JSON.parse(
      window.sessionStorage.getItem(CAD_FAILED_IMPORT_URLS_KEY) ?? "[]",
    ) as unknown;
    const urls = Array.isArray(saved)
      ? saved.filter((url): url is string => typeof url === "string")
      : [];
    if (!urls.includes(event.target.href)) urls.push(event.target.href);
    window.sessionStorage.setItem(
      CAD_FAILED_IMPORT_URLS_KEY,
      JSON.stringify(urls.slice(-8)),
    );
  } catch {
    // The normal reload recovery still works when storage is unavailable.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("error", rememberFailedCadImport, true);
}

function restoreCadTabAfterReload(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(CAD_TAB_RESTORE_KEY) !== "1") return;
    window.sessionStorage.removeItem(CAD_TAB_RESTORE_KEY);
    useEditorStore.getState().setActiveTab("cad");
  } catch {
    // Recovery is best-effort when storage is unavailable.
  }
}

function prepareCadImportReload(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.sessionStorage.getItem(CAD_IMPORT_RELOAD_KEY) === "1") {
      return false;
    }
    window.sessionStorage.setItem(CAD_IMPORT_RELOAD_KEY, "1");
    window.sessionStorage.setItem(CAD_TAB_RESTORE_KEY, "1");
    return true;
  } catch {
    // Without sessionStorage we cannot prevent a reload loop.
    return false;
  }
}

function clearCadImportReloadMarker(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(CAD_IMPORT_RELOAD_KEY);
    window.sessionStorage.removeItem(CAD_FAILED_IMPORT_URLS_KEY);
  } catch {
    // The viewer loaded, so a stale recovery marker is harmless.
  }
}

function cancelCadImportReload(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(CAD_IMPORT_RELOAD_KEY);
    window.sessionStorage.removeItem(CAD_TAB_RESTORE_KEY);
  } catch {
    // The preservation listener already surfaced why the reload was paused.
  }
}

async function refreshFailedCadImports(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(CAD_IMPORT_RELOAD_KEY) !== "1") return;
    const saved = JSON.parse(
      window.sessionStorage.getItem(CAD_FAILED_IMPORT_URLS_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(saved)) return;
    await Promise.all(
      saved
        .filter((url): url is string => typeof url === "string")
        .map(async (url) => {
          const resolved = new URL(url, window.location.href);
          if (resolved.origin !== window.location.origin) return;
          try {
            await window.fetch(resolved, {
              cache: "reload",
              credentials: "same-origin",
            });
          } catch {
            // The real module import below owns the user-facing error.
          }
        }),
    );
  } catch {
    // A malformed or inaccessible recovery cache should not block the import.
  }
}

function reloadCadTab(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CAD_IMPORT_RELOAD_KEY, "1");
    window.sessionStorage.setItem(CAD_TAB_RESTORE_KEY, "1");
  } catch {
    // Reloading still gives the module graph a clean retry.
  }
  if (!reloadApp()) cancelCadImportReload();
}

restoreCadTabAfterReload();

const CadViewerLazy = lazy(async () => {
  cadImportInProgress = true;
  try {
    // Safari can retain a failed module response across a normal reload. Force
    // any failed Vite preload URLs through the HTTP cache before importing.
    await refreshFailedCadImports();
    const m = await import("@tscircuit/3d-viewer");
    clearCadImportReloadMarker();
    return { default: m.CadViewer };
  } catch (cause) {
    // A failed ESM import is cached for the lifetime of the page, so resetting
    // a React error boundary cannot retry it. One reload gets a fresh module
    // graph and also replaces stale Vite chunk hashes after a deployment.
    if (prepareCadImportReload()) {
      if (reloadApp()) return await new Promise<never>(() => {});
      cancelCadImportReload();
      throw new Error(
        "The 3D viewer needs an app reload, but reload was paused to protect work in progress. Finish or save that work, then reload the app.",
        { cause },
      );
    }
    throw new Error(
      "The 3D viewer could not be loaded after refreshing. Check your connection, then reload the app.",
      { cause },
    );
  } finally {
    cadImportInProgress = false;
  }
});

type TabDef = { key: EditorTab; label: string };

const TABS: TabDef[] = [
  { key: "schematic", label: "Schematic" },
  { key: "pcb", label: "PCB" },
  { key: "cad", label: "3D" },
  { key: "bom", label: "BOM" },
  { key: "code", label: "Code" },
];

const CodeEditorTabLazy = lazy(async () => {
  const m = await import("@/editor/code/CodeEditorTab");
  return { default: m.CodeEditorTab };
});

export function EditorShell() {
  const activeTab = useEditorStore((s) => s.activeTab);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const setSelectedComponent = useCircuitStore((s) => s.setSelectedComponent);

  // Always-on background eval so PCB / 3D / BOM tabs and ExportDialog have
  // fresh circuitJson the moment the user clicks them.
  useBackgroundEvaluator();

  // The Code tab is an opt-in power-user surface (Settings → Advanced), hidden
  // by default. When off it's dropped from the tab bar and never mounted.
  const showCodeTab = useSettingsStore((s) => s.showCodeTab);
  const visibleTabs = useMemo(
    () => TABS.filter((t) => t.key !== "code" || showCodeTab),
    [showCodeTab]
  );
  // If the active tab is no longer available — the Code tab was toggled off —
  // fall back to the schematic: immediately for rendering and in the store
  // right after, so nothing flashes blank.
  const activeTabGone = !showCodeTab && activeTab === "code";
  const effectiveTab: EditorTab = activeTabGone ? "schematic" : activeTab;
  useEffect(() => {
    if (activeTabGone) setActiveTab("schematic");
  }, [activeTabGone, setActiveTab]);

  // The Code tab is mount-once: lazy-load it on first visit, then keep it
  // mounted (just hidden) so its editor state — cursor line, scroll, selection,
  // undo history, and any unsaved draft — survives switching away and back.
  // Latched via the "adjust state during render" pattern; cleared when the tab
  // is hidden so re-enabling it doesn't eagerly remount a stale editor.
  const [codeMounted, setCodeMounted] = useState(false);
  if (showCodeTab && activeTab === "code" && !codeMounted) setCodeMounted(true);
  if (!showCodeTab && codeMounted) setCodeMounted(false);

  // Switching tabs drops the current selection so the properties drawer closes
  // instead of carrying a stale pick into the next view. Clears both selection
  // channels (editor `selectedKeys` + circuit `selectedComponentName`).
  const handleTabChange = useCallback(
    (tab: EditorTab) => {
      if (tab === activeTab) return;
      clearSelection();
      setSelectedComponent(null);
      setActiveTab(tab);
    },
    [activeTab, clearSelection, setSelectedComponent, setActiveTab]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <EditorTabBar
        tabs={visibleTabs}
        active={effectiveTab}
        onChange={handleTabChange}
      />
      <div className="flex-1 min-h-0 min-w-0 relative">
        {effectiveTab === "schematic" && <SchematicReadonlyView />}
        {effectiveTab === "pcb" && <PcbTabContent />}
        {effectiveTab === "cad" && <CadTabContent />}
        {effectiveTab === "bom" && <BomTabContent />}
        {codeMounted && (
          <div className={cn("absolute inset-0", effectiveTab !== "code" && "hidden")}>
            <Suspense fallback={<ViewerLoading label="Loading code editor…" />}>
              <CodeEditorTabLazy />
            </Suspense>
          </div>
        )}
        {/* Component properties float over the canvas instead of pushing it,
            sliding in/out with the selection. */}
        <PropertiesDrawer />
      </div>
    </div>
  );
}

// Component properties as an overlay drawer on the left edge of the viewer
// (absolute, z-30, slide via translate-x), driven by the selection: it slides
// in when a component is selected and back out when the selection clears,
// floating over the canvas so it never reflows the viewer. Only the schematic &
// PCB tabs show it. Stays mounted while closed (translated off, `inert`) so the
// slide-out animates.
function PropertiesDrawer() {
  // `selectedKeys` is the canonical editor selection (stale keys pruned by
  // syncSelectionToLiveKeys); `selectedComponentName` is the legacy channel
  // still used by RunFrame clicks on the PCB tab.
  const selectedKeys = useEditorStore((s) => s.selectedKeys);
  const activeTab = useEditorStore((s) => s.activeTab);
  const manualEdits = useEditorStore((s) => s.manualEdits);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const setSelectedComponent = useCircuitStore((s) => s.setSelectedComponent);
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const selectedComponentName = useCircuitStore((s) => s.selectedComponentName);
  const isCompact = useIsCompact();
  // The properties panel only lives in the schematic & PCB editors; other tabs
  // (3D, BOM, code) keep it closed so it never slides in there.
  const tabHasPanel = activeTab === "schematic" || activeTab === "pcb";
  const hasSingleComponentSelection = useMemo(
    () => selectionIsSingleComponent(tsxCode, selectedKeys),
    [tsxCode, selectedKeys]
  );
  // A single user-routed trace (keyed by its connection id in manualEdits) also
  // gets a panel — PropertiesPanel.TraceFields edits its width. Mirrors that
  // panel's `selectedTrace` gate, but read off manualEdits so we don't rebuild
  // the pcb model just to decide whether to slide the drawer in.
  const hasSingleTraceSelection = useMemo(() => {
    if (activeTab !== "pcb" || selectedKeys.size !== 1) return false;
    const [key] = selectedKeys;
    return !!manualEdits[key]?.pcb?.route?.length;
  }, [activeTab, selectedKeys, manualEdits]);
  const open =
    tabHasPanel &&
    (hasSingleComponentSelection ||
      hasSingleTraceSelection ||
      selectedComponentName != null);

  // Dismissing the drawer *is* dropping the selection — both channels, the same
  // way the canvas deselect paths do it. Only wired up on compact, where the
  // drawer covers the canvas and there is no empty space left to tap.
  const handleClose = useCallback(() => {
    clearSelection();
    setSelectedComponent(null);
  }, [clearSelection, setSelectedComponent]);

  return (
    <aside
      className={cn(
        "absolute top-0 left-0 z-20 flex transition-transform duration-200 ease-out",
        // 280px matches the old fixed rail width, but below COMPACT_BREAKPOINT
        // that is 72% of a 390px phone — so the drawer goes full-bleed there,
        // Utility classes
        // rather than an inline width: a `style` attribute would outrank the
        // compact branch.
        isCompact ? "w-full" : "w-[280px] max-w-full",
        // Clears the PCB tab's own floating status bar. Imported from that
        // component rather than restated, so the two can't drift when the bar
        // changes height on touch.
        activeTab === "pcb" ? PCB_STATUS_BAR_CLEARANCE : "bottom-0",
        open ? "translate-x-0" : "-translate-x-full"
      )}
    >
      <div
        inert={!open}
        className="flex-1 min-w-0 flex flex-col border-r border-border bg-sidebar overflow-hidden shadow-xl"
      >
        <PanelErrorBoundary label="Properties panel">
          <PropertiesPanel onClose={isCompact ? handleClose : undefined} />
        </PanelErrorBoundary>
      </div>
    </aside>
  );
}

function EditorTabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: EditorTab;
  onChange: (tab: EditorTab) => void;
}) {
  // 36px tabs are a comfortable mouse target and an awkward thumb one. h-11
  // rather than h-10 because the bar's own border-b eats a pixel off the
  // buttons inside it, and 43px clears the 40px floor the rest of the touch
  // chrome holds where 39px would not.
  const isTouch = useIsTouch();
  const listRef = useRef<HTMLDivElement>(null);

  // The bar scrolls, so the active tab can sit outside the visible strip — and
  // tabs change without a tap (IssuesPanel jumps to PCB, the CAD reload
  // restores its tab). Pull the selected one back into view whenever it moves;
  // `nearest` makes this a no-op when it is already on screen.
  useEffect(() => {
    listRef.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs]);

  return (
    <div
      ref={listRef}
      className={cn(
        // overflow-x-auto is unconditional: five tabs fit a 390px phone today,
        // but a sixth would clip off the right edge with no way to reach it,
        // and a wide viewport never overflows so no scrollbar appears there.
        "flex items-stretch border-b border-border bg-sidebar shrink-0 select-none overflow-x-auto",
        isTouch ? "h-11" : "h-9"
      )}
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.key;
        return (
          // shrink-0 so the row scrolls instead of squeezing the labels into
          // each other once it overflows.
          <div key={tab.key} className="relative flex shrink-0 items-stretch">
            {/* The pill is a sibling inset from the button rather than the
                button's own background: the button stays the full height of the
                bar so the touch target above survives, while the cherry only
                paints the label. */}
            {isActive && (
              <span className="absolute inset-y-1 left-1 right-1 rounded-md bg-primary" />
            )}
            <button
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.key)}
              className={cn(
                // relative to stack above the pill it is painted over.
                "relative text-xs font-medium transition-colors",
                isTouch ? "px-4" : "px-3",
                isActive
                  ? "text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── PCB / 3D / BOM tab content ────────────────────────────────────────────────

// absolute inset-0 (not flex-1): the code-editor fallback renders inside a
// plain positioned div and the CAD fallback inside a non-flex block, so
// flex-1 would collapse to content height and pin the animation to the top.
function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <CircuitLoading label={label} />
    </div>
  );
}

function NoCircuitYet({ tab }: { tab: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="text-center max-w-sm text-muted-foreground">
        <p className="text-sm font-medium mb-1">No {tab} yet</p>
        <p className="text-xs opacity-70">
          Add components to your schematic, then come back here.
        </p>
      </div>
    </div>
  );
}

function PcbTabContent() {
  // PcbCanvas handles its own empty-state UI — no need for the Suspense
  // wrapper since it's loaded synchronously now (no heavy WebGL deps).
  // DRC is scoped here so it only runs while the PCB tab is open.
  usePcbDrc();
  return <PcbCanvas />;
}

function CadTabContent() {
  // The 3D viewer sees a "display" circuitJson: the autorouter's routes kept
  // by default, minus connections the user deleted (noAutoroute), with manual
  // routes spliced over. This is the SAME overlay the DRC runner and fab
  // exporter use (overlayManualRoutes), so 3D / DRC / fab are guaranteed to
  // match the PCB canvas. Raw circuitJson is preserved in the store untouched
  // so debugging / future tooling can opt back into the eval view.
  const rawCircuitJson = useCircuitStore((s) => s.circuitJson);
  const manualEdits = useEditorStore((s) => s.manualEdits);
  const circuitJson = useMemo(
    () => overlayManualRoutes(rawCircuitJson, manualEdits),
    [rawCircuitJson, manualEdits]
  );
  if (!circuitJson || circuitJson.length === 0) return <NoCircuitYet tab="3D model" />;
  return (
    <PanelErrorBoundary
      label="3D viewer"
      onRetry={reloadCadTab}
      retryLabel="Reload app"
    >
      <Suspense fallback={<ViewerLoading label="Loading 3D viewer…" />}>
        <CadViewerLazy circuitJson={circuitJson} />
      </Suspense>
    </PanelErrorBoundary>
  );
}

// Minimal BOM table — circuit-json contains source_component records with
// `name`, `manufacturer_part_number`, `supplier_part_numbers`, etc. Once
// fab-file export lands (Phase 2+), this tab can host the full bom CSV
// export UI from `circuit-json-to-bom-csv`.
function BomTabContent() {
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const rows = useMemo(() => {
    if (!circuitJson) return [];
    const out: { name: string; mpn: string; lcsc: string; ftype: string }[] = [];
    for (const el of circuitJson) {
      if (!el || typeof el !== "object") continue;
      const r = el as Record<string, unknown>;
      if (r.type !== "source_component") continue;
      const supplier = r.supplier_part_numbers as
        | Record<string, string[]>
        | undefined;
      const lcsc = supplier?.jlcpcb?.[0] ?? "";
      out.push({
        name: String(r.name ?? ""),
        mpn: String(r.manufacturer_part_number ?? ""),
        lcsc,
        ftype: String(r.ftype ?? r.type ?? ""),
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [circuitJson]);

  if (rows.length === 0) return <NoCircuitYet tab="BOM" />;

  return (
    <div className="absolute inset-0 overflow-auto bg-background">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-sidebar border-b border-border">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium text-muted-foreground">Designator</th>
            <th className="px-3 py-2 font-medium text-muted-foreground">MPN</th>
            <th className="px-3 py-2 font-medium text-muted-foreground">LCSC</th>
            <th className="px-3 py-2 font-medium text-muted-foreground">Type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.name}-${i}`}
              className="border-b border-border/40 hover:bg-accent/50"
            >
              <td className="px-3 py-1.5 font-mono">{r.name}</td>
              <td className="px-3 py-1.5">{r.mpn}</td>
              <td className="px-3 py-1.5 font-mono">{r.lcsc}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{r.ftype}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
