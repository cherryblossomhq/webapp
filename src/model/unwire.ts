import { pointOnSegment } from "../lib/geometry"
import { uid } from "../lib/id"
import { drawnIslands } from "./blocks"
import { schematicPins } from "./instances"
import { removeItems } from "./ops"
import { key, runs, wireGraph, type Edge } from "./tidy/cut"
import { isArranged, isPort } from "./tidy/nets"
import type { PinRef, Project, Vec2, Wire } from "./types"

// Deleting drawing from the schematic, for Sakura's `remove_wiring`: what is drawn at a pin, so the
// pin leaves its net (`wiringAt`), and what reaches no part at all (`looseIslands`), the drawing
// Tidy keeps below the blocks. Both only take wire, labels and power or ground ports away, so
// nothing they leave joins two nets; what a deletion cuts loose besides is the caller's to say
// (`connectionsLost`).

/** What a deletion takes, by id. */
export interface Taken {
  wires: string[]
  labels: string[]
  ports: string[]
  /** What is left of the wires it took a run of, as new wires, each with the id of the wire it is left of. */
  pieces: { from: string; wire: Wire }[]
}

/** How many wires went whole, were cut short, and how many labels and ports went. */
export function takenCount(t: Taken) {
  const cut = new Set(t.pieces.map((p) => p.from))
  return { wires: t.wires.filter((id) => !cut.has(id)).length, shortened: cut.size, labels: t.labels.length, ports: t.ports.length }
}

/** The project without what was taken. */
export function withoutTaken(project: Project, t: Taken): Project {
  if (!t.wires.length && !t.labels.length && !t.ports.length) return project
  const next = removeItems(project, { wires: t.wires, labels: t.labels, components: t.ports })
  return t.pieces.length ? { ...next, wires: [...next.wires, ...t.pieces.map((p) => p.wire)] } : next
}

const samePoint = (a: Vec2, b: Vec2) => key(a) === key(b)

/**
 * The islands of drawing that reach no part's pin: wires, labels and power or ground ports with no
 * part on them, as Tidy counts them. Drawing at a sheet symbol's pin, and an island with a
 * hierarchical label (a sheet's way out), are never loose.
 */
export function looseIslands(project: Project): Taken[] {
  const islands = drawnIslands(project)
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const wireById = new Map(project.wires.map((w) => [w.id, w]))
  const labelById = new Map(project.labels.map((l) => [l.id, l]))
  const sheetPins = (project.sheetSymbols ?? []).flatMap((s) => s.pins)
  const onWire = (w: Wire, p: Vec2) => w.points.some((q, i) => samePoint(q, p) || (i > 0 && pointOnSegment(p, w.points[i - 1], q)))
  const out: Taken[] = []
  for (const root of new Set([...islands.components.keys(), ...islands.wires.keys(), ...islands.labels.keys()])) {
    const ports = [...(islands.components.get(root) ?? [])]
    if (ports.some((id) => !byId.has(id) || isArranged(byId.get(id)!.partId))) continue
    const wires = islands.wires.get(root) ?? []
    const labels = islands.labels.get(root) ?? []
    if (labels.some((id) => labelById.get(id)?.kind === "hierarchical")) continue
    if (sheetPins.some((p) => labels.some((id) => samePoint(labelById.get(id)!, p)) || wires.some((id) => onWire(wireById.get(id)!, p)))) continue
    out.push({ wires, labels, ports, pieces: [] })
  }
  return out
}

/**
 * What is drawn at `pins`, for each to leave its net: from each pin, the wire as far as the first
 * junction, label, port, sheet pin or other pin; a label or port that this leaves standing on
 * nothing; and labels and ports right on the pin. A pin touching another part's pin stays touching it.
 */
export function wiringAt(project: Project, pins: PinRef[]): Taken {
  const points = new Map<string, Vec2>()
  const compsAt = new Map<string, string[]>()
  const labelsAt = new Map<string, string[]>()
  const put = (at: Map<string, string[]>, p: Vec2, id: string) => {
    const k = key(p)
    points.set(k, p)
    at.set(k, [...(at.get(k) ?? []), id])
  }
  for (const c of project.components) for (const pin of schematicPins(c)) put(compsAt, pin.pos, c.id)
  for (const l of project.labels) put(labelsAt, l, l.id)
  const sheetPinAt = new Set<string>()
  for (const s of project.sheetSymbols ?? []) {
    for (const p of s.pins) {
      sheetPinAt.add(key(p))
      points.set(key(p), p)
    }
  }
  const stands = (k: string) => compsAt.has(k) || labelsAt.has(k) || sheetPinAt.has(k)
  const g = wireGraph(project.wires, points, stands)
  const gone = new Set<number>()
  const live = (k: string) => (g.at.get(k) ?? []).filter((e) => !gone.has(e))
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const port = (id: string) => !!byId.get(id) && isPort(byId.get(id)!.partId)

  // From each pin, along the wire until something stands or wires meet.
  const starts = new Map<string, Set<string>>()
  const ends = new Set<string>()
  for (const ref of pins) {
    const c = byId.get(ref.componentId)
    const pin = c && schematicPins(c).find((p) => p.pin === ref.pin)
    if (!pin) continue
    const start = key(pin.pos)
    starts.set(start, (starts.get(start) ?? new Set()).add(ref.componentId))
    for (const first of live(start)) {
      let e = first
      let from = start
      while (!gone.has(e)) {
        gone.add(e)
        const edge = g.edges[e]
        const to = edge.a === from ? edge.b : edge.a
        if (stands(to)) {
          ends.add(to)
          break
        }
        const next = live(to)
        if (next.length !== 1) break
        from = to
        e = next[0]
      }
    }
  }

  const labels = new Set<string>()
  const ports = new Set<string>()
  // Right on a pin: its labels, and ports set on it (not the pin's own part, when a port's pin is the one asked for).
  for (const [k, own] of starts) {
    for (const id of labelsAt.get(k) ?? []) labels.add(id)
    for (const id of compsAt.get(k) ?? []) if (port(id) && !own.has(id)) ports.add(id)
  }
  // Where a run ended: one label or port left on nothing goes with it. Two together still join two names, so they stay.
  for (const k of ends) {
    if (starts.has(k) || live(k).length || sheetPinAt.has(k)) continue
    const here = [...(labelsAt.get(k) ?? []).map((id) => ({ id, label: true })), ...(compsAt.get(k) ?? []).map((id) => ({ id, label: false }))]
    if (here.length !== 1) continue
    if (here[0].label) labels.add(here[0].id)
    else if (port(here[0].id)) ports.add(here[0].id)
  }

  const edgesOf = new Map<string, Edge[]>()
  for (const e of g.edges) edgesOf.set(e.wire, [...(edgesOf.get(e.wire) ?? []), e])
  const wires: string[] = []
  const pieces: Taken["pieces"] = []
  for (const w of project.wires) {
    const mine = edgesOf.get(w.id) ?? []
    if (!mine.some((e) => gone.has(e.id))) continue
    wires.push(w.id)
    for (const run of runs(mine, (e) => !gone.has(e.id))) pieces.push({ from: w.id, wire: { ...w, id: uid("w"), points: run.points } })
  }
  return { wires, labels: [...labels], ports: [...ports], pieces }
}
