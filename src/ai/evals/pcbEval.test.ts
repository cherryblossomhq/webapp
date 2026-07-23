import { describe, expect, it } from "vitest";

import { PCB_EVAL_CASES } from "./cases";
import { evaluatePcbAttempt, summarizePcbEval } from "./pcbEval";

const PASSING_TSX = `export default () => (
  <board width="40mm" height="25mm" layers={2}>
    <chip
      name="U1"
      footprint="soic8"
      connections={{ VCC: "net.V3_3", GND: "net.GND" }}
    />
  </board>
)`;

describe("evaluatePcbAttempt", () => {
  it("scores a structurally and electrically correct circuit", () => {
    const result = evaluatePcbAttempt(
      {
        id: "rails",
        title: "Power rails",
        category: "connectivity",
        userPrompt: "wire power",
        initialTsx: "",
        expectations: {
          componentCount: 1,
          components: [{ name: "U1", elementTag: "chip", props: { footprint: "soic8" } }],
          connections: [
            { from: "U1.VCC", to: "net.V3_3" },
            { from: "U1.GND", to: "net.GND" },
          ],
          requiredNets: ["V3_3", "GND"],
          board: { width: "40mm", height: "25mm", layers: 2 },
          requiredTools: ["edit_tsx"],
          maxErrors: 0,
        },
      },
      {
        tsx: PASSING_TSX,
        tools: [{ name: "edit_tsx", ok: true }],
        issues: [],
      },
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.failures).toEqual([]);
  });

  it("treats malformed TSX as a fatal failure", () => {
    const result = evaluatePcbAttempt(PCB_EVAL_CASES[0], {
      tsx: "export default () => (<board>",
      tools: [{ name: "edit_tsx", ok: true }],
    });

    expect(result.passed).toBe(false);
    expect(result.fatalFailures[0]).toContain("TSX syntax error");
  });

  it("reports missing tools, components, properties, and connections", () => {
    const result = evaluatePcbAttempt(
      {
        id: "missing",
        title: "Missing requirements",
        category: "full-design",
        userPrompt: "build",
        initialTsx: "",
        expectations: {
          components: [{ name: "U2", elementTag: "chip", props: { footprint: "qfn32" } }],
          connections: [{ from: "U2.VCC", to: "net.VCC" }],
          requiredTools: ["fetch_datasheet"],
        },
      },
      { tsx: PASSING_TSX, tools: [] },
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Required tool did not succeed: fetch_datasheet");
    expect(result.failures).toContain("Missing component U2");
    expect(result.failures).toContain("Missing connection U2.VCC -> net.VCC");
  });

  it("scores bounded recovery and efficiency", () => {
    const result = evaluatePcbAttempt(
      {
        id: "repair",
        title: "Repair",
        category: "repair",
        userPrompt: "repair",
        initialTsx: "",
        expectations: {
          maxRepairAttempts: 2,
          maxDurationMs: 2_000,
          maxTotalTokens: 2_000,
          maxCostUsd: 0.05,
        },
      },
      {
        tsx: PASSING_TSX,
        hadRecoverableFailure: true,
        repairAttempts: 1,
        durationMs: 500,
        inputTokens: 500,
        outputTokens: 250,
        costUsd: 0.01,
      },
    );

    expect(result.passed).toBe(true);
    expect(result.breakdown.recovery).toBe(10);
    expect(result.breakdown.efficiency).toBe(10);
  });

  it("does not give free recovery credit for unnecessary repair turns", () => {
    const result = evaluatePcbAttempt(
      {
        id: "unnecessary-repair",
        title: "Unnecessary repair",
        category: "repair",
        userPrompt: "noop",
        initialTsx: "",
        expectations: {},
      },
      { tsx: PASSING_TSX, repairAttempts: 1 },
    );

    expect(result.breakdown.recovery).toBe(0);
    expect(result.failures).toContain("Unnecessary repair attempt");
  });
});

describe("summarizePcbEval", () => {
  it("summarizes pass rate, average score, and failed IDs", () => {
    const summary = summarizePcbEval([
      {
        caseId: "a",
        passed: true,
        score: 100,
        breakdown: { structure: 35, toolUse: 25, electrical: 20, recovery: 10, efficiency: 10 },
        failures: [],
        fatalFailures: [],
      },
      {
        caseId: "b",
        passed: false,
        score: 50,
        breakdown: { structure: 35, toolUse: 0, electrical: 5, recovery: 10, efficiency: 0 },
        failures: ["failed"],
        fatalFailures: [],
      },
    ]);

    expect(summary).toEqual({ passRate: 50, averageScore: 75, failedCaseIds: ["b"] });
  });
});

describe("PCB_EVAL_CASES", () => {
  it("has unique IDs and covers the major PCB-agent categories", () => {
    const ids = PCB_EVAL_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(PCB_EVAL_CASES.map((testCase) => testCase.category))).toEqual(
      new Set([
        "component-edit",
        "connectivity",
        "component-selection",
        "datasheet",
        "full-design",
        "repair",
        "placement",
      ]),
    );
  });
});
