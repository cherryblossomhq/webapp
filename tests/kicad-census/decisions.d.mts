export interface Rule {
  path: RegExp
  decision: "native" | "extend" | "not-needed" | "report"
  ext?: string
  note?: string
}
export const RULES: Rule[]
export const ATOMS: { path: RegExp; values: Set<string>; skip: number[]; free: boolean }[]
export const TOKENS: { names: string[]; decision: string; ext?: string; note: string }[]
export function decisionFor(path: string): Rule | null
