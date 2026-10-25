export interface EdgePiece {
  type: string
  closed: boolean
  line: number[][]
}
export function edgeOracle(text: string): EdgePiece[]
export function sample(line: number[][], step?: number): number[][]
export function length(line: number[][]): number
export function nearestIndex(lines: number[][][], reach?: number): (p: number[]) => number
