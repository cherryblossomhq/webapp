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

export const GRID_FINE_MM = 0.1;
export const GRID_COARSE_MM = 1.0;

export const DIMMED_OPACITY = 0.22;
