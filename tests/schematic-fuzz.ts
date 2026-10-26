import { writeFileSync } from "node:fs"
import { runTool, type ToolOutcome } from "../src/ai/tools"
import { computeConnectivity, pinKey, type SchematicConnectivity } from "../src/model/connectivity"
import { pointOnSegment } from "../src/lib/geometry"
import { schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { addLabel, addWire, createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"

/**
 * A seeded fuzz over Sakura's schematic tools with an oracle that knows which nets every pin was
 * asked to be on. After each call it compares the nets before and after: a call may join only the
 * nets it was told to join (the pins it was given, and the net it was told to name), may not split
 * a net, may not park a pin under another net's wire, and a call that fails must change nothing.
 */

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PARTS = [
  "resistor", "resistor", "resistor", "capacitor", "capacitor", "led", "diode", "npn", "nmos", "crystal", "pushbutton",
  "ams1117_3v3", "ams1117_5v0", "esp32_wroom_32e", "atmega328p", "sn74hc595", "ne555", "lm358", "uln2003a",
  "screw_terminal_3", "usb_c", "rpi_pico", "arduino_nano", "potentiometer", "inductor",
]
const NAMES = ["GND", "3V3", "VIN", "5V", "SDA", "SCL", "CLK", "MOSI", "MISO", "RST", "EN", "BOOT", "TX", "RX", "VBAT"]

/** auto: no x/y anywhere. mixed: some parts at random spots. debris: mixed, plus stray wires and labels dropped near pins. */
export type Placement = "auto" | "mixed" | "debris"

export interface FuzzStats {
  designs: number
  steps: Record<string, number>
  /** Calls that joined nets nobody asked for, or put a stray name on a net. */
  unasked: string[]
  /** Calls that split a net and did not say so. */
  lost: string[]
  /** Calls that split a net and told the caller which pins came loose. */
  lostReported: string[]
  /** Refused update_component calls that offered no spot. */
  noSpot: string[]
  /** Calls that left a pin under another net's wire. */
  looks: string[]
  /** A refused call that changed the project, or a call that said "done" and was not. */
  inconsistent: string[]
  /** Connects refused although every pin was free to connect. */
  falseRefusals: string[]
  /** Connects that reported pins it could not connect. */
  partial: string[]
  /** Refused connects on a sheet with debris on it (not judged: the refusal may be right). */
  refusals: string[]
  /** update_component calls refused because they would join nets, and the spot they offered did not work. */
  badSuggestions: string[]
  refusedMoves: number
  suggestedMoves: number
  maxMs: number
}

const emptyStats = (): FuzzStats => ({
  designs: 0,
  steps: {},
  unasked: [],
  lost: [],
  lostReported: [],
  noSpot: [],
  looks: [],
  inconsistent: [],
  falseRefusals: [],
  partial: [],
  refusals: [],
  badSuggestions: [],
  refusedMoves: 0,
  suggestedMoves: 0,
  maxMs: 0,
})

interface Snapshot {
  conn: SchematicConnectivity
  /** pin key -> net id, or solo:key */
  group: Map<string, string>
  /** group -> names written on it (labels, power ports) */
  names: Map<string, Set<string>>
  /** "pin|wire" pairs: a pin lying on a wire of a net it is not on */
  looks: Set<string>
}

function snapshot(p: Project): Snapshot {
  const conn = computeConnectivity(p)
  const group = new Map<string, string>()
  const names = new Map<string, Set<string>>()
  const addName = (g: string, n: string) => {
    const s = names.get(g) ?? new Set<string>()
    s.add(n)
    names.set(g, s)
  }
  const looks = new Set<string>()
  for (const c of p.components) {
    const part = findPart(c.partId)
    for (const pin of schematicPins(c, part)) {
      const key = pinKey(c.id, pin.pin)
      const g = conn.pinNet.get(key) ?? `solo:${key}`
      group.set(key, g)
      if (part?.powerNet) addName(g, c.props.net?.trim() || part.powerNet)
      for (const w of p.wires) {
        const wn = conn.wireNet.get(w.id)
        if (wn === g) continue
        if (w.points.some((q, i) => i > 0 && pointOnSegment(pin.pos, w.points[i - 1], q))) looks.add(`${key}|${w.id}`)
      }
      for (const l of p.labels) {
        if (conn.labelNet.get(l.id) !== g && pointOnSegment(pin.pos, l, l)) looks.add(`${key}|${l.id}`)
      }
    }
  }
  for (const l of p.labels) {
    const g = conn.labelNet.get(l.id)
    if (g) addName(g, l.name.trim())
  }
  return { conn, group, names, looks }
}

const byGroup = (s: Snapshot, keys: Iterable<string>) => {
  const m = new Map<string, string[]>()
  for (const k of keys) {
    const g = s.group.get(k)
    if (g === undefined) continue
    m.set(g, [...(m.get(g) ?? []), k])
  }
  return m
}

/** Compare nets before and after one call. `asked` are the pins that may be joined; `name` is a net they may join. */
function compare(
  before: Snapshot,
  after: Snapshot,
  asked: string[],
  name: string | undefined,
  label: string,
  stats: FuzzStats,
  opts: { autoName?: boolean; renames?: boolean } = {},
) {
  const { autoName = false, renames = false } = opts
  const common = [...before.group.keys()].filter((k) => after.group.has(k))
  const askedGroups = new Set(asked.map((k) => before.group.get(k)).filter((g): g is string => !!g))
  if (name) for (const [g, ns] of before.names) if (ns.has(name)) askedGroups.add(g)
  const allowedNames = new Set(name ? [name] : [])

  // Joined nets.
  const afterGroups = byGroup(after, common)
  for (const [g, keys] of afterGroups) {
    const covered = new Set(keys.map((k) => before.group.get(k)!))
    // Names that landed on this net and were on none of the nets it came from.
    const had = new Set<string>()
    for (const c of covered) for (const n of before.names.get(c) ?? []) had.add(n)
    const foreign = [...(after.names.get(g) ?? [])].filter(
      (n) => !had.has(n) && !allowedNames.has(n) && !(autoName && /^NET\d+$/.test(n)),
    )
    if (foreign.length) stats.unasked.push(`${label}: name ${foreign.join(",")} landed on ${keys.slice(0, 3).join(" ")}`)
    if (covered.size < 2) continue
    if ([...covered].every((c) => askedGroups.has(c))) continue
    stats.unasked.push(`${label}: joined ${[...covered].map((c) => `${c}(${keys.filter((k) => before.group.get(k) === c).slice(0, 2).join(" ")})`).join(" + ")}`)
  }
  // Split nets.
  const beforeGroups = byGroup(before, common)
  for (const [g, keys] of beforeGroups) {
    if (renames) break
    const parts = new Set(keys.map((k) => after.group.get(k)!))
    if (parts.size > 1 && !keys.every((k) => after.group.get(k)?.startsWith("solo:"))) stats.lost.push(`${label}: ${g} split (${keys.slice(0, 4).join(" ")})`)
  }
  // Pins under a wire that is not theirs.
  for (const l of after.looks) if (!before.looks.has(l)) stats.looks.push(`${label}: ${l}`)
}

const refOf = (p: Project, key: string) => {
  const i = key.lastIndexOf(":")
  const c = p.components.find((x) => x.id === key.slice(0, i))
  return `${c?.ref}.${key.slice(i + 1)}`
}

/** One fuzzed design. */
export function fuzzDesign(seed: number, placement: Placement, stats: FuzzStats, opts: { steps?: number } = {}) {
  const rand = rng(seed * 7919 + (placement === "auto" ? 1 : placement === "mixed" ? 2 : 3))
  const scatter = placement !== "auto"
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  let p = createProject(`fuzz-${seed}`)
  const total = opts.steps ?? 30 + Math.floor(rand() * 25)
  stats.designs++
  let snap = snapshot(p)
  const bump = (k: string) => (stats.steps[k] = (stats.steps[k] ?? 0) + 1)

  const call = (tool: string, input: Record<string, unknown>) => {
    const t0 = performance.now()
    const out = runTool(p, tool, input)
    stats.maxMs = Math.max(stats.maxMs, performance.now() - t0)
    return out
  }

  /** Apply a call, then judge it. `asked` are pin keys the call may join, `name` a net it may join. */
  const step = (tool: string, input: Record<string, unknown>, asked: string[] = [], name?: string, renames = false): ToolOutcome => {
    const label = `seed ${seed}/${placement} ${tool} ${JSON.stringify(input)}`
    if (process.env.FUZZ_DUMP && label.startsWith(process.env.FUZZ_DUMP)) writeFileSync(process.env.FUZZ_DUMP_FILE!, JSON.stringify({ project: p, tool, input }))
    const out = call(tool, input)
    bump(tool)
    if (out.isError && out.project !== p) stats.inconsistent.push(`${label}: refused but changed the project`)
    const next = out.isError ? p : out.project
    const after = next === p ? snap : snapshot(next)
    const lostBefore = stats.lost.length
    compare(snap, after, asked, name, label, stats, { autoName: tool === "connect", renames })
    if (!out.isError && /no longer on/.test(out.result)) stats.lostReported.push(...stats.lost.splice(lostBefore))
    else for (let i = lostBefore; i < stats.lost.length; i++) stats.lost[i] += ` => ${out.result.slice(0, 160)}`
    p = next
    snap = after
    return out
  }

  const pinsOf = (ref: string) => {
    const c = p.components.find((x) => x.ref === ref)
    const part = c && findPart(c.partId)
    return part ? part.pins.map((pin) => ({ spec: part.pins.length === 1 ? ref : `${ref}.${pin.number}`, key: pinKey(c!.id, pin.number) })) : []
  }
  const allPins = () => p.components.flatMap((c) => pinsOf(c.ref))
  /** The name someone chose for the net a pin is on, "(auto)" for a net with only made-up names, null for none. */
  const netNameOf = (key: string) => {
    const g = snap.group.get(key)
    if (!g || g.startsWith("solo:")) return null
    const named = [...(snap.names.get(g) ?? [])]
    return named.find((n) => !/^NET\d+$/.test(n)) ?? named[0] ?? "(auto)"
  }

  const addPart = () => {
    const id = pick(PARTS)
    const input: Record<string, unknown> = { part_id: id }
    if (scatter && rand() < 0.6) {
      input.x = Math.round(rand() * 200) / 10
      input.y = Math.round((rand() - 0.5) * 120) / 10
      if (rand() < 0.4) input.rotation = pick([0, 90, 180, 270])
    }
    const out = step("add_component", input)
    if (out.isError && placement === "auto") stats.falseRefusals.push(`seed ${seed}: add_component ${id} refused: ${out.result}`)
  }
  const addPort = () => {
    const kind = rand() < 0.5 ? "ground" : "power"
    const input: Record<string, unknown> = { part_id: kind }
    if (kind === "power") input.props = { net: pick(["3V3", "5V", "VIN", "VCC"]) }
    const name = kind === "ground" ? "GND" : (input.props as { net: string }).net
    const out = call("add_component", input)
    bump("add_component")
    const label = `seed ${seed}/${placement} add_component ${JSON.stringify(input)}`
    if (out.isError) {
      stats.falseRefusals.push(`${label}: ${out.result}`)
      return
    }
    const after = snapshot(out.project)
    compare(snap, after, [], name, label, stats)
    p = out.project
    snap = after
  }

  const nParts = 4 + Math.floor(rand() * 8)
  for (let i = 0; i < nParts; i++) (rand() < 0.1 ? addPort : addPart)()

  for (let s = 0; s < total; s++) {
    const r = rand()
    if (placement === "debris" && rand() < 0.15) {
      // Something already on the sheet: a loose wire or a label with a name, near a pin.
      const c = pick(p.components)
      const pins = schematicPins(c)
      if (!pins.length) continue
      const at = pick(pins).pos
      const near = (n: number) => Math.round((n + (rand() - 0.5) * 1.6) * 10) / 10
      const a = { x: near(at.x), y: near(at.y) }
      if (rand() < 0.6) p = addWire(p, [a, rand() < 0.5 ? { x: a.x + Math.round((rand() - 0.5) * 30) / 10, y: a.y } : { x: a.x, y: a.y + Math.round((rand() - 0.5) * 30) / 10 }]).project
      else p = addLabel(p, pick(["FOO", "BAR", "GND", "VIN", "NET1"]), a, pick([0, 90, 180, 270] as const)).project
      snap = snapshot(p)
      bump("debris")
      continue
    }
    if (r < 0.1 && p.components.length < 16) {
      ;(rand() < 0.15 ? addPort : addPart)()
    } else if (r < 0.62) {
      // connect
      const pins = allPins()
      if (pins.length < 2) continue
      const k = 1 + Math.floor(rand() * rand() * 5) + (rand() < 0.5 ? 1 : 0)
      const net = rand() < 0.55 ? pick(NAMES) : undefined
      let chosen: { spec: string; key: string }[] = []
      let ok = false
      for (let tries = 0; tries < 8 && !ok; tries++) {
        const free = rand() < 0.8
        const pool = free ? pins.filter((x) => !netNameOf(x.key)) : pins
        if (pool.length < 1) continue
        chosen = []
        for (let i = 0; i < k; i++) {
          const c = pick(pool)
          if (!chosen.some((x) => x.key === c.key)) chosen.push(c)
        }
        // Never ask for two named nets to become one: that is a short, and refusing it is right.
        const names = new Set(chosen.map((x) => netNameOf(x.key)).filter((n): n is string => !!n && n !== "(auto)" && !/^NET\d+$/.test(n)))
        if (net) names.add(net)
        const groups = new Set(chosen.map((x) => snap.group.get(x.key)).filter((g): g is string => !!g && !g.startsWith("solo:")))
        ok = names.size <= 1 && chosen.length >= (net ? 1 : 2) && groups.size <= 3
      }
      if (!ok) continue
      const input: Record<string, unknown> = { pins: chosen.map((x) => x.spec), ...(net ? { net_name: net } : {}) }
      const out = step("connect", input, chosen.map((x) => x.key), net)
      if (out.isError) (placement === "debris" ? stats.refusals : stats.falseRefusals).push(`seed ${seed}/${placement} connect ${JSON.stringify(input)}: ${out.result}`)
      else if (/not connected/i.test(out.result)) stats.partial.push(`seed ${seed}/${placement} connect ${JSON.stringify(input)}: ${out.result}`)
      else {
        const gs = new Set(chosen.map((x) => snap.group.get(x.key)))
        if (gs.size > 1 || [...gs].some((g) => g?.startsWith("solo:") && chosen.length > 1)) {
          stats.inconsistent.push(`seed ${seed}/${placement} connect ${JSON.stringify(input)}: said done, pins are on ${[...gs].join(" ")}`)
        }
      }
    } else if (r < 0.82) {
      // move or rotate
      const c = pick(p.components)
      const input: Record<string, unknown> = { ref: c.ref }
      const kind = rand()
      if (kind < 0.65) {
        input.x = Math.round((c.sch.x + (rand() - 0.5) * 8) * 10) / 10
        input.y = Math.round((c.sch.y + (rand() - 0.5) * 8) * 10) / 10
        if (rand() < 0.15) input.rotation = pick([0, 90, 180, 270])
      } else if (kind < 0.9) input.rotation = pick([0, 90, 180, 270])
      else input.x = Math.round(rand() * 160) / 10
      const out = step("update_component", input)
      if (out.isError) {
        stats.refusedMoves++
        if (!/x=-?[\d.]+, y=/.test(out.result) && !/Rotation \d+ works/.test(out.result)) stats.noSpot.push(`seed ${seed}/${placement} ${JSON.stringify(input)}: ${out.result}`)
        const m = out.result.match(/x=(-?[\d.]+), y=(-?[\d.]+)/)
        if (m) {
          stats.suggestedMoves++
          const probe = runTool(p, "update_component", { ref: c.ref, x: Number(m[1]), y: Number(m[2]), ...(typeof input.rotation === "number" ? { rotation: input.rotation } : {}) })
          if (probe.isError) stats.badSuggestions.push(`seed ${seed}/${placement}: ${out.result} -> ${probe.result}`)
        }
      }
    } else if (r < 0.9) {
      // remove
      if (p.components.length < 3) continue
      const c = pick(p.components)
      // Removing a part is meant to drop its own pins from their nets.
      step("remove_component", { ref: c.ref })
    } else if (r < 0.96) {
      const c = p.components.find((x) => findPart(x.partId)?.powerNet)
      if (!c) continue
      const net = pick(["3V3", "5V", "VIN", "GND", "VCC"])
      const keys = pinsOf(c.ref).map((x) => x.key)
      step("update_component", { ref: c.ref, props: { net } }, keys, net, true)
    } else {
      // props and rename: must never change a net
      const c = pick(p.components)
      step("update_component", { ref: c.ref, props: { note: "x" } })
    }
  }
}

export function runFuzz(designs: number, placements: Placement[] = ["auto", "mixed"], first = 1): Record<Placement, FuzzStats> {
  const out = {} as Record<Placement, FuzzStats>
  for (const placement of placements) {
    const stats = emptyStats()
    for (let i = 0; i < designs; i++) fuzzDesign(first + i, placement, stats)
    out[placement] = stats
  }
  return out
}

const byTool = (xs: string[]) => {
  const m: Record<string, number> = {}
  for (const x of xs) {
    const t = x.match(/ (add_component|update_component|remove_component|connect|create_part) /)?.[1] ?? "?"
    m[t] = (m[t] ?? 0) + 1
  }
  return m
}

export const summarize = (s: FuzzStats) => ({
  designs: s.designs,
  calls: s.steps,
  unasked: s.unasked.length,
  unaskedByTool: byTool(s.unasked),
  lost: s.lost.length,
  lostByTool: byTool(s.lost),
  lostReported: s.lostReported.length,
  noSpot: s.noSpot.length,
  looks: s.looks.length,
  looksByTool: byTool(s.looks),
  inconsistent: s.inconsistent.length,
  falseRefusals: s.falseRefusals.length,
  partial: s.partial.length,
  refusals: s.refusals.length,
  refusedMoves: s.refusedMoves,
  suggestedMoves: s.suggestedMoves,
  badSuggestions: s.badSuggestions.length,
  slowestCallMs: Math.round(s.maxMs),
})

export { refOf }
