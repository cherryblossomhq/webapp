export interface RuleSch {
  path: RegExp
  decision: "native" | "extend" | "not-needed" | "report"
  today: string
  ext?: string
  note?: string
  effort?: string
}
export const RULES_SCH: RuleSch[]
export const ATOMS_SCH: { path: RegExp; values: Set<string>; skip: number[] }[]
export const TOKENS_SCH: { names: string[]; decision: string; ext?: string; note: string }[]
export function decisionForSch(path: string): RuleSch | null
