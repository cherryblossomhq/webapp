// Names to bodies: reads a package's own name (KiCad's `SOIC-8_3.9x4.9mm_P1.27mm`, a supplier's
// `SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL`) into the family of model that draws it and the sizes the name
// states. Pure: no three.js, so the tests read it without a browser.
//
// A name is parsed, never looked up: the families are matched by pattern and the dimensions are
// read out of the name where it has them, so a package nobody listed still gets the right body.
// What a name does not say (a body height, a lead style) comes from the family's typical value in
// the builders. A name nothing here recognises, or one that looks like a family but isn't drawn
// by it (a horizontal header, a TO-247), returns null and the caller goes on to the footprint's
// own name, as every part drew before packages were named.

import type { BodySize, ChipRole } from "./smd"

/** What the caller knows about the part besides the package's name. */
export interface PartHints {
  /** Designator prefix from the symbol (`R`, `C`, `D`, `U`...). */
  refPrefix?: string
  /** Name, description and keywords, for a word that settles what a chip is. */
  text?: string
}

export type GullStyle = "sot23" | "sot323" | "sot523" | "sot223" | "sot89" | "soic" | "ssop" | "tssop" | "msop" | "tqfp" | "lqfp" | "pqfp" | "to252" | "to263"

/** What a name settles. `family` is the builder that draws it. */
export type ModelPlan =
  | { family: "chip"; role: ChipRole; l: number; w: number; cathodeFirst?: boolean }
  | { family: "moldedDiode"; style: string; cathodeFirst?: boolean }
  | { family: "gullWing"; style: GullStyle; body?: BodySize }
  | { family: "noLead"; body?: BodySize }
  | { family: "gridPackage"; body?: BodySize; balls: boolean }
  | { family: "dip" }
  | { family: "to220"; isolated: boolean }
  | { family: "to92" }
  | { family: "pinHeader"; socket: boolean }
  | { family: "jst"; series: "ph" | "xh" | "eh" }

const num = (s: string) => Number(s.replace(",", "."))

// ---------- reading a name ----------

/** The name without its library, upper-cased and with spaces turned to `_`. */
const clean = (name: string) => name.slice(name.indexOf(":") + 1).trim().toUpperCase().replace(/\s+/g, "_")

/** Parts of a name that carry sizes that are not the body's: the exposed pad, the mask, the layout of a grid. */
const NOT_BODY = /(?:^|[_-])(?:EP|MASK|LAYOUT\w*|BALL|PAD|THERMALVIAS|DIE)\d*(?:\.\d+)?(?:X\d+(?:\.\d+)?)?(?:MM)?(?=[_-]|$)/g

/**
 * The body a name states, if it does: KiCad's `3.9x4.9mm` (across the pins, then along them) and
 * a supplier's `L4.9-W3.9` (length along the pins, width across).
 */
export function bodyOf(name: string): BodySize | undefined {
  const n = clean(name)
  const supplier = n.match(/(?:^|[_-])L(\d+(?:\.\d+)?)-W(\d+(?:\.\d+)?)(?=[_-]|$)/)
  if (supplier) return { w: num(supplier[2]), l: num(supplier[1]) }
  const stripped = n.replace(NOT_BODY, "")
  const m = stripped.match(/(?:^|[^\d.])(\d+(?:[.,]\d+)?)X(\d+(?:[.,]\d+)?)(?:X(\d+(?:[.,]\d+)?)(?!P))?(?:MM)?(?=[_-]|$)/)
  if (!m) return undefined
  const w = num(m[1])
  const l = num(m[2])
  const h = m[3] ? num(m[3]) : undefined
  // A pin count or a pitch read as a size (`SOIC-8_3x4`) is not one: a body is a few millimetres at least.
  if (w < 0.4 || l < 0.4 || w > 60 || l > 60) return undefined
  return { w, l, ...(h && h < 12 ? { h } : {}), xy: true }
}

// ---------- chips ----------

/** Imperial chip codes and the body each is, in millimetres. */
const IMPERIAL: Record<string, [number, number]> = {
  "01005": [0.4, 0.2],
  "0201": [0.6, 0.3],
  "0402": [1.0, 0.5],
  "0603": [1.6, 0.8],
  "0805": [2.0, 1.25],
  "1206": [3.2, 1.6],
  "1210": [3.2, 2.5],
  "1812": [4.5, 3.2],
  "2010": [5.0, 2.5],
  "2220": [5.7, 5.0],
  "2512": [6.3, 3.2],
}

/** A passive's letters and an imperial code: `R_0603_1608Metric`, `LED_0805`, or the code alone (`0603`). */
const CHIP_NAME = /^(?:(R|RES|C|CAP|L|IND|LED|D|DIODE)[_-]?)?(01005|0201|0402|0603|0805|1206|1210|1812|2010|2220|2512)(?=[_-]|$)/

/** A metric code, `1608Metric` for 1.6 x 0.8 mm, after a passive's letter (and an imperial code that isn't in the table). */
const METRIC_NAME = /^(R|C|L|LED|D)_(?:\d{4,5}_)?(\d{2})(\d{2})METRIC/

/** The role of a chip from the start of its name, then the part's designator, then its words (the category's included). */
function chipRole(prefix: string | undefined, hints: PartHints): ChipRole {
  const p = prefix ?? ""
  if (/^(?:R|RES)$/.test(p)) return "resistor"
  if (/^(?:C|CAP)$/.test(p)) return "capacitor"
  if (p === "L" || p === "IND") return "inductor"
  if (p === "LED") return "led"
  if (p === "D" || p === "DIODE") return "diode"
  // A bare code (`0603` on a supplier's land) says nothing about what is in it: the part's
  // designator, then its category and description, do.
  const ref = (hints.refPrefix ?? "").toUpperCase()
  const text = hints.text ?? ""
  if (ref === "R") return "resistor"
  if (ref === "C") return "capacitor"
  if (ref === "L") return "inductor"
  if (ref === "D") return /\bled\b/i.test(text) ? "led" : "diode"
  if (/\bled\b/i.test(text)) return "led"
  if (/resistor|\bohm|\bres\b|\d\s*[kM]?Ω/i.test(text)) return "resistor"
  if (/inductor|ferrite|\bchoke\b|\bbead\b/i.test(text)) return "inductor"
  if (/diode|schottky|\bzener\b|\btvs\b/i.test(text)) return "diode"
  return "capacitor"
}

function chipPlan(n: string, hints: PartHints): ModelPlan | null {
  const code = n.match(CHIP_NAME)
  const metric = code ? null : n.match(METRIC_NAME)
  if (!code && !metric) return null
  // Resistor arrays and networks share a chip's code and are not one chip.
  if (/ARRAY|PACK|NETWORK|CONVEX/.test(n)) return null
  const [l, w] = metric ? [num(metric[2]) / 10, num(metric[3]) / 10] : IMPERIAL[code![2]]
  const role = chipRole(metric?.[1] ?? code?.[1], hints)
  return { family: "chip", role, l, w, ...(role === "led" || role === "diode" ? { cathodeFirst: true } : {}) }
}

// ---------- the families ----------

/** Leaded dual and quad packages: the style the builders draw. Checked in this order. */
const GULL: [RegExp, GullStyle][] = [
  [/(?:^|[_-])(?:T|HV|X|V)QFP/, "tqfp"],
  [/(?:^|[_-])(?:HL|L)QFP/, "lqfp"],
  // Plain, plastic, metric and heat-sink QFPs: 2.0 to 3.4 mm tall, taller than the thin ones.
  [/(?:^|[_-])[HPMEC]?QFP/, "pqfp"],
  [/(?:^|[_-])(?:H|HV|E|P)?TSSOP/, "tssop"],
  [/(?:^|[_-])(?:H|HV|U|MINI)?(?:VSSOP|MSOP)|(?:^|[_-])MINI-?SO/, "msop"],
  [/(?:^|[_-])(?:H|HV|Q|E|P)?SSOP/, "ssop"],
  [/(?:^|[_-])(?:H|HV|E|P|HS|ES)?(?:SOIC|SOP|SO)-?\d/, "soic"],
]

function gullFamily(n: string): GullStyle | null {
  for (const [re, style] of GULL) if (re.test(n)) return style
  return null
}

/** QFN, DFN, SON and their relatives: terminals under the body, flush with its edge. */
const NO_LEAD = /(?:^|[_-])[A-Z]{0,4}(?:QFN|DFN|SON)(?![A-Z])|(?:^|[_-])LFCSP/

/** Grid packages: pads under the body. */
const GRID = /(?:^|[_-])[A-Z]{0,3}(?:BGA|CSP|LGA)(?![A-Z])/

/**
 * The moulded diode style (a `diodeSize` key) for SOD, SMA, SMB and SMC bodies. KiCad's `D_SMA` and
 * a supplier's `SMA(DO-214AC)` or `SMA_L4.3-W2.7`; not an SMA connector.
 */
function diodeStyle(n: string): string | null {
  const sod = n.match(/(?:^|[_-])SOD-?(123|323|523|723|923|882|128|110)([A-Z]{0,2})(?![A-Z0-9])/)
  if (sod) return `sod${sod[1]}${sod[2].toLowerCase()}`
  if (/POWERDI-?123/.test(n)) return "sod123"
  const doN = n.match(/(?:^|[_-])DO-?214(A[ABC])/)
  if (doN) return { AA: "smb", AB: "smc", AC: "sma" }[doN[1]] ?? null
  const sm = n.match(/^(?:D_|DIODE[_-])?(SM[ABC])(?:$|\(|_L\d|[_-]HAND|[_-]DO)/) ?? n.match(/^(SM[ABC])J\d/)
  return sm ? sm[1].toLowerCase() : null
}

/** Packages named by their family: SOT, SO, QFP, QFN, BGA, DIP, TO and the like. */
function icFamily(n: string): ModelPlan | null {
  const body = bodyOf(n)

  // PowerPAK's SO-8 and SC-70 are flat-lead packages with a bare drain plate, not gull wings.
  if (/POWERPAK/.test(n)) return null

  // Small outline transistors and their relatives.
  if (/(?:^|[_-])SOT-?223(?!\d)/.test(n)) return { family: "gullWing", style: "sot223" }
  if (/(?:^|[_-])SOT-?89(?!\d)/.test(n)) return { family: "gullWing", style: "sot89" }
  if (/(?:^|[_-])SOT-?(?:416|523|723)(?!\d)/.test(n)) return { family: "gullWing", style: "sot523", ...(body ? { body } : {}) }
  if (/(?:^|[_-])(?:SOT-?(?:323|343|353|363|553|563)|SC-?(?:70|82|88))(?!\d)/.test(n)) return { family: "gullWing", style: "sot323", ...(body ? { body } : {}) }
  if (/(?:^|[_-])(?:T?SOT-?23|SOT-?143|SC-?(?:59|74)|SOT-?25|SOT-?26)(?!\d)/.test(n)) return { family: "gullWing", style: "sot23", ...(body ? { body } : {}) }
  if (/(?:^|[_-])(?:TO-?252|DPAK|D-PAK)(?![A-Z0-9])/.test(n)) return { family: "gullWing", style: "to252" }
  if (/(?:^|[_-])(?:TO-?263|D2PAK|D2-PAK)(?![A-Z0-9])/.test(n)) return { family: "gullWing", style: "to263" }

  // Through-hole transistors and regulators. The other TO packages (TO-247, TO-3P, TO-264, the
  // TO-39 can) and a TO-92 or TO-220 lying down are not these bodies and are left to the footprint's rules.
  if (/(?:^|[_-])TO-?92(?!\d)/.test(n)) return /HORIZONTAL/.test(n) ? null : { family: "to92" }
  if (/(?:^|[_-])TO-?220(?!\d)/.test(n) && !/HORIZONTAL/.test(n)) return { family: "to220", isolated: /(?:^|[_-])TO-?220F|FULLPAK|ISOLATED/.test(n) }

  // Dual in-line. A socket for one is a different part, and a surface-mount DIP has no through-hole pins.
  if (/(?:^|[_-])(?:C|S|P)?DIP-?\d+/.test(n) && !/SOCKET|SMD/.test(n)) return { family: "dip" }

  // Leadless (before the leaded rules: `VQFN` and `HTSON` contain a leaded family's letters).
  if (NO_LEAD.test(n)) return { family: "noLead", ...(body ? { body } : {}) }
  if (GRID.test(n)) return { family: "gridPackage", balls: !/(?:^|[_-])[A-Z]{0,2}LGA/.test(n), ...(body ? { body } : {}) }

  const style = gullFamily(n)
  return style ? { family: "gullWing", style, ...(body ? { body } : {}) } : null
}

/**
 * The model a package name settles, or null when the name says nothing this module knows. The
 * name is the footprint's own (`SOT-23-5`, with or without its KiCad library in front).
 */
export function translatePackage(name: string, hints: PartHints = {}): ModelPlan | null {
  const n = clean(name)
  if (!n) return null

  // Chip passives, LEDs and diodes on an imperial or metric code.
  const chip = chipPlan(n, hints)
  if (chip) return chip

  // Diodes in a moulded body.
  const diode = diodeStyle(n)
  if (diode) return { family: "moldedDiode", style: diode, cathodeFirst: true }

  // Vertical 2.54 mm headers and sockets. A horizontal one, a surface-mount one and any other
  // pitch are not what the builders draw.
  const hdr = n.match(/(?:^|[_-])PIN(HEADER|SOCKET)[_-]/)
  if (hdr) return /P2\.54MM/.test(n) && /VERTICAL/.test(n) && !/HORIZONTAL|SMD/.test(n) ? { family: "pinHeader", socket: hdr[1] === "SOCKET" } : null
  // JST's through-hole housings, standing up. The side-entry and surface-mount ones are others.
  const jst = n.match(/^JST_(PH|XH|EH)_/)
  if (jst) return /VERTICAL/.test(n) && !/HORIZONTAL|SMD|SM\d/.test(n) ? { family: "jst", series: jst[1].toLowerCase() as "ph" | "xh" | "eh" } : null

  return icFamily(n)
}
