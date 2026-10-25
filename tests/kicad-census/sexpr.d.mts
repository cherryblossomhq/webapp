export type Sexpr = string | Sexpr[]
export function parseSexpr(text: string): Sexpr[]
export function kid(node: Sexpr[] | undefined, name: string): Sexpr[] | undefined
export function kids(node: Sexpr[] | undefined, name: string): Sexpr[][]
export function numAt(node: Sexpr[] | undefined, index: number, fallback?: number): number
