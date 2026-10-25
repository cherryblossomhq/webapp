import { naturalCompare } from "../../lib/natural"
import { computeConnectivity, pinKey, type SchematicConnectivity } from "../connectivity"
import { isSchematicPart, powerNetName, schematicPins, unitOwners } from "../instances"
import { findPart } from "../library"
import { fieldsInFrame, hasFieldPlaces } from "../symbolDrawing"
import type { ComponentInstance, Project } from "../types"
import { portProblem, type PortVia, type RailKind } from "./shapes"

// The nets as Tidy needs them: which pin is on which, which are supply rails (drawn with power
// and ground ports), and names for the unnamed ones that end up needing a label.

export interface TidyNet {
  /** The net's id in `computeConnectivity`. */
  id: string
  name: string
  /** Named by a label or port, rather than after one of its pins. */
  named: boolean
  /**
   * Named by someone other than Tidy: a name that isn't the one Tidy gives an unnamed net it
   * labels (`nameForNet`), nor the editor's own (`Net-(R1-2)`). Where parts go never hangs on a
   * name Tidy gave, so a second tidy makes every choice the first one did.
   */
  given: boolean
  rail: RailKind | null
  /**
   * The power symbol brought in from KiCad that the net's ports are drawn as, when it has one: the
   * ports Tidy draws for the net are that part, not the editor's own (`withPortVias`).
   */
  port?: PortVia
  /** Why Tidy can't draw that symbol (`portProblem`); then Tidy leaves the sheet as it is. */
  portProblem?: string
  /** Pins of every component on it, ports included, as "componentId:pin". */
  pins: string[]
  /**
   * Its first physical pin, as "componentId:pin": what orders nets, since it stays the same when
   * Tidy names a net, so a second tidy makes every choice the first one did.
   */
  key: string
}

export interface NetInfo {
  /** Net id by "componentId:pin", for every pin on a net. */
  pinNet: Map<string, string>
  nets: Map<string, TidyNet>
  /** The connectivity it was read from. */
  conn: SchematicConnectivity
}

const GROUND = /^(A|D|P|S|C)?GND([_-]?[A-Z0-9]*)?$|^GND[A-Z0-9_]*$|^VSS[A-Z0-9_]*$|^0V$|^GROUND$|^EARTH$|^CHASSIS[A-Z0-9_]*$/i
const SUPPLY =
  /^\+?\d+(\.\d+)?V\d*(_[A-Z0-9]+)?$|^\+?\d+V\d+$|^V\d+(_\d+)?(_[A-Z0-9]+)?$|^V\d+V\d+$|^[+-]?(VCC|VDD|VBUS|VIN|VBAT|VSYS|VMOT|VM|VPP|VCCIO|VDDIO|IOVDD|AVDD|DVDD|AVCC|DVCC|VREG|VEXC|VLED|VUSB|VRAW|VSUPPLY|VPWR)([_-]?[A-Z0-9]*)$|_(VCC|VDD|VIN)$/i
/** Names of a rail's sense, divider or enable lines, which are signals: VBAT_SNS, VBUS_DET. */
const NOT_SUPPLY = /SNS|SENSE|DET|MON|_DIV|_FB$|_ADC|_EN$|_OK$|_PG$/i

/**
 * Ground, a supply, or neither: from the ports on the net, then its name, then the kinds of the
 * pins on it. Boards brought in from elsewhere have no ports and no pin kinds, so the name is often
 * all there is.
 */
function railOf(name: string, kinds: Set<string>, ports: Set<string>): RailKind | null {
  if (ports.has("ground")) return "ground"
  if (ports.has("power")) return GROUND.test(name) ? "ground" : "power"
  if (GROUND.test(name)) return "ground"
  if (kinds.has("ground") && !kinds.has("power")) return "ground"
  if (SUPPLY.test(name) && !NOT_SUPPLY.test(name)) return "power"
  if (kinds.has("power") && !NOT_SUPPLY.test(name)) return "power"
  return null
}

/** The nets of a project, with their rails. */
export function netInfo(project: Project): NetInfo {
  const conn = computeConnectivity(project)
  let pinNet = new Map(conn.pinNet)
  // A pin of a unit is listed under the part's own component as well (`unitOwners`); Tidy works with
  // what each component draws, so a pin is on the component that draws it and on no other.
  if (unitOwners(project.components).size) {
    const drawn = new Set<string>()
    for (const c of project.components) for (const p of schematicPins(c)) drawn.add(pinKey(c.id, p.pin))
    pinNet = new Map([...pinNet].filter(([k]) => drawn.has(k)))
  }
  const nets = new Map<string, TidyNet>()
  const byId = new Map(conn.nets.map((n) => [n.id, n]))
  const pinsOf = new Map<string, string[]>()
  for (const [pin, id] of pinNet) pinsOf.set(id, [...(pinsOf.get(id) ?? []), pin])
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const byComp = new Map(project.components.map((c) => [c.id, c]))
  const portIds = new Set(project.components.filter((c) => findPart(c.partId)?.powerNet).map((c) => c.id))
  const kinds = new Map<string, Set<string>>()
  const ports = new Map<string, Set<string>>()
  /** The power symbols from KiCad on each net, by part, with the first one of each: what its ports are drawn as. */
  const imported = new Map<string, Map<string, { count: number; first: ComponentInstance }>>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part) continue
    for (const p of part.pins) {
      const id = pinNet.get(pinKey(c.id, p.number))
      if (!id) continue
      if (part.powerNet) {
        const set = ports.get(id) ?? new Set()
        ports.set(id, set.add(part.id === "ground" ? "ground" : "power"))
        if (hasFieldPlaces(part)) {
          const byPart = imported.get(id) ?? new Map()
          const seen = byPart.get(part.id)
          byPart.set(part.id, { count: (seen?.count ?? 0) + 1, first: seen?.first ?? c })
          imported.set(id, byPart)
        }
      } else if (p.kind) {
        const set = kinds.get(id) ?? new Set()
        kinds.set(id, set.add(p.kind))
      }
    }
  }
  for (const [id, pins] of pinsOf) {
    const net = byId.get(id)
    if (!net) continue
    // By designator rather than id, so a copy of a sheet tidies as the sheet does.
    const physical = pins.filter((k) => !portIds.has(k.slice(0, k.lastIndexOf(":")))).map((k) => `${refOf.get(k.slice(0, k.lastIndexOf(":")))}:${k.slice(k.lastIndexOf(":") + 1)}|${k}`)
    // The name the net goes by in the editor, kept as it is: where a net has several names, Tidy
    // draws only this one and says which others it dropped.
    const base = baseName(byComp, pins)
    const made = !net.named || /^Net-\(.+\)$/.test(net.name) || net.name === base || (net.name.startsWith(`${base}_`) && /^\d+$/.test(net.name.slice(base.length + 1)))
    nets.set(id, {
      id,
      key: [...physical].sort()[0] ?? id,
      name: net.name,
      named: net.named,
      given: !made,
      // A pin alone on an unnamed net (a stub off a supply pin) is on nothing: never a rail, or
      // the port Tidy would draw there would name it and join it to whatever shares that name.
      // A name Tidy made up says nothing of what the net is: the pins and ports on it do.
      rail: !net.named && pins.length < 2 ? null : railOf(made && !ports.get(id)?.size ? "" : net.name, kinds.get(id) ?? new Set(), ports.get(id) ?? new Set()),
      pins,
      ...portOf(imported.get(id)),
    })
  }
  return { pinNet, nets, conn }
}

/** The imported power symbol a net's ports are drawn as: the one most of them are, the first by part id on a tie. */
function portOf(found: Map<string, { count: number; first: ComponentInstance }> | undefined): Pick<TidyNet, "port" | "portProblem"> {
  if (!found) return {}
  const [partId, { first }] = [...found].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]
  const problem = portProblem(partId)
  // The places are kept in the symbol's frame: a port Tidy draws is turned its own way, and its fields turn with it.
  return { port: { partId, ...(first.fields ? { fields: fieldsInFrame(first.fields, first.sch) } : {}) }, ...(problem ? { portProblem: problem } : {}) }
}

/** Physical components: what Tidy arranges. Ports are drawn anew at the pins they serve. */
export const isArranged = (partId: string) => {
  const part = findPart(partId)
  return !part?.powerNet
}

export const isPort = (partId: string) => !!findPart(partId)?.powerNet

/** True for a component a netlist counts: a physical part. */
export const countsInNetlist = (partId: string) => isSchematicPart(findPart(partId))

/** A port's net name. */
export { powerNetName }

/**
 * A name for an unnamed net that needs a label: its most telling pin, as the tscircuit importer
 * names them: a pin with a name on the part with the most pins, as `REF_PIN`.
 */
export function nameForNet(project: Project, net: TidyNet, taken: Set<string>): string {
  const base = baseName(new Map(project.components.map((c) => [c.id, c])), net.pins)
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  taken.add(name)
  return name
}

/** The name `nameForNet` starts from: `REF_PIN` of the net's most telling pin. */
function baseName(byId: Map<string, ComponentInstance>, pins: string[]): string {
  const candidates = pins
    .map((key) => {
      const i = key.lastIndexOf(":")
      const c = byId.get(key.slice(0, i))
      const part = c && findPart(c.partId)
      const pin = key.slice(i + 1)
      // The function the pin is switched to, where the symbol has alternates, names its net.
      const pinName = (part && c.pinAlt?.[pin] ? schematicPins(c, part).find((p) => p.pin === pin)?.name : undefined) ?? part?.pins.find((p) => p.number === pin)?.name ?? pin
      return c && part && !part.powerNet ? { ref: c.ref, pin, pinName, count: part.pins.length } : null
    })
    .filter((x): x is { ref: string; pin: string; pinName: string; count: number } => !!x)
  const numeric = (s: string) => /^\d+$/.test(s)
  candidates.sort(
    (a, b) =>
      Number(numeric(a.pinName)) - Number(numeric(b.pinName)) ||
      b.count - a.count ||
      naturalCompare(a.ref, b.ref) ||
      naturalCompare(a.pin, b.pin),
  )
  const best = candidates[0]
  return best ? `${best.ref}_${best.pinName}`.replace(/[^A-Za-z0-9_+\-./]/g, "_") : "NET"
}
