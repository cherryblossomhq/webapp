// editorStore — Phase 0 skeleton.
//
// This is the home for everything that's specific to the *editor* (selection,
// modal tool, viewport, the manualEdits sidecar) and intentionally separate
// from circuitStore (which is the home for tsx + circuitJson).
//
// During Phase 0 nothing drives manualEdits yet — the field exists so that
// project-file load/save can round-trip it correctly and the chat prompt can
// summarize current positions. Phase 1 / Phase 2 wire it to the new editors.

import { create } from "zustand";
import type {
  LayerId,
  ManualEditEntry,
  ManualEditsMap,
  PcbEdit,
  PcbRouteDraft,
  PcbRoutePoint,
  PcbRoutingMode,
  SchematicEdit,
  StableKey,
  ToolMode,
  ViewportTransform,
} from "../shared/types";
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

// "whatsnew" is a transient, closeable tab shown once after an app update (see
// whatsNewStore) — not a persistent view mode like the others.
export type EditorTab = "schematic" | "pcb" | "cad" | "bom" | "code" | "whatsnew";

interface EditorStore {
  // ─── Selection (shared across schematic / pcb tabs) ──────────────────────
  selectedKeys: ReadonlySet<StableKey>;

  // ─── Active editor tab (Phase 1+) ────────────────────────────────────────
  // Schematic routes to the new SVG editor; pcb/cad/bom still route to
  // RunFrame for now (Phase 2 replaces pcb). Lives in the store so
  // keyboard shortcuts / toolbar / properties panel can all coordinate.
  activeTab: EditorTab;

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
  // Angle constraint for manual routing, preview, and autoroute.
  routingMode: PcbRoutingMode;
  // In-progress PCB route. Owned here so the canvas, status bar, and
  // keyboard shortcut handlers all coordinate.
  pcbRouteDraft: PcbRouteDraft | null;
  // Net currently in focus for routing (highlights pads/traces, dims the rest).
  // Set when a route starts or when the user picks a ratsnest edge to autoroute.
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

  // ─── Actions: viewport ───────────────────────────────────────────────────
  setViewport: (which: keyof ViewportPair, transform: ViewportTransform) => void;
  resetViewport: (which: keyof ViewportPair) => void;

  // ─── Actions: sidecar ────────────────────────────────────────────────────
  setManualEdits: (m: ManualEditsMap) => void;
  setSchematicEdit: (key: StableKey, edit: SchematicEdit | null) => void;
  setPcbEdit: (key: StableKey, edit: PcbEdit | null) => void;
  // Batch variant of setPcbEdit: applies every entry in ONE store update so a
  // multi-select drag (or an autoroute-all commit) costs one notification and
  // one manualEdits copy per frame instead of one per key.
  setPcbEdits: (
    entries: ReadonlyArray<readonly [StableKey, PcbEdit | null]>
  ) => void;
  // Drop the optimistic PCB placement override (x/y) for any key whose
  // freshly-evaluated position now matches it. Called from the background
  // evaluator once an eval lands: the position is baked into the tsx (the real
  // source of truth), so the sidecar override has done its job as a drag preview
  // and is dropped to avoid masking later tsx changes (AI edits, undo, code tab).
  // Rotation is tsx-only (pcbRotation) — any legacy sidecar rotation field is
  // stripped on reconcile. Route / width / layer / mirror_x are left alone.
  reconcilePcbPlacements: (
    evalById: ReadonlyMap<StableKey, { x: number; y: number; rotation: number }>
  ) => void;
  // Drop entries whose key is no longer present in the live tsx. Called on
  // project save and after AI rewrites prune components.
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
  // Add a corner click at the cursor position on the current active layer.
  addPcbRouteCorner: (point: { x: number; y: number }) => void;
  // Insert a via at the last committed route point and flip the active
  // layer to `to`. Visual: a small annular ring appears at the corner; the
  // next segment starts on the new layer.
  insertPcbRouteVia: (to: LayerId) => void;
  // Set the live cursor + magnet-snap state. Cheap to call per pointermove.
  setPcbRouteCursor: (
    cursor: { x: number; y: number } | null,
    snappedPad: {
      selector: string;
      x: number;
      y: number;
      layer: LayerId;
    } | null,
    smartPreview?: PcbRoutePoint[] | null
  ) => void;
  // Finish the route at a destination pad. Adds the final route point
  // (snapped to the pad) and exposes the completed draft for the caller
  // to bake into tsx + sidecar. Returns the finished draft so the caller
  // can commit atomically, or null when there's nothing to commit
  // (single-point click).
  finishPcbRoute: (to: {
    selector: string;
    x: number;
    y: number;
    layer: LayerId;
  }) => PcbRouteDraft | null;
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
  | "activeLayer"
  | "layerVisibility"
  | "traceWidth"
  | "activeWidthProfileId"
  | "routingMode"
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
  activeLayer: TOP_LAYER_ID,
  layerVisibility: defaultLayerVisibility(),
  traceWidth: DEFAULT_TRACE_WIDTH_MM,
  activeWidthProfileId: "signal",
  routingMode: "ortho",
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

export const useEditorStore = create<EditorStore>((set, get) => ({
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
    if (prev === "trace" && mode !== "trace" && get().pcbRouteDraft) {
      set({ toolMode: mode, pcbRouteDraft: null });
      return;
    }
    set({ toolMode: mode });
  },

  // ─── Tab ──────────────────────────────────────────────────────────────────

  setActiveTab: (tab) => {
    if (get().activeTab === tab) return;
    set({ activeTab: tab });
  },

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
      let workingPcb: PcbEdit = pcb;
      if (pcb.rotation !== undefined) {
        changed = true;
        workingPcb = { ...pcb };
        delete workingPcb.rotation;
      }

      const hasXY =
        workingPcb.x !== undefined || workingPcb.y !== undefined;

      const commitEntry = (pcbOut: PcbEdit | undefined) => {
        const nextEntry: ManualEditEntry = { ...entry };
        if (pcbOut && Object.keys(pcbOut).length > 0) nextEntry.pcb = pcbOut;
        else delete nextEntry.pcb;
        if (Object.keys(nextEntry).length > 0) next[key] = nextEntry;
      };

      if (!hasXY || !target) {
        if (workingPcb !== pcb) commitEntry(workingPcb);
        else next[key] = entry;
        continue;
      }

      const xMatch =
        workingPcb.x === undefined || Math.abs(workingPcb.x - target.x) < EPS;
      const yMatch =
        workingPcb.y === undefined || Math.abs(workingPcb.y - target.y) < EPS;
      if (!xMatch || !yMatch) {
        if (workingPcb !== pcb) {
          changed = true;
          commitEntry(workingPcb);
        } else next[key] = entry;
        continue;
      }

      changed = true;
      const restPcb: PcbEdit = { ...workingPcb };
      delete restPcb.x;
      delete restPcb.y;
      delete restPcb.rotation;
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
        cursor: null,
        snappedPad: null,
        smartPreview: null,
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
        cursor: null,
        snappedPad: null,
        smartPreview: null,
      },
      activeLayer: start.layer,
    });
  },

  addPcbRouteCorner: (point) => {
    const cur = get().pcbRouteDraft;
    if (!cur) return;
    const last = cur.points[cur.points.length - 1];
    if (last && last.x === point.x && last.y === point.y) return;
    const next: PcbRoutePoint = {
      x: point.x,
      y: point.y,
      layer: cur.activeLayer,
      width: cur.width,
    };
    set({
      pcbRouteDraft: { ...cur, points: [...cur.points, next], smartPreview: null },
    });
  },

  insertPcbRouteVia: (to) => {
    const cur = get().pcbRouteDraft;
    if (!cur) return;
    if (cur.activeLayer === to) return;
    // Drop the via AT the current end of the route by appending a
    // duplicate point at last(x,y) on the new layer. pcbModel reads
    // adjacent points with differing layers as a via at that XY; without
    // this duplicate point, the renderer would emit the via at the
    // user's NEXT click and silently drop the segment between the
    // pre-`/` corner and the post-`/` corner.
    const last = cur.points[cur.points.length - 1];
    const viaPoint: PcbRoutePoint = {
      x: last.x,
      y: last.y,
      layer: to,
      width: cur.width,
    };
    set({
      pcbRouteDraft: {
        ...cur,
        points: [...cur.points, viaPoint],
        activeLayer: to,
        smartPreview: null,
      },
      activeLayer: to,
    });
  },

  setPcbRouteCursor: (cursor, snappedPad, smartPreview = undefined) => {
    const cur = get().pcbRouteDraft;
    if (!cur) return;
    const sameCursor =
      (cur.cursor === null && cursor === null) ||
      (cur.cursor !== null &&
        cursor !== null &&
        cur.cursor.x === cursor.x &&
        cur.cursor.y === cursor.y);
    const sameSnap =
      (cur.snappedPad === null && snappedPad === null) ||
      (cur.snappedPad !== null &&
        snappedPad !== null &&
        cur.snappedPad.selector === snappedPad.selector);
    const nextPreview =
      smartPreview === undefined ? cur.smartPreview : smartPreview;
    const samePreview =
      cur.smartPreview === nextPreview ||
      (cur.smartPreview !== null &&
        nextPreview !== null &&
        cur.smartPreview.length === nextPreview.length &&
        cur.smartPreview.every(
          (p, i) =>
            p.x === nextPreview[i].x &&
            p.y === nextPreview[i].y &&
            p.layer === nextPreview[i].layer
        ));
    if (sameCursor && sameSnap && samePreview) return;
    set({
      pcbRouteDraft: { ...cur, cursor, snappedPad, smartPreview: nextPreview },
    });
  },

  finishPcbRoute: (to) => {
    const cur = get().pcbRouteDraft;
    if (!cur) return null;
    // Self-connect rejection — clicking the start pad terminates with no
    // route. The caller can decide to surface a toast.
    if (cur.fromSelector === to.selector) {
      set({ pcbRouteDraft: null });
      return null;
    }
    // Append the destination pad point. If the destination pad is on a
    // different layer than the current active layer, the renderer infers
    // a via at the previous point (route[N-1] on activeLayer → route[N]
    // on the pad's layer). For now we follow the user's active layer
    // choice — they should have already pressed `/` to switch if needed.
    const finalPoint: PcbRoutePoint = {
      x: to.x,
      y: to.y,
      layer: to.layer,
      width: cur.width,
    };
    const finished: PcbRouteDraft = {
      ...cur,
      toSelector: to.selector,
      points: [...cur.points, finalPoint],
      cursor: null,
      snappedPad: null,
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
        smartPreview: null,
        ...(wasVia ? { activeLayer: newLast.layer } : {}),
      },
      ...(wasVia ? { activeLayer: newLast.layer } : {}),
    });
  },

  clearPcbRouteDraft: () => {
    if (get().pcbRouteDraft === null && get().focusedNetKey === null) return;
    set({ pcbRouteDraft: null, focusedNetKey: null });
  },

  setFocusedNetKey: (key) => {
    if (get().focusedNetKey === key) return;
    set({ focusedNetKey: key });
  },

  reset: () => set({ ...INITIAL, selectedKeys: new Set() }),
}));
