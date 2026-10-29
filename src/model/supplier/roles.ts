import type { PartPinRole } from "@cherryblossom/api-contract"

// What a pin is for, read from its name. Shared by the website's parts API (which labels a
// supplier's pins) and the copilot's checks (which compare a pin map against them), so the two
// can't disagree about what "VIN" means.
//
// The rules are deliberately narrow. A role is a claim the comparison acts on: a supply pin drawn
// where the supplier has ground refuses the part. Every name these patterns miss is a `signal`,
// which claims nothing, so a pattern too wide costs a false refusal and one too narrow only a
// weaker check.

/**
 * Two spellings of one pin, reduced to one word: `UD+`, `UD_P` and `ud+` are one name, `UD+` and
 * `UD-` are two. The sign is mapped rather than stripped, because on a differential pair it is
 * the whole difference between the pins.
 */
export function canonicalPin(name: string): string {
  let s = String(name ?? "").toUpperCase().trim()
  s = s.replace(/\+/g, "P").replace(/(?<=.)-$/g, "N").replace(/^-$/, "N")
  s = s.replace(/[^A-Z0-9]/g, "")
  return SYNONYMS.get(s) ?? s
}

/**
 * Spellings that mean the same pin. Small on purpose: every entry is a pair the comparison would
 * otherwise call a different name, and over-normalising hides real errors.
 */
const SYNONYMS = new Map(
  Object.entries({
    GROUND: "GND",
    VSS: "GND",
    DGND: "GND",
    AGND: "GND",
    PGND: "GND",
    SGND: "GND",
    GNDA: "GND",
    GNDD: "GND",
    EPAD: "EP",
    PAD: "EP",
    THERMALPAD: "EP",
    EXPOSEDPAD: "EP",
    TAB: "EP",
    NOCONNECT: "NC",
    NOTCONNECTED: "NC",
    DNC: "NC",
    TX: "TXD",
    RX: "RXD",
    DP: "UDP",
    DPLUS: "UDP",
    USBDP: "UDP",
    DN: "UDN",
    DM: "UDN",
    DMINUS: "UDN",
    USBDM: "UDN",
    RFIN: "IN",
    RFOUT: "OUT",
    ANODE: "A",
    CATHODE: "K",
  }),
)

const GROUND = /^(GND|AGND|DGND|PGND|SGND|VSSA|VSSD|VSSIO|CMIP|CMOP|0V)\d*$/
const EXPOSED = /^EP\d*$/
const NO_CONNECT = /^NC\d*$/
const POWER_OUT = /^(VOUT|VO|VREGOUT|VDDOUT|VCCOUT|VOUTA|VOUTB)\d*$/
const POWER_IN =
  /^(VIN|VI|VCC|VCCA|VCCIO|VCCQ|VDD|VDDA|VDDD|VDDIO|VDDQ|VDDCORE|AVDD|DVDD|AVCC|DVCC|IOVDD|VS|VSUP|VSUPPLY|VBUS|VBAT|VBATT|VPP|VMOT|VPSI|VPSO|VPOS|VNEG|VEE|VP|VN|3V3|5V|1V8|12V)\d*$/

/**
 * The role a pin's name declares. Names are canonical first, so `VDD_IO`, `VddIO` and `VDDIO`
 * agree. `CMIP` and `CMOP` are ground: Analog Devices' "common" pins (the AD8318's). Plain `COM`
 * is not, because a Darlington array's `COM` is the flyback common on the motor supply. Nor is
 * `VM`: a motor driver's supply, but a battery protector's (DW01A) voltage-monitor input.
 */
export function pinRole(name: string): PartPinRole {
  const n = canonicalPin(name)
  if (EXPOSED.test(n)) return "exposed_pad"
  if (GROUND.test(n)) return "ground"
  if (NO_CONNECT.test(n)) return "nc"
  if (POWER_OUT.test(n)) return "power_out"
  if (POWER_IN.test(n)) return "power_in"
  return "signal"
}

/**
 * Whether a name could be read as `role`, generously: `VDD_3V3` and `AVDD1V8` could be supplies,
 * `GNDPWR` and `E` (a Darlington array's emitters) could be ground. Used only to stop a strict
 * reading of one side from refusing a pin the other side spells unusually.
 */
export function couldBe(role: PartPinRole, name: string): boolean {
  const n = canonicalPin(name)
  if (pinRole(name) === role) return true
  switch (role) {
    case "ground":
      return /GND|VSS|^COM|^E$|^EP/.test(n)
    case "power_in":
      // A regulator's drawing may spell its supply `INPUT` or `IN`.
      return /^V.*(DD|CC|IN|BAT|BUS|SUP|PS|S$)|^[0-9]+V[0-9]*$|^VCC|^VDD|^AVDD|^DVDD|^BAT|^IN(PUT)?$/.test(n)
    case "power_out":
      return /^V.*OUT|^VO|^OUT(PUT)?$|^BAT/.test(n)
    case "exposed_pad":
      return /^EP|GND|VSS|PAD/.test(n)
    default:
      return false
  }
}

/** A role that carries current for the whole part: getting one wrong is a dead board, not a typo. */
export const isRail = (role: PartPinRole) => role === "ground" || role === "power_in" || role === "power_out"

/** A pin whose name is its number (`1`, `2`...) says nothing about what it is. */
export const isPlaceholderName = (name: string, number: string) => !name.trim() || name.trim() === number.trim() || /^\d+$/.test(name.trim())

/** How a role reads in a sentence. */
export const ROLE_WORDS: Record<PartPinRole, string> = {
  power_in: "a supply input",
  power_out: "a supply output",
  ground: "ground",
  exposed_pad: "the exposed pad",
  nc: "not connected",
  signal: "a signal",
}

/** The editor's pin kind for a supplier role, which places the pin on a box symbol. */
export function kindForRole(role: PartPinRole): "power" | "ground" | "output" | "nc" | undefined {
  if (role === "power_in") return "power"
  if (role === "ground" || role === "exposed_pad") return "ground"
  if (role === "power_out") return "output"
  if (role === "nc") return "nc"
  return undefined
}
