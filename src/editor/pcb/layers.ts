// Layer config for the PCB canvas.
//
// The data model has always been N-layer (LayerId is just `string` and every
// route point / pad / via carries its own layer). This module turns the
// board's copper-layer count into the concrete set of layers the UI shows:
// a 2-layer board surfaces top + bottom, a 4-layer board adds inner1 / inner2,
// and so on up to 8 copper layers — matching circuit-json's layer naming
// ("top" / "bottom" / "inner1" … "inner6").
//
// Color choices mirror Altium / KiCad conventions:
//   - Top copper:    red
//   - Bottom copper: blue
//   - Inner copper:  a distinct hue per layer (green, amber, purple, …)
//   - Silkscreen:    near-white (subtle on dark background)
// The active layer renders at full alpha; inactive layers fade so the user
// can tell where they're routing without losing context.

import type { LayerId, PcbRoutingMode } from "@/editor/shared/types";

export interface LayerConfig {
  id: LayerId;
  // Display name in the layer panel.
  label: string;
  // Hex color used for traces, pads, and via annular rings on this layer.
  color: string;
  // Render order, lowest first. Board outline < copper (bottom→top) <
  // silkscreen — we want copper above the board and silkscreen labels on
  // top of copper.
  zOrder: number;
  // True for copper layers (top / bottom / inner*); false for silkscreen,
  // mask, and the board outline. Only copper layers can host routed traces
  // and be picked as the active routing layer.
  isCopper: boolean;
}

// ─── Copper layer registry ────────────────────────────────────────────────────

export const TOP_LAYER_ID: LayerId = "top";
export const BOTTOM_LAYER_ID: LayerId = "bottom";

// circuit-json supports up to 6 inner copper layers (inner1 … inner6), for a
// total of 8 copper layers including the two outer faces.
export const MIN_COPPER_LAYERS = 2;
export const MAX_COPPER_LAYERS = 8;
export const DEFAULT_COPPER_LAYERS = 2;

// All possible inner layer ids, ordered top→bottom (inner1 sits just under the
// top face). circuit-json's `all_layers` uses this exact naming.
export const INNER_LAYER_IDS: ReadonlyArray<LayerId> = [
  "inner1",
  "inner2",
  "inner3",
  "inner4",
  "inner5",
  "inner6",
];

// Distinct hue per inner layer so a multi-layer board reads at a glance.
const INNER_LAYER_COLORS: Record<string, string> = {
  inner1: "#22c55e", // green
  inner2: "#eab308", // amber
  inner3: "#a855f7", // purple
  inner4: "#f97316", // orange
  inner5: "#14b8a6", // teal
  inner6: "#ec4899", // pink
};

// zOrder for each inner layer — slotted between bottom (10) and top (30) so
// the physical stackup (top → inner1 → … → bottom) maps to paint order.
// inner1 = 28 (just below top), inner6 = 18 (just above bottom).
function innerZOrder(idx: number): number {
  return 28 - idx * 2;
}

// ─── Full layer registry (every layer the editor knows about) ─────────────────

const SILKSCREEN_TOP: LayerConfig = {
  id: "silkscreen_top" as LayerId,
  label: "Silkscreen (top)",
  color: "#e5e7eb",
  zOrder: 40,
  isCopper: false,
};
const SILKSCREEN_BOTTOM: LayerConfig = {
  id: "silkscreen_bottom" as LayerId,
  label: "Silkscreen (bottom)",
  color: "#9ca3af",
  zOrder: 41,
  isCopper: false,
};
const BOARD_OUTLINE: LayerConfig = {
  id: "board" as LayerId,
  label: "Board outline",
  color: "#4a5160",
  zOrder: 0,
  isCopper: false,
};
const TOP_COPPER: LayerConfig = {
  id: TOP_LAYER_ID,
  label: "Top copper",
  color: "#ef4444",
  zOrder: 30,
  isCopper: true,
};
const BOTTOM_COPPER: LayerConfig = {
  id: BOTTOM_LAYER_ID,
  label: "Bottom copper",
  color: "#3b82f6",
  zOrder: 10,
  isCopper: true,
};

function innerLayerConfig(idx: number): LayerConfig {
  const id = INNER_LAYER_IDS[idx];
  return {
    id,
    label: `Inner ${idx + 1}`,
    color: INNER_LAYER_COLORS[id] ?? "#94a3b8",
    zOrder: innerZOrder(idx),
    isCopper: true,
  };
}

// Every layer the editor can render, used for id→config lookups (colors,
// labels). The visible *set* for a given board is derived per layer-count via
// `layersForCount` — this is just the registry.
export const ALL_LAYERS: ReadonlyArray<LayerConfig> = [
  BOARD_OUTLINE,
  BOTTOM_COPPER,
  ...INNER_LAYER_IDS.map((_, i) => innerLayerConfig(i)),
  TOP_COPPER,
  SILKSCREEN_TOP,
  SILKSCREEN_BOTTOM,
];

const LAYER_BY_ID = new Map<LayerId, LayerConfig>(
  ALL_LAYERS.map((l) => [l.id, l])
);

export function getLayer(id: LayerId): LayerConfig | undefined {
  return LAYER_BY_ID.get(id);
}

// Resolve a layer color (or a fallback when the layer is unknown).
export function getLayerColor(id: LayerId, fallback = "#94a3b8"): string {
  return LAYER_BY_ID.get(id)?.color ?? fallback;
}

// Returns true for copper layers — used by the route tool to reject clicks
// targeting silkscreen / board / unknown layers.
export function isCopperLayer(id: LayerId): boolean {
  return LAYER_BY_ID.get(id)?.isCopper ?? false;
}

// ─── Board-count → layer set ──────────────────────────────────────────────────

// Clamp an arbitrary layer count into the supported copper range.
export function clampCopperLayers(n: number | undefined): number {
  if (!Number.isFinite(n)) return DEFAULT_COPPER_LAYERS;
  return Math.min(MAX_COPPER_LAYERS, Math.max(MIN_COPPER_LAYERS, Math.round(n!)));
}

// Copper layer *ids* for an N-layer board, ordered top → bottom:
//   2 layers → [top, bottom]
//   4 layers → [top, inner1, inner2, bottom]
export function copperLayerIdsForCount(numLayers: number): LayerId[] {
  const n = clampCopperLayers(numLayers);
  const inner = INNER_LAYER_IDS.slice(0, n - 2);
  return [TOP_LAYER_ID, ...inner, BOTTOM_LAYER_ID];
}

// Copper LayerConfigs for an N-layer board, ordered top → bottom.
export function copperLayersForCount(numLayers: number): LayerConfig[] {
  return copperLayerIdsForCount(numLayers).map(
    (id) => LAYER_BY_ID.get(id) as LayerConfig
  );
}

// Every layer shown in the LayerPanel for an N-layer board, in physical
// top→bottom display order: top silkscreen, copper (top→bottom), bottom
// silkscreen, then the board outline.
export function layersForCount(numLayers: number): LayerConfig[] {
  return [
    SILKSCREEN_TOP,
    ...copperLayersForCount(numLayers),
    SILKSCREEN_BOTTOM,
    BOARD_OUTLINE,
  ];
}

// Default visibility map shipped on first load. Everything visible — this is a
// routing tool, so hiding copper by default would just hide the user's work.
// Inner layers absent from the map read as visible too (the renderer treats
// `!== false` as on).
export function defaultLayerVisibility(): Record<LayerId, boolean> {
  const v: Record<LayerId, boolean> = {};
  for (const l of ALL_LAYERS) v[l.id] = true;
  return v;
}

export const DEFAULT_TRACE_WIDTH_MM = 0.25;

export interface TraceWidthProfile {
  id: string;
  label: string;
  widthMm: number;
}

export const TRACE_WIDTH_PROFILES: ReadonlyArray<TraceWidthProfile> = [
  { id: "fine", label: "Fine", widthMm: 0.15 },
  { id: "signal", label: "Signal", widthMm: 0.25 },
  { id: "power", label: "Power", widthMm: 0.6 },
  { id: "high", label: "High current", widthMm: 1.0 },
];

export function profileForWidth(
  widthMm: number
): TraceWidthProfile | undefined {
  return TRACE_WIDTH_PROFILES.find((p) => Math.abs(p.widthMm - widthMm) < 1e-6);
}

export function profileForId(id: string): TraceWidthProfile | undefined {
  return TRACE_WIDTH_PROFILES.find((p) => p.id === id);
}

// Corner style and angle constraint are one axis, so this list is also what
// `G` / `Shift`+`Space` cycle. Order runs from the most constrained to the least.
export const PCB_ROUTING_MODES: ReadonlyArray<PcbRoutingMode> = [
  "ortho",
  "diag45",
  "curved",
  "free",
];

export function routingModeLabel(mode: PcbRoutingMode): string {
  switch (mode) {
    case "ortho":
      return "90°";
    case "diag45":
      return "45°";
    case "curved":
      return "Round";
    case "free":
      return "Any";
  }
}

// Standard via dimensions (mm). These match JLCPCB's standard min-via spec
// (0.3mm drill / 0.6mm pad) which is what nearly every hobbyist board uses.
export const DEFAULT_VIA_DRILL_MM = 0.3;
export const DEFAULT_VIA_PAD_MM = 0.6;

