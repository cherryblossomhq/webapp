// hitTest — world-space spatial queries for the PCB canvas.
//
// Two flavors:
//   - Point hit-test: given (x, y) in world coords, find the element under
//     the cursor. Used by SelectTool, RouteTool (pad detection), and the
//     hover overlay.
//   - Rect hit-test: given a world-space rectangle, return all elements
//     fully or partially inside. Used by marquee selection.
//
// Implementation: pure geometry (no rbush needed at MVP scale). Cherry
// Blossom boards are small enough — a few hundred pads + components —
// that O(N) over a built model is well under 1ms. If we ever hit a
// performance ceiling, rbush is already in package.json and the hit-test
// signatures stay the same.
//
// Priority order (top-most first), mimicking Altium:
//   1. Vias
//   2. Pads
//   3. Trace segments
//   4. Components (body bbox)
// Hidden layers are skipped — the user shouldn't be able to pick what
// they can't see.

import type { LayerId } from "@/editor/shared/types";
import {
  pcbComponentDisplayBbox,
  type PcbComponentRecord,
  type PcbModel,
  type PcbPadRecord,
  type PcbTraceRecord,
  type PcbTraceSegment,
  type PcbViaRecord,
} from "./pcbModel";

export type HitKind =
  | { kind: "component"; record: PcbComponentRecord }
  | { kind: "pad"; record: PcbPadRecord }
  | { kind: "trace"; record: PcbTraceRecord; segmentIndex: number }
  | { kind: "via"; record: PcbViaRecord };

export interface HitTestOptions {
  // Layers currently visible. Hit-test ignores everything on hidden layers.
  layerVisibility: Readonly<Record<LayerId, boolean>>;
  // Additional pixel-space tolerance for thin-line hits (trace segments,
  // silkscreen). Converted to mm by the caller via the current zoom.
  toleranceMm: number;
  // When true, components are skipped even if their bbox covers the
  // point. Used by the route tool, which only wants pads / vias / traces.
  ignoreComponents?: boolean;
}

const isLayerVisible = (
  layer: LayerId,
  vis: Readonly<Record<LayerId, boolean>>
): boolean => vis[layer] !== false;

// ─── Point hit-test ───────────────────────────────────────────────────────────

export function hitTestPoint(
  model: PcbModel,
  worldX: number,
  worldY: number,
  opts: HitTestOptions
): HitKind | null {
  // 1) Vias (tiny, narrow targets — give them top priority).
  for (const via of model.vias) {
    // Vias span both their from + to layer; pick if either is visible.
    if (
      !isLayerVisible(via.fromLayer, opts.layerVisibility) &&
      !isLayerVisible(via.toLayer, opts.layerVisibility)
    )
      continue;
    const r = via.outerDiameter / 2 + opts.toleranceMm;
    if (pointInCircle(worldX, worldY, via.x, via.y, r)) {
      return { kind: "via", record: via };
    }
  }

  // 2) Pads (per-shape hit-test).
  for (const pad of model.pads) {
    if (!isLayerVisible(pad.layer, opts.layerVisibility) && !pad.isThroughHole)
      continue;
    if (padContainsPoint(pad, worldX, worldY, opts.toleranceMm)) {
      return { kind: "pad", record: pad };
    }
  }

  // 3) Trace segments — distance to capsule.
  for (const trace of model.traces) {
    for (let i = 0; i < trace.segments.length; i++) {
      const seg = trace.segments[i];
      if (!isLayerVisible(seg.layer, opts.layerVisibility)) continue;
      if (
        pointToSegmentDistance(
          worldX,
          worldY,
          seg.fromX,
          seg.fromY,
          seg.toX,
          seg.toY
        ) <= seg.width / 2 + opts.toleranceMm
      ) {
        return { kind: "trace", record: trace, segmentIndex: i };
      }
    }
  }

  // 4) Components (body bbox + slight inflate).
  if (!opts.ignoreComponents) {
    for (const comp of model.components) {
      if (!isLayerVisible(comp.layer, opts.layerVisibility)) continue;
      const display = comp.displayBbox ?? pcbComponentDisplayBbox(comp, model.pads);
      if (
        pointInRotatedRect(
          worldX,
          worldY,
          comp.x,
          comp.y,
          display.width + opts.toleranceMm * 2,
          display.height + opts.toleranceMm * 2,
          display.rotationDeg
        )
      ) {
        return { kind: "component", record: comp };
      }
    }
  }

  return null;
}

// ─── Rect (marquee) hit-test ──────────────────────────────────────────────────

export interface HitRectResult {
  components: PcbComponentRecord[];
  pads: PcbPadRecord[];
  traces: PcbTraceRecord[];
  vias: PcbViaRecord[];
}

export function hitTestRect(
  model: PcbModel,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  opts: HitTestOptions
): HitRectResult {
  const result: HitRectResult = {
    components: [],
    pads: [],
    traces: [],
    vias: [],
  };

  for (const comp of model.components) {
    if (!isLayerVisible(comp.layer, opts.layerVisibility)) continue;
    if (
      comp.x >= minX &&
      comp.x <= maxX &&
      comp.y >= minY &&
      comp.y <= maxY
    ) {
      result.components.push(comp);
    }
  }

  for (const pad of model.pads) {
    if (!isLayerVisible(pad.layer, opts.layerVisibility) && !pad.isThroughHole)
      continue;
    if (pad.x >= minX && pad.x <= maxX && pad.y >= minY && pad.y <= maxY) {
      result.pads.push(pad);
    }
  }

  for (const trace of model.traces) {
    for (const seg of trace.segments) {
      if (!isLayerVisible(seg.layer, opts.layerVisibility)) continue;
      // Either endpoint inside the rect → include the trace.
      if (
        (seg.fromX >= minX &&
          seg.fromX <= maxX &&
          seg.fromY >= minY &&
          seg.fromY <= maxY) ||
        (seg.toX >= minX &&
          seg.toX <= maxX &&
          seg.toY >= minY &&
          seg.toY <= maxY)
      ) {
        result.traces.push(trace);
        break;
      }
    }
  }

  for (const via of model.vias) {
    if (
      !isLayerVisible(via.fromLayer, opts.layerVisibility) &&
      !isLayerVisible(via.toLayer, opts.layerVisibility)
    )
      continue;
    if (via.x >= minX && via.x <= maxX && via.y >= minY && via.y <= maxY) {
      result.vias.push(via);
    }
  }

  return result;
}

// ─── Pad-only finder (route tool) ─────────────────────────────────────────────

// Find the nearest pad within `radius` mm of (x, y) on the given layer.
// Through-holes match regardless of layer (they span all copper). Used
// for the route tool's pad snap.
export function findNearestPad(
  model: PcbModel,
  worldX: number,
  worldY: number,
  layer: LayerId,
  radiusMm: number
): PcbPadRecord | null {
  let best: PcbPadRecord | null = null;
  let bestDist2 = radiusMm * radiusMm;
  for (const pad of model.pads) {
    if (pad.layer !== layer && !pad.isThroughHole) continue;
    const dx = pad.x - worldX;
    const dy = pad.y - worldY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      best = pad;
      bestDist2 = d2;
    }
  }
  return best;
}

// ─── Geometry primitives ──────────────────────────────────────────────────────

function pointInCircle(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function padContainsPoint(
  pad: PcbPadRecord,
  px: number,
  py: number,
  tol: number
): boolean {
  // Circular through-holes hit as their annular ring; rect/pill-pad plated
  // holes (tscircuit's pin-1 squares, slots) use the shape test below.
  if (pad.isThroughHole && pad.shape === "circle") {
    return pointInCircle(
      px,
      py,
      pad.x,
      pad.y,
      (pad.outerDiameter ?? 0.8) / 2 + tol
    );
  }
  switch (pad.shape) {
    case "circle":
      return pointInCircle(px, py, pad.x, pad.y, (pad.radius ?? 0.5) + tol);
    case "rect":
    case "pill":
      // Pad may be rotated (eval rotation on rect/pill footprints). Undo the
      // rotation around the pad center before testing the axis-aligned bounds.
      return pointInRotatedRect(
        px,
        py,
        pad.x,
        pad.y,
        (pad.rectWidth ?? 1) + tol * 2,
        (pad.rectHeight ?? 1) + tol * 2,
        pad.rotationDeg
      );
    case "polygon": {
      if (!pad.polygonPoints || pad.polygonPoints.length < 3) return false;
      return pointInPolygon(px, py, pad.polygonPoints);
    }
  }
  return false;
}

function pointInRotatedRect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotationDeg: number
): boolean {
  if (rotationDeg === 0) {
    return (
      px >= cx - width / 2 &&
      px <= cx + width / 2 &&
      py >= cy - height / 2 &&
      py <= cy + height / 2
    );
  }
  const rad = (-rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return (
    rx >= -width / 2 &&
    rx <= width / 2 &&
    ry >= -height / 2 &&
    ry <= height / 2
  );
}

function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - x1;
    const ey = py - y1;
    return Math.hypot(ex, ey);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function pointInPolygon(
  px: number,
  py: number,
  poly: ReadonlyArray<{ x: number; y: number }>
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Re-export segment helpers for tools that need them.
export { pointToSegmentDistance };
export const __testing = {
  pointInCircle,
  pointInRotatedRect,
  pointInPolygon,
  padContainsPoint,
};

// Suppress unused parameter warning for typed import.
export type _UnusedSegment = PcbTraceSegment;

