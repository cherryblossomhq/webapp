export interface OracleZone {
  inFootprint: boolean
  layers: string[]
  onlyCopper: boolean
  surface: ("top" | "bottom")[]
  other: string[]
  kind: "copper" | "keepout" | "rule-area" | "teardrop" | "placement"
  netName: string
  priority: number
  uuid: string | null
  name: string
  locked: boolean
  clearance: number | null
  minThickness: number | null
  connect: "thermal" | "yes" | "no" | "thru_hole_only"
  thermalGap: number | null
  thermalBridge: number | null
  smoothing: string
  radius: number
  islandMode: number
  islandArea: number | null
  mode: string
  teardrop: "padvia" | "track_end" | null
  keepout: { tracks: boolean; vias: boolean; pads: boolean; copperpour: boolean; footprints: boolean } | null
  strokedFill: boolean
  filled: boolean
  rings: number[][][]
  fills: Map<string, number[][][]>
}
export function arcPoints(a: number[], m: number[], b: number[], err?: number): number[][]
export function zoneOracle(text: string): { zones: OracleZone[]; front: string; back: string; names: string[]; ids: string[] }
export function knownOther(name: string): boolean
export function importedZone(z: OracleZone): boolean
