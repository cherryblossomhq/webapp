import { describe, expect, it, vi } from "vitest";

import type { EvalIssue } from "@/editor/shared/types";
import {
  buildCandidateRepairPrompt,
  validateCandidateTsx,
  type CandidateEvaluationRunner,
} from "./candidateValidation";

const VALID_TSX = `export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="1k" footprint="0603" />
  </board>
)`;

function issue(
  id: string,
  severity: "error" | "warning",
  type = "test_error",
): EvalIssue {
  return { id, severity, type, message: `Problem ${id}` };
}

describe("validateCandidateTsx", () => {
  it("rejects malformed TSX before invoking the expensive evaluator", async () => {
    const evaluate = vi.fn<CandidateEvaluationRunner>();
    const result = await validateCandidateTsx({
      candidateTsx: "export default () => (<board>",
      manualEdits: {},
      evaluate,
    });

    expect(result.ok).toBe(false);
    expect(result.evaluationError).toMatch(/syntax error/i);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("allows pre-existing errors and blocks only net-new errors", async () => {
    const existing = issue("existing", "error");
    const added = issue("new", "error");
    const evaluate = vi.fn<CandidateEvaluationRunner>(async () => ({
      circuitJson: [],
      issues: [existing, added],
      durationMs: 12,
    }));

    const result = await validateCandidateTsx({
      candidateTsx: VALID_TSX,
      manualEdits: {},
      baselineIssues: [existing],
      evaluate,
    });

    expect(result.ok).toBe(false);
    expect(result.newErrors).toEqual([added]);
    expect(result.durationMs).toBe(12);
  });

  it("preserves duplicate issue counts when subtracting the baseline", async () => {
    const repeated = issue("same", "error");
    const evaluate = vi.fn<CandidateEvaluationRunner>(async () => ({
      circuitJson: [],
      issues: [repeated, repeated],
      durationMs: 1,
    }));

    const result = await validateCandidateTsx({
      candidateTsx: VALID_TSX,
      manualEdits: {},
      baselineIssues: [repeated],
      evaluate,
    });

    expect(result.newErrors).toHaveLength(1);
  });

  it("returns warnings without blocking the commit", async () => {
    const warning = issue("warning", "warning", "placement_warning");
    const evaluate = vi.fn<CandidateEvaluationRunner>(async () => ({
      circuitJson: [],
      issues: [warning],
      durationMs: 4,
    }));

    const result = await validateCandidateTsx({
      candidateTsx: VALID_TSX,
      manualEdits: {},
      evaluate,
    });

    expect(result.ok).toBe(true);
    expect(result.newWarnings).toEqual([warning]);
  });

  it("fails closed when evaluation throws", async () => {
    const evaluate = vi.fn<CandidateEvaluationRunner>(async () => {
      throw new Error("runner crashed");
    });
    const result = await validateCandidateTsx({
      candidateTsx: VALID_TSX,
      manualEdits: {},
      evaluate,
    });

    expect(result.ok).toBe(false);
    expect(result.evaluationError).toBe("runner crashed");
  });
});

describe("buildCandidateRepairPrompt", () => {
  it("includes the exact draft and prioritizes connectivity over placement", () => {
    const prompt = buildCandidateRepairPrompt({
      ok: false,
      candidateTsx: VALID_TSX,
      issues: [],
      newErrors: [issue("power", "error", "unconnected_power_pin_error")],
      newWarnings: [],
      durationMs: 10,
    });

    expect(prompt).toContain("Connectivity and pin mappings come before placement");
    expect(prompt).toContain("unconnected_power_pin_error");
    expect(prompt).toContain(VALID_TSX);
  });
});
