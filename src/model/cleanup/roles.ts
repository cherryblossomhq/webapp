import { valueText } from "../instances"
import { findPart } from "../library"
import type { ComponentInstance, PartDef } from "../types"

// What each part is to Clean up: whether it can be the main part of a block (a chip, a module, a
// regulator, a connector with a handful of pins) or one of the small parts that serve it, and the
// word a block named after its main part starts with.

/** The fewest pins a connector needs to be drawn about rather than beside another part. */
const CONNECTOR_PINS = 3

/**
 * A part drawn from a KiCad symbol (it keeps its pins of one number apart, `jumpers`) that is a
 * two-pin passive of the kind its designator says: a resistor R, a capacitor C. The editor's own
 * parts are known by their ids, which a brought-in symbol does not have.
 */
const kicadPassive = (part: PartDef | undefined, prefix: string) => !!part?.jumpers && part.category === "Passives" && part.refPrefix === prefix && part.pins.length === 2

/** The editor's resistor, or a resistor brought in from KiCad. */
export const isResistorPart = (part: PartDef | undefined) => part?.id === "resistor" || kicadPassive(part, "R")

/** Whether a part can be the main part of a block. Everything else serves one. */
export function isMainPart(part: PartDef | undefined): boolean {
  if (!part) return false
  // A symbol from KiCad with one pin or none is a flag or a marker (PWR_FLAG), not a chip.
  if (part.jumpers && part.pins.length < 2) return false
  switch (part.category) {
    case "ICs":
    case "Modules":
      return true
    case "Power":
      // A regulator, not a battery or a coin cell.
      return part.pins.length >= CONNECTOR_PINS
    case "Connectors":
      return part.pins.length >= CONNECTOR_PINS
    case "Electromechanical":
      // A relay, not a switch.
      return part.pins.length >= 5
    default:
      return false
  }
}

/** Lower is more of a chip: who gets a part that serves two chips equally. */
export function mainRank(part: PartDef | undefined): number {
  switch (part?.category) {
    case "Power":
      return 0
    case "ICs":
    case "Modules":
      // A regulator brought in as an IC is still a regulator.
      return roleOf(part) === "REGULATOR" ? 0 : 1
    default:
      return 2
  }
}

/** A regulator or a charger: the part that makes or manages a supply, as opposed to one that merely runs on it. */
export const isPowerChip = (part: PartDef | undefined) => mainRank(part) === 0 || roleOf(part) === "CHARGER"

/**
 * A part that sits on a supply without being what runs on it: a connector, or an ESD or surge
 * protector. Where a regulator is on a supply, these do not take its capacitors. A real chip, however
 * small, keeps the capacitor that stands beside it.
 */
export function isHelper(part: PartDef | undefined): boolean {
  if (!part) return false
  return mainRank(part) === 2 || roleOf(part) === "ESD"
}

/** The pins of a regulator, if the name says nothing: an input, an output, ground and a few controls. */
const LDO_PIN = /^(V?IN|V?OUT|VSS|A?GND|EN|CE|NC|TAB|ADJ|BYP|SENSE|PG|PGOOD|NR|SS|EP|PAD|THERMALPAD)\d*$/i
/** A switching regulator's pins: the switch node, an input and feedback. */
const SWITCH_PIN = /^(SW|LX|PH)\d*$/i

/** Whether a chip's pins are those of a regulator (an LDO's, or a switcher's), whatever it is called. */
function pinsOfRegulator(part: PartDef): boolean {
  const names = part.pins.map((p) => p.name.trim())
  const has = (re: RegExp) => names.some((n) => re.test(n))
  if (has(SWITCH_PIN)) return has(/^V?IN\d*$/i) && has(/^(FB|VFB|ADJ|EN|COMP)$/i)
  return part.pins.length <= 8 && has(/^V?IN\d*$/i) && has(/^V?OUT\d*$/i) && names.every((n) => LDO_PIN.test(n))
}

/** The pins of a regulator that carry its switch node, for finding its inductor. */
export const switchPins = (part: PartDef | undefined) => (part?.pins ?? []).filter((p) => SWITCH_PIN.test(p.name.trim()))

export const isLed = (part: PartDef | undefined) =>
  part?.id === "led" || part?.id === "ws2812b" || (!!part?.jumpers && part.category === "Diodes" && part.pins.length === 2 && /led/i.test(`${part.refPrefix} ${part.name}`))

/** Farads in a capacitor's value ("100nF", "4u7", "10 uF"), or null when it isn't one. */
export function capacitance(c: ComponentInstance): number | null {
  const part = findPart(c.partId)
  if (!part || !(/^capacitor/.test(part.id) || kicadPassive(part, "C"))) return null
  const m = valueText(c, part).trim().match(/^(\d+(?:[.,]\d+)?)\s*([pnuµm]?)\s*(\d*)\s*f?$/i)
  if (!m) return null
  const unit = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, "": 1 }[m[2].toLowerCase() as "p" | "n" | "u" | "µ" | "m" | ""]
  // "4u7" is 4.7 uF.
  const number = Number(`${m[1].replace(",", ".")}${m[3] ? `.${m[3]}` : ""}`)
  return Number.isFinite(number) ? number * unit : null
}

export const isCapacitor = (c: ComponentInstance) => /^capacitor/.test(c.partId) || kicadPassive(findPart(c.partId), "C")

/** A capacitor that holds a rail up rather than decouples a pin: electrolytic, tantalum or 4.7 uF and up. */
export function isBulkCap(c: ComponentInstance): boolean {
  const part = findPart(c.partId)
  if (!part || !isCapacitor(c)) return false
  // A capacitor from KiCad says what it is by its value alone.
  if (part.id !== "capacitor" && !kicadPassive(part, "C")) return true
  return (capacitance(c) ?? 0) >= 4.7e-6
}

const MCU = /atmega|attiny|esp32|esp8266|stm32|rp2040|pico|arduino|wemos|xiao|nrf5|samd|pic1|ch32/i
/** Kinds of chip by what they do, matched against the part's id and name. */
const CHIP_ROLES: [RegExp, string][] = [
  [MCU, "MCU"],
  [/load.?switch|power.?switch|tps2[02]\d{2}|sy628\d|mic20\d{2}/i, "LOAD SWITCH"],
  [/ldo|regulator|buck|boost|tps7|tps5|ap2112|ap7361|ams1117|lm78|lm1117|me6211|lp59|mcp1700|xc6206|ld1117/i, "REGULATOR"],
  [/mcp738|tp405|bq2|charger/i, "CHARGER"],
  [/usblc|esd|tvs|prtr|ip4|ecmf/i, "ESD"],
  [/w25q|flash|24c\d|at24|eeprom|fram/i, "MEMORY"],
  [/ads1|ads8|mcp3\d|adc|hx711/i, "ADC"],
  [/bme|bmp|lsm|mpu|icm|sht\d|aht|sensor|accel|gyro/i, "SENSOR"],
  [/ch340|ft232|cp210|usb-uart|usb.?serial/i, "USB-UART"],
  [/tb66|uln200|drv8|l298|l293|a4988|motor/i, "DRIVER"],
  [/595|shift/i, "SHIFT REGISTER"],
  [/lm358|op-amp|opamp|tl07|mcp600/i, "OP-AMP"],
  [/ne555|555|timer/i, "TIMER"],
  [/pc817|opto/i, "OPTOCOUPLER"],
  [/oled|lcd|display|ssd13/i, "DISPLAY"],
]

/** The first word of a block named after this main part: REGULATOR, MCU, CONNECTOR... */
export function roleOf(part: PartDef | undefined): string {
  if (!part) return "PART"
  const text = `${part.id} ${part.name}`
  switch (part.category) {
    case "Power":
      return part.pins.length >= CONNECTOR_PINS ? "REGULATOR" : "BATTERY"
    case "Connectors":
      if (/^usb|usb_c|micro_usb/.test(part.id)) return "USB"
      if (/barrel/.test(part.id)) return "POWER JACK"
      if (/microsd/.test(part.id)) return "SD CARD"
      if (/^socket_/.test(part.id)) return "SOCKET"
      return "CONNECTOR"
    case "Electromechanical":
      return /relay/i.test(text) ? "RELAY" : "SWITCH"
    case "Diodes":
      return isLed(part) ? "LED" : "DIODE"
    case "Modules":
    case "ICs":
      return CHIP_ROLES.find(([re]) => re.test(text))?.[1] ?? (part.category === "ICs" && pinsOfRegulator(part) ? "REGULATOR" : part.category === "Modules" ? "MODULE" : "IC")
    default:
      return part.name.toUpperCase()
  }
}
