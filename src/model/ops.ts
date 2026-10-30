import {
  emptyBox,
  expandBox,
  normBox,
  orthogonalElbow,
  pointOnSegment,
  rotate90,
  round,
  samePoint,
  simplifyPolyline,
  transformBox,
} from "../lib/geometry"
import { uid } from "../lib/id"
import { copperLayers } from "./stack"
import { SpatialHash, pointBox } from "../lib/spatialHash"
import { blockFrames, blocksWithout } from "./blocks"
import { UnionFind, computeConnectivity, type SchematicConnectivity } from "./connectivity"
import { drawingBounds, moveDrawing } from "./drawings"
import { DEFAULT_RULES } from "./rules"
import { classValues, hasNetClasses } from "./netClasses"
import { labelBox } from "./labels"
import { rekeyAutoNets } from "./rekeyNets"
import { cutAtTs, kicadRulesShown, settleKicadSheet } from "./kicadJoin"
import { findPart, getPart } from "./library"
import { dirVector, pinStubPoint, schematicBounds, schematicPins, type WorldPin } from "./instances"
import { SCH_GRID } from "./symbols"
import { symbolOf } from "./symbolDrawing"
import { repairUnits } from "./units"
import type {
  ComponentInstance,
  Mirror,
  NetLabel,
  PinRef,
  DesignRules,
  PartDef,
  Project,
  Rotation,
  Trace,
  Vec2,
  Via,
  Wire,
} from "./types"

export { DEFAULT_RULES }
export { autoPlacePcb, repackCopper, repackPcb } from "./autoplace"

/**
 * Width for new traces on a net: the width the net was given by name (`rules.netWidths`), else its net class's (X10), else the default.
 * A width given to one net wins over its class's because it is the more specific; a board with no classes has no middle step.
 */
export const netTraceWidth = (rules: DesignRules, netName: string | null | undefined) =>
  (netName ? rules.netWidths?.[netName] : undefined) ?? (netName && hasNetClasses(rules) ? classValues(rules, netName).traceWidth : rules.traceWidth)

export function createProject(name = "Untitled project", description = ""): Project {
  const now = Date.now()
  return {
    id: uid("p"),
    name,
    description,
    createdAt: now,
    updatedAt: now,
    components: [],
    wires: [],
    labels: [],
    traces: [],
    vias: [],
    zones: [],
    texts: [],
    board: { width: 50, height: 40, x: 0, y: 0, thickness: 1.6, cornerRadius: 1 },
    rules: { ...DEFAULT_RULES },
  }
}

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

export function nextRef(project: Project, prefix: string): string {
  let max = 0
  const re = new RegExp(`^${prefix.replace(/[#$]/g, "\\$&")}(\\d+)$`)
  for (const c of project.components) {
    const m = c.ref.match(re)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}

export interface AddComponentOptions {
  sch?: Partial<ComponentInstance["sch"]>
  pcb?: Partial<ComponentInstance["pcb"]>
  props?: Record<string, string>
  footprint?: string
  ref?: string
  id?: string
}

export function makeComponent(project: Project, partId: string, opts: AddComponentOptions = {}): ComponentInstance {
  const part = getPart(partId)
  return {
    id: opts.id ?? uid("c"),
    partId,
    ref: opts.ref ?? nextRef(project, part.refPrefix),
    props: { ...part.defaultProps, ...opts.props },
    footprint: opts.footprint ?? part.footprints[0] ?? "",
    sch: { x: 0, y: 0, rot: 0, ...opts.sch },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false, ...opts.pcb },
  }
}

export function addComponent(
  project: Project,
  partId: string,
  opts: AddComponentOptions = {},
): { project: Project; component: ComponentInstance } {
  const component = makeComponent(project, partId, opts)
  return { project: touch({ ...project, components: [...project.components, component] }), component }
}

export function updateComponent(
  project: Project,
  id: string,
  patch: Partial<Omit<ComponentInstance, "sch" | "pcb">> & {
    sch?: Partial<ComponentInstance["sch"]>
    pcb?: Partial<ComponentInstance["pcb"]>
  },
): Project {
  return touch({
    ...project,
    components: project.components.map((c) => {
      if (c.id !== id) return c
      const next = {
        ...c,
        ...patch,
        props: patch.props ? { ...patch.props } : c.props,
        sch: withoutEmptyMirror({ ...c.sch, ...patch.sch }),
        pcb: { ...c.pcb, ...patch.pcb },
      }
      // A reference text that shows something other than the part's reference (a part a KiCad board names `REF**`) follows the part once the part is renamed.
      if (patch.ref !== undefined && patch.ref !== c.ref && c.texts?.some((t) => t.kind === "reference" && t.text !== undefined)) {
        next.texts = c.texts.map((t) => (t.kind === "reference" && t.text !== undefined ? (({ text: _text, ...rest }) => rest)(t) : t))
      }
      // The KiCad footprint id names the footprint the file gave, so another footprint makes it wrong (`${FOOTPRINT_NAME}`).
      if (patch.footprint !== undefined && patch.footprint !== c.footprint && patch.fpid === undefined) delete next.fpid
      // A part's own groups name the pads, drawings and texts of its land by place, so another footprint ends them.
      if (patch.footprint !== undefined && patch.footprint !== c.footprint) delete next.groups
      return next
    }),
  })
}

/** A placement with a mirror that is not one has none: the key is gone, not undefined. */
function withoutEmptyMirror(sch: ComponentInstance["sch"]): ComponentInstance["sch"] {
  if (sch.mirror !== undefined) return sch
  const { mirror: _mirror, ...rest } = sch
  return "mirror" in sch ? rest : sch
}

export interface ItemIds {
  components?: string[]
  wires?: string[]
  labels?: string[]
  traces?: string[]
  vias?: string[]
  /** Blocks go without their parts, which stay where they are. */
  blocks?: string[]
  drawings?: string[]
}

/** Delete items. A deleted component leaves its block, and a block left empty goes too. */
export function removeItems(project: Project, ids: ItemIds): Project {
  const c = new Set(ids.components)
  const w = new Set(ids.wires)
  const l = new Set(ids.labels)
  const t = new Set(ids.traces)
  const v = new Set(ids.vias)
  const b = new Set(ids.blocks)
  const d = new Set(ids.drawings)
  const drawings = project.drawings?.filter((x) => !d.has(x.id))
  // A part deleted while others of its units stay: the next unit becomes the part, with its footprint and place on the board.
  const left = project.components.filter((x) => !c.has(x.id))
  const removed = c.size ? project.components.filter((x) => c.has(x.id)) : []
  const result = touch({
    ...project,
    components: removed.length ? repairUnits(left, removed) : left,
    wires: project.wires.filter((x) => !w.has(x.id)),
    labels: project.labels.filter((x) => !l.has(x.id)),
    traces: project.traces.filter((x) => !t.has(x.id)),
    vias: project.vias.filter((x) => !v.has(x.id)),
    ...(project.blocks && { blocks: blocksWithout(project.blocks.filter((x) => !b.has(x.id)), c) }),
    ...(drawings && { drawings: drawings.length ? drawings : undefined }),
  })
  // A part that goes can rename the nets made up from its pins: the board data keyed by those names follows (and a project with none is returned as it is).
  return removed.length ? rekeyAutoNets(project, result) : result
}

export function addWire(project: Project, points: Vec2[]): { project: Project; wire: Wire | null } {
  const pts = simplifyPolyline(points.map((p) => ({ x: round(p.x), y: round(p.y) })))
  if (pts.length < 2) return { project, wire: null }
  const wire: Wire = { id: uid("w"), points: pts }
  const all = [...project.wires, wire]
  // S11: on a sheet joined by KiCad's rules a wire end on another wire's side joins nothing, so the wires are cut where they meet (KiCad's T).
  return { project: touch({ ...project, wires: kicadRulesShown(project) ? cutAtTs(all, wire) : all }), wire }
}

export function addLabel(project: Project, name: string, at: Vec2, rot: Rotation = 0): { project: Project; label: NetLabel } {
  // In a project named as KiCad names its nets a label is a local one, KiCad's own.
  const label: NetLabel = { id: uid("l"), name, x: round(at.x), y: round(at.y), rot, ...(project.netNames ? { kind: "local" as const } : {}) }
  return { project: touch({ ...project, labels: [...project.labels, label] }), label }
}

export function addTrace(project: Project, trace: Omit<Trace, "id">): { project: Project; trace: Trace | null } {
  const points = simplifyPolyline(trace.points.map((p) => ({ x: round(p.x), y: round(p.y) })))
  if (points.length < 2) return { project, trace: null }
  // No copper on a layer the board lacks: a load would drop it.
  if (!copperLayers(project.board).includes(trace.layer)) return { project, trace: null }
  const t: Trace = { ...trace, points, id: uid("t") }
  return { project: touch({ ...project, traces: [...project.traces, t] }), trace: t }
}

/** A via for a net: its net class's size, else the rules'. `net` is the net's name. */
export function addVia(project: Project, at: Vec2, opts: { locked?: boolean; net?: string | null } = {}): { project: Project; via: Via } {
  const size = classValues(project.rules, opts.net)
  const via: Via = {
    id: uid("v"),
    x: round(at.x),
    y: round(at.y),
    diameter: size.viaDiameter,
    drill: size.viaDrill,
    ...(opts.locked ? { locked: true } : {}),
  }
  return { project: touch({ ...project, vias: [...project.vias, via] }), via }
}

export function findPin(project: Project, ref: PinRef): WorldPin | null {
  const c = project.components.find((x) => x.id === ref.componentId)
  if (!c) return null
  return schematicPins(c).find((p) => p.pin === ref.pin) ?? null
}

/** Resolve "R1.1", "U1.VCC" or "U1.8" to a pin reference. */
export function resolvePinSpec(project: Project, spec: string): PinRef | null {
  const m = spec.trim().match(/^([^.\s]+)\.(.+)$/)
  if (!m) return null
  const [, ref, pinName] = m
  // A part with several units has a symbol for each; the one that is the part (with the footprint) comes first.
  const same = project.components.filter((x) => x.ref.toLowerCase() === ref.toLowerCase())
  const c = same.find((x) => !findPart(x.partId)?.unitOf) ?? same[0]
  if (!c) return null
  const part = findPart(c.partId)
  if (!part) return null
  const byNumber = part.pins.find((p) => p.number === pinName)
  if (byNumber) return { componentId: c.id, pin: byNumber.number }
  const byName = part.pins.filter((p) => p.name.toLowerCase() === pinName.toLowerCase())
  if (byName.length) return { componentId: c.id, pin: byName[0].number }
  if (part.pins.length === 1) return { componentId: c.id, pin: part.pins[0].number }
  return null
}

/** The points of a wire between two pins, with a short stub leaving each pin and one elbow. */
export function wireRoute(pa: WorldPin, pb: WorldPin, horizontalFirst = pa.dir === "left" || pa.dir === "right"): Vec2[] {
  const sa = pinStubPoint(pa, SCH_GRID * 2)
  const sb = pinStubPoint(pb, SCH_GRID * 2)
  const mid = orthogonalElbow(sa, sb, horizontalFirst)
  return simplifyPolyline([pa.pos, ...mid, pb.pos].map((p) => ({ x: round(p.x), y: round(p.y) })))
}

/** Draw a schematic wire between two pins with short stubs leaving each pin. */
export function connectPins(project: Project, a: PinRef, b: PinRef): Project {
  const pa = findPin(project, a)
  const pb = findPin(project, b)
  if (!pa || !pb) return project
  return addWire(project, wireRoute(pa, pb)).project
}

/** Attach a net label to a pin via a short wire stub. */
export function labelPin(project: Project, ref: PinRef, name: string, stubLength = SCH_GRID * 3): Project {
  const pin = findPin(project, ref)
  if (!pin) return project
  const stub = pinStubPoint(pin, stubLength)
  const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
  let next = addWire(project, [pin.pos, stub]).project
  next = addLabel(next, name, stub, rot).project
  return next
}

/** What goes where a part goes: wires, net labels and power symbols that hang off its pins and are nobody else's. */
export interface Followers {
  wires: string[]
  labels: string[]
  /** Power symbols (ports and grounds). */
  components: string[]
}

/**
 * Everything drawn on a part's pins that belongs to it alone, so it can go where the part goes.
 *
 * The drawing is cut into fragments: wires, net labels and power symbols that touch each other
 * (at a point or a T). A fragment that reaches one of the parts' pins and no pin of any other part
 * is theirs whole: a stub to a net label, a power symbol on a pin, a comb joining two supply pins
 * with a tee to a symbol. Leaving any of it behind would cut the pins off their net, so it all
 * moves. A fragment that also reaches another part is a connection and is stretched instead; only
 * the labels and symbols sitting right on a pin of the parts still go with them.
 */
/** The same, worked out from scratch: for a pick that includes a power symbol, which is then the part's own. */
export function partFollowersFresh(project: Project, ids: string[]): Followers {
  const mine = new Set(ids)
  const out: Followers = { wires: [], labels: [], components: [] }
  if (!project.components.some((c) => mine.has(c.id))) return out
  const key = (p: Vec2) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`

  const uf = new UnionFind()
  const owners = new Map<string, string[]>()
  const at = (p: Vec2, owner: string) => {
    const k = key(p)
    const list = owners.get(k)
    if (list) list.push(owner)
    else owners.set(k, [owner])
  }
  const mineAt = new Set<string>()
  const foreignAt = new Set<string>()
  const symbols: { id: string; pos: Vec2 }[] = []
  for (const c of project.components) {
    const symbol = !mine.has(c.id) && !!findPart(c.partId)?.powerNet
    for (const pin of schematicPins(c)) {
      if (symbol) {
        symbols.push({ id: c.id, pos: pin.pos })
        uf.find(`c:${c.id}`)
        at(pin.pos, `c:${c.id}`)
      } else (mine.has(c.id) ? mineAt : foreignAt).add(key(pin.pos))
    }
  }
  const segments = new SpatialHash<{ wire: string; a: Vec2; b: Vec2 }>()
  const probes: { p: Vec2; owner: string }[] = []
  for (const w of project.wires) {
    if (w.points.length < 2) continue
    uf.find(`w:${w.id}`)
    for (const p of w.points) at(p, `w:${w.id}`)
    for (let i = 1; i < w.points.length; i++) segments.insert({ wire: w.id, a: w.points[i - 1], b: w.points[i] }, normBox(w.points[i - 1], w.points[i]))
    probes.push({ p: w.points[0], owner: `w:${w.id}` }, { p: w.points[w.points.length - 1], owner: `w:${w.id}` })
  }
  for (const l of project.labels) {
    uf.find(`l:${l.id}`)
    at(l, `l:${l.id}`)
    probes.push({ p: l, owner: `l:${l.id}` })
  }
  for (const list of owners.values()) for (let i = 1; i < list.length; i++) uf.union(list[0], list[i])
  for (const probe of probes) {
    for (const s of segments.query(pointBox(probe.p, 1e-3))) {
      if (`w:${s.wire}` !== probe.owner && pointOnSegment(probe.p, s.a, s.b)) uf.union(probe.owner, `w:${s.wire}`)
    }
  }

  // Which fragments reach one of the parts' pins, and which reach another part's.
  const reachesMine = new Set<string>()
  const reachesOther = new Set<string>()
  for (const [k, list] of owners) {
    const roots = list.map((o) => uf.find(o))
    if (mineAt.has(k)) for (const r of roots) reachesMine.add(r)
    if (foreignAt.has(k)) for (const r of roots) reachesOther.add(r)
  }
  const theirs = (owner: string) => {
    const root = uf.find(owner)
    return reachesMine.has(root) && !reachesOther.has(root)
  }
  for (const w of project.wires) if (w.points.length >= 2 && theirs(`w:${w.id}`)) out.wires.push(w.id)
  for (const l of project.labels) {
    const sitsOn = mineAt.has(key(l)) && !foreignAt.has(key(l))
    if (theirs(`l:${l.id}`) || sitsOn) out.labels.push(l.id)
  }
  for (const s of symbols) {
    const sitsOn = mineAt.has(key(s.pos)) && !foreignAt.has(key(s.pos))
    if (theirs(`c:${s.id}`) || sitsOn) out.components.push(s.id)
  }
  return out
}

/**
 * The drawing cut into fragments (see `partFollowers`), worked out once per sheet: a drag asks for
 * it on pointer down and a move tool on every call, and everything but which parts are asked
 * about is the same. Wires, labels and power symbols are numbered (wires first, then labels, then
 * the parts that are symbols) and points are whole numbers of thousandths, since this is built on
 * every sheet that is dragged on and strings cost more than the rest of it.
 */
interface Fragments {
  ownersAt: Map<number, number[]>
  root: Int32Array
  members: Map<number, { wires: string[]; labels: string[]; symbols: string[] }>
  /** Point -> parts (not power symbols) with a pin there. */
  pinComps: Map<number, string[]>
  /** Fragment -> parts (not power symbols) with a pin on it. */
  touching: Map<number, Set<string>>
  compKeys: Map<string, number[]>
  labelsAt: Map<number, string[]>
  symbolsAt: Map<number, string[]>
  symbolIds: Set<string>
  order: { wires: Map<string, number>; labels: Map<string, number>; comps: Map<string, number> }
  nodeOfWire: Map<string, number>
}
const fragmentCache = new WeakMap<Project, Fragments>()

const pointKey = (p: Vec2) => Math.round(p.x * 1000) * 20_000_003 + Math.round(p.y * 1000)

function fragmentsOf(project: Project): Fragments {
  const hit = fragmentCache.get(project)
  if (hit) return hit
  const W = project.wires.length
  const L = project.labels.length
  const parent = new Int32Array(W + L + project.components.length).map((_, i) => i)
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  const ownersAt = new Map<number, number[]>()
  const at = (k: number, owner: number) => {
    const list = ownersAt.get(k)
    if (list) list.push(owner)
    else ownersAt.set(k, [owner])
  }
  const pinComps = new Map<number, string[]>()
  const compKeys = new Map<string, number[]>()
  const symbolsAt = new Map<number, string[]>()
  const symbolIds = new Set<string>()
  const symbolNode = new Map<string, number>()
  const order = { wires: new Map<string, number>(), labels: new Map<string, number>(), comps: new Map<string, number>() }
  project.components.forEach((c, i) => {
    order.comps.set(c.id, i)
    const symbol = !!findPart(c.partId)?.powerNet
    const keys: number[] = []
    for (const pin of schematicPins(c)) {
      const k = pointKey(pin.pos)
      keys.push(k)
      if (symbol) {
        symbolIds.add(c.id)
        symbolNode.set(c.id, W + L + i)
        at(k, W + L + i)
        const list = symbolsAt.get(k)
        if (list) list.push(c.id)
        else symbolsAt.set(k, [c.id])
      } else {
        const list = pinComps.get(k)
        if (list) list.push(c.id)
        else pinComps.set(k, [c.id])
      }
    }
    compKeys.set(c.id, keys)
  })
  const segments = new SpatialHash<{ wire: number; a: Vec2; b: Vec2 }>()
  const probes: { p: Vec2; owner: number }[] = []
  const nodeOfWire = new Map<string, number>()
  project.wires.forEach((w, i) => {
    order.wires.set(w.id, i)
    nodeOfWire.set(w.id, i)
    if (w.points.length < 2) return
    for (const p of w.points) at(pointKey(p), i)
    for (let k = 1; k < w.points.length; k++) segments.insert({ wire: i, a: w.points[k - 1], b: w.points[k] }, normBox(w.points[k - 1], w.points[k]))
    probes.push({ p: w.points[0], owner: i }, { p: w.points[w.points.length - 1], owner: i })
  })
  const labelsAt = new Map<number, string[]>()
  project.labels.forEach((l, j) => {
    order.labels.set(l.id, j)
    const k = pointKey(l)
    at(k, W + j)
    const list = labelsAt.get(k)
    if (list) list.push(l.id)
    else labelsAt.set(k, [l.id])
    probes.push({ p: l, owner: W + j })
  })
  for (const list of ownersAt.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i])
  for (const probe of probes) {
    for (const s of segments.query(pointBox(probe.p, 1e-3))) {
      if (s.wire !== probe.owner && pointOnSegment(probe.p, s.a, s.b)) union(probe.owner, s.wire)
    }
  }
  const root = new Int32Array(parent.length)
  for (let i = 0; i < parent.length; i++) root[i] = find(i)
  const members = new Map<number, { wires: string[]; labels: string[]; symbols: string[] }>()
  const memberOf = (node: number) => {
    let m = members.get(root[node])
    if (!m) members.set(root[node], (m = { wires: [], labels: [], symbols: [] }))
    return m
  }
  project.wires.forEach((w, i) => w.points.length >= 2 && memberOf(i).wires.push(w.id))
  project.labels.forEach((l, j) => memberOf(W + j).labels.push(l.id))
  for (const [id, node] of symbolNode) memberOf(node).symbols.push(id)
  const touching = new Map<number, Set<string>>()
  for (const [k, list] of ownersAt) {
    const comps = pinComps.get(k)
    if (!comps) continue
    for (const o of list) {
      let set = touching.get(root[o])
      if (!set) touching.set(root[o], (set = new Set()))
      for (const c of comps) set.add(c)
    }
  }
  const fr: Fragments = { ownersAt, root, members, pinComps, touching, compKeys, labelsAt, symbolsAt, symbolIds, order, nodeOfWire }
  fragmentCache.set(project, fr)
  return fr
}

export function partFollowers(project: Project, ids: string[]): Followers {
  const fr = fragmentsOf(project)
  // A power symbol picked itself is the part's own: the fragments were cut with it as a foreigner.
  if (ids.some((id) => fr.symbolIds.has(id))) return partFollowersFresh(project, ids)
  const mine = new Set(ids)
  const out: Followers = { wires: [], labels: [], components: [] }
  if (!ids.some((id) => fr.compKeys.has(id))) return out
  const reachesMine = new Set<number>()
  const mineKeys = new Set<number>()
  for (const id of mine) {
    for (const k of fr.compKeys.get(id) ?? []) {
      mineKeys.add(k)
      for (const o of fr.ownersAt.get(k) ?? []) reachesMine.add(fr.root[o])
    }
  }
  const wires = new Set<string>()
  const labels = new Set<string>()
  const symbols = new Set<string>()
  for (const r of reachesMine) {
    // A fragment that also reaches another part is a connection, not the part's own.
    let other = false
    for (const c of fr.touching.get(r) ?? []) if (!mine.has(c)) other = true
    if (other) continue
    const m = fr.members.get(r)!
    m.wires.forEach((w) => wires.add(w))
    m.labels.forEach((l) => labels.add(l))
    m.symbols.forEach((c) => symbols.add(c))
  }
  // A label or symbol right on a pin of the parts and of no other part.
  for (const k of mineKeys) {
    if ((fr.pinComps.get(k) ?? []).some((c) => !mine.has(c))) continue
    for (const l of fr.labelsAt.get(k) ?? []) labels.add(l)
    for (const c of fr.symbolsAt.get(k) ?? []) symbols.add(c)
  }
  out.wires = [...wires].sort((x, y) => fr.order.wires.get(x)! - fr.order.wires.get(y)!)
  out.labels = [...labels].sort((x, y) => fr.order.labels.get(x)! - fr.order.labels.get(y)!)
  out.components = [...symbols].sort((x, y) => fr.order.comps.get(x)! - fr.order.comps.get(y)!)
  return out
}

/** Move one part to (x, y), taking what hangs off its pins alone along and stretching the wires attached to it. */
export function moveComponent(project: Project, id: string, to: Vec2): Project {
  const c = project.components.find((x) => x.id === id)
  if (!c) return project
  const delta = { x: to.x - c.sch.x, y: to.y - c.sch.y }
  if (!delta.x && !delta.y) return project
  const f = partFollowers(project, [id])
  const comps = [id, ...f.components]
  return moveSchematicItems(project, { components: comps, labels: f.labels, wires: f.wires }, delta, findRubberBands(project, comps, f.labels, f.wires))
}

/**
 * What a drag of the picked items moves and stretches: the picked parts take along what hangs off
 * their pins alone (`partFollowers`), and the wires attached to them are rubber bands. Hand the
 * result to `moveSchematicItems`.
 */
export function dragPlan(project: Project, picked: { components: string[]; labels: string[]; wires: string[] }) {
  const follow = partFollowers(project, picked.components)
  const ids = {
    components: [...new Set([...picked.components, ...follow.components])],
    labels: [...new Set([...picked.labels, ...follow.labels])],
    wires: [...new Set([...picked.wires, ...follow.wires])],
  }
  return { ids, bands: findRubberBands(project, ids.components, ids.labels, ids.wires) }
}

/** A change of how a symbol lies on the sheet: a quarter turn counter-clockwise on screen, or a mirror, both about the symbol's origin. */
export type Reorient = { kind: "turn"; by: Rotation } | { kind: "mirror"; axis: Mirror }

/** Where a point lies after the symbol is turned or mirrored, about `centre`. */
function reorientPoint(p: Vec2, centre: Vec2, w: Reorient): Vec2 {
  const d = { x: p.x - centre.x, y: p.y - centre.y }
  const r = w.kind === "turn" ? rotate90(d, w.by) : w.axis === "x" ? { x: d.x, y: -d.y } : { x: -d.x, y: d.y }
  return { x: round(centre.x + r.x), y: round(centre.y + r.y) }
}

/**
 * The turn and mirror a placement has after a change on the sheet is made to it. A turn is
 * counter-clockwise on screen whatever the mirror (the symbol's own turn runs the other way once it is mirrored);
 * mirroring one way and then the other is a half turn.
 */
export function composeOrientation(o: { rot: Rotation; mirror?: Mirror }, w: Reorient): { rot: Rotation; mirror?: Mirror } {
  const rot = (a: number) => ((((a % 360) + 360) % 360) as Rotation)
  // `mirror: undefined` is said, not left out, so that merging it into a placement takes the old mirror away.
  if (w.kind === "turn") return o.mirror ? { rot: rot(o.rot - w.by), mirror: o.mirror } : { rot: rot(o.rot + w.by), mirror: undefined }
  if (!o.mirror) return { rot: o.rot, mirror: w.axis }
  if (o.mirror === w.axis) return { rot: o.rot, mirror: undefined }
  return { rot: rot(o.rot + 180), mirror: undefined }
}

/**
 * A symbol's own fields turn and mirror with it: their anchors are in the symbol's frame (`SCH_FIELD::GetPosition`),
 * so on the sheet each goes where the change puts it. The angle and justification are the symbol's and stay.
 */
function reorientFields(fields: ComponentInstance["fields"], w: Reorient): ComponentInstance["fields"] {
  if (!fields) return fields
  const move = (p: Vec2): Vec2 => {
    const r = w.kind === "turn" ? rotate90(p, w.by) : w.axis === "x" ? { x: p.x, y: -p.y } : { x: -p.x, y: p.y }
    // To the six places a field's anchor is kept to, not the four a part's place is.
    return { x: round(r.x, 6), y: round(r.y, 6) }
  }
  return Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, { ...f, ...move({ x: f.x, y: f.y }) }]))
}

/** The label's turn after the sheet is mirrored: the way its flag points is reflected. */
const mirrorLabelRot = (rot: Rotation, axis: Mirror): Rotation => ((((axis === "x" ? -rot : 180 - rot) % 360) + 360) % 360) as Rotation

/**
 * Turn or mirror one part. Its stubs go with it, and wires that reach other things stay attached to
 * its pins. The part's own placement is composed with the change (`composeOrientation`).
 */
export function reorientComponent(project: Project, id: string, w: Reorient, conn?: SchematicConnectivity): Project {
  const c = project.components.find((x) => x.id === id)
  if (!c) return project
  const stubs = partFollowers(project, [id])
  const digits = kicadRulesShown(project) ? 6 : 4
  const oldPins = schematicPins(c)
  let moved = updateComponent(project, id, { sch: composeOrientation(c.sch, w), ...(c.fields ? { fields: reorientFields(c.fields, w) } : {}) })
  const newPins = new Map(schematicPins(moved.components.find((x) => x.id === id)!).map((p) => [p.pin, p]))
  const around = (p: Vec2): Vec2 => reorientPoint(p, c.sch, w)
  // Power symbols on the part's pins turn about the part too, so each pin of theirs lands where the change puts it.
  for (const sid of stubs.components) {
    const sym = moved.components.find((x) => x.id === sid)
    const pin = sym && schematicPins(sym)[0]
    if (!sym || !pin) continue
    const to = around(pin.pos)
    const turned = updateComponent(moved, sid, { sch: composeOrientation(sym.sch, w), ...(sym.fields ? { fields: reorientFields(sym.fields, w) } : {}) })
    const now = schematicPins(turned.components.find((x) => x.id === sid)!)[0]
    moved = updateComponent(turned, sid, { sch: { x: round(sym.sch.x + to.x - now.pos.x, digits), y: round(sym.sch.y + to.y - now.pos.y, digits) } })
  }
  const stubWires = new Set(stubs.wires)
  const stubLabels = new Set(stubs.labels)
  const newPosOf = (p: Vec2) => {
    const pin = oldPins.find((q) => samePoint(q.pos, p))
    return pin ? newPins.get(pin.pin) : undefined
  }
  const wires = moved.wires.map((wire) => {
    if (stubWires.has(wire.id)) {
      // On a sheet joined by KiCad's rules an end on a pin is put on the pin where it now is, not on its own rounding of the old place.
      return { ...wire, points: wire.points.map((p) => (digits > 4 ? (newPosOf(p)?.pos ?? around(p)) : around(p))) }
    }
    // The far end first, so the near end keeps index 0 when a bend is added.
    let points = wire.points
    const tail = newPosOf(wire.points[wire.points.length - 1])
    if (tail && !samePoint(points[points.length - 1], tail.pos)) points = stretchEnd(points, points.length - 1, tail.pos, digits > 4)
    const head = newPosOf(wire.points[0])
    if (head && !samePoint(points[0], head.pos)) points = stretchEnd(points, 0, head.pos, digits > 4)
    return points === wire.points ? wire : { ...wire, points }
  })
  const labels = moved.labels.map((l) => {
    if (!stubLabels.has(l.id)) return l
    const pin = newPosOf(l)
    if (pin) {
      const d = dirVector(pin.dir)
      return { ...l, x: pin.pos.x, y: pin.pos.y, rot: (d.x > 0 ? 0 : d.y > 0 ? 90 : d.x < 0 ? 180 : 270) as Rotation }
    }
    const at = around(l)
    return { ...l, x: at.x, y: at.y, rot: w.kind === "turn" ? (((l.rot + w.by) % 360) as Rotation) : mirrorLabelRot(l.rot, w.axis) }
  })
  // A wire that was stretched to the changed pin may have left behind a label in its middle, or the
  // end of a wire that tees into it: put those back on it, as a move does.
  const kept = reseat(project, { components: moved.components, wires: simplifyChanged(project.wires, wires), labels }, stubWires, stubLabels, { x: 0, y: 0 }, conn, digits)
  const bridges = bridgePinContacts(project, moved.components, new Set([id, ...stubs.components]))
  return settleKicadSheet(project, { ...moved, wires: [...kept.wires, ...bridges], labels: kept.labels, updatedAt: Date.now() })
}

/**
 * Give a part another definition (`create_part`'s `replaces`: a corrected symbol, its pins by the same numbers) and keep its wiring on
 * its pins by number. What hangs off one pin alone (a stub to a net label, a power symbol on the pin) moves with that pin, a label
 * or power symbol right on a pin goes to where the pin now is, and a wire that ends on a pin is stretched to it. A fragment that
 * hangs off several of its pins that move apart (a comb of supply pins) has its ends stretched instead. A pin number the new
 * definition lacks keeps nothing: what was on it stays where it was, and `pinsLeft` names it.
 */
export function switchPart(project: Project, id: string, patch: { partId: string; footprint: string }, conn?: SchematicConnectivity): Project {
  const c = project.components.find((x) => x.id === id)
  if (!c) return project
  const digits = kicadRulesShown(project) ? 6 : 4
  const switched = updateComponent(project, id, patch)
  const now = switched.components.find((x) => x.id === id)!
  // Pins that share a number pair up in the order each symbol lists them.
  const fresh = new Map<string, WorldPin[]>()
  for (const p of schematicPins(now)) fresh.set(p.pin, [...(fresh.get(p.pin) ?? []), p])
  const taken = new Map<string, number>()
  const moves = new Map<number, { from: Vec2; to: WorldPin }>()
  for (const p of schematicPins(c)) {
    const k = taken.get(p.pin) ?? 0
    taken.set(p.pin, k + 1)
    const to = fresh.get(p.pin)?.[k]
    if (to && !samePoint(to.pos, p.pos) && !moves.has(pointKey(p.pos))) moves.set(pointKey(p.pos), { from: p.pos, to })
  }
  if (!moves.size) return switched

  const fr = fragmentsOf(project)
  const deltaOf = (m: { from: Vec2; to: WorldPin }): Vec2 => ({ x: m.to.pos.x - m.from.x, y: m.to.pos.y - m.from.y })
  const othersAt = (k: number) => (fr.pinComps.get(k) ?? []).some((o) => o !== id)
  // The fragments that are the part's own, each with the one shift its pins give it; one its pins pull apart is null.
  const shift = new Map<number, Vec2 | null>()
  for (const k of fr.compKeys.get(id) ?? []) {
    const m = moves.get(k)
    const d = m ? deltaOf(m) : { x: 0, y: 0 }
    for (const o of fr.ownersAt.get(k) ?? []) {
      const r = fr.root[o]
      if ([...(fr.touching.get(r) ?? [])].some((x) => x !== id)) continue
      const had = shift.get(r)
      shift.set(r, had === undefined ? d : had && samePoint(had, d) ? had : null)
    }
  }
  const by = (p: Vec2, d: Vec2): Vec2 => ({ x: round(p.x + d.x, digits), y: round(p.y + d.y, digits) })
  const carriedWires = new Map<string, Vec2>()
  const carriedLabels = new Map<string, Vec2>()
  const carriedSymbols = new Map<string, Vec2>()
  for (const [r, d] of shift) {
    if (!d || (!d.x && !d.y)) continue
    const m = fr.members.get(r)
    m?.wires.forEach((w) => carriedWires.set(w, d))
    m?.labels.forEach((l) => carriedLabels.set(l, d))
    m?.symbols.forEach((s) => carriedSymbols.set(s, d))
  }
  // What sits right on a moving pin, and on no other part's, goes to it.
  const onPin = new Map<string, WorldPin>()
  for (const [k, m] of moves) {
    if (othersAt(k)) continue
    for (const l of fr.labelsAt.get(k) ?? []) if (!carriedLabels.has(l)) onPin.set(l, m.to)
    for (const s of fr.symbolsAt.get(k) ?? []) if (!carriedSymbols.has(s)) carriedSymbols.set(s, deltaOf(m))
  }

  const components = switched.components.map((x) => {
    const d = carriedSymbols.get(x.id)
    return d ? { ...x, sch: { ...x.sch, x: round(x.sch.x + d.x, digits), y: round(x.sch.y + d.y, digits) } } : x
  })
  const wires = project.wires.map((w) => {
    const d = carriedWires.get(w.id)
    if (d) return { ...w, points: w.points.map((p) => by(p, d)) }
    if (w.points.length < 2) return w
    // The far end first, so the near end keeps index 0 when a bend is added.
    let points = w.points
    const tail = moves.get(pointKey(points[points.length - 1]))
    if (tail && !othersAt(pointKey(tail.from))) points = stretchEnd(points, points.length - 1, tail.to.pos, digits > 4)
    const head = moves.get(pointKey(points[0]))
    if (head && !othersAt(pointKey(head.from))) points = stretchEnd(points, 0, head.to.pos, digits > 4)
    return points === w.points ? w : { ...w, points }
  })
  const labels = project.labels.map((l) => {
    const d = carriedLabels.get(l.id)
    if (d) return { ...l, ...by(l, d) }
    const pin = onPin.get(l.id)
    if (!pin) return l
    const v = dirVector(pin.dir)
    return { ...l, x: pin.pos.x, y: pin.pos.y, rot: (v.x > 0 ? 0 : v.y > 0 ? 90 : v.x < 0 ? 180 : 270) as Rotation }
  })
  const kept = reseat(project, { components, wires: simplifyChanged(project.wires, wires), labels }, new Set(carriedWires.keys()), new Set([...carriedLabels.keys(), ...onPin.keys()]), { x: 0, y: 0 }, conn, digits)
  const bridges = bridgePinContacts(project, components, new Set([id, ...carriedSymbols.keys()]))
  return settleKicadSheet(project, { ...switched, components, wires: [...kept.wires, ...bridges], labels: kept.labels, updatedAt: Date.now() })
}

/** The pins of `before`'s part that something was wired to and that `after`'s definition has no number for, as numbers. */
export function pinsLeft(before: ComponentInstance, after: ComponentInstance, conn: SchematicConnectivity): string[] {
  const kept = new Set(schematicPins(after).map((p) => p.pin))
  return [...new Set(schematicPins(before).map((p) => p.pin))].filter((n) => !kept.has(n) && conn.pinNet.has(`${before.id}:${n}`))
}

/** Turn one part to `rot`. Its stubs turn with it; wires that reach other things stay attached to its pins. */
export function rotateComponent(project: Project, id: string, rot: Rotation, conn?: SchematicConnectivity): Project {
  const c = project.components.find((x) => x.id === id)
  if (!c || c.sch.rot === rot) return project
  // On screen the part turns the other way once it is mirrored: its own turn went from `c.sch.rot` to `rot`.
  const own = (rot - c.sch.rot + 360) % 360
  const by = (c.sch.mirror ? (360 - own) % 360 : own) as Rotation
  return reorientComponent(project, id, { kind: "turn", by }, conn)
}

/** Mirror one part: `x` flips it top to bottom, `y` left to right. Its stubs go with it, and wires that reach other things stay on its pins. */
export function mirrorComponent(project: Project, id: string, axis: Mirror, conn?: SchematicConnectivity): Project {
  return reorientComponent(project, id, { kind: "mirror", axis }, conn)
}

/**
 * Pins that touched another part's pin directly, where one part moved or turned and the other
 * didn't: a short wire joins them again, as a wire end on the pin would have followed it. A power
 * symbol set right on a pin (as Tidy draws them) or two parts pin to pin have no wire to stretch,
 * so without this any move of either cut the pin off its net. KiCad's drag does the same. The wire
 * leaves the pin that stayed and bends once, along the longer way first; if it crosses another
 * net, the check after the edit refuses it as it would any other wire.
 */
export function bridgePinContacts(before: Project, after: ComponentInstance[], moved: ReadonlySet<string>): Wire[] {
  const keyOf = (p: Vec2) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
  const stayed = new Map<string, Vec2>()
  for (const c of before.components) if (!moved.has(c.id)) for (const pin of schematicPins(c)) stayed.set(keyOf(pin.pos), pin.pos)
  if (!stayed.size) return []
  const now = new Map(after.filter((c) => moved.has(c.id)).map((c) => [c.id, c]))
  const out: Wire[] = []
  for (const c of before.components) {
    const moving = moved.has(c.id) ? now.get(c.id) : undefined
    if (!moving) continue
    const to = new Map(schematicPins(moving).map((pin) => [pin.pin, pin.pos]))
    for (const pin of schematicPins(c)) {
      const at = stayed.get(keyOf(pin.pos))
      const there = to.get(pin.pin)
      if (!at || !there || samePoint(at, there)) continue
      const corner = Math.abs(there.x - at.x) >= Math.abs(there.y - at.y) ? { x: there.x, y: at.y } : { x: at.x, y: there.y }
      const points = [at, corner, there].filter((p, i, all) => i === 0 || !samePoint(p, all[i - 1]))
      out.push({ id: uid("w"), points })
    }
  }
  return out
}

/** Pins of moving components / labels that drag wire endpoints with them. */
export interface RubberBand {
  wireId: string
  endIndex: number
}

export function findRubberBands(project: Project, componentIds: string[], labelIds: string[], wireIds: string[]): RubberBand[] {
  const moving = new Set(wireIds)
  const comps = new Set(componentIds)
  const labelSet = new Set(labelIds)
  // Points are rounded to four places wherever they are made, so equal points have equal keys.
  const keyOf = (p: Vec2) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
  const anchors = new Set<string>()
  for (const c of project.components) if (comps.has(c.id)) for (const pin of schematicPins(c)) anchors.add(keyOf(pin.pos))
  for (const l of project.labels) if (labelSet.has(l.id)) anchors.add(keyOf(l))
  const out: RubberBand[] = []
  const banded = new Set<string>()
  const band = (w: Wire, endIndex: number) => {
    out.push({ wireId: w.id, endIndex })
    banded.add(`${w.id}:${endIndex}`)
  }
  for (const w of project.wires) {
    if (moving.has(w.id) || w.points.length < 2) continue
    const last = w.points.length - 1
    for (const endIndex of [0, last]) {
      if (anchors.has(keyOf(w.points[endIndex]))) band(w, endIndex)
    }
  }
  // A wire that is carried whole, or has both its ends on the part, goes where the part goes. A wire
  // that ends on it (a T) must follow, or it is cut loose; and that wire may in turn carry others.
  const whole = new Set(moving)
  for (const w of project.wires) if (!moving.has(w.id) && w.points.length >= 2 && banded.has(`${w.id}:0`) && banded.has(`${w.id}:${w.points.length - 1}`)) whole.add(w.id)
  for (let grew = true; grew; ) {
    grew = false
    const carried = new SpatialHash<{ a: Vec2; b: Vec2 }>()
    for (const x of project.wires) {
      if (!whole.has(x.id)) continue
      for (let i = 1; i < x.points.length; i++) carried.insert({ a: x.points[i - 1], b: x.points[i] }, normBox(x.points[i - 1], x.points[i]))
    }
    for (const w of project.wires) {
      if (whole.has(w.id) || w.points.length < 2) continue
      const last = w.points.length - 1
      for (const endIndex of [0, last]) {
        if (banded.has(`${w.id}:${endIndex}`)) continue
        const p = w.points[endIndex]
        if (carried.query(pointBox(p, 1e-3)).some((sg) => pointOnSegment(p, sg.a, sg.b))) band(w, endIndex)
      }
      if (banded.has(`${w.id}:0`) && banded.has(`${w.id}:${last}`)) {
        whole.add(w.id)
        grew = true
      }
    }
  }
  return out
}

/**
 * Move one end of a wire to `to`, bending the wire so it stays orthogonal. `exact` is for a sheet joined by KiCad's rules (S11): its wires keep KiCad's points, so a wire
 * that is off true by what the editor's four digits put on a pin (a wire from a pin to a T that is at six digits) is still the straight wire it was drawn as, and the
 * neighbour of the end moves by the end's own step rather than to the end's place, so a point that other wires meet is never moved by a rounding.
 */
export function stretchEnd(points: Vec2[], e: number, to: Vec2, exact = false): Vec2[] {
  const last = points.length - 1
  const pts = points.map((p) => ({ ...p }))
  const nIdx = e === 0 ? 1 : last - 1
  const orig = points[e]
  const neighbor = points[nIdx]
  const eps = exact ? 1e-4 : 1e-6
  const wasHorizontal = Math.abs(orig.y - neighbor.y) < eps
  pts[e] = to
  if (pts.length === 2) {
    const a = pts[e]
    const b = pts[nIdx]
    if (Math.abs(a.x - b.x) > eps && Math.abs(a.y - b.y) > eps) {
      const mid = wasHorizontal
        ? [{ x: round((a.x + b.x) / 2), y: a.y }, { x: round((a.x + b.x) / 2), y: b.y }]
        : [{ x: a.x, y: round((a.y + b.y) / 2) }, { x: b.x, y: round((a.y + b.y) / 2) }]
      const seq = [a, ...mid, b]
      return e === 0 ? seq : seq.reverse()
    }
    return pts
  }
  if (exact) pts[nIdx] = wasHorizontal ? { x: neighbor.x, y: round(neighbor.y + to.y - orig.y, 6) } : { x: round(neighbor.x + to.x - orig.x, 6), y: neighbor.y }
  else if (wasHorizontal) pts[nIdx] = { x: neighbor.x, y: pts[e].y }
  else pts[nIdx] = { x: pts[e].x, y: neighbor.y }
  // The segment beyond the neighbour ran the same way as the end's (a wire with a redundant corner on
  // a straight run): moving the neighbour would leave it slanted, so it gets a bend of its own.
  const next = points[e === 0 ? nIdx + 1 : nIdx - 1]
  const moved = pts[nIdx]
  const slanted = Math.abs(moved.x - next.x) > eps && Math.abs(moved.y - next.y) > eps
  const wasStraight = Math.abs(neighbor.x - next.x) < eps || Math.abs(neighbor.y - next.y) < eps
  if (slanted && wasStraight) pts.splice(e === 0 ? nIdx + 1 : nIdx, 0, wasHorizontal ? { x: neighbor.x, y: next.y } : { x: next.x, y: neighbor.y })
  return pts
}

/**
 * Move schematic items by `delta`, stretching attached wires orthogonally, then put back on the
 * net what sat on a wire that was reshaped (`reseat`). `conn` is the connectivity of `base`
 * when the caller has it; `reseat: false` stops after the stretch. Drawings just move.
 */
export function moveSchematicItems(
  base: Project,
  ids: { components: string[]; labels: string[]; wires: string[]; drawings?: string[] },
  delta: Vec2,
  bands: RubberBand[],
  conn?: SchematicConnectivity,
  options: { reseat?: boolean } = {},
): Project {
  const d = { x: round(delta.x), y: round(delta.y) }
  // S11: a sheet joined by KiCad's rules has its points at six digits (KiCad's own), and joins what is at an equal point, so a point moved is kept to six, not rounded to four.
  const digits = kicadRulesShown(base) ? 6 : 4
  const comps = new Set(ids.components)
  const labels = new Set(ids.labels)
  const wires = new Set(ids.wires)
  const drawings = new Set(ids.drawings)
  const bandsByWire = new Map<string, number[]>()
  for (const b of bands) bandsByWire.set(b.wireId, [...(bandsByWire.get(b.wireId) ?? []), b.endIndex])

  const shift = (p: Vec2): Vec2 => ({ x: round(p.x + d.x, digits), y: round(p.y + d.y, digits) })

  const stretched = base.wires.map((w) => {
    if (wires.has(w.id)) return { ...w, points: w.points.map(shift) }
    const ends = bandsByWire.get(w.id)
    if (!ends) return w
    const last = w.points.length - 1
    if (ends.includes(0) && ends.includes(last)) return { ...w, points: w.points.map(shift) }
    return { ...w, points: stretchEnd(w.points, ends[0], shift(w.points[ends[0]]), digits > 4) }
  })
  // A wire stretched into a hook, or doubled back on itself, is simplified before what sat on it is put back.
  const newWires = simplifyChanged(base.wires, stretched)
  const newLabels = base.labels.map((l) => (labels.has(l.id) ? { ...l, ...shift(l) } : l))
  const components = base.components.map((c) => (comps.has(c.id) ? { ...c, sch: { ...c.sch, ...shift(c.sch) } } : c))
  const kept = options.reseat === false ? { wires: newWires, labels: newLabels } : reseat(base, { components, wires: newWires, labels: newLabels }, wires, labels, d, conn, digits)
  // Pins that were on another part's pin, with nothing to stretch between them, get a wire.
  const bridges = bridgePinContacts(base, components, comps)

  return settleKicadSheet(base, {
    ...base,
    updatedAt: Date.now(),
    components,
    labels: kept.labels,
    wires: [...kept.wires, ...bridges],
    ...(drawings.size > 0 && base.drawings && { drawings: base.drawings.map((x) => (drawings.has(x.id) ? moveDrawing(x, d) : x)) }),
  })
}

const onPath = (points: Vec2[], p: Vec2) => points.some((q, i) => i > 0 && pointOnSegment(p, points[i - 1], q))

/** The point of the segment a-b nearest to `p`. */
function nearestOnSegment(a: Vec2, b: Vec2, p: Vec2, digits = 4): Vec2 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return { x: round(a.x + dx * t, digits), y: round(a.y + dy * t, digits) }
}

/** What a sheet has where, indexed once per sheet: a drag asks it again on every frame. */
interface SheetIndex {
  segments: SpatialHash<{ id: string; a: Vec2; b: Vec2 }>
  /** Wire ends and net labels. */
  points: SpatialHash<{ kind: "end" | "label"; id: string; end: 0 | 1; p: Vec2 }>
  pins: SpatialHash<{ comp: string; key: string; pos: Vec2 }>
  order: Map<string, number>
  labelOrder: Map<string, number>
}
const sheetIndexes = new WeakMap<Project, SheetIndex>()
const baseConnectivity = new WeakMap<Project, SchematicConnectivity>()

function sheetIndex(base: Project): SheetIndex {
  const hit = sheetIndexes.get(base)
  if (hit) return hit
  const ix: SheetIndex = {
    segments: new SpatialHash(),
    points: new SpatialHash(),
    pins: new SpatialHash(),
    order: new Map(base.wires.map((w, i) => [w.id, i])),
    labelOrder: new Map(base.labels.map((l, i) => [l.id, i])),
  }
  for (const w of base.wires) {
    for (let i = 1; i < w.points.length; i++) ix.segments.insert({ id: w.id, a: w.points[i - 1], b: w.points[i] }, normBox(w.points[i - 1], w.points[i]))
    if (w.points.length >= 2) {
      ix.points.insert({ kind: "end", id: w.id, end: 0, p: w.points[0] }, pointBox(w.points[0]))
      ix.points.insert({ kind: "end", id: w.id, end: 1, p: w.points[w.points.length - 1] }, pointBox(w.points[w.points.length - 1]))
    }
  }
  for (const l of base.labels) ix.points.insert({ kind: "label", id: l.id, end: 0, p: l }, pointBox(l))
  for (const c of base.components) for (const pin of schematicPins(c)) ix.pins.insert({ comp: c.id, key: `${c.id}:${pin.pin}`, pos: pin.pos }, pointBox(pin.pos))
  sheetIndexes.set(base, ix)
  return ix
}

/**
 * After a move or a turn reshaped some wires: whatever sat on one of them and is no longer on it
 * (a net label in the middle of the wire, the end of a wire that tees into it) is put back on the
 * net, so it keeps its name and its pins. A label or tee goes where the same stretch of wire went,
 * or else to the nearest point of the new route, but only to a place where it touches nothing of
 * another net, and a wire end is never pulled off a pin that stays. Where there is no such place,
 * or the item is still held by another wire it sat on (a crossing), it stays and a short wire is
 * drawn from it to the wire it lost. If even that would touch another net, it is left alone, and
 * the check that follows a move says what that cost. `carried` are the wires and labels that moved
 * whole; `conn` is the connectivity of `base`, which is worked out here when it is not at hand.
 */
function reseat(
  base: Project,
  after: { components: ComponentInstance[]; wires: Wire[]; labels: NetLabel[] },
  carried: Set<string>,
  carriedLabels: Set<string>,
  d: Vec2,
  conn?: SchematicConnectivity,
  digits = 4,
): { wires: Wire[]; labels: NetLabel[] } {
  if (!after.wires.some((w, i) => w !== base.wires[i])) return { wires: after.wires, labels: after.labels }
  const ix = sheetIndex(base)
  let nets = conn
  const net = () => {
    if (!nets) {
      nets = baseConnectivity.get(base) ?? computeConnectivity(base)
      baseConnectivity.set(base, nets)
    }
    return nets
  }
  const out = [...after.wires]
  const outLabels = [...after.labels]
  const added: Wire[] = []
  const changed = new Set<string>()
  out.forEach((w, i) => w !== base.wires[i] && changed.add(w.id))
  const movedLabels = new Set<string>()
  outLabels.forEach((l, i) => l !== base.labels[i] && movedLabels.add(l.id))
  const movingPins = new Map<string, Vec2>()
  const movingComps = new Set<string>()
  after.components.forEach((c, i) => {
    if (c === base.components[i]) return
    movingComps.add(c.id)
    for (const pin of schematicPins(c)) movingPins.set(`${c.id}:${pin.pin}`, pin.pos)
  })
  const wireNow = (id: string) => out[ix.order.get(id)!]
  const netOfWire = (id: string) => net().wireNet.get(id) ?? `wire:${id}`
  const shifted = (p: Vec2): Vec2 => ({ x: round(p.x + d.x, digits), y: round(p.y + d.y, digits) })

  const hostsOf = (p: Vec2, except?: string): string[] => {
    const ids = new Set<string>()
    for (const sg of ix.segments.query(pointBox(p, 1e-3))) if (sg.id !== except && pointOnSegment(p, sg.a, sg.b)) ids.add(sg.id)
    return [...ids].sort((x, y) => ix.order.get(x)! - ix.order.get(y)!)
  }
  const stationaryPinAt = (p: Vec2) => ix.pins.query(pointBox(p, 1e-3)).some((pn) => !movingComps.has(pn.comp) && samePoint(pn.pos, p))

  /** Whether something of a net other than `own` lies at `p` (a pin, a wire, an end, a label), as the sheet stands now. */
  const foreignAt = (p: Vec2, own: string): boolean => {
    const box = pointBox(p, 1e-3)
    for (const pn of ix.pins.query(box)) if (!movingComps.has(pn.comp) && samePoint(pn.pos, p) && net().pinNet.get(pn.key) !== own) return true
    for (const [key, pos] of movingPins) if (samePoint(pos, p) && net().pinNet.get(key) !== own) return true
    for (const s of ix.segments.query(box)) {
      if (!changed.has(s.id) && pointOnSegment(p, s.a, s.b) && netOfWire(s.id) !== own) return true
    }
    for (const id of changed) if (onPath(wireNow(id).points, p) && netOfWire(id) !== own) return true
    for (const it of ix.points.query(box)) {
      if (it.kind === "label" && !movedLabels.has(it.id) && samePoint(it.p, p) && net().labelNet.get(it.id) !== own) return true
    }
    for (const id of movedLabels) {
      const l = outLabels[ix.labelOrder.get(id)!]
      if (samePoint(l, p) && net().labelNet.get(id) !== own) return true
    }
    return false
  }
  /** Whether a stretch of new wire from a to b has a pin, a wire end or a label of another net on it, or ends on another net. */
  const crossesForeign = (a: Vec2, b: Vec2, own: string): boolean => {
    if (foreignAt(a, own) || foreignAt(b, own)) return true
    const box = normBox(a, b)
    for (const pn of ix.pins.query(box)) if (!movingComps.has(pn.comp) && pointOnSegment(pn.pos, a, b) && net().pinNet.get(pn.key) !== own) return true
    for (const [key, pos] of movingPins) if (pointOnSegment(pos, a, b) && net().pinNet.get(key) !== own) return true
    for (const it of ix.points.query(box)) {
      if (!pointOnSegment(it.p, a, b)) continue
      if (it.kind === "label" ? !movedLabels.has(it.id) && net().labelNet.get(it.id) !== own : !changed.has(it.id) && netOfWire(it.id) !== own) return true
    }
    for (const id of changed) {
      const pts = wireNow(id).points
      if (netOfWire(id) === own || pts.length < 2) continue
      if (pointOnSegment(pts[0], a, b) || pointOnSegment(pts[pts.length - 1], a, b)) return true
    }
    for (const id of movedLabels) if (pointOnSegment(outLabels[ix.labelOrder.get(id)!], a, b) && net().labelNet.get(id) !== own) return true
    return false
  }
  const routeClear = (route: Vec2[], oldPoints: Vec2[] | null, own: string): boolean => {
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]
      const b = route[i]
      // Only what is new is judged: a wire that already passed over something keeps doing so.
      if (oldPoints && oldPoints.some((q, k) => k > 0 && ((samePoint(q, b) && samePoint(oldPoints[k - 1], a)) || (samePoint(q, a) && samePoint(oldPoints[k - 1], b))))) continue
      if (crossesForeign(a, b, own)) return false
    }
    return true
  }

  /** Where `p`, which sat on `old`, can go on `hostNow`: where the stretch of wire it sat on went, then the nearest points. */
  const spots = (p: Vec2, old: Vec2[], hostNow: Vec2[]): Vec2[] => {
    const along = shifted(p)
    const out: Vec2[] = []
    if (onPath(hostNow, along)) out.push(along)
    const at = old.findIndex((q, i) => i > 0 && pointOnSegment(p, old[i - 1], q))
    const near = (i: number) => (i >= 1 && i < hostNow.length ? [nearestOnSegment(hostNow[i - 1], hostNow[i], p, digits)] : [])
    // The same run first: the segments that stand where the one it sat on stood.
    for (const i of [at, at - 1, at + 1]) out.push(...near(i))
    const all: Vec2[] = []
    for (let i = 1; i < hostNow.length; i++) all.push(nearestOnSegment(hostNow[i - 1], hostNow[i], p, digits))
    all.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))
    out.push(...all)
    const seen = new Set<string>()
    return out.filter((q) => !seen.has(`${q.x},${q.y}`) && (seen.add(`${q.x},${q.y}`), true))
  }

  const jumpered = new Set<string>()
  const handle = (it: { kind: "end" | "label"; id: string; end: 0 | 1; p: Vec2 }): boolean => {
    const p = it.p
    let own: string
    let eIdx = 0
    if (it.kind === "end") {
      const w = wireNow(it.id)
      eIdx = it.end === 0 ? 0 : w.points.length - 1
      // An end that moved itself was stretched with its part.
      if (w.points.length < 2 || !samePoint(w.points[eIdx], p)) return false
      own = netOfWire(it.id)
    } else {
      const l = outLabels[ix.labelOrder.get(it.id)!]
      if (!samePoint(l, p)) return false
      own = net().labelNet.get(it.id) ?? `label:${it.id}`
    }
    const hosts = hostsOf(p, it.kind === "end" ? it.id : undefined)
    const lost = hosts.filter((h) => !onPath(wireNow(h).points, p))
    if (!lost.length) return false
    const held = hosts.length - lost.length
    const pinned = it.kind === "end" && stationaryPinAt(p)

    if (held === 0 && !pinned) {
      for (const h of lost) {
        for (const to of spots(p, base.wires[ix.order.get(h)!].points, wireNow(h).points)) {
          if (samePoint(to, p) || foreignAt(to, own)) continue
          if (it.kind === "label") {
            outLabels[ix.labelOrder.get(it.id)!] = { ...outLabels[ix.labelOrder.get(it.id)!], x: to.x, y: to.y }
            movedLabels.add(it.id)
            return true
          }
          const w = wireNow(it.id)
          const route = stretchEnd(w.points, eIdx, to, digits > 4)
          if (!routeClear(route, w.points, own)) continue
          out[ix.order.get(it.id)!] = { ...w, points: route }
          changed.add(it.id)
          return true
        }
      }
    }
    // It stays where it is, and a short wire joins it to each wire it lost.
    let did = false
    for (const h of lost) {
      const key = `${it.kind}:${it.id}:${it.end}:${h}`
      if (jumpered.has(key)) continue
      jumpered.add(key)
      const hostNow = wireNow(h).points
      const targets: Vec2[] = []
      for (let i = 1; i < hostNow.length; i++) targets.push(nearestOnSegment(hostNow[i - 1], hostNow[i], p, digits))
      targets.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))
      for (const to of targets) {
        if (samePoint(to, p)) continue
        const routes = [orthogonalElbow(p, to, true), orthogonalElbow(p, to, false)]
        const clear = routes.find((r) => routeClear(r, null, own))
        if (!clear) continue
        added.push({ id: uid("w"), points: simplifyPolyline(clear) })
        did = true
        break
      }
    }
    return did
  }

  for (let round_ = 0; round_ < 4; round_++) {
    let moved = false
    for (const hid of [...changed]) {
      const old = base.wires[ix.order.get(hid)!].points
      for (let i = 1; i < old.length; i++) {
        for (const it of ix.points.query(normBox(old[i - 1], old[i]))) {
          if (!pointOnSegment(it.p, old[i - 1], old[i])) continue
          if (it.kind === "end" ? it.id === hid || carried.has(it.id) : carriedLabels.has(it.id)) continue
          if (handle(it)) moved = true
        }
      }
    }
    if (!moved) break
  }
  return { wires: added.length ? [...out, ...added] : out, labels: outLabels }
}

/** The wires of `wires` that differ from `base`'s, simplified: a wire stretched into a hook or a doubled-back spur loses it. */
function simplifyChanged(base: Wire[], wires: Wire[]): Wire[] {
  return wires.map((w, i) => (w === base[i] ? w : { ...w, points: simplifyPolyline(w.points) }))
}

export function cleanupWires(project: Project): Project {
  return {
    ...project,
    wires: project.wires
      .map((w) => ({ ...w, points: simplifyPolyline(w.points) }))
      .filter((w) => w.points.length >= 2),
  }
}

/** Room kept between a new part and everything already drawn: two wire stubs with their labels. */
const SPOT_GAP = 2

/**
 * Next free schematic spot to the right of everything already drawn: parts, wires, label flags,
 * block frames and drawings.
 * Given the part, it is the part's left edge that clears the drawing, not its origin, so a wide
 * part does not land on its neighbour, and the gap leaves room for the labels of both.
 */
export function freeSchematicSpot(project: Project, part?: PartDef, rot: Rotation = 0): Vec2 {
  if (!project.components.length) return { x: 0, y: 0 }
  const box = emptyBox()
  const boxes = [...project.components.map((c) => schematicBounds(c)), ...blockFrames(project).map((f) => f.box), ...(project.drawings ?? []).map(drawingBounds)]
  for (const b of boxes) {
    expandBox(box, { x: b.minX, y: b.minY })
    expandBox(box, { x: b.maxX, y: b.maxY })
  }
  for (const w of project.wires) for (const p of w.points) expandBox(box, p)
  for (const l of project.labels) {
    const b = labelBox(l)
    expandBox(box, { x: b.minX, y: b.minY })
    expandBox(box, { x: b.maxX, y: b.maxY })
  }
  const left = part ? transformBox(symbolOf(part).bounds, { x: 0, y: 0 }, rot).minX : 0
  return { x: round(Math.ceil((box.maxX + SPOT_GAP - left) / SCH_GRID - 1e-6) * SCH_GRID), y: 0 }
}
