// routeAssist — interactive MANUAL-routing helpers for the PCB editor: the
// obstacle-aware smart path preview while drawing with the route tool, plus
// net-lookup utilities for focus highlighting.
//
// Autorouting is NOT here: the board is autorouted by @tscircuit/core's
// capacity-mesh autorouter during eval, and pcbModel displays those routes
// directly (the sidecar only overrides or hides them per connection).
//
// Uses @tscircuit/infgrid-ijump-astar (IJump / MultilayerIjump) for the
// orthogonal preview, and an in-house 8-direction grid A* for 45° / free
// modes. Obstacles are built from the live pcbModel (pads + displayed
// traces). Pads on the net being routed are excluded so the path can
// terminate on them.

import {
  IJumpAutorouter,
  MultilayerIjump,
} from "@tscircuit/infgrid-ijump-astar";
import { canonEndpoint, connectionId } from "@/editor/shared/connectionId";
import type {
  LayerId,
  PcbRoutePoint,
  PcbRoutingMode,
  StableKey,
} from "@/editor/shared/types";
import {
  padWorldCorners,
  type PcbModel,
  type PcbPadRecord,
  type PcbTraceSegment,
  type UnroutedNet,
} from "./pcbModel";
import { copperLayersForCount } from "./layers";

const OBSTACLE_MARGIN = 0.15;
const GRID_STEP = 0.1;
const MAX_ITERATIONS = 8000;
const VIA_COST = 4;
const SQRT2 = Math.SQRT2;

type RouteObstacle = {
  type: "rect";
  layers: string[];
  center: { x: number; y: number };
  width: number;
  height: number;
  connectedTo: string[];
};

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

// ─── Obstacle construction ────────────────────────────────────────────────────

function axisAlignedBounds(
  points: ReadonlyArray<{ x: number; y: number }>,
  margin: number
): { center: { x: number; y: number }; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    return { center: { x: 0, y: 0 }, width: 1 + margin * 2, height: 1 + margin * 2 };
  }
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2,
  };
}

function padObstacle(
  pad: PcbPadRecord,
  copperLayerIds: readonly LayerId[],
  margin: number
): RouteObstacle {
  const { center, width, height } = axisAlignedBounds(
    padWorldCorners(pad),
    margin
  );
  const layers = pad.isThroughHole ? [...copperLayerIds] : [pad.layer];
  return {
    type: "rect",
    layers,
    center,
    width,
    height,
    connectedTo: [],
  };
}

function traceSegmentObstacle(
  seg: PcbTraceSegment,
  traceKey: string,
  margin: number
): RouteObstacle {
  const halfW = seg.width / 2 + margin;
  const { center, width, height } = axisAlignedBounds(
    [
      { x: seg.fromX, y: seg.fromY },
      { x: seg.toX, y: seg.toY },
    ],
    halfW
  );
  return {
    type: "rect",
    layers: [seg.layer],
    center,
    width,
    height,
    connectedTo: [traceKey],
  };
}

function modelBounds(model: PcbModel): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (model.board) {
    minX = model.board.centerX - model.board.width / 2;
    minY = model.board.centerY - model.board.height / 2;
    maxX = model.board.centerX + model.board.width / 2;
    maxY = model.board.centerY + model.board.height / 2;
  }
  for (const p of model.pads) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) {
    return { minX: -25, maxX: 25, minY: -25, maxY: 25 };
  }
  const pad = 2;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

export function buildObstacles(
  model: PcbModel,
  opts: {
    layerCount: number;
    excludeSelectors?: ReadonlySet<string>;
    excludeTraceKey?: StableKey | null;
  }
): RouteObstacle[] {
  const copperLayerIds = copperLayersForCount(opts.layerCount).map((l) => l.id);
  const exclude = opts.excludeSelectors ?? new Set<string>();
  const obstacles: RouteObstacle[] = [];

  for (const pad of model.pads) {
    const sel = model.selectorByPad.get(pad);
    if (sel && exclude.has(canonEndpoint(sel))) continue;
    obstacles.push(padObstacle(pad, copperLayerIds, OBSTACLE_MARGIN));
  }

  for (const trace of model.traces) {
    if (opts.excludeTraceKey && trace.key === opts.excludeTraceKey) continue;
    for (const seg of trace.segments) {
      obstacles.push(traceSegmentObstacle(seg, trace.key, OBSTACLE_MARGIN));
    }
  }

  return obstacles;
}

function pointBlocked(
  x: number,
  y: number,
  layer: LayerId,
  obstacles: ReadonlyArray<RouteObstacle>
): boolean {
  for (const o of obstacles) {
    if (!o.layers.includes(layer)) continue;
    const hw = o.width / 2;
    const hh = o.height / 2;
    if (
      x >= o.center.x - hw &&
      x <= o.center.x + hw &&
      y >= o.center.y - hh &&
      y <= o.center.y + hh
    ) {
      return true;
    }
  }
  return false;
}

// ─── Path simplification ──────────────────────────────────────────────────────

type SegmentDir = "h" | "v" | "d1" | "d2";

function segmentDir(
  from: { x: number; y: number },
  to: { x: number; y: number }
): SegmentDir | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const eps = GRID_STEP / 4;
  if (Math.abs(dx) < eps && Math.abs(dy) < eps) return null;
  if (Math.abs(dy) < eps) return "h";
  if (Math.abs(dx) < eps) return "v";
  if (Math.sign(dx) === Math.sign(dy)) return "d1";
  return "d2";
}

export function simplifyRoute(
  points: PcbRoutePoint[],
  mode: PcbRoutingMode
): PcbRoutePoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const out: PcbRoutePoint[] = [{ ...points[0] }];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const layerChange =
      cur.layer !== prev.layer || cur.layer !== next.layer;
    if (layerChange) {
      out.push({ ...cur });
      continue;
    }
    if (mode === "ortho") {
      const dx1 = cur.x - prev.x;
      const dy1 = cur.y - prev.y;
      const dx2 = next.x - cur.x;
      const dy2 = next.y - cur.y;
      const dir1 = Math.abs(dx1) > Math.abs(dy1) ? "h" : "v";
      const dir2 = Math.abs(dx2) > Math.abs(dy2) ? "h" : "v";
      if (dir1 !== dir2) out.push({ ...cur });
    } else {
      const dir1 = segmentDir(prev, cur);
      const dir2 = segmentDir(cur, next);
      if (dir1 !== dir2) out.push({ ...cur });
    }
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

// ─── Core pathfinder ──────────────────────────────────────────────────────────

function snapRoutePoint(p: { x: number; y: number; layer: string }): PcbRoutePoint {
  return {
    x: Math.round(p.x / GRID_STEP) * GRID_STEP,
    y: Math.round(p.y / GRID_STEP) * GRID_STEP,
    layer: p.layer,
  };
}

function toCell(v: number): number {
  return Math.round(v / GRID_STEP);
}

function fromCell(c: number): number {
  return c * GRID_STEP;
}

interface GridNode {
  ix: number;
  iy: number;
  layer: LayerId;
  g: number;
  f: number;
  parent: GridNode | null;
}

function gridKey(ix: number, iy: number, layer: LayerId): string {
  return `${ix},${iy},${layer}`;
}

function heuristicCell(
  ix: number,
  iy: number,
  layer: LayerId,
  goalIx: number,
  goalIy: number,
  goalLayer: LayerId
): number {
  const spatial =
    Math.hypot(ix - goalIx, iy - goalIy) * GRID_STEP;
  const layerPenalty = layer === goalLayer ? 0 : VIA_COST * GRID_STEP;
  return spatial + layerPenalty;
}

function reconstructGridPath(end: GridNode): PcbRoutePoint[] {
  const rev: PcbRoutePoint[] = [];
  let cur: GridNode | null = end;
  while (cur) {
    rev.push({
      x: fromCell(cur.ix),
      y: fromCell(cur.iy),
      layer: cur.layer,
    });
    cur = cur.parent;
  }
  rev.reverse();
  const out: PcbRoutePoint[] = [];
  for (const p of rev) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y && last.layer === p.layer) {
      continue;
    }
    out.push(p);
  }
  return out;
}

function findRoutePathGrid8(opts: {
  from: RouteEndpoint;
  to: RouteEndpoint;
  obstacles: RouteObstacle[];
  copperLayers: readonly LayerId[];
  bounds: ReturnType<typeof modelBounds>;
}): PcbRoutePoint[] | null {
  const { from, to, obstacles, copperLayers, bounds } = opts;
  const startIx = toCell(from.x);
  const startIy = toCell(from.y);
  const goalIx = toCell(to.x);
  const goalIy = toCell(to.y);
  const minIx = toCell(bounds.minX);
  const maxIx = toCell(bounds.maxX);
  const minIy = toCell(bounds.minY);
  const maxIy = toCell(bounds.maxY);

  const start: GridNode = {
    ix: startIx,
    iy: startIy,
    layer: from.layer,
    g: 0,
    f: heuristicCell(
      startIx,
      startIy,
      from.layer,
      goalIx,
      goalIy,
      to.layer
    ),
    parent: null,
  };

  const open = new Map<string, GridNode>();
  open.set(gridKey(start.ix, start.iy, start.layer), start);
  const closed = new Set<string>();

  const neighbors = [
    { dix: 1, diy: 0, cost: 1 },
    { dix: -1, diy: 0, cost: 1 },
    { dix: 0, diy: 1, cost: 1 },
    { dix: 0, diy: -1, cost: 1 },
    { dix: 1, diy: 1, cost: SQRT2 },
    { dix: 1, diy: -1, cost: SQRT2 },
    { dix: -1, diy: 1, cost: SQRT2 },
    { dix: -1, diy: -1, cost: SQRT2 },
  ];

  let iterations = 0;
  while (open.size > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    let current: GridNode | null = null;
    let bestF = Infinity;
    for (const node of open.values()) {
      if (node.f < bestF) {
        bestF = node.f;
        current = node;
      }
    }
    if (!current) break;

    const cur = current;
    const curKey = gridKey(cur.ix, cur.iy, cur.layer);
    open.delete(curKey);
    closed.add(curKey);

    if (
      cur.ix === goalIx &&
      cur.iy === goalIy &&
      cur.layer === to.layer
    ) {
      return reconstructGridPath(cur);
    }

    const tryMove = (nix: number, niy: number, nLayer: LayerId, stepCost: number) => {
      if (nix < minIx || nix > maxIx || niy < minIy || niy > maxIy) return;
      const nx = fromCell(nix);
      const ny = fromCell(niy);
      if (pointBlocked(nx, ny, nLayer, obstacles)) return;
      const nk = gridKey(nix, niy, nLayer);
      if (closed.has(nk)) return;
      const g = cur.g + stepCost * GRID_STEP;
      const existing = open.get(nk);
      if (existing && existing.g <= g) return;
      const node: GridNode = {
        ix: nix,
        iy: niy,
        layer: nLayer,
        g,
        f: g + heuristicCell(nix, niy, nLayer, goalIx, goalIy, to.layer),
        parent: current,
      };
      open.set(nk, node);
    };

    for (const n of neighbors) {
      tryMove(current.ix + n.dix, current.iy + n.diy, current.layer, n.cost);
    }

    for (const layer of copperLayers) {
      if (layer === current.layer) continue;
      tryMove(current.ix, current.iy, layer, VIA_COST);
    }
  }

  return null;
}

function findRoutePathOrtho(opts: {
  model: PcbModel;
  from: RouteEndpoint;
  to: RouteEndpoint;
  traceWidth: number;
  layerCount: number;
  obstacles: RouteObstacle[];
}): PcbRoutePoint[] | null {
  const { model, from, to, traceWidth, layerCount, obstacles } = opts;
  const bounds = modelBounds(model);
  const needsMultilayer = layerCount > 2 || from.layer !== to.layer;

  const connection = {
    name: "route",
    pointsToConnect: [
      { x: from.x, y: from.y, layer: from.layer },
      { x: to.x, y: to.y, layer: to.layer },
    ],
  };

  const input = {
    layerCount,
    minTraceWidth: traceWidth,
    obstacles,
    connections: [connection],
    bounds,
  };

  let result;
  if (needsMultilayer) {
    const router = new MultilayerIjump({
      input,
      GRID_STEP,
      OBSTACLE_MARGIN,
      MAX_ITERATIONS,
    });
    result = router.solve()[0];
  } else {
    const router = new IJumpAutorouter({
      input,
      GRID_STEP,
      OBSTACLE_MARGIN,
      MAX_ITERATIONS,
    });
    result = router.solve()[0];
  }

  if (!result?.solved || !result.route || result.route.length < 2) return null;
  return simplifyRoute(result.route.map(snapRoutePoint), "ortho");
}

export function findRoutePath(opts: {
  model: PcbModel;
  from: RouteEndpoint;
  to: RouteEndpoint;
  traceWidth: number;
  layerCount: number;
  excludeSelectors?: ReadonlySet<string>;
  excludeTraceKey?: StableKey | null;
  routingMode?: PcbRoutingMode;
}): PcbRoutePoint[] | null {
  const { model, from, to, traceWidth, layerCount } = opts;
  const mode = opts.routingMode ?? "ortho";
  const exclude = new Set(opts.excludeSelectors ?? []);
  exclude.add(canonEndpoint(from.selector));
  exclude.add(canonEndpoint(to.selector));

  const obstacles = buildObstacles(model, {
    layerCount,
    excludeSelectors: exclude,
    excludeTraceKey: opts.excludeTraceKey,
  });

  if (mode === "ortho") {
    return findRoutePathOrtho({
      model,
      from,
      to,
      traceWidth,
      layerCount,
      obstacles,
    });
  }

  const copperLayers = copperLayersForCount(layerCount).map((l) => l.id);
  const raw = findRoutePathGrid8({
    from,
    to,
    obstacles,
    copperLayers,
    bounds: modelBounds(model),
  });
  if (!raw) return null;
  return simplifyRoute(raw, mode);
}

// Preview segment from last committed point to cursor (same active layer).
export function previewRoutePath(opts: {
  model: PcbModel;
  from: PcbRoutePoint;
  to: { x: number; y: number; layer: LayerId };
  fromSelector: string;
  traceWidth: number;
  layerCount: number;
  netSelectors?: ReadonlySet<string>;
  routingMode?: PcbRoutingMode;
}): PcbRoutePoint[] | null {
  if (fromSamePoint(opts.from, opts.to)) return null;
  const exclude = new Set(opts.netSelectors ?? []);
  exclude.add(canonEndpoint(opts.fromSelector));

  const path = findRoutePath({
    model: opts.model,
    from: {
      selector: opts.fromSelector,
      x: opts.from.x,
      y: opts.from.y,
      layer: opts.from.layer,
    },
    to: {
      selector: "__cursor__",
      x: opts.to.x,
      y: opts.to.y,
      layer: opts.to.layer,
    },
    traceWidth: opts.traceWidth,
    layerCount: opts.layerCount,
    excludeSelectors: exclude,
    routingMode: opts.routingMode,
  });
  if (!path || path.length < 2) return null;
  return path.slice(1);
}

function fromSamePoint(
  a: { x: number; y: number },
  b: { x: number; y: number }
): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < GRID_STEP / 2;
}
