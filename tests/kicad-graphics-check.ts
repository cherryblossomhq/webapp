import { isDeepStrictEqual } from "node:util"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { worldShapes } from "../src/model/shapeItems"
import { shapeBox, shapePolylines } from "../src/model/shapes"
import type { Project } from "../src/model/types"
import { graphicsOracle, lineWithin } from "./kicad-census/graphics.mjs"

// The drawings of a built project against the oracle's reading of the raw file
// (`tests/kicad-census/graphics.mjs`, which shares no code with `src`). Counted per layer (the
// project's world layer, so a bottom part's are already swapped), then each drawing of the file is
// matched to one of the project's of the same type and layer whose width, fill and dash are the same
// and whose geometry is within 0.001 mm: a circle by centre and radius, an arc by its circle and
// ends, the rest by the greatest distance between the two outlines (both sides read as polylines).

const near = (a: number, b: number, eps = 0.001) => Math.abs(a - b) <= eps

interface FileShape {
  type: string
  layer: string
  width: number
  filled: boolean
  dash: string | null
  multi: boolean
  quarter: boolean
  analytic?: { c: number[]; r: number; ends?: number[][] }
  lines: number[][][]
}

export interface GraphicsCheck {
  file: number
  project: number
  counts: boolean
  wrong: number
  layers: Record<string, number>
  note: string
}

export function checkGraphics(text: string, project: Project, lossy: string[]): GraphicsCheck {
  const g = graphicsOracle(text)
  const file: FileShape[] = []
  const skipLayer = (l: string) => l === "Edge.Cuts" || l === "inner" || l === "unknown"
  for (const s of [...g.board, ...g.footprints.flatMap((f) => f.shapes)]) {
    if (!skipLayer(s.layer)) file.push({ ...s, type: s.type === "poly" ? "polygon" : s.type, multi: s.layers.length > 1 })
  }
  // A target is the circle and two lines KiCad plots.
  for (const t of g.targets as { at: number[]; size: number; width: number; layer: string; x: boolean }[]) {
    if (skipLayer(t.layer)) continue
    const w = t.width <= 0 ? 0.1 : t.width
    const r = t.x ? t.size / 2 : t.size / 3
    const h = t.size / 2
    const ring = [[t.at[0] + r, t.at[1]], [t.at[0], t.at[1] + r], [t.at[0] - r, t.at[1]], [t.at[0], t.at[1] - r]]
    file.push({ type: "circle", layer: t.layer, width: w, filled: false, dash: null, multi: false, quarter: true, analytic: { c: t.at, r }, lines: [ring] })
    const segs = t.x
      ? [[[t.at[0] - h, t.at[1] - h], [t.at[0] + h, t.at[1] + h]], [[t.at[0] - h, t.at[1] + h], [t.at[0] + h, t.at[1] - h]]]
      : [[[t.at[0] - h, t.at[1]], [t.at[0] + h, t.at[1]]], [[t.at[0], t.at[1] - h], [t.at[0], t.at[1] + h]]]
    for (const seg of segs) file.push({ type: "line", layer: t.layer, width: w, filled: false, dash: null, multi: false, quarter: true, lines: [seg] })
  }
  const world = worldShapes(project)
  const layers: Record<string, number> = {}
  for (const s of file) layers[s.layer] = (layers[s.layer] ?? 0) + 1
  const projCounts: Record<string, number> = {}
  for (const w of world) projCounts[w.shape.layer] = (projCounts[w.shape.layer] ?? 0) + 1
  // A layer that is none of KiCad's, or a number that makes no shape, is a refusal the gate raises: nothing to compare.
  const skip = lossy.some((l) => /not one of KiCad's/.test(l) || /numbers do not make a shape/.test(l))
  const counts = skip || Object.keys({ ...layers, ...projCounts }).every((k) => (layers[k] ?? 0) === (projCounts[k] ?? 0))

  // The project's drawings by type, layer and the left top corner of their box on a 0.01 mm grid (rounded, so two values within 0.005 are in the same cell or the next), so a drawing of the file is looked for in the nine cells around its own corner.
  const CELL = 0.01
  type Cand = { shape: (typeof world)[number]["shape"]; used: boolean; box: number[]; lines?: number[][][] }
  const buckets = new Map<string, Cand[]>()
  const key = (type: string, layer: string, x: number, y: number, dx = 0, dy = 0) => `${type}|${layer}|${Math.round(x / CELL) + dx}|${Math.round(y / CELL) + dy}`
  for (const w of world) {
    const b = shapeBox(w.shape)
    const cand: Cand = { shape: w.shape, used: false, box: [b.minX, -b.maxY, b.maxX, -b.minY] }
    const k = key(w.shape.type, w.shape.layer, cand.box[0], cand.box[1])
    const list = buckets.get(k)
    if (list) list.push(cand)
    else buckets.set(k, [cand])
  }
  /** The outline of a candidate as points, flattened the first time it is needed. */
  const linesOf = (c: Cand) => (c.lines ??= shapePolylines(c.shape, 0.0002).map((l) => l.map((p) => [p.x, -p.y])))
  let wrong = 0
  let firstWrong = ""
  for (const s of file) {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const l of s.lines) {
      for (const p of l) {
        minX = Math.min(minX, p[0])
        maxX = Math.max(maxX, p[0])
        minY = Math.min(minY, p[1])
        maxY = Math.max(maxY, p[1])
      }
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    let hit = false
    // A first pass takes each project drawing once; a drawing left over (many tiny drawings within a micrometre of each other cannot be told apart) is looked for again among all of them, the counts per layer having been compared already.
    for (const strict of [true, false]) {
      if (hit) break
      // A rectangle of a part turned by other than a quarter turn is a polygon in KiCad (`EDA_SHAPE::rotate`) and in the project (X6): looked for as either.
      const types = s.type === "rect" ? ["rect", "polygon"] : [s.type]
      const cands = types.flatMap((type) => [-1, 0, 1].flatMap((dx) => [-1, 0, 1].flatMap((dy) => buckets.get(key(type, s.layer, minX, minY, dx, dy)) ?? [])))
      for (let i = 0; i < cands.length && !hit; i++) {
        const cand = cands[i]
      if (strict && cand.used) continue
        const sh = cand.shape
        if (!near(cand.box[0], minX, 0.005) || !near(cand.box[1], minY, 0.005) || !near(cand.box[2], maxX, 0.005) || !near(cand.box[3], maxY, 0.005)) continue
        if (!near(sh.width, s.width < 0 && s.width > -1e-4 ? 0 : s.width, 1e-6) && !s.multi) continue
        if (!!sh.fill !== s.filled || (sh.dash ?? null) !== s.dash) continue
        let ok: boolean
        if (s.type === "circle" && sh.type === "circle") ok = near(sh.c.x, s.analytic!.c[0]) && near(-sh.c.y, s.analytic!.c[1]) && near(sh.r, s.analytic!.r)
        else if (s.type === "arc" && sh.type === "arc" && s.analytic?.ends) {
          // An arc is its three points, so the centre of a very flat one is not well defined by their rounding (KiCad has the same): compare its ends and its outline.
          const e = [[sh.start.x, -sh.start.y], [sh.end.x, -sh.end.y]]
          const w = s.analytic.ends
          const same = (a: number[], b: number[]) => near(a[0], b[0]) && near(a[1], b[1])
          ok = w.length === 2 && ((same(e[0], w[0]) && same(e[1], w[1])) || (same(e[0], w[1]) && same(e[1], w[0]))) && s.lines.length === linesOf(cand).length && lineWithin(s.lines[0], linesOf(cand)[0], 0.001)
        } else ok = s.lines.length === linesOf(cand).length && s.lines.every((l, k) => lineWithin(l, linesOf(cand)[k], 0.001))
        if (ok) {
          cand.used = true
          hit = true
        }
      }
    }
    if (!hit) {
      wrong++
      if (!firstWrong) firstWrong = `drawings: a ${s.type} on ${s.layer} near (${cx.toFixed(2)}, ${cy.toFixed(2)}) has no match in the project`
    }
  }
  return { file: file.length, project: world.length, counts, wrong: skip ? 0 : wrong, layers, note: (!skip && wrong) || !counts ? firstWrong || `drawings: counts differ ${JSON.stringify(layers)} vs ${JSON.stringify(projCounts)}` : "" }
}

/** The project's drawings through the stored form and back: the same board drawings (ids included) and the same drawings in every land, to the last digit, and the stored text holds no drawing as an object. */
export function roundTripOk(project: Project): boolean {
  if (!project.graphics?.length && !project.footprints?.length) return true
  const text = serializeProject(project)
  const back = parseProjectFile(text, { id: project.id })
  if (!isDeepStrictEqual(back.graphics, project.graphics)) return false
  const had = new Map((project.footprints ?? []).map((f) => [f.name, f.shapes]))
  const got = new Map((back.footprints ?? []).map((f) => [f.name, f.shapes]))
  if (had.size !== got.size) return false
  for (const [name, shapes] of had) if (!isDeepStrictEqual(got.get(name), shapes)) return false
  return !text.includes('"type":"line"')
}
