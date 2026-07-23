import type { EvalIssue } from "@/editor/shared/types";
import {
  extractBoardConfig,
  extractComponents,
  extractConnections,
  normalizeSelectorString,
  validateTsx,
} from "@/utils/tsxTransform";

export const PCB_EVAL_WEIGHTS = {
  structure: 35,
  toolUse: 25,
  electrical: 20,
  recovery: 10,
  efficiency: 10,
} as const;

export type PcbEvalCategory =
  | "component-edit"
  | "connectivity"
  | "component-selection"
  | "datasheet"
  | "full-design"
  | "repair"
  | "placement";

export interface PcbToolTrace {
  name: string;
  ok: boolean;
  durationMs?: number;
}

export interface ExpectedComponent {
  name: string;
  elementTag?: string;
  props?: Record<string, string>;
}

export interface ExpectedConnection {
  from: string;
  to: string;
}

export interface PcbEvalExpectations {
  componentCount?: number;
  components?: ExpectedComponent[];
  connections?: ExpectedConnection[];
  requiredNets?: string[];
  board?: Partial<{ width: string; height: string; layers: number }>;
  requiredTools?: string[];
  forbiddenIssueTypes?: string[];
  maxErrors?: number;
  maxWarnings?: number;
  maxRepairAttempts?: number;
  maxDurationMs?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
}

export interface PcbEvalCase {
  id: string;
  title: string;
  category: PcbEvalCategory;
  userPrompt: string;
  initialTsx: string;
  expectations: PcbEvalExpectations;
  minimumScore?: number;
}

export interface PcbEvalObservation {
  tsx: string;
  tools?: PcbToolTrace[];
  issues?: EvalIssue[];
  repairAttempts?: number;
  hadRecoverableFailure?: boolean;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface PcbEvalBreakdown {
  structure: number;
  toolUse: number;
  electrical: number;
  recovery: number;
  efficiency: number;
}

export interface PcbEvalResult {
  caseId: string;
  passed: boolean;
  score: number;
  breakdown: PcbEvalBreakdown;
  failures: string[];
  fatalFailures: string[];
}

interface CheckResult {
  ok: boolean;
  message: string;
  fatal?: boolean;
}

function normalizedEndpoint(value: string): string {
  return normalizeSelectorString(value).toLowerCase();
}

function connectionExists(
  connections: ReturnType<typeof extractConnections>,
  expected: ExpectedConnection,
): boolean {
  const from = normalizedEndpoint(expected.from);
  const to = normalizedEndpoint(expected.to);
  return connections.some((connection) => {
    const actualFrom = normalizedEndpoint(
      `${connection.owner}.${connection.pinLabel}`,
    );
    const actualTo = normalizedEndpoint(connection.target);
    return (
      (actualFrom === from && actualTo === to) ||
      (actualFrom === to && actualTo === from)
    );
  });
}

function structuralChecks(tsx: string): CheckResult[] {
  const syntax = validateTsx(tsx);
  if (!syntax.ok) {
    return [
      {
        ok: false,
        fatal: true,
        message: `TSX syntax error: ${syntax.error}`,
      },
    ];
  }
  return [
    { ok: true, message: "TSX parses" },
    {
      ok: /export\s+default/.test(tsx),
      fatal: true,
      message: "Circuit must have a default export",
    },
    {
      ok: /<board\b/.test(tsx),
      fatal: true,
      message: "Circuit must render a board root",
    },
  ];
}

function electricalChecks(
  expectations: PcbEvalExpectations,
  observation: PcbEvalObservation,
): CheckResult[] {
  const components = extractComponents(observation.tsx);
  const connections = extractConnections(observation.tsx);
  const board = extractBoardConfig(observation.tsx);
  const issues = observation.issues ?? [];
  const checks: CheckResult[] = [];

  if (expectations.componentCount !== undefined) {
    checks.push({
      ok: components.length === expectations.componentCount,
      message: `Expected ${expectations.componentCount} components, found ${components.length}`,
    });
  }

  for (const expected of expectations.components ?? []) {
    const component = components.find((candidate) => candidate.name === expected.name);
    checks.push({
      ok: component !== undefined,
      message: `Missing component ${expected.name}`,
    });
    if (!component) continue;
    if (expected.elementTag) {
      checks.push({
        ok: component.elementTag === expected.elementTag,
        message: `${expected.name} should use <${expected.elementTag}>`,
      });
    }
    for (const [prop, value] of Object.entries(expected.props ?? {})) {
      checks.push({
        ok: component.props[prop] === value,
        message: `${expected.name}.${prop} should be ${value}, found ${component.props[prop] ?? "missing"}`,
      });
    }
  }

  for (const expected of expectations.connections ?? []) {
    checks.push({
      ok: connectionExists(connections, expected),
      message: `Missing connection ${expected.from} -> ${expected.to}`,
    });
  }

  const connectedNets = new Set(
    connections
      .map((connection) => connection.target)
      .filter((target) => target.startsWith("net."))
      .map((target) => target.slice(4).toLowerCase()),
  );
  for (const requiredNet of expectations.requiredNets ?? []) {
    checks.push({
      ok: connectedNets.has(requiredNet.replace(/^net\./i, "").toLowerCase()),
      message: `Required named net ${requiredNet} is not connected`,
    });
  }

  for (const [key, expected] of Object.entries(expectations.board ?? {})) {
    checks.push({
      ok: board[key as keyof typeof board] === expected,
      message: `Board ${key} should be ${String(expected)}, found ${String(board[key as keyof typeof board])}`,
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  if (expectations.maxErrors !== undefined) {
    checks.push({
      ok: errorCount <= expectations.maxErrors,
      fatal: true,
      message: `Expected at most ${expectations.maxErrors} errors, found ${errorCount}`,
    });
  }
  if (expectations.maxWarnings !== undefined) {
    checks.push({
      ok: warningCount <= expectations.maxWarnings,
      message: `Expected at most ${expectations.maxWarnings} warnings, found ${warningCount}`,
    });
  }
  for (const forbidden of expectations.forbiddenIssueTypes ?? []) {
    checks.push({
      ok: !issues.some((issue) => issue.type === forbidden),
      fatal: true,
      message: `Forbidden issue type present: ${forbidden}`,
    });
  }

  return checks;
}

function scoreChecks(checks: CheckResult[], maximum: number): number {
  if (checks.length === 0) return maximum;
  const passed = checks.filter((check) => check.ok).length;
  return (passed / checks.length) * maximum;
}

function toolChecks(
  expectations: PcbEvalExpectations,
  tools: PcbToolTrace[],
): CheckResult[] {
  const checks: CheckResult[] = [];
  for (const required of expectations.requiredTools ?? []) {
    checks.push({
      ok: tools.some((tool) => tool.name === required && tool.ok),
      message: `Required tool did not succeed: ${required}`,
    });
  }
  for (const tool of tools) {
    checks.push({
      ok: tool.ok,
      message: `Tool failed: ${tool.name}`,
    });
  }
  return checks;
}

function recoveryChecks(
  expectations: PcbEvalExpectations,
  observation: PcbEvalObservation,
  hasFatalFailure: boolean,
): CheckResult[] {
  const attempts = observation.repairAttempts ?? 0;
  const maxAttempts = expectations.maxRepairAttempts ?? 2;
  if (!observation.hadRecoverableFailure) {
    return [{ ok: attempts === 0, message: "Unnecessary repair attempt" }];
  }
  return [
    { ok: !hasFatalFailure, message: "Candidate did not recover from the initial failure" },
    {
      ok: attempts > 0 && attempts <= maxAttempts,
      message: `Recovery used ${attempts} attempts; maximum is ${maxAttempts}`,
    },
  ];
}

function efficiencyChecks(
  expectations: PcbEvalExpectations,
  observation: PcbEvalObservation,
): CheckResult[] {
  const checks: CheckResult[] = [];
  if (expectations.maxDurationMs !== undefined) {
    checks.push({
      ok: observation.durationMs !== undefined && observation.durationMs <= expectations.maxDurationMs,
      message: `Duration exceeded ${expectations.maxDurationMs}ms`,
    });
  }
  if (expectations.maxTotalTokens !== undefined) {
    const total = (observation.inputTokens ?? 0) + (observation.outputTokens ?? 0);
    checks.push({
      ok: total <= expectations.maxTotalTokens,
      message: `Token usage ${total} exceeded ${expectations.maxTotalTokens}`,
    });
  }
  if (expectations.maxCostUsd !== undefined) {
    checks.push({
      ok: observation.costUsd !== undefined && observation.costUsd <= expectations.maxCostUsd,
      message: `Cost exceeded $${expectations.maxCostUsd.toFixed(4)}`,
    });
  }
  return checks;
}

export function evaluatePcbAttempt(
  testCase: PcbEvalCase,
  observation: PcbEvalObservation,
): PcbEvalResult {
  const structure = structuralChecks(observation.tsx);
  const electrical = structure.some((check) => check.fatal && !check.ok)
    ? []
    : electricalChecks(testCase.expectations, observation);
  const tools = toolChecks(testCase.expectations, observation.tools ?? []);
  const initialFatal = [...structure, ...electrical].some(
    (check) => check.fatal && !check.ok,
  );
  const recovery = recoveryChecks(testCase.expectations, observation, initialFatal);
  const efficiency = efficiencyChecks(testCase.expectations, observation);

  const breakdown: PcbEvalBreakdown = {
    structure: scoreChecks(structure, PCB_EVAL_WEIGHTS.structure),
    toolUse: scoreChecks(tools, PCB_EVAL_WEIGHTS.toolUse),
    electrical: scoreChecks(electrical, PCB_EVAL_WEIGHTS.electrical),
    recovery: scoreChecks(recovery, PCB_EVAL_WEIGHTS.recovery),
    efficiency: scoreChecks(efficiency, PCB_EVAL_WEIGHTS.efficiency),
  };
  const allChecks = [...structure, ...tools, ...electrical, ...recovery, ...efficiency];
  const failures = allChecks.filter((check) => !check.ok).map((check) => check.message);
  const fatalFailures = allChecks
    .filter((check) => check.fatal && !check.ok)
    .map((check) => check.message);
  const score = Number(
    Object.values(breakdown).reduce((sum, value) => sum + value, 0).toFixed(1),
  );
  return {
    caseId: testCase.id,
    passed: fatalFailures.length === 0 && score >= (testCase.minimumScore ?? 80),
    score,
    breakdown,
    failures,
    fatalFailures,
  };
}

export function summarizePcbEval(results: PcbEvalResult[]): {
  passRate: number;
  averageScore: number;
  failedCaseIds: string[];
} {
  if (results.length === 0) {
    return { passRate: 0, averageScore: 0, failedCaseIds: [] };
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    passRate: Number(((passed / results.length) * 100).toFixed(1)),
    averageScore: Number(
      (results.reduce((sum, result) => sum + result.score, 0) / results.length).toFixed(1),
    ),
    failedCaseIds: results.filter((result) => !result.passed).map((result) => result.caseId),
  };
}
