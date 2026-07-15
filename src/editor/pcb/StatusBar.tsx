// StatusBar — bottom-edge HUD for the PCB editor.

import { Eye, EyeOff } from "lucide-react";
import { getLayer, routingModeLabel } from "./layers";
import { useEditorStore } from "@/editor/state/editorStore";
import type { LayerId, PcbRoutingMode } from "@/editor/shared/types";

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
}: StatusBarProps) {
  // Subscribed here — NOT passed down from PcbCanvas — so per-pointermove
  // cursor updates re-render only this strip, never the canvas component.
  const cursorWorld = useEditorStore((s) => s.pcbCursorMm);
  const layer = getLayer(activeLayer);
  return (
    <div className="absolute bottom-0 left-0 right-0 z-40 h-7 flex items-center gap-4 px-3 bg-sidebar/80 backdrop-blur-sm border-t border-border text-[11px] font-mono text-muted-foreground select-none pointer-events-none">
      <div className="flex items-center gap-1.5">
        <span className="opacity-60">x:</span>
        <span className="text-foreground tabular-nums w-14">
          {cursorWorld ? formatMm(cursorWorld.x) : "—"}
        </span>
        <span className="opacity-60">y:</span>
        <span className="text-foreground tabular-nums w-14">
          {cursorWorld ? formatMm(cursorWorld.y) : "—"}
        </span>
      </div>

      <div className="opacity-30">·</div>

      <div className="flex items-center gap-1.5">
        <span
          className="size-2 rounded-sm"
          style={{ background: layer?.color ?? "#888" }}
        />
        <span className="text-foreground">{layer?.label ?? activeLayer}</span>
      </div>

      <div className="opacity-30">·</div>

      <div className="flex items-center gap-1.5">
        <span className="opacity-60">grid:</span>
        <span className="tabular-nums">{gridMm.toFixed(2)} mm</span>
      </div>

      <div className="opacity-30">·</div>

      <div className="flex items-center gap-1.5">
        <span className="opacity-60">w:</span>
        <span className="text-foreground tabular-nums">
          {widthProfileLabel
            ? `${widthProfileLabel} (${traceWidthMm.toFixed(2)} mm)`
            : `${traceWidthMm.toFixed(2)} mm`}
        </span>
      </div>

      <div className="opacity-30">·</div>

      <div className="flex items-center gap-1.5">
        <span className="opacity-60">route:</span>
        <span className="text-foreground">{routingModeLabel(routingMode)}</span>
      </div>

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
            className="flex items-center gap-1.5 pointer-events-auto hover:text-foreground cursor-pointer"
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
            className="flex items-center pointer-events-auto hover:text-foreground cursor-pointer disabled:cursor-default disabled:opacity-50"
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

      <div className="opacity-30">·</div>

      <div className="flex items-center gap-1.5 capitalize">
        <span className="opacity-60">tool:</span>
        <span className="text-foreground">{toolMode}</span>
      </div>
    </div>
  );
}

function formatMm(v: number): string {
  const n = Math.abs(v) < 0.005 ? 0 : v;
  const s = n.toFixed(2);
  return n >= 0 ? `+${s}` : s;
}
