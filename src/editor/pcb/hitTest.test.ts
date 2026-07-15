import { describe, expect, it } from "vitest";
import {
  findNearestPad,
  hitTestPoint,
  hitTestRect,
  __testing,
} from "./hitTest";
import type {
  PcbComponentRecord,
  PcbModel,
  PcbPadRecord,
  PcbTraceRecord,
  PcbViaRecord,
} from "./pcbModel";

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

function component(over: Partial<PcbComponentRecord> = {}): PcbComponentRecord {
  return {
    key: "u_abc123",
    name: "U1",
    pcbComponentId: "pcb_c_1",
    x: 0,
    y: 0,
    rotationDeg: 0,
    originRotationDeg: 0,
    layer: "top",
    width: 4,
    height: 2,
    manuallyPlaced: false,
    pcbXInTsx: false,
    pcbYInTsx: false,
    hasSilkscreenOutline: false,
    ...over,
  };
}

function smtPad(over: Partial<PcbPadRecord> = {}): PcbPadRecord {
  return {
    pcbSmtpadId: "p_1",
    componentKey: "u_abc123",
    pcbComponentId: "pcb_c_1",
    x: 0,
    y: 0,
    layer: "top",
    isThroughHole: false,
    shape: "rect",
    rectWidth: 1,
    rectHeight: 0.6,
    rotationDeg: 0,
    pcbPortId: null,
    portHints: [],
    ...over,
  };
}

function trace(over: Partial<PcbTraceRecord> = {}): PcbTraceRecord {
  return {
    key: "t_abcdef",
    fromSelector: ".u1>.pin1",
    toSelector: ".r1>.pin1",
    segments: [],
    vias: [],
    userRouted: false,
    ...over,
  };
}

const vis = (top = true, bottom = true): Record<string, boolean> => ({
  top,
  bottom,
});

describe("hitTestPoint", () => {
  it("returns null on an empty model", () => {
    expect(
      hitTestPoint(emptyModel, 0, 0, {
        layerVisibility: vis(),
        toleranceMm: 0,
      })
    ).toBeNull();
  });

  it("hits a rect pad inside its bbox", () => {
    const pad = smtPad({ x: 5, y: 5, rectWidth: 1, rectHeight: 0.5 });
    const model: PcbModel = { ...emptyModel, pads: [pad] };
    expect(
      hitTestPoint(model, 5, 5, {
        layerVisibility: vis(),
        toleranceMm: 0,
      })
    ).toMatchObject({ kind: "pad", record: pad });
  });

  it("misses outside the pad bbox", () => {
    const pad = smtPad({ x: 0, y: 0, rectWidth: 1, rectHeight: 0.5 });
    const model: PcbModel = { ...emptyModel, pads: [pad] };
    expect(
      hitTestPoint(model, 2, 2, {
        layerVisibility: vis(),
        toleranceMm: 0,
      })
    ).toBeNull();
  });

  it("hits a trace segment along its midpoint", () => {
    const t = trace({
      segments: [
        {
          fromX: 0,
          fromY: 0,
          toX: 4,
          toY: 0,
          layer: "top",
          width: 0.25,
        },
      ],
    });
    const model: PcbModel = { ...emptyModel, traces: [t] };
    const hit = hitTestPoint(model, 2, 0, {
      layerVisibility: vis(),
      toleranceMm: 0.1,
    });
    expect(hit?.kind).toBe("trace");
  });

  it("ignores trace segments on hidden layers", () => {
    const t = trace({
      segments: [
        {
          fromX: 0,
          fromY: 0,
          toX: 4,
          toY: 0,
          layer: "bottom",
          width: 0.25,
        },
      ],
    });
    const model: PcbModel = { ...emptyModel, traces: [t] };
    expect(
      hitTestPoint(model, 2, 0, {
        layerVisibility: vis(true, false),
        toleranceMm: 0.1,
      })
    ).toBeNull();
  });

  it("hits a via on either of its two layers", () => {
    const via: PcbViaRecord = {
      x: 0,
      y: 0,
      drillDiameter: 0.3,
      outerDiameter: 0.6,
      fromLayer: "top",
      toLayer: "bottom",
      traceKey: null,
    };
    const model: PcbModel = { ...emptyModel, vias: [via] };
    // Top layer hidden, bottom visible → via is still hittable.
    expect(
      hitTestPoint(model, 0.1, 0, {
        layerVisibility: vis(false, true),
        toleranceMm: 0,
      })?.kind
    ).toBe("via");
    // Both hidden → no hit.
    expect(
      hitTestPoint(model, 0.1, 0, {
        layerVisibility: vis(false, false),
        toleranceMm: 0,
      })
    ).toBeNull();
  });

  it("respects priority order: via > pad > trace > component", () => {
    const x = 0;
    const y = 0;
    const model: PcbModel = {
      ...emptyModel,
      components: [component({ x, y, width: 5, height: 5 })],
      pads: [
        smtPad({ x, y, rectWidth: 1, rectHeight: 1 }),
      ],
      traces: [
        trace({
          segments: [
            { fromX: -1, fromY: 0, toX: 1, toY: 0, layer: "top", width: 0.5 },
          ],
        }),
      ],
      vias: [
        {
          x,
          y,
          drillDiameter: 0.3,
          outerDiameter: 0.6,
          fromLayer: "top",
          toLayer: "bottom",
          traceKey: null,
        },
      ],
    };
    const hit = hitTestPoint(model, 0, 0, {
      layerVisibility: vis(),
      toleranceMm: 0.1,
    });
    expect(hit?.kind).toBe("via");
  });

  it("hits a rotated component using its rotated bbox", () => {
    const comp = component({
      x: 0,
      y: 0,
      width: 4,
      height: 1,
      rotationDeg: 90,
    });
    const model: PcbModel = { ...emptyModel, components: [comp] };
    // After 90° rotation, the long axis runs along Y. Point on Y axis
    // inside the rotated bbox should hit.
    expect(
      hitTestPoint(model, 0, 1.5, {
        layerVisibility: vis(),
        toleranceMm: 0,
      })?.kind
    ).toBe("component");
    // Point off to the side (where pre-rotation the body extended)
    // should miss.
    expect(
      hitTestPoint(model, 1.5, 0, {
        layerVisibility: vis(),
        toleranceMm: 0,
      })
    ).toBeNull();
  });
});

describe("hitTestRect (marquee)", () => {
  it("returns components fully inside the rect", () => {
    const c1 = component({ x: 0, y: 0 });
    const c2 = component({ x: 10, y: 10, key: "u_xxx111" });
    const model: PcbModel = { ...emptyModel, components: [c1, c2] };
    const result = hitTestRect(model, -1, -1, 1, 1, {
      layerVisibility: vis(),
      toleranceMm: 0,
    });
    expect(result.components).toHaveLength(1);
    expect(result.components[0].key).toBe("u_abc123");
  });

  it("includes a trace if either endpoint is in the rect", () => {
    const t = trace({
      segments: [
        { fromX: 0, fromY: 0, toX: 10, toY: 0, layer: "top", width: 0.25 },
      ],
    });
    const model: PcbModel = { ...emptyModel, traces: [t] };
    const result = hitTestRect(model, 9, -1, 11, 1, {
      layerVisibility: vis(),
      toleranceMm: 0,
    });
    expect(result.traces).toHaveLength(1);
  });
});

describe("findNearestPad (route tool snap)", () => {
  it("finds the nearest pad on the active layer within radius", () => {
    const a = smtPad({ x: 0, y: 0, layer: "top" });
    const b = smtPad({
      x: 5,
      y: 0,
      layer: "top",
      pcbSmtpadId: "p_b",
    });
    const model: PcbModel = { ...emptyModel, pads: [a, b] };
    const found = findNearestPad(model, 4.8, 0, "top", 1);
    expect(found?.pcbSmtpadId).toBe("p_b");
  });

  it("returns null when no pad is in range", () => {
    const a = smtPad({ x: 0, y: 0, layer: "top" });
    const model: PcbModel = { ...emptyModel, pads: [a] };
    expect(findNearestPad(model, 5, 5, "top", 1)).toBeNull();
  });

  it("matches through-holes on any layer", () => {
    const a = smtPad({
      x: 0,
      y: 0,
      layer: "top",
      isThroughHole: true,
      shape: "circle",
      outerDiameter: 1,
      drillDiameter: 0.4,
    });
    const model: PcbModel = { ...emptyModel, pads: [a] };
    expect(findNearestPad(model, 0.05, 0, "bottom", 1)?.x).toBe(0);
  });
});

describe("geometry primitives", () => {
  it("pointInCircle: inside / outside / boundary", () => {
    expect(__testing.pointInCircle(0, 0, 0, 0, 1)).toBe(true);
    expect(__testing.pointInCircle(2, 0, 0, 0, 1)).toBe(false);
    expect(__testing.pointInCircle(1, 0, 0, 0, 1)).toBe(true);
  });

  it("pointInPolygon: triangle case", () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 3 },
    ];
    expect(__testing.pointInPolygon(2, 1, tri)).toBe(true);
    expect(__testing.pointInPolygon(0, 3, tri)).toBe(false);
  });
});
