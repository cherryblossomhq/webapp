import { beforeEach, describe, expect, it, vi } from "vitest";
import { HUD_PUBLISH_INTERVAL_MS, __resetHudClock, routeLive } from "./routeLive";

beforeEach(() => {
  routeLive.clear();
  routeLive.resetStats();
  __resetHudClock();
});

describe("paint channel", () => {
  it("notifies every subscriber synchronously on publish", () => {
    const seen: number[] = [];
    const off = routeLive.subscribePaint(() =>
      seen.push(routeLive.snapshot.version)
    );
    const before = routeLive.snapshot.version;
    routeLive.publish();
    expect(seen).toEqual([before + 1]);
    off();
    routeLive.publish();
    expect(seen).toHaveLength(1);
  });

  it("publish() allocates nothing", () => {
    const snap = routeLive.snapshot;
    const buffers = [
      snap.committedX,
      snap.committedY,
      snap.previewX,
      snap.previewY,
      snap.previewHit,
    ];
    for (let i = 0; i < 1000; i++) routeLive.publish();
    expect(routeLive.snapshot).toBe(snap);
    expect(snap.committedX).toBe(buffers[0]);
    expect(snap.committedY).toBe(buffers[1]);
    expect(snap.previewX).toBe(buffers[2]);
    expect(snap.previewY).toBe(buffers[3]);
    expect(snap.previewHit).toBe(buffers[4]);
  });

  it("grows its buffers only when a draft outruns them", () => {
    const snap = routeLive.snapshot;
    const before = snap.previewX;
    routeLive.ensurePreviewCapacity(4);
    expect(snap.previewX).toBe(before);
    routeLive.ensurePreviewCapacity(before.length + 1);
    expect(snap.previewX).not.toBe(before);
    expect(snap.previewX.length).toBeGreaterThan(before.length);
    expect(snap.previewHit.length).toBe(snap.previewX.length);
  });
});

describe("HUD channel", () => {
  it("republishes at most once per interval", () => {
    const fn = vi.fn();
    const off = routeLive.subscribeHud(fn);
    expect(routeLive.publishHud(1_000)).toBe(true);
    expect(routeLive.publishHud(1_000 + HUD_PUBLISH_INTERVAL_MS / 2)).toBe(false);
    expect(routeLive.publishHud(1_000 + HUD_PUBLISH_INTERVAL_MS)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it("keeps getHud() identity stable between publishes so React cannot tear", () => {
    routeLive.publishHud(0, true);
    const a = routeLive.getHud();
    expect(routeLive.getHud()).toBe(a);
    routeLive.publish();
    expect(routeLive.getHud()).toBe(a);
    routeLive.publishHud(HUD_PUBLISH_INTERVAL_MS * 2, true);
    expect(routeLive.getHud()).not.toBe(a);
  });

  it("reports what the snapshot holds", () => {
    routeLive.snapshot.active = true;
    routeLive.snapshot.committedLengthMm = 10;
    routeLive.snapshot.leaderLengthMm = 2.5;
    routeLive.snapshot.blocked = true;
    routeLive.publishHud(0, true);
    const hud = routeLive.getHud();
    expect(hud.active).toBe(true);
    expect(hud.totalLengthMm).toBeCloseTo(12.5, 9);
    expect(hud.leaderLengthMm).toBeCloseTo(2.5, 9);
    expect(hud.blocked).toBe(true);
  });
});

describe("stats", () => {
  it("tracks the maxima the perf gate asserts on", () => {
    routeLive.recordMove(0.4);
    routeLive.recordMove(0.1);
    routeLive.recordFlush(3);
    routeLive.recordFlush(1);
    expect(routeLive.stats.moveCount).toBe(2);
    expect(routeLive.stats.moveSelfMsMax).toBeCloseTo(0.4, 9);
    expect(routeLive.stats.flushMsMax).toBe(3);
    expect(routeLive.stats.flushMsSamples).toEqual([3, 1]);
    routeLive.resetStats();
    expect(routeLive.stats.moveCount).toBe(0);
    expect(routeLive.stats.flushMsSamples).toEqual([]);
  });

  it("clear() drops the live geometry without touching identities", () => {
    const snap = routeLive.snapshot;
    snap.active = true;
    snap.previewLen = 5;
    snap.kneeIndex = 2;
    routeLive.clear();
    expect(snap.active).toBe(false);
    expect(snap.previewLen).toBe(0);
    expect(snap.kneeIndex).toBe(-1);
    expect(routeLive.snapshot).toBe(snap);
  });
});
