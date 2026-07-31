import { describe, expect, it } from "vitest";
import {
  GRID_CELL_MM,
  OCTAGON_CHAMFER_FRACTION,
  __testing,
  buildRouteObstacles,
  indexObstacles,
  obstacleSetKey,
  octagonVertices,
  segmentHitsHard,
  segmentHitsRect,
  segmentLeavesKeepIn,
  softPenetrationMm,
  type RouteRect,
} from "./routeGraph";
import { DEFAULT_BOARD_CLEARANCES, padInflationMm } from "./routeClearance";
import { makeModel, makePad, withSelectors } from "./routeFixtures";
import type { StableKey } from "@/editor/shared/types";

function rect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  soft = false
): RouteRect {
  return { minX, minY, maxX, maxY, layers: ["top"], soft };
}

function setOf(rects: RouteRect[]) {
  return indexObstacles({
    hard: rects.filter((r) => !r.soft),
    soft: rects.filter((r) => r.soft),
    keepIn: null,
    layer: "top",
  });
}

describe("octagonVertices", () => {
  const out = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));

  it("emits the eight corners in the documented order", () => {
    octagonVertices(rect(-2, -2, 2, 2), out);
    const ch = 2 * OCTAGON_CHAMFER_FRACTION;
    expect(out).toEqual([
      { x: 2, y: 2 - ch },
      { x: 2 - ch, y: 2 },
      { x: -2 + ch, y: 2 },
      { x: -2, y: 2 - ch },
      { x: -2, y: -2 + ch },
      { x: -2 + ch, y: -2 },
      { x: 2 - ch, y: -2 },
      { x: 2, y: -2 + ch },
    ]);
  });

  it("chamfers by the SHORTER half-extent on a non-square rect", () => {
    octagonVertices(rect(-4, -1, 4, 1), out);
    const ch = 1 * OCTAGON_CHAMFER_FRACTION;
    expect(out[0]).toEqual({ x: 4, y: 1 - ch });
    expect(out[1]).toEqual({ x: 4 - ch, y: 1 });
    // The chamfer never eats into the long axis more than the short one allows.
    expect(out[1].x).toBeGreaterThan(0);
  });
});

describe("segmentHitsRect", () => {
  const r = rect(0, 0, 2, 2);

  it("counts an exact edge graze as CLEAR", () => {
    // Touching is what a hug does; the inflation already carries the bias.
    expect(segmentHitsRect(-1, 0, 3, 0, r.minX, r.minY, r.maxX, r.maxY)).toBe(
      false
    );
    expect(segmentHitsRect(0, -1, 0, 3, r.minX, r.minY, r.maxX, r.maxY)).toBe(
      false
    );
    expect(segmentHitsRect(-1, 2, 3, 2, r.minX, r.minY, r.maxX, r.maxY)).toBe(
      false
    );
  });

  it("counts a corner touch as clear and a crossing as a hit", () => {
    expect(segmentHitsRect(-1, 1, 1, -1, r.minX, r.minY, r.maxX, r.maxY)).toBe(
      false
    );
    expect(segmentHitsRect(-1, 1, 3, 1, r.minX, r.minY, r.maxX, r.maxY)).toBe(
      true
    );
  });

  it("counts a fully-contained segment as a hit", () => {
    expect(
      segmentHitsRect(0.5, 0.5, 1.5, 1.5, r.minX, r.minY, r.maxX, r.maxY)
    ).toBe(true);
  });

  it("handles a degenerate zero-length segment", () => {
    expect(segmentHitsRect(1, 1, 1, 1, r.minX, r.minY, r.maxX, r.maxY)).toBe(
      true
    );
    expect(segmentHitsRect(5, 5, 5, 5, r.minX, r.minY, r.maxX, r.maxY)).toBe(
      false
    );
  });
});

describe("the uniform grid index", () => {
  // 300 obstacles over a field several cells wide, so the DDA has real work.
  const rects: RouteRect[] = [];
  for (let i = 0; i < 300; i++) {
    const x = (i % 20) * 3 - 30;
    const y = Math.floor(i / 20) * 3 - 22;
    rects.push(rect(x, y, x + 1.2, y + 0.8));
  }
  const set = setOf(rects);

  function brute(ax: number, ay: number, bx: number, by: number): boolean {
    return set.hard.some((r) =>
      segmentHitsRect(ax, ay, bx, by, r.minX, r.minY, r.maxX, r.maxY)
    );
  }

  it("agrees with a brute-force scan over 500 random segments", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 500; i++) {
      const ax = rand() * 80 - 40;
      const ay = rand() * 80 - 40;
      const bx = rand() * 80 - 40;
      const by = rand() * 80 - 40;
      expect(segmentHitsHard(set, ax, ay, bx, by)).toBe(brute(ax, ay, bx, by));
    }
  });

  it("offers up every rect the segment actually hits", () => {
    const candidates = new Set(__testing.hardCandidates(set, -40, -20, 40, 20));
    for (let i = 0; i < set.hard.length; i++) {
      const r = set.hard[i];
      if (segmentHitsRect(-40, -20, 40, 20, r.minX, r.minY, r.maxX, r.maxY)) {
        expect(candidates.has(i)).toBe(true);
      }
    }
  });

  it("keeps the grid cell pitch it advertises", () => {
    expect(GRID_CELL_MM).toBe(2);
    const g = set.hardGrid;
    expect(g.start.length).toBe(g.cellsX * g.cellsY + 1);
  });

  it("an empty set never reports a hit", () => {
    expect(segmentHitsHard(setOf([]), -5, -5, 5, 5)).toBe(false);
  });
});

describe("canonical ordering", () => {
  it("the sort is stable under input permutation", () => {
    const a = rect(1, 1, 2, 2);
    const b = rect(-3, 0, -1, 4);
    const c = rect(1, -5, 2, -4);
    const one = setOf([a, b, c]).hard.map((r) => [r.minX, r.minY]);
    const two = setOf([c, a, b]).hard.map((r) => [r.minX, r.minY]);
    const three = setOf([b, c, a]).hard.map((r) => [r.minX, r.minY]);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
  });

  it("ties on minX fall through to minY, maxX, maxY", () => {
    const sorted = setOf([
      rect(0, 0, 5, 5),
      rect(0, 0, 4, 9),
      rect(0, -1, 1, 1),
    ]).hard;
    expect(sorted.map((r) => [r.minY, r.maxX])).toEqual([
      [-1, 1],
      [0, 4],
      [0, 5],
    ]);
  });
});

describe("softPenetrationMm", () => {
  it("measures a courtyard crossing corner to corner", () => {
    const set = setOf([rect(-1, -1, 1, 1, true)]);
    expect(softPenetrationMm(set, -3, -3, 3, 3)).toBeCloseTo(
      Math.hypot(2, 2),
      6
    );
  });

  it("is zero for a segment that misses every courtyard", () => {
    const set = setOf([rect(-1, -1, 1, 1, true)]);
    expect(softPenetrationMm(set, -3, 5, 3, 5)).toBe(0);
  });

  it("sums across several overlapping courtyards", () => {
    const set = setOf([rect(0, -1, 2, 1, true), rect(3, -1, 4, 1, true)]);
    expect(softPenetrationMm(set, -1, 0, 6, 0)).toBeCloseTo(3, 6);
  });
});

describe("buildRouteObstacles", () => {
  const padA = makePad({ x: -5, y: 0 });
  const padB = makePad({ x: 5, y: 0, pcbPortId: "p2" });
  const model = withSelectors(makeModel({ pads: [padA, padB] }), [
    ["r1.pin1", padA],
    ["r2.pin1", padB],
  ]);

  const baseOpts = {
    model,
    layer: "top",
    layerCount: 2,
    traceWidthMm: 0.25,
    excludeSelectors: new Set<string>(),
    excludeTraceKey: null,
    clearances: DEFAULT_BOARD_CLEARANCES,
  };

  it("inflates a pad by exactly padInflationMm", () => {
    const set = buildRouteObstacles(baseOpts);
    const inflate = padInflationMm(0.25);
    const left = set.hard[0];
    expect(left.minX).toBeCloseTo(-5 - 0.4 - inflate, 9);
    expect(left.maxY).toBeCloseTo(0.25 + inflate, 9);
  });

  it("drops pads on the routed net so the path can terminate on them", () => {
    const set = buildRouteObstacles({
      ...baseOpts,
      excludeSelectors: new Set(["r1.pin1"]),
    });
    expect(set.hard).toHaveLength(1);
  });

  it("drops copper already on the routed net, autoroute included", () => {
    const trace = {
      key: "conn_r1_r2" as StableKey,
      fromSelector: ".R1 > .pin1",
      toSelector: ".R2 > .pin1",
      segments: [
        {
          fromX: -4,
          fromY: 0,
          toX: 4,
          toY: 0,
          width: 0.2,
          layer: "top",
          traceKey: "conn_r1_r2" as StableKey,
        },
      ],
      vias: [],
      userRouted: false,
    };
    const withTrace = { ...baseOpts, model: makeModel({ traces: [trace] }) };
    expect(buildRouteObstacles(withTrace).hard).toHaveLength(1);
    // The net's own autoroute is not a wall for the manual route replacing it.
    expect(
      buildRouteObstacles({
        ...withTrace,
        excludeSelectors: new Set(["r1.pin1", "r2.pin1"]),
      }).hard
    ).toHaveLength(0);
  });

  it("keeps only obstacles on the drafted layer", () => {
    const bottom = makePad({ x: 0, y: 0, layer: "bottom" });
    const set = buildRouteObstacles({
      ...baseOpts,
      model: makeModel({ pads: [bottom] }),
    });
    expect(set.hard).toHaveLength(0);
  });

  it("treats a through-hole pad as an obstacle on every copper layer", () => {
    const th = makePad({ x: 0, y: 0, layer: "top", isThroughHole: true });
    const set = buildRouteObstacles({
      ...baseOpts,
      layer: "bottom",
      model: makeModel({ pads: [th] }),
    });
    expect(set.hard).toHaveLength(1);
  });

  it("inset the board into a keep-in area", () => {
    const set = buildRouteObstacles(baseOpts);
    expect(set.keepIn).not.toBeNull();
    expect(set.keepIn!.minX).toBeCloseTo(-20 + 0.125 + 0.2 + 0.01, 9);
    expect(segmentLeavesKeepIn(set, 0, 0, 25, 0)).toBe(true);
    expect(segmentLeavesKeepIn(set, 0, 0, 5, 0)).toBe(false);
  });

  it("component courtyards are SOFT, never walls", () => {
    const set = buildRouteObstacles({
      ...baseOpts,
      model: makeModel({
        components: [
          {
            key: "u_abc123",
            name: "U1",
            pcbComponentId: "pc_u1",
            x: 0,
            y: 0,
            rotationDeg: 0,
            originRotationDeg: 0,
            layer: "top",
            width: 4,
            height: 4,
            manuallyPlaced: false,
            pcbXInTsx: false,
            pcbYInTsx: false,
            hasSilkscreenOutline: false,
          },
        ],
      }),
    });
    expect(set.hard).toHaveLength(0);
    expect(set.soft).toHaveLength(1);
    expect(segmentHitsHard(set, -5, 0, 5, 0)).toBe(false);
    expect(softPenetrationMm(set, -5, 0, 5, 0)).toBeCloseTo(4, 6);
  });
});

describe("obstacleSetKey", () => {
  const model = makeModel();
  const opts = {
    model,
    layer: "top",
    layerCount: 2,
    traceWidthMm: 0.25,
    excludeSelectors: new Set(["b", "a"]),
    excludeTraceKey: null,
    clearances: DEFAULT_BOARD_CLEARANCES,
  };

  it("is stable for the same inputs and independent of selector order", () => {
    expect(obstacleSetKey(opts)).toBe(
      obstacleSetKey({ ...opts, excludeSelectors: new Set(["a", "b"]) })
    );
  });

  it("changes when anything the obstacle set depends on changes", () => {
    const base = obstacleSetKey(opts);
    expect(obstacleSetKey({ ...opts, layer: "bottom" })).not.toBe(base);
    expect(obstacleSetKey({ ...opts, traceWidthMm: 0.6 })).not.toBe(base);
    expect(obstacleSetKey({ ...opts, layerCount: 4 })).not.toBe(base);
    expect(obstacleSetKey({ ...opts, excludeTraceKey: "conn_a1b2c3" })).not.toBe(
      base
    );
    expect(obstacleSetKey({ ...opts, model: makeModel() })).not.toBe(base);
    expect(
      obstacleSetKey({
        ...opts,
        clearances: { traceToPadMm: 0.2, traceToTraceMm: 0.1, boardEdgeMm: 0.2 },
      })
    ).not.toBe(base);
  });
});
