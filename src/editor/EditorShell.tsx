// EditorShell — top-level editor container.
//
// Routing:
//   - schematic : read-only @tscircuit/schematic-viewer (consumes circuitJson;
//                 AI owns structure, PropertiesPanel owns scalar edits)
//   - pcb       : standalone PcbCanvas (circuitJson + manualEdits, manual
//                 routing — the PHYSICAL artifact stays hand-editable)
//   - cad       : @tscircuit/3d-viewer (consumes circuitJson)
//   - bom       : simple table view (consumes circuitJson)
//
// The schematic / PCB / 3D / BOM tabs all read circuitJson from circuitStore,
// kept fresh by useBackgroundEvaluator(), which runs @tscircuit/eval on every
// tsx + manualEdits change.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore, type EditorTab } from "@/editor/state/editorStore";
import { selectionIsSingleComponent } from "@/editor/shared/componentSelection";
import { useSettingsStore } from "@/store/settingsStore";
import { SchematicReadonlyView } from "@/editor/schematic/SchematicReadonlyView";
import { PcbCanvas } from "@/editor/pcb/PcbCanvas";
import { overlayManualRoutes } from "@/editor/pcb/circuitJsonMerge";
import { useBackgroundEvaluator } from "@/editor/services/useBackgroundEvaluator";
import { usePcbDrc } from "@/editor/services/usePcbDrc";
import { PropertiesPanel } from "@/editor/PropertiesPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

// The Properties drawer slides in from the left when a component is selected;
// 280px matches the old fixed rail width.
const PROPERTIES_DRAWER_WIDTH = 280;

// ─── Default the 3D engine to JSCAD ────────────────────────────────────────
// @tscircuit/3d-viewer reads window.localStorage["cadViewerEngine"] in
// CadViewerInner's useState lazy initializer (fixed upstream in v0.0.560 —
// previously a race between read/write effects meant any seed got clobbered).
// We write "jscad" once per install via a versioned migration key so first
// mount lands on JSCAD; the in-app context-menu toggle still writes to the
// same key, so a user who flips to Manifold has that choice persist.
const CAD_ENGINE_SEED_KEY = "cherryblossom:cadEngineSeeded";
const CAD_ENGINE_SEED_VERSION = "1";
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

const CadViewerLazy = lazy(async () => {
  const m = await import("@tscircuit/3d-viewer");
  return { default: m.CadViewer };
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
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const selectedComponentName = useCircuitStore((s) => s.selectedComponentName);
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

  return (
    <aside
      className={cn(
        "absolute top-0 left-0 z-20 flex transition-transform duration-200 ease-out",
        activeTab === "pcb" ? "bottom-7" : "bottom-0",
        open ? "translate-x-0" : "-translate-x-full"
      )}
      style={{ width: PROPERTIES_DRAWER_WIDTH }}
    >
      <div
        inert={!open}
        className="flex-1 min-w-0 flex flex-col border-r border-border bg-sidebar overflow-hidden shadow-xl"
      >
        <PanelErrorBoundary label="Properties panel">
          <PropertiesPanel />
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
  return (
    <div
      className="flex items-stretch h-9 border-b border-border bg-sidebar shrink-0 select-none"
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.key;
        return (
          <div key={tab.key} className="relative flex items-stretch">
            <button
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.key)}
              className={cn(
                "px-3 text-xs font-medium transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
            {isActive && (
              <span className="absolute bottom-0 left-1 right-1 h-0.5 bg-primary rounded-t" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── PCB / 3D / BOM tab content ────────────────────────────────────────────────

function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground gap-2">
      <Loader2 className="size-4 animate-spin" />
      {label}
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
  // The 3D viewer sees a "display" circuitJson: raw eval output with the
  // autorouter's pcb_trace / pcb_via stripped, and the user's manual
  // routes overlaid. This is the SAME overlay the DRC runner and fab
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
    <Suspense fallback={<ViewerLoading label="Loading 3D viewer…" />}>
      <CadViewerLazy circuitJson={circuitJson} />
    </Suspense>
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
