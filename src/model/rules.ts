import type { BoardDef, DesignRules, Project, ThermalRelief } from "./types"

/** What a typical two-layer fab makes without extra charge, and the sizes new copper gets. */
export const DEFAULT_RULES: DesignRules = {
  traceWidth: 0.25,
  minTraceWidth: 0.15,
  preferredWidths: [0.15, 0.25, 0.4, 0.75, 1],
  clearance: 0.2,
  edgeClearance: 0.4,
  holeClearance: 0.25,
  viaDiameter: 0.6,
  viaDrill: 0.3,
  minDrill: 0.2,
  minAnnularRing: 0.13,
  viaInPad: false,
  maskExpansion: 0.05,
  pasteExpansion: 0,
  tentVias: true,
  pourClearance: 0.3,
  pourMinWidth: 0.25,
  thermalRelief: "relief-tht",
  thermalSpokes: 4,
  thermalSpokeWidth: 0.5,
  thermalSpokeAngle: 0,
}

/** The rules a fab's capabilities decide, as opposed to the sizes a designer picks. */
export type CapabilityRules = Pick<DesignRules, "minTraceWidth" | "clearance" | "minDrill" | "minAnnularRing" | "edgeClearance" | "holeClearance">

export interface FabCapability {
  id: string
  name: string
  description: string
  rules: CapabilityRules
}

/** Capability classes, from what any fab makes to what only the better ones do. */
export const FAB_CAPABILITIES: FabCapability[] = [
  {
    id: "conservative",
    name: "Conservative (8 mil)",
    description: "Wide margins any fab, or a careful home etch, can make.",
    rules: { minTraceWidth: 0.2, clearance: 0.2, minDrill: 0.4, minAnnularRing: 0.2, edgeClearance: 0.5, holeClearance: 0.5 },
  },
  {
    id: "standard",
    name: "Standard (6 mil)",
    description: "What budget two-layer fabs make at their base price.",
    rules: {
      minTraceWidth: DEFAULT_RULES.minTraceWidth,
      clearance: DEFAULT_RULES.clearance,
      minDrill: DEFAULT_RULES.minDrill,
      minAnnularRing: DEFAULT_RULES.minAnnularRing,
      edgeClearance: DEFAULT_RULES.edgeClearance,
      holeClearance: DEFAULT_RULES.holeClearance,
    },
  },
  {
    id: "fine",
    name: "Fine (5 mil)",
    description: "Fine-pitch parts; most fabs make it, some charge more.",
    rules: { minTraceWidth: 0.127, clearance: 0.127, minDrill: 0.2, minAnnularRing: 0.1, edgeClearance: 0.3, holeClearance: 0.2 },
  },
  {
    id: "advanced",
    name: "Advanced (4 mil)",
    description: "The limit of standard processes, usually at extra cost.",
    rules: { minTraceWidth: 0.1, clearance: 0.1, minDrill: 0.15, minAnnularRing: 0.1, edgeClearance: 0.25, holeClearance: 0.2 },
  },
]

const CAPABILITY_KEYS = Object.keys(FAB_CAPABILITIES[0].rules) as (keyof CapabilityRules)[]

/** The capability class the rules match exactly, or null when they've been set by hand. */
export function matchCapability(rules: DesignRules): FabCapability | null {
  return FAB_CAPABILITIES.find((f) => CAPABILITY_KEYS.every((k) => Math.abs(f.rules[k] - rules[k]) < 1e-9)) ?? null
}

/** Take a capability class's limits, growing any size that would now break them. */
export function applyCapability(rules: DesignRules, cap: FabCapability): DesignRules {
  const next = { ...rules, ...cap.rules }
  next.traceWidth = Math.max(next.traceWidth, next.minTraceWidth)
  next.viaDrill = Math.max(next.viaDrill, next.minDrill)
  next.viaDiameter = Math.max(next.viaDiameter, next.viaDrill + 2 * next.minAnnularRing)
  next.preferredWidths = rules.preferredWidths.filter((w) => w >= next.minTraceWidth - 1e-9)
  if (!next.preferredWidths.length) next.preferredWidths = [next.traceWidth]
  return next
}

/** Rules from a project file, with every rule it predates at its default. */
export function normalizeRules(raw: Partial<DesignRules> | undefined): DesignRules {
  const rules = { ...DEFAULT_RULES, ...raw }
  // an absent minimum via diameter is no minimum; a stored one must be a positive number
  if (!(typeof rules.minViaDiameter === "number" && Number.isFinite(rules.minViaDiameter) && rules.minViaDiameter > 0)) delete rules.minViaDiameter
  const widths = Array.isArray(rules.preferredWidths) ? rules.preferredWidths.filter((w) => Number.isFinite(w) && w > 0) : []
  return { ...rules, preferredWidths: widths.length ? [...new Set(widths)].sort((a, b) => a - b) : DEFAULT_RULES.preferredWidths }
}

export const THERMAL_RELIEF_OPTIONS: { value: ThermalRelief; label: string; title: string }[] = [
  { value: "relief-tht", label: "Through-hole", title: "Spokes on through-hole pads, solid SMD pads" },
  { value: "relief", label: "All pads", title: "Spokes on every pad, easier to solder by hand" },
  { value: "direct", label: "Solid", title: "Pads joined to the pour with no relief" },
]

/** Trace width for the next W press while routing: the next preferred width up, wrapping round. */
export function nextPreferredWidth(rules: DesignRules, current: number): number {
  const widths = rules.preferredWidths.length ? rules.preferredWidths : [rules.traceWidth]
  return widths.find((w) => w > current + 1e-6) ?? widths[0]
}

// ---------- Board stackup ----------

export const BOARD_THICKNESSES = [0.4, 0.6, 0.8, 1, 1.2, 1.6, 2]

/** Copper foil thickness for a weight: 1 oz/ft² is 35 µm. */
export const copperThickness = (weight: number) => 0.035 * weight

const MASK_THICKNESS = 0.02

export interface StackupLayer {
  name: string
  kind: "silk" | "mask" | "copper" | "core"
  material: string
  /** Millimetres; null for layers too thin to matter to the total. */
  thickness: number | null
}

/** The two-layer stackup the board is built to, top to bottom; the core takes up what the rest leaves. */
export function boardStackup(b: BoardDef): StackupLayer[] {
  const cu = copperThickness(b.copperWeight ?? 1)
  const core = Math.max(0.1, b.thickness - 2 * cu - 2 * MASK_THICKNESS)
  const weight = `${b.copperWeight ?? 1} oz copper`
  return [
    { name: "Top silkscreen", kind: "silk", material: "Epoxy ink", thickness: null },
    { name: "Top solder mask", kind: "mask", material: "LPI, εr 3.8", thickness: MASK_THICKNESS },
    { name: "Top copper", kind: "copper", material: weight, thickness: cu },
    { name: "Core", kind: "core", material: "FR-4, εr 4.5", thickness: core },
    { name: "Bottom copper", kind: "copper", material: weight, thickness: cu },
    { name: "Bottom solder mask", kind: "mask", material: "LPI, εr 3.8", thickness: MASK_THICKNESS },
    { name: "Bottom silkscreen", kind: "silk", material: "Epoxy ink", thickness: null },
  ]
}

// ---------- Units ----------

export type LengthUnit = "mm" | "mil"

export const MM_PER_MIL = 0.0254

export const toUnit = (mm: number, unit: LengthUnit) => (unit === "mil" ? mm / MM_PER_MIL : mm)
export const fromUnit = (value: number, unit: LengthUnit) => (unit === "mil" ? value * MM_PER_MIL : value)

/** A length for display: up to 3 decimals in mm, 1 in mil, without trailing zeros. */
export function formatLength(mm: number, unit: LengthUnit, withUnit = false): string {
  const v = toUnit(mm, unit)
  const s = String(Number(v.toFixed(unit === "mil" ? 1 : 3)))
  return withUnit ? `${s} ${unit}` : s
}

/** Pour gap for a zone: its own, or the rule. */
export const zoneClearance = (project: Project, explicit?: number) => explicit ?? project.rules.pourClearance
