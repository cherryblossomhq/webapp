import { outlineState } from "../model/outline"
import { outlineCrossingProblem } from "../model/outlineCrossing"
import type { Project } from "../model/types"

/** An export that needs the board cut out was asked of a board whose outline does not close or is missing. */
export class OutlineNotClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OutlineNotClosedError"
  }
}

const noOutline = (what: string) => new OutlineNotClosedError(`${what} cannot be made: the board has no outline. Draw one on the Edge.Cuts layer in the PCB view, closed, and export again.`)

const openPieces = (project: Project) => project.board.outline?.paths.filter((p) => !p.closed).length ?? 0
const piecesInTheOpen = (open: number) => `${open} piece${open === 1 ? "" : "s"} of it end${open === 1 ? "s" : ""} in the open`

/**
 * Refuse, with a message that says what to do, when the board has no closed outline: a solid model needs it. The board is kept as
 * drawn either way; nothing here changes it.
 */
export function requireClosedOutline(project: Project, what: string): void {
  const state = outlineState(project.board)
  if (state === "closed") {
    const crossing = outlineCrossingProblem(project.board.outline?.paths ?? [])
    if (crossing) throw new OutlineNotClosedError(`${what} cannot be made: ${crossing.charAt(0).toLowerCase()}${crossing.slice(1)} Fix it in the PCB view and export again.`)
    return
  }
  if (state === "missing") throw noOutline(what)
  throw new OutlineNotClosedError(`${what} cannot be made: the board outline is not closed (${piecesInTheOpen(openPieces(project))}). Close it in the PCB view, or delete the stray piece, and export again.`)
}

/**
 * Refuse when the board has no outline at all, which leaves a fab nothing to cut. One with gaps or edges that cross is plotted as drawn,
 * as KiCad plots it (85 open-source KiCad boards have one), and `outlineWarning` says so.
 */
export function requireOutline(project: Project, what: string): void {
  if (outlineState(project.board) === "missing") throw noOutline(what)
}

/** What the fab files of a board say about an outline a fab cannot cut as it is drawn; null for one that closes cleanly, or none at all. */
export function outlineWarning(project: Project): string | null {
  const state = outlineState(project.board)
  if (state === "missing") return null
  if (state === "closed") {
    const crossing = outlineCrossingProblem(project.board.outline?.paths ?? [])
    return crossing ? `The board outline has edges that cross, so a fab cannot cut it as it is drawn. ${crossing}` : null
  }
  return `The board outline is not closed (${piecesInTheOpen(openPieces(project))}), so a fab cannot cut it as it is drawn. Close it in the PCB view, or delete the stray piece, before ordering.`
}
