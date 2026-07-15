// Shared types for the editor package. Phase 0 wires only a subset of these
// (selection, viewport, manualEdits); the rest are stubs the schematic and
// pcb editors will fill in during Phase 1 / Phase 2.

import type { StableKey } from "./keys";

export type { StableKey };

// ─── Sidecar (manualEdits) ─────────────────────────────────────────────────────

export interface SchematicEdit {
  x?: number;
  y?: number;
  rotation?: number; // degrees, multiples of 90
  // For trace keys only: ordered list of [x, y] world coords representing
  // the wire's intermediate corners. Endpoints come from the trace's path
  // selectors (`.R1 > .pin1`), so this stores ONLY the bends in between.
  // When unset, the renderer falls back to Manhattan auto-routing — that
  // means an AI rewrite of <trace path={...}/> doesn't strand the visual
  // layout; the user-drawn route is preserved separately and only kicks
  // in once the trace's key is back in the tsx.
  waypoints?: Array<[number, number]>;
}

// Standard copper-layer identifiers. Matches circuit-json's `layer` field
// convention: "top" / "bottom" / "in1" / "in2" / ... PR 1 ships UI for
// top + bottom only; inner layers are a UI-only follow-up.
export type LayerId = "top" | "bottom" | string;

/** Angle constraint for manual routing, smart preview, and autoroute. */
export type PcbRoutingMode = "ortho" | "diag45" | "free";

// One point along a routed trace. Adjacent points with different `layer`
// values imply a via at the point where the layer flips.
export interface PcbRoutePoint {
  x: number;
  y: number;
  layer: LayerId;
  /** Segment width in mm starting at this point. Falls back to route default. */
  width?: number;
}

export interface PcbEdit {
  // ─── Component placement ────────────────────────────────────────────────
  x?: number;
  y?: number;
  /** @deprecated Rotation lives in tsx `pcbRotation` only — not read by pcbModel. */
  rotation?: number;
  layer?: LayerId;
  mirror_x?: boolean;

  // ─── Trace routing (used when key references a <trace>) ────────────────
  // Ordered route points; segment N is from `route[N]` to `route[N+1]` and
  // sits on `route[N].layer`. When two adjacent points have different
  // layers, the renderer draws a via at that point. Endpoints sit on real
  // pads, so this array captures EVERY point including the pad-snap
  // endpoints — that way an AI tsx rewrite of the trace's selectors
  // (`from`/`to`) is the only way to invalidate a route.
  route?: PcbRoutePoint[];
  // Trace width in mm. When unset, the canvas uses the global default
  // (editorStore.traceWidth).
  width?: number;
}

export interface ManualEditEntry {
  schematic?: SchematicEdit;
  pcb?: PcbEdit;
}

export type ManualEditsMap = Record<StableKey, ManualEditEntry>;

// ─── Selection / tool / viewport ───────────────────────────────────────────────

export type ToolMode =
  | "select"
  | "move"
  | "rotate"
  | "mirror"
  | "wire"
  | "trace"
  | "via"
  | "delete";

export interface ViewportTransform {
  // CSS transform applied to the canvas root: translate then scale.
  x: number;
  y: number;
  scale: number;
}

export interface SelectionState {
  selectedKeys: ReadonlySet<StableKey>;
}

// In-progress PCB route. Lives in editorStore so the canvas, status bar,
// undo handler, and Ctrl+Z all see the same state. On commit the route is
// written to the manualEdits sidecar only (keyed by the connection id of its
// two endpoints — see PcbCanvas.commitRoute); the tsx is never touched, since
// connectivity lives in `connections`. Cancel (Esc / right-click / tool
// switch) clears the draft without mutating the sidecar.
export interface PcbRouteDraft {
  // Trace key — non-null when the user re-routes an existing keyed route, null
  // when starting a fresh route.
  traceKey: StableKey | null;
  // Connectivity selectors. `from` is set at the first pad click; `to`
  // gets set when the user clicks the destination pad.
  fromSelector: string;
  toSelector: string | null;
  // Ordered route points captured so far (clicks + via insertions). First
  // entry is the start pad's coords + layer; last is the most recent
  // corner. The live cursor is rendered separately via `cursor` below.
  points: PcbRoutePoint[];
  // Layer the next segment lands on. Pressing `/` flips this AND inserts
  // a via at the last committed point.
  activeLayer: LayerId;
  // Trace width for new segments. Defaults to editorStore.traceWidth but
  // is captured here so width changes mid-route only affect future
  // segments.
  width: number;
  // Live cursor in world coords. Used for the preview segment from the
  // last committed point to the cursor.
  cursor: { x: number; y: number } | null;
  // When cursor is magnet-snapped to a pad on the active layer.
  snappedPad: {
    selector: string;
    x: number;
    y: number;
    layer: LayerId;
  } | null;
  // Obstacle-aware preview from the last committed point to the cursor.
  // Computed by routeAssist on pointermove; rendered as a dashed overlay.
  smartPreview: PcbRoutePoint[] | null;
}

// ─── EditorOp (semantic edit operations for undo/redo) ─────────────────────────

export type EditorOp =
  | {
      kind: "set_schematic_pos";
      key: StableKey;
      from: SchematicEdit | undefined;
      to: SchematicEdit;
    }
  | {
      kind: "set_pcb_pos";
      key: StableKey;
      from: PcbEdit | undefined;
      to: PcbEdit;
    }
  | {
      kind: "set_pcb_route";
      key: StableKey;
      from: Array<[number, number]> | undefined;
      to: Array<[number, number]>;
    }
  | {
      kind: "tsx_replace";
      from: string;
      to: string;
    };

// ─── Project file (.cherryblossom.json) ────────────────────────────────────────

// The on-disk project schema. Version 1 is the first (and only) supported
// format; the experimental pre-launch layouts it replaced are gone. A loader
// for a future schema version can branch on `version` when backward
// compatibility actually becomes a concern.
export interface ProjectFile {
  version: 1;
  tsxCode: string;
  manualEdits: ManualEditsMap;
  metadata?: { title: string };
}

// ─── Evaluator output ──────────────────────────────────────────────────────────

export interface EvaluatorResult {
  // Monotonic per-evaluator instance. The store keeps only the latest version.
  version: number;
  // Hash of the (tsx + manualEdits) input so consumers can verify they're
  // looking at output that matches some specific input snapshot.
  inputHash: string;
  // The raw circuit-json from CircuitRunner. Typed as unknown[] to avoid
  // forcing every consumer to depend on @tscircuit/eval's types.
  circuitJson: unknown[];
  // Errors collected during evaluation (compile or runtime). Empty on success.
  errors: string[];
  // Wall-clock duration in ms — useful for performance overlays.
  durationMs: number;
}

export interface EvaluatorError {
  version: number;
  inputHash: string;
  message: string;
}
