import type { DrawingColor } from "../model/types"
import { useTheme } from "../store/themeStore"

// Canvas colours mirror the CSS tokens in index.css; SVG attributes need literal values.
export interface SchPalette {
  paper: string
  /** The canvas outside a sheet's page: a step darker than the paper, as Altium shades it. */
  outside: string
  grid: string
  /** The page's border, zones and title block. */
  frame: string
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
  outside: "#e9e7de",
  grid: "#b4b2a8",
  frame: "#7a5a52",
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
  outside: "#0e0c0f",
  grid: "#3a353a",
  frame: "#8a8088",
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
  // Drawings on the layers that are neither copper nor silkscreen: thin and muted, so they never read as copper.
  shapeMask: "rgba(96,200,120,0.75)",
  shapePaste: "rgba(205,205,215,0.7)",
  shapeFab: "rgba(175,165,200,0.8)",
  shapeAdhesive: "rgba(225,175,95,0.75)",
  shapeUser: "rgba(150,175,205,0.8)",
  select: "#ffffff",
  selectSoft: "rgba(255,255,255,0.08)",
  highlight: "rgba(255,255,255,0.35)",
  danger: "#ff4d57",
  warn: "#ffb547",
}

// Inner copper layers (X1, and the 32 layer boards): a colour for each of the thirty inner layers a board can have, in the stack's order, so a board reads at a
// glance whatever its layer count and every layer is told from the red top and the blue bottom. The first ten are the colours the editor began with; the other
// twenty were chosen one after another, each the colour farthest (in CIELAB) from all the ones before it and from the top and bottom, so no two of the 32 are
// closer than a clear difference (about 23 in CIELAB, `tests/layer-colors.test.ts`) and a layer's neighbours in the stack are never alike. The pour is the same hue, darker.
const INNER_COPPER = [
  "#37d67a", "#ffb02e", "#c26bff", "#27d3e6", "#f0e14a", "#ff6fb1", "#9bd13f", "#ff8a4c", "#5ab0ff", "#d4a5ff",
  "#10f910", "#e3cca0", "#1010f9", "#f910ca", "#da8581", "#4163c8", "#94f0c6", "#bf10f9", "#f9106d", "#d9f094",
  "#d6f910", "#a0c5e3", "#c84148", "#60fb68", "#e3a0c9", "#c89241", "#d161c6", "#f9109c", "#90f910", "#10f9ed",
]
/** A copper colour with its light taken down by a third, for the pour that lies under the traces. */
const darker = (hex: string) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.68).toString(16).padStart(2, "0")).join("")}`
const INNER_POUR = [
  "#1a9150", "#bf7f10", "#8a3ec9", "#12909e", "#b0a31a", "#c24a82", "#6c9422", "#c0561f", "#2f77c4", "#9a6ec2",
  ...INNER_COPPER.slice(10).map(darker),
]

/** The inner layers a colour is made for: KiCad's limit of 32 copper layers less the two outer ones. */
export const COLOURED_INNER_LAYERS = INNER_COPPER.length

/** The colour of a copper layer's tracks and pads, the one function every place that draws or lists a layer asks. `in1` is the first of the inner colours. */
export function copperColor(layer: string): string {
  if (layer === "top") return PCB.topCopper
  if (layer === "bottom") return PCB.bottomCopper
  const k = Number(layer.slice(2))
  return INNER_COPPER[(Math.max(1, Number.isFinite(k) ? k : 1) - 1) % INNER_COPPER.length]
}

/** The colour of a copper layer's pour. */
export function pourColor(layer: string): string {
  if (layer === "top") return PCB.topPour
  if (layer === "bottom") return PCB.bottomPour
  const k = Number(layer.slice(2))
  return INNER_POUR[(Math.max(1, Number.isFinite(k) ? k : 1) - 1) % INNER_POUR.length]
}
