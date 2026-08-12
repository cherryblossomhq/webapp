// ratsnest — compute the airwire / "ratsnest" line set for an unrouted PCB.
//
// For each unrouted net (every pad sharing a net — whether wired pin↔pin or
// pin→net for power/ground; see pcbModel Phase 8), draw the minimum spanning
// tree (MST) over its pad positions, treating pads already joined by committed
// copper as pre-connected. The MST gives the user the shortest set of
// connections still to route — exactly what Altium / KiCad show as flashing
// guides.
//
// Algorithm: Kruskal's MST with a union-find. Edge weight is straight-line
// distance. O(E log E) where E = N(N-1)/2 over N pads per net — quadratic in
// pad count. Signal nets are tiny, but power/ground nets (now ratsnested too,
// issue #24) can carry dozens of pads, so a large net is the costly case, not
// a constant-time one.

import type { PcbModel, UnroutedNet } from "./pcbModel";

export interface RatsnestEdge {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  // Pad selectors at each end — used for net focus / autoroute restore.
  fromSelector: string;
  toSelector: string;
  // The source_trace this airwire belongs to — used for selection /
  // highlighting later (PR 2).
  traceKey: string | null;
}

export function computeRatsnest(model: PcbModel): RatsnestEdge[] {
  const all: RatsnestEdge[] = [];
  for (const net of model.unroutedNets) {
    all.push(...computeNetMst(net));
  }
  return all;
}

// Exported for unit testing — Kruskal MST over a single net's pad list.
export function computeNetMst(net: UnroutedNet): RatsnestEdge[] {
  const pads = net.pads;
  if (pads.length < 2) return [];

  // Build candidate edges with squared distance (we only need ordering,
  // not actual lengths). Skip pairs at identical positions — those would
  // produce zero-length airwires that just clutter.
  type Edge = { i: number; j: number; d2: number };
  const edges: Edge[] = [];
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const dx = pads[j].x - pads[i].x;
      const dy = pads[j].y - pads[i].y;
      const d2 = dx * dx + dy * dy;
      if (d2 === 0) continue;
      edges.push({ i, j, d2 });
    }
  }
  edges.sort((a, b) => a.d2 - b.d2);

  // Union-find.
  const parent = new Array<number>(pads.length);
  for (let i = 0; i < pads.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[ra] = rb;
    return true;
  };

  // Pre-union pads already joined by committed copper (same cluster id). They
  // count as connected, so the MST won't draw an airwire over routed segments —
  // it only spans what's still unrouted. Pads with no cluster id stay singletons.
  const firstInCluster = new Map<number, number>();
  for (let i = 0; i < pads.length; i++) {
    const c = pads[i].cluster;
    if (c === undefined) continue;
    const seed = firstInCluster.get(c);
    if (seed === undefined) firstInCluster.set(c, i);
    else union(seed, i);
  }

  const out: RatsnestEdge[] = [];
  for (const e of edges) {
    if (union(e.i, e.j)) {
      out.push({
        fromX: pads[e.i].x,
        fromY: pads[e.i].y,
        toX: pads[e.j].x,
        toY: pads[e.j].y,
        fromSelector: pads[e.i].selector,
        toSelector: pads[e.j].selector,
        traceKey: net.traceKey,
      });
      if (out.length === pads.length - 1) break;
    }
  }
  return out;
}
