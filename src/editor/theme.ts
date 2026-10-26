import type { DrawingColor } from "../model/types"
import { useTheme } from "../store/themeStore"

// Canvas colours mirror the CSS tokens in index.css; SVG attributes need literal values.
export interface SchPalette {
  paper: string
  grid: string
  /** Symbol body and pin lines. */
  outline: string
  /** Designators. */
  ink: string
  /** Values and pin names. */
  ink2: string
  ink3: string
  pinNumber: string
  /** Fill of box symbols (ICs, connectors). */
  body: string
  wire: string
  junction: string
  /** Net label fill and its text. */
  label: string
  labelInk: string
  /** Frames and titles of schematic blocks: thin lines and big titles, so they never read as wires. */
  block: string
  power: string
  select: string
  selectSoft: string
  highlight: string
  pinHover: string
  noConnect: string
  danger: string
  /** The colours of drawings (lines, shapes and text), each a shade that reads on this sheet. */
  drawing: Record<DrawingColor, string>
  /** Opacity of a drawing's fill, a soft tint of its colour. */
  tint: number
  stroke: number
  wireWidth: number
}

// Light follows the classic EDA sheet that Altium and KiCad users read without thinking:
// cream paper, blue wires and junctions, dark red symbols on pale yellow bodies, teal pin
// names. Selection is green so it never reads as a wire.
export const SCH_LIGHT: SchPalette = {
  paper: "#f8f7f1",
  grid: "#b4b2a8",
  outline: "#840000",
  ink: "#24211c",
  ink2: "#00605e",
  ink3: "#8d8a80",
  pinNumber: "#a10000",
  body: "#ffffc2",
  wire: "#1d3fae",
  junction: "#1d3fae",
  label: "#e3e9fb",
  labelInk: "#10297a",
  block: "#3a51c2",
  power: "#840000",
  select: "#109448",
  selectSoft: "rgba(16,148,72,0.08)",
  highlight: "rgba(16,148,72,0.3)",
  pinHover: "#109448",
  noConnect: "#1d3fae",
  danger: "#cf3a3d",
  drawing: {
    ink: "#24211c",
    gray: "#7d7a72",
    red: "#c02a2a",
    orange: "#c8600e",
    yellow: "#b08600",
    green: "#1f7f43",
    blue: "#3a51c2",
    purple: "#7a3fc4",
  },
  tint: 0.13,
  stroke: 0.02,
  wireWidth: 0.022,
}

// Dark: warm light ink on the plum-dark paper of the app's dark theme, box symbols raised a
// step off the paper, and bright copper wires so nets read first.
export const SCH_DARK: SchPalette = {
  paper: "#171419",
  grid: "#3a353a",
  outline: "#e6e1d8",
  ink: "#e6e1d8",
  ink2: "#a5a39d",
  ink3: "#7d7871",
  pinNumber: "#a5a39d",
  body: "#201c20",
  wire: "#e08b52",
  junction: "#e08b52",
  label: "#2f2119",
  labelInk: "#f6dcc6",
  block: "#8590d6",
  power: "#f2a673",
  select: "#6b97ff",
  selectSoft: "rgba(107,151,255,0.12)",
  highlight: "rgba(107,151,255,0.38)",
  pinHover: "#6b97ff",
  noConnect: "#6b97ff",
  danger: "#ff6b6b",
  drawing: {
    ink: "#e6e1d8",
    gray: "#9a958d",
    red: "#ff7a72",
    orange: "#f2a673",
    yellow: "#e9c75a",
    green: "#6fd294",
    blue: "#8f9bf0",
    purple: "#c59cff",
  },
  tint: 0.17,
  stroke: 0.02,
  wireWidth: 0.022,
}

/** Schematic colours for the current theme; components using it redraw when it changes. */
export const useSch = (): SchPalette => useTheme((s) => (s.scheme === "dark" ? SCH_DARK : SCH_LIGHT))

// Layout colours follow EDA convention so layers read at a glance: red top, blue bottom.
// Both copper layers are drawn opaque over a black substrate, so the clearance gaps of the
// front pour show the layer behind it and every trace and pad gets a contrasting outline.
export const PCB = {
  outside: "#121115",
  grid: "rgba(255,255,255,0.08)",
  gridMajor: "rgba(255,255,255,0.055)",
  board: "#050406",
  edge: "#e2cd6e",
  topCopper: "#ff3b3b",
  topPour: "#c4161f",
  bottomCopper: "#4a5bff",
  bottomPour: "#2d38c6",
  pad: "#efb1ec",
  padBack: "#a77fb8",
  plating: "#5fe0a6",
  via: "#d6d2df",
  hole: "#19181d",
  silk: "#45ecff",
  silkBottom: "#e27cff",
  label: "#ffffff",
  labelHalo: "rgba(8,6,10,0.92)",
  ratsnest: "rgba(255,255,255,0.72)",
  courtyard: "rgba(110,240,175,0.7)",
  select: "#ffffff",
  selectSoft: "rgba(255,255,255,0.08)",
  highlight: "rgba(255,255,255,0.35)",
  danger: "#ff4d57",
  warn: "#ffb547",
}
