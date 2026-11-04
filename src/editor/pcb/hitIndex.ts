import { CellGrid } from "../../lib/cellGrid"
import { emptyBox, expandBox, type Box } from "../../lib/geometry"
import { arcOf, isArcTrace } from "../../model/arcTracks"
import { pcbCourtyard } from "../../model/instances"
import type { CopperItem, PcbAnalysis } from "../../model/pcb"
import { resolvedComponents } from "../../model/ruleAreas"
import type { ComponentInstance, Project, Trace, Via, Vec2 } from "../../model/types"

// What the pointer is over, found among what is near it: the PCB view asks on every move of the pointer, and going through each of a board's
// pads, vias, track pieces and parts took tens of milliseconds a move on CERN's Macbeth (10,000 pads, 5,215 vias, 5,798 tracks, 1,566 parts).

type PadItem = Extract<CopperItem, { kind: "pad" }>

interface HitIndex {
  /** The pad items, in the order of the analysis's items. */
  pads: PadItem[]
  padGrid: CellGrid
  /** By index in `project.vias`. */
  viaGrid: CellGrid
  /** By index in `project.traces`, one entry for each piece of a track. */
  traceGrid: CellGrid
  /** The parts that are placed, in the order of `resolvedComponents`, with their courtyards. */
  parts: { c: ComponentInstance; courtyard: Box }[]
  partGrid: CellGrid
}

/** The box of points, `pad` round them. */
const boxOf = (points: readonly Vec2[], pad: number): Box => points.reduce((b, q) => expandBox(b, q, pad), emptyBox())

const indexes = new WeakMap<CopperItem[], WeakMap<Project, HitIndex>>()

/** The index of a project's copper and parts for picking, made once for each project and analysis. */
export function hitIndex(p: Project, items: CopperItem[]): HitIndex {
  let byProject = indexes.get(items)
  if (!byProject) indexes.set(items, (byProject = new WeakMap()))
  let index = byProject.get(p)
  if (index) return index
  const pads = items.filter((i): i is PadItem => i.kind === "pad")
  const padGrid = new CellGrid()
  pads.forEach((it, i) => padGrid.add(i, it.box))
  const viaGrid = new CellGrid()
  p.vias.forEach((v, i) => viaGrid.add(i, boxOf([v], v.diameter / 2)))
  const traceGrid = new CellGrid()
  p.traces.forEach((t, i) => {
    if (isArcTrace(t)) {
      // An arc track lies within its circle's box, its width round it.
      const c = arcOf(t.points).circle
      traceGrid.add(i, c && Number.isFinite(c.r) ? boxOf([c.c], c.r + t.width / 2) : boxOf(t.points, t.width / 2))
      return
    }
    for (let s = 0; s < t.points.length - 1; s++) traceGrid.add(i, boxOf([t.points[s], t.points[s + 1]], t.width / 2))
  })
  const parts: HitIndex["parts"] = []
  const partGrid = new CellGrid()
  for (const c of resolvedComponents(p)) {
    if (!c.pcb.placed) continue
    const courtyard = pcbCourtyard(c)
    if (!courtyard) continue
    partGrid.add(parts.length, courtyard)
    parts.push({ c, courtyard })
  }
  index = { pads, padGrid, viaGrid, traceGrid, parts, partGrid }
  byProject.set(p, index)
  return index
}

/** A net's tracks, pads and vias. */
interface NetCopper {
  traces: Trace[]
  pads: PadItem[]
  vias: Via[]
}

const byNets = new WeakMap<PcbAnalysis, { project: Project; nets: Map<string, NetCopper> }>()

/** Each net's copper, found once for each analysis: lighting the net under the pointer went through the whole board for each net it passed over. */
export function netCopper(p: Project, pcb: PcbAnalysis, net: string): NetCopper | undefined {
  let kept = byNets.get(pcb)
  if (!kept || kept.project !== p) {
    const nets = new Map<string, NetCopper>()
    const of = (id: string | null | undefined) => {
      if (!id) return null
      let n = nets.get(id)
      if (!n) nets.set(id, (n = { traces: [], pads: [], vias: [] }))
      return n
    }
    for (const t of p.traces) of(pcb.traceNet.get(t.id))?.traces.push(t)
    for (const it of pcb.items) if (it.kind === "pad") of(it.netId)?.pads.push(it)
    for (const v of p.vias) of(pcb.viaNet.get(v.id))?.vias.push(v)
    byNets.set(pcb, (kept = { project: p, nets }))
  }
  return kept.nets.get(net)
}
