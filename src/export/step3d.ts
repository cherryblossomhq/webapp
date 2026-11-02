import { drillsThrough } from "../model/stack"
import * as THREE from "three"
import { naturalCompare } from "../lib/natural"
import { placedComponents } from "../editor/three/buildBoard"
import { fetchModelBytes, modelLibrary } from "../editor/three/files/library"
import { isStretched, placementMatrix } from "../editor/three/files/placement"
import { boardColors, mountingHoles } from "../model/board"
import { pcbPads, slotEnds } from "../model/instances"
import { holeCentre } from "../model/padDistance"
import { outlineGeometry, pointInRing, signedArea, type OutlineGeometry } from "../model/outline"
import { reversePath } from "../model/outlineOps"
import { arcCircle, flattenSeg, type ShapePath } from "../model/shapes"
import { requireClosedOutline } from "./outlineGuard"
import { componentModel, modelFileKey } from "../model/models3d"
import type { ComponentInstance, Model3D, Project, Vec2 } from "../model/types"
import { writeStep, type StepContourSeg, type StepColor, type StepExportInput, type StepMesh, type StepModelInput, type StepPlacement } from "./step"

// The board as a STEP assembly, for mechanical CAD: the board's exact solid with every hole, and
// every part that has a 3D model where it sits. A part with a STEP model (its supplier's, KiCad's,
// or a STEP file the user added) goes in as that file, exact; one with a mesh file goes in as the
// mesh. A part with no model is left out and named in the notes: a made-up body in a file someone
// designs an enclosure around is worse than a gap. Each distinct model is written once and placed
// per component, named by designator.
//
// STEP's frame: millimetres, x and y as the project's (y up), the board's bottom face at z = 0.

const srgb = (c: THREE.Color): StepColor => {
  const out = { r: 0, g: 0, b: 0 }
  c.getRGB(out, THREE.SRGBColorSpace)
  return out
}

const hexColor = (hex: string): StepColor => srgb(new THREE.Color(hex))

/** A model file's triangles in one frame, by material colour: a textured mesh is its texture's part too. */
export function meshesOf(object: THREE.Object3D, frame: THREE.Matrix4 = new THREE.Matrix4()): StepMesh[] {
  object.updateWorldMatrix(true, true)
  const root = object.matrixWorld.clone().invert()
  const out: StepMesh[] = []
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible) return
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined
    if (!pos) return
    m.multiplyMatrices(frame, root).multiply(mesh.matrixWorld)
    const index = mesh.geometry.getIndex()
    const vertex = (i: number) => (index ? index.getX(i) : i)
    const total = index ? index.count : pos.count
    const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: total, materialIndex: 0 }]
    for (const g of groups) {
      const material = materials[g.materialIndex ?? 0] ?? materials[0]
      if (!material) continue
      const end = Math.min(total, g.start + g.count)
      const positions = new Float32Array((end - g.start) * 3)
      for (let i = g.start, k = 0; i < end; i++, k += 3) {
        v.fromBufferAttribute(pos, vertex(i)).applyMatrix4(m)
        positions[k] = v.x
        positions[k + 1] = v.y
        positions[k + 2] = v.z
      }
      if (positions.length >= 9) out.push({ positions, color: srgb(material.color ?? new THREE.Color(0.5, 0.5, 0.5)), name: mesh.name || undefined })
    }
  })
  return out
}

/** A component's footprint frame in STEP's: moved and turned, and a bottom-side part flipped onto the bottom face. */
export function componentMatrix(project: Project, c: ComponentInstance): THREE.Matrix4 {
  const bottom = c.pcb.side === "bottom"
  const m = new THREE.Matrix4().makeTranslation(c.pcb.x, c.pcb.y, bottom ? 0 : project.board.thickness)
  m.multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(c.pcb.rot)))
  if (bottom) m.multiply(new THREE.Matrix4().makeRotationY(Math.PI))
  return m
}

/** A closed outline path as the pieces the STEP writer takes (arcs exact, curves flattened to 0.0002 mm), counter-clockwise or clockwise as asked. */
function contourOf(path: ShapePath, ccw: boolean): StepContourSeg[] {
  const pieces: StepContourSeg[] = []
  for (const s of path.segs) {
    if (s.kind === "arc") {
      const c = arcCircle(s.start, s.mid, s.end)
      if (c && c.r > 1e-9) {
        pieces.push({ kind: "arc", a: s.start, b: s.end, c: c.c, r: c.r, ccw: c.sweep > 0 })
        continue
      }
    }
    const pts = flattenSeg(s.kind === "arc" ? { kind: "line", a: s.start, b: s.end } : s)
    for (let i = 1; i < pts.length; i++) pieces.push({ kind: "line", a: pts[i - 1], b: pts[i] })
  }
  // Which way round the path runs is the sign of the area of its flattened outline (arcs bulge past their chords).
  const runsCcw = signedArea(path.segs.flatMap((s) => flattenSeg(s).slice(0, -1))) > 0
  if (runsCcw === ccw) return pieces
  const back = reversePath({ closed: true, segs: path.segs })
  return back ? contourOf(back, ccw) : pieces
}

/** The pieces of board an outline of its own is, for the STEP writer, and which piece each drill is in. */
function stepRegions(g: OutlineGeometry, paths: ShapePath[]): NonNullable<StepExportInput["board"]["outline"]["regions"]> {
  return g.regions.map((_, ri) => {
    const mine = g.rings.filter((r) => r.region === ri)
    const outer = mine.find((r) => !r.hole)!
    return { outer: contourOf(paths[outer.path], true), holes: mine.filter((r) => r.hole).map((r) => contourOf(paths[r.path], false)) }
  })
}

export function stepBoard(project: Project): StepExportInput["board"] {
  const b = project.board
  const g = outlineGeometry(b)
  const holes: StepExportInput["board"]["holes"] = []
  // With an outline of its own, each drill is measured against it: it goes with the piece it is in, or is marked as not safely inside one.
  const place = (x: number, y: number, diameter: number, slot?: { a: Vec2; b: Vec2 }) => {
    if (!g) {
      holes.push({ x, y, diameter, ...(slot && { slot }) })
      return
    }
    const ends = slot ? [slot.a, slot.b] : [{ x, y }]
    const r = diameter / 2
    const inside = ends.every((p) => g.contains(p) && g.nearest(p) > r + 1e-3)
    const ring = inside ? g.rings.find((q) => !q.hole && pointInRing(ends[0], q.pts) && g.regions[q.region]) : undefined
    holes.push({ x, y, diameter, region: ring && inside ? ring.region : -1, ...(slot && { slot }) })
  }
  for (const c of placedComponents(project)) {
    for (const p of pcbPads(c)) {
      if (!p.holeDiameter) continue
      const ends = slotEnds(p)
      const at = holeCentre(p)
      place(at.x, at.y, p.holeDiameter, ends ? { a: ends[0], b: ends[1] } : undefined)
    }
  }
  // Only a through via cuts the whole board; blind, buried and micro vias stay inside it (see the note in stepFile).
  for (const v of project.vias) if (drillsThrough(project.board, v)) place(v.x, v.y, v.drill)
  for (const h of mountingHoles(b)) place(h.x, h.y, h.drill)
  return {
    outline: { x: b.x, y: b.y, width: b.width, height: b.height, cornerRadius: b.cornerRadius, ...(g ? { regions: stepRegions(g, b.outline!.paths) } : {}) },
    thickness: b.thickness,
    holes,
    color: hexColor(boardColors(b).mask),
  }
}

/** Designators named in the left-out note before it says how many more. */
const MISSING_LISTED = 12

/** One line for every part left out for having no 3D model, so no one takes the gap for an empty spot on the board. */
export function missingNote(refs: string[]): string {
  const sorted = [...refs].sort(naturalCompare)
  const listed = sorted.slice(0, MISSING_LISTED).join(", ")
  const more = sorted.length > MISSING_LISTED ? ` and ${sorted.length - MISSING_LISTED} more` : ""
  const head = sorted.length === 1 ? "1 part has no 3D model and is left out" : `${sorted.length} parts have no 3D model and are left out`
  return `${head}: ${listed}${more}.`
}

/** What each placed component is drawn with in the file. */
type PartPlan = { c: ComponentInstance; model: Model3D | null }

export interface StepProgress {
  done: number
  total: number
}

/** Model files read in parallel at most. */
const FETCHES = 4

async function inBatches<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(FETCHES, items.length) }, async () => {
      while (next < items.length) await run(items[next++])
    }),
  )
}

/**
 * Write the project as a STEP file. Model files are fetched as needed (STEP, the exact copy, for a
 * supplier's model); a part whose file can't be read is left out, and a STEP file that can't be
 * fetched is written as the mesh the 3D view draws. The notes say which.
 */
export async function stepFile(project: Project, options: { onProgress?: (p: StepProgress) => void; signal?: AbortSignal } = {}): Promise<{ text: string; notes: string[] }> {
  requireClosedOutline(project, "The STEP model")
  const notes: string[] = []
  const plans: PartPlan[] = placedComponents(project).map((c) => ({ c, model: componentModel(project, c) }))
  const files = new Map<string, Model3D>()
  for (const p of plans) if (p.model) files.set(JSON.stringify(p.model), p.model)

  // Each distinct file and placement once: its drawn meshes (to place it, and as a fallback) and,
  // for STEP, the file's own text, fetched once per file however many footprints place it. A STEP
  // file that can't be fetched leaves the drawn meshes, which are written instead (`stepError`).
  const read = new Map<string, { object: THREE.Group; step: string | null; stepError?: string } | { error: string }>()
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const stepTexts = new Map<string, Promise<string>>()
  const stepText = (m: Model3D) => {
    const file = modelFileKey(m)
    let text = stepTexts.get(file)
    if (!text) stepTexts.set(file, (text = fetchModelBytes(m, "step", options.signal).then((bytes) => new TextDecoder().decode(bytes))))
    return text
  }
  let done = 0
  options.onProgress?.({ done, total: files.size })
  await inBatches([...files], async ([key, m]) => {
    try {
      const object = await modelLibrary.load(m)
      if (m.format !== "step") read.set(key, { object, step: null })
      else {
        try {
          read.set(key, { object, step: await stepText(m) })
        } catch (e) {
          if (options.signal?.aborted) throw e
          read.set(key, { object, step: null, stepError: message(e) })
        }
      }
    } catch (e) {
      read.set(key, { error: message(e) })
    }
    options.onProgress?.({ done: ++done, total: files.size })
  })
  options.signal?.throwIfAborted()

  const models = new Map<string, StepModelInput>()
  const placements: StepPlacement[] = []
  // Notes, by file: two models may share a name.
  const failed = new Map<string, { name: string; error: string; refs: string[] }>()
  const meshInstead = new Map<string, { name: string; error: string; refs: string[] }>()
  // Parts with no model at all, left out.
  const missing: string[] = []
  const noteFor = (into: typeof failed, file: string, name: string, error: string, ref: string) => {
    const entry = into.get(file) ?? { name, error, refs: [] }
    entry.refs.push(ref)
    into.set(file, entry)
  }
  for (const { c, model } of plans) {
    if (!model) {
      missing.push(c.ref)
      continue
    }
    const at = componentMatrix(project, c)
    const got = read.get(JSON.stringify(model))
    if (!got || "error" in got) {
      noteFor(failed, modelFileKey(model), model.name, got?.error ?? "not read", c.ref)
      continue
    }
    const place = placementMatrix(model, got.object)
    // A model KiCad stretches cannot be placed by a STEP assembly's rigid transform, so it is written as its mesh, stretched.
    if (got.step && !isStretched(model)) {
      // The file goes in as it is, once however it is placed; where it sits is the instance's transform.
      const key = `step:${modelFileKey(model)}`
      if (!models.has(key)) models.set(key, { key, name: model.name, source: { kind: "step", text: got.step }, fallback: meshesOf(got.object) })
      placements.push({ ref: c.ref, model: key, matrix: at.clone().multiply(place).elements })
    } else {
      // A mesh is written already placed on its footprint, so its scale needs no transform.
      const key = `file:${JSON.stringify(model)}`
      if (!models.has(key)) models.set(key, { key, name: model.name, source: { kind: "mesh", meshes: meshesOf(got.object, place) } })
      placements.push({ ref: c.ref, model: key, matrix: at.elements })
      if (got.stepError) noteFor(meshInstead, modelFileKey(model), model.name, got.stepError, c.ref)
    }
  }
  for (const { name, error, refs } of failed.values()) {
    notes.push(`${refs.join(", ")}: ${name} couldn't be read (${error}), so ${refs.length === 1 ? "it is" : "they are"} left out.`)
  }
  for (const { name, error, refs } of meshInstead.values()) {
    notes.push(`${refs.join(", ")}: ${name}'s STEP file couldn't be fetched (${error}), so ${refs.length === 1 ? "it is" : "they are"} written as its mesh.`)
  }

  if (missing.length) notes.push(missingNote(missing))

  const partial = project.vias.filter((v) => v.kind).length
  if (partial) notes.push(`${partial} blind, buried or micro via${partial === 1 ? " is" : "s are"} not drawn: the board solid has only the holes that go through it.`)
  const out = writeStep({ name: project.name, board: stepBoard(project), models: [...models.values()], placements })
  return { text: out.text, notes: [...notes, ...out.notes] }
}
