import { describe, expect, it } from "vitest";

import { nextViolationIndex } from "./drc";

// The DRC inspector's prev/next index math. Pure, so it's worth pinning the
// wraparound and empty/unfocused seed behavior that's easy to get off-by-one.
describe("nextViolationIndex", () => {
  it("returns -1 for an empty list", () => {
    expect(nextViolationIndex(0, -1, 1)).toBe(-1);
    expect(nextViolationIndex(0, -1, -1)).toBe(-1);
  });

  it("seeds at index 0 when nothing is focused and stepping forward", () => {
    expect(nextViolationIndex(3, -1, 1)).toBe(0);
  });

  it("seeds at the last index when nothing is focused and stepping back", () => {
    expect(nextViolationIndex(3, -1, -1)).toBe(2);
  });

  it("wraps forward past the end", () => {
    expect(nextViolationIndex(3, 2, 1)).toBe(0);
  });

  it("wraps backward past the start", () => {
    expect(nextViolationIndex(3, 0, -1)).toBe(2);
  });

  it("advances normally in the middle", () => {
    expect(nextViolationIndex(3, 1, 1)).toBe(2);
    expect(nextViolationIndex(3, 1, -1)).toBe(0);
  });

  it("stays on the only element for a single-item list", () => {
    expect(nextViolationIndex(1, 0, 1)).toBe(0);
    expect(nextViolationIndex(1, 0, -1)).toBe(0);
  });
});
