import type { List } from "../board/sexpr"

// A KiCad schematic as typed data, for every file version from KiCad 6 on. Coordinates are KiCad's
// own: millimetres, y down on the sheet (symbol drawings are y up), angles in degrees
// counter-clockwise on screen. Nothing is converted to the editor's frame here (that is
// `build.ts`). Every typed object keeps `node`, its list from the file, so whatever the typed
// fields leave out is still there for a later slice to read: the reader loses nothing, and what
// the importer does with each node is in the import report.

export interface Pt {
  x: number
  y: number
}

/** Which KiCad release wrote the file, from its version stamp (docs/kicad-import-schematic.md, section 6). */
export type SchEra = "pre6-nightly" | "kicad6" | "kicad7" | "kicad8" | "kicad9" | "kicad10" | "kicad11-dev" | "unknown"

/** A field: `(property "Reference" "R1" (at ...) (effects ...))`. A value of `~` before stamp 20250318 is empty and is read as such. */
export interface SchProperty {
  name: string
  value: string
  hide: boolean
  at: Pt | null
  node: List
}

export interface LibPin {
  number: string
  name: string
  /** KiCad's electrical type, `no_connect` also for the old `unconnected`. */
  type: string
  /** The pin's graphic style: `line`, `inverted`, `clock`... */
  shape: string
  /** The connection point, in the symbol's own frame (y up). */
  at: Pt
  /** The direction the pin points from its connection point toward the body: 0 right, 90 up, 180 left, 270 down. */
  angle: number
  length: number
  hidden: boolean
  /** The unit it belongs to; 0 for a pin shared by every unit. */
  unit: number
  /** The body style (De Morgan) it belongs to; 0 for every style. */
  bodyStyle: number
  alternates: { name: string; type: string; shape: string }[]
  node: List
}

export type LibGraphicKind = "polyline" | "rectangle" | "circle" | "arc" | "bezier" | "ellipse" | "text" | "text_box" | "other"

export interface LibGraphic {
  kind: LibGraphicKind
  unit: number
  bodyStyle: number
  /** The points of a polyline or bezier, the corners of a rectangle (start, end), the centre of a circle, the ends of an arc. */
  pts: Pt[]
  radius?: number
  /** An arc: start, a point on it, end; and the circle it lies on. `complemented` is set when the reader replaced it (switch 10). */
  arc?: { start: Pt; mid: Pt; end: Pt; center: Pt; radius: number; complemented: boolean }
  text?: string
  fill: string | null
  strokeWidth: number
  strokeType: string
  node: List
}

export interface LibSymbol {
  /** The name as the cache writes it, `Device:R`. */
  name: string
  /** The symbol this one extends (resolved by `resolveLibSymbol`). */
  extendsName?: string
  props: SchProperty[]
  /** `global` for `(power)` and `(power global)`, `local` for `(power local)`, null for a part. */
  power: "global" | "local" | null
  pinNamesHidden: boolean
  pinNumbersHidden: boolean
  inBom: boolean
  onBoard: boolean
  /** The number of units, and of body styles (2 for De Morgan). */
  units: number
  bodyStyles: number
  pins: LibPin[]
  graphics: LibGraphic[]
  node: List
}

export interface SymbolInstance {
  project: string
  /** The instance path of the sheet the symbol is on: `/<root uuid>/<sheet uuid>` from KiCad 7, the board's form (no root uuid) in KiCad 6's root list. */
  path: string
  reference: string
  unit: number
  value: string | null
  footprint: string | null
  /** The path was written by the symbol (KiCad 7 and later) or by the root list (KiCad 6). */
  from: "symbol" | "root-list"
}

export interface PlacedSymbol {
  /** The `lib_id` as written, `Device:R`. */
  libId: string
  /** `lib_name`: the name this symbol has in the cache when the library's own was edited. */
  libName: string | null
  /** The key into the cache: `libName` when there is one, else `libId`. */
  cacheKey: string
  at: Pt
  angle: number
  mirror: "" | "x" | "y"
  unit: number
  bodyStyle: number
  uuid: string
  props: SchProperty[]
  inBom: boolean
  onBoard: boolean
  dnp: boolean
  excludeFromSim: boolean
  inPosFiles: boolean
  /** The pins the file lists with their uuids and chosen alternates. */
  pins: { number: string; uuid: string; alternate: string | null }[]
  instances: SymbolInstance[]
  node: List
}

export interface SchWire {
  pts: Pt[]
  node: List
}

export interface SchJunction {
  at: Pt
  node: List
}

export interface SchNoConnect {
  at: Pt
  node: List
}

export type LabelKind = "local" | "global" | "hierarchical" | "directive"

export interface SchLabel {
  kind: LabelKind
  /** The text as the user reads it: `{slash}` is `/`, and an old `~NAME~` is `~{NAME}`. */
  text: string
  raw: string
  at: Pt
  angle: number
  shape: string | null
  node: List
}

export interface SheetPin {
  name: string
  /** The pin's direction: input, output, bidirectional, tri_state, passive. */
  type: string
  at: Pt
  angle: number
  node: List
}

export interface SheetInstance {
  project: string
  path: string
  page: string
}

export interface SchSheet {
  at: Pt
  size: Pt
  uuid: string
  /** The sheet's name and file as the file names them (switch 8): null when the file gives neither. */
  name: string | null
  file: string | null
  pins: SheetPin[]
  instances: SheetInstance[]
  node: List
}

export interface BusEntry {
  at: Pt
  size: Pt
  node: List
}

export interface SchGroup {
  name: string
  members: string[]
  uuid: string
  node: List
}

export interface EmbeddedFileRef {
  name: string
  type: string
}

export interface KicadSchematic {
  /** The `(version N)` stamp; null when the file has none. */
  version: number | null
  era: SchEra
  generator: string | null
  generatorVersion: string | null
  /** The sheet's own uuid: the first part of every instance path of KiCad 7 and later. */
  uuid: string
  paper: string | null
  /** Title block entries in file order: `Title`, `Date`, `Rev`, `Company`, `Comment1`... */
  titleBlock: { key: string; value: string }[]
  libSymbols: LibSymbol[]
  symbols: PlacedSymbol[]
  wires: SchWire[]
  buses: SchWire[]
  busEntries: BusEntry[]
  busAliases: { name: string; members: string[] }[]
  junctions: SchJunction[]
  noConnects: SchNoConnect[]
  /** Local, global, hierarchical and directive labels, in file order. */
  labels: SchLabel[]
  sheets: SchSheet[]
  groups: SchGroup[]
  /** KiCad 6's root list of symbol instances, as read (applied to the symbols by `applyRootInstances`). */
  rootInstances: SymbolInstance[]
  /** The `sheet_instances` of the root sheet (KiCad 6): a path and a page each. */
  sheetInstances: SheetInstance[]
  embeddedFiles: EmbeddedFileRef[]
  /** Lists the typed fields do not cover, by token: text, text_box, polyline, rectangle, circle, arc, bezier, image, table, rule_area... */
  others: Record<string, List[]>
  /** The root `(kicad_sch ...)` list, whole. */
  tree: List
}

/** A sheet file read from the project, with the path it was found at. */
export interface SheetFile {
  path: string
  schematic: KicadSchematic
  /** The text that was read, for the node accounting. */
  text: string
}
