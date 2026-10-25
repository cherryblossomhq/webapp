export interface OracleShape {
  type: string
  layer: string
  layers: string[]
  width: number
  filled: boolean
  dash: string | null
  net: string | null
  /** False for a drawing of a footprint turned by other than a quarter turn, which the project places at the nearest quarter (X6). */
  quarter: boolean
  analytic?: { c: number[]; r: number; ends?: number[][] }
  lines: number[][][]
}
export interface OracleGraphics {
  board: OracleShape[]
  footprints: { ref: string; name: string; shapes: OracleShape[] }[]
  targets: { at: number[]; size: number; width: number; layer: string; x: boolean }[]
  skipped: { degenerate: number }
  front: string
  back: string
}
export function graphicsOracle(text: string): OracleGraphics
export function lineDistance(a: number[][], b: number[][]): number
export function circleThrough(a: number[], b: number[], c: number[]): { c: number[]; r: number } | null
export function lineWithin(a: number[][], b: number[][], eps: number): boolean
