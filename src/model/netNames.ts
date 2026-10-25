import { expandPinNumber } from "./pinNumbers"
import { symbolOf, unitLetters } from "./symbolDrawing"
import type { ComponentInstance, Net, PartDef } from "./types"

// S2: the names KiCad gives nets, for a project that is named that way (`Project.netNames`).
//
// KiCad names a net after its driver: the item on it of the highest priority (a global label, a global
// power symbol, a local power symbol, a local label; `CONNECTION_SUBGRAPH::PRIORITY`,
// eeschema/connection_graph.h). Between drivers of one priority the name that sorts first wins, a name
// with `-Pad` in it last (`candidate_cmp`, connection_graph.cpp). A global label or a global power
// symbol names the net as it is written; a local label or a local power symbol puts the sheet's path
// in front (`/NAME` on the root sheet: `SCH_CONNECTION::recacheName`). A net no label or power symbol
// names is named after one of its pins, `Net-(R1-Pad2)`, or `unconnected-(R1-Pad2)` where it is a pin
// alone (`SCH_PIN::GetDefaultNetName`, sch_pin.cpp, and the weakly driven single pin rule of
// `CONNECTION_GRAPH::buildConnectionGraph`). The editor writes names as the user reads them: a `/` that
// KiCad writes `{slash}` is `/`.

/** The priority of each kind of driver, as `CONNECTION_SUBGRAPH::PRIORITY` numbers them. */
export const DRIVER = { pin: 1, label: 4, localPower: 5, globalPower: 6, globalLabel: 7 } as const

/** What a net's name came from: the text to type to get it back, and which kind of label or symbol. */
export interface NameDriver {
  prio: number
  /** The net's name if this driver wins: `/NAME` for a local one. */
  name: string
  /** What the driver is written as: the label's text, or the power symbol's net. */
  text: string
  kind: "local" | "global"
  /** A label or a power symbol. */
  from: "label" | "power"
}

/** The driver KiCad picks among those of a net: the highest priority, then `-Pad` names last, then the name that sorts first. */
export function bestDriver(drivers: readonly NameDriver[]): NameDriver | undefined {
  let best: NameDriver | undefined
  for (const d of drivers) {
    if (!best || d.prio > best.prio) {
      best = d
      continue
    }
    if (d.prio < best.prio) continue
    const lowD = barePad(d.text)
    const lowB = barePad(best.text)
    if (lowD !== lowB ? lowB : d.text < best.text) best = d
  }
  return best
}

const barePad = (name: string) => name.includes("-Pad")

/** The name KiCad gives a net from a driver: a local one has the sheet's path in front. The root sheet's path is `/`. */
export const driverName = (text: string, kind: "local" | "global", sheetPath = "/") => (kind === "local" ? `${sheetPath}${text}` : text)

/** The names the editor and KiCad make up for a net nothing names: `Net-(R1-2)`, `Net-(R1-Pad2)`, `unconnected-(R1-Pad2)`. */
export const isAutoNetName = (name: string) => /^(?:Net|unconnected)-\(.+\)$/.test(name) || /^N\$\d+$/.test(name)

/** What KiCad shows for a connection with no name at all (a power symbol whose Value is empty). */
export const NO_NET = "<NO NET>"

/** KiCad's `GetShownName`: a pin named `~` has no name. */
const shown = (name: string) => (name.trim() === "~" ? "" : name)

/** The unit letter KiCad adds to a reference of a symbol with several units: A for unit 1. */
export function unitSuffix(c: Pick<ComponentInstance, "unit">, part: PartDef): string {
  return (part.units?.count ?? 1) > 1 ? unitLetters(c.unit ?? 1) : ""
}

/** One pin of a symbol as KiCad names a net after it. */
export interface PinFact {
  /** The pin's name as the symbol gives it (`~{RESET}` is kept as written; `~` and nothing are no name). */
  name: string
  number: string
  /** The smallest pad number of the drawn pin this one is a pad of, which names a net (`[6,7,9-11]` is pad 6): the number itself for any other pin. */
  pad?: string
  /** The pin is of the type no connect. */
  noConnect?: boolean
}

/**
 * `SCH_PIN::GetDefaultNetName`: `Net-(R1-Pad2)` for a pin with no name or a name that is its number,
 * `Net-(U1A-VCC)` for a named pin (with the unit's letter when the symbol has several units, and `-Pad2`
 * added when another pin of the unit has the same name, or the pin is not connected), and
 * `unconnected-(...)` where nothing but the pin itself is on the net. KiCad 6 names every pin `-PadN`.
 * An unannotated symbol (`U?`) has its uuid in place of its reference.
 */
export function pinNetName(
  rule: "kicad" | "kicad6",
  ref: string,
  unitLetter: string,
  pin: PinFact,
  sameUnit: readonly PinFact[],
  unconnected: boolean,
  uuid = "",
): string {
  const start = unconnected || pin.noConnect ? "unconnected-(" : "Net-("
  const lone = unconnected || !!pin.noConnect
  if (/\?$/.test(ref) || ref === "") return `${start}${rule === "kicad6" ? ref : ""}${uuid}-Pad${pin.pad ?? pin.number})`
  const name = shown(pin.name)
  const pad = pin.pad ?? pin.number
  if (rule === "kicad6" || name === "" || name === pin.number) return `${start}${ref}-Pad${pad})`
  const has = sameUnit.some((q) => shown(q.name) === name && (q.pad ?? q.number) !== pad && !q.noConnect)
  return `${start}${ref}${unitLetter}-${name}${lone || has ? `-Pad${pad}` : ""})`
}

/** The facts of every pin a component's symbol draws, in the unit and body style it is placed as. */
export function pinFacts(c: ComponentInstance, part: PartDef): PinFact[] {
  const symbol = symbolOf(part, c)
  const raw = new Map((symbol.pinLabels ?? []).map((l) => [l.number, l.name]))
  // The pads of a stacked pin (`[6,7,9-11]`) are one pin of the symbol, named after its smallest pad.
  const padOf = new Map<string, string>()
  for (const l of symbol.pinLabels ?? []) {
    const pads = expandPinNumber(l.number)
    if (pads.length > 1) for (const n of pads) padOf.set(n, [...pads].sort((a, b) => (Number.isNaN(Number(a)) || Number.isNaN(Number(b)) ? (a < b ? -1 : 1) : Number(a) - Number(b)))[0])
  }
  const out: PinFact[] = []
  const seen = new Set<string>()
  for (const port of symbol.ports) {
    if (seen.has(port.pin)) continue
    seen.add(port.pin)
    const def = part.pins.find((p) => p.number === port.pin)
    const alt = c.pinAlt?.[port.pin]
    const altName = alt ? def?.alternates?.find((a) => a.name === alt)?.name : undefined
    // A symbol drawn from KiCad's keeps its pin's name as written; the editor's own pins have the name in the part.
    const name = altName ?? (def?.unnamed ? "" : (raw.get(port.pin) ?? def?.name ?? ""))
    out.push({ name, number: port.pin, ...(padOf.has(port.pin) ? { pad: padOf.get(port.pin) } : {}), ...(port.type === "no_connect" || def?.type === "no_connect" ? { noConnect: true } : {}) })
  }
  return out
}

/**
 * The text to give a label so that it joins the net called `name` in a project named as KiCad names its
 * nets: the label text the net is named by, so `/SDA` (a local label's net) is the text `SDA`. A name no
 * net has, that starts with the sheet's `/`, is a local label's: the text is what follows it.
 */
export function labelTextFor(nets: readonly Net[], name: string): string {
  const net = nets.find((n) => n.name === name)
  if (net?.label) return net.label.text
  if (net) return net.name
  return name.startsWith("/") && name.length > 1 ? name.slice(1) : name
}
