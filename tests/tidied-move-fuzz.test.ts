import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicPins, type WorldPin } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { pinsUnderOtherNets } from "../src/model/merges"
import { partFollowers } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { netlist, netlistDiff, Session } from "./sakura-session"
import { comb, labelledWire, portOnPin, sharedTee, teeToPort } from "./tidy-shapes"

/**
 * Moves and turns of random parts on sheets drawn the way Tidy draws them: supply pins on
 * power symbols (right on the pin, at the end of a short wire, or on a tee out of a comb joining
 * several pins), signal pins on label stubs, junctions two parts share with a symbol tee on them,
 * and wires between two parts with the net's label sitting on the middle of them. Every move or turn ends one of two ways:
 *
 *   - the netlist is pin for pin identical (and no pin sits under a wire of another net), or
 *   - the call is refused and the project is the very one it was given.
 *
 * FUZZ_SHEETS=200 for more.
 */

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

const PARTS = ["resistor", "resistor", "capacitor", "capacitor", "led", "diode", "npn", "nmos", "crystal", "ne555", "lm358", "sn74hc595", "ams1117_3v3", "pushbutton"]

const looks = (p: Project) => new Set(pinsUnderOtherNets(p, computeConnectivity(p)).map((h) => `${h.pin}|${h.net}`))

/** A random sheet: parts on a loose grid, wired with labels by `connect`, then restyled the way Tidy draws it. */
function tidiedSheet(seed: number): { s: Session; styled: number } {
  const r = rng(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const s = new Session()
  s.must("set_board", { width: 60, height: 40 })
  const count = 5 + Math.floor(r() * 6)
  for (let i = 0; i < count; i++) {
    const at = { x: (i % 4) * 9 + Math.round(r() * 10) / 10, y: Math.floor(i / 4) * 9 + Math.round(r() * 10) / 10 }
    s.must("add_component", { part_id: pick(PARTS), ...at, rotation: pick([0, 0, 90, 180, 270]) })
  }
  // Nets: every pin goes to GND, 3V3, one of a few signals, or nothing.
  const groups = new Map<string, string[]>()
  for (const c of s.project.components) {
    const part = findPart(c.partId)!
    for (const pin of part.pins) {
      const roll = r()
      const net = roll < 0.3 ? "GND" : roll < 0.5 ? "3V3" : roll < 0.75 ? `SIG${Math.floor(r() * 4)}` : null
      if (net) groups.set(net, [...(groups.get(net) ?? []), `${c.ref}.${pin.number}`])
    }
  }
  for (const [net, pins] of groups) {
    const rail = net === "GND" || net === "3V3"
    if (pins.length < (rail ? 1 : 2)) continue
    s.run("connect", { pins, net_name: net })
  }

  // Restyle supplies and add shared junctions; a shape that changes the netlist or lands a pin under
  // another net's wire is not one Tidy would draw, and is dropped.
  const before = netlist(s.project)
  const looked = looks(s.project)
  let p = s.project
  let styled = 0
  const net = (ref: string, number: string) => before.get(`${ref}.${number}`)
  const pinsOf = (ref: string): WorldPin[] => schematicPins(p.components.find((c) => c.ref === ref)!)
  const draw = (shape: Project | null) => {
    if (!shape) return
    if (netlistDiff(before, netlist(shape)).length) return
    for (const l of looks(shape)) if (!looked.has(l)) return
    p = shape
    styled++
  }
  for (const c of s.project.components) {
    const rails = (["GND", "3V3"] as const).map((n) => ({ n, pins: pinsOf(c.ref).filter((q) => net(c.ref, q.pin) === n) }))
    for (const { n, pins } of rails) {
      const bySide = new Map<string, WorldPin[]>()
      for (const q of pins) bySide.set(q.dir, [...(bySide.get(q.dir) ?? []), q])
      for (const side of bySide.values()) {
        const how = r()
        if (how < 0.3 && side.length > 1) draw(comb(p, side, n))
        else if (how < 0.6) for (const q of side) draw(portOnPin(p, pinsOf(c.ref).find((x) => x.pin === q.pin)!, n))
        else if (how < 0.85) for (const q of side) draw(teeToPort(p, pinsOf(c.ref).find((x) => x.pin === q.pin)!, n))
      }
    }
  }
  // Two parts sharing a rail through one wire with a tee to a symbol on it.
  const refs = s.project.components.map((c) => c.ref)
  for (let i = 0; i < 3; i++) {
    const a = pick(refs)
    const b = pick(refs)
    if (a === b) continue
    for (const n of ["GND", "3V3"] as const) {
      const pa = pinsOf(a).find((q) => net(a, q.pin) === n)
      const pb = pinsOf(b).find((q) => net(b, q.pin) === n)
      if (pa && pb) draw(sharedTee(p, pa, pb, n, r() < 0.5 ? "h" : "v"))
    }
  }
  // A wire between two pins of one net with the net's name written on the middle of it.
  for (let i = 0; i < 6; i++) {
    const a = pick(refs)
    const b = pick(refs)
    if (a === b) continue
    const pa = pick(pinsOf(a))
    const pb = pinsOf(b).find((q) => net(b, q.pin) && net(b, q.pin) === net(a, pa.pin))
    const name = net(a, pa.pin)
    if (pb && name && !name.startsWith("Net-(")) draw(labelledWire(p, pa, pb, name))
  }
  s.project = p
  s.start = p
  return { s, styled }
}

describe("moving and turning parts on tidied sheets", () => {
  it("leaves every pin on its net, or refuses and changes nothing", () => {
    const sheets = Number(process.env.FUZZ_SHEETS ?? 30)
    const broken: string[] = []
    const stats = { sheets: 0, styled: 0, ops: 0, done: 0, refused: 0, carried: 0, cutRefusals: 0 }
    for (let seed = 1; seed <= sheets; seed++) {
      const { s, styled } = tidiedSheet(seed)
      stats.sheets++
      stats.styled += styled
      const r = rng(seed * 7919)
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
      for (let i = 0; i < 14; i++) {
        const was = s.project
        const movable = was.components.filter((c) => !c.ref.startsWith("#"))
        const c = pick(movable)
        const input: Record<string, unknown> = { ref: c.ref }
        const roll = r()
        if (roll < 0.75) {
          // Near its place half the time, where nothing else is, and far away otherwise.
          const near = r() < 0.5
          input.x = Math.round((near ? c.sch.x + (r() - 0.5) * 8 : r() * 45 - 5) * 10) / 10
          input.y = Math.round((near ? c.sch.y + (r() - 0.5) * 8 : r() * 35 - 5) * 10) / 10
        }
        if (roll > 0.6) input.rotation = pick([0, 90, 180, 270])
        const label = `sheet ${seed} ${JSON.stringify(input)}`
        const followers = partFollowers(was, [c.id])
        const names = netlist(was)
        const out = s.run("update_component", input)
        stats.ops++
        if (out.isError) {
          stats.refused++
          if (/would cut/.test(out.result)) {
            stats.cutRefusals++
            if (!/would cut [^ ,]+\.[^ ,]+(, [^ ,]+\.[^ ,]+)* off /.test(out.result)) broken.push(`${label}: a cut was refused without naming the pins: ${out.result.slice(0, 160)}`)
          }
          if (out.project !== was) broken.push(`${label}: refused but changed the project`)
          if (!/Not changed/.test(out.result)) broken.push(`${label}: refused without saying what: ${out.result.slice(0, 120)}`)
          continue
        }
        if (s.project === was) continue
        stats.done++
        if (followers.components.length || followers.wires.length) stats.carried++
        const diff = netlistDiff(names, netlist(s.project))
        if (diff.length) broken.push(`${label}: ${diff.slice(0, 4).join("; ")} (${out.result.slice(0, 120)})`)
        for (const l of looks(s.project)) if (!looks(was).has(l)) broken.push(`${label}: ${l} now looks connected`)
      }
    }
    expect(broken.slice(0, 5)).toEqual([])
    // The fuzz means nothing if the sheets were plain or every call was refused.
    expect(stats.styled).toBeGreaterThan(stats.sheets * 3)
    expect(stats.done).toBeGreaterThan(stats.ops * 0.2)
    expect(stats.carried).toBeGreaterThan(stats.sheets)
    expect(stats.refused).toBeGreaterThan(0)
  })
})
