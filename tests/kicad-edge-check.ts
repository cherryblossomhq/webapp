import { edgeOracle, length, nearestIndex, sample } from "./kicad-census/edge.mjs"
import { outlinePaths } from "../src/model/outlineOps"
import { flattenPath } from "../src/model/shapes"
import type { Project } from "../src/model/types"

// The board's outline in the project against the raw file's Edge.Cuts, both ways, to 0.001 mm (the oracle is `kicad-census/edge.mjs`,
// which shares no code with `src`). The project's outline is its paths, or, for a board that is a plain rectangle, the rectangle it holds.

const END_REACH = 0.1 + 0.001

export interface EdgeCheck {
  /** Pieces the file draws on Edge.Cuts, and the points of them compared. */
  pieces: number
  fileSamples: number
  projectSamples: number
  /** Points more than 0.001 mm from the other side and not at a place the importer says it repaired. */
  wrong: number
  /** Points more than 0.001 mm off that sit within a tenth of a millimetre of an end of an open piece of the file: where a gap was closed. */
  atRepairs: number
  /** Points off by up to 0.1 mm on a board where the importer says it merged pieces onto a line. */
  merged: number
  /** Pieces of the file under a tenth of a millimetre that are missing from the project, where the importer says it dropped some. */
  dropped: number
  note: string
}

export function checkEdge(text: string, project: Project, repair: { moved: number; dropped: number; zeroLength: number }): EdgeCheck {
  const raw = edgeOracle(text)
  const result: EdgeCheck = { pieces: raw.length, fileSamples: 0, projectSamples: 0, wrong: 0, atRepairs: 0, merged: 0, dropped: 0, note: "" }
  const missing = project.board.outline?.paths.length === 0
  const model = (missing ? [] : outlinePaths(project.board)).map((p) => {
    const pts = flattenPath(p, 0.0002).map((q) => [q.x, -q.y])
    return p.closed ? [...pts, pts[0]] : pts
  })
  if (!raw.length) {
    if (!missing) result.note = "the file draws no outline and the project is not marked as missing one"
    return result
  }
  if (!model.length) {
    result.note = "the file draws an outline and the project has none"
    result.wrong = raw.length
    return result
  }
  const ends = raw.filter((r) => !r.closed).flatMap((r) => [r.line[0], r.line[r.line.length - 1]])
  const nearEnd = nearestIndex(ends.map((e) => [e, e]), END_REACH)
  const toModel = nearestIndex(model, 0.15)
  const toFile = nearestIndex(raw.map((r) => r.line), 0.15)
  const judge = (d: number, p: number[]) => {
    if (d <= 0.001) return
    if (nearEnd(p) <= END_REACH) result.atRepairs++
    else if (repair.moved > 0 && d <= 0.1 + 1e-9) result.merged++
    else result.wrong++
  }
  for (const r of raw) {
    const pts = sample(r.line)
    // A piece under a tenth of a millimetre may have been dropped (the importer counts them): one that is still there is matched as any other.
    if (length(r.line) < 0.1 && repair.dropped + repair.zeroLength > 0) {
      result.fileSamples += pts.length
      if (pts.some((p) => toModel(p) > 0.001)) result.dropped++
      continue
    }
    result.fileSamples += pts.length
    for (const p of pts) judge(toModel(p), p)
  }
  for (const line of model) {
    const pts = sample(line)
    result.projectSamples += pts.length
    for (const p of pts) judge(toFile(p), p)
  }
  if (result.wrong) result.note = `outline: differs from the file's at ${result.wrong} of ${result.fileSamples + result.projectSamples} points`
  return result
}
