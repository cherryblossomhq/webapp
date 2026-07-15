// pcbCanvasDraw — imperative Canvas 2D renderer for the static board geometry.
//
// The PCB editor is a hybrid: this module paints everything that does NOT
// change on hover/selection (grid, board outline, traces, pads, vias,
// component bodies + designators, silkscreen) onto a single <canvas> in one
// draw call per frame. The interactive chrome (selection / hover highlights,
// ratsnest, route draft, DRC markers, marquee) stays on the React/SVG overlay
// in PcbCanvas.tsx — those change rapidly and re-rendering a handful of SVG
// nodes is cheap, whereas reconciling tens of thousands of static nodes on
// every wheel tick was not.
//
// The math here MIRRORS the SVG renderer exactly (same pad variants, the same
// `bodyPathD` notch, the same silkscreen text flip) so the two layers line up
// pixel-for-pixel. We draw straight from `PcbModel` world-mm geometry rather
// than routing through `circuit-to-canvas` (a read-only circuit-json renderer
// that manages its own camera matrix and would fight our viewport).
//
// Coordinate system: the context is set to
//   setTransform(dpr,0,0,dpr,0,0) · translate(w/2 + vx, h/2 + vy) · scale(s,-s)
// so all drawing below is in world millimeters with Y up, matching the SVG
// `stageTransform`. Strokes that the SVG drew with `vectorEffect=
// "non-scaling-stroke"` are reproduced by dividing the desired screen-pixel
// width by `viewport.scale`; real trace/silk widths (mm) scale naturally.

import type { LayerId } from "@/editor/shared/types";
import { BOTTOM_LAYER_ID, getLayerColor, type LayerConfig } from "./layers";
import {
  pcbComponentDisplayBbox,
  type PcbComponentRecord,
  type PcbModel,
  type PcbPadRecord,
  type PcbViaRecord,
} from "./pcbModel";
import { isPadOnNet, isTraceOnNet } from "./routeAssist";
import {
  COLOR_BOARD_BORDER,
  COLOR_BOARD_FILL,
  COLOR_GRID_COARSE,
  COLOR_GRID_FINE,
  COLOR_HOLE,
  COLOR_TH_PAD,
  COLOR_VIA,
  COLOR_VIA_STROKE,
  DIMMED_OPACITY,
  GRID_COARSE_MM,
  GRID_FINE_MM,
} from "./pcbColors";

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

interface CanvasSize {
  width: number;
  height: number;
}

// Axis-aligned visible world rect (with a small margin), used to cull
// off-screen elements when zoomed in. When the whole board fits in view this
// covers everything, so nothing is culled — the safe, common case.
interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DrawPcbOptions {
  // Visible copper/silkscreen layers, already sorted bottom→top by zOrder.
  orderedLayers: ReadonlyArray<LayerConfig>;
  // Per-element visibility predicates — shared with PcbCanvas so what's drawn
  // equals what's hit-testable.
  isPadVisible: (pad: PcbPadRecord) => boolean;
  isViaVisible: (via: { fromLayer: LayerId; toLayer: LayerId }) => boolean;
  isLayerOn: (layer: LayerId) => boolean;
  // Net-focus dimming. `focusedNet` gates component membership; the selector
  // set gates traces/pads. Null when no net is focused (nothing dims).
  focusedNet: PcbModel["nets"][number] | null;
  focusedNetSelectors: ReadonlySet<string> | null;
  // Component-render inputs, mirroring PcbCanvas's memos: which parts get a
  // courtyard outline + pin-1 notch, the pin-1 pad per part, and pad counts.
  chipLikeNames: ReadonlySet<string>;
  pin1ByCompKey: ReadonlyMap<string, PcbPadRecord>;
  padCountByCompKey: ReadonlyMap<string, number>;
  // Device pixel ratio for the backing store (retina crispness).
  dpr: number;
}

// Same inverse transform as PcbCanvas's screenToWorld — duplicated here so the
// draw module stays self-contained (no import cycle with the React file).
function screenToWorld(
  sx: number,
  sy: number,
  v: Viewport,
  canvas: CanvasSize
): { x: number; y: number } {
  const dx = sx - canvas.width / 2 - v.x;
  const dy = sy - canvas.height / 2 - v.y;
  return { x: dx / v.scale, y: -dy / v.scale };
}

function rectsIntersect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  v: ViewRect
): boolean {
  return maxX >= v.minX && minX <= v.maxX && maxY >= v.minY && minY <= v.maxY;
}

// Append a rounded-rect subpath. Used for the board outline and pill/round-rect
// pads instead of ctx.roundRect, which isn't available on every WebView the
// desktop app ships against.
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function drawPcb(
  ctx: CanvasRenderingContext2D,
  model: PcbModel,
  viewport: Viewport,
  canvasSize: CanvasSize,
  opts: DrawPcbOptions
): void {
  const { dpr } = opts;

  // Clear the full backing store in device pixels, then install the world
  // transform. The canvas itself is transparent — the container's COLOR_BG
  // shows through so the low-alpha grid blends the same way it did over SVG.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(canvasSize.width / 2 + viewport.x, canvasSize.height / 2 + viewport.y);
  ctx.scale(viewport.scale, -viewport.scale);

  // Visible world rect (+1mm margin to keep edge strokes from popping).
  const tl = screenToWorld(0, 0, viewport, canvasSize);
  const br = screenToWorld(canvasSize.width, canvasSize.height, viewport, canvasSize);
  const margin = 1;
  const view: ViewRect = {
    minX: Math.min(tl.x, br.x) - margin,
    maxX: Math.max(tl.x, br.x) + margin,
    minY: Math.min(tl.y, br.y) - margin,
    maxY: Math.max(tl.y, br.y) + margin,
  };

  // Painter's order matches the SVG: grid → board → traces (per layer) → pads
  // → vias → components → silkscreen lines → silkscreen text.
  drawGrid(ctx, viewport, canvasSize);
  drawBoard(ctx, model, viewport);
  drawTraces(ctx, model, view, opts);
  drawPads(ctx, model, viewport, view, opts);
  drawVias(ctx, model, viewport, view, opts);
  drawComponents(ctx, model, viewport, view, opts);
  drawSilkscreen(ctx, model, viewport, view, opts);

  // Leave the transform reset so a stray follow-up draw can't inherit the
  // world matrix.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ─── Grid ───────────────────────────────────────────────────────────────────

function drawGrid(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  canvasSize: CanvasSize
): void {
  // Skip the grid when too zoomed-out (would be a hash of lines).
  if (viewport.scale < 12) return;
  const tl = screenToWorld(0, 0, viewport, canvasSize);
  const br = screenToWorld(canvasSize.width, canvasSize.height, viewport, canvasSize);
  const minX = Math.min(tl.x, br.x);
  const maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y);
  const maxY = Math.max(tl.y, br.y);
  const lineWidth = 0.5 / viewport.scale; // non-scaling: 0.5 screen px

  // Fine grid only when zoomed in enough to actually see it.
  if (viewport.scale >= 60) {
    ctx.beginPath();
    const firstFineX = Math.ceil(minX / GRID_FINE_MM) * GRID_FINE_MM;
    for (let x = firstFineX; x <= maxX; x += GRID_FINE_MM) {
      if (Math.abs((x / GRID_COARSE_MM) % 1) < 1e-3) continue; // skip coarse-aligned
      ctx.moveTo(x, minY);
      ctx.lineTo(x, maxY);
    }
    const firstFineY = Math.ceil(minY / GRID_FINE_MM) * GRID_FINE_MM;
    for (let y = firstFineY; y <= maxY; y += GRID_FINE_MM) {
      if (Math.abs((y / GRID_COARSE_MM) % 1) < 1e-3) continue;
      ctx.moveTo(minX, y);
      ctx.lineTo(maxX, y);
    }
    ctx.strokeStyle = COLOR_GRID_FINE;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  ctx.beginPath();
  const firstCoarseX = Math.ceil(minX / GRID_COARSE_MM) * GRID_COARSE_MM;
  for (let x = firstCoarseX; x <= maxX; x += GRID_COARSE_MM) {
    ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
  }
  const firstCoarseY = Math.ceil(minY / GRID_COARSE_MM) * GRID_COARSE_MM;
  for (let y = firstCoarseY; y <= maxY; y += GRID_COARSE_MM) {
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
  }
  ctx.strokeStyle = COLOR_GRID_COARSE;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

// ─── Board ──────────────────────────────────────────────────────────────────

function drawBoard(
  ctx: CanvasRenderingContext2D,
  model: PcbModel,
  viewport: Viewport
): void {
  const board = model.board;
  if (!board) return;
  const x = board.centerX - board.width / 2;
  const y = board.centerY - board.height / 2;
  ctx.beginPath();
  roundRectPath(ctx, x, y, board.width, board.height, 0.5);
  ctx.fillStyle = COLOR_BOARD_FILL;
  ctx.fill();
  ctx.strokeStyle = COLOR_BOARD_BORDER;
  ctx.lineWidth = 0.15 / viewport.scale; // non-scaling
  ctx.stroke();
}

// ─── Traces ─────────────────────────────────────────────────────────────────

function drawTraces(
  ctx: CanvasRenderingContext2D,
  model: PcbModel,
  view: ViewRect,
  opts: DrawPcbOptions
): void {
  const { orderedLayers, focusedNetSelectors } = opts;
  const netFocus = focusedNetSelectors !== null;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const layer of orderedLayers) {
    // Bucket this layer's visible segments by (width, alpha) so each batch is a
    // single stroke. Distinct widths are few (the trace-width profiles) and
    // alpha is just dimmed-or-not, so this collapses thousands of SVG nodes
    // into a handful of stroke calls.
    const buckets = new Map<
      string,
      { width: number; alpha: number; segs: PcbModel["traces"][number]["segments"] }
    >();
    for (const trace of model.traces) {
      const dim = netFocus && !isTraceOnNet(trace.key, focusedNetSelectors!);
      const alpha = dim ? DIMMED_OPACITY : 1;
      for (const seg of trace.segments) {
        if (seg.layer !== layer.id) continue;
        const sMinX = Math.min(seg.fromX, seg.toX);
        const sMaxX = Math.max(seg.fromX, seg.toX);
        const sMinY = Math.min(seg.fromY, seg.toY);
        const sMaxY = Math.max(seg.fromY, seg.toY);
        if (!rectsIntersect(sMinX, sMinY, sMaxX, sMaxY, view)) continue;
        const key = `${seg.width}|${alpha}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, (bucket = { width: seg.width, alpha, segs: [] }));
        bucket.segs.push(seg);
      }
    }
    if (buckets.size === 0) continue;
    ctx.strokeStyle = getLayerColor(layer.id);
    for (const bucket of buckets.values()) {
      ctx.globalAlpha = bucket.alpha;
      ctx.lineWidth = bucket.width;
      ctx.beginPath();
      for (const seg of bucket.segs) {
        ctx.moveTo(seg.fromX, seg.fromY);
        ctx.lineTo(seg.toX, seg.toY);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// ─── Pads ───────────────────────────────────────────────────────────────────

function drawPads(
  ctx: CanvasRenderingContext2D,
  model: PcbModel,
  viewport: Viewport,
  view: ViewRect,
  opts: DrawPcbOptions
): void {
  const { isPadVisible, focusedNetSelectors } = opts;
  const netFocus = focusedNetSelectors !== null;
  // Base (non-selected) pad stroke — selection halos are the overlay's job.
  const strokeWidth = 0.04 / viewport.scale; // non-scaling
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = strokeWidth;

  for (const pad of model.pads) {
    if (!isPadVisible(pad)) continue;
    if (!padInView(pad, view)) continue;
    const dim = netFocus && !isPadOnNet(pad, model, focusedNetSelectors!);
    ctx.globalAlpha = dim ? DIMMED_OPACITY : 1;
    ctx.fillStyle = pad.isThroughHole ? COLOR_TH_PAD : getLayerColor(pad.layer);
    ctx.lineWidth = strokeWidth;

    if (pad.isThroughHole) {
      // Pad first — circular annular ring, or the rect/pill pad tscircuit
      // puts around pin 1 of through-hole footprints — then the drill on top.
      ctx.save();
      ctx.translate(pad.x, pad.y);
      ctx.rotate(pad.rotationDeg * DEG);
      ctx.beginPath();
      if (pad.shape === "rect" || pad.shape === "pill") {
        const w = pad.rectWidth ?? 1;
        const h = pad.rectHeight ?? 1;
        const r = pad.pillRadius ?? (pad.shape === "pill" ? 0.2 : 0);
        if (r > 0) roundRectPath(ctx, -w / 2, -h / 2, w, h, r);
        else ctx.rect(-w / 2, -h / 2, w, h);
      } else {
        ctx.arc(0, 0, (pad.outerDiameter ?? 0.8) / 2, 0, TAU);
      }
      ctx.fill();
      ctx.stroke();
      const ox = pad.drillOffsetX ?? 0;
      const oy = pad.drillOffsetY ?? 0;
      ctx.fillStyle = COLOR_HOLE;
      ctx.beginPath();
      if (pad.drillWidth !== undefined && pad.drillHeight !== undefined) {
        // Slot drill renders as a pill.
        roundRectPath(
          ctx,
          ox - pad.drillWidth / 2,
          oy - pad.drillHeight / 2,
          pad.drillWidth,
          pad.drillHeight,
          Math.min(pad.drillWidth, pad.drillHeight) / 2
        );
      } else {
        ctx.arc(ox, oy, (pad.drillDiameter ?? 0.3) / 2, 0, TAU);
      }
      ctx.fill();
      ctx.restore();
      continue;
    }

    if (pad.shape === "circle") {
      ctx.beginPath();
      ctx.arc(pad.x, pad.y, pad.radius ?? 0.5, 0, TAU);
      ctx.fill();
      ctx.stroke();
      continue;
    }

    if (pad.shape === "rect" || pad.shape === "pill") {
      const w = pad.rectWidth ?? 1;
      const h = pad.rectHeight ?? 1;
      const r = pad.shape === "pill" ? pad.pillRadius ?? 0.2 : 0;
      // Draw axis-aligned in the pad's local frame, then translate+rotate into
      // world — keeps a resistor pad's long axis glued to the rotated body.
      ctx.save();
      ctx.translate(pad.x, pad.y);
      ctx.rotate(pad.rotationDeg * DEG);
      ctx.beginPath();
      if (r > 0) roundRectPath(ctx, -w / 2, -h / 2, w, h, r);
      else ctx.rect(-w / 2, -h / 2, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      continue;
    }

    if (pad.shape === "polygon" && pad.polygonPoints && pad.polygonPoints.length > 0) {
      ctx.beginPath();
      pad.polygonPoints.forEach((p, i) =>
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
      );
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      continue;
    }
  }
  ctx.globalAlpha = 1;
}

function padInView(pad: PcbPadRecord, view: ViewRect): boolean {
  // Conservative half-extent: largest of the shape's spans.
  const half =
    pad.shape === "circle"
      ? pad.radius ?? (pad.outerDiameter ?? 0.8) / 2
      : Math.max(pad.rectWidth ?? 1, pad.rectHeight ?? 1);
  return rectsIntersect(
    pad.x - half,
    pad.y - half,
    pad.x + half,
    pad.y + half,
    view
  );
}

// ─── Vias ───────────────────────────────────────────────────────────────────

function drawVias(
  ctx: CanvasRenderingContext2D,
  model: PcbModel,
  viewport: Viewport,
  view: ViewRect,
  opts: DrawPcbOptions
): void {
  const { isViaVisible } = opts;
  const ringStroke = 0.05 / viewport.scale; // non-scaling
  for (const via of allVias(model)) {
    if (!isViaVisible(via)) continue;
    const r = via.outerDiameter / 2;
    if (!rectsIntersect(via.x - r, via.y - r, via.x + r, via.y + r, view)) continue;
    ctx.beginPath();
    ctx.arc(via.x, via.y, r, 0, TAU);
    ctx.fillStyle = COLOR_VIA;
    ctx.fill();
    ctx.strokeStyle = COLOR_VIA_STROKE;
    ctx.lineWidth = ringStroke;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(via.x, via.y, via.drillDiameter / 2, 0, TAU);
    ctx.fillStyle = COLOR_HOLE;
    ctx.fill();
  }
}

function allVias(model: PcbModel): PcbViaRecord[] {
  const out = [...model.vias];
  for (const trace of model.traces) out.push(...trace.vias);
  return out;
}

// ─── Components ─────────────────────────────────────────────────────────────

function drawComponents(
  ctx: CanvasRenderingContext2D,
  model: PcbModel,
  viewport: Viewport,
  view: ViewRect,
  opts: DrawPcbOptions
): void {
  const {
    isLayerOn,
    focusedNet,
    focusedNetSelectors,
    chipLikeNames,
    pin1ByCompKey,
    padCountByCompKey,
  } = opts;
  const netFocus = focusedNetSelectors !== null;
  const bodyStroke = 0.06 / viewport.scale; // non-scaling 0.06 screen px

  for (const comp of model.components) {
    if (!isLayerOn(comp.layer)) continue;

    const display = comp.displayBbox ?? pcbComponentDisplayBbox(comp, model.pads);
    const reach = Math.hypot(display.width, display.height) / 2;
    if (!rectsIntersect(comp.x - reach, comp.y - reach, comp.x + reach, comp.y + reach, view))
      continue;

    const dim = netFocus && !focusedNet!.pads.some((p) => p.componentKey === comp.key);
    const placementOpacity = comp.manuallyPlaced ? 1 : 0.85;
    const alpha = (dim ? DIMMED_OPACITY : 1) * placementOpacity;
    const showOutline =
      chipLikeNames.has(comp.name) || (padCountByCompKey.get(comp.key) ?? 0) > 2;

    if (!showOutline) {
      // Two-terminal passive: the pads show the footprint and the real
      // silkscreen (designator + outline, drawn by drawSilkscreen) is the
      // whole picture — the body layer adds nothing.
      continue;
    }

    // When the footprint ships real silkscreen (body outline + pin-1 art),
    // draw only the subtle courtyard fill as the part's click-target cue —
    // a synthetic outline + notch on top of the true outline read as a
    // "double body" and the pad-derived box is far wider than the part.
    const pin1 =
      !comp.hasSilkscreenOutline && chipLikeNames.has(comp.name)
        ? pin1ByCompKey.get(comp.key) ?? null
        : null;
    const notch = comp.hasSilkscreenOutline
      ? null
      : pickNotch(comp, pin1, display.width, display.height, display.rotationDeg);
    const fill =
      comp.layer === BOTTOM_LAYER_ID
        ? "rgba(59, 130, 246, 0.08)"
        : "rgba(239, 68, 68, 0.06)";

    // Body courtyard, drawn in the part's rotated local frame.
    ctx.save();
    ctx.translate(comp.x, comp.y);
    ctx.rotate(display.rotationDeg * DEG);
    ctx.globalAlpha = alpha;
    const path = new Path2D(bodyPathD(display.width, display.height, notch));
    ctx.fillStyle = fill;
    ctx.fill(path);
    if (!comp.hasSilkscreenOutline) {
      ctx.strokeStyle = "rgba(180,190,210,0.45)";
      ctx.lineWidth = bodyStroke;
      ctx.stroke(path);
    }
    ctx.restore();

    // No synthetic designator label — the real footprint silkscreen (drawn by
    // drawSilkscreen) carries the reference designator, matching tscircuit /
    // Altium.
  }
  ctx.globalAlpha = 1;
}

// ─── Silkscreen ─────────────────────────────────────────────────────────────

function drawSilkscreen(
  ctx: CanvasRenderingContext2D,
  model: PcbModel,
  viewport: Viewport,
  view: ViewRect,
  opts: DrawPcbOptions
): void {
  const { isLayerOn } = opts;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Real silkscreen widths are mm and scale with zoom like traces do — the
  // old renderer treated stroke_width as a non-scaling screen-px width, which
  // turned 0.1mm footprint art into invisible 0.1px hairlines. Floor at 1
  // screen px so outlines stay legible when zoomed way out.
  const minWidth = 1 / viewport.scale;

  // Closed shapes (rects / circles / pills / ovals) — pin-1 dots, body boxes.
  ctx.globalAlpha = 0.85;
  for (const shape of model.silkscreenShapes) {
    if (!isLayerOn(shape.layer)) continue;
    const reach = (Math.hypot(shape.width, shape.height) + shape.strokeWidth) / 2;
    if (
      !rectsIntersect(shape.x - reach, shape.y - reach, shape.x + reach, shape.y + reach, view)
    )
      continue;
    const color = getLayerColor(shape.layer);
    ctx.save();
    ctx.translate(shape.x, shape.y);
    if (shape.rotationDeg !== 0) ctx.rotate(shape.rotationDeg * DEG);
    ctx.beginPath();
    if (shape.kind === "circle" || shape.kind === "oval") {
      ctx.ellipse(0, 0, shape.width / 2, shape.height / 2, 0, 0, TAU);
    } else {
      const r =
        shape.kind === "pill"
          ? Math.min(shape.width, shape.height) / 2
          : shape.cornerRadius;
      if (r > 0)
        roundRectPath(ctx, -shape.width / 2, -shape.height / 2, shape.width, shape.height, r);
      else ctx.rect(-shape.width / 2, -shape.height / 2, shape.width, shape.height);
    }
    if (shape.filled) {
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (shape.strokeWidth > 0) {
      if (shape.dashed) ctx.setLineDash([0.4, 0.3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(shape.strokeWidth, minWidth);
      ctx.stroke();
      if (shape.dashed) ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Lines — bucketed by (layer, width) so each batch is one stroke.
  const lineBuckets = new Map<
    string,
    { layer: LayerId; width: number; lines: PcbModel["silkscreenLines"] }
  >();
  for (const line of model.silkscreenLines) {
    if (!isLayerOn(line.layer)) continue;
    const minX = Math.min(line.x1, line.x2);
    const maxX = Math.max(line.x1, line.x2);
    const minY = Math.min(line.y1, line.y2);
    const maxY = Math.max(line.y1, line.y2);
    if (!rectsIntersect(minX, minY, maxX, maxY, view)) continue;
    const key = `${line.layer}|${line.width}`;
    let bucket = lineBuckets.get(key);
    if (!bucket)
      lineBuckets.set(key, (bucket = { layer: line.layer, width: line.width, lines: [] }));
    bucket.lines.push(line);
  }
  for (const bucket of lineBuckets.values()) {
    ctx.strokeStyle = getLayerColor(bucket.layer);
    ctx.lineWidth = Math.max(bucket.width, minWidth);
    ctx.beginPath();
    for (const line of bucket.lines) {
      ctx.moveTo(line.x1, line.y1);
      ctx.lineTo(line.x2, line.y2);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Text — scales with zoom (mm font), un-flipped + rotated per the SVG.
  for (const tx of model.silkscreenTexts) {
    if (!isLayerOn(tx.layer)) continue;
    const align: CanvasTextAlign =
      tx.anchor === "center" ? "center" : tx.anchor === "right" ? "right" : "left";
    drawLabel(
      ctx,
      tx.x,
      tx.y,
      tx.text,
      tx.fontSize,
      getLayerColor(tx.layer),
      align,
      0.7,
      tx.rotationDeg,
      tx.anchorV,
      tx.mirrored
    );
  }
}

// ─── Text helper ────────────────────────────────────────────────────────────

// Draw monospace text at a world point. The global stage transform flips Y
// (scale(s,-s)); canvas text would render upside-down + mirrored, so we
// re-apply the SVG's `scale(1,-1) rotate(-deg)` locally to put glyphs upright.
// Order matches the SVG transform exactly: translate → scale(1,-1) → rotate.
function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  fontSizeMm: number,
  fill: string,
  align: CanvasTextAlign,
  alpha: number,
  rotationDeg = 0,
  baseline: "top" | "middle" | "bottom" = "middle",
  mirrored = false
): void {
  ctx.save();
  ctx.translate(x, y);
  // Mirrored silkscreen text (bottom layer) flips horizontally so it reads
  // correctly when the board is viewed from the back.
  ctx.scale(mirrored ? -1 : 1, -1);
  if (rotationDeg !== 0) ctx.rotate(-rotationDeg * DEG);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.font = `${fontSizeMm}px ${MONO_FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// ─── Component body shape (shared with the SVG ComponentBody overlay) ────────

export type NotchSide = "top" | "bottom" | "left" | "right";

// Trace the body outline as an SVG path string. With no notch this is a
// rounded-corner-free rectangle; with a notch a semicircle is bitten out of the
// requested edge (DIP-style pin-1 marker). Consumed both here (via Path2D) and
// by PcbCanvas's SVG ComponentBody, so the courtyard reads identically on the
// canvas base layer and the selection/hover overlay.
export function bodyPathD(
  width: number,
  height: number,
  notch: { side: NotchSide; radius: number } | null
): string {
  const w2 = width / 2;
  const h2 = height / 2;
  if (!notch) {
    return `M ${-w2} ${-h2} L ${w2} ${-h2} L ${w2} ${h2} L ${-w2} ${h2} Z`;
  }
  const r = notch.radius;
  // The body group lives inside the stage's scale(1,-1) y-flip, so SVG arc
  // sweep directions are inverted from "normal": sweep=0 here bulges into the
  // rect for a notch. Canvas Path2D follows the same SVG arc grammar under the
  // same flipped CTM, so the bite lands the same way.
  switch (notch.side) {
    case "top":
      return `M ${-w2} ${-h2} L ${w2} ${-h2} L ${w2} ${h2} L ${r} ${h2} A ${r} ${r} 0 0 0 ${-r} ${h2} L ${-w2} ${h2} Z`;
    case "bottom":
      return `M ${-w2} ${-h2} L ${-r} ${-h2} A ${r} ${r} 0 0 0 ${r} ${-h2} L ${w2} ${-h2} L ${w2} ${h2} L ${-w2} ${h2} Z`;
    case "right":
      return `M ${-w2} ${-h2} L ${w2} ${-h2} L ${w2} ${-r} A ${r} ${r} 0 0 0 ${w2} ${r} L ${w2} ${h2} L ${-w2} ${h2} Z`;
    case "left":
      return `M ${-w2} ${-h2} L ${w2} ${-h2} L ${w2} ${h2} L ${-w2} ${h2} L ${-w2} ${r} A ${r} ${r} 0 0 0 ${-w2} ${-r} Z`;
  }
}

// Project pin 1 into the body's local frame and pick the edge it sits closest
// to — that's where the notch goes. Uses the same rotation as the rendered
// courtyard (from pad-derived bounds), not sidecar delta alone.
export function pickNotch(
  comp: PcbComponentRecord,
  pin1: PcbPadRecord | null,
  renderW: number,
  renderH: number,
  renderRotationDeg: number
): { side: NotchSide; radius: number } | null {
  if (!pin1) return null;
  const wdx = pin1.x - comp.x;
  const wdy = pin1.y - comp.y;
  if (Math.hypot(wdx, wdy) < 1e-6) return null;
  const rotRad = renderRotationDeg * DEG;
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);
  // World → body local: undo the courtyard group rotation.
  const lx = cos * wdx + sin * wdy;
  const ly = -sin * wdx + cos * wdy;
  const halfW = renderW / 2;
  const halfH = renderH / 2;
  const side: NotchSide =
    Math.abs(lx) / halfW > Math.abs(ly) / halfH
      ? lx > 0
        ? "right"
        : "left"
      : ly > 0
        ? "top"
        : "bottom";
  const radius = Math.max(0.18, Math.min(1.2, Math.min(renderW, renderH) * 0.18));
  return { side, radius };
}
