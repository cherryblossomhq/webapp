// Twenty common parts a reviewer tried by name alone (October 2026), for the lookup that has to
// resolve a name to a supplier part without being given an orderable number. Thirteen of the
// twenty came back "different part number" before families: `mpnCore` only stripped spaces and
// brackets, never an ordering suffix like DRLR or IDGSR.
//
// `expect` is what the recorded supplier answers (`recorded.json`, from the live smoke test)
// produce for the bare name:
// - `found`: every supplier part number that starts with the name shares one package and one set
//   of pin roles, so it is one part, resolved to the best stocked of them (`lcsc`, among
//   `members` supplier part numbers).
// - `ambiguous`: the name is sold in several packages (or pin roles), a real choice, listed best
//   stocked first with what differs. `choices` is the LCSC number of each package's best stocked
//   part number, in the order listed; `why` says what differs.

export type CommonPart =
  | { name: string; expect: "found"; lcsc: string; members: number; why: string }
  | { name: string; expect: "ambiguous"; choices: string[]; why: string }

export const COMMON_PARTS: CommonPart[] = [
  { name: "ADS1115", expect: "ambiguous", choices: ["C37593", "C701611", "C47361299"], why: "sold in MSOP-10, X2QFN-10 and WLCSP-12; the four MSOP-10 grades are one part" },
  { name: "SHT31-DIS", expect: "found", lcsc: "C453460", members: 3, why: "F2.5kS and B2.5kS reels, and a record the supplier files as a sensor, are one DFN-8 with the same pins" },
  { name: "TPS61023", expect: "found", lcsc: "C919459", members: 2, why: "DRLR and DRLT are the same SOT-563 and pins; the reel size is the only difference" },
  { name: "INA219", expect: "ambiguous", choices: ["C138706", "C87469"], why: "sold in SOIC-8 and SOT-23-8" },
  { name: "TPS63020", expect: "found", lcsc: "C15483", members: 4, why: "DSJR, DSJT and the two automotive grades are one VSON-14" },
  { name: "W25Q128JV", expect: "ambiguous", choices: ["C2456298", "C2456297", "C190862", "C401671"], why: "sold in SOIC-16, two sizes of WSON-8 and SOIC-8" },
  { name: "DRV8833", expect: "ambiguous", choices: ["C50506", "C154936", "C544801", "C701801"], why: "sold in TSSOP-16 with and without an exposed pad, QFN-16 and WQFN-16" },
  { name: "MCP2515", expect: "ambiguous", choices: ["C185941", "C153782", "C96140"], why: "sold in TSSOP-20, SOIC-18 and QFN-20" },
  { name: "TMP117", expect: "ambiguous", choices: ["C699536", "C2867882"], why: "sold in WSON-6 and DSBGA-6" },
  { name: "AP2112K-3.3", expect: "found", lcsc: "C22365427", members: 3, why: "the records call one SOT-23-5 both SOT-23-5 and SOT-25-5; same size, same pins" },
  { name: "MPU6050", expect: "found", lcsc: "C24112", members: 1, why: "catalogued MPU-6050; the user uploads under MPU6050 are not preferred" },
  { name: "WS2812B", expect: "ambiguous", choices: ["C2761795", "C4154873", "C42417599"], why: "the exact records have no stock and are a 3535 and two user uploads, so the stocked 5.0 x 5.0 mm WS2812B-B/T joins them and is listed first, then two 3.5 mm pinouts; a footprint such as led5050 picks one" },
  { name: "BME280", expect: "found", lcsc: "C92489", members: 2, why: "two records of one LGA-8" },
  { name: "LM358", expect: "found", lcsc: "C2984960", members: 1, why: "its own SOP-8 record with pins; the other LM358 records are blank symbols with no pins, passed over (VEE/GND and VEE are one pin where two are drawn)" },
  { name: "TP4056", expect: "found", lcsc: "C725790", members: 5, why: "five records of one ESOP-8 with its exposed pad" },
  { name: "STM32F103C8T6", expect: "found", lcsc: "C8734", members: 1, why: "its own reviewed record is one LQFP-48; the exact number outranks its variants, and the two EasyEDA user uploads spelled like it are not used" },
  { name: "CH340C", expect: "found", lcsc: "C84681", members: 2, why: "two records of one SOP-16" },
  { name: "LIS3DH", expect: "found", lcsc: "C15134", members: 1, why: "LIS3DHTR in LGA-16; the LIS3DHHTR in a 5 x 5 mm CCLGA-16 has no stock, so it is not offered as a choice" },
  { name: "AMS1117-3.3", expect: "ambiguous", choices: ["C347222", "C20628883"], why: "sold in SOT-223 (tab as pin 4) and SOT-89 (3 pins)" },
  { name: "NE555", expect: "ambiguous", choices: ["C18164403", "C55186583"], why: "two records agree, and a third in the same SOIC-8 puts TRIG on pin 5 and RTIG on pin 2 where they put CONT and TRIG: another pin map, so the differing pins are listed instead of merged" },
]
