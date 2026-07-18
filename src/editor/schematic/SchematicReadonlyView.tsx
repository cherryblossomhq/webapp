// SchematicReadonlyView — the read-only schematic surface.
//
// The bet: the schematic is a *view*, not an editor. Structure changes come
// from the AI (it rewrites the tsx); scalar tweaks (value / footprint / name)
// come from the PropertiesPanel; nobody drags symbols around. So we render
// tscircuit's own schematic viewer straight off circuitJson and let
// tscircuit's autolayout + trace-solver own placement and wiring.
//
// Data source: circuitStore.circuitJson, kept fresh by useBackgroundEvaluator
// on every tsx change. On a new edit, circuitJson holds its PREVIOUS value
// until the new eval lands (stale-while-revalidate); on a hard eval failure it
// holds the last good render and we surface a subtle banner. Clicking a symbol
// selects its component (by source name) for the panel + chat context.

import { useCallback, useMemo, useRef, useState } from "react";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import type { AnyCircuitElement } from "circuit-json";
import { Loader2, AlertTriangle, Sparkles } from "lucide-react";
import { useCircuitStore } from "@/store/circuitStore";
import { useChatStore } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useEditorStore } from "@/editor/state/editorStore";
import { useTheme } from "@/hooks/useTheme";
import { useAiReady } from "@/hooks/useAiReady";
import { hashInput } from "@/editor/services/CircuitEvaluator";
import { extractComponents } from "@/utils/tsxTransform";
import { getSchematicColorOverrides } from "./schematicColors";

// Map a clicked schematic_component_id back to its source designator (e.g. "R1").
// The tsx stable `key` does NOT survive into circuitJson, so the source `name`
// is the join key the rest of the app (PropertiesPanel, chat ## Selection) uses.
function resolveSourceName(
  circuitJson: AnyCircuitElement[],
  schematicComponentId: string
): string | null {
  let sourceId: string | undefined;
  for (const el of circuitJson) {
    const r = el as Record<string, unknown>;
    if (
      r.type === "schematic_component" &&
      r.schematic_component_id === schematicComponentId
    ) {
      sourceId = r.source_component_id as string | undefined;
      break;
    }
  }
  if (!sourceId) return null;
  for (const el of circuitJson) {
    const r = el as Record<string, unknown>;
    if (r.type === "source_component" && r.source_component_id === sourceId) {
      const name = r.name;
      return typeof name === "string" ? name : null;
    }
  }
  return null;
}

export function SchematicReadonlyView() {
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const evalInputHash = useCircuitStore((s) => s.evalInputHash);
  const evalVersion = useCircuitStore((s) => s.evalVersion);
  const evalError = useCircuitStore((s) => s.evalError);
  const setSelectedComponent = useCircuitStore((s) => s.setSelectedComponent);
  const manualEdits = useEditorStore((s) => s.manualEdits);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const { theme } = useTheme();

  // The render is "behind" the live tsx whenever the latest eval doesn't match
  // the current input. Reuses the same hash the chat-validation race relies on.
  const isStale = useMemo(
    () => hashInput(tsxCode, manualEdits) !== evalInputHash,
    [tsxCode, manualEdits, evalInputHash]
  );

  const componentCount = useMemo(
    () => extractComponents(tsxCode).length,
    [tsxCode]
  );

  const hasSchematic = useMemo(
    () =>
      !!circuitJson &&
      circuitJson.some(
        (e) => (e as Record<string, unknown>).type === "schematic_component"
      ),
    [circuitJson]
  );

  // SchematicViewer memoizes its SVG on getCircuitHash(circuitJson) =
  // `${length}_${editCount}`. A scalar edit (resistor value, footprint, name)
  // changes neither the element count nor `editCount` (we never set it), so the
  // viewer keeps showing a STALE svg until it remounts — the "switch tabs and
  // come back to see the change" bug. Hand it a shallow copy stamped with the
  // monotonic eval version as `editCount` so the hash busts on every eval. A
  // copy (not in-place mutation) keeps the store's array clean for the PCB / 3D
  // / BOM consumers; bumping editCount (vs. a React `key`) avoids a remount, so
  // the user's pan/zoom survives the update.
  //
  // Theme is folded into the stamp for the same reason: the viewer reads
  // `colorOverrides` inside its SVG memo but omits it from that memo's deps, so
  // toggling light↔dark wouldn't repaint the SVG on its own. Encoding the theme
  // bit into editCount busts the hash on a theme flip while still preserving
  // pan/zoom (no remount).
  const viewerCircuitJson = useMemo(() => {
    if (!circuitJson) return null;
    const stamped = circuitJson.slice() as AnyCircuitElement[] & {
      editCount?: number;
    };
    (stamped as { editCount?: number }).editCount =
      evalVersion * 2 + (theme === "dark" ? 1 : 0);
    return stamped;
  }, [circuitJson, evalVersion, theme]);

  const colorOverrides = useMemo(
    () => getSchematicColorOverrides(theme),
    [theme]
  );

  const handleComponentClicked = useCallback(
    ({
      schematicComponentId,
      event,
    }: {
      schematicComponentId: string;
      event: MouseEvent;
    }) => {
      if (!circuitJson) return;
      // The viewer hit-tests clicks on a *global* window listener using screen
      // coordinates alone (@tscircuit/schematic-viewer): it fires whenever a
      // click's x/y lands over a component's bounding box, even when the click
      // actually hit a modal, popover, or the properties drawer stacked above
      // the canvas. Those overlays sit outside our surface in the DOM —
      // portaled dialogs (Settings, Export…) at the body root, or sibling
      // overlays like the properties drawer — so gate on the click's real
      // target: ignore any click that didn't land inside the schematic view.
      // Keeps overlay clicks from selecting a component behind them — for every
      // overlay, not just Settings.
      const target = event?.target as Element | null;
      if (!target?.closest(".schematic-readonly")) return;
      const name = resolveSourceName(circuitJson, schematicComponentId);
      if (!name) return;
      // A stale PCB-tab key selection would otherwise shadow this name-based
      // pick in PropertiesPanel (it prefers selectedKeys) — clear it first.
      clearSelection();
      setSelectedComponent(name);
    },
    [circuitJson, clearSelection, setSelectedComponent]
  );

  // Click on empty schematic space → deselect, which slides the Properties
  // drawer back out. A click ON a component is handled by
  // onSchematicComponentClicked above; we only clear when the click landed on
  // bare canvas. Capture the pointer-down position so we can tell a click from
  // a pan (a drag to pan the canvas must NOT deselect).
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const handleBackgroundPointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);
  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      // Component clicks and viewer controls (the ⋮ menu) keep the selection.
      if (
        target.closest("[data-schematic-component-id]") ||
        target.closest("button")
      )
        return;
      const down = pointerDownPos.current;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      clearSelection();
      setSelectedComponent(null);
    },
    [clearSelection, setSelectedComponent]
  );

  // Empty circuit → put the assistant front-and-center: a composer right on the
  // canvas so a first-timer's instinct ("type what I want") just works, instead
  // of having to discover the side chat. Submitting opens the chat rail (so the
  // streamed answer is visible) and routes through the same sendMessage path.
  if (componentCount === 0) {
    return <EmptySchematicPrompt />;
  }

  // Has parts but no rendered schematic yet → eval is booting / in flight, or
  // the current tsx failed to build and we have no prior good render to show.
  if (!hasSchematic) {
    return (
      <Centered>
        {evalError ? (
          <>
            <AlertTriangle className="size-5 mb-2 text-amber-500" />
            <p className="text-sm font-medium mb-1">Couldn’t build the schematic</p>
            <p className="text-xs opacity-70 max-w-md font-mono break-words">
              {evalError}
            </p>
          </>
        ) : (
          <>
            <Loader2 className="size-5 mb-2 animate-spin opacity-60" />
            <p className="text-sm font-medium">Building schematic…</p>
          </>
        )}
      </Centered>
    );
  }

  return (
    <div
      className="schematic-readonly absolute inset-0 bg-background"
      onPointerDownCapture={handleBackgroundPointerDown}
      onClick={handleBackgroundClick}
    >
      <SchematicViewer
        // viewerCircuitJson is the store array stamped with editCount so the
        // viewer's internal SVG memo busts on every eval / theme flip (see note
        // above).
        circuitJson={(viewerCircuitJson ?? circuitJson) as AnyCircuitElement[]}
        editingEnabled={false}
        // The "Show Groups" toggle persists to localStorage and its only off-
        // switch lives in the view menu we hide (see index.css). disableGroups
        // forces groups off regardless of any stale persisted flag, so the
        // overlay can never get stuck on with no way to dismiss it.
        disableGroups
        colorOverrides={colorOverrides}
        containerStyle={{ width: "100%", height: "100%" }}
        onSchematicComponentClicked={handleComponentClicked}
      />

      {/* Subtle, non-blocking status. Top-RIGHT so it clears the properties
          drawer that now slides in over the left edge (the viewer's own menu
          button in this corner is hidden via index.css). Never a blocking
          spinner — the stale render stays visible and useful while eval catches
          up. */}
      <div className="absolute top-2 right-2 flex flex-col items-end gap-1 pointer-events-none">
        {evalError ? (
          <StatusChip tone="warn">
            <AlertTriangle className="size-3" />
            Showing last working version — fixing…
          </StatusChip>
        ) : isStale ? (
          <StatusChip tone="muted">
            <Loader2 className="size-3 animate-spin" />
            Updating…
          </StatusChip>
        ) : null}
      </div>
    </div>
  );
}

// The empty-schematic state. Rather than just *telling* a first-timer to use
// the assistant, we give them the input right here. Submitting opens the chat
// rail and hands off to chatStore.sendMessage — the exact path the side chat
// uses — so the AI owns the build from the very first keystroke.
function EmptySchematicPrompt() {
  const [input, setInput] = useState("");
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setChatOpen = useChatStore((s) => s.setChatOpen);
  const openSettings = useSettingsStore((s) => s.openSettings);

  // Kept in lockstep with the sendMessage guard so this composer and the send
  // path agree on whether the active AI provider is usable. While `pending`
  // (session restore in flight at launch) the sign-in link stays hidden so
  // signed-in users don't get a "Sign in" flash.
  const { ready: aiReady, pending: aiPending, settingsTab } = useAiReady();

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming || aiPending) return;
    // Provider not set up yet → route to Settings rather than firing a doomed send.
    if (!aiReady) {
      openSettings(settingsTab);
      return;
    }
    setInput("");
    // Open the chat rail so the streamed response is visible, then hand off.
    setChatOpen(true);
    void sendMessage(text);
  }, [input, isStreaming, aiReady, aiPending, settingsTab, openSettings, setChatOpen, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
      <div className="flex w-full max-w-md flex-col items-center">
        <Sparkles className="size-5 mb-2 text-primary/70" />
        <p className="text-sm font-medium mb-1 text-foreground">
          Your schematic is empty
        </p>
        <p className="text-xs text-muted-foreground mb-4 max-w-xs">
          Describe what you want to build — the assistant designs the schematic
          for you.
        </p>

        <div className="w-full rounded-xl border border-border bg-card text-left shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. add an ESP32 with a 3V3 regulator"
            rows={2}
            autoFocus
            disabled={isStreaming}
            className="w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
            style={
              { maxHeight: "160px", fieldSizing: "content" } as React.CSSProperties
            }
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
            <span className="pl-1 text-[11px] text-muted-foreground/70">
              Enter to send · Shift+Enter for a new line
            </span>
            <button
              onClick={handleSend}
              disabled={!input.trim() || isStreaming || aiPending}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles className="size-3.5" />
              Send to AI
            </button>
          </div>
        </div>

        {!aiReady && !aiPending && (
          <button
            onClick={() => openSettings(settingsTab)}
            className="mt-3 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Sign in to start
          </button>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-muted-foreground px-6">
      {children}
    </div>
  );
}

function StatusChip({
  tone,
  children,
}: {
  tone: "warn" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur " +
        (tone === "warn"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : "border-border bg-card/80 text-muted-foreground")
      }
    >
      {children}
    </span>
  );
}
