import { describe, expect, it } from "vitest";
import {
  findNetContainingSelector,
  findUserRouteAtPad,
  isPadOnNet,
  isTraceOnNet,
  selectorsOnNet,
} from "./routeAssist";
import { connectionId } from "@/editor/shared/connectionId";
import { makeModel, makePad, withSelectors } from "./routeFixtures";
import type { UnroutedNet } from "./pcbModel";

const padA = makePad({ x: -5, y: 0, componentKey: "r_aaa111" });
const padB = makePad({ x: 5, y: 0, componentKey: "r_bbb222", pcbPortId: "p2" });
const padC = makePad({ x: 0, y: 6, componentKey: "r_ccc333", pcbPortId: "p3" });

const net: UnroutedNet = {
  traceKey: connectionId("R1.pin1", "R2.pin1"),
  fromSelector: "R1.pin1",
  toSelector: "R2.pin1",
  pads: [
    { x: -5, y: 0, selector: "R1.pin1", componentKey: "r_aaa111" },
    { x: 5, y: 0, selector: "R2.pin1", componentKey: "r_bbb222" },
  ],
};

const model = withSelectors(
  makeModel({
    pads: [padA, padB, padC],
    nets: [net],
    traces: [
      {
        key: connectionId("R1.pin1", "R2.pin1"),
        fromSelector: "R1.pin1",
        toSelector: "R2.pin1",
        userRouted: true,
        segments: [
          { fromX: -5, fromY: 0, toX: 5, toY: 0, layer: "top", width: 0.25 },
        ],
        vias: [],
      },
    ],
  }),
  [
    ["r1.pin1", padA],
    ["r2.pin1", padB],
    ["r3.pin1", padC],
  ]
);

describe("findNetContainingSelector", () => {
  it("resolves a pad to its net regardless of selector spelling", () => {
    expect(findNetContainingSelector(model, ".R1 > .pin1")).toBe(net);
    expect(findNetContainingSelector(model, "r2.pin1")).toBe(net);
  });

  it("returns null for a pad that is on no net", () => {
    expect(findNetContainingSelector(model, "R3.pin1")).toBeNull();
  });
});

describe("selectorsOnNet / isPadOnNet", () => {
  it("canonicalises every selector on the net", () => {
    expect(selectorsOnNet(net)).toEqual(new Set(["r1.pin1", "r2.pin1"]));
  });

  it("classifies pads by net membership — the wrong-net click rejection", () => {
    const sels = selectorsOnNet(net);
    expect(isPadOnNet(padA, model, sels)).toBe(true);
    expect(isPadOnNet(padB, model, sels)).toBe(true);
    expect(isPadOnNet(padC, model, sels)).toBe(false);
  });

  it("a pad with no selector is never on the net", () => {
    expect(isPadOnNet(makePad(), model, selectorsOnNet(net))).toBe(false);
  });
});

describe("isTraceOnNet", () => {
  it("matches the connection id of any pad pair on the net", () => {
    const sels = selectorsOnNet(net);
    expect(isTraceOnNet(connectionId("r1.pin1", "r2.pin1"), sels)).toBe(true);
    expect(isTraceOnNet(connectionId("r1.pin1", "r3.pin1"), sels)).toBe(false);
  });
});

describe("findUserRouteAtPad", () => {
  it("finds a user route ending at the pad, from either end", () => {
    expect(findUserRouteAtPad(model, "R1.pin1")).toEqual({
      traceKey: connectionId("R1.pin1", "R2.pin1"),
      fromEnd: "start",
    });
    expect(findUserRouteAtPad(model, "R2.pin1")).toEqual({
      traceKey: connectionId("R1.pin1", "R2.pin1"),
      fromEnd: "end",
    });
  });

  it("ignores autorouted traces — only user copper can be picked up", () => {
    const evalOnly = makeModel({
      traces: [
        {
          key: "conn_abc123",
          fromSelector: "R1.pin1",
          toSelector: "R2.pin1",
          userRouted: false,
          segments: [],
          vias: [],
        },
      ],
    });
    expect(findUserRouteAtPad(evalOnly, "R1.pin1")).toBeNull();
  });
});
