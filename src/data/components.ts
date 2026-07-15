/**
 * Hardcoded component library for MVP
 * Defines all available component types with tscircuit mappings.
 */

/**
 * Supported component symbol types. Maps to Circuit JSON source_component ftypes.
 */
export type ComponentSymbol =
  | "resistor"
  | "capacitor"
  | "inductor"
  | "led"
  | "diode"
  | "transistor_npn"
  | "ic"
  | "connector"
  | "gnd"
  | "vcc";

/**
 * Component definition from the library. Used to create new instances.
 */
export interface ComponentDef {
  symbol: ComponentSymbol;
  displayName: string; // e.g., "Resistor"
  category: "Passive" | "Active" | "Power" | "Digital" | "Analog";
  defaultValue: string; // e.g., "10k" for resistor
  defaultFootprint: string; // e.g., "0402"
  designatorPrefix?: string; // e.g., "R", "C", "U" — populated from DB
  pinCount: number;
  pinLabels: string[]; // e.g., ["1", "2"] or ["Anode", "Cathode"]
  svgPath?: string; // SVG path data for custom symbols
  /** tscircuit JSX element name, e.g. "resistor", "chip", "netalias" */
  tscircuitElement?: string;
  /** tscircuit prop name for the component's primary value, e.g. "resistance", "capacitance" */
  valuePropName?: string;
}

/**
 * Map of symbol type to component definition.
 *
 * Each definition now includes `tscircuitElement` (the JSX tag name in tscircuit)
 * and `valuePropName` (the prop that carries the component's primary value).
 */
export const COMPONENT_LIBRARY: Record<string, ComponentDef> = {
  resistor: {
    symbol: "resistor",
    displayName: "Resistor",
    category: "Passive",
    defaultValue: "10k",
    defaultFootprint: "0402",
    designatorPrefix: "R",
    pinCount: 2,
    pinLabels: ["1", "2"],
    tscircuitElement: "resistor",
    valuePropName: "resistance",
  },
  capacitor: {
    symbol: "capacitor",
    displayName: "Capacitor",
    category: "Passive",
    defaultValue: "100nF",
    defaultFootprint: "0402",
    designatorPrefix: "C",
    pinCount: 2,
    pinLabels: ["1", "2"],
    tscircuitElement: "capacitor",
    valuePropName: "capacitance",
  },
  inductor: {
    symbol: "inductor",
    displayName: "Inductor",
    category: "Passive",
    defaultValue: "10µH",
    defaultFootprint: "0603",
    designatorPrefix: "L",
    pinCount: 2,
    pinLabels: ["1", "2"],
    tscircuitElement: "inductor",
    valuePropName: "inductance",
  },
  led: {
    symbol: "led",
    displayName: "LED",
    category: "Active",
    defaultValue: "LED",
    defaultFootprint: "0603",
    designatorPrefix: "D",
    pinCount: 2,
    pinLabels: ["Anode", "Cathode"],
    tscircuitElement: "led",
    valuePropName: "color",
  },
  diode: {
    symbol: "diode",
    displayName: "Diode",
    category: "Active",
    defaultValue: "1N4148",
    defaultFootprint: "SOD-123",
    designatorPrefix: "D",
    pinCount: 2,
    pinLabels: ["Anode", "Cathode"],
    tscircuitElement: "diode",
    valuePropName: "partNumber",
  },
  transistor_npn: {
    symbol: "transistor_npn",
    displayName: "NPN Transistor",
    category: "Active",
    defaultValue: "2N2222",
    defaultFootprint: "TO-92",
    designatorPrefix: "Q",
    pinCount: 3,
    pinLabels: ["Base", "Collector", "Emitter"],
    tscircuitElement: "transistor",
    valuePropName: "partNumber",
  },
  connector: {
    symbol: "connector",
    displayName: "Connector 2-pin",
    category: "Passive",
    defaultValue: "CONN",
    defaultFootprint: "pinrow2",
    designatorPrefix: "J",
    pinCount: 2,
    pinLabels: ["1", "2"],
    tscircuitElement: "pinheader",
    valuePropName: "pinCount",
  },
  ic: {
    symbol: "ic",
    displayName: "DIP8 IC",
    category: "Digital",
    defaultValue: "ATmega328P",
    defaultFootprint: "DIP8",
    designatorPrefix: "U",
    pinCount: 8,
    pinLabels: ["1", "2", "3", "4", "5", "6", "7", "8"],
    tscircuitElement: "chip",
    valuePropName: "partNumber",
  },
  gnd: {
    symbol: "gnd",
    displayName: "Ground",
    category: "Power",
    defaultValue: "GND",
    defaultFootprint: "none",
    designatorPrefix: "GND",
    pinCount: 1,
    pinLabels: ["GND"],
    tscircuitElement: "netalias",
    valuePropName: "net",
  },
  vcc: {
    symbol: "vcc",
    displayName: "Power Supply",
    category: "Power",
    defaultValue: "VCC",
    defaultFootprint: "none",
    designatorPrefix: "VCC",
    pinCount: 1,
    pinLabels: ["VCC"],
    tscircuitElement: "netalias",
    valuePropName: "net",
  },
};

/**
 * Get component definition by symbol
 */
export function getComponentDef(symbol: string): ComponentDef | undefined {
  return COMPONENT_LIBRARY[symbol];
}

/**
 * Generate next component designator (R1, R2, ... or C1, C2, ...)
 */
export function getNextDesignator(
  symbol: string,
  existingIds: string[]
): string {
  const prefix = getDesignatorPrefix(symbol);
  if (!prefix) return "U1"; // Fallback

  let number = 1;
  while (existingIds.includes(`${prefix}${number}`)) {
    number++;
  }
  return `${prefix}${number}`;
}

/**
 * Get designator prefix for a symbol type
 */
function getDesignatorPrefix(symbol: string): string {
  const prefixes: Record<string, string> = {
    resistor: "R",
    capacitor: "C",
    inductor: "L",
    led: "D",
    diode: "D",
    ic: "U",
    transistor_npn: "Q",
    connector: "J",
    gnd: "GND",
    vcc: "VCC",
  };
  return prefixes[symbol] || "U";
}

