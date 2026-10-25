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
  node: List
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
  /** The outlines KiCad drew a TrueType text with (`render_cache`), which decide its silkscreen shapes (X19). */
  renderCache: boolean
  /** The property's name when the text is a footprint field (`Reference`, `Value`, `Datasheet`...). */
  field: string | null
  /** A text box (`gr_text_box`, `fp_text_box`): its corners, whether it is an outline of points, its border and margins. */
  box: { start: Pt; end: Pt; hasOutline: boolean; border: boolean; strokeWidth: number | null; margins: [number, number, number, number] | null } | null
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
  /** The shape has a start or end shape (an arrowhead), or its own colour: KiCad 10 things the editor does not hold. */
  ending: boolean
  colored: boolean
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
  /** `copper`, `keepout`, `rule-area`, `teardrop` or `placement`. */
  kind: string
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
  props: { key: string; value: string }[]
  pads: KicadPad[]
  models: KicadModel[]
  texts: KicadText[]
  shapes: KicadShape[]
  zones: KicadZone[]
  /** Groups of the footprint's own pads, drawings, texts and groups: their members are ids of the footprint's children. */
  groups: KicadGroup[]
  /** Layers the footprint draws on that KiCad shows and plots on no board layer (`private_layers`, KiCad 7). */
  privateLayers: string[]
  /** Net tie groups: lists of pad numbers whose nets may meet. KiCad 5 tags that say "net tie" make one group of every pad. */
  netTies: string[][]
  /** Jumper pad groups (KiCad 9): lists of pad numbers connected inside the part. */
  jumperGroups: string[][]
  /** `(duplicate_pad_numbers_are_jumpers yes)` (KiCad 9): pads that share a number are jumpers. */
  jumperDuplicates: boolean
  node: List
}

export interface KicadSegment {
  start: Pt
  end: Pt
  width: number
  layer: string
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
  net: string | null
  netRaw: string | null
  badNet?: string
  locked: boolean
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
  /** Lists the typed fields do not cover, by token: dimensions, groups, images, targets, generated patterns... */
  others: Record<string, List[]>
  /** The root `(kicad_pcb ...)` list, whole. */
  tree: List
}
