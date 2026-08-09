// Design-rule checking (DRC) for PCB routing, run on the MERGED circuit-json
// (autoroute + manual routes spliced in by circuitJsonMerge.ts). tscircuit's
// own checks run during eval on the autorouted geometry only; because manual
// routes never reach the evaluator, hand-drawn copper would otherwise never be
// clearance-checked. Running @tscircuit/checks over the merged artifact closes
// that gap — manual copper is checked exactly like autorouted copper.
//
// @tscircuit/checks is lazy-imported so the (large) checks bundle only loads
// the first time DRC actually runs, mirroring the evaluator's lazy import.

import type { AnyCircuitElement } from "circuit-json";

import { log } from "@/utils/logger";

export interface DrcViolation {
  // Content-derived identifier (type + center + message), used as a React key
  // and to keep the inspector pinned to a specific violation across re-checks.
  // We deliberately do NOT reuse the upstream *_error_id: those can be index-
  // or position-based, so after a re-eval a different violation may inherit an
  // old id and the inspector would silently swap what it describes.
  id: string;
  // The circuit-json error_type, e.g. "pcb_trace_error",
  // "pcb_pad_trace_clearance_error".
  type: string;
  message: string;
  // Board-space location of the violation, when the check reports one. Clearance
  // and edge violations carry a center; some (e.g. port-not-connected) don't.
  center: { x: number; y: number } | null;
}

type RoutingChecks = (cj: AnyCircuitElement[]) => Promise<unknown[]>;

let cachedRunner: RoutingChecks | null = null;

async function loadRunner(): Promise<RoutingChecks> {
  if (cachedRunner) return cachedRunner;
  const mod = await import("@tscircuit/checks");
  cachedRunner = mod.runAllRoutingChecks as unknown as RoutingChecks;
  return cachedRunner;
}

/**
 * Run the routing design-rule checks over a (preferably merged) circuit-json
 * and return normalized violations. Never throws: a checks failure or an empty
 * board yields an empty list so DRC can't break the editor.
 */
export async function runPcbDrc(
  circuitJson: ReadonlyArray<AnyCircuitElement> | null | undefined,
): Promise<DrcViolation[]> {
  if (!circuitJson || circuitJson.length === 0) return [];
  try {
    const run = await loadRunner();
    const raw = await run(circuitJson as AnyCircuitElement[]);
    return normalizeDrcViolations(raw);
  } catch (err) {
    log.warn("[drc] checks failed:", err);
    return [];
  }
}

// Pure index math for the DRC inspector's prev/next. Wraps around both ends;
// when nothing is focused, stepping forward starts at 0 and stepping back at
// the last item. Returns -1 for an empty list. Lives here (not in PcbCanvas)
// so it stays unit-testable without importing the canvas component graph.
export function nextViolationIndex(
  length: number,
  focusedIndex: number,
  dir: 1 | -1,
): number {
  if (length === 0) return -1;
  const base = focusedIndex >= 0 ? focusedIndex : dir === 1 ? -1 : 0;
  return (base + dir + length) % length;
}

/**
 * Pure normalizer: circuit-json error elements → DrcViolation[]. Exported for
 * testing without pulling in the @tscircuit/checks bundle.
 */
export function normalizeDrcViolations(
  raw: ReadonlyArray<unknown>,
): DrcViolation[] {
  const out: DrcViolation[] = [];
  // Count identical content keys so two genuinely-coincident findings still get
  // unique React keys (`#1`, `#2`) without falling back to unstable indices.
  const seen = new Map<string, number>();
  for (const el of raw) {
    if (!el || typeof el !== "object") continue;
    const r = el as Record<string, unknown>;
    const type =
      typeof r.error_type === "string"
        ? r.error_type
        : typeof r.type === "string"
          ? r.type
          : null;
    const message = typeof r.message === "string" ? r.message : null;
    if (!type || !message) continue;

    let center: { x: number; y: number } | null = null;
    const c = r.center;
    if (c && typeof c === "object") {
      const cx = (c as Record<string, unknown>).x;
      const cy = (c as Record<string, unknown>).y;
      if (
        typeof cx === "number" &&
        Number.isFinite(cx) &&
        typeof cy === "number" &&
        Number.isFinite(cy)
      ) {
        center = { x: cx, y: cy };
      }
    }

    // Round the center so float noise across re-checks can't churn the id.
    const centerKey = center
      ? `${Math.round(center.x * 1000) / 1000},${Math.round(center.y * 1000) / 1000}`
      : "-";
    const base = `${type}|${centerKey}|${message}`;
    const dupes = seen.get(base) ?? 0;
    seen.set(base, dupes + 1);
    const id = dupes === 0 ? base : `${base}#${dupes}`;

    out.push({ id, type, message, center });
  }
  return out;
}
