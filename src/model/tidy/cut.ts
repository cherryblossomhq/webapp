import { pointOnSegment, round } from "../../lib/geometry"
import { drawnIslands } from "../blocks"
import { pinKey } from "../connectivity"
import { schematicPins } from "../instances"
import type { Project, Vec2, Wire } from "../types"
import type { NetInfo } from "./nets"
import { DIRS, type Dir } from "./shapes"

// One block tidied where it is: what of the drawing around it goes. Only the wire from each of the
// block's pins as far as the first junction, the first pin of another part, or the first label or
// port goes, and then whatever is left of that drawing that reaches no part outside the block (the
// block's own labels and ports, which it draws anew). Everything else stays as the user drew it.
// Where a cut leaves wire to another part behind, a label (a port, on a supply) goes on it, unless
// it has a name already; a pin of another part left with nothing gets its own.
//
// Wire from a pin to nowhere (a stub, or a branch off a labelled pin's wire that ends in nothing)
// is neither cut nor redrawn: it stays as drawn, and Tidy says so. So does wire that leads to no
// pin at all, a part having been dragged off it, with any label or port on it: that drawing is no
// longer the block's, so it is kept and counted, not taken. The whole-sheet tidy keeps the same
// wire, below the blocks (`deadRuns`).

export interface Cut {
  wires: Set<string>
  labels: Set<string>
  comps: Set<string>
  /** What is left of wires that lost a piece, as new wires. */
  pieces: Vec2[][]
  /** Pins of parts outside the block left with nothing: each gets a label or port of its own. */
  outside: { componentId: string; pin: string; net: string }[]
  /**
   * Points on wires left behind where a cut was made, by the piece they are on: the piece's name
   * goes on each one that is a wire's end (`end`), so no wire is left hanging; on a piece with no
   * end cut, on the first of its points that has room. Each runs `free`.
   */
  taps: { at: Vec2; net: string; free: Dir[]; end: boolean; piece: number }[]
}

const key = (p: Vec2) => `${round(p.x)},${round(p.y)}`
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

interface Edge {
  id: number
  wire: string
  a: string
  b: string
  pa: Vec2
  pb: Vec2
}

/** Wires as a graph: split at every point where a wire, pin or label stands, so each meeting is a node. */
interface Graph {
  edges: Edge[]
  at: Map<string, number[]>
  points: Map<string, Vec2>
  /** Edges of wire that lead to no pin, label or port: a stub's, a branch to nowhere's. */
  dead: Set<number>
}

function wireGraph(wires: Wire[], points: Map<string, Vec2>, terminal: (k: string) => boolean): Graph {
  const edges: Edge[] = []
  const at = new Map<string, number[]>()
  for (const w of wires) for (const p of w.points) points.set(key(p), p)
  const all = [...points.values()]
  for (const w of wires) {
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1]
      const b = w.points[i]
      const on = all.filter((p) => pointOnSegment(p, a, b))
      on.sort((p, q) => Math.abs(p.x - a.x) + Math.abs(p.y - a.y) - (Math.abs(q.x - a.x) + Math.abs(q.y - a.y)))
      for (let j = 1; j < on.length; j++) {
        if (key(on[j - 1]) === key(on[j])) continue
        const e: Edge = { id: edges.length, wire: w.id, a: key(on[j - 1]), b: key(on[j]), pa: on[j - 1], pb: on[j] }
        edges.push(e)
        at.set(e.a, [...(at.get(e.a) ?? []), e.id])
        at.set(e.b, [...(at.get(e.b) ?? []), e.id])
      }
    }
  }
  // Wire ends at nothing are pruned back to where something stands or wires meet.
  const dead = new Set<number>()
  const degree = new Map([...at].map(([k, ids]) => [k, ids.length]))
  const leaves = [...at.keys()].filter((k) => degree.get(k) === 1 && !terminal(k)).sort(byKey)
  while (leaves.length) {
    const k = leaves.pop()!
    const e = (at.get(k) ?? []).find((id) => !dead.has(id))
    if (e === undefined) continue
    dead.add(e)
    const m = edges[e].a === k ? edges[e].b : edges[e].a
    degree.set(k, 0)
    const d = degree.get(m)! - 1
    degree.set(m, d)
    if (d === 1 && !terminal(m)) leaves.push(m)
  }
  // An island with one thing on it is all stub, rings of wire included.
  const terminals = [...at.keys()].filter(terminal)
  if (terminals.length <= 1) for (const e of edges) dead.add(e.id)
  return { edges, at, points, dead }
}

/**
 * The wire of an island that leads to no pin, label or port, for the whole-sheet tidy to keep:
 * wires wholly on it by id, and the runs of wires partly on it as new pieces, in connected sets.
 */
export function deadRuns(project: Project, wireIds: string[], labelIds: string[], compIds: string[]): { wires: string[]; pieces: Vec2[][] }[] {
  const ids = new Set(wireIds)
  const wires = project.wires.filter((w) => ids.has(w.id))
  const points = new Map<string, Vec2>()
  const stands = new Set<string>()
  const byId = new Map(project.components.map((c) => [c.id, c]))
  for (const id of compIds) {
    const c = byId.get(id)
    for (const pin of c ? schematicPins(c) : []) {
      stands.add(key(pin.pos))
      points.set(key(pin.pos), pin.pos)
    }
  }
  const labels = new Set(labelIds)
  for (const l of project.labels) {
    if (!labels.has(l.id)) continue
    stands.add(key(l))
    points.set(key(l), l)
  }
  const g = wireGraph(wires, points, (k) => stands.has(k))
  if (!g.dead.size) return []
  // Connected sets of dead edges.
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    const p = parent.get(x) ?? x
    if (p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  for (const ids of g.at.values()) {
    const d = ids.filter((id) => g.dead.has(id))
    for (const id of d.slice(1)) parent.set(find(id), find(d[0]))
  }
  const sets = new Map<number, { wires: string[]; pieces: Vec2[][] }>()
  const setOf = (e: number) => {
    const r = find(e)
    let s = sets.get(r)
    if (!s) sets.set(r, (s = { wires: [], pieces: [] }))
    return s
  }
  for (const w of wires) {
    const mine = g.edges.filter((e) => e.wire === w.id)
    if (mine.every((e) => g.dead.has(e.id))) {
      setOf(mine[0].id).wires.push(w.id)
      continue
    }
    for (const run of runs(mine, (e) => g.dead.has(e.id))) setOf(run.first).pieces.push(run.points)
  }
  return [...sets.values()]
}

/** Runs of a wire's edges, in order, that `keep` keeps, as points. */
function runs(mine: Edge[], keep: (e: Edge) => boolean): { first: number; points: Vec2[] }[] {
  const out: { first: number; points: Vec2[] }[] = []
  let run: Vec2[] = []
  let first = -1
  const flush = () => {
    if (run.length > 1) out.push({ first, points: simplify(run) })
    run = []
  }
  for (const e of mine) {
    if (!keep(e)) {
      flush()
      continue
    }
    if (!run.length) {
      run.push(e.pa)
      first = e.id
    }
    run.push(e.pb)
  }
  flush()
  return out
}

/** What of the drawing around the block `inside` goes when it is tidied on its own, and what is added. */
export function cutAtBlock(project: Project, inside: Set<string>, info: NetInfo, arranged: (id: string) => boolean): Cut {
  const out: Cut = { wires: new Set(), labels: new Set(), comps: new Set(), pieces: [], outside: [], taps: [] }
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const islands = drawnIslands(project)
  const wireIds = new Set<string>()
  const labelIds = new Set<string>()
  const compIds = new Set<string>()
  for (const [root, comps] of islands.components) {
    if (![...comps].some((id) => inside.has(id))) continue
    for (const id of islands.wires.get(root) ?? []) wireIds.add(id)
    for (const id of islands.labels.get(root) ?? []) labelIds.add(id)
    for (const id of comps) compIds.add(id)
  }
  const wires = project.wires.filter((w) => wireIds.has(w.id))
  const labels = project.labels.filter((l) => labelIds.has(l.id))

  // What stands at each point: pins inside and outside the block, ports, labels.
  const insideAt = new Map<string, { componentId: string; pin: string }[]>()
  const outsideAt = new Map<string, { componentId: string; pin: string }[]>()
  const portsAt = new Map<string, string[]>()
  const labelsAt = new Map<string, string[]>()
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v])
  const points = new Map<string, Vec2>()
  for (const id of [...compIds].sort()) {
    const c = byId.get(id)
    if (!c) continue
    for (const pin of schematicPins(c)) {
      const k = key(pin.pos)
      points.set(k, pin.pos)
      if (inside.has(id)) push(insideAt, k, { componentId: id, pin: pin.pin })
      else if (arranged(id)) push(outsideAt, k, { componentId: id, pin: pin.pin })
      else push(portsAt, k, id)
    }
  }
  for (const l of labels) {
    points.set(key(l), l)
    push(labelsAt, key(l), l.id)
  }
  const stops = (k: string) => (outsideAt.get(k)?.length ?? 0) + (portsAt.get(k)?.length ?? 0) + (labelsAt.get(k)?.length ?? 0) > 0
  const { edges, at, dead } = wireGraph(wires, points, (k) => insideAt.has(k) || stops(k))

  // Only wire that leads somewhere is cut; how many such wires meet at each point, as drawn.
  const live = (k: string) => (at.get(k) ?? []).filter((e) => !dead.has(e))
  const gone = new Set<number>()
  const cuts = new Map<string, string>()

  // From each pin of the block along its wire, to the first junction or anything else there. The
  // way is read from the drawing as it was, so the order the pins come in changes nothing.
  for (const start of [...insideAt.keys()].sort(byKey)) {
    const pins = insideAt.get(start)!
    const net = info.pinNet.get(pinKey(pins[0].componentId, pins[0].pin))
    if (!net) continue
    if (stops(start) || live(start).length !== 1) {
      if (live(start).length || stops(start)) cuts.set(start, net)
      continue
    }
    let k = start
    let e = live(k)[0]
    while (!gone.has(e)) {
      gone.add(e)
      k = edges[e].a === k ? edges[e].b : edges[e].a
      if (insideAt.has(k)) break
      const next = live(k).filter((id) => id !== e)
      if (stops(k) || next.length !== 1) {
        cuts.set(k, net)
        break
      }
      e = next[0]
    }
  }

  // What is left at the cuts, in pieces that hang together: a piece that reaches a pin outside the
  // block stays, labelled where it was cut unless it has a name; a piece that reaches none was the
  // block's own drawing, and goes with its labels and ports.
  const rest = (k: string) => live(k).filter((e) => !gone.has(e))
  const done = new Set<string>()
  let pieceNo = 0
  for (const k of [...cuts.keys()].sort(byKey)) {
    if (done.has(k)) continue
    const nodes = new Set([k])
    const piece = new Set<number>()
    for (const stack = [k]; stack.length; ) {
      const n = stack.pop()!
      for (const id of rest(n)) {
        piece.add(id)
        const m = edges[id].a === n ? edges[id].b : edges[id].a
        if (!nodes.has(m)) {
          nodes.add(m)
          stack.push(m)
        }
      }
    }
    for (const n of nodes) done.add(n)
    const sorted = [...nodes].sort(byKey)
    const outsidePins = sorted.flatMap((n) => outsideAt.get(n) ?? [])
    const named = sorted.some((n) => (portsAt.get(n)?.length ?? 0) + (labelsAt.get(n)?.length ?? 0) > 0)
    if (!outsidePins.length) {
      for (const id of piece) gone.add(id)
      for (const n of sorted) {
        for (const id of portsAt.get(n) ?? []) out.comps.add(id)
        for (const id of labelsAt.get(n) ?? []) out.labels.add(id)
      }
      continue
    }
    if (named) continue
    if (!piece.size) {
      // Nothing but the pin of another part where the cut was: it gets its own label or port.
      out.outside.push({ ...outsidePins[0], net: cuts.get(k)! })
      continue
    }
    pieceNo++
    for (const c of sorted.filter((n) => cuts.has(n) && rest(n).length)) {
      const p = points.get(c)!
      const used = new Set<Dir>()
      for (const id of rest(c)) {
        const e = edges[id]
        const q = e.a === c ? e.pb : e.pa
        used.add(q.x > p.x ? "right" : q.x < p.x ? "left" : q.y > p.y ? "up" : "down")
      }
      out.taps.push({ at: p, net: cuts.get(c)!, free: DIRS.filter((d) => !used.has(d)), end: rest(c).length === 1, piece: pieceNo })
    }
  }

  // Wires that lost a piece: what is left of each, in runs.
  for (const w of wires) {
    const mine = edges.filter((e) => e.wire === w.id)
    if (!mine.some((e) => gone.has(e.id))) continue
    out.wires.add(w.id)
    for (const run of runs(mine, (e) => !gone.has(e.id))) out.pieces.push(run.points)
  }
  return out
}

/** Points in a straight line through the middle of a run dropped. */
function simplify(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1]
    const b = points[i]
    const c = points[i + 1]
    const straight = (round(a.x) === round(b.x) && round(b.x) === round(c.x)) || (round(a.y) === round(b.y) && round(b.y) === round(c.y))
    if (!straight) out.push(b)
  }
  out.push(points[points.length - 1])
  return out
}
