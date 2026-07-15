import { extractComponents } from "./tsxTransform";

export interface FootprintFamily {
  label: string;
  examples: readonly string[];
}

export const FOOTPRINT_FAMILIES: readonly FootprintFamily[] = [
  { label: "SMD passives", examples: ["0402", "0603", "0805", "1206"] },
  {
    label: "SMD ICs",
    examples: ["soic8", "soic16", "soic20", "ssop16", "qfn16", "qfn32", "qfp32"],
  },
  {
    label: "THT ICs",
    examples: ["dip8", "dip14", "dip16", "dip28", "dip40"],
  },
  { label: "Transistors / small ICs", examples: ["sot23", "sot23_5", "sot23_6"] },
  { label: "Diodes", examples: ["sod123", "do35"] },
  { label: "Polarised caps", examples: ["axial_p5mm"] },
  {
    label: "Headers / connectors",
    examples: ["pinrow2", "pinrow3", "pinrow4", "pinrow6", "pinrow8"],
  },
];

export const VALID_FOOTPRINTS: ReadonlySet<string> = new Set(
  FOOTPRINT_FAMILIES.flatMap((f) => f.examples)
);

// Tags where a footprint is meaningless (nets, traces, board, group, etc.) and
// must NOT be flagged when missing.
const FOOTPRINT_EXEMPT_TAGS = new Set([
  "net",
  "netlabel",
  "trace",
  "via",
  "board",
  "group",
  "subcircuit",
]);

// Tags whose footprint is determined entirely by a side prop (the catalog
// strings still apply but we should not nag the model if it's also missing).
const FOOTPRINT_OPTIONAL_TAGS = new Set([
  "connector", // <connector standard="usb_c" /> auto-derives footprint
]);

export function isValidFootprint(fp: string): boolean {
  return VALID_FOOTPRINTS.has(fp);
}

export type FootprintIssueKind =
  | "missing"
  | "unknown"
  | "mismatch";

export interface FootprintIssue {
  componentName: string;
  elementTag: string;
  kind: FootprintIssueKind;
  // Footprint the model actually wrote (empty string when missing).
  actual: string;
  // For "mismatch": the footprint we expect (e.g. from an imported part).
  expected?: string;
  message: string;
}

/**
 * Scan a circuit's TSX for footprint problems:
 *   - "missing"  : a component that needs a footprint doesn't carry one
 *   - "unknown"  : the footprint string isn't in VALID_FOOTPRINTS
 *   - "mismatch" : the footprint disagrees with `expected` (lookup by component
 *                  name first, then element tag for JLCPCB-imported parts)
 */
export function validateCircuitFootprints(
  tsx: string,
  expected: Record<string, string> = {}
): FootprintIssue[] {
  const issues: FootprintIssue[] = [];
  let components;
  try {
    components = extractComponents(tsx);
  } catch {
    return issues;
  }

  for (const c of components) {
    if (FOOTPRINT_EXEMPT_TAGS.has(c.elementTag)) continue;

    const actual = (c.props.footprint ?? "").trim();
    const expectedFp = (expected[c.name] ?? expected[c.elementTag])?.trim();

    if (!actual) {
      if (FOOTPRINT_OPTIONAL_TAGS.has(c.elementTag)) continue;
      issues.push({
        componentName: c.name,
        elementTag: c.elementTag,
        kind: "missing",
        actual: "",
        expected: expectedFp,
        message: `${c.name} (<${c.elementTag}>) has no footprint prop`,
      });
      continue;
    }

    if (expectedFp && expectedFp !== actual) {
      issues.push({
        componentName: c.name,
        elementTag: c.elementTag,
        kind: "mismatch",
        actual,
        expected: expectedFp,
        message: `${c.name} footprint "${actual}" disagrees with imported part footprint "${expectedFp}"`,
      });
      continue;
    }

    if (!isValidFootprint(actual)) {
      issues.push({
        componentName: c.name,
        elementTag: c.elementTag,
        kind: "unknown",
        actual,
        message: `${c.name} footprint "${actual}" is not in the canonical catalog`,
      });
    }
  }

  return issues;
}

/**
 * Markdown table mirroring FOOTPRINT_FAMILIES — used inside the AI system
 * prompt so the prompt + validator share a single source of truth.
 */
export function footprintCatalogMarkdownTable(): string {
  const rows = FOOTPRINT_FAMILIES.map(
    (f) => `| ${f.label} | ${f.examples.map((s) => `\`${s}\``).join(" ")} |`
  );
  return ["| Family | Examples |", "|---|---|", ...rows].join("\n");
}
