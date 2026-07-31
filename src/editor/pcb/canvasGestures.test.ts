import { describe, expect, it } from "vitest";
import {
  MOUSE_TOLERANCES,
  TOUCH_TOLERANCES,
  clampScale,
  pinchAnchor,
  pinchViewport,
  pointerDistance,
  pointerMidpoint,
  screenToWorld,
  tolerancesFor,
  viewportAnchoring,
  zoomAboutPoint,
  type ScreenPoint,
  type Viewport,
} from "./canvasGestures";

const CANVAS = { width: 400, height: 600 };
const LIMITS = { min: 1.5, max: 400 };

function worldAt(screen: ScreenPoint, v: Viewport) {
  return screenToWorld(screen.x, screen.y, v, CANVAS);
}

describe("pointer helpers", () => {
  it("measures distance and midpoint", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 30, y: 40 };
    expect(pointerDistance(a, b)).toBe(50);
    expect(pointerMidpoint(a, b)).toEqual({ x: 15, y: 20 });
  });
});

describe("clampScale", () => {
  it("clamps to the limits and rejects non-finite input", () => {
    expect(clampScale(10, LIMITS)).toBe(10);
    expect(clampScale(0.1, LIMITS)).toBe(LIMITS.min);
    expect(clampScale(1e6, LIMITS)).toBe(LIMITS.max);
    expect(clampScale(Number.NaN, LIMITS)).toBe(LIMITS.min);
  });
});

describe("viewportAnchoring", () => {
  it("is the inverse of screenToWorld", () => {
    const world = { x: 3.5, y: -7.25 };
    const screen = { x: 123, y: 456 };
    const v = viewportAnchoring(world, screen, 25, CANVAS);
    const round = worldAt(screen, v);
    expect(round.x).toBeCloseTo(world.x, 10);
    expect(round.y).toBeCloseTo(world.y, 10);
  });
});

describe("zoomAboutPoint", () => {
  const v: Viewport = { x: 12, y: -30, scale: 25 };

  it("keeps the world point under the cursor fixed", () => {
    const cursor = { x: 90, y: 410 };
    const before = worldAt(cursor, v);
    const next = zoomAboutPoint(v, CANVAS, cursor, 2, LIMITS);
    expect(next.scale).toBe(50);
    const after = worldAt(cursor, next);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it("returns the same viewport when already clamped", () => {
    const atMax: Viewport = { ...v, scale: LIMITS.max };
    expect(zoomAboutPoint(atMax, CANVAS, { x: 10, y: 10 }, 4, LIMITS)).toBe(
      atMax
    );
  });
});

describe("pinchViewport", () => {
  const v: Viewport = { x: 0, y: 0, scale: 20 };

  it("scales by the ratio of finger separation", () => {
    const a = { x: 150, y: 300 };
    const b = { x: 250, y: 300 };
    const anchor = pinchAnchor(a, b, v, CANVAS);
    // Fingers spread from 100px to 200px apart about the same midpoint.
    const next = pinchViewport(
      anchor,
      { x: 100, y: 300 },
      { x: 300, y: 300 },
      CANVAS,
      LIMITS
    );
    expect(next.scale).toBeCloseTo(40, 10);
  });

  it("keeps the content under the midpoint pinned while zooming", () => {
    const a = { x: 120, y: 200 };
    const b = { x: 220, y: 260 };
    const anchor = pinchAnchor(a, b, v, CANVAS);
    const before = worldAt(anchor.startMidpoint, v);
    // Spread AND slide: separation 1.5x, midpoint moves by (+40, -25).
    const a2 = { x: 115, y: 190 };
    const b2 = { x: 265, y: 280 };
    const next = pinchViewport(anchor, a2, b2, CANVAS, LIMITS);
    const mid2 = pointerMidpoint(a2, b2);
    const after = worldAt(mid2, next);
    expect(next.scale).toBeGreaterThan(v.scale);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it("pans without zooming when both fingers translate rigidly", () => {
    const a = { x: 100, y: 100 };
    const b = { x: 200, y: 100 };
    const anchor = pinchAnchor(a, b, v, CANVAS);
    const next = pinchViewport(
      anchor,
      { x: 130, y: 160 },
      { x: 230, y: 160 },
      CANVAS,
      LIMITS
    );
    expect(next.scale).toBeCloseTo(v.scale, 10);
    expect(next.x).toBeCloseTo(v.x + 30, 10);
    expect(next.y).toBeCloseTo(v.y + 60, 10);
  });

  it("still pans when clamped at max scale", () => {
    const atMax: Viewport = { x: 0, y: 0, scale: LIMITS.max };
    const a = { x: 100, y: 100 };
    const b = { x: 200, y: 100 };
    const anchor = pinchAnchor(a, b, atMax, CANVAS);
    // Spreading further can't zoom past the limit, but the midpoint shift must
    // still move the board — otherwise the gesture feels frozen at the edge.
    const next = pinchViewport(
      anchor,
      { x: 50, y: 140 },
      { x: 350, y: 140 },
      CANVAS,
      LIMITS
    );
    expect(next.scale).toBe(LIMITS.max);
    expect(next.y).toBeCloseTo(atMax.y + 40, 10);
  });

  it("degrades to a pan when both fingers start on the same pixel", () => {
    const a = { x: 200, y: 300 };
    const anchor = pinchAnchor(a, a, v, CANVAS);
    const next = pinchViewport(
      anchor,
      { x: 210, y: 300 },
      { x: 230, y: 300 },
      CANVAS,
      LIMITS
    );
    expect(Number.isFinite(next.scale)).toBe(true);
    expect(next.scale).toBeCloseTo(v.scale, 10);
    expect(next.x).toBeCloseTo(v.x + 20, 10);
  });

  it("clamps a collapse toward zero separation to the minimum scale", () => {
    const a = { x: 100, y: 300 };
    const b = { x: 300, y: 300 };
    const anchor = pinchAnchor(a, b, v, CANVAS);
    const next = pinchViewport(
      anchor,
      { x: 199, y: 300 },
      { x: 201, y: 300 },
      CANVAS,
      LIMITS
    );
    expect(next.scale).toBe(LIMITS.min);
  });
});

describe("tolerancesFor", () => {
  it("returns the mouse set for a fine pointer and a looser set for touch", () => {
    expect(tolerancesFor(false)).toBe(MOUSE_TOLERANCES);
    expect(tolerancesFor(true)).toBe(TOUCH_TOLERANCES);
    // Every touch threshold must be at least as forgiving as its mouse twin.
    for (const key of Object.keys(MOUSE_TOLERANCES) as Array<
      keyof typeof MOUSE_TOLERANCES
    >) {
      expect(TOUCH_TOLERANCES[key]).toBeGreaterThan(MOUSE_TOLERANCES[key]);
    }
  });
});
