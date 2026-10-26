import { readFileSync } from "node:fs"
import * as circuitJson from "circuit-json"
import { describe, expect, it } from "vitest"
import { circuitJsonFile, projectToCircuitJson } from "../src/export/circuitJson"
import { projectFromCircuitJson } from "../src/model/circuitJsonImport"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { EXAMPLES } from "../src/model/examples"
import { PARTS } from "../src/model/library"
import { addComponent, addTrace, addVia, createProject, labelPin } from "../src/model/ops"
import { parseProjectFile } from "../src/model/projectFile"
import type { Project, Rotation } from "../src/model/types"
import { isPhysical } from "../src/model/instances"

const origin = { id: "p", createdAt: 0, updatedAt: 0 }

/**
 * The schema circuit-json exports under an element's type name, which is the same check as
 * `any_circuit_element` without trying every other kind first: that union takes a minute on a
 * board with thousands of elements.
 */
interface Schema {
  safeParse: (value: unknown) => { success: true; data: unknown } | { success: false; error: { issues: unknown[] } }
}
const schemaOf = (type: string): Schema => (circuitJson as unknown as Record<string, Schema | undefined>)[type] ?? circuitJson.any_circuit_element

/** Every element must be one circuit-json accepts, with no field dropped for not being in its schema. */
function schemaProblems(elements: unknown[]): string[] {
  const problems: string[] = []
  for (const el of elements as Record<string, unknown>[]) {
    const parsed = schemaOf(String(el.type)).safeParse(el)
    if (!parsed.success) {
      problems.push(`${String(el.type)}: ${JSON.stringify(parsed.error.issues[0]).slice(0, 200)}`)
      continue
    }
    const out = parsed.data as Record<string, unknown>
    for (const key of Object.keys(el)) {
      if (!(key in out)) problems.push(`${String(el.type)}.${key} is not in the schema and would be stripped`)
    }
  }
  return problems
}

interface Net {
  name: string | null
  pins: string[]
}

/** Nets as sets of "REF:pin", named where the netlist names them. */
function netlist(p: Project): Net[] {
  const ref = new Map(p.components.map((c) => [c.id, c.ref]))
  return computeConnectivity(p)
    .nets.filter((n) => n.pins.length >= 2 || (n.named && n.pins.length))
    .map((n) => ({ name: n.named ? n.name : null, pins: n.pins.map((x) => `${ref.get(x.componentId)}:${x.pin}`).sort() }))
    .sort((a, b) => a.pins.join().localeCompare(b.pins.join()))
}

const padKey = (n: number) => String(Math.round(n * 1000) / 1000)

function pads(p: Project): Record<string, string[]> {
  return Object.fromEntries(
    p.components
      .filter((c) => c.pcb.placed)
      .map((c) => [
        c.ref,
        pcbPads(c)
          .map((pad) => [pad.pin ?? "-", padKey(pad.x), padKey(pad.y), padKey(pad.width), padKey(pad.height), padKey(pad.holeDiameter ?? 0), padKey(pad.slotLength ?? 0), pad.plated === false ? "npth" : "", pad.layers.join("+")].join("|"))
          .sort(),
      ]),
  )
}

function expectRoundTrip(original: Project) {
  const { elements } = projectToCircuitJson(original)
  expect(schemaProblems(elements)).toEqual([])
  const back = projectFromCircuitJson(JSON.parse(JSON.stringify(elements)), { name: original.name })
  const refs = original.components.filter((c) => isPhysical(PARTS.find((x) => x.id === c.partId) ?? undefined) || c.pcb.placed).map((c) => c.ref)
  void refs
  const before = netlist(original)
  const after = netlist(back.project)
  // Same partition of pins; the nets the original named keep their names.
  expect(after.map((n) => n.pins)).toEqual(before.map((n) => n.pins))
  for (const [i, net] of before.entries()) if (net.name) expect(after[i].name).toBe(net.name)
  expect(pads(back.project)).toEqual(pads(original))
  return { elements, back }
}

describe("projectToCircuitJson", () => {
  describe.each(EXAMPLES.map((e) => [e.name, e.project] as const))("the %s example", (_name, project) => {
    const { elements } = projectToCircuitJson(project)

    it("is made of elements circuit-json accepts", () => {
      expect(schemaProblems(elements)).toEqual([])
    })

    it("comes back through the importer with the same netlist, pin for pin, and the same pads", () => {
      const { back } = expectRoundTrip(project)
      expect(back.project.vias).toHaveLength(project.vias.length)
      expect(back.project.zones.map((z) => `${z.net}:${z.layer}`).sort()).toEqual(project.zones.map((z) => `${z.net}:${z.layer}`).sort())
      expect(back.project.board).toMatchObject({ width: project.board.width, height: project.board.height, cornerRadius: project.board.cornerRadius, mountingHoles: project.board.mountingHoles })
      expect(back.project.traces.reduce((n, t) => n + t.points.length, 0)).toBe(project.traces.reduce((n, t) => n + t.points.length, 0))
    })
  })

  it.each(["sheet", "imported", "blinker"])("exports the v1 fixture %s and reads it back", (name) => {
    const { file } = JSON.parse(readFileSync(new URL(`./fixtures/project-v1/${name}.json`, import.meta.url), "utf8"))
    const project = parseProjectFile(file, origin)
    const { elements } = projectToCircuitJson(project)
    expect(schemaProblems(elements)).toEqual([])
    const back = projectFromCircuitJson(JSON.parse(JSON.stringify(elements)), { name })
    const placed = project.components.filter((c) => c.pcb.placed).length
    if (placed) expect(pads(back.project)).toEqual(pads(project))
    expect(netlist(back.project).map((n) => n.pins)).toEqual(netlist(project).map((n) => n.pins).filter((_, i, all) => all[i]))
  })

  it("writes values where tscircuit looks for them", () => {
    const { elements } = projectToCircuitJson(EXAMPLES.find((e) => e.id === "blinker")!.project)
    const resistor = elements.find((e) => e.type === "source_component" && "ftype" in e && e.ftype === "simple_resistor")
    expect(resistor).toMatchObject({ resistance: expect.any(Number), display_resistance: expect.stringMatching(/Ω$/), name: expect.stringMatching(/^R\d+$/) })
    const cap = elements.find((e) => e.type === "source_component" && "ftype" in e && e.ftype === "simple_capacitor")
    if (cap) expect(cap).toMatchObject({ capacitance: expect.any(Number) })
    expect(elements.find((e) => e.type === "source_component" && "ftype" in e && e.ftype === "simple_led")).toBeTruthy()
  })

  it("carries resistance as ohms, capacitance as farads and the part number as the manufacturer's", () => {
    let p = createProject("Values")
    p = addComponent(p, "resistor", { props: { resistance: "4k7" }, pcb: { x: 0, y: 0, placed: true } }).project
    p = addComponent(p, "capacitor", { props: { capacitance: "100nF", voltage: "50V" }, pcb: { x: 5, y: 0, placed: true } }).project
    p = addComponent(p, "ne555", { pcb: { x: 10, y: 0, placed: true } }).project
    const { elements } = projectToCircuitJson(p)
    expect(elements.find((e) => e.type === "source_component" && "resistance" in e)).toMatchObject({ resistance: 4700, display_resistance: "4k7Ω" })
    expect(elements.find((e) => e.type === "source_component" && "capacitance" in e)).toMatchObject({ max_voltage_rating: 50, display_capacitance: "100nF" })
    expect((elements.find((e) => e.type === "source_component" && "capacitance" in e) as { capacitance: number }).capacitance).toBeCloseTo(1e-7, 12)
    expect(elements.find((e) => e.type === "source_component" && e.name === "U1")).toMatchObject({ ftype: "simple_chip", manufacturer_part_number: "NE555" })
  })

  it("writes the file as JSON text and says what stays behind", () => {
    const project = EXAMPLES.find((e) => e.id === "esp32-robot")!.project
    const { text, notes } = circuitJsonFile(project)
    expect(Array.isArray(JSON.parse(text))).toBe(true)
    expect(notes.join(" ")).toMatch(/pour/)
    expect(notes.every((n) => !n.includes("—"))).toBe(true)
    expect(notes.join(" ")).not.toMatch(/drawings/)
    const drawn = { ...project, drawings: [{ id: "d1", type: "text" as const, x: 0, y: 0, text: "Note", size: 0.14 }] }
    expect(circuitJsonFile(drawn).notes.join(" ")).toMatch(/drawings \(texts, lines and shapes\) are left out/)
  })

  it("exports a board with slots, polygon pads and project land patterns as the pads they are", () => {
    const source = readFileSync(new URL("./fixtures/project-v1/imported.json", import.meta.url), "utf8")
    const project = parseProjectFile(JSON.parse(source).file, origin)
    expect(project.footprints?.length).toBeGreaterThan(0)
    expectRoundTrip(project)
  })
})

// A seeded generator, so a failure names a seed that reproduces it.
function prng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const physical = PARTS.filter((p) => isPhysical(p) && p.footprints.length > 0)

function randomProject(seed: number): Project {
  const rand = prng(seed)
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  let p = createProject(`Random ${seed}`)
  const count = 3 + Math.floor(rand() * 6)
  const refs: { id: string; pins: string[] }[] = []
  for (let i = 0; i < count; i++) {
    const part = pick(physical)
    const added = addComponent(p, part.id, {
      sch: { x: (i % 4) * 8, y: -Math.floor(i / 4) * 8, rot: pick([0, 90, 180, 270]) as Rotation },
      footprint: pick(part.footprints),
      pcb: { x: (rand() - 0.5) * 40, y: (rand() - 0.5) * 30, rot: pick([0, 90, 180, 270]) as Rotation, side: rand() < 0.3 ? "bottom" : "top", placed: true },
    })
    p = added.project
    refs.push({ id: added.component.id, pins: part.pins.map((x) => x.number) })
  }
  const nets = 2 + Math.floor(rand() * 4)
  for (let n = 0; n < nets; n++) {
    for (let k = 0; k < 2 + Math.floor(rand() * 2); k++) {
      const c = pick(refs)
      p = labelPin(p, { componentId: c.id, pin: pick(c.pins) }, `N${n}`)
    }
  }
  if (rand() < 0.7) {
    const c = p.components[0]
    const at = pcbPads(c)[0]
    if (at) p = addTrace(p, { layer: "top", width: 0.25, points: [{ x: at.x, y: at.y }, { x: at.x + 3, y: at.y }, { x: at.x + 3, y: at.y + 2 }] }).project
  }
  if (rand() < 0.5) p = addVia(p, { x: (rand() - 0.5) * 20, y: (rand() - 0.5) * 20 }).project
  if (rand() < 0.5) p = { ...p, board: { ...p.board, cornerRadius: pick([0, 1, 2.5]), mountingHoles: rand() < 0.5 ? { drill: 3.2, diameter: 6, inset: 3.5 } : null } }
  return p
}

describe("round trip", () => {
  it.each(Array.from({ length: 30 }, (_, i) => i + 1))("keeps the netlist and every pad of random board %i", (seed) => {
    expectRoundTrip(randomProject(seed))
  })
})
