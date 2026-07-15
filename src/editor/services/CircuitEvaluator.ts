// CircuitEvaluator wraps @tscircuit/eval's CircuitRunner with:
//   - Debouncing (so we don't re-evaluate on every keystroke).
//   - Monotonic versioning (so consumers can drop stale results).
//   - Hash of the inputs (so consumers can verify a result matches a specific
//     tsx snapshot, closing the chat-validation race from codex finding #6).
//   - Cancellation that's leak-free; kill() the in-flight runner on every
//     new request.
//
// Phase 0 ships this as a main-thread runner (CircuitRunner). The plan calls
// for moving it into a real WebWorker via createCircuitWebWorker; both share
// the same executeWithFsMap / getCircuitJson shape, so the swap is local
// to defaultExecutor below.

import type { EvaluatorError, EvaluatorResult, ManualEditsMap } from "../shared/types";
import { log } from "@/utils/logger";

// Subset of CircuitRunner's API that we depend on. Keeping this narrow means
// the executor is trivial to mock in tests.
export interface EvaluatorExecutor {
  executeWithFsMap(opts: {
    fsMap: Record<string, string>;
    mainComponentPath?: string;
  }): Promise<void>;
  renderUntilSettled(): Promise<void>;
  getCircuitJson(): Promise<unknown[]>;
  kill(): Promise<void>;
}

// Factory; caller can override for tests.
export type ExecutorFactory = () => EvaluatorExecutor;

// Recursive stable-key JSON serializer. Sorts object keys at every level so
// the output is order-independent, AND (unlike JSON.stringify with an array
// replacer, which whitelists property names at every nesting level and silently
// strips everything else) preserves nested values verbatim. Arrays keep their
// original order because order is semantically meaningful for waypoints, etc.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

// A small synchronous string hash (FNV-1a 32-bit). Good enough to detect
// "did the input change between request and reply" but not a security primitive.
//
// Bug history: the previous JSON.stringify(m, Object.keys(m).sort()) shape was
// a footgun: the array replacer is an allowlist of property names that applies
// at EVERY nesting level, so {r_x: {schematic: {x: 1}}} hashed to {r_x: {}}
// because "schematic" wasn't on the allowlist. Identical hashes for completely
// different physical-layout state defeated the whole "tsx + sidecar snapshot"
// contract. The recursive stableStringify above is the fix.
export function hashInput(tsx: string, manualEdits: ManualEditsMap): string {
  const stableEdits = stableStringify(manualEdits);
  // Use a separator that can't appear in either tsx or the JSON output, so
  // (tsx="foo", edits={a:1}) and (tsx="fo", edits={o:{a:1}}) hash differently.
  const s = tsx + " " + stableEdits;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const DEFAULT_DEBOUNCE_MS = 300;
// Ceiling for a single eval before it's killed and surfaced as an error. Tuned
// for the AI-generated circuits Opus produces — a large board (many parts +
// autorouting) can take well over 10s to render-until-settled, and a too-tight
// ceiling turned every heavy render into a spurious failure. Successful fast
// renders still return the instant they settle, so this only governs how long a
// genuinely slow/stuck eval is given before giving up.
const DEFAULT_TIMEOUT_MS = 30_000;

interface EvaluatorOptions {
  debounceMs?: number;
  timeoutMs?: number;
  executorFactory?: ExecutorFactory;
  onResult?: (r: EvaluatorResult) => void;
  onError?: (e: EvaluatorError) => void;
}

interface EvaluateRequest {
  version: number;
  tsx: string;
  manualEdits: ManualEditsMap;
  inputHash: string;
}

// Default executor: lazy-loaded so test environments that don't import this
// path never pay the cost of pulling in @tscircuit/eval. The dynamic
// `import()` form is preserved (rather than a top-level `import`) so
// Vite/Rollup can code-split the eval bundle into its own chunk; the
// editor renders the schematic instantly without waiting for the
// (multi-MB) eval runtime to load.
let _circuitRunnerCtor: (new () => EvaluatorExecutor) | null = null;
async function defaultExecutorFactory(): Promise<EvaluatorExecutor> {
  if (!_circuitRunnerCtor) {
    const mod = await import("@tscircuit/eval");
    _circuitRunnerCtor = mod.CircuitRunner as unknown as new () => EvaluatorExecutor;
  }
  return new _circuitRunnerCtor();
}

export class CircuitEvaluator {
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly executorFactory: ExecutorFactory | null;
  private readonly onResult?: (r: EvaluatorResult) => void;
  private readonly onError?: (e: EvaluatorError) => void;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: { executor: EvaluatorExecutor | null; req: EvaluateRequest } | null = null;
  private nextVersion = 1;
  private latestVersionEmitted = 0;
  private disposed = false;
  private pending: { tsx: string; manualEdits: ManualEditsMap } | null = null;

  constructor(opts: EvaluatorOptions = {}) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.executorFactory = opts.executorFactory ?? null;
    this.onResult = opts.onResult;
    this.onError = opts.onError;
  }

  // Schedule a (debounced) evaluation. Returns the version number that will
  // be assigned to this request; consumers can use it to track which result
  // belongs to which input.
  schedule(tsx: string, manualEdits: ManualEditsMap): number {
    if (this.disposed) return this.nextVersion;
    const version = this.nextVersion;
    this.pending = { tsx, manualEdits };
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const p = this.pending;
      this.pending = null;
      if (!p) return;
      void this._run(p.tsx, p.manualEdits);
    }, this.debounceMs);
    return version;
  }

  // Skip the debounce: evaluate immediately. Used by tests and by the
  // initial mount path where we want a result ASAP.
  evaluateNow(tsx: string, manualEdits: ManualEditsMap): Promise<EvaluatorResult | null> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.pending = null;
    }
    return this._run(tsx, manualEdits);
  }

  private async _run(
    tsx: string,
    manualEdits: ManualEditsMap
  ): Promise<EvaluatorResult | null> {
    if (this.disposed) return null;

    // Cancel any in-flight evaluation. We don't await kill(); letting it run
    // in the background is fine; the result will be filtered out by version.
    if (this.inflight) {
      const old = this.inflight;
      this.inflight = null;
      void safeKill(old.executor);
    }

    const version = this.nextVersion++;
    const inputHash = hashInput(tsx, manualEdits);
    const req: EvaluateRequest = { version, tsx, manualEdits, inputHash };

    let executor: EvaluatorExecutor;
    try {
      executor = this.executorFactory
        ? this.executorFactory()
        : await defaultExecutorFactory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[CircuitEvaluator] failed to construct executor:", err);
      this._emitError({ version, inputHash, message });
      return null;
    }

    const myInflight = { executor, req };
    this.inflight = myInflight;

    const start = performance.now();
    const timeoutHandle = setTimeout(() => {
      // If we're still the in-flight evaluation when the timer fires, kill
      // the executor and surface a timeout error.
      if (this.inflight !== myInflight) return;
      this.inflight = null;
      void safeKill(executor);
      this._emitError({
        version,
        inputHash,
        message: `Evaluation timed out after ${this.timeoutMs}ms`,
      });
    }, this.timeoutMs);

    try {
      await executor.executeWithFsMap({
        fsMap: { "main.tsx": tsx },
        mainComponentPath: "main.tsx",
      });
      await executor.renderUntilSettled();
      const circuitJson = (await executor.getCircuitJson()) as unknown[];

      // The evaluation finished. If we've since started a newer one, skip
      // emitting; the newer one will replace us.
      if (this.inflight !== myInflight) return null;
      this.inflight = null;

      const errors = collectErrors(circuitJson);
      const durationMs = performance.now() - start;
      const result: EvaluatorResult = {
        version,
        inputHash,
        circuitJson,
        errors,
        durationMs,
      };
      this._emitResult(result);
      return result;
    } catch (err) {
      if (this.inflight === myInflight) this.inflight = null;
      const message = err instanceof Error ? err.message : String(err);
      log.error("[CircuitEvaluator] evaluation failed:", err);
      this._emitError({ version, inputHash, message });
      return null;
    } finally {
      clearTimeout(timeoutHandle);
      // Make sure we don't leak the executor if it's still ours after a
      // throw; kill in the background.
      if (this.inflight !== myInflight) {
        void safeKill(executor);
      }
    }
  }

  private _emitResult(r: EvaluatorResult) {
    if (r.version <= this.latestVersionEmitted) return;
    this.latestVersionEmitted = r.version;
    try {
      this.onResult?.(r);
    } catch (err) {
      log.error("[CircuitEvaluator] onResult handler threw:", err);
    }
  }

  private _emitError(e: EvaluatorError) {
    try {
      this.onError?.(e);
    } catch (err) {
      log.error("[CircuitEvaluator] onError handler threw:", err);
    }
  }

  // Best-effort cleanup. Safe to call multiple times.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pending = null;
    if (this.inflight) {
      const inflight = this.inflight;
      this.inflight = null;
      void safeKill(inflight.executor);
    }
  }
}

// Defensive wrapper around executor.kill: tolerates implementations that
// return undefined (or throw synchronously) instead of a rejected promise.
async function safeKill(executor: EvaluatorExecutor | null | undefined): Promise<void> {
  if (!executor) return;
  try {
    await Promise.resolve(executor.kill());
  } catch {
    // Already discarding the result; nothing to do.
  }
}

function collectErrors(circuitJson: unknown[]): string[] {
  const out: string[] = [];
  for (const el of circuitJson) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    if (
      typeof r.type === "string" &&
      (r.type.endsWith("_error") || r.type.endsWith("_warning")) &&
      typeof r.message === "string"
    ) {
      out.push(r.message);
    }
  }
  return out;
}
