export function legacyRecordCounts(text: string): Record<string, number>
export function legacyNeeds(text: string): Set<string>
export interface RawLegacyPin {
  name: string
  number: string
  at: [number, number]
  length: number
  orient: string
  unit: number
  convert: number
  type: string
  attrs: string
}
export type RawLegacyShape =
  | { kind: "arc"; c: [number, number]; r: number; a1: number; a2: number; unit: number; convert: number; width: number; fill: string; ends: [number, number, number, number] | null }
  | { kind: "circle"; c: [number, number]; r: number; unit: number; convert: number; width: number; fill: string }
  | { kind: "rect"; a: [number, number]; b: [number, number]; unit: number; convert: number; width: number; fill: string }
  | { kind: "poly" | "bezier"; pts: [number, number][]; unit: number; convert: number; width: number; fill: string }
  | { kind: "text"; at: [number, number]; unit: number; convert: number }
export interface RawLegacySymbol {
  name: string
  units: number
  power: boolean
  offset: number
  shapes: RawLegacyShape[]
  pins: RawLegacyPin[]
  fields: { index: number; text: string; at: [number, number]; size: number; vertical: boolean; visible: boolean }[]
  aliases: string[]
}
export function rawLegacySymbols(text: string): Map<string, RawLegacySymbol>
