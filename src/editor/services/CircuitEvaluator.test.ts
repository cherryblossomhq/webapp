import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitEvaluator, hashInput } from "./CircuitEvaluator";
import type { EvaluatorExecutor } from "./CircuitEvaluator";
import type { ManualEditsMap } from "../shared/types";

// A controllable mock executor — tests advance its lifecycle by hand.
function makeMockExecutor() {
  let resolveExecute: (() => void) | null = null;
  const calls = {
    executeWithFsMap: 0,
    renderUntilSettled: 0,
    getCircuitJson: 0,
    kill: 0,
  };
  let circuitJson: unknown[] = [];
  const executor: EvaluatorExecutor = {
    executeWithFsMap: vi.fn(async () => {
      calls.executeWithFsMap += 1;
      await new Promise<void>((res) => {
        resolveExecute = res;
      });
    }),
    renderUntilSettled: vi.fn(async () => {
      calls.renderUntilSettled += 1;
    }),
    getCircuitJson: vi.fn(async () => {
      calls.getCircuitJson += 1;
      return circuitJson;
    }),
    kill: vi.fn(async () => {
      calls.kill += 1;
      // If kill happens while we're still waiting in execute, free the
      // promise so the parent task can settle.
      if (resolveExecute) {
        const r = resolveExecute;
        resolveExecute = null;
        r();
      }
    }),
  };
  return {
    executor,
    calls,
    finishExecute: () => {
      const r = resolveExecute;
      resolveExecute = null;
      r?.();
    },
    setCircuitJson: (json: unknown[]) => {
      circuitJson = json;
    },
  };
}

describe("hashInput", () => {
  it("produces an 8-char lowercase hex digest", () => {
    const h = hashInput("export default () => (<board />)", {});
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when tsx changes", () => {
    const a = hashInput("export default () => (<board />)", {});
    const b = hashInput("export default () => (<board width='10mm' />)", {});
    expect(a).not.toBe(b);
  });

  it("changes when manualEdits change", () => {
    const empty: ManualEditsMap = {};
    const populated: ManualEditsMap = {
      r_aaa111: { schematic: { x: 1, y: 2 } },
    };
    expect(hashInput("x", empty)).not.toBe(hashInput("x", populated));
  });

  it("is order-independent in manualEdits keys", () => {
    const a: ManualEditsMap = {
      r_aaa111: { schematic: { x: 1 } },
      c_bbb222: { schematic: { y: 2 } },
    };
    const b: ManualEditsMap = {
      c_bbb222: { schematic: { y: 2 } },
      r_aaa111: { schematic: { x: 1 } },
    };
    expect(hashInput("x", a)).toBe(hashInput("x", b));
  });

  it("CRITICAL (regression for codex P1 #1): nested manualEdits values change the hash", () => {
    // Previous bug: JSON.stringify(m, Object.keys(m).sort()) used the array
    // as a property-name allowlist that applied at EVERY nesting level, so
    // {r_x: {schematic: {x: 1}}} hashed to {r_x: {}} because "schematic"
    // wasn't in the allowlist. Two completely different physical layouts
    // produced identical hashes, defeating the validation gate entirely.
    const a: ManualEditsMap = {
      r_aaa111: { schematic: { x: 1, y: 2, rotation: 0 } },
    };
    const b: ManualEditsMap = {
      r_aaa111: { schematic: { x: 999, y: 2, rotation: 0 } },
    };
    expect(hashInput("x", a)).not.toBe(hashInput("x", b));
  });

  it("CRITICAL: layer, mirror_x, route, and noAutoroute contribute to the hash", () => {
    const base: ManualEditsMap = {
      r_aaa111: { pcb: { x: 0, y: 0, layer: "top", mirror_x: false } },
    };
    const variants: ManualEditsMap[] = [
      { r_aaa111: { pcb: { x: 0, y: 0, layer: "bottom", mirror_x: false } } },
      { r_aaa111: { pcb: { x: 0, y: 0, layer: "top", mirror_x: true } } },
      { r_aaa111: { pcb: { x: 0, y: 0, layer: "top", mirror_x: false, route: [{ x: 1, y: 2, layer: "top" }, { x: 3, y: 4, layer: "top" }] } } },
      { r_aaa111: { pcb: { x: 0, y: 0, layer: "top", mirror_x: false, noAutoroute: true } } },
    ];
    const baseHash = hashInput("x", base);
    for (const v of variants) {
      expect(hashInput("x", v)).not.toBe(baseHash);
    }
  });

  it("route order matters (different routes hash differently)", () => {
    const a: ManualEditsMap = {
      t_aaa111: { pcb: { route: [{ x: 1, y: 2, layer: "top" }, { x: 3, y: 4, layer: "top" }] } },
    };
    const b: ManualEditsMap = {
      t_aaa111: { pcb: { route: [{ x: 3, y: 4, layer: "top" }, { x: 1, y: 2, layer: "top" }] } },
    };
    expect(hashInput("x", a)).not.toBe(hashInput("x", b));
  });
});

describe("CircuitEvaluator — versioning + result delivery", () => {
  let mock: ReturnType<typeof makeMockExecutor>;
  let evaluator: CircuitEvaluator;

  beforeEach(() => {
    mock = makeMockExecutor();
  });

  afterEach(() => {
    evaluator?.dispose();
  });

  it("emits versioned, hashed results when evaluation succeeds", async () => {
    mock.setCircuitJson([{ type: "source_component", name: "R1" }]);
    const onResult = vi.fn();
    evaluator = new CircuitEvaluator({
      executorFactory: () => mock.executor,
      onResult,
    });
    const promise = evaluator.evaluateNow("export default () => (<board/>)", {});
    // Allow the executor to complete its (synchronous mock) flow.
    mock.finishExecute();
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.inputHash).toMatch(/^[0-9a-f]{8}$/);
    expect(result?.errors).toEqual([]);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("collects embedded error messages into result.errors", async () => {
    mock.setCircuitJson([
      { type: "source_component", name: "R1" },
      { type: "compile_error", message: "syntax error on line 3" },
      { type: "drc_warning", message: "trace too narrow" },
    ]);
    evaluator = new CircuitEvaluator({
      executorFactory: () => mock.executor,
    });
    const promise = evaluator.evaluateNow("export default () => (<board/>)", {});
    mock.finishExecute();
    const result = await promise;
    expect(result?.errors).toEqual([
      "syntax error on line 3",
      "trace too narrow",
    ]);
    expect(result?.issues.map((issue) => issue.severity)).toEqual([
      "error",
      "warning",
    ]);
  });

  it("emits versions monotonically across evaluations", async () => {
    mock.setCircuitJson([]);
    const versions: number[] = [];
    evaluator = new CircuitEvaluator({
      executorFactory: () => mock.executor,
      onResult: (r) => versions.push(r.version),
    });
    for (let i = 0; i < 3; i++) {
      const p = evaluator.evaluateNow(`tsx${i}`, {});
      mock.finishExecute();
      await p;
    }
    expect(versions).toEqual([1, 2, 3]);
  });

  it("CRITICAL: cancels in-flight evaluation on a new request and doesn't leak the executor", async () => {
    const first = makeMockExecutor();
    const second = makeMockExecutor();
    second.setCircuitJson([{ type: "source_component", name: "R2" }]);

    let createCount = 0;
    evaluator = new CircuitEvaluator({
      executorFactory: () => {
        createCount += 1;
        return createCount === 1 ? first.executor : second.executor;
      },
    });

    // Start the first eval but don't let it resolve yet.
    const firstPromise = evaluator.evaluateNow("tsx-A", {});
    // Yield once so executeWithFsMap actually starts.
    await Promise.resolve();
    // Now schedule a second eval — should kill the first.
    const secondPromise = evaluator.evaluateNow("tsx-B", {});
    second.finishExecute();
    const r2 = await secondPromise;
    // First should resolve to null (superseded).
    const r1 = await firstPromise;
    expect(r1).toBeNull();
    expect(r2?.version).toBe(2);
    // The first executor must have been told to clean up.
    expect(first.calls.kill).toBeGreaterThanOrEqual(1);
  });

  it("CRITICAL: stale (older-version) results are dropped via onResult monotonicity", async () => {
    const onResult = vi.fn();
    evaluator = new CircuitEvaluator({
      executorFactory: () => mock.executor,
      onResult,
    });
    mock.setCircuitJson([]);
    // Evaluate twice — first should reach onResult; the second too.
    const p1 = evaluator.evaluateNow("tsx-A", {});
    mock.finishExecute();
    await p1;
    const p2 = evaluator.evaluateNow("tsx-B", {});
    mock.finishExecute();
    await p2;
    const versions = onResult.mock.calls.map((c) => c[0].version);
    expect(versions).toEqual([1, 2]);
    // Versions are strictly increasing — even if a stale result raced in
    // late we'd never see a regression.
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
  });

  it("emits an error result when the executor throws", async () => {
    const failing: EvaluatorExecutor = {
      executeWithFsMap: vi.fn(async () => {
        throw new Error("boom");
      }),
      renderUntilSettled: vi.fn(),
      getCircuitJson: vi.fn(async () => []),
      kill: vi.fn(),
    };
    const onError = vi.fn();
    evaluator = new CircuitEvaluator({
      executorFactory: () => failing,
      onError,
    });
    const result = await evaluator.evaluateNow("tsx", {});
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      version: 1,
      message: "boom",
    });
  });

  it("dispose stops further results from being emitted", async () => {
    const onResult = vi.fn();
    evaluator = new CircuitEvaluator({
      executorFactory: () => mock.executor,
      onResult,
    });
    evaluator.dispose();
    // Schedule another eval — should be a no-op; nextVersion stays unchanged.
    const v = evaluator.schedule("tsx", {});
    expect(v).toBe(1);
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe("CircuitEvaluator — debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses bursts of schedule() calls into a single evaluation", async () => {
    const mock = makeMockExecutor();
    mock.setCircuitJson([]);
    let createCount = 0;
    const evaluator = new CircuitEvaluator({
      debounceMs: 50,
      executorFactory: () => {
        createCount += 1;
        return mock.executor;
      },
    });
    evaluator.schedule("a", {});
    evaluator.schedule("b", {});
    evaluator.schedule("c", {});
    expect(createCount).toBe(0);
    vi.advanceTimersByTime(60);
    // Microtask queue still pending — drain it.
    await Promise.resolve();
    mock.finishExecute();
    await Promise.resolve();
    await Promise.resolve();
    expect(createCount).toBe(1);
    evaluator.dispose();
  });
});
