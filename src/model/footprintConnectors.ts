import { box, circle, clearOfPads, footprint, line, npth, rect, slot, smd, tht } from "./footprintKit"
import type { FootprintDef, PadDef, Vec2 } from "./types"

// Connectors and other electromechanical parts. Connectors face -y: wire entries, plug openings and
// card slots are on the -y side of the body, so a part at the board's bottom edge needs no turning.
// Edge connectors' courtyards stop at the face that sits on the board edge, so they can go flush.

/** x of pin i of n on a row centred on the origin. */
const rowX = (i: number, n: number, pitch: number) => (i - (n - 1) / 2) * pitch

interface TerminalBlockSpec {
  name: string
  n: number
  pitch: number
  pad: number
  drill: number
  /** Body edges from the pin row: the wire-entry face (negative) and the back. */
  front: number
  back: number
  /** y of the two lines marking the wire-entry openings. */
  entries: [number, number]
  /** Radius of the circle drawn round each screw head. */
  screw: number
}

/**
 * Horizontal screw terminal block. Pins on y = 0, centred, pin 1 square at -x. Each screw head is
 * a circle crossed by its slot where clear of the pad, and a corner mark sits by pin 1.
 */
export function terminalBlock(s: TerminalBlockSpec): FootprintDef {
  const pads = Array.from({ length: s.n }, (_, i) => tht(String(i + 1), rowX(i, s.n, s.pitch), 0, s.pad, s.drill, i === 0))
  const half = (s.n * s.pitch) / 2 + 0.06
  const slotW = 0.172
  const reach = Math.sqrt((s.screw - 0.02) ** 2 - slotW ** 2) / Math.SQRT2
  const off = slotW / Math.SQRT2
  const screws = pads.flatMap((p) => [
    circle(p.x, 0, s.screw, 36),
    ...clearOfPads(
      [-1, 1].map((k) => line(p.x - reach - k * off, -reach + k * off, p.x + reach - k * off, reach + k * off)),
      [p],
    ),
  ])
  return {
    name: s.name,
    pads,
    silk: [
      rect(-half, s.front, half, s.back),
      ...s.entries.map((y) => line(-half, y, half, y)),
      ...screws,
      [{ x: -half - 0.24, y: s.front + 0.4 }, { x: -half - 0.24, y: s.front - 0.24 }, { x: -half + 0.16, y: s.front - 0.24 }],
    ],
    courtyard: box(-half - 0.44, s.front - 0.44, half + 0.44, s.back + 0.44),
  }
}

/**
 * Phoenix PT 1,5/n-5,0-H style, 5.0 mm pitch. Pads match the footprinter's
 * pinrow{n}_p5mm_id1.3mm_od2.6mm; the body runs 4.06 mm behind the pins and 5.06 mm in front.
 */
export const terminalBlock5mm = (n: number) =>
  terminalBlock({ name: `terminal_block_5mm_${n}`, n, pitch: 5, pad: 2.6, drill: 1.3, front: -5.06, back: 4.06, entries: [-3.5, -4.6], screw: 2.18 })

/** Phoenix MKDS 1,5/n-5,08: 5.08 mm pitch, 1.3 mm holes, 9.8 mm deep with the pins 4.6 mm from the entry face. */
const terminalBlock508 = (n: number) =>
  terminalBlock({ name: `terminal_block_5.08mm_${n}`, n, pitch: 5.08, pad: 2.3, drill: 1.3, front: -4.6, back: 5.2, entries: [-2.6, -4.1], screw: 2.0 })

/** Phoenix PT 1,5/n-3,5-H: 3.5 mm pitch, 1.2 mm holes, 7.6 mm deep. */
const terminalBlock35 = (n: number) =>
  terminalBlock({ name: `terminal_block_3.5mm_${n}`, n, pitch: 3.5, pad: 1.8, drill: 1.2, front: -4.5, back: 3.1, entries: [-3.0, -3.9], screw: 1.4 })

/**
 * Right-angle pluggable header (Phoenix MC / MSTBA): pins at the back of a shroud that opens to
 * the front (-y), where the screw plug goes in. Pin 1 square at -x, a notch marks its end.
 */
function pluggableHeader(name: string, n: number, pitch: number, pad: number, drill: number, front: number, back: number, overhang: number): FootprintDef {
  const pads = Array.from({ length: n }, (_, i) => tht(String(i + 1), rowX(i, n, pitch), 0, pad, drill, i === 0))
  const half = ((n - 1) * pitch) / 2 + overhang
  const lip = front + 1.2
  return footprint(
    name,
    pads,
    [
      rect(-half, front, half, back),
      // The shroud's mouth, and the ribs between positions inside it.
      line(-half + 0.5, lip, half - 0.5, lip),
      ...pads.slice(1).map((p) => line(p.x - pitch / 2, front, p.x - pitch / 2, lip)),
      [{ x: -half - 0.3, y: back - 0.6 }, { x: -half - 0.3, y: back + 0.3 }, { x: -half + 0.6, y: back + 0.3 }],
    ],
    box(-half - 0.6, front - 0.4, half + 0.4, back + 0.6),
  )
}

/** Phoenix MC 1,5/n-G-3,81: 3.81 mm pitch, 1.2 mm holes, the shroud 8 mm deep. */
const mcHeader = (n: number) => pluggableHeader(`phoenix_mc_3.81mm_${n}`, n, 3.81, 2, 1.2, -8, 1.3, 2.6)

/** Phoenix MSTBA 2,5/n-G-5,08: 5.08 mm pitch, 1.4 mm holes, the shroud 12 mm deep. */
const mstbaHeader = (n: number) => pluggableHeader(`phoenix_mstba_5.08mm_${n}`, n, 5.08, 2.1, 1.4, -10, 2, 3.54)

/**
 * USB Type-C receptacle, USB 2.0, 16 contacts (GCT USB4105-GF-A): a row of signal pads at the
 * back, four plated shell slots and two locating pegs. The plug opening is the -y face.
 * Contacts paired on one pad keep the A-side name (A1 carries B12, A4 carries B9...).
 */
function usbC16(): FootprintDef {
  const signal: [string, number, number][] = [
    ["A1", -3.2, 0.6],
    ["A4", -2.4, 0.6],
    ["B8", -1.75, 0.3],
    ["A5", -1.25, 0.3],
    ["B7", -0.75, 0.3],
    ["A6", -0.25, 0.3],
    ["A7", 0.25, 0.3],
    ["B6", 0.75, 0.3],
    ["A8", 1.25, 0.3],
    ["B5", 1.75, 0.3],
    ["B4", 2.4, 0.6],
    ["B1", 3.2, 0.6],
  ]
  const pads: PadDef[] = [
    ...signal.map(([pin, x, w]) => smd(pin, x, 4.755, w, 1.15)),
    slot("S1", -4.32, 4.18, 1, 2.1, 0.6, 1.7),
    slot("S2", 4.32, 4.18, 1, 2.1, 0.6, 1.7),
    slot("S3", -4.32, 0, 1, 1.8, 0.6, 1.4),
    slot("S4", 4.32, 0, 1, 1.8, 0.6, 1.4),
    npth(-2.89, 3.68, 0.65),
    npth(2.89, 3.68, 0.65),
  ]
  return footprint("usb_c_16p", pads, [rect(-4.47, -2.6, 4.47, 4.75)], box(-5.07, -2.6, 5.07, 5.58))
}

/**
 * Micro-USB B receptacle (Amphenol 10118192-0001LF): five 0.65 mm pitch signal pads at the back
 * and six shell pads. The shell overhangs the board edge by 1.3 mm at the -y face.
 */
function microUsbB(): FootprintDef {
  const pads: PadDef[] = [
    ...[1, 2, 3, 4, 5].map((n) => smd(String(n), (n - 3) * 0.65, 0, 0.4, 1.35)),
    smd("S1", -3.1, -0.125, 2.1, 1.6),
    smd("S2", 3.1, -0.125, 2.1, 1.6),
    smd("S3", -3.8, -2.675, 1.8, 1.9),
    smd("S4", -1.2, -2.675, 1.9, 1.9),
    smd("S5", 1.2, -2.675, 1.9, 1.9),
    smd("S6", 3.8, -2.675, 1.8, 1.9),
  ]
  return footprint("micro_usb_b", pads, [rect(-3.75, -5.44, 3.75, 0.23), line(-3.75, -4.13, 3.75, -4.13)], box(-4.95, -4.13, 4.95, 0.95))
}

/**
 * JST SH 1.0 mm 4-pin side-entry header (SM04B-SRSS-TB), the Qwiic / STEMMA QT connector: contacts
 * at the back, the two mounting tabs (5, 6) beside the cable opening at -y.
 */
function qwiicSh4(): FootprintDef {
  const pads = [
    ...[0, 1, 2, 3].map((i) => smd(String(i + 1), rowX(i, 4, 1), 2, 0.6, 1.55)),
    smd("5", -2.8, -1.875, 1.2, 1.8),
    smd("6", 2.8, -1.875, 1.2, 1.8),
  ]
  return footprint("qwiic_jst_sh_4", pads, [rect(-3, -2.7, 3, 1.2)], box(-3.65, -2.9, 3.65, 3.05))
}

/**
 * 5.5 x 2.1 mm DC barrel jack (CUI PJ-002AH), through-hole with slotted lugs: centre pin (1) at
 * the back, sleeve (2) in the middle and the switch lug (3) on the side. The plug goes in at -y.
 */
function barrelJack(): FootprintDef {
  const pads = [
    slot("1", 0, 6.5, 5, 2.5, 1, 3.5),
    slot("2", 0, 0.5, 4.5, 2.25, 1, 3),
    slot("3", 4.7, 3.5, 2.25, 4.5, 1, 3),
  ]
  return footprint("barrel_jack_pj002a", pads, [rect(-4.5, -7.2, 4.5, 7.2)], box(-4.75, -7.2, 6.1, 7.95))
}

/**
 * microSD push-push socket with card detect (Hirose DM3AT-SF-PEJM5): eight contacts at the back,
 * the detect switch (9, 10) and four shell tabs. The card goes in at -y.
 */
function microSd(): FootprintDef {
  const pads: PadDef[] = [
    ...[3.2, 2.1, 1.0, -0.1, -1.2, -2.3, -3.4, -4.5].map((x, i) => smd(String(i + 1), x, 0, 0.7, 1.2)),
    smd("9", -6.4, -10.5, 1, 0.8),
    smd("10", -5.45, 0, 0.7, 1.2),
    smd("11", -6.4, -4.3, 1, 1.2),
    smd("12", -6.4, -14.65, 1, 2.8),
    smd("13", 7.1, -15.1, 1.3, 1.9),
    smd("14", 4.75, 0, 1, 1.2),
  ]
  return footprint("microsd_dm3at", pads, [rect(-5.9, -15.7, 7.35, 0.9)], box(-7.15, -15.7, 8, 1.15))
}

/**
 * CR2032 coin cell retainer: a 13 mm round negative pad under the cell and two positive tabs
 * either side (pads 1 and 3, the same pin).
 */
function coinCell2032(): FootprintDef {
  const pads: PadDef[] = [
    smd("1", -13, 0, 6, 6),
    { ...smd("2", 0, 0, 13, 13), shape: "circle" },
    smd("3", 13, 0, 6, 6),
  ]
  return footprint("cr2032_holder", pads, [circle(0, 0, 10.4, 48), line(-15.5, 3.6, -14.5, 3.6), line(-15, 3.1, -15, 4.1)], box(-16.25, -10.65, 16.25, 10.65))
}

/**
 * Songle SRD-05VDC-SL-C sugar-cube relay, 19.9 x 15.5 mm: coil A1 / A2, common next to the coil,
 * normally open and normally closed at the far end.
 */
function relaySrd(): FootprintDef {
  const pads = [
    tht("1", -6.1, 6, 1.98, 1.32, true),
    tht("2", -6.1, -6, 1.98, 1.32),
    tht("3", -8.1, 0, 1.98, 1.32),
    tht("4", 6.1, -6, 1.98, 1.32),
    tht("5", 6.1, 6, 1.98, 1.32),
  ]
  // Coil and contact symbol on the lid, as on the part.
  const coil: Vec2[] = rect(-4.6, -1.6, -1.6, 1.6)
  const contact: Vec2[] = [
    { x: 1.2, y: 0 },
    { x: 3.6, y: 1.8 },
  ]
  return footprint("relay_srd", pads, [rect(-10.3, -7.75, 9.55, 7.75), coil, line(-3.1, -1.6, -3.1, -4.4), line(-3.1, 1.6, -3.1, 4.4), contact], box(-10.55, -8, 9.8, 8))
}

/** 12 mm through-hole buzzer, pins 7.6 mm apart, + is pin 1. */
function buzzer12(): FootprintDef {
  const pads = [tht("1", -3.8, 0, 2, 1, true), tht("2", 3.8, 0, 2, 1)]
  return footprint("buzzer_12mm", pads, [circle(0, 0, 6.1, 48), line(-4.3, 2.4, -3.3, 2.4), line(-3.8, 1.9, -3.8, 2.9)], box(-6.35, -6.35, 6.35, 6.35))
}

/** WS2812B addressable RGB LED, PLCC-4 5 x 5 mm. Pin 1 (VDD) top left, marked by the corner notch. */
function ws2812b(): FootprintDef {
  const pads = [smd("1", -2.45, 1.65, 1.5, 0.9), smd("2", -2.45, -1.65, 1.5, 0.9), smd("3", 2.45, -1.65, 1.5, 0.9), smd("4", 2.45, 1.65, 1.5, 0.9)]
  return footprint(
    "ws2812b",
    pads,
    [rect(-2.5, -2.5, 2.5, 2.5), [{ x: -3.55, y: 2.1 }, { x: -3.55, y: 2.75 }, { x: -2.9, y: 2.75 }]],
    box(-3.45, -2.75, 3.45, 2.75),
  )
}

export const CONNECTOR_FOOTPRINTS: Record<string, () => FootprintDef> = {
  terminal_block_5mm_2: () => terminalBlock5mm(2),
  terminal_block_5mm_3: () => terminalBlock5mm(3),
  ...Object.fromEntries([2, 3, 4].map((n) => [`terminal_block_5.08mm_${n}`, () => terminalBlock508(n)])),
  ...Object.fromEntries([2, 3].map((n) => [`terminal_block_3.5mm_${n}`, () => terminalBlock35(n)])),
  ...Object.fromEntries([2, 3, 4].map((n) => [`phoenix_mc_3.81mm_${n}`, () => mcHeader(n)])),
  ...Object.fromEntries([2, 3].map((n) => [`phoenix_mstba_5.08mm_${n}`, () => mstbaHeader(n)])),
  qwiic_jst_sh_4: qwiicSh4,
  usb_c_16p: usbC16,
  micro_usb_b: microUsbB,
  barrel_jack_pj002a: barrelJack,
  microsd_dm3at: microSd,
  cr2032_holder: coinCell2032,
  relay_srd: relaySrd,
  buzzer_12mm: buzzer12,
  ws2812b: ws2812b,
}
