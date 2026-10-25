// Core document model. World coordinates are y-up in both editors:
// schematic units are on a 0.1 grid, KiCad's 50 mil (see model/symbols.ts); PCB units are millimetres.

import type { ShapePath } from "./shapes"

export interface Vec2 {
  x: number
  y: number
}

export type Rotation = 0 | 90 | 180 | 270
export type PcbSide = "top" | "bottom"
export type CopperLayer = "top" | "bottom"

// ---------- Library definitions ----------

export type SymbolPrimitive =
  | { type: "path"; points: Vec2[]; fill: boolean; width?: number }
  | { type: "circle"; x: number; y: number; radius: number; fill: boolean }
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
}

export interface SymbolDef {
  primitives: SymbolPrimitive[]
  ports: SymbolPort[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface PinDef {
  /** Pin number; matches footprint pad numbers. */
  number: string
  name: string
  /** Electrical role, used for ERC-lite checks and box symbol placement. */
  kind?: "passive" | "input" | "output" | "power" | "ground" | "io" | "nc"
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
   * False for a non-plated hole (NPTH): a bare drill with no copper, pin null and
   * width = height = holeDiameter. It is an obstacle for copper but never part of a net.
   */
  plated?: false
  /**
   * The exposed (thermal) pad of a no-lead package, numbered one past its last lead (17 on a
   * QFN-16). A part may list it as a pin, usually ground, or leave it unconnected.
   */
  exposed?: true
}

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
   * The package's own name where a source gave one (KiCad's `SOIC-8_3.9x4.9mm_P1.27mm`, a
   * supplier's `SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL`). The 3D view reads the body's kind and size from it.
   */
  package?: string
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
  body3d?: { height: number; color: string }
  mpn?: string
  /** Made for one project (see CustomPartSpec) rather than shipped in the library. */
  custom?: boolean
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
  /** Footprinter string or data-defined footprint whose pads are numbered like the pins. */
  footprint: string
  pins: (PinDef & { side?: PinSide })[]
  /** A discrete symbol from CUSTOM_SYMBOLS; a box with the pins on its sides when absent. */
  symbol?: string
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

/** How far to trust a project part, and why. */
export interface PartSource {
  /**
   * `supplier`: built from a supplier's pinout. `database`: from a part the parts index stores
   * whole (KiCad's libraries; `database` says which). `memory`: written by the copilot from what it
   * recalled.
   */
  pins: "supplier" | "database" | "memory"
  /**
   * `supplier`: the supplier's own land. `database`: the stored part's land (a KiCad footprint).
   * `checked`: a footprinter land checked pad by pad against the supplier's. `memory`: chosen
   * without one.
   */
  land: "supplier" | "database" | "checked" | "memory"
  /** The parts index part it was made from, when it was. */
  database?: PartDatabaseSource
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
 * A real 3D model of a part: a file the 3D view draws in place of the generated body, and the
 * STEP export writes as it is. The generated body is what shows until the file has loaded, and
 * whenever it can't be.
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

export interface ComponentInstance {
  id: string
  partId: string
  ref: string
  props: Record<string, string>
  footprint: string
  sch: { x: number; y: number; rot: Rotation }
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
  /** The part's reference, value and own text, where a board brought in from KiCad has them (`PartText`); absent for a part drawn in the editor. */
  texts?: PartText[]
  /** The footprint's id in the KiCad board it came from, `Library:Name`, which `${FOOTPRINT_LIBRARY}` and `${FOOTPRINT_NAME}` in text show; absent for a part drawn in the editor, whose footprint name is `footprint`. */
  fpid?: string
}

export interface Wire {
  id: string
  points: Vec2[]
}

export interface NetLabel {
  id: string
  name: string
  x: number
  y: number
  rot: Rotation
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
}

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
}

/** Copper pour covering the whole board on one layer, tied to a net by name. */
export interface Zone {
  id: string
  net: string
  layer: CopperLayer
  /** Gap to copper on other nets (mm); defaults to the pour clearance rule. */
  clearance?: number
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
  name: string
  /** Ids of its components. A component is in one block at most. */
  components: string[]
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
}

/** A line through its points, or a polygon when closed. Arrowheads go on open lines only. */
export interface DrawingLine extends DrawingStyle {
  id: string
  type: "line"
  points: Vec2[]
  closed?: boolean
  arrows?: "start" | "end" | "both"
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
 * Free text: a title, a note or a callout, on one or more lines. x and y are the top of its first
 * line: its left end, its middle or its right end as it is aligned. Turned 90° it reads upwards.
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
  rot?: 0 | 90
}

/**
 * Lines, shapes and text drawn on the schematic to explain it, as Altium's drawing tools do. They
 * are graphics only: nothing connects to them, and no check reads them.
 */
export type SchematicDrawing = DrawingLine | DrawingBox | DrawingText

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

export interface Project {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
  components: ComponentInstance[]
  wires: Wire[]
  labels: NetLabel[]
  traces: Trace[]
  vias: Via[]
  zones: Zone[]
  texts: BoardText[]
  /** Drawings on the board itself, on any layer (lines, arcs, circles, rectangles, polygons, curves, ellipses). */
  graphics?: BoardGraphic[]
  board: BoardDef
  rules: DesignRules
  /** Functional blocks of the schematic, each drawn as a titled frame around its parts. */
  blocks?: SchematicBlock[]
  /** Lines, shapes and text drawn on the schematic, bottom first. */
  drawings?: SchematicDrawing[]
  /** Parts made for this project that aren't in the library. */
  parts?: CustomPartSpec[]
  /**
   * Land patterns neither the library nor the footprinter has, such as those of a board brought
   * in from elsewhere. Components and project parts name them like any other footprint.
   */
  footprints?: FootprintDef[]
  /** Real 3D models, one per part and footprint; parts without one are drawn with a generated body. */
  models?: ModelAssignment[]
  /** Free-form project properties such as revision, author or licence, in the order they were added. */
  properties?: { key: string; value: string }[]
  /** Electrical check findings the user ignored, by key, e.g. "bare-led:c_4" (see model/erc.ts). */
  ignoredChecks?: string[]
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
}
