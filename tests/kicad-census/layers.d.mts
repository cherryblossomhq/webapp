export interface LayersOracle {
  copper: { id: number; name: string; type: string; label?: string }[]
  ids: string[]
  stackRows: number
  thickness: number
  arcs: number
  arcLen: number
  arcKeys: string[]
  segments: number
  segLen: number
  vias: { key: string; kind: string }[]
  padstacks: number
  fpInner: string[]
}
export function layersOracle(text: string): LayersOracle | null
export function arcLength(a: number[], m: number[], b: number[]): number
export function copperTable(root: unknown[]): { id: number; name: string; type: string; label?: string }[]
