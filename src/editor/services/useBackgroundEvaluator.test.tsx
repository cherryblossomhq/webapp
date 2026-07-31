import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluatorHarness = vi.hoisted(() => ({
  callbacks: null as null | {
    onResult: (result: {
      version: number;
      inputHash: string;
      circuitJson: unknown[];
      errors: string[];
      issues: Array<{
        id: string;
        type: string;
        message: string;
        severity: "error" | "warning";
      }>;
      durationMs: number;
    }) => void;
  },
}));

vi.mock("./CircuitEvaluator", () => ({
  CircuitEvaluator: class {
    constructor(callbacks: NonNullable<typeof evaluatorHarness.callbacks>) {
      evaluatorHarness.callbacks = callbacks;
    }

    schedule() {}
    dispose() {}
  },
  // Keep placement reconciliation out of this publication-order test.
  hashInput: () => "newer-live-input",
}));

vi.mock("@/editor/issues", () => ({
  collectEvalIssues: vi.fn(async () => []),
}));

import { useCircuitStore } from "@/store/circuitStore";
import { useBackgroundEvaluator } from "./useBackgroundEvaluator";

describe("useBackgroundEvaluator", () => {
  beforeEach(() => {
    evaluatorHarness.callbacks = null;
    useCircuitStore.setState({
      circuitJson: null,
      evalVersion: 0,
      evalInputHash: null,
      evalErrorHash: null,
      evalError: null,
      evalIssues: [],
      evalIssuesVersion: 0,
      isValidating: false,
    });
  });

  it("publishes the result version and hash before making circuitJson available", () => {
    const { unmount } = renderHook(() => useBackgroundEvaluator());
    const snapshots: Array<{
      circuitJson: unknown[] | null;
      evalVersion: number;
      evalInputHash: string | null;
      evalIssuesVersion: number;
    }> = [];
    const unsubscribe = useCircuitStore.subscribe((state) => {
      snapshots.push({
        circuitJson: state.circuitJson,
        evalVersion: state.evalVersion,
        evalInputHash: state.evalInputHash,
        evalIssuesVersion: state.evalIssuesVersion,
      });
    });

    act(() => {
      evaluatorHarness.callbacks?.onResult({
        version: 1,
        inputHash: "result-input",
        circuitJson: [],
        errors: [],
        issues: [],
        durationMs: 1,
      });
    });

    const firstAvailable = snapshots.find((state) => state.circuitJson !== null);
    expect(firstAvailable).toMatchObject({
      evalVersion: 1,
      evalInputHash: "result-input",
      evalIssuesVersion: 0,
    });

    unsubscribe();
    unmount();
  });
});
