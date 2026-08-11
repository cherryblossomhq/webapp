// editorStore — Phase 0 skeleton.
//
// This is the home for everything that's specific to the *editor* (selection,
// modal tool, viewport, the manualEdits sidecar) and intentionally separate
// from circuitStore (which is the home for tsx + circuitJson).
//
// During Phase 0 nothing drives manualEdits yet — the field exists so that
// project-file load/save can round-trip it correctly and callers can
// summarize current positions. Phase 1 / Phase 2 wire it to the new editors.

import { create, type StateCreator } from "zustand";
import type {
  LayerId,
  ManualEditEntry,
  ManualEditsMap,
  PcbConflictMode,
  PcbEdit,
  PcbRouteDraft,
  PcbRoutePoint,
  PcbRoutingMode,
  RoutePosture,
  SchematicEdit,
  StableKey,
  ToolMode,
  ViewportTransform,
} from "../shared/types";
import {
  CORNER_RADIUS_MAX_MM,
  defaultCornerRadiusMm,
  swapPosture,
} from "../pcb/routeLeader";
import { routeLive } from "../pcb/routeLive";
import {
  DEFAULT_TRACE_WIDTH_MM,
  PCB_ROUTING_MODES,
  TOP_LAYER_ID,
  TRACE_WIDTH_PROFILES,
  profileForId,
  profileForWidth,
  defaultLayerVisibility,
} from "../pcb/layers";

interface ViewportPair {
  schematic: ViewportTransform;
  pcb: ViewportTransform;
}

const INITIAL_VIEWPORT: ViewportTransform = { x: 0, y: 0, scale: 1 };

export type EditorTab = "schematic" | "pcb" | "cad" | "bom" | "code";

interface EditorStore {
  // ─── Selection (shared across schematic / pcb tabs) ──────────────────────
  selectedKeys: ReadonlySet<StableKey>;

  // ─── Active editor tab (Phase 1+) ────────────────────────────────────────
  // Schematic routes to the new SVG editor; pcb/cad/bom still route to
  // RunFrame for now (Phase 2 replaces pcb). Lives in the store so
  // keyboard shortcuts / toolbar / properties panel can all coordinate.
  activeTab: EditorTab;

  // ─── Shared Issues panel ─────────────────────────────────────────────────
  issuesOpen: boolean;
  requestedDrcFocusId: string | null;

  // ─── Modal tool ──────────────────────────────────────────────────────────
  toolMode: ToolMode;

  // ─── Viewports (one per tab) ─────────────────────────────────────────────
  viewport: ViewportPair;

  // ─── Sidecar: physical layout owned by the GUI, never the LLM ────────────
  manualEdits: ManualEditsMap;

  // ─── Eval reconciliation ─────────────────────────────────────────────────
  // Bumps every time the user makes a sidecar edit; the evaluator records the
  // value seen at the moment evaluation started, and reconciliation drops
  // edits already applied.
  localEditsSinceEval: number;

  // ─── PCB editor state ────────────────────────────────────────────────────
  // Active routing layer. New route segments land here, new vias swap to
  // here. Cycles between visible copper layers via `/`.
  activeLayer: LayerId;
  // Per-layer visibility. The renderer skips hidden layers; hit-test
  // ignores them too so users can't accidentally select something they
  // can't see.
  layerVisibility: Record<LayerId, boolean>;
  // Trace width for new segments (mm). Pressing `T` cycles width profiles.
  traceWidth: number;
  activeWidthProfileId: string | null;
  // Corner style for manual routing. One axis, four members — see PcbRoutingMode.
  routingMode: PcbRoutingMode;
  // Whether the clearance halo shades the route being drawn. On by default:
  // "will this fit?" is the question a router asks every second.
  clearanceHaloVisible: boolean;
  // In-progress PCB route. Owned here so the canvas, status bar, and
  // keyboard shortcut handlers all coordinate.
  pcbRouteDraft: PcbRouteDraft | null;
  // Net currently in focus for routing (highlights pads/traces, dims the rest).
  // Set when a route starts or when the user picks a ratsnest edge.
  focusedNetKey: StableKey | null;
  // Hovered element under the cursor (for highlight overlay). Set per
  // pointermove from the canvas hit-test. Null when not hovering.
  hoveredKey: StableKey | null;
  // Live cursor position in board mm, for the StatusBar readout. Lives here
  // (not in PcbCanvas state) so per-pointermove updates re-render only the
  // StatusBar subscriber, never the whole canvas component. Rounded to
  // 0.01 mm — the display precision — so sub-display motion is a no-op set.
  pcbCursorMm: { x: number; y: number } | null;

  // ─── Actions: selection ──────────────────────────────────────────────────
  setSelection: (keys: Iterable<StableKey>) => void;
  clearSelection: () => void;
  toggleSelection: (key: StableKey) => void;
  addToSelection: (key: StableKey) => void;
  removeFromSelection: (key: StableKey) => void;
  isSelected: (key: StableKey) => boolean;

  // ─── Actions: tool ───────────────────────────────────────────────────────
  setToolMode: (mode: ToolMode) => void;

  // ─── Actions: tab ────────────────────────────────────────────────────────
  setActiveTab: (tab: EditorTab) => void;
  setIssuesOpen: (open: boolean) => void;
  toggleIssues: () => void;
  requestDrcFocus: (id: string | null) => void;

  // ─── Actions: viewport ───────────────────────────────────────────────────
  setViewport: (which: keyof ViewportPair, transform: ViewportTransform) => void;
  resetViewport: (which: keyof ViewportPair) => void;

  // ─── Actions: sidecar ────────────────────────────────────────────────────
  setManualEdits: (m: ManualEditsMap) => void;
  setSchematicEdit: (key: StableKey, edit: SchematicEdit | null) => void;
  setPcbEdit: (key: StableKey, edit: PcbEdit | null) => void;
  // Batch variant of setPcbEdit: applies every entry in ONE store update so a
  // multi-select drag (or a board-wide re-autoroute restore) costs one
  // notification and one manualEdits copy per frame instead of one per key.
  setPcbEdits: (
    entries: ReadonlyArray<readonly [StableKey, PcbEdit | null]>
  ) => void;
  // Drop the optimistic PCB placement override (x/y) for any key whose
  // freshly-evaluated position now matches it. Called from the background
  // evaluator once an eval lands: the position is baked into the tsx (the real
  // source of truth), so the sidecar override has done its job as a drag preview
  // and is dropped to avoid masking later tsx changes (undo, code tab edits).
  // Rotation is tsx-only (pcbRotation). Route / width / layer / mirror_x are
  // left alone when the optimistic x/y placement is reconciled.
  reconcilePcbPlacements: (
    evalById: ReadonlyMap<StableKey, { x: number; y: number; rotation: number }>
  ) => void;
  // Drop entries whose key is no longer present in the live tsx. Called on
  // project save and after a rewrite prunes components.
  pruneOrphans: (liveKeys: ReadonlySet<StableKey>) => void;

  // ─── Selection helpers ───────────────────────────────────────────────────
  // Drop selected keys that no longer exist in the live tsx.
  syncSelectionToLiveKeys: (liveKeys: ReadonlySet<StableKey>) => void;

  // ─── Actions: PCB layers / routing ───────────────────────────────────────
  setActiveLayer: (layer: LayerId) => void;
  toggleLayerVisibility: (layer: LayerId) => void;
  setLayerVisibility: (layer: LayerId, visible: boolean) => void;
  setTraceWidth: (width: number) => void;
  cycleTraceWidth: () => void;
  setActiveWidthProfile: (profileId: string | null) => void;
  cycleRoutingMode: () => void;
  setRoutingMode: (mode: PcbRoutingMode) => void;
  setHoveredKey: (key: StableKey | null) => void;
  setPcbCursorMm: (p: { x: number; y: number } | null) => void;
  toggleClearanceHalo: () => void;

  // ─── Actions: PCB route draft ────────────────────────────────────────────
  // Start a new route from a pad. `from` carries the pad selector, world
  // coords, and the layer the pad lives on (becomes the route's first
  // active layer).
  startPcbRoute: (from: {
    selector: string;
    x: number;
    y: number;
    layer: LayerId;
  }) => void;
  startPcbRouteFromExisting: (opts: {
    traceKey: StableKey;
    fromEnd: "start" | "end";
    fromSelector: string;
    route: ReadonlyArray<PcbRoutePoint>;
    width: number;
  }) => void;
  // Commit EVERY vertex of the geometry that is on screen — the hug vertices,
  // the leader knee, and the endpoint. This replaces the old one-point
  // `addPcbRouteCorner`, which is the single reason routes never went around
  // components no matter how good the pathfinder was.
  appendPcbRoutePoints: (
    points: ReadonlyArray<{ x: number; y: number }>
  ) => void;
  // Via AT `at` — the head of the unfixed track, which is where every reference
  // tool puts it; dropping it at the previous corner put it behind the cursor.
  // Commits `leader` first so the copper actually reaches the via, stays unfixed
  // until the next click, and remembers how many vertices it pushed so a second
  // `V` can undo the whole thing.
  placePendingVia: (opts: {
    x: number;
    y: number;
    toLayer: LayerId;
    leader?: ReadonlyArray<{ x: number; y: number }>;
  }) => void;
  cancelPendingVia: () => void;
  // `current` is the posture actually on screen. While unlocked that is the
  // per-frame auto guess, which lives in a ref outside the store — so the caller
  // has to hand it over or the first Space would swap from a stale value.
  swapPcbRoutePosture: (current?: RoutePosture) => void;
  setPcbConflictMode: (mode: PcbConflictMode) => void;
  cyclePcbConflictMode: () => void;
  adjustPcbCornerRadius: (deltaMm: number) => void;
  // Finish the route at a destination pad. Adds the final route point
  // (snapped to the pad) and exposes the completed draft for the caller
  // to bake into tsx + sidecar. Returns the finished draft so the caller
  // can commit atomically, or null when there's nothing to commit
  // (single-point click).
  finishPcbRoute: (
    to: {
      selector: string;
      x: number;
      y: number;
      layer: LayerId;
    } | null,
    interior?: ReadonlyArray<{ x: number; y: number }>
  ) => PcbRouteDraft | null;
  // Pop the most recent route point (Ctrl+Z / Backspace during route).
  popPcbRoutePoint: () => void;
  clearPcbRouteDraft: () => void;
  setFocusedNetKey: (key: StableKey | null) => void;

  // ─── Test / reset hook ───────────────────────────────────────────────────
  reset: () => void;
}

const INITIAL: Pick<
  EditorStore,
  | "selectedKeys"
  | "toolMode"
  | "viewport"
  | "manualEdits"
  | "localEditsSinceEval"
  | "activeTab"
  | "issuesOpen"
  | "requestedDrcFocusId"
  | "activeLayer"
  | "layerVisibility"
  | "traceWidth"
  | "activeWidthProfileId"
  | "routingMode"
  | "clearanceHaloVisible"
  | "pcbRouteDraft"
  | "focusedNetKey"
  | "hoveredKey"
  | "pcbCursorMm"
> = {
  selectedKeys: new Set(),
  toolMode: "select",
  viewport: { schematic: INITIAL_VIEWPORT, pcb: INITIAL_VIEWPORT },
  manualEdits: {},
  localEditsSinceEval: 0,
  activeTab: "schematic",
  issuesOpen: false,
  requestedDrcFocusId: null,
  activeLayer: TOP_LAYER_ID,
  layerVisibility: defaultLayerVisibility(),
  traceWidth: DEFAULT_TRACE_WIDTH_MM,
  activeWidthProfileId: "signal",
  routingMode: "diag45",
  clearanceHaloVisible: true,
  pcbRouteDraft: null,
  focusedNetKey: null,
  hoveredKey: null,
  pcbCursorMm: null,
};

function withEntry(
  m: ManualEditsMap,
  key: StableKey,
  patch: Partial<ManualEditEntry>
): ManualEditsMap {
  const prev = m[key] ?? {};
  const next: ManualEditEntry = { ...prev, ...patch };
  // Drop any subkey that's now undefined to keep the shape minimal.
  if (next.schematic === undefined) delete next.schematic;
  if (next.pcb === undefined) delete next.pcb;
  if (Object.keys(next).length === 0) {
    const { [key]: _, ...rest } = m;
    void _;
    return rest;
  }
  return { ...m, [key]: next };
}

// Zustand middleware. Any write that lands while a route draft is live is, by
// construction, a write the routing interaction caused — and the whole frame
// pipeline exists so that a pointer move causes none. Counting them here is what
// makes "onPointerMove does no store write" machine-checkable instead of a
// comment: the browser perf gate asserts this stays at zero across a 240-move
// drag, and it would catch a regression that reintroduced a per-move setState.
function countRouteWrites(
  init: StateCreator<EditorStore>
): StateCreator<EditorStore> {
  return (set, get, api) => {
    // Zustand's setter is overloaded, and no single forwarding signature covers
    // every overload — hence the two narrowing casts. The call itself is a
    // straight pass-through.
    const counted = ((partial: unknown, replace?: boolean) => {
      if (get().pcbRouteDraft !== null) routeLive.stats.storeWrites++;
      (set as (p: unknown, r?: boolean) => void)(partial, replace);
    }) as typeof set;
    return init(counted, get, api);
  };
}

export const useEditorStore = create<EditorStore>(countRouteWrites((set, get) => ({
  ...INITIAL,

  // ─── Selection ────────────────────────────────────────────────────────────

  setSelection: (keys) => set({ selectedKeys: new Set(keys) }),

  clearSelection: () => {
    if (get().selectedKeys.size === 0) return;
    set({ selectedKeys: new Set() });
  },

  toggleSelection: (key) => {
    const next = new Set(get().selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ selectedKeys: next });
  },

  addToSelection: (key) => {
    const cur = get().selectedKeys;
    if (cur.has(key)) return;
    const next = new Set(cur);
    next.add(key);
    set({ selectedKeys: next });
  },

  removeFromSelection: (key) => {
    const cur = get().selectedKeys;
    if (!cur.has(key)) return;
    const next = new Set(cur);
    next.delete(key);
    set({ selectedKeys: next });
  },

  isSelected: (key) => get().selectedKeys.has(key),

  // ─── Tool ─────────────────────────────────────────────────────────────────

  setToolMode: (mode) => {
    const prev = get().toolMode;
    if (prev === mode) return;
    const draft = get().pcbRouteDraft;
    if (prev === "trace" && mode !== "trace" && draft) {
      // Leaving the route tool abandons the draft, so it restores the layer the
      // draft's own vias moved off too — same reason as clearPcbRouteDraft.
      const startLayer = draft.points[0]?.layer;
      set({
        toolMode: mode,
        pcbRouteDraft: null,
        ...(startLayer !== undefined && startLayer !== get().activeLayer
          ? { activeLayer: startLayer }
          : {}),
      });
      return;
    }
    set({ toolMode: mode });
  },

  // ─── Tab ──────────────────────────────────────────────────────────────────

  setActiveTab: (tab) => {
    if (get().activeTab === tab) return;
    set({ activeTab: tab });
  },

  setIssuesOpen: (open) => {
    if (get().issuesOpen === open) return;
    set({ issuesOpen: open });
  },

  toggleIssues: () => set((state) => ({ issuesOpen: !state.issuesOpen })),

  requestDrcFocus: (id) => set({ requestedDrcFocusId: id }),

  // ─── Viewport ─────────────────────────────────────────────────────────────

  setViewport: (which, transform) => {
    const cur = get().viewport[which];
    if (
      cur.x === transform.x &&
      cur.y === transform.y &&
      cur.scale === transform.scale
    )
      return;
    set((s) => ({ viewport: { ...s.viewport, [which]: transform } }));
  },

  resetViewport: (which) => {
    set((s) => ({ viewport: { ...s.viewport, [which]: INITIAL_VIEWPORT } }));
  },

  // ─── Sidecar ──────────────────────────────────────────────────────────────

  setManualEdits: (m) => set({ manualEdits: m, localEditsSinceEval: 0 }),

  setSchematicEdit: (key, edit) =>
    set((s) => ({
      manualEdits: withEntry(s.manualEdits, key, {
        schematic: edit ?? undefined,
      }),
      localEditsSinceEval: s.localEditsSinceEval + 1,
    })),

  setPcbEdit: (key, edit) =>
    set((s) => ({
      manualEdits: withEntry(s.manualEdits, key, { pcb: edit ?? undefined }),
      localEditsSinceEval: s.localEditsSinceEval + 1,
    })),

  setPcbEdits: (entries) => {
    if (entries.length === 0) return;
    set((s) => {
      // One shallow copy, then patch in place — withEntry would re-copy the
      // whole map per entry (O(N·M) for an M-part drag).
      const next: ManualEditsMap = { ...s.manualEdits };
      for (const [key, edit] of entries) {
        const prev = next[key] ?? {};
        const entry: ManualEditEntry = { ...prev, pcb: edit ?? undefined };
        if (entry.schematic === undefined) delete entry.schematic;
        if (entry.pcb === undefined) delete entry.pcb;
        if (Object.keys(entry).length === 0) delete next[key];
        else next[key] = entry;
      }
      return {
        manualEdits: next,
        localEditsSinceEval: s.localEditsSinceEval + 1,
      };
    });
  },

  reconcilePcbPlacements: (evalById) => {
    const cur = get().manualEdits;
    const EPS = 1e-6;

    let changed = false;
    const next: ManualEditsMap = {};
    for (const k of Object.keys(cur)) {
      const key = k as StableKey;
      const entry = cur[key];
      const pcb = entry.pcb;
      if (!pcb) {
        next[key] = entry;
        continue;
      }

      const target = evalById.get(key);
      const hasXY = pcb.x !== undefined || pcb.y !== undefined;

      const commitEntry = (pcbOut: PcbEdit | undefined) => {
        const nextEntry: ManualEditEntry = { ...entry };
        if (pcbOut && Object.keys(pcbOut).length > 0) nextEntry.pcb = pcbOut;
        else delete nextEntry.pcb;
        if (Object.keys(nextEntry).length > 0) next[key] = nextEntry;
      };

      if (!hasXY || !target) {
        next[key] = entry;
        continue;
      }

      const xMatch =
        pcb.x === undefined || Math.abs(pcb.x - target.x) < EPS;
      const yMatch =
        pcb.y === undefined || Math.abs(pcb.y - target.y) < EPS;
      if (!xMatch || !yMatch) {
        next[key] = entry;
        continue;
      }

      changed = true;
      const restPcb: PcbEdit = { ...pcb };
      delete restPcb.x;
      delete restPcb.y;
      commitEntry(Object.keys(restPcb).length > 0 ? restPcb : undefined);
    }
    if (changed) set({ manualEdits: next });
  },

  pruneOrphans: (liveKeys) => {
    const cur = get().manualEdits;
    let changed = false;
    const next: ManualEditsMap = {};
    for (const k of Object.keys(cur)) {
      if (liveKeys.has(k)) {
        next[k] = cur[k];
      } else {
        changed = true;
      }
    }
    if (changed) set({ manualEdits: next });
  },

  syncSelectionToLiveKeys: (liveKeys) => {
    const cur = get().selectedKeys;
    if (cur.size === 0) return;
    let changed = false;
    const next = new Set<StableKey>();
    for (const k of cur) {
      if (liveKeys.has(k)) next.add(k);
      else changed = true;
    }
    if (changed) set({ selectedKeys: next });
  },

  // ─── PCB layers / routing ─────────────────────────────────────────────────

  setActiveLayer: (layer) => {
    if (get().activeLayer === layer) return;
    set({ activeLayer: layer });
  },

  toggleLayerVisibility: (layer) => {
    const cur = get().layerVisibility;
    const next = { ...cur, [layer]: !(cur[layer] ?? true) };
    set({ layerVisibility: next });
  },

  setLayerVisibility: (layer, visible) => {
    const cur = get().layerVisibility;
    if ((cur[layer] ?? true) === visible) return;
    set({ layerVisibility: { ...cur, [layer]: visible } });
  },

  setTraceWidth: (width) => {
    if (!Number.isFinite(width) || width <= 0) return;
    if (get().traceWidth === width) return;
    const draft = get().pcbRouteDraft;
    set({
      traceWidth: width,
      activeWidthProfileId: profileForWidth(width)?.id ?? null,
      ...(draft ? { pcbRouteDraft: { ...draft, width } } : {}),
    });
  },

  cycleTraceWidth: () => {
    const profiles = TRACE_WIDTH_PROFILES;
    const curId = get().activeWidthProfileId;
    const idx = profiles.findIndex((p) => p.id === curId);
    const next = profiles[(idx + 1) % profiles.length];
    const draft = get().pcbRouteDraft;
    set({
      traceWidth: next.widthMm,
      activeWidthProfileId: next.id,
      ...(draft ? { pcbRouteDraft: { ...draft, width: next.widthMm } } : {}),
    });
  },

  setActiveWidthProfile: (profileId) => {
    const profile = profileId ? profileForId(profileId) : undefined;
    if (profileId && !profile) return;
    const width = profile?.widthMm ?? get().traceWidth;
    const draft = get().pcbRouteDraft;
    set({
      activeWidthProfileId: profileId,
      traceWidth: width,
      ...(draft ? { pcbRouteDraft: { ...draft, width } } : {}),
    });
  },

  cycleRoutingMode: () => {
    const cur = get().routingMode;
    const idx = PCB_ROUTING_MODES.indexOf(cur);
    const next = PCB_ROUTING_MODES[(idx + 1) % PCB_ROUTING_MODES.length];
    set({ routingMode: next });
  },

  setRoutingMode: (mode) => {
    if (get().routingMode === mode) return;
    set({ routingMode: mode });
  },

  setHoveredKey: (key) => {
    if (get().hoveredKey === key) return;
    set({ hoveredKey: key });
  },

  setPcbCursorMm: (p) => {
    const cur = get().pcbCursorMm;
    if (p === null) {
      if (cur !== null) set({ pcbCursorMm: null });
      return;
    }
    const x = Math.round(p.x * 100) / 100;
    const y = Math.round(p.y * 100) / 100;
    if (cur && cur.x === x && cur.y === y) return;
    set({ pcbCursorMm: { x, y } });
  },

  toggleClearanceHalo: () =>
    set((s) => ({ clearanceHaloVisible: !s.clearanceHaloVisible })),

  // ─── PCB route draft ──────────────────────────────────────────────────────

  startPcbRoute: (from) => {
    const width = get().traceWidth;
    const initial: PcbRoutePoint = {
      x: from.x,
      y: from.y,
      layer: from.layer,
      width,
    };
    set({
      pcbRouteDraft: {
        traceKey: null,
        fromSelector: from.selector,
        toSelector: null,
        points: [initial],
        activeLayer: from.layer,
        width,
        posture: "hv-first",
        postureLocked: false,
        conflictMode: "walkaround",
        pendingVia: null,
        cornerRadiusMm: defaultCornerRadiusMm(width),
      },
      activeLayer: from.layer,
    });
  },

  startPcbRouteFromExisting: (opts) => {
    const points =
      opts.fromEnd === "end"
        ? opts.route.map((p) => ({ ...p })).reverse()
        : opts.route.map((p) => ({ ...p }));
    const start = points[0];
    set({
      pcbRouteDraft: {
        traceKey: opts.traceKey,
        fromSelector: opts.fromSelector,
        toSelector: null,
        points,
        activeLayer: start.layer,
        width: opts.width,
        posture: "hv-first",
        postureLocked: false,
        conflictMode: "walkaround",
        pendingVia: null,
        cornerRadiusMm: defaultCornerRadiusMm(opts.width),
      },
      activeLayer: start.layer,
    });
  },

  appendPcbRoutePoints: (points) => {
    const cur = get().pcbRouteDraft;
    if (!cur || points.length === 0) return;
    const next = cur.points.slice();
    for (const p of points) {
      const last = next[next.length - 1];
      // Drop zero-length leading duplicates: a click that lands exactly on the
      // anchor (pad snap, degenerate leader) must not push a null segment.
      if (last && last.x === p.x && last.y === p.y && last.layer === cur.activeLayer) {
        continue;
      }
      next.push({ x: p.x, y: p.y, layer: cur.activeLayer, width: cur.width });
    }
    if (next.length === cur.points.length) return;
    set({ pcbRouteDraft: { ...cur, points: next, pendingVia: null } });
  },

  placePendingVia: ({ x, y, toLayer, leader }) => {
    const cur = get().pcbRouteDraft;
    if (!cur || cur.activeLayer === toLayer) return;
    const before = cur.points.length;
    const points = cur.points.slice();
    const push = (px: number, py: number, layer: LayerId) => {
      const last = points[points.length - 1];
      if (last && last.x === px && last.y === py && last.layer === layer) return;
      points.push({ x: px, y: py, layer, width: cur.width });
    };
    // Carry the copper up to the via head first, then the duplicate-XY point on
    // the new layer. pcbModel reads adjacent points with differing layers as a
    // via at that XY; without the duplicate the renderer emits the via at the
    // user's NEXT click and silently drops the segment in between.
    for (const p of leader ?? []) push(p.x, p.y, cur.activeLayer);
    push(x, y, cur.activeLayer);
    points.push({ x, y, layer: toLayer, width: cur.width });
    set({
      pcbRouteDraft: {
        ...cur,
        points,
        activeLayer: toLayer,
        pendingVia: {
          x,
          y,
          fromLayer: cur.activeLayer,
          toLayer,
          pushedPoints: points.length - before,
        },
      },
      activeLayer: toLayer,
    });
  },

  cancelPendingVia: () => {
    const cur = get().pcbRouteDraft;
    const via = cur?.pendingVia;
    if (!cur || !via) return;
    const keep = Math.max(1, cur.points.length - via.pushedPoints);
    set({
      pcbRouteDraft: {
        ...cur,
        points: cur.points.slice(0, keep),
        activeLayer: via.fromLayer,
        pendingVia: null,
      },
      activeLayer: via.fromLayer,
    });
  },

  swapPcbRoutePosture: (current) => {
    const cur = get().pcbRouteDraft;
    if (!cur) return;
    // The first explicit swap locks the posture for the rest of the draft.
    // Re-guessing per segment is what KiCad users report fighting.
    set({
      pcbRouteDraft: {
        ...cur,
        posture: swapPosture(current ?? cur.posture),
        postureLocked: true,
      },
    });
  },

  setPcbConflictMode: (mode) => {
    const cur = get().pcbRouteDraft;
    if (!cur || cur.conflictMode === mode) return;
    set({ pcbRouteDraft: { ...cur, conflictMode: mode } });
  },

  cyclePcbConflictMode: () => {
    const cur = get().pcbRouteDraft;
    if (!cur) return;
    set({
      pcbRouteDraft: {
        ...cur,
        conflictMode: cur.conflictMode === "walkaround" ? "ignore" : "walkaround",
      },
    });
  },

  adjustPcbCornerRadius: (deltaMm) => {
    const cur = get().pcbRouteDraft;
    if (!cur) return;
    const next = Math.max(
      0,
      Math.min(CORNER_RADIUS_MAX_MM, cur.cornerRadiusMm + deltaMm)
    );
    if (next === cur.cornerRadiusMm) return;
    set({ pcbRouteDraft: { ...cur, cornerRadiusMm: next } });
  },

  finishPcbRoute: (to, interior) => {
    const cur = get().pcbRouteDraft;
    if (!cur) return null;
    // Dropping the draft without committing has to undo what the draft did to
    // the editor — including the layer one of its own vias moved off. Same rule
    // as clearPcbRouteDraft, and for the same reason: otherwise the user is left
    // on the bottom copper and their next click on a top-layer pad silently does
    // nothing.
    const abandon = (): null => {
      const startLayer = cur.points[0]?.layer;
      set({
        pcbRouteDraft: null,
        ...(startLayer !== undefined && startLayer !== get().activeLayer
          ? { activeLayer: startLayer }
          : {}),
      });
      return null;
    };
    // Self-connect rejection — clicking the start pad terminates with no
    // route. The caller can decide to surface a toast.
    if (to && cur.fromSelector === to.selector) return abandon();
    const points = cur.points.slice();
    const push = (x: number, y: number, layer: LayerId) => {
      const last = points[points.length - 1];
      if (last && last.x === x && last.y === y && last.layer === layer) return;
      points.push({ x, y, layer, width: cur.width });
    };
    for (const p of interior ?? []) push(p.x, p.y, cur.activeLayer);
    // A dangling stub (Enter / End / double-click) has no destination pad; the
    // preview's own endpoint is already in `interior`.
    if (to) push(to.x, to.y, to.layer);
    if (points.length < 2) return abandon();
    const finished: PcbRouteDraft = {
      ...cur,
      toSelector: to?.selector ?? null,
      points,
      pendingVia: null,
    };
    set({ pcbRouteDraft: null });
    return finished;
  },

  popPcbRoutePoint: () => {
    const cur = get().pcbRouteDraft;
    if (!cur || cur.points.length <= 1) return;
    const popped = cur.points[cur.points.length - 1];
    const newLast = cur.points[cur.points.length - 2];
    // If the popped point was a via duplicate (same XY as the previous
    // point but a different layer), restore activeLayer to the layer the
    // new last point sits on. Otherwise subsequent corners would land on
    // a layer the user already undid.
    const wasVia =
      popped.x === newLast.x &&
      popped.y === newLast.y &&
      popped.layer !== newLast.layer;
    set({
      pcbRouteDraft: {
        ...cur,
        points: cur.points.slice(0, -1),
        pendingVia: null,
        ...(wasVia ? { activeLayer: newLast.layer } : {}),
      },
      ...(wasVia ? { activeLayer: newLast.layer } : {}),
    });
  },

  clearPcbRouteDraft: () => {
    const cur = get().pcbRouteDraft;
    if (cur === null && get().focusedNetKey === null) return;
    // Abandoning a route undoes everything the route did — including the layer a
    // via moved us onto. Without this, Esc over a route that dropped a via leaves
    // the editor on the bottom copper, and the next click on a top-layer pad
    // silently does nothing: a dead end with no way to see why.
    const startLayer = cur?.points[0]?.layer;
    set({
      pcbRouteDraft: null,
      focusedNetKey: null,
      ...(startLayer !== undefined && startLayer !== get().activeLayer
        ? { activeLayer: startLayer }
        : {}),
    });
  },

  setFocusedNetKey: (key) => {
    if (get().focusedNetKey === key) return;
    set({ focusedNetKey: key });
  },

  reset: () => set({ ...INITIAL, selectedKeys: new Set() }),
})));
