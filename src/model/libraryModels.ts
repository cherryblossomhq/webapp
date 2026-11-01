import TABLE from "./libraryModels.json"
import type { Model3D } from "./types"

// The KiCad models the built-in parts are drawn with (`libraryModelSources.ts` says which, and
// `tests/library-models.generate.test.ts` placed each on our footprint). A project that gives a
// part on a footprint a model of its own (`Project.models`) is drawn with that instead.

const BY_KEY = new Map(TABLE.models.map((m) => [`${m.part}\n${m.footprint}`, m.model as Model3D]))

/**
 * The model a part has on a footprint without the project giving it one: a built-in part's own
 * (`resistor` on `0603`), else the package's whatever part is in it (`soic8`), else none.
 */
export function libraryModel(part: string, footprint: string): Model3D | null {
  return BY_KEY.get(`${part}\n${footprint}`) ?? BY_KEY.get(`*\n${footprint}`) ?? null
}
