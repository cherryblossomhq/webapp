import { describe, it, expect } from "vitest";
import { CircuitRunner } from "@tscircuit/eval";
import type { AnyCircuitElement } from "circuit-json";

// No mocks: runs the real eval — including core's capacity-mesh autorouter —
// and proves the display pipeline picks its routes up: pcbModel renders them
// keyed by pad-pair connection ids, deleting one (noAutoroute) hides it and
// brings its airwire back, and overlayManualRoutes ships the same set. This
// is the drift guard for tscircuit upgrades: if core changes how pcb_trace
// routes or their endpoint port ids are emitted, this fails before a user
// sees a silently-unrouted board.
import { buildPcbModel, evalTraceEndpoints } from "./pcbModel";
import { overlayManualRoutes } from "./circuitJsonMerge";
import type { ManualEditsMap } from "@/editor/shared/types";

const TSX = `
export default () => (
  <board width="30mm" height="30mm">
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-8} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={8} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={0} pcbY={8} pcbRotation={90} />
    <resistor name="R4" resistance="1k" footprint="0402" pcbX={0} pcbY={-8} pcbRotation={90} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R3 > .pin2" to=".R4 > .pin1" />
    <trace from=".R1 > .pin1" to=".R4 > .pin2" />
  </board>
);`;

describe("autoroute display pipeline (real eval)", () => {
  it("renders eval autoroutes, hides a deleted one, and ships the overlay", async () => {
    const runner = new CircuitRunner();
    await runner.executeWithFsMap({
      fsMap: { "main.tsx": TSX },
      mainComponentPath: "main.tsx",
    });
    await runner.renderUntilSettled();
    const circuitJson = (await runner.getCircuitJson()) as AnyCircuitElement[];

    const evalTraceIds = circuitJson
      .filter((e) => (e as { type?: string }).type === "pcb_trace")
      .map((e) => (e as { pcb_trace_id: string }).pcb_trace_id);
    expect(evalTraceIds.length).toBeGreaterThanOrEqual(3);

    // Every eval trace renders, keyed by a real pad-pair connection id (no
    // `pcbtrace_` synthetic fallback — endpoint port ids must resolve).
    const model = buildPcbModel(circuitJson, TSX, {});
    const auto = model.traces.filter((t) => !t.userRouted);
    expect(auto).toHaveLength(evalTraceIds.length);
    for (const t of auto) {
      expect(t.key.startsWith("conn_")).toBe(true);
      expect(t.segments.length).toBeGreaterThan(0);
    }
    // A fully-autorouted board shows no airwires.
    expect(model.unroutedNets).toHaveLength(0);

    // Delete one connection: its trace disappears and the airwire returns.
    const victim = auto[0];
    const edits: ManualEditsMap = {
      [victim.key]: { pcb: { noAutoroute: true } },
    };
    const m2 = buildPcbModel(circuitJson, TSX, edits);
    expect(m2.traces.filter((t) => t.key === victim.key)).toHaveLength(0);
    expect(m2.unroutedNets.length).toBeGreaterThan(0);

    // The overlay agrees with the canvas: it drops exactly the eval traces
    // that share the deleted connection key (plus their linked vias).
    const droppedIds = new Set(
      [...evalTraceEndpoints(circuitJson)]
        .filter(([, ends]) => ends.key === victim.key)
        .map(([id]) => id),
    );
    expect(droppedIds.size).toBeGreaterThan(0);
    const merged = overlayManualRoutes(circuitJson, edits);
    const mergedIds = merged
      .filter((e) => (e as { type?: string }).type === "pcb_trace")
      .map((e) => (e as { pcb_trace_id: string }).pcb_trace_id);
    expect(mergedIds).toHaveLength(evalTraceIds.length - droppedIds.size);
    expect(mergedIds.some((id) => droppedIds.has(id))).toBe(false);
    for (const el of merged) {
      const r = el as { type?: string; pcb_trace_id?: string };
      if (r.type === "pcb_via" && r.pcb_trace_id) {
        expect(droppedIds.has(r.pcb_trace_id)).toBe(false);
      }
    }
  }, 120_000);
});
