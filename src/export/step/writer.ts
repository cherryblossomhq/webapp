import { len, real, str, unit } from "./format"
import type { StepColor } from "./types"

/** `(#1,#2,...)`, broken over lines so a face with thousands of holes isn't one huge line. */
export function refs(ids: readonly number[]): string {
  let s = "("
  for (let i = 0; i < ids.length; i++) {
    if (i) s += i % 32 === 0 ? ",\n" : ","
    s += `#${ids[i]}`
  }
  return `${s})`
}

/** A product with a shape, as an assembly sees it. */
export interface Shape {
  definition: number
  /** The shape representation instances are placed by. */
  rep: number
  /** An identity AXIS2_PLACEMENT_3D among `rep`'s items. */
  origin: number
}

/** The ids every representation and product in the file shares. */
export interface Contexts {
  application: number
  product: number
  definition: number
  /** Millimetres, radians, steradians, with an uncertainty. */
  geometry: number
}

/**
 * The DATA section as it is written: entities numbered in order, with points and directions
 * shared (one CARTESIAN_POINT per position, one DIRECTION per direction) and colours styled once.
 */
export class StepWriter {
  private lines: string[] = []
  private next = 1
  private points = new Map<string, number>()
  private dirs = new Map<string, number>()
  private styles = new Map<string, number>()
  readonly contexts: Contexts

  constructor() {
    const application = this.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')")
    this.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${application})`)
    const product = this.add(`PRODUCT_CONTEXT('',#${application},'mechanical')`)
    const definition = this.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${application},'design')`)
    const mm = this.add("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")
    const rad = this.add("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))")
    const sr = this.add("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())")
    const uncertainty = this.add(
      `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${mm},'distance_accuracy_value','confusion accuracy')`,
    )
    const geometry = this.add(
      `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))` +
        `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr}))REPRESENTATION_CONTEXT('','3D'))`,
    )
    this.contexts = { application, product, definition, geometry }
  }

  add(body: string): number {
    const id = this.next++
    this.lines.push(`#${id}=${body};`)
    return id
  }

  /** An id for an entity written later with `define`, for references that come first. */
  reserve(): number {
    return this.next++
  }

  /** `count` consecutive ids, for a block of entities copied from another file. */
  reserveBlock(count: number): number {
    const first = this.next
    this.next += count
    return first
  }

  define(id: number, body: string): void {
    this.lines.push(`#${id}=${body};`)
  }

  /** Entities already numbered, such as an embedded file's. */
  raw(line: string): void {
    this.lines.push(line)
  }

  point(x: number, y: number, z: number): number {
    const key = `${len(x)},${len(y)},${len(z)}`
    let id = this.points.get(key)
    if (id === undefined) {
      id = this.add(`CARTESIAN_POINT('',(${key}))`)
      this.points.set(key, id)
    }
    return id
  }

  /** A unit direction; the vector given needn't be normalised. */
  dir(x: number, y: number, z: number): number {
    const l = Math.hypot(x, y, z) || 1
    const key = `${unit(x / l)},${unit(y / l)},${unit(z / l)}`
    let id = this.dirs.get(key)
    if (id === undefined) {
      id = this.add(`DIRECTION('',(${key}))`)
      this.dirs.set(key, id)
    }
    return id
  }

  /** AXIS2_PLACEMENT_3D at a point, with `axis` its z and `ref` its x (`null` leaves x to the reader). */
  placement(at: number, axis: number, ref: number | null): number {
    return this.add(`AXIS2_PLACEMENT_3D('',#${at},#${axis},${ref === null ? "$" : `#${ref}`})`)
  }

  /** The placement at the origin with the standard axes, for an instance's own frame. */
  origin(): number {
    return this.placement(this.point(0, 0, 0), this.dir(0, 0, 1), this.dir(1, 0, 0))
  }

  /**
   * A surface colour on a solid, shell or face: a STYLED_ITEM over a style chain shared by every
   * item of that colour. Collect the ids for the representation's MDGPR.
   */
  style(item: number, color: StepColor): number {
    const c = clampColor(color)
    const key = `${real(c.r, 4)},${real(c.g, 4)},${real(c.b, 4)}`
    let assignment = this.styles.get(key)
    if (assignment === undefined) {
      const rgb = this.add(`COLOUR_RGB('',${key})`)
      const fill = this.add(`FILL_AREA_STYLE_COLOUR('',#${rgb})`)
      const area = this.add(`FILL_AREA_STYLE('',(#${fill}))`)
      const surfaceFill = this.add(`SURFACE_STYLE_FILL_AREA(#${area})`)
      const side = this.add(`SURFACE_SIDE_STYLE('',(#${surfaceFill}))`)
      const usage = this.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`)
      assignment = this.add(`PRESENTATION_STYLE_ASSIGNMENT((#${usage}))`)
      this.styles.set(key, assignment)
    }
    return this.add(`STYLED_ITEM('color',(#${assignment}),#${item})`)
  }

  /** The presentation that makes a representation's styled items count, in its context. */
  presentation(styled: readonly number[], context: number): void {
    if (styled.length) this.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',${refs(styled)},#${context})`)
  }

  /** PRODUCT through PRODUCT_DEFINITION_SHAPE, sharing the file's contexts. */
  product(name: string): { product: number; definition: number; shape: number } {
    const n = str(name)
    const product = this.add(`PRODUCT(${n},${n},'',(#${this.contexts.product}))`)
    this.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${product}))`)
    const formation = this.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`)
    const definition = this.add(`PRODUCT_DEFINITION('design','',#${formation},#${this.contexts.definition})`)
    const shape = this.add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`)
    return { product, definition, shape }
  }

  /**
   * One instance of `child` in an assembly, as OCCT writes it: a NAUO named `name`, and the
   * child's representation placed in the parent's by an ITEM_DEFINED_TRANSFORMATION from the
   * child's own origin to `at`, a placement among the parent representation's items.
   */
  instance(parent: Shape, child: Shape, id: string, name: string, at: number): void {
    const transform = this.add(`ITEM_DEFINED_TRANSFORMATION('','',#${child.origin},#${at})`)
    const relation = this.add(
      `(REPRESENTATION_RELATIONSHIP('','',#${child.rep},#${parent.rep})` +
        `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${transform})SHAPE_REPRESENTATION_RELATIONSHIP())`,
    )
    const usage = this.add(
      `NEXT_ASSEMBLY_USAGE_OCCURRENCE(${str(id)},${str(name)},'',#${parent.definition},#${child.definition},$)`,
    )
    const shape = this.add(`PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item',#${usage})`)
    this.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${relation},#${shape})`)
  }

  /** The whole file: header, then the entities in the order they were written. */
  text(header: { name: string; author: string; timestamp: string }): string {
    const head = [
      "ISO-10303-21;",
      "HEADER;",
      "FILE_DESCRIPTION(('Printed circuit board assembly'),'2;1');",
      `FILE_NAME(${str(header.name)},${str(header.timestamp)},(${str(header.author)}),(''),'Cherry Blossom','Cherry Blossom','');`,
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      "ENDSEC;",
      "DATA;",
    ]
    return `${head.join("\n")}\n${this.lines.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)

function clampColor(c: StepColor): StepColor {
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) }
}
