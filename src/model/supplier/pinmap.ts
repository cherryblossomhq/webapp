import type { PartPinRole, SupplierPin } from "@cherryblossom/api-contract"
import { canonicalPin, couldBe, isPlaceholderName, isRail, pinRole, ROLE_WORDS } from "./roles"

// Is pin 3 the pin the supplier calls pin 3?
//
// Names alone can't say. `T1OUT` and `DOUT1` are one pin, and a ULN2003A's supplier drawing
// calls its inputs `1B` to `7B` where a datasheet table says `IN1` to `IN7`: a check on spelling
// fires on every correct part. So a pin is refused for its ROLE, and for a name the supplier
// uses on a different pin:
//
// - A supply or ground pin of the real part drawn as anything else (TPS61023: `VIN` drawn on the
//   supplier's `VOUT`, `FB` on its `GND`; AD8318: `VPSI` on its common, ground, pins).
// - A pin drawn as supply or ground where the supplier has a named signal (LFCN-1700+: the RF
//   output on a ground pad).
// - A name the supplier uses on exactly one other pin (`IN1` drawn on pin 2 when the supplier puts
//   `IN1` on pin 3): two of those, or one that is a supply, is a map shifted or mirrored.
// - A pin number the part doesn't have.
//
// Everything else that differs is a spelling, reported so the copilot uses the supplier's names.

export interface DrawnPin {
  number: string
  name: string
}

export interface PinFinding {
  number: string
  drawn: string
  /** The supplier's name for this pin number, or "" when it has none. */
  vendor: string
  text: string
}

export interface PinComparison {
  /** `agrees`: same names. `renamed`: names differ, nothing contradicts. `contradicted`: refuse. */
  verdict: "agrees" | "renamed" | "contradicted"
  fatal: PinFinding[]
  renamed: PinFinding[]
  /** Supplier pins the drawing leaves out. */
  missing: SupplierPin[]
  /** Pins named the same (or as an alias) as the supplier's, of `comparable`. */
  matched: number
  comparable: number
  /**
   * A two-pin polarized part numbered the other way round from the supplier (anode 1 here,
   * cathode 1 there). Not an error when the part takes the supplier's land, whose numbering it is.
   */
  polaritySwapped: boolean
}

const POLARITY: Record<string, "A" | "K"> = { A: "A", K: "K", C: "K", P: "A", N: "K", "1": "A", "2": "K" }

/** For a two-pin part named only by polarity, which end each number is. */
function polarityOf(pins: { number: string; name: string }[]): Map<string, "A" | "K"> | null {
  if (pins.length !== 2) return null
  const out = new Map<string, "A" | "K">()
  for (const p of pins) {
    const c = canonicalPin(p.name)
    if (c === p.number) return null
    const end = POLARITY[c]
    if (!end) return null
    out.set(p.number, end)
  }
  return new Set(out.values()).size === 2 ? out : null
}

/** Strip a trailing index added to make repeated names unique (`GND2`, `COMM6`). */
const base = (c: string) => c.replace(/(?<=[A-Z])\d+$/, "")

export function comparePins(drawn: DrawnPin[], vendor: SupplierPin[]): PinComparison {
  const byNumber = new Map(vendor.map((p) => [p.number, p]))
  const exposed = vendor.filter((p) => p.role === "exposed_pad")
  const fatal: PinFinding[] = []
  const renamed: PinFinding[] = []
  let matched = 0
  let comparable = 0

  // Two-pin polarized parts: a numbering convention, not a pin map.
  const dPol = polarityOf(drawn)
  const vPol = polarityOf(vendor)
  if (dPol && vPol) {
    const swapped = [...dPol].some(([n, end]) => vPol.get(n) && vPol.get(n) !== end)
    const missing = vendor.filter((p) => !dPol.has(p.number))
    return { verdict: swapped ? "renamed" : "agrees", fatal, renamed, missing, matched: swapped ? 0 : 2, comparable: 2, polaritySwapped: swapped }
  }

  // Where the supplier puts each of its names, for names on exactly one pin.
  const seenAt = new Map<string, Set<string>>()
  for (const p of vendor) {
    for (const spelling of [p.name, ...p.aliases]) {
      const key = canonicalPin(spelling)
      seenAt.set(key, (seenAt.get(key) ?? new Set()).add(p.number))
    }
  }
  const uniqueAt = new Map([...seenAt].filter(([, at]) => at.size === 1).map(([k, at]) => [k, [...at][0]]))
  const displaced: PinFinding[] = []
  const drawnNumbers = new Set<string>()

  for (const d of drawn) {
    // An exposed pad given a name for a number (`EP`) is the supplier's exposed pad.
    let truth = byNumber.get(d.number)
    if (!truth && exposed.length === 1 && canonicalPin(d.number) === "EP") truth = exposed[0]
    drawnNumbers.add(truth?.number ?? d.number)
    if (!truth) {
      fatal.push({
        number: d.number,
        drawn: d.name,
        vendor: "",
        text: `pin ${d.number} (${d.name}) doesn't exist: the supplier's part has ${vendor.length} pins, numbered ${numberRange(vendor)}`,
      })
      continue
    }
    if (isPlaceholderName(d.name, d.number)) continue
    comparable++
    const drawnC = canonicalPin(d.name)
    const spellings = [truth.name, ...truth.aliases]
    const accepted = spellings.map(canonicalPin)
    // `GND2` is the supplier's `GND`; `AIN0` is not its `AIN1`.
    if (accepted.includes(drawnC) || accepted.includes(base(drawnC))) {
      matched++
      continue
    }
    const vendorRoles = new Set<PartPinRole>([truth.role, ...truth.aliases.map(pinRole)])
    const dRole = pinRole(d.name)
    const finding = { number: truth.number, drawn: d.name, vendor: truth.name }
    const vRail = [...vendorRoles].find(isRail)
    const compatible = (a: PartPinRole, b: PartPinRole) => a === b || (a === "exposed_pad" && b === "ground") || (a === "ground" && b === "exposed_pad")
    if (vRail && !compatible(dRole, vRail) && !couldBe(vRail, d.name)) {
      fatal.push({ ...finding, text: `pin ${truth.number} is ${truth.name} (${ROLE_WORDS[vRail]}), drawn as ${d.name} (${ROLE_WORDS[dRole]})` })
      continue
    }
    if (isRail(dRole) && !vRail && truth.role !== "exposed_pad" && truth.role !== "nc" && truth.name.length > 1 && !spellings.some((s) => couldBe(dRole, s))) {
      fatal.push({ ...finding, text: `pin ${truth.number} is ${truth.name} (${ROLE_WORDS[truth.role]}), drawn as ${d.name} (${ROLE_WORDS[dRole]})` })
      continue
    }
    const elsewhere = uniqueAt.get(drawnC) ?? uniqueAt.get(base(drawnC))
    if (elsewhere && elsewhere !== truth.number) {
      displaced.push({ ...finding, text: `pin ${truth.number} is ${truth.name}, drawn as ${d.name}, which the supplier puts on pin ${elsewhere}` })
      continue
    }
    renamed.push({ ...finding, text: `pin ${truth.number} is ${truth.name}, drawn as ${d.name}` })
  }

  // One displaced signal is more likely two names for one function; two, or a displaced rail, is
  // a map in the wrong order.
  const railDisplaced = displaced.some((f) => isRail(pinRole(f.drawn)))
  if (displaced.length >= 2 || railDisplaced) fatal.push(...displaced)
  else renamed.push(...displaced)

  const missing = vendor.filter((p) => !drawnNumbers.has(p.number))
  const verdict = fatal.length ? "contradicted" : renamed.length ? "renamed" : "agrees"
  return { verdict, fatal, renamed, missing, matched, comparable, polaritySwapped: false }
}

/** `1-16, 17` for a 17-pin part, or the list when it isn't a run. */
export function numberRange(pins: { number: string }[]): string {
  const nums = pins.map((p) => p.number)
  const ints = nums.map(Number)
  if (ints.every((n) => Number.isInteger(n))) {
    const sorted = [...ints].sort((a, b) => a - b)
    if (sorted.every((n, i) => n === sorted[0] + i)) return `${sorted[0]}-${sorted[sorted.length - 1]}`
  }
  return nums.slice(0, 12).join(", ") + (nums.length > 12 ? ", ..." : "")
}

/** A pin list as the copilot reads one: `1:FB 2:EN 3:VIN(supply in) 4:GND(ground)`. */
export function pinMapText(pins: SupplierPin[]): string {
  const tag: Partial<Record<PartPinRole, string>> = {
    power_in: "supply in",
    power_out: "supply out",
    ground: "ground",
    exposed_pad: "exposed pad",
    nc: "nc",
  }
  return pins.map((p) => `${p.number}:${p.name}${tag[p.role] ? `(${tag[p.role]})` : ""}`).join(" ")
}
