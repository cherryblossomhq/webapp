import { describe, expect, it } from "vitest";
import { computeNetMst, computeRatsnest } from "./ratsnest";
import type { PcbModel, UnroutedNet } from "./pcbModel";

const emptyModel: PcbModel = {
  board: null,
  components: [],
  pads: [],
  traces: [],
  vias: [],
  silkscreenLines: [],
  silkscreenShapes: [],
  silkscreenTexts: [],
  nets: [],
  unroutedNets: [],
  byKey: new Map(),
  keyByPcbComponentId: new Map(),
  padByPortId: new Map(),
  padBySelector: new Map(),
  selectorByPad: new Map(),
};

function net(pads: Array<[number, number]>, traceKey: string | null = null): UnroutedNet {
  return {
    traceKey,
    fromSelector: ".x>.p1",
    toSelector: ".x>.p2",
    pads: pads.map(([x, y], i) => ({
      x,
      y,
      selector: `.x > .p${i + 1}`,
      componentKey: null,
    })),
  };
}

describe("computeNetMst", () => {
  it("returns empty for a single-pad net", () => {
    expect(computeNetMst(net([[0, 0]]))).toEqual([]);
  });

  it("returns one edge for a two-pin net", () => {
    const edges = computeNetMst(net([[0, 0], [3, 0]]));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromX: 0,
      fromY: 0,
      toX: 3,
      toY: 0,
    });
  });

  it("picks the MST (not all-pairs) for a 3-pad chain", () => {
    // Three pads in a line — MST should be (0,0)-(1,0) + (1,0)-(2,0),
    // NOT include the longer (0,0)-(2,0) edge.
    const edges = computeNetMst(net([[0, 0], [1, 0], [2, 0]]));
    expect(edges).toHaveLength(2);
    const totalLen = edges.reduce(
      (a, e) => a + Math.hypot(e.toX - e.fromX, e.toY - e.fromY),
      0
    );
    expect(totalLen).toBeCloseTo(2);
  });

  it("connects 4 pads at the corners of a square with 3 edges", () => {
    const edges = computeNetMst(
      net([
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
    );
    expect(edges).toHaveLength(3);
  });

  it("skips zero-length edges (identical positions)", () => {
    const edges = computeNetMst(
      net([
        [0, 0],
        [0, 0],
        [1, 0],
      ])
    );
    // The two pads at (0,0) don't get an airwire between them. They DO
    // each get an airwire to (1,0) — but the MST only needs one of those
    // connections (the other is implicit through the shared position).
    expect(edges.length).toBeLessThanOrEqual(2);
    for (const e of edges) {
      expect(Math.hypot(e.toX - e.fromX, e.toY - e.fromY)).toBeGreaterThan(0);
    }
  });

  it("carries the traceKey through to every edge", () => {
    const edges = computeNetMst(net([[0, 0], [1, 0]], "t_abcdef"));
    expect(edges[0].traceKey).toBe("t_abcdef");
  });

  it("pre-unions same-cluster pads (routed copper draws no airwire)", () => {
    // Pads 0 and 1 are already joined by copper (cluster 0); pad 2 is its own
    // cluster. The MST spans only the still-unrouted gap → one airwire, and it
    // reaches pad 2 rather than bridging the two clustered pads.
    const n: UnroutedNet = {
      traceKey: null,
      fromSelector: ".x>.p1",
      toSelector: ".x>.p2",
      pads: [
        { x: 0, y: 0, selector: ".x > .p1", componentKey: null, cluster: 0 },
        { x: 3, y: 0, selector: ".x > .p2", componentKey: null, cluster: 0 },
        { x: 6, y: 0, selector: ".x > .p3", componentKey: null, cluster: 1 },
      ],
    };
    const edges = computeNetMst(n);
    expect(edges).toHaveLength(1);
    expect(Math.max(edges[0].fromX, edges[0].toX)).toBe(6);
  });

  it("draws nothing when every pad is in one cluster", () => {
    const n: UnroutedNet = {
      traceKey: null,
      fromSelector: ".x>.p1",
      toSelector: ".x>.p2",
      pads: [
        { x: 0, y: 0, selector: ".x > .p1", componentKey: null, cluster: 0 },
        { x: 3, y: 0, selector: ".x > .p2", componentKey: null, cluster: 0 },
      ],
    };
    expect(computeNetMst(n)).toEqual([]);
  });

  it("spans coincident pads in different clusters via a non-zero edge", () => {
    // p0 and p1 sit at the same point but in different clusters — genuinely
    // distinct pads. The d2===0 skip means no useless zero-length airwire is
    // drawn between them, yet the net is still spanned (p0 reaches p2). The MST
    // must not silently leave the two clusters disconnected.
    const n: UnroutedNet = {
      traceKey: null,
      fromSelector: ".x>.p1",
      toSelector: ".x>.p2",
      pads: [
        { x: 0, y: 0, selector: ".x > .p1", componentKey: null, cluster: 0 },
        { x: 0, y: 0, selector: ".x > .p2", componentKey: null, cluster: 1 },
        { x: 3, y: 0, selector: ".x > .p3", componentKey: null, cluster: 1 },
      ],
    };
    const edges = computeNetMst(n);
    expect(edges).toHaveLength(1);
    expect(
      Math.hypot(edges[0].toX - edges[0].fromX, edges[0].toY - edges[0].fromY)
    ).toBeCloseTo(3);
  });
});

describe("computeRatsnest", () => {
  it("returns no edges for an empty model", () => {
    expect(computeRatsnest(emptyModel)).toEqual([]);
  });

  it("concatenates MSTs for multiple nets", () => {
    const model: PcbModel = {
      ...emptyModel,
      unroutedNets: [
        net([[0, 0], [1, 0]]),
        net([[5, 0], [6, 0], [7, 0]]),
      ],
    };
    const edges = computeRatsnest(model);
    expect(edges).toHaveLength(3); // 1 + 2
  });
});
