/**
 * Version 1 to 2 of the project file (October 2026): discrete symbols at KiCad's proportions.
 *
 * The resistors, diodes, transistors and the rest were drawn up to twice KiCad's size, and
 * shrinking them moved their pins towards their bodies, off the wires and labels that met them.
 * This puts each of those pins back in touch with what it touched:
 *
 * - a single wire ending there is lengthened to the pin's new place;
 * - a label alone there moves with the pin;
 * - anything else (several wires, another part's pin, or a wire running through the old place,
 *   which a wire end or a label there was joined to) gets a short wire from the new place to the
 *   old.
 *
 * Every move runs along one axis, so the drawing stays orthogonal. What it can't keep:
 *
 * - a pin touching a chip's or a connector's directly, with nothing else there: their geometry
 *   isn't frozen here, and an unwired pin is far likelier;
 * - a drawing with a wire across a part, where the pin's new place (or, for a short wire, its
 *   old one) is on that wire. A pin that would land on another net is left unconnected, which
 *   Checks reports, rather than shorted to it, which nothing would.
 *
 * Plain JSON in and out, and frozen: the pins as they were and as they became in version 2.
 */

type Json = Record<string, unknown>
interface Pt {
  x: number
  y: number
}

/** A pin's place in its symbol: [x, y] in version 1, then [x, y] in version 2. */
type Move = [number, number, number, number]

/** Two pins on the x axis, from ±`from` to ±`to`. */
const along = (from: number, to: number): Move[] => [
  [-from, 0, -to, 0],
  [from, 0, to, 0],
]
const RESISTOR = along(0.5, 0.3)
const LONG = along(0.6, 0.3)
const PUSHBUTTON = along(0.5, 0.4)
const POTENTIOMETER: Move[] = [...RESISTOR, [0, -0.4, 0, -0.2]]
const BJT: Move[] = [
  [-0.6, 0.3, -0.4, 0.3],
  [0.6, 0.3, 0.4, 0.3],
  [0, -0.4, 0, -0.3],
]
const MOSFET: Move[] = [
  [0.3, 0.6, 0.3, 0.3],
  [0.3, -0.6, 0.3, -0.5],
  [-0.5, -0.1, -0.3, -0.1],
]
const SLIDE_SWITCH: Move[] = [
  [0.4, 0.1, 0.4, 0.2],
  [0.4, -0.1, 0.4, -0.2],
]
const BUZZER: Move[] = [
  [-0.4, 0.2, -0.2, 0.2],
  [-0.4, -0.2, -0.2, -0.2],
]

/** Library parts whose pins moved. Capacitors, Zeners and power ports kept theirs. */
export const LIBRARY_PARTS: Record<string, Move[]> = {
  resistor: RESISTOR,
  inductor: LONG,
  potentiometer: POTENTIOMETER,
  crystal: LONG,
  diode: LONG,
  schottky: LONG,
  led: LONG,
  npn: BJT,
  pnp: BJT,
  nmos: MOSFET,
  pmos: MOSFET,
  battery: RESISTOR,
  coin_cell_cr2032: RESISTOR,
  pushbutton: PUSHBUTTON,
  pushbutton_smd: PUSHBUTTON,
  slide_switch: SLIDE_SWITCH,
  buzzer: BUZZER,
}

/** Project parts by the discrete symbol their spec names. Box symbols kept their pins. */
export const PROJECT_PART_SYMBOLS: Record<string, Move[]> = {
  resistor: RESISTOR,
  inductor: LONG,
  ferrite_bead: RESISTOR,
  crystal: LONG,
  fuse: LONG,
  diode: LONG,
  schottky: LONG,
  tvs: LONG,
  led: LONG,
  battery: RESISTOR,
  buzzer: BUZZER,
  switch: PUSHBUTTON,
  npn: BJT,
  pnp: BJT,
  nmos: MOSFET,
  pmos: MOSFET,
}

/** Pins that didn't move, which another part's pin may have touched. */
const AXIAL: [number, number][] = [
  [-0.3, 0],
  [0.3, 0],
]
const STILL_LIBRARY_PARTS: Record<string, [number, number][]> = {
  capacitor: AXIAL,
  capacitor_polarized: AXIAL,
  capacitor_tantalum: AXIAL,
  zener: AXIAL,
  slide_switch: [[-0.4, 0]],
  power: [[0, -0.2]],
  ground: [[0, 0.3]],
}
const STILL_PROJECT_PART_SYMBOLS: Record<string, [number, number][]> = { capacitor: AXIAL, capacitor_polarized: AXIAL, zener: AXIAL }

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const isPoint = (p: unknown): p is Pt => isObject(p) && typeof p.x === "number" && typeof p.y === "number"
const r4 = (n: number) => {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? 0 : r
}
const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
const pointKey = (p: Pt) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`
function onSegment(p: Pt, a: Pt, b: Pt) {
  if (Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) > 1e-6) return false
  return p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6
}

/** Symbol space to the sheet: turned counter-clockwise by `rot`, then moved to the part. */
function place(x: number, y: number, at: Pt, rot: unknown): Pt {
  const [rx, ry] = rot === 90 ? [-y, x] : rot === 180 ? [-x, -y] : rot === 270 ? [y, -x] : [x, y]
  return { x: r4(at.x + rx), y: r4(at.y + ry) }
}

interface Pin {
  from: Pt
  to: Pt
  /** The net a power port names. */
  net?: string
}

export function kicadSymbols(project: Json): Json {
  const ownSymbols = new Map<string, string>()
  for (const part of list(project.parts)) {
    if (isObject(part) && typeof part.id === "string" && typeof part.symbol === "string") ownSymbols.set(part.id, part.symbol)
  }

  // Every pin whose version 1 place is known, moved or not.
  const pins: Pin[] = []
  for (const c of list(project.components)) {
    if (!isObject(c) || typeof c.partId !== "string") continue
    const own = ownSymbols.get(c.partId)
    const sch = isObject(c.sch) ? c.sch : {}
    const at = { x: typeof sch.x === "number" ? sch.x : 0, y: typeof sch.y === "number" ? sch.y : 0 }
    for (const [ox, oy, nx, ny] of LIBRARY_PARTS[c.partId] ?? (own ? PROJECT_PART_SYMBOLS[own] : undefined) ?? []) {
      pins.push({ from: place(ox, oy, at, sch.rot), to: place(nx, ny, at, sch.rot) })
    }
    const props = isObject(c.props) ? c.props : {}
    const net = c.partId === "power" || c.partId === "ground" ? (typeof props.net === "string" && props.net.trim()) || (c.partId === "power" ? "VCC" : "GND") : undefined
    for (const [x, y] of STILL_LIBRARY_PARTS[c.partId] ?? (own ? STILL_PROJECT_PART_SYMBOLS[own] : undefined) ?? []) {
      const p = place(x, y, at, sch.rot)
      pins.push({ from: p, to: p, net })
    }
  }
  if (pins.every((p) => same(p.from, p.to))) return project

  const wires = list(project.wires).map((w) => (isObject(w) && Array.isArray(w.points) ? { ...w, points: w.points.filter(isPoint) } : w))
  const labels = list(project.labels).map((l) => (isObject(l) ? { ...l } : l))
  const drawn = wires.flatMap((w, i) => (isObject(w) && Array.isArray(w.points) ? [{ i, points: w.points as Pt[] }] : []))
  const named = labels.flatMap((l, i) => (isObject(l) && isPoint(l) ? [{ i, at: l as Json & Pt, name: typeof l.name === "string" ? l.name.trim() : "" }] : []))

  // What was connected to what in version 1, as far as wires, labels and the pins above say.
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let r = a
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const owners = new Map<string, string[]>()
  const own = (p: Pt, k: string) => owners.set(pointKey(p), [...(owners.get(pointKey(p)) ?? []), k])
  pins.forEach((p, i) => {
    own(p.from, `p${i}`)
    if (p.net) union(`p${i}`, `n:${p.net}`)
  })
  for (const w of drawn) for (const p of w.points) own(p, `w${w.i}`)
  for (const l of named) {
    own(l.at, `l${l.i}`)
    union(`l${l.i}`, `n:${l.name}`)
  }
  for (const keys of owners.values()) for (const k of keys.slice(1)) union(keys[0], k)
  const segments = (w: { points: Pt[] }) => w.points.slice(1).map((b, j) => [w.points[j], b] as const)
  const probes = [...drawn.flatMap((w) => [w.points[0], w.points[w.points.length - 1]].filter(Boolean).map((p) => ({ p, k: `w${w.i}` }))), ...named.map((l) => ({ p: l.at as Pt, k: `l${l.i}` }))]
  for (const { p, k } of probes) for (const w of drawn) if (`w${w.i}` !== k && segments(w).some(([a, b]) => onSegment(p, a, b))) union(k, `w${w.i}`)
  const groupOf = new Map<string, string>()
  for (const w of drawn) groupOf.set(`w${w.i}`, find(`w${w.i}`))
  for (const l of named) groupOf.set(`l${l.i}`, find(`l${l.i}`))

  let next = 0
  const ids = new Set(wires.map((w) => (isObject(w) ? w.id : undefined)))
  const newId = () => {
    while (ids.has(`w_kicad${next}`)) next++
    ids.add(`w_kicad${next}`)
    return `w_kicad${next}`
  }

  pins.forEach(({ from, to }, i) => {
    if (same(from, to)) return
    const net = find(`p${i}`)
    const foreign = (k: string) => groupOf.get(k) !== net
    const here = (p: Pt) => same(p, from)
    const through = drawn.filter((w) => w.points.some(here))
    const otherPins = pins.filter((p) => here(p.from)).length - 1
    const labelsHere = named.filter((l) => here(l.at))
    // Wires running through the old place without a corner there: a wire end or a label at it
    // joined them, and only one left there keeps them joined.
    const crossing = drawn.filter((w) => !w.points.some(here) && segments(w).some(([a, b]) => onSegment(from, a, b)))
    const ends = through.length === 1 && through[0].points.filter(here).length === 1 ? through[0] : null
    const end = ends ? ends.points.findIndex(here) : -1
    const extend = !!ends && (end === 0 || end === ends.points.length - 1) && crossing.length === 0
    const stub = !extend && (through.length > 0 || otherPins > 0 || (labelsHere.length > 0 && crossing.length > 0))

    // Nothing put at the new place, along a new wire or at a short wire's old end may touch another net.
    const kept = extend ? `w${ends!.i}` : ""
    const probing = extend || stub || labelsHere.length > 0
    const landsOnOther =
      probing &&
      (drawn.some((w) => `w${w.i}` !== kept && foreign(`w${w.i}`) && segments(w).some(([a, b]) => onSegment(to, a, b))) ||
        named.some((l) => foreign(`l${l.i}`) && same(l.at, to)))
    const alongTouches =
      (extend || stub) &&
      ((stub && crossing.some((w) => foreign(`w${w.i}`))) ||
        drawn.some((w) => `w${w.i}` !== kept && foreign(`w${w.i}`) && [w.points[0], w.points[w.points.length - 1]].some((p) => p && onSegment(p, to, from))) ||
        named.some((l) => foreign(`l${l.i}`) && onSegment(l.at, to, from)))
    if (landsOnOther || alongTouches) return

    if (extend) {
      if (end === 0) ends!.points.unshift(to)
      else ends!.points.push(to)
    } else if (stub) {
      const w = { id: newId(), points: [to, from] }
      wires.push(w)
      drawn.push({ i: wires.length - 1, points: w.points })
      groupOf.set(`w${wires.length - 1}`, net)
    }
    if (!stub) for (const l of labelsHere) Object.assign(l.at, { x: to.x, y: to.y })
  })
  return { ...project, wires, labels }
}
