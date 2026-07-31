import { extractComponents } from "./tsxTransform";

export interface FootprintFamily {
  label: string;
  examples: readonly string[];
}

// Every string here is a real `@tscircuit/footprinter` family — an entry that
// footprinter can't parse becomes a *blocking* `source_invalid_component_property_error`
// in the pre-apply review, so it costs the model a repair round. (`do35` used to
// live in the Diodes row and did exactly that: footprinter has no DO-35 family,
// only `axial_p<pitch>`.) Verify additions against footprinter before adding them.
export const FOOTPRINT_FAMILIES: readonly FootprintFamily[] = [
  {
    label: "SMD passives",
    examples: ["0201", "0402", "0603", "0805", "1206", "1210", "2010", "2512"],
  },
  {
    label: "SMD ICs",
    examples: [
      "soic8",
      "soic14",
      "soic16",
      "soic20",
      "ssop16",
      "tssop8",
      "tssop16",
      "tssop20",
      "msop8",
      "sop8",
      "qfn16",
      "qfn24",
      "qfn32",
      "qfp32",
      "tqfp32",
      "tqfp44",
      "lqfp48",
    ],
  },
  {
    label: "THT ICs",
    examples: ["dip8", "dip14", "dip16", "dip28", "dip40"],
  },
  {
    label: "Transistors / regulators / small ICs",
    examples: [
      "sot23",
      "sot23_5",
      "sot23_6",
      "sot223",
      "sot89",
      "sot323",
      "sot363",
      "to92",
      "to220_3",
      "to220f_3",
    ],
  },
  {
    label: "Diodes",
    examples: ["sod123", "sod323", "sod523", "sod882", "sma", "smb", "smc"],
  },
  {
    label: "Polarised / bulk caps",
    examples: ["axial_p5mm", "electrolytic", "electrolytic_p2.5mm", "radial_p5mm"],
  },
  {
    label: "Headers / connectors",
    examples: [
      "pinrow2",
      "pinrow3",
      "pinrow4",
      "pinrow5",
      "pinrow6",
      "pinrow8",
      "pinrow10",
      "pinrow4_female",
      "pinrow4_smd",
      "jst2_ph",
      "jst3_ph",
    ],
  },
  {
    label: "Crystals",
    examples: ["hc49"],
  },
  {
    label: "Buttons / switches / jumpers / pots",
    examples: ["pushbutton", "potentiometer", "solderjumper2", "solderjumper3"],
  },
  {
    label: "Generic pad primitives (last resort — for parts with no family above)",
    examples: ["smtpad_w2mm_h1mm", "platedhole_d1mm"],
  },
];

export const VALID_FOOTPRINTS: ReadonlySet<string> = new Set(
  FOOTPRINT_FAMILIES.flatMap((f) => f.examples)
);

// Parameter suffixes are valid on any family (`_p<pitch>`, `_w<width>`,
// `_id`/`_od` drill/pad diameter, `_female`, `_smd`, …), and footprinter parses
// all of them (verified against @tscircuit/footprinter 0.0.371:
// `pinrow6_female`, `dip8_p2mm`, `0402_smd` etc. all build). The validator must
// accept them, or every valid suffix becomes a spurious "Footprint Issues"
// entry.
//
// Matching is case-sensitive on purpose: footprinter matches the pin-count
// suffix case-sensitively (`SOT23_5` silently renders 3 pads), so an
// uppercase footprint must keep getting flagged.
const PARAM_SUFFIX_SEGMENT =
  /^(?:p|w|h|d|id|od)\d+(?:\.\d+)?(?:mm)?$|^(?:female|male|smd)$/;

function stripParamSuffixes(fp: string): string {
  const segments = fp.split("_");
  while (
    segments.length > 1 &&
    PARAM_SUFFIX_SEGMENT.test(segments[segments.length - 1])
  ) {
    segments.pop();
  }
  return segments.join("_");
}

// Families reachable by suffix-stripping a catalog entry (`axial_p5mm` →
// `axial`, `smtpad_w2mm_h1mm` → `smtpad`). A candidate that carries at least
// one recognised suffix may match on its base; a *bare* base stays invalid
// unless it is itself a catalog entry, because the axial/pad-primitive
// families are only meaningful with explicit dimensions.
const VALID_FOOTPRINT_BASES: ReadonlySet<string> = new Set(
  FOOTPRINT_FAMILIES.flatMap((f) => f.examples.map(stripParamSuffixes))
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

export function isValidFootprint(fp: string): boolean {
  if (VALID_FOOTPRINTS.has(fp)) return true;
  const base = stripParamSuffixes(fp);
  return base !== fp && VALID_FOOTPRINT_BASES.has(base);
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

