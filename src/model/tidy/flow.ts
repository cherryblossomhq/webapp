import { naturalCompare } from "../../lib/natural"
import { findPart } from "../library"
import type { ComponentInstance, Project, SchematicBlock } from "../types"
import type { NetInfo, TidyNet } from "./nets"

// Which way a sheet reads: where power comes in, where it is regulated, the part in charge, and
// what hangs off it. Worked out from the nets and the parts on them, so a block's name only
// breaks ties.
//
// - Entry: a connector on the board's incoming supply (the highest rail: VBUS, VIN, a battery).
// - Regulation: a chip that turns one supply into another (an output pin on a rail and a second
//   rail on its inputs, or an inductor beside it).
// - Inputs that reach the controller only through other blocks (a sensor's connector behind
//   its amplifier), the furthest first.
// - Control: the block holding the chip with the most pins, the microcontroller.
// - Then chips the controller talks to, then connectors and indicators, then test points and
//   whatever was left loose.

export const Rank = { Entry: 0, Regulation: 1, Upstream: 2, Control: 3, Chips: 4, Outputs: 5, Rest: 6 } as const
export type Rank = (typeof Rank)[keyof typeof Rank]

export interface FlowBlock {
  id: string
  name: string
  rank: Rank
  /** Sorts blocks of one rank: lower first. */
  key: number
  /** Its place in reading order. */
  index: number
}

const ENTRY = /^(VBUS|VIN|VRAW|VSUPPLY|VEXT|VMAIN)$/i
const BATTERY = 95
/** Pin names that take a signal in: analog inputs, converter channels. */
const INPUT_PIN = /^(A?IN[A-Z]*\d*[_PNM+-]?\d*|ADC\d*|CH\d+[PN+-]?|VIN[PN+-]|SIG)/i

/**
 * How far up the supply chain a rail is: the incoming supply highest, a battery just below it
 * (it charges from the incoming one), then by voltage.
 */
export function railLevel(name: string): number {
  if (ENTRY.test(name)) return 100
  if (/^VBATT?$/i.test(name)) return BATTERY
  if (/^(VBUS|VIN|VBAT|VRAW)/i.test(name)) return 90
  const v = name.match(/(\d+)(?:V|_|\.)(\d+)?/i) ?? name.match(/(\d+)/)
  if (v) {
    const n = Number(`${v[1]}.${v[2] ?? 0}`)
    if (Number.isFinite(n) && n > 0 && n < 80) return n
  }
  // A supply named for what it feeds (SD_VDD, VCC) is taken for a low one, read after the
  // regulators that make it.
  return 1
}

const isConnector = (c: ComponentInstance) => {
  const p = findPart(c.partId)
  return !!p && p.pins.length >= 2 && (p.category === "Connectors" || /^(J|P|CN|CON|USB)\d/i.test(c.ref))
}
const isChip = (c: ComponentInstance) => {
  const p = findPart(c.partId)
  return !!p && p.pins.length >= 3 && !isConnector(c) && (p.category === "ICs" || p.category === "Modules" || p.category === "Power" || /^U\d/i.test(c.ref))
}
const isTestPoint = (c: ComponentInstance) => (findPart(c.partId)?.pins.length ?? 0) <= 1 || /^TP\d/i.test(c.ref)

/** The nets each pin of a component is on. */
function pinNets(c: ComponentInstance, info: NetInfo): { name: string; net: TidyNet }[] {
  const out: { name: string; net: TidyNet }[] = []
  for (const p of findPart(c.partId)?.pins ?? []) {
    const id = info.pinNet.get(`${c.id}:${p.number}`)
    const net = id ? info.nets.get(id) : undefined
    if (net) out.push({ name: p.name, net })
  }
  return out
}

/** Reading order of the blocks, by the way power and signals flow between them. */
export function flowOrder(project: Project, blocks: SchematicBlock[], info: NetInfo): FlowBlock[] {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const members = (b: SchematicBlock) => b.components.map((id) => byId.get(id)).filter((c): c is ComponentInstance => !!c)

  // The controller: the chip with the most pins anywhere on the sheet.
  const chips = blocks.flatMap((b) => members(b).filter(isChip))
  const pinCount = (c: ComponentInstance) => findPart(c.partId)?.pins.length ?? 0
  const controller = [...chips].sort((a, b) => pinCount(b) - pinCount(a) || naturalCompare(a.ref, b.ref))[0]

  const supplies = (c: ComponentInstance) => pinNets(c, info).filter((p) => p.net.rail === "power")
  // Power comes in through the connector on the highest supply: VIN rather than 3V3, VBUS rather
  // than VCC. A connector that only hands lower supplies on is an output.
  const connectors = blocks.flatMap((b) => members(b).filter(isConnector))
  const top = Math.max(0, ...connectors.flatMap((c) => supplies(c).map((p) => railLevel(p.net.name))))

  // How many blocks away from the controller's each block is, along signals, and on which side
  // of it: a chain that reaches it only on its inputs (a sensor through an amplifier and a filter
  // into a converter's analog inputs) reads before it, the furthest first; anything else after it.
  const signalNets = (b: SchematicBlock) => new Set(members(b).flatMap((c) => pinNets(c, info).filter((p) => !p.net.rail).map((p) => p.net.id)))
  const nets = new Map(blocks.map((b) => [b.id, signalNets(b)]))
  const distance = new Map<string, number>()
  const upstream = new Set<string>()
  const home = blocks.find((x) => controller && x.components.includes(controller.id))
  if (home && controller) {
    const ctrlPins = pinNets(controller, info).filter((p) => !p.net.rail)
    // By the pins' names: a GPIO's kind says little about which way it is used.
    /** Whether a block meets the controller only on pins that take signals in. */
    const feedsIn = (b: SchematicBlock) => {
      const met = ctrlPins.filter((p) => nets.get(b.id)!.has(p.net.id))
      return met.length > 0 && met.every((p) => INPUT_PIN.test(p.name))
    }
    distance.set(home.id, 0)
    let frontier = [home]
    for (let d = 1; frontier.length; d++) {
      const next: SchematicBlock[] = []
      for (const f of frontier) {
        for (const o of blocks) {
          if (distance.has(o.id) || ![...nets.get(f.id)!].some((n) => nets.get(o.id)!.has(n))) continue
          distance.set(o.id, d)
          if (d === 1 ? feedsIn(o) : upstream.has(f.id)) upstream.add(o.id)
          next.push(o)
        }
      }
      frontier = next
    }
  }

  const rankOf = (b: SchematicBlock): { rank: Rank; key: number } => {
    const parts = members(b)
    const rails = new Set(parts.flatMap((c) => supplies(c).map((p) => p.net.id)))
    // The connector on the highest supply, and a battery's beside USB.
    const level = Math.max(0, ...parts.filter(isConnector).flatMap((c) => supplies(c).map((p) => railLevel(p.net.name))))
    const entry = top > 0 && (level >= top || level === BATTERY)
    const regulator = parts.find((c) => {
      if (!isChip(c)) return false
      const own = supplies(c)
      // An output pin on a supply: a regulator's, or a charger's battery pin.
      const out = own.some((p) => /^(V?OUT|VO|OUTPUT|V?BAT|VSYS)\d*$/i.test(p.name))
      const levels = new Set(own.map((p) => p.net.id))
      const switcher = parts.some((o) => /^L\d/i.test(o.ref) || findPart(o.partId)?.id === "inductor")
      return (out && levels.size >= 2) || (switcher && rails.size >= 2)
    })
    const regLevel = regulator ? Math.max(...supplies(regulator).map((p) => railLevel(p.net.name))) : 0
    if (entry && !parts.some((c) => c === controller)) return { rank: Rank.Entry, key: -level }
    if (regulator) return { rank: Rank.Regulation, key: -regLevel }
    if (controller && parts.includes(controller)) return { rank: Rank.Control, key: 0 }
    // Peripherals: the more nets shared with the controller's block, the sooner.
    const ctrlBlock = blocks.find((x) => controller && x.components.includes(controller.id))
    const ctrlNets = new Set(ctrlBlock ? members(ctrlBlock).flatMap((c) => pinNets(c, info).filter((p) => !p.net.rail).map((p) => p.net.id)) : [])
    const shared = new Set(parts.flatMap((c) => pinNets(c, info).filter((p) => !p.net.rail && ctrlNets.has(p.net.id)).map((p) => p.net.id))).size
    if (parts.length && parts.every(isTestPoint)) return { rank: Rank.Rest, key: -shared }
    const far = distance.get(b.id) ?? 0
    if (upstream.has(b.id)) return { rank: Rank.Upstream, key: -far }
    // After the controller: nearest first, chips before connectors and indicators.
    if (parts.some(isChip)) return { rank: Rank.Chips, key: far * 100 - shared }
    return { rank: Rank.Outputs, key: far * 100 - shared }
  }

  const firstRef = (b: SchematicBlock) =>
    members(b)
      .map((c) => c.ref)
      .sort((x, y) => naturalCompare(x, y))[0] ?? ""
  return blocks
    .map((b) => ({ b, ...rankOf(b) }))
    .sort(
      (x, y) =>
        x.rank - y.rank ||
        x.key - y.key ||
        naturalCompare(x.b.name, y.b.name) ||
        naturalCompare(firstRef(x.b), firstRef(y.b)),
    )
    .map((x, index) => ({ id: x.b.id, name: x.b.name, rank: x.rank, key: x.key, index }))
}

// ---------- Arranging frames ----------

export interface Frame {
  id: string
  width: number
  height: number
}

/** A landscape sheet, A4 and its family. */
const ASPECT = Math.SQRT2

/**
 * The room frames are packed into: a width and height from the first frame's top-left corner, less a notch at its bottom-right
 * corner (a page's title block) that no frame may cover.
 */
export interface PackTarget {
  width: number
  height: number
  notch: { width: number; height: number }
}

/**
 * Frames in rows, in reading order, top-aligned with even gaps: the row width is chosen so the
 * whole sheet comes out as compact as it can and close to a landscape page, `aspectWeight`
 * saying how much the shape counts against the area. With `stack`, a frame
 * short enough goes under the one before it rather than beside it, so small drawings fill the
 * height a tall one gives their row. With a `target` (the page of a whole-sheet tidy), an
 * arrangement that fits in it beats one that doesn't, and the shape aimed for is the target's.
 * Returns each frame's top-left corner, with y up, the first at (0, 0).
 */
export function packRows(frames: Frame[], gap: number, stack = false, aspectWeight = 1.5, target?: PackTarget): Map<string, { x: number; y: number }> {
  const widths = frames.map((f) => f.width)
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, frames.length - 1)
  type Column = { frames: Frame[]; width: number; height: number }
  type Row = { columns: Column[]; width: number; height: number }
  let best: { cost: number; rows: Row[] } | null = null
  // Every row width at which a row would break differently.
  const limits = new Set<number>([total])
  for (let i = 0; i < frames.length; i++) {
    let w = 0
    for (let j = i; j < frames.length; j++) {
      w += widths[j] + (j > i ? gap : 0)
      limits.add(Math.round(w * 1000) / 1000)
    }
  }
  const used = frames.reduce((a, f) => a + f.width * f.height, 0)
  const aim = target ? target.width / target.height : ASPECT
  /** Whether every frame of the rows is inside the target and clear of its notch. */
  const fits = (rows: Row[]) => {
    if (!target) return true
    const notchX = target.width - target.notch.width
    const notchY = -(target.height - target.notch.height)
    let y = 0
    for (const row of rows) {
      let x = 0
      for (const col of row.columns) {
        let top = y
        for (const f of col.frames) {
          const bottom = top - f.height
          if (x + f.width > target.width + 1e-6 || bottom < -target.height - 1e-6) return false
          if (x + f.width > notchX + 1e-6 && bottom < notchY - 1e-6) return false
          top = bottom - gap
        }
        x += col.width + gap
      }
      y -= row.height + gap
    }
    return true
  }
  for (const limit of [...limits].sort((a, b) => a - b)) {
    const rows: Row[] = []
    let row: Row | null = null
    for (const f of frames) {
      const col = row?.columns[row.columns.length - 1]
      if (row && col && stack && col.height + gap + f.height <= row.height + 1e-6 && row.width - col.width + Math.max(col.width, f.width) <= limit + 1e-6) {
        row.width += Math.max(col.width, f.width) - col.width
        col.width = Math.max(col.width, f.width)
        col.height += gap + f.height
        col.frames.push(f)
        continue
      }
      if (row && row.width + gap + f.width <= limit + 1e-6) {
        row.columns.push({ frames: [f], width: f.width, height: f.height })
        row.width += gap + f.width
        row.height = Math.max(row.height, f.height)
        continue
      }
      row = { columns: [{ frames: [f], width: f.width, height: f.height }], width: f.width, height: f.height }
      rows.push(row)
    }
    const W = Math.max(...rows.map((r) => r.width))
    const H = rows.reduce((a, r) => a + r.height, 0) + gap * (rows.length - 1)
    const area = W * H
    const aspect = W / H
    // An arrangement off the target loses to any on it; among those off it, the most compact still wins, for the page a size up.
    const cost = area * (1 + aspectWeight * Math.abs(Math.log(aspect / aim))) + (area - used) * 0.2 + (fits(rows) ? 0 : 1e12)
    if (!best || cost < best.cost - 1e-9) best = { cost, rows }
  }
  const out = new Map<string, { x: number; y: number }>()
  let y = 0
  for (const row of best?.rows ?? []) {
    let x = 0
    for (const col of row.columns) {
      let cy = y
      for (const f of col.frames) {
        out.set(f.id, { x, y: cy })
        cy -= f.height + gap
      }
      x += col.width + gap
    }
    y -= row.height + gap
  }
  return out
}
