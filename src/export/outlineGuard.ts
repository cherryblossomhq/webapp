import { outlineState } from "../model/outline"
import type { Project } from "../model/types"

/** An export that needs the board cut out was asked of a board whose outline does not close or is missing. */
export class OutlineNotClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OutlineNotClosedError"
  }
}

/**
 * Refuse, with a message that says what to do, when the board has no closed outline: a fab cuts the board along it, and
 * a solid model needs it. The board is kept as drawn either way; nothing here changes it.
 */
export function requireClosedOutline(project: Project, what: string): void {
  const state = outlineState(project.board)
  if (state === "closed") return
  const open = project.board.outline?.paths.filter((p) => !p.closed).length ?? 0
  throw new OutlineNotClosedError(
    state === "missing"
      ? `${what} cannot be made: the board has no outline. Draw one on the Edge.Cuts layer in the PCB view, closed, and export again.`
      : `${what} cannot be made: the board outline is not closed (${open} piece${open === 1 ? "" : "s"} of it end${open === 1 ? "s" : ""} in the open). Close it in the PCB view, or delete the stray piece, and export again.`,
  )
}
