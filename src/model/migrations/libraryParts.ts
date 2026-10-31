/**
 * Version 3 to 4 of the project file (October 2026): the built-in library holds basic parts only.
 *
 * It used to list chips and modules too (the ICs and Modules, four regulators, the WS2812B), and
 * a project placed them by their library ids ("ne555", "esp32_devkit_v1"). A chip is found in the
 * parts database now, like any other specific part, and the library no longer defines one. So a
 * project that placed one gets it as a part of its own (`Project.parts`), drawn exactly as the
 * library drew it, so every pin is where its wires meet it, and its components and 3D models name
 * that part. Its components keep the footprints they had.
 *
 * Plain JSON in and out, and frozen: the parts as the library had them (`libraryParts.json`).
 */

import RETIRED from "./libraryParts.json"

type Json = Record<string, unknown>

const PARTS = new Map<string, Json & { id: string }>(Object.entries(RETIRED))

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value)

export function libraryParts(project: Json): Json {
  const used = new Map<string, Json>()
  const rename = (id: unknown): string | undefined => {
    const part = typeof id === "string" ? PARTS.get(id) : undefined
    if (part) used.set(part.id, part)
    return part?.id
  }
  const components = Array.isArray(project.components)
    ? project.components.map((c) => {
        const id = isObject(c) ? rename(c.partId) : undefined
        return id ? { ...(c as Json), partId: id } : c
      })
    : project.components
  const models = Array.isArray(project.models)
    ? project.models.map((m) => {
        const id = isObject(m) ? rename(m.part) : undefined
        return id ? { ...(m as Json), part: id } : m
      })
    : project.models
  if (!used.size) return project
  const parts = Array.isArray(project.parts) ? project.parts : []
  const have = new Set(parts.map((s) => (isObject(s) ? s.id : undefined)))
  return { ...project, components, models, parts: [...parts, ...[...used.values()].filter((s) => !have.has(s.id))] }
}
