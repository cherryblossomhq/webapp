import { getFootprint, isValidFootprint, registerProjectFootprints } from "./footprints"
import { CATEGORIES, findPart, isRegistered, registerPart } from "./library"
import { discreteSymbol, type DiscreteSymbolName } from "./discreteSymbols"
import { makeBoxSymbol, type BoxPin } from "./symbols"
import type { CustomPartSpec, FootprintDef, PartCategory, PartDef, PinDef, PinSide, Project, SymbolDef } from "./types"

// Parts the library doesn't have, made for one project (by the copilot) and stored in it.
// A spec is plain data; this module validates it and builds the PartDef the editor renders.

const ANODE = ["A", "ANODE", "+"]
const CATHODE = ["K", "C", "CATHODE", "-"]
const POSITIVE = ["+", "POS", "PLUS", "1"]
const NEGATIVE = ["-", "NEG", "MINUS", "2"]

interface SymbolKind {
  symbol: DiscreteSymbolName
  /** Designator prefix when the spec names none. */
  ref: string
  /** Library port labels, each with the pin names it accepts; unnamed ports take the remaining pins in order. */
  ports: { label: string; names?: string[] }[]
}

const twoTerminal = (symbol: DiscreteSymbolName, ref: string): SymbolKind => ({ symbol, ref, ports: [{ label: "1" }, { label: "2" }] })
const polarized = (symbol: DiscreteSymbolName, ref: string, first: string[], second: string[]): SymbolKind => ({
  symbol,
  ref,
  ports: [
    { label: "1", names: first },
    { label: "2", names: second },
  ],
})

/** Discrete symbols a project part can use instead of a box. Pins are matched by name where polarity matters. */
export const CUSTOM_SYMBOLS: Record<string, SymbolKind> = {
  resistor: twoTerminal("resistor", "R"),
  capacitor: twoTerminal("capacitor", "C"),
  capacitor_polarized: polarized("capacitor_polarized", "C", POSITIVE, NEGATIVE),
  inductor: twoTerminal("inductor", "L"),
  ferrite_bead: twoTerminal("ferrite_bead", "FB"),
  crystal: twoTerminal("crystal", "Y"),
  fuse: twoTerminal("fuse", "F"),
  diode: polarized("diode", "D", ANODE, CATHODE),
  schottky: polarized("schottky", "D", ANODE, CATHODE),
  zener: polarized("zener", "D", ANODE, CATHODE),
  tvs: polarized("tvs", "D", ANODE, CATHODE),
  led: polarized("led", "D", ANODE, CATHODE),
  battery: polarized("battery", "BT", POSITIVE, NEGATIVE),
  buzzer: twoTerminal("buzzer", "BZ"),
  switch: twoTerminal("pushbutton", "SW"),
  npn: {
    symbol: "npn",
    ref: "Q",
    ports: [
      { label: "1", names: ["C", "COLLECTOR"] },
      { label: "2", names: ["B", "BASE"] },
      { label: "3", names: ["E", "EMITTER"] },
    ],
  },
  pnp: {
    symbol: "pnp",
    ref: "Q",
    ports: [
      { label: "1", names: ["C", "COLLECTOR"] },
      { label: "2", names: ["B", "BASE"] },
      { label: "3", names: ["E", "EMITTER"] },
    ],
  },
  nmos: {
    symbol: "nmos",
    ref: "Q",
    ports: [
      { label: "1", names: ["D", "DRAIN"] },
      { label: "2", names: ["S", "SOURCE"] },
      { label: "3", names: ["G", "GATE"] },
    ],
  },
  pmos: {
    symbol: "pmos",
    ref: "Q",
    ports: [
      { label: "1", names: ["D", "DRAIN"] },
      { label: "2", names: ["S", "SOURCE"] },
      { label: "3", names: ["G", "GATE"] },
    ],
  },
}

export const CUSTOM_CATEGORIES = CATEGORIES.filter((c) => c !== "Symbols")

export const DEFAULT_REF_PREFIX: Record<PartCategory, string> = {
  Passives: "X",
  Diodes: "D",
  Transistors: "Q",
  Power: "U",
  ICs: "U",
  Modules: "U",
  Connectors: "J",
  Electromechanical: "SW",
  Symbols: "#",
}

const BODY: Partial<Record<PartCategory, PartDef["body3d"]>> = {
  Modules: { height: 3.2, color: "#1f3b2c" },
  Connectors: { height: 5, color: "#111111" },
  Electromechanical: { height: 3.5, color: "#2b2b2e" },
}

/** Map library port labels to pin numbers; an error names the pins a polarized symbol needs. */
function symbolPinMap(kind: SymbolKind, pins: PinDef[]): Record<string, string> | string {
  if (pins.length !== kind.ports.length) return `needs exactly ${kind.ports.length} pins, got ${pins.length}`
  const map: Record<string, string> = {}
  const used = new Set<string>()
  for (const port of kind.ports) {
    if (!port.names) continue
    const pin = pins.find((p) => !used.has(p.number) && port.names!.includes(p.name.trim().toUpperCase()))
    if (!pin) return `needs a pin named ${port.names.slice(0, 2).join(" or ")}`
    map[port.label] = pin.number
    used.add(pin.number)
  }
  const rest = pins.filter((p) => !used.has(p.number))
  for (const port of kind.ports) if (!port.names) map[port.label] = rest.shift()!.number
  return map
}

/** Sides for a box symbol: as given, else by pin kind, else split evenly between left and right in pin order. */
function boxLayout(pins: CustomPartSpec["pins"]) {
  const sides: Record<PinSide, BoxPin[]> = { left: [], right: [], top: [], bottom: [] }
  const free: BoxPin[] = []
  for (const p of pins) {
    const side: PinSide | undefined =
      p.side ??
      (p.kind === "power" ? "top" : p.kind === "ground" ? "bottom" : p.kind === "input" ? "left" : p.kind === "output" ? "right" : undefined)
    const pin = { number: p.number, name: p.name }
    if (side) sides[side].push(pin)
    else free.push(pin)
  }
  const toLeft = Math.max(0, Math.min(free.length, Math.round((free.length + sides.right.length - sides.left.length) / 2)))
  sides.left.push(...free.slice(0, toLeft))
  sides.right.push(...free.slice(toLeft))
  return sides
}

function buildSymbol(spec: CustomPartSpec): SymbolDef {
  if (spec.symbol) {
    const kind = CUSTOM_SYMBOLS[spec.symbol]
    if (!kind) throw new Error(`Unknown symbol "${spec.symbol}". Use one of: ${Object.keys(CUSTOM_SYMBOLS).join(", ")}`)
    const map = symbolPinMap(kind, spec.pins)
    if (typeof map === "string") throw new Error(`The ${spec.symbol} symbol ${map}`)
    return discreteSymbol(kind.symbol, map)
  }
  return makeBoxSymbol(boxLayout(spec.pins))
}

/** Every reason the spec can't be built, or an empty list. */
export function customPartProblems(spec: CustomPartSpec): string[] {
  const problems: string[] = []
  if (!spec.name.trim()) problems.push("name is empty")
  if (!CATEGORIES.includes(spec.category) || spec.category === "Symbols") {
    problems.push(`category must be one of ${CUSTOM_CATEGORIES.join(", ")}`)
  }
  if (!/^[A-Z]{1,3}$/.test(spec.refPrefix)) problems.push("ref_prefix must be 1-3 capital letters, e.g. U, J, Q")
  if (!spec.pins.length) problems.push("a part needs at least one pin")
  const numbers = new Set<string>()
  for (const p of spec.pins) {
    if (!p.number.trim()) problems.push("every pin needs a number")
    else if (numbers.has(p.number)) problems.push(`pin ${p.number} is listed twice`)
    numbers.add(p.number)
  }
  if (problems.length) return problems

  if (!isValidFootprint(spec.footprint)) {
    problems.push(`unknown footprint "${spec.footprint}"`)
    return problems
  }
  const alias = spec.padAlias ?? {}
  const padPins = new Set<string>()
  const orphanPads: string[] = []
  const footprintPads = getFootprint(spec.footprint).pads
  for (const pad of footprintPads) {
    if (!pad.pin) continue
    const pin = alias[pad.pin] ?? pad.pin
    if (numbers.has(pin)) padPins.add(pin)
    // An exposed pad may be left without a pin, as it always could be.
    else if (!pad.exposed) orphanPads.push(pad.pin)
  }
  const padless = spec.pins.filter((p) => !padPins.has(p.number))
  const padCount = new Set(footprintPads.filter((p) => p.pin).map((p) => p.pin)).size
  if (padless.length) {
    // A pin for the exposed pad numbered anything but its pad: say which number it has.
    const ep = footprintPads.find((p) => p.exposed)
    const named = padless.find((p) => /^(EP|EPAD|PAD|THERMAL|THERMALPAD|EXPOSEDPAD)\d*$/i.test(p.name.replace(/[^a-z0-9]/gi, "")))
    const hint = ep && named ? `; the exposed pad is pad ${ep.pin}, so number pin ${named.name} ${ep.pin}` : ""
    problems.push(
      `footprint ${spec.footprint} has ${padCount} numbered pads, but pin(s) ${padless.slice(0, 12).map((p) => p.number).join(", ")} have no pad${hint}`,
    )
  }
  if (orphanPads.length) {
    problems.push(
      `pad(s) ${orphanPads.slice(0, 12).join(", ")} of ${spec.footprint} have no pin: list them (name NC, kind nc if unused) or map them with pad_alias`,
    )
  }
  if (spec.symbol) {
    const kind = CUSTOM_SYMBOLS[spec.symbol]
    if (!kind) problems.push(`unknown symbol "${spec.symbol}"; use one of ${Object.keys(CUSTOM_SYMBOLS).join(", ")} or leave it out for a box`)
    else {
      const map = symbolPinMap(kind, spec.pins)
      if (typeof map === "string") problems.push(`the ${spec.symbol} symbol ${map}`)
    }
  }
  return problems
}

const byNumber = (a: PinDef, b: PinDef) => {
  const na = Number(a.number)
  const nb = Number(b.number)
  return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.number.localeCompare(b.number)
}

/** Build the PartDef for a spec. Throws when the spec can't be drawn; validate with customPartProblems first. */
export function buildCustomPart(spec: CustomPartSpec): PartDef {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    refPrefix: spec.refPrefix,
    pins: spec.pins.map((p) => ({ number: p.number, name: p.name, kind: p.kind ?? "passive" })).sort(byNumber),
    symbol: buildSymbol(spec),
    footprints: [spec.footprint],
    defaultProps: { ...spec.props },
    valueProp: spec.valueProp,
    keywords: spec.keywords,
    padAlias: spec.padAlias,
    mpn: spec.props.mpn,
    body3d: BODY[spec.category] ?? { height: 1.4, color: "#1c1c1f" },
    custom: true,
  }
}

/**
 * Register a project's parts so findPart resolves them, and its land patterns before them, which
 * its parts may use; specs that can't be built are skipped.
 */
export function registerProjectParts(project: Pick<Project, "parts" | "footprints">) {
  registerProjectFootprints(project)
  for (const spec of project.parts ?? []) {
    if (isRegistered(spec.id)) continue
    try {
      registerPart(buildCustomPart(spec))
    } catch {
      // A hand-edited spec that no longer builds: its components show as unknown parts.
    }
  }
}

/** The project's own parts, in the order they were made. */
export function projectPartDefs(project: Pick<Project, "parts"> | null | undefined): PartDef[] {
  if (!project?.parts?.length) return []
  registerProjectParts(project)
  return project.parts.map((s) => findPart(s.id)).filter((p): p is PartDef => !!p?.custom)
}

/** FNV-1a, base 36: a short, stable digest of a definition. */
export function digest(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(0, 6)
}

/**
 * An id that changes whenever the definition does, so one id never names two different parts.
 * Provenance (`source`) is left out: checking a part against a supplier later doesn't make it a
 * different part, and parts made before it existed keep the ids they were saved with.
 */
export function customPartId(spec: Omit<CustomPartSpec, "id">): string {
  const definition = { ...spec }
  delete definition.source
  const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "part"
  return `${slug}-${digest(JSON.stringify(definition))}`
}

/**
 * Copy the specs of `partIds` that `target` lacks from `source`, with the project land patterns
 * they and `footprints` name, e.g. when pasting between projects.
 */
export function withPartsFrom(target: Project, source: Project, partIds: Iterable<string>, footprints: Iterable<string> = []): Project {
  const have = new Set((target.parts ?? []).map((s) => s.id))
  const add: CustomPartSpec[] = []
  for (const id of new Set(partIds)) {
    if (have.has(id)) continue
    const spec = source.parts?.find((s) => s.id === id)
    if (spec) add.push(spec)
  }
  const haveFootprints = new Set((target.footprints ?? []).map((f) => f.name))
  const addFootprints: FootprintDef[] = []
  for (const name of new Set([...add.map((s) => s.footprint), ...footprints])) {
    if (haveFootprints.has(name)) continue
    const def = source.footprints?.find((f) => f.name === name)
    if (def) addFootprints.push(def)
  }
  if (!add.length && !addFootprints.length) return target
  return {
    ...target,
    ...(add.length ? { parts: [...(target.parts ?? []), ...add] } : {}),
    ...(addFootprints.length ? { footprints: [...(target.footprints ?? []), ...addFootprints] } : {}),
  }
}
