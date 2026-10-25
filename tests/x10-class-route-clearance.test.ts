import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoroute } from "../src/model/autoroute";
import { computeConnectivity } from "../src/model/connectivity";
import { importKicadBoard } from "../src/model/kicad/board";
import { analyzePcb } from "../src/model/pcb";
import type { Project } from "../src/model/types";
import { board, footprint, pad } from "./kicad-board-fixtures";

// A wide class with a low clearance (width 2, clearance 0.2) on a board whose Default clearance is 0.7. The router seeds a wide
// trace from a pad's copper and, once it had, tied the trace to the pad's centre: on a pad narrower than the trace, that centre
// is nearer the next pad than the cells the keepouts were made for, and the trace broke the 0.7 the pair keeps (found on the
// pcbench domotics_out board: 0.690 mm < 0.7 mm).

const clearanceErrors = (p: Project) =>
  analyzePcb(p, computeConnectivity(p))
    .violations.filter((v) => v.kind === "clearance")
    .map((v) => v.message);
const bare = (p: Project): Project => ({
  ...p,
  traces: [],
  vias: [],
  zones: [],
});

/** Pads of 3.5 x 1.7 at 2.54 pitch (a power transistor's), the middle one on the class Power, the one above it on a net of Default, and the one below on another net of Power (pairs at 0.2). */
const synthetic = (dy = 0) => {
  const q = footprint({
    token: "module",
    ref: "Q1",
    at: `20 ${15 + dy}`,
    pads: [
      pad({
        number: "1",
        type: "thru_hole",
        shape: "oval",
        at: "0 -2.54",
        size: "3.5 1.7",
        layers: '"*.Cu" "*.Mask"',
        extra: "(drill 1)",
        net: "(net 2 SIG)",
      }),
      pad({
        number: "2",
        type: "thru_hole",
        shape: "oval",
        at: "0 0",
        size: "3.5 1.7",
        layers: '"*.Cu" "*.Mask"',
        extra: "(drill 1)",
        net: "(net 1 /OUT)",
      }),
      pad({
        number: "3",
        type: "thru_hole",
        shape: "oval",
        at: "0 2.54",
        size: "3.5 1.7",
        layers: '"*.Cu" "*.Mask"',
        extra: "(drill 1)",
        net: "(net 3 /OTHER)",
      }),
    ],
  });
  const r1 = footprint({
    token: "module",
    ref: "R1",
    at: `32 ${12.46 + dy}`,
    pads: [
      pad({ number: "1", at: "0 0", size: "1.5 1.5", net: "(net 2 SIG)" }),
    ],
  });
  const r2 = footprint({
    token: "module",
    ref: "R2",
    at: `32 ${15 + dy}`,
    pads: [
      pad({ number: "1", at: "0 0", size: "1.5 1.5", net: "(net 1 /OUT)" }),
    ],
  });
  const r3 = footprint({
    token: "module",
    ref: "R3",
    at: `32 ${17.54 + dy}`,
    pads: [
      pad({ number: "1", at: "0 0", size: "1.5 1.5", net: "(net 3 /OTHER)" }),
    ],
  });
  // a pad too small for the 2 mm trace joins Q1.2 first, in 0.3 mm, and the wide trace to this big pad then starts from that stub
  const r4 = footprint({
    token: "module",
    ref: "R4",
    at: `6 ${15 + dy}`,
    pads: [pad({ number: "1", at: "0 0", size: "3 3", net: "(net 1 /OUT)" })],
  });
  const classes = [
    `(net_class Default "" (clearance 0.7) (trace_width 0.25) (via_dia 0.8) (via_drill 0.4) (uvia_dia 0.3) (uvia_drill 0.1) (add_net SIG))`,
    `(net_class Power "" (clearance 0.2) (trace_width 2) (via_dia 0.8) (via_drill 0.4) (uvia_dia 0.3) (uvia_drill 0.1) (add_net /OUT) (add_net /OTHER))`,
  ];
  return board({
    version: 20171130,
    header: "(host pcbnew 5.1.12)",
    setup: "(setup (pad_to_mask_clearance 0))",
    nets: ['(net 0 "")', "(net 1 /OUT)", "(net 2 SIG)", "(net 3 /OTHER)"],
    outline: `(gr_line (start 0 0) (end 80 0) (layer Edge.Cuts) (width 0.1)) (gr_line (start 80 0) (end 80 40) (layer Edge.Cuts) (width 0.1)) (gr_line (start 80 40) (end 0 40) (layer Edge.Cuts) (width 0.1)) (gr_line (start 0 40) (end 0 0) (layer Edge.Cuts) (width 0.1))`,
    body: [q, r1, r2, r3, r4, ...classes],
  });
};

const load = (text: string | Uint8Array): Project => {
  const r = importKicadBoard(text as string);
  if (r.status !== "imported") throw new Error("not imported");
  return bare(r.project);
};

describe("a class with a low clearance and a wide trace", () => {
  // where the board sits on the router's grid decides which cell the wide trace starts from, so several places
  it.each([0.01, 0.07, 0.11, 0.16])(
    "keeps the pair's clearance from the next pad where its trace leaves a pad narrower than itself (synthetic, moved %s mm)",
    (dy) => {
      const p = load(synthetic(dy));
      expect(p.rules.clearance).toBe(0.7);
      expect(p.rules.netClasses?.[0]).toMatchObject({
        name: "Power",
        clearance: 0.2,
        traceWidth: 2,
      });
      const res = autoroute(p, { timeLimitMs: 30_000 });
      expect(res.project.traces.some((t) => t.width === 2)).toBe(true);
      expect(clearanceErrors(res.project)).toEqual([]);
    },
  );
  it("a board with no classes routes as before: the same copper with the class taken out is unchanged by it", () => {
    const p = load(synthetic());
    const none: Project = {
      ...p,
      rules: { ...p.rules, netClasses: undefined },
    };
    const a = autoroute(none, { timeLimitMs: 30_000 });
    const b = autoroute(
      { ...none, rules: { ...none.rules, netClasses: [] } },
      { timeLimitMs: 30_000 },
    );
    expect(b.project.traces.map((t) => ({ ...t, id: "" }))).toEqual(
      a.project.traces.map((t) => ({ ...t, id: "" })),
    );
    expect(clearanceErrors(a.project)).toEqual([]);
  });
});

const CORPUS = process.env.KICAD_CORPUS;
const DOMOTICS = CORPUS
  ? join(CORPUS, "pcbench", "PCBs", "domotics_out-board", "raw.kicad_pcb")
  : "";
describe.skipIf(!CORPUS || !existsSync(DOMOTICS))(
  "the pcbench domotics_out board (corpus)",
  () => {
    it("routes with its Power class (clearance 0.2, width 2, Default 0.7) with no clearance error", () => {
      const p = load(new Uint8Array(readFileSync(DOMOTICS)));
      expect(p.rules.clearance).toBe(0.7);
      expect(p.rules.netClasses).toHaveLength(1);
      expect(p.rules.netClasses![0]).toMatchObject({
        name: "Power",
        clearance: 0.2,
        traceWidth: 2,
      });
      expect(p.rules.netClasses![0].nets).toHaveLength(8);
      const res = autoroute(p, { timeLimitMs: 60_000 });
      expect(clearanceErrors(res.project)).toEqual([]);
    }, 180_000);
  },
);
