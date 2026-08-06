// routeGraph — the obstacle model the walkaround solver searches over.
//
// Two jobs, both allocation-free at query time because they run inside the
// frame budget:
//
//   1. Turn the live PcbModel into a per-layer set of inflated axis-aligned
//      rectangles. Copper (pads, trace segments, vias) is HARD — a wall.
//      Component courtyards are SOFT — a per-mm cost penalty, because routing
//      under a QFN body is legal and routine, and a hard courtyard would make
//      the router refuse boards a human would ship.
//   2. Answer "does this segment hit copper" and "how far does it run under a
//      body" without a linear scan, via a CSR-style uniform grid over typed
//      arrays. No Map, no per-query allocation, and an obstacle spanning many
//      cells is tested once thanks to a generation-stamped visited array.
//
// Hard obstacles are sorted canonically by (minX, minY, maxX, maxY). The
// solver's node indices derive from that rank, which is what makes the A*
// reproducible across evals instead of dependent on `model.pads` array order —
// and reproducibility is what stops the preview flickering between two equally
// valid paths.

import { canonEndpoint } from "@/editor/shared/connectionId";
import type { Point } from "@/editor/shared/snap";
import type { LayerId, StableKey } from "@/editor/shared/types";
import { copperLayersForCount } from "./layers";
import {
  DEFAULT_BOARD_CLEARANCES,
  boardKeepInInsetMm,
  padInflationMm,
  traceInflationMm,
  viaInflationMm,
  type BoardClearances,
} from "./routeClearance";
import { padWorldCorners, type PcbModel } from "./pcbModel";

export const GRID_CELL_MM = 2;
export const CORRIDOR_PAD_MM = 3;
export const OCTAGON_CHAMFER_FRACTION = 0.25;
export const MAX_NODES = 256;

// Touching counts as CLEAR: the inflation already carries
// PREVIEW_CLEARANCE_BIAS_MM, so a path that grazes an inflated outline is
// exactly the hug we want, not a collision. Shrinking the box by this much
// before the slab test is how that is expressed without special-casing
// axis-parallel segments.
const TOUCH_EPS_MM = 1e-9;

export interface RouteRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  layers: readonly LayerId[];
  soft: boolean;
}

export interface RouteKeepIn {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** CSR uniform grid over one rect list, cell pitch `GRID_CELL_MM`. */
export interface CellGrid {
  minX: number;
  minY: number;
  cellsX: number;
  cellsY: number;
  start: Uint32Array;
  items: Uint32Array;
  // Generation-stamped visited set, so a rect straddling many cells is tested
  // once per query without clearing an array.
  stamp: Int32Array;
  gen: number;
}

export interface RouteObstacleSet {
  hard: RouteRect[];
  soft: RouteRect[];
  keepIn: RouteKeepIn | null;
  layer: LayerId;
  hardGrid: CellGrid;
  // Courtyards get their own index. `softPenetrationMm` runs on the solver's
  // inner edge loop, twice per candidate edge, and a linear scan over 50
  // component bodies there was the single biggest reason a dense board's solve
  // hit its deadline instead of finding the way around.
  softGrid: CellGrid;
}

export interface BuildObstaclesOpts {
  model: PcbModel;
  layer: LayerId;
  layerCount: number;
  traceWidthMm: number;
  /** Pads on the routed net — the path has to be able to terminate on them. */
  excludeSelectors: ReadonlySet<string>;
  /** The trace being re-routed; its own copper is not an obstacle. */
  excludeTraceKey: StableKey | null;
  clearances: BoardClearances;
}

// ─── Construction ─────────────────────────────────────────────────────────────

export function buildRouteObstacles(
  opts: BuildObstaclesOpts
): RouteObstacleSet {
  const {
    model,
    layer,
    layerCount,
    traceWidthMm,
    excludeSelectors,
    excludeTraceKey,
  } = opts;
  const clearances = opts.clearances ?? DEFAULT_BOARD_CLEARANCES;
  const copper = copperLayersForCount(layerCount).map((l) => l.id);
  const hard: RouteRect[] = [];
  const soft: RouteRect[] = [];

  const padInflate = padInflationMm(traceWidthMm, clearances);
  for (const pad of model.pads) {
    const sel = model.selectorByPad.get(pad);
    if (sel && excludeSelectors.has(canonEndpoint(sel))) continue;
    const layers = pad.isThroughHole ? copper : [pad.layer];
    if (!layers.includes(layer)) continue;
    hard.push(inflatedBounds(padWorldCorners(pad), padInflate, layers, false));
  }

  for (const trace of model.traces) {
    if (excludeTraceKey && trace.key === excludeTraceKey) continue;
    // Copper already on the routed net is not in the way — it is the same node.
    // Skipping it matters most for a connection the autorouter already covered:
    // its autoroute is still on screen while the manual route is being drawn (it
    // only disappears once the sidecar entry lands), so treating it as a wall
    // would make the user dodge the very trace they are replacing.
    if (
      excludeSelectors.has(canonEndpoint(trace.fromSelector)) &&
      excludeSelectors.has(canonEndpoint(trace.toSelector))
    ) {
      continue;
    }
    for (const seg of trace.segments) {
      if (seg.layer !== layer) continue;
      const inflate = traceInflationMm(traceWidthMm, seg.width, clearances);
      hard.push(
        inflatedBounds(
          [
            { x: seg.fromX, y: seg.fromY },
            { x: seg.toX, y: seg.toY },
          ],
          inflate,
          [seg.layer],
          false
        )
      );
    }
  }

  for (const via of model.vias) {
    // Vias bridge every copper layer they pass through and were invisible to
    // the old grid solver, which is one reason previews used to cross them.
    const inflate = viaInflationMm(traceWidthMm, via.outerDiameter, clearances);
    hard.push(
      inflatedBounds([{ x: via.x, y: via.y }], inflate, copper, false)
    );
  }

  for (const comp of model.components) {
    if (comp.layer !== layer) continue;
    const display = comp.displayBbox;
    const w = display?.width ?? comp.width;
    const h = display?.height ?? comp.height;
    const rot = ((display?.rotationDeg ?? comp.rotationDeg) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rot));
    const sin = Math.abs(Math.sin(rot));
    const halfW = (w * cos + h * sin) / 2;
    const halfH = (w * sin + h * cos) / 2;
    soft.push({
      minX: comp.x - halfW,
      minY: comp.y - halfH,
      maxX: comp.x + halfW,
      maxY: comp.y + halfH,
      layers: [comp.layer],
      soft: true,
    });
  }

  let keepIn: RouteKeepIn | null = null;
  if (model.board) {
    const inset = boardKeepInInsetMm(traceWidthMm, clearances);
    keepIn = {
      minX: model.board.centerX - model.board.width / 2 + inset,
      minY: model.board.centerY - model.board.height / 2 + inset,
      maxX: model.board.centerX + model.board.width / 2 - inset,
      maxY: model.board.centerY + model.board.height / 2 - inset,
    };
  }

  return indexObstacles({ hard, soft, keepIn, layer });
}

function inflatedBounds(
  points: ReadonlyArray<Point>,
  margin: number,
  layers: readonly LayerId[],
  soft: boolean
): RouteRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) {
    minX = minY = maxX = maxY = 0;
  }
  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
    layers,
    soft,
  };
}

/**
 * Sort both rect lists canonically and index each. Split out from
 * `buildRouteObstacles` so the solver's tests can pose a rectangle field
 * directly without standing up a whole PcbModel.
 */
export function indexObstacles(input: {
  hard: RouteRect[];
  soft: RouteRect[];
  keepIn: RouteKeepIn | null;
  layer: LayerId;
}): RouteObstacleSet {
  const hard = input.hard.slice().sort(compareRects);
  const soft = input.soft.slice().sort(compareRects);
  return {
    hard,
    soft,
    keepIn: input.keepIn,
    layer: input.layer,
    hardGrid: buildGrid(hard),
    softGrid: buildGrid(soft),
  };
}

function buildGrid(rects: ReadonlyArray<RouteRect>): CellGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.minX < minX) minX = r.minX;
    if (r.minY < minY) minY = r.minY;
    if (r.maxX > maxX) maxX = r.maxX;
    if (r.maxY > maxY) maxY = r.maxY;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const cellsX = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL_MM) || 1);
  const cellsY = Math.max(1, Math.ceil((maxY - minY) / GRID_CELL_MM) || 1);
  const cellCount = cellsX * cellsY;

  // Two-pass CSR fill: count per cell, prefix-sum, then scatter.
  const counts = new Uint32Array(cellCount + 1);
  for (const r of rects) {
    const c0 = cellIndexX(r.minX, minX, cellsX);
    const c1 = cellIndexX(r.maxX, minX, cellsX);
    const r0 = cellIndexY(r.minY, minY, cellsY);
    const r1 = cellIndexY(r.maxY, minY, cellsY);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) counts[cy * cellsX + cx + 1]++;
    }
  }
  for (let i = 0; i < cellCount; i++) counts[i + 1] += counts[i];
  const start = counts;
  const items = new Uint32Array(start[cellCount]);
  const cursor = new Uint32Array(cellCount);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const c0 = cellIndexX(r.minX, minX, cellsX);
    const c1 = cellIndexX(r.maxX, minX, cellsX);
    const r0 = cellIndexY(r.minY, minY, cellsY);
    const r1 = cellIndexY(r.maxY, minY, cellsY);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const cell = cy * cellsX + cx;
        items[start[cell] + cursor[cell]++] = i;
      }
    }
  }

  return {
    minX,
    minY,
    cellsX,
    cellsY,
    start,
    items,
    stamp: new Int32Array(rects.length),
    gen: 0,
  };
}

function compareRects(a: RouteRect, b: RouteRect): number {
  if (a.minX !== b.minX) return a.minX - b.minX;
  if (a.minY !== b.minY) return a.minY - b.minY;
  if (a.maxX !== b.maxX) return a.maxX - b.maxX;
  return a.maxY - b.maxY;
}

function cellIndexX(v: number, minX: number, cellsX: number): number {
  const i = Math.floor((v - minX) / GRID_CELL_MM);
  return i < 0 ? 0 : i >= cellsX ? cellsX - 1 : i;
}

function cellIndexY(v: number, minY: number, cellsY: number): number {
  const i = Math.floor((v - minY) / GRID_CELL_MM);
  return i < 0 ? 0 : i >= cellsY ? cellsY - 1 : i;
}

// ─── Octagon vertices ─────────────────────────────────────────────────────────

/**
 * Write the eight hug candidates for `r` into `out` (which must already hold 8
 * mutable points — this runs inside the frame budget and must not allocate).
 *
 * The octagon, not the rectangle, is what makes the path hug at 45°: a plain
 * rect forces every visibility edge into a 90° corner, which is exactly the
 * lumpy staircase this rebuild exists to kill.
 */
export function octagonVertices(r: RouteRect, out: Point[]): void {
  const cx = (r.minX + r.maxX) / 2;
  const cy = (r.minY + r.maxY) / 2;
  const hw = (r.maxX - r.minX) / 2;
  const hh = (r.maxY - r.minY) / 2;
  const ch = Math.min(hw, hh) * OCTAGON_CHAMFER_FRACTION;
  out[0].x = cx + hw;
  out[0].y = cy + hh - ch;
  out[1].x = cx + hw - ch;
  out[1].y = cy + hh;
  out[2].x = cx - hw + ch;
  out[2].y = cy + hh;
  out[3].x = cx - hw;
  out[3].y = cy + hh - ch;
  out[4].x = cx - hw;
  out[4].y = cy - hh + ch;
  out[5].x = cx - hw + ch;
  out[5].y = cy - hh;
  out[6].x = cx + hw - ch;
  out[6].y = cy - hh;
  out[7].x = cx + hw;
  out[7].y = cy - hh + ch;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function segmentHitsHard(
  set: RouteObstacleSet,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  const grid = set.hardGrid;
  if (set.hard.length === 0) return false;
  if (!walkBegin(grid, ax, ay, bx, by)) return false;
  grid.gen++;
  const gen = grid.gen;
  const stamp = grid.stamp;
  const hard = set.hard;
  for (let cell = walkNext(); cell >= 0; cell = walkNext()) {
    const end = grid.start[cell + 1];
    for (let i = grid.start[cell]; i < end; i++) {
      const idx = grid.items[i];
      if (stamp[idx] === gen) continue;
      stamp[idx] = gen;
      const r = hard[idx];
      if (segmentHitsRect(ax, ay, bx, by, r.minX, r.minY, r.maxX, r.maxY)) {
        walkState.live = false;
        return true;
      }
    }
  }
  return false;
}

/** Total length of the segment that runs inside a soft (courtyard) rect. */
export function softPenetrationMm(
  set: RouteObstacleSet,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const grid = set.softGrid;
  if (set.soft.length === 0) return 0;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return 0;
  if (!walkBegin(grid, ax, ay, bx, by)) return 0;
  grid.gen++;
  const gen = grid.gen;
  const stamp = grid.stamp;
  let total = 0;
  const e = TOUCH_EPS_MM;
  for (let cell = walkNext(); cell >= 0; cell = walkNext()) {
    const end = grid.start[cell + 1];
    for (let i = grid.start[cell]; i < end; i++) {
      const idx = grid.items[i];
      if (stamp[idx] === gen) continue;
      stamp[idx] = gen;
      const r = set.soft[idx];
      // Same boundary rule as the hard test: a segment that grazes a courtyard
      // edge is running ALONGSIDE the body, not under it, and must cost nothing —
      // otherwise the cheapest way around a component still reads as going
      // through it.
      const span = clipSpan(
        ax,
        ay,
        dx,
        dy,
        r.minX + e,
        r.minY + e,
        r.maxX - e,
        r.maxY - e
      );
      if (span > 0) total += span * len;
    }
  }
  return total;
}

/** True when the segment leaves the board keep-in area. */
export function segmentLeavesKeepIn(
  set: RouteObstacleSet,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  const k = set.keepIn;
  if (!k) return false;
  const e = TOUCH_EPS_MM;
  return (
    ax < k.minX - e ||
    ax > k.maxX + e ||
    ay < k.minY - e ||
    ay > k.maxY + e ||
    bx < k.minX - e ||
    bx > k.maxX + e ||
    by < k.minY - e ||
    by > k.maxY + e
  );
}

// Liang–Barsky, returning the clipped parameter span in [0, 1]. Unrolled over
// the two axes rather than looped over a `[p]`/`[q]` pair: this runs on the
// solver's inner edge loop, and two 4-element arrays per call is hundreds of
// thousands of allocations per solve — enough GC pressure to cost a frame.
function clipSpan(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number {
  let t0 = 0;
  let t1 = 1;
  if (dx > -1e-12 && dx < 1e-12) {
    if (ax < minX || ax > maxX) return 0;
  } else {
    let ta = (minX - ax) / dx;
    let tb = (maxX - ax) / dx;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 >= t1) return 0;
  }
  if (dy > -1e-12 && dy < 1e-12) {
    if (ay < minY || ay > maxY) return 0;
  } else {
    let ta = (minY - ay) / dy;
    let tb = (maxY - ay) / dy;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 >= t1) return 0;
  }
  return t1 - t0;
}

export function segmentHitsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): boolean {
  const e = TOUCH_EPS_MM;
  const lx = minX + e;
  const hx = maxX - e;
  const ly = minY + e;
  const hy = maxY - e;
  if (lx > hx || ly > hy) return false;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dx) < 1e-12) {
    if (ax <= lx || ax >= hx) return false;
  } else {
    let ta = (lx - ax) / dx;
    let tb = (hx - ax) / dx;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  if (Math.abs(dy) < 1e-12) {
    if (ay <= ly || ay >= hy) return false;
  } else {
    let ta = (ly - ay) / dy;
    let tb = (hy - ay) / dy;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  return t0 < t1;
}

/**
 * True when the point is strictly inside any hard rect (drops dead nodes).
 * Grid-indexed rather than a linear scan: this runs 8× per corridor obstacle at
 * the top of every solve, so on a dense board the scan alone was O(n²).
 */
export function pointInsideHard(
  set: RouteObstacleSet,
  x: number,
  y: number,
  skipIndex: number
): boolean {
  const e = TOUCH_EPS_MM;
  const grid = set.hardGrid;
  // cellIndexX/Y clamp, which is harmless: the containment test below is exact,
  // so a point outside the grid can never match a rect inside it.
  const cell =
    cellIndexY(y, grid.minY, grid.cellsY) * grid.cellsX +
    cellIndexX(x, grid.minX, grid.cellsX);
  const end = grid.start[cell + 1];
  for (let i = grid.start[cell]; i < end; i++) {
    const idx = grid.items[i];
    if (idx === skipIndex) continue;
    const r = set.hard[idx];
    if (x > r.minX + e && x < r.maxX - e && y > r.minY + e && y < r.maxY - e) {
      return true;
    }
  }
  return false;
}

// ─── Grid traversal ───────────────────────────────────────────────────────────
// Amanatides–Woo DDA over the segment, clipped to the grid bbox. The cursor
// lives at module scope and the walk is an explicit `walkBegin` / `walkNext`
// pair rather than a visitor: `segmentHitsHard` runs on the solver's inner edge
// loop, and one closure plus one range object per query is enough allocation to
// show up as a GC pause mid-drag.

const walkState = {
  cx: 0,
  cy: 0,
  endCx: 0,
  endCy: 0,
  stepX: 0,
  stepY: 0,
  tMaxX: 0,
  tMaxY: 0,
  tDeltaX: 0,
  tDeltaY: 0,
  cellsX: 0,
  cellsY: 0,
  left: 0,
  live: false,
};

/** Seed the DDA. False when the segment misses the grid bbox entirely. */
function walkBegin(
  grid: CellGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  const w = walkState;
  w.live = false;
  const minX = grid.minX;
  const minY = grid.minY;
  const dx = bx - ax;
  const dy = by - ay;
  // Clip to the grid: anything outside it cannot hold an obstacle by
  // construction, so the walk never needs to step there.
  if (
    !clipRange(
      ax,
      ay,
      dx,
      dy,
      minX,
      minY,
      minX + grid.cellsX * GRID_CELL_MM,
      minY + grid.cellsY * GRID_CELL_MM
    )
  ) {
    return false;
  }
  const sx = ax + dx * clipT0;
  const sy = ay + dy * clipT0;
  const ex = ax + dx * clipT1;
  const ey = ay + dy * clipT1;

  w.cellsX = grid.cellsX;
  w.cellsY = grid.cellsY;
  w.cx = cellIndexX(sx, minX, grid.cellsX);
  w.cy = cellIndexY(sy, minY, grid.cellsY);
  w.endCx = cellIndexX(ex, minX, grid.cellsX);
  w.endCy = cellIndexY(ey, minY, grid.cellsY);
  w.stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  w.stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const segDx = ex - sx;
  const segDy = ey - sy;
  w.tDeltaX = w.stepX === 0 ? Infinity : Math.abs(GRID_CELL_MM / segDx);
  w.tDeltaY = w.stepY === 0 ? Infinity : Math.abs(GRID_CELL_MM / segDy);
  w.tMaxX =
    w.stepX === 0
      ? Infinity
      : ((w.stepX > 0
          ? minX + (w.cx + 1) * GRID_CELL_MM
          : minX + w.cx * GRID_CELL_MM) -
          sx) /
        segDx;
  w.tMaxY =
    w.stepY === 0
      ? Infinity
      : ((w.stepY > 0
          ? minY + (w.cy + 1) * GRID_CELL_MM
          : minY + w.cy * GRID_CELL_MM) -
          sy) /
        segDy;
  w.left = grid.cellsX + grid.cellsY + 2;
  w.live = true;
  return true;
}

/** The current cell, advancing the cursor; -1 once the walk is exhausted. */
function walkNext(): number {
  const w = walkState;
  if (!w.live) return -1;
  const cell = w.cy * w.cellsX + w.cx;
  if (w.left-- <= 0 || (w.cx === w.endCx && w.cy === w.endCy)) {
    w.live = false;
    return cell;
  }
  if (w.tMaxX < w.tMaxY) {
    w.cx += w.stepX;
    w.tMaxX += w.tDeltaX;
    if (w.cx < 0 || w.cx >= w.cellsX) w.live = false;
  } else {
    w.cy += w.stepY;
    w.tMaxY += w.tDeltaY;
    if (w.cy < 0 || w.cy >= w.cellsY) w.live = false;
  }
  return cell;
}

// `clipRange`'s two outputs, module-level for the same allocation reason.
let clipT0 = 0;
let clipT1 = 1;

function clipRange(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): boolean {
  let t0 = 0;
  let t1 = 1;
  if (dx > -1e-12 && dx < 1e-12) {
    if (ax < minX || ax > maxX) return false;
  } else {
    let ta = (minX - ax) / dx;
    let tb = (maxX - ax) / dx;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  if (dy > -1e-12 && dy < 1e-12) {
    if (ay < minY || ay > maxY) return false;
  } else {
    let ta = (minY - ay) / dy;
    let tb = (maxY - ay) / dy;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  clipT0 = t0;
  clipT1 = t1;
  return true;
}

// ─── Memo key ─────────────────────────────────────────────────────────────────

// Model identity is not serializable, so it gets a monotonic token. A WeakMap
// keeps the token alive exactly as long as the model does.
const modelTokens = new WeakMap<PcbModel, number>();
let nextModelToken = 1;

function modelToken(model: PcbModel): number {
  let t = modelTokens.get(model);
  if (t === undefined) {
    t = nextModelToken++;
    modelTokens.set(model, t);
  }
  return t;
}

export function obstacleSetKey(opts: BuildObstaclesOpts): string {
  const sels: string[] = [];
  for (const s of opts.excludeSelectors) sels.push(s);
  sels.sort();
  const c = opts.clearances ?? DEFAULT_BOARD_CLEARANCES;
  return [
    modelToken(opts.model),
    opts.layer,
    opts.layerCount,
    opts.traceWidthMm,
    opts.excludeTraceKey ?? "",
    c.traceToPadMm,
    c.traceToTraceMm,
    c.boardEdgeMm,
    sels.join(","),
  ].join("|");
}

export const __testing = {
  /** Every hard-rect index the grid walk offers up for `segmentHitsHard`. */
  hardCandidates(
    set: RouteObstacleSet,
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): number[] {
    const seen = new Set<number>();
    const grid = set.hardGrid;
    if (walkBegin(grid, ax, ay, bx, by)) {
      for (let cell = walkNext(); cell >= 0; cell = walkNext()) {
        const end = grid.start[cell + 1];
        for (let i = grid.start[cell]; i < end; i++) {
          seen.add(grid.items[i]);
        }
      }
    }
    return Array.from(seen).sort((a, b) => a - b);
  },
};

