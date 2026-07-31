// routeAssist — net lookups for the PCB editor's manual routing.
//
// This file used to also own the smart path preview. It doesn't any more: the
// preview is now a two-tier pipeline across routeLeader (the O(1) rubber band),
// routeGraph (inflated obstacles + a uniform-grid index), routeSolver (a
// visibility-graph A* under a millisecond deadline) and routeOverlayDraw. The
// 0.1 mm grid A* and the IJump autorouter that used to live here are gone.
//
// `@tscircuit/infgrid-ijump-astar` stays in package.json even though nothing in
// src/ imports it: @tscircuit/core imports it at module scope and declares it a
// PEER, and the root `legacy-peer-deps=true` means npm will not install peers on
// its own. Dropping it does not tidy the tree — it breaks the evaluator.
//
// Autorouting is NOT here either: the board is autorouted by @tscircuit/core's
// capacity-mesh autorouter during eval, and pcbModel displays those routes
// directly (the sidecar only overrides or hides them per connection).

import { canonEndpoint, connectionId } from "@/editor/shared/connectionId";
import type { LayerId, StableKey } from "@/editor/shared/types";
import type { PcbModel, PcbPadRecord, UnroutedNet } from "./pcbModel";

export interface RouteEndpoint {
  selector: string;
  x: number;
  y: number;
  layer: LayerId;
}

// ─── Net lookup ───────────────────────────────────────────────────────────────

export function findNetContainingSelector(
  model: PcbModel,
  selector: string
): UnroutedNet | null {
  const target = canonEndpoint(selector);
  // Search every net (incl. fully-routed) so a pad already wired up still
  // resolves to its net — needed to focus a net by clicking one of its traces.
  for (const net of model.nets) {
    for (const pad of net.pads) {
      if (canonEndpoint(pad.selector) === target) return net;
    }
  }
  return null;
}

export function selectorsOnNet(net: UnroutedNet): ReadonlySet<string> {
  return new Set(net.pads.map((p) => canonEndpoint(p.selector)));
}

export function isPadOnNet(
  pad: PcbPadRecord,
  model: PcbModel,
  netSelectors: ReadonlySet<string>
): boolean {
  const sel = model.selectorByPad.get(pad);
  return sel ? netSelectors.has(canonEndpoint(sel)) : false;
}

export function isTraceOnNet(
  traceKey: StableKey,
  netSelectors: ReadonlySet<string>
): boolean {
  for (const a of netSelectors) {
    for (const b of netSelectors) {
      if (a === b) continue;
      if (connectionId(a, b) === traceKey) return true;
    }
  }
  return false;
}

export function findUserRouteAtPad(
  model: PcbModel,
  selector: string
): { traceKey: StableKey; fromEnd: "start" | "end" } | null {
  const target = canonEndpoint(selector);
  for (const trace of model.traces) {
    if (!trace.userRouted) continue;
    if (canonEndpoint(trace.fromSelector) === target) {
      return { traceKey: trace.key, fromEnd: "start" };
    }
    if (canonEndpoint(trace.toSelector) === target) {
      return { traceKey: trace.key, fromEnd: "end" };
    }
  }
  return null;
}
