import { mountingHoles } from "../model/board"
import { resolvedComponents } from "../model/ruleAreas"
import { isNpth, pcbPads, slotEnds, type WorldPad } from "../model/instances"
import { outlineSlots } from "../model/outlineOps"
import { holeCentre } from "../model/padDistance"
import { copperLayers, drillsThrough, kicadLayerName, viaLayers } from "../model/stack"
import { drillLayerName, fileIndex, postMachiningComment, spanOf, viaBackdrills, type ViaBackdrill } from "../model/machining"
import type { CopperLayer, PostMachining, Project, Vec2 } from "../model/types"
import { onBoard } from "../model/partFlags"

export interface DrillHole {
  x: number
  y: number
  diameter: number
  /** End centres of a slotted hole, drilled as a G85 slot. */
  slot?: [Vec2, Vec2]
  /** X5: the layers a hole that is not a through hole runs between (a blind, buried or micro via), front first; absent for a hole through the board. */
  span?: [CopperLayer, CopperLayer]
  /** X22: the counterbore or countersink a via has at the board's front and back, which KiCad notes in the drill file beside the hole (a pad's is not in KiCad's drill files). */
  post?: { front?: PostMachining; back?: PostMachining }
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
    const hole: DrillHole = { x: v.x, y: v.y, diameter: v.drill, ...(v.post ? { post: v.post } : {}) }
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
  for (const [size, t] of tool) {
    lines.push(`T${t}C${size}`)
    // X22, as KiCad's Excellon writer does (`createDrillFile`): a tool that drills a hole with a post-machining says so, and each such hole says what it is before its coordinates.
    if (holes.some((h) => h.post && mm(h.diameter) === size)) lines.push("; Post-machining")
  }
  lines.push("%", "G90", "G05")
  for (const [size, t] of tool) {
    lines.push(`T${t}`)
    for (const h of holes) {
      if (mm(h.diameter) !== size) continue
      const [a, b] = h.slot ?? []
      if (h.post?.front) lines.push(`; ${postMachiningComment("front", h.post.front)}`)
      if (h.post?.back) lines.push(`; ${postMachiningComment("back", h.post.back)}`)
      lines.push(a && b ? `X${mm(a.x)}Y${mm(a.y)}G85X${mm(b.x)}Y${mm(b.y)}` : `X${mm(h.x)}Y${mm(h.y)}`)
    }
  }
  lines.push("T0", "M30")
  return lines.join("\n") + "\n"
}

// ---------- backdrills (X22) ----------

/** One backdrill file KiCad writes: the span its bit runs between, as the via lists it (start, end), and the holes. */
export interface BackdrillSet {
  /** The drill's own start and end. */
  start: CopperLayer
  end: CopperLayer
  /** The span in stack order, front first (KiCad's `DRILL_SPAN::Pair`). */
  pair: [CopperLayer, CopperLayer]
  holes: ViaBackdrill[]
}

/**
 * The backdrill files the board has, in KiCad's order (`EnumerateDrillSpans`, drill_enumerator.cpp `:337`: by the span's top layer, bottom layer and then the layers as they are listed). The holes of a span are
 * the vias that drill between those two layers, secondary and tertiary alike. A pad's backdrill is not in KiCad's drill files (`m_PadMachining` is off for them), so it is in the fabrication notes only.
 */
export function backdrillSets(project: Project): BackdrillSet[] {
  const all = copperLayers(project.board)
  const by = new Map<string, BackdrillSet>()
  for (const h of viaBackdrills(project)) {
    const key = `${h.from}>${h.to}`
    const set = by.get(key) ?? { start: h.from, end: h.to, pair: spanOf(project.board, h), holes: [] }
    set.holes.push(h)
    by.set(key, set)
  }
  const at = (l: CopperLayer) => all.indexOf(l)
  return [...by.values()].sort((a, b) => at(a.pair[0]) - at(b.pair[0]) || at(a.pair[1]) - at(b.pair[1]) || at(a.start) - at(b.start) || at(a.end) - at(b.end))
}

/** KiCad's name for the first backdrill file of a span: `_Backdrills_Drill_1_4` (`getDrillFileName`, gendrill_writer_base.cpp `:216`). */
export const backdrillFileSuffix = (project: Project, set: BackdrillSet) => `_Backdrills_Drill_${fileIndex(project.board, set.start)}_${fileIndex(project.board, set.end)}`

/** And of the second, which tags every hit with `; backdrill`: `-front-in3-backdrill` (`getBackdrillLayerPairFileName`, gendrill_excellon_writer.cpp `:654`). */
export const backdrillPairSuffix = (set: BackdrillSet) => `-${drillLayerName(set.pair[0])}-${drillLayerName(set.pair[1])}-backdrill`

/** The stub as KiCad's comment says it: `0.320mm (0.0126")`. */
const stubText = (v: number) => `${v.toFixed(3)}mm (${(v / 25.4).toFixed(4)}")`

/**
 * One backdrill file, as KiCad's Excellon writer makes it (`createDrillFile` with `NPTH_FILE`): non-plated holes, the file function `NonPlated,a,b,Blind` for the span's layer numbers, a tool for each
 * bit size with the comment `; Backdrill stub ...` (the least and the greatest stub of its holes) and `, post-machining` (KiCad says that of every backdrill tool), and holes sorted by size, then x, then y as the file
 * has them (KiCad's y runs down, the editor's up). `tag` is the second file, which says `; backdrill` before every hit.
 */
export function excellonBackdrill(project: Project, set: BackdrillSet, tag = false): string {
  const all = copperLayers(project.board)
  const sorted = [...set.holes].sort((a, b) => a.size - b.size || a.x - b.x || b.y - a.y)
  const sizes = [...new Set(sorted.map((h) => mm(h.size)))].sort((a, b) => Number(a) - Number(b))
  const tool = new Map(sizes.map((s, i) => [s, i + 1]))
  const a = all.indexOf(set.pair[0]) + 1
  const b = all.indexOf(set.pair[1]) + 1
  const lines = [
    "M48",
    `; Cherry Blossom backdrill file, holes drilled from ${kicadLayerName(set.start)} to ${kicadLayerName(set.end)}`,
    `; #@! TF.FileFunction,NonPlated,${a},${b},Blind`,
    "; FORMAT={-:-/ absolute / metric / decimal}",
    "FMAT,2",
    "METRIC",
  ]
  for (const [size, t] of tool) {
    const stubs = sorted.filter((h) => mm(h.size) === size).map((h) => h.stub)
    const least = Math.min(...stubs)
    const most = Math.max(...stubs)
    lines.push("; #@! TA.AperFunction,NonPlated,BackDrill", `T${t}C${size}`, `; Backdrill stub ${stubText(least)}${mm(most) !== mm(least) ? ` to ${stubText(most)}` : ""}, post-machining`)
  }
  lines.push("%", "G90", "G05")
  for (const [size, t] of tool) {
    lines.push(`T${t}`)
    for (const h of sorted) {
      if (mm(h.size) !== size) continue
      if (tag) lines.push("; backdrill")
      lines.push(`X${mm(h.x)}Y${mm(h.y)}`)
    }
  }
  lines.push("T0", "M30")
  return lines.join("\n") + "\n"
}
