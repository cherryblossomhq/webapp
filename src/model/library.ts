import { passive } from "./partKit"
import { CONNECTOR_PARTS } from "./partsConnectors"
import { discreteSymbol } from "./discreteSymbols"
import { scoped } from "./scope"
import { makeBoxSymbol } from "./symbols"
import type { PartCategory, PartDef } from "./types"

export const PARTS: PartDef[] = [
  // ---------- Passives ----------
  {
    id: "resistor",
    name: "Resistor",
    category: "Passives",
    description: "Fixed resistor",
    refPrefix: "R",
    pins: passive(["1", "1"], ["2", "2"]),
    symbol: discreteSymbol("resistor"),
    footprints: ["0603", "0402", "0805", "1206", "axial_p10.16mm"],
    defaultProps: { resistance: "10k" },
    valueProp: "resistance",
    keywords: ["res", "ohm", "pullup", "pulldown"],
  },
  {
    id: "capacitor",
    name: "Capacitor",
    category: "Passives",
    description: "Ceramic capacitor (non-polarized)",
    refPrefix: "C",
    pins: passive(["1", "1"], ["2", "2"]),
    symbol: discreteSymbol("capacitor"),
    footprints: ["0603", "0402", "0805", "1206", "radial_p2.5mm"],
    defaultProps: { capacitance: "100nF" },
    valueProp: "capacitance",
    keywords: ["cap", "decoupling", "mlcc", "farad"],
  },
  {
    id: "capacitor_polarized",
    name: "Electrolytic Capacitor",
    category: "Passives",
    description: "Polarized aluminium electrolytic capacitor",
    refPrefix: "C",
    pins: passive(["1", "+"], ["2", "-"]),
    symbol: discreteSymbol("capacitor_polarized"),
    footprints: ["electrolytic_d5mm_p2mm", "electrolytic_d6.3mm_p2.5mm", "electrolytic", "cap_elec_8x10.5"],
    defaultProps: { capacitance: "10uF", voltage: "16V" },
    valueProp: "capacitance",
    keywords: ["cap", "bulk", "polarized", "electrolytic"],
  },
  {
    id: "capacitor_tantalum",
    name: "Tantalum Capacitor",
    category: "Passives",
    description: "Polarized moulded tantalum capacitor (EIA 3528)",
    refPrefix: "C",
    pins: passive(["1", "+"], ["2", "-"]),
    symbol: discreteSymbol("capacitor_polarized"),
    footprints: ["tantalum_3528"],
    defaultProps: { capacitance: "10uF", voltage: "25V" },
    valueProp: "capacitance",
    keywords: ["cap", "tantalum", "bulk", "polarized", "3528"],
  },
  {
    id: "inductor",
    name: "Inductor",
    category: "Passives",
    description: "Fixed inductor",
    refPrefix: "L",
    pins: passive(["1", "1"], ["2", "2"]),
    symbol: discreteSymbol("inductor"),
    footprints: ["0805", "0603", "1206"],
    defaultProps: { inductance: "10uH" },
    valueProp: "inductance",
    keywords: ["coil", "choke", "henry"],
  },
  {
    id: "potentiometer",
    name: "Potentiometer",
    category: "Passives",
    description: "Trimmer potentiometer with wiper",
    refPrefix: "RV",
    pins: passive(["1", "1"], ["2", "W"], ["3", "3"]),
    symbol: discreteSymbol("potentiometer"),
    footprints: ["potentiometer"],
    defaultProps: { resistance: "10k" },
    valueProp: "resistance",
    keywords: ["pot", "trimmer", "variable resistor"],
  },
  {
    id: "crystal",
    name: "Crystal",
    category: "Passives",
    description: "Quartz crystal, HC-49/S (low-profile HC-49) package",
    refPrefix: "Y",
    pins: passive(["1", "1"], ["2", "2"]),
    symbol: discreteSymbol("crystal"),
    footprints: ["hc49"],
    defaultProps: { frequency: "16MHz" },
    valueProp: "frequency",
    keywords: ["xtal", "oscillator", "clock"],
  },

  // ---------- Diodes ----------
  {
    id: "diode",
    name: "Diode",
    category: "Diodes",
    description: "General purpose signal diode",
    refPrefix: "D",
    pins: [
      { number: "1", name: "A", kind: "passive" },
      { number: "2", name: "K", kind: "passive" },
    ],
    symbol: discreteSymbol("diode"),
    footprints: ["sod123", "sma", "axial_p7.62mm", "diode_sma", "diode_smb", "diode_smc"],
    defaultProps: { mpn: "1N4148W" },
    valueProp: "mpn",
    keywords: ["rectifier", "1n4148"],
  },
  {
    id: "schottky",
    name: "Schottky Diode",
    category: "Diodes",
    description: "Low forward-voltage Schottky diode",
    refPrefix: "D",
    pins: [
      { number: "1", name: "A", kind: "passive" },
      { number: "2", name: "K", kind: "passive" },
    ],
    symbol: discreteSymbol("schottky"),
    footprints: ["sma", "sod123", "diode_sma", "diode_smb", "diode_smc"],
    defaultProps: { mpn: "SS34" },
    valueProp: "mpn",
    keywords: ["reverse polarity", "ss34", "bat54"],
  },
  {
    id: "zener",
    name: "Zener Diode",
    category: "Diodes",
    description: "Voltage reference / clamp diode",
    refPrefix: "D",
    pins: [
      { number: "1", name: "A", kind: "passive" },
      { number: "2", name: "K", kind: "passive" },
    ],
    symbol: discreteSymbol("zener"),
    footprints: ["sod123"],
    defaultProps: { voltage: "5.1V" },
    valueProp: "voltage",
    keywords: ["clamp", "reference", "tvs"],
  },
  {
    id: "led",
    name: "LED",
    category: "Diodes",
    description: "Light emitting diode",
    refPrefix: "D",
    pins: [
      { number: "1", name: "A", kind: "passive" },
      { number: "2", name: "K", kind: "passive" },
    ],
    symbol: discreteSymbol("led"),
    footprints: ["0603", "0805", "1206"],
    defaultProps: { color: "red" },
    valueProp: "color",
    keywords: ["light", "indicator", "status"],
  },

  // ---------- Transistors (SOT-23 pinout: BJT 1=B 2=E 3=C, MOSFET 1=G 2=S 3=D) ----------
  {
    id: "npn",
    name: "NPN Transistor",
    category: "Transistors",
    description: "General purpose NPN BJT (SOT-23)",
    refPrefix: "Q",
    pins: [
      { number: "1", name: "B", kind: "input" },
      { number: "2", name: "E", kind: "passive" },
      { number: "3", name: "C", kind: "passive" },
    ],
    symbol: discreteSymbol("npn", { "1": "3", "2": "1", "3": "2" }),
    footprints: ["sot23"],
    defaultProps: { mpn: "MMBT3904" },
    valueProp: "mpn",
    keywords: ["bjt", "2n3904", "switch"],
  },
  {
    id: "pnp",
    name: "PNP Transistor",
    category: "Transistors",
    description: "General purpose PNP BJT (SOT-23)",
    refPrefix: "Q",
    pins: [
      { number: "1", name: "B", kind: "input" },
      { number: "2", name: "E", kind: "passive" },
      { number: "3", name: "C", kind: "passive" },
    ],
    symbol: discreteSymbol("pnp", { "1": "3", "2": "1", "3": "2" }),
    footprints: ["sot23"],
    defaultProps: { mpn: "MMBT3906" },
    valueProp: "mpn",
    keywords: ["bjt", "2n3906", "high side"],
  },
  {
    id: "nmos",
    name: "N-MOSFET",
    category: "Transistors",
    description: "N-channel enhancement MOSFET (SOT-23)",
    refPrefix: "Q",
    pins: [
      { number: "1", name: "G", kind: "input" },
      { number: "2", name: "S", kind: "passive" },
      { number: "3", name: "D", kind: "passive" },
    ],
    symbol: discreteSymbol("nmos", {
      "1": "3",
      "2": "2",
      "3": "1",
    }),
    footprints: ["sot23"],
    defaultProps: { mpn: "2N7002" },
    valueProp: "mpn",
    keywords: ["fet", "low side", "switch", "ao3400"],
  },
  {
    id: "pmos",
    name: "P-MOSFET",
    category: "Transistors",
    description: "P-channel enhancement MOSFET (SOT-23)",
    refPrefix: "Q",
    pins: [
      { number: "1", name: "G", kind: "input" },
      { number: "2", name: "S", kind: "passive" },
      { number: "3", name: "D", kind: "passive" },
    ],
    symbol: discreteSymbol("pmos", {
      "1": "3",
      "2": "2",
      "3": "1",
    }),
    footprints: ["sot23"],
    defaultProps: { mpn: "AO3401" },
    valueProp: "mpn",
    keywords: ["fet", "high side", "load switch", "reverse polarity"],
  },

  // ---------- Power ----------
  {
    id: "power",
    name: "Power Port",
    category: "Symbols",
    description: "Connects pins to a named supply net (VCC, 3V3, 5V...)",
    refPrefix: "#PWR",
    pins: [{ number: "1", name: "1", kind: "power" }],
    symbol: discreteSymbol("power"),
    footprints: [],
    defaultProps: { net: "VCC" },
    valueProp: "net",
    powerNet: "VCC",
    keywords: ["vcc", "vdd", "3v3", "5v", "supply", "rail"],
  },
  {
    id: "ground",
    name: "Ground",
    category: "Symbols",
    description: "Connects pins to the GND net",
    refPrefix: "#GND",
    pins: [{ number: "1", name: "1", kind: "ground" }],
    symbol: discreteSymbol("ground"),
    footprints: [],
    defaultProps: { net: "GND" },
    valueProp: "net",
    powerNet: "GND",
    keywords: ["gnd", "vss", "0v", "earth"],
  },
  {
    id: "battery",
    name: "Battery",
    category: "Power",
    description: "Battery connected through a JST PH 2-pin connector",
    refPrefix: "BT",
    pins: [
      { number: "1", name: "+", kind: "power" },
      { number: "2", name: "-", kind: "ground" },
    ],
    symbol: discreteSymbol("battery"),
    footprints: ["jst2_ph"],
    defaultProps: { voltage: "3.7V" },
    valueProp: "voltage",
    keywords: ["lipo", "cell", "jst"],
  },
  {
    id: "coin_cell_cr2032",
    name: "CR2032 Holder",
    category: "Power",
    description: "Retainer for a 20 mm CR2032 coin cell, SMD; the negative pad is under the cell",
    refPrefix: "BT",
    pins: [
      { number: "1", name: "+", kind: "power" },
      { number: "2", name: "-", kind: "ground" },
    ],
    symbol: discreteSymbol("battery"),
    footprints: ["cr2032_holder"],
    defaultProps: { voltage: "3V" },
    valueProp: "voltage",
    padAlias: { "3": "1" },
    keywords: ["coin cell", "button cell", "cr2032", "battery holder", "rtc backup", "lithium"],
  },

  // ---------- Connectors ----------
  ...CONNECTOR_PARTS,

  // ---------- Electromechanical ----------
  {
    id: "pushbutton",
    name: "Push Button",
    category: "Electromechanical",
    description: "6 mm tactile switch, normally open",
    refPrefix: "SW",
    pins: passive(["1", "1"], ["2", "2"]),
    symbol: discreteSymbol("pushbutton"),
    footprints: ["pushbutton"],
    defaultProps: {},
    padAlias: { "2": "1", "3": "2", "4": "2" },
    keywords: ["switch", "tactile", "button", "reset"],
  },
  {
    id: "pushbutton_smd",
    name: "Push Button SMD",
    category: "Electromechanical",
    description: "5.2 mm SMD tactile switch (TL3342), normally open",
    refPrefix: "SW",
    pins: passive(["1", "1"], ["2", "2"]),
    symbol: discreteSymbol("pushbutton"),
    footprints: ["tl3342"],
    defaultProps: {},
    padAlias: { "2": "1", "3": "2", "4": "2" },
    keywords: ["switch", "tactile", "button", "smd", "tl3342"],
  },
  {
    id: "slide_switch",
    name: "Slide Switch SPDT",
    category: "Electromechanical",
    description: "Through-hole SPDT slide switch (EG1218), pin 2 is the common",
    refPrefix: "SW",
    pins: passive(["1", "1"], ["2", "C"], ["3", "3"]),
    symbol: discreteSymbol("spdt", { "1": "2", "2": "1", "3": "3" }),
    footprints: ["eg1218"],
    defaultProps: {},
    keywords: ["switch", "power switch", "on off", "slide", "spdt", "eg1218"],
  },
  {
    id: "relay_srd05",
    name: "Relay SPDT 5 V",
    category: "Electromechanical",
    description: "10 A sugar-cube relay with a 5 V coil, changeover contact (SRD-05VDC-SL-C)",
    refPrefix: "K",
    pins: passive(["1", "A1"], ["2", "A2"], ["3", "COM"], ["4", "NO"], ["5", "NC"]),
    symbol: makeBoxSymbol({
      left: [
        { number: "1", name: "A1" },
        { number: "2", name: "A2" },
      ],
      right: [
        { number: "3", name: "COM" },
        { number: "4", name: "NO" },
        { number: "5", name: "NC" },
      ],
    }),
    footprints: ["relay_srd"],
    defaultProps: { mpn: "SRD-05VDC-SL-C" },
    valueProp: "mpn",
    mpn: "SRD-05VDC-SL-C",
    keywords: ["relay", "songle", "spdt", "coil", "mains", "switch"],
  },
  {
    id: "buzzer",
    name: "Buzzer 12 mm",
    category: "Electromechanical",
    description: "12 mm through-hole buzzer or piezo, + is pin 1",
    refPrefix: "BZ",
    pins: [
      { number: "1", name: "+", kind: "passive" },
      { number: "2", name: "-", kind: "passive" },
    ],
    symbol: discreteSymbol("buzzer"),
    footprints: ["buzzer_12mm"],
    defaultProps: {},
    keywords: ["buzzer", "beeper", "piezo", "speaker", "sound", "alarm"],
  },
]

const byId = new Map(PARTS.map((p) => [p.id, p]))

/**
 * Parts made for a project (`Project.parts`), registered as projects are opened or edited.
 * Ids carry a hash of the definition, so one id never names two different parts and
 * entries never need removing. The ids are only as honest as the file that holds them, so the
 * registry is the scope's (`model/scope.ts`): on a server, a part one project registers under an
 * id is never what another project reads by it.
 */
const projectParts = scoped(() => new Map<string, PartDef>())
const projectPart = (id: string) => projectParts().get(id) ?? projectParts.base.get(id)

export function registerPart(part: PartDef) {
  if (byId.has(part.id)) return
  const parts = projectParts()
  parts.set(part.id, part)
  // A part with several units is placed as several symbols of one reference; only one of them is on the board.
  // The others are placements of its twin, which has the same pins and drawings and no footprint (`unitOf`).
  if (part.units && part.units.count > 1 && !part.powerNet && !part.unitOf) parts.set(unitTwinId(part.id), { ...part, id: unitTwinId(part.id), footprints: [], unitOf: part.id })
}

/** The id of the twin a part's other units are placed as (see `registerPart`). */
export const unitTwinId = (id: string) => `${id}@sub`

/** Takes a project part out of memory again: for an import that registered parts to check a project and then refused it. */
export function unregisterPart(id: string) {
  projectParts().delete(id)
  projectParts().delete(unitTwinId(id))
}

/** The ids of the project parts in memory, so that an import can tell which parts it registered. */
export const projectPartIds = (): string[] => [...projectParts().keys()].filter((id) => !id.endsWith("@sub"))

export const isRegistered = (id: string) => byId.has(id) || projectPart(id) !== undefined

export function getPart(id: string): PartDef {
  const part = findPart(id)
  if (!part) throw new Error(`Unknown part "${id}"`)
  return part
}

export const findPart = (id: string) => byId.get(id) ?? projectPart(id)

export const CATEGORIES: PartCategory[] = [
  "Symbols",
  "Passives",
  "Diodes",
  "Transistors",
  "Power",
  "ICs",
  "Modules",
  "Connectors",
  "Electromechanical",
]
