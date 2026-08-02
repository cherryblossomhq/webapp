// StatusBar — bottom-edge HUD for the PCB editor.
//
// Eight segments of monospace readout is ~500px of content in a strip that
// can't wrap or scroll, so below the compact breakpoint it drops to the three
// that are actionable or change under you: active layer, trace width, DRC. The
// live cursor readout is the first to go — it's fed by pointermove, which on a
// touch device only fires while a finger is already covering the board.

import { useSyncExternalStore } from "react";
import { Eye, EyeOff } from "lucide-react";
import { getLayer, routingModeLabel } from "./layers";
import { routeLive } from "./routeLive";
import { useEditorStore } from "@/editor/state/editorStore";
import { useIsCompact, useIsTouch } from "@/hooks/useViewport";
import type { LayerId, PcbRoutingMode } from "@/editor/shared/types";

// The bar floats over the canvas, so anything else floating in the PCB stage has
// to clear it — EditorShell's properties drawer offsets by exactly this much.
// Declared as a matched pair of CSS variants rather than each side branching on
// `useIsTouch()` independently, because that is precisely how they drifted: the
// bar grew to 36px on touch while the drawer went on clearing 28px, hiding the
// bottom 8px of the drawer behind it.
//
// 28px is under any touch-target guideline, but a 44px strip would eat real
// board area; 36px with roomier interactive children is the compromise.
export const PCB_STATUS_BAR_HEIGHT = "h-7 pointer-coarse:h-9";
export const PCB_STATUS_BAR_CLEARANCE = "bottom-7 pointer-coarse:bottom-9";

interface StatusBarProps {
  activeLayer: LayerId;
  gridMm: number;
  traceWidthMm: number;
  widthProfileLabel: string | null;
  routingMode: PcbRoutingMode;
  toolMode: string;
  drcCount: number;
  onDrcClick?: () => void;
  // DRC marker visibility on the canvas + its toggle. The count/inspector stay
  // available even when the markers are hidden.
  drcVisible: boolean;
  onToggleDrcVisible?: () => void;
  // Cycles the trace-width profile — the T shortcut's on-screen twin. The
  // readout was an inert <span>, which made width unchangeable without a
  // keyboard.
  onCycleTraceWidth?: () => void;
}

export function StatusBar({
  activeLayer,
  gridMm,
  traceWidthMm,
  widthProfileLabel,
  routingMode,
  toolMode,
  drcCount,
  onDrcClick,
  drcVisible,
  onToggleDrcVisible,
  onCycleTraceWidth,
}: StatusBarProps) {
  // Subscribed here — NOT passed down from PcbCanvas — so per-pointermove
  // cursor updates re-render only this strip, never the canvas component.
  const cursorWorld = useEditorStore((s) => s.pcbCursorMm);
  // While a route is in flight the whole readout comes off routeLive instead,
  // republished at most every 100ms. That is the only React subscription on the
  // routing hot path, and it is why a drag re-renders this 28px strip ten times
  // a second and nothing else.
  const hud = useSyncExternalStore(routeLive.subscribeHud, routeLive.getHud);
  const isCompact = useIsCompact();
  const isTouch = useIsTouch();
  const layer = getLayer(hud.active ? hud.layer : activeLayer);
  const tapTarget = isTouch ? "min-h-8 px-1.5 -mx-0.5" : "";
  const cursor = hud.active
    ? hud.cursorValid
      ? { x: hud.cursorX, y: hud.cursorY }
      : null
    : cursorWorld;
  const widthMm = hud.active ? hud.widthMm : traceWidthMm;
  return (
    <div
      data-testid="pcb-status-bar"
      // whitespace-nowrap is load-bearing, not cosmetic: the strip cannot wrap
      // or scroll, so without it a long segment ("signal (0.25 mm)") folds onto
      // a second line and is clipped by the 28px height.
      className={`absolute bottom-0 left-0 right-0 z-40 ${PCB_STATUS_BAR_HEIGHT} flex items-center gap-4 px-3 bg-sidebar/80 backdrop-blur-sm border-t border-border text-[11px] font-mono text-muted-foreground select-none pointer-events-none whitespace-nowrap`}
    >
      {!isCompact && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="opacity-60">x:</span>
            <span className="text-foreground tabular-nums w-14">
              {cursor ? formatMm(cursor.x) : "—"}
            </span>
            <span className="opacity-60">y:</span>
            <span className="text-foreground tabular-nums w-14">
              {cursor ? formatMm(cursor.y) : "—"}
            </span>
          </div>

          <Dot />
        </>
      )}

      <div className="flex items-center gap-1.5">
        <span
          className="size-2 rounded-sm"
          style={{ background: layer?.color ?? "#888" }}
        />
        <span className="text-foreground">{layer?.label ?? activeLayer}</span>
      </div>

      {/* Grid pitch is fixed and no mid-route decision depends on it, so the
          routing readout takes its space rather than overflowing the strip. */}
      {!isCompact && !hud.active && (
        <>
          <Dot />

          <div className="flex items-center gap-1.5">
            <span className="opacity-60">grid:</span>
            <span className="tabular-nums">{gridMm.toFixed(2)} mm</span>
          </div>
        </>
      )}

      <Dot />

      <button
        type="button"
        onClick={onCycleTraceWidth}
        disabled={!onCycleTraceWidth}
        className={`flex items-center gap-1.5 rounded pointer-events-auto hover:text-foreground disabled:pointer-events-none ${tapTarget}`}
        title="Trace width — tap to cycle profile (T)"
        aria-label={`Trace width ${traceWidthMm.toFixed(2)} millimetres. Activate to cycle.`}
      >
        <span className="opacity-60">w:</span>
        <span className="text-foreground tabular-nums">
          {widthProfileLabel && !isCompact && !hud.active
            ? `${widthProfileLabel} (${widthMm.toFixed(2)} mm)`
            : `${widthMm.toFixed(2)} mm`}
        </span>
      </button>

      {!isCompact && (
        <>
          <Dot />

          <div className="flex items-center gap-1.5">
            <span className="opacity-60">route:</span>
            <span className="text-foreground">
              {routingModeLabel(hud.active ? hud.mode : routingMode)}
            </span>
          </div>
        </>
      )}

      {hud.active && !isCompact && (
        <>
          <Dot />
          <span className="text-foreground">
            {hud.mode === "free"
              ? "—"
              : hud.posture === "hv-first"
                ? "H/V first"
                : "45 first"}
            {hud.postureLocked ? " ·" : ""}
          </span>
          <Dot />
          <span className="text-foreground">
            {hud.conflictMode === "walkaround" ? "walk" : "ignore"}
          </span>
        </>
      )}

      {hud.active && (
        <>
          <Dot />
          <div className="flex items-center gap-1.5">
            <span className="opacity-60">len</span>
            <span className="text-foreground tabular-nums">
              {hud.totalLengthMm.toFixed(2)} mm
            </span>
            <span className="opacity-60 tabular-nums">
              (+{hud.leaderLengthMm.toFixed(2)})
            </span>
          </div>
          {hud.viaCount > 0 && !isCompact && (
            <>
              <Dot />
              <span className="tabular-nums">
                {hud.viaCount} {hud.viaCount === 1 ? "via" : "vias"}
              </span>
            </>
          )}
          {hud.blocked && (
            <>
              <Dot />
              <span className="text-red-400">blocked</span>
            </>
          )}
        </>
      )}

      <div className="flex-1" />

      {drcCount === 0 ? (
        <div className="flex items-center gap-1.5">
          <span className="opacity-60">DRC:</span>
          <span className="text-emerald-500">clear</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onDrcClick}
            disabled={!onDrcClick}
            className={`flex items-center gap-1.5 rounded pointer-events-auto hover:text-foreground cursor-pointer ${tapTarget}`}
            title="Inspect DRC issues"
          >
            <span className="opacity-60">DRC:</span>
            <span className="text-red-400 tabular-nums">
              {drcCount} {drcCount === 1 ? "issue" : "issues"}
            </span>
          </button>
          <button
            type="button"
            onClick={onToggleDrcVisible}
            disabled={!onToggleDrcVisible}
            aria-pressed={drcVisible}
            className={`flex items-center justify-center rounded pointer-events-auto hover:text-foreground cursor-pointer disabled:cursor-default disabled:opacity-50 ${
              isTouch ? "size-8" : ""
            }`}
            title={drcVisible ? "Hide DRC markers" : "Show DRC markers"}
            aria-label={drcVisible ? "Hide DRC markers" : "Show DRC markers"}
          >
            {drcVisible ? (
              <Eye className="size-3.5" />
            ) : (
              <EyeOff className="size-3.5" />
            )}
          </button>
        </div>
      )}

      {/* The route banner names the tool while drafting, so this yields too. */}
      {!isCompact && !hud.active && (
        <>
          <Dot />

          <div className="flex items-center gap-1.5 capitalize">
            <span className="opacity-60">tool:</span>
            <span className="text-foreground">{toolMode}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Dot() {
  return <div className="opacity-30">·</div>;
}

function formatMm(v: number): string {
  const n = Math.abs(v) < 0.005 ? 0 : v;
  const s = n.toFixed(2);
  return n >= 0 ? `+${s}` : s;
}

