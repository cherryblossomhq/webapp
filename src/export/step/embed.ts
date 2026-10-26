// Putting another STEP file inside this one: its entities are copied whole (geometry, its own
// contexts and units, colours, layers, any assembly of its own) under new numbers, and its root
// products become what the board's assembly instances.

import { rawString, str } from "./format"
import {
  isA,
  numberValue,
  parsePart21,
  partOf,
  stringText,
  writeInstance,
  type Instance,
  type Value,
} from "./part21"
import type { Shape, StepWriter } from "./writer"

export type StepSchema = "AP203" | "AP214" | "AP242" | "other" | "unknown"

export type Embedded =
  | { ok: true; shape: Shape; schema: StepSchema; schemaName: string; errors: number }
  | { ok: false; reason: string }

/** Relationships whose `related_product_definition` (the fifth attribute) is a component. */
const USAGES = new Set([
  "NEXT_ASSEMBLY_USAGE_OCCURRENCE",
  "ASSEMBLY_COMPONENT_USAGE",
  "QUANTIFIED_ASSEMBLY_COMPONENT_USAGE",
  "PROMISSORY_USAGE_OCCURRENCE",
  "SPECIFIED_HIGHER_USAGE_OCCURRENCE",
  "PRODUCT_DEFINITION_USAGE",
])

const DEFINITIONS = ["PRODUCT_DEFINITION", "PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS"]

/** Entities that are a shape; a file with none of them has nothing to show. */
const GEOMETRY = new Set([
  "MANIFOLD_SOLID_BREP",
  "BREP_WITH_VOIDS",
  "FACETED_BREP",
  "SHELL_BASED_SURFACE_MODEL",
  "FACE_BASED_SURFACE_MODEL",
  "GEOMETRIC_SET",
  "GEOMETRIC_CURVE_SET",
  "ADVANCED_FACE",
  "FACE_SURFACE",
  "TESSELLATED_SOLID",
  "TESSELLATED_SHELL",
  "TRIANGULATED_FACE",
  "COMPLEX_TRIANGULATED_FACE",
])

/** AP203's context subtypes, written as the AP214 types they specialise. */
const RENAMED: Record<string, string> = {
  DESIGN_CONTEXT: "PRODUCT_DEFINITION_CONTEXT",
  MECHANICAL_CONTEXT: "PRODUCT_CONTEXT",
}

function schemaOf(name: string): StepSchema {
  const n = name.toUpperCase()
  if (!n) return "unknown"
  if (n.includes("AUTOMOTIVE_DESIGN")) return "AP214"
  if (n.includes("CONFIG_CONTROL_DESIGN") || n.includes("CONFIGURATION_CONTROL_3D_DESIGN") || n.startsWith("AP203")) {
    return "AP203"
  }
  if (n.includes("AP242")) return "AP242"
  return "other"
}

const ref = (v: Value | undefined) => (typeof v === "number" ? v : undefined)

/** The items list of a representation, simple or complex. */
function itemsOf(rep: Instance): Value[] | undefined {
  for (const p of rep.parts) {
    if (p.type.endsWith("REPRESENTATION") && Array.isArray(p.params[1])) return p.params[1]
  }
  return undefined
}

function isShapeRepresentation(inst: Instance): boolean {
  return inst.parts.some((p) => p.type.endsWith("SHAPE_REPRESENTATION"))
}

function triple(byId: Map<number, Instance>, id: number | undefined, type: string): number[] | undefined {
  if (id === undefined) return undefined
  const inst = byId.get(id)
  const params = inst && partOf(inst, type)
  const list = params?.[1]
  if (!Array.isArray(list) || list.length < 2) return undefined
  const out = list.map((v) => numberValue(v) ?? NaN)
  while (out.length < 3) out.push(0)
  return out.every(Number.isFinite) ? out : undefined
}

/** An AXIS2_PLACEMENT_3D at the origin with the standard axes. */
function isIdentity(byId: Map<number, Instance>, inst: Instance): boolean {
  const p = partOf(inst, "AXIS2_PLACEMENT_3D")
  if (!p) return false
  const at = triple(byId, ref(p[1]), "CARTESIAN_POINT")
  if (!at || at.some((c) => Math.abs(c) > 1e-12)) return false
  const same = (v: Value | undefined, want: number[]) => {
    if (v === "$") return true
    const d = triple(byId, ref(v), "DIRECTION")
    if (!d) return false
    const l = Math.hypot(d[0], d[1], d[2])
    return l > 0 && d.every((c, i) => Math.abs(c / l - want[i]) < 1e-12)
  }
  return same(p[2], [0, 0, 1]) && same(p[3], [1, 0, 0])
}

/**
 * Copies a STEP file into `w` and returns the product the assembly instances. A file with one
 * root product (one that isn't a component of another) is instanced as it is, renamed `name`;
 * a file with several gets a product of its own, `name`, holding them all.
 */
export function embedStep(w: StepWriter, text: string, name: string): Embedded {
  const file = parsePart21(text)
  if (!file.instances.length) return { ok: false, reason: "it has no entities" }
  const schemaName = stringText(
    (file.header.find((h) => h.type === "FILE_SCHEMA")?.params[0] as Value[] | undefined)?.[0],
  )?.trim() ?? ""
  const schema = schemaOf(schemaName)

  // A number defined twice is the first definition: a later one is dropped.
  const byId = new Map<number, Instance>()
  const instances: Instance[] = []
  for (const inst of file.instances) {
    if (byId.has(inst.id)) continue
    byId.set(inst.id, inst)
    instances.push(inst)
  }
  if (!instances.some((i) => i.parts.some((p) => GEOMETRY.has(p.type)))) {
    return { ok: false, reason: "it has no geometry" }
  }

  // Roots: product definitions that no assembly in the file uses as a component.
  const components = new Set<number>()
  const shapesOf = new Map<number, number[]>()
  const repsOf = new Map<number, number[]>()
  const add = (map: Map<number, number[]>, key: number, value: number) => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  for (const inst of instances) {
    for (const p of inst.parts) {
      if (USAGES.has(p.type)) {
        const related = ref(p.params[4])
        if (related !== undefined) components.add(related)
      } else if (p.type === "PRODUCT_DEFINITION_SHAPE") {
        const of = ref(p.params[2])
        if (of !== undefined) add(shapesOf, of, inst.id)
      } else if (p.type === "SHAPE_DEFINITION_REPRESENTATION") {
        const of = ref(p.params[0])
        const rep = ref(p.params[1])
        if (of !== undefined && rep !== undefined) add(repsOf, of, rep)
      }
    }
  }
  const roots: { definition: number; rep: number }[] = []
  for (const inst of instances) {
    if (!DEFINITIONS.some((t) => isA(inst, t)) || components.has(inst.id)) continue
    const rep = (shapesOf.get(inst.id) ?? [])
      .flatMap((pds) => repsOf.get(pds) ?? [])
      .find((r) => {
        const rep = byId.get(r)
        return rep !== undefined && isShapeRepresentation(rep)
      })
    if (rep !== undefined) roots.push({ definition: inst.id, rep })
  }
  if (!roots.length) return { ok: false, reason: "no product in it has a shape" }

  // Each root's representation needs an identity placement among its items: the transform of
  // an instance goes from there to its place on the board.
  const origins = roots.map((root) => {
    const rep = byId.get(root.rep)!
    const items = itemsOf(rep)
    const found = items?.find((v) => {
      const item = typeof v === "number" ? byId.get(v) : undefined
      return item !== undefined && isIdentity(byId, item)
    })
    if (typeof found === "number") return { id: found, copied: true }
    // Not shared with the file's own points: this one lives in the embedded file's context.
    const at = w.add("CARTESIAN_POINT('',(0.,0.,0.))")
    const z = w.add("DIRECTION('',(0.,0.,1.))")
    const x = w.add("DIRECTION('',(1.,0.,0.))")
    const axis = w.add(`AXIS2_PLACEMENT_3D('',#${at},#${z},#${x})`)
    if (items) items.push(-axis)
    else rep.parts[0].params[1] = [-axis]
    return { id: axis, copied: false }
  })

  if (roots.length === 1) {
    const definition = byId.get(roots[0].definition)!
    const formation = byId.get(ref((partOf(definition, "PRODUCT_DEFINITION") ?? definition.parts[0].params)[2]) ?? -1)
    const product = byId.get(ref(formation?.parts[0].params[2]) ?? -1)
    if (product && isA(product, "PRODUCT") && !product.complex) {
      product.parts[0].params[0] = str(name)
      product.parts[0].params[1] = str(name)
    }
  }

  // New numbers, in the file's order. Its application contexts become this file's one, and its
  // protocol definitions and AP203's approval and person assignments are left behind (AP214
  // has no such entities and nothing points at them).
  const kept: Instance[] = []
  const number = new Map<number, number>()
  const contexts = new Set<number>()
  for (const inst of instances) {
    const type = inst.parts[0].type
    if (isA(inst, "APPLICATION_CONTEXT")) {
      contexts.add(inst.id)
      continue
    }
    if (isA(inst, "APPLICATION_PROTOCOL_DEFINITION") || type.startsWith("CC_DESIGN_")) continue
    if (!inst.complex && RENAMED[type]) inst.parts[0].type = RENAMED[type]
    kept.push(inst)
  }
  const first = w.reserveBlock(kept.length)
  kept.forEach((inst, i) => number.set(inst.id, first + i))
  const app = w.contexts.application
  const renumber = (id: number) => (contexts.has(id) ? app : number.get(id))
  for (const inst of kept) w.raw(`#${number.get(inst.id)}=${writeInstance(inst, renumber, rawString)};`)

  const sourceShape = (i: number): Shape => {
    const o = origins[i]
    return {
      definition: number.get(roots[i].definition)!,
      rep: number.get(roots[i].rep)!,
      origin: o.copied ? number.get(o.id)! : o.id,
    }
  }
  const errors = file.errors
  if (roots.length === 1) return { ok: true, shape: sourceShape(0), schema, schemaName, errors }

  const wrapper = w.product(name)
  const rep = w.reserve()
  const origin = w.origin()
  const items = [origin]
  const shape: Shape = { definition: wrapper.definition, rep, origin }
  roots.forEach((_, i) => {
    const at = w.origin()
    items.push(at)
    w.instance(shape, sourceShape(i), String(i + 1), name, at)
  })
  w.define(rep, `SHAPE_REPRESENTATION(${str(name)},(${items.map((i) => `#${i}`).join(",")}),#${w.contexts.geometry})`)
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${wrapper.shape},#${rep})`)
  return { ok: true, shape, schema, schemaName, errors }
}
