// routeLeader — the O(1) rubber band.
//
// This is tier 1 of the two-tier preview: pure math from the anchor `A` to the
// snapped cursor `C`, evaluated once per animation frame, with no obstacle
// awareness, no allocation beyond the two-or-three vertices it returns, and no
// failure mode. It is what guarantees the band is on screen every single frame;
// the walkaround solver in routeSolver.ts can only ever *upgrade* it.
//
// The shape is the interactive-routing gesture every professional EDA tool
// ships: not one vector snapped to the nearest 45°, but a TWO-SEGMENT leader —
// an axis-aligned run plus a 45° chamfer — whose order the user swaps with
// Space. Both `A` and `C` sit on the 0.1 mm grid, so every quantity below is an
// exact multiple of 0.1 mm and no epsilon fuzz can accumulate into a segment
// that is almost-but-not-quite 45°.

import type { Point } from "@/editor/shared/snap";
import type { PcbRoutingMode, RoutePosture } from "@/editor/shared/types";

export type { RoutePosture };

// GRID_FINE_MM / 4 — a quarter of the smallest move the cursor can make, so a
// leg is dropped only when it is genuinely degenerate.
export const LEADER_EPS_MM = 0.025;

export const POSTURE_AXIS_RATIO_HI = 2.5;
export const POSTURE_AXIS_RATIO_LO = 0.4;
export const POSTURE_TRAVEL_SAMPLES = 4;
export const PAD_ASPECT_THRESHOLD = 1.2;
export const CORNER_RADIUS_DEFAULT_MUL = 1.5;
export const CORNER_RADIUS_STEP_MM = 0.05;
export const CORNER_RADIUS_MAX_MM = 5;
export const FILLET_TANGENT_MAX_FRAC = 0.45;
export const FILLET_MAX_STEP_DEG = 5;
export const FILLET_MIN_INTERIOR_PTS = 3;

export interface LeaderVertex {
  x: number;
  y: number;
  /** Present when this vertex is reached by a circular arc, not a straight run. */
  arc?: { rMm: number; sweep: 0 | 1 };
}

export interface Leader {
  points: LeaderVertex[];
  /** Index of the corner vertex in `points`, or -1 when the leader is one segment. */
  kneeIndex: number;
}

/** `leaderShape` verdicts. */
export const LEADER_NONE = 0;
/** One segment: `out` carries the effective endpoint (C, axis-corrected). */
export const LEADER_DIRECT = 1;
/** Two segments: `out` carries the knee; the endpoint is C unchanged. */
export const LEADER_KNEE = 2;

/**
 * The allocation-free core. The solver evaluates tens of thousands of candidate
 * connections inside a 4 ms budget, so it cannot afford `leaderPath`'s object
 * per vertex — it calls this and reads `out` instead. `leaderPath` is the thin
 * allocating wrapper, so there is exactly one implementation of the geometry.
 *
 * `eps` is the residual below which a leg counts as axis-aligned, and the axis
 * cases MOVE THE ENDPOINT to make that true. That is right for the interactive
 * leader, whose endpoint is the cursor: nudging where the band lands by a
 * hundredth of a millimetre is invisible and it keeps the ±45° invariant exact.
 * It is wrong for the solver, whose endpoint is a fixed graph node it may not
 * move — so `routeSolver` passes 0 and gets the honest two-segment leader (a
 * long axis run plus a very short 45° stub) instead of a near-axis cheat.
 */
export function leaderShape(
  ax: number,
  ay: number,
  cx: number,
  cy: number,
  mode: PcbRoutingMode,
  posture: RoutePosture,
  out: Point,
  eps: number = LEADER_EPS_MM
): number {
  const dx = cx - ax;
  const dy = cy - ay;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // Degenerate cases first, in every mode. At the default eps the two axis cases
  // snap the endpoint onto the exact axis so a sub-epsilon residual can never
  // make a "horizontal" segment fail the ±45° invariant downstream; at eps = 0
  // they fire only on exact equality and so move nothing.
  if (adx <= eps && ady <= eps) return LEADER_NONE;
  if (ady <= eps) {
    out.x = cx;
    out.y = ay;
    return LEADER_DIRECT;
  }
  if (adx <= eps) {
    out.x = ax;
    out.y = cy;
    return LEADER_DIRECT;
  }
  if (mode === "free") {
    out.x = cx;
    out.y = cy;
    return LEADER_DIRECT;
  }

  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;

  if (mode === "ortho") {
    if (posture === "hv-first") {
      out.x = cx;
      out.y = ay;
    } else {
      out.x = ax;
      out.y = cy;
    }
    return LEADER_KNEE;
  }

  // Collapse to a single segment ONLY when the two legs are exactly equal — the
  // cursor is exactly on the 45° diagonal, so the one segment really is 45°.
  //
  // An epsilon collapse here would be a bug, not a tidy-up. The anchor is often a
  // pad centre (a 0402 pad sits at ±0.51 mm) while the cursor is on the 0.1 mm
  // grid, so |adx - ady| is routinely a few hundredths: dropping that leg emits a
  // single 44.86° segment on the very first leg out of every pad. A 0.01 mm axis
  // stub is the honest geometry, and it is what a reference tool draws too.
  if (adx === ady) {
    out.x = cx;
    out.y = cy;
    return LEADER_DIRECT;
  }
  if (posture === "hv-first") {
    // Axis run out of the anchor on the dominant axis, 45° chamfer into C.
    if (adx > ady) {
      out.x = ax + sx * (adx - ady);
      out.y = ay;
    } else {
      out.x = ax;
      out.y = ay + sy * (ady - adx);
    }
  } else {
    const d = Math.min(adx, ady);
    out.x = ax + sx * d;
    out.y = ay + sy * d;
  }
  return LEADER_KNEE;
}

const kneeScratch: Point = { x: 0, y: 0 };

export function leaderPath(
  a: Point,
  c: Point,
  mode: PcbRoutingMode,
  posture: RoutePosture,
  cornerRadiusMm = 0
): Leader {
  const verdict = leaderShape(a.x, a.y, c.x, c.y, mode, posture, kneeScratch);
  if (verdict === LEADER_NONE) return { points: [], kneeIndex: -1 };
  if (verdict === LEADER_DIRECT) {
    return {
      points: [{ x: kneeScratch.x, y: kneeScratch.y }],
      kneeIndex: -1,
    };
  }
  const knee: Point = { x: kneeScratch.x, y: kneeScratch.y };
  if (mode === "curved") return filletedLeader(a, c, knee, cornerRadiusMm);
  return { points: [knee, { x: c.x, y: c.y }], kneeIndex: 0 };
}

// Replace the corner with a circular fillet tangent to both legs. The clamp is
// on the TANGENT distance rather than the radius: that makes the user-facing
// `cornerRadiusMm` step directly meaningful and makes t = 0 degrade exactly to
// diag45 instead of to a degenerate arc.
function filletedLeader(
  a: Point,
  c: Point,
  k: Point,
  cornerRadiusMm: number
): Leader {
  const ax = a.x - k.x;
  const ay = a.y - k.y;
  const cx = c.x - k.x;
  const cy = c.y - k.y;
  const la = Math.hypot(ax, ay);
  const lc = Math.hypot(cx, cy);
  const t = Math.min(
    Math.max(cornerRadiusMm, 0),
    FILLET_TANGENT_MAX_FRAC * la,
    FILLET_TANGENT_MAX_FRAC * lc
  );
  if (!(t > 0)) {
    return { points: [k, { x: c.x, y: c.y }], kneeIndex: 0 };
  }
  const uax = ax / la;
  const uay = ay / la;
  const ucx = cx / lc;
  const ucy = cy / lc;
  // Interior angle at K between K→A and K→C.
  const cosTheta = Math.max(-1, Math.min(1, uax * ucx + uay * ucy));
  const theta = Math.acos(cosTheta);
  const r = t * Math.tan(theta / 2);
  const cross = uax * ucy - uay * ucx;
  return {
    points: [
      { x: k.x + t * uax, y: k.y + t * uay },
      {
        x: k.x + t * ucx,
        y: k.y + t * ucy,
        arc: { rMm: r, sweep: cross < 0 ? 1 : 0 },
      },
      { x: c.x, y: c.y },
    ],
    kneeIndex: 0,
  };
}

/** Σ chord length from `a` through the leader. Arc chords count as straight. */
export function leaderCost(a: Point, leader: Leader): number {
  let total = 0;
  let px = a.x;
  let py = a.y;
  for (const p of leader.points) {
    total += Math.hypot(p.x - px, p.y - py);
    px = p.x;
    py = p.y;
  }
  return total;
}

/** True copper length — the readout the status bar shows, so arcs measure as arcs. */
export function leaderLengthMm(a: Point, leader: Leader): number {
  let total = 0;
  let px = a.x;
  let py = a.y;
  for (const p of leader.points) {
    const chord = Math.hypot(p.x - px, p.y - py);
    if (p.arc && p.arc.rMm > 0 && chord > 0) {
      const ratio = Math.min(1, chord / (2 * p.arc.rMm));
      total += 2 * p.arc.rMm * Math.asin(ratio);
    } else {
      total += chord;
    }
    px = p.x;
    py = p.y;
  }
  return total;
}

// Flatten arcs so the result can be committed. The sidecar's PcbRoutePoint[]
// has no arc primitive and both circuitJsonMerge and drc consume polylines;
// inventing one is explicitly out of scope, so the fillet is tessellated at
// commit time exactly as it was drawn.
export function tessellateLeader(a: Point, leader: Leader): Point[] {
  const out: Point[] = [];
  let px = a.x;
  let py = a.y;
  for (const p of leader.points) {
    if (p.arc && p.arc.rMm > 0) {
      appendArcPoints(out, px, py, p, p.arc.rMm, p.arc.sweep);
    }
    out.push({ x: p.x, y: p.y });
    px = p.x;
    py = p.y;
  }
  return out;
}

function appendArcPoints(
  out: Point[],
  x0: number,
  y0: number,
  end: Point,
  r: number,
  sweep: 0 | 1
): void {
  const chord = Math.hypot(end.x - x0, end.y - y0);
  if (chord < 1e-12) return;
  const half = Math.min(1, chord / (2 * r));
  const sweepAngle = 2 * Math.asin(half);
  // Centre sits perpendicular to the chord, on the side the sweep flag names;
  // with `n` the +90° rotation of the chord direction, offsetting by +h puts the
  // traversal counter-clockwise, so the same sign drives both.
  const mx = (x0 + end.x) / 2;
  const my = (y0 + end.y) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  const nx = -(end.y - y0) / chord;
  const ny = (end.x - x0) / chord;
  const sign = sweep === 1 ? 1 : -1;
  const ccx = mx + sign * h * nx;
  const ccy = my + sign * h * ny;
  const a0 = Math.atan2(y0 - ccy, x0 - ccx);
  const delta = sign * sweepAngle;
  const steps = Math.max(
    FILLET_MIN_INTERIOR_PTS + 1,
    Math.ceil(Math.abs((delta * 180) / Math.PI) / FILLET_MAX_STEP_DEG)
  );
  for (let i = 1; i < steps; i++) {
    const ang = a0 + (delta * i) / steps;
    out.push({ x: ccx + r * Math.cos(ang), y: ccy + r * Math.sin(ang) });
  }
}

export function polylineLengthMm(pts: ReadonlyArray<Point>): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

export interface AutoPostureInput {
  /** Number of committed vertices — the pad rule only applies on the first leg. */
  pointCount: number;
  /** World-space AABB of the pad the draft started on, when it started on one. */
  startPadBox: { width: number; height: number } | null;
  /** Summed cursor delta over the last POSTURE_TRAVEL_SAMPLES flushes. */
  travelX: number;
  travelY: number;
}

/**
 * Guess which leg should leave the anchor first. Two rules, in order: leave a
 * long pad along its long edge (that is where the copper has room), otherwise
 * follow how the user is actually moving the mouse. A locked posture never
 * reaches this function.
 */
export function autoPosture(input: AutoPostureInput): RoutePosture {
  const box = input.startPadBox;
  if (input.pointCount === 1 && box) {
    const w = Math.abs(box.width);
    const h = Math.abs(box.height);
    const lo = Math.min(w, h);
    if (lo > 0 && Math.max(w, h) / lo >= PAD_ASPECT_THRESHOLD) {
      return w > h ? "hv-first" : "diag-first";
    }
  }
  const tx = Math.abs(input.travelX);
  const ty = Math.abs(input.travelY);
  if (tx < 1e-9 && ty < 1e-9) return "hv-first";
  const ratio = tx / Math.max(ty, 1e-9);
  if (ratio > POSTURE_AXIS_RATIO_HI || ratio < POSTURE_AXIS_RATIO_LO) {
    return "hv-first";
  }
  return "diag-first";
}

export function swapPosture(p: RoutePosture): RoutePosture {
  return p === "hv-first" ? "diag-first" : "hv-first";
}

export function defaultCornerRadiusMm(traceWidthMm: number): number {
  return CORNER_RADIUS_DEFAULT_MUL * traceWidthMm;
}
