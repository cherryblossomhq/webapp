/**
 * A colour, each channel 0..1, in sRGB: the numbers a hex code gives, not three.js's linear
 * working values. STEP readers take COLOUR_RGB as sRGB (OCCT converts it to linear on reading).
 */
export interface StepColor {
  r: number
  g: number
  b: number
}

export interface StepPoint {
  x: number
  y: number
}

/** One piece of a board outline: a straight edge, or a circular arc from `a` to `b` about `c` (`ccw`: counter-clockwise, seen from +z). */
export type StepContourSeg =
  | { kind: "line"; a: StepPoint; b: StepPoint }
  | { kind: "arc"; a: StepPoint; b: StepPoint; c: StepPoint; r: number; ccw: boolean }

/** A piece of board: its outline counter-clockwise, and the cutouts inside it (each clockwise). */
export interface StepRegion {
  outer: StepContourSeg[]
  holes: StepContourSeg[][]
}

export interface StepHole {
  x: number
  y: number
  diameter: number
  /** With a board that has `regions`: which one the drill is in, or -1 when it is not safely inside one (it is left out and counted). */
  region?: number
  /** A slot instead: a capsule `diameter` wide from `a` to `b` (its end centres). */
  slot?: { a: StepPoint; b: StepPoint }
}

export interface StepBoardInput {
  /**
   * Rounded rectangle centred on (x, y), mm; cornerRadius 0 is square. With `regions` the board is
   * those pieces instead (an outline of its own: arcs, cutouts, several pieces) and the rectangle is
   * only the box they lie in.
   */
  outline: { x: number; y: number; width: number; height: number; cornerRadius: number; regions?: StepRegion[] }
  /** The board's bottom face is z = 0 and its top z = thickness. */
  thickness: number
  /** Drills through the board, plated or not. */
  holes: StepHole[]
  /** Solder mask colour, on the whole board; the cut edges and hole walls are FR4. */
  color: StepColor
}

export interface StepMesh {
  /** xyz triplets, mm, in the model's own frame. */
  positions: Float32Array
  /** Triangles as vertex indices; without one, every three vertices are a triangle. */
  index?: Uint32Array | Uint16Array
  color: StepColor
  name?: string
}

export type StepShapeSource =
  /** A whole STEP file, embedded with its own geometry, colours and units. */
  | { kind: "step"; text: string }
  /** Triangles in mm, already in the model's own frame. */
  | { kind: "mesh"; meshes: StepMesh[] }

export interface StepModelInput {
  key: string
  name: string
  source: StepShapeSource
  /** Used, with a note, when a `step` source can't be embedded (no shape found, unparseable). */
  fallback?: StepMesh[]
}

export interface StepPlacement {
  /** Designator, the instance's name in the tree ("U1"). */
  ref: string
  /** `StepModelInput.key`. */
  model: string
  /**
   * Column-major 4x4 (three.js `Matrix4.elements` order) from the model's frame to the board's
   * frame: rotation and translation only.
   */
  matrix: ArrayLike<number>
}

export interface StepExportInput {
  /** The assembly's product name: the project's name. */
  name: string
  board: StepBoardInput
  models: StepModelInput[]
  placements: StepPlacement[]
  author?: string
  /** ISO 8601; now when absent. */
  timestamp?: string
}

export interface StepExportResult {
  text: string
  /** Sentences for the user about what didn't go as asked. */
  notes: string[]
}
