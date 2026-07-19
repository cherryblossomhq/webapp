import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "@/editor/state/editorStore";
import {
  BOTTOM_LAYER_ID,
  DEFAULT_TRACE_WIDTH_MM,
  TOP_LAYER_ID,
  TRACE_WIDTH_PROFILES,
} from "./layers";

beforeEach(() => {
  useEditorStore.getState().reset();
});

describe("editorStore setPcbEdits (batch)", () => {
  it("applies every entry in one update and matches setPcbEdit semantics", () => {
    useEditorStore.getState().setPcbEdits([
      ["k_a", { x: 1, y: 2 }],
      ["k_b", { x: 3, y: 4 }],
    ]);
    const m = useEditorStore.getState().manualEdits;
    expect(m["k_a"]?.pcb).toEqual({ x: 1, y: 2 });
    expect(m["k_b"]?.pcb).toEqual({ x: 3, y: 4 });
    // One batch = one local-edit bump (drag frames key off this).
    expect(useEditorStore.getState().localEditsSinceEval).toBe(1);
  });

  it("null edit clears the pcb entry and drops empty records", () => {
    useEditorStore.getState().setPcbEdit("k_a", { x: 1, y: 2 });
    useEditorStore.getState().setPcbEdits([["k_a", null]]);
    expect(useEditorStore.getState().manualEdits["k_a"]).toBeUndefined();
  });

  it("preserves an existing schematic edit on the same key", () => {
    useEditorStore.getState().setSchematicEdit("k_a", { x: 9, y: 9 });
    useEditorStore.getState().setPcbEdits([["k_a", { x: 1, y: 2 }]]);
    const entry = useEditorStore.getState().manualEdits["k_a"];
    expect(entry?.schematic).toEqual({ x: 9, y: 9 });
    expect(entry?.pcb).toEqual({ x: 1, y: 2 });
  });

  it("empty batch is a no-op", () => {
    const before = useEditorStore.getState().manualEdits;
    useEditorStore.getState().setPcbEdits([]);
    expect(useEditorStore.getState().manualEdits).toBe(before);
    expect(useEditorStore.getState().localEditsSinceEval).toBe(0);
  });
});

describe("editorStore pcbCursorMm", () => {
  it("rounds to 0.01mm and skips no-op sets", () => {
    useEditorStore.getState().setPcbCursorMm({ x: 1.2345, y: -0.018 });
    const first = useEditorStore.getState().pcbCursorMm;
    expect(first).toEqual({ x: 1.23, y: -0.02 });
    // Sub-display motion must not produce a new object (no re-render).
    useEditorStore.getState().setPcbCursorMm({ x: 1.2349, y: -0.0182 });
    expect(useEditorStore.getState().pcbCursorMm).toBe(first);
    useEditorStore.getState().setPcbCursorMm(null);
    expect(useEditorStore.getState().pcbCursorMm).toBeNull();
  });
});

describe("editorStore PCB layers", () => {
  it("defaults to TOP_LAYER_ID active + all layers visible", () => {
    const s = useEditorStore.getState();
    expect(s.activeLayer).toBe(TOP_LAYER_ID);
    expect(s.layerVisibility[TOP_LAYER_ID]).toBe(true);
    expect(s.layerVisibility[BOTTOM_LAYER_ID]).toBe(true);
  });

  it("toggleLayerVisibility flips the bit", () => {
    useEditorStore.getState().toggleLayerVisibility(BOTTOM_LAYER_ID);
    expect(useEditorStore.getState().layerVisibility[BOTTOM_LAYER_ID]).toBe(
      false
    );
    useEditorStore.getState().toggleLayerVisibility(BOTTOM_LAYER_ID);
    expect(useEditorStore.getState().layerVisibility[BOTTOM_LAYER_ID]).toBe(
      true
    );
  });

  it("setTraceWidth rejects non-positive values", () => {
    useEditorStore.getState().setTraceWidth(-1);
    expect(useEditorStore.getState().traceWidth).toBe(DEFAULT_TRACE_WIDTH_MM);
    useEditorStore.getState().setTraceWidth(0);
    expect(useEditorStore.getState().traceWidth).toBe(DEFAULT_TRACE_WIDTH_MM);
  });

  it("cycleTraceWidth walks through width profiles", () => {
    const profiles = TRACE_WIDTH_PROFILES;
    const startId = useEditorStore.getState().activeWidthProfileId;
    const startIdx = profiles.findIndex((p) => p.id === startId);
    useEditorStore.getState().cycleTraceWidth();
    expect(useEditorStore.getState().traceWidth).toBe(
      profiles[(startIdx + 1) % profiles.length].widthMm
    );
  });

  it("cycleTraceWidth mid-route propagates to the draft so commit uses the new width", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    const startWidth = useEditorStore.getState().pcbRouteDraft!.width;
    useEditorStore.getState().cycleTraceWidth();
    const afterWidth = useEditorStore.getState().pcbRouteDraft!.width;
    expect(afterWidth).not.toBe(startWidth);
    expect(afterWidth).toBe(useEditorStore.getState().traceWidth);
    const finished = useEditorStore.getState().finishPcbRoute({
      selector: ".R2>.pin1",
      x: 3,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    // Commit-time width matches the post-cycle value, not the start value.
    expect(finished!.width).toBe(afterWidth);
  });

  it("setTraceWidth mid-route propagates to the draft", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().setTraceWidth(0.6);
    expect(useEditorStore.getState().pcbRouteDraft!.width).toBe(0.6);
  });
});

describe("editorStore PCB route draft", () => {
  it("startPcbRoute seeds the draft with the start pad as the first point", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 1,
      y: 2,
      layer: TOP_LAYER_ID,
    });
    const draft = useEditorStore.getState().pcbRouteDraft;
    expect(draft).not.toBeNull();
    expect(draft!.points).toEqual([
      { x: 1, y: 2, layer: TOP_LAYER_ID, width: DEFAULT_TRACE_WIDTH_MM },
    ]);
    expect(draft!.fromSelector).toBe(".R1>.pin1");
    expect(draft!.activeLayer).toBe(TOP_LAYER_ID);
  });

  it("addPcbRouteCorner appends a point on the active layer", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().addPcbRouteCorner({ x: 3, y: 0 });
    expect(useEditorStore.getState().pcbRouteDraft!.points).toEqual([
      { x: 0, y: 0, layer: TOP_LAYER_ID, width: DEFAULT_TRACE_WIDTH_MM },
      { x: 3, y: 0, layer: TOP_LAYER_ID, width: DEFAULT_TRACE_WIDTH_MM },
    ]);
  });

  it("skips zero-length corners (cursor jitter on snapped click)", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 1,
      y: 1,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().addPcbRouteCorner({ x: 1, y: 1 });
    expect(useEditorStore.getState().pcbRouteDraft!.points).toHaveLength(1);
  });

  it("insertPcbRouteVia drops a via point at the last corner + flips activeLayer", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().addPcbRouteCorner({ x: 1, y: 0 });
    useEditorStore.getState().insertPcbRouteVia(BOTTOM_LAYER_ID);
    useEditorStore.getState().addPcbRouteCorner({ x: 2, y: 0 });
    const pts = useEditorStore.getState().pcbRouteDraft!.points;
    // Expected route: [start@top, c1@top, c1@bottom (via), c2@bottom].
    // The via duplicate is what makes pcbModel emit the via at (1, 0)
    // and a bottom-layer segment from (1, 0) → (2, 0).
    expect(pts).toHaveLength(4);
    expect(pts[1]).toEqual({
      x: 1,
      y: 0,
      layer: TOP_LAYER_ID,
      width: DEFAULT_TRACE_WIDTH_MM,
    });
    expect(pts[2]).toEqual({
      x: 1,
      y: 0,
      layer: BOTTOM_LAYER_ID,
      width: DEFAULT_TRACE_WIDTH_MM,
    });
    expect(pts[3]).toEqual({
      x: 2,
      y: 0,
      layer: BOTTOM_LAYER_ID,
      width: DEFAULT_TRACE_WIDTH_MM,
    });
  });

  it("popPcbRoutePoint over a via restores activeLayer to the previous layer", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().addPcbRouteCorner({ x: 1, y: 0 });
    useEditorStore.getState().insertPcbRouteVia(BOTTOM_LAYER_ID);
    expect(useEditorStore.getState().pcbRouteDraft!.activeLayer).toBe(
      BOTTOM_LAYER_ID
    );
    useEditorStore.getState().popPcbRoutePoint();
    expect(useEditorStore.getState().pcbRouteDraft!.activeLayer).toBe(
      TOP_LAYER_ID
    );
    expect(useEditorStore.getState().activeLayer).toBe(TOP_LAYER_ID);
  });

  it("insertPcbRouteVia no-ops when target layer is already active", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().insertPcbRouteVia(TOP_LAYER_ID);
    expect(useEditorStore.getState().pcbRouteDraft!.activeLayer).toBe(
      TOP_LAYER_ID
    );
  });

  it("popPcbRoutePoint removes the last point but never the first", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().addPcbRouteCorner({ x: 1, y: 0 });
    useEditorStore.getState().addPcbRouteCorner({ x: 2, y: 0 });
    useEditorStore.getState().popPcbRoutePoint();
    expect(useEditorStore.getState().pcbRouteDraft!.points).toHaveLength(2);
    useEditorStore.getState().popPcbRoutePoint();
    expect(useEditorStore.getState().pcbRouteDraft!.points).toHaveLength(1);
    // Cannot pop the start pad — guard against an empty draft.
    useEditorStore.getState().popPcbRoutePoint();
    expect(useEditorStore.getState().pcbRouteDraft!.points).toHaveLength(1);
  });

  it("finishPcbRoute returns the completed draft and clears state", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().addPcbRouteCorner({ x: 1, y: 0 });
    const finished = useEditorStore.getState().finishPcbRoute({
      selector: ".R2>.pin1",
      x: 3,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    expect(finished).not.toBeNull();
    expect(finished!.toSelector).toBe(".R2>.pin1");
    expect(finished!.points).toHaveLength(3);
    expect(useEditorStore.getState().pcbRouteDraft).toBeNull();
  });

  it("finishPcbRoute rejects self-connection (same selector)", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    const finished = useEditorStore.getState().finishPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    expect(finished).toBeNull();
    expect(useEditorStore.getState().pcbRouteDraft).toBeNull();
  });

  it("clearPcbRouteDraft wipes the draft (Esc / right-click)", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().clearPcbRouteDraft();
    expect(useEditorStore.getState().pcbRouteDraft).toBeNull();
  });

  it("leaving trace mode clears an in-progress route draft", () => {
    useEditorStore.getState().setToolMode("trace");
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().setPcbRouteCursor({ x: 2, y: 0 }, null, [
      { x: 1, y: 0, layer: TOP_LAYER_ID },
    ]);
    useEditorStore.getState().setToolMode("select");
    expect(useEditorStore.getState().toolMode).toBe("select");
    expect(useEditorStore.getState().pcbRouteDraft).toBeNull();
  });

  it("setPcbRouteCursor stores cursor + snappedPad", () => {
    useEditorStore.getState().startPcbRoute({
      selector: ".R1>.pin1",
      x: 0,
      y: 0,
      layer: TOP_LAYER_ID,
    });
    useEditorStore.getState().setPcbRouteCursor(
      { x: 2.5, y: 0 },
      {
        selector: ".R2>.pin1",
        x: 3,
        y: 0,
        layer: TOP_LAYER_ID,
      }
    );
    const d = useEditorStore.getState().pcbRouteDraft!;
    expect(d.cursor).toEqual({ x: 2.5, y: 0 });
    expect(d.snappedPad).not.toBeNull();
  });
});

describe("editorStore setPcbEdit (sidecar write)", () => {
  it("writes to manualEdits[key].pcb without touching tsx", () => {
    useEditorStore.getState().setPcbEdit("r_abc123", {
      x: 5,
      y: 6,
      layer: "bottom",
    });
    const edit =
      useEditorStore.getState().manualEdits["r_abc123"]?.pcb;
    expect(edit).toMatchObject({ x: 5, y: 6, layer: "bottom" });
  });

  it("setPcbEdit(null) removes the pcb sub-entry", () => {
    useEditorStore.getState().setPcbEdit("r_abc123", { x: 5, y: 6 });
    useEditorStore.getState().setPcbEdit("r_abc123", null);
    expect(useEditorStore.getState().manualEdits["r_abc123"]).toBeUndefined();
  });
});
