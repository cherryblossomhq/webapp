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
  /** Where the copper's centre is on the board (the pad's place moved by its shape offset, turned with it). */
  cx: number
  cy: number
  detail: PadDetail
}
/** What the raw file says of one pad on the board (y down), by KiCad's rules; see `pad-detail.mjs`. */
export interface PadDetail {
  eff: string
  cx: number
  cy: number
  /** Signed distance from a point of the board to the pad's copper (negative inside). */
  sd: (x: number, y: number) => number
  hole: { x: number; y: number; d: number; slot: number | null; ends: [[number, number], [number, number]] | null; plated: boolean } | null
  holeSd: ((x: number, y: number) => number) | null
  faces: { copper: Set<string>; mask: Set<string>; paste: Set<string>; silk: Set<string>; flashed: Set<string> }
  margins: { mask?: number; paste?: number; ratio?: number; clearance?: number; zone?: number; thermalGap?: number; thermalWidth?: number; thermalAngle?: number }
  property?: string
  numberKicad: string
  size: [number, number]
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
export interface OracleCopper {
  stamp: number | null
  footprints: { ref: string; attr: string[]; hasAttr: boolean; tags: string; ties: string[][]; jumpers: string[][]; jumperDuplicates: boolean; padNumbers: string[] }[]
  /** Segments with the file's net name (or null), length in millimetres, whether locked. */
  segments: { net: string | null; length: number; locked: boolean; layer: string }[]
  vias: { net: string | null; locked: boolean }[]
}
export function copperOracle(text: string): OracleCopper
