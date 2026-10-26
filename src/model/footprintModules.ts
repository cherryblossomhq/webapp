import { round } from "../lib/geometry"
import { box, circle, dualRow, footprint, line, rect, smd } from "./footprintKit"
import type { FootprintDef, PadDef, Vec2 } from "./types"

// Development boards and RF modules. Pad positions follow the parts' published land patterns;
// header holes are 1.0 mm for 0.64 mm square pins. Pin 1 is at the top left (+y, -x) and the
// pins count down the left side, then up the right, like a DIP.

/** Small dot beside pin 1, outside the outline. */
const pin1Dot = (x: number, y: number) => circle(x, y, 0.15, 8)

/**
 * Arduino Nano: two rows of 15 on 2.54 mm, 15.24 mm apart, on an 18 x 43 mm board. Pin 1 is
 * D1/TX at the end away from the mini-USB socket, which overhangs the -y edge.
 */
function arduinoNano(): FootprintDef {
  const pads = dualRow({ n: 15, rowX: 7.62, pitch: 2.54, size: 1.7, drill: 1 })
  const usb: Vec2[] = [
    { x: -3.85, y: -21.59 },
    { x: -3.85, y: -23.5 },
    { x: 3.85, y: -23.5 },
    { x: 3.85, y: -21.59 },
  ]
  return footprint("arduino_nano", pads, [rect(-8.89, -21.59, 8.89, 21.59), usb, pin1Dot(-9.6, 17.78)], box(-9.14, -23.75, 9.14, 21.84))
}

/**
 * Raspberry Pi Pico, soldered flat by its 40 castellated edges (3.2 x 1.6 mm pads straddling the
 * 21 x 51 mm board edge) plus the three debug pads at the far end. Micro-USB at the pin 1 end, +y.
 */
function raspberryPiPico(): FootprintDef {
  const pads: PadDef[] = []
  for (let i = 0; i < 20; i++) {
    const y = round(24.13 - i * 2.54)
    pads.push(smd(String(i + 1), -9.69, y, 3.2, 1.6))
    pads.push(smd(String(40 - i), 9.69, y, 3.2, 1.6))
  }
  pads.push(smd("D1", -2.54, -24.7, 1.6, 3.2), smd("D2", 0, -24.7, 1.6, 3.2), smd("D3", 2.54, -24.7, 1.6, 3.2))
  const usb: Vec2[] = [
    { x: -4, y: 21.1 },
    { x: -4, y: 26.8 },
    { x: 4, y: 26.8 },
    { x: 4, y: 21.1 },
    { x: -4, y: 21.1 },
  ]
  return footprint("rpi_pico", pads, [rect(-10.5, -25.5, 10.5, 25.5), usb, pin1Dot(-11.85, 24.13)], box(-11.55, -26.55, 11.55, 27.05))
}

/** Pads of a castellated RF module: a column down each side and a row across the end, plus ground pads. */
interface ModulePads {
  /** Pads per side column, x of the columns and the y of the first (top) pad. */
  side: number
  sideX: number
  topY: number
  /** Pads across the bottom end and their y. */
  end: number
  endY: number
  pitch: number
  /** Pad size along x for the side columns (across the edge), and across it. */
  long: number
  short: number
}

function modulePads(m: ModulePads): PadDef[] {
  const pads: PadDef[] = []
  let n = 1
  for (let i = 0; i < m.side; i++) pads.push(smd(String(n++), -m.sideX, m.topY - i * m.pitch, m.long, m.short))
  for (let i = 0; i < m.end; i++) pads.push(smd(String(n++), (i - (m.end - 1) / 2) * m.pitch, m.endY, m.short, m.long))
  for (let i = 0; i < m.side; i++) pads.push(smd(String(n++), m.sideX, m.topY - (m.side - 1 - i) * m.pitch, m.long, m.short))
  return pads
}

/** Outline of an 18 mm wide module with the antenna end at the top, open where pads cross it. */
function moduleSilk(top: number, bottom: number, antenna: number): Vec2[][] {
  return [
    rect(-9, bottom, 9, top),
    // Antenna keep-out: a line across the module where the copper-free area starts.
    line(-9, antenna, 9, antenna),
  ]
}

/**
 * ESP32-WROOM-32E, 18 x 25.5 mm: 14 pads down each side and 10 across the end on 1.27 mm, and a
 * 5 x 5 mm ground pad (39). The PCB antenna end is at the top (+y), above pin 1.
 */
function esp32Wroom32e(): FootprintDef {
  const pads = modulePads({ side: 14, sideX: 8.5, topY: 8.255, end: 10, endY: -9.255, pitch: 1.27, long: 2, short: 0.9 })
  pads.push(smd("39", -1, 0.755, 5, 5))
  return footprint("esp32_wroom_32e", pads, moduleSilk(15.745, -9.755, 9.5), box(-9.75, -10.5, 9.75, 16))
}

/**
 * ESP32-S3-WROOM-1, 18 x 25.5 mm: 14 pads down each side and 12 across the end on 1.27 mm, and
 * the ground pad split into a 3 x 3 grid (41-49) for even paste. Antenna end at the top (+y).
 */
function esp32S3Wroom1(): FootprintDef {
  const pads = modulePads({ side: 14, sideX: 8.75, topY: 5.26, end: 12, endY: -12.5, pitch: 1.27, long: 1.5, short: 0.9 })
  const grid: [number, number][] = [
    [-1.5, -2.46],
    [-2.9, -1.06],
    [-2.9, -2.46],
    [-2.9, -3.86],
    [-1.5, -3.86],
    [-0.1, -3.86],
    [-0.1, -2.46],
    [-0.1, -1.06],
    [-1.5, -1.06],
  ]
  grid.forEach(([x, y], i) => pads.push(smd(String(41 + i), x, y, 0.9, 0.9)))
  return footprint("esp32_s3_wroom_1", pads, moduleSilk(12.75, -12.75, 6.4), box(-9.75, -13.5, 9.75, 13))
}

/**
 * Espressif ESP32-DevKitC: two 1x19 headers 25.4 mm apart on a 27.9 x 48.2 mm carrier. The
 * WROOM module's antenna overhangs the pin 1 end (+y); the micro-USB socket is at the other end.
 */
function esp32DevkitC(): FootprintDef {
  const pads = dualRow({ n: 19, rowX: 12.7, pitch: 2.54, size: 1.7, drill: 1 })
  const antenna: Vec2[] = [
    { x: -9, y: 24.1 },
    { x: -9, y: 30.3 },
    { x: 9, y: 30.3 },
    { x: 9, y: 24.1 },
  ]
  const usb: Vec2[] = [
    { x: -4.07, y: -24.1 },
    { x: -4.07, y: -25 },
    { x: 4.07, y: -25 },
    { x: 4.07, y: -24.1 },
  ]
  return footprint("esp32_devkitc", pads, [rect(-13.95, -24.1, 13.95, 24.1), antenna, usb, pin1Dot(-14.6, 22.86)], box(-14.2, -25.25, 14.2, 30.55))
}

/**
 * Wemos D1 Mini (ESP8266): two rows of 8 on 2.54 mm, 22.86 mm apart, on a 25.4 x 34.3 mm board.
 * Pin 1 is RST at the antenna end (+y); the USB socket is at the -y end.
 */
function wemosD1Mini(): FootprintDef {
  const pads = dualRow({ n: 8, rowX: 11.43, pitch: 2.54, size: 1.7, drill: 1, topY: 9.525 })
  const usb: Vec2[] = [
    { x: -5.08, y: -17.145 },
    { x: -5.08, y: -15.62 },
    { x: 3.81, y: -15.62 },
    { x: 3.81, y: -17.145 },
  ]
  return footprint("wemos_d1_mini", pads, [rect(-12.7, -17.145, 12.7, 17.145), usb, pin1Dot(-13.3, 9.525)], box(-12.95, -17.4, 12.95, 17.4))
}

/**
 * Seeed Studio XIAO ESP32-C3: two rows of 7 on 2.54 mm, 15.24 mm apart, on a 17.8 x 21 mm board,
 * with oblong pads so it can go on headers or be soldered flat. USB-C at the pin 1 end (+y).
 */
function xiaoEsp32c3(): FootprintDef {
  const pads = dualRow({ n: 7, rowX: 7.62, pitch: 2.54, size: 1.8, drill: 1.1 }).map((p) => ({
    ...p,
    shape: p.pin === "1" ? ("rect" as const) : ("pill" as const),
    width: 3,
  }))
  const usb: Vec2[] = [
    { x: -4.5, y: 10.5 },
    { x: -4.5, y: 11.7 },
    { x: 4.5, y: 11.7 },
    { x: 4.5, y: 10.5 },
  ]
  return footprint("xiao_esp32c3", pads, [rect(-8.9, -10.5, 8.9, 10.5), usb, pin1Dot(-9.6, 9.6)], box(-9.4, -10.75, 9.4, 11.95))
}

export const MODULE_FOOTPRINTS: Record<string, () => FootprintDef> = {
  arduino_nano: arduinoNano,
  rpi_pico: raspberryPiPico,
  esp32_wroom_32e: esp32Wroom32e,
  esp32_s3_wroom_1: esp32S3Wroom1,
  esp32_devkitc: esp32DevkitC,
  wemos_d1_mini: wemosD1Mini,
  xiao_esp32c3: xiaoEsp32c3,
}
