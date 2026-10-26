import { connector, dualHeader, header, numbered, passive } from "./partKit"
import { makeBoxSymbol } from "./symbols"
import type { PartDef } from "./types"

/** DIP IC socket: pins down the left from pin 1 and up the right, as the chip it holds. */
function dipSocket(n: number, wide = false): PartDef {
  const pins = Array.from({ length: n }, (_, i) => ({ number: String(i + 1), name: String(i + 1) }))
  return {
    id: `socket_dip${n}`,
    name: `IC Socket DIP-${n}`,
    category: "Connectors",
    description: `${n}-pin DIP socket, ${wide ? "15.24" : "7.62"} mm rows, for a socketed through-hole IC`,
    refPrefix: "XU",
    pins: pins.map((p) => ({ ...p, kind: "passive" })),
    symbol: makeBoxSymbol({ left: pins.slice(0, n / 2), right: pins.slice(n / 2).reverse() }),
    footprints: [wide ? `dip${n}_w15.24mm` : `dip${n}`],
    defaultProps: {},
    keywords: ["socket", "ic socket", "dip socket", "dil", "turned pin"],
    body3d: { height: 4.2, color: "#151517" },
  }
}

const SCREW_KEYWORDS = ["terminal block", "screw terminal", "phoenix", "power input", "wire"]

/** Phoenix Contact screw terminal block on a library footprint. */
const phoenixBlock = (series: string, n: number, pitch: string, mpn: string, footprint: string): PartDef =>
  connector({
    id: `phoenix_${series.toLowerCase()}_${n}`,
    name: `Phoenix ${series} ${n}P`,
    description: `Phoenix Contact ${series} screw terminal block, ${pitch} mm pitch, ${n} positions`,
    footprints: [footprint],
    pins: numbered(n),
    mpn,
    keywords: [...SCREW_KEYWORDS, series.toLowerCase(), `${pitch}mm`],
    body3d: { height: series === "PT" ? 8.4 : 10, color: "#2f7d4f" },
  })

/** Phoenix Contact right-angle header for a pluggable screw plug. */
const phoenixHeader = (series: string, n: number, pitch: string, mpn: string, footprint: string): PartDef =>
  connector({
    id: `phoenix_${series.toLowerCase()}_${n}`,
    name: `Phoenix ${series} ${n}P`,
    description: `Phoenix Contact ${series} pluggable terminal header, right angle, ${pitch} mm pitch, ${n} positions`,
    footprints: [footprint],
    pins: numbered(n),
    mpn,
    keywords: ["pluggable terminal block", "terminal header", "phoenix", "combicon", series.toLowerCase(), `${pitch}mm`],
    body3d: { height: series === "MC" ? 6.6 : 9.2, color: "#2f7d4f" },
  })

/** Vertical JST wire-to-board header. */
const jst = (series: "PH" | "XH", n: number): PartDef =>
  connector({
    id: `jst_${series.toLowerCase()}_${n}`,
    name: `JST ${series} ${n}P`,
    description: `JST ${series} ${series === "PH" ? "2.0" : "2.5"} mm wire-to-board header, vertical, ${n} positions`,
    footprints: [`jst_${series.toLowerCase()}_${n}`],
    pins: numbered(n),
    mpn: series === "PH" ? `B${n}B-PH-K-S(LF)(SN)` : `B${n}B-XH-A(LF)(SN)`,
    keywords: ["jst", series.toLowerCase(), "wire to board", "battery", "lipo", "connector"],
    body3d: { height: series === "PH" ? 6 : 7, color: "#efe8d7" },
  })

export const CONNECTOR_PARTS: PartDef[] = [
  ...[2, 3, 4, 5, 6, 8, 10].map((n) => header(n)),
  ...[2, 3, 4, 5, 6, 8, 10].map((n) => header(n, true)),
  dualHeader(3, { name: "ISP Header 2x3", description: "2.54 mm 2x3 header, the AVR in-system programming connector", keywords: ["isp", "icsp", "avr", "programming"] }),
  dualHeader(5),
  dualHeader(20, { name: "Pin Header 2x20", description: "2.54 mm 2x20 header, the Raspberry Pi GPIO connector", keywords: ["raspberry pi", "gpio", "hat"] }),
  dipSocket(8),
  dipSocket(14),
  dipSocket(16),
  dipSocket(28),
  {
    id: "screw_terminal_2",
    name: "Screw Terminal 2P",
    category: "Connectors",
    description: "5.08 mm pitch 2-position screw terminal",
    refPrefix: "J",
    pins: passive(["1", "1"], ["2", "2"]),
    symbol: makeBoxSymbol({
      right: [
        { number: "1", name: "1" },
        { number: "2", name: "2" },
      ],
    }),
    footprints: ["pinrow2_p5.08mm", "pinrow2_p5mm_id1.3mm_od2.6mm", "terminal_block_5mm_2"],
    defaultProps: {},
    keywords: ["terminal block", "power input", "wire"],
    body3d: { height: 10, color: "#2f7d4f" },
  },
  {
    id: "screw_terminal_3",
    name: "Screw Terminal 3P",
    category: "Connectors",
    description: "5.0 mm pitch 3-position screw terminal",
    refPrefix: "J",
    pins: passive(["1", "1"], ["2", "2"], ["3", "3"]),
    symbol: makeBoxSymbol({
      right: [
        { number: "1", name: "1" },
        { number: "2", name: "2" },
        { number: "3", name: "3" },
      ],
    }),
    footprints: ["pinrow3_p5mm_id1.3mm_od2.6mm", "pinrow3_p5.08mm", "terminal_block_5mm_3"],
    defaultProps: {},
    keywords: ["terminal block", "sensor", "servo", "wire", "xy301v"],
    body3d: { height: 10, color: "#2f7d4f" },
  },
  phoenixBlock("MKDS", 2, "5.08", "1715721", "terminal_block_5.08mm_2"),
  phoenixBlock("MKDS", 3, "5.08", "1715734", "terminal_block_5.08mm_3"),
  phoenixBlock("MKDS", 4, "5.08", "1715747", "terminal_block_5.08mm_4"),
  phoenixBlock("PT", 2, "3.5", "1984617", "terminal_block_3.5mm_2"),
  phoenixBlock("PT", 3, "3.5", "1984620", "terminal_block_3.5mm_3"),
  phoenixHeader("MC", 2, "3.81", "1803277", "phoenix_mc_3.81mm_2"),
  phoenixHeader("MC", 3, "3.81", "1803280", "phoenix_mc_3.81mm_3"),
  phoenixHeader("MC", 4, "3.81", "1803293", "phoenix_mc_3.81mm_4"),
  phoenixHeader("MSTBA", 2, "5.08", "1757242", "phoenix_mstba_5.08mm_2"),
  phoenixHeader("MSTBA", 3, "5.08", "1757255", "phoenix_mstba_5.08mm_3"),
  jst("PH", 2),
  jst("PH", 3),
  jst("PH", 4),
  jst("XH", 2),
  jst("XH", 3),
  jst("XH", 4),
  connector({
    id: "qwiic",
    name: "Qwiic / STEMMA QT",
    description: "JST SH 1.0 mm 4-pin I2C connector (GND, 3V3, SDA, SCL), SMD",
    footprints: ["qwiic_jst_sh_4"],
    pins: [
      ["2", "3V3"],
      ["3", "SDA"],
      ["4", "SCL"],
    ],
    bottom: [
      ["1", "GND"],
      ["5", "MP"],
    ],
    mpn: "SM04B-SRSS-TB(LF)(SN)",
    // Both mounting tabs are one pin, to tie to ground or leave unconnected.
    padAlias: { "6": "5" },
    keywords: ["qwiic", "stemma qt", "jst sh", "i2c", "sparkfun", "adafruit", "connector"],
    body3d: { height: 2.9, color: "#efe8d7" },
  }),
  connector({
    id: "usb_c",
    name: "USB-C Receptacle",
    description: "USB 2.0 Type-C receptacle, 16 contacts, SMD with through-hole shell tabs",
    footprints: ["usb_c_16p"],
    pins: [
      ["A4", "VBUS"],
      ["B4", "VBUS"],
      ["A5", "CC1"],
      ["B5", "CC2"],
      ["A6", "D+"],
      ["B6", "D+"],
      ["A7", "D-"],
      ["B7", "D-"],
      ["A8", "SBU1"],
      ["B8", "SBU2"],
    ],
    bottom: [
      ["A1", "GND"],
      ["B1", "GND"],
      ["S1", "SHIELD"],
    ],
    mpn: "USB4105-GF-A",
    padAlias: { S2: "S1", S3: "S1", S4: "S1" },
    keywords: ["usb", "usb-c", "type-c", "usb c", "type c", "receptacle", "power input", "connector"],
    body3d: { height: 3.2, color: "#c4c9cf" },
  }),
  connector({
    id: "micro_usb",
    name: "Micro-USB B",
    description: "Micro-USB B receptacle, SMD, shell overhangs the board edge",
    footprints: ["micro_usb_b"],
    pins: [
      ["1", "VBUS"],
      ["2", "D-"],
      ["3", "D+"],
      ["4", "ID"],
    ],
    bottom: [
      ["5", "GND"],
      ["S1", "SHIELD"],
    ],
    mpn: "10118192-0001LF",
    padAlias: { S2: "S1", S3: "S1", S4: "S1", S5: "S1", S6: "S1" },
    keywords: ["usb", "micro usb", "micro-b", "microusb", "receptacle", "power input", "connector"],
    body3d: { height: 2.6, color: "#c4c9cf" },
  }),
  connector({
    id: "barrel_jack",
    name: "DC Barrel Jack",
    description: "5.5 x 2.1 mm DC power jack, through-hole, centre pin is pin 1",
    footprints: ["barrel_jack_pj002a"],
    pins: [
      ["1", "+"],
      ["3", "SW"],
    ],
    bottom: [["2", "-"]],
    mpn: "PJ-002AH",
    keywords: ["dc jack", "barrel jack", "power jack", "power input", "5.5mm", "2.1mm", "wall adapter", "connector"],
    body3d: { height: 11, color: "#151517" },
  }),
  connector({
    id: "microsd",
    name: "microSD Socket",
    description: "microSD card socket, push-push with card detect, SMD",
    footprints: ["microsd_dm3at"],
    pins: [
      ["1", "DAT2"],
      ["2", "DAT3/CD"],
      ["3", "CMD"],
      ["4", "VDD"],
      ["5", "CLK"],
      ["6", "VSS"],
      ["7", "DAT0"],
      ["8", "DAT1"],
      ["9", "DET_A"],
      ["10", "DET_B"],
    ],
    bottom: [["11", "SHIELD"]],
    mpn: "DM3AT-SF-PEJM5",
    padAlias: { "12": "11", "13": "11", "14": "11" },
    keywords: ["sd card", "microsd", "tf card", "memory card", "spi", "socket", "connector"],
    body3d: { height: 1.8, color: "#c4c9cf" },
  }),
]
