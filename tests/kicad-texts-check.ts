import { isDeepStrictEqual } from "node:util"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { componentTexts, shownOf, textInk, worldTexts, type WorldText } from "../src/model/texts"
import type { Project } from "../src/model/types"
import { boxCornersOracle, oracleInk, textOracle, type OracleFont, type OracleText } from "./kicad-census/texts.mjs"

// The texts of a built project against the oracle's reading of the raw file (`tests/kicad-census/texts.mjs`, which shares no
// code with `src`): counted per layer (the project's world layer, so a bottom part's are already swapped), and every text of
// the file matched to one of the project's on the same layer and kind within 0.001 mm of the same place, with the same size,
// pen, angle, mirror, justification, spacing, flags, hidden state and shown content. With a stroke font, the strokes of each text
// against the oracle's own layout.

const near = (a: number, b: number, eps = 0.001) => Math.abs(a - b) <= eps
const turn = (a: number) => ((a % 360) + 360) % 360
const angleNear = (a: number, b: number) => {
  const d = Math.abs(turn(a) - turn(b))
  return Math.min(d, 360 - d) <= 1e-4
}

export interface TextsCheck {
  file: number
  project: number
  counts: boolean
  wrong: number
  layers: Record<string, number>
  /** Texts whose strokes were laid out against the oracle's, and how many differ. */
  inkChecked: number
  inkWrong: number
  /** Text boxes whose rectangle, border and margins were compared. */
  boxes: number
  /** Texts of parts turned by other than a quarter turn, which are compared like the rest (X6). */
  turned: number
  /** Texts of parts that were paired by footprint order and not by place (parts that share a place). */
  pairedByOrder: number
  note: string
}

const skipLayer = (l: string) => l === "inner" || l === "unknown"

/** The strokes of two texts the same, as multisets of polylines, to a micrometre. */
function sameInk(a: { x: number; y: number }[][], b: number[][][]): boolean {
  if (a.length !== b.length) return false
  const used = new Array(b.length).fill(false)
  for (const line of a) {
    let hit = -1
    for (let i = 0; i < b.length && hit < 0; i++) {
      if (used[i] || b[i].length !== line.length) continue
      // the project is y up, the oracle y down
      if (line.every((p, k) => near(p.x, b[i][k][0]) && near(-p.y, b[i][k][1]))) hit = i
    }
    if (hit < 0) return false
    used[hit] = true
  }
  return true
}

export function checkTexts(text: string, project: Project, opts: { font?: OracleFont } = {}): TextsCheck {
  const o = textOracle(text)
  const layers: Record<string, number> = {}
  const result: TextsCheck = { file: 0, project: 0, counts: true, wrong: 0, layers, inkChecked: 0, inkWrong: 0, boxes: 0, turned: 0, pairedByOrder: 0, note: "" }
  const complain = (what: string) => {
    result.wrong++
    if (!result.note) result.note = what
  }
  const faces = (t: OracleText) => t.face !== null && !t.face.startsWith("KiCad Font")

  const fileOf = (t: OracleText) => !skipLayer(t.layer) && !(t.isBox && (t.fp || t.box?.outline))
  // A footprint is paired with its part by footprint identity: the importer builds the parts in the natural order of the
  // footprints' references (equal references keep the file's order), so sorting the file's footprints the same way pairs each
  // with its own part even when two parts share a place; the place is then checked, not used to pair.
  const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" })
  const ordered = o.footprints.map((f, i) => ({ f, i })).sort((a, b) => natural.compare(a.f.ref, b.f.ref) || a.i - b.i).map((x) => x.f)
  const pairs: { f: (typeof o.footprints)[number]; c: (typeof project.components)[number] | undefined }[] =
    ordered.length === project.components.length ? ordered.map((f, i) => ({ f, c: project.components[i] })) : ordered.map((f) => ({ f, c: undefined }))
  if (ordered.length !== project.components.length) complain(`${o.footprints.length} footprints in the file, ${project.components.length} parts in the project`)

  const compare = (t: OracleText, w: WorldText, hidden: boolean) => {
    const bad: string[] = []
    if (!near(w.x, t.x) || !near(w.y, -t.y)) bad.push(`place (${w.x}, ${w.y}) vs (${t.x}, ${-t.y})`)
    if (!angleNear(w.rot, t.angle)) bad.push(`angle ${w.rot} vs ${t.angle}`)
    if (w.mirror !== t.mirror) bad.push("mirror")
    if (!near(w.size, t.h, 2e-6) || !near(w.w, t.w, 2e-6)) bad.push(`size ${w.size}x${w.w} vs ${t.h}x${t.w}`)
    if (!near(w.thickness, t.thickness, 2e-6)) bad.push(`thickness ${w.thickness} vs ${t.thickness}`)
    if (w.bold !== t.bold || w.italic !== t.italic) bad.push("bold or italic")
    if (w.hj !== t.hj || w.vj !== t.vj) bad.push(`justify ${w.hj},${w.vj} vs ${t.hj},${t.vj}`)
    if (!near(w.spacing, t.spacing, 1e-9)) bad.push("line spacing")
    if (w.knockout !== t.knockout) bad.push("knockout")
    if (w.hidden !== hidden) bad.push("hidden")
    if (w.locked !== t.locked) bad.push("locked")
    if (t.fp && !t.isBox && w.upright !== t.keepUpright) bad.push("keep upright")
    if (t.hasExpression === false && !t.usesFilename && shownOf(project, w) !== t.shown) bad.push(`content ${JSON.stringify(shownOf(project, w))} vs ${JSON.stringify(t.shown)}`)
    if (t.isBox) {
      const b = t.box!
      result.boxes++
      // the oracle derives the text's own frame from the file's rectangle by the version's rule (boxCornersOracle)
      const corners = boxCornersOracle(b, t.angle, o.version)
      if (!corners) bad.push("box corners are not defined for this version")
      const width = corners ? Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) : 0
      const height = corners ? Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]) : 0
      if (!w.box || !near(w.box.w, width, 2e-6) || !near(w.box.h, height, 2e-6)) bad.push(`box size ${w.box?.w}x${w.box?.h} vs ${width}x${height}`)
      const legacy = Math.round((b.strokeWidth === null ? -1 : Math.round(b.strokeWidth * 1e6)) / 2) + Math.round(Math.round(t.h * 1e6) * 0.75)
      const margins = b.margins ?? [legacy / 1e6, legacy / 1e6, legacy / 1e6, legacy / 1e6]
      if (!w.box || w.box.margins.some((m, i) => !near(m, margins[i], 2e-6))) bad.push("box margins")
      const border = b.border && b.strokeWidth !== null && b.strokeWidth > 0 ? b.strokeWidth : undefined
      if (!w.box || (w.box.border ?? null) !== (border ?? null)) bad.push(`box border ${w.box?.border} vs ${border}`)
    }
    if (bad.length) complain(`${t.kind} "${t.raw.slice(0, 20)}" on ${t.layer}: ${bad.join("; ")}`)
    // the strokes, laid out by the oracle with the same font
    const theirs = opts.font && !faces(t) && !t.hasExpression && !bad.length ? oracleInk(opts.font, t, o.version) : null
    if (theirs) {
      result.inkChecked++
      const mine = textInk(project, w)
      if (!sameInk(mine.strokes, theirs.strokes) || !near(mine.pen, theirs.pen, 2e-6)) {
        result.inkWrong++
        if (!result.note) result.note = `strokes of ${t.kind} "${t.shown.slice(0, 20)}" on ${t.layer} differ from the oracle's`
      }
    }
  }

  const take = <T extends { used?: boolean }>(list: T[], pick: (x: T) => boolean) => {
    const found = list.find((x) => !x.used && pick(x))
    if (found) found.used = true
    return found
  }

  // board text
  const boardWorld = worldTexts(project).filter((t) => t.kind === "board").map((w) => ({ w, used: false }))
  for (const t of o.board) {
    if (!fileOf(t)) continue
    result.file++
    layers[t.layer] = (layers[t.layer] ?? 0) + 1
    const hit = take(boardWorld, ({ w }) => w.layer === t.layer && near(w.x, t.x) && near(w.y, -t.y))
    if (!hit) {
      complain(`board text "${t.raw.slice(0, 20)}" on ${t.layer} near (${t.x.toFixed(2)}, ${(-t.y).toFixed(2)}) has no match in the project`)
      continue
    }
    compare(t, hit.w, false)
  }
  const matchedBoard = boardWorld.length
  result.project += matchedBoard

  // parts' text
  const quarter = (a: number) => Math.abs(a - 90 * Math.round(a / 90)) < 1e-6
  const projectLayers: Record<string, number> = {}
  const sharedPlace = new Map<string, number>()
  for (const f of o.footprints) {
    const k = `${f.at[0]},${f.at[1]},${f.bottom}`
    sharedPlace.set(k, (sharedPlace.get(k) ?? 0) + 1)
  }
  for (const { f, c } of pairs) {
    if (!c) continue
    if (!near(c.pcb.x, f.at[0]) || !near(c.pcb.y, -f.at[1]) || (c.pcb.side === "bottom") !== f.bottom) {
      complain(`${f.ref || "a part"}: the part paired with this footprint is not at its place`)
      continue
    }
    const world = componentTexts(c).map((w) => ({ w, used: false }))
    // A part at any angle (X6) is compared like any other: the oracle turns each text by the footprint's angle as KiCad does.
    if (!quarter(f.angle)) result.turned += f.texts.filter((t) => fileOf(t)).length
    if ((sharedPlace.get(`${f.at[0]},${f.at[1]},${f.bottom}`) ?? 0) > 1) result.pairedByOrder += f.texts.filter((t) => fileOf(t)).length
    for (const t of f.texts) {
      if (!fileOf(t)) continue
      result.file++
      layers[t.layer] = (layers[t.layer] ?? 0) + 1
      const hit = take(world, ({ w }) => w.layer === t.layer && w.kind === t.kind && near(w.x, t.x) && near(w.y, -t.y))
      if (!hit) {
        complain(`${f.ref || "a part"}: ${t.kind} "${t.raw.slice(0, 20)}" on ${t.layer} near (${t.x.toFixed(2)}, ${(-t.y).toFixed(2)}) has no match in the project`)
        continue
      }
      compare(t, hit.w, t.hide)
    }
    result.project += world.length
    for (const { w } of world) projectLayers[w.layer] = (projectLayers[w.layer] ?? 0) + 1
  }
  // every text of the project that is on the board stands for one of the file's; counts per layer, for the board text and the compared parts
  for (const { w } of boardWorld) projectLayers[w.layer] = (projectLayers[w.layer] ?? 0) + 1
  result.counts = result.file === result.project && isDeepStrictEqual(Object.fromEntries(Object.entries(layers).sort()), Object.fromEntries(Object.entries(projectLayers).sort()))
  if (!result.counts && !result.note) result.note = `texts: ${result.file} in the file, ${result.project} compared in the project; ${JSON.stringify(layers)} vs ${JSON.stringify(projectLayers)}`
  return result
}

/** The project through the stored form and back: the same texts on the board and on every part, to the last digit, and no text stored as a long object. */
export function textsRoundTripOk(project: Project): boolean {
  const kicad = project.texts?.some((t) => t.layer !== undefined)
  const parts = project.components.some((c) => c.texts)
  if (!kicad && !parts) return true
  const stored = serializeProject(project)
  const back = parseProjectFile(stored, { id: project.id })
  if (!isDeepStrictEqual(back.texts, project.texts)) return false
  const had = new Map(project.components.map((c) => [c.id, c.texts]))
  for (const c of back.components) if (!isDeepStrictEqual(c.texts, had.get(c.id))) return false
  return !stored.includes('"kind":"reference"') && !stored.includes('"hj":') && !stored.includes('"textStyles":null')
}
