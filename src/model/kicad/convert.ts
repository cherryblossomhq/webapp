import type { PartIndexPin, PartPinRole, SupplierLand, SupplierPad } from "@cherryblossom/api-contract"
import { couldBe, pinRole } from "../supplier/roles"
import type { FootprintResult } from "./footprint"
import type { KicadPin, RawSymbol } from "./symbol"

// A KiCad symbol and the footprint its Footprint field names, as one part of ours: pins numbered
// and named as the symbol draws them, each pad of the footprint belonging to the pin with its
// number.
//
// A part is made only when that pairing is exact. KiCad's libraries are drawn by many hands and
// the symbol and its footprint are separate files; a symbol with no footprint named, a footprint
// that isn't in the library, a pin with no pad or a pad no pin owns would each be a part whose
// wiring the editor could not stand behind, so they are skipped, with the reason, never guessed.
// The exceptions are the ones real parts need: an exposed pad the symbol leaves out (it becomes a
// pin `EP`, so it can be tied to ground) and mounting pads (connector shells, tabs), which stay
// as copper with no pin, as they are in KiCad.

/** The KiCad symbol libraries that hold nets and flags, not parts. */
const NOT_PARTS = new Set(["power"])

export type SkipCode =
  | "power_symbol"
  | "no_pins"
  | "no_footprint"
  | "footprint_missing"
  | "footprint_unsupported"
  | "pin_conflict"
  | "pin_without_number"
  | "pin_without_pad"
  | "pad_without_pin"
  | "bad_symbol"

export interface KicadPartRow {
  /** `Regulator_Linear:AMS1117-3.3`: the library and the symbol. */
  key: string
  library: string
  name: string
  description: string
  keywords: string[]
  datasheet: string | null
  refPrefix: string
  category: string
  /** The footprint's own name, `SOT-223-3_TabPin2`: the package as KiCad writes it. */
  package: string
  /** The footprint the symbol names, `Package_TO_SOT_SMD:SOT-223-3_TabPin2`. */
  footprintKey: string
  /**
   * The land this part sits on. It is the footprint's key, plus a suffix when the
   * symbol made the land its own: pads it leaves unconnected (a connector's shell) or an exposed
   * pad it marks, which another symbol on the same footprint may not.
   */
  landKey: string
  pins: PartIndexPin[]
  /** Symbol units: a quad op-amp has 4, and all their pins are in `pins`. */
  units: number
  /** The KiCad library release it was converted from. */
  release: string
}

export interface KicadLandRow {
  /** `Package_TO_SOT_SMD:SOT-223-3_TabPin2`. */
  key: string
  land: SupplierLand
}

export type Conversion =
  | { ok: true; part: KicadPartRow; land: KicadLandRow; stats: PartStats }
  | { ok: false; code: SkipCode; detail: string }

export interface PartStats {
  /** Pins the symbol hides (a gate's power pins). */
  hiddenPins: number
  /** Pins with alternate functions. */
  alternatePins: number
  /** An exposed pad the symbol omitted, made a pin. */
  exposedPinAdded: boolean
  /** Mounting pads kept as copper with no pin. */
  mountingPads: number
}

// ---------- pins ----------

const SIDE_OF_ANGLE: Record<number, NonNullable<PartIndexPin["side"]>> = { 0: "left", 180: "right", 90: "bottom", 270: "top" }

/**
 * Names that settle a pin's role whatever type KiCad gave it: ground, an exposed pad, not
 * connected. KiCad types a ground pin `bidirectional` (the TM4C and LM4F's pin 39, `GND`), an
 * exposed pad `input` or `output` (`EP` on the HIP2100, `EPAD` on the TCA9535) and a
 * do-not-connect pin `output` or `bidirectional` (`DNC` on the EA eDIP displays, `N/C` on the
 * PIC18F45K80), because its type says what the die does and not what the board does. A wrong guess
 * here is a dead board (a ground pin that is a signal, an exposed pad nobody ties down), so these
 * names win over the type. Anything else a name might say (a supply, an output) does not: see
 * `roleOf`.
 *
 * The patterns are narrow on purpose. They read the name as KiCad spells it, not as `pinRole`
 * canonicalises it: `E+` is the THAT2180's emitter (canonically `EP`, but not a pad), and
 * `NC1` to `NC6` are an analog switch's normally-closed contacts, which only look like no-connects.
 */
const NC_NAME = /^(N\/C|NC|DNC|DO[\s_-]*NOT[\s_-]*CONNECT|NO[\s_-]*CONNECT|NOT[\s_-]*CONNECTED)$/i
const EXPOSED_PAD_NAME = /^(EP|E-?PAD|PAD|TAB|THERMAL[\s_-]*PAD|EXPOSED[\s_-]*PAD)\d*$/i

function roleByName(name: string): "ground" | "exposed_pad" | "nc" | null {
  const n = name.trim()
  if (NC_NAME.test(n)) return "nc"
  if (EXPOSED_PAD_NAME.test(n)) return "exposed_pad"
  return pinRole(n) === "ground" ? "ground" : null
}

/**
 * KiCad's electrical type decides a pin's role, except for the names above. A pin KiCad draws as an
 * input, output or bidirectional is a signal whatever else its name looks like: `V_{IN}0` on a
 * converter's analog input, `VP`/`VN` on a tone decoder and `Vbus` on a current monitor are inputs,
 * not supplies, and a regulator's `VDD` output is not a supply input. A `passive`, `unspecified`
 * or `free` pin takes the role its name declares, and the supply and ground types still refine
 * toward ground, exposed pad and no-connect by name.
 */
function roleOf(pin: KicadPin): PartPinRole {
  if (pin.etype === "no_connect") return "nc"
  switch (pin.etype) {
    case "power_in": {
      const byName = pinRole(pin.name)
      if (byName === "ground" || byName === "exposed_pad" || byName === "nc") return byName
      return couldBe("ground", pin.name) && !couldBe("power_in", pin.name) ? "ground" : "power_in"
    }
    case "power_out":
      return pinRole(pin.name) === "ground" ? "ground" : "power_out"
    case "input":
    case "output":
    case "bidirectional":
    case "tri_state":
    case "open_collector":
    case "open_emitter":
      return roleByName(pin.name) ?? "signal"
    default:
      // passive, unspecified, free: KiCad says nothing, so the name does.
      return pinRole(pin.name)
  }
}

/** What the box symbol draws a signal pin as. Supplies, grounds and unconnected pins say it by their role. */
function kindOf(pin: KicadPin, role: PartPinRole): PartIndexPin["kind"] {
  if (role !== "signal") return undefined
  switch (pin.etype) {
    case "input":
      return "input"
    case "output":
    case "tri_state":
    case "open_collector":
    case "open_emitter":
      return "output"
    case "bidirectional":
      return "io"
    default:
      return "passive"
  }
}

const sideOf = (angle: number): PartIndexPin["side"] => SIDE_OF_ANGLE[((Math.round(angle / 90) * 90) % 360 + 360) % 360]

/** A pin's place in the layout: side first, then along it (top to bottom on the left and right, left to right on top and bottom). */
const SIDE_RANK = { left: 0, right: 1, top: 2, bottom: 3 } as const

function layoutOrder(a: KicadPin, b: KicadPin): number {
  // Unit 0 is shared by every unit (a part's own power pins): after the units' pins.
  const ua = a.unit === 0 ? Infinity : a.unit
  const ub = b.unit === 0 ? Infinity : b.unit
  if (ua !== ub) return ua < ub ? -1 : 1
  const sa = SIDE_RANK[sideOf(a.angle) ?? "left"]
  const sb = SIDE_RANK[sideOf(b.angle) ?? "left"]
  if (sa !== sb) return sa - sb
  return sa <= 1 ? b.y - a.y || a.x - b.x : a.x - b.x || b.y - a.y
}

interface Merged {
  pins: KicadPin[]
  conflict: string | null
}

/** One pin per number: the same pin listed in several units is one, and one number with two names is a conflict. */
function mergePins(pins: KicadPin[]): Merged {
  const byNumber = new Map<string, KicadPin>()
  for (const pin of pins) {
    const have = byNumber.get(pin.number)
    if (!have) {
      byNumber.set(pin.number, pin)
    } else if (have.name !== pin.name) {
      return { pins: [], conflict: `pin ${pin.number} is ${have.name} and ${pin.name}` }
    } else if (have.etype !== pin.etype && /^power_/.test(pin.etype)) {
      byNumber.set(pin.number, { ...have, etype: pin.etype })
    }
  }
  return { pins: [...byNumber.values()], conflict: null }
}

// ---------- categories ----------

/** The editor's category for a KiCad symbol library. */
export function categoryOf(library: string): string {
  if (/^(Regulator|Power_|Reference_Voltage|Converter_DCDC|Converter_ACDC|Battery_Management)/.test(library)) return "Power"
  if (/^Connector/.test(library)) return "Connectors"
  if (/^(Switch|Relay|Buzzer|Motor|Fuse|Mechanical|Jumper)/.test(library)) return "Electromechanical"
  if (/^(Diode|LED)/.test(library)) return "Diodes"
  if (/^Transistor/.test(library)) return "Transistors"
  if (/^(RF_Module|Module|RF_Bluetooth|RF_WiFi)/.test(library)) return "Modules"
  if (/^(Device|Inductor|Filter)/.test(library)) return "Passives"
  return "ICs"
}

const DEFAULT_PREFIX: Record<string, string> = {
  Passives: "X",
  Diodes: "D",
  Transistors: "Q",
  Power: "U",
  ICs: "U",
  Modules: "U",
  Connectors: "J",
  Electromechanical: "SW",
}

function refPrefixOf(reference: string | undefined, category: string): string {
  const letters = (reference ?? "").replace(/[^A-Za-z]/g, "").toUpperCase()
  return /^[A-Z]{1,3}$/.test(letters) ? letters : (DEFAULT_PREFIX[category] ?? "U")
}

// ---------- pads and pins ----------

/** Pad numbers a mounting tab, shell or shield carries: copper with no pin, as KiCad leaves it. */
const MOUNTING = /^(MP|MH|SH|SHELL|SHIELD|SHLD|MOUNT|MNT|S|G|TAB)\d*$/i

const area = (p: SupplierPad) => p.width * p.height

/** FNV-1a in base 36, for the suffix of a land a symbol changed. */
function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(0, 6)
}

/** The footprint's name after the library: `Package_QFP:TQFP-32_7x7mm_P0.8mm` is `TQFP-32_7x7mm_P0.8mm`. */
const packageOf = (footprintKey: string) => footprintKey.slice(footprintKey.indexOf(":") + 1)

export interface ConvertContext {
  library: string
  /** The footprint library's answer for a `Library:Name` key, or undefined when it has no such footprint. */
  footprint: (key: string) => FootprintResult | undefined
  /** The KiCad release, e.g. `10.0.7`. */
  release: string
}

/** A resolved symbol (`extends` already followed) as a part, or the reason it isn't one. */
export function convertSymbol(symbol: RawSymbol, ctx: ConvertContext): Conversion {
  const skip = (code: SkipCode, detail = ""): Conversion => ({ ok: false, code, detail })
  if (symbol.power || NOT_PARTS.has(ctx.library)) return skip("power_symbol")
  if (!symbol.pins.length && !symbol.unnumbered) return skip("no_pins")
  // A pin with no number would leave the part a pin short, and nothing to say which pad is its own.
  if (symbol.unnumbered) return skip("pin_without_number", `${symbol.unnumbered} pin${symbol.unnumbered === 1 ? "" : "s"} with no number`)
  const footprintKey = (symbol.props.Footprint ?? "").trim()
  if (!footprintKey) return skip("no_footprint")
  const result = ctx.footprint(footprintKey)
  if (!result) return skip("footprint_missing", footprintKey)
  if (!result.ok) return skip("footprint_unsupported", `${footprintKey}: ${result.reason}`)

  const merged = mergePins(symbol.pins)
  if (merged.conflict) return skip("pin_conflict", merged.conflict)
  const pins = merged.pins

  // Pads and pins must pair by number.
  const land: SupplierLand = { ...result.land, pads: result.land.pads.map((p) => ({ ...p })) }
  const padNumbers = new Set(land.pads.filter((p) => p.number && p.plated !== false).map((p) => p.number))
  const pinNumbers = new Set(pins.map((p) => p.number))
  const noPad = [...pinNumbers].filter((n) => !padNumbers.has(n))
  if (noPad.length) return skip("pin_without_pad", `${footprintKey}: pin${noPad.length === 1 ? "" : "s"} ${noPad.slice(0, 6).join(", ")}${noPad.length > 6 ? ", ..." : ""}`)

  const stats: PartStats = { hiddenPins: pins.filter((p) => p.hidden).length, alternatePins: pins.filter((p) => p.alternates.length).length, exposedPinAdded: false, mountingPads: 0 }
  const extra = [...padNumbers].filter((n) => !pinNumbers.has(n))
  const extraPins: PartIndexPin[] = []
  if (extra.length) {
    const numericPins = pins.map((p) => Number(p.number)).filter(Number.isFinite)
    const maxPin = numericPins.length ? Math.max(...numericPins) : 0
    // The pads of the pins, for scale: an exposed pad is much bigger than the leads around it.
    const areas = land.pads.filter((p) => pinNumbers.has(p.number)).map(area).sort((a, b) => a - b)
    const median = areas[Math.floor(areas.length / 2)] ?? 0
    const biggest = Math.max(...land.pads.map(area))
    const unowned: string[] = []
    for (const n of extra) {
      const copper = land.pads.filter((p) => p.number === n)
      const main = copper.reduce((a, b) => (area(b) > area(a) ? b : a))
      const exposedLike = /^(EP|EPAD)\d*$/i.test(n) || (Number(n) === maxPin + 1 && area(main) >= biggest * 0.999 && area(main) >= 2.5 * median)
      if (exposedLike) {
        main.exposed = true
        extraPins.push({ number: n, name: "EP", aliases: [], role: "exposed_pad", side: "bottom" })
        stats.exposedPinAdded = true
      } else if (MOUNTING.test(n)) {
        // Copper with no pin: the pad's number is dropped so the editor reads it as unconnected.
        for (const p of copper) p.number = ""
        stats.mountingPads += copper.length
      } else {
        unowned.push(n)
      }
    }
    if (unowned.length) return skip("pad_without_pin", `${footprintKey}: pad${unowned.length === 1 ? "" : "s"} ${unowned.slice(0, 6).join(", ")}${unowned.length > 6 ? ", ..." : ""}`)
  }

  // A symbol's own exposed-pad pin marks that pad too.
  const dbPins: PartIndexPin[] = [...pins].sort(layoutOrder).map((p) => {
    const role = roleOf(p)
    const kind = kindOf(p, role)
    const side = sideOf(p.angle)
    return { number: p.number, name: p.name, aliases: p.alternates, role, ...(kind && { kind }), ...(side && { side }) }
  })
  for (const p of dbPins) {
    if (p.role !== "exposed_pad") continue
    const copper = land.pads.filter((q) => q.number === p.number)
    if (copper.length) copper.reduce((a, b) => (area(b) > area(a) ? b : a)).exposed = true
  }
  dbPins.push(...extraPins)
  // The land as this symbol uses it. When that differs from the footprint's own, it is a land of its own.
  const blanked = land.pads.map((p, i) => (p.number !== result.land.pads[i].number ? i : -1)).filter((i) => i >= 0)
  const exposedAt = land.pads.map((p, i) => (p.exposed ? i : -1)).filter((i) => i >= 0)
  const landKey = blanked.length || exposedAt.length ? `${footprintKey}#${hashOf(JSON.stringify([blanked, exposedAt]))}` : footprintKey

  const description = (symbol.props.Description ?? "").trim()
  const keywords = (symbol.props.ki_keywords ?? "").split(/\s+/).filter(Boolean)
  const category = categoryOf(ctx.library)
  const pkg = packageOf(footprintKey)
  return {
    ok: true,
    stats,
    land: { key: landKey, land },
    part: {
      key: `${ctx.library}:${symbol.name}`,
      library: ctx.library,
      name: symbol.name,
      description,
      keywords,
      datasheet: (symbol.props.Datasheet ?? "").trim() && symbol.props.Datasheet.trim() !== "~" ? symbol.props.Datasheet.trim() : null,
      refPrefix: refPrefixOf(symbol.props.Reference, category),
      category,
      package: pkg,
      footprintKey,
      landKey,
      pins: dbPins,
      units: symbol.units,
      release: ctx.release,
    },
  }
}
