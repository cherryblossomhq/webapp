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
  driver: Map<number, { name: string; full: string; prio: number; low: boolean; depth: number; strong: boolean }>
  /** The names each group carries. */
  names: Map<number, Set<string>>
  /** S8: the classes each net that has a pin is in, by the net's name: the Netclass fields of the labels on it, and of a rule area's directive labels for what the area holds. */
  netClasses: Map<string, Set<string>>
  /** What was left out of the derivation: `buses`. */
  unsupported: Set<string>
  /** Where the editor's own rules and KiCad's part, per sheet file: the cases of the importer's S11 flag. */
  cases: { file: string; kind: "wire-end-on-side" | "label-pin-side" | "near-miss" | "close-points" | "pin-rounding" }[]
  symbols: number
  pinsTotal: number
  instances: number
  groupOf(key: string): number | number[] | undefined
  /** The full name KiCad gives a group's net: its driver's (a global one as written, a local one with its sheet's path), else the pin's `Net-(R1-Pad2)` or `unconnected-(...)`; null when nothing names it. */
  netName(group: number): string | null
}
/** The member nets of a bus name read by the oracle's own reader (KiCad 6 to 9's grammar for the names the corpus has), or null for a net's name. */
export function busMembers(text: string, aliases: Map<string, string[]>, depth?: number): { kind: "vector" | "group"; names: string[]; locals: string[] } | null
export function deriveNets(rootFile: string, opts?: DeriveOptions): Derived
export interface BoardFootprintNets {
  ref: string
  path: string
  pads: { number: string; type: string | undefined; net: string | null }[]
}
export function boardPadNets(boardFile: string): BoardFootprintNets[]
