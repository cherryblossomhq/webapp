import { naturalCompare } from "../../lib/natural"
import { pinKey } from "../connectivity"
import { addToBlock, createBlock } from "../blocks"
import { schematicBounds, schematicPins, valueText } from "../instances"
import { findPart } from "../library"
import { isArranged, netInfo } from "../tidy/nets"
import type { ComponentInstance, Project, SchematicBlock } from "../types"
import { isBulkCap, isCapacitor, isHelper, isLed, isMainPart, isPowerChip, mainRank, roleOf, switchPins } from "./roles"

// Grouping: the parts that are in no block put into blocks, from how they are wired.
//
// Each chip, module, regulator or connector with a handful of pins (its "main part") is the centre
// of a block, and every small part joins the main part it is wired to most directly:
//
// - Cost of a wire between two parts: 1 along a net of just those two, else 2, or 0.8 from a
//   resistor, so a part prefers a resistor already on its net to the chip behind it (a divider's
//   lower resistor follows the upper one to its connector, while a pull-up and a reset switch stay
//   with the chip, though a capacitor from a header reaches the same net). Ground joins nothing.
// - A part's main part is the cheapest one to reach through small parts only, so a resistor and
//   LED hung from a pin follow the pin, a crystal and its load capacitors follow the clock pins, a
//   pull-up and a reset switch follow the reset pin, and a diode in a connector's supply line goes
//   with the connector or the regulator it is wired to.
// - A supply that four or more parts share joins nothing by wire: a part on one (a decoupling
//   capacitor) costs 4 plus its distance on the sheet to a pin of each main part on that rail,
//   nearest first, with regulators preferred for bulk capacitors and avoided for decoupling ones.
//   Wire beats rail, so a capacitor on a signal line goes with the chip on it.
//   Where a regulator or charger is on the rail, a capacitor never goes to a connector, protector or
//   supervisor (`isHelper`), however far apart the sheet is spread. A switching regulator's output is
//   the net behind its inductor.
// - A chain of small parts reaching no main part but by such a rail and holding an LED (a power
//   LED and its resistor) is a block of its own.
// - What is left goes to the nearest main part if one is within `NEAR`, else to OTHER.
//
// Parts already in a block are never moved: their blocks keep every part, and a loose part wired
// to one of them joins it. The OTHER block that Tidy makes (`leftover`) is not a grouping: its parts
// are loose, and a part that stays in OTHER stays in that block, never in a user's block of that name.

/** Cost of joining a main part over a rail with four or more parts on it, before distance. */
const RAIL_COST = 4
/** A part this near a main part (schematic units) with nothing else to go with joins its block. */
const NEAR = 3
/** Farthest distance that counts against a part on a rail. */
const FAR = 20
/**
 * What a regulator's distance to a bulk capacitor counts for, against 1 for a chip's: a bulk cap
 * leans to the regulator but, standing in a chip's own decoupling row, stays with the chip.
 */
const BULK_WEIGHT = 0.8
const EPS = 1e-9
/** Most parts on a net for each pair to be linked; bigger nets are treated like rails. */
const MAX_LINKED = 12
/** Longest block name from a main part's role, designator and value. */
const NAME_LENGTH = 26

export interface BlockGroup {
  /** The block these parts went into. */
  blockId: string
  name: string
  /** False when they joined a block that was already there. */
  isNew: boolean
  /** The main part, when the block is named after one. */
  main: string | null
  /** The loose parts it took, by id. */
  parts: string[]
}

export interface Grouping {
  project: Project
  groups: BlockGroup[]
  /** Loose parts put in blocks. */
  grouped: number
  /** Blocks made. */
  created: number
  /** Loose parts that joined blocks already there. */
  joined: number
}

const compOf = (key: string) => key.slice(0, key.lastIndexOf(":"))

interface Link {
  /** The net, by its id in `netInfo`. */
  net: string
  comps: string[]
  /** A supply too crowded to say who serves whom by wire. */
  rail: boolean
}

/** A new block's name: its main part's role and designator, and its value while it fits. */
export function blockName(c: ComponentInstance, withValue = true): string {
  const part = findPart(c.partId)
  const base = `${roleOf(part)} ${c.ref}`
  const value = withValue ? valueText(c, part).trim().toUpperCase() : ""
  return value && value !== c.ref && base.length + 1 + value.length <= NAME_LENGTH ? `${base} ${value}` : base
}

/**
 * Each part as it was drawn. After Tidy the sheet remembers where every part was before (`origins`
 * of the OTHER block), and as long as all of them are still where Tidy left them, those positions are
 * what distances are measured on; otherwise the parts are read where they are.
 */
function drawnPositions(project: Project, parts: ComponentInstance[]): (c: ComponentInstance) => ComponentInstance {
  const origins: NonNullable<SchematicBlock["origins"]> = {}
  for (const b of project.blocks ?? []) if (b.leftover) Object.assign(origins, b.origins)
  const same = (c: ComponentInstance) => {
    const o = origins[c.id]
    return !!o && o.to.x === c.sch.x && o.to.y === c.sch.y && o.to.rot === c.sch.rot
  }
  if (!parts.length || !parts.every(same)) return (c) => c
  const cache = new Map<string, ComponentInstance>()
  return (c) => {
    let moved = cache.get(c.id)
    if (!moved) {
      moved = { ...c, sch: origins[c.id].from }
      cache.set(c.id, moved)
    }
    return moved
  }
}

/**
 * Put every part in no block into one. Blocks that exist keep their names, ids and every part;
 * loose parts wired to one of them join it. Connections are never touched, since a block is only a
 * list of parts.
 */
export function groupLooseParts(project: Project): Grouping {
  const none: Grouping = { project, groups: [], grouped: 0, created: 0, joined: 0 }
  const parts = project.components
    .filter((c) => isArranged(c.partId))
    .sort((a, b) => naturalCompare(a.ref, b.ref) || naturalCompare(a.id, b.id))
  const blockOf = new Map<string, string>()
  // The OTHER block Tidy makes for parts it could not place holds loose parts, not a grouping: its parts are grouped anew.
  for (const b of project.blocks ?? []) if (!b.leftover) for (const id of b.components) blockOf.set(id, b.id)
  const loose = parts.filter((c) => !blockOf.has(c.id))
  if (!loose.length) return none

  const byId = new Map(parts.map((c) => [c.id, c]))
  const drawn = drawnPositions(project, parts)
  const info = netInfo(project)
  const main = (id: string) => isMainPart(findPart(byId.get(id)!.partId))
  const isResistor = (id: string) => byId.get(id)!.partId === "resistor"

  // ---------- What joins what ----------
  const links: Link[] = []
  for (const net of info.nets.values()) {
    if (net.rail === "ground") continue
    const comps = [...new Set(net.pins.map(compOf).filter((id) => byId.has(id)))]
    if (comps.length < 2) continue
    comps.sort((a, b) => naturalCompare(byId.get(a)!.ref, byId.get(b)!.ref))
    links.push({ net: net.id, comps, rail: (net.rail === "power" && comps.length >= 4) || comps.length > MAX_LINKED })
  }
  const adj = new Map<string, { to: string; cost: number }[]>()
  for (const l of links) {
    if (l.rail) continue
    for (const u of l.comps) {
      for (const v of l.comps) {
        if (u === v) continue
        const cost = l.comps.length === 2 ? 1 : isResistor(u) ? 0.8 : 2
        adj.set(u, [...(adj.get(u) ?? []), { to: v, cost }])
      }
    }
  }

  // ---------- Where each part starts: main parts, and parts in blocks already ----------
  const labelOf = (id: string) => (blockOf.has(id) ? `b:${blockOf.get(id)}` : `a:${id}`)
  const sources = parts.filter((c) => main(c.id) || blockOf.has(c.id))
  // A small tie-breaker per source, so that two equal ways to a chip choose the same one all the way along a chain.
  const penalty = new Map<string, number>()
  const rankOf = (c: ComponentInstance) => (main(c.id) ? mainRank(findPart(c.partId)) : 3)
  ;[...sources]
    .sort((a, b) => rankOf(a) - rankOf(b) || naturalCompare(a.ref, b.ref))
    .forEach((c, i) => penalty.set(c.id, rankOf(c) * 0.01 + i * 1e-5))
  const isSource = (id: string) => penalty.has(id)

  const dist = new Map<string, number>()
  const label = new Map<string, string>()
  for (const c of sources) {
    dist.set(c.id, penalty.get(c.id)!)
    label.set(c.id, labelOf(c.id))
  }

  // Loose small parts on a crowded supply: each main part on it, by distance to its nearest pin.
  const center = (c: ComponentInstance) => {
    const b = schematicBounds(drawn(c))
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  }
  const pinsOf = new Map<string, ReturnType<typeof schematicPins>>()
  const pinsOn = (id: string, net?: string) => {
    let pins = pinsOf.get(id)
    if (!pins) {
      pins = schematicPins(drawn(byId.get(id)!))
      pinsOf.set(id, pins)
    }
    return net ? pins.filter((p) => info.pinNet.get(pinKey(id, p.pin)) === net) : pins
  }
  /** From the middle of a small part to the nearest pin of a main part, on `net` when given. */
  const distance = (small: ComponentInstance, mainId: string, net?: string) => {
    const at = center(small)
    const pins = pinsOn(mainId, net)
    return pins.length ? Math.min(FAR, ...pins.map((p) => Math.hypot(p.pos.x - at.x, p.pos.y - at.y))) : FAR
  }
  // The output of a switching regulator is behind its inductor, not on a pin of its own: the net
  // on the far side of the inductor from the switch pin.
  const behindInductor = new Map<string, string[]>()
  for (const c of parts) {
    for (const pin of switchPins(findPart(c.partId))) {
      const sw = info.pinNet.get(pinKey(c.id, pin.number))
      for (const key of sw ? info.nets.get(sw)?.pins ?? [] : []) {
        const coil = byId.get(compOf(key))
        if (!coil || !/^inductor/.test(coil.partId)) continue
        for (const p of findPart(coil.partId)?.pins ?? []) {
          const out = info.pinNet.get(pinKey(coil.id, p.number))
          if (out && out !== sw) behindInductor.set(out, [...new Set([...(behindInductor.get(out) ?? []), c.id])])
        }
      }
    }
  }
  for (const l of links) {
    if (!l.rail) continue
    const onNet = l.comps.filter(main)
    const mains = [...onNet, ...(behindInductor.get(l.net) ?? []).filter((id) => !onNet.includes(id))]
    // A supply with a regulator or charger on it: that is where its capacitors belong, and the
    // connectors, protectors and supervisors on it do not take them, however far apart the sheet is spread.
    const powered = mains.some((m) => isPowerChip(findPart(byId.get(m)!.partId)))
    const reach = (small: ComponentInstance, m: string) => distance(small, m, onNet.includes(m) ? l.net : undefined)
    for (const id of l.comps) {
      if (isSource(id)) continue
      const small = byId.get(id)!
      for (const m of mains) {
        const part = findPart(byId.get(m)!.partId)
        if (powered && isCapacitor(small) && isHelper(part)) continue
        const regulator = mainRank(part) === 0
        const away = reach(small, m)
        const weight = regulator ? (isBulkCap(small) ? BULK_WEIGHT : 1.25) : 1
        const cost = RAIL_COST + away * 0.04 * weight + penalty.get(m)!
        if (cost < (dist.get(id) ?? Infinity) - EPS) {
          dist.set(id, cost)
          label.set(id, labelOf(m))
        }
      }
    }
  }

  // ---------- Cheapest way from a main part to every small one ----------
  const done = new Set<string>()
  for (;;) {
    let u: string | null = null
    for (const [id, d] of dist) {
      if (done.has(id)) continue
      if (u === null) u = id
      else {
        const best = dist.get(u)!
        if (d < best - EPS || (Math.abs(d - best) <= EPS && naturalCompare(byId.get(id)!.ref, byId.get(u)!.ref) < 0)) u = id
      }
    }
    if (u === null) break
    done.add(u)
    for (const { to, cost } of adj.get(u) ?? []) {
      if (isSource(to) || done.has(to)) continue
      const nd = dist.get(u)! + cost
      if (nd < (dist.get(to) ?? Infinity) - EPS) {
        dist.set(to, nd)
        label.set(to, label.get(u)!)
      }
    }
  }

  // ---------- Chains with an LED that no wire joins to a main part ----------
  const wired = new Set<string>()
  for (const l of links) {
    if (l.rail) continue
    if (l.comps.some(isSource)) for (const id of l.comps) if (!isSource(id)) wired.add(id)
  }
  const seen = new Set<string>()
  for (const c of loose) {
    if (isSource(c.id) || seen.has(c.id)) continue
    const chain: string[] = []
    const stack = [c.id]
    seen.add(c.id)
    while (stack.length) {
      const id = stack.pop()!
      chain.push(id)
      for (const { to } of adj.get(id) ?? []) {
        if (isSource(to) || seen.has(to)) continue
        seen.add(to)
        stack.push(to)
      }
    }
    if (chain.some((id) => wired.has(id))) continue
    const led = chain
      .map((id) => byId.get(id)!)
      .filter((p) => isLed(findPart(p.partId)))
      .sort((a, b) => naturalCompare(a.ref, b.ref))[0]
    if (led) for (const id of chain) label.set(id, `c:${led.id}`)
  }

  // ---------- What nothing is wired to: the nearest main part, if near, else OTHER ----------
  const mains = sources.filter((c) => main(c.id))
  for (const c of loose) {
    if (label.has(c.id)) continue
    let best: { label: string; d: number } | null = null
    for (const m of mains) {
      const d = distance(c, m.id)
      if (d <= NEAR && (!best || d < best.d - EPS)) best = { label: labelOf(m.id), d }
    }
    label.set(c.id, best?.label ?? "other")
  }

  // ---------- Assemble the groups ----------
  const taken = new Map<string, string[]>()
  for (const c of loose) taken.set(label.get(c.id)!, [...(taken.get(label.get(c.id)!) ?? []), c.id])
  interface Draft {
    name: string
    main: string | null
    parts: string[]
    /** Repeated circuits are told apart by what is in them. */
    signature: string | null
    order: [number, string]
  }
  const drafts: Draft[] = []
  const joins: { blockId: string; parts: string[] }[] = []
  let other: string[] = []
  for (const [key, ids] of [...taken].sort(([a], [b]) => naturalCompare(a, b))) {
    if (key === "other") {
      other = ids
    } else if (key.startsWith("b:")) {
      joins.push({ blockId: key.slice(2), parts: ids })
    } else {
      const head = byId.get(key.slice(2))!
      const part = findPart(head.partId)
      const helpers = ids.filter((id) => id !== head.id)
      // A connector with its own small parts, or an LED chain: circuits that get repeated.
      const repeats = key.startsWith("c:") || (part?.category === "Connectors" && helpers.length > 0)
      const signature = repeats
        ? `${head.partId}|${helpers
            .map((id) => `${byId.get(id)!.partId}=${valueText(byId.get(id)!)}`)
            .sort()
            .join(",")}`
        : null
      drafts.push({
        name: blockName(head, !key.startsWith("c:")),
        main: head.id,
        parts: [head.id, ...helpers],
        signature,
        order: [key.startsWith("c:") ? 3 : mainRank(part), head.ref],
      })
    }
  }
  // Three line sensors wired alike are one block of three, not three blocks.
  const merged: Draft[] = []
  const bySignature = new Map<string, Draft[]>()
  for (const d of drafts) {
    if (d.signature) bySignature.set(d.signature, [...(bySignature.get(d.signature) ?? []), d])
    else merged.push(d)
  }
  for (const group of bySignature.values()) {
    if (group.length < 2) {
      merged.push(...group)
      continue
    }
    const head = byId.get(group[0].main!)!
    const part = findPart(head.partId)
    merged.push({
      name: `${(isLed(part) ? "LED" : part?.name ?? "PART").toUpperCase()} x${group.length}`,
      main: group[0].main,
      parts: group.flatMap((d) => d.parts),
      signature: null,
      order: group[0].order,
    })
  }
  merged.sort((a, b) => a.order[0] - b.order[0] || naturalCompare(a.order[1], b.order[1]))

  // ---------- Make the blocks ----------
  let next = project
  const groups: BlockGroup[] = []
  let created = 0
  let joined = 0
  const make = (name: string, ids: string[], mainId: string | null) => {
    const r = createBlock(next, name, ids)
    next = r.project
    if (!r.block) return
    created++
    groups.push({ blockId: r.block.id, name: r.block.name, isNew: true, main: mainId, parts: ids })
  }
  const join = (blockId: string, ids: string[]) => {
    next = addToBlock(next, blockId, ids)
    joined += ids.length
    groups.push({ blockId, name: next.blocks!.find((b) => b.id === blockId)!.name, isNew: false, main: null, parts: ids })
  }
  for (const d of merged) make(d.name, d.parts, d.main)
  for (const j of joins) join(j.blockId, j.parts)
  // What stays in OTHER joins Tidy's block for it when there is one; a block the user named OTHER is theirs.
  const leftover = next.blocks?.find((b) => b.leftover)
  const staying = other.filter((id) => !leftover?.components.includes(id))
  if (staying.length) {
    if (leftover) join(leftover.id, staying)
    else make("OTHER", staying, null)
  }
  return { project: next, groups, grouped: loose.length - (other.length - staying.length), created, joined }
}
