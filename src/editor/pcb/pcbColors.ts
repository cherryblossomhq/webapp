// Shared visual constants for the PCB editor's two render layers.
//
// The static board geometry is drawn imperatively on a <canvas>
// (`pcbCanvasDraw.ts`) while the interactive chrome — selection / hover
// highlights, ratsnest, route draft, DRC markers, marquee — stays on the
// React/SVG overlay (`PcbCanvas.tsx`). Both need the same palette and grid
// pitch, so the constants live here to keep the two layers in lockstep.
//
// Neutral canvas family shared with the schematic viewer: the bg matches the
// schematic dark background (#18191c, see schematicColors.ts) and the board
// fill is a slightly raised neutral so a board still reads, dropping the old
// cold blue-black. Full per-layer copper light-mode theming is deferred (see
// follow-up issue / layers.ts); the PCB canvas stays dark-only for now, so
// these remain concrete hex.

export const COLOR_BG = "#18191c";
export const COLOR_BOARD_FILL = "#202227";
export const COLOR_BOARD_BORDER = "#3b4350";
export const COLOR_GRID_FINE = "rgba(138, 140, 148, 0.06)";
export const COLOR_GRID_COARSE = "rgba(150, 153, 162, 0.16)";
export const COLOR_HOLE = "#18191c";
// Through-hole pads span every copper layer, so they don't wear a single
// layer's color — they render in Altium's "Multi-Layer" silver-gray instead.
export const COLOR_TH_PAD = "#c0c0c0";
export const COLOR_VIA = "#d4a24a";
export const COLOR_VIA_STROKE = "#7a5a1f";
// Brand-cherry selection highlight (matches the app's --primary brand).
// (Distinct from the orange-red DRC marker COLOR_DRC below: cherry-pink vs
// orange-red.)
export const COLOR_SELECTED = "#ea4065";
export const COLOR_HOVER = "#7ff5ff";
export const COLOR_RATSNEST = "#ca8a04";
export const COLOR_DRC = "#ff4d4f";

// ─── Manual routing overlay ───────────────────────────────────────────────────
// Leader vs committed is ONE axis — opacity plus a glow. No dash: a world-space
// dash shimmers at high DPI while the cursor moves, and that shimmer is the
// "unprofessional" tell. No hue change either, or the route would appear to
// shift colour the instant it is committed.
export const COLOR_CLEARANCE_HALO = "rgba(255, 255, 255, 0.10)";
export const COLOR_ROUTE_LEADER_GLOW = "rgba(255, 255, 255, 0.35)";
export const COLOR_ROUTE_KNEE = "rgba(255, 255, 255, 0.85)";
export const COLOR_ROUTE_BLOCKED = COLOR_DRC;
// Top copper is #ef4444 and COLOR_DRC is #ff4d4f, so a same-hue overstroke on the
// DEFAULT layer is a ~4% pixel delta — invisible, which defeats the whole point of
// a violation cue. It therefore reads by shape as well as hue: a dark rim under a
// wider opaque core, legible on every layer colour rather than only the blue ones.
export const COLOR_ROUTE_BLOCKED_RIM = "rgba(10, 10, 12, 0.85)";
export const ROUTE_COMMITTED_ALPHA = 1;
export const ROUTE_LEADER_ALPHA = 0.75;

export const GRID_FINE_MM = 0.1;
export const GRID_COARSE_MM = 1.0;

export const DIMMED_OPACITY = 0.22;

