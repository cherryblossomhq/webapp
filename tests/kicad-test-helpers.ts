import { expect } from "vitest"
import { EXTENSION_NAMES, importKicadBoard } from "../src/model/kicad/board"
import type { KicadProjectResult } from "../src/model/kicad/project"
import type { Project } from "../src/model/types"
import { board } from "./kicad-board-fixtures"

// Helpers that many KiCad tests had each written out again. A test file imports the one it wants; where its own spelling was another (`near` for `nearE6`),
// it imports it `as` that name.

/** Every extension of the board importer, built or not, as the `built` option takes them. */
export const ALL = new Set(Object.keys(EXTENSION_NAMES))

/** A uuid that is the number in the last group, so a test can name an item. */
export const uuidD = (n: number) => `d0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

/** Two numbers within `eps` of each other, the tolerance in the name. */
export const nearMilli = (a: number, b: number, eps = 0.001) => Math.abs(a - b) <= eps
export const nearE5 = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps
export const nearE6 = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
export const expectNearE6 = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps)

/** The project a board text imports as, refusing the test when it is not imported. */
export const importedBoard = (text: string): Project => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}

/** A project import that has to have been imported. */
export const importedProject = (r: KicadProjectResult) => {
  if (r.status !== "imported") throw new Error(`refused (${r.reason}): ${r.message}`)
  return r
}

/** The import of a board made of `body` lines (and the `board()` options in `extra`), which has to be imported. */
export const importBody = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ body, ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r
}
