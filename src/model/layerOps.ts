import { uid } from "../lib/id"
import { round } from "../lib/geometry"
import { classValues } from "./netClasses"
import { anchorSide } from "./zoneLayers"
import { copperLayers, defaultStackup, flipLayer, isInner, kicadLayerName, layerIndex, layerOfKicadName, MAX_COPPER_LAYERS, spanKind, viaBetween, withCopperCount } from "./stack"
import type { BoardStack, CopperLayer, CopperLayerType, PadDef, Project, StackRow, Trace, Vec2, Via, ViaKind, Zone } from "./types"

// X1, X4 and X5 as the editor edits them: pure functions that return a new project (or the same one when nothing changes), so each is one undo step and
// the PCB view, the Inspector and Sakura's tools share one set of rules.

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

// ---------- vias ----------

export interface NewViaOptions {
  net?: string | null
  locked?: boolean
  /** The kind; absent or `through` is a via through the board. */
  kind?: "through" | ViaKind
  /** The two layers a via that is not a through via joins, in either order. Defaults to the layer a track ends on and the one next to it. */
  between?: [CopperLayer, CopperLayer]
}

/**
 * A via for a net: its net class's size (a micro via has the class's micro via size, else the board's, else KiCad's own 0.3 mm with a 0.1 mm hole), through the board or between two layers.
 * A kind that disagrees with its layers is made to agree: a blind via is a via with one outer end, a buried via has none, and a micro via joins neighbouring layers.
 */
export function makeVia(project: Project, at: Vec2, opts: NewViaOptions = {}): { project: Project; via: Via } {
  const sizes = classValues(project.rules, opts.net)
  const micro = opts.kind === "micro"
  const dia = micro ? (sizes.microViaDiameter ?? project.rules.microVia?.diameter ?? 0.3) : sizes.viaDiameter
  const drill = micro ? (sizes.microViaDrill ?? project.rules.microVia?.drill ?? 0.1) : sizes.viaDrill
  const via: Via = { id: uid("v"), x: round(at.x), y: round(at.y), diameter: dia, drill, ...(opts.locked ? { locked: true } : {}) }
  if (opts.kind && opts.kind !== "through") {
    const stack = copperLayers(project.board)
    const [a, b] = opts.between ?? [stack[0], stack[Math.min(1, stack.length - 1)]]
    if (a !== b && stack.includes(a) && stack.includes(b)) {
      const span = viaBetween(project.board, a, b, micro)
      if (span.kind) {
        // A buried via that is micro is a micro via; one asked for as buried between layers with an outer end is blind.
        const kind: ViaKind = micro ? "micro" : opts.kind === "buried" && span.kind === "blind" ? "blind" : span.kind
        Object.assign(via, { kind, from: span.from, to: span.to })
      }
    }
  }
  return { project: touch({ ...project, vias: [...project.vias, via] }), via }
}

/**
 * A via's two ends changed (X5): its kind follows its layers (a via between the outer two is a through via, one with an outer end is blind, one with none buried; a micro via
 * stays micro). A via that joins the same layer twice is left as it was.
 */
export function setViaSpan(project: Project, id: string, a: CopperLayer, b: CopperLayer): Project {
  const v = project.vias.find((x) => x.id === id)
  if (!v || a === b) return project
  const stack = copperLayers(project.board)
  if (!stack.includes(a) || !stack.includes(b)) return project
  const span = viaBetween(project.board, a, b, v.kind === "micro")
  const { kind: _k, from: _f, to: _t, ...rest } = v
  return touch({ ...project, vias: project.vias.map((x) => (x.id === id ? { ...rest, ...span } : x)) })
}

/** Change what sort of via a via is: through the board (every layer), micro (the layer it ends on and the next), or blind or buried (the layers it has, or its first end and the layer next to it). */
export function setViaKind(project: Project, id: string, to: "through" | "partial" | "micro"): Project {
  const v = project.vias.find((x) => x.id === id)
  if (!v) return project
  const stack = copperLayers(project.board)
  const { kind: _k, from: _f, to: _t, ...rest } = v
  if (to === "through") return touch({ ...project, vias: project.vias.map((x) => (x.id === id ? rest : x)) })
  const from = v.from ?? stack[0]
  const next = v.to ?? stack[Math.min(stack.indexOf(from) + 1, stack.length - 1)]
  const other = next === from ? stack[Math.max(0, stack.indexOf(from) - 1)] : next
  if (other === from) return project
  const span = viaBetween(project.board, from, other, to === "micro")
  // A "blind or buried" via that would be through the board is blind: the choice was a via that is not through.
  const kind = to === "micro" ? "micro" : span.kind ?? "blind"
  return touch({ ...project, vias: project.vias.map((x) => (x.id === id ? { ...rest, kind, from: span.from ?? from, to: span.to ?? other } : x)) })
}

/** The layer after `layer` in the stack, or the one before it, going round: where a track goes on from a via. */
export function nextCopperLayer(project: Pick<Project, "board">, layer: CopperLayer, step: 1 | -1 = 1): CopperLayer {
  const all = copperLayers(project.board)
  const i = all.indexOf(layer)
  return all[(((i < 0 ? 0 : i) + step) % all.length + all.length) % all.length]
}

/** Which sort of via a via is, in words: through, blind, buried or micro. */
export const viaKindName = (v: Pick<Via, "kind">): string => v.kind ?? "through"

// ---------- tracks ----------

/** An arc track (X4): a trace of three points on a layer. Null when the points lie on a line. */
export function makeArcTrace(project: Project, opts: { layer: CopperLayer; start: Vec2; mid: Vec2; end: Vec2; width: number; net?: string; locked?: boolean }): { project: Project; trace: Trace | null } {
  const pts = [opts.start, opts.mid, opts.end].map((p) => ({ x: round(p.x), y: round(p.y) }))
  const cross = (pts[1].x - pts[0].x) * (pts[2].y - pts[1].y) - (pts[1].y - pts[0].y) * (pts[2].x - pts[1].x)
  if (Math.abs(cross) < 1e-9 || !copperLayers(project.board).includes(opts.layer)) return { project, trace: null }
  const t: Trace = { id: uid("t"), layer: opts.layer, width: opts.width, points: pts, arc: true, ...(opts.locked ? { locked: true } : {}), ...(opts.net ? { net: opts.net } : {}) }
  return { project: touch({ ...project, traces: [...project.traces, t] }), trace: t }
}

/** An arc track with one of its three points moved to `to`: the circle follows, the ends and the middle are points on it as ever. Unchanged when the three points would lie on a line. */
export function moveArcPoint(project: Project, id: string, index: 0 | 1 | 2, to: Vec2): Project {
  const t = project.traces.find((x) => x.id === id)
  if (!t || !t.arc || t.points.length !== 3) return project
  const pts = t.points.map((p, i) => (i === index ? { x: round(to.x), y: round(to.y) } : p))
  const cross = (pts[1].x - pts[0].x) * (pts[2].y - pts[1].y) - (pts[1].y - pts[0].y) * (pts[2].x - pts[1].x)
  if (Math.abs(cross) < 1e-9) return project
  return touch({ ...project, traces: project.traces.map((x) => (x.id === id ? { ...x, points: pts } : x)) })
}

/** An arc track run the other way: its ends swapped, the middle where it was. */
export function reverseArc(project: Project, id: string): Project {
  const t = project.traces.find((x) => x.id === id)
  if (!t || !t.arc || t.points.length !== 3) return project
  return touch({ ...project, traces: project.traces.map((x) => (x.id === id ? { ...x, points: [x.points[2], x.points[1], x.points[0]] } : x)) })
}

/** An arc track as the straight track between its ends, and a straight track of two points as an arc bulging by `bulge` mm (the editor's way to start an arc). */
export function setArc(project: Project, id: string, arc: boolean, bulge = 0.5): Project {
  const t = project.traces.find((x) => x.id === id)
  if (!t) return project
  if (!arc) {
    if (!t.arc) return project
    const { arc: _a, points, ...rest } = t
    return touch({ ...project, traces: project.traces.map((x) => (x.id === id ? { ...rest, points: [points[0], points[2]] } : x)) })
  }
  if (t.arc || t.points.length !== 2) return project
  const [a, b] = t.points
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return project
  const mid = { x: round((a.x + b.x) / 2 - (dy / len) * bulge), y: round((a.y + b.y) / 2 + (dx / len) * bulge) }
  return touch({ ...project, traces: project.traces.map((x) => (x.id === id ? { ...x, arc: true as const, points: [a, mid, b] } : x)) })
}

// ---------- the layers ----------

/** What copper and drawings a board has on a layer, for saying what taking the layer away would delete. */
export interface LayerContent {
  traces: number
  vias: number
  zones: number
  drawings: number
  texts: number
  /** Pads that have copper on the layer by their own say (`PadDef.layers.inner`, a pad stack layer or `PadDef.zoneLayers`). */
  pads: number
}

const onLayerName = (name: string, layer: CopperLayer) => layerOfKicadName(name) === layer

export function layerContent(project: Project, layer: CopperLayer): LayerContent {
  return {
    traces: project.traces.filter((t) => t.layer === layer).length,
    vias: project.vias.filter((v) => v.kind !== undefined && (v.from === layer || v.to === layer)).length,
    zones: project.zones.filter((z) => (z.layers ?? [z.layer]).includes(layer)).length,
    drawings: (project.graphics ?? []).filter((g) => onLayerName(g.layer, layer)).length,
    texts: project.texts.filter((t) => t.layer !== undefined && onLayerName(t.layer, layer)).length,
    pads: (project.footprints ?? []).reduce((n, f) => n + f.pads.filter((p) => p.layers?.inner?.includes(layer) || p.stack?.layers[layer] || p.zoneLayers?.includes(layer)).length, 0),
  }
}

export const isEmptyContent = (c: LayerContent) => Object.values(c).every((n) => n === 0)

const without = <T extends object>(o: T, ...keys: string[]): T => {
  const out = { ...o } as Record<string, unknown>
  for (const k of keys) delete out[k]
  return out as T
}

/**
 * The project with `count` copper layers (2 to 32). More layers are added before the back one, each a signal layer with no stackup row of its own; fewer drop the
 * inner layers from the back of the inner ones, with what is on them: their traces, the layer from the zones that have it (a zone left with none is dropped), their
 * drawings and texts, the blind and buried vias that end on them, and a pad's own inner layers. The stackup rows are dropped whichever way the count goes, for they describe
 * a stack of the old size: `defaultStackup` makes one for the new. Returns what was deleted, so the caller can say so.
 */
export function setCopperLayerCount(project: Project, count: number): { project: Project; removed: LayerContent } {
  const n = Math.max(2, Math.min(MAX_COPPER_LAYERS, Math.round(count)))
  const had = copperLayers(project.board)
  const none: LayerContent = { traces: 0, vias: 0, zones: 0, drawings: 0, texts: 0, pads: 0 }
  if (n === had.length) return { project, removed: none }
  const board = withCopperCount(project.board, n)
  project = keepBottomPartLayers(project, had.length, n)
  const keep = new Set(copperLayers(board))
  const gone = had.filter((l) => !keep.has(l))
  const removed = { ...none }
  // What is deleted is counted once: a buried via that ends on two layers that go is one via.
  for (const l of gone) {
    const c = layerContent(project, l)
    removed.zones += c.zones
    removed.pads += c.pads
  }
  const alive = (l: CopperLayer) => keep.has(l)
  const alsoNames = new Set(gone.map(kicadLayerName))
  const zones = project.zones.flatMap((z) => {
    const own = z.layers ?? [z.layer]
    const ls = own.filter(alive)
    if (ls.length === own.length) return [z]
    // A rule area that is on layers that are not copper too keeps those (X29); a zone with none left is gone.
    if (!ls.length) return z.other?.length ? [{ ...without(z, "layers"), layers: [], layer: anchorSide(z.other) }] : []
    const next = { ...without(z, "layers"), layer: ls[0] }
    return [ls.length > 1 ? { ...next, layers: ls } : next]
  })
  const footprints = project.footprints?.map((f) => {
    if (!f.pads.some((p) => p.layers?.inner?.some((l) => !alive(l)) || p.zoneLayers?.some((l) => !alive(l)) || (p.stack && Object.keys(p.stack.layers).some((k) => k !== "inner" && !alive(k as CopperLayer))))) return f
    return { ...f, pads: f.pads.map((p) => cleanPad(p, alive)) }
  })
  const next: Project = {
    ...project,
    board,
    traces: project.traces.filter((t) => alive(t.layer)),
    vias: project.vias.filter((v) => v.kind === undefined || (alive(v.from!) && alive(v.to!))).map((v) => (v.zoneLayers?.some((l) => !alive(l)) ? { ...v, zoneLayers: v.zoneLayers.filter(alive) } : v)),
    zones,
    ...(project.graphics ? { graphics: project.graphics.filter((g) => !alsoNames.has(g.layer)) } : {}),
    texts: project.texts.filter((t) => t.layer === undefined || !alsoNames.has(t.layer)),
    ...(footprints ? { footprints } : {}),
  }
  removed.traces = project.traces.length - next.traces.length
  removed.vias = project.vias.length - next.vias.length
  removed.drawings = (project.graphics?.length ?? 0) - (next.graphics?.length ?? 0)
  removed.texts = project.texts.length - next.texts.length
  return { project: touch(next), removed }
}

/**
 * What is on a copper layer the board no longer has, dropped, as `setCopperLayerCount` drops it from the board it changes: for the board as another copy left it
 * (a copy cut the stack to two layers while this one routed on `in1`). Traces, blind and buried vias, the layers of zones (a zone with none left goes), and the
 * board graphics and texts on an inner layer's name. The project itself when nothing is on a missing layer.
 */
export function dropDeadLayers(project: Project): Project {
  const keep = new Set<string>(copperLayers(project.board))
  const alive = (l: CopperLayer) => keep.has(l)
  const aliveName = (n: string) => {
    const l = layerOfKicadName(n)
    return !l || alive(l)
  }
  const zoneOk = (z: Zone) => (z.layers ?? [z.layer]).every(alive)
  const viaOk = (v: Via) => (v.kind === undefined || (alive(v.from!) && alive(v.to!))) && !v.zoneLayers?.some((l) => !alive(l))
  if (
    project.traces.every((t) => alive(t.layer)) &&
    project.zones.every(zoneOk) &&
    project.vias.every(viaOk) &&
    (project.graphics ?? []).every((g) => aliveName(g.layer)) &&
    project.texts.every((t) => t.layer === undefined || aliveName(t.layer))
  )
    return project
  const zones = project.zones.flatMap((z) => {
    if (zoneOk(z)) return [z]
    const ls = (z.layers ?? [z.layer]).filter(alive)
    if (!ls.length) return []
    const next = { ...without(z, "layers"), layer: ls[0] }
    return [ls.length > 1 ? { ...next, layers: ls } : next]
  })
  return {
    ...project,
    traces: project.traces.filter((t) => alive(t.layer)),
    vias: project.vias.filter((v) => v.kind === undefined || (alive(v.from!) && alive(v.to!))).map((v) => (v.zoneLayers?.some((l) => !alive(l)) ? { ...v, zoneLayers: v.zoneLayers.filter(alive) } : v)),
    zones,
    ...(project.graphics ? { graphics: project.graphics.filter((g) => aliveName(g.layer)) } : {}),
    texts: project.texts.filter((t) => t.layer === undefined || aliveName(t.layer)),
  }
}

/**
 * A bottom-side part keeps its inner layers in its own frame (`flipLayer`: of four layers its `in1` is the board's `in2`), and that map depends on the layer
 * count, so a count that changes would move the part's inner copper to another physical layer. This rewrites them, in the pad lists, the pad stacks, the land's
 * drawings and the parts' texts, so each stays on the layer it is on in the board. A land used by a bottom-side part is written in the part's frame (as the
 * KiCad import does), so a land shared with a top-side part is not supported. A layer the new stack lacks keeps its physical name and is dropped as usual.
 */
function keepBottomPartLayers(project: Project, from: number, to: number): Project {
  if ((from < 4 && to < 4) || from === to) return project
  const bottom = project.components.filter((c) => c.pcb.side === "bottom")
  if (!bottom.length) return project
  const alive = new Set<string>(copperLayers(withCopperCount(project.board, to)))
  const id = (l: CopperLayer): CopperLayer => {
    const physical = flipLayer(l, from)
    return alive.has(physical) ? flipLayer(physical, to) : physical
  }
  const names = new Set(bottom.map((c) => c.footprint))
  const mapShapeLayer = (n: string) => {
    const l = layerOfKicadName(n)
    return l && isInner(l) ? kicadLayerName(id(l)) : n
  }
  const footprints = project.footprints?.map((f) => {
    if (!names.has(f.name)) return f
    return {
      ...f,
      pads: f.pads.map((p) => {
        let out = p
        if (p.layers?.inner) out = { ...out, layers: { ...out.layers, inner: p.layers.inner.map(id) } }
        if (p.layers?.other) out = { ...out, layers: { ...out.layers, other: p.layers.other.map(mapShapeLayer) } }
        if (p.zoneLayers) out = { ...out, zoneLayers: p.zoneLayers.map((l) => (l === "top" || l === "bottom" ? l : id(l))) }
        if (p.stack) {
          const layers = Object.fromEntries(Object.entries(p.stack.layers).map(([k, v]) => [k === "inner" || k === "top" || k === "bottom" ? k : id(k as CopperLayer), v]))
          out = { ...out, stack: { ...p.stack, layers: layers as NonNullable<PadDef["stack"]>["layers"] } }
        }
        return out
      }),
      ...(f.shapes ? { shapes: f.shapes.map((s) => ({ ...s, layer: mapShapeLayer(s.layer) })) } : {}),
    }
  })
  const components = project.components.map((c) => (c.pcb.side === "bottom" && c.texts?.some((t) => mapShapeLayer(t.layer) !== t.layer) ? { ...c, texts: c.texts.map((t) => ({ ...t, layer: mapShapeLayer(t.layer) })) } : c))
  return { ...project, components, ...(footprints ? { footprints } : {}) }
}

function cleanPad(p: PadDef, alive: (l: CopperLayer) => boolean): PadDef {
  let out = p
  if (p.layers?.inner?.some((l) => !alive(l))) out = { ...out, layers: { ...out.layers, inner: out.layers!.inner!.filter(alive) } }
  if (p.zoneLayers?.some((l) => !alive(l))) out = { ...out, zoneLayers: p.zoneLayers.filter(alive) }
  if (p.stack) {
    const layers = Object.fromEntries(Object.entries(p.stack.layers).filter(([k]) => k === "inner" || alive(k as CopperLayer)))
    out = { ...out, stack: { ...p.stack, layers: layers as NonNullable<PadDef["stack"]>["layers"] } }
  }
  return out
}

/** Name a copper layer (an empty name is KiCad's own) and say what it is for. */
export function setCopperLayer(project: Project, layer: CopperLayer, patch: { label?: string; type?: CopperLayerType }): Project {
  const i = layerIndex(project.board, layer)
  if (i < 0) return project
  const stack: BoardStack = project.board.stack ?? { copper: copperLayers(project.board).map(() => ({})) }
  const copper = stack.copper.map((c, k) => {
    if (k !== i) return c
    const next = { ...c }
    if (patch.label !== undefined) {
      if (patch.label.trim()) next.label = patch.label.trim().slice(0, 120)
      else delete next.label
    }
    if (patch.type !== undefined) {
      if (patch.type === "signal") delete next.type
      else next.type = patch.type
    }
    return next
  })
  return touch({ ...project, board: normalizeStackOf({ ...project.board, stack: { ...stack, copper } }) })
}

/** A board whose stack says nothing a plain two layer board does not has no stack. */
function normalizeStackOf(board: Project["board"]): Project["board"] {
  const s = board.stack
  if (!s) return board
  const plain = s.copper.length === 2 && s.copper.every((c) => !c.label && !c.type) && !s.rows?.length && s.finish === undefined && s.edgePlating === undefined && s.dielectricConstraints === undefined && !s.edgeConnector
  return plain ? without(board, "stack") : board
}

// ---------- the stackup ----------

/** Give the board the standard stackup for its layers, or drop its stackup rows. */
export function setStackup(project: Project, rows: StackRow[] | null): Project {
  const stack: BoardStack = project.board.stack ?? { copper: copperLayers(project.board).map(() => ({})) }
  const { rows: _r, ...rest } = stack
  const next: BoardStack = rows && rows.length ? { ...rest, rows } : rest
  return touch({ ...project, board: normalizeStackOf({ ...project.board, stack: next }) })
}

/** Change one row of the stackup. Absent fields in `patch` are left, `undefined` clears one. */
export function updateStackRow(project: Project, index: number, patch: Partial<Omit<StackRow, "name" | "type">>): Project {
  const rows = project.board.stack?.rows
  if (!rows?.[index]) return project
  const next = rows.map((r, i) => {
    if (i !== index) return r
    const merged: Record<string, unknown> = { ...r, ...patch }
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
    return merged as unknown as StackRow
  })
  return setStackup(project, next)
}

/** The finish and the other board-level stackup settings. */
export function setStackSettings(project: Project, patch: Partial<Pick<BoardStack, "finish" | "edgePlating" | "dielectricConstraints" | "edgeConnector">>): Project {
  const stack: BoardStack = project.board.stack ?? { copper: copperLayers(project.board).map(() => ({})) }
  const merged: Record<string, unknown> = { ...stack, ...patch }
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
  return touch({ ...project, board: normalizeStackOf({ ...project.board, stack: merged as unknown as BoardStack }) })
}

/** A via's kind in words for the Inspector: what its layers make it, whatever it says. */
export const viaSpanKind = (project: Pick<Project, "board">, v: Pick<Via, "kind" | "from" | "to">): "through" | "blind" | "buried" => (v.from && v.to ? spanKind(project.board, v.from, v.to) : "through")

export { defaultStackup, isInner }
