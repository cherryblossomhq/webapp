import type { PcbEvalCase } from "./pcbEval";

const EMPTY_BOARD = `export default () => (
  <board width="50mm" height="50mm" />
)`;

const BASIC_LED = `export default () => (
  <board width="30mm" height="20mm">
    <resistor name="R1" resistance="1k" footprint="0603" />
    <led name="LED1" footprint="0603" />
  </board>
)`;

export const PCB_EVAL_CASES: PcbEvalCase[] = [
  {
    id: "component-value-edit",
    title: "Change a resistor value without disturbing the design",
    category: "component-edit",
    userPrompt: "Change R1 to 4.7k",
    initialTsx: BASIC_LED,
    expectations: {
      componentCount: 2,
      components: [
        { name: "R1", elementTag: "resistor", props: { resistance: "4.7k" } },
        { name: "LED1", elementTag: "led" },
      ],
      requiredTools: ["update_component"],
      maxErrors: 0,
      maxRepairAttempts: 2,
    },
  },
  {
    id: "named-power-rails",
    title: "Connect an IC to explicit named power rails",
    category: "connectivity",
    userPrompt: "Connect U1 power to 3.3 V and ground using named nets",
    initialTsx: EMPTY_BOARD,
    expectations: {
      components: [{ name: "U1", elementTag: "chip" }],
      connections: [
        { from: "U1.VCC", to: "net.V3_3" },
        { from: "U1.GND", to: "net.GND" },
      ],
      requiredNets: ["V3_3", "GND"],
      maxErrors: 0,
    },
  },
  {
    id: "usb-c-builtin",
    title: "Use the semantic built-in USB-C connector",
    category: "full-design",
    userPrompt: "Add a USB-C power input",
    initialTsx: EMPTY_BOARD,
    expectations: {
      components: [
        { name: "USBC1", elementTag: "connector", props: { standard: "usb_c" } },
      ],
      requiredNets: ["VBUS", "GND"],
      maxErrors: 0,
    },
  },
  {
    id: "datasheet-before-ic",
    title: "Verify a non-trivial IC before placement",
    category: "datasheet",
    userPrompt: "Add a TP4056 Li-ion charger",
    initialTsx: EMPTY_BOARD,
    expectations: {
      components: [{ name: "U1" }],
      requiredTools: ["search_jlcpcb", "fetch_datasheet", "import_component"],
      maxErrors: 0,
    },
  },
  {
    id: "footprint-verification",
    title: "Verify an uncertain package before using it",
    category: "component-selection",
    userPrompt: "Add an AO3400 MOSFET with the correct footprint",
    initialTsx: EMPTY_BOARD,
    expectations: {
      components: [{ name: "Q1", elementTag: "mosfet", props: { footprint: "sot23" } }],
      requiredTools: ["lookup_footprint"],
      maxErrors: 0,
    },
  },
  {
    id: "stable-designators",
    title: "Add a component without renaming existing references",
    category: "component-edit",
    userPrompt: "Add a 100 nF decoupling capacitor for the LED supply",
    initialTsx: BASIC_LED,
    expectations: {
      componentCount: 3,
      components: [
        { name: "R1" },
        { name: "LED1" },
        { name: "C1", elementTag: "capacitor", props: { capacitance: "100nF" } },
      ],
      maxErrors: 0,
    },
  },
  {
    id: "board-constraints",
    title: "Respect explicit board dimensions and layer count",
    category: "placement",
    userPrompt: "Make the board 40 by 25 mm and keep it two-layer",
    initialTsx: EMPTY_BOARD,
    expectations: {
      board: { width: "40mm", height: "25mm", layers: 2 },
      maxErrors: 0,
    },
  },
  {
    id: "repair-invalid-selector",
    title: "Recover from an invalid pin selector",
    category: "repair",
    userPrompt: "Fix the broken U1 power connections",
    initialTsx: EMPTY_BOARD,
    expectations: {
      connections: [
        { from: "U1.VCC", to: "net.VCC" },
        { from: "U1.GND", to: "net.GND" },
      ],
      requiredNets: ["VCC", "GND"],
      maxErrors: 0,
      maxRepairAttempts: 2,
    },
  },
];
