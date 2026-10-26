import { parseFarads } from "../lib/values"
import { computeConnectivity, pinKey, type SchematicConnectivity } from "./connectivity"
import { isPhysical, pcbPads, schematicPins, type WorldPad } from "./instances"
import { findPart } from "./library"
import type { ComponentInstance, PartDef, PinDef, Project } from "./types"

// Which capacitor decouples which chip, and how far it sits from the pin it serves.
//
// Pairing is structural: nothing reads a designator, and a net name only to recognise ground.
// A capacitor decouples a chip when all of these hold:
//
// - it is a two-pin capacitor of 10 nF to 1 uF: smaller ones set timing or load a crystal,
//   bigger ones are bulk storage that belongs on the rail rather than at a pin;
// - its pins land on two different nets and one of them is ground;
// - the other net reaches a supply pin of a chip: a power pin, or the input or output of a
//   regulator. A chip is a part in the ICs or Power category with three pins or more, or a bare
//   RF module in Modules; a dev board in Modules, which carries its own decoupling, is not one;
// - when that supply reaches several chips, the one drawn nearest the capacitor in the
//   schematic is the one it serves, since that is where its designer put it; unless the
//   capacitor already sits at the supply pin of another of them on the board, which then wins.

/** Capacitance counted as decoupling, in farads: 10 nF to 1 uF. */
export const DECOUPLING_MIN_F = 10e-9
export const DECOUPLING_MAX_F = 1e-6
/** Automatic placement aims for a decoupling capacitor's supply pad within this of its pin's pad, edge to edge (mm). */
export const DECOUPLING_TARGET_MM = 2
/**
 * The Checks panel warns above this (mm). A capacitor's lead and trace add about a nanohenry per
 * millimetre to the loop it closes, so a few millimetres cost little and 3 mm is a common rule of
 * thumb; placement aims lower (DECOUPLING_TARGET_MM) so a hand-placed capacitor at 2 to 3 mm is
 * left alone instead of nagged.
 */
export const DECOUPLING_WARN_MM = 3

const GROUND_NAME = /^((a|d|p)?gnd([_-]\w+)?|ground|vss|0v)$/i
/** Regulator pins that carry the supply in or out, as opposed to enable, adjust or no-connect pins. */
const REGULATOR_SUPPLY = /^(v?in|v?out|vi|vo)(\d|[_+-]|$)/i

export interface DecouplingPair {
  capId: string
  chipId: string
  /** The supply net the capacitor bypasses. */
  netId: string
  netName: string
  groundNetId: string
  /** The capacitor's pin on the supply and its pin on ground. */
  capSupplyPin: string
  capGroundPin: string
  /** The chip's supply pins on that net, by number. */
  supplyPins: string[]
}

const isCapacitor = (part: PartDef) => part.valueProp === "capacitance" && part.pins.length === 2

/**
 * A part decoupling capacitors serve: an IC, a regulator, or a bare RF module such as the
 * ESP32-WROOM, which has its supply pin and nothing else. Not a dev board, which carries its own
 * decoupling, nor a battery or passive.
 */
export const isChip = (part: PartDef | undefined): part is PartDef =>
  !!part &&
  isPhysical(part) &&
  (part.category === "ICs" || part.category === "Power" || (part.category === "Modules" && !!part.keywords?.includes("rf"))) &&
  part.pins.length >= 3

/** Pins that take a chip's supply: power pins, and a regulator's input and output. */
export function isSupplyPin(part: PartDef, pin: PinDef): boolean {
  if (pin.kind === "power") return true
  return part.category === "Power" && (pin.kind === "input" || pin.kind === "output") && REGULATOR_SUPPLY.test(pin.name)
}

/** The capacitance of a capacitor in farads when it is in the decoupling band, else null. */
export function decouplingFarads(c: ComponentInstance, part = findPart(c.partId)): number | null {
  if (!part || !isCapacitor(part)) return null
  const f = parseFarads(c.props.capacitance)
  if (f === null || f < DECOUPLING_MIN_F * (1 - 1e-9) || f > DECOUPLING_MAX_F * (1 + 1e-9)) return null
  return f
}

type PadShape = Pick<WorldPad, "shape" | "x" | "y" | "width" | "height">

/** Pad edge to pad edge (mm). Round pads are exact; others are taken as their bounding box. */
export function padGap(a: PadShape, b: PadShape): number {
  const round = (p: PadShape) => p.shape === "circle"
  const boxPoint = (p: PadShape, x: number, y: number) =>
    Math.hypot(Math.max(Math.abs(x - p.x) - p.width / 2, 0), Math.max(Math.abs(y - p.y) - p.height / 2, 0))
  if (round(a) && round(b)) return Math.max(0, Math.hypot(a.x - b.x, a.y - b.y) - a.width / 2 - b.width / 2)
  if (round(a)) return Math.max(0, boxPoint(b, a.x, a.y) - a.width / 2)
  if (round(b)) return Math.max(0, boxPoint(a, b.x, b.y) - b.width / 2)
  const dx = Math.max(Math.abs(a.x - b.x) - (a.width + b.width) / 2, 0)
  const dy = Math.max(Math.abs(a.y - b.y) - (a.height + b.height) / 2, 0)
  return Math.hypot(dx, dy)
}

/** Of the chips whose supply pins are in `onRail`, the placed one nearest the capacitor's supply pad on the board. */
function nearestOnBoard(
  cap: ComponentInstance,
  capPin: string,
  onRail: { chip: ComponentInstance; pin: string }[],
  pads: (c: ComponentInstance) => WorldPad[],
): { chip: ComponentInstance; gap: number } | null {
  const capPads = pads(cap).filter((p) => p.pin === capPin)
  let best: { chip: ComponentInstance; gap: number } | null = null
  for (const s of onRail) {
    if (!s.chip.pcb.placed) continue
    for (const b of pads(s.chip)) {
      if (b.pin !== s.pin) continue
      for (const a of capPads) {
        const gap = padGap(a, b)
        if (!best || gap < best.gap - 1e-9) best = { chip: s.chip, gap }
      }
    }
  }
  return best
}

/** Nets that are ground: by name, or by a ground pin of anything but a passive (a ground port, a chip, a battery). */
export function groundNetIds(project: Project, sch: SchematicConnectivity): Set<string> {
  const ground = new Set<string>()
  for (const net of sch.nets) {
    if (GROUND_NAME.test(net.name)) ground.add(net.id)
  }
  for (const c of project.components) {
    const part = findPart(c.partId)
    for (const pin of part?.pins ?? []) {
      const net = pin.kind === "ground" ? sch.pinNet.get(pinKey(c.id, pin.number)) : undefined
      if (net) ground.add(net)
    }
  }
  return ground
}

/** Every decoupling capacitor with the chip and supply it serves. */
export function decouplingPairs(project: Project, sch: SchematicConnectivity = computeConnectivity(project)): DecouplingPair[] {
  const netOf = (c: ComponentInstance, pin: string) => sch.pinNet.get(pinKey(c.id, pin))
  const padCache = new Map<string, WorldPad[]>()
  const pads = (c: ComponentInstance) => {
    let list = padCache.get(c.id)
    if (!list) padCache.set(c.id, (list = pcbPads(c)))
    return list
  }
  const parts = new Map(project.components.map((c) => [c.id, findPart(c.partId)]))

  const ground = groundNetIds(project, sch)

  // Chip supply pins by net, with where each is drawn.
  const supplies = new Map<string, { chip: ComponentInstance; pin: string; pos: { x: number; y: number } }[]>()
  for (const c of project.components) {
    const part = parts.get(c.id)
    if (!isChip(part)) continue
    const drawn = new Map(schematicPins(c, part).map((p) => [p.pin, p.pos]))
    for (const pin of part.pins) {
      if (!isSupplyPin(part, pin)) continue
      const net = netOf(c, pin.number)
      const pos = drawn.get(pin.number)
      if (!net || ground.has(net) || !pos) continue
      const list = supplies.get(net) ?? []
      list.push({ chip: c, pin: pin.number, pos })
      supplies.set(net, list)
    }
  }

  const pairs: DecouplingPair[] = []
  for (const cap of project.components) {
    const part = parts.get(cap.id)
    if (!part || decouplingFarads(cap, part) === null) continue
    const [a, b] = part.pins.map((p) => ({ pin: p.number, net: netOf(cap, p.number) }))
    if (!a.net || !b.net || a.net === b.net) continue
    const aGround = ground.has(a.net)
    if (aGround === ground.has(b.net)) continue
    const [gnd, rail] = aGround ? [a, b] : [b, a]
    const onRail = (supplies.get(rail.net!) ?? []).filter((s) => s.chip.id !== cap.id)
    if (!onRail.length) continue
    // The chip drawn nearest the capacitor, measured between pins.
    const capPins = schematicPins(cap, part).map((p) => p.pos)
    let best: { chip: ComponentInstance; d: number } | null = null
    for (const s of onRail) {
      const d = Math.min(...capPins.map((p) => Math.hypot(p.x - s.pos.x, p.y - s.pos.y)))
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && s.chip.ref.localeCompare(best.chip.ref, undefined, { numeric: true }) < 0)) {
        best = { chip: s.chip, d }
      }
    }
    let chip = best!.chip
    // A capacitor already beside the supply pin of one of the chips on its rail serves that one.
    if (cap.pcb.placed && new Set(onRail.map((s) => s.chip.id)).size > 1) {
      const nearest = nearestOnBoard(cap, rail.pin, onRail, pads)
      if (nearest && nearest.gap <= DECOUPLING_WARN_MM && nearest.chip.id !== chip.id) chip = nearest.chip
    }
    pairs.push({
      capId: cap.id,
      chipId: chip.id,
      netId: rail.net!,
      netName: sch.nets.find((n) => n.id === rail.net)?.name ?? rail.net!,
      groundNetId: gnd.net!,
      capSupplyPin: rail.pin,
      capGroundPin: gnd.pin,
      supplyPins: [...new Set(onRail.filter((s) => s.chip.id === chip.id).map((s) => s.pin))],
    })
  }
  return pairs
}

export interface DecouplingGap {
  pair: DecouplingPair
  cap: ComponentInstance
  chip: ComponentInstance
  /** From the capacitor's supply pad to the nearest pad of the chip's supply pins on that net (mm). */
  gap: number
  /** The chip pin that nearest pad belongs to, by number and name. */
  pin: string
  pinName: string
}

/**
 * How far each placed decoupling capacitor is from the chip it serves: the edge-to-edge gap
 * between its supply pad and the nearest pad of the chip's supply pins on the same net.
 */
export function decouplingGaps(project: Project, pairs: DecouplingPair[] = decouplingPairs(project)): DecouplingGap[] {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const out: DecouplingGap[] = []
  for (const pair of pairs) {
    const cap = byId.get(pair.capId)
    const chip = byId.get(pair.chipId)
    if (!cap?.pcb.placed || !chip?.pcb.placed) continue
    const supply = new Set(pair.supplyPins)
    const capPads = pcbPads(cap).filter((p) => p.pin === pair.capSupplyPin)
    const chipPads = pcbPads(chip).filter((p) => p.pin !== null && supply.has(p.pin))
    let best: { gap: number; pin: string } | null = null
    for (const a of capPads) {
      for (const b of chipPads) {
        const gap = padGap(a, b)
        if (!best || gap < best.gap) best = { gap, pin: b.pin! }
      }
    }
    if (!best) continue
    const pinName = findPart(chip.partId)?.pins.find((p) => p.number === best.pin)?.name ?? best.pin
    out.push({ pair, cap, chip, gap: best.gap, pin: best.pin, pinName })
  }
  return out
}

/** Of the capacitors in `ids`, the decoupling ones and how many are within the target of their pin. */
export function decouplingSummary(project: Project, ids: Set<string>): { near: number; total: number } {
  const gaps = decouplingGaps(project).filter((g) => ids.has(g.cap.id))
  return { near: gaps.filter((g) => Number(g.gap.toFixed(1)) <= DECOUPLING_TARGET_MM).length, total: gaps.length }
}
