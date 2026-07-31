import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "./editorStore";

const get = () => useEditorStore.getState();

describe("editorStore — selection", () => {
  beforeEach(() => {
    get().reset();
  });

  it("starts with an empty selection in select mode", () => {
    expect(get().selectedKeys.size).toBe(0);
    expect(get().toolMode).toBe("select");
  });

  it("setSelection replaces the entire set", () => {
    get().setSelection(["r_aaa111", "c_bbb222"]);
    expect(get().selectedKeys.size).toBe(2);
    get().setSelection(["d_ccc333"]);
    expect(get().selectedKeys.size).toBe(1);
    expect(get().selectedKeys.has("d_ccc333")).toBe(true);
  });

  it("toggleSelection adds and removes correctly", () => {
    get().toggleSelection("r_aaa111");
    expect(get().isSelected("r_aaa111")).toBe(true);
    get().toggleSelection("r_aaa111");
    expect(get().isSelected("r_aaa111")).toBe(false);
  });

  it("addToSelection / removeFromSelection are idempotent", () => {
    get().addToSelection("r_aaa111");
    get().addToSelection("r_aaa111");
    expect(get().selectedKeys.size).toBe(1);
    get().removeFromSelection("r_aaa111");
    get().removeFromSelection("r_aaa111");
    expect(get().selectedKeys.size).toBe(0);
  });

  it("clearSelection is a no-op when already empty", () => {
    const prev = get().selectedKeys;
    get().clearSelection();
    // Same identity since no update was issued.
    expect(get().selectedKeys).toBe(prev);
  });

  it("CRITICAL: syncSelectionToLiveKeys drops stale keys", () => {
    get().setSelection(["r_aaa111", "c_bbb222", "d_ccc333"]);
    get().syncSelectionToLiveKeys(new Set(["r_aaa111", "c_bbb222"]));
    expect(get().selectedKeys.size).toBe(2);
    expect(get().selectedKeys.has("d_ccc333")).toBe(false);
  });
});

describe("editorStore — tool mode", () => {
  beforeEach(() => get().reset());

  it("setToolMode transitions cleanly", () => {
    get().setToolMode("move");
    expect(get().toolMode).toBe("move");
    get().setToolMode("rotate");
    expect(get().toolMode).toBe("rotate");
  });

  it("setToolMode is a no-op when the value is unchanged", () => {
    const before = get().toolMode;
    get().setToolMode(before);
    // No state change should have occurred — same reference holds.
    expect(get().toolMode).toBe(before);
  });
});

describe("editorStore — viewport", () => {
  beforeEach(() => get().reset());

  it("setViewport per tab is independent", () => {
    get().setViewport("schematic", { x: 10, y: 20, scale: 2 });
    expect(get().viewport.schematic).toEqual({ x: 10, y: 20, scale: 2 });
    expect(get().viewport.pcb.scale).toBe(1);
  });

  it("resetViewport restores the identity transform", () => {
    get().setViewport("pcb", { x: 100, y: 200, scale: 3 });
    get().resetViewport("pcb");
    expect(get().viewport.pcb).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("editorStore — active tab (Phase 1)", () => {
  beforeEach(() => get().reset());

  it("defaults to the schematic tab", () => {
    expect(get().activeTab).toBe("schematic");
  });

  it("setActiveTab switches between tabs", () => {
    get().setActiveTab("pcb");
    expect(get().activeTab).toBe("pcb");
    get().setActiveTab("cad");
    expect(get().activeTab).toBe("cad");
  });

  it("setActiveTab is a no-op when unchanged (no extraneous re-renders)", () => {
    const before = get().activeTab;
    get().setActiveTab(before);
    expect(get().activeTab).toBe(before);
  });

  it("reset() returns to the schematic tab", () => {
    get().setActiveTab("bom");
    get().reset();
    expect(get().activeTab).toBe("schematic");
  });
});

describe("editorStore — manualEdits sidecar", () => {
  beforeEach(() => get().reset());

  it("setSchematicEdit creates an entry and bumps localEditsSinceEval", () => {
    const before = get().localEditsSinceEval;
    get().setSchematicEdit("r_aaa111", { x: 1, y: 2 });
    expect(get().manualEdits.r_aaa111?.schematic).toEqual({ x: 1, y: 2 });
    expect(get().localEditsSinceEval).toBe(before + 1);
  });

  it("setSchematicEdit(null) removes the schematic subkey", () => {
    get().setSchematicEdit("r_aaa111", { x: 1 });
    get().setSchematicEdit("r_aaa111", null);
    expect(get().manualEdits.r_aaa111).toBeUndefined();
  });

  it("setPcbEdit + setSchematicEdit on the same key coexist", () => {
    get().setSchematicEdit("r_aaa111", { x: 1 });
    get().setPcbEdit("r_aaa111", { x: 10, y: 20 });
    expect(get().manualEdits.r_aaa111?.schematic).toEqual({ x: 1 });
    expect(get().manualEdits.r_aaa111?.pcb).toEqual({ x: 10, y: 20 });
  });

  it("CRITICAL: pruneOrphans drops entries whose key isn't in liveKeys", () => {
    get().setSchematicEdit("r_aaa111", { x: 1 });
    get().setSchematicEdit("c_bbb222", { x: 2 });
    get().pruneOrphans(new Set(["r_aaa111"]));
    expect(get().manualEdits.r_aaa111).toBeDefined();
    expect(get().manualEdits.c_bbb222).toBeUndefined();
  });

  it("setManualEdits resets localEditsSinceEval to 0", () => {
    get().setSchematicEdit("r_aaa111", { x: 1 });
    expect(get().localEditsSinceEval).toBeGreaterThan(0);
    get().setManualEdits({});
    expect(get().localEditsSinceEval).toBe(0);
  });
});

describe("editorStore — reconcilePcbPlacements", () => {
  beforeEach(() => get().reset());

  const evalMap = (
    entries: Record<string, { x: number; y: number; rotation: number }>
  ) =>
    new Map(
      Object.entries(entries) as Array<
        [import("../shared/types").StableKey, { x: number; y: number; rotation: number }]
      >
    );

  it("drops a placement override once the eval matches it", () => {
    get().setPcbEdit("r_aaa111", { x: 10, y: 20 });
    get().reconcilePcbPlacements(evalMap({ r_aaa111: { x: 10, y: 20, rotation: 0 } }));
    expect(get().manualEdits.r_aaa111).toBeUndefined();
  });

  it("KEEPS the override while it still diverges (mid-drag, tsx not baked yet)", () => {
    get().setPcbEdit("r_aaa111", { x: 10, y: 20 });
    // Eval still reflects the OLD position — must not clear or the part jumps.
    get().reconcilePcbPlacements(evalMap({ r_aaa111: { x: 0, y: 0, rotation: 0 } }));
    expect(get().manualEdits.r_aaa111?.pcb).toEqual({ x: 10, y: 20 });
  });

  it("preserves a manual route when clearing the matched position", () => {
    get().setPcbEdit("t_ccc333", {
      x: 5,
      y: 6,
      route: [
        { x: 0, y: 0, layer: "top" },
        { x: 5, y: 6, layer: "top" },
      ],
      width: 0.25,
    });
    get().reconcilePcbPlacements(evalMap({ t_ccc333: { x: 5, y: 6, rotation: 0 } }));
    const pcb = get().manualEdits.t_ccc333?.pcb;
    expect(pcb?.x).toBeUndefined();
    expect(pcb?.y).toBeUndefined();
    expect(pcb?.route).toHaveLength(2);
    expect(pcb?.width).toBe(0.25);
  });

  it("ignores keys with no eval entry (component errored out of the build)", () => {
    get().setPcbEdit("r_aaa111", { x: 10, y: 20 });
    get().reconcilePcbPlacements(evalMap({}));
    expect(get().manualEdits.r_aaa111?.pcb).toEqual({ x: 10, y: 20 });
  });
});
