import { drillLayerName, viaProtection } from "../model/machining"
import { copperLayers, viaDiameterOn, viaLayers, drillsThrough } from "../model/stack"
import type { CopperLayer, Project, Via } from "../model/types"
import { GerberWriter } from "./gerber"

// X22: via protection (IPC-4761) as KiCad's Gerber drill writer files it (`GERBER_WRITER::CreateDrillandMapFilesSet` and `createProtectionFile`, gendrill_gerber_writer.cpp of the 10.0
// line, `:67-205` and `:208-345`): for each plated span, one file of the holes that are filled and one of those that are capped (a flash of the hole's diameter), then, over every via, one file each for
// the covering and the plugging of the front and of the back (the covering a flash of the via's pad on that side, the plugging of the hole), each file a Gerber X2 file whose function is `Other,<Feature>`. A board
// whose vias have none of it has no such file. KiCad writes them with its Gerber drill format and not with Excellon; the fabrication files here are Excellon, so they come alongside.

export interface ProtectionFile {
  /** The end of the file's name, after the project's: `-filling-front-back`. */
  suffix: string
  content: string
}

interface Span {
  layers: [CopperLayer, CopperLayer]
  vias: Via[]
}

/** The plated spans the board's vias drill: the through holes first, then each pair of layers a via runs between, in stack order (KiCad's `EnumerateDrillSpans`). */
function spans(project: Project): Span[] {
  const all = copperLayers(project.board)
  const by = new Map<string, Span>()
  const through: Span = { layers: [all[0], all[all.length - 1]], vias: [] }
  for (const v of project.vias) {
    if (drillsThrough(project.board, v)) {
      through.vias.push(v)
      continue
    }
    const l = viaLayers(project.board, v)
    const key = `${l[0]}>${l[l.length - 1]}`
    const span = by.get(key) ?? { layers: [l[0], l[l.length - 1]] as [CopperLayer, CopperLayer], vias: [] }
    span.vias.push(v)
    by.set(key, span)
  }
  const at = (l: CopperLayer) => all.indexOf(l)
  return [through, ...[...by.values()].sort((a, b) => at(a.layers[0]) - at(b.layers[0]) || at(a.layers[1]) - at(b.layers[1]))]
}

/** A file of flashes: one for each via that has the feature, of the diameter `size` gives. */
function flashFile(vias: Via[], fileFunction: string, size: (v: Via) => number): string {
  const w = new GerberWriter()
  for (const v of vias) w.flashCircle({ x: v.x, y: v.y }, size(v))
  return w.toString(fileFunction)
}

/** The protection files of a board, in KiCad's order; empty for a board whose vias have no protection. */
export function viaProtectionFiles(project: Project): ProtectionFile[] {
  if (!project.vias.length) return []
  const rules = project.rules
  const state = new Map(project.vias.map((v) => [v, viaProtection(rules, v, project.board)]))
  const out: ProtectionFile[] = []
  for (const span of spans(project)) {
    const pair = `${drillLayerName(span.layers[0])}-${drillLayerName(span.layers[1])}`
    for (const [feature, word, pick] of [["Filling", "filling", (v: Via) => state.get(v)!.fill], ["Capping", "capping", (v: Via) => state.get(v)!.cap]] as const) {
      const vias = span.vias.filter(pick)
      if (vias.length) out.push({ suffix: `-${word}-${pair}`, content: flashFile(vias, `Other,${feature}`, (v) => v.drill) })
    }
  }
  const all = project.vias
  const sides = [
    ["Covering-Back", "covering-back", (v: Via) => state.get(v)!.coverBack, (v: Via) => viaDiameterOn(v, viaLayers(project.board, v).at(-1)!)],
    ["Covering-Front", "covering-front", (v: Via) => state.get(v)!.coverFront, (v: Via) => viaDiameterOn(v, viaLayers(project.board, v)[0])],
    ["Plugging-Back", "plugging-back", (v: Via) => state.get(v)!.plugBack, (v: Via) => v.drill],
    ["Plugging-Front", "plugging-front", (v: Via) => state.get(v)!.plugFront, (v: Via) => v.drill],
  ] as const
  for (const [feature, word, pick, size] of sides) {
    const vias = all.filter(pick)
    if (vias.length) out.push({ suffix: `-${word}`, content: flashFile(vias, `Other,${feature}`, size) })
  }
  return out
}
