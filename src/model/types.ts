// Core document model. World coordinates are y-up in both editors:
// schematic units are on a 0.1 grid, KiCad's 50 mil (see model/symbols.ts); PCB units are millimetres.

import type { ShapePath } from "./shapes"

export interface Vec2 {
  x: number
  y: number
}

export type Rotation = 0 | 90 | 180 | 270
export type PcbSide = "top" | "bottom"
/**
 * A copper layer by its place in the board's stack: `top` is the front, `bottom` the back, and the layers between are
 * `in1` (the one under the front) to `in30`, in order (X1). A board has two to 32 copper layers (`BoardDef.stack`): without
 * a stack it has `top` and `bottom` only, as every board drawn in the editor does.
 */
export type CopperLayer = "top" | "bottom" | `in${number}`

// ---------- Library definitions ----------

/** KiCad's line styles; a line with none of these is solid. */
export type StrokeDash = "dash" | "dot" | "dash_dot" | "dash_dot_dot"

/** How a closed shape is filled: with the outline's colour, the symbol's body colour, or a colour of its own. */
export type FillKind = "outline" | "background" | "color"

/**
 * What a drawn shape looks like beyond its outline (S6). Every field absent is the editor's own
 * look, which is what its own symbols have: a shape of an imported symbol has the width, dash,
 * colour and fill its file gave it, exactly.
 */
export interface ShapeLook {
  /** Line width in schematic units (KiCad's millimetres over 12.7); absent is the editor's own width. */
  width?: number
  dash?: StrokeDash
  /** The line's colour, `#rrggbb` or `rgba(r,g,b,a)`; absent is the symbol's own colour. */
  color?: string
  /** `background` and `color` fills; a plain `fill: true` is the `outline` one. */
  fillKind?: Exclude<FillKind, "outline">
  fillColor?: string
}

export type SymbolPrimitive =
  | { type: "path"; points: Vec2[]; fill: boolean; width?: number; look?: ShapeLook }
  | { type: "circle"; x: number; y: number; radius: number; fill: boolean; look?: ShapeLook }
  /** A circular arc through three points, as KiCad keeps it: from `start` through `mid` to `end`. */
  | { type: "arc"; start: Vec2; mid: Vec2; end: Vec2; fill: boolean; look?: ShapeLook }
  /** A cubic Bezier curve: two ends and two control points, in order. */
  | { type: "bezier"; points: [Vec2, Vec2, Vec2, Vec2]; fill: boolean; look?: ShapeLook }
  /** An ellipse, or the arc of one from `from` to `to` (degrees); `rotation` turns it about its centre. */
  | { type: "ellipse"; x: number; y: number; rx: number; ry: number; rotation: number; from?: number; to?: number; fill: boolean; look?: ShapeLook }
  | {
      type: "text"
      text: string
      x: number
      y: number
      anchor: TextAnchor
      size?: number
      role?: "ref" | "value" | "pin" | "pinNumber" | "label"
      /** Runs along its pin instead of across the symbol, e.g. long names of top and bottom pins. */
      alongPin?: boolean
      /** Text of an imported symbol: its angle in degrees (0 across, 90 up) in the symbol's own frame. */
      angle?: number
      bold?: boolean
      italic?: boolean
      /** The text's colour of its own. */
      color?: string
    }

export type TextAnchor =
  | "middle"
  | "middle_top"
  | "middle_bottom"
  | "middle_left"
  | "middle_right"
  | "top_left"
  | "top_right"
  | "bottom_left"
  | "bottom_right"
  | "center"

export interface SymbolPort {
  pin: string
  x: number
  y: number
  /** Direction a wire leaves the pin, in symbol space. */
  dir: "left" | "right" | "up" | "down"
  /** KiCad's electrical type of the pin, where the symbol came from KiCad. */
  type?: PinType
  /** A pin that is not drawn. A hidden power-input pin is on the global net of its name. */
  hidden?: true
}

/** The name and number of a pin of an imported symbol, which are laid out by the pin's way in the sheet, not the symbol's (`model/pinText.ts`). */
export interface PinLabel {
  number: string
  name: string
  /** Where a wire meets the pin, in the symbol's frame. */
  x: number
  y: number
  /** The unit vector from there toward the body. */
  dx: number
  dy: number
  length: number
  nameSize: number
  numberSize: number
  /** The largest name size among the symbol's pins: names above their pins all stand clear of the biggest. */
  maxNameSize: number
  showName: boolean
  showNumber: boolean
}

export interface SymbolDef {
  primitives: SymbolPrimitive[]
  ports: SymbolPort[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** S7: the body alone, without its pins, where the symbol is drawn from KiCad's: what a do-not-populate cross covers. */
  bodyBounds?: { minX: number; minY: number; maxX: number; maxY: number }
  /** Pins whose names and numbers are laid out as KiCad lays them out. Absent for the editor's own symbols, which carry their texts as primitives. */
  pinLabels?: PinLabel[]
  /** Pin names are drawn this far inside the body (0: above the pin line). */
  pinNameOffset?: number
}

/** KiCad's electrical pin types: `PinDef.kind` is the editor's coarser role, this is what ERC compares. */
export type PinType =
  | "input"
  | "output"
  | "bidirectional"
  | "tri_state"
  | "passive"
  | "free"
  | "unspecified"
  | "power_in"
  | "power_out"
  | "open_collector"
  | "open_emitter"
  | "no_connect"

/** How KiCad draws the end of a pin. */
export type PinShape = "line" | "inverted" | "clock" | "inverted_clock" | "input_low" | "clock_low" | "output_low" | "edge_clock_high" | "non_logic"

/** A function a pin can be switched to on one placed symbol (a pin alternate). */
export interface PinAlternate {
  name: string
  type: PinType
  shape: PinShape
}

export interface PinDef {
  /** Pin number; matches footprint pad numbers. */
  number: string
  name: string
  /** Electrical role, used for ERC-lite checks and box symbol placement. */
  kind?: "passive" | "input" | "output" | "power" | "ground" | "io" | "nc"
  /** KiCad's electrical type, where it is known. */
  type?: PinType
  /** The symbol gives the pin no name (`~`): `name` is its number, so the editor has something to call it, and an export writes it empty. */
  unnamed?: true
  /** Functions the pin can be switched to (`ComponentInstance.pinAlt` says which one a placed symbol uses). */
  alternates?: PinAlternate[]
}

export type PadShape = "rect" | "circle" | "pill" | "polygon"

export interface PadDef {
  pin: string | null
  shape: PadShape
  x: number
  y: number
  width: number
  height: number
  /** Present for polygon pads, relative to the footprint origin. */
  points?: Vec2[]
  /** Through-hole when set; pad exists on both copper layers. */
  holeDiameter?: number
  /**
   * Overall length of a slotted (oval) hole, measured along the pad's longer side. The slot is
   * holeDiameter wide. Connector shell tabs and jack lugs need these.
   */
  slotLength?: number
  layer: "top" | "through"
  /**
   * A pad KiCad draws as an oval that is as wide as it is tall: a circle to look at and to route to, but its thermal relief spokes
   * lie along its axes where a circle's lie at 45 degrees. Set by the KiCad import only.
   */
  axisSpokes?: true
  /**
   * False for a non-plated hole (NPTH): a bare drill with no copper, pin null and
   * width = height = holeDiameter. It is an obstacle for copper but never part of a net.
   */
  plated?: false
  /**
   * The exposed (thermal) pad of a no-lead package, numbered one past its last lead (17 on a
   * QFN-16). A part may list it as a pin, usually ground, or leave it unconnected.
   */
  exposed?: true
  // ---------- X7, the pad model: everything below is optional, and an absent field is what a pad was before it ----------
  /**
   * The number the KiCad file gives the pad, which the KiCad export writes back. Absent when it is `pin` (and, for a pad
   * with no pin, when it has no number). Pads that share a number but carry different nets each have a pin of their
   * own and share this; an unnumbered pad that carries a net has a pin of its own and this is the empty string.
   */
  number?: string
  /**
   * The pad's own turn within its part, in degrees counter-clockwise, when it is not a whole quarter turn (a quarter
   * turn is the size's width and height swapped, so lands from before keep the pads they had). `x`, `y`, `width` and
   * `height` are the pad as it is before the turn, about its centre; `points` of a polygon pad are never turned.
   */
  rot?: number
  /** A rectangle with rounded corners: the radius is this times the shorter side, 0 to 0.5 (KiCad's `roundrect_rratio`). */
  round?: number
  /**
   * A rectangle with chamfered corners: the size of the cut is `ratio` times the shorter side; `corners` is a sum of 1
   * (top left), 2 (top right), 4 (bottom right) and 8 (bottom left) as the pad is seen, before its turn.
   */
  chamfer?: { ratio: number; corners: number }
  /**
   * A custom pad: its copper is the anchor (a circle of diameter `width`, or the rectangle `width` by `height`, about `x`, `y`)
   * with these drawings added, each with its line width and fill, in the pad's frame about its centre before its turn. `hull`:
   * a pour keeps its clearance from the convex hull of the pad instead of its outline (KiCad's `clearance convexhull`).
   */
  custom?: { anchor: "circle" | "rect"; shapes: BoardShape[]; hull?: true; proxy?: BoardShape[] }
  /**
   * The hole's place relative to the pad's centre, in the pad's frame before its turn (KiCad's drill `offset` moves the copper
   * from the hole, so this is its negative).
   */
  holeOffset?: Vec2
  /**
   * Which way a slotted hole runs in the pad's frame before its turn, in degrees: 0 along x, 90 along y (a polygon pad, which has no
   * turn, any angle). Absent is along the pad's longer side, which is what a slot has always done; the field is for one across it
   * (and for a square pad).
   */
  holeAxis?: number
  /** The layers the pad is on where they are not what its kind has (`padFaces`). Sides are relative to the part's own side. */
  layers?: PadLayers
  /** The mask opening's margin round the pad, the paste margin, and its ratio of the pad's size; each replaces the board's (KiCad's `solder_mask_margin`, `solder_paste_margin`, `solder_paste_margin_ratio`). */
  maskMargin?: number
  pasteMargin?: number
  pasteRatio?: number
  /** The clearance copper of another net keeps from this pad, replacing the net classes' (KiCad's local `clearance`). */
  clearance?: number
  /** How a pour joins the pad (KiCad's `zone_connect`: none, thermal relief, solid, thermal relief on through-hole pads only), and the thermal relief's own gap and spoke width. */
  zoneConnect?: ZoneConnect
  thermalGap?: number
  thermalWidth?: number
  /** A turn of the thermal spokes in degrees, from the pad's own axes. */
  thermalAngle?: number
  /** KiCad's fabrication property (`bga`, `fiducial_glob`, `fiducial_loc`, `testpoint`, `castellated`, `heatsink`, `mechanical`, `pressfit`). */
  property?: PadProperty
  /**
   * X1, a pad stack (KiCad 9's `padstack`): the copper shape of a layer that is not the pad's own. The fields above are the part's own side
   * (KiCad's front layer); `stack` says what the other layers have where it differs, in the pad's frame about its place. The hole is the
   * pad's alone.
   */
  stack?: PadStack
  /** X1, KiCad's `remove_unused_layers` and `keep_end_layers`: what becomes of the pad's copper on a layer nothing connects to on it. Absent keeps every layer. */
  unused?: "remove" | "keepEnds"
  /**
   * X31, KiCad's pad `zone_layer_connections`: the copper layers a pour joins the pad on when its unused layers are removed, as ids of a board seen from the part's own
   * side (a part on the bottom turns them over). The pad keeps its copper on those layers, and on the others only where a track, a via or a pad touches it. `[]` is no layer; absent
   * is no setting (the pad then keeps the layers it has by what touches it). It has an effect only with `unused`.
   */
  zoneLayers?: CopperLayer[]
  /**
   * X5, KiCad's pad `tenting`: whether the mask is closed over the pad on its own side (`top`) and on the far one (`bottom`), where the pad says. A side it does not say
   * follows the mask layers of the pad (`layers.mask`) as ever.
   */
  tent?: { top?: boolean; bottom?: boolean }
}

/** What one layer of a pad stack has where it is not the pad's own: its shape and size and the pour settings that go with them. */
export type PadLayerShape = Partial<Pick<PadDef, "shape" | "x" | "y" | "width" | "height" | "points" | "rot" | "round" | "chamfer" | "custom" | "clearance" | "zoneConnect" | "thermalGap" | "thermalWidth" | "thermalAngle">>

/**
 * KiCad's two kinds of pad stack: `front_inner_back`, one shape for the front (the pad's own), one for every inner layer (`inner`) and one for
 * the back (`far`), and `custom`, a shape for every layer on its own. A layer is named by its id in a board seen from the part's own side
 * (`in1` is the first inner layer under the part's face, `bottom` the far side), as `PadLayers.inner` is, and a layer that is not named has
 * the pad's own shape.
 */
export interface PadStack {
  mode: "front_inner_back" | "custom"
  layers: { inner?: PadLayerShape } & Partial<Record<CopperLayer, PadLayerShape>>
}

/** The sides a layer of a pad is on, relative to the part's own side (a part on the bottom turns them over). */
export type PadSides = "top" | "bottom" | "both" | "none"

/** Where a pad has copper, solder mask, paste and silkscreen, for a field the pad's kind does not settle. */
export interface PadLayers {
  copper?: PadSides
  mask?: PadSides
  paste?: PadSides
  silk?: PadSides
  /**
   * X1: the inner copper layers the pad has copper on, as ids of a board seen from the part's own side (`in1` is the one under the
   * part's own face; a part on the bottom turns them over). Absent is what the pad's kind has: every inner layer for a through-hole
   * pad whose copper is on both sides (KiCad's `*.Cu`), none for any other. `[]` is none on a pad that would have them (a through-hole
   * pad whose layers name `F.Cu` and `B.Cu` only).
   */
  inner?: CopperLayer[]
  /** Other layers of the part the pad is on (fabrication, courtyard, user), by KiCad's name with `F.` the part's own side: kept and written back, drawn nowhere. */
  other?: string[]
}

export type ZoneConnect = "none" | "thermal" | "solid" | "tht"

export type PadProperty = "bga" | "fiducial_glob" | "fiducial_loc" | "testpoint" | "castellated" | "heatsink" | "mechanical" | "pressfit"

// ---------- Board and footprint graphics ----------

/** How a drawing's line is broken up, as KiCad's stroke types: absent is a solid line. */
export type ShapeDash = "dash" | "dot" | "dash_dot" | "dash_dot_dot"

/**
 * A corner of a polygon outline. `mid` makes the edge from the previous corner (the last one, for
 * the first) an arc through `mid` instead of a straight line, as KiCad's polygons can have.
 */
export interface ShapePoint extends Vec2 {
  mid?: Vec2
}

/**
 * What a drawing is, in millimetres in the frame it is held in (the board's for a board drawing, the
 * footprint's for a land's, y up). An arc is held as KiCad holds it, by three points on it: the
 * circle and the way round follow from them, so nothing is rounded to an angle. An ellipse's
 * `rot` is its major axis' angle (counter-clockwise, degrees); with `from` and `to` (the parameter
 * `t` of `(rx cos t, ry sin t)`, degrees, counter-clockwise from `from` to `to`) it is an elliptical arc.
 */
export type ShapeGeometry =
  | { type: "line"; a: Vec2; b: Vec2 }
  | { type: "arc"; start: Vec2; mid: Vec2; end: Vec2 }
  | { type: "circle"; c: Vec2; r: number }
  | { type: "rect"; a: Vec2; b: Vec2; radius?: number }
  | { type: "polygon"; pts: ShapePoint[]; holes?: ShapePoint[][] }
  | { type: "curve"; p0: Vec2; c1: Vec2; c2: Vec2; p1: Vec2 }
  | { type: "ellipse"; c: Vec2; rx: number; ry: number; rot: number; from?: number; to?: number }

/** What every drawing has, whatever it is. */
export interface ShapeStyle {
  /**
   * KiCad's name for the layer: `F.SilkS`, `B.Mask`, `F.Fab`, `Dwgs.User`, `User.7`, `F.Cu`... On a
   * land, `F.` is the part's own side and `B.` the other, so a part flipped to the bottom draws it on the other side.
   */
  layer: string
  /** Stroke width (mm). A filled shape is also outlined by it. */
  width: number
  dash?: ShapeDash
  /** Filled solid, as well as outlined by `width`. Only closed shapes can be. */
  fill?: true
  /** The net of copper that has one, by the project's net name; absent for a drawing with none. */
  net?: string
  locked?: true
}

/** A drawing: a line, arc, circle, rectangle, polygon, curve or ellipse on a named layer. */
export type BoardShape = ShapeStyle & ShapeGeometry

/** A drawing on the board itself (`Project.graphics`). */
export type BoardGraphic = BoardShape & { id: string }

// ---------- dimensions, groups and reference images (X11, X12, X14) ----------

/** KiCad's five kinds of dimension: a measured distance along the line between two points, one along an axis, a leader with text, a centre mark, a radius. */
export type DimensionKind = "aligned" | "orthogonal" | "leader" | "center" | "radial"

/**
 * A dimension, as KiCad holds it (`PCB_DIMENSION_BASE` and its subclasses, pcbnew/pcb_dimension.cpp), in millimetres in the frame it is
 * held in (the board's for a board dimension, the land's for a part's, y up). What it draws (extension lines, the crossbar, arrows, the
 * measured text) is worked out from this by KiCad's own rules (`model/dimensions.ts`) and is never stored. The numbers named "as KiCad
 * has it" keep KiCad's own sign, which is measured in its frame (y down): `height` is positive when the extension lines point along
 * (-dy, dx) of the vector from `a` to `b` in that frame.
 */
export interface BoardDimension {
  id: string
  kind: DimensionKind
  /** KiCad's name of the layer, as a drawing's. */
  layer: string
  /** The points measured (start and end); for a centre mark its centre and the end of one arm; for a radius its centre and a point on the circle; for a leader the tip of its arrow and the end of its line. */
  a: Vec2
  b: Vec2
  /** Aligned and orthogonal: the distance from the points to the crossbar, as KiCad has it. */
  height?: number
  /** Orthogonal: measures along y; absent is along x. */
  vertical?: true
  /** Aligned and orthogonal: how far the extension lines go past the crossbar. */
  extHeight: number
  /** How far the extension lines start from the points. */
  extOffset: number
  /** Radial: the length of the line past the circle. */
  leaderLength?: number
  /** Leader: a frame round the text, 1 a rectangle, 2 a circle, 3 a rounded rectangle; absent none. */
  frame?: 1 | 2 | 3
  /** The line width and the arrow's length. */
  thickness: number
  arrow: number
  /** The arrows point inwards (from outside the crossbar); absent is outwards. */
  inward?: true
  /** Where the text sits: 1 on the crossbar, 2 where the text is put by hand; absent is outside the crossbar. */
  textMode?: 1 | 2
  /** The text turns with the crossbar. */
  keep?: true
  /** The units of the measured value (0 inches, 1 mils, 2 millimetres, 3 automatic), how they show (0 none, 1 after the value, 2 in brackets) and the digits (KiCad's `precision`, 0 to 9). */
  units: number
  format: number
  precision: number
  /** Trailing zeros are left off. */
  zeros?: true
  prefix?: string
  suffix?: string
  /** The text in place of the measured value. */
  override?: string
  /** The text's own attributes: where, how it turns, how big and how it is drawn; `size` is the glyph height. */
  x: number
  y: number
  rot: number
  size: number
  w?: number
  tw?: number
  bold?: true
  italic?: true
  mirror?: true
  hj?: "left" | "right"
  vj?: "top" | "bottom"
  spacing?: number
  locked?: true
}

/**
 * A KiCad group (`PCB_GROUP`): items that are picked, moved, turned and locked together. `members` are the ids of what is in it: on the
 * board any object by its id (a part, a trace, a via, a drawing, a text, a dimension, an image, another group); in a part (`ComponentInstance.groups`)
 * the part's own things by place (`p3` the land's fourth pad, `s0` its first drawing, `t2` the part's third text, `d0` its first dimension, `g1` its second group).
 */
export interface PcbGroup {
  id: string
  name: string
  members: string[]
  locked?: true
  /** The design block the group was made from (KiCad 10). */
  lib?: string
}

/** A bitmap on a layer (KiCad's reference image). Its bytes are a model file kept by the host (`store/modelFiles.ts`); the project holds only their id. */
export interface ReferenceImage {
  id: string
  /** Its centre on the board. */
  x: number
  y: number
  layer: string
  /** KiCad's scale factor of the image; its size on the board is its pixels at `ppi` times this. */
  scale: number
  /** The model file's id (the SHA-256 of the bytes, lowercase hex), its format, and its size in pixels and resolution. */
  file: string
  format: "png" | "jpg"
  px: number
  py: number
  ppi: number
  locked?: true
}

export interface FootprintDef {
  name: string
  pads: PadDef[]
  silk: Vec2[][]
  courtyard: { minX: number; minY: number; maxX: number; maxY: number }
  /**
   * The footprint's drawings (a board brought in from KiCad has them on every layer): silkscreen,
   * mask, paste, fabrication, courtyard, user layers and copper. A land with no pads has these and
   * nothing else (a logo, a mounting hole's drawing). `silk` and `courtyard` stay what they were, so
   * a land from the library or the footprinter reads as before and has none of these.
   */
  shapes?: BoardShape[]
  /**
   * The footprint has no courtyard of its own (a logo, a drawing): `courtyard` is only the box of its
   * drawings, for selecting it, and the checks that need a courtyard leave it out.
   */
  noCourtyard?: true
  /**
   * X30: the zones drawn inside the footprint (keepouts, and pours on no net), in the land's frame, which is the part's own side's: they move, turn and flip with every part that has the land
   * (`partZones.ts` puts them on the board). Their ids (`z0`, `z1`...) name their place in the land; none has a net, a uuid or a priority tie to break against the board's zones.
   */
  zones?: Zone[]
  /**
   * The package's own name where a source gave one (KiCad's `SOIC-8_3.9x4.9mm_P1.27mm`, a
   * supplier's `SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL`), kept as it was given.
   */
  package?: string
}

// ---------- Symbol drawings (S10) ----------

/** What every item of a drawing says: which unit and body style it is drawn in, and how it looks. */
export interface DrawingBase {
  /** The unit it belongs to; absent or 0 is every unit. */
  unit?: number
  /** The body style it belongs to; absent or 0 is every style. */
  body?: number
  /** Line width in schematic units; absent is KiCad's default width. */
  width?: number
  dash?: StrokeDash
  color?: string
  /** Absent is no fill. */
  fill?: FillKind
  fillColor?: string
  /** KiCad's private items: kept, and not drawn on a sheet. */
  private?: true
}

export interface DrawingTextStyle {
  /** Text height in schematic units. */
  size?: number
  bold?: true
  italic?: true
  /** Absent is centred. */
  h?: "left" | "right"
  v?: "top" | "bottom"
  hidden?: true
  color?: string
  thickness?: number
}

/** One drawn item of a symbol, in the symbol's own frame (schematic units, y up), as KiCad's cache has it. */
export type DrawingItem =
  | ({ kind: "polyline"; points: Vec2[] } & DrawingBase)
  | ({ kind: "rectangle"; a: Vec2; b: Vec2; radius?: number } & DrawingBase)
  | ({ kind: "circle"; c: Vec2; r: number } & DrawingBase)
  | ({ kind: "arc"; start: Vec2; mid: Vec2; end: Vec2 } & DrawingBase)
  | ({ kind: "bezier"; points: Vec2[] } & DrawingBase)
  | ({ kind: "ellipse"; c: Vec2; rx: number; ry: number; rotation: number; from?: number; to?: number } & DrawingBase)
  | ({ kind: "text"; text: string; at: Vec2; angle: number } & DrawingTextStyle & DrawingBase)

/** A pin of a symbol drawing. Its number is as KiCad writes it: `[1-3]` is three pads at one place. */
export interface DrawingPin {
  number: string
  name: string
  type: PinType
  shape: PinShape
  /** Where a wire meets it, in the symbol's frame. */
  x: number
  y: number
  /** The way it points from there to the body: 0 right, 90 up, 180 left, 270 down. */
  angle: number
  length: number
  hidden?: true
  unit?: number
  body?: number
  alternates?: PinAlternate[]
  /** Text heights of its name and number, in schematic units. */
  nameSize?: number
  numberSize?: number
}

/**
 * A symbol as KiCad's cache keeps it: the drawing of every unit and body style, its pins and the
 * places of its fields. Kept whole in the project so that a part placed from it is drawn exactly
 * as KiCad draws it; `model/symbolDrawing.ts` makes the drawings the editor works with.
 */
export interface SymbolDrawing {
  /** The symbol's name in the library it came from, `Device:R`. */
  name: string
  /** Absent is one unit. */
  units?: number
  unitNames?: Record<number, string>
  /** Absent is one body style; 2 is De Morgan. */
  bodyStyles?: number
  bodyStyleNames?: string[]
  items: DrawingItem[]
  pins: DrawingPin[]
  /** Where pin names sit: `offset` from the pin's end into the body (0 draws them above the pin), and whether they are shown at all. */
  pinNames?: { offset?: number; hidden?: true }
  pinNumbersHidden?: true
  /** A power symbol: its net is the Value; `local` keeps it on its sheet. */
  power?: "global" | "local"
  /** Pins of one number are one pad (jumpered), and groups of numbers that are joined inside the part. */
  jumpers?: { duplicates?: true; groups?: string[][] }
  /** The fields of the symbol and where each sits, in the symbol's frame. */
  fields: { name: string; value: string; place: FieldPlace }[]
}

export type PartCategory =
  | "Passives"
  | "Diodes"
  | "Transistors"
  | "Power"
  | "ICs"
  | "Modules"
  | "Connectors"
  | "Electromechanical"
  | "Symbols"

export interface PartDef {
  id: string
  name: string
  category: PartCategory
  description: string
  refPrefix: string
  pins: PinDef[]
  symbol: SymbolDef
  /** Footprinter strings; first is the default. Empty for schematic-only parts. */
  footprints: string[]
  defaultProps: Record<string, string>
  /** Property shown as {VAL} on the schematic. */
  valueProp?: string
  keywords?: string[]
  /** Footprint pad number -> pin number, for pads that share a pin (tabs, 4-pad switches). */
  padAlias?: Record<string, string>
  /** Power ports name the net they belong to and have no PCB presence. */
  powerNet?: string
  mpn?: string
  /** Made for one project (see CustomPartSpec) rather than shipped in the library. */
  custom?: boolean
  /** S5: a part with several units or body styles has one drawing for each (`symbolOf` picks it). `symbol` is unit 1 in body style 1. */
  units?: PartUnits
  /**
   * S5: present on a part drawn from a KiCad symbol, whose pins of one number are separate pins
   * unless `duplicates` (they are one pad, jumpered); `groups` are numbers the part joins inside
   * itself. The editor's own parts have none: they join pins of one number.
   */
  jumpers?: { duplicates: boolean; groups: string[][] }
  /** S5: this is a placed unit of the part `unitOf`, with no footprint of its own: the part itself is on the board. */
  unitOf?: string
  /** S5: a power port that stays on its sheet (KiCad's local power symbol). */
  powerLocal?: boolean
  /** S5: where the symbol's own fields sit, in its frame, for a part placed from the library. */
  fieldPlaces?: Record<string, FieldPlace>
}

/** S5: the drawings of a part's units and body styles, by `"unit:bodyStyle"` (both counted from 1). */
export interface PartUnits {
  count: number
  bodyStyles: number
  /** The name of each unit, from 1, where the symbol gives one. */
  unitNames?: Record<number, string>
  /** The name of each body style, from 1. */
  bodyStyleNames?: string[]
  symbols: Record<string, SymbolDef>
}

/**
 * S5: where one field of a placed symbol (Reference, Value, Footprint, a user field...) is drawn:
 * its own place, angle, size and justification, which are not the symbol's.
 */
export interface FieldPlace {
  /** The text's anchor, from the symbol's origin, on the sheet (y up). Turning or mirroring the symbol leaves it where it is, as KiCad does. */
  x: number
  y: number
  /** 0 across, 90 up. */
  angle: 0 | 90
  /** Text height in schematic units; absent is the editor's own text size. */
  size?: number
  hidden?: true
  /** Justification as KiCad has it; absent is centred. */
  h?: "left" | "right"
  v?: "top" | "bottom"
  bold?: true
  italic?: true
  /** Draw `Name: value` instead of the value alone. */
  showName?: true
  color?: string
  /** The thickness of the text's strokes, as the file has it (units). */
  thickness?: number
  /** KiCad's "do not autoplace": the field stays where it is put. */
  noAutoplace?: true
}

export type PinSide = "left" | "right" | "top" | "bottom"

/**
 * A part that isn't in the library, made for one project (by the copilot) and stored in it,
 * so the project opens the same anywhere. Built into a PartDef by `model/customParts.ts`.
 */
export interface CustomPartSpec {
  /** Unique across projects: a slug of the name plus a hash of the definition. */
  id: string
  name: string
  description: string
  category: PartCategory
  refPrefix: string
  /** Footprinter string or data-defined footprint whose pads are numbered like the pins. Empty for a part with a drawing and no footprint. */
  footprint: string
  pins: (PinDef & { side?: PinSide })[]
  /** A discrete symbol from CUSTOM_SYMBOLS; a box with the pins on its sides when absent. */
  symbol?: string
  /** S10: the key of its drawing in `Project.symbols`. A part with a drawing takes its pins, units and symbols from it. */
  drawing?: string
  /** Default properties: mpn, manufacturer, datasheet, value... */
  props: Record<string, string>
  valueProp?: string
  padAlias?: Record<string, string>
  keywords?: string[]
  /**
   * Where the pins and the land came from, and the latest check against a supplier. Absent on
   * parts made before October 2026, which were all made from the copilot's memory. Not part of
   * the id: the same drawing verified later is the same part.
   */
  source?: PartSource
}

/** Where a project part came from in the parts index. */
export interface PartDatabaseSource {
  /** Where the index got it: KiCad's libraries, or a supplier record it kept. */
  origin: "kicad" | "easyeda"
  /** Its id there: `Regulator_Linear:AMS1117-3.3` for KiCad, an LCSC number for EasyEDA. */
  key: string
  /** KiCad: the library release it was converted from, e.g. `10.0.7`. */
  release?: string
  /** KiCad: the footprint the symbol names, `Package_TO_SOT_SMD:SOT-223-3_TabPin2`. */
  footprint?: string
  /** The licence of the data, and the credit it asks for: shown wherever the part's source is. */
  licence: string
  attribution: string
}

/** The KiCad files a project part was imported from. */
export interface PartFileSource {
  /** The symbol, `Library:Name` with the symbol library's file name as the library (the name alone for a file of its own); null for a footprint imported alone. */
  symbol: string | null
  /** The footprint's name, as its file gives it. */
  footprint: string
}

/** How far to trust a project part, and why. */
export interface PartSource {
  /**
   * `supplier`: built from a supplier's pinout. `database`: from a part the parts index stores
   * whole (KiCad's libraries; `database` says which). `file`: from the user's own KiCad files
   * (`file` says which). `memory`: written by the copilot from what it recalled. `library`: drawn
   * for the editor's own library, which listed chips and modules until October 2026 (a project
   * that placed one keeps it as its own part) and still draws the examples' chips. `user`: changed
   * by hand in the part editor (`model/projectParts.ts`) after it was built from one of the others,
   * which the rest of the source still names: the user's word for the part, as their own files are.
   */
  pins: "supplier" | "database" | "file" | "memory" | "import" | "library" | "user"
  /**
   * `supplier`: the supplier's own land. `database`: the stored part's land (a KiCad footprint).
   * `file`: the footprint the user imported. `checked`: a footprinter land checked pad by pad
   * against the supplier's. `memory`: chosen without one. `import`: the land (if any) is the one
   * the imported board gave it. `library`: the editor's own library's. `user`: changed by hand in the part editor.
   */
  land: "supplier" | "database" | "file" | "checked" | "memory" | "import" | "library" | "user"
  /**
   * `import`: the part came from a KiCad schematic the user brought in, drawn and wired as that file
   * has it, so there is nothing to check against a supplier. `file` is the schematic's file name and
   * `libId` the symbol's `Library:Name` there.
   */
  imported?: { file: string; libId: string }
  /** The parts index part it was made from, when it was. */
  database?: PartDatabaseSource
  /** The user's own KiCad files it was imported from, when it was (`model/kicadImport.ts`). */
  file?: PartFileSource
  /** The supplier record the part was built from or checked against. */
  supplier?: {
    lcsc: string
    mpn: string
    /** As the parts API says: `curated`, `consensus`, `single_source` or `disputed`. */
    confidence: string
    /** Supplier drawings that agree on the pins. */
    vendors: number
    fetchedAt: string
    /** Disagreements between drawings, in sentences. */
    disputes?: string[]
    /** The record is an EasyEDA user's upload, not an LCSC catalogue part: lower confidence. */
    userUpload?: boolean
    /** The credit the record asks for wherever its data is used, shown in the Inspector. */
    attribution?: string
  }
  /** Why it was made from memory: no record, a lookup that failed, or no lookup at all. */
  note?: string
  /**
   * Sakura compared the datasheet's pin table with this part's pins and found them to agree
   * (`read_datasheet` with `confirm_part`). A weaker note than `supplier` or a passed `check`:
   * a model read a PDF, and nothing parsed it. It is said in Checks and never makes a part verified.
   */
  datasheet?: {
    at: string
    /** The LCSC part whose datasheet was read. */
    lcsc: string
    /** The pages of the pin table that were compared. */
    pages: number[]
  }
  /** The latest check of a part made from memory against a supplier record. */
  check?: {
    at: string
    lcsc?: string
    /**
     * `no_record`: no supplier part at all. `different_part`: supplier parts numbered like it exist,
     * but none has its pin count. `ambiguous`: several packages or pinouts, none picked.
     * `pending`: made while the supplier lookup was failing, and not checked since.
     */
    verdict: "agrees" | "renamed" | "contradicted" | "no_record" | "different_part" | "ambiguous" | "pending"
    /** What disagrees, each with its pin numbers or millimetres. */
    findings: string[]
  }
}

// ---------- 3D models ----------

/** File formats a 3D model can be in: STEP is exact geometry, the others are meshes. */
export type Model3DFormat = "step" | "obj" | "wrl" | "stl" | "glb"

/**
 * A part's 3D model: a file the 3D view draws and the STEP export writes as it is. Until the file
 * has loaded, and whenever it can't be, the part shows only its pads.
 */
export interface Model3D {
  /**
   * `file`: one the user added, by the SHA-256 of its bytes (hex), kept by the host's
   * `ModelFileStore`. `supplier`: the supplier's model of the part, by the supplier's model id,
   * through the host's `SupplierPartsSource.model`; it has a mesh (`obj`) to draw and a STEP to export.
   * `kicad`: a STEP file in KiCad's 3D library, by `<release>/<path>`, through the host's
   * `PartsIndexSource.model`; it is drawn and exported from that one file.
   */
  source: "file" | "supplier" | "kicad"
  id: string
  /** The file's name as it was added, or the supplier's title for the model. */
  name: string
  /** The file's format. A supplier model is `step`: that is the one exported, and the mesh is drawn. */
  format: Model3DFormat
  /**
   * What `offset` places. `model`: the file's own origin, as KiCad places a model. `center`: the
   * middle of the model's footprint on the board and the bottom of the model, after rotation, which
   * is how a supplier places its models (their own origins are anywhere).
   */
  origin: "model" | "center"
  /** Millimetres in the footprint's frame: x and y as the pads, z up from the board's top surface. */
  offset: { x: number; y: number; z: number }
  /** Degrees about x, then y, then z, counter-clockwise looking down each axis at the origin. */
  rotation: { x: number; y: number; z: number }
  /** Millimetres per unit of the file: 1 for a millimetre model, 25.4 for inches. Meshes only; STEP files say their own units. */
  scale?: number
  /** Who made the model, as it should be credited wherever it is used. */
  attribution?: string
}

/** The model a part has on one footprint: every component of that part on that footprint is drawn with it. */
export interface ModelAssignment {
  part: string
  footprint: string
  model: Model3D
}

// ---------- Document ----------

/** `x` flips the symbol top to bottom (about the x axis), `y` left to right, after its turn. */
export type Mirror = "x" | "y"

/**
 * What KiCad calls a footprint's attributes, and the pad groups it keeps beside them. Every field
 * is absent for a part drawn in the editor, which then behaves as it always did. `model/partFlags.ts`
 * has what each one does.
 */
export interface PartFlags {
  /** How the part is mounted, as the file says. Absent: neither (a fiducial, a logo, a drawing). */
  mount?: "smd" | "through_hole"
  /** KiCad's "virtual" (a board feature, not a part to buy or place): left out of the BOM and the position file. */
  virtual?: true
  /** Left out of the BOM. */
  excludeFromBom?: true
  /** Left out of the position (pick and place) file. */
  excludeFromPos?: true
  /** In the file but not in the schematic (KiCad's board only). Stays in the BOM unless it is also not in the BOM. */
  boardOnly?: true
  /** Do not populate: left out of the BOM and the position file (KiCad keeps it in both); its paste is still plotted. */
  dnp?: true
  /** The symbol's `exclude_from_sim yes`: a simulation leaves the part out. */
  excludeFromSim?: true
  /** The symbol's `on_board no`: the part is in the schematic and has no footprint on the board. */
  notOnBoard?: true
  /** The part has no courtyard and that is meant. */
  allowMissingCourtyard?: true
  /** Solder mask bridges between this part's pads are allowed. */
  allowMaskBridges?: true
  /** Pads that share a number are jumpers: connected inside the part, not a short. */
  jumperDuplicates?: true
  /** Groups of pad numbers connected inside the part (a solder jumper's two pads). */
  jumperGroups?: string[][]
  /** Groups of pad numbers whose nets may meet on this part (a net tie): copper touching them is not a short. */
  netTies?: string[][]
}

/**
 * S9: what one schematic variant changes on one symbol, as KiCad 10 keeps it in the symbol's instance (`variant`): only what differs from the
 * symbol's own value is listed. A flag is the editor's own (`dnp`, `excludeFromBom`, `notOnBoard`, `excludeFromSim`, `excludeFromPos`), `true`
 * where the variant sets it and `false` where the variant clears what the symbol sets; `fields` are field values (`Value`, `Footprint`, any user field).
 */
export interface VariantOverride {
  dnp?: boolean
  excludeFromBom?: boolean
  notOnBoard?: boolean
  excludeFromSim?: boolean
  excludeFromPos?: boolean
  fields?: Record<string, string>
}

/** S9: the schematic variants of a project, by the name KiCad gives them, with the one the editor shows now. */
export interface ProjectVariants {
  list: { name: string; description?: string }[]
  /** The variant the BOM, the position file, the do not populate marks and the board follow; absent: the symbols as they are (KiCad's default variant). */
  active?: string
}

export interface ComponentInstance {
  id: string
  partId: string
  ref: string
  props: Record<string, string>
  footprint: string
  /** Where it is on the sheet: its turn (counter-clockwise), then its mirror, as KiCad applies them. */
  sch: { x: number; y: number; rot: Rotation; mirror?: Mirror }
  /** S5: the unit of a part with several that this symbol is; 1 when absent. Symbols of one part share its reference. */
  unit?: number
  /** S5: the body style (De Morgan) it is drawn in; 1 when absent. */
  bodyStyle?: number
  /** S5: fields with a place of their own, by field name (`Reference`, `Value`, `Footprint`, a user field). Absent: the symbol's own places. */
  fields?: Record<string, FieldPlace>
  /** S5: the alternate function chosen for a pin, by pin number. */
  pinAlt?: Record<string, string>
  /** KiCad's `fields_autoplaced` on the symbol: its fields are laid out by KiCad's rules until one is moved by hand. */
  fieldsAutoplaced?: true
  pcb: {
    x: number
    y: number
    /** Degrees counter-clockwise, any angle in [0, 360). A part drawn in the editor is on a quarter turn; a board brought in from KiCad may be at any angle (X6). */
    rot: number
    side: PcbSide
    placed: boolean
    /** Pinned by the user: automatic placement and re-packing leave it where it is. */
    locked?: boolean
  }
  /** Pins left unconnected on purpose; checks skip them and the schematic marks them with a cross. */
  nc?: string[]
  /** Footprint attributes and net ties, as a board brought in from KiCad has them (`PartFlags`). */
  flags?: PartFlags
  /** S9: what each schematic variant changes on this symbol, by the variant's name. */
  variants?: Record<string, VariantOverride>
  /** The part's reference, value and own text, where a board brought in from KiCad has them (`PartText`); absent for a part drawn in the editor. */
  texts?: PartText[]
  /** Groups inside the footprint, of its own pads, drawings, texts and dimensions (see `PcbGroup`). */
  groups?: PcbGroup[]
  /** The footprint's id in the KiCad board it came from, `Library:Name`, which `${FOOTPRINT_LIBRARY}` and `${FOOTPRINT_NAME}` in text show; absent for a part drawn in the editor, whose footprint name is `footprint`. */
  fpid?: string
  /**
   * S1: the use of a sheet this symbol is on, as the path of sheet symbols that lead to it (`/h1/h4`, see `model/sheets.ts`).
   * Absent: the root sheet. A sheet used twice has its symbols twice, one for each use, each with its own reference and its
   * own place on the board.
   */
  inst?: string
  /** S1: on a use of a sheet after the first, the symbol of the first use this one is a copy of: editing the sheet edits every copy. */
  tpl?: string
}

export interface Wire {
  id: string
  /** S1: the sheet it is drawn on (`SchematicSheet.id`); absent is the root sheet. Wires, labels and drawings belong to a sheet, which every use of it shares. */
  sheet?: string
  points: Vec2[]
  /** S4: the line's own width, dash and colour (`width` in schematic units); absent is the editor's own wire. */
  look?: Pick<ShapeLook, "width" | "dash" | "color">
}

/**
 * S2, S1: the kinds of label. A local label joins the nets of its name on its own sheet, a global one on every sheet, and a
 * hierarchical one joins its sheet to the pin of its name on the sheet symbol that holds the sheet (`model/sheets.ts`).
 */
export type LabelKind = "local" | "global" | "hierarchical"

/** S2: what a label's flag says about its signal, as KiCad has it. */
export type LabelShape = "input" | "output" | "bidirectional" | "tri_state" | "passive"

/**
 * S2, S4: how a text on the sheet is set (a label's, a note's, a table cell's). Every field absent is
 * the editor's own text; sizes are in schematic units.
 */
export interface TextLook {
  /** Text height; absent is the editor's own text size. */
  size?: number
  /** The stroke the letters are drawn with. */
  thickness?: number
  bold?: true
  italic?: true
  /** `#rrggbb` or `rgba(r,g,b,a)`; absent is the sheet's ink. */
  color?: string
  /** A font by name, which the editor does not have (it draws its own): kept, and said in the report. */
  face?: string
  /** Justification as KiCad has it; absent is centred. */
  h?: "left" | "right"
  v?: "top" | "bottom"
  /** KiCad's `mirror` justification: the text is drawn reversed. */
  mirror?: true
  /** A hyperlink the text carries. */
  href?: string
  /** `(hide yes)`: the text is there and not drawn. */
  hidden?: true
  /** KiCad's `line_spacing` (a factor of the text height). */
  lineSpacing?: number
}

/** S2: a field of a label (a global label's intersheet references, or any other property it has), with the place and look KiCad gave it. */
export interface LabelField {
  name: string
  value: string
  place: FieldPlace
}

export interface NetLabel {
  id: string
  /** S1: the sheet it is drawn on; absent is the root sheet. */
  sheet?: string
  name: string
  x: number
  y: number
  rot: Rotation
  /**
   * S2: `local` joins the nets of its name on its own sheet and names the net `/NAME`, `global` joins them
   * on every sheet and names the net as it is written. A label with no kind is the editor's own, which is
   * KiCad's local label once a project names its nets as KiCad does (`Project.netNames`).
   */
  kind?: LabelKind
  /** S2: a global or hierarchical label's flag shape. */
  shape?: LabelShape
  /** S2: size, style, justification and colour of the label's text. */
  look?: TextLook
  /** S2: the label's other fields (a global label's `Intersheetrefs`). */
  fields?: LabelField[]
  /** S2: KiCad's `fields_autoplaced`. */
  fieldsAutoplaced?: true
}

// ---------- S4: the strokes, fills and cells a KiCad sheet draws with ----------

/** A line's own look, in schematic units: KiCad's `(stroke ...)`; absent is the editor's own line. */
export type SheetStroke = Pick<ShapeLook, "width" | "dash" | "color">

/** How a box or shape is filled: KiCad's `(fill (type ...) (color ...))`; absent is none. */
export interface SheetFill {
  kind: FillKind
  color?: string
}

/** One cell of a table: its own place and size on the sheet, as KiCad gives them, and how many columns and rows it spans. */
export interface TableCell {
  text: string
  x: number
  y: number
  w: number
  h: number
  rot: Rotation
  colSpan: number
  rowSpan: number
  margins?: [number, number, number, number]
  look?: TextLook
  fill?: SheetFill
  excludeFromSim?: true
}

export interface Trace {
  id: string
  layer: CopperLayer
  width: number
  points: Vec2[]
  /** Routed by hand (e.g. a fine-pitch fan-out); kept when routing is redone from scratch. */
  locked?: boolean
  /**
   * The net the trace is on, by name, when a board brought in from KiCad says so. Without it (every
   * trace drawn or routed in the editor) the net is whatever the trace touches. With it the trace
   * counts as copper of that net even where it touches nothing, and touching another net is a short.
   */
  net?: string
  /**
   * An arc track (X4), KiCad's `arc`: `points` are its three points, start, a point on the arc between and end, as KiCad stores
   * it, so the circle and the way round follow from them and nothing is rounded to an angle. A trace without it is a polyline.
   */
  arc?: true
}

export interface Via {
  id: string
  x: number
  y: number
  diameter: number
  drill: number
  /** Net of a stitching via, which ties pours together without a trace. */
  net?: string
  /** Placed by hand as part of a fan-out; kept when routing is redone from scratch. */
  locked?: boolean
  /**
   * The net a routed via is on, by name, when a board brought in from KiCad says so (what `Trace.net`
   * is for a trace). Not `net`, which makes the via a stitching via that the stitcher owns.
   */
  routedNet?: string
  /**
   * X5: a via that does not run the board's whole stack. A blind via joins an outer layer to an inner one, a buried via two inner
   * layers, a micro via is a short blind via between neighbouring layers (KiCad's `blind`, `buried` and `micro`). Absent is a through
   * via, which reaches every copper layer, as every via was. `from` is the layer nearer the front; both are set whenever this is.
   */
  kind?: ViaKind
  from?: CopperLayer
  to?: CopperLayer
  /** Whether the via's mask is closed over its pad on the front and the back (KiCad's `tenting`); a side it does not say follows the board's rule. */
  tent?: { front?: boolean; back?: boolean }
  /** What becomes of the via's copper on layers nothing connects to (KiCad's `remove_unused_layers`, `keep_end_layers`, `start_end_only`): absent keeps every layer. */
  unused?: "remove" | "keepEnds" | "startEnd"
  /** The copper layers a pour joins the via on when its unused layers are removed (KiCad's `zone_layer_connections`); the others get no connection. */
  zoneLayers?: CopperLayer[]
  /** A via that is not on a net KiCad would route (KiCad's `free`): its net is not changed when a track is dragged. */
  free?: true
  /**
   * A via stack (KiCad's `padstack`): the diameter on each layer where it is not the via's `diameter`. `inner` and `back` are KiCad's
   * front, inner and back mode (the front is `diameter`); `layers` is its custom mode, a diameter for every copper layer but the front.
   */
  stack?: { inner: number; back: number } | { layers: Partial<Record<CopperLayer, number>> }
}

/** How a via that is not a through via is told apart: a blind one has an outer end, a buried one has two inner ends, a micro via is a short blind one. */
export type ViaKind = "blind" | "buried" | "micro"

/** ENIG, tin-lead HASL, lead-free HASL, OSP. */
export type SurfaceFinish = "enig" | "hasl" | "lf-hasl" | "osp"

/** Outer-layer copper weight in ounces per square foot: 1 oz is 35 µm. */
export type CopperWeight = 1 | 2

export interface MountingHoles {
  /** Drill diameter (mm), e.g. 3.2 for M3. */
  drill: number
  /** Plated ring outer diameter (mm). */
  diameter: number
  /** Distance from each board edge to the hole centre (mm). */
  inset: number
}

/**
 * A board outline drawn path by path (X2): each path is lines, arcs, curves and elliptical arcs that
 * follow one another, closed or not. A closed path is a loop: the loops nest, and a loop inside a loop
 * that is the board is a hole in it (a cutout, a slot), one inside that is board again, and so on. A path
 * that does not close is kept as drawn, and the board is "not closed" while it is there.
 */
export interface BoardOutline {
  paths: ShapePath[]
  /**
   * `paths[0]` is the rectangle the board was before anything was drawn on its edge, still waiting to be replaced: the first closed
   * shape drawn that does not lie inside it becomes the board in its place (and a shape inside it is a cutout). Cleared as soon as that
   * happens or the rectangle itself is edited. Absent for every outline that came from a file or was set whole.
   */
  seed?: true
}

export interface BoardDef {
  /** The board's bounding box when it has an `outline`, else its size. */
  width: number
  height: number
  /** Board centre in PCB space (the bounding box's centre when it has an `outline`). */
  x: number
  y: number
  /**
   * The board's shape when it is not the rectangle `width` by `height` with `cornerRadius`: absent for a
   * board drawn in the editor and never given one. With it, `cornerRadius` is 0 and the box above follows
   * it (`syncOutlineBox`, `model/outlineOps.ts`). An outline with no paths is a board with no outline.
   */
  outline?: BoardOutline
  /** Finished board thickness (mm). */
  thickness: number
  cornerRadius: number
  /** Solder mask colour as hex; green when absent. */
  maskColor?: string
  /** Silkscreen colour as hex; white, or black on a light mask, when absent. */
  silkColor?: string
  finish?: SurfaceFinish
  copperWeight?: CopperWeight
  /** Plated holes in the four corners; null or absent for none. */
  mountingHoles?: MountingHoles | null
  /**
   * X1: the board's copper layers and its physical stackup. Absent is the two layers every board drawn in the editor has, with no
   * stackup of its own (`boardStackup`, `model/rules.ts`, describes them). See `model/stack.ts` for what reads it.
   */
  stack?: BoardStack
}

/** What a copper layer is for, in KiCad's words: a signal layer, a power plane, either (mixed), or a jumper layer. */
export type CopperLayerType = "signal" | "power" | "mixed" | "jumper"

/** The board's copper layers and stackup (X1). */
export interface BoardStack {
  /**
   * The copper layers from the front to the back, two or more (KiCad has 2 to 32). The first is `top`, the last is `bottom` and the ones
   * between are `in1`, `in2`... in order, so a layer's id is its place and this holds only what each is called and for.
   */
  copper: StackCopper[]
  /** The physical stackup as KiCad's board setup lists it, front to back, when the board has one (a board of KiCad 6 or later may); absent is none. */
  rows?: StackRow[]
  /** KiCad's `copper_finish` as written (`ENIG`, `HASL`, `None`, `Immersion tin`...), the board's `finish` where one of the editor's four fits it. */
  finish?: string
  /** `edge_plating yes`: the board's edge is plated. */
  edgePlating?: boolean
  /** `dielectric_constraints yes`: the dielectric thicknesses are held to the manufacturer's constraints. */
  dielectricConstraints?: boolean
  /** `edge_connector`: `yes` or `bevelled` (absent or `none` is none). */
  edgeConnector?: "yes" | "bevelled"
}

export interface StackCopper {
  /** The name the user gave the layer (`(31 B.Cu signal "Back")`); absent is KiCad's own (`F.Cu`, `In1.Cu`, `B.Cu`). */
  label?: string
  /** Absent is a signal layer. */
  type?: CopperLayerType
}

/** One layer of the stackup, as KiCad's `(layer ...)` of `setup (stackup ...)` says it. */
export interface StackRow {
  /** KiCad's name for it: `F.Cu`, `In1.Cu`, `B.Cu`, `F.SilkS`, `F.Mask`, `F.Paste`, `B.Mask`..., or a dielectric's own name (`dielectric 1`). */
  name: string
  /** KiCad's type word as written: `copper`, `core`, `prepreg`, `Top Solder Mask`, `Top Silk Screen`... */
  type: string
  thickness?: number
  /** The thickness is held (impedance control). */
  locked?: true
  material?: string
  epsilonR?: number
  lossTangent?: number
  color?: string
  /** KiCad 11's dielectric model and the frequency its figures are for. */
  model?: "constant" | "djordjevic_sarkar"
  specFreq?: number
  /** The further sublayers of a dielectric (`addsublayer`), each with the same fields. */
  sub?: Omit<StackRow, "name" | "type" | "sub">[]
}

/**
 * How a zone joins the pads of its own net: with spokes on every pad (`thermal`), with spokes on through-hole pads and solid on the
 * rest (`tht`), solidly (`solid`), or not at all (`none`: the pour keeps its clearance round them).
 */
export type ZoneConnection = "thermal" | "tht" | "solid" | "none"

/** What a rule area keeps out, in KiCad's words: each flag set is "not allowed" inside it. A rule area with no flag set restricts nothing (it is there for rules). */
export interface ZoneKeepout {
  tracks?: true
  vias?: true
  pads?: true
  /** Copper pours: a pour keeps out of the area, by its outline and with no clearance. */
  pour?: true
  footprints?: true
}

/**
 * A copper pour: the whole board on one layer, or (X3) any polygon on one layer or both, with its own settings; or a rule area
 * (keepout) that keeps tracks, vias, pads, pours or parts out of a polygon. The fill is not stored: it is computed from the zone,
 * the copper round it and the rules, and refilled whenever any of them changes (`model/pour.ts`, `model/zoneFill.ts`).
 *
 * A zone with none of the fields below `clearance` is the editor's own whole-board pour, as it always was: its fill, its thermal
 * reliefs and everything else about it come from the board's design rules and are unchanged. Each optional field's absence is that
 * default.
 */
export interface Zone {
  id: string
  /** The net's name; empty for a zone on no net (a pour that touches nothing, or a rule area). */
  net: string
  /** The layer, or the first of its layers (`layers`). */
  layer: CopperLayer
  /** Gap to copper on other nets (mm); defaults to the pour clearance rule. */
  clearance?: number
  /** A name to tell it by (KiCad's zone name). */
  name?: string
  /**
   * The polygon the zone covers: the first closed path is its outline and every other closed path is a hole in it, as KiCad
   * stores a zone. Absent is the whole board (inset by the edge clearance), which is what a pour drawn by the editor is.
   */
  outline?: ShapePath[]
  /** Every layer it is on, `layer` first: a zone on both copper layers. Absent is the one layer. `[]` with `other` is a zone on no copper layer (see `other`). */
  layers?: CopperLayer[]
  /**
   * X29: KiCad's names of the layers it is on that are not copper (`F.Mask`, `B.Paste`, `F.SilkS`, `User.3`, `Edge.Cuts`...), in the order of `SHAPE_LAYERS`. A zone with only these has `layers: []`
   * and a `layer` that is no more than the side it was put on: it is a filled area on the mask, the paste, the silkscreen or a user layer, filled by KiCad's rules for such a zone
   * (`nonCopperFill.ts`: its polygon smoothed and kept inside the board, minus the rule areas that keep pours out, thinned to its minimum width), with no net, no clearance and no pads. A rule area may
   * have them beside its copper layers (it then keeps pours out of a zone on that layer too); a pour never has both.
   */
  other?: string[]
  /** KiCad's identity of the zone as 32 lowercase hex digits (`kicadUuid`): what orders two zones of equal priority, as KiCad's `HigherPriority` does (the greater one is filled first). Absent for a zone drawn here and for a board of KiCad 5 or earlier, which had no such order: file order then. */
  uuid?: string
  /** From a board of KiCad 5 or earlier, whose fill cut a zone only out of zones of strictly higher priority (`zone_filler.cpp` of 5.1): two such zones of equal priority cut neither, and overlap. */
  unordered?: true
  /** Which of two overlapping zones wins: the higher one is filled first and the lower keeps out of it. Absent is 0. */
  priority?: number
  /** The thinnest copper the fill keeps (mm); necks and slivers under it are removed. Defaults to the pour minimum width rule. */
  minWidth?: number
  /** How its pads are joined; defaults to the thermal relief rule. */
  connect?: ZoneConnection
  /** The ring of clearance round a pad with a thermal relief (mm); defaults to the zone's clearance. */
  thermalGap?: number
  /** The width of a thermal relief's spokes (mm); defaults to the thermal spoke width rule. */
  spokeWidth?: number
  /** Rounded or cut off corners of the outline, by `radius` (mm). */
  smoothing?: { kind: "chamfer" | "fillet"; radius: number }
  /** What happens to copper no same-net copper touches: removed (absent), kept (`never`), or removed when under that many square millimetres. */
  islands?: "never" | number
  /** Present: a rule area, not a pour; it has no net and no fill. */
  keepout?: ZoneKeepout
  /** KiCad's teardrop zone, made at a pad or via (`padvia`) or the end of a track (`track_end`): it joins its own net's pads solidly, and rule areas and lower zones do not cut into it. */
  teardrop?: "padvia" | "track_end"
  /** How far the fill keeps from the board's edge (mm); defaults to the edge clearance rule. A board brought in from KiCad 5 or earlier says it itself: that KiCad kept a pour its clearance and half the edge line's width from the edge. */
  edgeGap?: number
  /** How far the fill keeps from the edge of a drilled hole that has no copper (mm); defaults to the clearance. KiCad 6 and later keep a pour out of such a hole by the board's own hole clearance, which is less than a pour's clearance; KiCad 5 and earlier used the pour's. */
  holeGap?: number
  /** Pinned by the user (KiCad's lock): the editing tools leave it where it is. */
  locked?: true
  /** Only on the board's copy of a zone of a part (`partZones.ts`, never stored): the id of the part it belongs to. */
  part?: string
}

/**
 * What a text has beyond the editor's own silkscreen text, as KiCad's text objects have it (X9). A text with a
 * `layer` is a KiCad text: it is laid out by KiCad's rules (`lib/kicadText.ts`), with the attributes below. One
 * with none is the editor's own silkscreen text, drawn as it always was, and the rest of these are not used.
 * Each is optional and its absence is KiCad's default.
 */
export interface TextAttrs {
  /** KiCad's name of the layer it is on: `F.SilkS`, `B.Cu`, `F.Mask`, `User.1`, `Edge.Cuts`... On a part, `F.` is the part's own side. */
  layer?: string
  /** Glyph width (mm) when it is not the height (`size`). */
  w?: number
  /** Pen width (mm); absent is automatic, an eighth of the width (a fifth when bold). */
  thickness?: number
  bold?: true
  italic?: true
  /** Mirrored about its own vertical axis, as text on a bottom layer is to read from below. */
  mirror?: true
  /** Drawn as a hole in a filled box round it (what a knockout is on silkscreen or copper). */
  knockout?: true
  /** Justification; absent is centred. */
  hj?: "left" | "right"
  vj?: "top" | "bottom"
  /** Line spacing factor; absent is 1. */
  spacing?: number
  /** `false` for a part's text that may turn upside down with the part (KiCad's "unlocked", which means keep upright is off). */
  upright?: false
  /** Not drawn or plotted (a part's own text; board text cannot be hidden). */
  hide?: true
  locked?: true
  /** A hyperlink KiCad keeps with the text; it has no other use here. */
  href?: string
  /** A text box: the text is wrapped inside a rectangle centred on (x, y) and turned with the text, with an optional border. */
  box?: TextBox
}

/** A text box (KiCad's `gr_text_box`): the rectangle's size, the border's width when it has one, and the margins (left, top, right, bottom) the text keeps from the edge. */
export interface TextBox {
  w: number
  h: number
  border?: number
  margins: [number, number, number, number]
}

/**
 * Text on the board. Size is the cap height in mm for the editor's own silkscreen text, and the glyph
 * height for a KiCad text (one with a `layer`). `rot` is the angle in degrees counter-clockwise; the editor's
 * own text turns by quarter turns only, a KiCad text by any angle.
 */
export interface BoardText extends TextAttrs {
  id: string
  text: string
  x: number
  y: number
  size: number
  rot: number
  side: PcbSide
}

/**
 * A part's own text, as KiCad keeps it with the footprint: its reference, its value, or text of its own.
 * Where it sits is in the land's frame (the part before it is turned or flipped), so it goes with the part;
 * `layer` follows the same rule (`F.` is the part's own side). A reference or value has no `text` unless it shows
 * something other than the part's reference or value (a part that KiCad names `REF**`); text of its own has its
 * content, with KiCad's variables in it (`${REFERENCE}`). A part with no `texts` is a part drawn in the editor, whose
 * designator the editor places (`model/silk.ts`); one with `texts` has what the file says and no other designator.
 */
export interface PartText extends TextAttrs {
  kind: "reference" | "value" | "user"
  text?: string
  layer: string
  x: number
  y: number
  size: number
  rot: number
}

/**
 * A named group of parts on the schematic (USB-C INPUT, 3.3V POWER, MCU), drawn as a titled frame
 * around them. Only what is in it is stored: the frame follows the parts (`model/blocks.ts`).
 */
export interface SchematicBlock {
  id: string
  /** S1: the use of a sheet it is drawn on (as `ComponentInstance.inst`); absent is the root sheet. A block holds the symbols of one use. */
  inst?: string
  name: string
  /** Ids of its components. A component is in one block at most. */
  components: string[]
  /** S4: KiCad's locked group: its parts cannot be moved, turned or deleted on the sheet until it is unlocked. */
  locked?: true
  /** Set on the OTHER block Tidy makes for parts in no block: it holds loose parts, not a grouping someone chose. Renaming it clears this. */
  leftover?: boolean
  /**
   * On a `leftover` block: where Tidy found each part of the sheet before it laid them out (`from`)
   * and where it left it (`to`), by component id, so Clean up can still read how the sheet was drawn.
   */
  origins?: Record<string, { from: ComponentInstance["sch"]; to: ComponentInstance["sch"] }>
}

// ---------- Schematic drawings ----------

/**
 * Colours a drawing can take. Named rather than hex, so each one is drawn in a shade that reads on
 * the light sheet and another on the dark one (`editor/theme.ts`).
 */
export type DrawingColor = "ink" | "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple"
export type LineWeight = "thin" | "medium" | "thick"
export type LineDash = "solid" | "dashed" | "dotted"

/** How a drawing is painted. Absent fields are the defaults: ink, no fill, a medium solid line. */
export interface DrawingStyle {
  /** Line, outline and text colour. */
  color?: DrawingColor
  /** A soft tint inside a closed shape, or behind a text. */
  fill?: DrawingColor
  weight?: LineWeight
  dash?: LineDash
  /**
   * What a KiCad file said, exactly: the line's width, dash and colour (and a text's pen and letter
   * colour). It wins over `color`, `weight` and `dash`; setting one of those in the editor clears it.
   */
  stroke?: SheetStroke
  /** A KiCad file's fill (the outline's colour, the sheet's, or one of its own); it wins over `fill`. */
  paint?: SheetFill
  /** KiCad's `exclude_from_sim` on a text, a text box or a table cell. */
  excludeFromSim?: true
}

/** A line through its points, or a polygon when closed. Arrowheads go on open lines only. A KiCad polyline is one of these (`stroke`, and `paint` for its fill). */
export interface DrawingLine extends DrawingStyle {
  id: string
  type: "line"
  points: Vec2[]
  closed?: boolean
  arrows?: "start" | "end" | "both"
  /**
   * S8: the polygon is a KiCad rule area. The symbols it covers take its flags (`model/ruleAreas.ts`), and a directive label on its edge
   * puts the nets inside it in the label's net class. Present only on a closed line.
   */
  ruleArea?: RuleAreaMark
}

/** S8: what a rule area does to the symbols inside it, as KiCad's `(rule_area (dnp yes) (in_bom no) (on_board no) (exclude_from_sim yes) ...)`. Each flag is present only when set. */
export interface RuleAreaMark {
  dnp?: true
  excludeFromBom?: true
  notOnBoard?: true
  excludeFromSim?: true
}

/** A rectangle, by its box: x and y are the lower-left corner (y is up). */
export interface DrawingBox extends DrawingStyle {
  id: string
  type: "rect"
  x: number
  y: number
  width: number
  height: number
  /** Rounded corners of a rectangle, in schematic units. */
  radius?: number
}

/**
 * Free text: a title, a note or a callout, on one or more lines. x and y are the text's anchor: its
 * left end, its middle or its right end as it is aligned, and the top of its first line, unless
 * `valign` says otherwise. Turned 90° it reads upwards.
 *
 * A text from a KiCad file always has `valign` (KiCad's own default is the middle, and its lines are 1.5
 * sizes apart where the editor's are 1.3): that is what tells the two apart, and it is drawn and written
 * back the way KiCad has it. The fields after `valign` only such a text has.
 */
export interface DrawingText extends DrawingStyle {
  id: string
  type: "text"
  x: number
  y: number
  text: string
  /** Font size in schematic units; a designator's is 0.1. */
  size: number
  align?: "left" | "center" | "right"
  bold?: boolean
  italic?: boolean
  mono?: boolean
  /** An outline around the text, in its colour, weight and dash. */
  border?: boolean
  rot?: Rotation
  /** Which end of the text's height `y` is: the top (the editor's own), the middle or the bottom (KiCad's justification). */
  valign?: "top" | "middle" | "bottom"
  /** KiCad's `mirror` justification: the text is drawn reversed. */
  mirror?: true
  /** A hyperlink the text carries. */
  href?: string
  /** `(hide yes)`: the text is there and not drawn. */
  hidden?: true
  /** A font by name, which the editor does not have (it draws its own): kept, and said in the report. */
  face?: string
  /** KiCad's `line_spacing` (a factor of the text height). */
  lineSpacing?: number
}

/** A circle by its centre and radius. */
export interface DrawingCircle extends DrawingStyle {
  id: string
  type: "circle"
  x: number
  y: number
  radius: number
}

/** A circular arc through three points, as KiCad keeps it: from `start` through `mid` to `end`. */
export interface DrawingArc extends DrawingStyle {
  id: string
  type: "arc"
  start: Vec2
  mid: Vec2
  end: Vec2
}

/** A cubic Bezier curve: two ends and two control points, in order. */
export interface DrawingCurve extends DrawingStyle {
  id: string
  type: "bezier"
  points: [Vec2, Vec2, Vec2, Vec2]
}

/** Text in a box. `x`, `y` is the box's corner KiCad calls `at`, `w` and `h` its size along its own turn. */
export interface DrawingTextBox extends DrawingStyle {
  id: string
  type: "textbox"
  text: string
  x: number
  y: number
  w: number
  h: number
  rot: Rotation
  /** The gap between the box and its text: left, top, right, bottom. */
  margins?: [number, number, number, number]
  look?: TextLook
}

/** A picture on the sheet: a PNG, base64, drawn `scale` times its own size around `x`, `y`. */
export interface DrawingImage extends DrawingStyle {
  id: string
  type: "image"
  x: number
  y: number
  scale: number
  data: string
}

/** A table (KiCad 8 on). */
export interface DrawingTable extends DrawingStyle {
  id: string
  type: "table"
  columns: number
  columnWidths: number[]
  rowHeights: number[]
  cells: TableCell[]
  border: { external: boolean; header: boolean; stroke?: SheetStroke }
  separators: { rows: boolean; cols: boolean; stroke?: SheetStroke }
}

/** A junction dot of its own size and colour. It is drawn where it is, whether or not wires meet there. */
export interface DrawingJunction extends DrawingStyle {
  id: string
  type: "junction"
  x: number
  y: number
  /** The dot's diameter in schematic units; absent is the editor's own dot. */
  diameter?: number
  /** `#rrggbb` or `rgba(r,g,b,a)`. */
  dotColor?: string
}

/** A no-connect flag that is not on a part's pin (one on a pin is that pin's `nc` mark). */
export interface DrawingNoConnect extends DrawingStyle {
  id: string
  type: "noconnect"
  x: number
  y: number
}

/** S8: the shape at the end of a directive label's pin. */
export type DirectiveShape = "dot" | "round" | "diamond" | "rectangle"

/**
 * S8: a directive label (KiCad's `netclass_flag`): a pin with a flag on its end, that is on a wire, a pin or the edge of a rule area at `x`, `y`.
 * Its fields say what it does: a field named `Netclass` puts the net it is on in that class, and a field named `Component Class` names a
 * class for the symbols in the rule area it is on (the editor keeps it and writes it back; it uses none).
 */
export interface DrawingDirective extends DrawingStyle {
  id: string
  type: "directive"
  /** The label's own text, which KiCad leaves empty. */
  text: string
  /** Where the pin is attached (KiCad's `at`). */
  x: number
  y: number
  /** The turn KiCad's `at` has: 0 sends the pin up, 90 left, 180 down, 270 right. */
  rot: Rotation
  shape: DirectiveShape
  /** The pin's length in schematic units (KiCad's `length`). */
  length: number
  look?: TextLook
  /** Every property of the label, with its place and look. */
  fields: LabelField[]
  fieldsAutoplaced?: true
}

/**
 * S3: a bus: a line that carries several nets, which a label of its own names (`D[0..7]`, `{A B}`, see `model/busNames.ts`). It is
 * a polyline of straight segments, each a KiCad `(bus ...)`; a net joins it only through a bus entry, or by the name of a member.
 * Its own `stroke` is the line KiCad drew (width 0 is KiCad's default bus width).
 */
export interface DrawingBus extends DrawingStyle {
  id: string
  type: "bus"
  points: Vec2[]
}

/**
 * S3: a bus entry, the short diagonal that leaves a bus for a wire: it runs from `x`, `y` to `x + dx`, `y + dy` (y up). A wire
 * on one end and a bus on the other is the way a net leaves a bus; the net it joins is the member its label names. `toBus` is a
 * KiCad 5 bus-to-bus entry, which joins two buses instead.
 */
export interface DrawingBusEntry extends DrawingStyle {
  id: string
  type: "busentry"
  x: number
  y: number
  dx: number
  dy: number
  toBus?: true
}

/** S3: the names a bus alias stands for, and the sheet whose file keeps it (absent is the root's): any sheet's label may use any alias. */
export interface BusAlias {
  id: string
  sheet?: string
  name: string
  members: string[]
}

/**
 * Lines, shapes and text drawn on the schematic: by hand with the drawing tools, as Altium's do, and
 * from a KiCad sheet, which also has arcs, curves, circles, text boxes, pictures, tables, junction
 * dots and no-connect flags of its own. They are graphics only: nothing connects to them (a dot or
 * flag only draws), and no check reads them, except the buses and bus entries (S3), which join nets
 * by their members (`model/connectivity.ts`).
 */
export type SchematicDrawing = (
  | DrawingLine
  | DrawingBox
  | DrawingText
  | DrawingCircle
  | DrawingArc
  | DrawingCurve
  | DrawingTextBox
  | DrawingImage
  | DrawingTable
  | DrawingJunction
  | DrawingNoConnect
  | DrawingDirective
  | DrawingBus
  | DrawingBusEntry
) & {
  /** S1: the sheet it is drawn on; absent is the root sheet. */
  sheet?: string
}

/** How pads join a pour of their own net: spokes on every pad, spokes on through-hole pads only, or solid. */
export type ThermalRelief = "relief" | "relief-tht" | "direct"

/** Board-wide rules, all lengths in millimetres. `model/rules.ts` has the defaults and what each one does. */
export interface DesignRules {
  traceWidth: number
  minTraceWidth: number
  /** Widths offered for a trace in the Inspector and cycled with W while routing. */
  preferredWidths: number[]
  /** Copper to copper of another net. */
  clearance: number
  /** Copper to the board edge; pours are inset by it too. */
  edgeClearance: number
  /** Drill edge to drill edge. */
  holeClearance: number
  viaDiameter: number
  viaDrill: number
  /**
   * The smallest via diameter the checks allow (KiCad's `via_min_size`, "Minimum via diameter"); absent is no minimum, which is how a
   * board drawn here starts. A via narrower than this is a check error, as KiCad flags it.
   */
  minViaDiameter?: number
  minDrill: number
  /** Copper ring around a plated hole, (pad - drill) / 2. */
  minAnnularRing: number
  /** Vias may sit in SMD pads, which the fab then fills and caps. */
  viaInPad: boolean
  /** Solder mask opening past the pad edge. */
  maskExpansion: number
  /** Paste aperture past the pad edge; negative shrinks it. */
  pasteExpansion: number
  /** Vias stay covered by solder mask. */
  tentVias: boolean
  /** Pour gap to other nets, unless a zone sets its own. */
  pourClearance: number
  /** Pour necks thinner than this are removed. */
  pourMinWidth: number
  thermalRelief: ThermalRelief
  thermalSpokes: 2 | 4
  thermalSpokeWidth: number
  /** 0 for spokes along the pad's axes, 45 for diagonal ones. */
  thermalSpokeAngle: 0 | 45
  /**
   * The ring of clearance round a pad joined to a pour by spokes, unless a zone or the pad sets its own (KiCad's zone `thermal_gap`).
   * Absent: the pour's clearance, as it always was. A pour kept far from other nets (2.5 mm on a mains board) wants a narrower
   * one: a 2.5 mm ring round a 2.6 mm pad is 7.6 mm across, wider than the copper round it, and the spokes reach nothing.
   */
  thermalGap?: number
  /** Trace width (mm) by net name, for nets that carry current such as supplies and motor outputs. */
  netWidths?: Record<string, number>
  /**
   * Net classes other than Default, in order (`model/netClasses.ts` says how a net finds its class and what a class sets).
   * Absent or empty is a board with no classes: every net is in Default, which is the rules above (X10).
   */
  netClasses?: NetClass[]
  /** What the Default class has that the rules above do not: a name and description of its own, micro via sizes, a differential pair. */
  defaultClass?: DefaultNetClass
  /** Via sizes offered while routing, besides the rule's own (KiCad's `user_via`). */
  viaSizes?: ViaSize[]
  /** Differential pair sizes offered while routing (KiCad's `user_diff_pair`). */
  diffPairSizes?: DiffPairSize[]
  /** The smallest via drill, when it differs from `minDrill`, which is then the through hole's (KiCad's `via_min_drill` and `through_hole_min`). Absent: both are `minDrill`. */
  minViaDrill?: number
  /** The board's minimum clearance (KiCad's `clearance_min`): no pair of nets is checked below it, whatever their classes say. Absent: none. */
  minClearance?: number
  /** Solder mask openings closer than this are merged into one when the mask is plotted (KiCad's `solder_mask_min_width`). Absent or 0: none are. */
  maskMinWidth?: number
  /** Paste aperture growth as a fraction of the pad's size on each side, on top of `pasteExpansion` (KiCad's `pad_to_paste_clearance_ratio`; -0.1 shrinks by 10%). Absent: 0. */
  pasteRatio?: number
  /** The most a drawn circle, arc or round corner may differ from the true one, in mm, where the editor turns one into a polygon (KiCad's `max_error`; its default is 0.005). Absent: that default. */
  maxError?: number
  /** Parts of the board may let the mask bridge between their own pads (KiCad's `allow_soldermask_bridges_in_footprints`); the editor has no mask bridge check, so it is kept and exported. */
  maskBridgesInParts?: boolean
  /** X5: a board that tents vias on one side only, or tents each side by its own rule (KiCad's `setup (tenting ...)`). Absent: `tentVias` is both sides or neither. A via's own `tent` still decides for that via. */
  tentSides?: { front: boolean; back: boolean }
  /** X5, micro vias: the size a new one has (KiCad 5's `uvia_size` and `uvia_drill`), and the smallest the checks allow (`uvia_min_size`, `uvia_min_drill`). */
  microVia?: ViaSize
  minMicroVia?: ViaSize
  /** X5: what the board allows (KiCad 5's `uvias_allowed` and `blind_buried_vias_allowed`). Absent: allowed, as KiCad starts a board. A via of a kind the board does not allow is a check error. */
  microViasAllowed?: boolean
  blindBuriedViasAllowed?: boolean
}

/** A via size: pad diameter and drill, in mm. */
export interface ViaSize {
  diameter: number
  drill: number
}

/** A differential pair size: each trace's width, the gap between them and, where the file has one, the gap between their vias, in mm. */
export interface DiffPairSize {
  width: number
  gap: number
  viaGap?: number
}

/**
 * A net class: the sizes the nets in it start with, and the clearance KiCad checks them at. A size that is absent is the Default class's,
 * that is the rules' (KiCad 9 lets a class leave a field to the Default class, and `.kicad_pro` files do).
 */
export interface NetClass {
  /** Unique, and not "Default": that class is the rules themselves (`DesignRules.defaultClass` holds what else it has). */
  name: string
  description?: string
  /** Copper to copper of another net; two nets are checked at the larger of their classes' (`pairClearance`). */
  clearance?: number
  /** Width of new traces on the net's nets. */
  traceWidth?: number
  viaDiameter?: number
  viaDrill?: number
  microViaDiameter?: number
  microViaDrill?: number
  diffPairWidth?: number
  diffPairGap?: number
  /** Nets in the class, by name, as the schematic names them. */
  nets: string[]
  /** Wildcard patterns (`*` and `?`, or a regular expression) that also put a net in the class, as KiCad's net class patterns do. */
  patterns?: string[]
  /**
   * S8: nets a directive label of the schematic puts in the class (`model/directives.ts`): worked out from the labels after every edit of the
   * schematic, never set by hand, so a label that moves or goes takes its net out of the class. A net listed in `nets` is in the class either way.
   */
  labelNets?: string[]
  /** S8: the class exists only because a directive label names it and the project does not define it (KiCad's implicit class: it sets no size). It goes when no label names it. */
  implicit?: true
}

/** What the Default class has that the design rules do not hold: a name and description of its own and sizes that only a class has. */
export interface DefaultNetClass {
  name?: string
  description?: string
  microViaDiameter?: number
  microViaDrill?: number
  diffPairWidth?: number
  diffPairGap?: number
}

/**
 * S1: a sheet of the schematic, drawn once. The root sheet is `ROOT_SHEET` (it needs no entry: a project with no `sheets` is one sheet);
 * every other is used by one or more sheet symbols (`SheetSymbol`) on a sheet above it. Its wires, labels, drawings and blocks are tagged
 * with its id (`sheet`), its symbols with the use of it they are on (`ComponentInstance.inst`).
 */
export interface SchematicSheet {
  id: string
  /**
   * The file a sheet imported from KiCad was read from, by its name alone (`power.kicad_sch`): the KiCad export writes the sheet back to the same name, so the
   * history of a KiCad project's files in git stays whole. Never shown or asked for; absent for a sheet made here, which is named after its sheet symbol.
   */
  file?: string
  /** The root's name, which the sheet tree and tabs show (`Main` when absent); a sheet below it is named by the symbol that uses it. */
  name?: string
  /** The sheet file's title block (Title, Date, Rev, Company, Comment1...), where it is not the root's, which the project's properties hold. */
  titleBlock?: { key: string; value: string }[]
  /**
   * S11: the sheet is joined by KiCad's rules (a wire end on another wire's side joins only through a junction, a label on a pin on a wire's
   * side joins the pin alone, points join only where they are exactly the same, to KiCad's 100 nm). Set on a sheet imported from KiCad that has
   * such a case; absent on every sheet drawn in the editor, which keeps the editor's own rules.
   */
  kicadRules?: true
}

/** S1: a pin of a sheet symbol: where a net leaves the sheet for its parent. Its name is the text of a hierarchical label in the sheet. */
export interface SheetPin {
  id: string
  name: string
  /** The shape of the flag: the direction of the signal, as a label's shape. */
  shape: LabelShape
  x: number
  y: number
  /** Which edge of the symbol it is on and which way it points: 0 on the right edge, 90 top, 180 left, 270 bottom. */
  rot: Rotation
  /** Size, style and justification of its text. */
  look?: TextLook
}

/**
 * S1: a sheet symbol: the rectangle on a sheet that stands for a use of another sheet, with the pins that join them. Its `id` is
 * short and is what the paths of a sheet's uses are made of.
 */
export interface SheetSymbol {
  id: string
  /** The sheet it is drawn on. */
  sheet: string
  /** The sheet it stands for. */
  child: string
  /** The rectangle, by its lower-left corner and size (y up). */
  x: number
  y: number
  w: number
  h: number
  /** The `Sheetname` field: what the sheet is called on the parent. */
  name: string
  pins: SheetPin[]
  /** The other fields and every field's place and look, by name (`Sheetname`, `Sheetfile`, a user field) with its value. */
  fields?: { name: string; value: string; place: FieldPlace }[]
  /** Its border and fill; absent is KiCad's default. */
  stroke?: SheetStroke
  fill?: SheetFill
  /** The flags it carries as a symbol does: `dnp`, `excludeFromBom`, `notOnBoard`, `excludeFromSim` (each only when set). */
  flags?: Pick<PartFlags, "dnp" | "excludeFromBom" | "notOnBoard" | "excludeFromSim">
  /** S9: what each variant changes on this sheet symbol, by the path of the use of its parent sheet it is drawn on (`` for the root), then the variant's name. */
  variants?: Record<string, Record<string, VariantOverride>>
  /** KiCad's `fields_autoplaced`. */
  fieldsAutoplaced?: true
}

/** How a net is drawn on the schematic when Tidy draws it: net labels, or power and ground ports. */
export type NetStyle = "label" | "port"

export interface Project {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
  components: ComponentInstance[]
  wires: Wire[]
  labels: NetLabel[]
  /** S1: the sheets of the schematic besides what the root holds, and the sheet symbols that use them. Absent: one sheet. */
  sheets?: SchematicSheet[]
  sheetSymbols?: SheetSymbol[]
  /** S3: the bus aliases of the schematic, in file order; any label may name one inside a bus group (`{USB CLK}`). */
  busAliases?: BusAlias[]
  /** S9: the schematic variants (KiCad 10) and the one shown. Absent: no variants. */
  variants?: ProjectVariants
  /**
   * S1: set only on a view of one use of a sheet (`sheetView` in `model/sheets.ts`), whose items are that sheet's alone: the path
   * of the use it shows. Never stored, never on a project the user has open.
   */
  scope?: string
  traces: Trace[]
  vias: Via[]
  zones: Zone[]
  texts: BoardText[]
  /** Drawings on the board itself, on any layer (lines, arcs, circles, rectangles, polygons, curves, ellipses). */
  graphics?: BoardGraphic[]
  /** Dimensions on the board (KiCad's), whose lines and text are worked out from them (`model/dimensions.ts`). */
  dimensions?: BoardDimension[]
  /** Groups of the board's items (KiCad's). */
  groups?: PcbGroup[]
  /** Reference images, which are bitmaps held by the host's model file store. */
  images?: ReferenceImage[]
  board: BoardDef
  rules: DesignRules
  /** Functional blocks of the schematic, each drawn as a titled frame around its parts. */
  blocks?: SchematicBlock[]
  /** Lines, shapes and text drawn on the schematic, bottom first. */
  drawings?: SchematicDrawing[]
  /**
   * S2: how the project's nets are named. Absent: by the editor's rule (a label's text, `Net-(R1-2)` for the
   * rest). `kicad`: as KiCad names them, from `/NAME` for a local label to `Net-(R1-Pad2)`, by its driver
   * priority; `kicad6` is the same with KiCad 6's `Net-(R1-Pad2)` for every unnamed net; `kicad5` is KiCad 5's (a legacy `.sch`): those names, and its order of drivers (a hierarchical label above a local one, a nearer sheet first). Set by the import.
   */
  netNames?: "kicad" | "kicad6" | "kicad5"
  /** Parts made for this project that aren't in the library. */
  parts?: CustomPartSpec[]
  /** S10: the symbol drawings the project's parts use, by key (a hash of the drawing), each stored once. */
  symbols?: Record<string, SymbolDrawing>
  /**
   * Land patterns neither the library nor the footprinter has, such as those of a board brought
   * in from elsewhere. Components and project parts name them like any other footprint.
   */
  footprints?: FootprintDef[]
  /**
   * 3D models, one per part and footprint. A part without one is drawn with its built-in model
   * (`libraryModels.ts`) if it has one, and otherwise shows only its pads.
   */
  models?: ModelAssignment[]
  /** Free-form project properties such as revision, author or licence, in the order they were added. */
  properties?: { key: string; value: string }[]
  /** Electrical check findings the user ignored, by key, e.g. "bare-led:c_4" (see model/erc.ts). */
  ignoredChecks?: string[]
  /**
   * How Tidy draws a net, where someone chose, by the name its labels and ports give it (`NAME` for KiCad's `/NAME`):
   * `label` draws it with net labels even when its name or pins make it a supply (a 10 A path named VBUS through a fuse),
   * `port` with power or ground ports. Absent: Tidy decides from the net's ports, name and pins (`model/tidy/nets.ts`).
   */
  netStyles?: Record<string, NetStyle>
  /**
   * What a KiCad import set by itself, so it can be undone or retired without touching the user's own
   * choices (`model/importMarks.ts`): the keys in `ignoredChecks` it wrote, and the pins it marked no
   * connect (`ComponentInstance.nc`) by component id.
   */
  importMarks?: { checks?: string[]; noConnect?: Record<string, string[]> }
}

export interface PinRef {
  componentId: string
  pin: string
}

export interface Net {
  id: string
  name: string
  /** True when the name came from a label or power port. */
  named: boolean
  pins: PinRef[]
  /**
   * S2: in a project named as KiCad names its nets, the label that gives the net its name: the text to type
   * and whether it is a local label (`/NAME`) or a global one (`NAME`). Absent when a power symbol names it
   * or nothing does.
   */
  label?: { text: string; kind: LabelKind }
  /** S2: the power symbol (or hidden power pin) that gives the net its name: the net it names, and whether it is a local power symbol (`/NAME`). */
  power?: { text: string; local: boolean }
}
