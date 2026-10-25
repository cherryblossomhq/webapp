export interface OracleFont {
  glyphs: { width: number; strokes: number[][][] }[]
}
export interface OracleText {
  kind: string
  head: string
  raw: string
  shown: string
  layerName: string
  layer: string
  lx: number
  ly: number
  x: number
  y: number
  angle: number
  mirror: boolean
  h: number
  w: number
  thickness: number
  /** The width as the file stores it (KiCad 9 and 10 wrap a text box with it). */
  rawThickness: number
  bold: boolean
  italic: boolean
  hj: number
  vj: number
  spacing: number
  knockout: boolean
  hide: boolean
  locked: boolean
  keepUpright: boolean
  face: string | null
  renderCache: boolean
  isBox: boolean
  hasExpression: boolean
  usesFilename: boolean
  box?: { sx: number; sy: number; ex: number; ey: number; outline: boolean; strokeWidth: number | null; border: boolean; margins: number[] | null }
  fp: OracleFootprint | null
  fpRef?: string
}
export interface OracleFootprint {
  ref: string
  value: string
  at: number[]
  angle: number
  bottom: boolean
  name: string
  fields: Record<string, string>
  texts: OracleText[]
}
export interface OracleTexts {
  version: number | null
  front: string
  back: string
  board: OracleText[]
  footprints: OracleFootprint[]
  props: Record<string, string>
  unresolved: Set<string>
}
export function loadFont(sourceText: string): OracleFont
export function fontFromGlyphStrings(strings: string[]): OracleFont
export function glyphStringsOf(sourceText: string): string[]
export function loadFontFile(path: string): OracleFont
export function markupRuns(line: string): { runs: { s: string; sub: boolean; sup: boolean }[]; bars: { from: number; to: number }[] }
export function penWidth(t: { thickness: number; bold: boolean; w: number; h: number }): number
export function drawAngle(angle: number, keepUpright: boolean): number
export function inkOf(font: OracleFont, shown: string, t: Pick<OracleText, "x" | "y" | "w" | "h" | "thickness" | "bold" | "italic" | "mirror" | "hj" | "vj" | "spacing">, angle: number, multiline: boolean): { strokes: number[][][]; pen: number }
export function newOverbar(old: string): string
export function textOracle(text: string): OracleTexts
export function oracleInk(font: OracleFont, t: OracleText, version?: number | null): { strokes: number[][][]; pen: number } | null
export function boxCornersOracle(box: { sx: number; sy: number; ex: number; ey: number }, angleDeg: number, version: number | null): number[][] | null
export function boxAnchorOracle(t: OracleText, corners: number[][], drawAng: number): number[]
export function linebreakOracle(font: OracleFont, text: string, column: number, t: Pick<OracleText, "w" | "h" | "italic">, thickness: number): string
export const boxTextIsPlain: (shown: string) => boolean
