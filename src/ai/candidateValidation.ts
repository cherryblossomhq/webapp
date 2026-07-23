import type {
  EvalIssue,
  ManualEditsMap,
} from "@/editor/shared/types";
import {
  CircuitEvaluator,
  type EvaluatorExecutor,
} from "@/editor/services/CircuitEvaluator";
import { collectEvalIssues } from "@/editor/issues";
import { validateTsx } from "@/utils/tsxTransform";

export interface CandidateEvaluationSnapshot {
  circuitJson: unknown[];
  issues: EvalIssue[];
  durationMs: number;
}

export type CandidateEvaluationRunner = (
  tsx: string,
  manualEdits: ManualEditsMap,
) => Promise<CandidateEvaluationSnapshot>;

export interface CandidateValidationOptions {
  candidateTsx: string;
  manualEdits: ManualEditsMap;
  baselineIssues?: readonly EvalIssue[];
  evaluate?: CandidateEvaluationRunner;
}

export interface CandidateValidationResult {
  ok: boolean;
  candidateTsx: string;
  /** Already-rendered candidate output, available when evaluation succeeded. */
  circuitJson?: unknown[];
  issues: EvalIssue[];
  newErrors: EvalIssue[];
  newWarnings: EvalIssue[];
  durationMs: number;
  evaluationError?: string;
}

function issueKey(issue: EvalIssue): string {
  return `${issue.severity}|${issue.type}|${issue.message.trim()}`;
}

function subtractBaseline(
  candidate: readonly EvalIssue[],
  baseline: readonly EvalIssue[],
): EvalIssue[] {
  const remaining = new Map<string, number>();
  for (const issue of baseline) {
    const key = issueKey(issue);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const netNew: EvalIssue[] = [];
  for (const issue of candidate) {
    const key = issueKey(issue);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      netNew.push(issue);
    }
  }
  return netNew;
}

async function defaultEvaluate(
  tsx: string,
  manualEdits: ManualEditsMap,
): Promise<CandidateEvaluationSnapshot> {
  let evaluationError: string | null = null;
  const evaluator = new CircuitEvaluator({
    onError: (error) => {
      evaluationError = error.message;
    },
  });
  try {
    const result = await evaluator.evaluateNow(tsx, manualEdits);
    if (!result) {
      throw new Error(evaluationError ?? "Circuit evaluation returned no result");
    }
    const issues = await collectEvalIssues(result.circuitJson);
    return {
      circuitJson: result.circuitJson,
      issues,
      durationMs: result.durationMs,
    };
  } finally {
    evaluator.dispose();
  }
}

export async function validateCandidateTsx(
  options: CandidateValidationOptions,
): Promise<CandidateValidationResult> {
  const syntax = validateTsx(options.candidateTsx);
  if (!syntax.ok) {
    const location =
      syntax.line === undefined
        ? ""
        : ` at ${syntax.line}:${syntax.column ?? 0}`;
    return {
      ok: false,
      candidateTsx: options.candidateTsx,
      issues: [],
      newErrors: [],
      newWarnings: [],
      durationMs: 0,
      evaluationError: `TSX syntax error${location}: ${syntax.error}`,
    };
  }

  try {
    const snapshot = await (options.evaluate ?? defaultEvaluate)(
      options.candidateTsx,
      options.manualEdits,
    );
    const netNew = subtractBaseline(
      snapshot.issues,
      options.baselineIssues ?? [],
    );
    const newErrors = netNew.filter((issue) => issue.severity === "error");
    const newWarnings = netNew.filter((issue) => issue.severity === "warning");
    return {
      ok: newErrors.length === 0,
      candidateTsx: options.candidateTsx,
      circuitJson: snapshot.circuitJson,
      issues: snapshot.issues,
      newErrors,
      newWarnings,
      durationMs: snapshot.durationMs,
    };
  } catch (error) {
    return {
      ok: false,
      candidateTsx: options.candidateTsx,
      issues: [],
      newErrors: [],
      newWarnings: [],
      durationMs: 0,
      evaluationError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildCandidateRepairPrompt(
  result: CandidateValidationResult,
): string {
  const problems = result.evaluationError
    ? [result.evaluationError]
    : result.newErrors.map(
        (issue) => `${issue.type}: ${issue.message}`,
      );
  const conciseProblems = problems.slice(0, 12);
  if (problems.length > conciseProblems.length) {
    conciseProblems.push(
      `${problems.length - conciseProblems.length} additional errors omitted`,
    );
  }
  return [
    "The draft circuit failed pre-commit validation and has NOT been applied.",
    "Fix the blocking errors below with semantic circuit tools when possible; use edit_tsx or write_tsx only for structures those tools cannot express. Connectivity and pin mappings come before placement or routing.",
    "Blocking errors:",
    ...conciseProblems.map((problem) => `- ${problem}`),
    "",
    "Current draft TSX (this is the exact working copy for old_string matches):",
    "```tsx",
    result.candidateTsx,
    "```",
    "Do not finish with prose only. Make the repair, then give a short summary.",
  ].join("\n");
}

// Re-exported solely for narrow dependency injection in future worker-backed
// validation. This keeps the production validator independent of the concrete
// @tscircuit/eval runner without exposing it through the chat store.
export type CandidateEvaluatorExecutor = EvaluatorExecutor;
