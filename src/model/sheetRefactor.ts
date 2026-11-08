import { round } from "../lib/geometry"
import { uid } from "../lib/id"
import { computeConnectivity, pinKey, type SchematicConnectivity } from "./connectivity"
import { dirVector, powerNetName, schematicBounds, schematicPins } from "./instances"
import { findPart } from "./library"
import { nextRef, partFollowers } from "./ops"
import { addSheet, addSheetPin, freeSheetSpot, NEW_SHEET_H, NEW_SHEET_W } from "./sheetOps"
import { centredOn, DEFAULT_PAPER, sheetDrawingBox } from "./paper"
import { ROOT_SHEET, copyKey, sheetIdOf, sheetView, symbolsOnSheet, syncCopies, useAt, useOf, usesOfSheet } from "./sheets"
import type { ComponentInstance, LabelKind, LabelShape, NetLabel, Project, Rotation, SheetSymbol, Vec2 } from "./types"

// Moving part of a sheet onto a sheet of its own, as Altium's "Move Selected Sub-Circuit to Different Sheet" does, with the sheet made for it
// and the connections kept: the selected parts (with what hangs off their pins alone, `partFollowers`), wires, labels and drawings go to a new
// sheet, a sheet symbol takes their place, and every net that ran between what moved and what stayed leaves the new sheet through a pin. Inside,
// a hierarchical label of the net's name stands where the drawing was cut (or a label that already named it becomes one); outside, the pin carries
// a label of that name, and so does each loose end the cut left. A net that a power symbol or a global label names crosses by that name instead,
// with a power symbol (or a global label) where it was cut. The result is checked pin for pin against the netlist before, and refused if anything
// differs. A sheet used more than once moves in every use alike.

export interface SheetSelection {
  components?: string[]
  wires?: string[]
  labels?: string[]
  drawings?: string[]
  blocks?: string[]
}

export type MoveToSheetResult =
  | {
      project: Project
      symbol: SheetSymbol
      /** The use of the new sheet, below the use it was made from. */
      path: string
      /** How many parts went, power symbols left out. */
      parts: number
      /** The names of the new sheet's pins. */
      pins: string[]
      /** The nets that cross by a global name (a power symbol or a global label) rather than a pin. */
      globals: string[]
    }
  | { error: string }

const GRID = 0.1
const PIN_STEP = 0.2
const snap = (v: number) => round(Math.round(v / GRID) * GRID, 4)
const pt = (p: Vec2) => `${round(p.x, 4)},${round(p.y, 4)}`
const isPort = (c: ComponentInstance) => !!findPart(c.partId)?.powerNet

/** Where something meets the drawing: a pin, a wire's point, a label, a sheet pin. `end` is a point that joins a wire's side (a pin, a label, a wire's end). */
type Node = { t: "pin"; key: string } | { t: "wire"; id: string } | { t: "label"; id: string } | { t: "sheetpin" }
interface Touch {
  at: Vec2
  node: Node
  end: boolean
  /** A place along a wire's side rather than one of its points: a label joins there, a pin does not. */
  side?: true
  /** The way out from what it is on: a pin's direction, a wire's last stretch. */
  away?: Vec2
}

/** A place where what moves and what stays met, on one net. */
interface Cut {
  at: Vec2
  net: string
  inner: Touch
  outer: Touch
}

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  const eps = 1e-4
  if (p.x < Math.min(a.x, b.x) - eps || p.x > Math.max(a.x, b.x) + eps || p.y < Math.min(a.y, b.y) - eps || p.y > Math.max(a.y, b.y) + eps) return false
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < eps) return false
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len < eps
}

const turnOf = (v: Vec2 | undefined): Rotation => (!v ? 0 : Math.abs(v.x) >= Math.abs(v.y) ? (v.x >= 0 ? 0 : 180) : v.y >= 0 ? 90 : 270)
const neg = (v: Vec2 | undefined) => (v ? { x: -v.x, y: -v.y } : undefined)
const unit = (a: Vec2, b: Vec2): Vec2 | undefined => {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  return d < 1e-9 ? undefined : { x: (b.x - a.x) / d, y: (b.y - a.y) / d }
}

/** The net of a node on a use of a sheet, as the connectivity has it. */
function netOf(conn: SchematicConnectivity, use: string, n: Node): string | undefined {
  if (n.t === "pin") return conn.pinNet.get(n.key)
  if (n.t === "wire") return conn.byUse?.wireNet.get(use)?.get(n.id) ?? conn.wireNet.get(n.id)
  if (n.t === "label") return conn.byUse?.labelNet.get(use)?.get(n.id) ?? conn.labelNet.get(n.id)
  return undefined
}

/** Every pin's net, as a partition: two projects connect alike when the same pins are together in both. A pin on no net is alone. */
function pinGroups(project: Project, conn: SchematicConnectivity): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of project.components) for (const p of schematicPins(c)) out.set(pinKey(c.id, p.pin), conn.pinNet.get(pinKey(c.id, p.pin)) ?? `alone:${pinKey(c.id, p.pin)}`)
  return out
}

/** The pins whose nets split or joined from `a` to `b`, by reference and pin. */
function connectionChanges(project: Project, a: Map<string, string>, b: Map<string, string>): string[] {
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const forward = new Map<string, string>()
  const backward = new Map<string, string>()
  const out: string[] = []
  for (const [k, x] of a) {
    const y = b.get(k)
    if (y === undefined) continue
    if ((forward.get(x) ?? y) !== y || (backward.get(y) ?? x) !== x) out.push(`${refOf.get(k.slice(0, k.lastIndexOf(":"))) ?? "?"}.${k.slice(k.lastIndexOf(":") + 1)}`)
    forward.set(x, y)
    backward.set(y, x)
  }
  return [...new Set(out)]
}

/** A name for a net nothing names, from its most telling pin as Tidy names one: `U1_OUT`. */
function nameFromPins(project: Project, pins: string[], taken: Set<string>): string {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const best = pins
    .map((k) => {
      const c = byId.get(k.slice(0, k.lastIndexOf(":")))
      const part = c && findPart(c.partId)
      if (!c || !part || part.powerNet) return null
      const pin = k.slice(k.lastIndexOf(":") + 1)
      const name = part.pins.find((p) => p.number === pin)?.name ?? pin
      return { ref: c.ref, pin, name, count: part.pins.length }
    })
    .filter((x): x is { ref: string; pin: string; name: string; count: number } => !!x)
    .sort((a, b) => Number(/^\d+$/.test(a.name)) - Number(/^\d+$/.test(b.name)) || b.count - a.count || a.ref.localeCompare(b.ref, undefined, { numeric: true }))[0]
  const base = (best ? `${best.ref}_${/^\d+$/.test(best.name) ? best.pin : best.name}` : "NET").replace(/[^A-Za-z0-9_+\-./]/g, "_")
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  taken.add(name)
  return name
}

/** Whether anything that stays is in a box (or a pin's length beyond it): a point, a wire through it, another sheet symbol. */
function crowded(box: { minX: number; minY: number; maxX: number; maxY: number }, points: Touch[], segs: { a: Vec2; b: Vec2 }[], symbols: SheetSymbol[]): boolean {
  const m = 0.3
  const b = { minX: box.minX - m, minY: box.minY - m, maxX: box.maxX + m, maxY: box.maxY + m }
  const inside = (p: Vec2) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
  if (points.some((t) => inside(t.at))) return true
  if (symbols.some((s) => s.x < b.maxX && s.x + s.w > b.minX && s.y < b.maxY && s.y + s.h > b.minY)) return true
  // A wire through the box with neither end in it: clip it to the box (Liang and Barsky).
  return segs.some(({ a, b: e }) => {
    let t0 = 0
    let t1 = 1
    const dx = e.x - a.x
    const dy = e.y - a.y
    for (const [p, q] of [
      [-dx, a.x - b.minX],
      [dx, b.maxX - a.x],
      [-dy, a.y - b.minY],
      [dy, b.maxY - a.y],
    ]) {
      if (p === 0) {
        if (q < 0) return false
        continue
      }
      const r = q / p
      if (p < 0) t0 = Math.max(t0, r)
      else t1 = Math.min(t1, r)
      if (t0 > t1) return false
    }
    return true
  })
}

/** A name for the new sheet that no other sheet on its parent has. */
function freeName(project: Project, sheet: string, base: string): string {
  const taken = new Set(symbolsOnSheet(project, sheet).map((s) => s.name.toLowerCase()))
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}${i}`
  return name
}

/**
 * The selection on the use of a sheet at `here` moved to a new sheet below it, as described above. `name` names the sheet (one selected block's
 * name when absent, else `Sheet`). Refused with a sentence when nothing that can move is selected or a connection would change.
 */
export function moveToNewSheet(project: Project, here: string, selection: SheetSelection, name?: string): MoveToSheetResult {
  const use = useAt(project, here)
  const path = use.path
  const sheet = use.sheet
  const view = sheetView(project, path)
  const viewIds = new Set(view.components.map((c) => c.id))
  const blocks = (view.blocks ?? []).filter((b) => selection.blocks?.includes(b.id))
  const picked = [...new Set([...(selection.components ?? []), ...blocks.flatMap((b) => b.components)])].filter((id) => viewIds.has(id))
  const byId = new Map(project.components.map((c) => [c.id, c]))
  if (!picked.some((id) => !isPort(byId.get(id)!))) return { error: "Select the parts to move to a new sheet first." }

  // What moves: the parts picked, what hangs off their pins alone, and the wires, labels and drawings picked.
  const follow = partFollowers(view, picked)
  const comps = new Set([...picked, ...follow.components])
  const has = <T extends { id: string }>(list: T[] | undefined) => new Set((list ?? []).map((x) => x.id))
  const viewWires = has(view.wires)
  const viewLabels = has(view.labels)
  const viewDrawings = has(view.drawings)
  const wires = new Set([...(selection.wires ?? []), ...follow.wires].filter((id) => viewWires.has(id)))
  const labels = new Set([...(selection.labels ?? []), ...follow.labels].filter((id) => viewLabels.has(id)))
  const drawings = new Set((selection.drawings ?? []).filter((id) => viewDrawings.has(id)))

  // Where what moves meets what stays, on the drawing as it is.
  const inside: Touch[] = []
  const outside: Touch[] = []
  for (const c of view.components) for (const p of schematicPins(c)) (comps.has(c.id) ? inside : outside).push({ at: p.pos, node: { t: "pin", key: pinKey(c.id, p.pin) }, end: true, away: dirVector(p.dir) })
  type Seg = { a: Vec2; b: Vec2; id: string }
  const insideSegs: Seg[] = []
  const outsideSegs: Seg[] = []
  for (const w of view.wires) {
    const mine = wires.has(w.id)
    w.points.forEach((q, i) => {
      const last = i === w.points.length - 1
      const end = i === 0 || last
      const from = i === 0 ? w.points[1] : w.points[i - 1]
      ;(mine ? inside : outside).push({ at: q, node: { t: "wire", id: w.id }, end, away: end && from ? unit(from, q) : undefined })
      if (!last) (mine ? insideSegs : outsideSegs).push({ a: q, b: w.points[i + 1], id: w.id })
    })
  }
  for (const l of view.labels) (labels.has(l.id) ? inside : outside).push({ at: { x: l.x, y: l.y }, node: { t: "label", id: l.id }, end: true })
  for (const s of symbolsOnSheet(project, sheet)) for (const p of s.pins) outside.push({ at: { x: p.x, y: p.y }, node: { t: "sheetpin" }, end: true, away: dirVector(p.rot === 0 ? "right" : p.rot === 90 ? "up" : p.rot === 180 ? "left" : "down") })

  const before = computeConnectivity(project)
  const cuts: Cut[] = []
  const outsideAt = new Map<string, Touch[]>()
  for (const o of outside) (outsideAt.get(pt(o.at)) ?? outsideAt.set(pt(o.at), []).get(pt(o.at))!).push(o)
  const insideAt = new Set(inside.map((t) => pt(t.at)))
  const cut = (inner: Touch, outer: Touch) => {
    const net = netOf(before, path, inner.node)
    const other = netOf(before, path, outer.node)
    // Only what was one net is a cut: a wire's end resting on another net's wire, on a sheet joined by KiCad's rules, joined nothing.
    if (!net || (other !== undefined && other !== net)) return
    cuts.push({ at: inner.at, net, inner, outer })
  }
  for (const t of inside) {
    const at = outsideAt.get(pt(t.at))
    if (at) for (const o of at) cut(t, o)
    else if (t.end) for (const s of outsideSegs) if (onSegment(t.at, s.a, s.b)) cut(t, { at: t.at, node: { t: "wire", id: s.id }, end: false, side: true })
  }
  for (const o of outside) {
    if (!o.end || insideAt.has(pt(o.at))) continue
    for (const s of insideSegs) if (onSegment(o.at, s.a, s.b)) cut({ at: o.at, node: { t: "wire", id: s.id }, end: false, side: true }, o)
  }

  // The new sheet, its symbol on this sheet (placed below, once its pins are known), and what moves put on it: the parts in every use of this sheet.
  const blockName = blocks.length === 1 ? blocks[0].name.trim() : ""
  const title = freeName(project, sheet, name?.trim() || blockName || "Sheet")
  const made = addSheet(project, path, { minX: 0, minY: 0, maxX: NEW_SHEET_W, maxY: NEW_SHEET_H }, title)
  const hid = made.symbol.id
  const sid = made.symbol.child
  const childPath = `${path}/${hid}`
  const parentRules = project.sheets?.find((s) => s.id === sheet)?.kicadRules
  const keys = new Set([...comps].map((id) => copyKey(byId.get(id)!)))
  const uses = new Set(usesOfSheet(project, sheet).map((u) => u.path))
  const moves = (c: ComponentInstance) => uses.has(useOf(c)) && keys.has(copyKey(c))
  const below = (inst: string) => `${inst}/${hid}`
  const toChild = <T extends { sheet?: string }>(x: T): T => ({ ...x, sheet: sid })
  const movedIds = new Set(project.components.filter(moves).map((c) => c.id))
  let next: Project = {
    ...made.project,
    sheets: made.project.sheets!.map((s) => (s.id === sid && parentRules ? { ...s, kicadRules: parentRules } : s)),
    components: made.project.components.map((c) => (moves(c) ? { ...c, inst: below(useOf(c)) } : c)),
    wires: made.project.wires.map((w) => (sheetIdOf(w) === sheet && wires.has(w.id) ? toChild(w) : w)),
    labels: made.project.labels.map((l) => (sheetIdOf(l) === sheet && labels.has(l.id) ? toChild(l) : l)),
  }
  if (made.project.drawings) next.drawings = made.project.drawings.map((d) => (sheetIdOf(d) === sheet && drawings.has(d.id) ? toChild(d) : d))
  if (made.project.blocks) {
    // A block whose parts all moved goes with them; the others keep the parts that stayed, and one left with none goes.
    const blocksNext = made.project.blocks.flatMap((b) => {
      const inst = b.inst ?? ""
      if (!uses.has(inst)) return [b]
      const gone = b.components.filter((id) => movedIds.has(id))
      if (!gone.length) return [b]
      if (gone.length === b.components.length) return [{ ...b, inst: below(inst) }]
      const left = b.components.filter((id) => !movedIds.has(id))
      return left.length ? [{ ...b, components: left }] : []
    })
    if (blocksNext.length) next.blocks = blocksNext
    else delete next.blocks
  }

  // The nets the move split, and how each crosses back.
  const moved = computeConnectivity(next)
  const groupsBefore = pinGroups(project, before)
  // The nets of this use of the sheet (the other uses of a sheet used twice split alike, and the same labels mend them).
  const hereNets = new Set<string>()
  for (const t of [...inside, ...outside]) {
    const n = netOf(before, path, t.node)
    if (n) hereNets.add(n)
  }
  const split = new Set<string>()
  {
    const seen = new Map<string, string>()
    for (const [k, net] of groupsBefore) {
      if (!hereNets.has(net)) continue
      const now = moved.pinNet.get(k) ?? `alone:${k}`
      const was = seen.get(net)
      if (was !== undefined && was !== now) split.add(net)
      else seen.set(net, now)
    }
    // A cut whose two sides are no longer one net splits it too, whatever pins it has: a wire to a label that names it, a sheet pin.
    for (const c of cuts) if (netOf(moved, childPath, c.inner.node) !== netOf(moved, path, c.outer.node)) split.add(c.net)
  }

  const netName = new Map(before.nets.map((n) => [n.id, n]))
  const nameAfter = new Map(moved.nets.map((n) => [n.id, n.name]))
  const afterName = (use: string, node: Node) => nameAfter.get(netOf(moved, use, node) ?? "")
  const taken = new Set([...project.labels.map((l) => l.name.trim()), ...before.nets.map((n) => n.name)])
  const local: LabelKind | undefined = project.netNames ? "local" : undefined
  const pinsWanted: { name: string; shape: LabelShape; kind: LabelKind | undefined; outsideAt: Vec2[] }[] = []
  const insideLabels: NetLabel[] = []
  const outsideLabels: NetLabel[] = []
  const converted = new Map<string, Partial<NetLabel>>()
  const ports: { at: Vec2; inst: string; sheet: string; name: string; away?: Vec2; side?: true }[] = []
  const globals: string[] = []
  const label = (sheetId: string, name: string, at: Vec2, rot: Rotation, kind: LabelKind | undefined, shape?: LabelShape): NetLabel => ({
    id: uid("l"),
    ...(sheetId !== ROOT_SHEET ? { sheet: sheetId } : {}),
    name,
    x: at.x,
    y: at.y,
    rot,
    ...(kind ? { kind } : {}),
    ...(shape && kind && kind !== "local" ? { shape } : {}),
  })
  const pinsOnNet = (net: string) => [...groupsBefore].filter(([, n]) => n === net).map(([k]) => k)
  for (const net of split) {
    const mine = cuts.filter((c) => c.net === net)
    const netLabels = (side: "in" | "out") => view.labels.filter((l) => (labels.has(l.id) === (side === "in")) && netOf(before, path, { t: "label", id: l.id }) === net)
    const inLabels = netLabels("in")
    const outLabels = netLabels("out")
    // A net a power symbol or a global label names crosses by that name.
    const port = project.components.find((c) => isPort(c) && !findPart(c.partId)?.powerLocal && before.pinNet.get(pinKey(c.id, schematicPins(c)[0]?.pin ?? "")) === net)
    const globalText = port ? powerNetName(port) : [...inLabels, ...outLabels].find((l) => l.kind === "global")?.name.trim()
    if (globalText) {
      globals.push(globalText)
      for (const c of mine) {
        if (afterName(childPath, c.inner.node) !== globalText) ports.push({ at: c.at, inst: childPath, sheet: sid, name: globalText, away: c.inner.away ?? neg(c.outer.away), side: c.inner.side })
        if (c.outer.node.t !== "sheetpin" && afterName(path, c.outer.node) !== globalText) ports.push({ at: c.at, inst: path, sheet, name: globalText, away: c.outer.away ?? neg(c.inner.away), side: c.outer.side })
      }
      continue
    }
    // The pin's name: a text both sides already had (that is how they were joined), else one of theirs, else the net's own, else one made from its pins.
    const inTexts = inLabels.map((l) => l.name.trim()).filter(Boolean)
    const outTexts = outLabels.map((l) => l.name.trim()).filter(Boolean)
    const n = netName.get(net)
    const own = n?.named ? (n.label?.text ?? n.name.replace(/^.*\//, "")) : undefined
    const pinName = inTexts.find((t) => outTexts.includes(t)) ?? outTexts[0] ?? inTexts[0] ?? own ?? nameFromPins(project, pinsOnNet(net), taken)
    // A net that left this sheet upwards through a hierarchical label still does, through one beside the new pin.
    const upward = inLabels.find((l) => l.kind === "hierarchical" && l.name.trim() === pinName)
    const shape = (upward ?? inLabels.find((l) => l.kind === "hierarchical"))?.shape ?? "bidirectional"
    const outsidePoints = [...mine.map((c) => c.at), ...outLabels.filter((l) => l.name.trim() === pinName).map((l) => ({ x: l.x, y: l.y }))]
    pinsWanted.push({ name: pinName, shape, kind: upward ? "hierarchical" : local, outsideAt: outsidePoints })
    const done = new Set<string>()
    for (const c of mine) {
      if (done.has(pt(c.at))) continue
      done.add(pt(c.at))
      insideLabels.push(label(sid, pinName, c.at, turnOf(c.inner.away ?? neg(c.outer.away)), "hierarchical", shape))
      // A loose end outside takes the name; the label at the new pin is what joins it there.
      outsideLabels.push(label(sheet, pinName, c.at, turnOf(c.outer.away ?? neg(c.inner.away)), local))
    }
    if (!mine.length) {
      // Joined by name alone: a label inside that had the name becomes the sheet's hierarchical label.
      const named = inLabels.find((l) => l.name.trim() === pinName)
      if (named && named.kind !== "hierarchical") converted.set(named.id, { kind: "hierarchical", shape })
      else if (!named) {
        const pin = pinsOnNet(net).find((k) => movedIds.has(k.slice(0, k.lastIndexOf(":"))))
        const c = pin && byId.get(pin.slice(0, pin.lastIndexOf(":")))
        const wp = c && schematicPins(c).find((p) => pinKey(c.id, p.pin) === pin)
        if (wp) insideLabels.push(label(sid, pinName, wp.pos, turnOf(dirVector(wp.dir)), "hierarchical", shape))
      }
    }
  }

  // The symbol: where the parts were, as tall as its busier edge needs, its pins on the side their nets go off to.
  const box = [...movedIds].filter((id) => viewIds.has(id) && !isPort(byId.get(id)!)).map((id) => schematicBounds(byId.get(id)!))
  const cx = (Math.min(...box.map((b) => b.minX)) + Math.max(...box.map((b) => b.maxX))) / 2
  const cy = (Math.min(...box.map((b) => b.minY)) + Math.max(...box.map((b) => b.maxY))) / 2
  const unique = new Map<string, (typeof pinsWanted)[number]>()
  for (const p of pinsWanted) {
    const was = unique.get(p.name)
    if (was) was.outsideAt.push(...p.outsideAt)
    else unique.set(p.name, { ...p, outsideAt: [...p.outsideAt] })
  }
  const sideOf = (p: (typeof pinsWanted)[number]) => (p.outsideAt.length && p.outsideAt.reduce((s, q) => s + q.x, 0) / p.outsideAt.length > cx ? "right" : "left")
  const left = [...unique.values()].filter((p) => sideOf(p) === "left")
  const right = [...unique.values()].filter((p) => sideOf(p) === "right")
  const meanY = (p: (typeof pinsWanted)[number]) => (p.outsideAt.length ? p.outsideAt.reduce((s, q) => s + q.y, 0) / p.outsideAt.length : cy)
  // Top to bottom as their nets are, so wires to them need not cross.
  left.sort((a, b) => meanY(b) - meanY(a))
  right.sort((a, b) => meanY(b) - meanY(a))
  const longest = (list: typeof left) => Math.max(0, ...list.map((p) => p.name.length))
  const w = Math.max(NEW_SHEET_W, snap(0.8 + 0.06 * (longest(left) + longest(right))))
  const h = Math.max(NEW_SHEET_H, snap((Math.max(left.length, right.length) + 1) * PIN_STEP))
  // Where the parts were, when nothing that stays is there: a pin of it on a wire that stays would join that wire's net, and a label left at a cut
  // under it could not be read. Else in free space beside everything.
  let x = snap(cx - w / 2)
  let y = snap(cy - h / 2)
  if (crowded({ minX: x, minY: y, maxX: x + w, maxY: y + h }, outside, outsideSegs, symbolsOnSheet(project, sheet))) {
    const spot = freeSheetSpot({ ...next, sheetSymbols: next.sheetSymbols!.filter((s) => s.id !== hid) }, path)
    x = spot.x
    y = spot.y
  }
  next = { ...next, sheetSymbols: next.sheetSymbols!.map((s) => (s.id === hid ? { ...s, x, y, w, h } : s)) }
  for (const p of left) next = addSheetPin(next, hid, p.name, p.shape, "left")
  for (const p of right) next = addSheetPin(next, hid, p.name, p.shape, "right")
  const symbol = next.sheetSymbols!.find((s) => s.id === hid)!
  for (const p of symbol.pins) {
    const want = unique.get(p.name)!
    outsideLabels.push(label(sheet, p.name, { x: p.x, y: p.y }, p.rot, want.kind, want.shape))
  }

  next = {
    ...next,
    labels: [...next.labels.map((l) => (converted.has(l.id) ? { ...l, ...converted.get(l.id) } : l)), ...insideLabels, ...outsideLabels],
  }
  // A net that crosses by a global name gets a power symbol like the one that names it where it was cut, on each side that lost it; along a wire's side,
  // where a pin would join nothing, or with no power symbol to copy, a global label of the name.
  const portDone = new Set<string>()
  for (const q of ports) {
    const k = `${q.inst}|${pt(q.at)}|${q.name}`
    if (portDone.has(k)) continue
    portDone.add(k)
    const model = !q.side && project.components.find((c) => isPort(c) && powerNetName(c) === q.name)
    if (model) {
      const at0 = { ...model, id: "", sch: { ...model.sch, x: 0, y: 0 } }
      const p0 = schematicPins(at0)[0]?.pos ?? { x: 0, y: 0 }
      const part = findPart(model.partId)!
      // A copy of the symbol, none of what makes the model one of its own: its use, its copy key, its variants.
      const { tpl: _tpl, variants: _variants, ...plain } = model
      void [_tpl, _variants]
      const copy: ComponentInstance = {
        ...plain,
        id: uid("c"),
        ref: nextRef(next, part.refPrefix),
        inst: q.inst || undefined,
        sch: { ...model.sch, x: round(q.at.x - p0.x, 6), y: round(q.at.y - p0.y, 6) },
        pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
      }
      if (!copy.inst) delete copy.inst
      next = { ...next, components: [...next.components, copy] }
    } else {
      next = { ...next, labels: [...next.labels, label(q.sheet, q.name, q.at, turnOf(q.away), "global", "passive")] }
    }
  }
  // The other uses of this sheet, and of the new one, get the power symbols placed here.
  if (ports.length) next = syncCopies(syncCopies(next, childPath), path)

  const changes = connectionChanges(next, groupsBefore, pinGroups(next, computeConnectivity(next)))
  if (changes.length) {
    const list = changes.slice(0, 4).join(", ")
    return { error: `Moving these to a new sheet would change the connections of ${list}${changes.length > 4 ? ` and ${changes.length - 4} more pins` : ""}, so nothing was moved. Select the wires between them too, or move fewer parts.` }
  }
  // The new sheet's page: A4 landscape about what moved onto it.
  const drawn = sheetDrawingBox(sheetView(next, childPath))
  next = { ...next, sheets: next.sheets!.map((s) => (s.id === sid ? { ...s, paper: drawn ? centredOn({ size: "A4" }, drawn) : DEFAULT_PAPER } : s)) }
  return {
    project: { ...next, updatedAt: Date.now() },
    symbol,
    path: childPath,
    parts: [...comps].filter((id) => !isPort(byId.get(id)!)).length,
    pins: symbol.pins.map((p) => p.name),
    globals: [...new Set(globals)],
  }
}
