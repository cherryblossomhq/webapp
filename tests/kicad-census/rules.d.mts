export const KICAD_DEFAULTS: { uviaDia: number; uviaDrill: number; description: string; maxError: number }
export interface OracleClass {
  name: string
  description: string
  nodes: Partial<Record<"clearance" | "trace_width" | "via_dia" | "via_drill" | "uvia_dia" | "uvia_drill" | "diff_pair_width" | "diff_pair_gap", number>>
  members: string[]
}
export interface OracleRules {
  stamp: number | null
  classes: OracleClass[]
  nets: string[]
  setup: {
    userVias: number[][]
    userDiffPairs: number[][]
    maskMin?: number
    pasteRatio?: number
    maxError?: number
    clearanceMin?: number
    creepage?: number
    bridges?: string
    throughHoleMin?: number
    viaMinDrill?: number
    viaSize?: number
    viaDrill?: number
    traceClearance?: number
  }
}
export function rulesOracle(source: string): OracleRules
export function readable(raw: string): string
export function classOf(rules: OracleRules, rawNet: string): string
