export interface OraclePad {
  number: string
  type: string
  shape: string
  x: number
  y: number
  angle: number
  w: number
  h: number
  /** The file's own name for the pad's net (an old overbar converted), or null. */
  net: string | null
  /** The extent of the pad's outline on the board, null for a custom pad. */
  box: { w: number; h: number } | null
}
export interface OracleFootprint {
  ref: string
  x: number
  y: number
  angle: number
  bottom: boolean
  pads: OraclePad[]
}
export function oracle(text: string): OracleFootprint[]
export function overbarOf(text: string): string
