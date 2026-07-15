import { describe, expect, it, vi } from "vitest";
import type { AnyCircuitElement } from "circuit-json";

// Mock the checks bundle so runPcbDrc's failure path is deterministic and we
// never load the real (heavy) @tscircuit/checks in a unit test.
vi.mock("@tscircuit/checks", () => ({
  runAllRoutingChecks: vi.fn(() => Promise.reject(new Error("boom"))),
}));

import { normalizeDrcViolations, runPcbDrc } from "./drc";

describe("normalizeDrcViolations", () => {
  it("normalizes clearance errors with a center and a content-derived id", () => {
    const raw = [
      {
        type: "pcb_pad_trace_clearance_error",
        error_type: "pcb_pad_trace_clearance_error",
        pcb_pad_trace_clearance_error_id: "e1",
        message: "Pad too close to trace",
        center: { x: 1.5, y: -2 },
      },
    ];
    expect(normalizeDrcViolations(raw)).toEqual([
      {
        // Content-derived (type|center|message), NOT the upstream *_error_id.
        id: "pcb_pad_trace_clearance_error|1.5,-2|Pad too close to trace",
        type: "pcb_pad_trace_clearance_error",
        message: "Pad too close to trace",
        center: { x: 1.5, y: -2 },
      },
    ]);
  });

  it("derives a stable id from type + center + message, ignoring upstream ids", () => {
    const raw = [
      {
        type: "pcb_trace_error",
        error_type: "pcb_trace_error",
        // An index-based upstream id that could be reused by a different
        // violation after a re-check — we must NOT key on it.
        pcb_trace_error_id: "misaligned_via_pt1_3",
        message: "Trace too close to board edge",
        center: { x: 0, y: 10 },
      },
    ];
    const [v] = normalizeDrcViolations(raw);
    expect(v.id).toBe("pcb_trace_error|0,10|Trace too close to board edge");
    expect(v.type).toBe("pcb_trace_error");
  });

  it("gives coincident findings unique ids with a dup counter", () => {
    const dup = {
      type: "pcb_trace_error",
      error_type: "pcb_trace_error",
      message: "same spot",
      center: { x: 1, y: 1 },
    };
    const ids = normalizeDrcViolations([dup, { ...dup }]).map((v) => v.id);
    expect(ids[0]).toBe("pcb_trace_error|1,1|same spot");
    expect(ids[1]).toBe("pcb_trace_error|1,1|same spot#1");
    expect(new Set(ids).size).toBe(2);
  });

  it("returns center: null when the error has no usable center", () => {
    const raw = [
      {
        type: "pcb_port_not_connected_error",
        error_type: "pcb_port_not_connected_error",
        message: "Port not connected",
      },
      {
        type: "pcb_via_trace_clearance_error",
        error_type: "pcb_via_trace_clearance_error",
        message: "partial center",
        center: { x: 3 }, // missing y → not usable
      },
    ];
    const out = normalizeDrcViolations(raw);
    expect(out).toHaveLength(2);
    expect(out[0].center).toBeNull();
    expect(out[1].center).toBeNull();
  });

  it("derives an id even when the element carries no center", () => {
    const raw = [{ type: "pcb_trace_error", message: "no center here" }];
    expect(normalizeDrcViolations(raw)[0].id).toBe(
      "pcb_trace_error|-|no center here",
    );
  });

  it("skips non-objects and entries missing type or message", () => {
    const raw = [
      null,
      "nope",
      42,
      { type: "pcb_trace_error" }, // no message
      { message: "no type" }, // no type
      {
        type: "pcb_trace_error",
        error_type: "pcb_trace_error",
        message: "valid",
        center: { x: 0, y: 0 },
      },
    ];
    const out = normalizeDrcViolations(raw);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("valid");
  });
});

describe("runPcbDrc", () => {
  it("returns [] for empty or null input without loading the checks bundle", async () => {
    expect(await runPcbDrc(null)).toEqual([]);
    expect(await runPcbDrc([])).toEqual([]);
  });

  it("never throws — a checks failure resolves to []", async () => {
    const cj = [{ type: "pcb_trace" }] as unknown as AnyCircuitElement[];
    await expect(runPcbDrc(cj)).resolves.toEqual([]);
  });
});
