import { parseFarads } from "../lib/values"
import type { Box } from "../lib/geometry"
import { computeConnectivity, pinKey, type SchematicConnectivity } from "./connectivity"
import { decouplingPairs, groundNetIds, isChip, isSupplyPin, padGap, type DecouplingPair } from "./decoupling"
import { pcbCourtyard, pcbPads, schematicPins, type WorldPad } from "./instances"
import { findPart } from "./library"
import { findNearSpot, inflateBox, type NearAnchor, type NearSpot } from "./placeNear"
import type { ComponentInstance, PartDef, PcbSide, Project } from "./types"

// Power stages: the parts of a switching regulator's loop, or an LDO's input and output, placed
// as a datasheet draws them. Nothing reads a designator and the pins are told apart by name, the
// way a datasheet names them (SW or LX, BST or BOOT, FB, VIN, GND), since a part's pin kinds
// don't say which pin is the switch node.
//
// For a switching regulator, around the chip:
//
// - input capacitors of any value across VIN and ground, smallest first so the one that handles
//   the fastest edges is nearest the pins;
// - the inductor with one end on the SW pin and the other end pointing away from the chip;
// - a bootstrap capacitor between BST and SW, and a catch or boost diode on SW;
// - output capacitors at the inductor's far end (buck) or at VOUT (boost), grounded at the chip;
// - the feedback divider at FB, kept away from the SW pin and the inductor.
//
// An LDO gets its input and output capacitors of any value at IN and OUT. That is wider than
// decoupling.ts, which only pairs 10 nF to 1 uF capacitors with a chip and leaves bulk ones to the
// general packing.

export type StageKind = "buck" | "boost" | "ldo"
export type StageRole = "input-cap" | "inductor" | "boot-cap" | "diode" | "output-cap" | "feedback"

const SW_PIN = /^(sw|lx|phase|switch)([_-]?\d+)?$/i
const BOOT_PIN = /^(bst|boot|vbst|bootstrap|cboot)([_-]?\d+)?$/i
const FB_PIN = /^(v?fb|feedback)([_-]?\d+)?$/i
const VIN_PIN = /^(pvin|avin|vin|vi|in)([_-]?\d+)?$/i
const VOUT_PIN = /^(vout|vo|out)([_-]?\d+)?$/i
const GND_PIN = /^[apd]?gnd([_-]?\d+)?$/i

/** Courtyard to a stage part's (mm): tighter than the general capacitor gap, since the loop is the point. */
export const STAGE_GAP = 0.3
/** The feedback divider keeps this far from the switch node when it can (mm). */
const FEEDBACK_KEEP_AWAY = 4

export interface SatAnchor {
  /** The satellite's own pin. */
  pin: string
  /** Chip pins by number, or a pin of another satellite once that one is placed. */
  to: { chip: string[] } | { part: string; pin: string }
  weight: number
}

export interface StageSat {
  id: string
  role: StageRole
  anchors: SatAnchor[]
  /** A pin of the satellite that should end up farther from the chip than the first anchor's pin: an inductor's far end, a capacitor's ground pad. */
  away?: string
}

export interface PowerStage {
  chipId: string
  kind: StageKind
  /** The chip's switch-node pins, empty for an LDO. */
  swPins: string[]
  /** In placement order. */
  sats: StageSat[]
}

interface ChipPins {
  sw: string[]
  boot: string[]
  fb: string[]
  vin: string[]
  vout: string[]
  gnd: string[]
}

function classifyPins(part: PartDef): ChipPins {
  const out: ChipPins = { sw: [], boot: [], fb: [], vin: [], vout: [], gnd: [] }
  for (const pin of part.pins) {
    const n = pin.name.trim()
    if (SW_PIN.test(n)) out.sw.push(pin.number)
    else if (BOOT_PIN.test(n)) out.boot.push(pin.number)
    else if (FB_PIN.test(n)) out.fb.push(pin.number)
    else if (pin.kind === "ground" || GND_PIN.test(n)) out.gnd.push(pin.number)
    else if (VIN_PIN.test(n)) out.vin.push(pin.number)
    else if (VOUT_PIN.test(n)) out.vout.push(pin.number)
  }
  return out
}

const isTwoPin = (part: PartDef | undefined): part is PartDef => !!part && part.pins.length === 2

/**
 * Every power stage in the project: each switching regulator and each LDO with its loop parts.
 * A capacitor on a rail more than one chip draws from belongs to one of them: the chip decoupling.ts
 * pairs it with, else the one drawn nearest it in the schematic.
 */
export function powerStages(
  project: Project,
  sch: SchematicConnectivity = computeConnectivity(project),
  pairs: DecouplingPair[] = decouplingPairs(project, sch),
  /** Parts whose board position is final (not about to be re-packed); a rail capacitor already beside another chip stays with it. */
  settled: ReadonlySet<string> = new Set(),
): PowerStage[] {
  const netOf = (c: ComponentInstance, pin: string) => sch.pinNet.get(pinKey(c.id, pin))
  const ground = groundNetIds(project, sch)
  const parts = project.components.map((c) => ({ c, part: findPart(c.partId) }))
  const farads = (c: ComponentInstance) => parseFarads(c.props.capacitance) ?? Infinity
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const byRef = (a: ComponentInstance, b: ComponentInstance) => a.ref.localeCompare(b.ref, undefined, { numeric: true })
  const stages: PowerStage[] = []

  for (const { c: chip, part } of parts) {
    if (!isChip(part)) continue
    const pins = classifyPins(part)
    const supplyPins = part.pins.filter((p) => isSupplyPin(part, p))
    const netsOf = (numbers: string[]) => new Set(numbers.map((n) => netOf(chip, n)).filter((n): n is string => !!n && !ground.has(n)))
    const switching = pins.sw.length > 0 && pins.vin.length > 0
    // An LDO: a regulator whose supply pins are an input and an output, with nothing switching.
    const linear = !switching && part.category === "Power" && pins.vin.length > 0 && pins.vout.length > 0 && supplyPins.length >= 2
    if (!switching && !linear) continue

    const vin = netsOf(pins.vin)
    const swNet = switching ? netsOf(pins.sw) : new Set<string>()
    const bootNet = netsOf(pins.boot)
    const fbNet = netsOf(pins.fb)
    const voutNet = netsOf(pins.vout)
    const neighbours = parts.filter((x) => x.c.id !== chip.id && isTwoPin(x.part))
    const onNet = (x: { c: ComponentInstance; part: PartDef | undefined }, nets: Set<string>) =>
      x.part!.pins.map((p) => ({ pin: p.number, net: netOf(x.c, p.number) })).find((p) => !!p.net && nets.has(p.net))
    const otherPin = (x: { c: ComponentInstance; part: PartDef | undefined }, pin: string) => {
      const other = x.part!.pins.find((p) => p.number !== pin)!.number
      return { pin: other, net: netOf(x.c, other) }
    }

    const inductor = switching
      ? neighbours.filter((x) => x.part!.valueProp === "inductance" && onNet(x, swNet)).sort((a, b) => byRef(a.c, b.c))[0]
      : undefined
    const inductorFar = inductor ? otherPin(inductor, onNet(inductor, swNet)!.pin) : undefined
    let kind: StageKind = "ldo"
    if (switching) {
      if (inductorFar?.net) kind = vin.has(inductorFar.net) ? "boost" : "buck"
      else kind = pins.vout.length ? "boost" : "buck"
    }
    // The net the output capacitors sit on: the inductor's far end for a buck, the VOUT pin otherwise.
    const outNets = kind === "buck" ? new Set(inductorFar?.net ? [inductorFar.net] : []) : voutNet
    const chipGnd = { chip: pins.gnd }
    // A switching stage closes its hot loop through the chip's ground pin, so the capacitor's ground pad
    // is kept close to it. An LDO's capacitors ground through the pour, and their ground pad faces away
    // from the chip as decoupling places it.
    const groundAnchor = (pin: string): SatAnchor[] => (kind === "ldo" ? [] : [{ pin, to: chipGnd, weight: 0.6 }])
    const claimed = new Set<string>()
    const sats: Record<StageRole, StageSat[]> = { "input-cap": [], inductor: [], "boot-cap": [], diode: [], "output-cap": [], feedback: [] }

    const caps = neighbours.filter((x) => x.part!.valueProp === "capacitance").sort((a, b) => farads(a.c) - farads(b.c) || byRef(a.c, b.c))
    // A capacitor between two nets as (net it sits on, its pin there) and (its pin on ground).
    const acrossGround = (x: (typeof caps)[number], nets: Set<string>) => {
      const rail = onNet(x, nets)
      if (!rail) return null
      const other = otherPin(x, rail.pin)
      return other.net && ground.has(other.net) ? { rail: rail.pin, gnd: other.pin } : null
    }
    if (switching) {
      for (const x of caps) {
        const boot = onNet(x, bootNet)
        const sw = onNet(x, swNet)
        if (!boot || !sw || boot.pin === sw.pin) continue
        claimed.add(x.c.id)
        sats["boot-cap"].push({
          id: x.c.id,
          role: "boot-cap",
          anchors: [
            { pin: boot.pin, to: { chip: pins.boot }, weight: 1 },
            { pin: sw.pin, to: { chip: pins.sw }, weight: 1 },
          ],
        })
      }
    }
    for (const x of caps) {
      if (claimed.has(x.c.id)) continue
      const across = acrossGround(x, vin)
      if (!across) continue
      claimed.add(x.c.id)
      sats["input-cap"].push({
        id: x.c.id,
        role: "input-cap",
        anchors: [{ pin: across.rail, to: { chip: pins.vin }, weight: 1 }, ...groundAnchor(across.gnd)],
        ...(kind === "ldo" && { away: across.gnd }),
      })
    }
    for (const x of caps) {
      if (claimed.has(x.c.id)) continue
      const across = acrossGround(x, outNets)
      if (!across) continue
      claimed.add(x.c.id)
      const supply: SatAnchor =
        kind === "buck" && inductor
          ? { pin: across.rail, to: { part: inductor.c.id, pin: inductorFar!.pin }, weight: 1 }
          : { pin: across.rail, to: { chip: pins.vout }, weight: 1 }
      sats["output-cap"].push({ id: x.c.id, role: "output-cap", anchors: [supply, ...groundAnchor(across.gnd)], ...(kind === "ldo" && { away: across.gnd }) })
    }
    if (switching) {
      if (inductor) {
        const swPin = onNet(inductor, swNet)!.pin
        sats.inductor.push({ id: inductor.c.id, role: "inductor", anchors: [{ pin: swPin, to: { chip: pins.sw }, weight: 1 }], away: inductorFar!.pin })
      }
      for (const x of neighbours.filter((y) => y.part!.category === "Diodes").sort((a, b) => byRef(a.c, b.c))) {
        const sw = onNet(x, swNet)
        if (sw) sats.diode.push({ id: x.c.id, role: "diode", anchors: [{ pin: sw.pin, to: { chip: pins.sw }, weight: 1 }] })
      }
    }
    for (const x of neighbours.filter((y) => y.part!.valueProp === "resistance").sort((a, b) => byRef(a.c, b.c))) {
      const fb = onNet(x, fbNet)
      if (!fb) continue
      const other = otherPin(x, fb.pin)
      const anchors: SatAnchor[] = [{ pin: fb.pin, to: { chip: pins.fb }, weight: 1 }]
      if (other.net && ground.has(other.net)) anchors.push({ pin: other.pin, to: chipGnd, weight: 0.3 })
      sats.feedback.push({ id: x.c.id, role: "feedback", anchors })
    }

    // The inductor first: SW is the node that switches fastest and the inductor is the bulkiest part,
    // so it takes the room beside the pin before the capacitors fill it. Output capacitors come after
    // it because they measure from its far pad, and the divider last since it can sit farther away.
    const byValue = [...sats["input-cap"], ...sats["output-cap"]].sort((a, b) => farads(byId.get(a.id)!) - farads(byId.get(b.id)!) || byRef(byId.get(a.id)!, byId.get(b.id)!))
    const ordered =
      kind === "ldo"
        ? byValue
        : [...sats.inductor, ...sats["input-cap"], ...sats["boot-cap"], ...sats.diode, ...sats["output-cap"], ...sats.feedback]
    if (ordered.length) stages.push({ chipId: chip.id, kind, swPins: pins.sw, sats: ordered })
  }
  return resolveClaims(project, stages, pairs, sch, settled)
}

const isRailCap = (s: StageSat) => s.role === "input-cap" || s.role === "output-cap"
/** A regulator keeps this many of its own largest output capacitors whatever other chips share the rail. */
const OWN_OUTPUT_CAPS = 2

/**
 * Leave each rail capacitor in the one stage it belongs to, and in none when decoupling pairs it with
 * another chip, or when another chip drawing from the same rail has it closer (drawn closer in the
 * schematic, or already standing closer on the board). A bulk input capacitor beside a motor driver
 * stays with the motor driver, not the regulator that happens to share its rail. A regulator's own
 * largest output capacitors are the exception: they are its output filter, so they stay with it
 * however the other chips on the rail happen to be drawn (a design with no coordinates lays parts in
 * a row in creation order, which says nothing about who is closer).
 */
function resolveClaims(project: Project, stages: PowerStage[], pairs: DecouplingPair[], sch: SchematicConnectivity, settled: ReadonlySet<string>): PowerStage[] {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const pairedWith = new Map(pairs.map((p) => [p.capId, p.chipId]))
  const pos = (id: string, pin: string) => {
    const c = byId.get(id)
    return c ? schematicPins(c).find((p) => p.pin === pin)?.pos : undefined
  }
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
  /** Schematic distance from the capacitor's rail pin to what the stage anchors it to. */
  const distance = (stage: PowerStage, sat: StageSat) => {
    const a = sat.anchors[0]
    const from = pos(sat.id, a.pin)
    const to = ("chip" in a.to ? a.to.chip.map((pin) => pos(stage.chipId, pin)) : [pos(a.to.part, a.to.pin)]).filter((p) => !!p)
    if (!from || !to.length) return Infinity
    return Math.min(...to.map((p) => dist(p!, from)))
  }
  /** Supply pins of one chip on a net, as component, pin number. */
  const supplyOn = (chipId: string, net: string) => {
    const c = byId.get(chipId)
    const part = c && findPart(c.partId)
    if (!c || !part) return []
    return part.pins.filter((p) => isSupplyPin(part, p) && sch.pinNet.get(pinKey(c.id, p.number)) === net).map((p) => p.number)
  }
  /** Distance in the schematic from the capacitor's rail pin to a chip's supply pins on its net. */
  const drawn = (cap: ComponentInstance, pin: string, net: string, chipId: string) => {
    const from = pos(cap.id, pin)
    const to = supplyOn(chipId, net).map((n) => pos(chipId, n)).filter((p) => !!p)
    return from && to.length ? Math.min(...to.map((p) => dist(p!, from))) : Infinity
  }
  /** Gap on the board to a chip's supply pins on its net, when the capacitor and the chip both stand still. */
  const standing = (cap: ComponentInstance, pin: string, net: string, chipId: string) => {
    const chip = byId.get(chipId)
    if (!chip || !settled.has(cap.id) || !settled.has(chipId) || !cap.pcb.placed || !chip.pcb.placed) return Infinity
    const numbers = supplyOn(chipId, net)
    let best = Infinity
    for (const a of pcbPads(cap).filter((p) => p.pin === pin)) for (const b of pcbPads(chip).filter((p) => p.pin !== null && numbers.includes(p.pin))) best = Math.min(best, padGap(a, b))
    return best
  }
  const chips = project.components.filter((c) => isChip(findPart(c.partId)))
  const owner = new Map<string, { stage: PowerStage; d: number }>()
  const farads = (id: string) => parseFarads(byId.get(id)?.props.capacitance) ?? -Infinity
  for (const stage of stages) {
    const ownOutput = new Set(
      stage.sats
        .filter((s) => s.role === "output-cap" && pairedWith.get(s.id) === undefined)
        .sort((a, b) => farads(b.id) - farads(a.id) || a.id.localeCompare(b.id))
        .slice(0, OWN_OUTPUT_CAPS)
        .map((s) => s.id),
    )
    for (const sat of stage.sats.filter(isRailCap)) {
      const paired = pairedWith.get(sat.id)
      if (paired !== undefined && paired !== stage.chipId) continue
      const cap = byId.get(sat.id)
      const net = cap && sch.pinNet.get(pinKey(cap.id, sat.anchors[0].pin))
      let d = paired === undefined ? distance(stage, sat) : -1
      if (paired === undefined && cap && net && !ownOutput.has(sat.id)) {
        // Another chip drawing from this rail with the capacitor closer to its supply pins keeps it.
        const pin = sat.anchors[0].pin
        const others = chips.filter((c) => c.id !== stage.chipId)
        const ownDrawn = Math.min(d, drawn(cap, pin, net, stage.chipId))
        if (Math.min(Infinity, ...others.map((c) => drawn(cap, pin, net, c.id))) < ownDrawn - 1e-9) continue
        const ownBoard = standing(cap, pin, net, stage.chipId)
        if (Math.min(Infinity, ...others.map((c) => standing(cap, pin, net, c.id))) < ownBoard - 1e-9) continue
        d = ownDrawn
      }
      const best = owner.get(sat.id)
      if (!best || d < best.d - 1e-9) owner.set(sat.id, { stage, d })
    }
  }
  return stages
    .map((stage) => ({ ...stage, sats: stage.sats.filter((s) => !isRailCap(s) || owner.get(s.id)?.stage === stage) }))
    .filter((stage) => stage.sats.length)
}

export interface StageContext {
  /** The regulator, standing where it will. */
  chip: ComponentInstance
  byId: Map<string, ComponentInstance>
  /** Courtyards and obstacles to keep clear of, already carrying their own spacing. */
  blocked: Box[]
  /** Where the chip's fine-pitch pins have their way out, for nets other than the ones `exempt` names. */
  corridors: (exempt: Set<string>) => Box[]
  netOf: (componentId: string, pin: string) => string | undefined
  keepIn: Box | null
}

/**
 * Where each satellite of a stage goes around the chip as it stands, in placement order; a
 * satellite nothing within reach has room for is left out. Output capacitors of a buck measure
 * from the inductor's far pad, so they wait for it.
 */
export function placeStage(stage: PowerStage, ctx: StageContext, claimable: (id: string) => boolean = () => true): { id: string; spot: NearSpot }[] {
  const { chip } = ctx
  const side: PcbSide = chip.pcb.side
  const chipBox = pcbCourtyard(chip)
  if (!chipBox) return []
  const chipPads = pcbPads(chip)
  const padsOfChip = (numbers: string[]) => chipPads.filter((p) => p.pin !== null && numbers.includes(p.pin))
  const swPads = padsOfChip(stage.swPins)
  const placed: { id: string; spot: NearSpot }[] = []
  const placedComponent = (id: string): ComponentInstance | null => {
    const hit = placed.find((p) => p.id === id)
    const c = ctx.byId.get(id)
    return hit && c ? { ...c, pcb: { ...c.pcb, x: hit.spot.x, y: hit.spot.y, rot: hit.spot.rot, side: hit.spot.side, placed: true } } : null
  }

  for (const sat of stage.sats) {
    const c = ctx.byId.get(sat.id)
    if (!c || !claimable(sat.id)) continue
    const anchors: NearAnchor[] = []
    const exempt = new Set<string>()
    for (const a of sat.anchors) {
      let targets: WorldPad[]
      if ("chip" in a.to) {
        targets = padsOfChip(a.to.chip)
        for (const pin of a.to.chip) {
          const net = ctx.netOf(chip.id, pin)
          if (net) exempt.add(net)
        }
      } else {
        const { part, pin } = a.to
        const other = placedComponent(part)
        targets = other ? pcbPads(other).filter((p) => p.pin === pin) : []
      }
      if (targets.length) anchors.push({ pin: a.pin, targets, weight: a.weight })
      else if (!anchors.length) break
    }
    if (!anchors.length) continue
    const blocked = [inflateBox(chipBox, STAGE_GAP), ...ctx.corridors(exempt), ...ctx.blocked, ...placed.map((p) => inflateBox(p.spot.box, STAGE_GAP))]
    const inductor = placed.find((p) => stage.sats.find((s) => s.id === p.id)?.role === "inductor")
    const spot = findNearSpot(c, anchors, {
      side,
      blocked,
      keepIn: ctx.keepIn,
      ...(sat.away && { away: { pin: sat.away, from: chipBox } }),
      ...(sat.role === "feedback" && {
        penalty: (at: { x: number; y: number }) => {
          const keep = [...swPads, ...(inductor ? [inductor.spot.box] : [])]
          let cost = 0
          for (const k of keep) {
            const d = "shape" in k ? Math.hypot(k.x - at.x, k.y - at.y) : Math.hypot(Math.max(k.minX - at.x, at.x - k.maxX, 0), Math.max(k.minY - at.y, at.y - k.maxY, 0))
            cost += Math.max(0, FEEDBACK_KEEP_AWAY - d) * 0.5
          }
          return cost
        },
      }),
    })
    if (spot) placed.push({ id: sat.id, spot })
  }
  return placed
}

export interface StageGap {
  /** The satellite and its pin, then what it sits beside, e.g. "C1.1 to U1.VIN". */
  label: string
  ref: string
  role: StageRole
  /** Pad edge to pad edge (mm). */
  gap: number
}

export interface StageReport {
  chipRef: string
  kind: StageKind
  gaps: StageGap[]
}

/** How far each placed satellite of each stage is from the pins it is meant to sit beside. */
export function stageGaps(project: Project, stages: PowerStage[] = powerStages(project)): StageReport[] {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const out: StageReport[] = []
  for (const stage of stages) {
    const chip = byId.get(stage.chipId)
    const chipPart = chip && findPart(chip.partId)
    if (!chip?.pcb.placed || !chipPart) continue
    const gaps: StageGap[] = []
    const name = (c: ComponentInstance, pin: string) => {
      const n = findPart(c.partId)?.pins.find((p) => p.number === pin)?.name
      return `${c.ref}.${n && n !== pin ? n : pin}`
    }
    for (const sat of stage.sats) {
      const c = byId.get(sat.id)
      if (!c?.pcb.placed) continue
      const mine = pcbPads(c)
      for (const a of sat.anchors) {
        const target = "chip" in a.to ? chip : byId.get(a.to.part)
        const pins = "chip" in a.to ? a.to.chip : [a.to.pin]
        if (!target?.pcb.placed) continue
        let best: { gap: number; pad: WorldPad } | null = null
        for (const p of mine.filter((x) => x.pin === a.pin)) {
          for (const t of pcbPads(target).filter((x) => x.pin !== null && pins.includes(x.pin))) {
            const gap = padGap(p, t)
            if (!best || gap < best.gap) best = { gap, pad: t }
          }
        }
        if (best) gaps.push({ label: `${name(c, a.pin)} to ${name(target, best.pad.pin!)}`, ref: c.ref, role: sat.role, gap: best.gap })
      }
    }
    if (gaps.length) out.push({ chipRef: chip.ref, kind: stage.kind, gaps })
  }
  return out
}
