// routeLive — the live channel for everything the route preview needs to draw,
// deliberately outside React and outside Zustand.
//
// A pointer move while drafting must not re-render a 3000-line component or
// reconcile an SVG subtree. So the cursor, the leader, the hug, the collision
// flags and the readouts live here instead: one snapshot object allocated once
// and mutated in place, published by bumping a version integer and calling the
// painter synchronously. `PcbCanvas` never re-renders because of a pointer move
// while drafting; the only React subscriber is `StatusBar`, over a separate HUD
// channel throttled to 10 Hz.
//
// `stats` is not instrumentation-for-its-own-sake: the browser perf spec asserts
// on it (zero store writes, rAF coalescing, handler self-time), so it is part of
// the contract this module owes.

import type {
  LayerId,
  PcbConflictMode,
  PcbRoutingMode,
  RoutePosture,
} from "@/editor/shared/types";

export const HUD_PUBLISH_INTERVAL_MS = 100;
export const FLUSH_SAMPLE_RING = 256;

const INITIAL_CAPACITY = 256;

export interface RouteLiveSnapshot {
  /** Bumped by `publish()`; the painter's only change signal. */
  version: number;
  active: boolean;

  // ─── Committed draft (already in the store's `points`) ──────────────────
  committedX: Float64Array;
  committedY: Float64Array;
  committedLayer: LayerId[];
  committedLen: number;

  // ─── Composed preview: anchor, hug vertices, then the leader ────────────
  previewX: Float64Array;
  previewY: Float64Array;
  previewLen: number;
  /** One flag per preview SEGMENT (previewLen - 1 of them). */
  previewHit: Uint8Array;
  /** Index into the preview arrays of the leader's corner, -1 when straight. */
  kneeIndex: number;

  cursorValid: boolean;
  cursorX: number;
  cursorY: number;
  /** 0 = no magnet, 1 = pad on the routed net, 2 = pad on a foreign net. */
  snapKind: 0 | 1 | 2;
  snapX: number;
  snapY: number;
  snapRadiusMm: number;

  blocked: boolean;
  layer: LayerId;
  widthMm: number;
  clearanceHaloMm: number;
  haloVisible: boolean;

  pendingViaActive: boolean;
  pendingViaX: number;
  pendingViaY: number;

  /** `performance.now()` of the last rejected pad click; the painter fades it. */
  rejectFlashAt: number;
  rejectFlashX: number;
  rejectFlashY: number;

  mode: PcbRoutingMode;
  posture: RoutePosture;
  postureLocked: boolean;
  conflictMode: PcbConflictMode;

  committedLengthMm: number;
  leaderLengthMm: number;
  viaCount: number;
}

export interface RouteHudSnapshot {
  active: boolean;
  layer: LayerId;
  widthMm: number;
  mode: PcbRoutingMode;
  posture: RoutePosture;
  postureLocked: boolean;
  conflictMode: PcbConflictMode;
  totalLengthMm: number;
  leaderLengthMm: number;
  viaCount: number;
  blocked: boolean;
  cursorValid: boolean;
  cursorX: number;
  cursorY: number;
}

export interface RouteLiveStats {
  moveCount: number;
  rafCount: number;
  storeWrites: number;
  solveCount: number;
  okCount: number;
  timeoutCount: number;
  blockedCount: number;
  /** Frames that fell back to a bare straight line — must stay at zero. */
  directFallbackCount: number;
  moveSelfMsMax: number;
  flushMsMax: number;
  flushMsSamples: number[];
  moveSelfMsSamples: number[];
}

function makeSnapshot(): RouteLiveSnapshot {
  return {
    version: 0,
    active: false,
    committedX: new Float64Array(INITIAL_CAPACITY),
    committedY: new Float64Array(INITIAL_CAPACITY),
    committedLayer: [],
    committedLen: 0,
    previewX: new Float64Array(INITIAL_CAPACITY),
    previewY: new Float64Array(INITIAL_CAPACITY),
    previewLen: 0,
    previewHit: new Uint8Array(INITIAL_CAPACITY),
    kneeIndex: -1,
    cursorValid: false,
    cursorX: 0,
    cursorY: 0,
    snapKind: 0,
    snapX: 0,
    snapY: 0,
    snapRadiusMm: 0.4,
    blocked: false,
    layer: "top",
    widthMm: 0.25,
    clearanceHaloMm: 0.45,
    haloVisible: true,
    pendingViaActive: false,
    pendingViaX: 0,
    pendingViaY: 0,
    rejectFlashAt: 0,
    rejectFlashX: 0,
    rejectFlashY: 0,
    mode: "diag45",
    posture: "hv-first",
    postureLocked: false,
    conflictMode: "walkaround",
    committedLengthMm: 0,
    leaderLengthMm: 0,
    viaCount: 0,
  };
}

function makeStats(): RouteLiveStats {
  return {
    moveCount: 0,
    rafCount: 0,
    storeWrites: 0,
    solveCount: 0,
    okCount: 0,
    timeoutCount: 0,
    blockedCount: 0,
    directFallbackCount: 0,
    moveSelfMsMax: 0,
    flushMsMax: 0,
    flushMsSamples: [],
    moveSelfMsSamples: [],
  };
}

const snapshot = makeSnapshot();
const stats = makeStats();
const paintSubs = new Set<() => void>();
const hudSubs = new Set<() => void>();

let hud: RouteHudSnapshot = buildHud();
let lastHudAt = 0;
let hudTail: ReturnType<typeof setTimeout> | null = null;

function cancelHudTail(): void {
  if (hudTail === null) return;
  clearTimeout(hudTail);
  hudTail = null;
}

function buildHud(): RouteHudSnapshot {
  return {
    active: snapshot.active,
    layer: snapshot.layer,
    widthMm: snapshot.widthMm,
    mode: snapshot.mode,
    posture: snapshot.posture,
    postureLocked: snapshot.postureLocked,
    conflictMode: snapshot.conflictMode,
    totalLengthMm: snapshot.committedLengthMm + snapshot.leaderLengthMm,
    leaderLengthMm: snapshot.leaderLengthMm,
    viaCount: snapshot.viaCount,
    blocked: snapshot.blocked,
    cursorValid: snapshot.cursorValid,
    cursorX: snapshot.cursorX,
    cursorY: snapshot.cursorY,
  };
}

function sample(ring: number[], value: number): void {
  if (ring.length < FLUSH_SAMPLE_RING) ring.push(value);
  else ring[stats.rafCount % FLUSH_SAMPLE_RING] = value;
}

/** Grow a preview/committed buffer set in place. Called on draft growth only. */
function grown(buf: Float64Array, need: number): Float64Array {
  if (buf.length >= need) return buf;
  let size = buf.length || INITIAL_CAPACITY;
  while (size < need) size *= 2;
  return new Float64Array(size);
}

export const routeLive = {
  snapshot,
  stats,

  ensureCommittedCapacity(n: number): void {
    if (snapshot.committedX.length >= n) return;
    snapshot.committedX = grown(snapshot.committedX, n);
    snapshot.committedY = grown(snapshot.committedY, n);
  },

  ensurePreviewCapacity(n: number): void {
    if (snapshot.previewX.length >= n) return;
    snapshot.previewX = grown(snapshot.previewX, n);
    snapshot.previewY = grown(snapshot.previewY, n);
    const hits = new Uint8Array(snapshot.previewX.length);
    hits.set(snapshot.previewHit.subarray(0, snapshot.previewHit.length));
    snapshot.previewHit = hits;
  },

  subscribePaint(fn: () => void): () => void {
    paintSubs.add(fn);
    return () => {
      paintSubs.delete(fn);
    };
  },

  subscribeHud(fn: () => void): () => void {
    hudSubs.add(fn);
    return () => {
      hudSubs.delete(fn);
    };
  },

  /** Stable identity between publishes so `useSyncExternalStore` cannot tear. */
  getHud(): RouteHudSnapshot {
    return hud;
  },

  /** Republish the HUD if the interval has elapsed. Returns true when it did. */
  publishHud(nowMs: number, force = false): boolean {
    if (!force && nowMs - lastHudAt < HUD_PUBLISH_INTERVAL_MS) {
      // Trailing edge. The frame where the cursor comes to rest is almost always
      // inside the throttle window, so a leading-edge-only throttle leaves the
      // readout showing a value up to 100 ms stale — at the start of a route,
      // literally "len 0.00 mm" under a rubber band 13 mm long. A readout that
      // lies while the pointer is still is worse than no readout.
      if (hudTail === null) {
        hudTail = setTimeout(
          () => {
            hudTail = null;
            routeLive.publishHud(performance.now(), true);
          },
          HUD_PUBLISH_INTERVAL_MS - (nowMs - lastHudAt)
        );
      }
      return false;
    }
    cancelHudTail();
    lastHudAt = nowMs;
    hud = buildHud();
    for (const fn of hudSubs) fn();
    return true;
  },

  publish(): void {
    snapshot.version++;
    for (const fn of paintSubs) fn();
  },

  recordFlush(ms: number): void {
    if (ms > stats.flushMsMax) stats.flushMsMax = ms;
    sample(stats.flushMsSamples, ms);
  },

  recordMove(ms: number): void {
    stats.moveCount++;
    if (ms > stats.moveSelfMsMax) stats.moveSelfMsMax = ms;
    if (stats.moveSelfMsSamples.length < FLUSH_SAMPLE_RING) {
      stats.moveSelfMsSamples.push(ms);
    } else {
      stats.moveSelfMsSamples[stats.moveCount % FLUSH_SAMPLE_RING] = ms;
    }
  },

  clear(): void {
    cancelHudTail();
    snapshot.active = false;
    snapshot.committedLen = 0;
    snapshot.committedLayer.length = 0;
    snapshot.previewLen = 0;
    snapshot.kneeIndex = -1;
    snapshot.cursorValid = false;
    snapshot.snapKind = 0;
    snapshot.blocked = false;
    snapshot.pendingViaActive = false;
    snapshot.rejectFlashAt = 0;
    snapshot.committedLengthMm = 0;
    snapshot.leaderLengthMm = 0;
    snapshot.viaCount = 0;
  },

  resetStats(): void {
    stats.moveCount = 0;
    stats.rafCount = 0;
    stats.storeWrites = 0;
    stats.solveCount = 0;
    stats.okCount = 0;
    stats.timeoutCount = 0;
    stats.blockedCount = 0;
    stats.directFallbackCount = 0;
    stats.moveSelfMsMax = 0;
    stats.flushMsMax = 0;
    stats.flushMsSamples.length = 0;
    stats.moveSelfMsSamples.length = 0;
  },
};

/** Test/e2e hook — the HUD interval is wall-clock, so specs need a reset. */
export function __resetHudClock(): void {
  cancelHudTail();
  lastHudAt = 0;
}
