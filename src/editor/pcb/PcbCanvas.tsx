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
} from "./pcbModel";
import { computeRatsnest, type RatsnestEdge } from "./ratsnest";
import {
  findNetContainingSelector,
  findUserRouteAtPad,
  isPadOnNet,
  isTraceOnNet,
  previewRoutePath,
  selectorsOnNet,
} from "./routeAssist";
import { nextViolationIndex, type DrcViolation } from "./drc";
import {
  DEFAULT_VIA_DRILL_MM,
  DEFAULT_VIA_PAD_MM,
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
import { drawPcb, bodyPathD, pickNotch } from "./pcbCanvasDraw";
import {
  COLOR_BG,
  COLOR_HOLE,
  COLOR_TH_PAD,
  COLOR_VIA,
  COLOR_VIA_STROKE,
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
import { snapRouteCursor, snapToGrid, rectFromPoints } from "@/editor/shared/snap";
import type {
  LayerId,
  PcbEdit,
  PcbRoutePoint,
  PcbRoutingMode,
  StableKey,
} from "@/editor/shared/types";
import { extractComponentsCached } from "@/utils/tsxTransform";
import { isChipLike } from "@/editor/schematic/symbols";
import { connectionId } from "@/editor/shared/connectionId";
import { CircuitLoading } from "@/components/CircuitLoading";
import { toast } from "sonner";

// ─── Visual constants ─────────────────────────────────────────────────────────

const MIN_SCALE = 5;
const MAX_SCALE = 400;
const DEFAULT_SCALE = 25; // px per mm — pcb is denser than schematic
const ZOOM_SENSITIVITY_PX = 0.0015;
const MARQUEE_DRAG_THRESHOLD_PX = 3;
const SNAP_PAD_PX = 12; // pad-snap radius in screen pixels (route tool)
const HIT_TOL_PX = 4; // tolerance for thin targets (trace segments)
const RATSNEST_HIT_PX = 12; // screen-pixel hit slop for airwires
// Minimum zoom (px/mm) when focusing a DRC violation, so a tiny clearance
// marker is legible even if the user was fully zoomed out.
const DRC_FOCUS_MIN_SCALE = 25;
const SMART_PREVIEW_THROTTLE_MS = 32;

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

// ─── World ↔ screen transforms ───────────────────────────────────────────────

interface Viewport {
  x: number; // screen px offset (after the Y flip)
  y: number;
  scale: number; // px / mm
}

function screenToWorld(
  screenX: number,
  screenY: number,
  v: Viewport,
  canvas: { width: number; height: number }
): { x: number; y: number } {
  // SVG transform: translate(canvas.width/2 + v.x, canvas.height/2 + v.y)
  // then scale(v.scale, -v.scale)  →  world (mm).
  const sx = screenX - canvas.width / 2 - v.x;
  const sy = screenY - canvas.height / 2 - v.y;
  return {
    x: sx / v.scale,
    y: -sy / v.scale,
  };
}

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
  const pcbRouteDraft = useEditorStore((s) => s.pcbRouteDraft);
  const startPcbRoute = useEditorStore((s) => s.startPcbRoute);
  const startPcbRouteFromExisting = useEditorStore(
    (s) => s.startPcbRouteFromExisting
  );
  const addPcbRouteCorner = useEditorStore((s) => s.addPcbRouteCorner);
  const setPcbRouteCursor = useEditorStore((s) => s.setPcbRouteCursor);
  const insertPcbRouteVia = useEditorStore((s) => s.insertPcbRouteVia);
  const finishPcbRoute = useEditorStore((s) => s.finishPcbRoute);
  const popPcbRoutePoint = useEditorStore((s) => s.popPcbRoutePoint);
  const clearPcbRouteDraft = useEditorStore((s) => s.clearPcbRouteDraft);
  const focusedNetKey = useEditorStore((s) => s.focusedNetKey);
  const setFocusedNetKey = useEditorStore((s) => s.setFocusedNetKey);

  const bakePcbComponentTransform = useCircuitStore(
    (s) => s.bakePcbComponentTransform
  );
  const setBoard = useCircuitStore((s) => s.setBoard);

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
    if (!valid.has(activeLayer)) {
      setActiveLayer(TOP_LAYER_ID);
    }
  }, [copperLayerIds, activeLayer, setActiveLayer, clearPcbRouteDraft]);

  // Activate a copper layer. While a route is in progress this drops a via at
  // the current point and continues on the new layer (Altium / KiCad layer-
  // switch-mid-route); otherwise it just sets where the next route starts.
  // Non-copper layers (silkscreen / board outline) are ignored.
  const activateLayer = useCallback(
    (layer: LayerId) => {
      if (!isCopperLayer(layer)) return;
      const draft = useEditorStore.getState().pcbRouteDraft;
      if (draft && draft.activeLayer !== layer) {
        insertPcbRouteVia(layer);
      } else {
        setActiveLayer(layer);
      }
    },
    [insertPcbRouteVia, setActiveLayer]
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
        // Unit-length perpendicular direction of the original segment.
        perpX: number;
        perpY: number;
        // Indices into origRoute whose XY should shift by perp * delta.
        // First/last route points are excluded so pads stay anchored.
        movingIndices: ReadonlyArray<number>;
        moved: boolean;
      };
  const dragStateRef = useRef<DragState | null>(null);
  const smartPreviewRef = useRef<{
    key: string;
    at: number;
    path: PcbRoutePoint[] | null;
  }>({ key: "", at: 0, path: null });
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

  const screenToWorldLocal = useCallback(
    (sx: number, sy: number) => screenToWorld(sx, sy, viewport, canvasSize),
    [viewport, canvasSize]
  );

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

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    // Add a via at the current route point and advance to the next copper
    // layer (wraps around). No-op when not routing.
    const cycleViaToNextLayer = () => {
      const cur = useEditorStore.getState().pcbRouteDraft;
      if (!cur || copperLayerIds.length < 2) return;
      const i = copperLayerIds.indexOf(cur.activeLayer);
      const next = copperLayerIds[(i + 1) % copperLayerIds.length];
      if (next !== cur.activeLayer) insertPcbRouteVia(next);
    };

    const off = registerShortcuts([
      // Modal tools
      { key: "s", handler: () => setToolMode("select") },
      // The arrow tool both selects and moves, so M is just an alias for S
      // (kept for muscle memory) rather than a distinct mode.
      { key: "m", handler: () => setToolMode("select") },
      { key: "w", handler: () => setToolMode("trace") },
      { key: "escape", handler: () => clearPcbRouteDraft() },
      // Layer / width controls (active only while routing)
      // `/` and `V` both add a via and advance to the next copper layer,
      // cycling top → inner1 → … → bottom → top. On a 2-layer board this is
      // the familiar top↔bottom flip.
      { key: "/", handler: cycleViaToNextLayer },
      { key: "v", handler: cycleViaToNextLayer },
      // Number keys jump straight to a copper layer (1 = top, 2 = next, …).
      // While routing this drops a via and continues there; otherwise it just
      // picks where the next route starts.
      ...copperLayerIds.map((id, i) => ({
        key: String(i + 1),
        handler: () => activateLayer(id),
      })),
      { key: "t", handler: () => cycleTraceWidth() },
      { key: "g", handler: () => cycleRoutingMode() },
      { key: "a", handler: () => restoreNetAutoroute() },
      { key: "a", shift: true, handler: () => restoreBoardAutoroute() },
      {
        key: "backspace",
        handler: () => {
          const cur = useEditorStore.getState().pcbRouteDraft;
          if (cur && cur.points.length > 1) {
            popPcbRoutePoint();
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
      // Spacebar enables pan-on-drag
      {
        key: " ",
        handler: () => setSpacePan(true),
      },
      // Ctrl/Cmd+0 reset zoom
      {
        key: "0",
        ctrlOrMeta: true,
        allowInInput: true,
        handler: () => fitToView(),
      },
    ]);

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
    insertPcbRouteVia,
    cycleTraceWidth,
    cycleRoutingMode,
    popPcbRoutePoint,
    clearPcbRouteDraft,
    copperLayerIds,
    activateLayer,
    deleteSelection,
    fitToView,
    restoreNetAutoroute,
    restoreBoardAutoroute,
  ]);

  // ─── Mouse wheel zoom ───────────────────────────────────────────────────
  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      // deltaMode=1 means "lines" — normalize to roughly the trackpad scale.
      const deltaPx = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-deltaPx * ZOOM_SENSITIVITY_PX);
      const newScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, viewport.scale * factor)
      );
      if (newScale === viewport.scale) return;

      // Zoom to cursor: keep the world point under the cursor fixed.
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorldLocal(sx, sy);
      // After scale change, we want world(sx, sy) -> same screen coords:
      //   sx = canvas.width/2 + v.x + world.x * newScale
      //   sy = canvas.height/2 + v.y - world.y * newScale
      const newX = sx - canvasSize.width / 2 - world.x * newScale;
      const newY = sy - canvasSize.height / 2 + world.y * newScale;
      setViewport("pcb", { x: newX, y: newY, scale: newScale });
    },
    [viewport, canvasSize, screenToWorldLocal, setViewport]
  );

  // ─── Pointer handlers ───────────────────────────────────────────────────

  const beginPan = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      panStateRef.current = {
        startScreen: { x: e.clientX, y: e.clientY },
        startViewport: { ...viewport },
      };
      setPanning(true);
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    },
    [viewport]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Right-click cancels route or starts pan
      if (e.button === 2) {
        if (pcbRouteDraft) {
          clearPcbRouteDraft();
          return;
        }
        beginPan(e);
        return;
      }
      // Middle-click always pans
      if (e.button === 1 || (e.button === 0 && spacePan)) {
        beginPan(e);
        return;
      }
      if (e.button !== 0) return;

      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const world = screenToWorldLocal(screen.x, screen.y);
      const toleranceMm = HIT_TOL_PX / viewport.scale;

      // ─── Route tool ─────────────────────────────────────────────────────
      if (toolMode === "trace") {
        const padSnap = findNearestPad(
          model,
          world.x,
          world.y,
          activeLayer,
          SNAP_PAD_PX / viewport.scale
        );

        if (!pcbRouteDraft) {
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

          const startLayer = padSnap.isThroughHole
            ? activeLayer
            : padSnap.layer;
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

        // Route in progress: either finish on a pad or add a corner.
        if (padSnap && padSnap.pcbPortId) {
          const selector = padToSelector(padSnap, model);
          if (!selector) return;
          // Through-hole pads bridge all copper layers, so the route
          // terminates on whichever layer the user is currently routing
          // on — committing the final point on the pad's nominal layer
          // would make the model drop the last segment and render only
          // a via at the pad.
          const finishLayer = padSnap.isThroughHole
            ? pcbRouteDraft.activeLayer
            : padSnap.layer;
          const finished = finishPcbRoute({
            selector,
            x: padSnap.x,
            y: padSnap.y,
            layer: finishLayer,
          });
          if (finished) {
            commitRoute(finished, model);
          }
          return;
        }

        // Corner click: snap to grid + routing mode.
        const last = pcbRouteDraft.points[pcbRouteDraft.points.length - 1];
        const gridSnapped = snapToGrid(
          { x: world.x, y: world.y },
          GRID_FINE_MM
        );
        const snapped = snapRouteCursor(
          last,
          gridSnapped,
          routingMode,
          GRID_FINE_MM
        );
        addPcbRouteCorner(snapped);
        return;
      }

      // ─── Select / move tool default behavior ────────────────────────────
      const hit = hitTestPoint(model, world.x, world.y, {
        layerVisibility,
        toleranceMm,
      });

      if (!hit) {
        // Empty space: start marquee and drop net focus.
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
                perpX,
                perpY,
                movingIndices,
                moved: false,
              };
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
        (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
      }
    },
    [
      pcbRouteDraft,
      clearPcbRouteDraft,
      beginPan,
      spacePan,
      screenToWorldLocal,
      viewport.scale,
      toolMode,
      model,
      activeLayer,
      startPcbRoute,
      finishPcbRoute,
      addPcbRouteCorner,
      routingMode,
      startPcbRouteFromExisting,
      traceWidth,
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
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const world = screenToWorldLocal(screen.x, screen.y);
      setPcbCursorMm(world);

      // Panning?
      if (panStateRef.current) {
        const dx = e.clientX - panStateRef.current.startScreen.x;
        const dy = e.clientY - panStateRef.current.startScreen.y;
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
          if (Math.hypot(dx, dy) >= MARQUEE_DRAG_THRESHOLD_PX) {
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
            if (Math.hypot(screenDx, screenDy) < MARQUEE_DRAG_THRESHOLD_PX)
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
            if (Math.hypot(screenDx, screenDy) < MARQUEE_DRAG_THRESHOLD_PX)
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

      // Hover update + route cursor.
      const toleranceMm = HIT_TOL_PX / viewport.scale;
      if (toolMode === "trace") {
        const padSnap = findNearestPad(
          model,
          world.x,
          world.y,
          activeLayer,
          SNAP_PAD_PX / viewport.scale
        );
        if (pcbRouteDraft) {
          const last = pcbRouteDraft.points[pcbRouteDraft.points.length - 1];
          const snappedCursor = padSnap
            ? { x: padSnap.x, y: padSnap.y }
            : snapRouteCursor(
                last,
                snapToGrid({ x: world.x, y: world.y }, GRID_FINE_MM),
                routingMode,
                GRID_FINE_MM
              );
          const snappedSelector =
            padSnap && padSnap.pcbPortId
              ? padToSelector(padSnap, model)
              : null;

          let smartPreview: PcbRoutePoint[] | null = null;
          if (!padSnap) {
            const previewKey = `${Math.round(snappedCursor.x * 100)}_${Math.round(snappedCursor.y * 100)}_${pcbRouteDraft.activeLayer}_${pcbRouteDraft.points.length}_${routingMode}`;
            const now = performance.now();
            const cached = smartPreviewRef.current;
            if (
              cached.key === previewKey &&
              now - cached.at < SMART_PREVIEW_THROTTLE_MS
            ) {
              smartPreview = cached.path;
            } else {
              smartPreview = previewRoutePath({
                model,
                from: last,
                to: {
                  x: snappedCursor.x,
                  y: snappedCursor.y,
                  layer: pcbRouteDraft.activeLayer,
                },
                fromSelector: pcbRouteDraft.fromSelector,
                traceWidth: pcbRouteDraft.width,
                layerCount: numLayers,
                netSelectors: focusedNetSelectors ?? undefined,
                routingMode,
              });
              smartPreviewRef.current = {
                key: previewKey,
                at: now,
                path: smartPreview,
              };
            }
          }

          setPcbRouteCursor(
            snappedCursor,
            snappedSelector && padSnap
              ? {
                  selector: snappedSelector,
                  x: padSnap.x,
                  y: padSnap.y,
                  layer: padSnap.layer,
                }
              : null,
            smartPreview
          );
        }
        // Even before route start, light up nearest pad as a hover hint.
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
      setViewport,
      model,
      viewport.scale,
      toolMode,
      activeLayer,
      pcbRouteDraft,
      layerVisibility,
      setHoveredKey,
      setPcbRouteCursor,
      setPcbEdit,
      setPcbEdits,
      setPcbCursorMm,
      numLayers,
      focusedNetSelectors,
      routingMode,
    ]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
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
  // previous gesture as if the user never released the button.
  const onPointerCancel = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      panStateRef.current = null;
      dragStateRef.current = null;
      setPanning(false);
      setMarquee(null);
      (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
    },
    []
  );

  // Double-click on the canvas = fit view (mirrors schematic). Skip when
  // a route is in progress or the click lands on a drag-eligible target,
  // so muscle-memory drag interactions aren't ambushed by the fit.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (pcbRouteDraft) return;
      // Ignore double-click if the user landed on something — keeps the
      // gesture aligned with schematic where dbl-click on a component is
      // a no-op (fit only triggers on empty canvas).
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const world = screenToWorldLocal(
        e.clientX - rect.left,
        e.clientY - rect.top
      );
      const toleranceMm = HIT_TOL_PX / viewport.scale;
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
      model,
      layerVisibility,
      fitToView,
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
          className="absolute inset-0"
          style={{
            width: canvasSize.width,
            height: canvasSize.height,
            pointerEvents: "none",
          }}
        />
        <svg
          ref={svgRef}
          width={canvasSize.width}
          height={canvasSize.height}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
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
              onFocusNet={setFocusedNetKey}
              onRouteEdge={handleRouteEdge}
            />

            {/* Route draft preview. */}
            {pcbRouteDraft && (
              <RouteDraftOverlay
                draft={pcbRouteDraft}
                model={model}
                width={traceWidth}
              />
            )}

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

        <PcbToolbar
          toolMode={toolMode}
          routingMode={routingMode}
          onSelectTool={setToolMode}
          onSetRoutingMode={setRoutingMode}
          onFit={fitToView}
          onRestoreNetAutoroute={() => restoreNetAutoroute()}
          onRestoreBoardAutoroute={() => restoreBoardAutoroute()}
          canRestoreNet={focusedNetKey !== null}
          canRestoreBoard={routeEditKeys.length > 0}
        />

        <RouteModeBanner
          active={toolMode === "trace"}
          activeLayer={activeLayer}
          drafting={!!pcbRouteDraft}
          routingMode={routingMode}
        />

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
      />
    </div>
  );

  // ─── Local helpers (closures over the outer scope) ──────────────────────

  function commitRoute(
    finished: NonNullable<typeof pcbRouteDraft>,
    _model: PcbModel
  ) {
    // PCB route geometry is SIDECAR-ONLY. We deliberately do NOT emit a
    // `<trace>` (or `<via>`) into the tsx: connectivity lives in `connections`,
    // and wiring a `<trace>` source ↔ sidecar route is future work. Key the
    // route by the content-derived connection id of its two endpoints so
    // pcbModel/circuitJsonMerge can re-pair it to the matching net — and
    // suppress that net's ratsnest — without any tsx element to look up. The
    // key is stable across reloads because it's derived from the (canonical,
    // order-independent) endpoint pair, not minted. Layer changes are encoded
    // in the route points themselves, so vias need no separate storage.
    const fromSel = finished.fromSelector;
    const toSel = finished.toSelector!;
    const connId = connectionId(fromSel, toSel);
    const prevKey = finished.traceKey;
    if (prevKey && prevKey !== connId) {
      // The route was picked up from another pad pair: that connection loses
      // its copper, and noAutoroute keeps the autorouter from re-covering it.
      const prev = manualEdits[prevKey]?.pcb;
      if (prev) {
        setPcbEdit(prevKey, {
          ...(pcbEditWithoutRoute(prev) ?? {}),
          noAutoroute: true,
        });
      }
    }
    // Drawing copper un-deletes the connection — drop any noAutoroute marker
    // so the entry doesn't carry stale "deleted" state alongside a live route.
    const { noAutoroute: _undeleted, ...restPcb } =
      manualEdits[connId]?.pcb ?? {};
    setPcbEdit(connId, {
      ...restPcb,
      route: finished.points,
      width: finished.width,
    });
  }
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
  onFocusNet,
  onRouteEdge,
}: {
  edges: ReadonlyArray<RatsnestEdge>;
  focusedNetKey: StableKey | null;
  netFocusActive: boolean;
  onFocusNet: (key: StableKey) => void;
  onRouteEdge: (edge: RatsnestEdge) => void;
}) {
  return (
    <g>
      {edges.map((edge, idx) => {
        const focused = edge.traceKey === focusedNetKey;
        return (
          <g
            key={idx}
            style={{ cursor: "pointer" }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (edge.traceKey) onFocusNet(edge.traceKey);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRouteEdge(edge);
            }}
          >
            {/* Generous screen-space hit target — the visible stroke
                stays 1–2 px but picking uses this invisible capsule. */}
            <line
              x1={edge.fromX}
              y1={edge.fromY}
              x2={edge.toX}
              y2={edge.toY}
              stroke="transparent"
              strokeWidth={RATSNEST_HIT_PX}
              vectorEffect="non-scaling-stroke"
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
    <div className="absolute bottom-9 left-3 z-10 w-80 rounded-md border border-border bg-sidebar/95 backdrop-blur-sm p-3 text-xs shadow-lg select-none">
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
}: {
  active: boolean;
  activeLayer: LayerId;
  drafting: boolean;
  routingMode: PcbRoutingMode;
}) {
  if (!active) return null;
  const layer = getLayer(activeLayer);
  const layerName = layer?.label ?? activeLayer;
  const color = getLayerColor(activeLayer);
  const modeHint = routingModeLabel(routingMode);
  const text = drafting
    ? `Routing on ${layerName} (${modeHint})  •  Click a pad to finish  •  Click empty to add corner  •  Smart path preview  •  / or V = via  •  G = mode  •  Esc = cancel`
    : `Route tool — ${layerName} (${modeHint})  •  Click a pad to start or pick up trace  •  Click airwire to focus net  •  A = re-autoroute net  •  ⇧A = re-autoroute board  •  Esc = cancel`;
  return (
    <div
      style={{
        position: "absolute",
        top: 52,
        left: 12,
        right: 12,
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        pointerEvents: "none",
        userSelect: "none",
        color,
        opacity: 0.95,
      }}
    >
      {text}
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

function RouteDraftOverlay({
  draft,
  width,
}: {
  draft: NonNullable<ReturnType<typeof useEditorStore.getState>["pcbRouteDraft"]>;
  model: PcbModel;
  width: number;
}) {
  const segments: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
  }> = [];
  // Draft segments use the same layer color as committed traces — the
  // visual "draft" cue is the 0.7 opacity applied at render time, not a
  // separate hue. Keeps the user from seeing the route shift color on
  // commit.
  for (let i = 0; i < draft.points.length - 1; i++) {
    const a = draft.points[i];
    const b = draft.points[i + 1];
    if (a.layer !== b.layer) continue;
    segments.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      color: getLayerColor(a.layer),
    });
  }
  // Smart preview: obstacle-aware path from last point to cursor, or a
  // straight rubber band when snapped to a pad or pathfinder finds nothing.
  const last = draft.points[draft.points.length - 1];
  const cursor = draft.snappedPad ?? draft.cursor;
  const previewPoints = draft.smartPreview;
  if (last && cursor) {
    if (previewPoints && previewPoints.length > 0) {
      let px = last.x;
      let py = last.y;
      for (const pt of previewPoints) {
        if (pt.layer !== draft.activeLayer) continue;
        segments.push({
          x1: px,
          y1: py,
          x2: pt.x,
          y2: pt.y,
          color: getLayerColor(draft.activeLayer),
        });
        px = pt.x;
        py = pt.y;
      }
    } else {
      segments.push({
        x1: last.x,
        y1: last.y,
        x2: cursor.x,
        y2: cursor.y,
        color: getLayerColor(draft.activeLayer),
      });
    }
  }

  // Vias at layer transitions
  const vias: { x: number; y: number }[] = [];
  for (let i = 0; i < draft.points.length - 1; i++) {
    if (draft.points[i].layer !== draft.points[i + 1].layer) {
      vias.push({ x: draft.points[i + 1].x, y: draft.points[i + 1].y });
    }
  }

  return (
    <g>
      {segments.map((s, i) => (
        <line
          key={i}
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
          stroke={s.color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={
            i >= draft.points.length - 1 && draft.smartPreview?.length
              ? "0.4 0.25"
              : undefined
          }
          opacity={0.7}
        />
      ))}
      {vias.map((v, i) => (
        <g key={`v${i}`}>
          <circle
            cx={v.x}
            cy={v.y}
            r={DEFAULT_VIA_PAD_MM / 2}
            fill={COLOR_VIA}
            stroke={COLOR_VIA_STROKE}
            strokeWidth={0.05}
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={v.x}
            cy={v.y}
            r={DEFAULT_VIA_DRILL_MM / 2}
            fill={COLOR_HOLE}
          />
        </g>
      ))}
      {draft.snappedPad && (
        <circle
          cx={draft.snappedPad.x}
          cy={draft.snappedPad.y}
          r={0.4}
          fill="none"
          stroke={COLOR_HOVER}
          strokeWidth={0.1}
          vectorEffect="non-scaling-stroke"
        />
      )}
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
