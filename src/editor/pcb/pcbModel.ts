// pcbModel — pure (circuitJson + tsx + manualEdits) → PcbModel translation.
//
// The PCB editor consumes the eval pipeline's circuit-json output for
// component / pad / silkscreen geometry. tsx contributes the stable keys
// (so the sidecar survives AI rewrites), and manualEdits.pcb supplies
// physical overrides:
//   - Component placement (x, y) via manualEdits + tsx pcbX/pcbY; layer via tsx
//     `layer` prop; rotation via tsx pcbRotation only
//   - Routed trace geometry (per-point layer + width)
//
// Everything here is pure: no React, no DOM, no store reads. The canvas
// re-builds the model on every (circuitJson + tsx + manualEdits) change
// inside a useMemo, mirroring the schematic editor pattern.
//
// Important design choices:
//   - Pad coords come from circuit-json directly. When the user drags a
//     component, the component outline moves immediately (manualEdits
//     override) but pads stay at their eval coords until the debounced
//     eval re-runs (~300ms). This is intentional MVP — relative-to-
//     component pad transforms are tracked as a follow-up.
//   - Manual routes COMPLETELY override eval routes. If
//     manualEdits[traceKey].pcb.route exists, the renderer uses it and
//     ignores the eval's pcb_trace.route for that trace. This is what
//     makes "tsx as source of truth for connectivity, sidecar for
//     geometry" work.
//   - Ratsnest only computes for source_traces whose pcb_trace has no
//     route AND whose manualEdit has no route. Routed nets don't get a
//     ratsnest hint.

import type { AnyCircuitElement } from "circuit-json";
import type {
  LayerId,
  ManualEditsMap,
  PcbEdit,
  PcbRoutePoint,
  StableKey,
} from "@/editor/shared/types";
import { extractComponentsCached } from "@/utils/tsxTransform";
import { canonEndpoint, connectionId } from "@/editor/shared/connectionId";
import {
  DEFAULT_TRACE_WIDTH_MM,
  DEFAULT_VIA_DRILL_MM,
  DEFAULT_VIA_PAD_MM,
  TOP_LAYER_ID,
} from "./layers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BoardOutline {
  // Board center + half-extents (mm). The board outline is rendered as a
  // dashed border so users can tell where the board edges are without
  // hiding what's behind them.
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface PcbComponentRecord {
  key: StableKey;
  // Designator + display name from tsx (e.g. "R1").
  name: string;
  // Original pcb_component_id from circuit-json (kept for hit-test fall-back
  // and for cross-probe debugging).
  pcbComponentId: string;
  // World-space center after applying manualEdits.pcb overrides.
  x: number;
  y: number;
  rotationDeg: number;
  // The rotation baked into circuit-json (i.e. the rotation that width/height
  // were measured at). The sidecar override may diverge from this between an
  // R-press and the next eval; consumers that render the bbox or hit-test
  // it must rotate by `rotationDeg - originRotationDeg`, not by rotationDeg,
  // otherwise origRotation gets double-counted.
  originRotationDeg: number;
  layer: LayerId;
  // Body bbox in mm, at originRotationDeg. Used for the courtyard outline +
  // hit-test for component selection.
  width: number;
  height: number;
  // Pad-derived oriented display box (courtyard dims + rotation), precomputed
  // once in buildPcbModel. hitTest (per pointermove) and ComponentBody (per
  // render) read this instead of re-running pcbComponentDisplayBbox, which does
  // a rotating-calipers search + full pad scan. Absent only on hand-built test
  // fixtures, where consumers fall back to computing it on demand.
  displayBbox?: { width: number; height: number; rotationDeg: number };
  // True when the position is the user-edited override (vs. eval's auto-
  // placement). The renderer can show user-placed components with full
  // opacity and auto-placed ones slightly faded.
  manuallyPlaced: boolean;
  // Whether the tsx pins each axis explicitly (an `pcbX` / `pcbY` prop in the
  // source of truth). Tracked PER AXIS, not as one boolean: tscircuit lets a
  // part fix one coordinate and auto-lay-out the other, so a part with only
  // `pcbX` still has an auto Y that re-packs on the next eval. Unlike
  // `manuallyPlaced` (which also flips for a transient drag override), these
  // strictly answer "does the source of truth pin this axis?". The drag/rotate
  // bake uses them to pin whichever axes are still auto-placed so the part
  // doesn't drift when another part is moved (see withAutoPlacedPins).
  pcbXInTsx: boolean;
  pcbYInTsx: boolean;
  // True when the eval emitted footprint silkscreen outline geometry (lines /
  // paths / shapes — text doesn't count) for this part. The renderer then
  // draws only the subtle courtyard fill and lets the real silkscreen show
  // the body outline + pin-1 marker, instead of faking both with a
  // pad-derived box (which spans the pads, far wider than the actual body).
  hasSilkscreenOutline: boolean;
}

export type PadShape = "circle" | "rect" | "pill" | "polygon";

export interface PcbPadRecord {
  // pad identity from circuit-json
  pcbSmtpadId?: string;
  pcbPlatedHoleId?: string;
  // Owning component key (for selection + ratsnest grouping). Null when the
  // pad has no parent (rare — standalone pads from imported snippets).
  componentKey: StableKey | null;
  // Owning component pcb_component_id (kept so hit-tests can fall back to
  // component identity even when the tsx key resolution misses).
  pcbComponentId: string | null;
  // World position.
  x: number;
  y: number;
  // Layer the pad sits on (top/bottom). Plated through-holes draw on every
  // copper layer; for hit-test we treat them as the active layer.
  layer: LayerId;
  // True when this pad has a plated hole (drill diameter > 0). The
  // renderer draws an annular ring + drill dot.
  isThroughHole: boolean;
  // Geometry for the renderer + hit-test.
  shape: PadShape;
  // Circle radius (mm), valid when shape === "circle".
  radius?: number;
  // Rect / pill dimensions (mm). Width is along the pad's local X
  // (i.e. dimension along its own +x axis before rotationDeg is applied).
  rectWidth?: number;
  rectHeight?: number;
  // Effective CCW rotation (degrees) for rect / pill / rotated polygon
  // pads. Combines circuit-json's per-pad ccw_rotation with the parent
  // component's manualEdits delta so resistors / caps stay glued to
  // their body during R-press → eval. Always 0 for circle pads (they
  // are rotation-invariant) and for polygon pads whose vertices are
  // already pre-rotated in world space.
  rotationDeg: number;
  // Polygon points (mm world coords), valid when shape === "polygon".
  polygonPoints?: ReadonlyArray<{ x: number; y: number }>;
  // Pill rounding (mm), valid when shape === "pill".
  pillRadius?: number;
  // Through-hole drill (mm), valid when isThroughHole.
  drillDiameter?: number;
  // Slot drill extents (mm, pad-local frame) for oval/pill holes. When set,
  // the hole renders as a pill instead of a circle of drillDiameter.
  drillWidth?: number;
  drillHeight?: number;
  // Drill center offset from the pad center (mm, pad-local frame) — rect-pad
  // plated holes can park the hole off-center.
  drillOffsetX?: number;
  drillOffsetY?: number;
  // Through-hole outer pad diameter (mm), valid when shape === "circle".
  outerDiameter?: number;
  // pcb_port identifier that this pad terminates (used for ratsnest +
  // for resolving `.U1 > .pin1` style selectors back to a pad).
  pcbPortId: string | null;
  // The pad number / hint from circuit-json, e.g. "1" or "anode".
  portHints: ReadonlyArray<string>;
}

export interface PcbTraceSegment {
  // Endpoint world coords + the layer this segment sits on.
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  layer: LayerId;
  // Trace width in mm.
  width: number;
}

export interface PcbViaRecord {
  x: number;
  y: number;
  drillDiameter: number;
  outerDiameter: number;
  fromLayer: LayerId;
  toLayer: LayerId;
  // Optional owning trace key — populated for inline vias (route layer
  // change). Standalone vias have null.
  traceKey: StableKey | null;
}

export interface PcbTraceRecord {
  // Stable key from tsx (the `<trace key="t_..."/>` JSX attribute). Used
  // for selection, sidecar lookup, and undo.
  key: StableKey;
  // Endpoint selectors as written in tsx, for debugging.
  fromSelector: string;
  toSelector: string;
  // Resolved segments. Empty when the trace has no route in either eval
  // or manualEdits (ratsnest will pick it up).
  segments: PcbTraceSegment[];
  // Inline vias (where the route crosses layers). May be empty.
  vias: PcbViaRecord[];
  // True when the route came from manualEdits.pcb.route. False when from
  // the eval's pcb_trace.route. The renderer uses this to tag user-routed
  // traces (different selection halo).
  userRouted: boolean;
}

// One end of an unrouted net — for ratsnest rendering. We compute the
// minimum spanning tree (Kruskal, see ratsnest.ts) over these.
export interface RatsnestEndpoint {
  x: number;
  y: number;
  // Canonical pad selector (`.R1 > .pin1` form, normalized) — used for
  // net highlighting, autoroute, and ratsnest edge pairing.
  selector: string;
  componentKey: StableKey | null;
  // Pads already joined by committed copper share a cluster id; the MST
  // pre-unions same-cluster pads so no airwire is drawn over routed segments
  // (a partially-routed power net still ratsnests its remaining pads). Undefined
  // means "its own cluster" — the common all-unrouted case.
  cluster?: number;
}

export interface UnroutedNet {
  // Synthetic net id: connectionId of two of the net's pads (first + last by
  // collection order) — NOT a tsx <trace> key. Reserved for future ratsnest
  // selection/highlighting; for a multi-pad net it names an arbitrary endpoint
  // pair, not any single airwire. Null only in hand-built test fixtures.
  traceKey: StableKey | null;
  // An arbitrary pad pair on the net (first/last by collection order); see traceKey.
  fromSelector: string;
  toSelector: string;
  // 2+ pads connected on this net. Ratsnest draws the MST over these.
  pads: RatsnestEndpoint[];
}

export interface PcbSilkscreenLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  layer: LayerId;
}

// Closed silkscreen shapes (pcb_silkscreen_rect / circle / pill / oval).
// Footprinter + EasyEDA-imported footprints emit these alongside paths —
// pin-1 dots are circles, body outlines are sometimes rects.
export interface PcbSilkscreenShape {
  kind: "rect" | "circle" | "pill" | "oval";
  // Center, world mm.
  x: number;
  y: number;
  // Full extents (circle: 2r × 2r, oval: 2rx × 2ry).
  width: number;
  height: number;
  // Rect corner rounding (mm); pills round at min(w,h)/2 in the renderer.
  cornerRadius: number;
  rotationDeg: number;
  // 0 → no stroke (filled-only shape).
  strokeWidth: number;
  filled: boolean;
  dashed: boolean;
  layer: LayerId;
}

export interface PcbSilkscreenText {
  x: number;
  y: number;
  text: string;
  fontSize: number;
  layer: LayerId;
  rotationDeg: number;
  // Nine-point anchor split into axes ("top_left" → left + top).
  anchor: "left" | "center" | "right";
  anchorV: "top" | "middle" | "bottom";
  // Bottom-layer text is mirrored so it reads correctly through the board.
  mirrored: boolean;
}

export interface PcbModel {
  board: BoardOutline | null;
  components: PcbComponentRecord[];
  pads: PcbPadRecord[];
  traces: PcbTraceRecord[];
  vias: PcbViaRecord[];
  silkscreenLines: PcbSilkscreenLine[];
  silkscreenShapes: PcbSilkscreenShape[];
  silkscreenTexts: PcbSilkscreenText[];
  // Every multi-pad net (≥2 pads), regardless of routing state. Routed nets
  // stay here so focus / rip-up / reroute can still find a net after all its
  // airwires are gone. Carries cluster ids so a fully-routed net has every pad
  // in one cluster.
  nets: UnroutedNet[];
  // The subset of `nets` that still has at least one airwire (≥2 clusters).
  // Only this list feeds the ratsnest renderer.
  unroutedNets: UnroutedNet[];
  // Fast lookup helpers.
  byKey: Map<StableKey, PcbComponentRecord | PcbTraceRecord>;
  // pcb_component_id → tsx stable key. Lets the hit-test / selection
  // bridge eval-side IDs (which can't be edited by AI) to tsx-side keys
  // (which can).
  keyByPcbComponentId: Map<string, StableKey>;
  // pcb_port_id → pad record. Resolves trace selectors back to pad
  // positions for ratsnest + routing endpoint snapping.
  padByPortId: Map<string, PcbPadRecord>;
  // Pad lookup by `.componentName > .portHint` selector form — what
  // tscircuit `<trace path={...}/>` uses. Lower-case for case-insensitive
  // matches.
  padBySelector: Map<string, PcbPadRecord>;
  // Inverse of padBySelector keyed by object identity — gives an O(1)
  // canonical selector lookup for a pad. The route tool calls this on
  // every pointermove (pad-snap commit) so a linear scan would dominate
  // the routing frame budget on dense boards.
  selectorByPad: Map<PcbPadRecord, string>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

// Normalize a circuit-json layer field — most elements use string, some
// use string[]. We return the first element of arrays as a best-effort.
function normalizeLayer(v: unknown, fallback: LayerId = TOP_LAYER_ID): LayerId {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return fallback;
}

// circuit-json silkscreen elements carry the FACE they sit on ("top" /
// "bottom" — LayerRef has no silkscreen names), not an editor layer id.
// Map to the editor's silkscreen layers so silkscreen gets the near-white
// silkscreen color and the LayerPanel silkscreen toggles — passing the raw
// value through painted silkscreen in copper red and tied its visibility to
// the copper toggle.
function silkscreenLayerId(v: unknown): LayerId {
  const raw = normalizeLayer(v, TOP_LAYER_ID);
  return raw === "bottom" || raw === "silkscreen_bottom"
    ? "silkscreen_bottom"
    : "silkscreen_top";
}

// Convert a tscircuit pad selector to the canonical compact form used to
// compare endpoints everywhere (`.R1 > .pin1` → `r1.pin1`). This MUST agree
// with how `<trace>` from/to selectors are stored — since the connections
// refactor those are written compact (`R1.pin1`) via normalizeSelectorString.
// The old collapse-`>`-only form (`.r1>.pin1`) no longer matched the stored
// compact form, so every map that bridges a tsx trace key to a circuit-json
// source_trace (Phase 5a render, Phase 8 ratsnest, the fab-export splice in
// circuitJsonMerge) silently missed — manual routes vanished after eval caught
// up and a ghost ratsnest reappeared over routed copper. Delegating to the
// shared canonEndpoint keeps this in lockstep with connections-side comparisons.
export function normalizePadSelector(sel: string): string {
  return canonEndpoint(sel);
}

// Build the `.componentName > .pinX` style selector that <trace path={...}/>
// uses. Numeric labels get the "pin" prefix (1 → pin1) to match the
// tscircuit convention; named labels (anode/Cathode/VCC) pass through.
export function padSelectorFor(componentName: string, portHint: string): string {
  const safe = /^\d+$/.test(portHint) ? `pin${portHint}` : portHint;
  return normalizePadSelector(`.${componentName} > .${safe}`);
}

export interface SourcePortInfo {
  componentName: string;
  hint: string;
  hints: string[];
}

export interface SourceGraph {
  nameBySourceComponentId: Map<string, string>;
  sourcePortInfo: Map<string, SourcePortInfo>;
  sourceTraces: Array<{ id: string; portIds: ReadonlyArray<string> }>;
  sourceNetIdByTrace: Map<string, string | undefined>;
}

// Resolve circuit-json source_* elements into the lookup maps every consumer
// needs (PCB rendering here, the export splice in circuitJsonMerge.ts). Shared
// so the two can't drift — a change to how ports/traces are read happens once.
//
// Two passes because circuit-json doesn't guarantee element order: a
// source_port can appear before its parent source_component. Reading the name
// map in the same pass we populate it would silently miss those ports.
export function resolveSourceGraph(
  circuitJson: ReadonlyArray<AnyCircuitElement>,
): SourceGraph {
  const nameBySourceComponentId = new Map<string, string>();
  const sourcePortInfo = new Map<string, SourcePortInfo>();
  const sourceTraces: Array<{ id: string; portIds: ReadonlyArray<string> }> = [];
  const sourceNetIdByTrace = new Map<string, string | undefined>();

  // Pass 1: source_components only, so the name map is complete before Pass 2.
  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    if (asString(r.type) !== "source_component") continue;
    const id = asString(r.source_component_id);
    const name = asString(r.name);
    if (id && name) nameBySourceComponentId.set(id, name);
  }

  // Pass 2: source_ports + source_traces.
  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    const t = asString(r.type);
    if (!t) continue;

    if (t === "source_port") {
      const portId = asString(r.source_port_id);
      const ownerId = asString(r.source_component_id);
      if (!portId || !ownerId) continue;
      const name = nameBySourceComponentId.get(ownerId);
      const rawHints = (r.port_hints as unknown[]) ?? [];
      const hints = Array.isArray(rawHints)
        ? rawHints.filter((x): x is string => typeof x === "string")
        : [];
      const fallbackName = asString(r.name);
      if (fallbackName && !hints.includes(fallbackName)) hints.push(fallbackName);
      const hint = hints[0] ?? "?";
      if (name) {
        sourcePortInfo.set(portId, { componentName: name, hint, hints });
      }
    } else if (t === "source_trace") {
      const id = asString(r.source_trace_id);
      const portIds =
        (r.connected_source_port_ids as unknown[] | undefined)?.filter(
          (x): x is string => typeof x === "string"
        ) ?? [];
      if (id) {
        sourceTraces.push({ id, portIds });
        const netIds =
          (r.connected_source_net_ids as unknown[] | undefined)?.filter(
            (x): x is string => typeof x === "string"
          ) ?? [];
        sourceNetIdByTrace.set(id, netIds[0]);
      }
    }
  }

  return {
    nameBySourceComponentId,
    sourcePortInfo,
    sourceTraces,
    sourceNetIdByTrace,
  };
}

// The from/to pad selectors for a trace's resolved ports (first + last), or
// null when fewer than two ports resolve. Centralizes the pairing convention
// (first hint, first+last port) so the renderer and the export splice agree.
// NOTE: only ports[0] and ports[last] are used — a >2-port net's middle
// connections don't participate in pairing, and two traces sharing the same
// from/to selector pair are indistinguishable here (the renderer has the same
// limitation, so they stay in lockstep).
export function endpointSelectors(
  ports: ReadonlyArray<SourcePortInfo>,
): { fromSel: string; toSel: string } | null {
  if (ports.length < 2) return null;
  return {
    fromSel: padSelectorFor(ports[0].componentName, ports[0].hint),
    toSel: padSelectorFor(
      ports[ports.length - 1].componentName,
      ports[ports.length - 1].hint,
    ),
  };
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export function buildPcbModel(
  circuitJson: ReadonlyArray<AnyCircuitElement> | null | undefined,
  tsxCode: string,
  manualEdits: ManualEditsMap
): PcbModel {
  const empty: PcbModel = {
    board: null,
    components: [],
    pads: [],
    traces: [],
    vias: [],
    silkscreenLines: [],
    silkscreenShapes: [],
    silkscreenTexts: [],
    nets: [],
    unroutedNets: [],
    byKey: new Map(),
    keyByPcbComponentId: new Map(),
    padByPortId: new Map(),
    padBySelector: new Map(),
    selectorByPad: new Map(),
  };

  if (!circuitJson || circuitJson.length === 0) return empty;

  // ─── Phase 1: tsx index ─────────────────────────────────────────────────
  // Pull stable keys out of tsx so circuit-json elements can be matched
  // back to the sidecar. Failures here are non-fatal: if parsing fails
  // the model still renders, just without manualEdits overrides.
  let tsxComponents: Array<{
    name: string;
    key?: string;
    // Whether the tsx pins each axis. Tracked separately because tscircuit
    // honors a lone pcbX (or pcbY) and auto-lays-out the other coordinate.
    pcbXSet: boolean;
    pcbYSet: boolean;
    layer?: string;
  }> = [];
  try {
    tsxComponents = extractComponentsCached(tsxCode).map((c) => ({
      name: c.name,
      // `extractComponents` exposes the JSX `key=` attribute via
      // `props.key` (it walks every attribute through `getAllProps`).
      key: c.props.key,
      // An explicit pcbX / pcbY prop pins that axis in the tsx (the source of
      // truth for layout). A part with either axis pinned renders solid, not
      // faded, even after the optimistic drag override is reconciled away.
      pcbXSet: c.props.pcbX !== undefined,
      pcbYSet: c.props.pcbY !== undefined,
      layer: c.props.layer,
    }));
  } catch {
    // tsxTransform parse failures show up as compile errors elsewhere; the
    // PCB canvas should keep rendering whatever circuit-json it last got.
  }

  const tsxKeyByName = new Map<string, StableKey>();
  const pcbXByTsxName = new Set<string>();
  const pcbYByTsxName = new Set<string>();
  const layerByTsxName = new Map<string, string>();
  for (const c of tsxComponents) {
    if (c.key) tsxKeyByName.set(c.name, c.key);
    if (c.pcbXSet) pcbXByTsxName.add(c.name);
    if (c.pcbYSet) pcbYByTsxName.add(c.name);
    if (c.layer !== undefined) layerByTsxName.set(c.name, c.layer);
  }

  // ─── Phase 2: source resolution ─────────────────────────────────────────
  // source_component_id → name (the designator), source_port_id →
  // (component name + port hint). Shared with circuitJsonMerge.ts.
  const { nameBySourceComponentId, sourcePortInfo, sourceTraces, sourceNetIdByTrace } =
    resolveSourceGraph(circuitJson);

  // ─── Phase 3: PCB components ────────────────────────────────────────────
  const componentByPcbId = new Map<string, PcbComponentRecord>();
  const components: PcbComponentRecord[] = [];
  const keyByPcbComponentId = new Map<string, StableKey>();
  // Per-component translate delta from manualEdits — used in Phase 4 to
  // move pads with their parent during drag, without waiting for eval.
  // Rotation is NOT sidecarred: it lives in tsx pcbRotation and circuit-json.
  interface ComponentXform {
    origX: number;
    origY: number;
    effX: number;
    effY: number;
  }
  const xformByPcbId = new Map<string, ComponentXform>();

  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    if (asString(r.type) !== "pcb_component") continue;

    const pcbId = asString(r.pcb_component_id);
    const srcId = asString(r.source_component_id);
    if (!pcbId || !srcId) continue;

    const name = nameBySourceComponentId.get(srcId);
    if (!name) continue;

    // Some imported components (e.g. those pulled in by the AI import flow
    // before key injection) may not yet have a stable key — render them but
    // skip the sidecar lookup. The eval-time auto-placement is still shown.
    const key = tsxKeyByName.get(name);
    const edit: PcbEdit | undefined = key
      ? manualEdits[key]?.pcb
      : undefined;

    const center = asRecord(r.center);
    const origX = asNumber(center?.x) ?? 0;
    const origY = asNumber(center?.y) ?? 0;
    const origRotation = asNumber(r.rotation) ?? 0;
    const origLayer = normalizeLayer(r.layer);
    const width = asNumber(r.width) ?? 1;
    const height = asNumber(r.height) ?? 1;

    const x = edit?.x ?? origX;
    const y = edit?.y ?? origY;
    const rotation = origRotation;
    const tsxLayer = layerByTsxName.get(name);
    const layer =
      tsxLayer !== undefined
        ? normalizeLayer(tsxLayer)
        : (edit?.layer ?? origLayer);

    const record: PcbComponentRecord = {
      key: key ?? (`pcbcomp_${pcbId}` as StableKey),
      name,
      pcbComponentId: pcbId,
      x,
      y,
      rotationDeg: rotation,
      originRotationDeg: origRotation,
      layer,
      width,
      height,
      manuallyPlaced:
        pcbXByTsxName.has(name) ||
        pcbYByTsxName.has(name) ||
        edit?.x !== undefined ||
        edit?.y !== undefined,
      pcbXInTsx: pcbXByTsxName.has(name),
      pcbYInTsx: pcbYByTsxName.has(name),
      hasSilkscreenOutline: false, // computed in Phase 6
    };

    components.push(record);
    componentByPcbId.set(pcbId, record);
    xformByPcbId.set(pcbId, {
      origX,
      origY,
      effX: x,
      effY: y,
    });
    if (key) keyByPcbComponentId.set(pcbId, key);
  }

  // ─── Phase 4: Pads (SMT + plated holes) ────────────────────────────────
  const pads: PcbPadRecord[] = [];
  const padByPortId = new Map<string, PcbPadRecord>();
  const padBySelector = new Map<string, PcbPadRecord>();
  // Reverse map: pad object → its canonical selector (the first hint we
  // saw for that pad). Used by the route tool to look up the selector
  // for a snapped pad in O(1) per pointermove.
  const selectorByPad = new Map<PcbPadRecord, string>();

  // pcb_port_id → port info (component + hint). We collect these in a
  // first pass so when we visit pads we can resolve the selector even
  // when the port appears after the pad in the array.
  const pcbPortInfo = new Map<
    string,
    {
      componentKey: StableKey | null;
      componentName: string;
      hint: string;
      hints: string[];
    }
  >();

  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    if (asString(r.type) !== "pcb_port") continue;

    const portId = asString(r.pcb_port_id);
    const srcPortId = asString(r.source_port_id);
    if (!portId || !srcPortId) continue;

    const srcInfo = sourcePortInfo.get(srcPortId);
    if (!srcInfo) continue;

    const compKey = tsxKeyByName.get(srcInfo.componentName) ?? null;
    pcbPortInfo.set(portId, {
      componentKey: compKey,
      componentName: srcInfo.componentName,
      hint: srcInfo.hint,
      hints: srcInfo.hints,
    });
  }

  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    const t = asString(r.type);
    if (t !== "pcb_smtpad" && t !== "pcb_plated_hole") continue;

    const pcbComponentId = asString(r.pcb_component_id) ?? null;
    const componentKey = pcbComponentId
      ? keyByPcbComponentId.get(pcbComponentId) ?? null
      : null;
    const portId = asString(r.pcb_port_id) ?? null;
    const isTH = t === "pcb_plated_hole";
    const rawX = asNumber(r.x) ?? 0;
    const rawY = asNumber(r.y) ?? 0;
    const compRecord = pcbComponentId
      ? componentByPcbId.get(pcbComponentId)
      : undefined;
    const layer = compRecord?.layer ?? normalizeLayer(r.layer);
    const portHints =
      (r.port_hints as unknown[] | undefined)?.filter(
        (x): x is string => typeof x === "string"
      ) ?? [];

    // Apply the parent component's translate delta so pads follow a drag
    // without waiting for eval. Rotation comes from circuit-json only.
    const xform = pcbComponentId
      ? xformByPcbId.get(pcbComponentId)
      : undefined;
    const transformed = xform
      ? applyPositionDelta(rawX, rawY, xform)
      : { x: rawX, y: rawY };
    const x = transformed.x;
    const y = transformed.y;

    const shape = asString(r.shape) ?? (isTH ? "circle" : "rect");

    const padRotationDeg = padBaseRotationDeg(
      shape,
      asNumber(r.rect_ccw_rotation) ?? asNumber(r.ccw_rotation),
      compRecord?.originRotationDeg ?? 0
    );

    const pad: PcbPadRecord = {
      pcbSmtpadId: t === "pcb_smtpad" ? asString(r.pcb_smtpad_id) : undefined,
      pcbPlatedHoleId:
        t === "pcb_plated_hole" ? asString(r.pcb_plated_hole_id) : undefined,
      componentKey,
      pcbComponentId,
      x,
      y,
      layer,
      isThroughHole: isTH,
      shape: shapeFromString(shape),
      rotationDeg: padRotationDeg,
      pcbPortId: portId,
      portHints,
    };

    // Fill shape-specific dimensions defensively — circuit-json's shape
    // discriminator gates which fields are present, and plated holes name
    // their fields per variant: circle → outer_diameter, oval/pill →
    // outer_width/outer_height, *_hole_with_rect_pad → rect_pad_width/height.
    if (pad.shape === "circle") {
      pad.radius = isTH
        ? (asNumber(r.outer_diameter) ?? 0.8) / 2
        : asNumber(r.radius) ?? 0.5;
    } else if (pad.shape === "rect" || pad.shape === "pill") {
      pad.rectWidth =
        asNumber(r.rect_pad_width) ??
        asNumber(r.outer_width) ??
        asNumber(r.width) ??
        1;
      pad.rectHeight =
        asNumber(r.rect_pad_height) ??
        asNumber(r.outer_height) ??
        asNumber(r.height) ??
        1;
      if (pad.shape === "pill") {
        pad.pillRadius =
          asNumber(r.radius) ?? Math.min(pad.rectWidth, pad.rectHeight) / 2;
      } else {
        const borderRadius = asNumber(r.rect_border_radius);
        if (borderRadius) pad.pillRadius = borderRadius;
      }
    } else if (pad.shape === "polygon") {
      const pts = r.points;
      pad.polygonPoints = Array.isArray(pts)
        ? pts
            .map((p) => {
              const rp = asRecord(p);
              const px = asNumber(rp?.x) ?? 0;
              const py = asNumber(rp?.y) ?? 0;
              return xform
                ? applyPositionDelta(px, py, xform)
                : { x: px, y: py };
            })
        : [];
    }
    if (isTH) {
      const holeW = asNumber(r.hole_width);
      const holeH = asNumber(r.hole_height);
      if (holeW !== undefined && holeH !== undefined && holeW !== holeH) {
        // Slot / pill drill (oval and pill hole variants).
        pad.drillWidth = holeW;
        pad.drillHeight = holeH;
        pad.drillDiameter = Math.min(holeW, holeH);
      } else {
        pad.drillDiameter = asNumber(r.hole_diameter) ?? holeW ?? 0.3;
      }
      const offX = asNumber(r.hole_offset_x);
      const offY = asNumber(r.hole_offset_y);
      if (offX) pad.drillOffsetX = offX;
      if (offY) pad.drillOffsetY = offY;
      if (pad.shape === "circle") {
        pad.outerDiameter = asNumber(r.outer_diameter) ?? 0.8;
      }
    }

    pads.push(pad);
    if (portId) padByPortId.set(portId, pad);

    // Also index by selector form for trace endpoint resolution. We index
    // every hint the source_port carries (the canonical pad number, named
    // aliases like "anode" / "left") AND the pad's own port_hints. tscircuit's
    // selectors are tolerant — `.R1>.pin1`, `.R1>.left`, `.R1>.anode` may
    // all resolve to the same pad.
    if (portId) {
      const info = pcbPortInfo.get(portId);
      if (info) {
        const seen = new Set<string>();
        for (const hint of [...info.hints, ...portHints]) {
          if (!hint || seen.has(hint)) continue;
          seen.add(hint);
          const sel = padSelectorFor(info.componentName, hint);
          padBySelector.set(sel, pad);
          // First selector we see for this pad wins as the canonical
          // form for selectorByPad. In tscircuit the first hint is the
          // numeric pad number (e.g. "pin1"), which is the natural pick.
          if (!selectorByPad.has(pad)) selectorByPad.set(pad, sel);
        }
      }
    }
  }

  // ─── Phase 5: Traces (eval-side routes + manual overrides) ─────────────
  const traces: PcbTraceRecord[] = [];
  const standaloneVias: PcbViaRecord[] = [];

  // First, walk circuit-json pcb_trace elements to capture the eval's
  // route for each source_trace_id. Manual edits override this below.
  const evalRouteBySourceTraceId = new Map<
    string,
    { segments: PcbTraceSegment[]; vias: PcbViaRecord[] }
  >();
  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    if (asString(r.type) !== "pcb_trace") continue;
    const srcTraceId = asString(r.source_trace_id);
    const routeArr = r.route as unknown[] | undefined;
    if (!srcTraceId || !Array.isArray(routeArr)) continue;
    const built = buildSegmentsFromCircuitJsonRoute(routeArr);
    if (built.segments.length === 0 && built.vias.length === 0) continue;
    evalRouteBySourceTraceId.set(srcTraceId, built);
  }

  // Standalone vias from circuitJson are intentionally NOT rendered. They are
  // emitted by the tscircuit autorouter as part of its multi-layer routes —
  // but the editor is manual-only and already ignores the autorouter's
  // pcb_trace geometry (see the "No eval-route fallback" note in Phase 5
  // below). Rendering the vias without their owning traces produced floating
  // vias "coming from nowhere" (issue #23). Vias the user actually placed live
  // in manualEdits as route layer-changes and surface as inline trace vias.
  // To restore autoroute display, re-introduce both the eval-route lookup AND
  // this pcb_via collection together. `standaloneVias` stays an empty array.

  // Pair every source_trace to the connection id of its endpoint pads. A
  // sidecar route is keyed by that same connection id (see
  // PcbCanvas.commitRoute), so this map lets a rendered route recover its
  // net's from/to selectors and lets Phase 8 tell which nets are routed.
  // tscircuit lists a source_trace's ports in connection order; we pair on the
  // first/last (2-port) endpoints — net stubs / 0–1-port traces resolve to
  // null and are skipped.
  const selectorsByConnId = new Map<
    StableKey,
    { fromSel: string; toSel: string }
  >();
  for (const srcTrace of sourceTraces) {
    const ports = srcTrace.portIds
      .map((id) => sourcePortInfo.get(id))
      .filter((p): p is SourcePortInfo => !!p);
    const sels = endpointSelectors(ports);
    if (!sels) continue;
    const connId = connectionId(sels.fromSel, sels.toSel);
    if (!selectorsByConnId.has(connId)) selectorsByConnId.set(connId, sels);
  }

  // Render every sidecar route. Routes live ONLY in the sidecar (there is no
  // <trace> in the tsx — connectivity is `connections`), keyed by the
  // connection id of their two endpoints. This is fully decoupled from the
  // eval: a freshly-drawn route shows immediately, with no one-cycle lag, and
  // a route whose net the eval already produced recovers its from/to selectors
  // from the map above. A component-placement entry carries pcb.{x,y} but no
  // route, so it is skipped here. No eval-route (autoroute) display fallback —
  // every connection the user hasn't routed surfaces as a ratsnest airwire
  // (Phase 8); `evalRouteBySourceTraceId` is gathered for a future restore.
  for (const [k, entry] of Object.entries(manualEdits)) {
    const manualRoute = entry?.pcb?.route;
    if (!manualRoute || manualRoute.length < 2) continue;
    const key = k as StableKey;
    const built = buildSegmentsFromRoutePoints(
      manualRoute,
      entry.pcb?.width ?? DEFAULT_TRACE_WIDTH_MM,
      key
    );
    const sels = selectorsByConnId.get(key);
    traces.push({
      key,
      fromSelector: sels?.fromSel ?? "",
      toSelector: sels?.toSel ?? "",
      segments: built.segments,
      vias: built.vias,
      userRouted: true,
    });
  }

  // Precompute each component's pad-derived display box once. hitTest runs this
  // per pointermove and ComponentBody per render, so caching it here avoids
  // re-running the rotating-calipers search + pad scan on every mouse move.
  for (const comp of components) {
    comp.displayBbox = pcbComponentDisplayBbox(comp, pads);
  }

  // ─── Phase 6: Silkscreen ───────────────────────────────────────────────
  // Silkscreen elements attached to a component carry pcb_component_id —
  // apply the same parent-transform delta so designators / footprint
  // outlines move with their part during drag. All owned silkscreen renders
  // (the eval bakes component rotation into the world-space geometry, so a
  // rotated chip's outline arrives already rotated). Components that own
  // outline geometry are flagged so the renderer skips its synthetic
  // pad-derived body outline + notch in favor of the real footprint art.
  //
  // Designator text (pcb_silkscreen_text repeating the owner's name) is kept
  // and drawn as real silkscreen — like tscircuit / Altium — instead of the
  // editor synthesizing its own centered body label.
  const silkscreenLines: PcbSilkscreenLine[] = [];
  const silkscreenShapes: PcbSilkscreenShape[] = [];
  const silkscreenTexts: PcbSilkscreenText[] = [];
  const outlineOwnerIds = new Set<string>();
  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    const t = asString(r.type);
    if (!t || !t.startsWith("pcb_silkscreen_")) continue;
    const ownerId = asString(r.pcb_component_id);
    const ssXform = ownerId ? xformByPcbId.get(ownerId) : undefined;
    if (t !== "pcb_silkscreen_text" && ownerId) outlineOwnerIds.add(ownerId);

    if (t === "pcb_silkscreen_line") {
      const x1 = asNumber(r.x1) ?? 0;
      const y1 = asNumber(r.y1) ?? 0;
      const x2 = asNumber(r.x2) ?? 0;
      const y2 = asNumber(r.y2) ?? 0;
      const a = ssXform ? applyPositionDelta(x1, y1, ssXform) : { x: x1, y: y1 };
      const b = ssXform ? applyPositionDelta(x2, y2, ssXform) : { x: x2, y: y2 };
      silkscreenLines.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        width: asNumber(r.stroke_width) ?? 0.1,
        layer: silkscreenLayerId(r.layer),
      });
    } else if (t === "pcb_silkscreen_path") {
      const route = r.route;
      if (Array.isArray(route) && route.length >= 2) {
        const width = asNumber(r.stroke_width) ?? 0.1;
        const layer = silkscreenLayerId(r.layer);
        for (let i = 0; i < route.length - 1; i++) {
          const ra = asRecord(route[i]);
          const rb = asRecord(route[i + 1]);
          if (!ra || !rb) continue;
          const rawAx = asNumber(ra.x) ?? 0;
          const rawAy = asNumber(ra.y) ?? 0;
          const rawBx = asNumber(rb.x) ?? 0;
          const rawBy = asNumber(rb.y) ?? 0;
          const a = ssXform
            ? applyPositionDelta(rawAx, rawAy, ssXform)
            : { x: rawAx, y: rawAy };
          const b = ssXform
            ? applyPositionDelta(rawBx, rawBy, ssXform)
            : { x: rawBx, y: rawBy };
          silkscreenLines.push({
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            width,
            layer,
          });
        }
      }
    } else if (
      t === "pcb_silkscreen_rect" ||
      t === "pcb_silkscreen_circle" ||
      t === "pcb_silkscreen_pill" ||
      t === "pcb_silkscreen_oval"
    ) {
      const center = asRecord(r.center);
      const cx = asNumber(center?.x) ?? 0;
      const cy = asNumber(center?.y) ?? 0;
      const p = ssXform ? applyPositionDelta(cx, cy, ssXform) : { x: cx, y: cy };
      const layer = silkscreenLayerId(r.layer);
      const rotationDeg = asNumber(r.ccw_rotation) ?? 0;
      if (t === "pcb_silkscreen_rect") {
        silkscreenShapes.push({
          kind: "rect",
          x: p.x,
          y: p.y,
          width: asNumber(r.width) ?? 1,
          height: asNumber(r.height) ?? 1,
          cornerRadius: asNumber(r.corner_radius) ?? 0,
          rotationDeg,
          strokeWidth:
            r.has_stroke === false ? 0 : asNumber(r.stroke_width) ?? 0.1,
          filled: r.is_filled === true,
          dashed: r.is_stroke_dashed === true,
          layer,
        });
      } else if (t === "pcb_silkscreen_circle") {
        const radius = asNumber(r.radius) ?? 0.5;
        const filled = r.is_filled === true;
        silkscreenShapes.push({
          kind: "circle",
          x: p.x,
          y: p.y,
          width: radius * 2,
          height: radius * 2,
          cornerRadius: 0,
          rotationDeg,
          strokeWidth: filled ? 0 : asNumber(r.stroke_width) ?? 0.1,
          filled,
          dashed: false,
          layer,
        });
      } else if (t === "pcb_silkscreen_pill") {
        // Pills carry no stroke/fill fields in the spec — solid shapes.
        silkscreenShapes.push({
          kind: "pill",
          x: p.x,
          y: p.y,
          width: asNumber(r.width) ?? 1,
          height: asNumber(r.height) ?? 1,
          cornerRadius: 0,
          rotationDeg,
          strokeWidth: 0,
          filled: true,
          dashed: false,
          layer,
        });
      } else {
        // pcb_silkscreen_oval — radii, no stroke/fill fields (solid).
        silkscreenShapes.push({
          kind: "oval",
          x: p.x,
          y: p.y,
          width: (asNumber(r.radius_x) ?? 0.5) * 2,
          height: (asNumber(r.radius_y) ?? 0.5) * 2,
          cornerRadius: 0,
          rotationDeg,
          strokeWidth: 0,
          filled: true,
          dashed: false,
          layer,
        });
      }
    } else if (t === "pcb_silkscreen_text") {
      const text = asString(r.text) ?? "";
      const alignment = asString(r.anchor_alignment) ?? "center";
      const rawTx =
        asNumber(
          r.anchor_position
            ? (r.anchor_position as Record<string, unknown>).x
            : undefined
        ) ??
        asNumber(r.x) ??
        0;
      const rawTy =
        asNumber(
          r.anchor_position
            ? (r.anchor_position as Record<string, unknown>).y
            : undefined
        ) ??
        asNumber(r.y) ??
        0;
      const tp = ssXform
        ? applyPositionDelta(rawTx, rawTy, ssXform)
        : { x: rawTx, y: rawTy };
      silkscreenTexts.push({
        x: tp.x,
        y: tp.y,
        text,
        fontSize: asNumber(r.font_size) ?? 0.6,
        layer: silkscreenLayerId(r.layer),
        rotationDeg: asNumber(r.ccw_rotation) ?? 0,
        anchor: alignment.endsWith("left")
          ? "left"
          : alignment.endsWith("right")
            ? "right"
            : "center",
        anchorV: alignment.startsWith("top")
          ? "top"
          : alignment.startsWith("bottom")
            ? "bottom"
            : "middle",
        mirrored: r.is_mirrored === true,
      });
    }
  }
  for (const comp of components) {
    comp.hasSilkscreenOutline = outlineOwnerIds.has(comp.pcbComponentId);
  }

  // ─── Phase 7: Board outline ────────────────────────────────────────────
  let board: BoardOutline | null = null;
  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    if (asString(r.type) !== "pcb_board") continue;
    const center = asRecord(r.center);
    board = {
      centerX: asNumber(center?.x) ?? 0,
      centerY: asNumber(center?.y) ?? 0,
      width: asNumber(r.width) ?? 50,
      height: asNumber(r.height) ?? 50,
    };
    break;
  }

  // ─── Phase 8: Unrouted nets (for ratsnest) ─────────────────────────────
  // Group every pad that shares a net into one connected component, then list
  // the still-unrouted pads so ratsnest.ts can draw the MST of airwires. Two
  // connectivity shapes feed in and are unified here:
  //   • classic 2-port source_traces (pin↔pin), and
  //   • pin→net membership (each pad wired pad→net, e.g. power/ground) — which
  //     never produces a 2-port trace, so before this drew no airwire at all
  //     (issue #24).
  // We union source_port ids, bridged by a synthetic node per net so all pads
  // on one net collapse into a single component (mirrors liveRouteConnIds in
  // circuitJsonMerge.ts — the two read connectivity the same way so they can't
  // drift). Autorouter ignored: a net is "routed" only when a manualEdits
  // sidecar route exists, never because the eval produced a pcb_trace.route.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) {
      parent.set(x, x);
      return x;
    }
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur)! !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const srcTrace of sourceTraces) {
    const nodes = [...srcTrace.portIds];
    const netId = sourceNetIdByTrace.get(srcTrace.id);
    if (netId) nodes.push(`net:${netId}`);
    if (nodes.length === 0) continue;
    find(nodes[0]); // register single-port traces too
    for (let i = 1; i < nodes.length; i++) union(nodes[0], nodes[i]);
  }

  // Collect each component's distinct pads (deduped by selector — the same pad
  // can be reached through several traces on one net).
  const padsByRoot = new Map<string, Map<string, RatsnestEndpoint>>();
  for (const node of parent.keys()) {
    if (node.startsWith("net:")) continue; // a route never terminates on a net
    const info = sourcePortInfo.get(node);
    if (!info) continue;
    const sel = padSelectorFor(info.componentName, info.hint);
    const pad = padBySelector.get(sel);
    if (!pad) continue;
    const root = find(node);
    let pads = padsByRoot.get(root);
    if (!pads) padsByRoot.set(root, (pads = new Map()));
    if (!pads.has(sel)) {
      pads.set(sel, {
        x: pad.x,
        y: pad.y,
        selector: sel,
        componentKey: pad.componentKey,
      });
    }
  }

  const nets: UnroutedNet[] = [];
  const unroutedNets: UnroutedNet[] = [];
  for (const padMap of padsByRoot.values()) {
    const sels = [...padMap.keys()];
    if (sels.length < 2) continue;

    // Cluster pads already joined by committed copper. A sidecar route is keyed
    // by connectionId(endpoints) — the same key PcbCanvas.commitRoute wrote — so
    // pads with a route between them collapse into one cluster. The MST then
    // skips airwires over routed copper but still ratsnests the rest, so a
    // partially-routed power net keeps guiding the user to its remaining pads.
    const clusterParent = new Map<string, string>();
    const cFind = (x: string): string => {
      if (!clusterParent.has(x)) {
        clusterParent.set(x, x);
        return x;
      }
      let root = x;
      while (clusterParent.get(root)! !== root) root = clusterParent.get(root)!;
      return root;
    };
    const cUnion = (a: string, b: string) => {
      const ra = cFind(a);
      const rb = cFind(b);
      if (ra !== rb) clusterParent.set(ra, rb);
    };
    for (const sel of sels) cFind(sel);
    for (let i = 0; i < sels.length; i++) {
      for (let j = i + 1; j < sels.length; j++) {
        if (manualEdits[connectionId(sels[i], sels[j])]?.pcb?.route?.length) {
          cUnion(sels[i], sels[j]);
        }
      }
    }

    // Map cluster roots to small integers. A net with every pad in one cluster
    // is fully routed (no airwire) — it still belongs in `nets` (so it stays
    // findable for reroute), but is kept OUT of `unroutedNets` so the ratsnest
    // renderer never draws a ghost edge over its copper.
    const clusterIndex = new Map<string, number>();
    for (const sel of sels) {
      const root = cFind(sel);
      if (!clusterIndex.has(root)) clusterIndex.set(root, clusterIndex.size);
    }

    const fromSel = sels[0];
    const toSel = sels[sels.length - 1];
    const pads: RatsnestEndpoint[] = sels.map((sel) => ({
      ...padMap.get(sel)!,
      cluster: clusterIndex.get(cFind(sel))!,
    }));
    const net: UnroutedNet = {
      traceKey: connectionId(fromSel, toSel),
      fromSelector: fromSel,
      toSelector: toSel,
      pads,
    };
    nets.push(net);
    if (clusterIndex.size >= 2) unroutedNets.push(net);
  }

  // ─── Build lookup maps ──────────────────────────────────────────────────
  const byKey = new Map<StableKey, PcbComponentRecord | PcbTraceRecord>();
  for (const c of components) byKey.set(c.key, c);
  for (const t of traces) byKey.set(t.key, t);

  return {
    board,
    components,
    pads,
    traces,
    vias: standaloneVias,
    silkscreenLines,
    silkscreenShapes,
    silkscreenTexts,
    nets,
    unroutedNets,
    byKey,
    keyByPcbComponentId,
    padByPortId,
    padBySelector,
    selectorByPad,
  };
}

// A single pcbX / pcbY / pcbRotation / layer bake target. Mirrors the shape
// `circuitStore.bakePcbComponentTransform` consumes.
export interface PcbTransformUpdate {
  name: string;
  x?: number;
  y?: number;
  rotation?: number;
  layer?: LayerId;
}

export type PcbTransformPatch = Omit<PcbTransformUpdate, "name">;

// World-space oriented bbox for courtyard / hit-test. Derived from pad
// geometry in world space so we never reverse-engineer tscircuit's dual
// rotation encoding (cardinal pre-baked vs oblique AABB + ccw_rotation).
type PadBoundsInput = Pick<
  PcbPadRecord,
  | "componentKey"
  | "x"
  | "y"
  | "rotationDeg"
  | "shape"
  | "radius"
  | "rectWidth"
  | "rectHeight"
  | "polygonPoints"
>;

export function padWorldCorners(
  pad: PadBoundsInput
): ReadonlyArray<{ x: number; y: number }> {
  if (pad.shape === "circle") {
    const r = pad.radius ?? 0.5;
    return [
      { x: pad.x - r, y: pad.y - r },
      { x: pad.x + r, y: pad.y - r },
      { x: pad.x + r, y: pad.y + r },
      { x: pad.x - r, y: pad.y + r },
    ];
  }
  if (pad.shape === "rect" || pad.shape === "pill") {
    const w = pad.rectWidth ?? 1;
    const h = pad.rectHeight ?? 1;
    const rad = (pad.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const local = [
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ];
    return local.map(({ x, y }) => ({
      x: pad.x + x * cos - y * sin,
      y: pad.y + x * sin + y * cos,
    }));
  }
  if (pad.shape === "polygon" && pad.polygonPoints) {
    return pad.polygonPoints;
  }
  return [{ x: pad.x, y: pad.y }];
}

function orientedBoxFromWorldPoints(
  points: ReadonlyArray<{ x: number; y: number }>,
  centerX: number,
  centerY: number,
  margin = 0.08
): { width: number; height: number; rotationDeg: number } {
  if (points.length === 0) {
    return { width: 1, height: 1, rotationDeg: 0 };
  }
  let bestArea = Infinity;
  let bestW = 1;
  let bestH = 1;
  let bestDeg = 0;
  for (let deg = 0; deg < 180; deg++) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const dx = p.x - centerX;
      const dy = p.y - centerY;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      minX = Math.min(minX, lx);
      maxX = Math.max(maxX, lx);
      minY = Math.min(minY, ly);
      maxY = Math.max(maxY, ly);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      bestW = w;
      bestH = h;
      bestDeg = deg;
    }
  }
  return {
    width: bestW + margin * 2,
    height: bestH + margin * 2,
    rotationDeg: bestDeg,
  };
}

export function pcbComponentBoundsFromPads(
  comp: Pick<PcbComponentRecord, "key" | "x" | "y"> &
    Partial<Pick<PcbComponentRecord, "pcbComponentId">>,
  pads: ReadonlyArray<PadBoundsInput & { pcbComponentId?: string | null }>
): { width: number; height: number; rotationDeg: number } | null {
  const mine = pads.filter(
    (p) =>
      p.componentKey === comp.key ||
      (comp.pcbComponentId != null &&
        p.pcbComponentId != null &&
        p.pcbComponentId === comp.pcbComponentId)
  );
  if (mine.length === 0) return null;
  const corners: Array<{ x: number; y: number }> = [];
  for (const pad of mine) corners.push(...padWorldCorners(pad));
  return orientedBoxFromWorldPoints(corners, comp.x, comp.y);
}

/** @deprecated Use pcbComponentBoundsFromPads — kept as alias for tests. */
export function localFootprintFromPads(
  comp: Pick<PcbComponentRecord, "key" | "x" | "y" | "rotationDeg">,
  pads: ReadonlyArray<
    Pick<PcbPadRecord, "componentKey" | "x" | "y" | "rectWidth" | "rectHeight">
  >
): { width: number; height: number } | null {
  const box = pcbComponentBoundsFromPads(
    comp,
    pads.map((p) => ({
      ...p,
      shape: "rect" as const,
      rotationDeg: comp.rotationDeg,
    }))
  );
  if (!box) return null;
  return { width: box.width, height: box.height };
}

export function pcbComponentDisplayBbox(
  comp: {
    key?: StableKey;
    pcbComponentId?: string;
    x?: number;
    y?: number;
    width: number;
    height: number;
    rotationDeg: number;
    originRotationDeg: number;
  },
  pads?: ReadonlyArray<PadBoundsInput & { pcbComponentId?: string | null }>
): { width: number; height: number; rotationDeg: number } {
  if (comp.x != null && comp.y != null && pads) {
    const fromPads = pcbComponentBoundsFromPads(
      comp as Pick<PcbComponentRecord, "key" | "x" | "y" | "pcbComponentId">,
      pads
    );
    if (fromPads) return fromPads;
  }
  // No pads to measure — use circuit-json body dims at effective rotation.
  return {
    width: comp.width,
    height: comp.height,
    rotationDeg: comp.rotationDeg,
  };
}

// Augment a set of drag/rotate bake updates so that EVERY auto-placed axis
// (an `pcbX` / `pcbY` the tsx doesn't pin) is anchored to its current
// evaluated position.
//
// Why: tscircuit's auto-layout positions any coordinate a component leaves
// unpinned, and it re-packs ALL of them whenever the set of explicitly-placed
// parts changes. So baking only the dragged part's position makes the next
// eval shove every other auto-placed part somewhere new — they appear to "move
// on their own" ~1s after a drag (the debounce + eval delay). Pinning the
// auto-placed coordinates to where they already sit makes the placement
// sticky: after the first move, every axis has an explicit position and the
// evaluator stops rearranging them.
//
// Pinning is PER AXIS because tscircuit honors a lone pcbX (or pcbY) and
// auto-lays-out the other coordinate. A part with only pcbX still has a
// drifting Y, so we must anchor whichever axis the tsx leaves open — checking
// a single "is it placed?" boolean would miss the half-pinned case.
//
// Two cases are handled:
//   1. A dragged/rotated part gets each of its still-auto axes filled in from
//      the model (a rotate-only update carries no x/y, which would otherwise
//      leave its open axes auto-laid-out and still drifting).
//   2. Every other part the user didn't touch gets its still-auto axes pinned
//      at their current position.
// Axes already pinned in the tsx are left alone — the evaluator already honors
// them, so re-baking would be churn.
export function withAutoPlacedPins(
  model: Pick<PcbModel, "components">,
  updates: ReadonlyArray<PcbTransformUpdate>
): PcbTransformUpdate[] {
  const recordByName = new Map<string, PcbComponentRecord>();
  for (const c of model.components) recordByName.set(c.name, c);

  // Pass 1: pass updates through, back-filling each axis the tsx leaves auto
  // (and the update itself doesn't set) so the bake fully anchors the part.
  const result: PcbTransformUpdate[] = updates.map((u) => {
    const rec = recordByName.get(u.name);
    if (!rec) return { ...u };
    const next: PcbTransformUpdate = { ...u };
    if (next.x === undefined && !rec.pcbXInTsx) next.x = rec.x;
    if (next.y === undefined && !rec.pcbYInTsx) next.y = rec.y;
    return next;
  });

  // Pass 2: pin every untouched part's still-auto axes at their current value.
  const touched = new Set(updates.map((u) => u.name));
  for (const c of model.components) {
    if (touched.has(c.name)) continue;
    if (c.pcbXInTsx && c.pcbYInTsx) continue; // fully pinned — nothing to do
    const pin: PcbTransformUpdate = { name: c.name };
    if (!c.pcbXInTsx) pin.x = c.x;
    if (!c.pcbYInTsx) pin.y = c.y;
    result.push(pin);
  }

  return result;
}

function shapeFromString(s: string): PadShape {
  if (s === "circle" || s === "rect" || s === "pill" || s === "polygon")
    return s;
  if (s === "rotated_rect") return "rect";
  if (s === "rotated_pill" || s === "oval") return "pill";
  // Plated-hole "<hole>_hole_with_rect_pad" family — tscircuit uses these to
  // mark pin 1 of through-hole footprints with a square pad around the drill.
  if (s.endsWith("_hole_with_rect_pad")) return "rect";
  return "rect";
}

// Pad SVG rotation from circuit-json (cardinal = 0, oblique = ccw_rotation).
function padBaseRotationDeg(
  shape: string,
  ccwRotation: number | undefined,
  origComponentRotation: number
): number {
  if (
    shape === "rotated_rect" ||
    shape === "rotated_pill" ||
    shape === "rotated_pill_hole_with_rect_pad"
  ) {
    return ccwRotation ?? origComponentRotation;
  }
  // Oval/pill plated holes and rect-pad plated holes carry an explicit
  // rotation even in their non-"rotated" variants (rect_ccw_rotation /
  // ccw_rotation). Cardinal smtpad pills never emit ccw_rotation, so this
  // stays 0 for them.
  if (
    shape === "oval" ||
    shape === "pill" ||
    shape.endsWith("_hole_with_rect_pad")
  ) {
    return ccwRotation ?? 0;
  }
  return 0;
}

// Translate a world-space point by the parent component's drag delta.
function applyPositionDelta(
  px: number,
  py: number,
  xform: {
    origX: number;
    origY: number;
    effX: number;
    effY: number;
  }
): { x: number; y: number } {
  return {
    x: px + (xform.effX - xform.origX),
    y: py + (xform.effY - xform.origY),
  };
}

function buildSegmentsFromCircuitJsonRoute(
  route: ReadonlyArray<unknown>
): { segments: PcbTraceSegment[]; vias: PcbViaRecord[] } {
  const segments: PcbTraceSegment[] = [];
  const vias: PcbViaRecord[] = [];
  let prev: { x: number; y: number; layer: LayerId; width: number } | null =
    null;

  for (const point of route) {
    const p = asRecord(point);
    if (!p) continue;
    const rt = asString(p.route_type);
    const x = asNumber(p.x);
    const y = asNumber(p.y);
    if (x === undefined || y === undefined) continue;

    if (rt === "via") {
      const fromLayer = normalizeLayer(p.from_layer, "top");
      const toLayer = normalizeLayer(p.to_layer, "bottom");
      vias.push({
        x,
        y,
        drillDiameter: asNumber(p.hole_diameter) ?? 0.3,
        outerDiameter: asNumber(p.outer_diameter) ?? 0.6,
        fromLayer,
        toLayer,
        traceKey: null,
      });
      // After a via, subsequent wire points are on the new layer. The
      // route's next wire entry carries its own layer field, so we rely
      // on that rather than trying to predict it here.
      continue;
    }

    // wire
    const width = asNumber(p.width) ?? 0.25;
    const layer = normalizeLayer(p.layer, "top");
    if (prev && prev.layer === layer) {
      segments.push({
        fromX: prev.x,
        fromY: prev.y,
        toX: x,
        toY: y,
        layer,
        width,
      });
    }
    prev = { x, y, layer, width };
  }

  return { segments, vias };
}

function buildSegmentsFromRoutePoints(
  route: ReadonlyArray<PcbRoutePoint>,
  defaultWidth: number,
  traceKey: StableKey
): { segments: PcbTraceSegment[]; vias: PcbViaRecord[] } {
  const segments: PcbTraceSegment[] = [];
  const vias: PcbViaRecord[] = [];

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    if (a.layer === b.layer) {
      segments.push({
        fromX: a.x,
        fromY: a.y,
        toX: b.x,
        toY: b.y,
        layer: a.layer,
        width: a.width ?? defaultWidth,
      });
    } else {
      // Layer change at point `b`. Insert an inline via at `b` and continue.
      // We do NOT add a segment for the A→B span — adjacent layer changes
      // mean the user pressed `/` (or the route crosses layers without an
      // intermediate corner), and the via covers the transition.
      vias.push({
        x: b.x,
        y: b.y,
        drillDiameter: DEFAULT_VIA_DRILL_MM,
        outerDiameter: DEFAULT_VIA_PAD_MM,
        fromLayer: a.layer,
        toLayer: b.layer,
        traceKey,
      });
    }
  }

  return { segments, vias };
}
