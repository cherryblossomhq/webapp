import type { DrcViolation } from "./pcb/drc";
import type { EvalIssue, IssueSeverity } from "./shared/types";

type CircuitElement = Record<string, unknown>;

export interface EditorIssue {
  id: string;
  source: "eval" | "drc";
  severity: IssueSeverity;
  type: string;
  message: string;
  drcViolationId?: string;
}

export interface IssueGroup {
  id: string;
  severity: IssueSeverity;
  message: string;
  count: number;
  sources: Array<EditorIssue["source"]>;
  types: string[];
  drcViolationId?: string;
}

const ALWAYS_NOISE = ["are underspecified"];
const POWER_PIN_RE = /^(VCC|VDD|VBAT|VIN|V_OUT|V3_3|V5|POWER|PWR|DVCC|AVCC|\+3\.?3V|\+5V)$/i;
const GND_PIN_RE = /^(GND|GROUND|GND_OUT|VSS|AGND|PGND|DGND|SGND)$/i;

function issueType(el: CircuitElement): string | null {
  if (typeof el.error_type === "string") return el.error_type;
  if (typeof el.type === "string") return el.type;
  return null;
}

function issueSeverity(type: string): IssueSeverity {
  return type.endsWith("_warning") || type.includes("warning")
    ? "warning"
    : "error";
}

function hasConnectedPin(
  compName: string,
  pinRe: RegExp,
  circuitJson: ReadonlyArray<unknown>,
): boolean {
  const els = circuitJson as CircuitElement[];
  const comp = els.find(
    (el) => el.type === "source_component" && el.name === compName,
  );
  if (!comp) return false;
  const compId = comp.source_component_id as string;
  const matchingPorts = els.filter(
    (el) =>
      el.type === "source_port" &&
      el.source_component_id === compId &&
      pinRe.test(String(el.name ?? "")),
  );
  if (matchingPorts.length === 0) return false;
  const portIds = new Set(
    matchingPorts.map((port) => port.source_port_id as string),
  );
  return els.some(
    (el) =>
      el.type === "source_trace" &&
      ((el.connected_source_port_ids as string[]) ?? []).some((id) =>
        portIds.has(id),
      ),
  );
}

function hasNamedPinLabel(
  compName: string,
  pinRe: RegExp,
  circuitJson: ReadonlyArray<unknown>,
): boolean {
  const els = circuitJson as CircuitElement[];
  const comp = els.find(
    (el) => el.type === "source_component" && el.name === compName,
  );
  if (!comp) return false;
  return els.some(
    (el) =>
      el.type === "source_port" &&
      el.source_component_id === comp.source_component_id &&
      pinRe.test(String(el.name ?? "")),
  );
}

function isFalsePositive(
  message: string,
  circuitJson: ReadonlyArray<unknown>,
): boolean {
  if (ALWAYS_NOISE.some((fragment) => message.includes(fragment))) return true;

  const powerMatch = message.match(/^(\S+) has no pin with requires_power/);
  if (
    powerMatch &&
    (hasConnectedPin(powerMatch[1], POWER_PIN_RE, circuitJson) ||
      hasNamedPinLabel(powerMatch[1], POWER_PIN_RE, circuitJson))
  ) {
    return true;
  }

  const groundMatch = message.match(/^(\S+) has no pin with requires_ground/);
  return !!(
    groundMatch &&
    (hasConnectedPin(groundMatch[1], GND_PIN_RE, circuitJson) ||
      hasNamedPinLabel(groundMatch[1], GND_PIN_RE, circuitJson))
  );
}

function normalizeEvalFindings(
  findings: ReadonlyArray<unknown>,
  circuitJson: ReadonlyArray<unknown>,
): EvalIssue[] {
  const out: EvalIssue[] = [];
  const duplicateCounts = new Map<string, number>();

  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const el = finding as CircuitElement;
    const type = issueType(el);
    const message = typeof el.message === "string" ? el.message.trim() : "";
    if (!type || !message || isFalsePositive(message, circuitJson)) continue;
    if (!type.endsWith("_error") && !type.endsWith("_warning")) continue;

    const severity = issueSeverity(type);
    const baseId = `${severity}|${type}|${message}`;
    const duplicateIndex = duplicateCounts.get(baseId) ?? 0;
    duplicateCounts.set(baseId, duplicateIndex + 1);
    out.push({
      id: duplicateIndex === 0 ? baseId : `${baseId}#${duplicateIndex}`,
      type,
      message,
      severity,
    });
  }

  return out;
}

export function collectEmbeddedEvalIssues(
  circuitJson: ReadonlyArray<unknown>,
): EvalIssue[] {
  return normalizeEvalFindings(circuitJson, circuitJson);
}

/** Collect eval findings plus tscircuit's full check pass for the same result. */
export async function collectEvalIssues(
  circuitJson: ReadonlyArray<unknown>,
): Promise<EvalIssue[]> {
  let checks: unknown[] = [];
  try {
    const { runAllChecks } = await import("@tscircuit/checks");
    checks = await runAllChecks(circuitJson as never[]);
  } catch {
    // Embedded eval findings remain useful if the optional check pass fails.
  }

  // Some checks are already embedded in circuit-json. De-duplicate the exact
  // same finding across the two producers while preserving genuine repeated
  // occurrences within either producer. Taking the larger source count avoids
  // reporting 400 occurrences when eval and checks each report the same 200.
  const embedded = collectEmbeddedEvalIssues(circuitJson);
  const checked = normalizeEvalFindings(checks, circuitJson);
  const byContent = new Map<string, { embedded: EvalIssue[]; checked: EvalIssue[] }>();
  for (const issue of embedded) {
    const key = `${issue.severity}|${issue.message}`;
    const bucket = byContent.get(key) ?? { embedded: [], checked: [] };
    bucket.embedded.push(issue);
    byContent.set(key, bucket);
  }
  for (const issue of checked) {
    const key = `${issue.severity}|${issue.message}`;
    const bucket = byContent.get(key) ?? { embedded: [], checked: [] };
    bucket.checked.push(issue);
    byContent.set(key, bucket);
  }

  const out: EvalIssue[] = [];
  for (const bucket of byContent.values()) {
    const preferred =
      bucket.checked.length > bucket.embedded.length
        ? bucket.checked
        : bucket.embedded;
    out.push(...preferred);
  }
  return out;
}

export function buildEditorIssues(
  evalIssues: ReadonlyArray<EvalIssue>,
  drcViolations: ReadonlyArray<DrcViolation>,
  evalError: string | null,
): EditorIssue[] {
  const issues: EditorIssue[] = evalIssues.map((issue) => ({
    ...issue,
    source: "eval",
  }));

  if (evalError) {
    issues.unshift({
      id: `eval-failure|${evalError}`,
      source: "eval",
      severity: "error",
      type: "eval_failure",
      message: evalError,
    });
  }

  for (const violation of drcViolations) {
    issues.push({
      id: `drc|${violation.id}`,
      source: "drc",
      severity: "error",
      type: violation.type,
      message: violation.message,
      drcViolationId: violation.id,
    });
  }
  return issues;
}

export function groupEditorIssues(
  issues: ReadonlyArray<EditorIssue>,
): IssueGroup[] {
  const buckets = new Map<
    string,
    {
      severity: IssueSeverity;
      message: string;
      bySource: Map<EditorIssue["source"], EditorIssue[]>;
    }
  >();

  for (const issue of issues) {
    const key = `${issue.severity}|${issue.message}`;
    const bucket = buckets.get(key) ?? {
      severity: issue.severity,
      message: issue.message,
      bySource: new Map(),
    };
    const sourceIssues = bucket.bySource.get(issue.source) ?? [];
    sourceIssues.push(issue);
    bucket.bySource.set(issue.source, sourceIssues);
    buckets.set(key, bucket);
  }

  return Array.from(buckets, ([id, bucket]) => {
    const sourceGroups = Array.from(bucket.bySource.values());
    return {
      id,
      severity: bucket.severity,
      message: bucket.message,
      count: Math.max(...sourceGroups.map((group) => group.length)),
      sources: Array.from(bucket.bySource.keys()),
      types: Array.from(
        new Set(sourceGroups.flat().map((issue) => issue.type)),
      ),
      drcViolationId: bucket.bySource
        .get("drc")
        ?.find((issue) => issue.drcViolationId)?.drcViolationId,
    };
  }).sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.message.localeCompare(b.message);
  });
}

export function countGroupedIssues(groups: ReadonlyArray<IssueGroup>): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const group of groups) {
    if (group.severity === "error") errors += group.count;
    else warnings += group.count;
  }
  return { errors, warnings };
}
