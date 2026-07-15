import { describe, expect, it } from "vitest";
import { CircuitEvaluator } from "@/editor/services/CircuitEvaluator";
import {
  buildPcbModel,
  pcbComponentBoundsFromPads,
  pcbComponentDisplayBbox,
} from "./pcbModel";

const ROTATIONS = [0, 45, 90, 135, 180, 270] as const;

const capTsx = (rot: number) => `export default () => (
  <board width="10mm" height="10mm">
    <capacitor key="c_abc123" name="C1" capacitance="10uF" footprint="0402" pcbX={0} pcbY={0} pcbRotation={${rot}} />
  </board>
)`;

const dipTsx = (rot: number) => `export default () => (
  <board width="50mm" height="50mm">
    <chip key="u1_abc" name="U1" footprint="dip14" pcbX={0} pcbY={0} pcbRotation={${rot}} />
  </board>
)`;

function padExtentsContainDisplay(
  pads: ReturnType<typeof buildPcbModel>["pads"],
  compKey: string,
  display: { width: number; height: number; rotationDeg: number },
  compX: number,
  compY: number
): boolean {
  const mine = pads.filter((p) => p.componentKey === compKey);
  if (mine.length === 0) return false;
  const rad = (display.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = display.width / 2;
  const hh = display.height / 2;
  for (const pad of mine) {
    const dx = pad.x - compX;
    const dy = pad.y - compY;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    if (Math.abs(lx) > hw + 0.15 || Math.abs(ly) > hh + 0.15) return false;
  }
  return true;
}

describe("rotation matrix (live eval)", () => {
  for (const rot of ROTATIONS) {
    it(`0402 capacitor at ${rot}°: display bbox wraps all pads`, async () => {
      const ev = new CircuitEvaluator({ debounceMs: 0, timeoutMs: 30_000 });
      const tsx = capTsx(rot);
      const result = await ev.evaluateNow(tsx, {});
      expect(result).not.toBeNull();

      const m = buildPcbModel(result!.circuitJson as never, tsx, {});
      const c1 = m.components.find((c) => c.name === "C1");
      expect(c1).toBeTruthy();

      const display = pcbComponentDisplayBbox(c1!, m.pads);
      expect(
        padExtentsContainDisplay(m.pads, "c_abc123", display, c1!.x, c1!.y)
      ).toBe(true);
    }, 60_000);

    it(`DIP-14 at ${rot}°: pad-derived bounds match render + hit-test`, async () => {
      const ev = new CircuitEvaluator({ debounceMs: 0, timeoutMs: 30_000 });
      const tsx = dipTsx(rot);
      const result = await ev.evaluateNow(tsx, {});
      expect(result).not.toBeNull();

      const m = buildPcbModel(result!.circuitJson as never, tsx, {});
      const u1 = m.components.find((c) => c.name === "U1");
      expect(u1).toBeTruthy();

      const fromPads = pcbComponentBoundsFromPads(u1!, m.pads);
      const display = pcbComponentDisplayBbox(u1!, m.pads);
      expect(fromPads).not.toBeNull();
      expect(fromPads).toEqual(display);
      expect(display.width).toBeGreaterThan(5);
      expect(display.height).toBeGreaterThan(2);
    }, 60_000);
  }

  it("ignores legacy sidecar rotation in pcbModel", async () => {
    const ev = new CircuitEvaluator({ debounceMs: 0, timeoutMs: 30_000 });
    const tsx = capTsx(0).replace(
      'name="C1"',
      'name="C1" key="c_abc123"'
    );
    const result = await ev.evaluateNow(tsx, {});
    expect(result).not.toBeNull();

    const m = buildPcbModel(result!.circuitJson as never, tsx, {
      c_abc123: { pcb: { rotation: 90 } },
    });
    const c1 = m.components.find((c) => c.name === "C1");
    expect(c1!.rotationDeg).toBe(0);
  }, 60_000);
});
