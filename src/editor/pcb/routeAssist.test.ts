import { describe, expect, it, vi } from "vitest";
import {
  autorouteAll,
  buildObstacles,
  findRoutePath,
  simplifyRoute,
} from "./routeAssist";
import {
  padWorldCorners,
  type PcbModel,
  type PcbPadRecord,
  type UnroutedNet,
} from "./pcbModel";
import type { ManualEditsMap, StableKey } from "@/editor/shared/types";

const padA = {
  componentKey: "r_abc",
  pcbComponentId: "pc_r1",
  x: -5,
  y: 0,
  layer: "top",
  isThroughHole: false,
  shape: "rect" as const,
  rectWidth: 0.8,
  rectHeight: 0.5,
  rotationDeg: 0,
  pcbPortId: "p1",
  portHints: ["1"],
};
const padB = {
  componentKey: "r_xyz",
  pcbComponentId: "pc_r2",
  x: 5,
  y: 0,
  layer: "top",
  isThroughHole: false,
  shape: "rect" as const,
  rectWidth: 0.8,
  rectHeight: 0.5,
  rotationDeg: 0,
  pcbPortId: "p2",
  portHints: ["1"],
};

const emptyModel: PcbModel = {
  board: {
    centerX: 0,
    centerY: 0,
    width: 20,
    height: 20,
  },
  components: [],
  pads: [padA, padB],
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
  padBySelector: new Map([
    ["r1.pin1", padA],
    ["r2.pin1", padB],
  ]),
  selectorByPad: new Map([
    [padA, "r1.pin1"],
    [padB, "r2.pin1"],
  ]),
};

describe("simplifyRoute (ortho)", () => {
  it("removes collinear intermediate points", () => {
    const simplified = simplifyRoute(
      [
        { x: 0, y: 0, layer: "top" },
        { x: 1, y: 0, layer: "top" },
        { x: 2, y: 0, layer: "top" },
      ],
      "ortho"
    );
    expect(simplified).toEqual([
      { x: 0, y: 0, layer: "top" },
      { x: 2, y: 0, layer: "top" },
    ]);
  });
});

describe("buildObstacles", () => {
  it("includes pads as rects", () => {
    const obs = buildObstacles(emptyModel, { layerCount: 2 });
    expect(obs.length).toBeGreaterThanOrEqual(2);
  });

  it("expands rect pad obstacles to the rotated axis-aligned bounds", () => {
    const flat = {
      ...padA,
      x: 0,
      y: 0,
      rectWidth: 2,
      rectHeight: 1,
      rotationDeg: 0,
    };
    const rotated = { ...flat, rotationDeg: 45 };
    const flatObs = buildObstacles(
      { ...emptyModel, pads: [flat] },
      { layerCount: 2 }
    )[0];
    const rotObs = buildObstacles(
      { ...emptyModel, pads: [rotated] },
      { layerCount: 2 }
    )[0];

    expect(flatObs.width).toBeCloseTo(2.3, 5);
    expect(flatObs.height).toBeCloseTo(1.3, 5);

    const corners = padWorldCorners(rotated);
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const margin = 0.15;
    expect(rotObs.width).toBeCloseTo(
      Math.max(...xs) - Math.min(...xs) + margin * 2,
      5
    );
    expect(rotObs.height).toBeCloseTo(
      Math.max(...ys) - Math.min(...ys) + margin * 2,
      5
    );
    expect(rotObs.width).toBeGreaterThan(flatObs.height);
    expect(rotObs.height).toBeGreaterThan(flatObs.height);
  });

  it("builds obstacles for diagonal trace segments", () => {
    const model: PcbModel = {
      ...emptyModel,
      traces: [
        {
          key: "conn_test",
          fromSelector: "a",
          toSelector: "b",
          userRouted: true,
          segments: [
            {
              fromX: 0,
              fromY: 0,
              toX: 3,
              toY: 3,
              layer: "top",
              width: 0.25,
            },
          ],
          vias: [],
        },
      ],
    };
    const obs = buildObstacles(model, { layerCount: 2 });
    const traceObs = obs.find((o) => o.connectedTo.includes("conn_test"));
    expect(traceObs).toBeDefined();
    expect(traceObs!.width).toBeCloseTo(traceObs!.height, 5);
  });
});

describe("findRoutePath", () => {
  it("finds a Manhattan path between two separated pads", () => {
    const route = findRoutePath({
      model: emptyModel,
      from: {
        selector: "r1.pin1",
        x: -5,
        y: 0,
        layer: "top",
      },
      to: {
        selector: "r2.pin1",
        x: 5,
        y: 0,
        layer: "top",
      },
      traceWidth: 0.25,
      layerCount: 2,
      excludeSelectors: new Set(["r1.pin1", "r2.pin1"]),
    });
    expect(route).not.toBeNull();
    expect(route!.length).toBeGreaterThanOrEqual(2);
    expect(route![0]).toMatchObject({ x: -5, y: 0, layer: "top" });
    expect(route!.at(-1)).toMatchObject({ x: 5, y: 0, layer: "top" });
  });

  it("finds a path in 45° mode", () => {
    const route = findRoutePath({
      model: emptyModel,
      from: {
        selector: "r1.pin1",
        x: -5,
        y: 0,
        layer: "top",
      },
      to: {
        selector: "r2.pin1",
        x: 5,
        y: 0,
        layer: "top",
      },
      traceWidth: 0.25,
      layerCount: 2,
      excludeSelectors: new Set(["r1.pin1", "r2.pin1"]),
      routingMode: "diag45",
    });
    expect(route).not.toBeNull();
    expect(route!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("simplifyRoute", () => {
  it("preserves diagonal corners in 45° mode", () => {
    const simplified = simplifyRoute(
      [
        { x: 0, y: 0, layer: "top" },
        { x: 1, y: 1, layer: "top" },
        { x: 2, y: 1, layer: "top" },
      ],
      "diag45"
    );
    expect(simplified.length).toBe(3);
  });
});

function mkPad(selector: string, x: number, y: number): PcbPadRecord {
  return {
    componentKey: selector,
    pcbComponentId: `pc_${selector}`,
    x,
    y,
    layer: "top",
    isThroughHole: false,
    shape: "rect",
    rectWidth: 0.8,
    rectHeight: 0.5,
    rotationDeg: 0,
    pcbPortId: selector,
    portHints: ["1"],
  };
}

describe("autorouteAll", () => {
  it("routes every unrouted net, rebuilding the model after each", () => {
    // Two 2-pad nets that don't overlap (one at y=-3, one at y=3).
    const n1a = mkPad("u1.pin1", -6, -3);
    const n1b = mkPad("u2.pin1", 6, -3);
    const n2a = mkPad("u3.pin1", -6, 3);
    const n2b = mkPad("u4.pin1", 6, 3);
    const net1: UnroutedNet = {
      traceKey: "net1",
      fromSelector: "u1.pin1",
      toSelector: "u2.pin1",
      pads: [
        { selector: "u1.pin1", x: -6, y: -3, componentKey: "u1.pin1" },
        { selector: "u2.pin1", x: 6, y: -3, componentKey: "u2.pin1" },
      ],
    };
    const net2: UnroutedNet = {
      traceKey: "net2",
      fromSelector: "u3.pin1",
      toSelector: "u4.pin1",
      pads: [
        { selector: "u3.pin1", x: -6, y: 3, componentKey: "u3.pin1" },
        { selector: "u4.pin1", x: 6, y: 3, componentKey: "u4.pin1" },
      ],
    };
    const model: PcbModel = {
      ...emptyModel,
      pads: [n1a, n1b, n2a, n2b],
      nets: [net1, net2],
      unroutedNets: [net1, net2],
      padBySelector: new Map([
        ["u1.pin1", n1a],
        ["u2.pin1", n1b],
        ["u3.pin1", n2a],
        ["u4.pin1", n2b],
      ]),
      selectorByPad: new Map([
        [n1a, "u1.pin1"],
        [n1b, "u2.pin1"],
        [n2a, "u3.pin1"],
        [n2b, "u4.pin1"],
      ]),
    };
    // Identity rebuild: enough to exercise the orchestration contract.
    const rebuild = vi.fn(() => model);

    const { results, failedNets } = autorouteAll(
      model,
      {},
      0.25,
      2,
      "top",
      rebuild
    );

    expect(failedNets).toBe(0);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.connId)).size).toBe(2);
    // Rebuilt once after each net that produced copper.
    expect(rebuild).toHaveBeenCalledTimes(2);
    for (const r of results) {
      expect(r.route.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("counts a net with no routable airwire as failed and skips the rebuild", () => {
    // Two pads stacked on the same point — the MST spans no airwire.
    const p5 = mkPad("u5.pin1", 0, 0);
    const p6 = mkPad("u6.pin1", 0, 0);
    const stuck: UnroutedNet = {
      traceKey: "net_stuck",
      fromSelector: "u5.pin1",
      toSelector: "u6.pin1",
      pads: [
        { selector: "u5.pin1", x: 0, y: 0, componentKey: "u5.pin1" },
        { selector: "u6.pin1", x: 0, y: 0, componentKey: "u6.pin1" },
      ],
    };
    const model: PcbModel = {
      ...emptyModel,
      pads: [p5, p6],
      nets: [stuck],
      unroutedNets: [stuck],
      padBySelector: new Map([
        ["u5.pin1", p5],
        ["u6.pin1", p6],
      ]),
      selectorByPad: new Map([
        [p5, "u5.pin1"],
        [p6, "u6.pin1"],
      ]),
    };
    const rebuild = vi.fn(() => model);

    const { results, failedNets } = autorouteAll(
      model,
      {},
      0.25,
      2,
      "top",
      rebuild
    );

    expect(results).toHaveLength(0);
    expect(failedNets).toBe(1);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("routes each later net against the model returned by rebuildModel", () => {
    // The short-prevention contract is that copper laid by an earlier net —
    // delivered to the loop as the rebuilt model — is what later nets route
    // against. An identity rebuild can't prove this (the model never changes),
    // so here the rebuild keeps net2 in `nets` but strips its pads from
    // padBySelector. net2 can only fail if it's routed against the rebuilt
    // model; if autorouteAll wrongly reused the original model, net2 would
    // still have its pads and succeed.
    const n1a = mkPad("u1.pin1", -6, -3);
    const n1b = mkPad("u2.pin1", 6, -3);
    const n2a = mkPad("u3.pin1", -6, 3);
    const n2b = mkPad("u4.pin1", 6, 3);
    const net1: UnroutedNet = {
      traceKey: "net1",
      fromSelector: "u1.pin1",
      toSelector: "u2.pin1",
      pads: [
        { selector: "u1.pin1", x: -6, y: -3, componentKey: "u1.pin1" },
        { selector: "u2.pin1", x: 6, y: -3, componentKey: "u2.pin1" },
      ],
    };
    const net2: UnroutedNet = {
      traceKey: "net2",
      fromSelector: "u3.pin1",
      toSelector: "u4.pin1",
      pads: [
        { selector: "u3.pin1", x: -6, y: 3, componentKey: "u3.pin1" },
        { selector: "u4.pin1", x: 6, y: 3, componentKey: "u4.pin1" },
      ],
    };
    const base: PcbModel = {
      ...emptyModel,
      pads: [n1a, n1b, n2a, n2b],
      nets: [net1, net2],
      unroutedNets: [net1, net2],
      padBySelector: new Map([
        ["u1.pin1", n1a],
        ["u2.pin1", n1b],
        ["u3.pin1", n2a],
        ["u4.pin1", n2b],
      ]),
      selectorByPad: new Map([
        [n1a, "u1.pin1"],
        [n1b, "u2.pin1"],
        [n2a, "u3.pin1"],
        [n2b, "u4.pin1"],
      ]),
    };
    // Rebuilt model: net2 is still in `nets`, but its pads are gone, so
    // autorouteEdge can't resolve them and the net fails.
    const rebuilt: PcbModel = {
      ...base,
      padBySelector: new Map([
        ["u1.pin1", n1a],
        ["u2.pin1", n1b],
      ]),
    };
    const rebuild = vi.fn(() => rebuilt);

    const { results, failedNets } = autorouteAll(
      base,
      {},
      0.25,
      2,
      "top",
      rebuild
    );

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    // The one routed result is net1's edge, not net2's (net2 failed).
    expect(new Set([results[0].fromSelector, results[0].toSelector])).toEqual(
      new Set(["u1.pin1", "u2.pin1"])
    );
    expect(failedNets).toBe(1);
  });

  it("skips a snapshotted net that the rebuilt model no longer carries", () => {
    // net1 routes and triggers a rebuild; the rebuilt model drops net2 from
    // `nets` entirely (e.g. it merged into another cluster). net2 is still in
    // the up-front work list, so the loop must hit `if (!net) continue` and
    // neither route it nor count it as failed.
    const n1a = mkPad("u1.pin1", -6, -3);
    const n1b = mkPad("u2.pin1", 6, -3);
    const n2a = mkPad("u3.pin1", -6, 3);
    const n2b = mkPad("u4.pin1", 6, 3);
    const net1: UnroutedNet = {
      traceKey: "net1",
      fromSelector: "u1.pin1",
      toSelector: "u2.pin1",
      pads: [
        { selector: "u1.pin1", x: -6, y: -3, componentKey: "u1.pin1" },
        { selector: "u2.pin1", x: 6, y: -3, componentKey: "u2.pin1" },
      ],
    };
    const net2: UnroutedNet = {
      traceKey: "net2",
      fromSelector: "u3.pin1",
      toSelector: "u4.pin1",
      pads: [
        { selector: "u3.pin1", x: -6, y: 3, componentKey: "u3.pin1" },
        { selector: "u4.pin1", x: 6, y: 3, componentKey: "u4.pin1" },
      ],
    };
    const base: PcbModel = {
      ...emptyModel,
      pads: [n1a, n1b, n2a, n2b],
      nets: [net1, net2],
      unroutedNets: [net1, net2],
      padBySelector: new Map([
        ["u1.pin1", n1a],
        ["u2.pin1", n1b],
        ["u3.pin1", n2a],
        ["u4.pin1", n2b],
      ]),
      selectorByPad: new Map([
        [n1a, "u1.pin1"],
        [n1b, "u2.pin1"],
        [n2a, "u3.pin1"],
        [n2b, "u4.pin1"],
      ]),
    };
    // Rebuilt model: net2 is gone from `nets`, so the loop's find() misses it.
    const rebuilt: PcbModel = { ...base, nets: [net1] };
    const rebuild = vi.fn(() => rebuilt);

    const { results, failedNets } = autorouteAll(
      base,
      {},
      0.25,
      2,
      "top",
      rebuild
    );

    // Only net1 routed; net2 was skipped silently — not routed, not failed.
    expect(results).toHaveLength(1);
    expect(failedNets).toBe(0);
    expect(new Set([results[0].fromSelector, results[0].toSelector])).toEqual(
      new Set(["u1.pin1", "u2.pin1"])
    );
  });

  it("merges routes into manualEdits without clobbering existing pcb fields", () => {
    // Single 2-pad net. The merged edits map is what gets handed to
    // rebuildModel, so capture that argument to assert the merge contract:
    // (a) a sibling pcb field already on the routed connId survives, and
    // (b) an unrelated existing entry is carried through untouched.
    const n1a = mkPad("u1.pin1", -6, 0);
    const n1b = mkPad("u2.pin1", 6, 0);
    const net1: UnroutedNet = {
      traceKey: "net1",
      fromSelector: "u1.pin1",
      toSelector: "u2.pin1",
      pads: [
        { selector: "u1.pin1", x: -6, y: 0, componentKey: "u1.pin1" },
        { selector: "u2.pin1", x: 6, y: 0, componentKey: "u2.pin1" },
      ],
    };
    const model: PcbModel = {
      ...emptyModel,
      pads: [n1a, n1b],
      nets: [net1],
      unroutedNets: [net1],
      padBySelector: new Map([
        ["u1.pin1", n1a],
        ["u2.pin1", n1b],
      ]),
      selectorByPad: new Map([
        [n1a, "u1.pin1"],
        [n1b, "u2.pin1"],
      ]),
    };

    // The connId the route will be written under (matches autorouteEdge's
    // connectionId of the two endpoints).
    const routedConnId = results0ConnId(model);
    const seededEdits: ManualEditsMap = {
      [routedConnId]: { pcb: { layer: "bottom" } },
      other_conn: { pcb: { width: 0.5, route: [] } },
    };

    let mergedEdits: ManualEditsMap | null = null;
    const rebuild = vi.fn((edits: ManualEditsMap) => {
      mergedEdits = edits;
      return model;
    });

    const { results } = autorouteAll(
      model,
      seededEdits,
      0.3,
      2,
      "top",
      rebuild
    );

    expect(results).toHaveLength(1);
    expect(mergedEdits).not.toBeNull();
    const merged = mergedEdits!;
    // The route + width were written under the routed connId...
    expect(merged[routedConnId].pcb?.route?.length).toBeGreaterThanOrEqual(2);
    expect(merged[routedConnId].pcb?.width).toBe(0.3);
    // ...while the pre-existing sibling pcb field on that same entry survived.
    expect(merged[routedConnId].pcb?.layer).toBe("bottom");
    // The unrelated entry is carried through verbatim.
    expect(merged.other_conn).toEqual({ pcb: { width: 0.5, route: [] } });
    // The caller's original map was not mutated.
    expect(seededEdits[routedConnId].pcb?.route).toBeUndefined();
  });

  it("skips an unrouted net whose traceKey is null", () => {
    // The work list filters out nets without a stable traceKey — such a net
    // can't be re-resolved against the rebuilt model, so it is neither routed
    // nor counted as a failure, and no rebuild happens.
    const p1 = mkPad("u1.pin1", -6, 0);
    const p2 = mkPad("u2.pin1", 6, 0);
    const nullKeyNet: UnroutedNet = {
      traceKey: null,
      fromSelector: "u1.pin1",
      toSelector: "u2.pin1",
      pads: [
        { selector: "u1.pin1", x: -6, y: 0, componentKey: "u1.pin1" },
        { selector: "u2.pin1", x: 6, y: 0, componentKey: "u2.pin1" },
      ],
    };
    const model: PcbModel = {
      ...emptyModel,
      pads: [p1, p2],
      nets: [nullKeyNet],
      unroutedNets: [nullKeyNet],
      padBySelector: new Map([
        ["u1.pin1", p1],
        ["u2.pin1", p2],
      ]),
      selectorByPad: new Map([
        [p1, "u1.pin1"],
        [p2, "u2.pin1"],
      ]),
    };
    const rebuild = vi.fn(() => model);

    const { results, failedNets } = autorouteAll(
      model,
      {},
      0.25,
      2,
      "top",
      rebuild
    );

    expect(results).toHaveLength(0);
    expect(failedNets).toBe(0);
    expect(rebuild).not.toHaveBeenCalled();
  });
});

// The connId autorouteEdge writes under is connectionId(from, to) of the net's
// MST edge. Resolve it the same way the production code does so the test seeds
// the exact key the merge targets.
function results0ConnId(model: PcbModel): StableKey {
  const r = autorouteAll(model, {}, 0.25, 2, "top", () => model);
  return r.results[0].connId;
}
