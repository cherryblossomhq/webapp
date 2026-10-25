import { naturalCompare } from "../lib/natural"
import { schematicPins } from "./instances"
import { findPart } from "./library"
import { pinKindOfType } from "./pinKinds"
import { netInfo } from "./tidy/nets"
import { flowOrder } from "./tidy/flow"
import type { Project } from "./types"

// A block's ports: the nets that cross its frame, worked out from the netlist and never stored.
// Tidy uses their direction to face labels (in from the left, out to the right); a block diagram
// of the sheet, or real hierarchical sheets with a block as a sheet symbol and these as its sheet
// entries, can read the same thing later.

export type PortDirection = "in" | "out" | "bidir" | "power" | "ground"

export interface BlockPort {
  /** The net's id, as `computeConnectivity` gives it. */
  net: string
  name: string
  direction: PortDirection
  /** A bus it belongs to, such as I2C for SDA and SCL. */
  group?: string
  /** The block's own pins on it, as "REF.PIN". */
  pins: string[]
  /** The other blocks it reaches, by id; "" for parts in no block. */
  reaches: string[]
}

const BUSES: [RegExp, string][] = [
  [/(^|_)(SDA|SCL)\d*$/i, "I2C"],
  [/(^|_)(USB_?)?(D[PM+-]|DPLUS|DMINUS)\d*$|USB_D/i, "USB"],
  [/QSPI/i, "QSPI"],
  [/(^|_)(MOSI|MISO|COPI|CIPO|SCK|SCLK|CS|NSS|SS)\d*$/i, "SPI"],
  [/(^|_)(SWDIO|SWCLK|SWO|SWD)$/i, "SWD"],
  [/(^|_)(TXD?|RXD?|UART\w*)\d*$/i, "UART"],
]

/** Each block's place in reading order, by id. */
export const readingOrder = (project: Project, info = netInfo(project)) => new Map(flowOrder(project, project.blocks ?? [], info).map((f) => [f.id, f.index]))

/** The bus a net's name says it is part of, if any. */
export function busOf(name: string, others: string[]): string | undefined {
  for (const [re, bus] of BUSES) if (re.test(name)) return bus
  // Numbered siblings: GPIO0, GPIO1... share their stem.
  const m = name.match(/^(.*?[A-Za-z_])\d+$/)
  if (m && others.filter((o) => o !== name && o.startsWith(m[1]) && /^\d+$/.test(o.slice(m[1].length))).length) return m[1].replace(/_$/, "")
  return undefined
}

/**
 * The nets crossing a block's frame, in name order. `order` is the blocks' reading order, for
 * asking about several blocks at once.
 */
export function blockPorts(project: Project, blockId: string, info = netInfo(project), order = readingOrder(project, info)): BlockPort[] {
  const block = project.blocks?.find((b) => b.id === blockId)
  if (!block) return []
  const blockOf = new Map<string, string>()
  for (const b of project.blocks ?? []) for (const id of b.components) blockOf.set(id, b.id)
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const members = new Set(block.components)
  const here = order.get(blockId) ?? 0
  const ports: BlockPort[] = []
  for (const net of info.nets.values()) {
    const physical = net.pins.filter((k) => {
      const c = byId.get(k.slice(0, k.lastIndexOf(":")))
      return !!c && !findPart(c.partId)?.powerNet
    })
    const inside = physical.filter((k) => members.has(k.slice(0, k.lastIndexOf(":"))))
    const outside = physical.filter((k) => !members.has(k.slice(0, k.lastIndexOf(":"))))
    if (!inside.length || !outside.length) continue
    const reaches = [...new Set(outside.map((k) => blockOf.get(k.slice(0, k.lastIndexOf(":"))) ?? ""))].sort()
    const kinds = new Set(
      inside.map((k) => {
        const c = byId.get(k.slice(0, k.lastIndexOf(":")))!
        const number = k.slice(k.lastIndexOf(":") + 1)
        // A pin switched to another function is what that function is.
        const alt = c.pinAlt?.[number] ? schematicPins(c).find((p) => p.pin === number) : undefined
        const kind = alt?.type ? pinKindOfType(alt.type, alt.name) : undefined
        return (kind && kind !== "unknown" ? kind : undefined) ?? findPart(c.partId)?.pins.find((p) => p.number === number)?.kind ?? "passive"
      }),
    )
    let direction: PortDirection
    if (net.rail) direction = net.rail
    else if (kinds.size === 1 && kinds.has("output")) direction = "out"
    else if (kinds.size === 1 && kinds.has("input")) direction = "in"
    else if (kinds.has("io") || kinds.has("input") || kinds.has("output")) direction = "bidir"
    else {
      // Passive pins say nothing: what the net reaches downstream of this block is an output.
      const at = reaches.map((id) => order.get(id) ?? Infinity)
      direction = at.every((i) => i > here) ? "out" : at.every((i) => i < here) ? "in" : "bidir"
    }
    const pins = inside.map((k) => {
      const c = byId.get(k.slice(0, k.lastIndexOf(":")))!
      const pin = k.slice(k.lastIndexOf(":") + 1)
      const name = (c.pinAlt?.[pin] ? schematicPins(c).find((p) => p.pin === pin)?.name : undefined) ?? findPart(c.partId)?.pins.find((p) => p.number === pin)?.name ?? pin
      return `${c.ref}.${name}`
    })
    ports.push({ net: net.id, name: net.name, direction, pins, reaches })
  }
  const names = ports.map((p) => p.name)
  for (const p of ports) {
    if (p.direction === "power" || p.direction === "ground") continue
    const group = busOf(p.name, names)
    if (group) p.group = group
  }
  return ports.sort((a, b) => naturalCompare(a.name, b.name))
}
