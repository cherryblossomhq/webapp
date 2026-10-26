// The 13 parts Sakura made with create_part in production (October 17 to 19, 2026), with the pin
// maps and footprints it wrote from memory, and what checking them against LCSC found. These are
// the regression cases for building parts from supplier data: every one of them came from a real
// user's board.
//
// `pins`: "pass" when the map is right, "refuse" when it contradicts the supplier (a dead board),
// "unverified" when no supplier has the part. `footprint`: "pass" when the land fits the
// supplier's, "flag" when it doesn't, "unverified" when there is nothing to compare it with.
//
// Two need a word beyond the assessment made by hand that week:
// - ADS1115 on `msop10`: the pin map is right, but the footprinter's msop10 numbers its second row
//   top to bottom, so SCL lands on AIN2's lead and SDA on AIN3's. The footprint is wrong too.
// - U.FL-R-SMT-1: supplier drawings number it two ways, signal on pin 1 (C88374) or on pin 2
//   (C88373), each with its own land to match. Sakura's map is the first, so it passes against
//   that record; its footprint, a SOT-23, fits neither.

export interface ProductionPart {
  name: string
  footprint: string
  pins: { number: string; name: string }[]
  expect: { pins: "pass" | "refuse" | "unverified"; footprint: "pass" | "flag" | "unverified" }
}

const parse = (map: string) =>
  map
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const i = pair.indexOf(":")
      return { number: pair.slice(0, i), name: pair.slice(i + 1) }
    })

export const PRODUCTION_PARTS: ProductionPart[] = [
  { name: "SHT31-DIS", footprint: "dfn8", pins: parse("1:SDA 2:ADDR 3:ALERT 4:SCL 5:VDD 6:nRESET 7:R 8:VSS"), expect: { pins: "pass", footprint: "flag" } },
  { name: "ADS1115", footprint: "msop10", pins: parse("1:ADDR 2:ALERT/RDY 3:GND 4:AIN0 5:AIN1 6:AIN2 7:AIN3 8:VDD 9:SDA 10:SCL"), expect: { pins: "pass", footprint: "flag" } },
  {
    name: "AD8318",
    footprint: "qfn16_w3_h3_p0.5mm",
    pins: parse("1:VPSI 2:INHI 3:INLO 4:TADJ 5:CLPF 6:COMM6 7:VOUT 8:VSET 9:COMM9 10:VPSO 11:VPSO11 12:COMM12 13:ENBL 14:COMM14 15:COMM15 16:VPSI16 17:EP"),
    expect: { pins: "refuse", footprint: "flag" },
  },
  { name: "TP4056", footprint: "soic8", pins: parse("1:TEMP 2:PROG 3:GND 4:VCC 5:BAT 6:STDBY 7:CHRG 8:CE 9:EP"), expect: { pins: "pass", footprint: "flag" } },
  { name: "TPS61023", footprint: "sot23_6", pins: parse("1:SW 2:GND 3:EN 4:FB 5:VOUT 6:VIN"), expect: { pins: "refuse", footprint: "flag" } },
  { name: "DW01A", footprint: "sot23_6", pins: parse("1:OD 2:CS 3:OC 4:TD 5:VCC 6:GND"), expect: { pins: "pass", footprint: "pass" } },
  { name: "FS8205A", footprint: "tssop8", pins: parse("1:D1 2:S1a 3:S1b 4:G1 5:G2 6:S2a 7:S2b 8:D2"), expect: { pins: "pass", footprint: "flag" } },
  { name: "USBLC6-2SC6", footprint: "sot23_6", pins: parse("1:IO1a 2:GND 3:IO2a 4:IO2b 5:VBUS 6:IO1b"), expect: { pins: "pass", footprint: "pass" } },
  { name: "U.FL-R-SMT-1", footprint: "sot23", pins: parse("1:SIG 2:GND 3:GND2"), expect: { pins: "pass", footprint: "flag" } },
  { name: "HFCN-650+", footprint: "sot23_6", pins: parse("1:IN 2:GND2 3:GND3 4:OUT 5:GND5 6:GND6"), expect: { pins: "unverified", footprint: "unverified" } },
  { name: "LFCN-1700+", footprint: "sot23_6", pins: parse("1:IN 2:GND2 3:GND3 4:OUT 5:GND5 6:GND6"), expect: { pins: "refuse", footprint: "flag" } },
  { name: "ESD101-B1-02ELS", footprint: "0402", pins: parse("1:A 2:K"), expect: { pins: "pass", footprint: "flag" } },
  { name: "BLM18PG221SN1D", footprint: "0603", pins: parse("1:1 2:2"), expect: { pins: "pass", footprint: "pass" } },
]

/** Names that trap a lookup: prefixes across packages, and spellings a check on names would fail. */
export const TRAP_QUERIES = ["WS2812B", "WS2812B-2020", "ULN2003A", "AMS1117-3.3", "ESP32-WROOM-32E", "SS34"]

/**
 * Records read directly: ULN2003A in SOIC-16 (`1B`/`1C` names), AMS1117-3.3 in SOT-223 (a tab
 * that is pin 4), SS34 in SMA (cathode on pad 1), the WS2812B 5050 and 2020 (same pins, other
 * order); and, for the land tests, an ADS1115 in VSSOP-10, a second TP4056 drawing and an ESP32
 * module whose ground is a grid of pads.
 */
export const TRAP_PARTS = ["C482013", "C6186", "C908680", "C2846045", "C965555", "C2868291", "C22470410", "C6191510"]
