import { describe, expect, it } from "vitest";
import { CircuitEvaluator } from "@/editor/services/CircuitEvaluator";
import { buildPcbModel, pcbComponentDisplayBbox } from "./pcbModel";

const tsxAt = (rot: number) => `export default () => (
  <board width="10mm" height="10mm">
    <capacitor key="c_abc123" name="C1" capacitance="10uF" footprint="0402" pcbX={0} pcbY={0} pcbRotation={${rot}} />
  </board>
)`;

describe("rotation eval integration", () => {
  it("maps oblique eval output to correct pad rotation and body bbox", async () => {
    const ev = new CircuitEvaluator({ debounceMs: 0, timeoutMs: 30_000 });
    const result = await ev.evaluateNow(tsxAt(45), {});
    expect(result).not.toBeNull();

    const m = buildPcbModel(result!.circuitJson as never, tsxAt(45), {});
    const c1 = m.components.find((c) => c.name === "C1");
    expect(c1).toBeTruthy();
    expect(c1!.originRotationDeg).toBe(45);

    const display = pcbComponentDisplayBbox(c1!, m.pads);
    expect(display.rotationDeg).toBeGreaterThan(40);
    expect(display.rotationDeg).toBeLessThan(50);

    const pads = m.pads.filter((p) => p.componentKey === "c_abc123");
    expect(pads.length).toBe(2);
    for (const p of pads) {
      expect(p.rotationDeg).toBe(45);
    }
  }, 60_000);

  it("keeps cardinal 90° eval pads unrotated in SVG (geometry pre-baked)", async () => {
    const ev = new CircuitEvaluator({ debounceMs: 0, timeoutMs: 30_000 });
    const result = await ev.evaluateNow(tsxAt(90), {});
    expect(result).not.toBeNull();

    const m = buildPcbModel(result!.circuitJson as never, tsxAt(90), {});
    const pads = m.pads.filter((p) => p.componentKey === "c_abc123");
    for (const p of pads) {
      expect(p.rotationDeg).toBe(0);
    }
  }, 60_000);
});

describe("chip silkscreen", () => {
  it("renders the rotated footprint silkscreen including the designator", async () => {
    // The eval bakes pcbRotation into world-space silkscreen geometry, so the
    // footprint's real body outline renders correctly at oblique angles. The
    // owning part is flagged so the canvas skips its synthetic pad-derived
    // outline + notch (which used to be drawn INSTEAD of the real art — far
    // wider than the body, the "chip silkscreen is totally off" bug).
    const tsx = `export default () => (
  <board width="50mm" height="50mm">
    <chip name="U1" footprint="dip14" pcbX={0} pcbY={0} pcbRotation={20} />
  </board>
)`;
    const ev = new CircuitEvaluator({ debounceMs: 0, timeoutMs: 30_000 });
    const result = await ev.evaluateNow(tsx, {});
    expect(result).not.toBeNull();

    const m = buildPcbModel(result!.circuitJson as never, tsx, {});
    expect(m.silkscreenLines.length).toBeGreaterThan(0);
    // Silkscreen face ("top") maps to the editor's silkscreen layer id —
    // near-white color + LayerPanel silkscreen toggle, not copper red.
    for (const line of m.silkscreenLines) {
      expect(line.layer).toBe("silkscreen_top");
    }
    const u1 = m.components.find((c) => c.name === "U1");
    expect(u1?.hasSilkscreenOutline).toBe(true);
    // The eval's designator text is real silkscreen — rendered as-is, not
    // replaced by a synthetic editor label.
    expect(m.silkscreenTexts.map((t) => t.text)).toContain("U1");
  }, 60_000);
});
