// overlayManualRoutes — produce the single "what-you-see-is-what-you-get"
// circuit-json shared by every consumer that isn't the live PCB canvas: the 3D
// viewer, the DRC runner, and fabrication exporters (Gerber, drill, PnP). The
// result contains exactly the copper the PCB canvas shows — the autorouter's
// routes by default, minus what the user deleted, with manual routes spliced
// over — so 3D / DRC / fab match the PCB editor pixel-for-pixel.
//
// What it does
// ------------
// 1. Drops the autorouter `pcb_trace`s (and their linked `pcb_via`s) that the
//    sidecar replaces (a manual route at the same connection key) or hides
//    (`pcb.noAutoroute`, set when the user deletes a route). Everything else
//    the autorouter produced is kept — same rule pcbModel Phase 5 renders by,
//    via the shared evalTraceEndpoints keying.
// 2. Synthesizes a `pcb_trace` (+ linked `pcb_via` per layer change) from every
//    sidecar route. Routes live ONLY in the sidecar (no `<trace>` in the tsx —
//    connectivity is `connections`), keyed by the connection id of their
//    endpoints (PcbCanvas.commitRoute). We recompute that id from each
//    source_trace's pads to reattach `source_trace_id` + the autorouter's
//    endpoint `*_pcb_port_id`s + `subcircuit_id` (captured before dropping) so
//    DRC sees the route as a real, connected, net-scoped trace. A route with no
//    matching source_trace is still emitted and rendered from its geometry.
//
// Why a post-eval splice and not tscircuit `pcbPath` injection
// ------------------------------------------------------------
// tscircuit's `<trace pcbPath={...}/>` *can* express a fixed route, but its
// point coordinates are resolved relative to the anchor (`from`) component's
// pre-layout transform — they are NOT global board coordinates. Converting our
// global sidecar points into that frame is impossible for auto-placed parts
// (their position isn't known until after layout, which is what we'd be
// feeding). circuit-json `pcb_trace.route`, by contrast, is already global, so
// building it needs zero coordinate conversion and works for every component.

import type { AnyCircuitElement } from "circuit-json";

import {
  DEFAULT_TRACE_WIDTH_MM,
  DEFAULT_VIA_DRILL_MM,
  DEFAULT_VIA_PAD_MM,
} from "./layers";
import {
  endpointSelectors,
  evalTraceEndpoints,
  padSelectorFor,
  resolveSourceGraph,
} from "./pcbModel";
import { connectionId } from "../shared/connectionId";
import type {
  LayerId,
  ManualEditsMap,
  PcbRoutePoint,
  StableKey,
} from "../shared/types";

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | null {
  return v && typeof v === "object" ? (v as Rec) : null;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function isFinitePoint(p: PcbRoutePoint): boolean {
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    typeof p.layer === "string" &&
    p.layer.length > 0
  );
}

/**
 * Build the WYSIWYG circuit-json shared by the 3D viewer, DRC, and fab
 * export: the autorouter's pcb_trace/pcb_via kept by default, minus the
 * connections the sidecar overrides (manual route) or hides (noAutoroute),
 * plus one pcb_trace (+ vias) synthesized per sidecar route — so the output
 * matches the PCB canvas exactly. The input array is never mutated. A route
 * with a non-finite coord is skipped (never shipped); a route that pairs to
 * no source_trace is still emitted and rendered from its geometry, just
 * without net/port linkage.
 */
export function overlayManualRoutes(
  circuitJson: ReadonlyArray<AnyCircuitElement> | null | undefined,
  manualEdits: ManualEditsMap,
): AnyCircuitElement[] {
  if (!circuitJson || circuitJson.length === 0) {
    return circuitJson ? [...circuitJson] : [];
  }

  // Valid sidecar routes (≥2 finite points). The file loader sanitizes coords,
  // but in-session routes go straight into manualEdits — guard here so a
  // NaN/Infinity coord can't reach circuit-json and crash the exporter or DRC.
  const routedKeys = (Object.keys(manualEdits) as StableKey[]).filter((k) => {
    const route = manualEdits[k]?.pcb?.route;
    return !!route && route.length >= 2 && route.every(isFinitePoint);
  });

  // Autorouter traces the sidecar replaces (manual route at the same
  // connection key) or hides (noAutoroute). evalTraceEndpoints keys eval
  // traces exactly like pcbModel does, so the drop set can't drift from what
  // the canvas hides.
  const manualKeySet = new Set<StableKey>(routedKeys);
  const droppedTraceIds = new Set<string>();
  for (const [pcbTraceId, ends] of evalTraceEndpoints(circuitJson)) {
    if (
      manualKeySet.has(ends.key) ||
      manualEdits[ends.key]?.pcb?.noAutoroute
    ) {
      droppedTraceIds.add(pcbTraceId);
    }
  }

  if (routedKeys.length === 0) {
    return dropHiddenRoutes(circuitJson, droppedTraceIds);
  }

  // Capture, per source_trace, the autorouter's endpoint port ids + subcircuit
  // BEFORE dropping. A synthesized manual route reattaches these so DRC sees
  // its endpoints land on the pads (connectivity) and scopes it to the right
  // subcircuit. First pcb_trace per source_trace wins.
  const metaBySourceTraceId = new Map<
    string,
    { startPortId?: string; endPortId?: string; subcircuitId?: string }
  >();
  for (const el of circuitJson) {
    const r = asRecord(el);
    if (!r || asString(r.type) !== "pcb_trace") continue;
    const sourceTraceId = asString(r.source_trace_id);
    if (!sourceTraceId || metaBySourceTraceId.has(sourceTraceId)) continue;
    const { startPortId, endPortId } = endpointPortIds(r.route);
    metaBySourceTraceId.set(sourceTraceId, {
      startPortId,
      endPortId,
      subcircuitId: asString(r.subcircuit_id),
    });
  }

  // Map each source_trace's endpoint-pair connection id → its id, so a sidecar
  // route (keyed by that same id, see PcbCanvas.commitRoute) attaches to the
  // right net. endpointSelectors pairs on the first/last port (same as
  // pcbModel), so two traces sharing an endpoint pair are indistinguishable —
  // acceptable because the canvas has the identical limitation, so they agree.
  const { sourcePortInfo, sourceTraces } = resolveSourceGraph(circuitJson);
  const sourceTraceIdByConnId = new Map<string, string>();
  for (const st of sourceTraces) {
    const ports = st.portIds
      .map((pid) => sourcePortInfo.get(pid))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const sels = endpointSelectors(ports);
    if (!sels) continue;
    const connId = connectionId(sels.fromSel, sels.toSel);
    if (!sourceTraceIdByConnId.has(connId)) {
      sourceTraceIdByConnId.set(connId, st.id);
    }
  }

  // pcb_port_id → physical pad position, so a synthesized route's endpoints can
  // be oriented by geometry (issue #28): the route is stored in the user's draw
  // order under an order-independent connection id, but the captured start/end
  // port ids follow the SOURCE trace's order. Pairing them positionally would
  // label points[0] (at pad B) with pad A's id when the two orders disagree.
  const portPosById = buildPortPositionMap(circuitJson);

  // Drop the overridden/hidden autoroutes, then synthesize one pcb_trace
  // (+ vias) per sidecar route.
  const result = dropHiddenRoutes(circuitJson, droppedTraceIds);
  let counter = 0;
  for (const key of routedKeys) {
    const pcb = manualEdits[key]?.pcb;
    if (!pcb?.route) continue;
    const width = pcb.width ?? DEFAULT_TRACE_WIDTH_MM;
    const sourceTraceId = sourceTraceIdByConnId.get(key);
    const meta = sourceTraceId
      ? metaBySourceTraceId.get(sourceTraceId)
      : undefined;
    const pcbTraceId = `pcb_trace_manual_${sourceTraceId ?? key}_${counter++}`;
    // Assign start/end port ids to whichever pad each route endpoint actually
    // lands on, not by array position — so a reversed-direction draw labels the
    // endpoints correctly for DRC connectivity.
    const oriented = orientPortIds(
      pcb.route,
      meta?.startPortId,
      meta?.endPortId,
      portPosById,
    );
    const { route, vias } = routePointsToCircuitJson(pcb.route, width, oriented);
    const trace: Rec = { type: "pcb_trace", pcb_trace_id: pcbTraceId, route };
    if (sourceTraceId) trace.source_trace_id = sourceTraceId;
    if (meta?.subcircuitId) trace.subcircuit_id = meta.subcircuitId;
    result.push(trace as unknown as AnyCircuitElement);
    for (const via of vias) {
      result.push(makePcbVia(via, pcbTraceId, meta?.subcircuitId, counter++));
    }
  }

  // Collapse duplicate vias WITHIN a single trace defensively (a degenerate
  // route that flips layers twice at the same point). Vias from DIFFERENT
  // traces at the same (x,y) are distinct holes on distinct nets and are kept —
  // collapsing them would short the nets or drop a real hole. See
  // dedupeCoincidentVias.
  return dedupeCoincidentVias(result);
}

// Remove the autorouter pcb_traces in the drop set, and their standalone
// pcb_via elements (linked by pcb_trace_id) — a hidden trace's vias would
// otherwise remain as floating holes on the board (issue #23).
function dropHiddenRoutes(
  circuitJson: ReadonlyArray<AnyCircuitElement>,
  droppedTraceIds: ReadonlySet<string>,
): AnyCircuitElement[] {
  if (droppedTraceIds.size === 0) return [...circuitJson];
  return circuitJson.filter((el) => {
    const r = asRecord(el);
    if (!r) return true;
    const t = asString(r.type);
    if (t !== "pcb_trace" && t !== "pcb_via") return true;
    return !droppedTraceIds.has(asString(r.pcb_trace_id) ?? "");
  });
}

function dedupeCoincidentVias(
  elements: AnyCircuitElement[]
): AnyCircuitElement[] {
  const posKey = (r: Rec): string => {
    // Sort the layer pair so top→bottom and bottom→top collapse together.
    const layers = [asString(r.from_layer) ?? "", asString(r.to_layer) ?? ""]
      .sort()
      .join("~");
    return `${r.x}|${r.y}|${layers}`;
  };

  // Positions covered by a trace-owned via. An OWNERLESS via (a tsx-baked
  // <via> with no pcb_trace_id) that lands exactly here is the same physical
  // hole — e.g. a baked crossover the sidecar route also produces — and is
  // dropped in the pass below.
  const ownedPositions = new Set<string>();
  for (const el of elements) {
    const r = asRecord(el);
    if (r && asString(r.type) === "pcb_via" && asString(r.pcb_trace_id)) {
      ownedPositions.add(posKey(r));
    }
  }

  const seen = new Set<string>();
  const out: AnyCircuitElement[] = [];
  for (const el of elements) {
    const r = asRecord(el);
    if (r && asString(r.type) === "pcb_via") {
      // Scope the key to the owning pcb_trace. Two DIFFERENT traces (i.e.
      // different nets) that happen to change layer at the same (x,y) are two
      // distinct physical holes; collapsing them across nets would short the
      // nets or drop a real hole. Only true duplicates within one trace merge,
      // plus ownerless vias absorbed by a coincident owned one.
      const traceId = asString(r.pcb_trace_id) ?? "";
      if (!traceId && ownedPositions.has(posKey(r))) continue;
      const key = `${traceId}|${posKey(r)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(el);
  }
  return out;
}

interface BuiltVia {
  x: number;
  y: number;
  fromLayer: LayerId;
  toLayer: LayerId;
}

// Convert the sidecar's [{x,y,layer}] points into a circuit-json route. This
// mirrors pcbModel's `buildSegmentsFromRoutePoints` so the exported geometry is
// identical to what the canvas draws: adjacent points on the same layer form a
// wire run; a layer change emits a via at that point (no extra segment), and
// subsequent points continue on the new layer. The pad-anchored first/last
// points inherit the autorouter's endpoint port ids (captured before the strip)
// so DRC sees the route connect its pads.
function routePointsToCircuitJson(
  points: PcbRoutePoint[],
  width: number,
  { startPortId, endPortId }: { startPortId?: string; endPortId?: string },
): { route: Rec[]; vias: BuiltVia[] } {
  const route: Rec[] = [];
  const vias: BuiltVia[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const segWidth = p.width ?? width;
    if (i === 0) {
      const first: Rec = {
        route_type: "wire",
        x: p.x,
        y: p.y,
        width: segWidth,
        layer: p.layer,
      };
      if (startPortId) first.start_pcb_port_id = startPortId;
      route.push(first);
      continue;
    }
    const prev = points[i - 1];
    if (p.layer === prev.layer) {
      route.push({
        route_type: "wire",
        x: p.x,
        y: p.y,
        width: segWidth,
        layer: p.layer,
      });
      continue;
    }
    const prevWidth = prev.width ?? width;
    if (prev.x !== p.x || prev.y !== p.y) {
      route.push({
        route_type: "wire",
        x: p.x,
        y: p.y,
        width: prevWidth,
        layer: prev.layer,
      });
    }
    route.push({
      route_type: "via",
      x: p.x,
      y: p.y,
      from_layer: prev.layer,
      to_layer: p.layer,
    });
    route.push({
      route_type: "wire",
      x: p.x,
      y: p.y,
      width: segWidth,
      layer: p.layer,
    });
    vias.push({ x: p.x, y: p.y, fromLayer: prev.layer, toLayer: p.layer });
  }

  if (endPortId) {
    for (let i = route.length - 1; i >= 0; i--) {
      if (route[i].route_type === "wire") {
        route[i].end_pcb_port_id = endPortId;
        break;
      }
    }
  }

  return { route, vias };
}

// Map every pcb_port_id to its physical landing position. Pads
// (pcb_smtpad / pcb_plated_hole) carry the authoritative pad coords keyed by
// pcb_port_id; pcb_port elements are a fallback when their own x/y is present
// but no pad references the port. Pads always win (set last / unconditionally).
function buildPortPositionMap(
  circuitJson: ReadonlyArray<AnyCircuitElement>,
): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  for (const el of circuitJson) {
    const r = asRecord(el);
    if (!r) continue;
    const portId = asString(r.pcb_port_id);
    if (!portId) continue;
    const t = asString(r.type);
    const x = asNumber(r.x);
    const y = asNumber(r.y);
    if (x === undefined || y === undefined) continue;
    if (t === "pcb_smtpad" || t === "pcb_plated_hole") {
      map.set(portId, { x, y });
    } else if (t === "pcb_port" && !map.has(portId)) {
      map.set(portId, { x, y });
    }
  }
  return map;
}

// Orient the captured start/end port ids to the route's geometry. The route's
// first/last points are pad-anchored; assign each port id to the endpoint that
// physically lands on its pad. When the user's draw direction disagrees with
// the source trace's port order, this swaps them so points[0] is labeled with
// the pad it actually touches (issue #28). Falls back to the positional order
// when either id or either pad position is unavailable (nothing to compare).
function orientPortIds(
  route: ReadonlyArray<PcbRoutePoint>,
  startPortId: string | undefined,
  endPortId: string | undefined,
  portPosById: Map<string, { x: number; y: number }>,
): { startPortId?: string; endPortId?: string } {
  if (!startPortId || !endPortId || route.length < 2) {
    return { startPortId, endPortId };
  }
  const startPos = portPosById.get(startPortId);
  const endPos = portPosById.get(endPortId);
  if (!startPos || !endPos) return { startPortId, endPortId };

  const first = route[0];
  const last = route[route.length - 1];
  // Total squared distance keeping the order (first↔start, last↔end) vs.
  // swapping it. Pick whichever pairing seats each route endpoint on its
  // nearer pad. Squared distance suffices — we only compare, never measure.
  const keep = dist2(first, startPos) + dist2(last, endPos);
  const swap = dist2(first, endPos) + dist2(last, startPos);
  return swap < keep
    ? { startPortId: endPortId, endPortId: startPortId }
    : { startPortId, endPortId };
}

function dist2(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function endpointPortIds(originalRoute: unknown): {
  startPortId?: string;
  endPortId?: string;
} {
  if (!Array.isArray(originalRoute)) return {};
  let startPortId: string | undefined;
  let endPortId: string | undefined;
  for (const item of originalRoute) {
    const r = asRecord(item);
    if (!r) continue;
    const start = asString(r.start_pcb_port_id);
    if (start && !startPortId) startPortId = start;
    const end = asString(r.end_pcb_port_id);
    if (end) endPortId = end; // keep the last one we see
  }
  return { startPortId, endPortId };
}

function makePcbVia(
  via: BuiltVia,
  pcbTraceId: string,
  subcircuitId: string | undefined,
  index: number,
): AnyCircuitElement {
  const el: Rec = {
    type: "pcb_via",
    pcb_via_id: `pcb_via_manual_${pcbTraceId || "trace"}_${index}`,
    pcb_trace_id: pcbTraceId,
    x: via.x,
    y: via.y,
    hole_diameter: DEFAULT_VIA_DRILL_MM,
    outer_diameter: DEFAULT_VIA_PAD_MM,
    layers: [via.fromLayer, via.toLayer],
    from_layer: via.fromLayer,
    to_layer: via.toLayer,
  };
  if (subcircuitId) el.subcircuit_id = subcircuitId;
  return el as unknown as AnyCircuitElement;
}

/**
 * Set of connection ids for every pair of pads that share a net in the
 * evaluated circuit-json. A manual PCB route is keyed by `connectionId(padA,
 * padB)` over the pads' eval'd port-hint selectors (`.<comp> > .pin<N>`, see
 * PcbCanvas.commitRoute / pcbModel.selectorByPad); it is "live" iff padA and
 * padB are still co-netted here. ProjectStore.pruneOrphanEdits uses this to
 * drop orphaned copper whose net/components were deleted while preserving every
 * route on a surviving net — including a route between two pads of a power net,
 * whose key is no plain `connections` entry.
 *
 * Built in the SAME selector space as the route key (padSelectorFor over the
 * port's first hint), so named-pin parts (`anode`, `SDA`, `left`) match too —
 * the tsx `connections` label is never consulted. Returns null when there's no
 * circuit-json (no eval yet): the caller then can't prove a route is orphaned
 * and keeps every route rather than risk deleting drawn copper.
 */
export function liveRouteConnIds(
  circuitJson: ReadonlyArray<AnyCircuitElement> | null | undefined,
): Set<StableKey> | null {
  if (!circuitJson || circuitJson.length === 0) return null;

  const { sourcePortInfo, sourceTraces, sourceNetIdByTrace } =
    resolveSourceGraph(circuitJson);

  // Union-find over source_port ids, bridged by shared net nodes, so two pads
  // on the same net (each wired pad→net, never pad→pad) land in one group.
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

  for (const tr of sourceTraces) {
    const nodes = [...tr.portIds];
    const netId = sourceNetIdByTrace.get(tr.id);
    if (netId) nodes.push(`net:${netId}`);
    if (nodes.length === 0) continue;
    find(nodes[0]); // register single-node traces too
    for (let i = 1; i < nodes.length; i++) union(nodes[0], nodes[i]);
  }

  // Group pad selectors (skip net nodes — a route never terminates on one).
  const selectorsByRoot = new Map<string, string[]>();
  for (const node of parent.keys()) {
    if (node.startsWith("net:")) continue;
    const info = sourcePortInfo.get(node);
    if (!info) continue;
    const sel = padSelectorFor(info.componentName, info.hint);
    const root = find(node);
    const arr = selectorsByRoot.get(root);
    if (arr) arr.push(sel);
    else selectorsByRoot.set(root, [sel]);
  }

  const out = new Set<StableKey>();
  for (const sels of selectorsByRoot.values()) {
    for (let i = 0; i < sels.length; i++) {
      for (let j = i + 1; j < sels.length; j++) {
        out.add(connectionId(sels[i], sels[j]));
      }
    }
  }
  return out;
}
