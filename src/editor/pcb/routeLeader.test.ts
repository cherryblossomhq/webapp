import { describe, expect, it } from "vitest";
import {
  CORNER_RADIUS_DEFAULT_MUL,
  FILLET_MAX_STEP_DEG,
  FILLET_MIN_INTERIOR_PTS,
  FILLET_TANGENT_MAX_FRAC,
  LEADER_EPS_MM,
  autoPosture,
  defaultCornerRadiusMm,
  leaderCost,
  leaderLengthMm,
  leaderPath,
  polylineLengthMm,
  swapPosture,
  tessellateLeader,
  type Leader,
} from "./routeLeader";
import type { PcbRoutingMode, RoutePosture } from "@/editor/shared/types";

const A = { x: 0, y: 0 };
const MODES: PcbRoutingMode[] = ["ortho", "diag45", "curved", "free"];
const POSTURES: RoutePosture[] = ["hv-first", "diag-first"];

// Eight octants, all off-axis and off-diagonal so every case really needs a
// two-segment leader. Coordinates are exact 0.1mm multiples, matching what the
// snapper feeds the leader at runtime.
const OCTANTS = [
  { x: 4, y: 1 },
  { x: 1, y: 4 },
  { x: -1, y: 4 },
  { x: -4, y: 1 },
  { x: -4, y: -1 },
  { x: -1, y: -4 },
  { x: 1, y: -4 },
  { x: 4, y: -1 },
];

const ANGLE_TOL = 1e-9;

/** Straight segments only — an arc vertex is reached by an arc, not a segment. */
function straightSegments(
  a: { x: number; y: number },
  leader: Leader
): Array<{ dx: number; dy: number }> {
  const out: Array<{ dx: number; dy: number }> = [];
  let px = a.x;
  let py = a.y;
  for (const p of leader.points) {
    if (!p.arc) out.push({ dx: p.x - px, dy: p.y - py });
    px = p.x;
    py = p.y;
  }
  return out;
}

function isAxisOr45(dx: number, dy: number): boolean {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < ANGLE_TOL || ady < ANGLE_TOL) return true;
  return Math.abs(adx - ady) <= ANGLE_TOL * Math.max(1, adx);
}

describe("leaderPath — the ±45° invariant", () => {
  for (const mode of MODES) {
    for (const posture of POSTURES) {
      for (const c of OCTANTS) {
        it(`${mode}/${posture} → (${c.x}, ${c.y}) is legal, exact and short`, () => {
          const leader = leaderPath(A, c, mode, posture, 0.4);
          expect(leader.points.length).toBeGreaterThan(0);

          // (a) every straight segment is H, V or exactly ±45°.
          if (mode !== "free") {
            for (const s of straightSegments(A, leader)) {
              expect(isAxisOr45(s.dx, s.dy)).toBe(true);
            }
          }

          // (b) the final point is bit-identical to the cursor.
          const last = leader.points[leader.points.length - 1];
          expect(last.x).toBe(c.x);
          expect(last.y).toBe(c.y);

          // (c) never more than 2 segments — 3 vertices in `curved`.
          expect(leader.points.length).toBeLessThanOrEqual(
            mode === "curved" ? 3 : 2
          );
        });
      }
    }
  }

  it("free mode is always a single direct vertex", () => {
    for (const c of OCTANTS) {
      const leader = leaderPath(A, c, "free", "hv-first");
      expect(leader.points).toEqual([{ x: c.x, y: c.y }]);
      expect(leader.kneeIndex).toBe(-1);
    }
  });

  it("an exact-45° cursor collapses both postures to one segment", () => {
    for (const posture of POSTURES) {
      const leader = leaderPath(A, { x: 3, y: 3 }, "diag45", posture);
      expect(leader.points).toEqual([{ x: 3, y: 3 }]);
      expect(leader.kneeIndex).toBe(-1);
    }
  });
});

describe("leaderPath — degenerate cases", () => {
  it("a coincident cursor produces no geometry at all", () => {
    for (const mode of MODES) {
      expect(leaderPath(A, { x: 0, y: 0 }, mode, "hv-first")).toEqual({
        points: [],
        kneeIndex: -1,
      });
    }
  });

  it("a horizontal cursor produces one horizontal segment", () => {
    for (const mode of MODES) {
      const leader = leaderPath(A, { x: 5, y: 0 }, mode, "diag-first");
      expect(leader.points).toEqual([{ x: 5, y: 0 }]);
      expect(leader.kneeIndex).toBe(-1);
    }
  });

  it("a vertical cursor produces one vertical segment", () => {
    for (const mode of MODES) {
      const leader = leaderPath(A, { x: 0, y: -5 }, mode, "hv-first");
      expect(leader.points).toEqual([{ x: 0, y: -5 }]);
      expect(leader.kneeIndex).toBe(-1);
    }
  });

  it("a sub-epsilon residual is snapped onto the axis, never left near-45°", () => {
    const c = { x: 5, y: LEADER_EPS_MM / 2 };
    const leader = leaderPath(A, c, "diag45", "hv-first");
    expect(leader.points).toEqual([{ x: 5, y: 0 }]);
  });

  it("keeps a hundredth-of-a-mm leg rather than emitting a 44.86° segment", () => {
    // The everyday case, not a corner case: the anchor is a pad centre (a 0402
    // pad sits at ±0.51 mm) and the cursor is on the 0.1 mm grid, so the two legs
    // differ by 0.01 mm. Collapsing that leg would emit ONE segment at 44.86°,
    // which is neither axis-aligned nor 45° — an off-grid anchor must not be able
    // to break the mode's own invariant.
    const anchor = { x: -15.51, y: -15 };
    for (const posture of POSTURES) {
      const leader = leaderPath(anchor, { x: -13.4, y: -12.9 }, "diag45", posture);
      expect(leader.points).toHaveLength(2);
      expect(leader.kneeIndex).toBe(0);
      let px = anchor.x;
      let py = anchor.y;
      for (const p of leader.points) {
        const dx = Math.abs(p.x - px);
        const dy = Math.abs(p.y - py);
        const legal = dx < 1e-9 || dy < 1e-9 || Math.abs(dx - dy) < 1e-9;
        expect(legal, `segment ${dx},${dy} is neither axial nor 45°`).toBe(true);
        px = p.x;
        py = p.y;
      }
      expect(leader.points[1]).toEqual({ x: -13.4, y: -12.9 });
    }
  });
});

describe("leaderPath — posture", () => {
  it("the two postures put the knee on opposite sides of the A–C midpoint", () => {
    for (const c of OCTANTS) {
      const hv = leaderPath(A, c, "diag45", "hv-first");
      const diag = leaderPath(A, c, "diag45", "diag-first");
      expect(hv.kneeIndex).toBe(0);
      expect(diag.kneeIndex).toBe(0);
      const k1 = hv.points[0];
      const k2 = diag.points[0];
      expect(k1).not.toEqual(k2);
      // Reflecting one knee through the A–C midpoint lands on the other.
      expect(A.x + c.x - k1.x).toBeCloseTo(k2.x, 9);
      expect(A.y + c.y - k1.y).toBeCloseTo(k2.y, 9);
    }
  });

  it("ortho hv-first runs horizontally out of the anchor, diag-first vertically", () => {
    expect(leaderPath(A, { x: 4, y: 1 }, "ortho", "hv-first").points[0]).toEqual({
      x: 4,
      y: 0,
    });
    expect(
      leaderPath(A, { x: 4, y: 1 }, "ortho", "diag-first").points[0]
    ).toEqual({ x: 0, y: 1 });
  });

  it("swapPosture is an involution", () => {
    expect(swapPosture(swapPosture("hv-first"))).toBe("hv-first");
    expect(swapPosture("hv-first")).toBe("diag-first");
  });
});

describe("leaderPath — curved", () => {
  const c = { x: 10, y: 4 };

  it("t = 0 degrades exactly to diag45", () => {
    expect(leaderPath(A, c, "curved", "hv-first", 0)).toEqual(
      leaderPath(A, c, "diag45", "hv-first")
    );
  });

  it("clamps the tangent to 45% of the shorter leg", () => {
    const plain = leaderPath(A, c, "diag45", "hv-first");
    const k = plain.points[0];
    const legA = Math.hypot(k.x - A.x, k.y - A.y);
    const legC = Math.hypot(c.x - k.x, c.y - k.y);
    const shorter = Math.min(legA, legC);
    const leader = leaderPath(A, c, "curved", "hv-first", 999);
    const t1 = leader.points[0];
    const t = Math.hypot(k.x - t1.x, k.y - t1.y);
    expect(t).toBeLessThanOrEqual(FILLET_TANGENT_MAX_FRAC * shorter + 1e-9);
    expect(t).toBeCloseTo(FILLET_TANGENT_MAX_FRAC * shorter, 9);
  });

  it("tessellates the arc at ≤5° per step with ≥3 interior points", () => {
    const leader = leaderPath(A, c, "curved", "hv-first", 0.5);
    const pts = tessellateLeader(A, leader);
    const t1 = leader.points[0];
    const t2 = leader.points[1];
    expect(pts[0]).toEqual({ x: t1.x, y: t1.y });
    const t2Index = pts.length - 2;
    expect(pts[t2Index].x).toBeCloseTo(t2.x, 9);
    expect(pts[t2Index].y).toBeCloseTo(t2.y, 9);
    expect(pts[pts.length - 1]).toEqual({ x: c.x, y: c.y });
    const interior = t2Index - 1;
    expect(interior).toBeGreaterThanOrEqual(FILLET_MIN_INTERIOR_PTS);

    // Every tessellated step turns by no more than FILLET_MAX_STEP_DEG.
    const r = t2.arc!.rMm;
    const arcSpan = pts.slice(0, t2Index + 1);
    for (let i = 1; i < arcSpan.length; i++) {
      const chord = Math.hypot(
        arcSpan[i].x - arcSpan[i - 1].x,
        arcSpan[i].y - arcSpan[i - 1].y
      );
      const stepDeg =
        (2 * Math.asin(Math.min(1, chord / (2 * r))) * 180) / Math.PI;
      expect(stepDeg).toBeLessThanOrEqual(FILLET_MAX_STEP_DEG + 1e-6);
    }
  });

  it("the tessellated arc stays on the fillet circle", () => {
    const leader = leaderPath(A, c, "curved", "diag-first", 0.5);
    const pts = tessellateLeader(A, leader);
    const t2 = leader.points[1];
    const r = t2.arc!.rMm;
    // Reconstruct the centre from the first and last arc points, then check the
    // interior ones sit on the same circle.
    const t2Index = pts.length - 2;
    const arcPts = pts.slice(0, t2Index + 1);
    const centre = circleCentre(arcPts[0], arcPts[arcPts.length - 1], r);
    for (const p of arcPts) {
      expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(r, 6);
    }
  });

  it("the default radius tracks the trace width", () => {
    expect(defaultCornerRadiusMm(0.25)).toBeCloseTo(
      CORNER_RADIUS_DEFAULT_MUL * 0.25,
      9
    );
  });
});

function circleCentre(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: number
): { x: number; y: number } {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const nx = -(b.y - a.y) / chord;
  const ny = (b.x - a.x) / chord;
  // Two candidates; pick the one the arc actually bulges away from.
  const c1 = { x: mx + h * nx, y: my + h * ny };
  const c2 = { x: mx - h * nx, y: my - h * ny };
  return Math.abs(Math.hypot(a.x - c1.x, a.y - c1.y) - r) <
    Math.abs(Math.hypot(a.x - c2.x, a.y - c2.y) - r)
    ? c1
    : c2;
}

describe("length helpers", () => {
  it("leaderCost sums chords; leaderLengthMm measures the arc", () => {
    const c = { x: 10, y: 4 };
    const straight = leaderPath(A, c, "diag45", "hv-first");
    expect(leaderCost(A, straight)).toBeCloseTo(
      leaderLengthMm(A, straight),
      9
    );
    const curved = leaderPath(A, c, "curved", "hv-first", 0.5);
    expect(leaderLengthMm(A, curved)).toBeGreaterThan(leaderCost(A, curved));
  });

  it("polylineLengthMm sums a plain polyline", () => {
    expect(
      polylineLengthMm([
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 4 },
      ])
    ).toBeCloseTo(7, 9);
  });
});

describe("autoPosture", () => {
  it("leaves a long pad along its long edge", () => {
    expect(
      autoPosture({
        pointCount: 1,
        startPadBox: { width: 1.2, height: 0.6 },
        travelX: 0,
        travelY: 1,
      })
    ).toBe("hv-first");
    expect(
      autoPosture({
        pointCount: 1,
        startPadBox: { width: 0.6, height: 1.2 },
        travelX: 1,
        travelY: 0,
      })
    ).toBe("diag-first");
  });

  it("ignores a near-square pad and falls through to the travel rule", () => {
    expect(
      autoPosture({
        pointCount: 1,
        startPadBox: { width: 1, height: 0.95 },
        travelX: 1,
        travelY: 1,
      })
    ).toBe("diag-first");
  });

  it("only applies the pad rule on the first leg", () => {
    expect(
      autoPosture({
        pointCount: 2,
        startPadBox: { width: 0.6, height: 1.2 },
        travelX: 1,
        travelY: 1,
      })
    ).toBe("diag-first");
  });

  it("follows cursor travel at ratios 3.0 / 1.0 / 0.2", () => {
    const at = (travelX: number, travelY: number) =>
      autoPosture({ pointCount: 3, startPadBox: null, travelX, travelY });
    expect(at(3, 1)).toBe("hv-first");
    expect(at(1, 1)).toBe("diag-first");
    expect(at(0.2, 1)).toBe("hv-first");
  });

  it("ties break to hv-first", () => {
    expect(
      autoPosture({ pointCount: 3, startPadBox: null, travelX: 0, travelY: 0 })
    ).toBe("hv-first");
  });
});
