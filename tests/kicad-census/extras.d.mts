type Choice = boolean | null
interface Drill {
  size: number
  start: string
  end: string
}
interface Post {
  mode: string
  size: number | null
  depth: number | null
  angle: number | null
}
export interface ExtrasOracle {
  copper: string[]
  board: { cap: boolean; fill: boolean; coverFront: boolean; coverBack: boolean; plugFront: boolean; plugBack: boolean }
  vias: { at: [number, number]; cap: Choice; fill: Choice; coverFront: Choice; coverBack: Choice; plugFront: Choice; plugBack: Choice; backdrill: Drill | null; tertiary: Drill | null; front: Post | null; back: Post | null }[]
  pads: { ref: string; bottom: boolean; index: number; backdrill: Drill | null; tertiary: Drill | null; front: Post | null; back: Post | null; die: number; delay: number }[]
  /** The references of the footprints, in file order (a part with none is renamed by the importer). */
  refs: string[]
  generated: { type: string; name: string; layer: string; locked: boolean; members: number; trackMembers: number; viaMembers: number; keys: string[]; props: Record<string, unknown> }[]
  chains: { name: string; nets: string[]; terminals: number }[]
}
export function extrasOracle(text: string): ExtrasOracle | null
