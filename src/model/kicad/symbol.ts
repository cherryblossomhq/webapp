import { all, first, flag, num, parseSexpr, str, type SNode } from "./sexpr"

// KiCad schematic symbols (`.kicad_sym`), read for what a part needs: its properties, and its pins
// with their electrical type, where they sit on the symbol and the alternate functions they can
// take. The drawing itself (rectangles, text) is the editor's own box symbol's business.
//
// A library is a directory of one-symbol files (`Regulator_Linear.kicad_symdir/AMS1117-3.3.kicad_sym`
// since KiCad 10) or one file of many symbols; both are read by `parseSymbols`. A symbol may
// `extend` another in its library (AMS1117-3.3 extends AP1117-15): it takes the base's pins and
// overrides its properties.

export interface KicadPin {
  /** The pin number as drawn: `1`, `A1`, `EP`. It is the pad number on the footprint. */
  number: string
  /** The name as drawn, with KiCad's `~{...}` overbar markup turned into a trailing `#`. */
  name: string
  /** KiCad's electrical type: `input`, `output`, `bidirectional`, `tri_state`, `passive`, `free`, `unspecified`, `power_in`, `power_out`, `open_collector`, `open_emitter`, `no_connect`. */
  etype: string
  /** Hidden pins are still pins with pads (the power pins of a logic gate); they are kept. */
  hidden: boolean
  x: number
  y: number
  /** The direction the pin points, from its connection point toward the body: 0 right, 90 up, 180 left, 270 down. */
  angle: number
  /** The symbol unit it belongs to; 0 for a pin shared by every unit. */
  unit: number
  /** Other names the pin can take (`PCINT0`, `ADC0`), from KiCad's alternate pin functions. */
  alternates: string[]
}

export interface RawSymbol {
  name: string
  /** The symbol this one extends, in the same library. */
  extendsName?: string
  props: Record<string, string>
  pins: KicadPin[]
  /** A power port or flag (`GND`, `+5V`): a net, not a part. */
  power: boolean
  /** How many units the symbol has: 4 for a quad op-amp. */
  units: number
  /** Pins the symbol draws with no number (Valve:ECH81 has one). Such a part can't be paired with its pads. */
  unnumbered: number
}

/**
 * A pin name as the editor writes it. `~{RESET}` is KiCad's overbar, active low: `RESET#`.
 * `V_{IN}` and `x^{2}` are its subscript and superscript, which the editor doesn't draw: `VIN`. A
 * lone `~` is no name at all, and the number stands in for it.
 */
export function cleanPinName(raw: string, number: string): string {
  const name = raw
    .replace(/[_^]\{([^{}]*)\}/g, "$1")
    .replace(/~\{([^}]*)\}/g, (_, inner: string) => `${inner}#`)
    .trim()
  return !name || name === "~" ? number : name
}

/** A pin as drawn, or `"unnumbered"` for one with no number: it can't be dropped silently, because the part would then be missing a pin. */
function parsePin(node: SNode[], unit: number): KicadPin | "unnumbered" {
  const number = str(first(node, "number"), 1)
  if (number === undefined || number.trim() === "") return "unnumbered"
  const at = first(node, "at")
  const name = cleanPinName(str(first(node, "name"), 1) ?? "", number)
  const alternates = all(node, "alternate")
    .map((a) => cleanPinName(str(a, 1) ?? "", ""))
    .filter((a) => a && a !== name)
  return {
    number,
    name,
    etype: str(node, 1) ?? "unspecified",
    hidden: flag(node, "hide"),
    x: num(at, 1),
    y: num(at, 2),
    angle: num(at, 3),
    unit,
    alternates,
  }
}

/** Every symbol in a `.kicad_sym` file. */
export function parseSymbols(text: string): RawSymbol[] {
  const lib = parseSexpr(text).find((n): n is SNode[] => Array.isArray(n) && n[0] === "kicad_symbol_lib")
  if (!lib) throw new Error("not a KiCad symbol library: no (kicad_symbol_lib ...)")
  const out: RawSymbol[] = []
  for (const sym of all(lib, "symbol")) {
    const name = str(sym, 1)
    if (!name) continue
    const props: Record<string, string> = {}
    for (const p of all(sym, "property")) {
      const key = str(p, 1)
      if (key !== undefined) props[key] = str(p, 2) ?? ""
    }
    const pins: KicadPin[] = []
    let unnumbered = 0
    let units = 1
    for (const sub of all(sym, "symbol")) {
      // `NAME_<unit>_<style>`: unit 0 is shared by every unit; style 2 is the De Morgan drawing of
      // the same pins, which would list each of them twice.
      const m = (str(sub, 1) ?? "").match(/_(\d+)_(\d+)$/)
      if (!m) continue
      const unit = Number(m[1])
      const style = Number(m[2])
      if (unit > units) units = unit
      if (style > 1) continue
      for (const pin of all(sub, "pin")) {
        const parsed = parsePin(pin, unit)
        if (parsed === "unnumbered") unnumbered++
        else pins.push(parsed)
      }
    }
    out.push({
      name,
      extendsName: str(first(sym, "extends"), 1),
      props,
      pins,
      power: first(sym, "power") !== undefined,
      units,
      unnumbered,
    })
  }
  return out
}

/** A symbol with its base's pins and properties folded in, following `extends` chains. */
export function resolveExtends(symbol: RawSymbol, lookup: (name: string) => RawSymbol | undefined): RawSymbol {
  const seen = new Set<string>([symbol.name])
  let current = symbol
  let merged: RawSymbol = { ...symbol }
  while (current.extendsName) {
    const base = lookup(current.extendsName)
    if (!base || seen.has(base.name)) {
      throw new Error(`symbol ${symbol.name} extends ${current.extendsName}, which is ${base ? "a cycle" : "not in its library"}`)
    }
    seen.add(base.name)
    merged = {
      ...merged,
      props: { ...base.props, ...merged.props },
      pins: merged.pins.length ? merged.pins : base.pins,
      units: merged.pins.length ? merged.units : base.units,
      unnumbered: merged.pins.length ? merged.unnumbered : base.unnumbered,
      power: merged.power || base.power,
    }
    current = base
  }
  return merged
}
