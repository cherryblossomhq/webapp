import { describe, expect, it } from "vitest";
import {
  buildEditorIssues,
  collectEmbeddedEvalIssues,
  countGroupedIssues,
  groupEditorIssues,
} from "./issues";

describe("circuit issues", () => {
  it("preserves eval severity and drops known noise", () => {
    const issues = collectEmbeddedEvalIssues([
      { type: "source_component", name: "R1" },
      { type: "compile_error", message: "Invalid resistance" },
      {
        type: "source_property_ignored_warning",
        message: "Unused property",
      },
      { type: "source_warning", message: "Pins are underspecified" },
    ]);

    expect(issues.map(({ message, severity }) => ({ message, severity }))).toEqual([
      { message: "Invalid resistance", severity: "error" },
      { message: "Unused property", severity: "warning" },
    ]);
  });

  it("groups repetitions without double-counting eval and DRC", () => {
    const evalIssues = [
      {
        id: "e1",
        type: "pcb_trace_error",
        message: "Trace overlap",
        severity: "error" as const,
      },
      {
        id: "e2",
        type: "pcb_trace_error",
        message: "Trace overlap",
        severity: "error" as const,
      },
      {
        id: "w1",
        type: "source_warning",
        message: "Missing metadata",
        severity: "warning" as const,
      },
    ];
    const drcViolations = [
      {
        id: "d1",
        type: "pcb_trace_error",
        message: "Trace overlap",
        center: { x: 1, y: 2 },
      },
      {
        id: "d2",
        type: "pcb_trace_error",
        message: "Trace overlap",
        center: { x: 3, y: 4 },
      },
    ];

    const groups = groupEditorIssues(
      buildEditorIssues(evalIssues, drcViolations, null),
    );
    const overlap = groups.find((group) => group.message === "Trace overlap");

    expect(overlap).toMatchObject({
      count: 2,
      sources: ["eval", "drc"],
      drcViolationId: "d1",
    });
    expect(countGroupedIssues(groups)).toEqual({ errors: 2, warnings: 1 });
  });

  it("includes a hard eval failure as an error", () => {
    const groups = groupEditorIssues(
      buildEditorIssues([], [], "Syntax exploded"),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      severity: "error",
      message: "Syntax exploded",
      count: 1,
    });
  });
});
