// Pure geometry helpers. No DOM, no React, no Zustand — testable in isolation.
//
// The schematic editor uses two distinct snap modes:
//   - snapToGrid: align positions to a fixed grid (default 0.1mm in tscircuit
//     coordinates, which is what RunFrame's schematic viewer uses internally).
//   - snapToPin: while drawing a wire, magnetically attract the cursor to any
//     pin within snapRadius.
//
// The PCB route tool's angle constraints are NOT here: a professional 45° leader
// is a two-segment shape, not one vector snapped to the nearest octant, so that
// geometry lives in editor/pcb/routeLeader.ts.

export interface Point {
  x: number;
  y: number;
}

export const DEFAULT_GRID_MM = 0.1;

export function snapToGrid(point: Point, gridMm: number = DEFAULT_GRID_MM): Point {
  if (!Number.isFinite(gridMm) || gridMm <= 0) return point;
  return {
    x: Math.round(point.x / gridMm) * gridMm,
    y: Math.round(point.y / gridMm) * gridMm,
  };
}

// Returns the nearest pin to `point` within `snapRadiusMm`, or null if none.
// `pins` is the candidate list; small enough that linear search is fine.
export function snapToPin<P extends Point>(
  point: Point,
  pins: ReadonlyArray<P>,
  snapRadiusMm: number
): P | null {
  if (snapRadiusMm <= 0) return null;
  const r2 = snapRadiusMm * snapRadiusMm;
  let best: P | null = null;
  let bestDist2 = r2;
  for (const pin of pins) {
    const dx = pin.x - point.x;
    const dy = pin.y - point.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestDist2) {
      bestDist2 = d2;
      best = pin;
    }
  }
  return best;
}

// Axis-aligned bounding box helper for marquee/rubber-band hit-tests.
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}
