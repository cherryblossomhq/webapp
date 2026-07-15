import { describe, it, expect } from "vitest";
import {
  CHAT_MIN_WIDTH,
  CHAT_DEFAULT_WIDTH,
  CANVAS_FLOOR,
  clampChatWidth,
  maxChatWidth,
  wideChatWidth,
  snapChatWidth,
} from "./clampChatWidth";

// A roomy desktop row: 1600 wide, 220 library sidebar → 1380 available.
const ROW = 1600;
const SIDEBAR = 220;

describe("clampChatWidth", () => {
  it("returns the default unchanged when it fits", () => {
    expect(clampChatWidth(CHAT_DEFAULT_WIDTH, ROW, SIDEBAR)).toBe(440);
  });

  it("never goes below the hard minimum", () => {
    expect(clampChatWidth(50, ROW, SIDEBAR)).toBe(CHAT_MIN_WIDTH);
    expect(clampChatWidth(-100, ROW, SIDEBAR)).toBe(CHAT_MIN_WIDTH);
  });

  it("keeps the canvas at or above its floor", () => {
    const available = ROW - SIDEBAR; // 1380
    const width = clampChatWidth(99999, ROW, SIDEBAR);
    expect(available - width).toBeGreaterThanOrEqual(CANVAS_FLOOR);
  });

  it("respects the fraction cap on a wide row", () => {
    // 70% of 1380 = 966, which is tighter than the floor cap (1380-480=900).
    // Floor cap wins here, so max should be 900.
    expect(maxChatWidth(ROW, SIDEBAR)).toBe(900);
    expect(clampChatWidth(99999, ROW, SIDEBAR)).toBe(900);
  });

  it("widens the resizable region math when the sidebar grows (JLCPCB 640)", () => {
    const wideSidebar = 640;
    const maxNarrow = maxChatWidth(ROW, SIDEBAR);
    const maxWide = maxChatWidth(ROW, wideSidebar);
    expect(maxWide).toBeLessThan(maxNarrow);
  });

  it("pins to min when the sidebar leaves no usable region (sidebar >= row)", () => {
    // Degenerate geometry (e.g. a 640 JLCPCB sidebar on a 600 row): the
    // resizable region is negative, so chat must land on its hard minimum.
    expect(maxChatWidth(600, 640)).toBe(CHAT_MIN_WIDTH);
    expect(clampChatWidth(440, 600, 640)).toBe(CHAT_MIN_WIDTH);
  });

  it("collapses chat toward its min on a too-narrow window (chat yields first)", () => {
    // 700 row - 220 sidebar = 480 available; floor cap = 0, fraction cap = 336.
    // Both are below the min, so chat pins to its min and the canvas dips below
    // its floor — chat yields first, by design.
    expect(clampChatWidth(440, 700, SIDEBAR)).toBe(CHAT_MIN_WIDTH);
  });

  it("rounds to whole pixels", () => {
    expect(Number.isInteger(clampChatWidth(440.6, ROW, SIDEBAR))).toBe(true);
  });
});

describe("wideChatWidth", () => {
  it("is wider than the default but still clamped to the max", () => {
    const wide = wideChatWidth(ROW, SIDEBAR);
    expect(wide).toBeGreaterThan(CHAT_DEFAULT_WIDTH);
    expect(wide).toBeLessThanOrEqual(maxChatWidth(ROW, SIDEBAR));
  });
});

describe("snapChatWidth", () => {
  it("snaps to the default when released nearby", () => {
    expect(snapChatWidth(446, ROW, SIDEBAR)).toBe(440);
    expect(snapChatWidth(431, ROW, SIDEBAR)).toBe(440);
  });

  it("snaps to the min near the min", () => {
    expect(snapChatWidth(330, ROW, SIDEBAR)).toBe(CHAT_MIN_WIDTH);
  });

  it("snaps to the wide preset when released near it", () => {
    const wide = wideChatWidth(ROW, SIDEBAR);
    expect(snapChatWidth(wide - 5, ROW, SIDEBAR)).toBe(wide);
  });

  it("leaves a width far from any preset untouched", () => {
    // 620 sits between the 440 default and the wide preset, clear of both.
    expect(snapChatWidth(620, ROW, SIDEBAR)).toBe(620);
  });
});
