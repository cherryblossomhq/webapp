import { computeConnectivity, pinKey } from "../model/connectivity"
import { schematicBounds, schematicPins } from "../model/instances"
import { labelBox } from "../model/labels"
import { findPart } from "../model/library"
import { ROOT_SHEET, isHierarchical, sheetUses, useOf, type SheetUse } from "../model/sheets"
import type { ComponentInstance, NetLabel, Project, SchematicDrawing, Vec2, Wire } from "../model/types"

// S1: a project with sheets as one flat project, for the formats that have no sheets (Circuit JSON, and the board's side of
// the KiCad export). Each use of a sheet is laid out beside the last, a sheet used twice drawn twice, so nothing overlaps;
// sheet symbols are left out, a hierarchical label is a local one. What the hierarchy joined (a sheet pin and the label
// of its name, the nets below a sheet) is joined by a global label of the net's full name on every sheet the net is on, so
// the flat project has the nets, and the names, the hierarchical one has.

/** Room between two sheets laid side by side, in editor units. */
const GAP = 4

export interface FlatProject {
  project: Project
  notes: string[]
}

export function flattenHierarchy(project: Project): FlatProject {
  if (!isHierarchical(project) || project.scope !== undefined) return { project, notes: [] }
  const uses = sheetUses(project)
  const conn = computeConnectivity(project)

  // The box each use of a sheet takes up.
  const boxOf = (use: SheetUse) => {
    let minX = Infinity
    let maxX = -Infinity
    const grow = (x0: number, x1: number) => {
      minX = Math.min(minX, x0)
      maxX = Math.max(maxX, x1)
    }
    for (const c of project.components) if (useOf(c) === use.path) grow(schematicBounds(c).minX, schematicBounds(c).maxX)
    for (const w of project.wires) if ((w.sheet ?? ROOT_SHEET) === use.sheet) for (const p of w.points) grow(p.x, p.x)
    for (const l of project.labels) if ((l.sheet ?? ROOT_SHEET) === use.sheet) grow(labelBox(l).minX, labelBox(l).maxX)
    return minX === Infinity ? { minX: 0, maxX: 0 } : { minX, maxX }
  }
  const shift = new Map<string, number>()
  let cursor = 0
  for (const use of uses) {
    const box = boxOf(use)
    shift.set(use.path, cursor - box.minX)
    cursor += box.maxX - box.minX + GAP
  }
  const dx = (path: string) => shift.get(path) ?? 0

  const components: ComponentInstance[] = project.components.map((c) => {
    const d = dx(useOf(c))
    const { inst: _inst, tpl: _tpl, ...rest } = c
    void _inst
    void _tpl
    return d === 0 ? (rest as ComponentInstance) : ({ ...rest, sch: { ...c.sch, x: c.sch.x + d } } as ComponentInstance)
  })
  const wires: Wire[] = []
  const labels: NetLabel[] = []
  const drawings: SchematicDrawing[] = []
  for (const use of uses) {
    const d = dx(use.path)
    const first = uses.find((u) => u.sheet === use.sheet)!.path === use.path
    const id = (x: string) => (first ? x : `${x}@${use.path}`)
    for (const w of project.wires) if ((w.sheet ?? ROOT_SHEET) === use.sheet) wires.push({ ...stripSheet(w), id: id(w.id), points: w.points.map((p) => ({ x: p.x + d, y: p.y })) })
    for (const l of project.labels) {
      if ((l.sheet ?? ROOT_SHEET) !== use.sheet) continue
      const { sheet: _s, ...rest } = l
      void _s
      // A hierarchical label joins nothing in the flat project (its nets are joined below), so it is a local label.
      labels.push({ ...rest, id: id(l.id), x: l.x + d, ...(l.kind === "hierarchical" ? { kind: "local" as const, shape: undefined } : {}) } as NetLabel)
    }
    for (const dr of project.drawings ?? []) {
      if ((dr.sheet ?? ROOT_SHEET) !== use.sheet) continue
      drawings.push(moveDrawing(dr, d, id(dr.id)))
    }
  }

  // The nets the hierarchy joins: a global label of the net's name on every sheet it is on.
  const compOf = new Map(project.components.map((c) => [c.id, c]))
  for (const net of conn.nets) {
    const spots = new Map<string, Vec2>()
    for (const p of net.pins) {
      const c = compOf.get(p.componentId)
      if (!c) continue
      const path = useOf(c)
      if (spots.has(path)) continue
      const part = findPart(c.partId)
      const pin = schematicPins(c, part).find((x) => x.pin === p.pin && conn.pinNet.get(pinKey(c.id, x.pin)) === net.id)
      if (pin) spots.set(path, { x: pin.pos.x + dx(path), y: pin.pos.y })
    }
    for (const [path, map] of conn.byUse?.wireNet ?? []) {
      if (spots.has(path)) continue
      for (const [wid, nid] of map) {
        if (nid !== net.id) continue
        const w = project.wires.find((x) => x.id === wid)
        if (w?.points[0]) {
          spots.set(path, { x: w.points[0].x + dx(path), y: w.points[0].y })
          break
        }
      }
    }
    const crosses = spots.size > 1 || [...spots.keys()].some((p) => p !== "")
    if (!net.named && spots.size < 2) continue
    if (!crosses || !spots.size) continue
    for (const [path, at] of spots) labels.push({ id: `flat:${net.id}@${path}`, name: net.name, x: at.x, y: at.y, rot: 0, kind: "global", shape: "bidirectional" })
  }

  const { sheets: _sheets, sheetSymbols: _symbols, scope: _scope, ...rest } = project
  void _sheets
  void _symbols
  void _scope
  const flat: Project = { ...rest, components, wires, labels, ...(drawings.length ? { drawings } : {}) }
  if (project.blocks) flat.blocks = project.blocks.map((b) => {
    const { inst: _i, ...r } = b
    void _i
    return r
  })
  return {
    project: flat,
    notes: [`The schematic has ${uses.length} sheets, and Circuit JSON has none: each use of a sheet is laid out beside the last on one page, a sheet used twice is drawn twice, the sheet symbols and their pins are left out, and what the hierarchy joins is joined by a net label of the net's name on each sheet it is on.`],
  }
}

const stripSheet = (w: Wire): Wire => {
  const { sheet: _s, ...rest } = w
  void _s
  return rest as Wire
}

/** A drawing of a sheet moved sideways. */
function moveDrawing(d: SchematicDrawing, dx: number, id: string): SchematicDrawing {
  const { sheet: _s, ...rest } = d
  void _s
  const x = (n: number) => n + dx
  const pt = (p: Vec2) => ({ ...p, x: x(p.x) })
  const out = { ...rest, id } as Record<string, unknown>
  for (const k of ["x"] as const) if (typeof out[k] === "number") out[k] = x(out[k] as number)
  if (Array.isArray(out.points)) out.points = (out.points as Vec2[]).map(pt)
  for (const k of ["start", "mid", "end"] as const) if (out[k] && typeof out[k] === "object") out[k] = pt(out[k] as Vec2)
  if (Array.isArray(out.cells)) out.cells = (out.cells as { x: number }[]).map((c) => ({ ...c, x: x(c.x) }))
  return out as unknown as SchematicDrawing
}
