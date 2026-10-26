import { mountingHoles } from "../model/board"
import { isNpth, isPhysical, pcbPads, slotEnds, type WorldPad } from "../model/instances"
import { findPart } from "../model/library"
import type { Project, Vec2 } from "../model/types"

export interface DrillHole {
  x: number
  y: number
  diameter: number
  /** End centres of a slotted hole, drilled as a G85 slot. */
  slot?: [Vec2, Vec2]
}

function padHole(pad: WorldPad): DrillHole {
  const slot = slotEnds(pad)
  return { x: pad.x, y: pad.y, diameter: pad.holeDiameter ?? 0, ...(slot ? { slot } : {}) }
}

/** Plated holes from through-hole pads, vias and mounting holes. */
export function drillHoles(project: Project): DrillHole[] {
  const holes: DrillHole[] = []
  for (const c of project.components) {
    if (!isPhysical(findPart(c.partId))) continue
    for (const pad of pcbPads(c)) {
      if (pad.holeDiameter !== undefined && !isNpth(pad)) holes.push(padHole(pad))
    }
  }
  for (const v of project.vias) holes.push({ x: v.x, y: v.y, diameter: v.drill })
  for (const h of mountingHoles(project.board)) holes.push({ x: h.x, y: h.y, diameter: h.drill })
  return holes
}

/** Non-plated holes from footprints, such as module mounting holes. */
export function npthHoles(project: Project): DrillHole[] {
  const holes: DrillHole[] = []
  for (const c of project.components) {
    if (!isPhysical(findPart(c.partId))) continue
    for (const pad of pcbPads(c)) {
      if (pad.holeDiameter !== undefined && isNpth(pad)) holes.push(padHole(pad))
    }
  }
  return holes
}

const mm = (n: number) => {
  const s = n.toFixed(3)
  return s === "-0.000" ? "0.000" : s
}

/** Excellon drill file: the plated holes by default, the non-plated ones with `plated: false`. */
export function excellonDrill(project: Project, opts: { plated?: boolean } = {}): string {
  const plated = opts.plated ?? true
  const holes = plated ? drillHoles(project) : npthHoles(project)
  const sizes = [...new Set(holes.map((h) => mm(h.diameter)))].sort((a, b) => Number(a) - Number(b))
  const tool = new Map(sizes.map((s, i) => [s, i + 1]))
  const lines = [
    "M48",
    plated ? "; Cherry Blossom plated drill file" : "; Cherry Blossom non-plated drill file",
    plated ? "; #@! TF.FileFunction,Plated,1,2,PTH" : "; #@! TF.FileFunction,NonPlated,1,2,NPTH",
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
