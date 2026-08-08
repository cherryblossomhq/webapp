// routeSolver — tier 2 of the preview: the walkaround that hugs copper.
//
// A* over a VISIBILITY GRAPH whose nodes are the corners of inflated obstacle
// octagons, not cells of a fine grid. That distinction is the whole point: a
// grid A* emits a staircase whose steps are the grid pitch, while a visibility
// graph emits the two-segment leader between corners — the same geometry a
// human draws, and the same geometry the interactive leader draws.
//
// This tier may only ever UPGRADE the picture. It is given a hard millisecond
// deadline, it can time out, and a timeout changes nothing on screen (see
// `offerSolution`). Four mechanisms keep a 1 px mouse move from returning a
// different-but-equally-valid path, which is what "flicker" actually was:
//
//   1. Endpoints are grid-quantised before the solve, so sub-grid jitter cannot
//      change the input at all.
//   2. Node indices derive from the canonical obstacle rank (routeGraph), so
//      identical input yields identical numbering.
//   3. The heap comparator is total — (f, h, nodeIndex) — never insertion or
//      hash order, so two runs on identical input are byte-identical.
//   4. Topology hysteresis: a DIFFERENT route has to be measurably cheaper to
//      displace the incumbent.
//
// The solve is deliberately SINGLE-LAYER. The old grid A* hopped layers
// invisibly and the overlay then dropped those points, tearing a hole in the
// preview; layer changes now happen only through an explicit `V` / `1..N`.
//
// Push-and-shove is explicitly OUT OF SCOPE. `conflictMode` in the draft is the
// enum where a third member would go.

import type { Point } from "@/editor/shared/snap";
import type { PcbRoutingMode, RoutePosture } from "@/editor/shared/types";
import { log } from "@/utils/logger";
import { GRID_FINE_MM } from "./pcbColors";
import {
  LEADER_DIRECT,
  LEADER_NONE,
  leaderShape,
} from "./routeLeader";
import {
  CORRIDOR_PAD_MM,
  MAX_NODES,
  octagonVertices,
  pointInsideHard,
  segmentHitsHard,
  segmentLeavesKeepIn,
  softPenetrationMm,
  type RouteObstacleSet,
} from "./routeGraph";

export const SOLVE_BUDGET_MS = 4;
export const DEADLINE_CHECK_EVERY = 64;
export const SOLVE_MIN_DELTA_MM = 0.15;
export const STALE_RADIUS_MM = 8;
export const SOLVE_HYSTERESIS = 0.03;
export const BLOCKED_STREAK_TO_RENDER = 2;
export const VERTEX_COST_MM = 0.15;
export const ACUTE_CORNER_COST_MM = 1.0;
export const COURTYARD_COST_PER_MM = 3.0;

const SQRT2_MINUS_1 = Math.SQRT2 - 1;
const ANGLE_TOL = 1e-9;
const MAX_HEAP = 1 << 16;

export type WalkaroundStatus = "ok" | "blocked" | "timeout";

export interface WalkaroundResult {
  status: WalkaroundStatus;
  /** Full polyline including the anchor at [0]; empty unless "ok". */
  path: Point[];
  /** Index in `path` of the last obstacle-derived vertex, -1 when direct. */
  hugEndIndex: number;
  cost: number;
  /** Ordered graph node indices — the stability identity. */
  topology: number[];
}

export interface SolveOpts {
  set: RouteObstacleSet;
  from: Point;
  to: Point;
  mode: PcbRoutingMode;
  /** Absolute `performance.now()` value the search must not run past. */
  deadlineMs: number;
  now?: () => number;
}

const TIMEOUT: WalkaroundResult = {
  status: "timeout",
  path: [],
  hugEndIndex: -1,
  cost: 0,
  topology: [],
};

const BLOCKED: WalkaroundResult = {
  status: "blocked",
  path: [],
  hugEndIndex: -1,
  cost: 0,
  topology: [],
};

// ─── Reusable scratch (one solve at a time; never allocated per frame) ────────

interface Scratch {
  nodeX: Float64Array;
  nodeY: Float64Array;
  g: Float64Array;
  f: Float64Array;
  h: Float64Array;
  parent: Int32Array;
  parentKneeX: Float64Array;
  parentKneeY: Float64Array;
  parentHasKnee: Uint8Array;
  inDirX: Float64Array;
  inDirY: Float64Array;
  // Generation stamps rather than booleans: the arrays are reused across solves
  // and clearing 4k entries per frame is exactly the kind of work this rebuild
  // exists to delete.
  closed: Int32Array;
  seen: Int32Array;
  heap: Int32Array;
}

let scratch: Scratch | null = null;
let scratchSize = 0;
let scratchGen = 0;

function ensureScratch(n: number): Scratch {
  if (!scratch || scratchSize < n) {
    const size = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(2, n))));
    scratch = {
      nodeX: new Float64Array(size),
      nodeY: new Float64Array(size),
      g: new Float64Array(size),
      f: new Float64Array(size),
      h: new Float64Array(size),
      parent: new Int32Array(size),
      parentKneeX: new Float64Array(size),
      parentKneeY: new Float64Array(size),
      parentHasKnee: new Uint8Array(size),
      inDirX: new Float64Array(size),
      inDirY: new Float64Array(size),
      closed: new Int32Array(size),
      seen: new Int32Array(size),
      heap: new Int32Array(MAX_HEAP),
    };
    scratchSize = size;
    scratchGen = 0;
  }
  return scratch;
}

const octScratch: Point[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));
const edgeKnee: Point = { x: 0, y: 0 };

function snapGrid(v: number): number {
  return Math.round(v / GRID_FINE_MM) * GRID_FINE_MM;
}

// ─── Solve ────────────────────────────────────────────────────────────────────

export function solveWalkaround(opts: SolveOpts): WalkaroundResult {
  const now = opts.now ?? (() => performance.now());
  if (now() >= opts.deadlineMs) return TIMEOUT;

  const set = opts.set;
  // `curved` searches on its un-filleted diag45 geometry: the fillet lies
  // strictly inside the corner, so it can only reduce penetration, and keeping
  // the search polyline-only is what lets the ±45° assertion below stay exact.
  const mode: PcbRoutingMode = opts.mode === "curved" ? "diag45" : opts.mode;

  // Only the CURSOR is quantised. `from` is a committed vertex — a pad centre or
  // an already-placed corner — so it cannot jitter and needs no quantisation, and
  // snapping it would be actively wrong: a 0402 pad centre sits at ±0.51 mm, so
  // rounding it to 0.5 leaves the caller composing a 0.01 mm jog between the real
  // anchor and the hug's first vertex, which is neither axis-aligned nor 45°.
  const ax = opts.from.x;
  const ay = opts.from.y;
  const cx = snapGrid(opts.to.x);
  const cy = snapGrid(opts.to.y);
  if (Math.abs(cx - ax) < GRID_FINE_MM / 2 && Math.abs(cy - ay) < GRID_FINE_MM / 2) {
    return { status: "ok", path: [{ x: ax, y: ay }], hugEndIndex: -1, cost: 0, topology: [0, 1] };
  }

  const nodeCount = 2 + (set.hard.length + set.soft.length) * 8;
  const s = ensureScratch(nodeCount);
  scratchGen++;
  const gen = scratchGen;

  s.nodeX[0] = ax;
  s.nodeY[0] = ay;
  s.nodeX[1] = cx;
  s.nodeY[1] = cy;

  const active = collectNodes(set, s, ax, ay, cx, cy);

  // ─── A* ───────────────────────────────────────────────────────────────────
  s.seen[0] = gen;
  s.g[0] = 0;
  s.h[0] = heuristic(mode, ax, ay, cx, cy);
  s.f[0] = s.h[0];
  s.parent[0] = -1;
  s.parentHasKnee[0] = 0;
  s.inDirX[0] = 0;
  s.inDirY[0] = 0;

  let heapSize = 0;
  const heap = s.heap;

  const less = (a: number, b: number): boolean => {
    if (s.f[a] !== s.f[b]) return s.f[a] < s.f[b];
    if (s.h[a] !== s.h[b]) return s.h[a] < s.h[b];
    return a < b;
  };
  const push = (node: number): boolean => {
    if (heapSize >= MAX_HEAP) return false;
    let i = heapSize++;
    heap[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[p];
      heap[p] = heap[i];
      heap[i] = t;
      i = p;
    }
    return true;
  };
  const pop = (): number => {
    const top = heap[0];
    heapSize--;
    if (heapSize > 0) {
      heap[0] = heap[heapSize];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapSize && less(heap[l], heap[m])) m = l;
        if (r < heapSize && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[m];
        heap[m] = heap[i];
        heap[i] = t;
        i = m;
      }
    }
    return top;
  };

  push(0);
  let expansions = 0;
  let edgesSinceCheck = 0;
  let reached = false;
  // Best cost to C found so far — the upper bound the edge prune below uses.
  let goalBound = Infinity;

  while (heapSize > 0) {
    if (expansions % DEADLINE_CHECK_EVERY === 0 && now() >= opts.deadlineMs) {
      return TIMEOUT;
    }
    expansions++;
    const cur = pop();
    if (s.closed[cur] === gen) continue;
    s.closed[cur] = gen;
    if (cur === 1) {
      reached = true;
      break;
    }

    const px = s.nodeX[cur];
    const py = s.nodeY[cur];
    for (const q of active) {
      // One expansion is up to MAX_NODES edge evaluations, so a per-expansion
      // check alone lets a dense board overrun the budget by milliseconds. The
      // deadline has to be enforced at edge granularity too.
      if (++edgesSinceCheck >= DEADLINE_CHECK_EVERY) {
        edgesSinceCheck = 0;
        if (now() >= opts.deadlineMs) return TIMEOUT;
      }
      if (q === cur || s.closed[q] === gen) continue;
      const qx = s.nodeX[q];
      const qy = s.nodeY[q];
      // `heuristic` is not a heuristic between two nodes — for every mode it is
      // EXACTLY the two-segment leader's length, and the cost terms above it
      // (vertex, acute corner, courtyard) are all non-negative. So it is a tight
      // admissible lower bound on this edge, and these two arithmetic tests
      // discard the overwhelming majority of candidate edges without paying for
      // a collision query. Without them a 100-pad board evaluates ~65k edges per
      // solve and never finishes inside the 4 ms deadline, which is the
      // difference between the walkaround working and it silently never firing.
      const hq = heuristic(mode, qx, qy, cx, cy);
      const lower = s.g[cur] + heuristic(mode, px, py, qx, qy);
      if (lower + hq >= goalBound) continue;
      if (s.seen[q] === gen && lower >= s.g[q]) continue;
      const cost = bestConnection(set, mode, px, py, qx, qy);
      if (cost === Infinity) continue;
      // Acute-corner penalty at the JOIN: a leader's own 45/90 knee is never
      // acute, so the term only bites where it is meant to — a hug that doubles
      // back around a corner instead of carrying on past it.
      let extra = 0;
      if (cur !== 0) {
        const outX = bestOutDirX;
        const outY = bestOutDirY;
        if (s.inDirX[cur] * outX + s.inDirY[cur] * outY < 0) {
          extra = ACUTE_CORNER_COST_MM;
        }
      }
      const g = s.g[cur] + cost + extra;
      if (s.seen[q] === gen && g >= s.g[q]) continue;
      s.seen[q] = gen;
      s.g[q] = g;
      s.h[q] = hq;
      s.f[q] = g + hq;
      // Tightening the bound the moment the goal is first relaxed is what makes
      // the prune above bite: everything that cannot beat the incumbent route to
      // C is then rejected by two additions.
      if (q === 1 && g < goalBound) goalBound = g;
      s.parent[q] = cur;
      s.parentHasKnee[q] = bestHasKnee;
      s.parentKneeX[q] = bestKneeX;
      s.parentKneeY[q] = bestKneeY;
      s.inDirX[q] = bestInDirX;
      s.inDirY[q] = bestInDirY;
      if (!push(q)) return TIMEOUT;
    }
  }

  if (!reached) return BLOCKED;
  return reconstruct(s, mode, ax, ay);
}

// `bestConnection` reports its winning geometry through these rather than an
// object, because it is called ~65k times per solve and must not allocate.
let bestKneeX = 0;
let bestKneeY = 0;
let bestHasKnee = 0;
let bestOutDirX = 0;
let bestOutDirY = 0;
let bestInDirX = 0;
let bestInDirY = 0;

const POSTURES: readonly RoutePosture[] = ["hv-first", "diag-first"];

/** Cheapest legal leader between two nodes, or Infinity when neither posture fits. */
function bestConnection(
  set: RouteObstacleSet,
  mode: PcbRoutingMode,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  let best = Infinity;
  for (const posture of POSTURES) {
    // eps = 0: a graph node is not the cursor, so the axis cases must not move
    // the endpoint. Two nodes 0.02mm apart in y get a real knee — a long axis run
    // plus a 0.02mm 45° stub — rather than a segment drawn as horizontal that
    // isn't. That difference is what the hug commits as copper.
    const verdict = leaderShape(ax, ay, bx, by, mode, posture, edgeKnee, 0);
    if (verdict === LEADER_NONE) continue;
    let cost: number;
    let hasKnee = 0;
    let kx = 0;
    let ky = 0;
    let outX: number;
    let outY: number;
    let inX: number;
    let inY: number;
    if (verdict === LEADER_DIRECT) {
      // Node b itself, which at eps = 0 is exactly what `edgeKnee` holds. Naming
      // it directly keeps cost, collision and `reconstruct` provably one
      // geometry rather than three that happen to agree.
      if (illegal(set, ax, ay, bx, by)) continue;
      cost = Math.hypot(bx - ax, by - ay);
      cost += COURTYARD_COST_PER_MM * softPenetrationMm(set, ax, ay, bx, by);
      outX = inX = bx - ax;
      outY = inY = by - ay;
    } else {
      kx = edgeKnee.x;
      ky = edgeKnee.y;
      if (illegal(set, ax, ay, kx, ky)) continue;
      if (illegal(set, kx, ky, bx, by)) continue;
      hasKnee = 1;
      cost =
        Math.hypot(kx - ax, ky - ay) +
        Math.hypot(bx - kx, by - ky) +
        VERTEX_COST_MM;
      cost +=
        COURTYARD_COST_PER_MM *
        (softPenetrationMm(set, ax, ay, kx, ky) +
          softPenetrationMm(set, kx, ky, bx, by));
      outX = kx - ax;
      outY = ky - ay;
      inX = bx - kx;
      inY = by - ky;
    }
    // Ties go to hv-first, which POSTURES visits first.
    if (cost < best) {
      best = cost;
      bestHasKnee = hasKnee;
      bestKneeX = kx;
      bestKneeY = ky;
      bestOutDirX = outX;
      bestOutDirY = outY;
      bestInDirX = inX;
      bestInDirY = inY;
    }
  }
  return best;
}

function illegal(
  set: RouteObstacleSet,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  return (
    segmentHitsHard(set, ax, ay, bx, by) ||
    segmentLeavesKeepIn(set, ax, ay, bx, by)
  );
}

function heuristic(
  mode: PcbRoutingMode,
  x: number,
  y: number,
  gx: number,
  gy: number
): number {
  const dx = Math.abs(gx - x);
  const dy = Math.abs(gy - y);
  if (mode === "ortho") return dx + dy;
  if (mode === "free") return Math.hypot(dx, dy);
  return Math.max(dx, dy) + SQRT2_MINUS_1 * Math.min(dx, dy);
}

// ─── Node collection ──────────────────────────────────────────────────────────

const nodeBuf: number[] = [];
const distBuf: number[] = [];
const candidates: number[] = [];

function collectNodes(
  set: RouteObstacleSet,
  s: Scratch,
  ax: number,
  ay: number,
  cx: number,
  cy: number
): number[] {
  nodeBuf.length = 0;
  distBuf.length = 0;
  candidates.length = 0;
  nodeBuf.push(0, 1);

  const minX = Math.min(ax, cx) - CORRIDOR_PAD_MM;
  const maxX = Math.max(ax, cx) + CORRIDOR_PAD_MM;
  const minY = Math.min(ay, cy) - CORRIDOR_PAD_MM;
  const maxY = Math.max(ay, cy) + CORRIDOR_PAD_MM;

  // Soft obstacles get corners too. Without them a lone component body would be
  // unavoidable by construction — there would be nothing to route around — and
  // "routes do not go around components" is the complaint this rebuild answers.
  // Their index range sits after every hard rank, so the two never collide.
  const softBase = 2 + set.hard.length * 8;
  const addCorners = (
    rects: ReadonlyArray<RouteObstacleSet["hard"][number]>,
    base: number,
    isHard: boolean
  ) => {
    for (let rank = 0; rank < rects.length; rank++) {
      const r = rects[rank];
      if (r.maxX < minX || r.minX > maxX || r.maxY < minY || r.minY > maxY) {
        continue;
      }
      octagonVertices(r, octScratch);
      for (let o = 0; o < 8; o++) {
        const v = octScratch[o];
        if (pointInsideHard(set, v.x, v.y, isHard ? rank : -1)) continue;
        if (set.keepIn && outsideKeepIn(set, v.x, v.y)) continue;
        // Index derives from the CANONICAL rank, not from corridor membership,
        // so the same physical corner keeps the same identity as the cursor
        // moves and obstacles drift in and out of the corridor. That identity is
        // what the topology hysteresis compares.
        const idx = base + rank * 8 + o;
        s.nodeX[idx] = v.x;
        s.nodeY[idx] = v.y;
        candidates.push(idx);
      }
    }
  };
  addCorners(set.hard, 2, true);
  addCorners(set.soft, softBase, false);

  if (candidates.length <= MAX_NODES - 2) {
    for (const idx of candidates) nodeBuf.push(idx);
    return nodeBuf;
  }

  // Over budget: keep the vertices closest to the A–C line, ties by index.
  const dx = cx - ax;
  const dy = cy - ay;
  const len = Math.hypot(dx, dy) || 1;
  for (const idx of candidates) {
    distBuf.push(
      Math.abs((s.nodeX[idx] - ax) * dy - (s.nodeY[idx] - ay) * dx) / len
    );
  }
  const order = candidates.map((_, i) => i);
  order.sort((a, b) =>
    distBuf[a] !== distBuf[b]
      ? distBuf[a] - distBuf[b]
      : candidates[a] - candidates[b]
  );
  const kept = order
    .slice(0, MAX_NODES - 2)
    .map((i) => candidates[i])
    .sort((a, b) => a - b);
  for (const idx of kept) nodeBuf.push(idx);
  return nodeBuf;
}

function outsideKeepIn(set: RouteObstacleSet, x: number, y: number): boolean {
  const k = set.keepIn!;
  return x < k.minX || x > k.maxX || y < k.minY || y > k.maxY;
}

// ─── Reconstruction ───────────────────────────────────────────────────────────

function reconstruct(
  s: Scratch,
  mode: PcbRoutingMode,
  ax: number,
  ay: number
): WalkaroundResult {
  const chain: number[] = [];
  for (let n = 1; n !== -1; n = s.parent[n]) chain.push(n);
  chain.reverse();

  const px: number[] = [ax];
  const py: number[] = [ay];
  // -1 = derived vertex (a leader knee); otherwise the graph node it came from.
  const owner: number[] = [chain[0]];

  for (let i = 1; i < chain.length; i++) {
    const node = chain[i];
    if (s.parentHasKnee[node]) {
      px.push(s.parentKneeX[node]);
      py.push(s.parentKneeY[node]);
      owner.push(-1);
    }
    px.push(s.nodeX[node]);
    py.push(s.nodeY[node]);
    owner.push(node);
  }

  // The last obstacle-derived vertex is the hug end: the point the interactive
  // leader regrows from every frame. It survives the collinear merge even when
  // it sits mid-run, because dropping it would hand the leader back an anchor on
  // the far side of the obstacle and the band would cut straight through.
  let lastNodeRaw = -1;
  for (let i = 1; i < owner.length - 1; i++) if (owner[i] >= 2) lastNodeRaw = i;

  // Merge collinear runs — a hop that carries straight on through a node is not
  // a corner and must not read as one.
  const kx: number[] = [px[0]];
  const ky: number[] = [py[0]];
  const kOwner: number[] = [owner[0]];
  for (let i = 1; i < px.length - 1; i++) {
    if (i !== lastNodeRaw) {
      const n = kx.length - 1;
      const ux = px[i] - kx[n];
      const uy = py[i] - ky[n];
      const vx = px[i + 1] - px[i];
      const vy = py[i + 1] - py[i];
      const cross = ux * vy - uy * vx;
      const dot = ux * vx + uy * vy;
      if (Math.abs(cross) < 1e-9 && dot > 0) continue;
    }
    kx.push(px[i]);
    ky.push(py[i]);
    kOwner.push(owner[i]);
  }
  kx.push(px[px.length - 1]);
  ky.push(py[py.length - 1]);
  kOwner.push(owner[owner.length - 1]);

  const path: Point[] = new Array(kx.length);
  for (let i = 0; i < kx.length; i++) path[i] = { x: kx[i], y: ky[i] };

  if (mode !== "free" && !anglesLegal(path)) {
    // A violation here is a bug in the edge generator, not a routing outcome.
    // Reporting timeout keeps the last good geometry on screen (§ offerSolution)
    // rather than drawing something the mode forbids.
    log.warn("[routeSolver] discarded a path that violated the angle mode");
    return TIMEOUT;
  }

  let hugEndIndex = -1;
  for (let i = 1; i < kOwner.length - 1; i++) {
    if (kOwner[i] >= 2) hugEndIndex = i;
  }

  return {
    status: "ok",
    path,
    hugEndIndex,
    cost: s.g[1],
    topology: chain,
  };
}

function anglesLegal(path: ReadonlyArray<Point>): boolean {
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x);
    const dy = Math.abs(path[i].y - path[i - 1].y);
    // Deliberately exact. Loosening this to LEADER_EPS_MM would "fix" the
    // near-axis discard by letting the offending geometry through instead, and
    // a hug vertex is committed copper — a 6mm run with a 0.02mm rise is a
    // segment this mode forbids, however small the angle. `bestConnection`
    // passes eps = 0 so the edge generator never produces one.
    if (dx < ANGLE_TOL || dy < ANGLE_TOL) continue;
    if (Math.abs(dx - dy) > ANGLE_TOL * Math.max(1, dx)) return false;
  }
  return true;
}

// ─── Last-good store ──────────────────────────────────────────────────────────

export interface WalkaroundStore {
  anchorKey: string;
  hasSolution: boolean;
  path: Point[];
  hugEndIndex: number;
  cost: number;
  topology: number[];
  solvedFor: Point | null;
  blockedStreak: number;
}

export function createWalkaroundStore(): WalkaroundStore {
  return {
    anchorKey: "",
    hasSolution: false,
    path: [],
    hugEndIndex: -1,
    cost: 0,
    topology: [],
    solvedFor: null,
    blockedStreak: 0,
  };
}

export function resetWalkaroundStore(store: WalkaroundStore): void {
  store.anchorKey = "";
  store.hasSolution = false;
  store.path = [];
  store.hugEndIndex = -1;
  store.cost = 0;
  store.topology = [];
  store.solvedFor = null;
  store.blockedStreak = 0;
}

export function offerSolution(
  store: WalkaroundStore,
  r: WalkaroundResult,
  solvedFor: Point,
  anchorKey: string
): void {
  // A timeout is not a state. It never touches the store, which is exactly why
  // a slow frame cannot change what is on screen.
  if (r.status === "timeout") return;

  if (store.anchorKey !== anchorKey) {
    resetWalkaroundStore(store);
    store.anchorKey = anchorKey;
  }

  if (r.status === "blocked") {
    store.blockedStreak++;
    store.solvedFor = { x: solvedFor.x, y: solvedFor.y };
    return;
  }

  store.blockedStreak = 0;
  const accept =
    !store.hasSolution ||
    // Hysteresis exists to stop two established HUGS trading places at 120 Hz.
    // An incumbent with no hug has nothing to protect, and replacing it costs the
    // user no visual continuity — so it always yields. Without this the very
    // first solve of a draft (cursor still on the start pad, so A === C, cost 0)
    // becomes an incumbent that `cost < 0 * 0.97` can never displace, and the
    // walkaround stays silently dead for the whole draft.
    store.hugEndIndex < 1 ||
    sameTopology(store.topology, r.topology) ||
    r.cost < store.cost * (1 - SOLVE_HYSTERESIS);
  store.solvedFor = { x: solvedFor.x, y: solvedFor.y };
  if (!accept) return;

  store.hasSolution = true;
  store.path = r.path;
  store.hugEndIndex = r.hugEndIndex;
  store.cost = r.cost;
  store.topology = r.topology;
}

function sameTopology(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface WalkaroundView {
  /** Hug vertices AFTER the anchor, up to and including the hug end. */
  path: Point[];
  hugEnd: Point | null;
  blocked: boolean;
}

export function readWalkaround(
  store: WalkaroundStore,
  cursor: Point,
  anchorKey: string
): WalkaroundView {
  if (store.anchorKey !== anchorKey) {
    return { path: [], hugEnd: null, blocked: false };
  }
  const blocked = store.blockedStreak >= BLOCKED_STREAK_TO_RENDER;
  if (!store.hasSolution || store.hugEndIndex < 1) {
    return { path: [], hugEnd: null, blocked };
  }
  const solvedFor = store.solvedFor;
  if (
    solvedFor &&
    Math.hypot(cursor.x - solvedFor.x, cursor.y - solvedFor.y) > STALE_RADIUS_MM
  ) {
    return { path: [], hugEnd: null, blocked };
  }
  const path = store.path.slice(1, store.hugEndIndex + 1);
  return { path, hugEnd: path[path.length - 1] ?? null, blocked };
}
