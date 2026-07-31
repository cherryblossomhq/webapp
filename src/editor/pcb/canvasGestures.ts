// Pure viewport + pointer math for the PCB canvas.
//
// Plain functions over numbers — no React, no DOM, no store. Two reasons this
// lives outside PcbCanvas.tsx:
//   - Pinch math (scale from finger separation, translation from the midpoint)
//     is easy to get subtly wrong and trivial to unit test, so it is exercised
//     directly in canvasGestures.test.ts instead of only through a browser.
//   - Wheel zoom and pinch zoom MUST agree. Both funnel through
//     `viewportAnchoring`, so there is exactly ONE place that decides how a
//     world point stays pinned under a screen point at a new scale. A second,
//     parallel transform path is how "the board jumps when I pinch" bugs start.
//
// Coordinate contract (matches the SVG stage transform in PcbCanvas):
//   screenX = canvas.width  / 2 + v.x + world.x * v.scale
//   screenY = canvas.height / 2 + v.y - world.y * v.scale   (world Y is up)
// Screen coords are CANVAS-LOCAL px (clientX − boundingRect.left), not client
// px, so the same numbers work for hit tests and for gesture anchors.

export interface Viewport {
  x: number; // screen px offset (after the Y flip)
  y: number;
  scale: number; // px / mm
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface ScaleLimits {
  min: number;
  max: number;
}

export function screenToWorld(
  screenX: number,
  screenY: number,
  v: Viewport,
  canvas: CanvasSize
): { x: number; y: number } {
  const sx = screenX - canvas.width / 2 - v.x;
  const sy = screenY - canvas.height / 2 - v.y;
  return {
    x: sx / v.scale,
    y: -sy / v.scale,
  };
}

export function clampScale(scale: number, limits: ScaleLimits): number {
  if (!Number.isFinite(scale)) return limits.min;
  return Math.max(limits.min, Math.min(limits.max, scale));
}

/**
 * The viewport that puts `world` exactly under `screen` at `scale` — the
 * inverse of `screenToWorld` solved for the offsets. Every zoom in the editor
 * (wheel, pinch, DRC focus) is "anchor this world point to this screen point",
 * so this is the single primitive they share.
 */
export function viewportAnchoring(
  world: { x: number; y: number },
  screen: ScreenPoint,
  scale: number,
  canvas: CanvasSize
): Viewport {
  return {
    x: screen.x - canvas.width / 2 - world.x * scale,
    y: screen.y - canvas.height / 2 + world.y * scale,
    scale,
  };
}

/**
 * Multiply the zoom by `factor` while keeping whatever is under `screen`
 * exactly where it is. Used by the wheel handler; pinch uses the same anchor
 * math via `pinchViewport`.
 */
export function zoomAboutPoint(
  v: Viewport,
  canvas: CanvasSize,
  screen: ScreenPoint,
  factor: number,
  limits: ScaleLimits
): Viewport {
  const scale = clampScale(v.scale * factor, limits);
  if (scale === v.scale) return v;
  const world = screenToWorld(screen.x, screen.y, v, canvas);
  return viewportAnchoring(world, screen, scale, canvas);
}

export function pointerDistance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pointerMidpoint(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Frozen state captured when the second finger lands. Everything a pinch needs
 * is measured ONCE here, so subsequent frames are computed from the original
 * anchor rather than from the previous frame — incremental deltas accumulate
 * float drift and let a dropped move event permanently offset the board.
 */
export interface PinchAnchor {
  startDistance: number;
  startMidpoint: ScreenPoint;
  startViewport: Viewport;
  /** World point that was under `startMidpoint` — the invariant of the gesture. */
  anchorWorld: { x: number; y: number };
}

export function pinchAnchor(
  a: ScreenPoint,
  b: ScreenPoint,
  viewport: Viewport,
  canvas: CanvasSize
): PinchAnchor {
  const startMidpoint = pointerMidpoint(a, b);
  return {
    startDistance: pointerDistance(a, b),
    startMidpoint,
    startViewport: { ...viewport },
    anchorWorld: screenToWorld(
      startMidpoint.x,
      startMidpoint.y,
      viewport,
      canvas
    ),
  };
}

/**
 * Pinch zoom + pan in one step: scale follows the change in finger separation,
 * translation follows the change in midpoint. The world point that started
 * under the midpoint stays under the midpoint, which is what makes the board
 * feel stuck to the fingers.
 *
 * Two fingers that land on the same pixel give a zero start distance; there is
 * no meaningful ratio then, so the gesture degrades to a pure two-finger pan
 * instead of exploding to Infinity.
 */
export function pinchViewport(
  anchor: PinchAnchor,
  a: ScreenPoint,
  b: ScreenPoint,
  canvas: CanvasSize,
  limits: ScaleLimits
): Viewport {
  const distance = pointerDistance(a, b);
  const ratio =
    anchor.startDistance > 1e-6 ? distance / anchor.startDistance : 1;
  const scale = clampScale(anchor.startViewport.scale * ratio, limits);
  return viewportAnchoring(
    anchor.anchorWorld,
    pointerMidpoint(a, b),
    scale,
    canvas
  );
}

// ─── Hit tolerances ──────────────────────────────────────────────────────────
// Screen-pixel slop for picking. A mouse cursor is a single pixel with a
// visible hotspot; a fingertip is a ~9mm contact patch the user cannot see
// through, so every threshold that reads "close enough" has to grow on a coarse
// pointer. Derived once per pointer type and passed around as an object rather
// than branching at each use site — the values only ever change together.

export interface CanvasTolerances {
  /** Movement before a press becomes a drag (marquee / move / segment slide). */
  dragThresholdPx: number;
  /** Pick slop for thin targets — trace segments. */
  hitTolPx: number;
  /** Pad-snap radius for the route tool. */
  snapPadPx: number;
  /** Invisible stroke width of a ratsnest airwire's hit capsule. */
  ratsnestHitPx: number;
}

export const MOUSE_TOLERANCES: CanvasTolerances = {
  dragThresholdPx: 3,
  hitTolPx: 4,
  snapPadPx: 12,
  ratsnestHitPx: 12,
};

// A finger never lands within 3px of where it lifts, so the mouse drag
// threshold turns every tap into a micro-drag; 10px is the smallest value that
// reliably separates "tap" from "drag" for a thumb.
export const TOUCH_TOLERANCES: CanvasTolerances = {
  dragThresholdPx: 10,
  hitTolPx: 11,
  snapPadPx: 20,
  ratsnestHitPx: 18,
};

export function tolerancesFor(isTouch: boolean): CanvasTolerances {
  return isTouch ? TOUCH_TOLERANCES : MOUSE_TOLERANCES;
}
