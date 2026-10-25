export interface LegacyDeriveOptions {
  /** Whether a pin of the type "no connect" joins what is drawn to it (KiCad 5 does, by default). */
  ncPinsOnNets?: boolean
}
export interface LegacyDerived {
  /** Pin key `<board path>#<pad>` (the path upper case, without leading zeros) to its net group. */
  pins: Map<string, number | number[]>
  driver: Map<number, { name: string; bare: string; prio: number }>
  /** What was left out of the derivation: `buses`. */
  unsupported: Set<string>
  symbols: number
  /** The names of the symbols no library of the project has. */
  missing: Set<string>
  pinList: { key: string; group: number; ref: string; pad: string }[]
  groupOf(key: string): number | number[] | undefined
  /** The name KiCad 5 gives a group's net, or null for a net no label names and no pin of a part is on. */
  netName(group: number): string | null
}
export function deriveLegacyNets(rootFile: string, opts?: LegacyDeriveOptions): LegacyDerived
export function readLib(file: string): Map<string, { name: string; power: boolean; pins: { name: string; number: string; x: number; y: number; unit: number; convert: number; type: string; hidden: boolean }[] }>
/** KiCad's `ConvertToNewOverbarNotation`: the old `~NAME~` is `~{NAME}`. */
export function newOverbar(old: string): string
