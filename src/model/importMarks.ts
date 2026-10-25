import { computeConnectivity, pinKey } from "./connectivity"
import { runErc } from "./erc"
import type { Project } from "./types"

// What the KiCad import set on its own (`Project.importMarks`): the lone-label checks it ignored
// and the pins it marked no connect, so they can be taken back, or dropped once they stop being
// true, without touching an ignore or a no-connect the user made.

/** Marks of an import that no longer hold are dropped: an ignored check whose finding is gone, a no-connect pin that was cleared, connected or removed. */
export function pruneImportMarks(before: Project, after: Project): Project {
  const marks = after.importMarks
  if (!marks) return after
  // Only a schematic edit can change them.
  if (before.components === after.components && before.wires === after.wires && before.labels === after.labels) return after
  const conn = computeConnectivity(after)
  const byId = new Map(after.components.map((c) => [c.id, c]))
  let checks = marks.checks
  if (checks?.length) {
    const still = new Set(runErc(after, conn).filter((f) => f.kind === "lone-label").map((f) => f.key))
    checks = checks.filter((k) => still.has(k))
  }
  let noConnect = marks.noConnect
  if (noConnect) {
    const kept: Record<string, string[]> = {}
    for (const [id, pins] of Object.entries(noConnect)) {
      const c = byId.get(id)
      const live = pins.filter((p) => c?.nc?.includes(p) && conn.pinNet.get(pinKey(id, p)) === undefined)
      if (live.length) kept[id] = live
    }
    noConnect = Object.keys(kept).length ? kept : undefined
  }
  const same = (checks?.length ?? 0) === (marks.checks?.length ?? 0) && JSON.stringify(noConnect ?? null) === JSON.stringify(marks.noConnect ?? null)
  if (same) return after
  const dropped = new Set((marks.checks ?? []).filter((k) => !checks?.includes(k)))
  const ignored = (after.ignoredChecks ?? []).filter((k) => !dropped.has(k))
  const { importMarks: _old, ignoredChecks: _ig, ...rest } = after
  const next: Project = { ...rest, ...(ignored.length ? { ignoredChecks: ignored } : {}) }
  if (checks?.length || noConnect) next.importMarks = { ...(checks?.length ? { checks } : {}), ...(noConnect ? { noConnect } : {}) }
  return next
}

/** The pins the import marked no connect, on these parts or on every part: back to being checked as unconnected. */
export function clearImportedNoConnect(project: Project, componentIds?: string[]): Project {
  const marks = project.importMarks?.noConnect
  if (!marks) return project
  const only = componentIds ? new Set(componentIds) : null
  const left: Record<string, string[]> = {}
  const components = project.components.map((c) => {
    const pins = marks[c.id]
    if (!pins) return c
    if (only && !only.has(c.id)) {
      left[c.id] = pins
      return c
    }
    const nc = (c.nc ?? []).filter((p) => !pins.includes(p))
    const { nc: _nc, ...rest } = c
    return nc.length ? { ...rest, nc } : rest
  })
  const { importMarks: _m, ...rest } = project
  const importMarks = { ...(project.importMarks?.checks?.length ? { checks: project.importMarks.checks } : {}), ...(Object.keys(left).length ? { noConnect: left } : {}) }
  return { ...rest, components, updatedAt: Date.now(), ...(Object.keys(importMarks).length ? { importMarks } : {}) }
}

/** How many pins the import marked no connect that still are, on one part or on the board. */
export function importedNoConnectCount(project: Project, componentId?: string): number {
  const marks = project.importMarks?.noConnect
  if (!marks) return 0
  return Object.entries(marks).reduce((n, [id, pins]) => (componentId && id !== componentId ? n : n + pins.length), 0)
}
