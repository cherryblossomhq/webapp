// routeClearance — the ONE place that decides how far copper has to stay from
// other copper, shared by the live route preview and by what DRC will later say.
//
// Every path this module feeds is a CENTRELINE, so each formula carries
// `traceWidth / 2`. The constants mirror @tscircuit/checks' JLC minimum
// tolerances (`min_trace_to_pad_edge_clearance` 0.1, `min_board_edge_clearance`
// 0.2) and its comparison slack (`EPSILON` 0.005). `PREVIEW_CLEARANCE_BIAS_MM`
// is deliberately larger than that slack: a route that hugs an inflated outline
// is then provably NOT a violation, so the preview can never draw copper the
// checker will reject a second later.

export const DRC_TRACE_TO_PAD_MM = 0.1;
export const DRC_TRACE_TO_TRACE_MM = 0.1;
export const DRC_BOARD_EDGE_MM = 0.2;
export const DRC_EPSILON_MM = 0.005;
export const PREVIEW_CLEARANCE_BIAS_MM = 0.01;

export interface BoardClearances {
  traceToPadMm: number;
  traceToTraceMm: number;
  boardEdgeMm: number;
}

export const DEFAULT_BOARD_CLEARANCES: BoardClearances = {
  traceToPadMm: DRC_TRACE_TO_PAD_MM,
  traceToTraceMm: DRC_TRACE_TO_TRACE_MM,
  boardEdgeMm: DRC_BOARD_EDGE_MM,
};

export function padInflationMm(
  traceWidthMm: number,
  c: BoardClearances = DEFAULT_BOARD_CLEARANCES
): number {
  return traceWidthMm / 2 + c.traceToPadMm + PREVIEW_CLEARANCE_BIAS_MM;
}

export function traceInflationMm(
  traceWidthMm: number,
  otherWidthMm: number,
  c: BoardClearances = DEFAULT_BOARD_CLEARANCES
): number {
  return (
    traceWidthMm / 2 +
    otherWidthMm / 2 +
    c.traceToTraceMm +
    PREVIEW_CLEARANCE_BIAS_MM
  );
}

export function viaInflationMm(
  traceWidthMm: number,
  viaOuterMm: number,
  c: BoardClearances = DEFAULT_BOARD_CLEARANCES
): number {
  return (
    traceWidthMm / 2 + viaOuterMm / 2 + c.traceToTraceMm + PREVIEW_CLEARANCE_BIAS_MM
  );
}

export function boardKeepInInsetMm(
  traceWidthMm: number,
  c: BoardClearances = DEFAULT_BOARD_CLEARANCES
): number {
  return traceWidthMm / 2 + c.boardEdgeMm + PREVIEW_CLEARANCE_BIAS_MM;
}

// The halo is a statement about the RULE, so it omits the preview bias — a user
// measuring the shaded band against the fab's spec sheet must see the spec.
export function clearanceHaloWidthMm(
  traceWidthMm: number,
  c: BoardClearances = DEFAULT_BOARD_CLEARANCES
): number {
  return traceWidthMm + 2 * c.traceToPadMm;
}

