// routeOverlayDraw — imperative painter for the manual-routing overlay.
//
// It owns the third <canvas>, mounted between the static board canvas and the
// interactive <svg>. That position is the correct professional ordering: the
// preview paints ABOVE committed copper and BELOW selection halos, ratsnest and
// DRC markers, so a violation marker can never be hidden by the rubber band.
//
// Eight passes, bottom to top, each one `beginPath()` + one stroke/fill. The
// transform matches `pcbCanvasDraw.ts` and the SVG stage exactly, so the three
// surfaces line up pixel-for-pixel.
//
// NO COLOUR LITERAL MAY APPEAR IN THIS FILE. Every colour comes from
// pcbColors.ts or `layers.getLayerColor` — that is grep-checkable and it is what
// keeps the overlay in the same palette as the rest of the board.

import type { LayerId } from "@/editor/shared/types";
import { DEFAULT_VIA_DRILL_MM, DEFAULT_VIA_PAD_MM, getLayerColor } from "./layers";
import {
  COLOR_CLEARANCE_HALO,
  COLOR_HOLE,
  COLOR_HOVER,
  COLOR_ROUTE_BLOCKED,
  COLOR_ROUTE_BLOCKED_RIM,
  COLOR_ROUTE_KNEE,
  COLOR_ROUTE_LEADER_GLOW,
  COLOR_VIA,
  COLOR_VIA_STROKE,
  ROUTE_COMMITTED_ALPHA,
  ROUTE_LEADER_ALPHA,
} from "./pcbColors";
import type { RouteLiveSnapshot } from "./routeLive";

const TAU = Math.PI * 2;
const LEADER_GLOW_MUL = 1.35;
const KNEE_RADIUS_MUL = 0.25;
const BLOCKED_GLYPH_MM = 0.45;
const BLOCKED_GLYPH_MIN_PX = 9;
const CURSOR_DOT_MM = 0.15;
// Exported because the fade is time-based and a click is not followed by any
// other frame source — whoever sets `rejectFlashAt` has to drive repaints for
// this long or the ring freezes at full opacity.
export const REJECT_FLASH_MS = 400;

// Collision overstroke, outside in: a dark rim, then the violation colour at
// EXACTLY the trace width. The rim is what makes the cue read on a red layer
// (see COLOR_ROUTE_BLOCKED_RIM); the core staying at 1× is what keeps it honest.
// An overstroke wider than the copper tells a hardware engineer their trace is
// fatter than it is, which on a dense board is a worse lie than a weak cue.
const BLOCKED_PASSES = [
  { stroke: COLOR_ROUTE_BLOCKED_RIM, alpha: 1, widthMul: 2 },
  { stroke: COLOR_ROUTE_BLOCKED, alpha: 1, widthMul: 1 },
] as const;

export interface ViewportTransform {
  x: number;
  y: number;
  scale: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface DrawRouteOptions {
  isLayerOn: (layer: LayerId) => boolean;
  nowMs: number;
}

export function drawRouteOverlay(
  ctx: CanvasRenderingContext2D,
  snap: RouteLiveSnapshot,
  viewport: ViewportTransform,
  canvasSize: CanvasSize,
  dpr: number,
  opts: DrawRouteOptions
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!snap.active) return;
  if (!opts.isLayerOn(snap.layer)) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(canvasSize.width / 2 + viewport.x, canvasSize.height / 2 + viewport.y);
  ctx.scale(viewport.scale, -viewport.scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Cull to the visible world rect, same as drawPcb — a route drawn far off
  // screen costs nothing but must not cost a stroke either.
  const halfW = canvasSize.width / 2 / viewport.scale;
  const halfH = canvasSize.height / 2 / viewport.scale;
  const cxWorld = -viewport.x / viewport.scale;
  const cyWorld = viewport.y / viewport.scale;
  const view = {
    minX: cxWorld - halfW,
    maxX: cxWorld + halfW,
    minY: cyWorld - halfH,
    maxY: cyWorld + halfH,
  };
  const px = 1 / viewport.scale;

  const previewVisible =
    snap.previewLen >= 2 && polylineInView(snap.previewX, snap.previewY, snap.previewLen, view);
  const committedVisible =
    snap.committedLen >= 2 &&
    polylineInView(snap.committedX, snap.committedY, snap.committedLen, view);

  // ─── 1. Clearance halo ─────────────────────────────────────────────────
  if (snap.haloVisible && (committedVisible || previewVisible)) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLOR_CLEARANCE_HALO;
    ctx.lineWidth = snap.clearanceHaloMm;
    ctx.beginPath();
    tracePolyline(ctx, snap.committedX, snap.committedY, snap.committedLen);
    tracePolyline(ctx, snap.previewX, snap.previewY, snap.previewLen);
    ctx.stroke();
  }

  // ─── 2. Committed draft ────────────────────────────────────────────────
  // Per layer-run, skipping via transitions: a via is not a trace, so nothing
  // is drawn between two points on different layers.
  if (committedVisible) {
    ctx.globalAlpha = ROUTE_COMMITTED_ALPHA;
    ctx.lineWidth = snap.widthMm;
    let i = 0;
    while (i < snap.committedLen - 1) {
      const layer = snap.committedLayer[i];
      let j = i;
      while (j < snap.committedLen - 1 && snap.committedLayer[j + 1] === layer) j++;
      if (j > i) {
        ctx.strokeStyle = getLayerColor(layer);
        ctx.beginPath();
        ctx.moveTo(snap.committedX[i], snap.committedY[i]);
        for (let k = i + 1; k <= j; k++) {
          ctx.lineTo(snap.committedX[k], snap.committedY[k]);
        }
        ctx.stroke();
      }
      i = j + 1;
    }
  }

  if (previewVisible) {
    // ─── 3. Preview glow ─────────────────────────────────────────────────
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLOR_ROUTE_LEADER_GLOW;
    ctx.lineWidth = snap.widthMm * LEADER_GLOW_MUL;
    ctx.beginPath();
    tracePolyline(ctx, snap.previewX, snap.previewY, snap.previewLen);
    ctx.stroke();

    // ─── 4. Preview ──────────────────────────────────────────────────────
    ctx.globalAlpha = ROUTE_LEADER_ALPHA;
    ctx.strokeStyle = getLayerColor(snap.layer);
    ctx.lineWidth = snap.widthMm;
    ctx.beginPath();
    tracePolyline(ctx, snap.previewX, snap.previewY, snap.previewLen);
    ctx.stroke();

    // ─── 5. Collision overstroke ─────────────────────────────────────────
    // Present in both conflict modes; in `ignore` it is the only feedback there
    // is, so it must never be gated on the solver.
    let anyHit = false;
    for (let k = 0; k < snap.previewLen - 1; k++) {
      if (snap.previewHit[k]) {
        anyHit = true;
        break;
      }
    }
    if (anyHit) {
      // Two strokes, not one: a dark rim then a wider opaque core. A single
      // same-hue 50% overstroke is a ~4% pixel delta on the default red top
      // copper — see COLOR_ROUTE_BLOCKED_RIM. The rim is what makes the cue read
      // on any layer.
      for (const pass of BLOCKED_PASSES) {
        ctx.globalAlpha = pass.alpha;
        ctx.strokeStyle = pass.stroke;
        ctx.lineWidth = snap.widthMm * pass.widthMul;
        ctx.beginPath();
        for (let k = 0; k < snap.previewLen - 1; k++) {
          if (!snap.previewHit[k]) continue;
          ctx.moveTo(snap.previewX[k], snap.previewY[k]);
          ctx.lineTo(snap.previewX[k + 1], snap.previewY[k + 1]);
        }
        ctx.stroke();
      }
      ctx.lineWidth = snap.widthMm;
    }

    // ─── 6. Blocked glyph ────────────────────────────────────────────────
    if (snap.blocked) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = COLOR_ROUTE_BLOCKED;
      ctx.beginPath();
      tracePolyline(ctx, snap.previewX, snap.previewY, snap.previewLen);
      ctx.stroke();
      if (snap.cursorValid) {
        // Floored in PIXELS as well as millimetres: "there is no way through" is
        // the one cue the user must never miss, and a 0.45mm world glyph is three
        // pixels wide at a board-level zoom — exactly where they are most likely
        // to be dragging a long route.
        const r = Math.max(BLOCKED_GLYPH_MM, BLOCKED_GLYPH_MIN_PX * px);
        const d = r * Math.SQRT1_2;
        ctx.lineWidth = Math.max(1.5 * px, r * 0.25);
        ctx.beginPath();
        ctx.arc(snap.cursorX, snap.cursorY, r, 0, TAU);
        ctx.moveTo(snap.cursorX - d, snap.cursorY + d);
        ctx.lineTo(snap.cursorX + d, snap.cursorY - d);
        ctx.stroke();
        ctx.lineWidth = snap.widthMm;
      }
    }

    // ─── 7. Knee marker ──────────────────────────────────────────────────
    if (snap.kneeIndex >= 0 && snap.kneeIndex < snap.previewLen) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = COLOR_ROUTE_KNEE;
      ctx.beginPath();
      ctx.arc(
        snap.previewX[snap.kneeIndex],
        snap.previewY[snap.kneeIndex],
        Math.max(snap.widthMm * KNEE_RADIUS_MUL, 1.5 * px),
        0,
        TAU
      );
      ctx.fill();
    }
  }

  // ─── 8. Cursor chrome ──────────────────────────────────────────────────
  drawCursorChrome(ctx, snap, px, opts.nowMs);
  ctx.globalAlpha = 1;
}

function drawCursorChrome(
  ctx: CanvasRenderingContext2D,
  snap: RouteLiveSnapshot,
  px: number,
  nowMs: number
): void {
  const flashAge = nowMs - snap.rejectFlashAt;
  if (snap.rejectFlashAt > 0 && flashAge < REJECT_FLASH_MS) {
    ctx.globalAlpha = 1 - flashAge / REJECT_FLASH_MS;
    ctx.strokeStyle = COLOR_ROUTE_BLOCKED;
    ctx.lineWidth = Math.max(2 * px, snap.snapRadiusMm * 0.25);
    ctx.beginPath();
    ctx.arc(snap.rejectFlashX, snap.rejectFlashY, snap.snapRadiusMm, 0, TAU);
    ctx.stroke();
  }

  if (snap.snapKind !== 0) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = snap.snapKind === 2 ? COLOR_ROUTE_BLOCKED : COLOR_HOVER;
    ctx.lineWidth = Math.max(1.5 * px, snap.snapRadiusMm * 0.2);
    ctx.beginPath();
    ctx.arc(snap.snapX, snap.snapY, snap.snapRadiusMm, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = snap.snapKind === 2 ? COLOR_ROUTE_BLOCKED : COLOR_HOVER;
    ctx.beginPath();
    ctx.arc(snap.snapX, snap.snapY, CURSOR_DOT_MM, 0, TAU);
    ctx.fill();
  }

  if (snap.pendingViaActive) {
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = COLOR_VIA;
    ctx.beginPath();
    ctx.arc(snap.pendingViaX, snap.pendingViaY, DEFAULT_VIA_PAD_MM / 2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = COLOR_VIA_STROKE;
    ctx.lineWidth = Math.max(px, 0.05);
    ctx.stroke();
    ctx.fillStyle = COLOR_HOLE;
    ctx.beginPath();
    ctx.arc(snap.pendingViaX, snap.pendingViaY, DEFAULT_VIA_DRILL_MM / 2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = COLOR_CLEARANCE_HALO;
    ctx.lineWidth = Math.max(px, 0.06);
    ctx.beginPath();
    ctx.arc(
      snap.pendingViaX,
      snap.pendingViaY,
      DEFAULT_VIA_PAD_MM / 2 + snap.clearanceHaloMm / 2,
      0,
      TAU
    );
    ctx.stroke();
  }
}

function tracePolyline(
  ctx: CanvasRenderingContext2D,
  xs: Float64Array,
  ys: Float64Array,
  len: number
): void {
  if (len < 2) return;
  ctx.moveTo(xs[0], ys[0]);
  for (let i = 1; i < len; i++) ctx.lineTo(xs[i], ys[i]);
}

function polylineInView(
  xs: Float64Array,
  ys: Float64Array,
  len: number,
  view: { minX: number; maxX: number; minY: number; maxY: number }
): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < len; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  return (
    maxX >= view.minX && minX <= view.maxX && maxY >= view.minY && minY <= view.maxY
  );
}

