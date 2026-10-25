import { createHash } from "node:crypto"
import { dimensionDrawing } from "../src/model/dimensions"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { isDeepStrictEqual } from "node:util"
import type { Project } from "../src/model/types"
// @ts-expect-error the oracle is plain JavaScript with no declarations
import { dimensionOracle, groupOracle, imageOracle } from "./kicad-census/dimensions.mjs"

// Dimensions, groups and reference images of a board file against the project built from it, with an oracle that shares no code with `src` (`kicad-census/dimensions.mjs`):
// what each dimension draws (every line and circle, to a micrometre, in any order) and says (text, place, angle), what each group holds (by what the items are, not by id),
// and each image (place, layer, scale, size, resolution and bytes). The cached lines of a KiCad 5 dimension are compared too, where KiCad still draws them the same.

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps
type P = [number, number]
type Seg = [P, P]

/** Whether two lists of segments are the same set to `eps`, each segment either way round. */
function sameSegments(want: Seg[], got: Seg[], eps: number): boolean {
  if (want.length !== got.length) return false
  const used = new Array(got.length).fill(false)
  for (const w of want) {
    const i = got.findIndex((g, k) => !used[k] && ((near(g[0][0], w[0][0], eps) && near(g[0][1], w[0][1], eps) && near(g[1][0], w[1][0], eps) && near(g[1][1], w[1][1], eps)) || (near(g[0][0], w[1][0], eps) && near(g[0][1], w[1][1], eps) && near(g[1][0], w[0][0], eps) && near(g[1][1], w[0][1], eps))))
    if (i < 0) return false
    used[i] = true
  }
  return true
}

export interface DimensionsCheck {
  /** Dimensions of the board file and of the project. */
  file: number
  project: number
  /** Dimensions inside footprints, which the editor does not hold yet (X26). */
  inFootprints: number
  counts: boolean
  /** Dimensions whose lines, circles or text differ from the oracle's, and the first difference. */
  wrong: number
  /** What the file's text units say, against the project's units, for KiCad 5 dimensions. */
  legacy: number
  /** KiCad 5 dimensions whose cached arrows have KiCad's own length, and of those the ones every arrow of which is among the lines drawn. */
  arrowsComparable: number
  arrowsSame: number
  /** KiCad 5 dimensions whose cached crossbar ends are where the drawn crossbar ends, and whose cached feature lines start at the points and run the same way. */
  barSame: number
  featureSame: number
  /** The text of every dimension that has one, by its content, compared. */
  texts: number
  /** The groups of the file (as KiCad resolves them, less what the project cannot hold) and of the project; the part groups likewise. */
  groupsFile: number
  groupsProject: number
  partGroupsFile: number
  partGroupsProject: number
  partGroupsSkipped: number
  groupsWrong: number
  /** Images of the file and of the project, and how many differ. */
  imagesFile: number
  imagesProject: number
  imagesWrong: number
  /** The project, saved and loaded, is the same in these fields. */
  roundTrip: boolean
  note?: string
}

const BUILT_KINDS = new Set(["part", "segment", "via", "text", "dimension", "image", "target", "shape", "group", "pad"])

/** The groups of the oracle with what the project cannot hold taken out (zones, arc tracks, tables, items inside footprints), and groups left with nothing taken out after it. */
function builtGroups(groups: { name: string; locked: boolean; items: { kind: string }[]; groups: number[]; lib: string | null }[]) {
  // (a drawing on the edge layer is the outline, which is no drawing of the project)
  const items = groups.map((g) => g.items.filter((i) => BUILT_KINDS.has(i.kind) && !((i as { layer?: string }).layer === "Edge.Cuts" && i.kind === "shape")))
  const alive: (boolean | undefined)[] = []
  const lives = (i: number): boolean => (alive[i] ??= items[i].length > 0 || groups[i].groups.some((c) => lives(c)))
  const kept = groups.map((_, i) => i).filter((i) => lives(i))
  const place = new Map(kept.map((g, p) => [g, p]))
  return kept.map((i) => ({ ...groups[i], items: items[i], groups: groups[i].groups.filter((c) => place.has(c)).map((c) => place.get(c)!) }))
}

const kindOfShape = (type: string) => (type === "polygon" ? "poly" : type)

export function checkDimensions(text: string, project: Project, font: unknown, lossy: string[]): DimensionsCheck {
  const o = dimensionOracle(text, font)
  const dims = project.dimensions ?? []
  const out: DimensionsCheck = {
    file: o.dims.length,
    project: dims.length,
    inFootprints: o.inFootprints,
    counts: true,
    wrong: 0,
    legacy: 0,
    arrowsComparable: 0,
    arrowsSame: 0,
    barSame: 0,
    featureSame: 0,
    texts: 0,
    groupsFile: 0,
    groupsProject: 0,
    partGroupsFile: 0,
    partGroupsProject: 0,
    partGroupsSkipped: 0,
    groupsWrong: 0,
    imagesFile: 0,
    imagesProject: 0,
    imagesWrong: 0,
    roundTrip: true,
  }
  const note = (s: string) => (out.note ??= s)

  // ---- dimensions ----
  // A dimension on a layer the editor has not got, or in a unit it cannot hold, is a refusal the gate raises: nothing to compare.
  const skip = lossy.some((l) => /a dimension|a KiCad 5 dimension/.test(l))
  out.counts = skip || o.dims.length === dims.length
  if (!skip && out.counts) {
    o.dims.forEach((want: any, i: number) => {
      const got = dims[i]
      const flip = (s: Seg): Seg => [[s[0][0], -s[0][1]], [s[1][0], -s[1][1]]]
      const draw = dimensionDrawing(got)
      const wantLines = (want.drawn.lines as Seg[]).map(flip)
      const gotLines = draw.lines.map((l): Seg => [[l.a.x, l.a.y], [l.b.x, l.b.y]])
      let bad = ""
      if (got.kind !== want.kind || got.layer !== want.layer) bad = `kind or layer: ${got.kind} ${got.layer}, file ${want.kind} ${want.layer}`
      else if (!sameSegments(wantLines, gotLines, 1.5e-3)) bad = `lines: ${gotLines.length} in the project, ${wantLines.length} by the oracle`
      else if ((want.drawn.circles as { c: P; r: number }[]).length !== draw.circles.length || (want.drawn.circles as { c: P; r: number }[]).some((c, k) => !near(c.c[0], draw.circles[k].c.x, 2e-3) || !near(-c.c[1], draw.circles[k].c.y, 2e-3) || !near(c.r, draw.circles[k].r, 2e-3))) bad = "circles"
      else if (want.drawn.text) {
        const t = want.drawn.text as { content: string; x: number; y: number; angle: number }
        out.texts++
        if (!draw.text) bad = "no text"
        else if (draw.text.content !== t.content) bad = `text "${draw.text.content}" against "${t.content}"`
        else if (!near(draw.text.x, t.x, 1.5e-3) || !near(draw.text.y, -t.y, 1.5e-3)) bad = `text at (${draw.text.x}, ${draw.text.y}) against (${t.x}, ${-t.y})`
        else if (Math.min(Math.abs(draw.text.rot - t.angle), 360 - Math.abs(draw.text.rot - t.angle)) > 1e-3) bad = `text angle ${draw.text.rot} against ${t.angle}`
      } else if (draw.text) bad = "a text where there is none"
      if (!bad && !near(draw.measured / 1e6, want.drawn.measured, 1.5e-3)) bad = `measured ${draw.measured / 1e6} against ${want.drawn.measured}`
      if (bad) {
        out.wrong++
        note(`dimension ${i + 1} (${want.kind}, ${want.legacy ? "KiCad 5" : "typed"}): ${bad}`)
      }
      // The cached lines of a KiCad 5 dimension.
      if (want.legacy && want.cached) {
        out.legacy++
        const cached = want.cached as { arrows: Seg[]; crossbar?: Seg; feature1?: Seg; feature2?: Seg }
        const cachedLen = cached.arrows.length ? Math.hypot(cached.arrows[0][1][0] - cached.arrows[0][0][0], cached.arrows[0][1][1] - cached.arrows[0][0][1]) : 0
        if (cached.arrows.length === 4 && near(cachedLen, 1.27, 1e-3) && near(got.arrow, 1.27, 1e-9)) {
          out.arrowsComparable++
          const arrows = cached.arrows.map(flip)
          // every cached arrow line is one of the drawn lines (the arrow is KiCad's own shape)
          if (arrows.every((a) => gotLines.some((g) => sameSegments([a], [g], 2e-5)))) out.arrowsSame++
          else note(`dimension ${i + 1}: KiCad 5's cached arrows are not among the lines drawn`)
        }
        const ends = (s: Seg | undefined) => (s ? [s[0], s[1]].map((p) => [p[0], -p[1]] as P) : [])
        const bar = ends(cached.crossbar)
        if (bar.length === 2 && bar.every((p) => gotLines.some((g) => g.some((q) => near(q[0], p[0], 2e-5) && near(q[1], p[1], 2e-5))))) out.barSame++
        const f1 = cached.feature1
        const f2 = cached.feature2
        const run = (f: Seg | undefined, p: { x: number; y: number }) => {
          if (!f) return false
          const start: P = [f[0][0], -f[0][1]]
          const dir: P = [f[1][0] - f[0][0], -(f[1][1] - f[0][1])]
          return gotLines.some((g) => near(g[0][0], start[0], 2e-5) && near(g[0][1], start[1], 2e-5) && Math.abs((g[1][0] - g[0][0]) * dir[1] - (g[1][1] - g[0][1]) * dir[0]) < 1e-3 * Math.hypot(...dir)) && near(p.x, start[0], 2e-5) && near(p.y, start[1], 2e-5)
        }
        if (run(f1, got.a) && run(f2, got.b)) out.featureSame++
        // the unit the oracle reads from the raw text (FetchUnitsFromString) is the unit the dimension has
        const unit = want.units
        if (got.units !== unit) {
          out.wrong++
          note(`dimension ${i + 1}: units ${got.units} for the text "${want.text?.raw}"`)
        }
      }
    })
  }

  // ---- groups ----
  const g = groupOracle(text)
  const groups = project.groups ?? []
  const wantGroups = builtGroups(g.board)
  out.groupsFile = wantGroups.length
  out.groupsProject = groups.length
  const dropped = lossy.length > 0
  if (!dropped) {
    if (wantGroups.length !== groups.length) {
      out.groupsWrong++
      note(`groups: ${groups.length} in the project, ${wantGroups.length} by the oracle`)
    } else {
      const gi = new Map(groups.map((x, i) => [x.id, i]))
      const trace = new Map(project.traces.map((t) => [t.id, t]))
      const via = new Map(project.vias.map((v) => [v.id, v]))
      const comp = new Map(project.components.map((c) => [c.id, c]))
      const graphic = new Map((project.graphics ?? []).map((x) => [x.id, x]))
      const texts = new Map(project.texts.map((x) => [x.id, x]))
      const dimension = new Map(dims.map((x) => [x.id, x]))
      const image = new Map((project.images ?? []).map((x) => [x.id, x]))
      const r = (v: number) => Math.round(v * 1000) / 1000
      wantGroups.forEach((want: any, k) => {
        const have = groups[k]
        let bad = ""
        if (have.name !== want.name || (have.locked === true) !== want.locked || (have.lib ?? null) !== want.lib) bad = `name, lock or design block: "${have.name}", ${have.locked === true}, ${have.lib ?? null}`
        const childGroups = have.members.filter((m) => gi.has(m)).map((m) => gi.get(m)!).sort()
        if (!bad && !isDeepStrictEqual(childGroups, [...want.groups].sort())) bad = `nested groups ${childGroups} against ${want.groups}`
        if (!bad) {
          const sig = { part: [] as string[], segment: [] as string[], via: [] as string[], shape: [] as string[], text: [] as string[], dimension: 0, image: [] as string[] }
          for (const m of have.members) {
            if (gi.has(m)) continue
            if (comp.has(m)) sig.part.push(`${r(comp.get(m)!.pcb.x)},${r(comp.get(m)!.pcb.y)}`)
            else if (trace.has(m)) {
              const t = trace.get(m)!
              for (let i = 1; i < t.points.length; i++) {
                const a = `${r(t.points[i - 1].x)},${r(t.points[i - 1].y)}`
                const b = `${r(t.points[i].x)},${r(t.points[i].y)}`
                sig.segment.push([t.layer === "top" ? "F.Cu" : "B.Cu", ...[a, b].sort()].join("|"))
              }
            } else if (via.has(m)) sig.via.push(`${r(via.get(m)!.x)},${r(via.get(m)!.y)}`)
            else if (graphic.has(m)) sig.shape.push(`${graphic.get(m)!.layer}|${kindOfShape(graphic.get(m)!.type)}`)
            else if (texts.has(m)) sig.text.push(texts.get(m)!.layer ?? "")
            else if (dimension.has(m)) sig.dimension++
            else if (image.has(m)) sig.image.push(`${r(image.get(m)!.x)},${r(image.get(m)!.y)}|${image.get(m)!.layer}`)
          }
          const w = { part: [] as string[], segment: [] as string[], via: [] as string[], shape: [] as string[], text: [] as string[], dimension: 0, image: [] as string[] }
          for (const it of want.items as any[]) {
            if (it.kind === "part") w.part.push(`${r(it.at[0])},${r(-it.at[1])}`)
            else if (it.kind === "segment") w.segment.push([it.layer, ...[`${r(it.a[0])},${r(-it.a[1])}`, `${r(it.b[0])},${r(-it.b[1])}`].sort()].join("|"))
            else if (it.kind === "via") w.via.push(`${r(it.at[0])},${r(-it.at[1])}`)
            else if (it.kind === "shape") w.shape.push(`${it.layer}|${it.shape === "poly" ? "poly" : it.shape === "rect" ? "rect" : it.shape}`)
            else if (it.kind === "target") w.shape.push("TARGET")
            else if (it.kind === "text") w.text.push(it.layer)
            else if (it.kind === "dimension") w.dimension++
            else if (it.kind === "image") w.image.push(`${r(it.at[0])},${r(-it.at[1])}|${it.layer}`)
          }
          // A target is a circle and two lines on its layer; the oracle names it by its three drawings' count, which the project's drawings show.
          const targets = w.shape.filter((s) => s === "TARGET").length
          w.shape = w.shape.filter((s) => s !== "TARGET")
          const mixed = (a: string[]) => [...a].sort()
          // A place that sits exactly between two thousandths (-4.0625) rounds one way read from the file and the other way once the editor's y has been turned over: the same place, so the numbers of a signature agree to a thousandth and a half.
          const sameSigs = (a: string[], c: string[]) => {
            const x = mixed(a)
            const y = mixed(c)
            return x.length === y.length && x.every((t, i) => {
              const p = t.split(/(-?\d+(?:\.\d+)?)/)
              const q = y[i].split(/(-?\d+(?:\.\d+)?)/)
              return p.length === q.length && p.every((u, k) => (k % 2 ? Math.abs(Number(u) - Number(q[k])) < 1.5e-3 : u === q[k]))
            })
          }
          if (!sameSigs(sig.part, w.part)) bad = `parts ${sig.part.length} against ${w.part.length}`
          else if (!sameSigs(sig.segment, w.segment)) bad = `track segments ${sig.segment.length} against ${w.segment.length}`
          else if (!sameSigs(sig.via, w.via)) bad = `vias ${sig.via.length} against ${w.via.length}`
          else if (sig.shape.length !== w.shape.length + 3 * targets) bad = `drawings ${sig.shape.length} against ${w.shape.length} and ${targets} targets`
          else if (sig.text.length !== w.text.length || !isDeepStrictEqual(mixed(sig.text.map((t) => t)), mixed(w.text))) bad = `texts ${sig.text.length} against ${w.text.length}`
          else if (sig.dimension !== w.dimension) bad = `dimensions ${sig.dimension} against ${w.dimension}`
          else if (!isDeepStrictEqual(mixed(sig.image), mixed(w.image))) bad = "images"
        }
        if (bad) {
          out.groupsWrong++
          note(`group ${k + 1} "${want.name}": ${bad}`)
        }
      })
    }
    // the groups inside parts: by the part's place, the part's own pads, drawings and texts
    out.partGroupsFile = g.parts.reduce((n: number, p: any) => n + builtGroups(p.groups.map((x: any) => ({ ...x, items: x.items.map((i: any) => (i.kind === "pad" || i.kind === "shape" || i.kind === "text" || i.kind === "group" ? i : { kind: "unbuilt" })) }))).length, 0)
    out.partGroupsProject = project.components.reduce((n, c) => n + (c.groups?.length ?? 0), 0)
    if (out.partGroupsFile !== out.partGroupsProject) {
      out.groupsWrong++
      note(`groups inside parts: ${out.partGroupsProject} in the project, ${out.partGroupsFile} by the oracle`)
    }
  }

  // ---- images ----
  const images = imageOracle(text)
  out.imagesFile = images.length
  out.imagesProject = project.images?.length ?? 0
  if (!lossy.some((l) => /reference image/.test(l))) {
    if (images.length !== out.imagesProject) {
      out.imagesWrong++
      note(`images: ${out.imagesProject} in the project, ${images.length} by the oracle`)
    } else {
      images.forEach((want: any, i: number) => {
        const have = project.images![i]
        const sha = createHash("sha256").update(want.bytes).digest("hex")
        const bad =
          !near(have.x, want.at[0]) || !near(have.y, -want.at[1]) || have.layer !== want.layer || have.scale !== want.scale || (have.locked === true) !== want.locked || have.file !== sha || have.px !== want.px || have.py !== want.py || have.ppi !== want.ppi || have.format !== (want.png ? "png" : "jpg")
        if (bad) {
          out.imagesWrong++
          note(`image ${i + 1}: ${JSON.stringify({ ...have })} against place ${want.at}, layer ${want.layer}, scale ${want.scale}, ${want.px} by ${want.py} at ${want.ppi}, ${sha.slice(0, 8)}`)
        }
      })
    }
  }

  // ---- the stored form ----
  const back = parseProjectFile(serializeProject(project), { id: project.id })
  for (const k of ["dimensions", "groups", "images"] as const) if (!isDeepStrictEqual(back[k], project[k])) out.roundTrip = false
  if (!isDeepStrictEqual(back.components.map((c) => c.groups), project.components.map((c) => c.groups))) out.roundTrip = false
  return out
}
