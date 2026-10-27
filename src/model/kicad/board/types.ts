import type { LineEnd } from "../../types"
import type { List } from "./sexpr"

// A KiCad board as typed data, for every file version. Coordinates are KiCad's own: millimetres,
// y down, angles in degrees counter-clockwise on screen. Nothing is converted to the editor's
// frame here (that is `build.ts`). Every typed object keeps `node`, its list from the file, so
// whatever the typed fields leave out is still there for a later slice to read: the reader loses
// nothing, and what the importer does with each node is in the import report.

export interface Pt {
  x: number
  y: number
}

/** Which KiCad release wrote the file, from its version stamp (docs/kicad-import.md, 3.2). */
export type Era = "kicad3" | "kicad4" | "kicad5" | "pre6-nightly" | "kicad6" | "kicad7" | "kicad8" | "kicad9" | "kicad10" | "kicad11-dev" | "unknown"

export interface LayerRow {
  ordinal: number
  name: string
  type: string
  /** The name the user gave the layer, as in `(31 B.Cu signal "Back")`. */
  userName?: string
}

export interface KicadNet {
  /** The net's number in the file; null from stamp 20251028, which has none. */
  code: number | null
  /** The name as the file writes it. */
  raw: string
  /** The name as the user reads it: `{slash}` is `/`. */
  name: string
}

/** A KiCad 4 and 5 net class, which lives in the board (later ones live in the project file). */
export interface LegacyNetClass {
  name: string
  description: string
  clearance: number
  traceWidth: number
  viaDiameter: number
  viaDrill: number
  uviaDiameter: number
  uviaDrill: number
  diffPairWidth?: number
  diffPairGap?: number
  /** The members as the user reads them (`{slash}` as `/`). */
  nets: string[]
  /** The members as the file spells them, which is how the file's nets are keyed. */
  netsRaw: string[]
  /** The fields a class block of the file leaves out, by KiCad's names: KiCad 5 writes all six, so a missing one is a file this importer cannot take exactly. */
  missing: string[]
}

export interface KicadPad {
  /** The pad's number as written; empty for an unnumbered pad. */
  number: string
  type: string
  shape: string
  /** Position in the footprint's own frame, unturned. */
  at: Pt
  /** The pad's angle as stored: absolute, in the board frame (docs/kicad-import.md, 2.4). 0 when absent. */
  angle: number
  hasAngle: boolean
  w: number
  h: number
  layers: string[]
  drill: { oval: boolean; w: number; h: number; offset: Pt | null } | null
  /** The pad's net, as the user reads it, or null for no net. */
  net: string | null
  netRaw: string | null
  pinFunction?: string
  pinType?: string
  rectDelta?: Pt
  roundrectRatio?: number
  /** `chamfer_ratio`, and the corners `chamfer` names (this importer's own bits: 1 top left, 2 top right, 4 bottom right, 8 bottom left, as the pad is seen). */
  chamferRatio?: number
  chamferCorners?: number
  /** A custom pad's anchor shape, whether its pour clearance follows the convex hull, and its drawings with the pad's own proxy items (a number box, a spoke template), which are never plotted. */
  anchor?: "circle" | "rect"
  hull?: boolean
  primitives: KicadShape[]
  proxies: KicadShape[]
  /** The pad's own margins, clearance and pour settings as the file writes them, with a zero in a file up to stamp 20240201 already read as no setting (KiCad's own rule). `zoneConnect` is KiCad's number (0 none, 1 thermal, 2 solid, 3 thermal on through-hole pads). */
  local: PadLocal
  /** `pad_prop_*` words of the pad's `property`. */
  properties: string[]
  /** The pad has a `padstack` node (KiCad 9), and its `(remove_unused_layers)` and `(keep_end_layers)`. */
  padstack: boolean
  /** The pad stack's layers when it has one (`(padstack (mode ...) (layer ...))`, X1); null for a pad whose layers all share the pad's own shape. */
  stack: KicadPadStack | null
  /** `(tenting (front yes) (back no))` of the pad, each side as written; absent for a side it does not say (X5). `none` is both sides unset. */
  tenting?: { front?: boolean; back?: boolean }
  removeUnused?: boolean
  keepEnds?: boolean
  /** `(zone_layer_connections L1 L2 ...)` of a pad: the copper layers a pour joins it on when its unused layers are removed (KiCad 9 and 10 write what the last fill found); the layer names as written, `[]` for the node with none, null when the pad has no such node (X31). */
  zoneLayers: string[] | null
  /** A `tenting` that says yes or no for a side (`none` is no setting). */
  tented: boolean
  node: List
}

/** One layer of a pad stack as the file writes it: the shape, the size, the offset, the corner and pour settings, and the drawings of a custom shape. Absent is what the layer does not say. */
export interface KicadPadLayer {
  /** The layer's name as the file writes it: `Inner` or a copper layer's. */
  name: string
  shape?: string
  w?: number
  h?: number
  offset?: Pt
  rectDelta?: Pt
  roundrectRatio?: number
  chamferRatio?: number
  chamferCorners?: number
  anchor?: "circle" | "rect"
  hull?: boolean
  primitives: KicadShape[]
  proxies: KicadShape[]
  thermalGap?: number
  thermalWidth?: number
  thermalAngle?: number
  zoneConnect?: number
  clearance?: number
  node: List
}

export interface KicadPadStack {
  mode: "front_inner_back" | "custom"
  layers: KicadPadLayer[]
}

/** What a pad or a footprint sets for itself: margins, clearance and how a pour joins it. Absent is no setting. */
export interface PadLocal {
  maskMargin?: number
  pasteMargin?: number
  pasteRatio?: number
  clearance?: number
  zoneConnect?: number
  thermalGap?: number
  thermalWidth?: number
  thermalAngle?: number
}

export interface KicadText {
  /** `reference`, `value` or `user` for a footprint's own text; `board` for gr_text. */
  kind: string
  text: string
  at: Pt
  /** The angle as stored: the board-frame angle, in every release (docs/kicad-import.md, section 10). The position is in the footprint's own frame for a footprint's text. */
  angle: number
  /** False when the text is "unlocked" (`(at x y a unlocked)` or `(unlocked yes)`): it may turn upside down with its part. */
  keepUpright: boolean
  layer: string
  /** The glyph width and height (mm). In the file `(size h w)` gives the height first. */
  w: number
  h: number
  thickness: number
  hide: boolean
  mirror: boolean
  justify: string[]
  /** `(layer F.Cu knockout)`: drawn as a hole in a filled box. */
  knockout: boolean
  bold: boolean
  italic: boolean
  /** The font face the text names (a TrueType font); null for KiCad's own stroke font. */
  face: string | null
  lineSpacing: number
  href: string | null
  locked: boolean
  /**
   * The outlines KiCad drew a TrueType text with (`render_cache`), which decide its silkscreen shapes (X19): the text and angle the file gives them, and the
   * polygons, each a list of rings (its outline, then its holes) of x, y, x, y... in whole nanometres in the editor's frame (y up).
   */
  renderCache: { text: string; angle: number; polygons: number[][][] } | null
  /** The property's name when the text is a footprint field (`Reference`, `Value`, `Datasheet`...). */
  field: string | null
  /** A text box (`gr_text_box`, `fp_text_box`): its corners, whether it is an outline of points, its border and margins. */
  box: { start: Pt; end: Pt; hasOutline: boolean; corners: Pt[]; border: boolean; strokeWidth: number | null; margins: [number, number, number, number] | null } | null
  node: List
}

export type ShapeKind = "line" | "arc" | "circle" | "rect" | "poly" | "curve" | "bbox" | "ellipse" | "ellipse_arc"

export interface KicadShape {
  kind: ShapeKind
  layer: string
  start?: Pt
  end?: Pt
  /** An arc's middle point: read from `mid`, or worked out from a legacy arc's centre and sweep. */
  mid?: Pt
  center?: Pt
  pts?: Pt[]
  /** A polygon outline with arcs among its points. */
  hasArcs?: boolean
  /** A polygon's outline in file order: its points and its arcs. */
  polyItems?: ({ xy: Pt } | { arc: { start: Pt; mid: Pt; end: Pt } })[]
  /** A legacy arc as written: start is its centre, end the first end, this the sweep. */
  legacySweep?: number
  width: number
  /** Filled solid (`fill solid`, `yes`, or a legacy shape that is filled by its absence). */
  filled: boolean
  /** The fill is a hatch (`hatch`, `reverse_hatch`, `cross_hatch`), which the editor cannot draw. */
  hatched: boolean
  /** The stroke style (`dash`, `dot`...), or null for solid. */
  dash: string | null
  locked: boolean
  /** Every layer the shape names: `(layer X)` is one, `(layers X Y)` can be several. */
  layers: string[]
  /** The shape's net (copper shapes can have one), as the user reads it and as the file spells it. */
  net: string | null
  netRaw: string | null
  /** The net number a copper drawing names that the net table does not list (KiCad loads it with no net). */
  badNet?: string
  /** A rectangle's corner radius (KiCad 10), 0 for none. */
  radius: number
  /** An ellipse or elliptical arc: centre, radii, and the major axis' angle in degrees as the file writes it (KiCad's frame), with the sweep of an arc. */
  ellipse?: { center: Pt; major: number; minor: number; rotation: number; start?: number; end?: number }
  /** The shape's own solder mask margin, when it writes one. */
  maskMargin?: number
  /** X24: what KiCad 10 puts at the line's ends (`start_shape`, `end_shape`) and the colour it draws it in (`stroke (color r g b a)`); the editor keeps both and draws neither. */
  ends?: { start?: LineEnd; end?: LineEnd }
  color?: [number, number, number, number]
  node: List
}

/** A `target` mark: a circle with a cross or an X, drawn on one layer. */
export interface KicadTarget {
  shape: "plus" | "x"
  at: Pt
  size: number
  width: number
  layer: string
  node: List
}

/**
 * A dimension as the file has it, read as KiCad reads it (`parseDIMENSION`, pcb_io_kicad_sexpr_parser.cpp): every setting the constructor gives
 * its kind is in place before the file's own are applied, a KiCad 5 dimension (`feature1`, `crossbar`... and a text) is an aligned dimension whose
 * height comes from its crossbar and whose units come from its text, and its arrows and feature lines are not read (KiCad draws its own).
 * Numbers are millimetres in KiCad's frame (y down), except where said.
 */
export interface KicadDimension {
  legacy: boolean
  kind: "aligned" | "orthogonal" | "leader" | "center" | "radial"
  /** The layer: the dimension's own and its text's name the same layer in a file KiCad wrote; the one read last wins, as the object is both. */
  layer: string
  start: Pt
  end: Pt
  /** Aligned and orthogonal: KiCad's height, truncated to a nanometre as `UpdateHeight` makes it for a KiCad 5 dimension. */
  height: number
  vertical: boolean
  /** The extension height the file gives, or null for KiCad's default for a dimension that has none. */
  extensionHeight: number | null
  extensionOffset: number
  /** Radial: the leader length the file gives, or null for KiCad's default (three default arrow lengths). */
  leaderLength: number | null
  /** Leader: the text frame, 0 none, 1 rectangle, 2 circle, 3 rounded rectangle. */
  frame: number
  thickness: number
  arrowLength: number
  inward: boolean
  /** 0 outside, 1 inline, 2 manual (3, which KiCad takes as manual, is 2). */
  textMode: number
  keep: boolean
  /** The units mode (0 inches, 1 mils, 2 millimetres, 3 automatic), or null when the units of a KiCad 5 dimension's text are not one of those. */
  units: number | null
  format: number
  precision: number
  zeros: boolean
  prefix: string
  suffix: string
  /** The text that replaces the measured value, or null. */
  override: string | null
  /** The dimension's text as the file has it (its place, size and flags); null for a centre mark. */
  text: KicadText | null
  locked: boolean
  /** The id the file gives it: the dimension's, or its text's when that comes later (they are one object in KiCad). */
  uuid: string | null
  node: List
}

/** A group as the file has it: its members are the ids of other things in the file. */
export interface KicadGroup {
  name: string
  uuid: string | null
  locked: boolean
  libId: string | null
  members: string[]
  node: List
}

/** A reference image as the file has it. */
export interface KicadImage {
  at: Pt
  layer: string
  scale: number
  locked: boolean
  uuid: string | null
  /** The image's bytes (as the file's base64 decodes), its format, and the size and resolution KiCad reads from them. `format` is null for bytes that are neither a PNG nor a JPEG. */
  data: Uint8Array
  format: "png" | "jpg" | null
  px: number
  py: number
  ppi: number
  /** The resolution a KiCad before 20260623 derived (which truncated pixels per centimetre), and the file's version rescales the image by the ratio. */
  legacyPpi: number
  node: List
}

export interface KicadModel {
  path: string
  /** Offset in millimetres (stamps before 20171114 wrote inches). */
  offset: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  rotate: { x: number; y: number; z: number }
  hidden: boolean
  node: List
}

/** One piece of a zone's outline: a corner, or an arc through three points (KiCad 7 and later write them). */
export type KicadZoneSeg = { kind: "xy"; at: Pt } | { kind: "arc"; start: Pt; mid: Pt; end: Pt }

export interface KicadZone {
  net: string | null
  netRaw: string | null
  /** Copper layers it is on, as the file names them. */
  layers: string[]
  name: string
  priority: number
  /** The zone's `uuid` (KiCad 7 and later) or `tstamp` (6), as written; absent in a file that gives none. */
  uuid?: string
  /** `copper`, `keepout`, `rule-area` or `teardrop`. */
  kind: string
  /** X20: the rule area's `placement` node: whether it places parts, and the sheet, component class or group it names (the file's default is a sheet with no name). Null when the file has none. */
  placement: { enabled: boolean; by: "sheet" | "class" | "group"; name: string } | null
  keepout: { tracks: boolean; vias: boolean; pads: boolean; copperpour: boolean; footprints: boolean } | null
  polygon: Pt[]
  /** Every `(polygon (pts ...))` with its arcs: the first is the outline and the others are holes in it. */
  rings: KicadZoneSeg[][]
  hasArcs: boolean
  filled: boolean
  /** `connect_pads`: absent is a thermal relief on every pad, `yes` solid, `no` none, `thru_hole_only` thermal on through-hole pads. */
  connect: "thermal" | "yes" | "no" | "thru_hole_only"
  /** `connect_pads (clearance ...)`, null when the file gives none. */
  clearance: number | null
  minThickness: number | null
  thermalGap: number | null
  thermalBridge: number | null
  smoothing: "none" | "chamfer" | "fillet"
  radius: number
  /** `island_removal_mode`: 0 always (the default), 1 never, 2 below an area. */
  islandMode: number
  /** `island_area_min`, mm^2, null when the file gives none. */
  islandArea: number | null
  /** `fill (mode ...)`: segment (the old one, which KiCad 6 and later read as polygon), polygon and solid are one; hatch and thieving are not. */
  fillMode: "polygon" | "hatch" | "thieving"
  /** X24: the grid of a hatched fill (`hatch_thickness`, `hatch_gap`, `hatch_orientation`, `hatch_border_algorithm`, `hatch_min_hole_area`, `hatch_smoothing_level`, `hatch_smoothing_value`); null for a fill that is not hatched, and a number is null where the file gives none. */
  hatch: { thickness: number | null; gap: number | null; angle: number; minHole: number | null; thinBorder: boolean; smoothLevel: number; smoothValue: number | null } | null
  /** X24: `property` (KiCad 10): the layer each names and where its hatch pattern starts; `other` is the name of any other setting in one, which the importer does not know. */
  properties: { layer: string; at: Pt | null; other: string | null }[]
  teardrop: "padvia" | "track_end" | null
  /** The file has no `filled_areas_thickness`: its filled polygons are shrunk by half the minimum width and were drawn with a pen that wide (KiCad 5 and earlier), and KiCad 6 and later read them as the copper they drew. */
  strokedFill: boolean
  locked: boolean
  inFootprint: boolean
  node: List
}

export interface KicadFootprint {
  /** The library name and footprint, `Resistor_SMD:R_0603_1608Metric`; empty when the file gives none. */
  name: string
  ref: string
  value: string
  at: Pt
  angle: number
  /** The footprint came with `(transform ...)` instead of `(at ...)` (stamp 20260616 and later). */
  transformed: boolean
  scale: number
  side: "top" | "bottom"
  locked: boolean
  placed: boolean
  attr: string[]
  /** Whether the file has an `attr` node; without one, stamps before 20200826 mean through-hole. */
  hasAttr: boolean
  throughHole: boolean
  descr: string
  tags: string
  /** The link to the schematic symbol: `(path /5A1B2C3D)` or `(path "/uuid/uuid")`. */
  path: string
  sheetname: string
  sheetfile: string
  /** X20: the footprint's `component_classes`, each name once, in the file's order. */
  classes: string[]
  /** X23: what each board variant changes on the footprint (KiCad 10's `variant` nodes), in the file's order. */
  variants: KicadVariant[]
  /** X23: the footprint's `units`: a name and the pad numbers of each unit. */
  units: { name: string; pins: string[] }[]
  /** X23: the footprint's `point` nodes, in the footprint's own frame (an older file's, which has them in the board's, are brought into it). */
  points: KicadPoint[]
  props: { key: string; value: string }[]
  pads: KicadPad[]
  /** The footprint's own margins, clearance and pour connection, which each of its pads that sets none of its own takes (`PAD::GetSolderMaskExpansion` and the others ask the footprint). */
  local: PadLocal
  models: KicadModel[]
  texts: KicadText[]
  shapes: KicadShape[]
  zones: KicadZone[]
  /** X27: the dimensions drawn inside the footprint; their points are the board's in every file before stamp 20260616, which is every file there is. */
  dimensions: KicadDimension[]
  /** Groups of the footprint's own pads, drawings, texts and groups: their members are ids of the footprint's children. */
  groups: KicadGroup[]
  /** Layers the footprint draws on that KiCad shows and plots on no board layer (`private_layers`, KiCad 7). */
  privateLayers: string[]
  /** `(embedded_fonts yes)`: the footprint may use fonts embedded in the file (KiCad 9). */
  embedFonts: boolean
  /** Net tie groups: lists of pad numbers whose nets may meet. KiCad 5 tags that say "net tie" make one group of every pad. */
  netTies: string[][]
  /** Jumper pad groups (KiCad 9): lists of pad numbers connected inside the part. */
  jumperGroups: string[][]
  /** `(duplicate_pad_numbers_are_jumpers yes)` (KiCad 9): pads that share a number are jumpers. */
  jumperDuplicates: boolean
  node: List
}

/** X23: what one board variant changes on one footprint. A flag the node does not say is the footprint's own (`undefined`); `fields` are the field values the variant sets. */
export interface KicadVariant {
  name: string
  dnp?: boolean
  excludeFromBom?: boolean
  excludeFromPos?: boolean
  excludeFromSim?: boolean
  fields: { name: string; value: string }[]
}

/** X23: a `point` node: a PCB point (KiCad 10) at a place, of a size, on a layer. */
export interface KicadPoint {
  at: Pt
  size: number
  layer: string
  node: List
}

export interface KicadSegment {
  start: Pt
  end: Pt
  width: number
  layer: string
  /** X24: the mask layers the track names beside its copper layer, which open the mask along it, and its own margin for the opening (null when the file gives none). */
  mask: string[]
  maskMargin: number | null
  net: string | null
  /** The net as the file spells it, the key everywhere a net is compared. */
  netRaw: string | null
  /** The net number the board's net table does not list, which KiCad loads as no net. */
  badNet?: string
  locked: boolean
  node: List
}

export interface KicadArcTrack {
  start: Pt
  mid: Pt
  end: Pt
  width: number
  layer: string
  mask: string[]
  maskMargin: number | null
  net: string | null
  netRaw: string | null
  badNet?: string
  locked: boolean
  node: List
}

export interface KicadVia {
  at: Pt
  size: number
  drill: number
  /** The two layers it joins, front first as the file lists them. */
  layers: string[]
  kind: "through" | "blind" | "micro" | "buried"
  /** `(free)`: KiCad keeps the net of the via when a track is dragged. */
  free: boolean
  /** What becomes of the via's copper on layers nothing connects to: `remove_unused_layers` with `keep_end_layers` or without, or KiCad 10's `start_end_only`; absent keeps every layer. */
  unused?: "remove" | "keepEnds" | "startEnd"
  /** `(zone_layer_connections L1 L2 ...)`: the layers a pour joins the via on; the layer names as written. Absent when the node is. */
  zoneLayers?: string[]
  /** `(tenting (front yes) (back no))` of the via, or the older `(tenting front back)` words; absent for a side it does not say. */
  tenting?: { front?: boolean; back?: boolean }
  /** `(padstack (mode ...) (layer "Inner" (size d)) ...)`: the via's diameter per layer. Absent for a via with one diameter. */
  stack?: { mode: "front_inner_back" | "custom"; sizes: { name: string; size: number }[] }
  net: string | null
  netRaw: string | null
  badNet?: string
  locked: boolean
  node: List
}

/** The board's physical stackup (`setup (stackup ...)`, X1), as the rows and settings the file lists. */
export interface KicadStackup {
  rows: KicadStackupRow[]
  /** `copper_finish` as written. */
  finish?: string
  edgePlating?: boolean
  dielectricConstraints?: boolean
  edgeConnector?: "none" | "yes" | "bevelled"
  castellated?: boolean
  /** Rows KiCad does not keep (a layer listed twice, which it takes for a stackup appended twice, or more than 128): how many. */
  dropped: number
  node: List
}

/** One `(layer ...)` of a stackup; the sublayers of a dielectric (`addsublayer`) come with it. */
export interface KicadStackupRow {
  name: string
  type: string
  thickness?: number
  locked?: boolean
  material?: string
  epsilonR?: number
  lossTangent?: number
  color?: string
  specFreq?: number
  model?: "constant" | "djordjevic_sarkar"
  sub: Omit<KicadStackupRow, "name" | "type" | "sub">[]
}

/** A font file embedded in a board or a footprint: its bytes as the file stores them (compressed by KiCad), and the checksum the file gives. */
export interface KicadFontFile {
  name: string
  /** The footprint that embeds it; null for the board. */
  owner: KicadFootprint | null
  bytes: Uint8Array
  checksum: string | null
  /** The `file` node it was read from. */
  node: List
}

export interface KicadBoard {
  /** The `(version N)` stamp; null when the file has none. */
  version: number | null
  era: Era
  generator: string | null
  generatorVersion: string | null
  host: string | null
  thickness: number | null
  /** Title block entries and board properties, in file order. */
  properties: { key: string; value: string }[]
  layers: LayerRow[]
  copper: { names: string[]; front: string; back: string }
  /** The number of copper layers the board declares. */
  copperLayerCount: number
  /** The board's stackup when its setup has one. */
  stackup: KicadStackup | null
  /** `setup (tenting ...)`: the sides vias are tented on, or null when the file has none (KiCad's default is both). */
  tenting: { front: boolean; back: boolean } | null
  /** Numeric `setup` values by token: `last_trace_width`, `pad_to_mask_clearance`... */
  setup: Record<string, number>
  /** `setup` entries that are one word, not a number: `allow_soldermask_bridges_in_footprints yes`. */
  setupWords: Record<string, string>
  userTraceWidths: number[]
  /** `(user_via diameter drill)` entries: the via sizes offered while routing. Every number as written; one that is not a number is kept as NaN. */
  userVias: { diameter: number; drill: number }[]
  /** `(user_diff_pair width gap via_gap)` entries: the differential pair sizes offered while routing. */
  userDiffPairs: { width: number; gap: number; viaGap?: number }[]
  nets: KicadNet[]
  /** X23: the board's `variants` list, a name and a description each. */
  variants: { name: string; description: string }[]
  /** X23: the board's own `point` nodes. */
  points: KicadPoint[]
  /** `(padsonsilk true)` in the plot settings: a pad that lists a silkscreen layer is plotted there. */
  padsOnSilk: boolean
  netClasses: LegacyNetClass[]
  footprints: KicadFootprint[]
  segments: KicadSegment[]
  arcTracks: KicadArcTrack[]
  vias: KicadVia[]
  zones: KicadZone[]
  shapes: KicadShape[]
  targets: KicadTarget[]
  texts: KicadText[]
  dimensions: KicadDimension[]
  groups: KicadGroup[]
  images: KicadImage[]
  /** `(embedded_fonts yes)` of the board and the font files the board and its footprints embed (X19), their bytes as the file stores them. */
  embeddedFonts: { board: boolean; files: KicadFontFile[] }
  /** Lists the typed fields do not cover, by token: dimensions, groups, images, targets, generated patterns... */
  others: Record<string, List[]>
  /** The root `(kicad_pcb ...)` list, whole. */
  tree: List
}
