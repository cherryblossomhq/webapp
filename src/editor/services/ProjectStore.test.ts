import { describe, it, expect } from "vitest";
import {
  loadProject,
  parseProjectJson,
  ProjectParseError,
  pruneOrphanEdits,
  serializeProject,
  makeProjectFile,
  summarizeManualEdits,
} from "./ProjectStore";
import { connectionId } from "../shared/connectionId";

const SAMPLE_TSX = `export default () => (
  <board width="50mm" height="50mm">
    <resistor name="R1" resistance="10k" />
    <capacitor name="C1" capacitance="100nF" />
  </board>
)
`;

describe("loadProject", () => {
  it("accepts a v1 project and passes tsxCode through untouched", () => {
    const v1 = {
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: {
        r_aaa111: { schematic: { x: 1, y: 2, rotation: 90 } },
      },
    };
    const r = loadProject(v1);
    expect(r.project.version).toBe(1);
    expect(r.project.tsxCode).toBe(SAMPLE_TSX);
    expect(r.project.manualEdits).toEqual(v1.manualEdits);
  });

  it("defaults manualEdits to {} when omitted", () => {
    const r = loadProject({ version: 1, tsxCode: SAMPLE_TSX });
    expect(r.project.manualEdits).toEqual({});
  });

  it("preserves metadata", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      metadata: { title: "T" },
    });
    expect(r.project.metadata).toEqual({ title: "T" });
  });

  it("strips unknown metadata fields (e.g. the removed author)", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      metadata: { title: "T", author: "A" },
    });
    // Only `title` survives — a stale field can't leak back into the saved file.
    expect(r.project.metadata).toEqual({ title: "T" });
  });

  it("falls back to 'Untitled Circuit' when title is missing or non-string", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      metadata: { title: 123 },
    });
    expect(r.project.metadata).toEqual({ title: "Untitled Circuit" });
  });

  it("rejects missing and unsupported project versions", () => {
    expect(() => loadProject({ tsxCode: SAMPLE_TSX })).toThrow(ProjectParseError);
    expect(() =>
      loadProject({ version: 2, tsxCode: SAMPLE_TSX })
    ).toThrow("Unsupported project version: 2");
  });

  it("drops manualEdits entries with malformed keys + records a warning", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: {
        r_valid1: { schematic: { x: 1 } },
        BAD_KEY: { schematic: { x: 2 } },
        notakey: { pcb: { x: 3 } },
      },
    });
    expect(Object.keys(r.project.manualEdits)).toEqual(["r_valid1"]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("strips non-finite numbers from manualEdits", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: {
        r_valid1: { schematic: { x: NaN, y: 2, rotation: Infinity } },
      },
    });
    expect(r.project.manualEdits.r_valid1.schematic).toEqual({ y: 2 });
  });

  it("preserves schematic waypoints on round-trip (wire routes survive save/load)", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: {
        t_wire01: {
          schematic: { waypoints: [[3, 0], [3, 5]] },
        },
      },
    });
    expect(r.project.manualEdits.t_wire01.schematic?.waypoints).toEqual([
      [3, 0],
      [3, 5],
    ]);
  });

  it("sanitizes schematic waypoints, dropping malformed points", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: {
        t_wire02: {
          schematic: {
            waypoints: [
              [1, 2],
              [NaN, 4],
              ["bad", 7],
              [5, 6],
            ],
          },
        },
      },
    });
    expect(r.project.manualEdits.t_wire02.schematic?.waypoints).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it("CRITICAL (regression): preserves pcb.route + width on round-trip", () => {
    // Previous bug: sanitizePcb dropped the `route`/`width` fields. Manual
    // routes survived in the saved file but were stripped on every load — so
    // routing, saving, quitting, and reopening lost all manual traces.
    const route = [
      { x: 1, y: 2, layer: "top" },
      { x: 1, y: 5, layer: "top" },
      { x: 4, y: 5, layer: "bottom" },
      { x: 8, y: 5, layer: "bottom" },
    ];
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: { t_route1: { pcb: { route, width: 0.3 } } },
    });
    expect(r.project.manualEdits.t_route1.pcb?.route).toEqual(route);
    expect(r.project.manualEdits.t_route1.pcb?.width).toBe(0.3);
  });

  it("drops malformed route points and ignores too-short / bad-width routes", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: {
        t_route1: {
          pcb: {
            route: [
              { x: 1, y: 2, layer: "top" },
              { x: NaN, y: 3, layer: "top" }, // bad coord — dropped
              { x: 4, y: 5, layer: "" }, // empty layer — dropped
              { x: 6, y: 7 }, // missing layer — dropped
              { x: 9, y: 9, layer: "bottom" },
            ],
            width: -1, // invalid — dropped
          },
        },
        // A route with fewer than two valid points is meaningless and dropped.
        t_route2: {
          pcb: { route: [{ x: 1, y: 1, layer: "top" }] },
        },
      },
    });
    expect(r.project.manualEdits.t_route1.pcb?.route).toEqual([
      { x: 1, y: 2, layer: "top" },
      { x: 9, y: 9, layer: "bottom" },
    ]);
    expect(r.project.manualEdits.t_route1.pcb?.width).toBeUndefined();
    // A 1-point route is dropped (no `route` field carried through).
    expect(r.project.manualEdits.t_route2?.pcb?.route).toBeUndefined();
  });

  it("preserves PER-POINT width and the noAutoroute marker across save→load", () => {
    // Commit now stamps every vertex with the draft width, so dropping the
    // per-point value would silently re-widen a route to the global default on
    // the next load — and dropping noAutoroute would make the autorouter's
    // trace pop back for copper the user deleted.
    const route = [
      { x: 0, y: 0, layer: "top", width: 0.6 },
      { x: 3, y: 0, layer: "top", width: 0.6 },
    ];
    const saved = serializeProject(
      makeProjectFile({
        tsxCode: SAMPLE_TSX,
        manualEdits: {
          t_route1: { pcb: { route, width: 0.6 } },
          t_gone01: { pcb: { noAutoroute: true } },
        },
      })
    );
    const r = parseProjectJson(saved);
    expect(r.project.manualEdits.t_route1.pcb?.route).toEqual(route);
    expect(r.project.manualEdits.t_gone01.pcb?.noAutoroute).toBe(true);
  });

  it("drops a non-positive per-point width without dropping the point", () => {
    const r = loadProject({
      version: 1,
      tsxCode: SAMPLE_TSX,
      manualEdits: {
        t_route1: {
          pcb: {
            route: [
              { x: 0, y: 0, layer: "top", width: -1 },
              { x: 3, y: 0, layer: "top", width: Number.NaN },
            ],
          },
        },
      },
    });
    expect(r.project.manualEdits.t_route1.pcb?.route).toEqual([
      { x: 0, y: 0, layer: "top" },
      { x: 3, y: 0, layer: "top" },
    ]);
  });
});

describe("parseProjectJson", () => {
  it("throws ProjectParseError on bad JSON", () => {
    expect(() => parseProjectJson("not json {{{")).toThrow(ProjectParseError);
  });

  it("CRITICAL: corrupted-but-valid JSON missing tsxCode is rejected", () => {
    expect(() => parseProjectJson('{"version": 1}')).toThrow(ProjectParseError);
  });

  it("rejects a file with no tsxCode (e.g. a bare components array)", () => {
    const noTsx = JSON.stringify({
      components: [{ name: "R1", type: "resistor", value: "10k", footprint: "0402" }],
    });
    expect(() => parseProjectJson(noTsx)).toThrow(ProjectParseError);
  });

  it("round-trips a v1 project", () => {
    const file = makeProjectFile({
      tsxCode: SAMPLE_TSX,
      manualEdits: { r_aaa111: { schematic: { x: 1, y: 2 } } },
      metadata: { title: "T" },
    });
    const json = serializeProject(file);
    const parsed = parseProjectJson(json);
    expect(parsed.project.tsxCode).toBe(file.tsxCode);
    expect(parsed.project.manualEdits).toEqual(file.manualEdits);
    expect(parsed.project.metadata).toEqual(file.metadata);
  });
});

describe("pruneOrphanEdits", () => {
  it("CRITICAL: drops entries whose key is no longer in the live tsx", () => {
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" />
  </board>
)
`;
    const edits = {
      r_keep11: { schematic: { x: 1 } },
      c_gone22: { schematic: { x: 2 } },
    };
    const { manualEdits, pruned } = pruneOrphanEdits(tsx, edits);
    expect(Object.keys(manualEdits)).toEqual(["r_keep11"]);
    expect(pruned).toEqual(["c_gone22"]);
  });

  it("returns an empty pruned[] when nothing changes", () => {
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" />
  </board>
)
`;
    const edits = { r_keep11: { schematic: { x: 1 } } };
    const { pruned } = pruneOrphanEdits(tsx, edits);
    expect(pruned).toEqual([]);
  });

  it("keeps connection waypoints whose connId is live, prunes dead ones", () => {
    // A pin→pin connection authored on R1 → its content-derived connId must be
    // treated as live even though it isn't a tsx element key.
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" connections={{ pin1: "C1.pin1" }} />
    <capacitor key="c_keep22" name="C1" />
  </board>
)
`;
    const liveConnId = connectionId("R1.pin1", "C1.pin1");
    const edits = {
      [liveConnId]: { schematic: { waypoints: [[1, 2]] as [number, number][] } },
      conn_dead00: { schematic: { waypoints: [[3, 4]] as [number, number][] } },
    };
    const { manualEdits, pruned } = pruneOrphanEdits(tsx, edits);
    expect(Object.keys(manualEdits)).toContain(liveConnId);
    expect(pruned).toEqual(["conn_dead00"]);
  });

  const ROUTE = {
    pcb: {
      route: [
        { x: 0, y: 0, layer: "top" as const },
        { x: 5, y: 0, layer: "top" as const },
      ],
    },
  };

  it("keeps a PCB route whose endpoints are still co-netted (id in liveRouteConnIds)", () => {
    // PCB routes are sidecar-owned (no <trace>), keyed by the connection id of
    // their two PAD endpoints in eval'd port-hint space. The route key matches
    // no `connections` entry (a power-net route joins pad→net pads, not pad→pad)
    // and no element key — liveness comes solely from the caller's co-netted-pad
    // set, derived from the circuit-json. If the route's key is in that set, the
    // copper survives save/reload.
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" connections={{ pin1: "net.VCC" }} />
    <resistor key="r_keep22" name="R2" connections={{ pin1: "net.VCC" }} />
  </board>
)
`;
    const routeKey = connectionId("R1.pin1", "R2.pin1");
    const edits = {
      [routeKey]: ROUTE,
      conn_dead00: { schematic: { waypoints: [[3, 4]] as [number, number][] } },
    };
    const live = new Set([routeKey]);
    const { manualEdits, pruned } = pruneOrphanEdits(tsx, edits, live);
    expect(Object.keys(manualEdits)).toContain(routeKey);
    expect(pruned).toEqual(["conn_dead00"]);
  });

  it("issue #27: prunes an orphaned PCB route whose net no longer exists", () => {
    // Repro: route copper between two co-netted pads, then delete the net /
    // components so the endpoints are no longer co-netted. The route's key is in
    // neither liveKeys, liveConnIds, nor the co-netted-pad set — dead copper
    // that would otherwise persist and export to fab.
    const orphanKey = connectionId("R1.pin1", "R2.pin1");
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" />
    <resistor key="r_keep22" name="R2" />
  </board>
)
`;
    // Live set is non-empty but does NOT contain the orphan key (some other net
    // survives) — proves we prune on absence, not just on an empty set.
    const live = new Set([connectionId("R1.pin2", "R2.pin2")]);
    const { manualEdits, pruned } = pruneOrphanEdits(
      tsx,
      { [orphanKey]: ROUTE },
      live
    );
    expect(manualEdits).toEqual({});
    expect(pruned).toEqual([orphanKey]);
  });

  it("keeps a PCB route for a direct pin→pin connection via liveConnIds alone", () => {
    // A direct pin→pin connection's id equals the route key, so liveConnIds
    // keeps it even with an empty co-netted-pad set.
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" connections={{ pin1: "C1.pin1" }} />
    <capacitor key="c_keep22" name="C1" />
  </board>
)
`;
    const routeKey = connectionId("R1.pin1", "C1.pin1");
    const { manualEdits, pruned } = pruneOrphanEdits(
      tsx,
      { [routeKey]: ROUTE },
      new Set()
    );
    expect(Object.keys(manualEdits)).toContain(routeKey);
    expect(pruned).toEqual([]);
  });

  it("keeps a noAutoroute marker under a synthetic pcbtrace_ key while its trace is live", () => {
    // Deleting an eval trace that resolved no pad pair stores the marker under
    // `pcbtrace_<pcb_trace_id>` (evalTraceEndpoints). liveRouteConnIds includes
    // that key while the trace exists in the circuit-json, so the deletion
    // survives save/reload; once the trace is gone, the marker is orphaned.
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" />
  </board>
)
`;
    const edits = { pcbtrace_pt1: { pcb: { noAutoroute: true } } };
    const kept = pruneOrphanEdits(tsx, edits, new Set(["pcbtrace_pt1"]));
    expect(Object.keys(kept.manualEdits)).toContain("pcbtrace_pt1");
    expect(kept.pruned).toEqual([]);
    const gone = pruneOrphanEdits(tsx, edits, new Set());
    expect(gone.manualEdits).toEqual({});
    expect(gone.pruned).toEqual(["pcbtrace_pt1"]);
  });

  it("keeps every route when liveRouteConnIds is null/omitted (no eval — never guess)", () => {
    // Before the first eval the caller has no circuit-json, so route liveness is
    // unknown. We must keep all routes rather than risk deleting drawn copper.
    const tsx = `export default () => (
  <board>
    <resistor key="r_keep11" name="R1" />
    <resistor key="r_keep22" name="R2" />
  </board>
)
`;
    const orphanKey = connectionId("R1.pin1", "R2.pin1");
    const edits = { [orphanKey]: ROUTE };
    // Omitted (undefined):
    expect(pruneOrphanEdits(tsx, edits).manualEdits).toEqual(edits);
    // Explicit null:
    expect(pruneOrphanEdits(tsx, edits, null).manualEdits).toEqual(edits);
  });

  it("does NOT prune any route when the tsx fails to parse (mid-keystroke safety)", () => {
    // The parse-failure guard must short-circuit before route-orphan analysis,
    // or an invalid tsx would wipe drawn copper — even with a live set passed.
    const orphanKey = connectionId("R1.pin1", "R2.pin1");
    const edits = { [orphanKey]: ROUTE };
    const { manualEdits, pruned } = pruneOrphanEdits(
      "export default () => ( <not really tsx ;;;;",
      edits,
      new Set()
    );
    expect(manualEdits).toEqual(edits);
    expect(pruned).toEqual([]);
  });

  it("CRITICAL (regression for codex P1 #3): does NOT wipe edits when tsx fails to parse", () => {
    // Previous bug: collectKeys() returned an empty Set on parse failure,
    // so pruneOrphanEdits treated every sidecar entry as an orphan. Saving
    // (or autosaving) while the user was mid-keystroke would silently nuke
    // the entire manualEdits map. Fix: collectKeys returns null on parse
    // failure; pruneOrphanEdits returns the input unchanged with pruned=[].
    const brokenTsx = "export default () => ( <not really tsx ;;;;";
    const edits = {
      r_keep11: { schematic: { x: 1 } },
      c_keep22: { pcb: { x: 10, y: 20 } },
    };
    const { manualEdits, pruned } = pruneOrphanEdits(brokenTsx, edits);
    expect(manualEdits).toEqual(edits);
    expect(pruned).toEqual([]);
  });
});

describe("summarizeManualEdits", () => {
  it("returns a sentinel when there are no edits", () => {
    expect(summarizeManualEdits({})).toMatch(/none/);
  });

  it("formats one line per component with schematic + pcb context", () => {
    const summary = summarizeManualEdits({
      r_aaa111: {
        schematic: { x: 12.7, y: -5, rotation: 90 },
        pcb: { x: 10, y: 4, layer: "top" },
      },
    });
    expect(summary).toContain("r_aaa111");
    expect(summary).toContain("schematic(12.7, -5.0, 90deg)");
    expect(summary).toContain("pcb(10.0, 4.0, top)");
  });
});

describe("serializeProject", () => {
  it("refuses to serialize anything other than v1", () => {
    expect(() =>
      serializeProject({ version: 2, tsxCode: SAMPLE_TSX } as never)
    ).toThrow();
  });
});
