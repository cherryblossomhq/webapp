import { describe, expect, it } from "vitest";
import {
  applySemanticCircuitTool,
  isSemanticCircuitTool,
} from "./semanticCircuitTools";
import {
  extractBoardConfig,
  extractComponents,
  extractConnections,
  validateTsx,
} from "../utils/tsxTransform";

const BASE = `export default () => (
  <board width="50mm" height="40mm">
    <resistor key="r_keep01" name="R1" resistance="10k" footprint="0603" />
    <capacitor key="c_keep01" name="C1" capacitance="100nF" footprint="0603" />
  </board>
)`;

describe("semanticCircuitTools", () => {
  it("inspects the board without editing it", () => {
    const result = applySemanticCircuitTool(BASE, "inspect_circuit", {});
    expect(result.ok).toBe(true);
    expect(result.edited).toBe(false);
    expect(result.tsx).toBe(BASE);
    const manifest = JSON.parse(result.content) as {
      board: unknown;
      components: Array<{ name: string; tag: string }>;
    };
    expect(manifest.board).toEqual({ width: "50mm", height: "40mm", layers: 2 });
    expect(manifest.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "R1", tag: "resistor" }),
        expect.objectContaining({ name: "C1", tag: "capacitor" }),
      ])
    );
  });

  it("adds a typed component with a generated stable key", () => {
    const result = applySemanticCircuitTool(BASE, "add_component", {
      tag: "mosfet",
      name: "Q1",
      props: { channelType: "n", footprint: "sot23", pcbX: 4.5 },
    });
    expect(result.ok).toBe(true);
    expect(validateTsx(result.tsx).ok).toBe(true);
    const q1 = extractComponents(result.tsx).find((component) => component.name === "Q1");
    expect(q1).toMatchObject({
      elementTag: "mosfet",
      props: { channelType: "n", footprint: "sot23", pcbX: "4.5" },
    });
    expect(q1?.props.key).toMatch(/^q_/);
  });

  it("supports documented testpoints with stable keys", () => {
    const result = applySemanticCircuitTool(BASE, "add_component", {
      tag: "testpoint",
      name: "TP1",
    });

    expect(result.ok).toBe(true);
    const testpoint = extractComponents(result.tsx).find(
      (component) => component.name === "TP1"
    );
    expect(testpoint).toMatchObject({
      elementTag: "testpoint",
    });
    expect(testpoint?.props.key).toMatch(/^tp_/);
  });

  it("requires chip pin labels up front", () => {
    const rejected = applySemanticCircuitTool(BASE, "add_component", {
      tag: "chip",
      name: "U1",
      props: { footprint: "soic8" },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.content).toMatch(/pinLabels/);

    const accepted = applySemanticCircuitTool(BASE, "add_component", {
      tag: "chip",
      name: "U1",
      props: {
        footprint: "soic8",
        pinLabels: { pin1: "GND", pin8: "VCC" },
      },
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.tsx).toContain("pinLabels={{");
  });

  it("updates props and renames without replacing the stable key", () => {
    const result = applySemanticCircuitTool(BASE, "update_component", {
      name: "R1",
      new_name: "R2",
      props: { resistance: "4.7k", pcbRotation: 90, doNotPlace: true },
      delete_props: ["footprint"],
    });
    expect(result.ok).toBe(true);
    const r2 = extractComponents(result.tsx).find((component) => component.name === "R2");
    expect(r2?.props).toMatchObject({
      key: "r_keep01",
      resistance: "4.7k",
      pcbRotation: "90",
      doNotPlace: "true",
    });
    expect(r2?.props.footprint).toBeUndefined();
  });

  it("authors and removes normalized connectivity", () => {
    const connected = applySemanticCircuitTool(BASE, "connect_pins", {
      owner: "R1",
      pin: "pin1",
      target: "net.VCC",
    });
    expect(connected.ok).toBe(true);
    expect(extractConnections(connected.tsx)).toMatchObject([
      { owner: "R1", pinLabel: "pin1", target: "net.VCC" },
    ]);

    const disconnected = applySemanticCircuitTool(
      connected.tsx,
      "disconnect_pin",
      { owner: "R1", pin: "pin1" }
    );
    expect(disconnected.ok).toBe(true);
    expect(extractConnections(disconnected.tsx)).toHaveLength(0);
  });

  it("accepts numeric-leading pin aliases while keeping net names strict", () => {
    const added = applySemanticCircuitTool(BASE, "add_component", {
      tag: "chip",
      name: "U1",
      props: {
        footprint: "soic8",
        pinLabels: { pin1: "3V3", pin2: "GND" },
      },
    });
    expect(added.ok).toBe(true);

    const connectedToAlias = applySemanticCircuitTool(
      added.tsx,
      "connect_pins",
      { owner: "R1", pin: "pin1", target: "U1.3V3" }
    );
    expect(connectedToAlias.ok).toBe(true);

    const connectedFromAlias = applySemanticCircuitTool(
      connectedToAlias.tsx,
      "connect_pins",
      { owner: "U1", pin: "3V3", target: "net.V3_3" }
    );
    expect(connectedFromAlias.ok).toBe(true);
    expect(extractConnections(connectedFromAlias.tsx)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          owner: "R1",
          pinLabel: "pin1",
          target: "U1.3V3",
        }),
        expect.objectContaining({
          owner: "U1",
          pinLabel: "3V3",
          target: "net.V3_3",
        }),
      ])
    );

    expect(
      applySemanticCircuitTool(added.tsx, "connect_pins", {
        owner: "U1",
        pin: "3V3",
        target: "net.3V3",
      }).ok
    ).toBe(false);
  });

  it("rejects references to missing components", () => {
    const result = applySemanticCircuitTool(BASE, "connect_pins", {
      owner: "R1",
      pin: "pin2",
      target: "U404.OUT",
    });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/U404.*not found/);
  });

  it("removes a component and dangling connections", () => {
    const connected = applySemanticCircuitTool(BASE, "connect_pins", {
      owner: "R1",
      pin: "pin2",
      target: "C1.pin1",
    });
    const removed = applySemanticCircuitTool(connected.tsx, "remove_component", {
      name: "C1",
    });
    expect(removed.ok).toBe(true);
    expect(extractComponents(removed.tsx).map((component) => component.name)).toEqual(["R1"]);
    expect(extractConnections(removed.tsx)).toHaveLength(0);
  });

  it("changes board geometry with bounded layer choices", () => {
    const result = applySemanticCircuitTool(BASE, "set_board", {
      width: "80mm",
      layers: 4,
    });
    expect(result.ok).toBe(true);
    expect(extractBoardConfig(result.tsx)).toEqual({
      width: "80mm",
      height: "40mm",
      layers: 4,
    });
    expect(
      applySemanticCircuitTool(BASE, "set_board", { layers: 3 }).ok
    ).toBe(false);
  });

  it("recognizes only the semantic circuit tool names", () => {
    expect(isSemanticCircuitTool("add_component")).toBe(true);
    expect(isSemanticCircuitTool("edit_tsx")).toBe(false);
  });
});
