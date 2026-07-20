import { describe, expect, it } from "vitest";
import {
  buildPcbModel,
  normalizePadSelector,
  pcbComponentDisplayBbox,
  withAutoPlacedPins,
} from "./pcbModel";
import type { PcbComponentRecord } from "./pcbModel";
import { computeRatsnest } from "./ratsnest";
import { connectionId } from "@/editor/shared/connectionId";
import type { ManualEditsMap } from "@/editor/shared/types";

// Minimal circuit-json fixture: 1 board + 2 resistors with SMT pads + a
// source_trace connecting R1.pin1 ↔ R2.pin1. There is no <trace> in the tsx —
// PCB route geometry lives only in the sidecar, keyed by the connection id of
// its endpoint pads (see PcbCanvas.commitRoute / pcbModel Phase 5).
const TSX_FIXTURE = `export default () => (
  <board width="10mm" height="10mm">
    <resistor key="r_abc123" name="R1" resistance="1k" footprint="0402" pcbX={0} pcbY={0} />
    <resistor key="r_xyz789" name="R2" resistance="1k" footprint="0402" pcbX={3} pcbY={0} />
  </board>
)`;

// The sidecar key for a route over the fixture's source_trace (R1.pin1↔R2.pin1).
const ROUTE_KEY = connectionId("R1.pin1", "R2.pin1");

function fakePcbJson(): unknown[] {
  return [
    {
      type: "pcb_board",
      pcb_board_id: "b1",
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
    },
    {
      type: "source_component",
      source_component_id: "sc_r1",
      name: "R1",
      ftype: "simple_resistor",
    },
    {
      type: "source_component",
      source_component_id: "sc_r2",
      name: "R2",
      ftype: "simple_resistor",
    },
    {
      type: "source_port",
      source_port_id: "sp_r1_1",
      source_component_id: "sc_r1",
      port_hints: ["1", "left"],
      name: "1",
    },
    {
      type: "source_port",
      source_port_id: "sp_r1_2",
      source_component_id: "sc_r1",
      port_hints: ["2", "right"],
      name: "2",
    },
    {
      type: "source_port",
      source_port_id: "sp_r2_1",
      source_component_id: "sc_r2",
      port_hints: ["1", "left"],
      name: "1",
    },
    {
      type: "source_trace",
      source_trace_id: "st_1",
      connected_source_port_ids: ["sp_r1_1", "sp_r2_1"],
    },
    {
      type: "pcb_component",
      pcb_component_id: "pc_r1",
      source_component_id: "sc_r1",
      center: { x: 0, y: 0 },
      layer: "top",
      rotation: 0,
      width: 1.2,
      height: 0.6,
    },
    {
      type: "pcb_component",
      pcb_component_id: "pc_r2",
      source_component_id: "sc_r2",
      center: { x: 3, y: 0 },
      layer: "top",
      rotation: 0,
      width: 1.2,
      height: 0.6,
    },
    {
      type: "pcb_port",
      pcb_port_id: "pp_r1_1",
      pcb_component_id: "pc_r1",
      source_port_id: "sp_r1_1",
    },
    {
      type: "pcb_port",
      pcb_port_id: "pp_r1_2",
      pcb_component_id: "pc_r1",
      source_port_id: "sp_r1_2",
    },
    {
      type: "pcb_port",
      pcb_port_id: "pp_r2_1",
      pcb_component_id: "pc_r2",
      source_port_id: "sp_r2_1",
    },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pad_r1_1",
      pcb_component_id: "pc_r1",
      pcb_port_id: "pp_r1_1",
      shape: "rect",
      x: -0.4,
      y: 0,
      width: 0.5,
      height: 0.4,
      layer: "top",
      port_hints: ["1"],
    },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pad_r1_2",
      pcb_component_id: "pc_r1",
      pcb_port_id: "pp_r1_2",
      shape: "rect",
      x: 0.4,
      y: 0,
      width: 0.5,
      height: 0.4,
      layer: "top",
      port_hints: ["2"],
    },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: "pad_r2_1",
      pcb_component_id: "pc_r2",
      pcb_port_id: "pp_r2_1",
      shape: "rect",
      x: 2.6,
      y: 0,
      width: 0.5,
      height: 0.4,
      layer: "top",
      port_hints: ["1"],
    },
  ];
}

describe("buildPcbModel", () => {
  it("returns the empty model for null circuitJson", () => {
    const m = buildPcbModel(null, "", {});
    expect(m.components).toEqual([]);
    expect(m.pads).toEqual([]);
    expect(m.board).toBeNull();
  });

  it("returns the empty model for an empty array", () => {
    const m = buildPcbModel([], "", {});
    expect(m.components).toEqual([]);
  });

  it("extracts the board outline", () => {
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, {});
    expect(m.board).toMatchObject({
      centerX: 0,
      centerY: 0,
      width: 10,
      height: 10,
    });
  });

  it("resolves pcb_component to a tsx stable key by name", () => {
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, {});
    const r1 = m.components.find((c) => c.name === "R1");
    expect(r1).toBeDefined();
    expect(r1!.key).toBe("r_abc123");
    expect(r1!.x).toBe(0);
    expect(r1!.y).toBe(0);
    // The fixture pins R1 with explicit pcbX/pcbY, so it counts as placed
    // (tsx is the source of truth for layout — Option B), even with no sidecar.
    expect(r1!.manuallyPlaced).toBe(true);
  });

  it("applies tsx layer prop to the component body and its SMT pads", () => {
    const tsx = TSX_FIXTURE.replace(
      'name="R1"',
      'name="R1" layer="bottom"'
    );
    const m = buildPcbModel(fakePcbJson() as never, tsx, {});
    const r1 = m.components.find((c) => c.name === "R1");
    expect(r1!.layer).toBe("bottom");
    const r1Pads = m.pads.filter((p) => p.componentKey === "r_abc123");
    expect(r1Pads.length).toBe(2);
    for (const pad of r1Pads) expect(pad.layer).toBe("bottom");

    const r2Pads = m.pads.filter((p) => p.componentKey === "r_xyz789");
    expect(r2Pads.length).toBe(1);
    for (const pad of r2Pads) expect(pad.layer).toBe("top");
  });

  it("applies tsx layer to through-hole pads on the parent component", () => {
    const json = fakePcbJson();
    json.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "th_j1",
      pcb_component_id: "pc_r1",
      shape: "circle",
      x: 0,
      y: 0,
      outer_diameter: 1,
      hole_diameter: 0.4,
      layer: "top",
    } as never);
    const tsx = TSX_FIXTURE.replace(
      'name="R1"',
      'name="R1" layer="bottom"'
    );
    const m = buildPcbModel(json as never, tsx, {});
    const th = m.pads.find((p) => p.isThroughHole);
    expect(th?.layer).toBe("bottom");
  });

  it("parses pin-1 rect-pad plated holes (circular_hole_with_rect_pad)", () => {
    const json = fakePcbJson();
    json.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "th_pin1",
      pcb_component_id: "pc_r1",
      shape: "circular_hole_with_rect_pad",
      hole_shape: "circle",
      pad_shape: "rect",
      x: 2,
      y: 3,
      hole_diameter: 1,
      rect_pad_width: 1.7,
      rect_pad_height: 1.7,
      hole_offset_x: 0,
      hole_offset_y: 0,
      layers: ["top", "bottom"],
    } as never);
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    const th = m.pads.find((p) => p.pcbPlatedHoleId === "th_pin1");
    expect(th).toBeDefined();
    expect(th!.isThroughHole).toBe(true);
    // The square pad must carry its real dimensions. This variant has no
    // outer_diameter — the old parse fell back to a 0.8mm ring that the 1.0mm
    // drill painted over entirely, leaving the pad invisible.
    expect(th!.shape).toBe("rect");
    expect(th!.rectWidth).toBeCloseTo(1.7);
    expect(th!.rectHeight).toBeCloseTo(1.7);
    expect(th!.drillDiameter).toBeCloseTo(1);
  });

  it("parses oval plated holes into pill pads with slot drills", () => {
    const json = fakePcbJson();
    json.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "th_slot",
      pcb_component_id: "pc_r1",
      shape: "oval",
      x: 0,
      y: 0,
      outer_width: 1.8,
      outer_height: 1.2,
      hole_width: 1.0,
      hole_height: 0.6,
      layers: ["top", "bottom"],
    } as never);
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    const th = m.pads.find((p) => p.pcbPlatedHoleId === "th_slot");
    expect(th!.shape).toBe("pill");
    expect(th!.rectWidth).toBeCloseTo(1.8);
    expect(th!.rectHeight).toBeCloseTo(1.2);
    expect(th!.drillWidth).toBeCloseTo(1.0);
    expect(th!.drillHeight).toBeCloseTo(0.6);
  });

  it("sizes circular plated-hole radius from outer_diameter", () => {
    const json = fakePcbJson();
    json.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "th_round",
      pcb_component_id: "pc_r1",
      shape: "circle",
      x: 0,
      y: 0,
      outer_diameter: 1.6,
      hole_diameter: 0.8,
      layers: ["top", "bottom"],
    } as never);
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    const th = m.pads.find((p) => p.pcbPlatedHoleId === "th_round");
    expect(th!.outerDiameter).toBeCloseTo(1.6);
    // radius mirrors the ring so padWorldCorners / obstacles see true extents.
    expect(th!.radius).toBeCloseTo(0.8);
  });

  it("treats a component WITHOUT pcbX/pcbY as auto-placed (not manuallyPlaced)", () => {
    // No pcbX/pcbY → the part is auto-laid-out, so it renders faded.
    const tsx = `export default () => (
      <board width="10mm" height="10mm">
        <resistor key="r_abc123" name="R1" resistance="1k" footprint="0402" />
      </board>
    )`;
    const json = [
      { type: "pcb_board", pcb_board_id: "b1", center: { x: 0, y: 0 }, width: 10, height: 10 },
      { type: "source_component", source_component_id: "sc_r1", name: "R1", ftype: "simple_resistor" },
      {
        type: "pcb_component",
        pcb_component_id: "pc_r1",
        source_component_id: "sc_r1",
        center: { x: 0, y: 0 },
        layer: "top",
        rotation: 0,
        width: 1.2,
        height: 0.6,
      },
    ];
    const m = buildPcbModel(json as never, tsx, {});
    const r1 = m.components.find((c) => c.name === "R1");
    expect(r1!.manuallyPlaced).toBe(false);
  });

  it("applies manualEdits.pcb position override (x/y only)", () => {
    const edits: ManualEditsMap = {
      r_abc123: { pcb: { x: 7, y: 8 } },
    };
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, edits);
    const r1 = m.components.find((c) => c.name === "R1");
    expect(r1!.x).toBe(7);
    expect(r1!.y).toBe(8);
    expect(r1!.rotationDeg).toBe(0);
    expect(r1!.originRotationDeg).toBe(0);
    expect(r1!.manuallyPlaced).toBe(true);
  });

  it("does not double-rotate pads once eval lands the same rotation", () => {
    // After eval, circuit-json carries rotation=90 with pad positions and
    // dimensions already in the rotated frame. Applying the full 90° again
    // on top made copper shrink / flip ~1s after R-press (post-reconcile).
    const json = fakePcbJson().map((el) => {
      const r = el as Record<string, unknown>;
      if (r.type === "pcb_component" && r.pcb_component_id === "pc_r1") {
        return { ...r, rotation: 90, width: 0.64, height: 1.56 };
      }
      if (r.type === "pcb_smtpad" && r.pcb_component_id === "pc_r1") {
        const x = r.x as number;
        const y = r.y as number;
        return {
          ...r,
          x: -y,
          y: x,
          width: 0.64,
          height: 0.54,
        };
      }
      return el;
    });
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    const r1Pads = m.pads.filter((p) => p.pcbComponentId === "pc_r1");
    for (const p of r1Pads) {
      expect(p.rotationDeg).toBe(0);
    }
  });

  it("uses circuit-json dims at effective rotation when no pads are available", () => {
    const comp = {
      width: 1.56,
      height: 0.64,
      rotationDeg: 90,
      originRotationDeg: 0,
    };
    expect(pcbComponentDisplayBbox(comp)).toEqual({
      width: 1.56,
      height: 0.64,
      rotationDeg: 90,
    });
  });

  it("derives courtyard rotation from pad world geometry (encoding-agnostic)", () => {
    const comp = {
      width: 1.56,
      height: 0.64,
      rotationDeg: 45,
      originRotationDeg: 0,
    };
    expect(pcbComponentDisplayBbox(comp)).toEqual({
      width: 1.56,
      height: 0.64,
      rotationDeg: 45,
    });
  });

  it("derives a rotated local bbox for oblique reconciled parts", () => {
    const comp = {
      key: "r_abc123" as const,
      x: 0,
      y: 0,
      width: 1.261,
      height: 1.361,
      rotationDeg: 45,
      originRotationDeg: 45,
    };
    const pads = [
      {
        componentKey: "r_abc123" as const,
        x: -0.361,
        y: -0.361,
        rotationDeg: 45,
        shape: "rect" as const,
        rectWidth: 0.54,
        rectHeight: 0.64,
      },
      {
        componentKey: "r_abc123" as const,
        x: 0.361,
        y: 0.361,
        rotationDeg: 45,
        shape: "rect" as const,
        rectWidth: 0.54,
        rectHeight: 0.64,
      },
    ];
    const display = pcbComponentDisplayBbox(comp, pads);
    expect(display.rotationDeg).toBeGreaterThan(40);
    expect(display.rotationDeg).toBeLessThan(50);
    expect(display.width).toBeGreaterThan(0.9);
    expect(display.height).toBeGreaterThan(0.5);
  });

  it("derives bounds from pad world geometry regardless of originRotationDeg", () => {
    const comp = {
      key: "r_abc123" as const,
      x: 0,
      y: 0,
      width: 1.261,
      height: 1.361,
      rotationDeg: 135,
      originRotationDeg: 45,
    };
    const pads = [
      {
        componentKey: "r_abc123" as const,
        x: -0.5,
        y: 0.5,
        rotationDeg: 135,
        shape: "rect" as const,
        rectWidth: 0.54,
        rectHeight: 0.64,
      },
      {
        componentKey: "r_abc123" as const,
        x: 0.5,
        y: -0.5,
        rotationDeg: 135,
        shape: "rect" as const,
        rectWidth: 0.54,
        rectHeight: 0.64,
      },
    ];
    const display = pcbComponentDisplayBbox(comp, pads);
    // OBB follows pad layout in world space, not circuit-json encoding.
    expect(display.rotationDeg).toBeGreaterThan(40);
    expect(display.rotationDeg).toBeLessThan(50);
    expect(display.width).toBeGreaterThan(0.5);
    expect(display.height).toBeGreaterThan(0.5);
  });

  it("uses ccw_rotation as pad base rotation for oblique eval angles", () => {
    const json = fakePcbJson().map((el) => {
      const r = el as Record<string, unknown>;
      if (r.type === "pcb_component" && r.pcb_component_id === "pc_r1") {
        return {
          ...r,
          rotation: 45,
          width: 1.261,
          height: 1.361,
        };
      }
      if (r.type === "pcb_smtpad" && r.pcb_component_id === "pc_r1") {
        return {
          ...r,
          shape: "rotated_rect",
          ccw_rotation: 45,
          x: -0.361,
          y: -0.361,
        };
      }
      return el;
    });
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    const r1Pads = m.pads.filter((p) => p.pcbComponentId === "pc_r1");
    for (const p of r1Pads) {
      expect(p.rotationDeg).toBe(45);
    }
  });

  it("indexes pads by selector for trace endpoint resolution", () => {
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, {});
    // Numeric port hints are converted to `pinN` form to match tscircuit's
    // `.R1 > .pin1` selector convention. Named hints (e.g. "left") pass
    // through untouched.
    const padBySelector = m.padBySelector;
    expect(padBySelector.has(normalizePadSelector(".R1 > .pin1"))).toBe(true);
    expect(padBySelector.has(normalizePadSelector(".R1 > .left"))).toBe(true);
  });

  it("includes unrouted nets for ratsnest when no route exists", () => {
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, {});
    expect(m.unroutedNets.length).toBeGreaterThan(0);
    const net = m.unroutedNets[0];
    expect(net.pads.length).toBe(2);
  });

  it("renders a sidecar route even when no source_trace exists for it", () => {
    // The user finished a route between two pads with no source_trace in the
    // current circuitJson (either the eval hasn't caught up, or the pads aren't
    // connected in `connections` yet). Routes render straight from the sidecar
    // — decoupled from the eval — so the copper appears immediately instead of
    // vanishing until the next eval lands. Key is the endpoints' connection id.
    const key = connectionId("R1.pin2", "R2.pin1"); // no source_trace in fixture
    const edits: ManualEditsMap = {
      [key]: {
        pcb: {
          route: [
            { x: 0.4, y: 0, layer: "top" },
            { x: 2.6, y: 0, layer: "top" },
          ],
          width: 0.25,
        },
      },
    };
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, edits);
    const t = m.traces.find((tr) => tr.key === key);
    expect(t).toBeDefined();
    expect(t!.userRouted).toBe(true);
    expect(t!.segments).toHaveLength(1);
  });

  // A json fixture whose net (R1.pin1 ↔ R2.pin1) was routed by the eval's
  // autorouter. No endpoint port ids on the route — the key falls back to the
  // source_trace pairing, which is the same connection id (ROUTE_KEY).
  function fakePcbJsonWithAutoroute(): unknown[] {
    return [
      ...fakePcbJson(),
      {
        type: "pcb_trace",
        pcb_trace_id: "pt_1",
        source_trace_id: "st_1",
        route: [
          { route_type: "wire", x: -0.4, y: 0, layer: "top", width: 0.15 },
          { route_type: "wire", x: 2.6, y: 0, layer: "top", width: 0.15 },
        ],
      },
    ];
  }

  it("renders eval pcb_trace routes by default (autoroute-on)", () => {
    const m = buildPcbModel(fakePcbJsonWithAutoroute() as never, TSX_FIXTURE, {});
    const t = m.traces.find((tr) => tr.key === ROUTE_KEY);
    expect(t).toBeDefined();
    expect(t!.userRouted).toBe(false);
    expect(t!.segments).toHaveLength(1);
    expect(t!.fromSelector).toBe("r1.pin1");
    expect(t!.toSelector).toBe("r2.pin1");
    // Displayed copper joins the net's pads — no airwire over it.
    expect(m.unroutedNets).toHaveLength(0);
  });

  it("hides a deleted autoroute (noAutoroute) and brings back the airwire", () => {
    const edits: ManualEditsMap = {
      [ROUTE_KEY]: { pcb: { noAutoroute: true } },
    };
    const m = buildPcbModel(fakePcbJsonWithAutoroute() as never, TSX_FIXTURE, edits);
    expect(m.traces).toHaveLength(0);
    expect(m.unroutedNets.length).toBeGreaterThan(0);
  });

  it("a manual sidecar route overrides the eval route for its connection", () => {
    const edits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -0.4, y: 0, layer: "top" },
            { x: -0.4, y: 1, layer: "top" },
            { x: 2.6, y: 1, layer: "top" },
            { x: 2.6, y: 0, layer: "top" },
          ],
          width: 0.3,
        },
      },
    };
    const m = buildPcbModel(fakePcbJsonWithAutoroute() as never, TSX_FIXTURE, edits);
    // Exactly one trace for the connection — the manual one.
    const matching = m.traces.filter((tr) => tr.key === ROUTE_KEY);
    expect(matching).toHaveLength(1);
    expect(matching[0].userRouted).toBe(true);
    expect(matching[0].segments).toHaveLength(3);
  });

  it("keys an eval trace by its route's endpoint port ids when present", () => {
    // start/end_pcb_port_id name the pads the autorouter actually landed on
    // (here R1.pin2 ↔ R2.pin1) and win over the source_trace fallback
    // (which would pair R1.pin1 ↔ R2.pin1).
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_trace",
        pcb_trace_id: "pt_2",
        source_trace_id: "st_1",
        route: [
          {
            route_type: "wire",
            x: 0.4,
            y: 0,
            layer: "top",
            width: 0.15,
            start_pcb_port_id: "pp_r1_2",
          },
          {
            route_type: "wire",
            x: 2.6,
            y: 0,
            layer: "top",
            width: 0.15,
            end_pcb_port_id: "pp_r2_1",
          },
        ],
      },
    ];
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    const t = m.traces[0];
    expect(t).toBeDefined();
    expect(t.key).toBe(connectionId("R1.pin2", "R2.pin1"));
    expect(t.fromSelector).toBe("r1.pin2");
    expect(t.toSelector).toBe("r2.pin1");
  });

  it("renders a sidecar route over its net (userRouted=true)", () => {
    const edits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -0.4, y: 0, layer: "top" },
            { x: 1, y: 0, layer: "top" },
            { x: 1, y: 1.5, layer: "top" },
            { x: 2.6, y: 1.5, layer: "top" },
            { x: 2.6, y: 0, layer: "top" },
          ],
          width: 0.25,
        },
      },
    };
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, edits);
    const t = m.traces.find((tr) => tr.key === ROUTE_KEY);
    expect(t).toBeDefined();
    expect(t!.userRouted).toBe(true);
    // The route recovers its net's endpoint selectors from the source_trace.
    expect(t!.fromSelector).toBe("r1.pin1");
    expect(t!.toSelector).toBe("r2.pin1");
    // 4 segments for 5 points.
    expect(t!.segments).toHaveLength(4);
    expect(t!.segments[0].layer).toBe("top");
    expect(t!.segments[0].width).toBe(0.25);
  });

  it("a sidecar route keyed by its connection id suppresses that net's ratsnest", () => {
    // Regression: a routed net must NOT also draw a ratsnest airwire over its
    // copper. The route is keyed by connectionId(endpoints) — the same id Phase
    // 8 recomputes from the source_trace's pads — so the two agree and the net
    // is recognised as routed. (When the key didn't match, the net resurfaced
    // in unroutedNets and an airwire drew over the route.)
    const edits: ManualEditsMap = {
      [ROUTE_KEY]: {
        pcb: {
          route: [
            { x: -0.4, y: 0, layer: "top" },
            { x: 2.6, y: 0, layer: "top" },
          ],
          width: 0.25,
        },
      },
    };
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, edits);
    // Rendered exactly once, as user-routed copper.
    const matches = m.traces.filter((tr) => tr.key === ROUTE_KEY);
    expect(matches).toHaveLength(1);
    expect(matches[0].userRouted).toBe(true);
    // No ghost ratsnest over the routed net.
    expect(m.unroutedNets).toHaveLength(0);
    // …but the net stays in model.nets so focus / rip-up can find it once routed.
    const net = m.nets.find((n) => n.traceKey === ROUTE_KEY);
    expect(net).toBeTruthy();
    expect(net!.pads).toHaveLength(2);
  });

  // ─── pin→net ratsnest (issue #24) ──────────────────────────────────────
  // A power/ground net: each pad is wired pad→net (never pad→pad), so there's
  // no 2-port source_trace. The ratsnest must still group the pads by net and
  // draw the MST. Three single-pad parts (R1/R2/R3) joined to one net "GND".
  const NET_TSX = `export default () => (
    <board width="20mm" height="10mm">
      <resistor key="r_a" name="R1" resistance="1k" footprint="0402" pcbX={0} pcbY={0} />
      <resistor key="r_b" name="R2" resistance="1k" footprint="0402" pcbX={3} pcbY={0} />
      <resistor key="r_c" name="R3" resistance="1k" footprint="0402" pcbX={6} pcbY={0} />
    </board>
  )`;
  function netPcbJson(): unknown[] {
    const part = (n: string, sc: string, sp: string, pc: string, x: number) => [
      { type: "source_component", source_component_id: sc, name: n, ftype: "simple_resistor" },
      { type: "source_port", source_port_id: sp, source_component_id: sc, port_hints: ["1"], name: "1" },
      {
        type: "pcb_component",
        pcb_component_id: pc,
        source_component_id: sc,
        center: { x, y: 0 },
        layer: "top",
        rotation: 0,
        width: 1.2,
        height: 0.6,
      },
      { type: "pcb_port", pcb_port_id: `pp_${sp}`, pcb_component_id: pc, source_port_id: sp },
      {
        type: "pcb_smtpad",
        pcb_smtpad_id: `pad_${sp}`,
        pcb_component_id: pc,
        pcb_port_id: `pp_${sp}`,
        shape: "rect",
        x,
        y: 0,
        width: 0.5,
        height: 0.4,
        layer: "top",
        port_hints: ["1"],
      },
    ];
    return [
      { type: "pcb_board", pcb_board_id: "b1", center: { x: 0, y: 0 }, width: 20, height: 10 },
      { type: "source_net", source_net_id: "net_gnd", name: "GND" },
      ...part("R1", "sc_a", "sp_a", "pc_a", 0),
      ...part("R2", "sc_b", "sp_b", "pc_b", 3),
      ...part("R3", "sc_c", "sp_c", "pc_c", 6),
      // pad→net membership: each pad wired to GND, no pad↔pad trace.
      { type: "source_trace", source_trace_id: "st_a", connected_source_port_ids: ["sp_a"], connected_source_net_ids: ["net_gnd"] },
      { type: "source_trace", source_trace_id: "st_b", connected_source_port_ids: ["sp_b"], connected_source_net_ids: ["net_gnd"] },
      { type: "source_trace", source_trace_id: "st_c", connected_source_port_ids: ["sp_c"], connected_source_net_ids: ["net_gnd"] },
    ];
  }

  it("ratsnests a pin→net power/ground net (no 2-port trace)", () => {
    const m = buildPcbModel(netPcbJson() as never, NET_TSX, {});
    // The three GND pads form one net even though each is wired pad→net.
    expect(m.unroutedNets).toHaveLength(1);
    expect(m.unroutedNets[0].pads).toHaveLength(3);
    // MST over the three collinear pads → 2 airwires, total length 6.
    const edges = computeRatsnest(m);
    expect(edges).toHaveLength(2);
    const total = edges.reduce(
      (a, e) => a + Math.hypot(e.toX - e.fromX, e.toY - e.fromY),
      0
    );
    expect(total).toBeCloseTo(6);
  });

  it("drops airwires over routed pads but keeps ratsnesting the rest of a net", () => {
    // Route R1.pin1 ↔ R2.pin1 within the GND net. Those two pads are now
    // connected by copper, so the ratsnest collapses to a single airwire from
    // the routed cluster to R3 — no ghost airwire over the route.
    const edits: ManualEditsMap = {
      [connectionId("R1.pin1", "R2.pin1")]: {
        pcb: {
          route: [
            { x: 0, y: 0, layer: "top" },
            { x: 3, y: 0, layer: "top" },
          ],
          width: 0.25,
        },
      },
    };
    const m = buildPcbModel(netPcbJson() as never, NET_TSX, edits);
    expect(m.unroutedNets).toHaveLength(1);
    const edges = computeRatsnest(m);
    expect(edges).toHaveLength(1);
    // The remaining airwire reaches R3's pad at x=6.
    const e = edges[0];
    expect(Math.max(e.fromX, e.toX)).toBeCloseTo(6);
  });

  it("fully routed pin→net net draws no ratsnest", () => {
    const edits: ManualEditsMap = {
      [connectionId("R1.pin1", "R2.pin1")]: {
        pcb: { route: [{ x: 0, y: 0, layer: "top" }, { x: 3, y: 0, layer: "top" }], width: 0.25 },
      },
      [connectionId("R2.pin1", "R3.pin1")]: {
        pcb: { route: [{ x: 3, y: 0, layer: "top" }, { x: 6, y: 0, layer: "top" }], width: 0.25 },
      },
    };
    const m = buildPcbModel(netPcbJson() as never, NET_TSX, edits);
    expect(m.unroutedNets).toHaveLength(0);
    expect(computeRatsnest(m)).toHaveLength(0);
  });

  it("honors only the first net of a multi-net source_trace", () => {
    // A source_trace may list >1 net id. Phase 8 (via resolveSourceGraph) keeps
    // only connected_source_net_ids[0], so the extra net is dropped. Here R1's
    // trace lists [GND, VCC]; the pads still group on GND (the first) → one net
    // of 3. This pins the lossy behavior so a future change is caught.
    const json = netPcbJson();
    const st = json.find(
      (e) => (e as Record<string, unknown>).source_trace_id === "st_a"
    ) as Record<string, unknown>;
    st.connected_source_net_ids = ["net_gnd", "net_vcc"];
    const m = buildPcbModel(json as never, NET_TSX, {});
    expect(m.unroutedNets).toHaveLength(1);
    expect(m.unroutedNets[0].pads).toHaveLength(3);
  });

  it("dedups a pad reached through multiple traces on one net", () => {
    // R2.pin1 (sp_b) joins GND through a second redundant trace as well. The
    // pad is collected once (deduped by selector), so the net still has 3 pads
    // and 2 airwires — no double-counted pad, no ghost edge.
    const json = netPcbJson();
    json.push({
      type: "source_trace",
      source_trace_id: "st_b2",
      connected_source_port_ids: ["sp_b"],
      connected_source_net_ids: ["net_gnd"],
    });
    const m = buildPcbModel(json as never, NET_TSX, {});
    expect(m.unroutedNets).toHaveLength(1);
    expect(m.unroutedNets[0].pads).toHaveLength(3);
    expect(computeRatsnest(m)).toHaveLength(2);
  });

  it("inserts an inline via when route points span layers", () => {
    const tsxKey = ROUTE_KEY;
    const edits: ManualEditsMap = {
      [tsxKey]: {
        pcb: {
          route: [
            { x: -0.4, y: 0, layer: "top" },
            { x: 1, y: 0, layer: "top" },
            { x: 1, y: 0, layer: "bottom" },
            { x: 2.6, y: 0, layer: "bottom" },
          ],
          width: 0.3,
        },
      },
    };
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, edits);
    const t = m.traces.find((tr) => tr.key === tsxKey);
    expect(t).toBeDefined();
    expect(t!.vias).toHaveLength(1);
    expect(t!.vias[0].x).toBe(1);
    expect(t!.vias[0].fromLayer).toBe("top");
    expect(t!.vias[0].toLayer).toBe("bottom");
    // 1 top segment + 1 bottom segment (the layer-change span doesn't
    // produce its own segment — the via covers it).
    expect(t!.segments).toHaveLength(2);
  });

  it("does not render standalone pcb_via emitted by the autorouter (issue #23)", () => {
    // The editor is manual-only: it ignores the autorouter's pcb_trace
    // geometry. Standalone pcb_via elements that came with that geometry must
    // not be rendered either, otherwise the user sees vias "coming from
    // nowhere" with no trace attached.
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_via",
        pcb_via_id: "via_autoroute_1",
        x: 1.5,
        y: 0,
        hole_diameter: 0.3,
        outer_diameter: 0.6,
        from_layer: "top",
        to_layer: "bottom",
      },
    ];
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    expect(m.vias).toHaveLength(0);
  });

  it("translates child pads when the parent component is moved via manualEdits", () => {
    // R1 originally at (0, 0). Its two pads at (-0.4, 0) and (0.4, 0).
    // Move R1 to (7, 8). Pads should land at (6.6, 8) and (7.4, 8).
    const edits: ManualEditsMap = {
      r_abc123: { pcb: { x: 7, y: 8 } },
    };
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, edits);
    const r1Pads = m.pads.filter((p) => p.componentKey === "r_abc123");
    expect(r1Pads).toHaveLength(2);
    const xs = r1Pads.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(6.6, 4);
    expect(xs[1]).toBeCloseTo(7.4, 4);
    for (const p of r1Pads) expect(p.y).toBeCloseTo(8, 4);
    // R2 (unmoved) pads still at their original spot.
    const r2Pads = m.pads.filter((p) => p.componentKey === "r_xyz789");
    expect(r2Pads[0].x).toBeCloseTo(2.6, 4);
  });

  it("translates pads with sidecar x/y only", () => {
    const edits: ManualEditsMap = {
      r_abc123: { pcb: { x: 10, y: 0 } },
    };
    const m = buildPcbModel(fakePcbJson() as never, TSX_FIXTURE, edits);
    const r1Pads = m.pads.filter((p) => p.componentKey === "r_abc123");
    const xs = r1Pads.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(9.6, 4);
    expect(xs[1]).toBeCloseTo(10.4, 4);
    for (const p of r1Pads) expect(p.y).toBeCloseTo(0, 4);
  });

  it("survives a malformed pcb_smtpad without crashing", () => {
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_smtpad",
        // Missing critical fields. Should be skipped or rendered with
        // defaults — never throw.
      },
    ];
    expect(() =>
      buildPcbModel(json as never, TSX_FIXTURE, {})
    ).not.toThrow();
  });

  it("returns silently when tsx parse fails (kept rendering)", () => {
    const badTsx = "export default () => ( <board <<<INVALID";
    const m = buildPcbModel(fakePcbJson() as never, badTsx, {});
    // The model still produces components — just keyed by their
    // pcb_component_id since the tsx name resolution failed.
    expect(m.components.length).toBeGreaterThan(0);
  });
});

describe("withAutoPlacedPins", () => {
  // Build a minimal component record; only the fields the helper reads matter.
  // `placed` controls which axes the tsx pins: `true`/`false` set both, or pass
  // `{ x, y }` to model a half-placed part (only pcbX or only pcbY).
  const comp = (
    name: string,
    x: number,
    y: number,
    placed: boolean | { x?: boolean; y?: boolean } = false
  ): PcbComponentRecord => {
    const pcbXInTsx = typeof placed === "boolean" ? placed : placed.x ?? false;
    const pcbYInTsx = typeof placed === "boolean" ? placed : placed.y ?? false;
    return {
      key: `k_${name}` as PcbComponentRecord["key"],
      name,
      pcbComponentId: `pc_${name}`,
      x,
      y,
      rotationDeg: 0,
      originRotationDeg: 0,
      layer: "top",
      width: 1,
      height: 1,
      manuallyPlaced: pcbXInTsx || pcbYInTsx,
      pcbXInTsx,
      pcbYInTsx,
    } as PcbComponentRecord;
  };

  it("pins every auto-placed part the user didn't touch (the core fix)", () => {
    // R1 was dragged to (10,10); R2 + C1 are auto-laid-out. Without pinning,
    // the eval triggered by baking R1 would re-pack R2 + C1 and they'd appear
    // to move on their own ~1s later.
    const model = {
      components: [
        comp("R1", 0, 0, false),
        comp("R2", 0, -1.94, false),
        comp("C1", 0, -3.88, false),
      ],
    };
    const out = withAutoPlacedPins(model, [{ name: "R1", x: 10, y: 10 }]);
    const byName = new Map(out.map((u) => [u.name, u]));
    expect(byName.get("R1")).toEqual({ name: "R1", x: 10, y: 10 });
    // R2 + C1 get pinned at their current evaluated positions.
    expect(byName.get("R2")).toEqual({ name: "R2", x: 0, y: -1.94 });
    expect(byName.get("C1")).toEqual({ name: "C1", x: 0, y: -3.88 });
    expect(out).toHaveLength(3);
  });

  it("leaves parts already pinned in the tsx untouched", () => {
    // Every part is placed in tsx → the eval already honors their coords, so
    // there's nothing to pin beyond the dragged update.
    const model = {
      components: [comp("R1", 0, 0, true), comp("R2", 3, 0, true)],
    };
    const out = withAutoPlacedPins(model, [{ name: "R1", x: 5, y: 5 }]);
    expect(out).toEqual([{ name: "R1", x: 5, y: 5 }]);
  });

  it("back-fills x/y for a rotate-only update on an auto-placed part", () => {
    // A rotate bake carries only `rotation`. If the rotated part isn't pinned
    // in the tsx, leaving x/y off would keep it auto-laid-out and it (plus the
    // others) would still drift. The helper anchors it at its current coords.
    const model = {
      components: [comp("R1", 2, 4, false), comp("R2", 0, -1.94, false)],
    };
    const out = withAutoPlacedPins(model, [{ name: "R1", rotation: 90 }]);
    const byName = new Map(out.map((u) => [u.name, u]));
    expect(byName.get("R1")).toEqual({ name: "R1", rotation: 90, x: 2, y: 4 });
    expect(byName.get("R2")).toEqual({ name: "R2", x: 0, y: -1.94 });
  });

  it("does not double-add a touched part to the pin list", () => {
    const model = { components: [comp("R1", 0, 0, false)] };
    const out = withAutoPlacedPins(model, [{ name: "R1", x: 1, y: 1 }]);
    expect(out).toHaveLength(1);
  });

  it("anchors several dragged parts and pins the untouched rest", () => {
    // The drag-end call site (PcbCanvas) pushes one update per selected part,
    // so a multi-select drag carries N updates. R3 is the untouched neighbor.
    const model = {
      components: [
        comp("R1", 0, 0, false),
        comp("R2", 5, 0, false),
        comp("R3", 0, -1.94, false),
      ],
    };
    const out = withAutoPlacedPins(model, [
      { name: "R1", x: 10, y: 10 },
      { name: "R2", x: 12, y: 10 },
    ]);
    const byName = new Map(out.map((u) => [u.name, u]));
    expect(byName.get("R1")).toEqual({ name: "R1", x: 10, y: 10 });
    expect(byName.get("R2")).toEqual({ name: "R2", x: 12, y: 10 });
    expect(byName.get("R3")).toEqual({ name: "R3", x: 0, y: -1.94 });
    expect(out).toHaveLength(3);
  });

  it("still pins auto-placed neighbors when the touched part is tsx-pinned", () => {
    // R1 is already pinned in the tsx (passes through untouched), but R2 is
    // auto-laid-out and must still be pinned so it doesn't re-pack on the eval.
    const model = {
      components: [comp("R1", 0, 0, true), comp("R2", 0, -1.94, false)],
    };
    const out = withAutoPlacedPins(model, [{ name: "R1", x: 5, y: 5 }]);
    const byName = new Map(out.map((u) => [u.name, u]));
    expect(byName.get("R1")).toEqual({ name: "R1", x: 5, y: 5 });
    expect(byName.get("R2")).toEqual({ name: "R2", x: 0, y: -1.94 });
    expect(out).toHaveLength(2);
  });

  it("passes an update for an unknown component through unchanged", () => {
    // recordByName.get() misses → no back-fill, no crash; the update is kept.
    const model = { components: [comp("R1", 0, 0, false)] };
    const out = withAutoPlacedPins(model, [{ name: "GHOST", rotation: 90 }]);
    const byName = new Map(out.map((u) => [u.name, u]));
    expect(byName.get("GHOST")).toEqual({ name: "GHOST", rotation: 90 });
    // R1 is untouched + auto-placed, so it still gets pinned.
    expect(byName.get("R1")).toEqual({ name: "R1", x: 0, y: 0 });
  });

  it("pins only the auto axis of an untouched half-placed part", () => {
    // R2 has pcbX in the tsx but no pcbY, so its Y is auto-laid-out and would
    // drift. Only the open Y axis should be pinned — re-baking the pinned X
    // would be churn.
    const model = {
      components: [comp("R1", 0, 0, false), comp("R2", 7, -2, { x: true })],
    };
    const out = withAutoPlacedPins(model, [{ name: "R1", x: 10, y: 10 }]);
    const byName = new Map(out.map((u) => [u.name, u]));
    expect(byName.get("R1")).toEqual({ name: "R1", x: 10, y: 10 });
    expect(byName.get("R2")).toEqual({ name: "R2", y: -2 });
    expect(out).toHaveLength(2);
  });

  it("back-fills only the open axis when rotating a half-placed part", () => {
    // R1 has pcbY pinned but no pcbX. A rotate-only update must anchor the
    // open X (or it keeps auto-laying-out and drifts), but leave the pinned Y.
    const model = { components: [comp("R1", 3, 5, { y: true })] };
    const out = withAutoPlacedPins(model, [{ name: "R1", rotation: 90 }]);
    const byName = new Map(out.map((u) => [u.name, u]));
    expect(byName.get("R1")).toEqual({ name: "R1", rotation: 90, x: 3 });
    expect(out).toHaveLength(1);
  });
});

describe("normalizePadSelector", () => {
  it("folds whitespace, case, and the `.X > .y` form into compact `x.y`", () => {
    // Must agree with the compact form `<trace>` from/to is stored in, so the
    // tsx-key bridge maps (Phase 5a/8, fab export) match. See normalizePadSelector.
    expect(normalizePadSelector(".R1 > .pin1")).toBe("r1.pin1");
    expect(normalizePadSelector(".R1>.pin1")).toBe("r1.pin1");
    expect(normalizePadSelector(" .R1   >    .pin1 ")).toBe("r1.pin1");
    // The already-compact form passes through to the same canonical string.
    expect(normalizePadSelector("R1.pin1")).toBe("r1.pin1");
  });
});

describe("buildPcbModel silkscreen", () => {
  // Silkscreen elements say which FACE they're on ("top" / "bottom" — LayerRef
  // has no silkscreen names). The model must translate to the editor's
  // silkscreen layer ids, otherwise silkscreen paints in copper red and its
  // visibility rides the copper toggle instead of the silkscreen one.
  it("maps face layers to editor silkscreen layers", () => {
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_silkscreen_line",
        pcb_silkscreen_line_id: "sl_1",
        pcb_component_id: "pc_r1",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 0,
        stroke_width: 0.1,
        layer: "top",
      },
      {
        type: "pcb_silkscreen_path",
        pcb_silkscreen_path_id: "sp_1",
        pcb_component_id: "pc_r2",
        route: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        stroke_width: 0.12,
        layer: "bottom",
      },
      {
        type: "pcb_silkscreen_text",
        pcb_silkscreen_text_id: "st_1",
        pcb_component_id: "pc_r1",
        text: "hello",
        font_size: 0.5,
        anchor_position: { x: 2, y: 3 },
        anchor_alignment: "center",
        layer: "bottom",
      },
    ];
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    expect(m.silkscreenLines.map((l) => l.layer)).toEqual([
      "silkscreen_top",
      "silkscreen_bottom",
    ]);
    expect(m.silkscreenTexts[0].layer).toBe("silkscreen_bottom");
  });

  it("renders component-owned silkscreen and flags hasSilkscreenOutline", () => {
    // Footprint silkscreen used to be dropped for chip-like / 3+-pad parts,
    // leaving only the synthetic pad-derived courtyard — far wider than the
    // real body. All owned silkscreen renders now; owners of outline geometry
    // are flagged so the renderer skips its synthetic outline instead.
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_silkscreen_path",
        pcb_silkscreen_path_id: "sp_1",
        pcb_component_id: "pc_r1",
        route: [
          { x: -0.5, y: -0.3 },
          { x: 0.5, y: -0.3 },
          { x: 0.5, y: 0.3 },
        ],
        stroke_width: 0.1,
        layer: "top",
      },
    ];
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    expect(m.silkscreenLines).toHaveLength(2); // 3-point path → 2 segments
    const r1 = m.components.find((c) => c.name === "R1")!;
    const r2 = m.components.find((c) => c.name === "R2")!;
    expect(r1.hasSilkscreenOutline).toBe(true);
    expect(r2.hasSilkscreenOutline).toBe(false);
  });

  it("moves owned silkscreen with the parent's manual-edit delta", () => {
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_silkscreen_line",
        pcb_silkscreen_line_id: "sl_1",
        pcb_component_id: "pc_r1",
        x1: -0.5,
        y1: 0,
        x2: 0.5,
        y2: 0,
        stroke_width: 0.1,
        layer: "top",
      },
    ];
    const edits: ManualEditsMap = { r_abc123: { pcb: { x: 2, y: 1 } } };
    const m = buildPcbModel(json as never, TSX_FIXTURE, edits);
    expect(m.silkscreenLines[0]).toMatchObject({ x1: 1.5, y1: 1, x2: 2.5, y2: 1 });
  });

  it("keeps designator silkscreen text as real footprint art", () => {
    // The eval emits the designator as silkscreen text; the editor renders it
    // as-is (like tscircuit / Altium) rather than synthesizing its own label.
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_silkscreen_text",
        pcb_silkscreen_text_id: "st_1",
        pcb_component_id: "pc_r1",
        text: "R1",
        font_size: 0.4,
        anchor_position: { x: 0, y: 1 },
        anchor_alignment: "center",
        layer: "top",
      },
      {
        type: "pcb_silkscreen_text",
        pcb_silkscreen_text_id: "st_2",
        pcb_component_id: "pc_r1",
        text: "10k",
        font_size: 0.4,
        anchor_position: { x: 0, y: -1 },
        anchor_alignment: "top_left",
        layer: "top",
        is_mirrored: true,
      },
    ];
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    expect(m.silkscreenTexts).toHaveLength(2);
    expect(m.silkscreenTexts.map((t) => t.text)).toEqual(["R1", "10k"]);
    expect(m.silkscreenTexts[1]).toMatchObject({
      text: "10k",
      anchor: "left",
      anchorV: "top",
      mirrored: true,
    });
    // Text alone is not outline geometry — no synthetic-outline opt-out.
    const r1 = m.components.find((c) => c.name === "R1")!;
    expect(r1.hasSilkscreenOutline).toBe(false);
  });

  it("parses rect / circle / pill / oval into silkscreen shapes", () => {
    const json = [
      ...fakePcbJson(),
      {
        type: "pcb_silkscreen_rect",
        pcb_silkscreen_rect_id: "sr_1",
        pcb_component_id: "pc_r1",
        center: { x: 0, y: 0 },
        width: 2,
        height: 1,
        stroke_width: 0.15,
        corner_radius: 0.2,
        is_filled: false,
        ccw_rotation: 45,
        layer: "top",
      },
      {
        type: "pcb_silkscreen_circle",
        pcb_silkscreen_circle_id: "sc_1",
        pcb_component_id: "pc_r1",
        center: { x: 1, y: 1 },
        radius: 0.25,
        stroke_width: 0.1,
        is_filled: true,
        layer: "top",
      },
      {
        type: "pcb_silkscreen_pill",
        pcb_silkscreen_pill_id: "spl_1",
        pcb_component_id: "pc_r1",
        center: { x: -1, y: 0 },
        width: 1,
        height: 0.4,
        layer: "bottom",
      },
      {
        type: "pcb_silkscreen_oval",
        pcb_silkscreen_oval_id: "so_1",
        pcb_component_id: "pc_r1",
        center: { x: 0, y: -1 },
        radius_x: 0.6,
        radius_y: 0.3,
        layer: "top",
      },
    ];
    const m = buildPcbModel(json as never, TSX_FIXTURE, {});
    expect(m.silkscreenShapes).toHaveLength(4);
    const [rect, circle, pill, oval] = m.silkscreenShapes;
    expect(rect).toMatchObject({
      kind: "rect",
      width: 2,
      height: 1,
      cornerRadius: 0.2,
      rotationDeg: 45,
      strokeWidth: 0.15,
      filled: false,
      layer: "silkscreen_top",
    });
    // A filled circle has no stroke; extents are the full diameter.
    expect(circle).toMatchObject({
      kind: "circle",
      x: 1,
      y: 1,
      width: 0.5,
      height: 0.5,
      strokeWidth: 0,
      filled: true,
    });
    // Pills / ovals carry no stroke or fill fields — solid shapes.
    expect(pill).toMatchObject({
      kind: "pill",
      filled: true,
      strokeWidth: 0,
      layer: "silkscreen_bottom",
    });
    expect(oval).toMatchObject({ kind: "oval", width: 1.2, height: 0.6 });
    // Closed shapes count as outline geometry.
    const r1 = m.components.find((c) => c.name === "R1")!;
    expect(r1.hasSilkscreenOutline).toBe(true);
  });
});
