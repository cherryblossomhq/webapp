import { EXAMPLES } from "../src/model/examples"
import { TEMPLATES } from "../src/model/templates"
import type { Project } from "../src/model/types"

const shipped = new Map<string, Project>()
const fresh = new Map<string, Project>()

/**
 * An example as it ships (`src/model/examples/*.json`): built, routed and poured. Building one
 * routes it with no time limit, which takes seconds for the ESP32 robot and several times that on
 * CI, so the tests read the shipped file instead of routing it again in every test file.
 * `templates.test.ts` builds each one now and fails when its file no longer matches, so the two
 * are the same board whenever that test passes. One copy per test file: projects are never
 * mutated, so the tests share it.
 */
export function built(id: string): Project {
  let p = shipped.get(id)
  if (!p) {
    p = structuredClone(EXAMPLES.find((e) => e.id === id)!.project)
    shipped.set(id, p)
  }
  return p
}

/** An example built now, routing it: for `templates.test.ts`, which holds the shipped files to it. */
export function freshlyBuilt(id: string): Project {
  let p = fresh.get(id)
  if (!p) {
    p = TEMPLATES.find((t) => t.id === id)!.build()
    fresh.set(id, p)
  }
  return p
}
