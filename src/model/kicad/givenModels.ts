import type { Model3DFormat } from "../types"

// The 3D model files a KiCad board came with (a project's `3d models/` folder), apart from the board importer: the import's worker reads and
// hashes them before the importer is loaded, and the export finds them again among the kept files.

/** A 3D model file given with the board (a project's `3d models/` folder), kept in the host's file store by the SHA-256 of its bytes. */
export interface GivenModel {
  id: string
  name: string
  format: Model3DFormat
}

/** The model files given with a board, by their path under the board's folder: `/` between folders, lower case. */
export type GivenModels = ReadonlyMap<string, GivenModel>

/**
 * The given file a model's path names: `${KIPRJMOD}/3d models/U1.step` or `3d models/U1.step` by its path under the board's folder, else
 * (an absolute path, another variable) by its file name when one given file alone has it.
 */
export function givenModelFor<T = GivenModel>(path: string, given: ReadonlyMap<string, T>): T | null {
  const rel = path.replace(/\\/g, "/").replace(/^\$\{KIPRJMOD\}\//i, "").replace(/^\.\//, "").toLowerCase()
  const hit = given.get(rel)
  if (hit) return hit
  const name = rel.slice(rel.lastIndexOf("/") + 1)
  const same = [...given].filter(([k]) => k.slice(k.lastIndexOf("/") + 1) === name)
  return same.length === 1 ? same[0][1] : null
}
