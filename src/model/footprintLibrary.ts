import { CONNECTOR_FOOTPRINTS } from "./footprintConnectors"
import { box, circle, clearOfPads, line, npth, range, rect, smd, tht } from "./footprintKit"
import { MODULE_FOOTPRINTS } from "./footprintModules"
import type { FootprintDef, PadDef, Vec2 } from "./types"

// Footprints the footprinter can't generate, drawn from datasheet land patterns.
// Coordinates are millimetres, y up, origin at the footprint centre, as footprinter output.

/**
 * ESP32 DevKit V1 (DOIT, 30 pins): two 1x15 rows 25.4 mm apart, numbered like a DIP.
 * Pin 1 (3V3) is at the USB end, top left; the antenna end is at -y. The module's four 3 mm
 * corner mounting holes are drilled through the main board (non-plated).
 */
function esp32DevkitV1(): FootprintDef {
  const pads: PadDef[] = []
  for (let i = 0; i < 15; i++) {
    const y = 17.78 - i * 2.54
    pads.push(tht(String(i + 1), -12.7, y, 2, 1.02, i === 0))
    pads.push(tht(String(30 - i), 12.7, y, 2, 1.02))
  }
  pads.push(npth(-12.25, -21.21, 3), npth(12.25, -21.21, 3), npth(-12.25, 25.74, 3), npth(12.25, 25.74, 3))
  // Module outline, 28.3 x 51.5 mm, longer on the USB side than past the last pin row.
  const top = 27.98
  const bottom = -23.52
  // Micro-USB receptacle, 6.7 x 3.9 mm, against the USB end.
  const usb = [
    { x: -3.35, y: top },
    { x: -3.35, y: top - 3.9 },
    { x: 3.35, y: top - 3.9 },
    { x: 3.35, y: top },
  ]
  return {
    name: "esp32_devkit_v1",
    pads,
    silk: [
      rect(-14.15, bottom, 14.15, top),
      [{ x: -14.15, y: 21.2 }, { x: -11.3, y: 21.2 }, { x: -11.3, y: 19.6 }],
      usb,
      // Pin 1 dot just outside the outline.
      circle(-14.7, 17.78, 0.12, 8),
    ],
    courtyard: box(-14.4, bottom - 0.25, 14.4, top + 0.25),
  }
}

/** C&K TL3342 / 5.2 mm SMD tact switch. Pads 1-2 and 3-4 are joined inside. */
function tl3342(): FootprintDef {
  return {
    name: "tl3342",
    pads: [smd("1", -3.15, 1.9, 1.7, 1), smd("2", 3.15, 1.9, 1.7, 1), smd("3", -3.15, -1.9, 1.7, 1), smd("4", 3.15, -1.9, 1.7, 1)],
    // Body edges between the terminals, with the corner chamfers of the 5.2 mm case.
    silk: [
      line(-2.75, 1, -2.75, -1),
      line(2.75, 1, 2.75, -1),
      [{ x: -1.7, y: 2.3 }, { x: -1.25, y: 2.75 }, { x: 1.25, y: 2.75 }, { x: 1.7, y: 2.3 }],
      [{ x: -1.7, y: -2.3 }, { x: -1.25, y: -2.75 }, { x: 1.25, y: -2.75 }, { x: 1.7, y: -2.3 }],
      circle(0, 0, 1.3),
    ],
    courtyard: box(-4.25, -3.05, 4.25, 3.05),
  }
}

/**
 * E-Switch EG1218 SPDT slide switch, three round pads on 2.54 mm, pin 2 is the common. The
 * 11.7 x 4.1 mm body has notched mounting-tab ends and centre marks; the slider knob is hatched
 * at the pin 1 end of its travel, cut back where it would print on the pads.
 */
function eg1218(): FootprintDef {
  const pads = [tht("1", -2.54, 0, 1.68, 0.9), tht("2", 0, 0, 1.68, 0.9), tht("3", 2.54, 0, 1.68, 0.9)]
  const x = 5.842
  const y = 2.032
  const tab = 1.524
  const notch = 5.334
  const body: Vec2[] = [
    { x: -x, y: -y },
    { x: -0.254, y: -y },
    { x: 0, y: -y + 0.254 },
    { x: 0.254, y: -y },
    { x: x, y: -y },
    { x: x, y: -tab },
    { x: notch, y: -tab },
    { x: notch, y: tab },
    { x: x, y: tab },
    { x: x, y: y },
    { x: 0.254, y: y },
    { x: 0, y: y - 0.254 },
    { x: -0.254, y: y },
    { x: -x, y: y },
    { x: -x, y: tab },
    { x: -notch, y: tab },
    { x: -notch, y: -tab },
    { x: -x, y: -tab },
    { x: -x, y: -y },
  ]
  const knob = Array.from({ length: 7 }, (_, i) => line(-2.032 + i * 0.254, -1.016, -2.032 + i * 0.254, 1.016))
  return {
    name: "eg1218",
    pads,
    silk: [body, ...clearOfPads(knob, pads)],
    courtyard: box(-6.1, -2.35, 6.1, 2.35),
  }
}

/**
 * 0.96" SSD1306 I2C OLED module (27.3 x 27.8 mm) on a 1x4 header along its top edge.
 * Origin at the header centre; the module hangs below it.
 */
function oled096(): FootprintDef {
  const pads = [0, 1, 2, 3].map((i) => tht(String(i + 1), -3.81 + i * 2.54, 0, 1.7, 1, i === 0))
  const top = 2.3
  const bottom = top - 27.8
  return {
    name: "oled096_i2c",
    pads,
    silk: [rect(-13.65, bottom, 13.65, top), rect(-12.9, bottom + 4.6, 12.9, bottom + 19.6)],
    courtyard: box(-13.9, bottom - 0.25, 13.9, top + 0.25),
  }
}

/** Panasonic-style 8 x 10.5 mm SMD aluminium electrolytic. Pin 1 is +, on the chamfered side. */
function capElec8x10(): FootprintDef {
  // 8.3 mm square base plate, outline 0.06 mm outside it, chamfered 1.06 mm on the + side.
  const h = 4.36
  const c = 3.296
  return {
    name: "cap_elec_8x10.5",
    pads: [smd("1", -3.7, 0, 4.4, 2.5), smd("2", 3.7, 0, 4.4, 2.5)],
    silk: [
      [{ x: -h, y: 1.51 }, { x: -h, y: c }, { x: -c, y: h }, { x: h, y: h }, { x: h, y: 1.51 }],
      [{ x: -h, y: -1.51 }, { x: -h, y: -c }, { x: -c, y: -h }, { x: h, y: -h }, { x: h, y: -1.51 }],
      line(-5.6, 2.51, -4.6, 2.51),
      line(-5.1, 2.01, -5.1, 3.01),
    ],
    courtyard: box(-6.15, -4.55, 6.15, 4.55),
  }
}

/** EIA 3528-21 (case B) moulded tantalum. Pin 1 is the anode (+). */
function tantalum3528(): FootprintDef {
  return {
    name: "tantalum_3528",
    pads: [smd("1", -1.5375, 0, 1.325, 2.35), smd("2", 1.5375, 0, 1.325, 2.35)],
    silk: [[{ x: 1.75, y: 1.51 }, { x: -2.46, y: 1.51 }, { x: -2.46, y: -1.51 }, { x: 1.75, y: -1.51 }]],
    courtyard: box(-2.45, -1.65, 2.45, 1.65),
  }
}

interface DiodeSpec {
  /** Pad centre distance from the origin, pad size along and across the axis. */
  padX: number
  padW: number
  padH: number
  /** Silk outline half-height and the x of the closed cathode end. */
  silkY: number
  silkX: number
  /** x positions of the cathode band lines, in the gap beside the cathode pad. */
  band: number[]
  courtyard: [number, number]
}

/**
 * Moulded DO-214 diode land pattern. Pad 1 is the anode (-x), pad 2 the cathode (+x), matching
 * the library diodes. The outline is closed past the cathode pad and open on the anode side,
 * and a solid band of silk lines marks the cathode next to its pad.
 */
function diodeDo214(name: string, d: DiodeSpec): FootprintDef {
  const { padX, silkX, silkY } = d
  return {
    name,
    pads: [smd("1", -padX, 0, d.padW, d.padH), smd("2", padX, 0, d.padW, d.padH)],
    silk: [
      [
        { x: -padX, y: silkY },
        { x: silkX, y: silkY },
        { x: silkX, y: -silkY },
        { x: -padX, y: -silkY },
      ],
      ...d.band.map((x) => line(x, -silkY, x, silkY)),
    ],
    courtyard: box(-d.courtyard[0], -d.courtyard[1], d.courtyard[0], d.courtyard[1]),
  }
}

/** DO-214AC (SMA), 4.3 x 2.6 mm body. */
const diodeSma = () =>
  diodeDo214("diode_sma", { padX: 2, padW: 2.5, padH: 1.8, silkY: 1.65, silkX: 3.51, band: range(0.2, 0.5, 0.1), courtyard: [3.65, 1.75] })

/** DO-214AA (SMB), 4.3 x 3.6 mm body. */
const diodeSmb = () =>
  diodeDo214("diode_smb", { padX: 2.15, padW: 2.5, padH: 2.3, silkY: 2.15, silkX: 3.66, band: range(0.35, 0.65, 0.1), courtyard: [3.8, 2.25] })

/** DO-214AB (SMC), 7.1 x 6.2 mm body. */
const diodeSmc = () =>
  diodeDo214("diode_smc", { padX: 3.4, padW: 2.5, padH: 3.3, silkY: 3.25, silkX: 4.85, band: range(1.4, 1.9, 0.1), courtyard: [4.95, 3.35] })

/**
 * TO-220-3 standing upright, leads on 2.54 mm with pin 1 square at -x. The outline is the body
 * (front at -y) and the metal tab behind it (+y), with the tab's edge and its two notches.
 */
function to220Vertical(): FootprintDef {
  const pads: PadDef[] = [-2.54, 0, 2.54].map((x, i) => ({
    pin: String(i + 1),
    shape: i === 0 ? "rect" : "pill",
    x,
    y: 0,
    width: 1.905,
    height: 2,
    holeDiameter: 1.1,
    layer: "through",
  }))
  return {
    name: "to220_3_vertical",
    pads,
    silk: [rect(-5.12, -1.371, 5.12, 3.27), line(-5.12, 1.76, 5.12, 1.76), line(-1.85, 1.76, -1.85, 3.27), line(1.85, 1.76, 1.85, 3.27)],
    courtyard: box(-5.25, -1.51, 5.25, 3.4),
  }
}

/**
 * 2.54 mm male pin header, 1 x n, as the footprinter's pinrow{n}: pins along x, centred, pin 1
 * square at -x. Outlined like the KiCad header: a box round pins 2..n and an open corner by pin 1.
 */
function pinHeader(n: number): FootprintDef {
  const pads = Array.from({ length: n }, (_, i) => tht(String(i + 1), (i - (n - 1) / 2) * 2.54, 0, 1.7, 1, i === 0))
  const first = pads[0].x
  const last = pads[n - 1].x
  return {
    name: `pin_header_1x${n}`,
    pads,
    silk: [rect(first + 1.27, -1.33, last + 1.33, 1.33), [{ x: first, y: -1.33 }, { x: first - 1.33, y: -1.33 }, { x: first - 1.33, y: 0 }]],
    courtyard: box(first - 1.8, -1.8, last + 1.8, 1.8),
  }
}

const BUILDERS: Record<string, () => FootprintDef> = {
  esp32_devkit_v1: esp32DevkitV1,
  tl3342: tl3342,
  eg1218: eg1218,
  oled096_i2c: oled096,
  "cap_elec_8x10.5": capElec8x10,
  tantalum_3528: tantalum3528,
  diode_sma: diodeSma,
  diode_smb: diodeSmb,
  diode_smc: diodeSmc,
  to220_3_vertical: to220Vertical,
  ...Object.fromEntries([2, 3, 4, 5, 6, 8, 10].map((n) => [`pin_header_1x${n}`, () => pinHeader(n)])),
  ...CONNECTOR_FOOTPRINTS,
  ...MODULE_FOOTPRINTS,
}

/** Names of the footprints defined here, for pickers and validation. */
export const LIBRARY_FOOTPRINTS = Object.keys(BUILDERS)

export function libraryFootprint(name: string): FootprintDef | null {
  // Own keys only: `constructor` or `toString` is a name a project can give, and no land.
  return Object.hasOwn(BUILDERS, name) ? BUILDERS[name]() : null
}
