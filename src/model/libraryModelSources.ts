// Which KiCad footprint's 3D model each built-in part is drawn with, on each of its footprints: the
// same part where KiCad has it by part number (the TL3342, the SRD relay, the Phoenix terminal
// blocks), else the standard package the footprint is (an 0603 resistor, a SOIC-8, a 2.54 mm pin
// header). A part or footprint that is neither, such as a screw terminal of no particular maker or
// a dev board KiCad has no model of, isn't listed and has no model: the 3D view draws its pads.
//
// `tests/library-models.generate.test.ts` reads these from KiCad's libraries and writes where each
// model sits on our footprint to `libraryModels.json`, which is what the editor reads.

/** The KiCad library release the models are read from: the one the parts index serves. */
export { STOCK_MODEL_RELEASE as KICAD_LIBRARY_RELEASE } from "./kicad/board/stockModels"

export interface LibraryModelSource {
  /** A library part's id, or `*` for any part on the footprint (a package, whatever chip is in it). */
  part: string
  footprint: string
  /** KiCad's footprint, `Library:Name`. */
  kicad: string
  /** KiCad's pad numbers as ours where they differ: our diodes and LEDs are numbered anode first, KiCad's cathode first. */
  pads?: Record<string, string>
  /**
   * `positions` puts KiCad's pads on ours by where they are, not by number, for a land numbered
   * another way whose model is the same either way round (a switch's four legs, a header's pins).
   */
  match?: "positions"
  /** Pads left out of the comparison on both sides: an exposed pad drawn as a grid of pads, a module's test points. */
  ignore?: string[]
  /** How far a pad may land from ours (mm), where our land's pads are further out than KiCad's. */
  tolerance?: number
}

const CATHODE_FIRST = { "1": "2", "2": "1" }

const CHIPS: [string, string][] = [
  ["0402", "1005"],
  ["0603", "1608"],
  ["0805", "2012"],
  ["1206", "3216"],
]

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const nn = (n: number) => String(n).padStart(2, "0")

export const LIBRARY_MODEL_SOURCES: LibraryModelSource[] = [
  // Passives
  ...CHIPS.map(([size, metric]) => ({ part: "resistor", footprint: size, kicad: `Resistor_SMD:R_${size}_${metric}Metric` })),
  { part: "resistor", footprint: "axial_p10.16mm", kicad: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal" },
  ...CHIPS.map(([size, metric]) => ({ part: "capacitor", footprint: size, kicad: `Capacitor_SMD:C_${size}_${metric}Metric` })),
  { part: "capacitor_polarized", footprint: "electrolytic_d5mm_p2mm", kicad: "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm" },
  { part: "capacitor_polarized", footprint: "electrolytic_d6.3mm_p2.5mm", kicad: "Capacitor_THT:CP_Radial_D6.3mm_P2.50mm" },
  { part: "capacitor_polarized", footprint: "cap_elec_8x10.5", kicad: "Capacitor_SMD:CP_Elec_8x10.5" },
  { part: "capacitor_tantalum", footprint: "tantalum_3528", kicad: "Capacitor_Tantalum_SMD:CP_EIA-3528-21_Kemet-B" },
  ...CHIPS.filter(([size]) => size !== "0402").map(([size, metric]) => ({ part: "inductor", footprint: size, kicad: `Inductor_SMD:L_${size}_${metric}Metric` })),
  { part: "crystal", footprint: "hc49", kicad: "Crystal:Crystal_HC49-4H_Vertical" },

  // Diodes
  ...["diode", "schottky", "zener"].map((part) => ({ part, footprint: "sod123", kicad: "Diode_SMD:D_SOD-123", pads: CATHODE_FIRST })),
  ...["diode", "schottky"].flatMap((part) => [
    { part, footprint: "sma", kicad: "Diode_SMD:D_SMA", pads: CATHODE_FIRST },
    { part, footprint: "diode_sma", kicad: "Diode_SMD:D_SMA", pads: CATHODE_FIRST },
    { part, footprint: "diode_smb", kicad: "Diode_SMD:D_SMB", pads: CATHODE_FIRST },
    { part, footprint: "diode_smc", kicad: "Diode_SMD:D_SMC", pads: CATHODE_FIRST },
  ]),
  { part: "diode", footprint: "axial_p7.62mm", kicad: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal", pads: CATHODE_FIRST },
  ...CHIPS.filter(([size]) => size !== "0402").map(([size, metric]) => ({ part: "led", footprint: size, kicad: `LED_SMD:LED_${size}_${metric}Metric`, pads: CATHODE_FIRST })),

  // Electromechanical
  { part: "battery", footprint: "jst2_ph", kicad: "Connector_JST:JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical" },
  { part: "pushbutton", footprint: "pushbutton", kicad: "Button_Switch_THT:SW_PUSH_6mm", match: "positions" },
  { part: "pushbutton_smd", footprint: "tl3342", kicad: "Button_Switch_SMD:SW_SPST_TL3342", match: "positions" },
  { part: "relay_srd05", footprint: "relay_srd", kicad: "Relay_THT:Relay_SPDT_SANYOU_SRD_Series_Form_C", match: "positions" },
  { part: "buzzer", footprint: "buzzer_12mm", kicad: "Buzzer_Beeper:Buzzer_12x9.5RM7.6" },

  // Connectors
  ...[2, 3, 4, 5, 6, 8, 10].flatMap((n) => [
    { part: `header_1x${n}`, footprint: `pinrow${n}`, kicad: `Connector_PinHeader_2.54mm:PinHeader_1x${nn(n)}_P2.54mm_Vertical` },
    { part: `header_1x${n}`, footprint: `pin_header_1x${n}`, kicad: `Connector_PinHeader_2.54mm:PinHeader_1x${nn(n)}_P2.54mm_Vertical` },
    { part: `header_1x${n}_f`, footprint: `pinrow${n}_female`, kicad: `Connector_PinSocket_2.54mm:PinSocket_1x${nn(n)}_P2.54mm_Vertical` },
  ]),
  ...[3, 5, 20].map((n) => ({ part: `header_2x${n}`, footprint: `pinrow${2 * n}_rows2`, kicad: `Connector_PinHeader_2.54mm:PinHeader_2x${nn(n)}_P2.54mm_Vertical`, match: "positions" as const })),
  ...[8, 14, 16, 28].map((n) => ({ part: `socket_dip${n}`, footprint: `dip${n}`, kicad: `Package_DIP:DIP-${n}_W7.62mm_Socket` })),
  ...range(2, 4).map((n) => ({ part: `phoenix_mkds_${n}`, footprint: `terminal_block_5.08mm_${n}`, kicad: `TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-${n}-5.08_1x${nn(n)}_P5.08mm_Horizontal` })),
  ...range(2, 3).map((n) => ({ part: `phoenix_pt_${n}`, footprint: `terminal_block_3.5mm_${n}`, kicad: `TerminalBlock_Phoenix:TerminalBlock_Phoenix_PT-1,5-${n}-3.5-H_1x${nn(n)}_P3.50mm_Horizontal` })),
  ...range(2, 4).map((n) => ({ part: `phoenix_mc_${n}`, footprint: `phoenix_mc_3.81mm_${n}`, kicad: `Connector_Phoenix_MC:PhoenixContact_MC_1,5_${n}-G-3.81_1x${nn(n)}_P3.81mm_Horizontal` })),
  ...range(2, 3).map((n) => ({ part: `phoenix_mstba_${n}`, footprint: `phoenix_mstba_5.08mm_${n}`, kicad: `Connector_Phoenix_MSTB:PhoenixContact_MSTBA_2,5_${n}-G-5,08_1x${nn(n)}_P5.08mm_Horizontal` })),
  ...range(2, 4).map((n) => ({ part: `jst_ph_${n}`, footprint: `jst_ph_${n}`, kicad: `Connector_JST:JST_PH_B${n}B-PH-K_1x${nn(n)}_P2.00mm_Vertical` })),
  ...range(2, 4).map((n) => ({ part: `jst_xh_${n}`, footprint: `jst_xh_${n}`, kicad: `Connector_JST:JST_XH_B${n}B-XH-A_1x${nn(n)}_P2.50mm_Vertical` })),
  { part: "qwiic", footprint: "qwiic_jst_sh_4", kicad: "Connector_JST:JST_SH_SM04B-SRSS-TB_1x04-1MP_P1.00mm_Horizontal" },
  { part: "usb_c", footprint: "usb_c_16p", kicad: "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal" },
  // Our microSD numbers the card-detect switch's pins the other way round.
  { part: "microsd", footprint: "microsd_dm3at", kicad: "Connector_Card:microSD_HC_Hirose_DM3AT-SF-PEJM5", pads: { "9": "10", "10": "9" } },

  // Packages, whatever part is in them
  ...["npn", "pnp", "nmos", "pmos", "*"].map((part) => ({ part, footprint: "sot23", kicad: "Package_TO_SOT_SMD:SOT-23" })),
  { part: "*", footprint: "sot23_5", kicad: "Package_TO_SOT_SMD:SOT-23-5" },
  { part: "*", footprint: "sot223", kicad: "Package_TO_SOT_SMD:SOT-223-3_TabPin2" },
  { part: "*", footprint: "soic8", kicad: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" },
  { part: "*", footprint: "soic14", kicad: "Package_SO:SOIC-14_3.9x8.7mm_P1.27mm" },
  { part: "*", footprint: "soic16", kicad: "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm" },
  // The footprinter's TQFP-32 rows are 1.3 mm further out than a 7x7 mm TQFP-32's (an ATmega328P-AU's
  // leads end 4.5 mm from its centre, its pads start at 4.7): drawn all the same, so the 3D view shows it.
  { part: "*", footprint: "tqfp32_p0.8mm", kicad: "Package_QFP:TQFP-32_7x7mm_P0.8mm", tolerance: 1.3 },
  ...[4, 8, 14, 16, 28].map((n) => ({ part: "*", footprint: `dip${n}`, kicad: `Package_DIP:DIP-${n}_W7.62mm` })),
  { part: "*", footprint: "to220_3", kicad: "Package_TO_SOT_THT:TO-220-3_Vertical" },
  { part: "*", footprint: "to220_3_vertical", kicad: "Package_TO_SOT_THT:TO-220-3_Vertical" },
  { part: "*", footprint: "ws2812b", kicad: "LED_SMD:LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm" },
  { part: "*", footprint: "esp32_wroom_32e", kicad: "RF_Module:ESP32-WROOM-32E", ignore: ["39"] },
  { part: "*", footprint: "esp32_s3_wroom_1", kicad: "RF_Module:ESP32-S3-WROOM-1", ignore: ["41", "42", "43", "44", "45", "46", "47", "48", "49"] },
  { part: "*", footprint: "rpi_pico", kicad: "Module:RaspberryPi_Pico_SMD", ignore: ["D1", "D2", "D3", "TP1", "TP2", "TP3", "TP4", "TP5", "TP6"] },
]
