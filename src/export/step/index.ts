// STEP export (ISO 10303-21, AP214) of a whole board as one assembly: the board as an exact solid
// with its holes, and every part placed, a product per model instanced once per component and
// named by its designator. Pure data in, text out: no three.js, no DOM.

import { boardHoles, writeBoard } from "./board"
import { embedStep } from "./embed"
import { str } from "./format"
import { writeMeshModel } from "./mesh"
import type { StepExportInput, StepExportResult, StepMesh, StepModelInput } from "./types"
import { refs, StepWriter, type Shape } from "./writer"

export type {
  StepBoardInput,
  StepColor,
  StepExportInput,
  StepExportResult,
  StepHole,
  StepMesh,
  StepModelInput,
  StepPlacement,
  StepPoint,
  StepShapeSource,
} from "./types"

type Vec = [number, number, number]

/** The frame a placement puts its model in, or null when it isn't a rotation and a move. */
function rigidFrame(m: ArrayLike<number>): { at: Vec; x: Vec; z: Vec } | null {
  if (m.length < 16) return null
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return null
  if (Math.abs(m[3]) > 1e-9 || Math.abs(m[7]) > 1e-9 || Math.abs(m[11]) > 1e-9 || Math.abs(m[15] - 1) > 1e-9) return null
  const x: Vec = [m[0], m[1], m[2]]
  const y: Vec = [m[4], m[5], m[6]]
  const z: Vec = [m[8], m[9], m[10]]
  const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const tol = 1e-6
  for (const v of [x, y, z]) if (Math.abs(dot(v, v) - 1) > tol) return null
  if (Math.abs(dot(x, y)) > tol || Math.abs(dot(y, z)) > tol || Math.abs(dot(z, x)) > tol) return null
  const cross: Vec = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
  // A mirror has the third axis the other way round.
  if (dot(cross, z) < 0) return null
  return { at: [m[12], m[13], m[14]], x, z: cross }
}

/** "U1", "U1 and U2", "U1, U2 and U3", "U1, U2, U3 and 9 others". */
function listed(names: string[]): string {
  if (names.length <= 1) return names.join("")
  if (names.length > 4) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} others`
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

const are = (names: string[]) => (names.length === 1 ? "is" : "are")
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * A model from meshes. Pieces that aren't closed are written as surfaces, without a note:
 * generated bodies have open ones on purpose (a pin 1 dot, a marking).
 */
function meshModel(w: StepWriter, meshes: StepMesh[], model: StepModelInput): Shape | null {
  return writeMeshModel(w, meshes, model.name)?.shape ?? null
}

function buildModel(w: StepWriter, model: StepModelInput, users: string[], notes: string[]): Shape | null {
  if (model.source.kind === "mesh") {
    const shape = meshModel(w, model.source.meshes, model)
    if (!shape) notes.push(`${model.name}'s model has no triangles, so ${listed(users)} ${are(users)} left out.`)
    return shape
  }
  let reason: string
  try {
    const embedded = embedStep(w, model.source.text, model.name)
    if (embedded.ok) {
      if (embedded.schema === "AP242") {
        notes.push(
          `${model.name}'s STEP file is AP242; it is included as it is, but programs that read only AP214 may not show all of it.`,
        )
      } else if (embedded.schema === "other") {
        notes.push(
          `${model.name}'s STEP file is ${embedded.schemaName}, not AP203 or AP214; it is included as it is, but other programs may not read it.`,
        )
      }
      if (embedded.errors) {
        const n = embedded.errors
        notes.push(`${plural(n, "entity", "entities")} in ${model.name}'s STEP file couldn't be read and ${n === 1 ? "was" : "were"} left out.`)
      }
      return embedded.shape
    }
    reason = embedded.reason
  } catch {
    reason = "it couldn't be read"
  }
  if (model.fallback?.length) {
    const shape = meshModel(w, model.fallback, model)
    if (shape) {
      notes.push(`${model.name}'s STEP file couldn't be used (${reason}), so ${listed(users)} use${users.length === 1 ? "s" : ""} its mesh instead.`)
      return shape
    }
  }
  notes.push(`${model.name}'s STEP file couldn't be used (${reason}), so ${listed(users)} ${are(users)} left out.`)
  return null
}

/** The whole board and its parts as one STEP AP214 assembly. */
export function writeStep(input: StepExportInput): StepExportResult {
  const notes: string[] = []
  const w = new StepWriter()
  const name = input.name.trim() || "Board"
  const ctx = w.contexts.geometry

  const assembly = w.product(name)
  const rep = w.reserve()
  const origin = w.origin()
  const items = [origin]
  const parent: Shape = { definition: assembly.definition, rep, origin }
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${assembly.shape},#${rep})`)

  const board = input.board
  const o = board.outline
  if (o.width > 0 && o.height > 0 && [o.x, o.y, o.width, o.height].every(Number.isFinite)) {
    if (!(board.thickness > 0)) notes.push("The board has no thickness, so it is exported 1.6 mm thick.")
    const holes = boardHoles(board)
    const skipped = holes.overlapping + holes.atEdge + holes.invalid
    if (skipped) {
      const why = [
        holes.overlapping ? `${holes.overlapping} overlap${holes.overlapping === 1 ? "s" : ""} another hole` : "",
        holes.atEdge ? `${holes.atEdge} reach${holes.atEdge === 1 ? "es" : ""} the board edge` : "",
        holes.invalid ? `${holes.invalid} ${holes.invalid === 1 ? "has" : "have"} no size` : "",
      ].filter(Boolean)
      notes.push(`${plural(skipped, "hole is", "holes are")} left out of the board solid: ${listed(why)}.`)
    }
    const solid = writeBoard(w, board, holes.kept)
    const at = w.origin()
    items.push(at)
    w.instance(parent, solid, "PCB", "PCB", at)
  } else {
    notes.push("The board has no size, so only the parts are exported.")
  }

  const models = new Map<string, StepModelInput>()
  for (const m of input.models) if (!models.has(m.key)) models.set(m.key, m)
  const missing: string[] = []
  const bent: string[] = []
  const placed: { ref: string; model: string; frame: NonNullable<ReturnType<typeof rigidFrame>> }[] = []
  const users = new Map<string, string[]>()
  for (const p of input.placements) {
    if (!models.has(p.model)) {
      missing.push(p.ref)
      continue
    }
    const frame = rigidFrame(p.matrix)
    if (!frame) {
      bent.push(p.ref)
      continue
    }
    placed.push({ ref: p.ref, model: p.model, frame })
    users.set(p.model, [...(users.get(p.model) ?? []), p.ref])
  }
  if (missing.length) notes.push(`${listed(missing)} ${are(missing)} left out: no 3D model was given for ${missing.length === 1 ? "it" : "them"}.`)
  if (bent.length) {
    notes.push(`${listed(bent)} ${are(bent)} left out: ${bent.length === 1 ? "its placement scales or mirrors its" : "their placements scale or mirror their"} model, and a STEP assembly can only turn and move one.`)
  }

  const shapes = new Map<string, Shape | null>()
  for (const [key, model] of models) {
    const refsOf = users.get(key)
    if (refsOf) shapes.set(key, buildModel(w, model, refsOf, notes))
  }
  const ids = new Set<string>(["PCB"])
  for (const p of placed) {
    const shape = shapes.get(p.model)
    if (!shape) continue
    const { at, x, z } = p.frame
    const placement = w.placement(w.point(...at), w.dir(...z), w.dir(...x))
    items.push(placement)
    let id = p.ref
    for (let n = 2; ids.has(id); n++) id = `${p.ref}-${n}`
    ids.add(id)
    w.instance(parent, shape, id, p.ref, placement)
  }
  w.define(rep, `SHAPE_REPRESENTATION(${str(name)},${refs(items)},#${ctx})`)

  const timestamp = input.timestamp ?? new Date().toISOString().slice(0, 19)
  return { text: w.text({ name: `${name}.step`, author: input.author ?? "", timestamp }), notes }
}
