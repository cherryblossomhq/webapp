import { describe, it, expect, beforeEach } from "vitest";
import type { AnyCircuitElement } from "circuit-json";
import { useCircuitStore } from "./circuitStore";
import { useEditorStore } from "../editor/state/editorStore";
import { extractConnections } from "../utils/tsxTransform";

const getState = () => useCircuitStore.getState();

describe("circuitStore", () => {
  beforeEach(() => {
    getState().resetCircuit();
    useEditorStore.getState().reset();
  });

  describe("addComponent", () => {
    it("adds a resistor with auto-generated designator", () => {
      const name = getState().addComponent("resistor");
      expect(name).toBe("R1");
      const components = getState().getComponents();
      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("R1");
      expect(components[0].type).toBe("resistor");
      expect(components[0].value).toBe("10k");
      expect(components[0].footprint).toBe("0402");
    });

    it("increments designator for same type", () => {
      getState().addComponent("resistor");
      const name2 = getState().addComponent("resistor");
      expect(name2).toBe("R2");
      expect(getState().getComponents()).toHaveLength(2);
    });

    it("uses correct prefix per component type", () => {
      expect(getState().addComponent("capacitor")).toBe("C1");
      expect(getState().addComponent("inductor")).toBe("L1");
      expect(getState().addComponent("led")).toBe("D1");
      expect(getState().addComponent("ic")).toBe("U1");
      expect(getState().addComponent("transistor_npn")).toBe("Q1");
      expect(getState().addComponent("connector")).toBe("J1");
    });

    it("accepts override values", () => {
      getState().addComponent("resistor", { value: "47k", footprint: "0603" });
      const comp = getState().getComponents()[0];
      expect(comp.value).toBe("47k");
      expect(comp.footprint).toBe("0603");
    });

    it("throws for unknown component type", () => {
      expect(() => getState().addComponent("unknown")).toThrow(
        "Unknown component type"
      );
    });
  });

  describe("removeComponent", () => {
    it("removes a component by name", () => {
      getState().addComponent("resistor");
      getState().addComponent("capacitor");
      getState().removeComponent("R1");
      const components = getState().getComponents();
      expect(components).toHaveLength(1);
      expect(components[0].name).toBe("C1");
    });

    it("clears selection if selected component is deleted", () => {
      getState().addComponent("resistor");
      getState().setSelectedComponent("R1");
      expect(getState().selectedComponentName).toBe("R1");

      getState().removeComponent("R1");
      expect(getState().selectedComponentName).toBeNull();
    });
  });

  describe("updateComponent", () => {
    it("updates component value", () => {
      getState().addComponent("resistor");
      getState().updateComponent("R1", { value: "47k" });
      expect(getState().getComponents()[0].value).toBe("47k");
    });

    it("updates component footprint", () => {
      getState().addComponent("resistor");
      getState().updateComponent("R1", { footprint: "0603" });
      expect(getState().getComponents()[0].footprint).toBe("0603");
    });
  });

  describe("renameComponent", () => {
    it("renames a component", () => {
      getState().addComponent("resistor");
      const result = getState().renameComponent("R1", "R100");
      expect(result.success).toBe(true);
      expect(getState().getComponents()[0].name).toBe("R100");
    });

    it("fails for empty name", () => {
      getState().addComponent("resistor");
      const result = getState().renameComponent("R1", "");
      expect(result.success).toBe(false);
    });

    it("fails for duplicate name", () => {
      getState().addComponent("resistor");
      getState().addComponent("resistor");
      const result = getState().renameComponent("R1", "R2");
      expect(result.success).toBe(false);
    });

    it("returns success for no-op rename (same name)", () => {
      getState().addComponent("resistor");
      const result = getState().renameComponent("R1", "R1");
      expect(result.success).toBe(true);
    });
  });

  describe("connections", () => {
    const conns = () => extractConnections(getState().tsxCode);

    it("writes a pin→pin connection, with the chip as owner", () => {
      getState().addComponent("ic"); // U1 (chip)
      getState().addComponent("resistor"); // R1
      const res = getState().connectPins("R1.pin1", "U1.pin1");
      expect(res?.kind).toBe("wire");
      const c = conns();
      expect(c).toHaveLength(1);
      // Chip-first ownership: U1 owns the entry even though R1 was the origin.
      expect(c[0].owner).toBe("U1");
    });

    it("writes a pin→net connection", () => {
      getState().addComponent("resistor"); // R1
      const res = getState().connectPins("R1.pin2", "net.GND");
      expect(res?.kind).toBe("net");
      const c = conns();
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ owner: "R1", target: "net.GND" });
    });

    it("dedups: connecting the same pair twice is a no-op", () => {
      getState().addComponent("resistor"); // R1
      getState().addComponent("capacitor"); // C1
      getState().connectPins("R1.pin1", "C1.pin1");
      getState().connectPins("C1.pin1", "R1.pin1"); // reverse order
      expect(conns()).toHaveLength(1);
    });

    it("promotes to a net when a 3rd pin joins a pin→pin pair", () => {
      getState().addComponent("resistor"); // R1
      getState().addComponent("capacitor"); // C1
      getState().addComponent("led"); // D1
      getState().connectPins("R1.pin1", "C1.pin1"); // pin→pin
      const res = getState().connectPins("D1.pin1", "R1.pin1"); // 3rd pin
      expect(res?.kind).toBe("promoted");
      const c = conns();
      // Three pin→net entries, all on the same minted net.
      const netTargets = c.filter((x) => x.target.startsWith("net."));
      expect(netTargets).toHaveLength(3);
      expect(new Set(netTargets.map((x) => x.target)).size).toBe(1);
    });

    it("disconnect removes the connection entry", () => {
      getState().addComponent("resistor"); // R1
      getState().addComponent("capacitor"); // C1
      const res = getState().connectPins("R1.pin1", "C1.pin1")!;
      expect(conns()).toHaveLength(1);
      getState().disconnect(res.connId);
      expect(conns()).toHaveLength(0);
    });

    it("joins a bare pin to the net its peer already sits on", () => {
      getState().addComponent("resistor"); // R1
      getState().addComponent("resistor"); // R2
      getState().connectPins("R1.pin1", "net.GND");
      const res = getState().connectPins("R2.pin1", "R1.pin1"); // R1.pin1 ∈ GND
      expect(res?.kind).toBe("net");
      expect(conns().find((x) => x.owner === "R2")!.target).toBe("net.GND");
    });

    it("merges two existing nets when a pin on each is connected (no member stranded)", () => {
      getState().addComponent("resistor"); // R1
      getState().addComponent("resistor"); // R2
      getState().addComponent("resistor"); // R3
      getState().connectPins("R1.pin1", "net.NETA");
      getState().connectPins("R2.pin1", "net.NETB");
      getState().connectPins("R3.pin1", "net.NETB"); // 2nd member of NETB
      const res = getState().connectPins("R1.pin1", "R2.pin1"); // join the nets
      expect(res?.kind).toBe("net");
      const netTargets = conns().filter((x) => x.target.startsWith("net."));
      expect(netTargets).toHaveLength(3);
      // All three collapse onto ONE net…
      expect(new Set(netTargets.map((x) => x.target)).size).toBe(1);
      // …and R3 (never dragged) is carried over, not left behind on net.NETB.
      expect(conns().find((x) => x.owner === "R3")!.target).toBe("net.NETA");
    });

    it("chip-first ownership tiebreak: with two chips, selA's owner wins", () => {
      getState().addComponent("ic"); // U1
      getState().addComponent("ic"); // U2
      const res = getState().connectPins("U2.pin1", "U1.pin1");
      expect(res?.kind).toBe("wire");
      expect(conns()[0].owner).toBe("U2"); // selA origin
    });

    it("ownership tiebreak: with two passives, selA's owner wins", () => {
      getState().addComponent("capacitor"); // C1
      getState().addComponent("resistor"); // R1
      const res = getState().connectPins("C1.pin1", "R1.pin1");
      expect(res?.kind).toBe("wire");
      expect(conns()[0].owner).toBe("C1"); // selA origin
    });
  });

  describe("setBoard", () => {
    it("sets the copper layer count without touching dimensions", () => {
      const before = getState().getBoardConfig();
      getState().setBoard({ layers: 4 });
      const after = getState().getBoardConfig();
      expect(after.layers).toBe(4);
      expect(getState().tsxCode).toContain("layers={4}");
      // Width/height ride through the layers edit unchanged.
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
    });

    it("changing dimensions leaves the layer count intact", () => {
      getState().setBoard({ layers: 4 });
      getState().setBoard({ width: "80mm" });
      const b = getState().getBoardConfig();
      expect(b.width).toBe("80mm");
      expect(b.layers).toBe(4);
    });

    it("dropping back to the 2-layer default strips the prop", () => {
      getState().setBoard({ layers: 4 });
      getState().setBoard({ layers: 2 });
      expect(getState().getBoardConfig().layers).toBe(2);
      expect(getState().tsxCode).not.toContain("layers=");
    });

    it("clamps an out-of-range layer count to the supported max", () => {
      getState().setBoard({ layers: 99 });
      expect(getState().getBoardConfig().layers).toBe(8);
    });
  });

  describe("undo/redo", () => {
    it("can undo adding a component", () => {
      getState().addComponent("resistor");
      expect(getState().getComponents()).toHaveLength(1);

      getState().undo();
      expect(getState().getComponents()).toHaveLength(0);
    });

    it("can redo after undo", () => {
      getState().addComponent("resistor");
      getState().undo();
      expect(getState().getComponents()).toHaveLength(0);

      getState().redo();
      expect(getState().getComponents()).toHaveLength(1);
    });

    it("canUndo returns false for empty history", () => {
      expect(getState().canUndo()).toBe(false);
    });

    it("canRedo returns false when at latest", () => {
      getState().addComponent("resistor");
      expect(getState().canRedo()).toBe(false);
    });
  });

  describe("project I/O", () => {
    it("resets circuit to empty state", () => {
      getState().addComponent("resistor");
      getState().setMetadata("Test");

      getState().resetCircuit();

      expect(getState().getComponents()).toHaveLength(0);
      expect(getState().metadata.title).toBe("Untitled Circuit");
    });

    it("loads a v1 project, preserving keyed tsx and manual edits", () => {
      const tsxCode = `export default () => (
  <board width="60mm" height="40mm" autorouter="sequential-trace">
    <resistor key="r_abc123" name="R1" resistance="10k" footprint="0402" />
  </board>
)
`;
      getState().loadProject({
        version: 1,
        tsxCode,
        manualEdits: { r_abc123: { schematic: { x: 5, y: 7 } } },
        metadata: { title: "My Project" },
      });

      expect(getState().getComponents()).toHaveLength(1);
      // The loader trusts the file: already-keyed tsx is passed through verbatim.
      expect(getState().tsxCode).toBe(tsxCode);
      expect(getState().metadata.title).toBe("My Project");
      // The sidecar hydrates and round-trips back out unchanged.
      expect(getState().getProjectData().manualEdits).toEqual({
        r_abc123: { schematic: { x: 5, y: 7 } },
      });
    });

    it("coerces loaded metadata, dropping stale fields like author", () => {
      getState().loadProject({
        version: 1,
        tsxCode: `export default () => (\n  <board width="50mm" height="50mm" />\n)\n`,
        // A file from before `author` was removed still carries it.
        metadata: { title: "Kept", author: "Dropped" } as { title: string },
      });
      // The loader uses the sanitized metadata, so a stray field can't leak into
      // runtime state (and from there back into the next saved file).
      expect(getState().metadata).toEqual({ title: "Kept" });
    });

    it("serializes and deserializes project data", () => {
      getState().addComponent("resistor");
      getState().addComponent("capacitor");
      getState().setMetadata("My Circuit");

      const data = getState().getProjectData();
      expect(data.version).toBe(1);
      expect(data.tsxCode).toContain("resistor");
      expect(data.manualEdits).toEqual({});

      getState().resetCircuit();
      getState().loadProject(data);

      expect(getState().getComponents()).toHaveLength(2);
      expect(getState().metadata.title).toBe("My Circuit");
    });
  });

  describe("circuit JSON export", () => {
    it("returns null before any circuit has evaluated", () => {
      // resetCircuit (beforeEach) clears circuitJson, mirroring a fresh project
      // whose source hasn't been evaluated yet — nothing to export.
      expect(getState().getCircuitJsonForExport()).toBeNull();
    });

    it("applies the route overlay so export matches the PCB canvas", () => {
      // Autorouted traces ship by default, but a connection the user deleted
      // (noAutoroute in the editor sidecar) must be dropped. The getter must
      // route through overlayManualRoutes, not hand back the raw evaluated
      // circuitJson. This trace resolves no pad pair, so it's keyed by the
      // synthetic fallback key (`pcbtrace_<pcb_trace_id>`).
      getState().setCircuitJson([
        { type: "source_component", source_component_id: "sc1", name: "R1" },
        {
          type: "pcb_trace",
          pcb_trace_id: "pt1",
          route: [
            { route_type: "wire", x: 0, y: 0, width: 0.25, layer: "top" },
            { route_type: "wire", x: 1, y: 0, width: 0.25, layer: "top" },
          ],
        },
      ] as unknown as AnyCircuitElement[]);

      const kept = getState().getCircuitJsonForExport();
      expect((kept ?? []).map((e) => (e as { type: string }).type)).toEqual([
        "source_component",
        "pcb_trace",
      ]);

      useEditorStore.setState({
        manualEdits: { pcbtrace_pt1: { pcb: { noAutoroute: true } } },
      });
      const exported = getState().getCircuitJsonForExport();
      expect(exported).not.toBeNull();
      const types = (exported ?? []).map((e) => (e as { type: string }).type);
      expect(types).toEqual(["source_component"]);
    });
  });

  describe("AI edits", () => {
    it("applies AI TSX and re-injects keys defensively", () => {
      // The model often forgets `key` props on regen; applyAiEdit re-injects.
      const aiTsx = `export default () => (
  <board width="50mm" height="50mm" autorouter="sequential-trace">
    <resistor name="R1" resistance="100k" footprint="0805" />
    <capacitor name="C1" capacitance="1uF" footprint="0603" />
  </board>
)
`;
      const result = getState().applyAiEdit(aiTsx);
      expect(result).toBe(true);
      const live = getState().tsxCode;
      expect(live).toMatch(/<resistor key="r_[a-z0-9]{6}" name="R1"/);
      expect(live).toMatch(/<capacitor key="c_[a-z0-9]{6}" name="C1"/);
      expect(getState().getComponents()).toHaveLength(2);
    });

    it("preserves keys an AI emits explicitly across applyAiEdit", () => {
      const aiTsx = `export default () => (
  <board width="50mm" height="50mm" autorouter="sequential-trace">
    <resistor key="r_alpha1" name="R1" resistance="10k" />
  </board>
)
`;
      getState().applyAiEdit(aiTsx);
      expect(getState().tsxCode).toContain('key="r_alpha1"');
    });
  });

  describe("evaluator versioning (Phase 0)", () => {
    it("starts at evalVersion 0 with no inputHash", () => {
      expect(getState().evalVersion).toBe(0);
      expect(getState().evalInputHash).toBeNull();
    });

    it("monotonically advances evalVersion via setEvalResult", () => {
      getState().setEvalResult({ version: 1, inputHash: "abc" });
      expect(getState().evalVersion).toBe(1);
      expect(getState().evalInputHash).toBe("abc");

      getState().setEvalResult({ version: 5, inputHash: "def" });
      expect(getState().evalVersion).toBe(5);

      // Older versions are dropped silently — no rollback.
      getState().setEvalResult({ version: 3, inputHash: "ghi" });
      expect(getState().evalVersion).toBe(5);
      expect(getState().evalInputHash).toBe("def");
    });

    it("resetCircuit zeroes the eval version", () => {
      getState().setEvalResult({ version: 7, inputHash: "x" });
      getState().resetCircuit();
      expect(getState().evalVersion).toBe(0);
      expect(getState().evalInputHash).toBeNull();
    });

    it("setEvalFailure records the failed input's hash + message under the same monotonic guard", () => {
      getState().setEvalFailure({ version: 2, inputHash: "bad", message: "boom" });
      expect(getState().evalVersion).toBe(2);
      expect(getState().evalErrorHash).toBe("bad");
      expect(getState().evalError).toBe("boom");

      // A stale failure (older version) is dropped, leaving the newer state intact.
      getState().setEvalFailure({ version: 1, inputHash: "older", message: "late" });
      expect(getState().evalVersion).toBe(2);
      expect(getState().evalErrorHash).toBe("bad");
    });

    it("a later good render clears the recorded failure hash", () => {
      getState().setEvalFailure({ version: 3, inputHash: "bad", message: "boom" });
      expect(getState().evalErrorHash).toBe("bad");

      getState().setEvalResult({ version: 4, inputHash: "good" });
      expect(getState().evalInputHash).toBe("good");
      expect(getState().evalErrorHash).toBeNull();
    });
  });
});
