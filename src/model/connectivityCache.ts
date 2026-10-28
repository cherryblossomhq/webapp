import { computeConnectivity, type SchematicConnectivity } from "./connectivity"
import { runErc, type ErcFinding } from "./erc"
import { isRuleArea } from "./ruleAreas"
import type { Project, SchematicDrawing } from "./types"

// The schematic's connectivity and electrical checks, computed once per schematic and shared by
// everything that asks: the panels (`store/analysis.ts`), and the store's commit hooks
// (`followNetRenames`, `pruneImportMarks`), which must not each pay for them again.

const sameList = (a?: readonly string[], b?: readonly string[]) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]))

function sameProps(a: Record<string, string> | undefined, b: Record<string, string> | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/**
 * Whether two lists of drawings have the same bus lines, bus entries and rule areas, by identity (a drawing is replaced, never edited, so an unchanged one is the same object).
 * On a project with a sheet joined by KiCad's rules (S11) the junctions and no-connect markers count too: they join wires and keep a label off a wire there. The other drawings are not looked at.
 */
function sameConnectivityDrawings(a: readonly SchematicDrawing[] | undefined, b: readonly SchematicDrawing[] | undefined, exact: boolean): boolean {
  const matters = (d: SchematicDrawing) => mattersToNets(d) || (exact && (d.type === "junction" || d.type === "noconnect"))
  const x = (a ?? []).filter(matters)
  const y = (b ?? []).filter(matters)
  return x.length === y.length && x.every((d, i) => d === y[i])
}
const mattersToNets = (d: SchematicDrawing) => d.type === "bus" || d.type === "busentry" || isRuleArea(d)

/**
 * Whether two projects have the same schematic as far as connectivity and the electrical checks
 * can tell: the same wires and labels and project parts, and for each part the same id, part,
 * reference, properties, schematic place (position, turn and mirror), no-connect pins and what decides
 * which pins it draws (unit, body style, the function chosen for a pin). A move, a turn, a flip, a lock
 * or a flag on the PCB changes none of these, so it is not a schematic edit. `computeConnectivity` and
 * `runErc` read nothing else of a symbol: its footprint, fields' places, texts and board place are not
 * looked at, so a change to them keeps the answer.
 */
export function sameSchematic(a: Project, b: Project): boolean {
  // S1: the sheets and their symbols name nets and join them, and a view is a different part of the schematic.
  if (a.wires !== b.wires || a.labels !== b.labels || a.parts !== b.parts || a.sheetSymbols !== b.sheetSymbols || a.sheets !== b.sheets || a.scope !== b.scope) return false
  // The drawings custom parts are made of (a symbol's pins come from them) and the rule that names the nets.
  if (a.symbols !== b.symbols || a.netNames !== b.netNames) return false
  // S3 and S8: bus aliases and bus lines name and join nets, a rule area's flags and a sheet symbol's flags reach the components through the resolved flags (`resolvedComponents`), and the net auto-names read `notOnBoard` (a dnp or a lock on the PCB is still not a schematic edit). Every other drawing (a note, a box) says nothing about them.
  if (a.busAliases !== b.busAliases || (a.drawings !== b.drawings && !sameConnectivityDrawings(a.drawings, b.drawings, !!a.sheets?.some((x) => x.kicadRules)))) return false
  // S9: the active variant (and what each variant changes) decides which symbols are off the board, which the net auto-names read.
  if (a.variants !== b.variants) return false
  if (a.components === b.components) return true
  if (a.components.length !== b.components.length) return false
  for (let i = 0; i < a.components.length; i++) {
    const x = a.components[i]
    const y = b.components[i]
    if (x === y) continue
    if (x.id !== y.id || x.inst !== y.inst || x.partId !== y.partId || x.ref !== y.ref || x.sch.x !== y.sch.x || x.sch.y !== y.sch.y || x.sch.rot !== y.sch.rot || x.sch.mirror !== y.sch.mirror || x.unit !== y.unit || x.bodyStyle !== y.bodyStyle || !sameProps(x.pinAlt, y.pinAlt) || !sameList(x.nc, y.nc) || !sameProps(x.props, y.props) || !!x.flags?.notOnBoard !== !!y.flags?.notOnBoard || x.variants !== y.variants) return false
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
