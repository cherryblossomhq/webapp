import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { addComponent, createProject } from "../src/model/ops"
import {
  migrateProjectFile,
  parseProjectFile,
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_VERSION,
  ProjectFileError,
  serializeProject,
  summarizeProject,
} from "../src/model/projectFile"
import type { Project } from "../src/model/types"

const origin = { id: "p1", createdAt: 1_000, updatedAt: 2_000 }

const problem = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof ProjectFileError) return e.problem
    throw e
  }
  throw new Error("expected a ProjectFileError")
}

describe("the project file", () => {
  it("is an envelope with a format, a version and the design, and nothing about where it is kept", () => {
    const project = addComponent(createProject("Blinker", "An LED"), "resistor").project
    const file = JSON.parse(serializeProject(project))
    expect(Object.keys(file)).toEqual(["format", "version", "project"])
    expect(file.format).toBe(PROJECT_FILE_FORMAT)
    expect(file.version).toBe(PROJECT_FILE_VERSION)
    expect(file.project.name).toBe("Blinker")
    expect(file.project).not.toHaveProperty("id")
    expect(file.project).not.toHaveProperty("createdAt")
    expect(file.project).not.toHaveProperty("updatedAt")
  })

  it("reads back what it writes, with the identity of where it was stored", () => {
    const project = addComponent(createProject("Blinker"), "resistor").project
    const read = parseProjectFile(serializeProject(project), origin)
    expect(read).toEqual({ ...project, ...origin, properties: undefined, parts: undefined })
  })

  it.each(EXAMPLES.map((e) => [e.id, e] as const))("round-trips the %s example unchanged", (_id, example) => {
    const project = { ...example.project, id: "x", createdAt: 1, updatedAt: 2 }
    expect(serializeProject(parseProjectFile(serializeProject(project), project))).toBe(serializeProject(project))
  })

  it("reads a bare project from before the envelope as version 0", () => {
    const bare = { ...addComponent(createProject("Old"), "resistor").project, id: "p_old", createdAt: 5, updatedAt: 6 }
    const read = parseProjectFile(JSON.stringify(bare), origin)
    expect(read.name).toBe("Old")
    expect(read.components).toHaveLength(1)
    // The container's identity wins over what the old file carried.
    expect(read.id).toBe("p1")
    expect(read.createdAt).toBe(1_000)
    expect(migrateProjectFile(bare)).not.toHaveProperty("id")
  })

  it("keeps fields it doesn't know through a read and a write", () => {
    const file = JSON.parse(serializeProject(createProject("Kept")))
    file.project.futureField = { a: 1 }
    const again = JSON.parse(serializeProject(parseProjectFile(file, origin)))
    expect(again.project.futureField).toEqual({ a: 1 })
  })

  it("refuses a file from a newer editor rather than dropping what it can't read", () => {
    const file = JSON.parse(serializeProject(createProject()))
    file.version = PROJECT_FILE_VERSION + 1
    expect(problem(() => parseProjectFile(file, origin))).toBe("too_new")
  })

  it("refuses what isn't a project file", () => {
    expect(problem(() => parseProjectFile("{nope", origin))).toBe("not_json")
    expect(problem(() => parseProjectFile({ hello: "world" }, origin))).toBe("not_a_project")
    expect(problem(() => parseProjectFile({ format: "something.else", version: 1, project: {} }, origin))).toBe("not_a_project")
    expect(problem(() => parseProjectFile({ format: PROJECT_FILE_FORMAT, version: "1", project: {} }, origin))).toBe("not_a_project")
    expect(problem(() => parseProjectFile([], origin))).toBe("not_a_project")
  })

  it("repairs a sparse document instead of refusing it", () => {
    const read = parseProjectFile({ format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, project: { name: "  " } }, origin)
    expect(read.name).toBe("Untitled project")
    expect(read.components).toEqual([])
    expect(read.board.width).toBeGreaterThan(0)
  })

  it("summarises a project for a list, without its power and ground ports", () => {
    let project = addComponent(createProject("S", "d"), "resistor").project
    project = addComponent(project, "ground").project
    expect(summarizeProject(project)).toEqual({ name: "S", description: "d", componentCount: 1 })
  })
})

/** Each net as the pins on it ("R1.2"), with its name when a label or port gives one. */
function netlist(project: Project) {
  registerProjectParts(project)
  const conn = computeConnectivity(project)
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const pins = new Map<string, string[]>()
  for (const [key, net] of conn.pinNet) {
    const i = key.lastIndexOf(":")
    pins.set(net, [...(pins.get(net) ?? []), `${refOf.get(key.slice(0, i))}.${key.slice(i + 1)}`])
  }
  const named = new Map(conn.nets.map((n) => [n.id, n.named ? n.name : ""]))
  const nets = [...pins]
    .map(([id, on]) => ({ name: named.get(id) ?? "", pins: on.sort() }))
    .filter((n) => n.pins.length > 1 || n.name)
    .sort((a, b) => a.pins[0].localeCompare(b.pins[0]))
  return { nets, floating: conn.unconnectedPins.map((p) => `${refOf.get(p.componentId)}.${p.pin}`).sort() }
}

const v1 = (project: Partial<Project>) => ({
  format: PROJECT_FILE_FORMAT,
  version: 1,
  project: { name: "v1", description: "", labels: [], wires: [], ...project },
})
const resistor = { id: "r", partId: "resistor", ref: "R1", props: {}, sch: { x: 0, y: 0, rot: 0 } }

describe("version 1, before the discrete symbols were drawn at KiCad's proportions", () => {
  // Written by the editor as it was then, each with the netlist it had: a sheet of every discrete
  // symbol at every turn, touching pins, shared points and project parts; a tscircuit board as
  // imported; and the 555 example.
  it.each(["sheet", "imported", "blinker"])("keeps every connection of the %s", (name) => {
    const { file, expected } = JSON.parse(readFileSync(new URL(`./fixtures/project-v1/${name}.json`, import.meta.url), "utf8"))
    expect(file.version).toBe(1)
    expect(netlist(parseProjectFile(file, origin))).toEqual(expected)
  })

  it("lengthens the wire a pin ended and moves the label on a pin with it", () => {
    const read = parseProjectFile(
      v1({
        components: [resistor] as Project["components"],
        wires: [{ id: "w", points: [{ x: 1.5, y: 0 }, { x: 0.5, y: 0 }] }],
        labels: [{ id: "l", name: "IN", x: -0.5, y: 0, rot: 180 }],
      }),
      origin,
    )
    expect(read.wires).toEqual([{ id: "w", points: [{ x: 1.5, y: 0 }, { x: 0.5, y: 0 }, { x: 0.3, y: 0 }] }])
    expect(read.labels[0]).toMatchObject({ x: -0.3, y: 0 })
  })

  it("leaves a pin unconnected rather than short it to a wire drawn across the part", () => {
    // The pin's new place, 0.3, is on the wire named B; reaching it from A's wire would join them.
    const read = parseProjectFile(
      v1({
        components: [resistor] as Project["components"],
        wires: [
          { id: "a", points: [{ x: 1, y: 0 }, { x: 0.5, y: 0 }] },
          { id: "b", points: [{ x: 0.3, y: 1 }, { x: 0.3, y: -1 }] },
        ],
        labels: [
          { id: "la", name: "A", x: 1, y: 0, rot: 0 },
          { id: "lb", name: "B", x: 0.3, y: 1, rot: 90 },
        ],
      }),
      origin,
    )
    expect(computeConnectivity(read).conflicts).toEqual([])
    expect(netlist(read).floating).toContain("R1.2")
    expect(read.wires.find((w) => w.id === "a")!.points).toHaveLength(2)
  })
  it("keeps a wire that met another one at a pin on the pin's net", () => {
    // The wire ending at the pin made a T with the one running through it; lengthening it would
    // move its end off that wire, and a label there tied the pin to it the same way.
    const read = parseProjectFile(
      v1({
        components: [resistor] as Project["components"],
        wires: [
          { id: "a", points: [{ x: 1.5, y: 0 }, { x: 0.5, y: 0 }] },
          { id: "b", points: [{ x: 0.5, y: 1 }, { x: 0.5, y: -1 }] },
          { id: "c", points: [{ x: -0.5, y: 1 }, { x: -0.5, y: -1 }] },
        ],
        labels: [
          { id: "la", name: "A", x: 1.5, y: 0, rot: 0 },
          { id: "lc", name: "C", x: -0.5, y: 0, rot: 180 },
        ],
      }),
      origin,
    )
    const conn = computeConnectivity(read)
    expect(conn.wireNet.get("b")).toBe(conn.pinNet.get("r:2"))
    expect(conn.wireNet.get("c")).toBe(conn.pinNet.get("r:1"))
  })
  it("reconnects a pin that touched the common of a slide switch", () => {
    // R1's pin 2 sat on SW1's common, which didn't move, with no wire between them.
    const read = parseProjectFile(
      v1({
        components: [
          resistor,
          { id: "s", partId: "slide_switch", ref: "SW1", props: {}, sch: { x: 0.9, y: 0, rot: 0 } },
        ] as Project["components"],
      }),
      origin,
    )
    const conn = computeConnectivity(read)
    expect(conn.pinNet.get("r:2")).toBeDefined()
    expect(conn.pinNet.get("r:2")).toBe(conn.pinNet.get("s:2"))
  })
  it("doesn't join touching pins to a wire that only ran past them", () => {
    // R1 and R2 touched at 0.5, where B crossed without meeting them; a short wire from there would.
    const read = parseProjectFile(
      v1({
        components: [resistor, { ...resistor, id: "r2", ref: "R2", sch: { x: 1, y: 0, rot: 0 } }] as Project["components"],
        wires: [{ id: "b", points: [{ x: 0.5, y: 1 }, { x: 0.5, y: -1 }] }],
        labels: [{ id: "lb", name: "B", x: 0.5, y: 1, rot: 90 }],
      }),
      origin,
    )
    const conn = computeConnectivity(read)
    expect(conn.pinNet.get("r:2")).not.toBe(conn.wireNet.get("b"))
    expect(conn.pinNet.get("r2:1")).not.toBe(conn.wireNet.get("b"))
  })
})

/** A project as version 2 wrote it: traces and vias with no net of their own, parts with no flags. */
const v2 = {
  format: PROJECT_FILE_FORMAT,
  version: 2,
  project: {
    name: "v2",
    description: "",
    components: [
      { id: "r", partId: "resistor", ref: "R1", props: { resistance: "10k" }, footprint: "0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 5, y: -5, rot: 90, side: "top", placed: true, locked: true } },
    ],
    wires: [],
    labels: [{ id: "l", name: "IN", x: -0.5, y: 0, rot: 180 }],
    traces: [{ id: "t", layer: "top", width: 0.25, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], locked: true }],
    vias: [{ id: "v", x: 1, y: 0, diameter: 0.8, drill: 0.4 }, { id: "s", x: 2, y: 0, diameter: 0.8, drill: 0.4, net: "GND" }],
    zones: [{ id: "z", net: "GND", layer: "top" }],
    texts: [],
    board: { width: 30, height: 20, x: 0, y: 0, thickness: 1.6, cornerRadius: 1 },
  },
}

describe("version 2, before footprint flags and the nets of tracks and vias", () => {
  it("is read as it was written: no flags, no net on a trace, a stitching via still a stitching via", () => {
    const read = parseProjectFile(v2, origin)
    expect(read.components[0]).not.toHaveProperty("flags")
    expect(read.traces).toEqual(v2.project.traces)
    expect(read.vias).toEqual(v2.project.vias)
    expect(read.vias[1].net).toBe("GND")
    expect(read.vias[1].routedNet).toBeUndefined()
    expect(read.components[0].pcb).toEqual(v2.project.components[0].pcb)
  })
  it("migrates to the current version unchanged, and is saved as version 3", () => {
    const migrated = migrateProjectFile(v2)
    expect(migrated).toEqual(v2.project)
    expect(JSON.parse(serializeProject(parseProjectFile(v2, origin))).version).toBe(3)
    expect(PROJECT_FILE_VERSION).toBe(3)
  })
  it("a reader of version 2 would refuse a version 3 file: the bump is what keeps a flag from being lost", () => {
    const written = JSON.parse(serializeProject(parseProjectFile(v2, origin)))
    expect(written.version).toBeGreaterThan(2)
  })
  it("a version 3 document with flags and nets round-trips", () => {
    const doc = JSON.parse(JSON.stringify(v2))
    doc.version = 3
    doc.project.components[0].flags = { mount: "smd", dnp: true, netTies: [["1", "2"]] }
    doc.project.traces[0].net = "IN"
    doc.project.vias[0].routedNet = "IN"
    const read = parseProjectFile(doc, origin)
    expect(read.components[0].flags).toEqual({ mount: "smd", dnp: true, netTies: [["1", "2"]] })
    expect(read.traces[0].net).toBe("IN")
    expect(read.vias[0].routedNet).toBe("IN")
    expect(JSON.parse(serializeProject(read)).project.components[0].flags).toEqual(read.components[0].flags)
  })
})
