// Dark-mode palette for the read-only schematic viewer.
//
// @tscircuit/schematic-viewer renders the whole schematic as an SVG and exposes
// exactly one theming knob: `colorOverrides` (a Partial of circuit-to-svg's
// schematic color map, merged over the defaults). It styles the SVG *and* the
// viewer's own container background (auto-derived from the SVG background), so a
// single override object flips the entire canvas dark.
//
// Philosophy — "lights off", not a re-theme. The light palette is the familiar
// KiCad-style scheme (green nets, red component outlines, light component body,
// teal value/reference labels). Dark mode keeps that exact color *language* and
// only:
//   1. inverts the background (light paper → dark) + grid,
//   2. keeps every hue, adjusting lightness for the dark bg — dark reds/teals/
//      blues and near-black text are lightened so they stay legible; the green
//      nets are brightened for contrast; the once-light component body drops to a
//      deep, recessed fill so it doesn't glare,
//   3. flips the label background (white → dark translucent).
// Net/component hues are preserved — nets stay GREEN, components stay RED. The
// component body is the one exception: its light fill would glare on dark, so it
// drops to a deep indigo that recesses while still reading as the body. An earlier
// version went further and re-themed nets to cyan and the body to a flat dark
// gray that vanished into the bg; that broke recognizability and readability.
//
// Values are concrete strings (not var() aliases) because they're threaded into
// SVG fill/stroke attributes, not CSS. Light mode returns undefined → the viewer
// keeps its built-in light palette unchanged.

import type { ColorOverrides } from "circuit-to-svg";

// Same hues as the upstream light palette, tuned in lightness for the dark bg.
const RED = "rgb(244, 63, 63)"; // upstream component/pin dark red rgb(132,0,0)
const RED_NUM = "rgb(250, 92, 92)"; // upstream pin_number rgb(169,0,0)
const GREEN = "rgb(34, 214, 84)"; // upstream wire/junction green rgb(0,150,0)
const GREEN_CROSS = "rgb(82, 230, 122)"; // upstream wire_crossing rgb(30,180,30)
const TEAL = "rgb(74, 168, 168)"; // upstream value/reference/pin_name rgb(0,100,100)
const BLUE = "rgb(98, 128, 230)"; // upstream bus/no_connect/note dark blue
const PURPLE = "rgb(190, 112, 190)"; // upstream fields rgb(132,0,132)
const TEXT = "rgb(222, 225, 232)"; // near-black labels/cursor → light on dark
const MUTED = "rgb(150, 150, 156)"; // dark grays (aux_items/table) → readable

// Only the keys that change for the dark theme are listed. Everything omitted
// (net_name, hidden, brightened, shadow, erc_*) keeps its upstream value.
const SCHEMATIC_DARK: NonNullable<ColorOverrides["schematic"]> = {
  background: "#18191c",
  grid: "#2a2c31",
  grid_axes: "rgb(70, 92, 170)",

  // Nets: keep the GREEN hue, brightened for contrast/visibility on the dark bg.
  wire: GREEN,
  junction: GREEN,
  wire_crossing: GREEN_CROSS,

  // Components: keep the RED hue, lightened for the dark bg. The body drops from
  // its light fill to a deep indigo so it recesses without glaring on dark.
  component_outline: RED,
  pin: RED,
  pin_number: RED_NUM,
  component_body: "rgb(42, 36, 62)", // deep indigo (upstream is light yellow rgb(255,255,194))
  // Net labels (label_global, used for both the tag outline and its text) share
  // the component color in the light theme (upstream rgb(132,0,0) == the
  // component red), so they track it in dark too — same color as components.
  label_global: RED,

  // Buses / connection markers: dark blue is nearly invisible on dark — lighten.
  bus: BLUE,
  bus_junction: BLUE,
  no_connect: BLUE,
  note: BLUE,

  // Teal value/reference/pin-name labels, lightened.
  reference: TEAL,
  value: TEAL,
  pin_name: TEAL,
  fields: PURPLE,

  // Text that was near-black in light → light on dark.
  label_local: TEXT,
  label_hier: "rgb(196, 168, 90)", // upstream olive rgb(114,86,0), lightened
  cursor: TEXT,
  aux_items: MUTED,
  table: MUTED,
  label_background: "rgba(24, 25, 28, 0.6)",

  // Group / sheet framing (rare in our circuits) kept legible.
  sheet: RED,
  sheet_name: TEXT,
  sheet_label: TEXT,
  sheet_fields: PURPLE,
  sheet_filename: MUTED,
  worksheet: RED,
};

const DARK_OVERRIDES: ColorOverrides = { schematic: SCHEMATIC_DARK };

// Returns the colorOverrides to hand the viewer, or undefined to keep its
// built-in light palette.
export function getSchematicColorOverrides(
  theme: "light" | "dark"
): ColorOverrides | undefined {
  return theme === "dark" ? DARK_OVERRIDES : undefined;
}
