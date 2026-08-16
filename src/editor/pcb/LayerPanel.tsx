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
//
// Below the compact breakpoint the 192px permanent column would eat half a
// phone's canvas, so it becomes a dismissable overlay driven from the toolbar's
// Layers button instead of a dock.

import { useEffect } from "react";
import { isCopperLayer, type LayerConfig } from "./layers";
import { useIsCompact, useIsTouch } from "@/hooks/useViewport";
import type { LayerId } from "@/editor/shared/types";
import { Eye, EyeOff, X } from "lucide-react";

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
  // Overlay state. Ignored while the panel is docked (non-compact widths),
  // where it is always visible and has nothing to close.
  open: boolean;
  onClose: () => void;
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
  open,
  onClose,
}: LayerPanelProps) {
  const isCompact = useIsCompact();
  const isTouch = useIsTouch();
  // Only the compact panel is dismissable; docked it is always on screen and
  // has nothing to close. Escape is the one dismissal a keyboard user has —
  // the scrim needs a pointer and the × is compact-only.
  const isOverlay = isCompact && open;

  useEffect(() => {
    if (!isOverlay) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOverlay, onClose]);

  if (isCompact && !open) return null;

  // Copper layers appear in display order (top → bottom), so the running
  // counter doubles as the 1-based number-key shortcut for each.
  let copperIndex = 0;
  const body = (
    <>
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-medium tracking-wide uppercase text-[10px]">
          Layers
        </span>
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-muted-foreground">
            <span className="text-[10px]">Copper</span>
            <select
              value={numLayers}
              onChange={(e) => onSetLayerCount(Number(e.target.value))}
              className="bg-background border border-border rounded px-1 py-0.5 text-[11px] text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
              title="Board copper layer count"
              aria-label="Board copper layer count"
            >
              {LAYER_COUNT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {isCompact && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close layers"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
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
              className={`flex items-center gap-2 px-3 ${
                isTouch ? "py-2" : "py-1.5"
              } hover:bg-accent/40 ${
                canActivate ? "cursor-pointer" : "cursor-default"
              } ${isActive ? "bg-accent/30" : ""}`}
            >
              {/* A bare 14px icon is an unhittable target with a fingertip, so
                  the button grows to 44px on a coarse pointer — negative margin
                  keeps the row from growing with it. */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleVisibility(layer.id);
                }}
                className={`shrink-0 flex items-center justify-center rounded text-muted-foreground hover:text-foreground ${
                  isTouch ? "size-11 -my-2 -ml-1" : "size-4"
                }`}
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
    </>
  );

  if (!isCompact) {
    return (
      <div className="w-48 shrink-0 border-l border-border bg-sidebar text-xs flex flex-col">
        {body}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-40 flex justify-end">
      {/* Scrim doubles as the dismiss target — the panel covers most of a phone
          screen and reaching a small × is worse than tapping anywhere else. */}
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close layers"
        onClick={onClose}
      />
      <div className="relative w-56 max-w-[80%] h-full border-l border-border bg-sidebar text-xs flex flex-col shadow-xl">
        {body}
      </div>
    </div>
  );
}
