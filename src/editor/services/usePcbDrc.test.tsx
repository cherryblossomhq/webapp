import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drcHarness = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("@/editor/pcb/drc", () => ({
  runPcbDrc: drcHarness.run,
}));

import type { DrcViolation } from "@/editor/pcb/drc";
import { useEditorStore } from "@/editor/state/editorStore";
import { useCircuitStore } from "@/store/circuitStore";
import { usePcbDrc } from "./usePcbDrc";

describe("usePcbDrc", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    drcHarness.run.mockReset();
    useEditorStore.setState({ manualEdits: {} });
    useCircuitStore.setState({
      circuitJson: [{ type: "pcb_board" }] as never[],
      drcViolations: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops an in-flight DRC result after the PCB tab unmounts", async () => {
    let resolveRun: ((violations: DrcViolation[]) => void) | undefined;
    drcHarness.run.mockReturnValue(
      new Promise<DrcViolation[]>((resolve) => {
        resolveRun = resolve;
      }),
    );

    const { unmount } = renderHook(() => usePcbDrc());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(drcHarness.run).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      resolveRun?.([
        {
          id: "late",
          type: "pcb_trace_error",
          message: "Late violation",
          center: null,
        },
      ]);
      await Promise.resolve();
    });

    expect(useCircuitStore.getState().drcViolations).toEqual([]);
  });
});
