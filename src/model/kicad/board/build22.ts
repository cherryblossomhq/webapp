import { round } from "../../../lib/geometry"
import { flipLayer } from "../../stack"
import type { Backdrill, CopperLayer, GenValue, NetChain, PcbGenerator, PostMachining, Via } from "../../types"
import type { LayerMap } from "./layers"
import type { KicadBackdrill, KicadBoard, KicadGenerator, KicadGenValue, KicadPostMachining, KicadVia } from "./types"

// X21 and X22 from the reader's typed board into the project: a via's protection and drills, the generators as groups, the net chains.

const r6 = (n: number) => round(n, 6)

/** A post-machining as the project holds it: sizes to the nanometre, a zero as nothing (the writer leaves it out and the machine has none). */
export function postMachining(p: KicadPostMachining): PostMachining {
  return { mode: p.mode, ...(p.size ? { size: r6(p.size) } : {}), ...(p.depth ? { depth: r6(p.depth) } : {}), ...(p.angle ? { angle: round(p.angle, 1) } : {}) }
}

/** A backdrill on the board's layers; null when a layer is not one of the board's copper layers, which KiCad ignores too. */
export function backdrill(b: KicadBackdrill, layers: LayerMap, own: (l: CopperLayer) => CopperLayer = (l) => l): Backdrill | null {
  const from = layers.of(b.start)
  const to = layers.of(b.end)
  return from && to ? { size: r6(b.size), from: own(from), to: own(to) } : null
}

/** The X22 fields of a via: its own protection, its two drills and its post-machining. */
export function viaDrilling(v: KicadVia, layers: LayerMap, note: (what: string) => void): Pick<Via, "protect" | "backdrill" | "tertiary" | "post"> {
  const out: Pick<Via, "protect" | "backdrill" | "tertiary" | "post"> = {}
  if (v.protect) {
    const p = v.protect
    out.protect = { ...(p.cap !== undefined ? { cap: p.cap } : {}), ...(p.fill !== undefined ? { fill: p.fill } : {}), ...(p.cover ? { cover: { ...p.cover } } : {}), ...(p.plug ? { plug: { ...p.plug } } : {}) }
  }
  for (const [from, key] of [[v.backdrill, "backdrill"], [v.tertiary, "tertiary"]] as const) {
    if (!from) continue
    const made = backdrill(from, layers)
    if (made) out[key] = made
    else note(`a ${key === "backdrill" ? "backdrill" : "tertiary drill"} of a via, between ${from.start} and ${from.end}, which are not both copper layers of the board (KiCad ignores it too)`)
  }
  if (v.post) out.post = { ...(v.post.front ? { front: postMachining(v.post.front) } : {}), ...(v.post.back ? { back: postMachining(v.post.back) } : {}) }
  return out
}

function genValue(v: KicadGenValue): GenValue {
  if (typeof v === "object") {
    if ("xy" in v) return { xy: [r6(v.xy[0]), r6(-v.xy[1])] }
    if ("pts" in v) return { pts: v.pts.map(([x, y]): [number, number] => [r6(x), r6(-y)]) }
    return { cells: v.cells.map(([i, j]): [number, number] => [i, j]) }
  }
  return v
}

/**
 * A generated item as the project's: its kind, layer and properties (points in the project's frame), and the templates it lays out. Null for one that cannot be
 * held, with why: a layer the board does not have, or a property KiCad reads and the model cannot hold.
 */
export function convertGenerator(g: KicadGenerator, layers: LayerMap, convertVia: (v: KicadVia) => Via): { gen: PcbGenerator } | { why: string } {
  const layer = layers.of(g.layer)
  if (!layer) return { why: `${g.kind || "a generated item"} on ${g.layer}, which is not a copper layer of the board` }
  if (g.unreadable?.length) return { why: `${g.kind || "a generated item"} whose ${g.unreadable.join(", ")} has a value this importer cannot hold (an arc among the points)` }
  const props: Record<string, GenValue> = {}
  for (const [k, v] of g.props) props[k] = genValue(v)
  const templates = g.templates.map((t) => {
    const { id: _id, ...via } = convertVia(t.via)
    return { name: t.name, via }
  })
  return { gen: { kind: g.kind, layer, props, ...(templates.length ? { templates } : {}) } }
}

/**
 * KiCad's net chains by the project's net names. A net the board does not have is left out of its chain (KiCad does the same, `FindNet`); a terminal is a pad of a part, by the part and the pad's
 * place in its land, as `terminal` finds it from the file's id.
 */
export function convertNetChains(board: KicadBoard, labelOf: (raw: string) => string, terminal: (uuid: string) => { component: string; pad: number } | undefined): NetChain[] {
  const byName = new Map(board.nets.map((n) => [n.raw, n]))
  const out: NetChain[] = []
  for (const c of board.netChains) {
    const nets: string[] = []
    for (const member of c.nets) {
      // A name first; a number is a net code of a file older than KiCad 11's (the net table lists codes until 20251028).
      const hit = byName.get(member) ?? board.nets.find((n) => n.code !== null && String(n.code) === member)
      const label = hit ? labelOf(hit.raw) : undefined
      if (label !== undefined && !nets.includes(label)) nets.push(label)
    }
    const terminals = c.terminals.flatMap((u) => {
      const t = terminal(u)
      return t ? [t] : []
    })
    if (nets.length || terminals.length || c.name) out.push({ name: c.name, nets, ...(terminals.length ? { terminals } : {}) })
  }
  return out
}

/** The same layer seen from the part's own side (a part on the bottom has its layers turned over). */
export const ownLayer = (bottom: boolean, count: number) => (l: CopperLayer): CopperLayer => (bottom ? flipLayer(l, count) : l)
