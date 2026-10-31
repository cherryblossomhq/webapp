import { makeBoxSymbol, type BoxPin } from "./symbols"
import type { PartCategory, PartDef, PinDef } from "./types"

// Helpers for defining library parts.

export const passive = (...pins: [string, string][]): PinDef[] => pins.map(([number, name]) => ({ number, name, kind: "passive" }))

/** Pin numbers in reading order: 1, 2, 10, A1, A2, B1... */
export const byPinNumber = (a: PinDef, b: PinDef) => a.number.localeCompare(b.number, undefined, { numeric: true })

export function header(n: number, female = false): PartDef {
  const pins = Array.from({ length: n }, (_, i) => ({ number: String(i + 1), name: String(i + 1) }))
  return {
    id: `header_1x${n}${female ? "_f" : ""}`,
    name: `${female ? "Socket" : "Pin Header"} 1x${n}`,
    category: "Connectors",
    description: `2.54 mm ${female ? "female socket" : "male pin header"}, ${n} positions`,
    refPrefix: "J",
    pins: pins.map((p) => ({ ...p, kind: "passive" })),
    symbol: makeBoxSymbol({ right: pins }),
    footprints: female ? [`pinrow${n}_female`] : [`pinrow${n}`, `pin_header_1x${n}`],
    defaultProps: {},
    keywords: female ? ["connector", "socket", "female header", "receptacle", "dupont"] : ["connector", "header", "pins", "dupont"],
    body3d: { height: female ? 8.5 : 2.5, color: "#111111" },
  }
}

/** 2 x n male header on 2.54 mm, odd pins in one row and even pins in the other. */
export function dualHeader(n: number, extra: { name?: string; description?: string; keywords?: string[] } = {}): PartDef {
  const count = 2 * n
  const pins = Array.from({ length: count }, (_, i) => ({ number: String(i + 1), name: String(i + 1) }))
  return {
    id: `header_2x${n}`,
    name: extra.name ?? `Pin Header 2x${n}`,
    category: "Connectors",
    description: extra.description ?? `2.54 mm dual-row male pin header, ${count} positions`,
    refPrefix: "J",
    pins: pins.map((p) => ({ ...p, kind: "passive" })),
    // Odd pins down the left and even pins down the right, as the header reads from above.
    symbol: makeBoxSymbol({ left: pins.filter((_, i) => i % 2 === 0), right: pins.filter((_, i) => i % 2 === 1) }),
    footprints: [`pinrow${count}_rows2`],
    defaultProps: {},
    keywords: ["connector", "header", "dual row", "box header", "idc", ...(extra.keywords ?? [])],
    body3d: { height: 2.5, color: "#111111" },
  }
}

export interface ConnectorSpec {
  id: string
  name: string
  description: string
  footprints: string[]
  /** Pins in order down the symbol's right side, as [number, name]. */
  pins: [string, string][]
  /** Pins along the bottom (ground, shield). */
  bottom?: [string, string][]
  category?: PartCategory
  refPrefix?: string
  mpn?: string
  keywords?: string[]
  padAlias?: Record<string, string>
  body3d?: PartDef["body3d"]
}

/** A connector: its contacts down the right of a box, so wires run off into the circuit. */
export function connector(spec: ConnectorSpec): PartDef {
  const right: BoxPin[] = spec.pins.map(([number, name]) => ({ number, name }))
  const bottom: BoxPin[] = (spec.bottom ?? []).map(([number, name]) => ({ number, name }))
  const kindOf = (name: string): PinDef["kind"] =>
    /^(GND|VSS|SHIELD|-)$/i.test(name) ? "ground" : /^(VBUS|VCC|VDD|\+|5V|3V3)$/i.test(name) ? "power" : "passive"
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category ?? "Connectors",
    description: spec.description,
    refPrefix: spec.refPrefix ?? "J",
    pins: [...right, ...bottom].map((p) => ({ number: p.number, name: p.name, kind: kindOf(p.name) })).sort(byPinNumber),
    symbol: makeBoxSymbol({ right, bottom }),
    footprints: spec.footprints,
    defaultProps: spec.mpn ? { mpn: spec.mpn } : {},
    valueProp: spec.mpn ? "mpn" : undefined,
    keywords: spec.keywords,
    padAlias: spec.padAlias,
    mpn: spec.mpn,
    body3d: spec.body3d,
  }
}

/** Numbered contacts 1..n named by their number, for terminal blocks and wire-to-board connectors. */
export const numbered = (n: number): [string, string][] => Array.from({ length: n }, (_, i) => [String(i + 1), String(i + 1)])
