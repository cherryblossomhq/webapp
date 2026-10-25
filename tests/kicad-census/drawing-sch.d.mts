export interface RawSymbol {
  shapes: { kind: string; unit: number; body: number; nums: number[]; fill: string; width: number; private: boolean }[]
  pins: { unit: number; body: number; type: string; shape: string; at: number[]; angle: number; length: number; number: string; name: string; hidden: boolean; alternates: string[][] }[]
  units: number
  styles: number
  fields: { name: string; value: string; at: number[]; angle: number }[]
  version: number
}
export function rawSymbols(text: string): Map<string, RawSymbol>
export function kicadTransform(angle: number, mirror: string): { x1: number; y1: number; x2: number; y2: number }
export interface RawField {
  uuid: string
  name: string
  anchor: { x: number; y: number }
  size: number
  layout(length: number): { box: { minX: number; maxX: number; minY: number; maxY: number }; vertical: boolean }
}
export function rawFields(text: string): RawField[]
