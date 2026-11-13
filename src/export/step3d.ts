import { drillsThrough } from "../model/stack"
import * as THREE from "three"
import { boardColors, mountingHoles } from "../model/board"
import { pcbPads, slotEnds } from "../model/instances"
import { holeCentre } from "../model/padDistance"
import { outlineGeometry, pointInRing, signedArea, type OutlineGeometry } from "../model/outline"
import { reversePath } from "../model/outlineOps"
import { arcCircle, flattenSeg, type ShapePath } from "../model/shapes"
import { requireClosedOutline } from "./outlineGuard"
import { modelFileKey } from "../model/models3d"
import type { Project, Vec2 } from "../model/types"
import { componentMatrix, missingNote, placedParts, readPlacedModels, type ModelProgress, type ModelReader } from "./placedModels"
import { writeStep, type StepContourSeg, type StepColor, type StepExportInput, type StepModelInput, type StepPlacement } from "./step"

export { componentMatrix, meshesOf, missingNote } from "./placedModels"

// The board as a STEP assembly, for mechanical CAD: the board's exact solid with every hole, and
// every part that has a 3D model where it sits. A part with a STEP model (its supplier's, KiCad's,
// or a STEP file the user added) goes in as that file, exact; one with a mesh file goes in as the
// mesh. A part with no model is left out and named in the notes: a made-up body in a file someone
// designs an enclosure around is worse than a gap. Each distinct model is written once and placed
// per component, named by designator.
//
// STEP's frame: millimetres, x and y as the project's (y up), the board's bottom face at z = 0.

const hexColor = (hex: string): StepColor => {
  const out = { r: 0, g: 0, b: 0 }
  new THREE.Color(hex).getRGB(out, THREE.SRGBColorSpace)
  return out
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
  for (const c of placedParts(project)) {
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

export type StepProgress = ModelProgress

/**
 * Write the project as a STEP file. Model files are read through `reader` (STEP, the exact copy, for a supplier's model); a part whose file
 * can't be read is left out, and a STEP file that can't be fetched is written as the mesh the 3D view draws. The notes say which.
 */
export async function stepFile(project: Project, reader: ModelReader, options: { onProgress?: (p: StepProgress) => void; signal?: AbortSignal } = {}): Promise<{ text: string; notes: string[] }> {
  requireClosedOutline(project, "The STEP model")
  const found = await readPlacedModels(project, reader, options)
  const models = new Map<string, StepModelInput>()
  const placements: StepPlacement[] = []
  const decoder = new TextDecoder()
  for (const c of placedParts(project)) {
    const file = found.files.get(found.of.get(c.id) ?? "")
    if (!file) continue
    const at = componentMatrix(project, c)
    if (file.shape.kind === "step") {
      // The file goes in as it is, once however it is placed; where it sits is the instance's transform.
      const key = `step:${modelFileKey(file.model)}`
      if (!models.has(key)) models.set(key, { key, name: file.model.name, source: { kind: "step", text: decoder.decode(file.shape.bytes) }, ...(file.shape.fallback && { fallback: file.shape.fallback }) })
      placements.push({ ref: c.ref, model: key, matrix: at.clone().multiply(file.shape.matrix).elements })
    } else {
      // A mesh is written already placed on its footprint, so its scale needs no transform.
      const key = `file:${file.key}`
      if (!models.has(key)) models.set(key, { key, name: file.model.name, source: { kind: "mesh", meshes: file.shape.meshes } })
      placements.push({ ref: c.ref, model: key, matrix: at.elements })
    }
  }
  const notes = [...found.notes, ...(found.missing.length ? [missingNote(found.missing)] : [])]
  const partial = project.vias.filter((v) => v.kind).length
  if (partial) notes.push(`${partial} blind, buried or micro via${partial === 1 ? " is" : "s are"} not drawn: the board solid has only the holes that go through it.`)
  const out = writeStep({ name: project.name, board: stepBoard(project), models: [...models.values()], placements })
  return { text: out.text, notes: [...notes, ...out.notes] }
}
