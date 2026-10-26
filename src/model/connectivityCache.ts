import { computeConnectivity, type SchematicConnectivity } from "./connectivity"
import { runErc, type ErcFinding } from "./erc"
import type { Project } from "./types"

// The schematic's connectivity and electrical checks, computed once per schematic and shared by
// everything that asks: the panels (`store/analysis.ts`), and the store's commit hooks
// (`followNetRenames`, `pruneImportMarks`), which must not each pay for them again.

const sameList = (a?: readonly string[], b?: readonly string[]) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]))

function sameProps(a: Record<string, string>, b: Record<string, string>) {
  if (a === b) return true
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/** Whether two lists of drawings have the same bus lines and bus entries, by identity (a drawing is replaced, never edited, so an unchanged one is the same object). */
function sameBusDrawings(a: Project["drawings"], b: Project["drawings"]): boolean {
  if (a === b) return true
  const pick = (list: Project["drawings"]) => (list ?? []).filter((d) => d.type === "bus" || d.type === "busentry")
  const x = pick(a)
  const y = pick(b)
  return x.length === y.length && x.every((d, i) => d === y[i])
}

/**
 * Whether two projects have the same schematic as far as connectivity and the electrical checks
 * can tell: the same wires and labels and project parts, and for each part the same id, part,
 * reference, properties, schematic place and no-connect pins. A move, a turn, a flip, a lock or a
 * flag on the PCB changes none of these, so it is not a schematic edit.
 */
export function sameSchematic(a: Project, b: Project): boolean {
  // S1: the sheets and their symbols name nets and join them, and a view is a different part of the schematic.
  if (a.wires !== b.wires || a.labels !== b.labels || a.parts !== b.parts || a.sheetSymbols !== b.sheetSymbols || a.sheets !== b.sheets || a.scope !== b.scope) return false
  // S3: bus aliases and bus lines name and join nets too; every other drawing (a note, a box) says nothing about them.
  if (a.busAliases !== b.busAliases || !sameBusDrawings(a.drawings, b.drawings)) return false
  if (a.components === b.components) return true
  if (a.components.length !== b.components.length) return false
  for (let i = 0; i < a.components.length; i++) {
    const x = a.components[i]
    const y = b.components[i]
    if (x === y) continue
    if (x.id !== y.id || x.inst !== y.inst || x.partId !== y.partId || x.ref !== y.ref || x.sch.x !== y.sch.x || x.sch.y !== y.sch.y || x.sch.rot !== y.sch.rot || !sameList(x.nc, y.nc) || !sameProps(x.props, y.props)) return false
  }
  return true
}

const schCache = new WeakMap<Project, SchematicConnectivity>()
/** The last schematic computed, so a PCB-only edit (a new project object with the same schematic) reuses it. */
let last: { project: Project; value: SchematicConnectivity } | null = null

export function getConnectivity(p: Project): SchematicConnectivity {
  const hit = schCache.get(p)
  if (hit) return hit
  const value = last && sameSchematic(last.project, p) ? last.value : computeConnectivity(p)
  last = { project: p, value }
  schCache.set(p, value)
  return value
}

/** Keyed by the connectivity, which is reused while the schematic is unchanged, so PCB edits don't rerun it. */
const ercCache = new WeakMap<SchematicConnectivity, ErcFinding[]>()

/** Electrical check findings, ignored ones included (`splitIgnored` separates them). */
export function getErc(p: Project): ErcFinding[] {
  const conn = getConnectivity(p)
  let value = ercCache.get(conn)
  if (!value) {
    value = runErc(p, conn)
    ercCache.set(conn, value)
  }
  return value
}
