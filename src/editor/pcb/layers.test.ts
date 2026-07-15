import { describe, it, expect } from "vitest";
import {
  clampCopperLayers,
  copperLayerIdsForCount,
  copperLayersForCount,
  getLayer,
  isCopperLayer,
  layersForCount,
  BOTTOM_LAYER_ID,
  TOP_LAYER_ID,
} from "./layers";

describe("pcb layers — board-aware copper sets", () => {
  it("a 2-layer board is just top + bottom", () => {
    expect(copperLayerIdsForCount(2)).toEqual([TOP_LAYER_ID, BOTTOM_LAYER_ID]);
  });

  it("inner layers slot between top and bottom, ordered top→bottom", () => {
    expect(copperLayerIdsForCount(4)).toEqual([
      "top",
      "inner1",
      "inner2",
      "bottom",
    ]);
    expect(copperLayerIdsForCount(6)).toEqual([
      "top",
      "inner1",
      "inner2",
      "inner3",
      "inner4",
      "bottom",
    ]);
  });

  it("clamps to the supported 2..8 copper range", () => {
    expect(clampCopperLayers(1)).toBe(2);
    expect(clampCopperLayers(99)).toBe(8);
    expect(clampCopperLayers(undefined)).toBe(2);
    expect(copperLayerIdsForCount(99)).toHaveLength(8);
  });

  it("every copper layer reports as copper and has a config", () => {
    for (const id of copperLayerIdsForCount(8)) {
      expect(isCopperLayer(id)).toBe(true);
      expect(getLayer(id)).toBeDefined();
    }
    expect(copperLayersForCount(4)).toHaveLength(4);
  });

  it("the panel layer set adds silkscreen + board outline (non-copper)", () => {
    const ids = layersForCount(2).map((l) => l.id);
    expect(ids).toContain("silkscreen_top");
    expect(ids).toContain("silkscreen_bottom");
    expect(ids).toContain("board");
    // Copper count for a 2-layer board is exactly top + bottom.
    expect(layersForCount(2).filter((l) => l.isCopper)).toHaveLength(2);
    expect(layersForCount(6).filter((l) => l.isCopper)).toHaveLength(6);
    expect(isCopperLayer("silkscreen_top")).toBe(false);
    expect(isCopperLayer("board")).toBe(false);
  });
});
