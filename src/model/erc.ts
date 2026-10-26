import { parseValue } from "../lib/values"
import { pinKey, type SchematicConnectivity } from "./connectivity"
import { findPart } from "./library"
import { isPhysical, schematicPins } from "./instances"
import type { ComponentInstance, CustomPartSpec, Net, PartDef, Project, Vec2 } from "./types"

/**
 * Electrical rule checks: is the circuit right, as opposed to drawn right. Schematic only, and
 * every finding is a warning: each rule can be wrong about a real part, so none of them may
 * block fabrication, and each can be ignored for good (`Project.ignoredChecks`).
 *
 * - **lone-label**: a pin whose net is that pin and a label no other pin shares, usually a
 *   misspelt label. Connectivity counts a named net as connected, so nothing else sees it.
 * - **bare-led**: an LED with nothing in series to limit its current (ported from PR #88).
 * - **shorted**: a two-pin part with both pins on one net, so it does nothing (from PR #97).
 *
 * Measured on the five examples, the three v1 fixtures and the eight blog boards brought in
 * from tscircuit: every hit was a real mistake and none was a false alarm.
 */

export type ErcKind = "lone-label" | "bare-led" | "shorted"

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
  /** Labels it is about (lone-label). */
  labelIds: string[]
  /** Where on the schematic to look. */
  at: Vec2
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

/** Find electrical mistakes in the schematic. Pure; `store/analysis.ts` caches it beside connectivity. */
export function runErc(project: Project, conn: SchematicConnectivity): ErcFinding[] {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  const specs = new Map((project.parts ?? []).map((s) => [s.id, s]))
  const nets = new Map(conn.nets.map((n) => [n.id, n]))
  const netOf = (componentId: string, pin: string) => conn.pinNet.get(pinKey(componentId, pin))
  const ncOf = (c: ComponentInstance) => new Set(c.nc ?? [])

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

  // ---------- A pin only on a label nothing else shares ----------
  const labelsOf = new Map<string, string[]>()
  for (const l of project.labels) {
    const id = conn.labelNet.get(l.id)
    if (id) labelsOf.set(id, [...(labelsOf.get(id) ?? []), l.id])
  }
  const labelName = new Map(project.labels.map((l) => [l.id, l.name.trim()]))
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!isPhysical(part)) continue
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
    if (!part || !isPhysical(part) || part.pins.length !== 2) continue
    // A connector or test point exposes nets, so two of its contacts on one net is ordinary;
    // so is a part whose two pins are both declared supply or ground pads (a shield, say), and
    // one with a pin declared unused, which is a one-pin part.
    if (part.category === "Connectors" || part.refPrefix === "TP" || /test.?point/i.test(part.name)) continue
    const [a, b] = part.pins
    if (a.kind === b.kind && (a.kind === "power" || a.kind === "ground")) continue
    if (a.kind === "nc" || b.kind === "nc") continue
    if (ncOf(c).has(a.number) || ncOf(c).has(b.number)) continue
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
    if (!part || !isPhysical(part)) continue
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

  const order: Record<ErcKind, number> = { "bare-led": 0, shorted: 1, "lone-label": 2 }
  return findings.sort(
    (x, y) =>
      order[x.kind] - order[y.kind] ||
      x.subject.localeCompare(y.subject, undefined, { numeric: true }),
  )
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
