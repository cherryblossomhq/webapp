import { mountingHoles } from "../model/board"
import { resolvedComponents } from "../model/ruleAreas"
import { isNpth, pcbPads, slotEnds, type WorldPad } from "../model/instances"
import { outlineSlots } from "../model/outlineOps"
import { holeCentre } from "../model/padDistance"
import { copperLayers, drillsThrough, kicadLayerName, viaLayers } from "../model/stack"
import type { CopperLayer, Project, Vec2 } from "../model/types"
import { onBoard } from "../model/partFlags"

export interface DrillHole {
  x: number
  y: number
  diameter: number
  /** End centres of a slotted hole, drilled as a G85 slot. */
  slot?: [Vec2, Vec2]
  /** X5: the layers a hole that is not a through hole runs between (a blind, buried or micro via), front first; absent for a hole through the board. */
  span?: [CopperLayer, CopperLayer]
}

function padHole(pad: WorldPad): DrillHole {
  const slot = slotEnds(pad)
  // The hole is where the pad says it is, which is not the copper's centre for a hole drilled off it (X7).
  const at = holeCentre(pad)
  return { x: at.x, y: at.y, diameter: pad.holeDiameter ?? 0, ...(slot ? { slot } : {}) }
}

/** Plated holes from through-hole pads, vias and mounting holes. Those of a via that is not a through via carry the layers they run between. */
export function drillHoles(project: Project): DrillHole[] {
  const holes: DrillHole[] = []
  for (const c of resolvedComponents(project)) {
    if (!onBoard(c)) continue
    for (const pad of pcbPads(c)) {
      if (pad.holeDiameter !== undefined && !isNpth(pad)) holes.push(padHole(pad))
    }
  }
  for (const v of project.vias) {
    const hole: DrillHole = { x: v.x, y: v.y, diameter: v.drill }
    if (!drillsThrough(project.board, v)) {
      const span = viaLayers(project.board, v)
      hole.span = [span[0], span[span.length - 1]]
    }
    holes.push(hole)
  }
  for (const h of mountingHoles(project.board)) holes.push({ x: h.x, y: h.y, diameter: h.drill })
  return holes
}

/** Non-plated holes from footprints, such as module mounting holes. */
export function npthHoles(project: Project): DrillHole[] {
  const holes: DrillHole[] = []
  for (const c of resolvedComponents(project)) {
    if (!onBoard(c)) continue
    for (const pad of pcbPads(c)) {
      if (pad.holeDiameter !== undefined && isNpth(pad)) holes.push(padHole(pad))
    }
  }
  // A slot cut into the board (a stadium cutout) is routed from the drill file too, as well as drawn on the profile.
  for (const s of outlineSlots(project.board.outline?.paths ?? [])) holes.push({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2, diameter: s.width, slot: [s.a, s.b] })
  return holes
}

const mm = (n: number) => {
  const s = n.toFixed(3)
  return s === "-0.000" ? "0.000" : s
}

/** A KiCad drill file's own name for a layer: `F_Cu`, `In2_Cu`, `B_Cu`. */
const fileLayer = (l: CopperLayer) => kicadLayerName(l).replace(".", "_")

export interface DrillSet {
  /** The end of the file's name: `PTH`, or the two layers (`F_Cu-In1_Cu`). */
  suffix: string
  holes: DrillHole[]
  /** The layers the holes of a via that is not a through via run between. */
  span?: [CopperLayer, CopperLayer]
  /** The file's `TF.FileFunction` text. */
  fileFunction: string
}

/**
 * The sets of plated holes the board has, each drilled in its own file as KiCad's are: the through holes first, then one set for each pair of layers a
 * via runs between (KiCad's `GENDRILL_WRITER_BASE`, gendrill_file_writer_base.cpp 9.0.0 `:274-303` for the names, `:366-440` for the function).
 */
export function drillSets(project: Project): DrillSet[] {
  const all = drillHoles(project)
  const layers = copperLayers(project.board)
  const sets: DrillSet[] = [{ suffix: "PTH", holes: all.filter((h) => !h.span), fileFunction: `Plated,1,${layers.length},PTH` }]
  const pairs = new Map<string, DrillHole[]>()
  for (const h of all) if (h.span) pairs.set(h.span.join(">"), [...(pairs.get(h.span.join(">")) ?? []), h])
  const keyed = [...pairs.values()].map((holes) => ({ span: holes[0].span!, holes })).sort((a, b) => layers.indexOf(a.span[0]) - layers.indexOf(b.span[0]) || layers.indexOf(a.span[1]) - layers.indexOf(b.span[1]))
  for (const { span, holes } of keyed) {
    const a = layers.indexOf(span[0]) + 1
    const b = layers.indexOf(span[1]) + 1
    const kind = a === 1 || b === layers.length ? "Blind" : "Buried"
    sets.push({ suffix: `${fileLayer(span[0])}-${fileLayer(span[1])}`, holes, span, fileFunction: `Plated,${a},${b},${kind}` })
  }
  return sets
}

/** Excellon drill file: the plated holes by default, the non-plated ones with `plated: false`, the holes of the vias between two layers with `span`. */
export function excellonDrill(project: Project, opts: { plated?: boolean; span?: [CopperLayer, CopperLayer] } = {}): string {
  const plated = opts.plated ?? true
  const set = opts.span ? drillSets(project).find((s) => s.span && s.span[0] === opts.span![0] && s.span[1] === opts.span![1]) : undefined
  const holes = set ? set.holes : plated ? drillHoles(project).filter((h) => !h.span) : npthHoles(project)
  const sizes = [...new Set(holes.map((h) => mm(h.diameter)))].sort((a, b) => Number(a) - Number(b))
  const tool = new Map(sizes.map((s, i) => [s, i + 1]))
  const count = copperLayers(project.board).length
  const lines = [
    "M48",
    set ? `; Cherry Blossom plated drill file, holes between ${kicadLayerName(set.span![0])} and ${kicadLayerName(set.span![1])}` : plated ? "; Cherry Blossom plated drill file" : "; Cherry Blossom non-plated drill file",
    set ? `; #@! TF.FileFunction,${set.fileFunction}` : plated ? `; #@! TF.FileFunction,Plated,1,${count},PTH` : `; #@! TF.FileFunction,NonPlated,1,${count},NPTH`,
    "; FORMAT={-:-/ absolute / metric / decimal}",
    "FMAT,2",
    "METRIC",
  ]
  for (const [size, t] of tool) lines.push(`T${t}C${size}`)
  lines.push("%", "G90", "G05")
  for (const [size, t] of tool) {
    lines.push(`T${t}`)
    for (const h of holes) {
      if (mm(h.diameter) !== size) continue
      const [a, b] = h.slot ?? []
      lines.push(a && b ? `X${mm(a.x)}Y${mm(a.y)}G85X${mm(b.x)}Y${mm(b.y)}` : `X${mm(h.x)}Y${mm(h.y)}`)
    }
  }
  lines.push("T0", "M30")
  return lines.join("\n") + "\n"
}
