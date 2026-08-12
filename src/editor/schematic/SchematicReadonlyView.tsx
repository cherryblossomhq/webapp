// SchematicReadonlyView — the read-only schematic surface.
//
// The bet: the schematic is a *view*, not an editor. Structure changes come
// from rewriting the tsx; scalar tweaks (value / footprint / name) come from
// the PropertiesPanel; nobody drags symbols around. So we render
// tscircuit's own schematic viewer straight off circuitJson and let
// tscircuit's autolayout + trace-solver own placement and wiring.
//
// Data source: circuitStore.circuitJson, kept fresh by useBackgroundEvaluator
// on every tsx change. On a new edit, circuitJson holds its PREVIOUS value
// until the new eval lands (stale-while-revalidate); on a hard eval failure it
// holds the last good render and we surface a subtle banner. Clicking a symbol
// selects its component (by source name) for the properties panel — with a
// separate pointer-driven path for touch, see "Tap-to-select" below.

import { useCallback, useMemo, useRef } from "react";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import type { AnyCircuitElement } from "circuit-json";
import { Loader2, AlertTriangle, Sparkles } from "lucide-react";
import { useCircuitStore } from "@/store/circuitStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useEditorStore } from "@/editor/state/editorStore";
import { useTheme } from "@/hooks/useTheme";
import { hashInput } from "@/editor/services/CircuitEvaluator";
import { extractComponents } from "@/utils/tsxTransform";
import { getSchematicColorOverrides } from "./schematicColors";
import { CircuitLoading } from "@/components/CircuitLoading";

// Map a clicked schematic_component_id back to its source designator (e.g. "R1").
// The tsx stable `key` does NOT survive into circuitJson, so the source `name`
// is the join key the rest of the app (PropertiesPanel) uses.
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

// ─── Tap-to-select on touch ──────────────────────────────────────────────────
// The viewer's selection is mouse-only, and not by omission. Pan / pinch come
// from `use-mouse-matrix-transform`, whose `touchstart` listener is registered
// `{ passive: false }` and calls `preventDefault()` as its first statement,
// unconditionally. A canceled `touchstart` tells the browser not to synthesize
// the compatibility mouse events — `mousedown`, `mouseup` and, fatally,
// `click`. And `click` is the only channel selection travels on: the viewer
// hit-tests every component's measured client rect from a *window* `click`
// listener and calls `onSchematicComponentClicked` from there, while our
// deselect is the React `onClick` below. Verified in Chromium with a real touch
// tap: the sequence is `pointerdown, touchstart, pointerup, touchend` and
// nothing selects.
//
// The unconditional `preventDefault()` is upstream's bug to fix (it should be
// gated on a gesture actually starting, and on `props.enabled`). Until then we
// resolve taps from `pointerup`, which touch does deliver, hit-testing the same
// DOM the viewer measures. Mouse still goes through `click`, so desktop is
// untouched; if a future dep fix restores the synthetic click, both paths reach
// the same state (they're idempotent) rather than fighting.

// Movement allowed between press and release before it's a pan, not a tap. A
// finger never lifts within 3px of where it landed. These match the PCB
// canvas's MOUSE/TOUCH_TOLERANCES.dragThresholdPx so both surfaces feel the
// same under the same hand.
const MOUSE_TAP_SLOP_PX = 4;
const TOUCH_TAP_SLOP_PX = 10;
// Fingertip pick slop: grow each symbol's box before hit-testing so a tap that
// lands just shy of a small symbol still selects it.
const TOUCH_HIT_SLOP_PX = 11;

/**
 * The schematic component whose rendered box contains (x, y) in client
 * coordinates, or null for bare canvas. Mirrors the viewer's own hit test — it
 * measures each `[data-schematic-component-id]` element's client rect and tests
 * the point against it — because the viewer only publishes the result through a
 * `click` that touch never produces. Smallest box wins so a symbol sitting
 * inside a larger element's box still resolves to the symbol.
 */
function schematicComponentIdAtPoint(
  root: Element,
  x: number,
  y: number,
  slop: number
): string | null {
  let best: { id: string; area: number } | null = null;
  for (const el of root.querySelectorAll("[data-schematic-component-id]")) {
    const id = el.getAttribute("data-schematic-component-id");
    if (!id) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (
      x < r.left - slop ||
      x > r.right + slop ||
      y < r.top - slop ||
      y > r.bottom + slop
    ) {
      continue;
    }
    const area = r.width * r.height;
    if (!best || area < best.area) best = { id, area };
  }
  return best?.id ?? null;
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
  // the current input. Reuses the evaluator's own input hash.
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

  const clearComponentSelection = useCallback(() => {
    clearSelection();
    setSelectedComponent(null);
  }, [clearSelection, setSelectedComponent]);

  // Click on empty schematic space → deselect, which slides the Properties
  // drawer back out. A click ON a component is handled by
  // onSchematicComponentClicked above; we only clear when the click landed on
  // bare canvas. Capture the pointer-down position so we can tell a click from
  // a pan (a drag to pan the canvas must NOT deselect).
  const pointerDownPos = useRef<{
    x: number;
    y: number;
    pointerType: string;
  } | null>(null);
  // Set the moment a second finger lands. A pinch must never resolve as a tap,
  // even when the first finger happens to lift close to where it started
  // (rotating the pinch about it barely moves it).
  const sawSecondPointer = useRef(false);

  const handleBackgroundPointerDown = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) {
      sawSecondPointer.current = true;
      return;
    }
    sawSecondPointer.current = false;
    pointerDownPos.current = {
      x: e.clientX,
      y: e.clientY,
      pointerType: e.pointerType,
    };
  }, []);

  const handleBackgroundPointerCancel = useCallback(() => {
    pointerDownPos.current = null;
  }, []);

  // The touch half of selection (see "Tap-to-select" above). Mouse returns
  // immediately: `click` still drives it, and running both would only duplicate
  // work.
  const handleBackgroundPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (!e.isPrimary || sawSecondPointer.current) return;
      // Deliberately not cleared here: the next primary pointerdown overwrites
      // it, and leaving it in place keeps the `click` fallback below reading
      // the same press position with the same slop, should a browser ever
      // deliver the synthesized click after all.
      const down = pointerDownPos.current;
      // Viewer chrome (sheet selector, the ⋮ menu) owns its own taps.
      if ((e.target as Element | null)?.closest("button")) return;
      // Panned, not tapped.
      if (
        down &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > TOUCH_TAP_SLOP_PX
      ) {
        return;
      }
      const id = schematicComponentIdAtPoint(
        e.currentTarget,
        e.clientX,
        e.clientY,
        TOUCH_HIT_SLOP_PX
      );
      const name =
        id && circuitJson ? resolveSourceName(circuitJson, id) : null;
      if (!name) {
        clearComponentSelection();
        return;
      }
      clearSelection();
      setSelectedComponent(name);
    },
    [circuitJson, clearComponentSelection, clearSelection, setSelectedComponent]
  );

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
      // A finger routinely travels further than a mouse between press and
      // release, so the drag guard scales with whatever was doing the pressing.
      const slop =
        down && down.pointerType !== "mouse"
          ? TOUCH_TAP_SLOP_PX
          : MOUSE_TAP_SLOP_PX;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop) {
        return;
      }
      clearComponentSelection();
    },
    [clearComponentSelection]
  );

  // Empty circuit → point at the Code tab, which is where a board is authored.
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
          <CircuitLoading label="Building schematic…" />
        )}
      </Centered>
    );
  }

  return (
    <div
      className="schematic-readonly absolute inset-0 bg-background"
      onPointerDownCapture={handleBackgroundPointerDown}
      onPointerUp={handleBackgroundPointerUp}
      onPointerCancel={handleBackgroundPointerCancel}
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

// The empty-schematic state: a board with no parts yet. Points at the Code tab,
// where the circuit's TSX is edited — every part that lands on this canvas comes
// from there.
function EmptySchematicPrompt() {
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const showCodeTab = useSettingsStore((s) => s.showCodeTab);
  const setShowCodeTab = useSettingsStore((s) => s.setShowCodeTab);

  const openCode = useCallback(() => {
    if (!showCodeTab) setShowCodeTab(true);
    setActiveTab("code");
  }, [showCodeTab, setShowCodeTab, setActiveTab]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
      <div className="flex w-full max-w-md flex-col items-center">
        <Sparkles className="size-5 mb-2 text-primary/70" />
        <p className="text-sm font-medium mb-1 text-foreground">
          Your schematic is empty
        </p>
        <p className="text-xs text-muted-foreground mb-4 max-w-xs">
          Circuits are described as TSX. Add a part in the Code tab and it shows
          up here, on the PCB, and in 3D.
        </p>
        <button
          onClick={openCode}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Open the Code tab
        </button>
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
