// PcbCanvas — standalone PCB editor canvas.
//
// Replaces @tscircuit/pcb-viewer for the PCB tab. Mirrors the schematic
// editor's architecture:
//   - Pure model: `pcbModel.ts` turns (circuitJson + tsx + manualEdits)
//     into a renderable structure. Re-built on every memo dependency
//     change; no internal state.
//   - SVG-based renderer with mm world coords, Y-up, scale in px/mm.
//   - editorStore owns selection, viewport, layers, tools, route draft.
//   - manualEdits sidecar owns physical placement + routed trace
//     geometry; tsx stays connectivity-only.
//
// Rendering technology note: we use SVG (same as the schematic editor)
// rather than Pixi/WebGL. SVG handles typical Cherry Blossom workloads
// (a few hundred pads/traces) comfortably under 16ms/frame; the
// schematic editor proves the pattern works at this scale. The model,
// hit-test, tools, and ratsnest are all renderer-agnostic, so a future
// migration to Pixi/WebGL for ≥5k-element boards is a localized swap
// of this file only.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCircuitStore } from "@/store/circuitStore";
import { useEditorStore } from "@/editor/state/editorStore";
import {
  buildPcbModel,
  pcbComponentDisplayBbox,
  withAutoPlacedPins,
  type PcbComponentRecord,
  type PcbModel,
  type PcbPadRecord,
  type PcbTraceRecord,
  type PcbTraceSegment,
  type UnroutedNet,
  padWorldCorners,
} from "./pcbModel";
import { computeRatsnest, type RatsnestEdge } from "./ratsnest";
import {
  findNetContainingSelector,
  findUserRouteAtPad,
  isPadOnNet,
  isTraceOnNet,
  selectorsOnNet,
} from "./routeAssist";
import {
  autoPosture,
  leaderPath,
  leaderShape,
  leaderLengthMm,
  polylineLengthMm,
  swapPosture,
  tessellateLeader,
  CORNER_RADIUS_STEP_MM,
  LEADER_DIRECT,
  LEADER_NONE,
  POSTURE_TRAVEL_SAMPLES,
} from "./routeLeader";
import {
  DEFAULT_BOARD_CLEARANCES,
  clearanceHaloWidthMm,
} from "./routeClearance";
import {
  buildRouteObstacles,
  obstacleSetKey,
  segmentHitsHard,
  type BuildObstaclesOpts,
  type RouteObstacleSet,
} from "./routeGraph";
import {
  SOLVE_BUDGET_MS,
  SOLVE_MIN_DELTA_MM,
  createWalkaroundStore,
  offerSolution,
  readWalkaround,
  resetWalkaroundStore,
  solveWalkaround,
} from "./routeSolver";
import { routeLive } from "./routeLive";
import { REJECT_FLASH_MS, drawRouteOverlay } from "./routeOverlayDraw";
import { nextViolationIndex, type DrcViolation } from "./drc";
import {
  TOP_LAYER_ID,
  copperLayersForCount,
  getLayer,
  getLayerColor,
  isCopperLayer,
  layersForCount,
  DEFAULT_TRACE_WIDTH_MM,
  profileForWidth,
  routingModeLabel,
} from "./layers";
import { findNearestPad, hitTestPoint, hitTestRect } from "./hitTest";
import {
  pinchAnchor,
  pinchViewport,
  pointerDistance,
  screenToWorld,
  tolerancesFor,
  zoomAboutPoint,
  type CanvasTolerances,
  type PinchAnchor,
  type ScreenPoint,
  type Viewport,
} from "./canvasGestures";
import { drawPcb, bodyPathD, pickNotch } from "./pcbCanvasDraw";
import {
  COLOR_BG,
  COLOR_HOLE,
  COLOR_TH_PAD,
  COLOR_SELECTED,
  COLOR_HOVER,
  COLOR_RATSNEST,
  COLOR_DRC,
  GRID_FINE_MM,
  DIMMED_OPACITY,
} from "./pcbColors";
import { LayerPanel } from "./LayerPanel";
import { PcbToolbar } from "./PcbToolbar";
import { StatusBar } from "./StatusBar";
import {
  registerShortcuts,
  isTypingTarget,
} from "@/editor/shared/keyboard";
import { snapToGrid, rectFromPoints, type Point } from "@/editor/shared/snap";
import type {
  LayerId,
  PcbEdit,
  PcbRouteDraft,
  PcbRoutePoint,
  PcbRoutingMode,
  RoutePosture,
  StableKey,
} from "@/editor/shared/types";
import { extractComponentsCached } from "@/utils/tsxTransform";
import { isChipLike } from "@/editor/schematic/symbols";
import { canonEndpoint, connectionId } from "@/editor/shared/connectionId";
import { CircuitLoading } from "@/components/CircuitLoading";
import { useIsCompact, useIsTouch } from "@/hooks/useViewport";
import { toast } from "sonner";

// ─── Visual constants ─────────────────────────────────────────────────────────

// px/mm floor. Low enough that `fitViewportToModel` can still frame a big board
// (200×150mm) inside a ~390px phone canvas:
// 200mm × 1.15 padding needs ~1.7 px/mm there, so a 5 px/mm floor would clamp
// the fit and leave the board cropped with no way to zoom out.
const MIN_SCALE = 1.5;
const MAX_SCALE = 400;
const SCALE_LIMITS = { min: MIN_SCALE, max: MAX_SCALE };
const DEFAULT_SCALE = 25; // px per mm — pcb is denser than schematic
const ZOOM_SENSITIVITY_PX = 0.0015;
// Minimum zoom (px/mm) when focusing a DRC violation, so a tiny clearance
// marker is legible even if the user was fully zoomed out.
const DRC_FOCUS_MIN_SCALE = 25;

function pcbEditWithoutRoute(pcb: PcbEdit): PcbEdit | null {
  const { route: _route, width: _width, ...rest } = pcb;
  return Object.keys(rest).length > 0 ? rest : null;
}

// Restore-to-autoroute variant: also drops the noAutoroute deletion marker so
// the autorouter's copper shows again for the connection.
function pcbEditWithoutRouteState(pcb: PcbEdit): PcbEdit | null {
  const { noAutoroute: _del, ...rest } = pcbEditWithoutRoute(pcb) ?? {};
  return Object.keys(rest).length > 0 ? rest : null;
}

// Every pad-pair connection id on a net — the key space route edits (manual
// routes and noAutoroute deletions) are stored under.
function netConnIds(net: UnroutedNet): StableKey[] {
  const sels = net.pads.map((p) => p.selector);
  const out: StableKey[] = [];
  for (let i = 0; i < sels.length; i++) {
    for (let j = i + 1; j < sels.length; j++) {
      out.push(connectionId(sels[i], sels[j]));
    }
  }
  return out;
}

// Visual constants (colors + grid pitch) are shared with the canvas draw layer
// via `pcbColors.ts` so the SVG overlay and the imperative renderer stay in
// lockstep.

// ─── Live routing frame ───────────────────────────────────────────────────────
// Everything the rAF flush needs, refreshed by an effect. The flush reads THIS
// and never React state, which is what lets it run outside the render cycle.

interface RouteFrameCtx {
  model: PcbModel;
  viewport: Viewport;
  canvasSize: { width: number; height: number };
  dpr: number;
  /** Page-space origin of the <svg>, so client coords convert without a layout read. */
  originX: number;
  originY: number;
  tol: CanvasTolerances;
  numLayers: number;
  routingMode: PcbRoutingMode;
  netSelectors: ReadonlySet<string> | null;
  /**
   * Pads whose copper the route is allowed to land on. This is the focused net
   * PLUS the draft's own endpoints, which matters even when the start pad is on
   * no net at all: without it the route begins inside a wall and the solver
   * reports `blocked` on its very first frame. Kept separate from
   * `netSelectors`, which decides wrong-net click rejection and endpoint
   * magnets — a netless pad must not make every other pad "foreign".
   */
  obstacleExcludeSelectors: ReadonlySet<string>;
  isLayerOn: (layer: LayerId) => boolean;
  haloVisible: boolean;
}

interface PointerFrame {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  valid: boolean;
}

/** What the cursor magnet landed on this frame, for the click that follows. */
interface SnapTarget {
  /** Null when the pad carries no pcb_port and so cannot terminate a route. */
  selector: string | null;
  x: number;
  y: number;
  layer: LayerId;
  isThroughHole: boolean;
  foreignNet: boolean;
}

interface SnapResult {
  x: number;
  y: number;
  target: SnapTarget | null;
}

const EMPTY_SELECTORS: ReadonlySet<string> = new Set<string>();
// One result object, reused: this runs on every animation frame of a drag.
const snapResult: SnapResult = { x: 0, y: 0, target: null };

// Snap the raw pointer, in Altium's priority order: object snapping overrides
// the grid, Shift suppresses object snapping, Ctrl/Cmd suppresses the grid. The
// radius is a PIXEL budget divided by scale, so the magnet feels the same size
// at every zoom. Modifiers come off the pointer event, never off React state, so
// a key held mid-drag takes effect on the very next frame.
function snapCursorTarget(
  ctx: RouteFrameCtx,
  draft: PcbRouteDraft,
  anchor: PcbRoutePoint,
  pf: PointerFrame
): SnapResult {
  snapResult.target = null;
  if (!pf.valid) {
    snapResult.x = anchor.x;
    snapResult.y = anchor.y;
    return snapResult;
  }
  const world = screenToWorld(
    pf.clientX - ctx.originX,
    pf.clientY - ctx.originY,
    ctx.viewport,
    ctx.canvasSize
  );
  const radiusMm = ctx.tol.snapPadPx / ctx.viewport.scale;
  if (!pf.shiftKey) {
    const pad = findNearestPad(
      ctx.model,
      world.x,
      world.y,
      draft.activeLayer,
      radiusMm
    );
    if (pad) {
      const selector = ctx.model.selectorByPad.get(pad) ?? null;
      snapResult.x = pad.x;
      snapResult.y = pad.y;
      snapResult.target = {
        selector: pad.pcbPortId ? selector : null,
        x: pad.x,
        y: pad.y,
        layer: pad.layer,
        isThroughHole: pad.isThroughHole,
        foreignNet:
          ctx.netSelectors !== null &&
          !isPadOnNet(pad, ctx.model, ctx.netSelectors),
      };
      return snapResult;
    }
    const end = nearestRouteEndpoint(ctx, world, draft, radiusMm);
    if (end) {
      snapResult.x = end.x;
      snapResult.y = end.y;
      return snapResult;
    }
  }
  if (pf.ctrlKey) {
    snapResult.x = world.x;
    snapResult.y = world.y;
  } else {
    const g = snapToGrid(world, GRID_FINE_MM);
    snapResult.x = g.x;
    snapResult.y = g.y;
  }
  return snapResult;
}

// Free end of an existing user route on the same net — the second magnet, so a
// route can be continued from where another one stopped.
function nearestRouteEndpoint(
  ctx: RouteFrameCtx,
  world: Point,
  draft: PcbRouteDraft,
  radiusMm: number
): Point | null {
  if (!ctx.netSelectors) return null;
  let best: Point | null = null;
  let bestD2 = radiusMm * radiusMm;
  for (const trace of ctx.model.traces) {
    if (!trace.userRouted) continue;
    if (trace.key === draft.traceKey) continue;
    if (!isTraceOnNet(trace.key, ctx.netSelectors)) continue;
    for (const seg of trace.segments) {
      if (seg.layer !== draft.activeLayer) continue;
      for (const p of [
        { x: seg.fromX, y: seg.fromY },
        { x: seg.toX, y: seg.toY },
      ]) {
        const d2 = (p.x - world.x) ** 2 + (p.y - world.y) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
      }
    }
  }
  return best;
}

// World AABB of the pad a draft started on — the auto-posture long-edge rule.
function startPadBox(
  model: PcbModel,
  fromSelector: string
): { width: number; height: number } | null {
  const pad = model.padBySelector.get(canonEndpoint(fromSelector));
  if (!pad) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of padWorldCorners(pad)) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { width: maxX - minX, height: maxY - minY };
}

/** The preview vertices AFTER the anchor — exactly what a click commits. */
function previewTailPoints(snap: {
  previewX: Float64Array;
  previewY: Float64Array;
  previewLen: number;
}): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < snap.previewLen; i++) {
    out.push({ x: snap.previewX[i], y: snap.previewY[i] });
  }
  return out;
}

// Does either leg of this posture's leader run through copper? `curved` is tested
// on its un-filleted diag45 geometry, exactly as the solver does — the fillet
// lies strictly inside the corner and can only reduce penetration.
const postureProbe: Point = { x: 0, y: 0 };
function postureCollides(
  obstacles: RouteObstacleSet,
  a: Point,
  c: Point,
  mode: PcbRoutingMode,
  posture: RoutePosture
): boolean {
  const straight = mode === "curved" ? "diag45" : mode;
  const verdict = leaderShape(a.x, a.y, c.x, c.y, straight, posture, postureProbe);
  if (verdict === LEADER_NONE) return false;
  if (verdict === LEADER_DIRECT) {
    return segmentHitsHard(obstacles, a.x, a.y, postureProbe.x, postureProbe.y);
  }
  return (
    segmentHitsHard(obstacles, a.x, a.y, postureProbe.x, postureProbe.y) ||
    segmentHitsHard(obstacles, postureProbe.x, postureProbe.y, c.x, c.y)
  );
}

function offAxisOffDiagonal(a: Point, c: Point): boolean {
  const dx = Math.abs(c.x - a.x);
  const dy = Math.abs(c.y - a.y);
  return dx > 0.05 && dy > 0.05 && Math.abs(dx - dy) > 0.05;
}

// A dangling stub still has to belong to a connection, because that is what the
// sidecar keys route geometry by. Adopt the nearest OTHER pad on the routed net:
// that is the connection the user was part-way through drawing.
function stubConnectionKey(
  model: PcbModel,
  fromSelector: string,
  tail: ReadonlyArray<Point>
): StableKey | null {
  const net = findNetContainingSelector(model, fromSelector);
  if (!net) return null;
  const end = tail[tail.length - 1];
  const from = canonEndpoint(fromSelector);
  let best: string | null = null;
  let bestD2 = Infinity;
  for (const p of net.pads) {
    if (canonEndpoint(p.selector) === from) continue;
    const d2 = end ? (p.x - end.x) ** 2 + (p.y - end.y) ** 2 : 0;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p.selector;
    }
  }
  return best ? connectionId(fromSelector, best) : null;
}

// ─── World ↔ screen transforms ───────────────────────────────────────────────
// `Viewport` + `screenToWorld` live in canvasGestures.ts alongside the pinch
// math, so the pointer transforms and the gesture transforms can't drift apart.

function fitViewportToModel(
  model: PcbModel,
  canvas: { width: number; height: number },
  padding = 1.15
): Viewport {
  // Prefer the board outline; fall back to model bbox; fall back to
  // identity. The board is the natural framing for a PCB editor.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (model.board) {
    minX = model.board.centerX - model.board.width / 2;
    minY = model.board.centerY - model.board.height / 2;
    maxX = model.board.centerX + model.board.width / 2;
    maxY = model.board.centerY + model.board.height / 2;
  } else {
    for (const c of model.components) {
      minX = Math.min(minX, c.x - c.width / 2);
      minY = Math.min(minY, c.y - c.height / 2);
      maxX = Math.max(maxX, c.x + c.width / 2);
      maxY = Math.max(maxY, c.y + c.height / 2);
    }
    for (const p of model.pads) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { x: 0, y: 0, scale: DEFAULT_SCALE };
  }
  const w = (maxX - minX) * padding || 50;
  const h = (maxY - minY) * padding || 50;
  const sx = canvas.width / w;
  const sy = canvas.height / h;
  const scale = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, Math.min(sx, sy))
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Translate so world (cx, cy) lands at the canvas center. World Y is
  // up, screen Y is down; we apply scale(scale, -scale) at render time.
  return {
    x: -cx * scale,
    y: cy * scale,
    scale,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PcbCanvas() {
  // tsxCode + manualEdits + circuitJson + activeTab + toolMode etc.
  const tsxCode = useCircuitStore((s) => s.tsxCode);
  const circuitJson = useCircuitStore((s) => s.circuitJson);
  const drcViolations = useCircuitStore((s) => s.drcViolations);
  const manualEdits = useEditorStore((s) => s.manualEdits);
  const viewport = useEditorStore((s) => s.viewport.pcb);
  const setViewport = useEditorStore((s) => s.setViewport);
  const selectedKeys = useEditorStore((s) => s.selectedKeys);
  const setSelection = useEditorStore((s) => s.setSelection);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const toggleSelection = useEditorStore((s) => s.toggleSelection);
  const setHoveredKey = useEditorStore((s) => s.setHoveredKey);
  const hoveredKey = useEditorStore((s) => s.hoveredKey);
  const setPcbCursorMm = useEditorStore((s) => s.setPcbCursorMm);
  const activeLayer = useEditorStore((s) => s.activeLayer);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const layerVisibility = useEditorStore((s) => s.layerVisibility);
  const toolMode = useEditorStore((s) => s.toolMode);
  const setToolMode = useEditorStore((s) => s.setToolMode);
  const setPcbEdit = useEditorStore((s) => s.setPcbEdit);
  const setPcbEdits = useEditorStore((s) => s.setPcbEdits);
  const traceWidth = useEditorStore((s) => s.traceWidth);
  const cycleTraceWidth = useEditorStore((s) => s.cycleTraceWidth);
  const routingMode = useEditorStore((s) => s.routingMode);
  const cycleRoutingMode = useEditorStore((s) => s.cycleRoutingMode);
  const setRoutingMode = useEditorStore((s) => s.setRoutingMode);
  const clearanceHaloVisible = useEditorStore((s) => s.clearanceHaloVisible);
  const toggleClearanceHalo = useEditorStore((s) => s.toggleClearanceHalo);
  const pcbRouteDraft = useEditorStore((s) => s.pcbRouteDraft);
  const startPcbRoute = useEditorStore((s) => s.startPcbRoute);
  const startPcbRouteFromExisting = useEditorStore(
    (s) => s.startPcbRouteFromExisting
  );
  const appendPcbRoutePoints = useEditorStore((s) => s.appendPcbRoutePoints);
  const placePendingVia = useEditorStore((s) => s.placePendingVia);
  const cancelPendingVia = useEditorStore((s) => s.cancelPendingVia);
  const swapPcbRoutePosture = useEditorStore((s) => s.swapPcbRoutePosture);
  const cyclePcbConflictMode = useEditorStore((s) => s.cyclePcbConflictMode);
  const adjustPcbCornerRadius = useEditorStore((s) => s.adjustPcbCornerRadius);
  const finishPcbRoute = useEditorStore((s) => s.finishPcbRoute);
  const popPcbRoutePoint = useEditorStore((s) => s.popPcbRoutePoint);
  const clearPcbRouteDraft = useEditorStore((s) => s.clearPcbRouteDraft);
  const focusedNetKey = useEditorStore((s) => s.focusedNetKey);
  const setFocusedNetKey = useEditorStore((s) => s.setFocusedNetKey);

  const bakePcbComponentTransform = useCircuitStore(
    (s) => s.bakePcbComponentTransform
  );
  const setBoard = useCircuitStore((s) => s.setBoard);

  // ─── Pointer class + viewport class ──────────────────────────────────────
  // isTouch reveals the controls that only exist as keyboard shortcuts (Esc /
  // Backspace / V / T have no key to press on a phone). isCompact drives
  // LAYOUT — a half-width desktop window gets the same collapsed chrome as a
  // phone, per the hook's contract.
  const isTouch = useIsTouch();
  const isCompact = useIsCompact();
  // Tolerances for anything that has to commit to a size WITHOUT an event in
  // hand — the ratsnest pick capsule is a rendered stroke width, and dblclick
  // carries no pointerType. Everything driven by a pointer event derives its
  // own slop from that event instead; see `tolerancesFor(isGestureTouch(e))`
  // below, and the note on `isGestureTouch`.
  const tol = useMemo<CanvasTolerances>(() => tolerancesFor(isTouch), [isTouch]);
  // On-screen stand-ins for keyboard-only actions. Shown on a coarse pointer
  // (no keyboard) and in a compact viewport (likely a tablet / phone-shaped
  // window), never on a roomy desktop where they'd just be clutter.
  const showTouchActions = isTouch || isCompact;

  // ─── Model build ─────────────────────────────────────────────────────────
  const model = useMemo(
    () => buildPcbModel(circuitJson, tsxCode, manualEdits),
    [circuitJson, tsxCode, manualEdits]
  );

  const ratsnest = useMemo(() => computeRatsnest(model), [model]);

  const focusedNet = useMemo(
    () =>
      focusedNetKey
        ? model.nets.find((n) => n.traceKey === focusedNetKey) ?? null
        : null,
    [model.nets, focusedNetKey]
  );
  const focusedNetSelectors = useMemo(
    () => (focusedNet ? selectorsOnNet(focusedNet) : null),
    [focusedNet]
  );
  // Copper the route may legally land on. `obstacleSetKey` hashes the members,
  // not the Set identity, so recomputing this on every committed corner does not
  // rebuild the obstacle set.
  const draftFromSelector = pcbRouteDraft?.fromSelector ?? null;
  const draftToSelector = pcbRouteDraft?.toSelector ?? null;
  const routeExcludeSelectors = useMemo(() => {
    if (!draftFromSelector) return focusedNetSelectors ?? EMPTY_SELECTORS;
    const out = new Set(focusedNetSelectors ?? []);
    out.add(canonEndpoint(draftFromSelector));
    if (draftToSelector) out.add(canonEndpoint(draftToSelector));
    return out;
  }, [focusedNetSelectors, draftFromSelector, draftToSelector]);

  // ─── Copper layer set (board-aware) ────────────────────────────────────────
  // The board's copper layer count decides which copper layers the editor
  // surfaces: a 2-layer board shows top + bottom, a 4-layer board adds
  // inner1 / inner2, etc. Everything downstream — the layer panel, the route
  // tool's via cycling, layer visibility — reads off these derived sets, so
  // changing the board layer count lights up the inner layers everywhere.
  // Read from the tsx (synchronous + cached) rather than the eval'd model so
  // switching the count in the layer panel takes effect immediately instead
  // of lagging a re-eval behind.
  const numLayers = useCircuitStore((s) => s.getBoardConfig().layers);
  const copperLayers = useMemo(
    () => copperLayersForCount(numLayers),
    [numLayers]
  );
  const copperLayerIds = useMemo(
    () => copperLayers.map((l) => l.id),
    [copperLayers]
  );
  const displayLayers = useMemo(() => layersForCount(numLayers), [numLayers]);

  // ─── Autoroute restore ────────────────────────────────────────────────────
  // The board is autorouted by core's capacity-mesh autorouter on every eval;
  // pcbModel displays those routes directly. The sidecar only records the
  // user's per-connection edits — a manual route (override) or a noAutoroute
  // flag (deleted copper). "Re-autorouting" therefore just clears those edits
  // so the fresh eval result shows through again.

  // Sidecar keys carrying a route edit — drives the toolbar's board-restore
  // button enablement.
  const routeEditKeys = useMemo(() => {
    const keys: StableKey[] = [];
    for (const [k, entry] of Object.entries(manualEdits)) {
      if (entry.pcb?.route?.length || entry.pcb?.noAutoroute) {
        keys.push(k as StableKey);
      }
    }
    return keys;
  }, [manualEdits]);

  const clearRouteEdits = useCallback(
    (keys: ReadonlyArray<StableKey>, what: "net" | "board") => {
      // manualEdits is read via getState so this callback stays identity-
      // stable across drag frames (it feeds the memoized RatsnestLayer via
      // handleRouteEdge).
      const edits = useEditorStore.getState().manualEdits;
      const entries = keys
        .filter((k) => {
          const pcb = edits[k]?.pcb;
          return !!pcb && (!!pcb.route?.length || pcb.noAutoroute === true);
        })
        .map((k) => [k, pcbEditWithoutRouteState(edits[k]!.pcb!)] as const);
      if (entries.length === 0) {
        toast.message("Nothing to restore", {
          description:
            "No route edits to clear. If an airwire remains, the autorouter couldn't route that connection — route it manually (W).",
        });
        return;
      }
      setPcbEdits(entries);
      toast.success(
        what === "board" ? "Board re-autorouted" : "Net re-autorouted",
        {
          description: `Cleared ${entries.length} route edit${
            entries.length === 1 ? "" : "s"
          } — the autorouter's routes now show.`,
        }
      );
    },
    [setPcbEdits]
  );

  // A — restore the focused net to the autorouter's result (drops that net's
  // manual routes and deleted-route markers).
  const restoreNetAutoroute = useCallback(() => {
    const key = useEditorStore.getState().focusedNetKey;
    const net = key ? model.nets.find((n) => n.traceKey === key) : null;
    if (!net) {
      toast.message("Focus a net first", {
        description:
          "Click a trace or an airwire, then press A to restore that net's autoroute.",
      });
      return;
    }
    clearRouteEdits(netConnIds(net), "net");
  }, [model, clearRouteEdits]);

  // ⇧A — restore the whole board to the autorouter's result.
  const restoreBoardAutoroute = useCallback(() => {
    clearRouteEdits(routeEditKeys, "board");
  }, [clearRouteEdits, routeEditKeys]);

  // Double-click on an airwire: restore its net's autoroute. The airwire is
  // there because a route was deleted, replaced, or never found — bring back
  // whatever the autorouter has for the net.
  const handleRouteEdge = useCallback(
    (edge: RatsnestEdge) => {
      if (edge.traceKey) setFocusedNetKey(edge.traceKey);
      const net = model.nets.find((n) => n.traceKey === edge.traceKey);
      if (net) clearRouteEdits(netConnIds(net), "net");
    },
    [model, setFocusedNetKey, clearRouteEdits]
  );

  // ─── Live route preview: the non-React frame pipeline ─────────────────────
  // Everything below is refs on purpose. A pointermove while drafting writes no
  // React state and no Zustand state; it stamps `pointerFrameRef` and asks for
  // an animation frame. `flushRouteFrame` (defined further down, reached through
  // `flushRef` so the callbacks up here stay identity-stable) does the snapping,
  // the leader, the paint and — only then, and only within a hard deadline —
  // the walkaround solve.
  const routeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const routeRafRef = useRef<number | null>(null);
  const flushRef = useRef<() => void>(() => {});
  const pointerFrameRef = useRef({
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    ctrlKey: false,
    valid: false,
  });
  const frameCtxRef = useRef<RouteFrameCtx | null>(null);
  const walkStoreRef = useRef(createWalkaroundStore());
  const obstacleRef = useRef<{ key: string; set: RouteObstacleSet } | null>(null);
  // Ring of recent cursor deltas — the auto-posture "which way is the user
  // actually moving" rule.
  const travelRef = useRef({
    dx: new Float64Array(POSTURE_TRAVEL_SAMPLES),
    dy: new Float64Array(POSTURE_TRAVEL_SAMPLES),
    i: 0,
    lastX: 0,
    lastY: 0,
    seeded: false,
  });
  const lastSolveRef = useRef<{ x: number; y: number; key: string }>({
    x: 0,
    y: 0,
    key: "",
  });
  const effectivePostureRef = useRef<RoutePosture>("hv-first");
  const snapTargetRef = useRef<SnapTarget | null>(null);

  const scheduleRouteFrame = useCallback(() => {
    if (routeRafRef.current === null) {
      routeRafRef.current = requestAnimationFrame(() => flushRef.current());
    }
  }, []);

  // Run the frame NOW rather than next tick. Used at pointerdown so a click
  // commits geometry composed from the click's own position — that is what makes
  // "clicking commits exactly what is drawn" literally true.
  const flushRouteFrameNow = useCallback(() => {
    if (routeRafRef.current !== null) {
      cancelAnimationFrame(routeRafRef.current);
      routeRafRef.current = null;
    }
    flushRef.current();
  }, []);

  // Flash the rejection ring and DRIVE ITS FADE. The fade is derived from wall
  // clock inside the painter, and a click is not followed by any other frame
  // source — so without this loop a rejected pad click that the user does not
  // follow with a pointer move leaves the ring frozen at full opacity until
  // something else happens to repaint. The loop is a repaint only: no snapping,
  // no leader, no solve.
  const flashRafRef = useRef<number | null>(null);
  const flashRejectedPad = useCallback((x: number, y: number) => {
    const snap = routeLive.snapshot;
    snap.rejectFlashAt = performance.now();
    snap.rejectFlashX = x;
    snap.rejectFlashY = y;
    routeLive.publish();
    if (flashRafRef.current !== null) return;
    const tick = () => {
      routeLive.publish();
      const at = routeLive.snapshot.rejectFlashAt;
      // The final tick lands past the fade and paints the ring away.
      const live = at > 0 && performance.now() - at < REJECT_FLASH_MS;
      flashRafRef.current = live ? requestAnimationFrame(tick) : null;
    };
    flashRafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(
    () => () => {
      if (routeRafRef.current !== null) {
        cancelAnimationFrame(routeRafRef.current);
        routeRafRef.current = null;
      }
      if (flashRafRef.current !== null) {
        cancelAnimationFrame(flashRafRef.current);
        flashRafRef.current = null;
      }
      routeLive.clear();
    },
    []
  );

  // If the board layer count shrank out from under the active layer (e.g. the
  // user dropped a 4-layer board back to 2 while routing on inner1), fall back
  // to the top copper so routing always lands on a layer that exists.
  useEffect(() => {
    const valid = new Set(copperLayerIds);
    // Cancel an in-progress route that references a copper layer the board no
    // longer has — its active layer OR any already-stamped point. Those points
    // can't be cleanly remapped, and finishing would bake orphan copper onto a
    // phantom layer (invisible, unmatched by eval/DRC). Drop the draft instead.
    const draft = useEditorStore.getState().pcbRouteDraft;
    if (
      draft &&
      (!valid.has(draft.activeLayer) ||
        draft.points.some((p) => !valid.has(p.layer)))
    ) {
      clearPcbRouteDraft();
    }
    // Read through getState, not the render closure: abandoning the draft above
    // restores the layer it started on, which on a board that just lost layers is
    // itself a layer that no longer exists.
    if (!valid.has(useEditorStore.getState().activeLayer)) {
      setActiveLayer(TOP_LAYER_ID);
    }
  }, [copperLayerIds, activeLayer, setActiveLayer, clearPcbRouteDraft]);

  // Activate a copper layer. While a route is in progress this commits the
  // leader, drops a via AT THE CURSOR (the head of the unfixed track — where
  // every reference tool puts it) and continues on the new layer; otherwise it
  // just sets where the next route starts. Non-copper layers are ignored.
  const activateLayer = useCallback(
    (layer: LayerId) => {
      if (!isCopperLayer(layer)) return;
      const draft = useEditorStore.getState().pcbRouteDraft;
      if (!draft) {
        setActiveLayer(layer);
        return;
      }
      if (draft.pendingVia) {
        cancelPendingVia();
        if (draft.pendingVia.toLayer === layer) return;
      }
      if (useEditorStore.getState().pcbRouteDraft?.activeLayer === layer) return;
      flushRouteFrameNow();
      const tail = previewTailPoints(routeLive.snapshot);
      const head = tail[tail.length - 1];
      if (!head) return;
      placePendingVia({
        x: head.x,
        y: head.y,
        toLayer: layer,
        leader: tail.slice(0, -1),
      });
      scheduleRouteFrame();
    },
    [
      setActiveLayer,
      cancelPendingVia,
      placePendingVia,
      flushRouteFrameNow,
      scheduleRouteFrame,
    ]
  );

  // Component-name → "is this a chip-shaped part" lookup. Used to gate the
  // pin-1 notch — drawing it on resistors / caps would be silly. We mirror
  // the schematic's own classification (isChipLike) so what reads as a
  // chip-box in one editor reads as one in the other.
  const chipLikeNames = useMemo(() => {
    const out = new Set<string>();
    for (const c of extractComponentsCached(tsxCode)) {
      if (isChipLike(c.elementTag)) out.add(c.name);
    }
    return out;
  }, [tsxCode]);

  // Pin-1 lookup for the orientation marker — Altium-style. A pad is pin 1
  // if its port_hints contain "1" or "pin1". Some footprints (diodes,
  // polarized caps) also use semantic names like "anode" or "+"; we treat
  // those as pin 1 too so the marker still appears on polarized parts that
  // never declare a numeric "1".
  const pin1ByCompKey = useMemo(() => {
    const out = new Map<string, PcbPadRecord>();
    for (const pad of model.pads) {
      if (!pad.componentKey) continue;
      if (out.has(pad.componentKey)) continue;
      const isPin1 = pad.portHints.some((h) => {
        const l = h.toLowerCase();
        return l === "1" || l === "pin1" || l === "anode" || l === "+";
      });
      if (isPin1) out.set(pad.componentKey, pad);
    }
    return out;
  }, [model]);

  // Two-terminal passives (0402 caps/resistors) don't need a separate
  // courtyard box — the pads ARE the footprint. ICs / 3+ pin parts keep
  // the body outline for orientation (pin-1 notch) and selection affordance.
  const padCountByCompKey = useMemo(() => {
    const out = new Map<string, number>();
    for (const pad of model.pads) {
      if (!pad.componentKey) continue;
      out.set(pad.componentKey, (out.get(pad.componentKey) ?? 0) + 1);
    }
    return out;
  }, [model.pads]);

  // Source of truth for "is this PCB worth showing": does the user's tsx
  // declare any components? An empty schematic can still produce a non-
  // empty circuitJson (e.g. a bare <board/> emits a pcb_board element),
  // so falling back to circuitJson.length would render an empty PCB
  // instead of the "No PCB yet" hint.
  const hasSchematicComponents = useMemo(
    () => extractComponentsCached(tsxCode).length > 0,
    [tsxCode]
  );

  // ─── Container size + viewport sync ─────────────────────────────────────
  // canvasSize tracks the CANVAS WRAPPER (the flex-1 region that holds the
  // SVG), NOT the outer flex container — otherwise the LayerPanel's 192px
  // gets included and the SVG draws under the panel.
  //
  // We use a CALLBACK REF (not useRef + useEffect) because the wrapper is
  // conditionally rendered: the empty-state branch above returns markup
  // that doesn't include the wrapper. When circuitJson later arrives and
  // the wrapper mounts, a useRef + useEffect with `[canvasSize]` deps
  // would NOT re-fire (deps unchanged), the ResizeObserver would never
  // attach, and the SVG would stay frozen at the initial 800×600 inside
  // a much larger flex container. The callback ref guarantees we measure
  // + observe the moment the element appears.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Static board geometry renders here (imperative Canvas 2D); the <svg> above
  // it carries only the interactive chrome + pointer handlers.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  // Backing-store density for retina crispness. Recomputed on DPR / monitor
  // change so dragging the window between displays stays sharp.
  const [dpr, setDpr] = useState(() =>
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
  );

  const setCanvasWrapperEl = useCallback((el: HTMLDivElement | null) => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    canvasWrapperRef.current = el;
    if (!el) return;
    // Sync measure so the first paint uses the real size, not the stale
    // initial state — otherwise the SVG renders one frame at 800×600.
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      setCanvasSize((cur) =>
        cur.width === w && cur.height === h ? cur : { width: w, height: h }
      );
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width <= 0 || height <= 0) continue;
        const w = Math.floor(width);
        const h = Math.floor(height);
        setCanvasSize((cur) =>
          cur.width === w && cur.height === h ? cur : { width: w, height: h }
        );
      }
    });
    ro.observe(el);
    resizeObserverRef.current = ro;
  }, []);

  useEffect(() => {
    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
    };
  }, []);

  // Track the device pixel ratio. matchMedia fires on cross-monitor / zoom
  // changes; we re-subscribe with the new dppx each time so a second move is
  // still caught.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    const mq = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`
    );
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [dpr]);

  // Auto-fit on first render (when viewport is still the initial identity).
  const didAutoFitRef = useRef(false);
  useEffect(() => {
    if (didAutoFitRef.current) return;
    if (model.components.length === 0 && !model.board) return;
    if (canvasSize.width <= 1 || canvasSize.height <= 1) return;
    if (viewport.x !== 0 || viewport.y !== 0 || viewport.scale !== 1) return;
    const fit = fitViewportToModel(model, canvasSize);
    setViewport("pcb", fit);
    didAutoFitRef.current = true;
  }, [model, canvasSize, viewport, setViewport]);

  // ─── Pointer / panning state ────────────────────────────────────────────
  const panStateRef = useRef<{
    startScreen: { x: number; y: number };
    startViewport: Viewport;
  } | null>(null);
  type DragState =
    | {
        kind: "marquee" | "move";
        startScreen: { x: number; y: number };
        startWorld: { x: number; y: number };
        keys: ReadonlyArray<StableKey>;
        // Pre-drag sidecar entries (so we keep rotation/layer/route on commit).
        origEdits: Map<StableKey, PcbEdit | undefined>;
        // World-space starting position of each component. This is read ONCE
        // at pointerdown so subsequent pointermoves compute the new position
        // as (startPos + cursorDelta) — NOT (currentModelPos + cursorDelta),
        // which would compound the offset every frame as the model rebuilds.
        startPositions: Map<StableKey, { x: number; y: number }>;
        // True when the drag has moved past the threshold. Until then we
        // suppress sidecar writes so a tap-without-move doesn't push a no-op.
        moved: boolean;
      }
    | {
        // Altium-style segment drag — grab a trace segment and slide it
        // perpendicular to itself. Pad endpoints (first / last route point)
        // are pinned. The two segment endpoints that aren't pinned move
        // together along the original segment's perpendicular axis.
        kind: "trace_segment";
        startScreen: { x: number; y: number };
        startWorld: { x: number; y: number };
        traceKey: StableKey;
        segIndex: number;
        origRoute: PcbRoutePoint[];
        origWidth: number;
        // The sidecar entry as it was before the drag. `origRoute` can be a
        // fresh materialization of the autorouter's segments, so it is NOT a
        // safe thing to write back when abandoning — that would silently
        // promote an eval-routed trace to a manual one. This is.
        origEdit: PcbEdit | undefined;
        // Unit-length perpendicular direction of the original segment.
        perpX: number;
        perpY: number;
        // Indices into origRoute whose XY should shift by perp * delta.
        // First/last route points are excluded so pads stay anchored.
        movingIndices: ReadonlyArray<number>;
        moved: boolean;
      };
  const dragStateRef = useRef<DragState | null>(null);
  const [marquee, setMarquee] = useState<{
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } | null>(null);
  const [spacePan, setSpacePan] = useState(false);
  // True while a pan drag is in flight — drives the "grabbing" cursor. The
  // live cursor position is NOT component state: it goes straight to the
  // editorStore (setPcbCursorMm) so only the StatusBar re-renders per move.
  const [panning, setPanning] = useState(false);
  // Touch opt-in for rubber-band select. On a mouse, dragging empty board is a
  // marquee and pan needs a modifier (space / middle / right); on touch that
  // inverts — one finger pans, because pan is the gesture users reach for
  // constantly and a phone has no modifier to hold. Marquee is still reachable,
  // just behind this explicit toggle in the toolbar.
  const [marqueeMode, setMarqueeMode] = useState(false);
  // Layer panel visibility while it's an overlay (compact widths only — at
  // desktop widths the panel is docked and this is ignored).
  const [layersOpen, setLayersOpen] = useState(false);

  // ─── Multi-pointer gesture state ────────────────────────────────────────
  // Every live pointer, keyed by pointerId, in CANVAS-LOCAL px. panStateRef and
  // dragStateRef are single-slot by design (there is only ever one drag), so
  // without this map a second finger's pointerdown would overwrite the first
  // finger's gesture and leave a half-finished marquee or component move behind.
  // `touch` is carried per pointer so a held mouse button plus a finger can
  // never be mistaken for a pinch.
  const pointersRef = useRef(
    new Map<number, ScreenPoint & { touch: boolean }>()
  );
  // The pointer that OWNS the current single-pointer gesture (pan, drag, or an
  // armed tap). Every move/up handler ignores other pointers, so a second finger
  // can neither drive someone else's drag nor release its pointer capture.
  const gesturePointerRef = useRef<number | null>(null);
  // Two-finger pinch. `anchor` is frozen at gesture start and every frame is
  // computed from it, so a dropped pointermove can't accumulate drift.
  const pinchRef = useRef<{
    a: number;
    b: number;
    anchor: PinchAnchor;
  } | null>(null);
  // A touch press is a TAP and a PAN at the same time until the finger moves:
  // tapping empty board should clear the selection (or drop a route corner),
  // dragging it should pan. So on touch we arm the press here, suppress its
  // effect, and decide at pointerup — `action` runs only if the finger never
  // crossed the drag threshold.
  const tapRef = useRef<{
    pointerId: number;
    local: ScreenPoint;
    action: () => void;
    moved: boolean;
  } | null>(null);

  const screenToWorldLocal = useCallback(
    (sx: number, sy: number) => screenToWorld(sx, sy, viewport, canvasSize),
    [viewport, canvasSize]
  );

  // Canvas-local pointer position. Every gesture coordinate in this file is
  // local (not client) px so hit tests, marquee rects, and pinch anchors all
  // speak the same units. Measured off the <svg> rather than e.currentTarget,
  // so a press that starts on a child (an airwire) resolves to the same origin.
  const localPoint = useCallback((e: React.PointerEvent): ScreenPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  }, []);

  // Touch is the only pointer type that gets the inverted (pan-first) gesture
  // model and pinch. Pen reports a fine pointer with hover, so it keeps mouse
  // semantics — a stylus user wants the marquee, same as a mouse user.
  //
  // Slop has to be decided the same way, per EVENT and not from `useIsTouch()`:
  // `(pointer: coarse)` describes the PRIMARY pointer, so on a hybrid device (a
  // touchscreen laptop) it reports fine while a finger is driving the gesture.
  // Arming a tap there but judging it against the 3px MOUSE drag threshold
  // promotes every tap to a pan — no press would ever deselect, place a route
  // point, or focus a net. So every pointer handler below calls
  // `tolerancesFor(isGestureTouch(e))` rather than closing over `tol`.
  const isGestureTouch = (e: React.PointerEvent): boolean =>
    e.pointerType === "touch";

  // Delete the SELECTED ENTITIES — Altium-style: the PCB editor is the
  // PHYSICAL layout. Connectivity lives in the schematic / `connections`.
  // So "delete trace" here rips the copper geometry — the sidecar route for a
  // manual trace — and marks the connection noAutoroute so the autorouter's
  // copper doesn't pop right back on the next eval. The tsx is untouched
  // (routes were never written there); the ratsnest reappears for that net.
  // To delete the connection itself, the user goes to the schematic and
  // removes the wire.
  // Components are deferred to PR 2 (component delete needs tsxTransform
  // plumbing the schematic editor already has).
  const deleteSelection = useCallback(() => {
    const sel = useEditorStore.getState().selectedKeys;
    if (sel.size === 0) return;
    const edits = useEditorStore.getState().manualEdits;
    const entries: Array<readonly [StableKey, PcbEdit]> = [];
    for (const key of sel) {
      const entry = model.byKey.get(key);
      // Trace records carry a `segments` array; component records don't.
      if (!entry || !("segments" in entry)) continue;
      const cur = edits[key]?.pcb ?? {};
      entries.push([
        key,
        { ...(pcbEditWithoutRoute(cur) ?? {}), noAutoroute: true },
      ]);
    }
    if (entries.length > 0) setPcbEdits(entries);
    clearSelection();
  }, [model, setPcbEdits, clearSelection]);

  // ─── Fit-to-view (F shortcut + double-click on empty canvas) ────────────
  // Always fits the whole board / model regardless of selection — same
  // gesture every time, predictable muscle memory. Mirrors schematic.
  const fitToView = useCallback(() => {
    if (canvasSize.width <= 1 || canvasSize.height <= 1) return;
    const fit = fitViewportToModel(model, canvasSize);
    setViewport("pcb", fit);
  }, [model, canvasSize, setViewport]);

  // ─── DRC inspector (click a violation marker to pan/zoom + read it) ──────
  const [focusedDrcId, setFocusedDrcId] = useState<string | null>(null);
  const requestedDrcFocusId = useEditorStore((s) => s.requestedDrcFocusId);
  // Whether DRC markers are drawn on the canvas. Off by default — toggled on
  // from the StatusBar eye button; the count + inspector stay available
  // regardless of marker visibility.
  const [drcVisible, setDrcVisible] = useState(false);

  const focusViolation = useCallback(
    (v: DrcViolation) => {
      setFocusedDrcId(v.id);
      // Center the viewport on the violation, zooming in if we're far out so
      // the marker is actually legible. Pan-only if already close.
      if (v.center && canvasSize.width > 1) {
        const scale = Math.max(viewport.scale, DRC_FOCUS_MIN_SCALE);
        setViewport("pcb", {
          x: -v.center.x * scale,
          y: v.center.y * scale,
          scale,
        });
      }
    },
    [canvasSize.width, viewport.scale, setViewport],
  );

  // The shared Issues drawer can switch to PCB and request a particular DRC
  // finding. Keep the request in the store until this tab mounts, then focus
  // the existing inspector/viewport and consume it.
  useEffect(() => {
    if (!requestedDrcFocusId) return;
    const violation = drcViolations.find((v) => v.id === requestedDrcFocusId);
    if (!violation) return;
    const frame = requestAnimationFrame(() => {
      setDrcVisible(true);
      focusViolation(violation);
      useEditorStore.getState().requestDrcFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedDrcFocusId, drcViolations, focusViolation]);

  const focusedDrcIndex = focusedDrcId
    ? drcViolations.findIndex((v) => v.id === focusedDrcId)
    : -1;
  const focusedViolation =
    focusedDrcIndex >= 0 ? drcViolations[focusedDrcIndex] : null;

  const stepViolation = useCallback(
    (dir: 1 | -1) => {
      const next = nextViolationIndex(drcViolations.length, focusedDrcIndex, dir);
      if (next >= 0) focusViolation(drcViolations[next]);
    },
    [drcViolations, focusedDrcIndex, focusViolation],
  );

  // V — drop a via at the cursor and advance to the next copper layer, or, when
  // one is already pending and unfixed, take it back. Shared with the toolbar's
  // Via chip; on touch there is no key to press.
  const toggleViaAtCursor = useCallback(() => {
    const cur = useEditorStore.getState().pcbRouteDraft;
    if (!cur || copperLayerIds.length < 2) return;
    if (cur.pendingVia) {
      cancelPendingVia();
      scheduleRouteFrame();
      return;
    }
    const i = copperLayerIds.indexOf(cur.activeLayer);
    activateLayer(copperLayerIds[(i + 1) % copperLayerIds.length]);
  }, [copperLayerIds, cancelPendingVia, scheduleRouteFrame, activateLayer]);

  const commitRoute = useCallback(
    (finished: PcbRouteDraft, connId: StableKey) => {
      // PCB route geometry is SIDECAR-ONLY. We deliberately do NOT emit a
      // `<trace>` (or `<via>`) into the tsx: connectivity lives in `connections`,
      // and wiring a `<trace>` source ↔ sidecar route is future work. The route is
      // keyed by the content-derived connection id of its two endpoints so
      // pcbModel/circuitJsonMerge can re-pair it to the matching net — and
      // suppress that net's ratsnest — without any tsx element to look up. The
      // key is stable across reloads because it's derived from the (canonical,
      // order-independent) endpoint pair, not minted. Layer changes are encoded
      // in the route points themselves, so vias need no separate storage.
      //
      // Read through getState: this is reached from callbacks whose closures may
      // predate the latest sidecar write.
      const edits = useEditorStore.getState().manualEdits;
      const prevKey = finished.traceKey;
      if (prevKey && prevKey !== connId) {
        // The route was picked up from another pad pair: that connection loses
        // its copper, and noAutoroute keeps the autorouter from re-covering it.
        const prev = edits[prevKey]?.pcb;
        if (prev) {
          setPcbEdit(prevKey, {
            ...(pcbEditWithoutRoute(prev) ?? {}),
            noAutoroute: true,
          });
        }
      }
      // Drawing copper un-deletes the connection — drop any noAutoroute marker
      // so the entry doesn't carry stale "deleted" state alongside a live route.
      const { noAutoroute: _undeleted, ...restPcb } = edits[connId]?.pcb ?? {};
      setPcbEdit(connId, {
        ...restPcb,
        route: finished.points,
        width: finished.width,
      });
    },
    [setPcbEdit]
  );

  // Space / `/` — swap which leg of the leader leaves the anchor first, and lock
  // the posture for the rest of the draft. The posture on screen is the per-frame
  // auto guess while unlocked, so it is handed over explicitly.
  const swapPostureNow = useCallback(() => {
    if (!useEditorStore.getState().pcbRouteDraft) return false;
    swapPcbRoutePosture(effectivePostureRef.current);
    scheduleRouteFrame();
    return true;
  }, [swapPcbRoutePosture, scheduleRouteFrame]);

  // Enter / End / double-click — stop routing here and keep what is drawn.
  const finishRouteAtCursor = useCallback(() => {
    const draft = useEditorStore.getState().pcbRouteDraft;
    if (!draft) return;
    flushRouteFrameNow();
    const tail = previewTailPoints(routeLive.snapshot);
    if (draft.points.length + tail.length < 2) {
      clearPcbRouteDraft();
      return;
    }
    // The sidecar keys route geometry by the connection id of a PAD PAIR, so a
    // stub still needs a second endpoint to belong to. Re-routes keep their
    // original key; a fresh stub adopts the nearest other pad on the routed net,
    // which is the connection the user was part-way through drawing.
    const connKey =
      draft.traceKey ?? stubConnectionKey(model, draft.fromSelector, tail);
    if (!connKey) {
      toast.message("Nothing to attach this stub to", {
        description:
          "Finish on a pad, or press Esc — a route has to belong to a connection.",
      });
      return;
    }
    const finished = finishPcbRoute(null, tail);
    if (finished) commitRoute(finished, connKey);
  }, [
    model,
    flushRouteFrameNow,
    finishPcbRoute,
    clearPcbRouteDraft,
    commitRoute,
  ]);

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const off = registerShortcuts([
      // Modal tools
      { key: "s", handler: () => setToolMode("select") },
      // The arrow tool both selects and moves, so M is just an alias for S
      // (kept for muscle memory) rather than a distinct mode.
      { key: "m", handler: () => setToolMode("select") },
      { key: "w", handler: () => setToolMode("trace") },
      { key: "escape", handler: () => clearPcbRouteDraft() },
      // `/` swaps posture; the via moved to V alone. Both used to be via, and
      // an interactive router needs a posture key far more than it needs two.
      // Per PRESS, never per repeat — see the Space binding below.
      {
        key: "/",
        handler: (e) => {
          if (!e.repeat) swapPostureNow();
        },
      },
      { key: "v", handler: () => toggleViaAtCursor() },
      // Number keys jump straight to a copper layer (1 = top, 2 = next, …).
      // While routing this drops a via at the cursor and continues there.
      ...copperLayerIds.map((id, i) => ({
        key: String(i + 1),
        handler: () => activateLayer(id),
      })),
      { key: "t", handler: () => cycleTraceWidth() },
      // Corner style is ⇧Space and nothing else. `G` was a second binding for
      // the same action, and the surfaces drifted apart naming it — the canvas
      // hint said ⇧Space while the toolbar said G. It is also the wrong letter
      // to spend: in Altium `G` is the grid menu, so binding it here fights the
      // muscle memory of exactly the users this is aimed at.
      { key: " ", shift: true, handler: () => cycleRoutingMode() },
      { key: "r", shift: true, handler: () => cyclePcbConflictMode() },
      {
        key: "c",
        shift: true,
        handler: () => {
          toggleClearanceHalo();
          scheduleRouteFrame();
        },
      },
      // `,` / `.` step the fillet radius; with Shift the browser reports the
      // shifted characters, so those are their own specs.
      { key: ",", handler: () => adjustRadius(-1) },
      { key: ".", handler: () => adjustRadius(1) },
      { key: "<", shift: true, handler: () => adjustRadius(-5) },
      { key: ">", shift: true, handler: () => adjustRadius(5) },
      { key: "enter", handler: () => finishRouteAtCursor() },
      { key: "end", handler: () => finishRouteAtCursor() },
      { key: "a", handler: () => restoreNetAutoroute() },
      { key: "a", shift: true, handler: () => restoreBoardAutoroute() },
      {
        key: "backspace",
        handler: () => {
          const cur = useEditorStore.getState().pcbRouteDraft;
          if (cur) {
            // While drafting, Backspace is per-segment undo and NOTHING else. It
            // must not fall through to deleteSelection on a one-point draft —
            // that deleted the user's copper instead of their last click.
            if (cur.points.length > 1) {
              popPcbRoutePoint();
              scheduleRouteFrame();
            }
            return;
          }
          deleteSelection();
        },
      },
      {
        key: "delete",
        handler: () => deleteSelection(),
      },
      // F — fit-to-view (mirrors schematic).
      { key: "f", handler: () => fitToView() },
      // Space pans on drag — but only when no route is in flight. While drafting
      // it swaps posture instead, and must NOT arm spacePan, or the next drag
      // would pan the board out from under the route.
      {
        key: " ",
        handler: (e) => {
          if (!useEditorStore.getState().pcbRouteDraft) {
            setSpacePan(true);
            return;
          }
          e.preventDefault();
          // Per PRESS. Space used to be pan, so holding it is the muscle memory
          // users bring to this canvas — and on auto-repeat a swap-per-keydown
          // strobes the leader between its two postures at ~30Hz.
          if (e.repeat) return;
          swapPostureNow();
        },
      },
      // Ctrl/Cmd+0 reset zoom
      {
        key: "0",
        ctrlOrMeta: true,
        allowInInput: true,
        handler: () => fitToView(),
      },
    ]);

    function adjustRadius(steps: number) {
      if (!useEditorStore.getState().pcbRouteDraft) return;
      adjustPcbCornerRadius(steps * CORNER_RADIUS_STEP_MM);
      scheduleRouteFrame();
    }

    // Unconditional: a Space keyup while drafting still has to clear the flag,
    // or a posture swap mid-drag could latch pan mode forever.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && !isTypingTarget(e.target)) setSpacePan(false);
    };
    window.addEventListener("keyup", onKeyUp);
    return () => {
      off();
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    setToolMode,
    toggleViaAtCursor,
    cycleTraceWidth,
    cycleRoutingMode,
    cyclePcbConflictMode,
    toggleClearanceHalo,
    adjustPcbCornerRadius,
    popPcbRoutePoint,
    clearPcbRouteDraft,
    copperLayerIds,
    activateLayer,
    deleteSelection,
    fitToView,
    restoreNetAutoroute,
    restoreBoardAutoroute,
    swapPostureNow,
    finishRouteAtCursor,
    scheduleRouteFrame,
  ]);

  // ─── Mouse wheel zoom ───────────────────────────────────────────────────
  // Shares `zoomAboutPoint` with the pinch gesture, so wheel and pinch can't
  // disagree about where the anchor point ends up.
  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      // deltaMode=1 means "lines" — normalize to roughly the trackpad scale.
      const deltaPx = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-deltaPx * ZOOM_SENSITIVITY_PX);
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const next = zoomAboutPoint(
        viewport,
        canvasSize,
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        factor,
        SCALE_LIMITS
      );
      if (next === viewport) return;
      setViewport("pcb", next);
    },
    [viewport, canvasSize, setViewport]
  );

  // ─── Pointer handlers ───────────────────────────────────────────────────

  // Capture on the <svg> itself (not e.currentTarget, which is a child <g> for
  // presses that start on an airwire) so every gesture routes its moves to the
  // same element even when the pointer slides over the floating chrome above it.
  const capturePointer = useCallback((pointerId: number) => {
    try {
      svgRef.current?.setPointerCapture(pointerId);
    } catch {
      // The pointer can already be gone (a pinch finger lifting as we hand the
      // gesture to the survivor). The gesture still works, uncaptured.
    }
  }, []);

  const beginPan = useCallback(
    (pointerId: number, start: ScreenPoint) => {
      panStateRef.current = {
        startScreen: start,
        startViewport: { ...viewport },
      };
      gesturePointerRef.current = pointerId;
      setPanning(true);
      capturePointer(pointerId);
    },
    [viewport, capturePointer]
  );

  // Drop the in-flight single-pointer gesture WITHOUT committing it. Called when
  // a second finger lands: the user's intent just changed to pinch, and a
  // half-finished marquee or a component parked wherever the finger happened to
  // be is not a result anyone asked for. Move / segment drags have already
  // written preview geometry into the sidecar, so those are rolled back to their
  // pre-drag entries.
  const abandonGesture = useCallback(() => {
    const drag = dragStateRef.current;
    if (drag?.moved) {
      if (drag.kind === "move") {
        setPcbEdits(
          Array.from(drag.origEdits, ([key, edit]) => [key, edit ?? null] as const)
        );
      } else if (drag.kind === "trace_segment") {
        setPcbEdit(drag.traceKey, drag.origEdit ?? null);
      }
    }
    dragStateRef.current = null;
    panStateRef.current = null;
    tapRef.current = null;
    gesturePointerRef.current = null;
    setPanning(false);
    setMarquee(null);
  }, [setPcbEdit, setPcbEdits]);

  // Forget a pointer and, if it owned the active gesture, tear that down too.
  // Shared by pointercancel and lostpointercapture — a stale map entry would
  // leave the canvas convinced two fingers are down and break every later
  // gesture, so both paths must land here.
  const forgetPointer = useCallback(
    (pointerId: number) => {
      pointersRef.current.delete(pointerId);
      const pinch = pinchRef.current;
      if (pinch && (pinch.a === pointerId || pinch.b === pointerId)) {
        pinchRef.current = null;
      }
      if (gesturePointerRef.current === pointerId) {
        dragStateRef.current = null;
        panStateRef.current = null;
        tapRef.current = null;
        gesturePointerRef.current = null;
        setPanning(false);
        setMarquee(null);
      }
    },
    []
  );

  // Second finger down → pinch. Recorded in the CAPTURE phase (see the handler
  // wiring on the <svg>) because children like the ratsnest airwires
  // stopPropagation on pointerdown; without capture, landing a finger on an
  // airwire would swallow the event and pinch would never start.
  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const touch = isGestureTouch(e);
      const at = localPoint(e);
      pointersRef.current.set(e.pointerId, { ...at, touch });
      if (!touch) return;
      if (pinchRef.current) return; // a third finger changes nothing
      const fingers = Array.from(pointersRef.current.entries()).filter(
        ([, p]) => p.touch
      );
      if (fingers.length !== 2) return;
      const [[a, pa], [b, pb]] = fingers;
      abandonGesture();
      pinchRef.current = {
        a,
        b,
        anchor: pinchAnchor(pa, pb, viewport, canvasSize),
      };
    },
    [localPoint, abandonGesture, viewport, canvasSize]
  );

  // Arm a touch press as "tap OR pan". Captures the pointer so follow-up moves
  // can't escape to the floating chrome above the SVG, and remembers what a tap
  // would do. The pan engages only once the finger clears the drag threshold
  // (onPointerMove); `action` runs only if it never does (onPointerUp).
  const armTouchTap = useCallback(
    (pointerId: number, at: ScreenPoint, action: () => void) => {
      tapRef.current = { pointerId, local: at, action, moved: false };
      gesturePointerRef.current = pointerId;
      capturePointer(pointerId);
    },
    [capturePointer]
  );

  // Press on an airwire → focus its net. On touch the same press must still be
  // able to become a pan: airwires crisscross the whole board, and at a
  // finger-sized pick width they would otherwise carve it into dead zones. So
  // touch defers the focus to a tap exactly like an empty-board press does.
  // Identity-stable (both deps are stable), which keeps RatsnestLayer memoized.
  const handleEdgePress = useCallback(
    (e: React.PointerEvent, edge: RatsnestEdge) => {
      e.stopPropagation();
      const key = edge.traceKey;
      if (!key) return;
      if (e.pointerType === "touch") {
        armTouchTap(e.pointerId, localPoint(e), () => setFocusedNetKey(key));
        return;
      }
      setFocusedNetKey(key);
    },
    [armTouchTap, localPoint, setFocusedNetKey]
  );

  // The route tool's entire press behavior — start a route, pick one up, drop a
  // corner, or finish on a pad. Extracted from onPointerDown because on touch it
  // has to fire on pointer UP instead (a press is indistinguishable from the
  // start of a pan until the finger moves), and both paths must do the same
  // thing. Reads the draft through getState so a deferred call sees current
  // state rather than whatever was in the closure at pointerdown. Tolerances
  // come from the caller because they belong to the pointer that pressed, not
  // to the device.
  const traceTapAt = useCallback(
    (world: { x: number; y: number }, tolerances: CanvasTolerances) => {
      const draft = useEditorStore.getState().pcbRouteDraft;
      const padSnap = findNearestPad(
        model,
        world.x,
        world.y,
        activeLayer,
        tolerances.snapPadPx / viewport.scale
      );

      if (!draft) {
        if (!padSnap || !padSnap.pcbPortId) {
          setFocusedNetKey(null);
          return;
        }
        const selector = padToSelector(padSnap, model);
        if (!selector) return;

        const existing = findUserRouteAtPad(model, selector);
        if (existing) {
          const route = manualEdits[existing.traceKey]?.pcb?.route;
          const width =
            manualEdits[existing.traceKey]?.pcb?.width ?? traceWidth;
          if (route && route.length >= 2) {
            startPcbRouteFromExisting({
              traceKey: existing.traceKey,
              fromEnd: existing.fromEnd,
              fromSelector: selector,
              route,
              width,
            });
            const net = findNetContainingSelector(model, selector);
            if (net?.traceKey) setFocusedNetKey(net.traceKey);
            return;
          }
        }

        const startLayer = padSnap.isThroughHole ? activeLayer : padSnap.layer;
        startPcbRoute({
          selector,
          x: padSnap.x,
          y: padSnap.y,
          layer: startLayer,
        });
        const net = findNetContainingSelector(model, selector);
        if (net?.traceKey) setFocusedNetKey(net.traceKey);
        return;
      }

      // Route in progress. Compose this frame from the click's OWN position, so
      // what gets committed is byte-for-byte the geometry on screen — hug
      // vertices, leader knee and endpoint included. This is what finally makes
      // routes go around components: the preview is no longer decorative.
      flushRouteFrameNow();
      const tail = previewTailPoints(routeLive.snapshot);
      const target = snapTargetRef.current;

      if (target && target.selector) {
        if (target.foreignNet) {
          // Reject rather than wire two nets together — the schematic owns
          // connectivity. The painter fades the flash out over 400ms.
          flashRejectedPad(target.x, target.y);
          return;
        }
        // Through-hole pads bridge all copper layers, so the route terminates on
        // whichever layer the user is currently routing on — committing the
        // final point on the pad's nominal layer would make the model drop the
        // last segment and render only a via at the pad.
        const finishLayer = target.isThroughHole
          ? draft.activeLayer
          : target.layer;
        const finished = finishPcbRoute(
          {
            selector: target.selector,
            x: target.x,
            y: target.y,
            layer: finishLayer,
          },
          tail.slice(0, -1)
        );
        if (finished && finished.toSelector) {
          commitRoute(
            finished,
            connectionId(finished.fromSelector, finished.toSelector)
          );
        }
        return;
      }

      appendPcbRoutePoints(tail);
      scheduleRouteFrame();
    },
    [
      model,
      activeLayer,
      viewport.scale,
      manualEdits,
      traceWidth,
      startPcbRoute,
      startPcbRouteFromExisting,
      finishPcbRoute,
      appendPcbRoutePoints,
      flushRouteFrameNow,
      scheduleRouteFrame,
      flashRejectedPad,
      setFocusedNetKey,
      commitRoute,
    ]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // A second finger already claimed this press as a pinch (see
      // onPointerDownCapture) — it must not also start a single-pointer gesture.
      if (pinchRef.current) return;
      const touch = isGestureTouch(e);
      const ptrTol = tolerancesFor(touch);
      const screen = localPoint(e);

      // Right-click cancels route or starts pan
      if (e.button === 2) {
        if (pcbRouteDraft) {
          clearPcbRouteDraft();
          return;
        }
        beginPan(e.pointerId, screen);
        return;
      }
      // Middle-click always pans
      if (e.button === 1 || (e.button === 0 && spacePan)) {
        beginPan(e.pointerId, screen);
        return;
      }
      if (e.button !== 0) return;

      const world = screenToWorldLocal(screen.x, screen.y);
      const toleranceMm = ptrTol.hitTolPx / viewport.scale;

      // ─── Route tool ─────────────────────────────────────────────────────
      if (toolMode === "trace") {
        // Stamp the frame with the PRESS position so the geometry the click
        // commits is composed from where the user actually clicked, not from
        // whatever the last hover frame happened to hold.
        const pf = pointerFrameRef.current;
        pf.clientX = e.clientX;
        pf.clientY = e.clientY;
        pf.shiftKey = e.shiftKey;
        pf.ctrlKey = e.ctrlKey || e.metaKey;
        pf.valid = true;
        if (touch) {
          // One finger serves both jobs: tap = place the next route point,
          // drag = pan the board. Arm both, decide on release.
          armTouchTap(e.pointerId, screen, () => traceTapAt(world, ptrTol));
          return;
        }
        traceTapAt(world, ptrTol);
        return;
      }

      // ─── Select / move tool default behavior ────────────────────────────
      const hit = hitTestPoint(model, world.x, world.y, {
        layerVisibility,
        toleranceMm,
      });

      if (!hit) {
        // Empty board. Mouse keeps the rubber band (pan is on space / middle /
        // right). Touch inverts it: one finger pans, because that's what a
        // finger is for and there's no modifier to hold — rubber-band select
        // moves behind the toolbar's explicit box-select toggle.
        if (touch && !marqueeMode) {
          const additive = e.shiftKey;
          armTouchTap(e.pointerId, screen, () => {
            if (!additive) clearSelection();
            setFocusedNetKey(null);
          });
          return;
        }
        if (!e.shiftKey) clearSelection();
        setFocusedNetKey(null);
        dragStateRef.current = {
          kind: "marquee",
          startScreen: screen,
          startWorld: world,
          keys: [],
          origEdits: new Map(),
          startPositions: new Map(),
          moved: false,
        };
        gesturePointerRef.current = e.pointerId;
        (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        return;
      }

      // Hit something — selection logic. Clicking a trace focuses its net (so
      // A can restore its autoroute); any other pick clears focus.
      // Airwire clicks stopPropagation on their handler and never reach here.
      if (hit.kind === "trace") {
        const net = findNetContainingSelector(model, hit.record.fromSelector);
        setFocusedNetKey(net?.traceKey ?? null);
      } else {
        setFocusedNetKey(null);
      }

      const hitKey = hitKeyFromResult(hit);
      if (!hitKey) return;

      if (e.shiftKey) {
        toggleSelection(hitKey);
      } else if (!selectedKeys.has(hitKey)) {
        setSelection([hitKey]);
      }

      // Trace segment drag — Altium-style. Pad endpoints stay anchored;
      // the segment slides perpendicular to itself.
      if (hit.kind === "trace") {
        const trace = hit.record;
        const segIndex = hit.segmentIndex;
        const route = routeForDrag(trace, manualEdits);
        if (route && route.length >= 2 && segIndex >= 0 && segIndex < route.length - 1) {
          const a = route[segIndex];
          const b = route[segIndex + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len > 1e-6) {
            // Unit perpendicular (90° CCW rotation of segment direction).
            const perpX = -dy / len;
            const perpY = dx / len;
            const movingIndices: number[] = [];
            // Pin first/last route points (they sit on pads). For middle
            // segments both endpoints move together.
            if (segIndex !== 0) movingIndices.push(segIndex);
            if (segIndex !== route.length - 2) movingIndices.push(segIndex + 1);
            if (movingIndices.length > 0) {
              const origWidth =
                manualEdits[trace.key]?.pcb?.width ??
                trace.segments[segIndex]?.width ??
                DEFAULT_TRACE_WIDTH_MM;
              dragStateRef.current = {
                kind: "trace_segment",
                startScreen: screen,
                startWorld: world,
                traceKey: trace.key,
                segIndex,
                origRoute: route,
                origWidth,
                origEdit: manualEdits[trace.key]?.pcb,
                perpX,
                perpY,
                movingIndices,
                moved: false,
              };
              gesturePointerRef.current = e.pointerId;
              (e.currentTarget as SVGSVGElement).setPointerCapture(
                e.pointerId
              );
              return;
            }
          }
        }
        // Fell through — segment can't be dragged (both ends pinned with
        // no inner corners, or zero-length segment). Selection still
        // happened above; that's fine.
      }

      // Start a move drag whenever the user grabbed a movable piece — the
      // component body OR any of its pads. Pads cover most of a small
      // component's footprint; treating a pad-hit as "I want to drag this
      // part" matches every PCB tool's behavior (Altium, KiCad, Eagle).
      // Vias and trace segments are not draggable in PR 1 (deferred).
      const movableKey: StableKey | null =
        hit.kind === "component"
          ? hit.record.key
          : hit.kind === "pad"
            ? hit.record.componentKey
            : null;

      if (movableKey) {
        const startKeys: StableKey[] = e.shiftKey
          ? [movableKey]
          : Array.from(
              selectedKeys.has(movableKey)
                ? selectedKeys
                : new Set([movableKey])
            );
        const origEdits = new Map<StableKey, PcbEdit | undefined>();
        const startPositions = new Map<
          StableKey,
          { x: number; y: number }
        >();
        for (const k of startKeys) {
          origEdits.set(k, manualEdits[k]?.pcb);
          // Capture the world-space starting position from the LIVE model.
          // Subsequent pointermoves use (startPos + cursorDelta), so the
          // model rebuilding mid-drag (via setPcbEdit → manualEdits change
          // → re-render) doesn't compound the offset.
          const comp = model.byKey.get(k);
          if (comp && "x" in comp && "y" in comp) {
            startPositions.set(k, { x: comp.x, y: comp.y });
          }
        }
        dragStateRef.current = {
          kind: "move",
          startScreen: screen,
          startWorld: world,
          keys: startKeys,
          origEdits,
          startPositions,
          moved: false,
        };
        gesturePointerRef.current = e.pointerId;
        (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
      }
    },
    [
      pcbRouteDraft,
      clearPcbRouteDraft,
      beginPan,
      localPoint,
      armTouchTap,
      traceTapAt,
      marqueeMode,
      spacePan,
      screenToWorldLocal,
      viewport.scale,
      toolMode,
      model,
      layerVisibility,
      clearSelection,
      toggleSelection,
      setSelection,
      selectedKeys,
      manualEdits,
      setFocusedNetKey,
    ]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // ─── Drafting fast path: three statements, zero allocation ────────────
      // No store write, no React state, no hit test, no geometry. Everything
      // that costs anything happens once per animation frame instead of once per
      // event — which is what "sub-16ms while dragging" actually requires.
      if (
        toolMode === "trace" &&
        pcbRouteDraft &&
        !pinchRef.current &&
        gesturePointerRef.current === null
      ) {
        const t0 = performance.now();
        const ne = e.nativeEvent;
        const coalesced = ne.getCoalescedEvents?.();
        // Only the LAST coalesced point can change the final geometry; the
        // intermediate ones are pure waste.
        const src =
          coalesced && coalesced.length ? coalesced[coalesced.length - 1] : ne;
        const pf = pointerFrameRef.current;
        pf.clientX = src.clientX;
        pf.clientY = src.clientY;
        pf.shiftKey = src.shiftKey;
        pf.ctrlKey = src.ctrlKey || src.metaKey;
        pf.valid = true;
        if (routeRafRef.current === null) {
          routeRafRef.current = requestAnimationFrame(() => flushRef.current());
        }
        routeLive.recordMove(performance.now() - t0);
        return;
      }

      const screen = localPoint(e);
      // Keep the live-pointer map current. Only pointers that went down on the
      // canvas are tracked (a hovering mouse must never enter the map, or it
      // would look like a second finger to the pinch detector).
      const tracked = pointersRef.current.get(e.pointerId);
      if (tracked) {
        tracked.x = screen.x;
        tracked.y = screen.y;
      }

      // ─── Pinch ────────────────────────────────────────────────────────────
      // Scale and translation both come off the frozen anchor, so the content
      // under the fingers stays under the fingers even if a move event drops.
      const pinch = pinchRef.current;
      if (pinch) {
        const pa = pointersRef.current.get(pinch.a);
        const pb = pointersRef.current.get(pinch.b);
        if (pa && pb) {
          setViewport(
            "pcb",
            pinchViewport(pinch.anchor, pa, pb, canvasSize, SCALE_LIMITS)
          );
        }
        return;
      }

      // A pointer that doesn't own the active gesture must not drive it — a
      // second finger resting on the board would otherwise teleport whatever
      // the first finger is dragging.
      const owner = gesturePointerRef.current;
      if (owner !== null && owner !== e.pointerId) return;

      // Slop follows the pointer that's moving, not the device — the same split
      // `isGestureTouch` makes, and only the gesture's owner reaches this far.
      const ptrTol = tolerancesFor(isGestureTouch(e));
      const world = screenToWorldLocal(screen.x, screen.y);
      setPcbCursorMm(world);

      // Armed touch press: promote it to a pan the moment the finger clears the
      // drag threshold. The pan is anchored at the ORIGINAL down point, so the
      // board doesn't jump by the threshold distance when it engages.
      const tap = tapRef.current;
      if (tap && tap.pointerId === e.pointerId && !tap.moved) {
        if (pointerDistance(screen, tap.local) < ptrTol.dragThresholdPx) return;
        tap.moved = true;
        beginPan(e.pointerId, tap.local);
      }

      // Panning?
      if (panStateRef.current) {
        const dx = screen.x - panStateRef.current.startScreen.x;
        const dy = screen.y - panStateRef.current.startScreen.y;
        setViewport("pcb", {
          x: panStateRef.current.startViewport.x + dx,
          y: panStateRef.current.startViewport.y + dy,
          scale: panStateRef.current.startViewport.scale,
        });
        return;
      }

      // Active drag?
      const drag = dragStateRef.current;
      if (drag) {
        if (drag.kind === "marquee") {
          // Only show marquee once mouse has moved past threshold.
          const dx = screen.x - drag.startScreen.x;
          const dy = screen.y - drag.startScreen.y;
          if (Math.hypot(dx, dy) >= ptrTol.dragThresholdPx) {
            setMarquee({
              fromX: drag.startWorld.x,
              fromY: drag.startWorld.y,
              toX: world.x,
              toY: world.y,
            });
          }
        } else if (drag.kind === "move") {
          // World-space cursor delta from the pointerdown anchor.
          const dx = world.x - drag.startWorld.x;
          const dy = world.y - drag.startWorld.y;

          // Suppress the actual write until the user has moved past the
          // threshold — a plain click that selected a part shouldn't
          // immediately commit a no-op edit (which would push undo
          // history + churn the model).
          if (!drag.moved) {
            const screenDx = screen.x - drag.startScreen.x;
            const screenDy = screen.y - drag.startScreen.y;
            if (Math.hypot(screenDx, screenDy) < ptrTol.dragThresholdPx)
              return;
            drag.moved = true;
          }

          // All keys go through ONE batched store write — a multi-select drag
          // must not pay one store notification + manualEdits copy per part
          // per frame.
          const entries: Array<readonly [StableKey, PcbEdit]> = [];
          for (const key of drag.keys) {
            // Read the captured-at-pointerdown world position. This is
            // the FIXED anchor for the move — using model.byKey here
            // would compound the offset every frame since the model
            // rebuilds after each setPcbEdit.
            const startPos = drag.startPositions.get(key);
            if (!startPos) continue;
            const orig = drag.origEdits.get(key);
            const snapped = snapToGrid(
              { x: startPos.x + dx, y: startPos.y + dy },
              GRID_FINE_MM
            );
            entries.push([
              key,
              { ...orig, x: snapped.x, y: snapped.y },
            ] as const);
          }
          setPcbEdits(entries);
        } else if (drag.kind === "trace_segment") {
          // Cursor delta in world space, projected onto the original
          // segment's perpendicular axis — that's the "how far did we
          // slide the segment" scalar. The two non-pinned endpoints
          // move by (perp * delta).
          const dx = world.x - drag.startWorld.x;
          const dy = world.y - drag.startWorld.y;
          const perpDelta = dx * drag.perpX + dy * drag.perpY;

          // Threshold check, same logic as the component move drag.
          if (!drag.moved) {
            const screenDx = screen.x - drag.startScreen.x;
            const screenDy = screen.y - drag.startScreen.y;
            if (Math.hypot(screenDx, screenDy) < ptrTol.dragThresholdPx)
              return;
            drag.moved = true;
          }

          const moving = new Set(drag.movingIndices);
          const nextRoute: PcbRoutePoint[] = drag.origRoute.map((p, i) =>
            moving.has(i)
              ? {
                  ...p,
                  x: p.x + perpDelta * drag.perpX,
                  y: p.y + perpDelta * drag.perpY,
                }
              : { ...p }
          );
          const cur =
            useEditorStore.getState().manualEdits[drag.traceKey]?.pcb ?? {};
          setPcbEdit(drag.traceKey, {
            ...cur,
            route: nextRoute,
            width: drag.origWidth,
          });
        }
        return;
      }

      // Hover update. The route DRAFT never reaches here — it took the fast path
      // above — so this is the pre-draft "light up the pad you'd start from" hint.
      const toleranceMm = ptrTol.hitTolPx / viewport.scale;
      if (toolMode === "trace") {
        const padSnap = findNearestPad(
          model,
          world.x,
          world.y,
          activeLayer,
          ptrTol.snapPadPx / viewport.scale
        );
        setHoveredKey(padSnap?.componentKey ?? null);
        return;
      }

      const hit = hitTestPoint(model, world.x, world.y, {
        layerVisibility,
        toleranceMm,
      });
      setHoveredKey(hit ? hitKeyFromResult(hit) : null);
    },
    [
      screenToWorldLocal,
      localPoint,
      beginPan,
      canvasSize,
      setViewport,
      model,
      viewport.scale,
      toolMode,
      activeLayer,
      pcbRouteDraft,
      layerVisibility,
      setHoveredKey,
      setPcbEdit,
      setPcbEdits,
      setPcbCursorMm,
    ]
  );

  // Clear the live cursor when the pointer leaves the canvas, so the readout and
  // the rubber band don't freeze at the last in-canvas position.
  const onPointerLeave = useCallback(() => {
    if (!pointerFrameRef.current.valid) return;
    pointerFrameRef.current.valid = false;
    scheduleRouteFrame();
  }, [scheduleRouteFrame]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      pointersRef.current.delete(e.pointerId);

      // ─── Pinch teardown ───────────────────────────────────────────────────
      const pinch = pinchRef.current;
      if (pinch && (pinch.a === e.pointerId || pinch.b === e.pointerId)) {
        pinchRef.current = null;
        (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
        // Lifting one finger out of a pinch is how people settle into a
        // one-finger pan, so hand the gesture to the survivor instead of
        // dead-stopping. Re-anchoring at its CURRENT position means no jump.
        const fingers = Array.from(pointersRef.current.entries()).filter(
          ([, p]) => p.touch
        );
        if (fingers.length === 1) {
          // COPY the point. beginPan keeps `start` by reference, and the map
          // entry is mutated in place by every pointermove — handing the live
          // object over would make the pan's origin track the finger, so every
          // delta would come out zero and the board would sit frozen.
          const [id, at] = fingers[0];
          beginPan(id, { x: at.x, y: at.y });
        }
        return;
      }

      // ─── Armed touch press ────────────────────────────────────────────────
      const tap = tapRef.current;
      if (tap && tap.pointerId === e.pointerId) {
        tapRef.current = null;
        if (!tap.moved) {
          // Never crossed the drag threshold, so it was a tap: no pan was ever
          // started and there's nothing to unwind — just run the deferred work.
          gesturePointerRef.current = null;
          (e.currentTarget as SVGSVGElement).releasePointerCapture?.(
            e.pointerId
          );
          tap.action();
          return;
        }
      }

      // A finger that isn't driving the gesture just lifted (it landed too late
      // to become a pinch, say). Leave the gesture — and its pointer capture —
      // exactly where they are.
      const owner = gesturePointerRef.current;
      if (owner !== null && owner !== e.pointerId) return;
      gesturePointerRef.current = null;

      // End pan
      if (panStateRef.current) {
        panStateRef.current = null;
        setPanning(false);
        (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
        return;
      }
      const drag = dragStateRef.current;
      if (!drag) return;
      if (drag.kind === "marquee" && marquee) {
        const rect = rectFromPoints(
          { x: marquee.fromX, y: marquee.fromY },
          { x: marquee.toX, y: marquee.toY }
        );
        const hits = hitTestRect(
          model,
          rect.minX,
          rect.minY,
          rect.maxX,
          rect.maxY,
          { layerVisibility, toleranceMm: 0 }
        );
        const keys = new Set<StableKey>();
        for (const c of hits.components) keys.add(c.key);
        for (const t of hits.traces) keys.add(t.key);
        if (e.shiftKey) {
          const next = new Set(selectedKeys);
          for (const k of keys) next.add(k);
          setSelection(next);
        } else {
          setSelection(keys);
        }
      } else if (drag.kind === "move" && drag.moved) {
        // Bake the dragged positions into tsx (pcbX / pcbY props) so the
        // eval re-runs and downstream consumers — 3D viewer, BOM table,
        // fab-file exporters — see the new placement. Updates batched so
        // a multi-select drag costs one history snapshot, not N.
        const edits = useEditorStore.getState().manualEdits;
        const updates: Array<{
          name: string;
          x?: number;
          y?: number;
        }> = [];
        for (const key of drag.keys) {
          const comp = model.byKey.get(key);
          if (!comp || !("name" in comp)) continue;
          const editPcb = edits[key]?.pcb;
          if (!editPcb) continue;
          updates.push({ name: comp.name, x: editPcb.x, y: editPcb.y });
        }
        // Pin every auto-placed part in place too, so the eval triggered by
        // this bake doesn't re-pack the parts the user didn't touch (see
        // withAutoPlacedPins — the "other components move on their own" fix).
        if (updates.length > 0)
          bakePcbComponentTransform(withAutoPlacedPins(model, updates));
      }
      dragStateRef.current = null;
      setMarquee(null);
      (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
    },
    [
      marquee,
      model,
      layerVisibility,
      selectedKeys,
      setSelection,
      beginPan,
      bakePcbComponentTransform,
    ]
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
    },
    []
  );

  // Pointer cancellation cleanup. Fires when the OS / browser takes the
  // pointer away mid-gesture (touch interruption, window blur, scroll
  // capture by another element). Without this, panStateRef /
  // dragStateRef stay non-null and the next pointermove resumes the
  // previous gesture as if the user never released the button — and the
  // pointer map keeps a phantom finger down, which would wedge the canvas in
  // "two fingers are on the glass" forever.
  const onPointerCancel = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      forgetPointer(e.pointerId);
      (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
    },
    [forgetPointer]
  );

  // Capture loss can also arrive WITHOUT a pointerup — the browser revokes it
  // when the captured element is removed or another element takes over. Same
  // cleanup, and it's idempotent with the pointerup path (which has already
  // nulled the owner by the time the event fires, so the id comparison inside
  // forgetPointer keeps it from clobbering a freshly handed-over gesture).
  const onLostPointerCapture = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      forgetPointer(e.pointerId);
    },
    [forgetPointer]
  );

  // Double-click on the canvas = fit view (mirrors schematic). Skip when the
  // click lands on a drag-eligible target, so muscle-memory drag interactions
  // aren't ambushed by the fit. While a route is in flight it means Finish
  // Route instead — the gesture every reference tool uses.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (pcbRouteDraft) {
        finishRouteAtCursor();
        return;
      }
      // Ignore double-click if the user landed on something — keeps the
      // gesture aligned with schematic where dbl-click on a component is
      // a no-op (fit only triggers on empty canvas).
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const world = screenToWorldLocal(
        e.clientX - rect.left,
        e.clientY - rect.top
      );
      // A MouseEvent carries no pointerType, so this is the one hit test that
      // can't size itself per pointer and falls back to the device default.
      const toleranceMm = tol.hitTolPx / viewport.scale;
      const hit = hitTestPoint(model, world.x, world.y, {
        layerVisibility,
        toleranceMm,
      });
      if (hit) return;
      fitToView();
    },
    [
      pcbRouteDraft,
      screenToWorldLocal,
      viewport.scale,
      tol,
      model,
      layerVisibility,
      fitToView,
      finishRouteAtCursor,
    ]
  );

  // Sort layers bottom→top so SVG paint order yields the right z-stacking.
  // NOTE: must run before any conditional early-return so React sees a
  // stable hook order across renders (otherwise switching tabs while
  // circuitJson is transiently empty trips the Hooks-order detector).
  const orderedLayers = useMemo(
    () =>
      [...displayLayers]
        .filter((l) => layerVisibility[l.id] !== false)
        .sort((a, b) => a.zOrder - b.zOrder),
    [displayLayers, layerVisibility]
  );

  // Per-element visibility: pads / vias / components / silkscreen are drawn
  // outside the per-layer iteration, so they need their own filter against
  // layerVisibility. Mirrors the hit-test rules in hitTest.ts so what you
  // see equals what you can click. Through-holes span every copper layer —
  // they vanish only when EVERY copper layer is hidden. Vias survive while
  // either of their endpoint layers is on.
  const anyCopperVisible = useMemo(
    () => copperLayers.some((l) => layerVisibility[l.id] !== false),
    [copperLayers, layerVisibility]
  );
  const isPadVisible = useCallback(
    (pad: PcbPadRecord): boolean =>
      pad.isThroughHole
        ? anyCopperVisible
        : layerVisibility[pad.layer] !== false,
    [anyCopperVisible, layerVisibility]
  );
  const isViaVisible = useCallback(
    (via: { fromLayer: LayerId; toLayer: LayerId }): boolean =>
      layerVisibility[via.fromLayer] !== false ||
      layerVisibility[via.toLayer] !== false,
    [layerVisibility]
  );
  const isLayerOn = useCallback(
    (layer: LayerId): boolean => layerVisibility[layer] !== false,
    [layerVisibility]
  );

  // Keys whose highlight (selection halo / hover outline) the SVG overlay
  // redraws on top of the canvas base layer. A handful at most, so re-rendering
  // them on every hover/selection change is cheap — and crucially never
  // triggers a canvas redraw.
  const highlightKeys = useMemo(() => {
    const keys = new Set<StableKey>(selectedKeys);
    if (hoveredKey) keys.add(hoveredKey);
    return keys;
  }, [selectedKeys, hoveredKey]);

  // Resolve the highlighted records via O(1) byKey lookups rather than scanning
  // every trace/component each time the viewport changes — a pan over a dense
  // board would otherwise iterate thousands of elements just to find the few
  // that are selected/hovered. (Trace records carry `segments`; components don't.)
  const highlightTraces = useMemo(() => {
    const out: PcbTraceRecord[] = [];
    for (const key of highlightKeys) {
      const rec = model.byKey.get(key);
      if (rec && "segments" in rec) out.push(rec);
    }
    return out;
  }, [highlightKeys, model]);
  const highlightComponents = useMemo(() => {
    const out: PcbComponentRecord[] = [];
    for (const key of highlightKeys) {
      const rec = model.byKey.get(key);
      if (rec && !("segments" in rec)) out.push(rec);
    }
    return out;
  }, [highlightKeys, model]);

  // Pads belonging to a selected component get a halo. Resolve them once per
  // selection / model change instead of re-scanning every pad on each render —
  // PcbCanvas re-renders per frame during pans and drags, so an inline
  // `model.pads.map` would walk the whole pad list each time while a part
  // is selected. Halo is a selection-only cue (hover doesn't change a pad), so
  // hoveredKey is intentionally not an input here.
  const selectedPads = useMemo(() => {
    if (selectedKeys.size === 0) return [];
    const out: PcbPadRecord[] = [];
    for (const pad of model.pads) {
      if (pad.componentKey && selectedKeys.has(pad.componentKey)) out.push(pad);
    }
    return out;
  }, [selectedKeys, model]);

  // ─── Canvas draw (static geometry) ──────────────────────────────────────
  // One rAF-coalesced `drawPcb` per change of a draw-relevant input. Multiple
  // state changes in a tick (e.g. a wheel event that updates the viewport)
  // collapse into a single frame; selection / hover are NOT inputs here — they
  // live on the SVG overlay so they never force a full canvas repaint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (drawRafRef.current != null) cancelAnimationFrame(drawRafRef.current);
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Backing store in device px; CSS box stays canvasSize.
      const backW = Math.max(1, Math.round(canvasSize.width * dpr));
      const backH = Math.max(1, Math.round(canvasSize.height * dpr));
      if (canvas.width !== backW) canvas.width = backW;
      if (canvas.height !== backH) canvas.height = backH;
      drawPcb(ctx, model, viewport, canvasSize, {
        orderedLayers,
        isPadVisible,
        isViaVisible,
        isLayerOn,
        focusedNet,
        focusedNetSelectors,
        chipLikeNames,
        pin1ByCompKey,
        padCountByCompKey,
        dpr,
      });
    });
    return () => {
      if (drawRafRef.current != null) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
    };
  }, [
    model,
    viewport,
    canvasSize,
    dpr,
    orderedLayers,
    isPadVisible,
    isViaVisible,
    isLayerOn,
    focusedNet,
    focusedNetSelectors,
    chipLikeNames,
    pin1ByCompKey,
    padCountByCompKey,
  ]);

  // ─── Route overlay: paint + frame flush ─────────────────────────────────

  const paintRouteOverlay = useCallback(() => {
    const canvas = routeCanvasRef.current;
    const ctx = frameCtxRef.current;
    if (!canvas || !ctx) return;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    const backW = Math.max(1, Math.round(ctx.canvasSize.width * ctx.dpr));
    const backH = Math.max(1, Math.round(ctx.canvasSize.height * ctx.dpr));
    // Assigning width/height resets every context property, so the transform is
    // re-installed by drawRouteOverlay on each call anyway.
    if (canvas.width !== backW) canvas.width = backW;
    if (canvas.height !== backH) canvas.height = backH;
    drawRouteOverlay(
      c2d,
      routeLive.snapshot,
      ctx.viewport,
      ctx.canvasSize,
      ctx.dpr,
      { isLayerOn: ctx.isLayerOn, nowMs: performance.now() }
    );
  }, []);

  useEffect(() => routeLive.subscribePaint(paintRouteOverlay), [paintRouteOverlay]);

  // The rAF closure never reads React state; this effect is the only writer of
  // the context it does read.
  useEffect(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    frameCtxRef.current = {
      model,
      viewport,
      canvasSize,
      dpr,
      originX: rect?.left ?? 0,
      originY: rect?.top ?? 0,
      tol,
      numLayers,
      routingMode,
      netSelectors: focusedNetSelectors,
      obstacleExcludeSelectors: routeExcludeSelectors,
      isLayerOn,
      haloVisible: clearanceHaloVisible,
    };
    scheduleRouteFrame();
  }, [
    model,
    viewport,
    canvasSize,
    dpr,
    tol,
    numLayers,
    routingMode,
    focusedNetSelectors,
    routeExcludeSelectors,
    isLayerOn,
    clearanceHaloVisible,
    pcbRouteDraft,
    scheduleRouteFrame,
  ]);

  // The <svg>'s page origin moves with scroll and window resize, neither of
  // which re-renders this component — so the cached origin needs its own hook.
  useEffect(() => {
    const refresh = () => {
      const rect = svgRef.current?.getBoundingClientRect();
      const ctx = frameCtxRef.current;
      if (!rect || !ctx) return;
      ctx.originX = rect.left;
      ctx.originY = rect.top;
    };
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    return () => {
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, []);

  // Tear the walkaround's last-good state down with the draft, not lazily — a
  // hug from a finished route must never bleed into the next one.
  useEffect(() => {
    if (pcbRouteDraft) return;
    resetWalkaroundStore(walkStoreRef.current);
    lastSolveRef.current.key = "";
    travelRef.current.seeded = false;
    obstacleRef.current = null;
  }, [pcbRouteDraft]);

  const flushRouteFrame = useCallback(() => {
    routeRafRef.current = null;
    const t0 = performance.now();
    routeLive.stats.rafCount++;
    const ctx = frameCtxRef.current;
    const draft = useEditorStore.getState().pcbRouteDraft;
    const snap = routeLive.snapshot;

    if (!ctx || !draft || draft.points.length === 0) {
      if (snap.active) {
        routeLive.clear();
        routeLive.publish();
        routeLive.publishHud(t0, true);
      }
      return;
    }

    // ─── Committed draft ──────────────────────────────────────────────────
    const pts = draft.points;
    routeLive.ensureCommittedCapacity(pts.length);
    snap.committedLayer.length = 0;
    let committedMm = 0;
    let viaCount = 0;
    for (let i = 0; i < pts.length; i++) {
      snap.committedX[i] = pts[i].x;
      snap.committedY[i] = pts[i].y;
      snap.committedLayer.push(pts[i].layer);
      if (i === 0) continue;
      if (pts[i].layer !== pts[i - 1].layer) viaCount++;
      else committedMm += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    snap.committedLen = pts.length;

    const anchor = pts[pts.length - 1];
    const cursor = snapCursorTarget(ctx, draft, anchor, pointerFrameRef.current);
    snapTargetRef.current = cursor.target;

    // ─── Posture ──────────────────────────────────────────────────────────
    const travel = travelRef.current;
    if (travel.seeded) {
      travel.dx[travel.i] = cursor.x - travel.lastX;
      travel.dy[travel.i] = cursor.y - travel.lastY;
      travel.i = (travel.i + 1) % POSTURE_TRAVEL_SAMPLES;
    }
    travel.lastX = cursor.x;
    travel.lastY = cursor.y;
    travel.seeded = true;
    let posture = draft.posture;
    if (!draft.postureLocked) {
      let tx = 0;
      let ty = 0;
      for (let i = 0; i < POSTURE_TRAVEL_SAMPLES; i++) {
        tx += travel.dx[i];
        ty += travel.dy[i];
      }
      posture = autoPosture({
        pointCount: pts.length,
        startPadBox: startPadBox(ctx.model, draft.fromSelector),
        travelX: tx,
        travelY: ty,
      });
    }
    effectivePostureRef.current = posture;

    // ─── Obstacles ────────────────────────────────────────────────────────
    const buildOpts: BuildObstaclesOpts = {
      model: ctx.model,
      layer: draft.activeLayer,
      layerCount: ctx.numLayers,
      traceWidthMm: draft.width,
      excludeSelectors: ctx.obstacleExcludeSelectors,
      excludeTraceKey: draft.traceKey,
      clearances: ctx.model.board?.clearances ?? DEFAULT_BOARD_CLEARANCES,
    };
    const key = obstacleSetKey(buildOpts);
    if (obstacleRef.current?.key !== key) {
      obstacleRef.current = { key, set: buildRouteObstacles(buildOpts) };
    }
    const obstacles = obstacleRef.current.set;

    // ─── Tier 1: leader, on top of tier 2's frozen hug ────────────────────
    // `conflictMode` belongs in the key: switching to `ignore` stops the solver
    // being asked, and without the key change the last accepted hug would stay
    // frozen on screen — so the mode that promises to draw straight through
    // copper would instead keep drawing around it until the cursor went stale.
    const anchorKey = `${pts.length}:${anchor.x}:${anchor.y}:${draft.activeLayer}:${ctx.routingMode}:${draft.width}:${draft.conflictMode}`;
    const hug = readWalkaround(walkStoreRef.current, cursor, anchorKey);
    const tail = hug.hugEnd ?? anchor;
    // A two-segment leader has a mirror image with the same endpoint, and the two
    // rarely collide with the same copper. While the user has not taken over the
    // posture, prefer the one that fits: without this, an auto-guessed posture
    // draws straight through a pad the mirror clears, the solver correctly reports
    // a DIRECT connection (so there is no hug to fix it), and the band the user
    // clicks commits a violation. Only ever swaps AWAY from a collision, so the
    // choice stays a pure function of cursor + copper — no oscillation.
    if (!draft.postureLocked && postureCollides(obstacles, tail, cursor, ctx.routingMode, posture)) {
      const mirror = swapPosture(posture);
      if (!postureCollides(obstacles, tail, cursor, ctx.routingMode, mirror)) {
        posture = mirror;
        effectivePostureRef.current = posture;
      }
    }
    const leader = leaderPath(
      tail,
      cursor,
      ctx.routingMode,
      posture,
      draft.cornerRadiusMm
    );
    const leaderPts =
      ctx.routingMode === "curved" ? tessellateLeader(tail, leader) : leader.points;

    if (
      ctx.routingMode !== "free" &&
      leaderPts.length === 1 &&
      offAxisOffDiagonal(tail, cursor)
    ) {
      // The leader is required to produce a knee here; a single segment would be
      // the old straight-rubber-band fallback, which is exactly the flicker.
      routeLive.stats.directFallbackCount++;
    }

    // ─── Compose ──────────────────────────────────────────────────────────
    const total = 1 + hug.path.length + leaderPts.length;
    routeLive.ensurePreviewCapacity(total);
    snap.previewX[0] = anchor.x;
    snap.previewY[0] = anchor.y;
    let n = 1;
    for (const p of hug.path) {
      snap.previewX[n] = p.x;
      snap.previewY[n] = p.y;
      n++;
    }
    const leaderBase = n;
    for (const p of leaderPts) {
      snap.previewX[n] = p.x;
      snap.previewY[n] = p.y;
      n++;
    }
    snap.previewLen = n;
    snap.kneeIndex =
      leader.kneeIndex < 0
        ? -1
        : ctx.routingMode === "curved"
          ? leaderBase + Math.floor((leaderPts.length - 2) / 2)
          : leaderBase + leader.kneeIndex;

    for (let i = 0; i < n - 1; i++) {
      snap.previewHit[i] = segmentHitsHard(
        obstacles,
        snap.previewX[i],
        snap.previewY[i],
        snap.previewX[i + 1],
        snap.previewY[i + 1]
      )
        ? 1
        : 0;
    }

    let previewMm = 0;
    for (let i = 1; i < n; i++) {
      previewMm += Math.hypot(
        snap.previewX[i] - snap.previewX[i - 1],
        snap.previewY[i] - snap.previewY[i - 1]
      );
    }
    // Arcs are longer than their chords, so the readout uses true arc length.
    if (ctx.routingMode === "curved") {
      previewMm =
        polylineLengthMm([anchor, ...hug.path]) + leaderLengthMm(tail, leader);
    }

    const target = cursor.target;
    snap.active = true;
    // The rubber band's own endpoint IS the snapped cursor: the axis-lock in the
    // degenerate cases moves the landing point, and the readout must report where
    // the copper will go, not where the mouse happens to be.
    snap.cursorValid = pointerFrameRef.current.valid;
    snap.cursorX = n > 1 ? snap.previewX[n - 1] : anchor.x;
    snap.cursorY = n > 1 ? snap.previewY[n - 1] : anchor.y;
    snap.snapKind = target ? (target.foreignNet ? 2 : 1) : 0;
    snap.snapX = target?.x ?? 0;
    snap.snapY = target?.y ?? 0;
    snap.snapRadiusMm = Math.max(0.35, draft.width * 1.6);
    snap.blocked = hug.blocked;
    snap.layer = draft.activeLayer;
    snap.widthMm = draft.width;
    snap.clearanceHaloMm = clearanceHaloWidthMm(
      draft.width,
      buildOpts.clearances
    );
    snap.haloVisible = ctx.haloVisible;
    snap.pendingViaActive = draft.pendingVia !== null;
    snap.pendingViaX = draft.pendingVia?.x ?? 0;
    snap.pendingViaY = draft.pendingVia?.y ?? 0;
    snap.mode = ctx.routingMode;
    snap.posture = posture;
    snap.postureLocked = draft.postureLocked;
    snap.conflictMode = draft.conflictMode;
    snap.committedLengthMm = committedMm;
    snap.leaderLengthMm = previewMm;
    snap.viaCount = viaCount;

    // ─── Paint BEFORE solving ─────────────────────────────────────────────
    // The pixels are committed before the budget is spent, so even a solve that
    // burns its whole deadline cannot push visible geometry into the next frame.
    // This ordering is load-bearing.
    routeLive.publish();

    if (draft.conflictMode === "walkaround") {
      const lastSolve = lastSolveRef.current;
      const moved = Math.hypot(cursor.x - lastSolve.x, cursor.y - lastSolve.y);
      if (moved >= SOLVE_MIN_DELTA_MM || lastSolve.key !== anchorKey) {
        lastSolve.x = cursor.x;
        lastSolve.y = cursor.y;
        lastSolve.key = anchorKey;
        const result = solveWalkaround({
          set: obstacles,
          from: anchor,
          to: cursor,
          mode: ctx.routingMode,
          deadlineMs: t0 + SOLVE_BUDGET_MS,
        });
        routeLive.stats.solveCount++;
        if (result.status === "ok") routeLive.stats.okCount++;
        else if (result.status === "timeout") routeLive.stats.timeoutCount++;
        else routeLive.stats.blockedCount++;
        offerSolution(walkStoreRef.current, result, cursor, anchorKey);
      }
    }

    routeLive.recordFlush(performance.now() - t0);
    routeLive.publishHud(t0);
  }, []);

  useEffect(() => {
    flushRef.current = flushRouteFrame;
  }, [flushRouteFrame]);

  // ─── Empty / loading state ──────────────────────────────────────────────
  // Three branches:
  //   1. Schematic has no components → "No PCB yet" hint. Checked first so
  //      a bare <board/> (which produces a non-empty circuitJson) still
  //      surfaces the hint instead of an empty canvas.
  //   2. Schematic has components but circuitJson isn't ready yet (first
  //      tab switch, fresh project load) → spinner.
  //   3. Everything ready → fall through and render the canvas.
  if (!hasSchematicComponents) {
    return (
      <div
        ref={containerRef}
        className="absolute inset-0 flex flex-col bg-background"
      >
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-sm text-muted-foreground">
            <p className="text-sm font-medium mb-1">No PCB yet</p>
            <p className="text-xs opacity-70">
              Add components to your schematic, then come back here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!circuitJson || circuitJson.length === 0) {
    return (
      <div
        ref={containerRef}
        className="absolute inset-0 flex flex-col bg-background"
      >
        <div className="flex-1 flex items-center justify-center">
          <CircuitLoading label="Building PCB…" />
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  // SVG transform: place world origin at canvas center, then scale+flip-Y.
  const netFocusActive = focusedNetSelectors !== null;
  const stageTransform = `translate(${canvasSize.width / 2 + viewport.x}, ${
    canvasSize.height / 2 + viewport.y
  }) scale(${viewport.scale}, ${-viewport.scale})`;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex bg-[color:var(--pcb-bg)]"
      style={
        {
          // Background lives on the container so the SVG can be transparent
          // and let the dot grid show through.
          ["--pcb-bg" as string]: COLOR_BG,
        } as React.CSSProperties
      }
    >
      <div
        ref={setCanvasWrapperEl}
        className="flex-1 min-w-0 relative overflow-hidden"
      >
        {/* Static board geometry — one imperative draw call per frame, zero
            DOM. Sits under the <svg>; all pointer-events stay on the SVG. CSS
            box is canvasSize; the backing store (canvasSize × dpr) is sized in
            the draw effect. */}
        <canvas
          ref={canvasRef}
          data-testid="pcb-base-canvas"
          className="absolute inset-0"
          style={{
            width: canvasSize.width,
            height: canvasSize.height,
            pointerEvents: "none",
          }}
        />
        {/* Manual-routing preview. Strictly between the base canvas and the
            <svg>: above it, `setPointerCapture` and every child handler on the
            SVG would silently die; below it, the preview would hide under
            committed copper. No z-index — paint order is DOM order, and this
            root creates no stacking context. */}
        <canvas
          ref={routeCanvasRef}
          data-testid="pcb-route-canvas"
          className="absolute inset-0"
          style={{
            width: canvasSize.width,
            height: canvasSize.height,
            pointerEvents: "none",
          }}
        />
        <svg
          ref={svgRef}
          data-testid="pcb-stage"
          width={canvasSize.width}
          height={canvasSize.height}
          onWheel={onWheel}
          // Pointer bookkeeping runs in the CAPTURE phase: children (airwires,
          // DRC markers) stopPropagation on pointerdown, and a finger landing
          // on one of those must still register so pinch can start.
          onPointerDownCapture={onPointerDownCapture}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onLostPointerCapture}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          className="absolute inset-0 select-none"
          style={{
            cursor: cursorForTool(toolMode, !!pcbRouteDraft, spacePan, panning),
            // Transparent so the <canvas> board geometry beneath shows through;
            // the container holds COLOR_BG.
            background: "transparent",
            // Disable browser touch gestures so wheel events arrive.
            touchAction: "none",
          }}
        >
          <g transform={stageTransform}>
            {/* Selection / hover highlights — the only board geometry left on
                the SVG. Redrawn on top of the canvas base layer for just the
                selected/hovered keys, reusing the same shape components so the
                halo + outline read pixel-for-pixel with the old renderer. Kept
                off the canvas so rapid hover/selection never repaints it. */}
            <g>
              {highlightTraces.flatMap((trace) => {
                const highlight = selectedKeys.has(trace.key)
                  ? COLOR_SELECTED
                  : COLOR_HOVER;
                const dimmed =
                  netFocusActive &&
                  !isTraceOnNet(trace.key, focusedNetSelectors!);
                return trace.segments.map((seg, idx) =>
                  isLayerOn(seg.layer) ? (
                    <TraceSegmentShape
                      key={`${trace.key}-${idx}`}
                      seg={seg}
                      color={getLayerColor(seg.layer)}
                      highlight={highlight}
                      opacity={dimmed ? DIMMED_OPACITY : 1}
                    />
                  ) : null
                );
              })}
              {/* Only selected components' pads get a halo; hover doesn't change
                  a pad's look (mirrors the old PadShape `selected` prop). The
                  selected-pad set is memoized so this isn't an O(pads) scan on
                  every pointer-move render. */}
              {selectedPads.map((pad) => {
                if (!isPadVisible(pad)) return null;
                return (
                  <PadShape
                    key={padDomKey(pad)}
                    pad={pad}
                    selected
                    opacity={
                      netFocusActive &&
                      !isPadOnNet(pad, model, focusedNetSelectors!)
                        ? DIMMED_OPACITY
                        : 1
                    }
                  />
                );
              })}
              {highlightComponents.map((comp) => {
                if (!isLayerOn(comp.layer)) return null;
                return (
                  <ComponentBody
                    key={comp.key}
                    comp={comp}
                    pads={model.pads}
                    showOutline={
                      chipLikeNames.has(comp.name) ||
                      (padCountByCompKey.get(comp.key) ?? 0) > 2
                    }
                    selected={selectedKeys.has(comp.key)}
                    hovered={hoveredKey === comp.key}
                    pin1={
                      chipLikeNames.has(comp.name)
                        ? pin1ByCompKey.get(comp.key) ?? null
                        : null
                    }
                    opacity={
                      netFocusActive &&
                      !focusedNet!.pads.some(
                        (p) => p.componentKey === comp.key
                      )
                        ? DIMMED_OPACITY
                        : 1
                    }
                  />
                );
              })}
            </g>

            {/* Ratsnest — memoized: pan/zoom frames re-render PcbCanvas but
                must not re-reconcile every airwire (the one unbounded SVG
                subtree left on the overlay). */}
            <RatsnestLayer
              edges={ratsnest}
              focusedNetKey={focusedNetKey}
              netFocusActive={netFocusActive}
              hitPx={tol.ratsnestHitPx}
              pickable={toolMode !== "trace"}
              onEdgePress={handleEdgePress}
              onRouteEdge={handleRouteEdge}
            />

            {/* DRC violation markers (drawn on top). Routing checks run over
                the merged circuit-json so manual routes are flagged too. Only
                violations that report a board-space center get a marker; the
                StatusBar shows the total count regardless. Hidden via the
                StatusBar eye toggle without affecting the count/inspector. */}
            {drcVisible && (
              <DrcOverlay
                violations={drcViolations}
                focusedId={focusedDrcId}
                onSelect={focusViolation}
              />
            )}

            {/* Marquee selection rectangle. */}
            {marquee && (
              <rect
                x={Math.min(marquee.fromX, marquee.toX)}
                y={Math.min(marquee.fromY, marquee.toY)}
                width={Math.abs(marquee.toX - marquee.fromX)}
                height={Math.abs(marquee.toY - marquee.fromY)}
                fill="rgba(255, 214, 0, 0.1)"
                stroke={COLOR_SELECTED}
                strokeWidth={1}
                strokeDasharray="3 2"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        </svg>

        {/* Top chrome, stacked in ONE column: the toolbar grows a second row on
            touch, and a banner pinned at a fixed offset would end up underneath
            it. pointer-events-none so the gaps around the pills still pan. */}
        <div className="absolute top-2 inset-x-0 z-10 flex flex-col items-center gap-1 px-2 pointer-events-none">
          <PcbToolbar
            toolMode={toolMode}
            routingMode={routingMode}
            onSelectTool={setToolMode}
            onSetRoutingMode={setRoutingMode}
            onCycleRoutingMode={cycleRoutingMode}
            onFit={fitToView}
            onRestoreNetAutoroute={() => restoreNetAutoroute()}
            onRestoreBoardAutoroute={() => restoreBoardAutoroute()}
            canRestoreNet={focusedNetKey !== null}
            canRestoreBoard={routeEditKeys.length > 0}
            drafting={!!pcbRouteDraft}
            canAddVia={copperLayerIds.length > 1}
            onAddVia={toggleViaAtCursor}
            onUndoRoutePoint={() => popPcbRoutePoint()}
            onCancelRoute={() => clearPcbRouteDraft()}
            posture={
              pcbRouteDraft?.postureLocked ? pcbRouteDraft.posture : null
            }
            onSwapPosture={() => swapPostureNow()}
            conflictMode={pcbRouteDraft?.conflictMode ?? null}
            onCycleConflictMode={cyclePcbConflictMode}
            haloVisible={clearanceHaloVisible}
            onToggleHalo={toggleClearanceHalo}
            hasSelection={selectedKeys.size > 0}
            onDeleteSelection={deleteSelection}
            marqueeMode={marqueeMode}
            onToggleMarqueeMode={() => setMarqueeMode((v) => !v)}
            layersOpen={layersOpen}
            onToggleLayers={() => setLayersOpen((v) => !v)}
          />

          <RouteModeBanner
            active={toolMode === "trace"}
            activeLayer={activeLayer}
            drafting={!!pcbRouteDraft}
            routingMode={routingMode}
            compact={showTouchActions}
          />
        </div>

        <StatusBar
          activeLayer={activeLayer}
          gridMm={GRID_FINE_MM}
          traceWidthMm={traceWidth}
          widthProfileLabel={profileForWidth(traceWidth)?.label ?? null}
          routingMode={routingMode}
          toolMode={toolMode}
          drcCount={drcViolations.length}
          onDrcClick={
            drcViolations.length > 0
              ? () => useEditorStore.getState().setIssuesOpen(true)
              : undefined
          }
          drcVisible={drcVisible}
          onToggleDrcVisible={() => setDrcVisible((v) => !v)}
          onCycleTraceWidth={cycleTraceWidth}
        />

        {focusedViolation && (
          <DrcInspector
            violation={focusedViolation}
            index={focusedDrcIndex}
            total={drcViolations.length}
            onPrev={() => stepViolation(-1)}
            onNext={() => stepViolation(1)}
            onClose={() => setFocusedDrcId(null)}
          />
        )}
      </div>

      <LayerPanel
        layers={displayLayers}
        activeLayer={activeLayer}
        layerVisibility={layerVisibility}
        numLayers={numLayers}
        onActivate={activateLayer}
        onToggleVisibility={(layer) =>
          useEditorStore.getState().toggleLayerVisibility(layer)
        }
        onSetLayerCount={(n) => setBoard({ layers: n })}
        open={layersOpen}
        onClose={() => setLayersOpen(false)}
      />
    </div>
  );
}

// Airwire overlay. Memoized because it's the one unbounded SVG subtree left on
// the interactive layer: a dense board can carry hundreds of airwires, and
// without the memo every pan/zoom/selection render re-reconciled all of them.
// Handlers are identity-stable (store action + getState-reading callback), so
// during pan/zoom the whole subtree bails out and only the parent <g>'s
// transform attribute changes.
const RatsnestLayer = memo(function RatsnestLayer({
  edges,
  focusedNetKey,
  netFocusActive,
  hitPx,
  pickable,
  onEdgePress,
  onRouteEdge,
}: {
  edges: ReadonlyArray<RatsnestEdge>;
  focusedNetKey: StableKey | null;
  netFocusActive: boolean;
  // Screen-px width of the invisible pick capsule — wider on a coarse pointer,
  // where a 1px airwire is otherwise impossible to hit with a fingertip.
  hitPx: number;
  // False while the route tool is active. Airwires are MST edges *between
  // pads*, so their pick capsules are densest exactly over the pads — the one
  // place a click has to land to start or finish a route. Leaving them pickable
  // means the press hits the airwire's handler, which stops propagation and
  // focuses the net instead of terminating the route. While routing they are
  // guides, not targets; net focus stays available from the select tool.
  pickable: boolean;
  // Owns stopPropagation as well as the focus: on touch the parent turns the
  // press into a deferred tap so a drag from an airwire can still pan.
  onEdgePress: (e: React.PointerEvent, edge: RatsnestEdge) => void;
  onRouteEdge: (edge: RatsnestEdge) => void;
}) {
  return (
    <g>
      {edges.map((edge, idx) => {
        const focused = edge.traceKey === focusedNetKey;
        return (
          <g
            key={idx}
            style={pickable ? { cursor: "pointer" } : undefined}
            onPointerDown={pickable ? (e) => onEdgePress(e, edge) : undefined}
            onDoubleClick={
              pickable
                ? (e) => {
                    e.stopPropagation();
                    onRouteEdge(edge);
                  }
                : undefined
            }
          >
            {/* Generous screen-space hit target — the visible stroke
                stays 1–2 px but picking uses this invisible capsule. */}
            <line
              x1={edge.fromX}
              y1={edge.fromY}
              x2={edge.toX}
              y2={edge.toY}
              stroke="transparent"
              strokeWidth={hitPx}
              vectorEffect="non-scaling-stroke"
              pointerEvents={pickable ? undefined : "none"}
            />
            <line
              x1={edge.fromX}
              y1={edge.fromY}
              x2={edge.toX}
              y2={edge.toY}
              stroke={focused ? COLOR_HOVER : COLOR_RATSNEST}
              strokeWidth={focused ? 2 : 1}
              strokeDasharray="2 1.5"
              vectorEffect="non-scaling-stroke"
              opacity={focused ? 1 : netFocusActive ? 0.35 : 0.85}
              pointerEvents="none"
            />
            <title>
              {focused
                ? "Focused net — A or double-click restores its autoroute"
                : "Click to focus net, double-click to restore its autoroute"}
            </title>
          </g>
        );
      })}
    </g>
  );
});

// DRC violation markers. Each violation with a board-space center renders a
// non-scaling ring with a crosshair so it reads at any zoom; the message is an
// SVG <title> tooltip. Clicking a marker focuses it (the parent pans/zooms and
// opens the DrcInspector). Violations without a center (e.g. unconnected port)
// are counted in the StatusBar and reachable via the inspector's prev/next.
const DrcOverlay = memo(function DrcOverlay({
  violations,
  focusedId,
  onSelect,
}: {
  violations: DrcViolation[];
  focusedId: string | null;
  onSelect: (v: DrcViolation) => void;
}) {
  return (
    <g>
      {violations.map((v) => {
        if (!v.center) return null;
        const focused = v.id === focusedId;
        return (
          <g
            key={v.id}
            transform={`translate(${v.center.x},${v.center.y})`}
            style={{ cursor: "pointer" }}
            // Stop the canvas pan/marquee/select handlers from also firing.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(v);
            }}
          >
            {/* Generous transparent hit target (markers are sub-millimeter). */}
            <circle r={1.4} fill="transparent" />
            <circle
              r={focused ? 1.0 : 0.7}
              fill="rgba(255, 77, 79, 0.15)"
              stroke={COLOR_DRC}
              strokeWidth={focused ? 2.5 : 1.5}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={-0.4}
              y1={0}
              x2={0.4}
              y2={0}
              stroke={COLOR_DRC}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={0}
              y1={-0.4}
              x2={0}
              y2={0.4}
              stroke={COLOR_DRC}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <title>{v.message}</title>
          </g>
        );
      })}
    </g>
  );
});

// Floating card that shows the full message for the focused DRC violation and
// lets the user step through every issue (including center-less ones).
function DrcInspector({
  violation,
  index,
  total,
  onPrev,
  onNext,
  onClose,
}: {
  violation: DrcViolation;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const label = violation.type.replace(/_/g, " ");
  return (
    // max-w caps the card to the canvas on a phone, where a fixed 320px would
    // run off the right edge.
    <div className="absolute bottom-9 left-3 z-10 w-80 max-w-[calc(100%-1.5rem)] rounded-md border border-border bg-sidebar/95 backdrop-blur-sm p-3 text-xs shadow-lg select-none">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: COLOR_DRC }} />
          <span className="font-medium text-foreground">
            DRC issue {total > 0 ? index + 1 : 0} of {total}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground px-1"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {label}
      </div>
      <p className="text-foreground leading-snug mb-2">{violation.message}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={total < 2}
          className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={total < 2}
          className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          Next →
        </button>
        {!violation.center && (
          <span className="text-muted-foreground italic ml-auto">
            no location
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Small subcomponents (kept local so closures stay tight) ─────────────────

// Top-of-canvas banner shown while the route tool is active. Mirrors the
// schematic editor's StatusOverlay pattern. Two text variants: pre-draft
// (waiting on the first pad click) and mid-draft (route in progress).
// Color comes from the active layer so the banner is also a layer cue.
function RouteModeBanner({
  active,
  activeLayer,
  drafting,
  routingMode,
  compact,
}: {
  active: boolean;
  activeLayer: LayerId;
  drafting: boolean;
  routingMode: PcbRoutingMode;
  // Drop the keyboard cheat-sheet. It lists keys a touch device doesn't have,
  // and at ~200 characters it wraps into a five-line wall of text over the
  // board — the toolbar's contextual row carries those actions instead.
  compact: boolean;
}) {
  if (!active) return null;
  const layer = getLayer(activeLayer);
  const layerName = layer?.label ?? activeLayer;
  const color = getLayerColor(activeLayer);
  // Five hints, not twelve. The old banner listed every key and wrapped into a
  // wall of text across the board; these are the ones a router reaches for
  // without looking, and ShortcutsHelp carries the rest.
  const hints: ReadonlyArray<readonly [string, string]> = drafting
    ? [
        ["Space", "swap corner"],
        ["⇧Space", "corner style"],
        ["V", "via"],
        ["Enter", "finish"],
        ["Esc", "cancel"],
      ]
    : [
        ["Click pad", "start route"],
        ["A", "re-autoroute net"],
        ["Esc", "cancel"],
      ];
  return (
    <div className="flex max-w-full justify-center overflow-hidden">
      <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-sidebar/90 px-2.5 py-1 font-mono text-[11px] shadow-lg backdrop-blur-sm select-none">
        <span className="flex items-center gap-1.5">
          {/* Layer colour is data, not styling — being the layer cue is this
              banner's whole job, so it can't live in a utility class. */}
          <span className="size-2 rounded-sm" style={{ background: color }} />
          <span style={{ color }}>{layerName}</span>
        </span>
        <span className="text-foreground">{routingModeLabel(routingMode)}</span>
        {compact ? (
          <span className="text-muted-foreground">
            {drafting ? "tap a pad to finish" : "tap a pad to start"}
          </span>
        ) : (
          hints.map(([key, desc]) => (
            <span key={key} className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted/60 px-1 text-[10px] leading-4 text-foreground">
                {key}
              </kbd>
              <span className="text-muted-foreground">{desc}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function TraceSegmentShape({
  seg,
  color,
  highlight,
  opacity = 1,
}: {
  seg: PcbTraceSegment;
  color: string;
  highlight: string | null;
  opacity?: number;
}) {
  return (
    <g opacity={opacity}>
      {highlight && (
        <line
          x1={seg.fromX}
          y1={seg.fromY}
          x2={seg.toX}
          y2={seg.toY}
          stroke={highlight}
          strokeWidth={seg.width + 0.15}
          strokeLinecap="round"
          opacity={0.6}
        />
      )}
      <line
        x1={seg.fromX}
        y1={seg.fromY}
        x2={seg.toX}
        y2={seg.toY}
        stroke={color}
        strokeWidth={seg.width}
        strokeLinecap="round"
      />
    </g>
  );
}

function PadShape({
  pad,
  selected,
  opacity = 1,
}: {
  pad: PcbPadRecord;
  selected: boolean;
  opacity?: number;
}) {
  // SMT pads wear their layer color — same source of truth as traces and the
  // LayerPanel swatch. Through-holes span every copper layer, so they render
  // in the multi-layer silver (COLOR_TH_PAD) instead of a side's color.
  const fill = getLayerColor(pad.layer);
  const stroke = selected ? COLOR_SELECTED : "rgba(0,0,0,0.4)";
  const strokeWidth = selected ? 0.12 : 0.04;

  if (pad.isThroughHole) {
    // Pad first — circular annular ring, or the rect/pill pad tscircuit puts
    // around pin 1 of through-hole footprints — then the drill on top. All in
    // the pad's local frame so rotation and hole offsets compose.
    const w = pad.rectWidth ?? 1;
    const h = pad.rectHeight ?? 1;
    const rr = pad.pillRadius ?? (pad.shape === "pill" ? 0.2 : 0);
    const ox = pad.drillOffsetX ?? 0;
    const oy = pad.drillOffsetY ?? 0;
    return (
      <g
        opacity={opacity}
        transform={`translate(${pad.x},${pad.y}) rotate(${pad.rotationDeg})`}
      >
        {pad.shape === "rect" || pad.shape === "pill" ? (
          <rect
            x={-w / 2}
            y={-h / 2}
            width={w}
            height={h}
            rx={rr}
            ry={rr}
            fill={COLOR_TH_PAD}
            stroke={stroke}
            strokeWidth={strokeWidth}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <circle
            r={(pad.outerDiameter ?? 0.8) / 2}
            fill={COLOR_TH_PAD}
            stroke={stroke}
            strokeWidth={strokeWidth}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {pad.drillWidth !== undefined && pad.drillHeight !== undefined ? (
          // Slot drill renders as a pill.
          <rect
            x={ox - pad.drillWidth / 2}
            y={oy - pad.drillHeight / 2}
            width={pad.drillWidth}
            height={pad.drillHeight}
            rx={Math.min(pad.drillWidth, pad.drillHeight) / 2}
            fill={COLOR_HOLE}
          />
        ) : (
          <circle cx={ox} cy={oy} r={(pad.drillDiameter ?? 0.3) / 2} fill={COLOR_HOLE} />
        )}
      </g>
    );
  }

  if (pad.shape === "circle") {
    return (
      <circle
        cx={pad.x}
        cy={pad.y}
        r={pad.radius ?? 0.5}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
        opacity={opacity}
      />
    );
  }
  if (pad.shape === "rect" || pad.shape === "pill") {
    const w = pad.rectWidth ?? 1;
    const h = pad.rectHeight ?? 1;
    const r = pad.shape === "pill" ? pad.pillRadius ?? 0.2 : 0;
    // The rect is drawn axis-aligned in the pad's LOCAL frame (centered
    // on origin), then translated and rotated into world. This is what
    // keeps the long axis of a resistor pad aligned with the resistor
    // body when the part is rotated.
    return (
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={r}
        ry={r}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
        transform={`translate(${pad.x},${pad.y}) rotate(${pad.rotationDeg})`}
        opacity={opacity}
      />
    );
  }
  if (pad.shape === "polygon" && pad.polygonPoints) {
    const d = pad.polygonPoints.map((p) => `${p.x},${p.y}`).join(" ");
    return (
      <polygon
        points={d}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
        opacity={opacity}
      />
    );
  }
  return null;
}

function ComponentBody({
  comp,
  pads,
  showOutline,
  selected,
  hovered,
  pin1,
  opacity: dimOpacity = 1,
}: {
  comp: PcbComponentRecord;
  pads: ReadonlyArray<PcbPadRecord>;
  showOutline: boolean;
  selected: boolean;
  hovered: boolean;
  pin1: PcbPadRecord | null;
  opacity?: number;
}) {
  // The canvas base layer already paints every component's body fill (and the
  // real footprint silkscreen, including the reference designator). This
  // overlay exists ONLY to draw the selection / hover HIGHLIGHT on top, so it
  // strokes just the courtyard outline (recolored, and dashed on hover) and
  // leaves everything else to the canvas.
  //
  // Two-terminal passives have no courtyard outline; their selection cue is the
  // pad halos (rendered separately), so there's nothing for the overlay to add.
  if (!showOutline) return null;

  const placementOpacity = comp.manuallyPlaced ? 1 : 0.85;
  const stroke = selected
    ? COLOR_SELECTED
    : hovered
    ? COLOR_HOVER
    : "rgba(180,190,210,0.45)";
  const display = comp.displayBbox ?? pcbComponentDisplayBbox(comp, pads);
  // Parts with real footprint silkscreen draw no synthetic notch on the base
  // canvas (the silkscreen shows pin 1) — keep the highlight outline in the
  // same shape so selection doesn't grow a bite the body doesn't have.
  const notch = comp.hasSilkscreenOutline
    ? null
    : pickNotch(comp, pin1, display.width, display.height, display.rotationDeg);
  return (
    <g
      transform={`translate(${comp.x},${comp.y}) rotate(${display.rotationDeg})`}
      opacity={dimOpacity * placementOpacity}
    >
      <path
        d={bodyPathD(display.width, display.height, notch)}
        fill="none"
        stroke={stroke}
        strokeWidth={selected ? 0.15 : 0.06}
        strokeDasharray={hovered && !selected ? "0.3 0.2" : undefined}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

// ─── Helpers (module-scope) ──────────────────────────────────────────────────

function cursorForTool(
  tool: string,
  routing: boolean,
  panMode: boolean,
  panning: boolean
) {
  if (panning) return "grabbing";
  if (panMode) return "grab";
  if (routing) return "crosshair";
  switch (tool) {
    case "trace":
      return "crosshair";
    case "rotate":
      return "alias";
    default:
      return "default";
  }
}

function hitKeyFromResult(
  hit: ReturnType<typeof hitTestPoint>
): StableKey | null {
  if (!hit) return null;
  switch (hit.kind) {
    case "component":
      return hit.record.key;
    case "trace":
      return hit.record.key;
    case "pad":
      return hit.record.componentKey;
    case "via":
      return hit.record.traceKey;
    default:
      return null;
  }
}

function padDomKey(pad: PcbPadRecord): string {
  return (
    pad.pcbSmtpadId ??
    pad.pcbPlatedHoleId ??
    `${pad.componentKey ?? "none"}-${pad.x.toFixed(3)}-${pad.y.toFixed(3)}`
  );
}

// Get an editable PcbRoutePoint[] for a trace — either the manualEdits
// route if it already exists, or a fresh materialization from the eval'd
// segments. The caller will write the result back to manualEdits, which
// flips the trace from eval-routed to user-routed.
function routeForDrag(
  trace: PcbTraceRecord,
  manualEdits: Record<string, { pcb?: PcbEdit }>
): PcbRoutePoint[] | null {
  const manual = manualEdits[trace.key]?.pcb?.route;
  if (manual && manual.length >= 2) return manual.map((p) => ({ ...p }));
  if (trace.segments.length === 0) return null;

  const pts: PcbRoutePoint[] = [];
  for (let i = 0; i < trace.segments.length; i++) {
    const seg = trace.segments[i];
    if (i === 0) {
      pts.push({ x: seg.fromX, y: seg.fromY, layer: seg.layer, width: seg.width });
    }
    pts.push({ x: seg.toX, y: seg.toY, layer: seg.layer, width: seg.width });
  }

  for (const via of trace.vias) {
    const idx = pts.findIndex(
      (p) =>
        Math.hypot(p.x - via.x, p.y - via.y) < 1e-6 && p.layer === via.fromLayer
    );
    if (idx >= 0 && !pts.some((p) => p.x === via.x && p.y === via.y && p.layer === via.toLayer)) {
      pts.splice(idx + 1, 0, { x: via.x, y: via.y, layer: via.toLayer });
    }
  }

  return pts.length >= 2 ? pts : null;
}

function padToSelector(pad: PcbPadRecord, model: PcbModel): string | null {
  // O(1) reverse lookup. pcbModel populates `selectorByPad` with the
  // first hint it saw for each pad — typically `.<name> > .pin<N>`, the
  // canonical tscircuit selector form. Falls back to null only when the
  // pad has no port_id (rare: standalone pads from imported snippets).
  return model.selectorByPad.get(pad) ?? null;
}
