import { describe, expect, it } from "vitest"
import { orthogonalElbow, pointOnSegment, samePoint } from "../src/lib/geometry"
import { computeConnectivity, type SchematicConnectivity } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { EXAMPLES } from "../src/model/examples"
import { addComponent, addLabel, addWire, cleanupWires, createProject, dragPlan, moveSchematicItems, partFollowers, partFollowersFresh } from "../src/model/ops"
import { dragSelection } from "../src/model/schematicEdit"
import type { Project, Rotation, Vec2 } from "../src/model/types"
import { broken } from "./net-rules"
import { netlist, netlistDiff } from "./sakura-session"

// What a drag puts back after it reshapes a wire (reseat, ops.ts): a label in the middle of the wire,
// the end of a wire that tees into it. Two cases that used to cut a net, and a fuzz on hand-drawn
// sheets that holds reseat to doing no harm of its own: it never joins nets that the stretch alone
// did not, never pulls a wire end off a pin that stays, and mends what the stretch cut.

const pin = (p: Project, ref: string, n: string) => schematicPins(p.components.find((c) => c.ref === ref)!).find((q) => q.pin === n)!.pos
const idOf = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id
const part = (p: Project, ref: string, x: number, y: number, rot: Rotation = 0) => addComponent(p, "resistor", { ref, sch: { x, y, rot } }).project

/** The raw drag, as the canvas does it each frame, then cleaned up as it is on drop. */
function drag(p: Project, ref: string, delta: Vec2, reseat = true) {
  const { ids, bands } = dragPlan(p, { components: [idOf(p, ref)], labels: [], wires: [] })
  return cleanupWires(moveSchematicItems(p, ids, delta, bands, computeConnectivity(p), { reseat }))
}

describe("a wire end on a crossing", () => {
  /**
   * R1.2 to R2.1 is one straight wire (y = 0), a vertical wire from R3.1 to R4.2 crosses it at
   * (3, 0), and a diagonal wire to R5.1 ends exactly on the crossing: one net, SIG, held by two wires.
   */
  function crossing() {
    let p = createProject("t")
    p = part(p, "R1", 0, 0)
    p = part(p, "R2", 9, 0)
    p = part(p, "R3", 3, 2.3, 90)
    p = part(p, "R4", 3, -2.3, 90)
    p = part(p, "R5", 4.3, 1)
    p = addWire(p, [pin(p, "R1", "2"), pin(p, "R2", "1")]).project
    p = addWire(p, [pin(p, "R3", "1"), pin(p, "R4", "2")]).project
    p = addWire(p, [{ x: 3, y: 0 }, pin(p, "R5", "1")]).project
    p = addLabel(p, "SIG", { x: 3, y: 1 }).project
    return p
  }
  const on = (p: Project) => ["R1.2", "R2.1", "R3.1", "R4.2", "R5.1"].map((k) => netlist(p).get(k))

  it("starts as one net", () => {
    expect(on(crossing())).toEqual(Array(5).fill("SIG"))
  })

  it("nudging R1 up keeps R1.2 and R2.1 on SIG, with a wire to the one that lost the crossing", () => {
    const p = crossing()
    const moved = drag(p, "R1", { x: 0, y: 0.1 })
    expect(on(moved)).toEqual(Array(5).fill("SIG"))
    expect(netlistDiff(netlist(p), netlist(moved))).toEqual([])
    // Without the reseat it is cut: the stretched wire no longer passes the crossing.
    expect(netlistDiff(netlist(p), netlist(drag(p, "R1", { x: 0, y: 0.1 }, false))).length).toBeGreaterThan(0)
  })

  it("is the same as a drop through the check", () => {
    const p = crossing()
    const res = dragSelection(p, { components: [idOf(p, "R1")], labels: [], wires: [] }, { x: 0, y: 0.1 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(on(res.project)).toEqual(Array(5).fill("SIG"))
  })
})

describe("a hook that collapses", () => {
  /** R1.2 faces right; its wire leaves, drops 0.3 and returns left past the pin to R2, with HOOK on the drop. */
  function hook() {
    let p = createProject("t")
    p = part(p, "R1", 0, 0)
    p = part(p, "R2", -1.3, -0.3)
    p = addWire(p, [pin(p, "R1", "2"), { x: 0.6, y: 0 }, { x: 0.6, y: -0.3 }, pin(p, "R2", "2")]).project
    p = addLabel(p, "HOOK", { x: 0.6, y: -0.15 }, 270).project
    return p
  }

  it("keeps the net's name when R1 is dragged down 0.3 and the spur is simplified away", () => {
    const p = hook()
    expect(netlist(p).get("R1.2")).toBe("HOOK")
    const moved = drag(p, "R1", { x: 0, y: -0.3 })
    expect(netlist(moved).get("R1.2")).toBe("HOOK")
    expect(netlist(moved).get("R2.2")).toBe("HOOK")
    // The label is on the wire: it is not left floating where the spur was.
    const l = moved.labels.find((x) => x.name === "HOOK")!
    expect(moved.wires.some((w) => w.points.some((q, i) => i > 0 && pointOnSegment(l, w.points[i - 1], q)))).toBe(true)
    expect(netlistDiff(netlist(hook()), netlist(drag(p, "R1", { x: 0, y: -0.3 }, false))).length).toBeGreaterThan(0)
  })
})

describe("a tee on a wire that is stretched", () => {
  it("stays on the same run of it, not at the far corner", () => {
    let p = createProject("t")
    p = part(p, "R1", 0, 0)
    p = part(p, "R2", 4, -5.3, 90)
    p = addWire(p, [pin(p, "R1", "2"), { x: 4, y: 0 }, pin(p, "R2", "2")]).project
    // A tee from the middle of the first run up to a label.
    p = addWire(p, [{ x: 2, y: 0 }, { x: 2, y: 1.5 }]).project
    p = addLabel(p, "TEE", { x: 2, y: 1.5 }, 90).project
    expect(netlist(p).get("R1.2")).toBe("TEE")
    const moved = drag(p, "R1", { x: 0, y: -0.5 })
    expect(netlist(moved).get("R1.2")).toBe("TEE")
    expect(netlist(moved).get("R2.2")).toBe("TEE")
    // The tee's wire still starts on the first run (y = -0.5, x = 2), not at the corner (4, -0.5).
    expect(moved.wires.some((w) => samePoint(w.points[0], { x: 2, y: -0.5 }) || samePoint(w.points[w.points.length - 1], { x: 2, y: -0.5 }))).toBe(true)
  })
})

describe("what hangs off a part, from the cached fragments", () => {
  it("is what the uncached cut gives, for every part and every pair of parts of every example", () => {
    for (const e of EXAMPLES) {
      const p = e.project
      const ids = p.components.map((c) => c.id)
      for (let i = 0; i < ids.length; i++) {
        for (const pick of [[ids[i]], [ids[i], ids[(i + 3) % ids.length]]]) {
          expect(partFollowers(p, pick), `${e.id} ${pick.join()}`).toEqual(partFollowersFresh(p, pick))
        }
      }
    }
  })
})

// ---------- hand-drawn sheets ----------

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

/** Six resistors, turned at random, joined in pairs by hand-drawn wires with tees, labels and chains. */
export function handDrawn(seed: number): { p: Project; nets: number } | null {
  const r = rng(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const spots: [number, number][] = [[0, 0], [7, 0], [14, 0], [0, -7], [7, -7], [14, -7]]
  let p = createProject("hand")
  spots.forEach(([x, y], i) => (p = part(p, `R${i + 1}`, x, y, pick([0, 90, 180, 270]) as Rotation)))
  const free = p.components.flatMap((c) => schematicPins(c).map((q) => ({ ref: c.ref, pos: q.pos, dir: q.dir })))
  const used = new Set<string>()
  const take = (not?: string) => {
    const options = free.filter((f) => !used.has(`${f.ref}${f.pos.x},${f.pos.y}`) && f.ref !== not)
    if (!options.length) return null
    const f = pick(options)
    used.add(`${f.ref}${f.pos.x},${f.pos.y}`)
    return f
  }
  const nets = 2 + Math.floor(r() * 2)
  const onWire = (pts: Vec2[], frac: number): { at: Vec2; dir: "h" | "v" } | null => {
    const i = 1 + Math.floor(r() * (pts.length - 1))
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 0.5) return null
    const t = Math.min(len - 0.2, Math.max(0.2, Math.round(frac * len * 10) / 10)) / len
    return { at: { x: Math.round((a.x + (b.x - a.x) * t) * 10) / 10, y: Math.round((a.y + (b.y - a.y) * t) * 10) / 10 }, dir: Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? "h" : "v" }
  }
  for (let k = 0; k < nets; k++) {
    const a = take()
    const b = a && take(a.ref)
    if (!a || !b) return null
    const name = `N${k}`
    const via = r() < 0.5 ? [{ x: Math.round((a.pos.x + b.pos.x) * 5) / 10 + pick([-1, 0, 1]), y: a.pos.y + (r() < 0.5 ? 0.6 : -0.6) }] : []
    const route = [a.pos, ...via.flatMap((v, i) => orthogonalElbow(i ? via[i - 1] : a.pos, v, r() < 0.5).slice(1)), ...orthogonalElbow(via.length ? via[via.length - 1] : a.pos, b.pos, r() < 0.5).slice(1)]
    const main = addWire(p, route)
    if (!main.wire) return null
    p = main.project
    const pts = main.wire.points
    // A label near an end, a second label on the same wire, a tee with a label, a chain of two tees.
    if (r() < 0.6) {
      const h = onWire(pts, 0.3)
      if (h) p = addLabel(p, name, h.at).project
    }
    if (r() < 0.6) {
      const h = onWire(pts, 0.7)
      if (h) p = addLabel(p, name, h.at).project
    }
    for (let t = 0; t < 2; t++) {
      const h = onWire(pts, r())
      if (!h) continue
      const len = 0.4 + Math.round(r() * 5) / 10
      const end: Vec2 = h.dir === "h" ? { x: h.at.x, y: h.at.y + (r() < 0.5 ? len : -len) } : { x: h.at.x + (r() < 0.5 ? len : -len), y: h.at.y }
      const tee = addWire(p, [h.at, end])
      p = tee.project
      if (r() < 0.7) p = addLabel(p, name, end).project
      if (tee.wire && r() < 0.5) {
        const h2 = onWire(tee.wire.points, 0.5)
        if (h2) {
          const e2: Vec2 = h2.dir === "h" ? { x: h2.at.x, y: h2.at.y + 0.5 } : { x: h2.at.x + 0.5, y: h2.at.y }
          p = addWire(p, [h2.at, e2]).project
          p = addLabel(p, name, e2).project
        }
      }
    }
  }
  const conn = computeConnectivity(p)
  // Only sheets whose nets are as drawn: one name each, no two joined by accident.
  if (conn.conflicts.length) return null
  const named = conn.nets.filter((n) => n.named)
  if (named.length !== nets || named.some((n) => n.pins.length !== 2)) return null
  return { p, nets }
}

/**
 * Pairs of the sheet's nets that touch in `result`, judged by geometry alone: every label gets a
 * name of its own, so only what is drawn on what joins them. "N0+N2" is a wire of N0 on a wire of N2.
 */
function touching(base: SchematicConnectivity, result: Project): Set<string> {
  const physical = computeConnectivity({ ...result, labels: result.labels.map((l) => ({ ...l, name: `~${l.id}` })) })
  const groups = new Map<string, Set<string>>()
  const add = (phys: string | undefined, was: string | undefined) => {
    if (!phys || !was) return
    groups.set(phys, (groups.get(phys) ?? new Set()).add(was))
  }
  for (const w of result.wires) add(physical.wireNet.get(w.id), base.wireNet.get(w.id))
  for (const l of result.labels) add(physical.labelNet.get(l.id), base.labelNet.get(l.id))
  for (const [key, phys] of physical.pinNet) add(phys, base.pinNet.get(key))
  const out = new Set<string>()
  for (const g of groups.values()) {
    const nets = [...g].sort()
    for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) out.add(`${nets[i]}+${nets[j]}`)
  }
  return out
}

const DELTAS: Vec2[] = [{ x: 0.1, y: 0 }, { x: 0, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: -0.3, y: 0.1 }, { x: 0.5, y: -0.5 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 1.5, y: 1.5 }, { x: -2, y: 0.4 }]

describe("reseat on hand-drawn sheets", () => {
  it("never joins or cuts what the stretch alone did not, never pulls a wire end off a pin that stays", () => {
    const sheets = Number(process.env.SEEDS ?? 6) * 10
    const stats = { sheets: 0, drags: 0, stretchBroke: 0, reseatMended: 0, reseatMade: [] as string[], pulledOff: [] as string[], afterGuard: [] as string[] }
    for (let seed = 1; stats.sheets < sheets && seed < sheets * 20; seed++) {
      const sheet = handDrawn(seed)
      if (!sheet) continue
      stats.sheets++
      const p = sheet.p
      const base = netlist(p)
      const conn = computeConnectivity(p)
      for (const c of p.components) {
        const stationary = p.components.filter((x) => x.id !== c.id).flatMap((x) => schematicPins(x).map((q) => q.pos))
        for (const delta of DELTAS) {
          stats.drags++
          const { ids, bands } = dragPlan(p, { components: [c.id], labels: [], wires: [] })
          const naive = cleanupWires(moveSchematicItems(p, ids, delta, bands, conn, { reseat: false }))
          const full = cleanupWires(moveSchematicItems(p, ids, delta, bands, conn))
          const dn = new Set(netlistDiff(base, netlist(naive)).map((x) => x.split(":")[0]))
          const df = new Set(netlistDiff(base, netlist(full)).map((x) => x.split(":")[0]))
          if (dn.size) stats.stretchBroke++
          // Nets that touch in the result and did not in the stretch alone are reseat's doing.
          const mn = touching(conn, naive)
          for (const m of touching(conn, full)) if (!mn.has(m)) stats.reseatMade.push(`seed ${seed}, ${c.ref} by ${JSON.stringify(delta)}: ${m}`)
          if ([...dn].some((k) => !df.has(k))) stats.reseatMended++
          // A wire end that sat on a pin that stays is still on it.
          const ends = (q: Project) => q.wires.flatMap((w) => [w.points[0], w.points[w.points.length - 1]])
          for (const e of ends(p)) {
            if (!stationary.some((s) => samePoint(s, e))) continue
            if (!ends(full).some((f) => samePoint(f, e))) stats.pulledOff.push(`seed ${seed}, ${c.ref} by ${JSON.stringify(delta)} at ${e.x},${e.y}`)
          }
          // And whatever the drop is allowed to keep breaks nothing.
          const ok = dragSelection(p, { components: [c.id], labels: [], wires: [] }, delta, {})
          if (ok.ok) stats.afterGuard.push(...broken(p, ok.project, !!ok.inline).map((x) => `seed ${seed}, ${c.ref} by ${JSON.stringify(delta)}: ${x}`))
        }
      }
    }
    if (process.env.FUZZ_STATS) console.info("reseat", JSON.stringify({ ...stats, reseatMade: stats.reseatMade.length, pulledOff: stats.pulledOff.length, afterGuard: stats.afterGuard.length }))
    expect(stats.sheets).toBeGreaterThan(20)
    expect(stats.reseatMade.slice(0, 5)).toEqual([])
    expect(stats.pulledOff.slice(0, 5)).toEqual([])
    expect(stats.afterGuard.slice(0, 5)).toEqual([])
    // The stretch alone does break nets on these sheets, and reseat mends some: the test is not vacuous.
    expect(stats.stretchBroke).toBeGreaterThan(0)
  })
})
