import { describe, expect, it } from "vitest";
import { buildObstacles, findRoutePath, simplifyRoute } from "./routeAssist";
import { padWorldCorners, type PcbModel } from "./pcbModel";

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
