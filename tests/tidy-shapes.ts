import { samePoint } from "../src/lib/geometry"
import { dirVector, schematicPins, type WorldPin } from "../src/model/instances"
import { addComponent, addLabel, addWire, wireRoute } from "../src/model/ops"
import type { Project, Vec2 } from "../src/model/types"

// The shapes Tidy draws around a part's supply pins, built directly so tests do not need
// Tidy: a power symbol right on a pin, a short wire from a pin to a symbol, and a comb (a spine
// joining several pins, with a tee to one symbol). Each starts from the plain
// drawing `connect` makes (a short stub to a net label on every pin) and swaps the label for a
// symbol, so the netlist does not change: a symbol is its rail's name, as a label is.

const round = (n: number) => Math.round(n * 10) / 10

/** The turn that makes a symbol's pin face a way, by symbol kind (a ground's faces up at 0, a rail's down). */
const ROT_FOR: Record<string, Record<WorldPin["dir"], 0 | 90 | 180 | 270>> = {
  ground: { up: 0, left: 90, down: 180, right: 270 },
  power: { down: 0, right: 90, up: 180, left: 270 },
}

/** A wire leaves a part's pin one way; the symbol it ends in has its own pin facing back the other way. */
const FACING: Record<WorldPin["dir"], WorldPin["dir"]> = { up: "down", down: "up", left: "right", right: "left" }

/** A power symbol (ground, or a rail by name) whose pin is at `pin`, the wire to it leaving its part in direction `leaving`. */
export function symbolAt(p: Project, net: string, pin: Vec2, leaving: WorldPin["dir"]): Project {
  const kind = net === "GND" ? "ground" : "power"
  const rot = ROT_FOR[kind][FACING[leaving]]
  const probe = addComponent(p, kind, { props: kind === "power" ? { net } : undefined, sch: { x: 0, y: 0, rot } })
  const at = schematicPins(probe.component)[0].pos
  const x = round(pin.x - at.x)
  const y = round(pin.y - at.y)
  return addComponent(p, kind, { props: kind === "power" ? { net } : undefined, sch: { x, y, rot } }).project
}

/** The stub `connect` draws from a pin (a wire from the pin to a net label) and that label, if there is one. */
function stubOf(p: Project, pin: Vec2): { wire: string; end: Vec2; labels: string[] } | null {
  for (const w of p.wires) {
    if (w.points.length !== 2) continue
    const [a, b] = w.points
    const end = samePoint(a, pin) ? b : samePoint(b, pin) ? a : null
    if (!end) continue
    const labels = p.labels.filter((l) => samePoint(l, end)).map((l) => l.id)
    if (labels.length) return { wire: w.id, end, labels }
  }
  return null
}

const without = (p: Project, wires: string[], labels: string[]): Project => ({
  ...p,
  wires: p.wires.filter((w) => !wires.includes(w.id)),
  labels: p.labels.filter((l) => !labels.includes(l.id)),
})

/** The pin with its stub and label taken off, so a wire can be drawn to it by hand. */
export function clearStub(p: Project, pin: WorldPin): Project | null {
  const stub = stubOf(p, pin.pos)
  return stub ? without(p, [stub.wire], stub.labels) : null
}

/** A symbol sitting on the pin itself; the pin's stub and label go. False when the pin has no plain stub. */
export function portOnPin(p: Project, pin: WorldPin, net: string): Project | null {
  const stub = stubOf(p, pin.pos)
  if (!stub) return null
  return symbolAt(without(p, [stub.wire], stub.labels), net, pin.pos, pin.dir)
}

/** The pin's stub kept, with a symbol where its label was: a wire from the pin to a power symbol. */
export function teeToPort(p: Project, pin: WorldPin, net: string): Project | null {
  const stub = stubOf(p, pin.pos)
  if (!stub) return null
  return symbolAt(without(p, [], stub.labels), net, stub.end, pin.dir)
}

/**
 * Pins of one side and one net joined by a comb, as Tidy draws it: one wire running from the
 * outermost pin out to its stub, along the spine and back in to the other outermost pin, the
 * pins between them on stubs that end on the spine, and a tee out of the middle of the spine to one
 * symbol. Needs every pin to have a plain stub and the stub ends to lie on one line.
 */
export function comb(p: Project, pins: WorldPin[], net: string): Project | null {
  if (pins.length < 2) return null
  const stubs = pins.map((pin) => ({ pin, stub: stubOf(p, pin.pos) }))
  if (stubs.some((s) => !s.stub)) return null
  const ends = stubs.map((s) => s.stub!.end)
  const horizontal = ends.every((e) => e.y === ends[0].y)
  const vertical = ends.every((e) => e.x === ends[0].x)
  if (!horizontal && !vertical) return null
  const sorted = [...stubs].sort((a, b) => (horizontal ? a.stub!.end.x - b.stub!.end.x : a.stub!.end.y - b.stub!.end.y))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (samePoint(first.stub!.end, last.stub!.end)) return null
  const labels = stubs.flatMap((s) => s.stub!.labels)
  let next = without(p, [first.stub!.wire, last.stub!.wire], labels)
  next = addWire(next, [first.pin.pos, first.stub!.end, last.stub!.end, last.pin.pos]).project
  const mid = { x: round((first.stub!.end.x + last.stub!.end.x) / 2), y: round((first.stub!.end.y + last.stub!.end.y) / 2) }
  const d = pins[0].dir
  const v = dirVector(d)
  const tee = { x: round(mid.x + v.x * 0.3), y: round(mid.y + v.y * 0.3) }
  next = addWire(next, [mid, tee]).project
  return symbolAt(next, net, tee, d)
}

/** A wire through the pins of two parts with a symbol on a tee in the middle of it: a junction both parts share. */
export function sharedTee(p: Project, a: WorldPin, b: WorldPin, net: string, bend: "h" | "v" = "h"): Project | null {
  const sa = stubOf(p, a.pos)
  const sb = stubOf(p, b.pos)
  if (!sa || !sb) return null
  const via = bend === "h" ? { x: sb.end.x, y: sa.end.y } : { x: sa.end.x, y: sb.end.y }
  const points = [sa.end, via, sb.end].filter((q, i, all) => i === 0 || !samePoint(q, all[i - 1]))
  if (points.length < 2) return null
  let next = without(p, [], [...sa.labels, ...sb.labels])
  next = addWire(next, points).project
  // The tee leaves the middle of the first segment, away from the other parts: along its normal.
  const [s0, s1] = [points[0], points[1]]
  const mid = { x: round((s0.x + s1.x) / 2), y: round((s0.y + s1.y) / 2) }
  const horizontal = s0.y === s1.y
  const tee = horizontal ? { x: mid.x, y: round(mid.y + 0.3) } : { x: round(mid.x + 0.3), y: mid.y }
  next = addWire(next, [mid, tee]).project
  return symbolAt(next, net, tee, horizontal ? "up" : "right")
}

/**
 * A wire straight between two pins (no stubs or labels of their own) with the net's label sitting
 * on the middle of its longest run: a connection that carries the net's name in the middle, which a
 * move of either part can leave behind.
 */
export function labelledWire(p: Project, a: WorldPin, b: WorldPin, net: string): Project | null {
  const cleared = clearStub(p, a)
  const both = cleared && clearStub(cleared, b)
  if (!both) return null
  const route = wireRoute(a, b)
  let longest = 0
  for (let i = 1; i < route.length; i++) {
    const len = Math.abs(route[i].x - route[i - 1].x) + Math.abs(route[i].y - route[i - 1].y)
    const best = Math.abs(route[longest + 1].x - route[longest].x) + Math.abs(route[longest + 1].y - route[longest].y)
    if (len > best) longest = i - 1
  }
  const [s0, s1] = [route[longest], route[longest + 1]]
  const mid = { x: round((s0.x + s1.x) / 2), y: round((s0.y + s1.y) / 2) }
  return addLabel(addWire(both, route).project, net, mid, 0).project
}
