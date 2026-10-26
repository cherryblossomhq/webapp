import { round } from "../../lib/geometry"
import { naturalCompare } from "../../lib/natural"
import { findPart } from "../library"
import type { ComponentInstance, Project } from "../types"
import { BlockLayout, type BlockContext, type BlockDrawing, type LayoutStyle } from "./block"
import { flowOrder, packRows } from "./flow"
import type { NetInfo } from "./nets"
import { isBoxPart } from "./shapes"

// A block split into clusters: each chip, connector or module with the small parts that serve it,
// and chains of small parts that serve none (a power LED). Each cluster is laid out about its chip
// on its own, and a block's clusters are arranged like a block's frames are on the sheet, so a big
// block reads as a few small drawings rather than one tangle. Nets between clusters get labels.
//
// A small part joins the chip it is wired to through the fewest other small parts. One wired to
// none (a decoupling capacitor between two rails) joins a chip with pins on its rails, the chips
// taking such parts in proportion to their pins on the rail.
//
// A supply that only a few small parts of the block serve is wired like a signal (`wiredSupplyPins`):
// a regulator's input and output capacitors at its pins, a connector, a diode and a regulator in a
// line, a chip's one or two decoupling capacitors at its supply pins. Chips joined that way are
// one cluster, so the wires can be drawn.

export interface Cluster {
  /** The chip, connector or module it is drawn about; null for small parts serving none. */
  seed: ComponentInstance | null
  parts: ComponentInstance[]
}

const byRef = (a: ComponentInstance, b: ComponentInstance) => naturalCompare(a.ref, b.ref)
const pinCount = (c: ComponentInstance) => findPart(c.partId)?.pins.length ?? 0
const compOf = (key: string) => key.slice(0, key.lastIndexOf(":"))

/** Whether a part is drawn as a cluster of its own: a chip, connector or module. */
export const isSeed = (c: ComponentInstance) => isBoxPart(findPart(c.partId))

/** Most small parts a supply may serve in a block and still be wired. */
const WIRED_PARTS = 3
/** Most chips and connectors on a supply wired in a block. */
const WIRED_SEEDS = 2

/**
 * The supply pins of a block drawn wired, as "componentId:pin". A supply (not ground) is wired
 * where one to three small parts serve it, each a part of the supply's own path: between rails (a
 * capacitor, a diode from one supply to the next), or on to small parts only (a switch on to its
 * diode, a resistor on to its LED); with the pins of at most two chips or connectors on it. A
 * pull-up to a chip's pin, or a supply ten connectors share, keeps a port at each pin.
 */
export function wiredSupplyPins(parts: ComponentInstance[], nets: NetInfo): Set<string> {
  const inBlock = new Map(parts.map((c) => [c.id, c]))
  const seedPin = (k: string) => {
    const c = inBlock.get(compOf(k))
    return !!c && isSeed(c)
  }
  /** Whether a small part's pins other than those on `net` lead only to rails and small parts. */
  const onPath = (c: ComponentInstance, net: string) =>
    (findPart(c.partId)?.pins ?? []).every((p) => {
      const id = nets.pinNet.get(`${c.id}:${p.number}`)
      const n = id ? nets.nets.get(id) : undefined
      if (!n || n.id === net || n.rail) return true
      return !n.pins.some((k) => compOf(k) !== c.id && seedPin(k))
    })
  const byNet = new Map<string, { small: Set<string>; seeds: Set<string>; pins: string[] }>()
  for (const c of parts) {
    for (const p of findPart(c.partId)?.pins ?? []) {
      const key = `${c.id}:${p.number}`
      const id = nets.pinNet.get(key)
      if (!id || nets.nets.get(id)?.rail !== "power") continue
      const e = byNet.get(id) ?? { small: new Set(), seeds: new Set(), pins: [] }
      byNet.set(id, e)
      if (isSeed(c)) {
        e.seeds.add(c.id)
        e.pins.push(key)
      } else if (onPath(c, id)) {
        e.small.add(c.id)
        e.pins.push(key)
      }
    }
  }
  const out = new Set<string>()
  for (const e of byNet.values()) {
    if (e.small.size < 1 || e.small.size > WIRED_PARTS || e.seeds.size > WIRED_SEEDS) continue
    for (const k of e.pins) out.add(k)
  }
  return out
}

export function clustersOf(parts: ComponentInstance[], nets: NetInfo, wired: Set<string> = wiredSupplyPins(parts, nets)): Cluster[] {
  const inBlock = new Map(parts.map((c) => [c.id, c]))
  const seeds = parts.filter(isSeed).sort((a, b) => pinCount(b) - pinCount(a) || byRef(a, b))
  const small = parts.filter((c) => !isSeed(c)).sort(byRef)

  /** Pins that join parts: on a signal net, or on a supply that is wired. */
  const links = (k: string) => {
    const id = nets.pinNet.get(k)
    return !!id && (!nets.nets.get(id)!.rail || wired.has(k))
  }
  /** The nets of a part's pins that join it to other parts of the block: no rails but wired ones. */
  const signalNets = (c: ComponentInstance) => {
    const out: string[] = []
    for (const p of findPart(c.partId)?.pins ?? []) {
      const key = `${c.id}:${p.number}`
      const id = nets.pinNet.get(key)
      const net = id ? nets.nets.get(id) : undefined
      if (!net || !links(key) || out.includes(net.id)) continue
      if (net.pins.some((k) => compOf(k) !== c.id && inBlock.has(compOf(k)) && links(k))) out.push(net.id)
    }
    return out
  }
  const railNets = (c: ComponentInstance) => {
    const out: string[] = []
    for (const p of findPart(c.partId)?.pins ?? []) {
      const id = nets.pinNet.get(`${c.id}:${p.number}`)
      const net = id ? nets.nets.get(id) : undefined
      if (net?.rail && !out.includes(net.id)) out.push(net.id)
    }
    return out
  }
  const onNet = new Map<string, ComponentInstance[]>()
  for (const c of [...seeds, ...small]) for (const n of signalNets(c)) onNet.set(n, [...(onNet.get(n) ?? []), c])

  // Breadth first from every chip at once, through small parts only: first along nets joining
  // just two pins, a wire from one to the other, then along nets that branch. So a divider wired
  // to its connector stays with the connector rather than the microcontroller its middle goes to.
  // On a branching net, a part joins a small part already placed before it joins a chip. (Pin
  // counts, not names, since the names a tidy gives must not change what the next one does.)
  const twoPin = (n: string) => nets.nets.get(n)!.pins.filter((k) => inBlock.has(compOf(k)) && links(k)).length === 2
  const owner = new Map<string, string>()
  const spread = (start: { part: ComponentInstance; seed: string }[], branching: boolean) => {
    let frontier = start
    while (frontier.length) {
      const next: typeof frontier = []
      for (const { part, seed } of frontier) {
        for (const n of signalNets(part)) {
          if (!branching && !twoPin(n)) continue
          for (const o of onNet.get(n) ?? []) {
            if (isSeed(o) || owner.has(o.id)) continue
            owner.set(o.id, seed)
            next.push({ part: o, seed })
          }
        }
      }
      frontier = next
    }
  }
  spread(seeds.map((s) => ({ part: s, seed: s.id })), false)
  spread(
    [
      ...small.filter((c) => owner.has(c.id)).map((c) => ({ part: c, seed: owner.get(c.id)! })),
      ...seeds.map((s) => ({ part: s, seed: s.id })),
    ],
    true,
  )

  // Small parts wired to no chip: those on a signal net together make a chain of their own; a
  // part alone, joined to the rest by rails only, goes to a chip on its rails.
  const loose = small.filter((c) => !owner.has(c.id))
  const chains: ComponentInstance[][] = []
  const seen = new Set<string>()
  for (const c of loose) {
    if (seen.has(c.id)) continue
    const chain: ComponentInstance[] = []
    const stack = [c]
    seen.add(c.id)
    while (stack.length) {
      const x = stack.pop()!
      chain.push(x)
      for (const n of signalNets(x)) {
        for (const o of onNet.get(n) ?? []) {
          if (seen.has(o.id) || owner.has(o.id) || isSeed(o)) continue
          seen.add(o.id)
          stack.push(o)
        }
      }
    }
    chains.push(chain.sort(byRef))
  }
  const own: ComponentInstance[][] = []
  // Rail-only parts, shared out among the chips on their rails.
  const quota = new Map<string, number>()
  for (const chain of chains) {
    if (chain.length > 1 || signalNets(chain[0]).length) {
      own.push(chain)
      continue
    }
    const c = chain[0]
    const all = railNets(c)
    // Shared out by pins on its supplies; by ground pins only for a part on ground alone.
    const supplies = all.filter((n) => nets.nets.get(n)!.rail === "power")
    const rails = supplies.length ? supplies : all
    const candidates = seeds
      .map((s) => ({ s, pins: (findPart(s.partId)?.pins ?? []).filter((p) => rails.includes(nets.pinNet.get(`${s.id}:${p.number}`) ?? "")).length }))
      .filter((x) => x.pins > 0)
    if (!candidates.length) {
      // On a supply no chip of the block has a pin on (a buck's output, made through its
      // inductor): with the block's main chip all the same, in its row, rather than off alone.
      if (seeds.length) owner.set(c.id, seeds[0].id)
      else own.push(chain)
      continue
    }
    // The chip whose share of these parts is least used, by its pins on the rails.
    candidates.sort((a, b) => (quota.get(a.s.id) ?? 0) / a.pins - (quota.get(b.s.id) ?? 0) / b.pins || b.pins - a.pins)
    const pick = candidates[0].s
    quota.set(pick.id, (quota.get(pick.id) ?? 0) + 1)
    owner.set(c.id, pick.id)
  }

  let out: Cluster[] = seeds.map((s) => ({ seed: s, parts: [s, ...small.filter((c) => owner.get(c.id) === s.id)] }))
  // Parts alone between rails that no chip takes (bulk capacitors, a TVS diode) make one row.
  const railOnly = (chain: ComponentInstance[]) => chain.length === 1 && !signalNets(chain[0]).length
  const row = own.filter(railOnly).flat()
  for (const chain of own) if (!railOnly(chain)) out.push({ seed: null, parts: chain })
  if (row.length) out.push({ seed: null, parts: row })

  // Clusters a wired supply runs between are one: a connector, its diode and the regulator after.
  const at = new Map<string, number>()
  out.forEach((cl, i) => cl.parts.forEach((c) => at.set(c.id, i)))
  const root = out.map((_, i) => i)
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])))
  const firstOn = new Map<string, number>()
  for (const k of [...wired].sort()) {
    const i = at.get(compOf(k))
    const net = nets.pinNet.get(k)
    if (i === undefined || !net) continue
    const j = firstOn.get(net)
    if (j === undefined) firstOn.set(net, i)
    else if (find(i) !== find(j)) root[Math.max(find(i), find(j))] = Math.min(find(i), find(j))
  }
  if (root.some((r, i) => r !== i)) {
    const merged = new Map<number, Cluster>()
    out.forEach((cl, i) => {
      const r = find(i)
      const m = merged.get(r)
      if (!m) merged.set(r, { seed: cl.seed, parts: [...cl.parts] })
      else {
        m.parts.push(...cl.parts)
        // The chip with the most pins is the one it is drawn about.
        if (cl.seed && (!m.seed || pinCount(cl.seed) > pinCount(m.seed))) m.seed = cl.seed
      }
    })
    out = [...merged.values()]
  }
  return out
}

// ---------- A block of clusters ----------

const STYLES: LayoutStyle[] = ["full", "plain", "first"]

/** Supplies a cluster wires up to which every way of giving some up is tried; past it, one at a time, then all. */
const DROP_ALL_WAYS = 3

/**
 * The supplies of a cluster to draw with a port at each pin rather than wired, in the order they
 * are tried: none, then each set of them, fewest first, ending with all. By name, so the same
 * sheet under new ids tries them in the same order.
 */
function supplyDrops(parts: ComponentInstance[], nets: NetInfo, isWired: (key: string) => boolean): Set<string>[] {
  const supplies = new Set<string>()
  for (const c of parts) {
    for (const p of findPart(c.partId)?.pins ?? []) {
      const key = `${c.id}:${p.number}`
      const net = nets.pinNet.get(key)
      if (net && nets.nets.get(net)?.rail && isWired(key)) supplies.add(net)
    }
  }
  const sorted = [...supplies].sort((a, b) => naturalCompare(nets.nets.get(a)!.name, nets.nets.get(b)!.name) || naturalCompare(nets.nets.get(a)!.key, nets.nets.get(b)!.key))
  const out: Set<string>[] = [new Set()]
  if (!sorted.length) return out
  if (sorted.length <= DROP_ALL_WAYS) {
    const subsets: string[][] = []
    for (let mask = 1; mask < 1 << sorted.length; mask++) subsets.push(sorted.filter((_, i) => mask & (1 << i)))
    // Fewest first; of as many, in the order of the names.
    subsets.sort((a, b) => a.length - b.length)
    for (const s of subsets) out.push(new Set(s))
    return out
  }
  for (const n of sorted) out.push(new Set([n]))
  out.push(new Set(sorted))
  return out
}

/** Between clusters of one block, in world units. */
export const CLUSTER_GAP = 0.6

export interface BlockLayoutContext extends Omit<BlockContext, "external"> {
  /** Whether a net has pins outside the block. */
  external: (net: string) => boolean
}

/** A block's drawing: each cluster laid out on its own, then the clusters in rows in reading order. */
export function layoutBlock(parts: ComponentInstance[], ctx: BlockLayoutContext): BlockDrawing {
  const wired = wiredSupplyPins(parts, ctx.nets)
  const clusters = clustersOf(parts, ctx.nets, wired)
  const clusterOf = new Map<string, number>()
  clusters.forEach((cl, i) => cl.parts.forEach((c) => clusterOf.set(c.id, i)))
  const drawings = clusters.map((cl, i) => {
    const external = (net: string) =>
      ctx.external(net) ||
      ctx.nets.nets.get(net)!.pins.some((k) => {
        const at = clusterOf.get(compOf(k))
        return at !== undefined && at !== i
      })
    // A supply with other names is wired too, so they have wire to stand on.
    const named = (key: string) => {
      const net = ctx.nets.pinNet.get(key)
      return !!net && (ctx.aliases?.(net).length ?? 0) > 0
    }
    const isWired = (key: string) => wired.has(key) || named(key)
    // Drawn with templates first; a cluster that can't be drawn so is drawn without them, then as
    // Tidy drew before either, so nothing that tidied before now fails to. Then with a port at each
    // pin of a supply it wires instead of the wire: a wire joining a chip's supply pins can wall in
    // the pins between them (a chip select tied to the rail under the bus pins), whose labels then
    // have nowhere to go. Fewest supplies given up first.
    let error: unknown = null
    for (const drop of supplyDrops(cl.parts, ctx.nets, isWired)) {
      const cctx = { ...ctx, external, wired: (key: string) => isWired(key) && !drop.has(ctx.nets.pinNet.get(key) ?? "") }
      for (const style of STYLES) {
        try {
          return new BlockLayout(cl.parts, cctx, style).layout()
        } catch (e) {
          error ??= e
        }
      }
    }
    throw error
  })
  if (drawings.length === 1) return drawings[0]

  // Reading order of the clusters, as of blocks on a sheet.
  const pseudo = clusters.map((cl, i) => ({ id: String(i), name: (cl.seed ?? cl.parts[0]).ref, components: cl.parts.map((c) => c.id) }))
  const order = flowOrder({ components: parts } as Project, pseudo, ctx.nets)
  const packed = packRows(
    order.map((f) => {
      const e = drawings[Number(f.id)].extent
      return { id: f.id, width: round(e.maxX - e.minX), height: round(e.maxY - e.minY) }
    }),
    CLUSTER_GAP,
    true,
    // Inside a frame, compact matters more than the frame's own shape.
    0.3,
  )
  const out: BlockDrawing = { parts: new Map(), wires: [], labels: [], ports: [], extent: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } }
  for (const [id, at] of packed) {
    const d = drawings[Number(id)]
    const dx = round(at.x - d.extent.minX)
    const dy = round(at.y - d.extent.maxY)
    const move = (p: { x: number; y: number }) => ({ x: round(p.x + dx), y: round(p.y + dy) })
    for (const [pid, p] of d.parts) out.parts.set(pid, { ...move(p), rot: p.rot })
    for (const w of d.wires) out.wires.push({ net: w.net, points: w.points.map(move) })
    for (const l of d.labels) out.labels.push({ ...l, ...move(l) })
    for (const p of d.ports) out.ports.push({ ...p, ...move(p) })
    out.extent = {
      minX: Math.min(out.extent.minX, d.extent.minX + dx),
      minY: Math.min(out.extent.minY, d.extent.minY + dy),
      maxX: Math.max(out.extent.maxX, d.extent.maxX + dx),
      maxY: Math.max(out.extent.maxY, d.extent.maxY + dy),
    }
  }
  return out
}
