export interface DeriveOptions {
  /** Where a wire end or a pin on another wire's body joins it: only with a junction (KiCad's rule), always, or never. */
  bodyConnects?: "junction" | "always" | "never"
  /** A power symbol's net is its Value (default) or its pin's name. */
  powerNameFrom?: "value" | "name"
  /** A hidden power-input pin joins the global net named by its pin (KiCad's rule). */
  hiddenPower?: boolean
  /** A local label joins the global net of the same name when there is one on its own sheet (`same`, KiCad's rule and the default), anywhere (`any`), or never (`none`). */
  localJoinsGlobal?: "none" | "same" | "any"
}
export interface Derived {
  /** Pin key `<board path>#<pin number>` to the net group (a number), or an array of them for a number held by several pins. */
  pins: Map<string, number | number[]>
  /** The name KiCad gives each group that has a driver, and the driver's priority (2 sheet pin to 7 global label). */
  driver: Map<number, { name: string; prio: number; low: boolean }>
  /** The names each group carries. */
  names: Map<number, Set<string>>
  /** What was left out of the derivation: `buses`. */
  unsupported: Set<string>
  symbols: number
  pinsTotal: number
  instances: number
  groupOf(key: string): number | number[] | undefined
}
export function deriveNets(rootFile: string, opts?: DeriveOptions): Derived
export interface BoardFootprintNets {
  ref: string
  path: string
  pads: { number: string; type: string | undefined; net: string | null }[]
}
export function boardPadNets(boardFile: string): BoardFootprintNets[]
