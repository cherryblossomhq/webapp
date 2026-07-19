import { describe, expect, it } from "vitest";

import type { AnyCircuitElement } from "circuit-json";

import { overlayManualRoutes, liveRouteConnIds } from "./circuitJsonMerge";
import { connectionId } from "../shared/connectionId";
import type { ManualEditsMap, StableKey } from "../shared/types";

// Routes live in the sidecar keyed by the connection id of their endpoint pads
// (no <trace> in tsx). The fixture's source_trace connects R1.pin2 ↔ R2.pin1,
// so a sidecar route for it is stored under this id.
const ROUTE_KEY = connectionId("R1.pin2", "R2.pin1");

// A minimal but realistic circuit-json for two parts (R1, R2) connected by a
// single keyed trace, plus the autorouter's pcb_trace and one autorouted via.
// The selector pairing relies on source_component.name + source_port.port_hints
// matching the tsx trace's `path` selectors.
function fixture() {
  const tsx = `export default () => (
  <board width="40mm" height="30mm">
    <resistor key="t_r1" name="R1" resistance="1k" footprint="0805" pcbX="-10mm" pcbY="0mm" />
    <resistor key="t_r2" name="R2" resistance="1k" footprint="0805" pcbX="10mm" pcbY="0mm" />
    <trace key="t_trace1" path={[".R1 > .pin2", ".R2 > .pin1"]} />
  </board>
)
`;
  const circuitJson = [
    { type: "source_component", source_component_id: "sc1", name: "R1" },
    { type: "source_component", source_component_id: "sc2", name: "R2" },
    {
      type: "source_port",
      source_port_id: "sp1",
      source_component_id: "sc1",
      port_hints: ["pin2", "2"],
    },
    {
      type: "source_port",
      source_port_id: "sp2",
      source_component_id: "sc2",
      port_hints: ["pin1", "1"],
    },
    {
      type: "source_trace",
      source_trace_id: "st1",
      connected_source_port_ids: ["sp1", "sp2"],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "pt1",
      source_trace_id: "st1",
      subcircuit_id: "subc1",
      route: [
        { route_type: "wire", x: -9, y: 0, width: 0.25, layer: "top", start_pcb_port_id: "pp1" },
        { route_type: "wire", x: 9, y: 0, width: 0.25, layer: "top", end_pcb_port_id: "pp2" },
      ],
    },
    // An autorouter via that belongs to pt1 — it should be dropped on override.
    {
      type: "pcb_via",
      pcb_via_id: "auto_via",
      pcb_trace_id: "pt1",
      x: 0,
      y: 0,
      from_layer: "top",
      to_layer: "bottom",
      layers: ["top", "bottom"],
    },
  ] as unknown as AnyCircuitElement[];
  return { tsx, circuitJson };
}

function pcbTrace(json: unknown[]) {
  return json.find(
    (e): e is Record<string, unknown> =>
      !!e && typeof e === "object" && (e as Record<string, unknown>).type === "pcb_trace",
  );
}
function vias(json: unknown[]) {
  return json.filter(
    (e): e is Record<string, unknown> =>
      !!e && typeof e === "object" && (e as Record<string, unknown>).type === "pcb_via",
  );
}

describe("overlayManualRoutes", () => {
  it("keeps the autoroute when there are no manual routes (autoroute-by-default)", () => {
    // WYSIWYG: the canvas shows the autorouter's routes by default, so 3D /
    // DRC / fab must ship them too.
    const { circuitJson } = fixture();
    const merged = overlayManualRoutes(circuitJson, {});
    expect(
      (merged.find((e) => (e as Record<string, unknown>).type === "pcb_trace") as Record<string, unknown>)
        ?.pcb_trace_id,
    ).toBe("pt1");
    expect(
      (merged.find((e) => (e as Record<string, unknown>).type === "pcb_via") as Record<string, unknown>)
        ?.pcb_via_id,
    ).toBe("auto_via");
    // Non-routing elements are preserved.
    expect(merged.filter((e) => (e as Record<string, unknown>).type === "source_port")).toHaveLength(2);
  });

  it("drops an autoroute the user deleted (noAutoroute) along with its vias", () => {
    // Deleting a route on the canvas writes { noAutoroute: true } under the
    // connection id — the merge must hide the eval trace AND its linked
    // pcb_via so no floating hole ships (issue #23).
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: { pcb: { noAutoroute: true } },
    };
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    expect(merged.find((e) => (e as Record<string, unknown>).type === "pcb_trace")).toBeUndefined();
    expect(merged.find((e) => (e as Record<string, unknown>).type === "pcb_via")).toBeUndefined();
    expect(merged.filter((e) => (e as Record<string, unknown>).type === "source_port")).toHaveLength(2);
  });

  it("noAutoroute on one connection leaves other autoroutes untouched", () => {
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [connectionId("R9.pin1", "R8.pin2")]: { pcb: { noAutoroute: true } },
    };
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    expect(
      (merged.find((e) => (e as Record<string, unknown>).type === "pcb_trace") as Record<string, unknown>)
        ?.pcb_trace_id,
    ).toBe("pt1");
  });

  it("returns an empty array for empty/null input", () => {
    expect(overlayManualRoutes(null, {})).toEqual([]);
    expect(overlayManualRoutes([], {})).toEqual([]);
  });

  it("splices a single-layer manual route over the autoroute and drops its vias", () => {
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          width: 0.3,
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: -9, y: 5, layer: "top" },
            { x: 9, y: 5, layer: "top" },
            { x: 9, y: 0, layer: "top" },
          ],
        },
      },
    };

    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const trace = pcbTrace(merged) as Record<string, unknown>;
    const route = trace.route as Array<Record<string, unknown>>;

    expect(route).toHaveLength(4);
    expect(route.every((p) => p.route_type === "wire")).toBe(true);
    expect(route.every((p) => p.width === 0.3 && p.layer === "top")).toBe(true);
    // Endpoint port ids are carried over from the original route.
    expect(route[0].start_pcb_port_id).toBe("pp1");
    expect(route[route.length - 1].end_pcb_port_id).toBe("pp2");
    // The autorouter's via for this trace is gone; a single-layer route adds none.
    expect(vias(merged)).toHaveLength(0);
    // Other element types are preserved.
    expect(merged.filter((e) => (e as Record<string, unknown>).type === "source_port")).toHaveLength(2);
  });

  it("emits a via at a layer change and a matching pcb_via element", () => {
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "bottom" }, // via here (top → bottom)
            { x: 9, y: 0, layer: "bottom" },
          ],
        },
      },
    };

    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const trace = pcbTrace(merged) as Record<string, unknown>;
    const route = trace.route as Array<Record<string, unknown>>;

    const viaIdx = route.findIndex((p) => p.route_type === "via");
    const viaInRoute = route[viaIdx];
    expect(viaInRoute).toMatchObject({ x: 0, y: 0, from_layer: "top", to_layer: "bottom" });

    // Regression: tscircuit DRC flags a via as "misaligned" unless it is
    // flanked by wire points at the SAME (x,y) on both layers.
    const before = route[viaIdx - 1];
    const after = route[viaIdx + 1];
    expect(before.route_type).toBe("wire");
    expect(after.route_type).toBe("wire");
    expect(before.x).toBe(viaInRoute.x);
    expect(before.y).toBe(viaInRoute.y);
    expect(after.x).toBe(viaInRoute.x);
    expect(after.y).toBe(viaInRoute.y);
    expect(after.layer).toBe("bottom");

    // The closing wire lands on bottom and keeps the end port id.
    const lastWire = [...route].reverse().find((p) => p.route_type === "wire")!;
    expect(lastWire.layer).toBe("bottom");
    expect(lastWire.end_pcb_port_id).toBe("pp2");

    // Exactly one standalone pcb_via, linked to the synthesized trace (the
    // autorouter's auto_via was stripped).
    const v = vias(merged);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      pcb_trace_id: trace.pcb_trace_id,
      x: 0,
      y: 0,
      from_layer: "top",
      to_layer: "bottom",
    });
    expect(v[0].pcb_via_id).not.toBe("auto_via");
  });

  it("synthesizes a route that pairs to no source_trace (rendered from geometry)", () => {
    // The route's pads aren't a known source_trace. The drawn copper must
    // still appear (matching the canvas) — just with no source_trace_id — and
    // the autoroute it doesn't override (pt1) is kept.
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      ["conn_abc123" as StableKey]: {
        pcb: {
          route: [
            { x: 0, y: 0, layer: "top" },
            { x: 1, y: 1, layer: "top" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const traces = merged.filter(
      (e) => (e as Record<string, unknown>).type === "pcb_trace"
    ) as Array<Record<string, unknown>>;
    expect(traces).toHaveLength(2);
    expect(traces.some((t) => t.pcb_trace_id === "pt1")).toBe(true);
    const orphan = traces.find((t) => t.pcb_trace_id !== "pt1")!;
    expect(orphan.source_trace_id).toBeUndefined();
    expect(orphan.route).toHaveLength(2);
  });

  it("emits one pcb_via per layer change with unique ids for multi-via routes", () => {
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "bottom" }, // via 1: top → bottom
            { x: 0, y: 3, layer: "bottom" },
            { x: 0, y: 3, layer: "top" }, // via 2: bottom → top
            { x: 9, y: 0, layer: "top" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const v = vias(merged);
    expect(v).toHaveLength(2);
    expect(new Set(v.map((x) => x.pcb_via_id)).size).toBe(2);
    expect(v[0]).toMatchObject({ from_layer: "top", to_layer: "bottom" });
    expect(v[1]).toMatchObject({ from_layer: "bottom", to_layer: "top" });
  });

  it("collapses a tsx-baked <via> that coincides with a sidecar route via (issue #23)", () => {
    const { circuitJson } = fixture();
    // Simulate the <via> baked into tsx: the evaluator emits a standalone
    // pcb_via (no owning pcb_trace) at the same crossover the sidecar route
    // also produces. The merge must not ship two holes at (0,0).
    const withBakedVia = [
      ...circuitJson,
      {
        type: "pcb_via",
        pcb_via_id: "baked_via",
        x: 0,
        y: 0,
        from_layer: "bottom",
        to_layer: "top", // reversed order — still the same hole
        layers: ["bottom", "top"],
      },
    ] as unknown as AnyCircuitElement[];
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "bottom" }, // via at (0,0)
            { x: 9, y: 0, layer: "bottom" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes(withBakedVia, manualEdits);
    const v = vias(merged);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("inserts a leading wire when the layer change is not coincident with the previous point", () => {
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          // Layer flips at (9,5) but the previous point is (-9,0): the via must
          // still be flanked by a same-(x,y) wire on the from-layer.
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 9, y: 5, layer: "bottom" },
            { x: 9, y: 0, layer: "bottom" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const route = (pcbTrace(merged) as Record<string, unknown>).route as Array<
      Record<string, unknown>
    >;
    const viaIdx = route.findIndex((p) => p.route_type === "via");
    expect(route[viaIdx - 1]).toMatchObject({
      route_type: "wire",
      x: 9,
      y: 5,
      layer: "top",
    });
    expect(route[viaIdx]).toMatchObject({ x: 9, y: 5 });
  });

  it("binds to the first source_trace when a key pairs to more than one (first-write-wins)", () => {
    const { circuitJson } = fixture();
    // A second source_trace + pcb_trace with the SAME endpoint selectors as st1.
    const extra = [
      {
        type: "source_trace",
        source_trace_id: "st2",
        connected_source_port_ids: ["sp1", "sp2"],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "pt2",
        source_trace_id: "st2",
        route: [
          { route_type: "wire", x: -9, y: 0, layer: "top" },
          { route_type: "wire", x: 9, y: 0, layer: "top" },
        ],
      },
    ] as unknown as AnyCircuitElement[];
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 9, y: 0, layer: "top" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes([...circuitJson, ...extra], manualEdits);
    // Both autoroutes (pt1, pt2) are stripped; the manual route is synthesized
    // once, bound to the FIRST matching source_trace (st1).
    expect(
      merged.find((e) => {
        const id = (e as Record<string, unknown>).pcb_trace_id;
        return id === "pt1" || id === "pt2";
      })
    ).toBeUndefined();
    const synth = merged.filter(
      (e) => (e as Record<string, unknown>).type === "pcb_trace"
    );
    expect(synth).toHaveLength(1);
    expect((synth[0] as Record<string, unknown>).source_trace_id).toBe("st1");
  });

  it("synthesizes the route even when the source_trace has no pcb_trace (no port ids)", () => {
    // The autorouter produced no pcb_trace for this net (e.g. it failed / was
    // off), so there are no endpoint port ids to capture. The drawn copper must
    // still appear — bound to the source_trace, just without start/end port ids.
    const { circuitJson } = fixture();
    const noPcb = circuitJson.filter(
      (e) =>
        (e as Record<string, unknown>).type !== "pcb_trace" &&
        (e as Record<string, unknown>).type !== "pcb_via",
    );
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 9, y: 0, layer: "top" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes(noPcb, manualEdits);
    const trace = pcbTrace(merged) as Record<string, unknown> | undefined;
    expect(trace).toBeDefined();
    expect(trace!.source_trace_id).toBe("st1");
    const route = trace!.route as Array<Record<string, unknown>>;
    expect(route[0].start_pcb_port_id).toBeUndefined();
  });

  it("skips a route with a non-finite coord instead of splicing NaN into the json", () => {
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: Number.NaN, y: 5, layer: "top" },
            { x: 9, y: 0, layer: "top" },
          ],
        },
      },
    };
    // The bad route isn't shipped — and since it never became a valid
    // override, the autoroute for that connection survives instead. Either
    // way no NaN reaches the output.
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const traces = merged.filter(
      (e) => (e as Record<string, unknown>).type === "pcb_trace"
    ) as Array<Record<string, unknown>>;
    expect(traces).toHaveLength(1);
    expect(traces[0].pcb_trace_id).toBe("pt1");
  });

  it("reattaches subcircuit_id (captured before strip) to the synthesized trace and its via", () => {
    // The eval's pcb_trace carried subcircuit_id "subc1". The manual-only
    // synthesis must re-stamp it so DRC scopes the route to the right
    // subcircuit — on both the trace AND its via.
    const { circuitJson } = fixture();
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "top" },
            { x: 0, y: 0, layer: "bottom" }, // forces a via
            { x: 9, y: 0, layer: "bottom" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const trace = pcbTrace(merged) as Record<string, unknown>;
    expect(trace.subcircuit_id).toBe("subc1");
    const v = vias(merged);
    expect(v).toHaveLength(1);
    expect(v[0].subcircuit_id).toBe("subc1");
  });

  it("orients endpoint port ids by pad geometry for a reversed-direction route (issue #28)", () => {
    // The source trace orders ports pin2(pp1, at x=-9) → pin1(pp2, at x=9), so
    // the captured start=pp1 / end=pp2. The user draws the replacement route in
    // the OPPOSITE direction (pad at x=9 first, pad at x=-9 last). Positional
    // assignment would put pp1 on the x=9 endpoint — the wrong pad. The merge
    // must orient by geometry: the endpoint at x=-9 gets pp1, x=9 gets pp2.
    const { circuitJson } = fixture();
    // Add pads so each pcb_port_id has a physical position.
    const withPads = [
      ...circuitJson,
      { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_port_id: "pp1", x: -9, y: 0, layer: "top", shape: "rect", width: 1, height: 1 },
      { type: "pcb_smtpad", pcb_smtpad_id: "pad2", pcb_port_id: "pp2", x: 9, y: 0, layer: "top", shape: "rect", width: 1, height: 1 },
    ] as unknown as AnyCircuitElement[];
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: 9, y: 0, layer: "top" }, // drawn starting at pad pp2
            { x: 0, y: 3, layer: "top" },
            { x: -9, y: 0, layer: "top" }, // ending at pad pp1
          ],
        },
      },
    };
    const merged = overlayManualRoutes(withPads, manualEdits);
    const route = (pcbTrace(merged) as Record<string, unknown>).route as Array<
      Record<string, unknown>
    >;
    const firstWire = route[0];
    const lastWire = [...route].reverse().find((p) => p.route_type === "wire")!;
    // Geometry wins: the endpoint at x=9 (pad pp2) carries pp2, x=-9 carries pp1.
    expect(firstWire.x).toBe(9);
    expect(firstWire.start_pcb_port_id).toBe("pp2");
    expect(lastWire.x).toBe(-9);
    expect(lastWire.end_pcb_port_id).toBe("pp1");
  });

  it("keeps the positional order for a forward-direction route", () => {
    // Same pads, but drawn in the source trace's order (pp1 at x=-9 first). No
    // swap — start=pp1 on the first point, end=pp2 on the last.
    const { circuitJson } = fixture();
    const withPads = [
      ...circuitJson,
      { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_port_id: "pp1", x: -9, y: 0, layer: "top", shape: "rect", width: 1, height: 1 },
      { type: "pcb_smtpad", pcb_smtpad_id: "pad2", pcb_port_id: "pp2", x: 9, y: 0, layer: "top", shape: "rect", width: 1, height: 1 },
    ] as unknown as AnyCircuitElement[];
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -9, y: 0, layer: "top" },
            { x: 9, y: 0, layer: "top" },
          ],
        },
      },
    };
    const merged = overlayManualRoutes(withPads, manualEdits);
    const route = (pcbTrace(merged) as Record<string, unknown>).route as Array<
      Record<string, unknown>
    >;
    expect(route[0].start_pcb_port_id).toBe("pp1");
    expect(route[route.length - 1].end_pcb_port_id).toBe("pp2");
  });

  it("keeps coincident vias from DIFFERENT routes (no cross-net collapse)", () => {
    // Two distinct sidecar routes (distinct connection ids → distinct
    // synthesized pcb_traces) both change layer at the same (x,y). These are two
    // physical holes on two nets; collapsing them would short the nets or drop a
    // real hole. dedupeCoincidentVias is scoped per-trace, so both survive.
    const { circuitJson } = fixture();
    const viaRoute = (): { route: Array<{ x: number; y: number; layer: "top" | "bottom" }> } => ({
      route: [
        { x: -5, y: 0, layer: "top" },
        { x: 0, y: 0, layer: "top" },
        { x: 0, y: 0, layer: "bottom" }, // via at (0,0)
        { x: 5, y: 0, layer: "bottom" },
      ],
    });
    const manualEdits: ManualEditsMap = {
      [ROUTE_KEY]: { pcb: viaRoute() },
      // A second, unrelated route (orphan key — pairs to no source_trace).
      ["conn_dead11" as StableKey]: { pcb: viaRoute() },
    };
    const merged = overlayManualRoutes(circuitJson, manualEdits);
    const v = vias(merged);
    expect(v).toHaveLength(2);
    // The two holes belong to two distinct synthesized traces.
    expect(new Set(v.map((x) => x.pcb_trace_id)).size).toBe(2);
  });
});

describe("liveRouteConnIds", () => {
  // A power net: R1.pin1 and R2.pin1 both wired to net VCC (each pad→net, never
  // pad→pad). Crucially, the named alias "left" leads the port_hints — proving
  // the set is keyed off the numeric first-hint ("1" → pin1), the SAME space as
  // the route key, NOT the authored pin label. (Issue #27 regression guard: a
  // tsx-derived set would key off "left" and silently prune this route.)
  function powerNet(): AnyCircuitElement[] {
    return [
      { type: "source_component", source_component_id: "sc1", name: "R1" },
      { type: "source_component", source_component_id: "sc2", name: "R2" },
      {
        type: "source_port",
        source_port_id: "sp1",
        source_component_id: "sc1",
        port_hints: ["1", "left"],
      },
      {
        type: "source_port",
        source_port_id: "sp2",
        source_component_id: "sc2",
        port_hints: ["1", "left"],
      },
      {
        type: "source_trace",
        source_trace_id: "st1",
        connected_source_port_ids: ["sp1"],
        connected_source_net_ids: ["sn_vcc"],
      },
      {
        type: "source_trace",
        source_trace_id: "st2",
        connected_source_port_ids: ["sp2"],
        connected_source_net_ids: ["sn_vcc"],
      },
    ] as unknown as AnyCircuitElement[];
  }

  it("returns null for empty/null input (caller must keep all routes)", () => {
    expect(liveRouteConnIds(null)).toBeNull();
    expect(liveRouteConnIds(undefined)).toBeNull();
    expect(liveRouteConnIds([])).toBeNull();
  });

  it("pairs two pads that share a net, keyed in pinN space (named aliases ignored)", () => {
    const set = liveRouteConnIds(powerNet())!;
    // The route key the PCB canvas actually stores (pinN selectors).
    expect(set.has(connectionId("R1.pin1", "R2.pin1"))).toBe(true);
    // The authored-label form must NOT be what we key on.
    expect(set.has(connectionId("R1.left", "R2.left"))).toBe(false);
  });

  it("pairs two pads joined by a direct pin↔pin trace", () => {
    const json = [
      { type: "source_component", source_component_id: "sc1", name: "R1" },
      { type: "source_component", source_component_id: "sc2", name: "C1" },
      {
        type: "source_port",
        source_port_id: "sp1",
        source_component_id: "sc1",
        port_hints: ["2", "pin2"],
      },
      {
        type: "source_port",
        source_port_id: "sp2",
        source_component_id: "sc2",
        port_hints: ["1", "pin1"],
      },
      {
        type: "source_trace",
        source_trace_id: "st1",
        connected_source_port_ids: ["sp1", "sp2"],
      },
    ] as unknown as AnyCircuitElement[];
    const set = liveRouteConnIds(json)!;
    expect(set.has(connectionId("R1.pin2", "C1.pin1"))).toBe(true);
    expect(set.size).toBe(1);
  });

  it("emits every pad-pair for a 3-pad net", () => {
    const json = [
      { type: "source_component", source_component_id: "sc1", name: "R1" },
      { type: "source_component", source_component_id: "sc2", name: "R2" },
      { type: "source_component", source_component_id: "sc3", name: "R3" },
      { type: "source_port", source_port_id: "sp1", source_component_id: "sc1", port_hints: ["1"] },
      { type: "source_port", source_port_id: "sp2", source_component_id: "sc2", port_hints: ["1"] },
      { type: "source_port", source_port_id: "sp3", source_component_id: "sc3", port_hints: ["1"] },
      { type: "source_trace", source_trace_id: "st1", connected_source_port_ids: ["sp1"], connected_source_net_ids: ["gnd"] },
      { type: "source_trace", source_trace_id: "st2", connected_source_port_ids: ["sp2"], connected_source_net_ids: ["gnd"] },
      { type: "source_trace", source_trace_id: "st3", connected_source_port_ids: ["sp3"], connected_source_net_ids: ["gnd"] },
    ] as unknown as AnyCircuitElement[];
    const set = liveRouteConnIds(json)!;
    expect(set.has(connectionId("R1.pin1", "R2.pin1"))).toBe(true);
    expect(set.has(connectionId("R1.pin1", "R3.pin1"))).toBe(true);
    expect(set.has(connectionId("R2.pin1", "R3.pin1"))).toBe(true);
    expect(set.size).toBe(3);
  });

  it("does NOT pair pads on different nets (a cross-net route is not live)", () => {
    const json = [
      { type: "source_component", source_component_id: "sc1", name: "R1" },
      { type: "source_component", source_component_id: "sc2", name: "R2" },
      { type: "source_port", source_port_id: "sp1", source_component_id: "sc1", port_hints: ["1"] },
      { type: "source_port", source_port_id: "sp2", source_component_id: "sc2", port_hints: ["1"] },
      { type: "source_trace", source_trace_id: "st1", connected_source_port_ids: ["sp1"], connected_source_net_ids: ["vcc"] },
      { type: "source_trace", source_trace_id: "st2", connected_source_port_ids: ["sp2"], connected_source_net_ids: ["gnd"] },
    ] as unknown as AnyCircuitElement[];
    const set = liveRouteConnIds(json)!;
    expect(set.has(connectionId("R1.pin1", "R2.pin1"))).toBe(false);
    expect(set.size).toBe(0);
  });

  it("includes the synthetic pcbtrace_ key of an eval trace that resolves no pad pair", () => {
    // A noAutoroute marker on such a trace is stored under the
    // `pcbtrace_<pcb_trace_id>` fallback key (evalTraceEndpoints). It must be
    // live — survive pruneOrphanEdits at save time — for as long as the trace
    // is in the circuit-json, or the user's deletion reappears after reload.
    const trace = {
      type: "pcb_trace",
      pcb_trace_id: "pt_orphan",
      route: [
        { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.15 },
        { route_type: "wire", x: 1, y: 0, layer: "top", width: 0.15 },
      ],
    };
    const withTrace = liveRouteConnIds([
      ...powerNet(),
      trace,
    ] as unknown as AnyCircuitElement[])!;
    expect(withTrace.has("pcbtrace_pt_orphan" as StableKey)).toBe(true);
    // Pad-pair liveness is unaffected by the extra keys.
    expect(withTrace.has(connectionId("R1.pin1", "R2.pin1"))).toBe(true);
    // Trace gone from the eval → its synthetic key goes with it (the marker
    // is orphaned and prunable).
    const withoutTrace = liveRouteConnIds(powerNet())!;
    expect(withoutTrace.has("pcbtrace_pt_orphan" as StableKey)).toBe(false);
  });
});
