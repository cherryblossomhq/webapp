// Shared PcbModel fixtures for the routing unit tests.
//
// Nothing in the app imports this file — it exists so routeGraph.test.ts,
// routeAssist.test.ts and friends can pose a board without hand-rolling the
// dozen empty maps a real `PcbModel` carries.

import type { PcbModel, PcbPadRecord } from "./pcbModel";
import { DEFAULT_BOARD_CLEARANCES } from "./routeClearance";

export function makePad(over: Partial<PcbPadRecord> = {}): PcbPadRecord {
  return {
    componentKey: "r_abc123",
    pcbComponentId: "pc_r1",
    x: 0,
    y: 0,
    layer: "top",
    isThroughHole: false,
    shape: "rect",
    rectWidth: 0.8,
    rectHeight: 0.5,
    rotationDeg: 0,
    pcbPortId: "p1",
    portHints: ["1"],
    ...over,
  };
}

export function makeModel(over: Partial<PcbModel> = {}): PcbModel {
  const model: PcbModel = {
    board: {
      centerX: 0,
      centerY: 0,
      width: 40,
      height: 40,
      clearances: DEFAULT_BOARD_CLEARANCES,
    },
    components: [],
    pads: [],
    traces: [],
    vias: [],
    silkscreenLines: [],
    silkscreenShapes: [],
    silkscreenTexts: [],
    nets: [],
    unroutedNets: [],
    byKey: new Map(),
    keyByPcbComponentId: new Map(),
    padByPortId: new Map(),
    padBySelector: new Map(),
    selectorByPad: new Map(),
    ...over,
  };
  return model;
}

/** Wire `padBySelector` / `selectorByPad` for a list of `[selector, pad]` pairs. */
export function withSelectors(
  model: PcbModel,
  pairs: ReadonlyArray<readonly [string, PcbPadRecord]>
): PcbModel {
  for (const [sel, pad] of pairs) {
    model.padBySelector.set(sel, pad);
    model.selectorByPad.set(pad, sel);
  }
  return model;
}
