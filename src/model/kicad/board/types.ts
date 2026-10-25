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
  nets: string[]
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

export interface KicadModel {
  path: string
  /** Offset in millimetres (stamps before 20171114 wrote inches). */
  offset: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  rotate: { x: number; y: number; z: number }
  hidden: boolean
  node: List
}

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
  hasArcs: boolean
  filled: boolean
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
  userTraceWidths: number[]
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
  /** Lists the typed fields do not cover, by token: dimensions, groups, images, targets, generated patterns... */
  others: Record<string, List[]>
  /** The root `(kicad_pcb ...)` list, whole. */
  tree: List
}
