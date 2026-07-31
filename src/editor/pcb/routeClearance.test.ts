import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOARD_CLEARANCES,
  DRC_BOARD_EDGE_MM,
  DRC_EPSILON_MM,
  DRC_TRACE_TO_PAD_MM,
  DRC_TRACE_TO_TRACE_MM,
  PREVIEW_CLEARANCE_BIAS_MM,
  boardKeepInInsetMm,
  clearanceHaloWidthMm,
  padInflationMm,
  traceInflationMm,
  viaInflationMm,
} from "./routeClearance";

const WIDTHS = [0.15, 0.25, 0.6, 1.0];

describe("clearance formulas", () => {
  it("every inflation carries half the trace width, because paths are centrelines", () => {
    for (const w of WIDTHS) {
      expect(padInflationMm(w)).toBeCloseTo(
        w / 2 + DRC_TRACE_TO_PAD_MM + PREVIEW_CLEARANCE_BIAS_MM,
        12
      );
      expect(traceInflationMm(w, 0.3)).toBeCloseTo(
        w / 2 + 0.15 + DRC_TRACE_TO_TRACE_MM + PREVIEW_CLEARANCE_BIAS_MM,
        12
      );
      expect(viaInflationMm(w, 0.6)).toBeCloseTo(
        w / 2 + 0.3 + DRC_TRACE_TO_TRACE_MM + PREVIEW_CLEARANCE_BIAS_MM,
        12
      );
      expect(boardKeepInInsetMm(w)).toBeCloseTo(
        w / 2 + DRC_BOARD_EDGE_MM + PREVIEW_CLEARANCE_BIAS_MM,
        12
      );
    }
  });

  it("hugging an inflated pad is provably NOT a DRC violation", () => {
    // The checker compares `gap + EPSILON` against the rule, so clearing the
    // rule by more than EPSILON is what makes a hug safe rather than borderline.
    for (const w of WIDTHS) {
      expect(padInflationMm(w) - w / 2).toBeGreaterThan(
        DRC_TRACE_TO_PAD_MM + DRC_EPSILON_MM
      );
    }
  });

  it("the halo reports the RULE, not the preview bias", () => {
    for (const w of WIDTHS) {
      expect(clearanceHaloWidthMm(w)).toBeCloseTo(w + 2 * DRC_TRACE_TO_PAD_MM, 12);
    }
  });

  it("per-board overrides flow through every formula", () => {
    const tight = { traceToPadMm: 0.2, traceToTraceMm: 0.25, boardEdgeMm: 0.5 };
    expect(padInflationMm(0.25, tight)).toBeCloseTo(0.125 + 0.2 + 0.01, 12);
    expect(traceInflationMm(0.25, 0.25, tight)).toBeCloseTo(
      0.125 + 0.125 + 0.25 + 0.01,
      12
    );
    expect(viaInflationMm(0.25, 0.6, tight)).toBeCloseTo(
      0.125 + 0.3 + 0.25 + 0.01,
      12
    );
    expect(boardKeepInInsetMm(0.25, tight)).toBeCloseTo(0.125 + 0.5 + 0.01, 12);
    expect(clearanceHaloWidthMm(0.25, tight)).toBeCloseTo(0.25 + 0.4, 12);
  });

  it("the defaults are the JLC minimums @tscircuit/checks ships", () => {
    expect(DEFAULT_BOARD_CLEARANCES).toEqual({
      traceToPadMm: 0.1,
      traceToTraceMm: 0.1,
      boardEdgeMm: 0.2,
    });
    expect(PREVIEW_CLEARANCE_BIAS_MM).toBeGreaterThan(DRC_EPSILON_MM);
  });
});
