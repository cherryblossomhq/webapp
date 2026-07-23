import { describe, expect, it } from "vitest";
import { buildCircuitManifest } from "./circuitManifest";

const TSX = `export default () => (
  <board width="60mm" height="35mm" layers={4}>
    <connector name="J1" standard="usb_c" />
    <chip name="U1" footprint="qfn32" pinLabels={{ pin1: "GND", pin2: "VCC", pin3: "SDA" }}
      connections={{ GND: "net.GND", VCC: "net.V3V3", SDA: "J1.pin1" }} />
    <capacitor name="C1" capacitance="100nF" footprint="0402"
      connections={{ pin1: "net.V3V3", pin2: "net.GND" }} />
  </board>
)`;

describe("buildCircuitManifest", () => {
  it("summarizes inventory, typed components, nets, and direct connections", () => {
    const manifest = buildCircuitManifest(TSX);
    expect(manifest).toContain("Board: 60mm x 35mm | 4 copper layers");
    expect(manifest).toContain("Inventory: 3 components | 5 authored connections");
    expect(manifest).toContain("- J1 <connector> | standard=usb_c");
    expect(manifest).toContain("- net.GND [power]: U1.GND, C1.pin2");
    expect(manifest).toContain("- net.V3V3 [power]: U1.VCC, C1.pin1");
    expect(manifest).toContain("- U1.SDA -> J1.pin1");
  });

  it("includes bounded evaluator findings", () => {
    const issues = Array.from({ length: 14 }, (_, index) => ({
      id: `issue-${index}`,
      type: "test_issue",
      message: `finding ${index}`,
      severity: (index === 0 ? "error" : "warning") as "error" | "warning",
    }));
    const manifest = buildCircuitManifest(TSX, issues);
    expect(manifest).toContain("Evaluation: 1 errors | 13 warnings");
    expect(manifest).toContain("[error] test_issue: finding 0");
    expect(manifest).toContain("... 2 more issues");
    expect(manifest).not.toContain("finding 13");
  });
});
