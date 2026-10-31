import { pointOnSegment, round } from "../lib/geometry"
import { numeric } from "../lib/natural"
import { parseValue } from "../lib/values"
import { pinKey, type SchematicConnectivity } from "./connectivity"
import { findPart } from "./library"
import { AUTO_NET_NAME } from "./merges"
import { isSchematicPart, powerNetName, schematicPins, unitOwners, type WorldPin } from "./instances"
import { ROOT_SHEET, refusedSheetSymbols, sheetSymbolName, sheetUses, useAt } from "./sheets"
import { unitCount, unitLetters } from "./symbolDrawing"
import { ercCheckSeverity, fromKicad, keptPinMap } from "./checkRules"
import type { ComponentInstance, CustomPartSpec, Net, PartDef, PinType, Project, Vec2 } from "./types"

/**
 * Electrical rule checks: is the circuit right, as opposed to drawn right. Schematic only, and
 * every finding is a warning: each rule can be wrong about a real part, so none of them may
 * block fabrication, and each can be ignored for good (`Project.ignoredChecks`). On a project from
 * KiCad a finding takes the severity its project file gives KiCad's rule (`model/checkRules.ts`).
 *
 * - **lone-label**: a pin whose net is that pin and a label no other pin shares, usually a
 *   misspelt label. Connectivity counts a named net as connected, so nothing else sees it.
 * - **bare-led**: an LED with nothing in series to limit its current (ported from PR #88).
 * - **shorted**: a two-pin part with both pins on one net, so it does nothing (from PR #97).
 * - **missing-unit**: a part with several units (a dual op-amp) with some of them not placed
 *   (KiCad's "Symbol has unplaced units").
 * - **pin-conflict**: pins of an imported symbol on one net whose electrical types do not go
 *   together (two outputs), by KiCad's own table of pin pairs. Each pair KiCad calls an error or a
 *   warning is one warning here. The editor's own parts have no pin types and are never checked.
 * - **stray-no-connect**: a no-connect flag of the sheet that is not on a pin of a part (KiCad's "no
 *   connect flag not connected to a pin").
 * - **sheet-pin-no-label**, **label-no-sheet-pin**, **sheet-pin-unconnected** (S1): a pin of a sheet symbol whose
 *   sheet has no hierarchical label of its name, a hierarchical label with no pin of its name on the symbol of
 *   its sheet (or on a sheet with no symbol above it), and a sheet pin nothing is wired to. **sheet-loop**: a
 *   sheet symbol whose sheet holds itself, which the tree leaves out.
 * - **bus-entry-no-bus**, **net-not-bus-member** (S3): a bus entry with neither end on a bus, and a wire a bus entry joins to a bus whose
 *   label names no member of it (KiCad's "bus entry needed" and "net is graphically connected to a bus but not a bus member").
 * - **net-names**: one net with several names (labels or power ports of two names wired together, or a label `connect` named
 *   `NET3` left on a net that has a name now; KiCad's "both A and B are attached to the same items"). It points at the labels
 *   and ports of the names the net is not known by, and is keyed by the names, so it stays ignored while those same names meet.
 *
 * Measured on the five examples, the three v1 fixtures and the eight blog boards brought in
 * from tscircuit: every hit was a real mistake and none was a false alarm.
 */

export type ErcKind = "lone-label" | "bare-led" | "shorted" | "missing-unit" | "pin-conflict" | "stray-no-connect" | "sheet-pin-no-label" | "label-no-sheet-pin" | "sheet-pin-unconnected" | "sheet-loop" | "bus-entry-no-bus" | "net-not-bus-member" | "net-names"

export interface ErcFinding {
  kind: ErcKind
  /**
   * What ignoring it stores: the check, the component's id and, where a part can have more than
   * one, the pin, e.g. `bare-led:c_4`. Ids, not refs, so renaming D1 keeps it ignored and a new
   * part that takes the name D1 is checked afresh.
   */
  key: string
  message: string
  /** The part a list of ignored checks names it by, e.g. "D1" or "U3 pin 5". */
  subject: string
  /** Components it is about, the offending one first. */
  componentIds: string[]
  /** Labels it is about (lone-label, net-names). */
  labelIds: string[]
  /** Where on the schematic to look. */
  at: Vec2
  /** S1: the use of a sheet it is on (`ComponentInstance.inst`), when it is not the root: the editor opens that sheet to show it. */
  sheet?: string
  /**
   * How severe it is on a project from KiCad: the project's severity for KiCad's rule (`model/checkRules.ts`), and a pin pair's own level by the pin
   * table for a pin conflict. Absent on a project drawn here, where every finding is a warning.
   */
  severity?: "error" | "warning"
}

/** Ground and its usual spellings. Ground is shared by construction, so it never counts as a series link. */
const GROUND_NAME = /^(?:[ADPSC]?GND|GND[\w-]*|[\w-]*_GND|VSS\w*|0V|GROUND|EARTH)$/i

/**
 * A part that limits an LED's current by itself: a constant-current driver, an LED sold with its
 * resistor inside. Driver families are named narrowly, because a name match may only ever
 * silence a finding. Matches are by part number with whatever comes before or after it (case, suffixes,
 * a module's prefix). "LED driver" is not on the list: the 74HC595 is sold as one, and an LED
 * straight on its output still needs a resistor.
 */
const CURRENT_LIMITER =
  /constant.?current|current.?(?:sink|source|regulat|limit)|built.?in resistor|integrated resistor|internal resistor|with (?:a )?(?:series )?resistor|\bws28\d\d|\bsk68\d\d|\bsk98\d\d|\bapa10\d|\btlc59\d\d|\bmax72(?:19|21)|\bis31fl|\bmbi5\d{3}|\bstp16|(?<![a-z])(?:lm391[4-6]|lm3909|tm16\d\d|ht16k\d+|as1115|lp50\d\d|max695\d)/i

/** LEDs that look after their own current: addressable ones, and ones with the resistor inside. */
const SELF_LIMITED_LED = new RegExp(`addressable|neopixel|smart.?led|${CURRENT_LIMITER.source}`, "i")

/** Pins that say a driver is inside the package: a supply or a data line. */
const DRIVER_PIN = /^(?:VDD|VCC|VSS|GND|V\+|VIN|DIN|DI|DOUT|DO|SDI|SDO|CI|CO|CKI|CKO|DATA|CLK)$/

const OPTOCOUPLER = /opto.?coupler|opto.?isolator|photo.?coupler/i

/** Parts current flows straight through: diodes, fuses, ferrites, inductors, switches. */
const THROUGH_SYMBOLS = new Set(["diode", "schottky", "zener", "tvs", "fuse", "ferrite_bead", "inductor", "switch"])
const THROUGH_PARTS = new Set(["diode", "schottky", "zener", "inductor", "pushbutton", "pushbutton_smd", "slide_switch"])
const CAPACITOR_SYMBOLS = new Set(["capacitor", "capacitor_polarized"])
const CAPACITOR_PARTS = new Set(["capacitor", "capacitor_polarized", "capacitor_tantalum"])

const norm = (name: string) => name.toUpperCase().replace(/[\s_]/g, "")
const partText = (part: PartDef, c: ComponentInstance) =>
  [part.name, part.description, part.mpn, c.props.mpn, ...(part.keywords ?? [])].filter(Boolean).join(" ")

/** One LED inside a part: the two pins its current goes in and out by. */
interface LedElement {
  componentId: string
  legs: [string, string]
  /** Further pins of the same electrode, such as the second COM of a 7-segment digit. */
  also: string[]
  /** How a message names it: the ref, or "U4's LED A/K" inside a bigger part. */
  label: string
  /** Pin that tells it apart from the part's other LEDs in its key; null for a part with one. */
  keyPin: string | null
}

/**
 * The LEDs in a part, decided by its category and pins:
 *
 * - The library LED and any part drawn with the LED symbol: one LED, its two pins.
 * - A project part in Diodes that says it is LEDs (an LED bar, an RGB LED, a 7-segment digit):
 *   pins paired by name, A1 with K1 and so on, or every pin with one common pin (COM, CA, CC,
 *   or a lone A or K). A part that pairs no other way is left alone.
 * - An optocoupler's input, its A and K pins.
 *
 * Never an LED: modules and connectors (their LEDs come with their resistors on the module), and
 * a part with a supply or data pin or whose description says addressable or built-in resistor,
 * like the WS2812B: those drive their own current.
 */
function ledElements(c: ComponentInstance, part: PartDef, spec: CustomPartSpec | undefined): LedElement[] {
  if (part.category === "Modules" || part.category === "Connectors" || part.category === "Symbols") return []
  const text = partText(part, c)
  const pins = part.pins.filter((p) => !(c.nc ?? []).includes(p.number))
  const one = (a: string, b: string, label = c.ref): LedElement[] => [{ componentId: c.id, legs: [a, b], also: [], label, keyPin: null }]

  if (OPTOCOUPLER.test(text)) {
    // The input LED's A and K; C and E are the output transistor.
    const a = pins.find((p) => ["A", "ANODE"].includes(norm(p.name)))
    const k = pins.find((p) => ["K", "CATHODE"].includes(norm(p.name)))
    return a && k ? one(a.number, k.number, `${c.ref}'s LED ${a.name}/${k.name}`) : []
  }

  const isLed = part.id === "led" || spec?.symbol === "led" || (part.category === "Diodes" && /\bLEDs?\b|light.?emitting|bar.?graph|7.?seg|seven.?seg|segment display/i.test(text))
  if (!isLed) return []
  if (SELF_LIMITED_LED.test(text) || pins.some((p) => DRIVER_PIN.test(norm(p.name)))) return []
  if (pins.length < 2) return []
  if (pins.length === 2) return one(pins[0].number, pins[1].number)

  const inside = (a: { name: string }, b: { name: string }) => `${c.ref}'s LED ${a.name}/${b.name}`
  // An LED bar or dual LED: A1/K1, A2/K2...
  const numbered = (re: RegExp) => new Map(pins.flatMap((p) => (re.test(norm(p.name)) ? [[norm(p.name).replace(re, "$2"), p] as const] : [])))
  const anodes = numbered(/^(A|AN|ANODE|\+)(\d+)$/)
  const cathodes = numbered(/^(K|C|CATH|CATHODE|-)(\d+)$/)
  if (anodes.size && anodes.size === cathodes.size && anodes.size * 2 === pins.length && [...anodes.keys()].every((n) => cathodes.has(n))) {
    return [...anodes].map(([n, a]) => ({ componentId: c.id, legs: [a.number, cathodes.get(n)!.number], also: [], label: inside(a, cathodes.get(n)!), keyPin: a.number }))
  }
  // An RGB LED or a 7-segment digit: every other pin against one common pin.
  let commons = pins.filter((p) => /^(COM|COMMON|CA|CC)\d*$/.test(norm(p.name)))
  // A lone A or K is the common only on an RGB or bicolour LED: on a 7-segment digit, A is a segment.
  if (!commons.length && pins.length <= 4) commons = pins.filter((p) => /^(A|K|ANODE|CATHODE|\+|-)$/.test(norm(p.name)))
  // Several commons are fine when they share a name (a digit's COM on two pins); different
  // names (COM1, COM2) are several digits, which this doesn't pair up.
  if (!commons.length || new Set(commons.map((p) => norm(p.name))).size !== 1) return []
  const common = commons[0]
  const also = commons.slice(1).map((p) => p.number)
  return pins
    .filter((p) => !commons.includes(p))
    .map((p) => ({ componentId: c.id, legs: [p.number, common.number], also, label: inside(p, common), keyPin: p.number }))
}

/**
 * What a part does to an LED's current, for following it:
 *
 * - resistor: limits it, so a series link to one is what the LED needs.
 * - capacitor: passes no DC, so it changes nothing on the node.
 * - through: passes it on unlimited: diodes, fuses, ferrites, inductors, switches and buzzers, a
 *   0 ohm link. The search carries on out of its other pins.
 * - transistor: current goes collector to emitter (drain to source) and never through the base
 *   or gate, so an LED on a sink with an emitter resistor is followed to that resistor. A bare
 *   emitter on ground still ends at ground, and the base or gate is a plain signal pin.
 * - nothing: a test point. It exposes a node and changes no current.
 * - public: anything else, an IC, a connector or a relay. A node with one on it is not a series
 *   link, and the search stops there.
 *
 * Through parts that are 2-pin jumpers (a 1x2 header, a solder jumper) pass current like a link.
 * A three-pin switch joins its common to each throw, never one throw to the other.
 */
type Role = "resistor" | "capacitor" | "through" | "transistor" | "nothing" | "public"

const TEST_POINT = /test.?point/i
const JUMPER = /jumper|solder.?bridge|solder.?jumper/i
const COMMON_PIN = /^(C|COM|COMMON)$/

/** The pins current leaves by when it comes in at `pin`, for a through or transistor part; null when it can't tell. */
function farPins(part: PartDef, pin: string, role: Role): PartDef["pins"] | null {
  const here = part.pins.find((p) => p.number === pin)
  const others = part.pins.filter((p) => p.number !== pin)
  if (role === "transistor") {
    const pair: Record<string, string> = { C: "E", E: "C", D: "S", S: "D" }
    const want = pair[norm(here?.name ?? "")]
    return want ? others.filter((p) => norm(p.name) === want) : null
  }
  if (role === "through" && part.pins.length === 3 && part.category === "Electromechanical") {
    // SPDT: the common (named C or COM, else the middle pin) joins each throw; the throws don't join.
    const common = part.pins.find((p) => COMMON_PIN.test(norm(p.name))) ?? part.pins[1]
    return pin === common.number ? others : [common]
  }
  return others
}

function roleOf(c: ComponentInstance, part: PartDef, spec: CustomPartSpec | undefined): Role {
  const symbol = spec?.symbol
  if (part.refPrefix === "TP" || TEST_POINT.test(part.name)) return "nothing"
  if (
    part.pins.length === 2 &&
    (part.category === "Connectors" || part.category === "Passives") &&
    (/^header_1x2/.test(part.id) || ["JP", "SJ", "JMP"].includes(part.refPrefix) || JUMPER.test(partText(part, c)))
  ) {
    return "through"
  }
  // A project part in Passives drawn as a box, such as a resistor array or a part brought in
  // from tscircuit with odd pins, is known by its designator.
  const boxPassive = part.custom && part.category === "Passives" && !symbol ? part.refPrefix : ""
  const isResistor =
    part.id === "resistor" ||
    part.id === "potentiometer" ||
    symbol === "resistor" ||
    /^R[NA]?$/.test(boxPassive) ||
    (!!boxPassive && /resistor/i.test(partText(part, c)))
  if (isResistor) {
    // A 0 ohm link joins its two nets; it limits nothing.
    return parseValue(c.props.resistance ?? c.props.value) === 0 ? "through" : "resistor"
  }
  if (CURRENT_LIMITER.test(partText(part, c))) return "resistor"
  if (CAPACITOR_PARTS.has(part.id) || (symbol && CAPACITOR_SYMBOLS.has(symbol)) || boxPassive === "C") return "capacitor"
  if (THROUGH_PARTS.has(part.id) || (symbol && THROUGH_SYMBOLS.has(symbol)) || /^(L|FB|F)$/.test(boxPassive)) return "through"
  // Switches and buzzers; a relay's coil and contacts are not one path.
  if (part.category === "Electromechanical" && part.pins.length <= 3) return "through"
  if (part.category === "Transistors") return "transistor"
  if (part.category === "Diodes" && part.pins.length === 2) return "through"
  return "public"
}

/** How a pin reads in a message: "U1 pin 5 (PB5)", or "R1 pin 2" when its name is its number. */
function pinText(ref: string, part: PartDef | undefined, pin: string) {
  const name = part?.pins.find((p) => p.number === pin)?.name
  return name && name !== pin ? `${ref} pin ${pin} (${name})` : `${ref} pin ${pin}`
}

// ---------- Pin types that meet on one net ----------

/** KiCad's order of electrical pin types, the order of its table of pin pairs. */
const PIN_ORDER: PinType[] = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"]

/**
 * KiCad's default table of what two pin types on one net make (`ERC_SETTINGS::m_defaultPinMap`):
 * O fine, W a warning, E an error. Rows and columns follow `PIN_ORDER`.
 */
const PIN_PAIRS = [
  /* input          */ "OOOOOOWOOOOE",
  /* output         */ "OEOWOOWOEEEE",
  /* bidirectional  */ "OOOOOOWOWOWE",
  /* tri-state      */ "OWOOOOWWEWWE",
  /* passive        */ "OOOOOOWOOOOE",
  /* free           */ "OOOOOOOOOOOE",
  /* unspecified    */ "WWWWWOWWWWWE",
  /* power input    */ "OOOWOOWOOOOE",
  /* power output   */ "OEWEOOWOEEEE",
  /* open collector */ "OEOWOOWOEOOE",
  /* open emitter   */ "OEWWOOWOEOOE",
  /* no connect     */ "EEEEEEEEEEEE",
]

/**
 * What two pin types on one net make: "ok", a "warning" or an "error" by KiCad's table, or by a project's own (`erc.pin_map`, rows of digits: 0 fine,
 * 1 a warning, 2 an error), which a project from KiCad keeps when it changed KiCad's.
 */
export function pinPairLevel(a: PinType, b: PinType, table?: readonly string[]): "ok" | "warning" | "error" {
  const c = (table ?? PIN_PAIRS)[PIN_ORDER.indexOf(a)][PIN_ORDER.indexOf(b)]
  return c === "E" || c === "2" ? "error" : c === "W" || c === "1" ? "warning" : "ok"
}

/**
 * KiCad's weights of the pin types (`m_PinTypeWeights`): of the pins in a conflict it reports the
 * heaviest first, which clears the conflicts of that pin so that one bad pin is one finding.
 */
const PIN_WEIGHT: Record<PinType, number> = {
  free: 11,
  unspecified: 10,
  passive: 9,
  open_collector: 8,
  open_emitter: 7,
  input: 6,
  tri_state: 5,
  bidirectional: 4,
  output: 3,
  power_in: 2,
  power_out: 1,
  no_connect: 0,
}

/** A pin type as a sentence names it. */
const PIN_TYPE_TEXT: Record<PinType, string> = {
  input: "an input",
  output: "an output",
  bidirectional: "a bidirectional pin",
  tri_state: "a tri-state pin",
  passive: "a passive pin",
  free: "a free pin",
  unspecified: "an unspecified pin",
  power_in: "a power input",
  power_out: "a power output",
  open_collector: "an open collector",
  open_emitter: "an open emitter",
  no_connect: "a no-connect pin",
}

/** One pin of an imported symbol that sits on a net, with the component that draws it. */
interface TypedPin {
  c: ComponentInstance
  part: PartDef
  pin: WorldPin
  type: PinType
}

/** Find electrical mistakes in the schematic. Pure; `store/analysis.ts` caches it beside connectivity. */
export function runErc(project: Project, conn: SchematicConnectivity): ErcFinding[] {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const specs = new Map((project.parts ?? []).map((s) => [s.id, s]))
  const nets = new Map(conn.nets.map((n) => [n.id, n]))
  const netOf = (componentId: string, pin: string) => conn.pinNet.get(pinKey(componentId, pin))
  // A unit of a part with several is a symbol of its own whose pins are the part's: its owner is the component on the board.
  const owners = unitOwners(project.components)
  const twinsOf = new Map<string, ComponentInstance[]>()
  for (const c of project.components) {
    const owner = owners.get(c.id)
    if (owner) twinsOf.set(owner, [...(twinsOf.get(owner) ?? []), c])
  }
  /** Pins marked no-connect, across every unit of the part (a pin number is the part's, not one unit's). */
  const ncOf = (c: ComponentInstance) => {
    const twins = twinsOf.get(owners.get(c.id) ?? c.id)
    return new Set([...(c.nc ?? []), ...(twins ?? []).flatMap((t) => t.nc ?? [])])
  }
  /** The part a component's pins are checked as: its own when it is on the board, its owner's when it is another unit. */
  const physicalPartOf = (c: ComponentInstance) => {
    const part = findPart(c.partId)
    if (isSchematicPart(part)) return part
    const owner = owners.get(c.id)
    const ownerPart = owner ? findPart(byId.get(owner)?.partId ?? "") : undefined
    return part?.unitOf && isSchematicPart(ownerPart) ? part : undefined
  }

  // Nets with a power or ground port are supply rails; ground also by its name.
  const rails = new Set<string>()
  const grounds = new Set<string>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part?.powerNet) continue
    for (const p of part.pins) {
      const id = netOf(c.id, p.number)
      if (!id) continue
      rails.add(id)
      if (p.kind === "ground") grounds.add(id)
    }
  }
  // A hidden power-input pin of an ordinary part is on the global net of its name: a supply rail, ground by its name.
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part || part.powerNet) continue
    for (const pin of schematicPins(c, part)) {
      if (!pin.hidden || pin.type !== "power_in") continue
      const id = netOf(c.id, pin.pin)
      if (!id) continue
      rails.add(id)
      if (GROUND_NAME.test(pin.name.trim())) grounds.add(id)
    }
  }
  for (const n of conn.nets) if (GROUND_NAME.test(n.name)) grounds.add(n.id)

  const refOf = (id: string) => byId.get(id)?.ref ?? "?"
  const partOf = (id: string) => {
    const c = byId.get(id)
    return c ? findPart(c.partId) : undefined
  }
  /** A net as a message names it: its name, or the first pin on it that isn't one of `except`'s. */
  const netText = (net: Net, except: Set<string>) => {
    if (net.named) return net.name
    const pin = net.pins.find((p) => !except.has(p.componentId)) ?? net.pins[0]
    return pin ? pinText(refOf(pin.componentId), partOf(pin.componentId), pin.pin) : net.name
  }

  const findings: ErcFinding[] = []
  // A project from KiCad: its findings take the project's severities, and its pin conflicts its own pin table (`model/checkRules.ts`).
  const kicad = fromKicad(project)
  const pinTable = kicad ? keptPinMap(project) : undefined
  /** A pin conflict's own level by the pin table, which its rule's severity only turns on or off. */
  const levelOf = new Map<ErcFinding, "error" | "warning">()

  // ---------- A pin only on a label nothing else shares ----------
  const labelsOf = new Map<string, string[]>()
  // A label of a sheet used twice is on a net in each use (`byUse`).
  const labelNets: [string, string][] = conn.byUse ? [...conn.byUse.labelNet.values()].flatMap((m) => [...m]) : project.labels.flatMap((l) => (conn.labelNet.get(l.id) ? [[l.id, conn.labelNet.get(l.id)!] as [string, string]] : []))
  for (const [lid, id] of labelNets) labelsOf.set(id, [...(labelsOf.get(id) ?? []), lid])
  const labelName = new Map(project.labels.map((l) => [l.id, l.name.trim()]))
  for (const c of project.components) {
    const part = physicalPartOf(c)
    if (!part) continue
    const nc = ncOf(c)
    for (const pin of schematicPins(c, part)) {
      if (nc.has(pin.pin)) continue
      const id = netOf(c.id, pin.pin)
      const net = id ? nets.get(id) : undefined
      if (!net || !net.named || net.pins.length !== 1 || rails.has(net.id)) continue
      const labelIds = labelsOf.get(net.id) ?? []
      const names = [...new Set(labelIds.map((l) => labelName.get(l) ?? ""))].filter(Boolean)
      findings.push({
        kind: "lone-label",
        key: `lone-label:${c.id}:${pin.pin}`,
        message: `${pinText(c.ref, part, pin.pin)} goes only to the label ${names.join(", ") || net.name}, which no other pin has`,
        subject: pinText(c.ref, part, pin.pin),
        componentIds: [c.id],
        labelIds,
        at: pin.pos,
      })
    }
  }

  // ---------- Two-pin parts with both pins on one net ----------
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part || !isSchematicPart(part) || part.pins.length !== 2) continue
    // A connector or test point exposes nets, so two of its contacts on one net is ordinary;
    // so is a part whose two pins are both declared supply or ground pads (a shield, say), and
    // one with a pin declared unused, which is a one-pin part.
    if (part.category === "Connectors" || part.refPrefix === "TP" || /test.?point/i.test(part.name)) continue
    const [a, b] = part.pins
    if (a.kind === b.kind && (a.kind === "power" || a.kind === "ground")) continue
    if (a.kind === "nc" || b.kind === "nc") continue
    if (ncOf(c).has(a.number) || ncOf(c).has(b.number)) continue
    // Two pins the symbol joins inside itself are on one net by design.
    if (part.jumpers?.groups?.some((g) => g.includes(a.number) && g.includes(b.number))) continue
    const id = netOf(c.id, a.number)
    if (!id || id !== netOf(c.id, b.number)) continue
    const net = nets.get(id)
    if (!net) continue
    const alone = net.pins.every((p) => p.componentId === c.id) && !net.named
    findings.push({
      kind: "shorted",
      key: `shorted:${c.id}`,
      message: alone
        ? `${c.ref} has its two pins wired to each other, so it does nothing`
        : `${c.ref} has both pins on ${net.named ? "" : "the same net as "}${netText(net, new Set([c.id]))}, so it does nothing`,
      subject: c.ref,
      componentIds: [c.id],
      labelIds: [],
      at: { x: c.sch.x, y: c.sch.y },
    })
  }

  // ---------- LEDs with nothing in series to limit their current ----------
  const elements: LedElement[] = []
  const elementsOfPin = new Map<string, LedElement[]>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part || !isSchematicPart(part)) continue
    for (const e of ledElements(c, part, specs.get(part.id))) {
      elements.push(e)
      for (const leg of e.legs) {
        const k = pinKey(c.id, leg)
        elementsOfPin.set(k, [...(elementsOfPin.get(k) ?? []), e])
      }
    }
  }
  const roles = new Map<string, Role>()
  const role = (componentId: string): Role => {
    let r = roles.get(componentId)
    if (!r) {
      const c = byId.get(componentId)!
      const part = findPart(c.partId)!
      r = roleOf(c, part, specs.get(part.id))
      roles.set(componentId, r)
    }
    return r
  }
  const unit = (x: LedElement) => `led:${x.componentId}:${x.legs.join(":")}`

  /**
   * Follow an LED's current out of one leg, through other LEDs and the parts it passes straight
   * through, until it meets a resistor. A node only counts as a series link when nothing but
   * those is on it (PR #88's private node): an LED on a node with an IC pin is driven by that pin
   * directly, whatever else shares the node. Supply rails and ground end the search, since they
   * are shared by construction, and so does the LED's other side: a resistor whose far end is
   * back there is across the LED, not in series with it.
   */
  const search = (e: LedElement, start: string | undefined, opposite: string | undefined) => {
    const found = { limited: false, dangling: false, ends: [] as Net[] }
    const seenNets = new Set<string>(opposite ? [opposite] : [])
    const seenUnits = new Set<string>([unit(e)])
    const queue: string[] = []
    const visit = (id: string | undefined) => {
      if (!id) found.dangling = true
      else if (!seenNets.has(id)) {
        seenNets.add(id)
        queue.push(id)
      }
    }
    const acrossLed = (id: string | undefined) => !id || id === opposite || (grounds.has(id) && !!opposite && grounds.has(opposite))
    visit(start)
    while (queue.length) {
      const net = nets.get(queue.shift()!)
      if (!net) {
        found.dangling = true
        continue
      }
      if (grounds.has(net.id)) continue
      if (rails.has(net.id)) {
        found.ends.push(net)
        continue
      }
      let isPublic = false
      let resistor = false
      let others = 0
      const next: (string | undefined)[] = []
      for (const p of net.pins) {
        if (p.componentId === e.componentId && (e.legs.includes(p.pin) || e.also.includes(p.pin))) continue
        others++
        const leds = elementsOfPin.get(pinKey(p.componentId, p.pin))
        if (leds) {
          // Another LED in the string: carry on out of its other leg.
          for (const x of leds) {
            if (seenUnits.has(unit(x))) continue
            seenUnits.add(unit(x))
            next.push(netOf(x.componentId, x.legs[0] === p.pin ? x.legs[1] : x.legs[0]))
          }
          continue
        }
        const r = role(p.componentId)
        if (r === "nothing") {
          others--
          continue
        }
        const other = byId.get(p.componentId)!
        const nc = ncOf(other)
        const part = partOf(p.componentId)!
        const far = farPins(part, p.pin, r) ?? []
        if (r === "resistor") {
          resistor ||= far.some((q) => !acrossLed(netOf(p.componentId, q.number)))
          // A resistor with a far end not wired yet is still being drawn: the unconnected pin check's.
          if (far.some((q) => !nc.has(q.number) && !netOf(p.componentId, q.number))) found.dangling = true
        } else if (r === "public" || (r === "transistor" && !farPins(part, p.pin, r))) isPublic = true
        else if ((r === "through" || r === "transistor") && !seenUnits.has(p.componentId + ":" + p.pin)) {
          seenUnits.add(p.componentId + ":" + p.pin)
          // A pin of the part left unwired or no-connect is nothing to wait for: only the LED's own legs are.
          for (const q of far) {
            const id = nc.has(q.number) ? undefined : netOf(p.componentId, q.number)
            if (id) next.push(id)
          }
        }
      }
      if (!others) {
        // Nothing else on the node: wiring still to do, which the unconnected pin check reports.
        found.dangling = true
        continue
      }
      if (isPublic) {
        found.ends.push(net)
        continue
      }
      if (resistor) {
        found.limited = true
        return found
      }
      next.forEach(visit)
    }
    return found
  }

  for (const e of elements) {
    const [a, b] = e.legs
    const netA = netOf(e.componentId, a)
    const netB = netOf(e.componentId, b)
    // Both legs on one net is the shorted-part finding, or a broken multi-LED part; not this one.
    if (netA && netA === netB) continue
    const sides = [search(e, netA, netB), search(e, netB, netA)]
    if (sides.some((s) => s.limited || s.dangling)) continue
    const ends = sides.flatMap((s) => s.ends)

    const self = new Set([e.componentId])
    const terms = [...new Set(ends.map((n) => netText(n, self)))]
    const c = byId.get(e.componentId)!
    findings.push({
      kind: "bare-led",
      key: e.keyPin ? `bare-led:${e.componentId}:${e.keyPin}` : `bare-led:${e.componentId}`,
      message:
        terms.length === 0
          ? `${e.label} has no resistor in series to limit its current`
          : terms.length === 1
            ? `${e.label} has no resistor between it and ${terms[0]}`
            : `${e.label} has no resistor between ${terms[0]} and ${terms[1]}`,
      subject: e.label,
      componentIds: [e.componentId],
      labelIds: [],
      at: { x: c.sch.x, y: c.sch.y },
    })
  }

  // ---------- A part with units not all placed ----------
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part || part.unitOf || part.powerNet || unitCount(part) < 2) continue
    // The units of this part on the sheet: this component and the twins that name it as their owner.
    const placed = [c, ...(twinsOf.get(c.id) ?? [])]
    const have = new Set(placed.map((x) => x.unit ?? 1))
    const missing: number[] = []
    for (let u = 1; u <= unitCount(part); u++) if (!have.has(u)) missing.push(u)
    if (!missing.length) continue
    const letters = missing.map(unitLetters)
    findings.push({
      kind: "missing-unit",
      key: `missing-unit:${c.id}`,
      message: `${c.ref} has ${letters.length === 1 ? "an unplaced unit" : "unplaced units"}: ${letters.length === 1 ? letters[0] : `${letters.slice(0, -1).join(", ")} and ${letters[letters.length - 1]}`}`,
      subject: c.ref,
      componentIds: placed.map((x) => x.id),
      labelIds: [],
      at: { x: c.sch.x, y: c.sch.y },
    })
  }

  // ---------- Pin types that do not go together on one net ----------
  // KiCad's `ERC_TESTER::TestPinToPin`: the pins of a net are taken in order of reference and pin
  // number and each pair is looked up in the table. Pins of one symbol that stand at one place with
  // one name are stacked and never conflict. KiCad then reports the heaviest pin of the conflicts
  // first, paired with the nearest pin it conflicts with, and that clears every conflict of that
  // pin, so a pin is named once. A pin with no type (the editor's own parts) is not checked.
  const typed = new Map<string, TypedPin[]>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part) continue
    // A symbol that keeps pins of one number apart has no net for the second of them in the connectivity.
    const apart = !!part.jumpers && !part.jumpers.duplicates
    for (const pin of schematicPins(c, part)) {
      if (!pin.type || (pin.slot && apart)) continue
      const net = netOf(c.id, pin.pin)
      if (!net) continue
      const list = typed.get(net)
      const entry = { c, part, pin, type: pin.type }
      if (list) list.push(entry)
      else typed.set(net, [entry])
    }
  }
  const pinSubject = (t: TypedPin) => {
    if (t.part.powerNet) return `the ${powerNetName(t.c, t.part)} power symbol`
    const name = t.pin.name.trim()
    return name && name !== t.pin.pin ? `${t.c.ref} pin ${t.pin.pin} (${name})` : `${t.c.ref} pin ${t.pin.pin}`
  }
  for (const list of typed.values()) {
    if (list.length < 2) continue
    const pins = list
      .map((t, at) => ({ t, at }))
      .sort((a, b) => numeric.compare(a.t.c.ref, b.t.c.ref) || numeric.compare(a.t.pin.pin, b.t.pin.pin) || a.at - b.at)
      .map((x) => x.t)
    const clashes: { a: number; b: number; level: "warning" | "error" }[] = []
    const weight = new Map<number, number>()
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        const a = pins[i]
        const b = pins[j]
        const stacked =
          a.c.id === b.c.id &&
          a.pin.pos.x === b.pin.pos.x &&
          a.pin.pos.y === b.pin.pos.y &&
          a.pin.name === b.pin.name &&
          (a.type === b.type || a.type === "passive" || a.type === "free" || b.type === "passive" || b.type === "free")
        if (stacked) continue
        const level = pinPairLevel(a.type, b.type, pinTable)
        if (level === "ok") continue
        clashes.push({ a: i, b: j, level })
        weight.set(i, PIN_WEIGHT[a.type])
        weight.set(j, PIN_WEIGHT[b.type])
      }
    }
    const byWeight = [...weight].sort((x, y) => y[1] - x[1] || x[0] - y[0])
    for (const [i] of byWeight) {
      if (!clashes.length) break
      let nearest = -1
      let level: "warning" | "error" = "warning"
      let best = Infinity
      for (let k = clashes.length - 1; k >= 0; k--) {
        const m = clashes[k]
        if (m.a !== i && m.b !== i) continue
        clashes.splice(k, 1)
        const other = m.a === i ? m.b : m.a
        const d = Math.hypot(pins[i].pin.pos.x - pins[other].pin.pos.x, pins[i].pin.pos.y - pins[other].pin.pos.y)
        // KiCad walks its list from the front: the first conflict is the start, a nearer one replaces it.
        if (best === Infinity || d < best) {
          best = d
          nearest = other
          level = m.level
        }
      }
      if (nearest < 0) continue
      const a = pins[i]
      const b = pins[nearest]
      const slot = (t: TypedPin) => `${t.c.id}:${t.pin.pin}${t.pin.slot ? `#${t.pin.slot}` : ""}`
      const finding: ErcFinding = {
        kind: "pin-conflict",
        key: `pin-conflict:${slot(a)}:${slot(b)}`,
        message: `${pinSubject(a)} is ${PIN_TYPE_TEXT[a.type]} and ${pinSubject(b)} is ${PIN_TYPE_TEXT[b.type]}, ${level === "error" ? "which cannot share a net" : "which may not work on one net"}`,
        subject: `${pinSubject(a)} and ${pinSubject(b)}`,
        componentIds: a.c.id === b.c.id ? [a.c.id] : [a.c.id, b.c.id],
        labelIds: [],
        at: a.pin.pos,
      }
      findings.push(finding)
      levelOf.set(finding, level)
    }
  }

  // A no-connect flag drawn where no pin is: it means nothing, and KiCad says so. One on a wire that reaches a pin is not: it leaves that net open (`computeConnectivity`).
  for (const it of project.drawings ?? []) {
    if (it.type !== "noconnect") continue
    // A pin counts on the sheet the flag is drawn on, not on another sheet at the same place.
    const pinHere = project.components.some((c) => (project.sheetSymbols?.length ? useAt(project, c.inst ?? "").sheet === (it.sheet ?? ROOT_SHEET) : true) && schematicPins(c).some((p) => Math.hypot(p.pos.x - it.x, p.pos.y - it.y) < 1e-3))
    if (pinHere) continue
    const at = { x: it.x, y: it.y }
    const onWire = (w: (typeof project.wires)[number]) => (w.sheet ?? ROOT_SHEET) === (it.sheet ?? ROOT_SHEET) && w.points.some((q, i) => Math.hypot(q.x - at.x, q.y - at.y) < 1e-3 || (i > 0 && pointOnSegment(at, w.points[i - 1], q)))
    if (project.wires.some((w) => onWire(w) && !!nets.get(conn.wireNet.get(w.id) ?? "")?.pins.length)) continue
    findings.push({ kind: "stray-no-connect", key: `stray-no-connect:${it.id}`, message: `A no-connect flag at (${round(it.x, 2)}, ${round(it.y, 2)}) is not on a pin`, subject: `no-connect flag at (${round(it.x, 2)}, ${round(it.y, 2)})`, componentIds: [], labelIds: [], at: { x: it.x, y: it.y } })
  }

  findings.push(...sheetFindings(project))
  findings.push(...busFindings(project, conn))
  findings.push(...nameFindings(project, conn))
  // A finding on a part of a sheet below the root says which use it is on, so the editor can open it.
  for (const f of findings) {
    if (f.sheet) continue
    const inst = byId.get(f.componentIds[0] ?? "")?.inst
    if (inst) f.sheet = inst
  }

  const order: Record<ErcKind, number> = { "bare-led": 0, shorted: 1, "lone-label": 2, "pin-conflict": 3, "missing-unit": 4, "stray-no-connect": 5, "sheet-pin-no-label": 6, "label-no-sheet-pin": 7, "sheet-pin-unconnected": 8, "sheet-loop": 9, "bus-entry-no-bus": 10, "net-not-bus-member": 11, "net-names": 12 }
  const sorted = findings.sort(
    (x, y) =>
      order[x.kind] - order[y.kind] ||
      x.subject.localeCompare(y.subject, undefined, { numeric: true }),
  )
  if (!kicad) return sorted
  // A project from KiCad: each finding at the project's severity, none for a rule it ignores or a check KiCad does not have. A hierarchical label on a sheet
  // no sheet symbol stands for (the root's) is one KiCad calls a pin not connected.
  const symbolSheets = new Set((project.sheetSymbols ?? []).map((x) => x.child))
  const labelSheet = new Map(project.labels.map((l) => [l.id, l.sheet ?? ROOT_SHEET]))
  return sorted.flatMap((f) => {
    const orphan = f.kind === "label-no-sheet-pin" && !symbolSheets.has(labelSheet.get(f.labelIds[0] ?? "") ?? ROOT_SHEET)
    const severity = ercCheckSeverity(project, f.kind, levelOf.get(f), orphan ? "pin_not_connected" : undefined)
    return severity ? [{ ...f, severity }] : []
  })
}

/**
 * Nets with more than one name. Most of a net's labels and ports carry the name it goes by (a name someone chose before one `connect`
 * made up); the finding points at the others, the odd ones out, and at all of them when the odd name has nothing to select (a hidden
 * power pin). A sheet used twice can have the same names meet in each use: that is one finding. As in KiCad's ERC, which looks at one
 * sheet at a time, names count as meeting only where one use of a sheet has both: a label on the wire to a sheet pin and the
 * hierarchical label of another name inside are one net by design (what `wire_sheet_pin` with `net_name` draws).
 */
function nameFindings(project: Project, conn: SchematicConnectivity): ErcFinding[] {
  if (!conn.conflicts.length) return []
  const labelById = new Map(project.labels.map((l) => [l.id, l]))
  const labelsOn = new Map<string, { id: string; use: string; name: string; at: Vec2 }[]>()
  for (const [use, nets] of conn.byUse ? [...conn.byUse.labelNet] : [["", conn.labelNet] as const]) {
    for (const [id, net] of nets) {
      const l = labelById.get(id)
      if (l) (labelsOn.get(net) ?? labelsOn.set(net, []).get(net)!).push({ id, use, name: l.name.trim(), at: { x: l.x, y: l.y } })
    }
  }
  const portsOn = new Map<string, { id: string; use: string; name: string; at: Vec2 }[]>()
  // A hidden power-input pin of an ordinary part names its net too, with nothing drawn to select (as `computeConnectivity` joins it).
  const hiddenOn = new Map<string, { use: string; name: string }[]>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    const name = powerNetName(c, part)
    const use = c.inst ?? ""
    if (!name) {
      for (const p of schematicPins(c, part)) {
        const hidden = p.hidden && p.type === "power_in" ? p.name.trim() : ""
        const net = hidden && conn.pinNet.get(pinKey(c.id, p.pin))
        if (net) (hiddenOn.get(net) ?? hiddenOn.set(net, []).get(net)!).push({ use, name: hidden })
      }
      continue
    }
    const net = part!.pins.map((p) => conn.pinNet.get(pinKey(c.id, p.number))).find(Boolean)
    if (net) (portsOn.get(net) ?? portsOn.set(net, []).get(net)!).push({ id: c.id, use, name, at: { x: c.sch.x, y: c.sch.y } })
  }
  const byKey = new Map<string, ErcFinding>()
  for (const { names: all, netId } of conn.conflicts) {
    const namesOnUse = new Map<string, Set<string>>()
    for (const x of [...(labelsOn.get(netId) ?? []), ...(portsOn.get(netId) ?? []), ...(hiddenOn.get(netId) ?? [])]) (namesOnUse.get(x.use) ?? namesOnUse.set(x.use, new Set()).get(x.use)!).add(x.name)
    const meeting = [...namesOnUse.values()].filter((n) => n.size > 1)
    if (!meeting.length) continue
    // On a schematic with sheets, the names that meet on one sheet, as KiCad's ERC names them ("Both SXX_P and SPX are attached to the same items"):
    // the label on the wire to the sheet pin outside is another sheet's name. A sheet used several times meets them once in each use, and is one finding (below).
    const names = conn.byUse ? all.filter((n) => meeting.some((m) => m.has(n))) : all
    const labels = (labelsOn.get(netId) ?? []).filter((l) => names.includes(l.name))
    const ports = (portsOn.get(netId) ?? []).filter((p) => names.includes(p.name))
    const count = (n: string) => labels.filter((l) => l.name === n).length + ports.filter((p) => p.name === n).length
    const chosen = names.filter((n) => !AUTO_NET_NAME.test(n))
    const kept = (chosen.length ? chosen : names).reduce((a, b) => (count(b) > count(a) ? b : a))
    const oddLabels = labels.filter((l) => l.name !== kept)
    const oddPorts = ports.filter((p) => p.name !== kept)
    const odd = oddLabels.length || oddPorts.length
    const shownLabels = odd ? oddLabels : labels
    const shownPorts = odd ? oddPorts : ports
    const key = `net-names:${names.join(",")}`
    const same = byKey.get(key)
    if (same) {
      same.labelIds.push(...shownLabels.map((l) => l.id).filter((id) => !same.labelIds.includes(id)))
      same.componentIds.push(...shownPorts.map((p) => p.id).filter((id) => !same.componentIds.includes(id)))
      continue
    }
    // With nothing drawn to point at, a pin of the net.
    const pin = conn.nets.find((n) => n.id === netId)?.pins[0]
    const pinAt = pin && project.components.find((c) => c.id === pin.componentId)
    const first = shownLabels[0] ?? shownPorts[0] ?? (pinAt && { at: schematicPins(pinAt).find((p) => p.pin === pin.pin)?.pos })
    byKey.set(key, {
      kind: "net-names",
      key,
      message: `Net names merged: ${names.join(", ")}`,
      subject: `the names ${names.join(", ")} on one net`,
      componentIds: shownPorts.map((p) => p.id),
      labelIds: [...new Set(shownLabels.map((l) => l.id))],
      at: first?.at ?? { x: 0, y: 0 },
      ...(shownLabels[0]?.use ? { sheet: shownLabels[0].use } : {}),
    })
  }
  return [...byKey.values()]
}

/** S1: whether something of a sheet (a wire end or side, a label, a pin of a part) is at a point. */
function touchesAt(project: Project, sheet: string, use: string[], at: Vec2, skip?: (id: string) => boolean): boolean {
  const near = (p: Vec2) => Math.hypot(p.x - at.x, p.y - at.y) < 1e-3
  for (const w of project.wires) {
    if ((w.sheet ?? ROOT_SHEET) !== sheet || (skip && skip(w.id))) continue
    for (let i = 0; i < w.points.length; i++) {
      if (near(w.points[i])) return true
      if (i > 0 && pointOnSegment(at, w.points[i - 1], w.points[i])) return true
    }
  }
  for (const l of project.labels) if ((l.sheet ?? ROOT_SHEET) === sheet && near(l)) return true
  // S3: a bus line ending or passing there is something wired to it.
  for (const d of project.drawings ?? []) {
    if (d.type !== "bus" || (d.sheet ?? ROOT_SHEET) !== sheet) continue
    for (let i = 0; i < d.points.length; i++) if (near(d.points[i]) || (i > 0 && pointOnSegment(at, d.points[i - 1], d.points[i]))) return true
  }
  for (const c of project.components) if (use.includes(c.inst ?? "") && schematicPins(c).some((p) => near(p.pos))) return true
  return false
}

/**
 * S3: the findings of the buses. A bus entry with neither end on a bus leaves nothing to join (`bus-entry-no-bus`); and a wire that leaves a
 * bus by an entry should be a member of it: its label names one of the nets the bus carries (`net-not-bus-member`), which is checked only where
 * the bus has a name to hold it against.
 */
function busFindings(project: Project, conn: SchematicConnectivity): ErcFinding[] {
  const out: ErcFinding[] = []
  if (!conn.buses) return out
  const uses = sheetUses(project)
  const at2 = (p: Vec2) => `(${round(p.x, 2)}, ${round(p.y, 2)})`
  for (const [sheet, sb] of conn.buses) {
    const own = uses.find((u) => u.sheet === sheet)?.path ?? ""
    for (const e of sb.entries) {
      const start = e.ends[0]
      if (!e.onBus[0] && !e.onBus[1]) {
        out.push({ kind: "bus-entry-no-bus", key: `bus-entry-no-bus:${e.id}`, message: `The bus entry at ${at2(start)} is not on a bus`, subject: `bus entry at ${at2(start)}`, componentIds: [], labelIds: [], at: start, ...(own ? { sheet: own } : {}) })
        continue
      }
      const group = sb.groups[e.group]
      const names = group?.driver ? new Set(group.items.flatMap((i) => i.name.names)) : null
      if (!names) continue
      // The wire at the end that is not on the bus, and the label it carries.
      const k = e.onBus[0] ? 1 : 0
      if (e.onBus[k]) continue
      const end = e.ends[k]
      const wire = project.wires.find((w) => (w.sheet ?? ROOT_SHEET) === sheet && w.points.some((p) => Math.hypot(p.x - end.x, p.y - end.y) < 1e-3))
      const netId = wire ? conn.wireNet.get(wire.id) : undefined
      const net = netId ? conn.nets.find((n) => n.id === netId) : undefined
      const text = net?.label?.text ?? (net?.named && !net.power ? net.name : undefined)
      if (text && !names.has(text)) {
        out.push({ kind: "net-not-bus-member", key: `net-not-bus-member:${e.id}`, message: `The net ${text} leaves the bus ${group.driver!.text} by a bus entry, but ${text} is not one of its members`, subject: `net ${text} on a bus entry`, componentIds: [], labelIds: [], at: end, ...(own ? { sheet: own } : {}) })
      }
    }
  }
  return out
}

/** S1: the findings of the sheet tree: sheet pins and hierarchical labels that do not meet, sheet pins nothing is wired to, and sheets that hold themselves. */
function sheetFindings(project: Project): ErcFinding[] {
  const out: ErcFinding[] = []
  const symbols = project.sheetSymbols ?? []
  const labels = project.labels.filter((l) => l.kind === "hierarchical")
  if (!symbols.length && !labels.length) return out
  const uses = sheetUses(project)
  const usePaths = (sheet: string) => uses.filter((u) => u.sheet === sheet).map((u) => u.path)
  const hierOf = (sheet: string) => new Set(labels.filter((l) => (l.sheet ?? ROOT_SHEET) === sheet).map((l) => l.name.trim()))
  const pinsOf = (symbolsOn: SheetSymbolLike[]) => new Set(symbolsOn.flatMap((s) => s.pins.map((p) => p.name.trim())))
  type SheetSymbolLike = NonNullable<Project["sheetSymbols"]>[number]
  for (const sym of symbols) {
    const have = hierOf(sym.child)
    const parentUse = usePaths(sym.sheet)[0] ?? ""
    for (const pin of sym.pins) {
      const name = pin.name.trim()
      const where = { x: pin.x, y: pin.y }
      if (name && !have.has(name)) {
        out.push({ kind: "sheet-pin-no-label", key: `sheet-pin-no-label:${sym.id}:${pin.id}`, message: `The pin ${name} of the sheet ${sheetSymbolName(sym)} has no hierarchical label called ${name} inside the sheet`, subject: `sheet pin ${name} of ${sheetSymbolName(sym)}`, componentIds: [], labelIds: [], at: where, ...(parentUse ? { sheet: parentUse } : {}) })
      }
      if (!touchesAt(project, sym.sheet, usePaths(sym.sheet), where)) {
        out.push({ kind: "sheet-pin-unconnected", key: `sheet-pin-unconnected:${sym.id}:${pin.id}`, message: `The pin ${name || "(no name)"} of the sheet ${sheetSymbolName(sym)} has nothing connected to it`, subject: `unconnected sheet pin ${name} of ${sheetSymbolName(sym)}`, componentIds: [], labelIds: [], at: where, ...(parentUse ? { sheet: parentUse } : {}) })
      }
    }
  }
  for (const l of labels) {
    const sheet = l.sheet ?? ROOT_SHEET
    const name = l.name.trim()
    const above = symbols.filter((s) => s.child === sheet)
    const own = usePaths(sheet)[0] ?? ""
    if (!above.length) {
      out.push({ kind: "label-no-sheet-pin", key: `label-no-sheet-pin:${l.id}`, message: `The hierarchical label ${name} is on a sheet no sheet symbol stands for, so it joins nothing`, subject: `hierarchical label ${name}`, componentIds: [], labelIds: [l.id], at: { x: l.x, y: l.y }, ...(own ? { sheet: own } : {}) })
    } else if (!pinsOf(above).has(name)) {
      out.push({ kind: "label-no-sheet-pin", key: `label-no-sheet-pin:${l.id}`, message: `The hierarchical label ${name} has no pin called ${name} on the sheet symbol above`, subject: `hierarchical label ${name}`, componentIds: [], labelIds: [l.id], at: { x: l.x, y: l.y }, ...(own ? { sheet: own } : {}) })
    }
  }
  for (const sym of refusedSheetSymbols(project)) {
    out.push({ kind: "sheet-loop", key: `sheet-loop:${sym.id}`, message: `The sheet ${sheetSymbolName(sym)} holds itself, directly or through other sheets, so its pages are left out`, subject: `sheet ${sheetSymbolName(sym)}`, componentIds: [], labelIds: [], at: { x: sym.x, y: sym.y } })
  }
  return out
}

/** Findings split into the ones to show and the ones the user ignored. */
export function splitIgnored(findings: ErcFinding[], ignored: readonly string[] | undefined) {
  const keys = new Set(ignored ?? [])
  return {
    active: findings.filter((f) => !keys.has(f.key)),
    ignored: findings.filter((f) => keys.has(f.key)),
  }
}

/** Stop reporting a finding, by its key. One undo step in the editor. */
export function ignoreCheck(project: Project, key: string): Project {
  if (project.ignoredChecks?.includes(key)) return project
  return { ...project, ignoredChecks: [...(project.ignoredChecks ?? []), key], updatedAt: Date.now() }
}

/** Report an ignored finding again. */
export function restoreCheck(project: Project, key: string): Project {
  if (!project.ignoredChecks?.includes(key)) return project
  const rest = project.ignoredChecks.filter((k) => k !== key)
  return { ...project, ignoredChecks: rest.length ? rest : undefined, updatedAt: Date.now() }
}
