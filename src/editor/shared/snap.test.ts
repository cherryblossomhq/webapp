import { describe, it, expect } from "vitest";
import {
  snapToGrid,
  snapToPin,
  rectFromPoints,
  pointInRect,
  rectsIntersect,
  DEFAULT_GRID_MM,
} from "./snap";

describe("snapToGrid", () => {
  it("uses the default grid (0.1mm) when none is supplied", () => {
    // Float rounding through divide+round+multiply can land 1e-16 off the
    // ideal value; assert with closeness rather than equality.
    const r = snapToGrid({ x: 1.234, y: -2.567 });
    expect(r.x).toBeCloseTo(1.2, 9);
    expect(r.y).toBeCloseTo(-2.6, 9);
    expect(DEFAULT_GRID_MM).toBe(0.1);
  });

  it("rounds to the nearest grid step", () => {
    const a = snapToGrid({ x: 0.51, y: 0.49 }, 0.5);
    expect(a.x).toBeCloseTo(0.5, 9);
    expect(a.y).toBeCloseTo(0.5, 9);
    const b = snapToGrid({ x: 0.74, y: 0.26 }, 0.5);
    expect(b.x).toBeCloseTo(0.5, 9);
    expect(b.y).toBeCloseTo(0.5, 9);
    const c = snapToGrid({ x: 0.76, y: 0.24 }, 0.5);
    expect(c.x).toBeCloseTo(1, 9);
    expect(c.y).toBeCloseTo(0, 9);
  });

  it("returns the input unchanged for invalid grid sizes", () => {
    const p = { x: 1.234, y: 5.678 };
    expect(snapToGrid(p, 0)).toEqual(p);
    expect(snapToGrid(p, -1)).toEqual(p);
    expect(snapToGrid(p, NaN)).toEqual(p);
  });
});

describe("snapToPin", () => {
  const pins = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 5, y: 5 },
  ];

  it("returns the closest pin within radius", () => {
    expect(snapToPin({ x: 0.1, y: 0.1 }, pins, 0.5)).toEqual({ x: 0, y: 0 });
    expect(snapToPin({ x: 0.9, y: 0.1 }, pins, 0.5)).toEqual({ x: 1, y: 0 });
  });

  it("returns null when no pin is within radius", () => {
    expect(snapToPin({ x: 10, y: 10 }, pins, 0.5)).toBeNull();
  });

  it("returns null for non-positive radius", () => {
    expect(snapToPin({ x: 0, y: 0 }, pins, 0)).toBeNull();
    expect(snapToPin({ x: 0, y: 0 }, pins, -1)).toBeNull();
  });

  it("ties go to the LAST pin scanned (deterministic on input order)", () => {
    const tied = [
      { x: 0, y: 0, id: "a" },
      { x: 0, y: 0, id: "b" },
    ];
    expect(snapToPin({ x: 0, y: 0 }, tied, 1)?.id).toBe("b");
  });
});

describe("rectFromPoints + pointInRect + rectsIntersect", () => {
  it("rectFromPoints normalizes corner order", () => {
    const r = rectFromPoints({ x: 5, y: 8 }, { x: 1, y: 2 });
    expect(r).toEqual({ minX: 1, minY: 2, maxX: 5, maxY: 8 });
  });

  it("pointInRect handles boundary points (inclusive)", () => {
    const r = rectFromPoints({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(pointInRect({ x: 0, y: 0 }, r)).toBe(true);
    expect(pointInRect({ x: 1, y: 1 }, r)).toBe(true);
    expect(pointInRect({ x: 2, y: 2 }, r)).toBe(true);
    expect(pointInRect({ x: 3, y: 1 }, r)).toBe(false);
  });

  it("rectsIntersect detects touching edges", () => {
    const a = rectFromPoints({ x: 0, y: 0 }, { x: 1, y: 1 });
    const b = rectFromPoints({ x: 1, y: 0 }, { x: 2, y: 1 });
    expect(rectsIntersect(a, b)).toBe(true); // edge touch
    const c = rectFromPoints({ x: 2, y: 2 }, { x: 3, y: 3 });
    expect(rectsIntersect(a, c)).toBe(false);
  });
});
