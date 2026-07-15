// LayerPanel — right-side dock for the PCB editor.
//
// Header carries a board layer-count selector (2 / 4 / 6 / 8 copper layers) —
// switching it rewrites the board's `layers={N}` prop, which lights up the
// inner copper layers below. Each layer row has:
//   - A visibility toggle (eye icon)
//   - A color swatch
//   - The layer name
//   - For copper layers: the number-key shortcut + an "active" radio (routes
//     land on the active layer)
//
// Clicking anywhere on a row (except the eye icon) activates the layer. The
// visibility toggle does NOT activate; users routinely hide layers without
// wanting the active routing layer to change.

import { isCopperLayer, type LayerConfig } from "./layers";
import type { LayerId } from "@/editor/shared/types";
import { Eye, EyeOff } from "lucide-react";

interface LayerPanelProps {
  // Layers to show, in physical top→bottom display order (board-aware).
  layers: ReadonlyArray<LayerConfig>;
  activeLayer: LayerId;
  layerVisibility: Readonly<Record<LayerId, boolean>>;
  // Current copper layer count (drives the selector's value).
  numLayers: number;
  onActivate: (layer: LayerId) => void;
  onToggleVisibility: (layer: LayerId) => void;
  onSetLayerCount: (n: number) => void;
}

// Even copper counts cover the vast majority of fabbed boards; tscircuit
// supports up to 8 (2 outer + 6 inner).
const LAYER_COUNT_OPTIONS = [2, 4, 6, 8];

export function LayerPanel({
  layers,
  activeLayer,
  layerVisibility,
  numLayers,
  onActivate,
  onToggleVisibility,
  onSetLayerCount,
}: LayerPanelProps) {
  // Copper layers appear in display order (top → bottom), so the running
  // counter doubles as the 1-based number-key shortcut for each.
  let copperIndex = 0;
  return (
    <div className="w-48 shrink-0 border-l border-border bg-sidebar text-xs flex flex-col">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-medium tracking-wide uppercase text-[10px]">
          Layers
        </span>
        <label className="flex items-center gap-1 text-muted-foreground">
          <span className="text-[10px]">Copper</span>
          <select
            value={numLayers}
            onChange={(e) => onSetLayerCount(Number(e.target.value))}
            className="bg-background border border-border rounded px-1 py-0.5 text-[11px] text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
            title="Board copper layer count"
          >
            {LAYER_COUNT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex-1 overflow-y-auto">
        {layers.map((layer) => {
          const visible = layerVisibility[layer.id] !== false;
          const isActive = activeLayer === layer.id;
          const canActivate = isCopperLayer(layer.id);
          const shortcut = canActivate ? ++copperIndex : null;
          return (
            <div
              key={layer.id}
              onClick={() => {
                if (canActivate) onActivate(layer.id);
              }}
              onKeyDown={(e) => {
                if (!canActivate) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onActivate(layer.id);
                }
              }}
              role={canActivate ? "button" : undefined}
              tabIndex={canActivate ? 0 : undefined}
              aria-pressed={canActivate ? isActive : undefined}
              title={canActivate ? "Make active layer" : "Non-routable layer"}
              className={`flex items-center gap-2 px-3 py-1.5 hover:bg-accent/40 ${
                canActivate ? "cursor-pointer" : "cursor-default"
              } ${isActive ? "bg-accent/30" : ""}`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleVisibility(layer.id);
                }}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`${visible ? "Hide" : "Show"} ${layer.label}`}
                title={visible ? "Hide layer" : "Show layer"}
              >
                {visible ? (
                  <Eye className="size-3.5" />
                ) : (
                  <EyeOff className="size-3.5 opacity-50" />
                )}
              </button>

              <span
                className="size-3 rounded-sm shrink-0 border border-black/40"
                style={{ background: layer.color }}
                aria-hidden
              />

              <span
                className={`flex-1 min-w-0 text-left truncate ${
                  canActivate ? "" : "opacity-60"
                } ${isActive ? "text-foreground font-medium" : "text-muted-foreground"}`}
              >
                {layer.label}
              </span>

              {shortcut !== null && (
                <kbd
                  className={`shrink-0 px-1 rounded text-[9px] tabular-nums border ${
                    isActive
                      ? "border-primary/50 text-primary"
                      : "border-border text-muted-foreground/60"
                  }`}
                  aria-hidden
                >
                  {shortcut}
                </kbd>
              )}

              {canActivate && (
                <span
                  className={`size-2 rounded-full shrink-0 ${
                    isActive
                      ? "bg-primary"
                      : "border border-muted-foreground/40"
                  }`}
                  aria-hidden
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
