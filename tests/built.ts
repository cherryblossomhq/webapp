import { TEMPLATES } from "../src/model/templates"
import type { Project } from "../src/model/types"

const cache = new Map<string, Project>()

/**
 * An example, built once per test file. Building one routes it with no time limit, which takes
 * seconds for the ESP32 robot, and several times that on CI. Projects are never mutated, so the
 * tests can share one.
 */
export function built(id: string): Project {
  let p = cache.get(id)
  if (!p) {
    p = TEMPLATES.find((t) => t.id === id)!.build()
    cache.set(id, p)
  }
  return p
}
