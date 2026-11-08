import { imp } from "./kicad-sheets-fixtures"
import { readFileSync } from "node:fs"
import { drawingBounds } from "../src/model/drawings"
import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { customPartId, customPartProblems, registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { schematicPins } from "../src/model/instances"
import RETIRED from "../src/model/migrations/libraryParts.json"
import { fileModel, setModel } from "../src/model/models3d"
import { addComponent, connectPins, createProject, resolvePinSpec } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { DEFAULT_PAPER, holds, paperOf, sheetDrawingBox } from "../src/model/paper"
import { sheetUses, sheetView } from "../src/model/sheets"
import {
  migrateProjectFile,
  parseProjectFile,
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_VERSION,
  ProjectFileError,
  projectFileWriter,
  serializeProject,
  summarizeProject,
} from "../src/model/projectFile"
import type { CustomPartSpec, Project } from "../src/model/types"

const origin = { id: "p1", createdAt: 1_000, updatedAt: 2_000 }

/** A document with its sheets' pages left out: what the steps before version 6 are compared on (version 6 gives every sheet a page fitted to its drawing). */
const pageless = <T extends { sheets?: unknown }>(doc: T): T => {
  if (!Array.isArray(doc.sheets)) return doc
  return { ...doc, sheets: doc.sheets.map(({ paper: _paper, ...sheet }: Record<string, unknown>) => sheet) }
}

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

  it.each([7, 14, 15])("refuses a file at version %i from a newer editor rather than dropping what it can't read", (version) => {
    const file = JSON.parse(serializeProject(createProject()))
    file.version = version
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

describe("the workers' project file, written again only where an edit changed it", () => {
  it("is serializeProject's, character for character, through edits that change one value and keep the rest", () => {
    const write = projectFileWriter()
    for (const { project } of EXAMPLES) {
      // A zone with KiCad's kept fill (written compactly) and a part with units, so every stored form is in it.
      const ring = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]
      const kept: Project = { ...project, zones: project.zones.map((z) => ({ ...z, kept: { layers: [{ layer: "top" as const, rings: [ring] }], sig: "" } })) }
      const steps: Project[] = [
        kept,
        { ...kept, traces: kept.traces.map((t, i) => (i === 0 ? { ...t, width: t.width + 0.1 } : t)) },
        { ...kept, name: `${kept.name} again`, vias: [] },
        { ...kept, zones: [] },
        { ...kept, kicad: undefined },
      ]
      for (const p of steps) expect(write(p)).toBe(serializeProject(p))
    }
  })
})

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
  it("migrates to the current version unchanged, and is saved as the current version", () => {
    const migrated = migrateProjectFile(v2)
    expect(pageless(migrated)).toEqual({ ...v2.project, sheets: [{ id: "root" }] })
    expect(JSON.parse(serializeProject(parseProjectFile(v2, origin))).version).toBe(PROJECT_FILE_VERSION)
    expect(PROJECT_FILE_VERSION).toBe(6)
  })
  it("a reader of version 2 would refuse a newer file: the bump is what keeps a flag from being lost", () => {
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

/** A version 3 project with flags and nets on tracks and no drawings. */
const v3 = {
  format: PROJECT_FILE_FORMAT,
  version: 3,
  project: {
    ...v2.project,
    name: "v3",
    components: [{ ...v2.project.components[0], flags: { mount: "smd", dnp: true, netTies: [["1", "2"]] } }],
    traces: [{ id: "t", layer: "top", width: 0.25, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], net: "IN" }],
  },
}

describe("a version 3 file from the board track, with no drawings", () => {
  it("opens as it was written, with no drawings, and is saved as the current version", () => {
    const read = parseProjectFile(v3, origin)
    // a version 3 file is read as is: it has no `sheets`, which is the same project as a root sheet alone, which version 6 lists with its page
    expect(pageless(migrateProjectFile(v3))).toEqual({ ...v3.project, sheets: [{ id: "root" }] })
    expect(read.components[0].flags).toEqual({ mount: "smd", dnp: true, netTies: [["1", "2"]] })
    expect(read.traces).toEqual(v3.project.traces)
    expect(read.graphics).toBeUndefined()
    expect(read.footprints).toBeUndefined()
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
    expect(JSON.parse(serializeProject(read)).project).not.toHaveProperty("graphics")
  })
})

const P = (x: number, y: number) => ({ x, y })
/** One of every kind of drawing, with every optional field set. */
const everyShape = () => [
  { type: "line", a: P(0, 0), b: P(1, 2), layer: "F.SilkS", width: 0.12, dash: "dash", locked: true },
  { type: "arc", start: P(0, 0), mid: P(1, 1), end: P(2, 0), layer: "B.SilkS", width: 0.2, dash: "dot" },
  { type: "circle", c: P(3, 3), r: 1.5, layer: "F.Fab", width: 0.1, fill: true },
  { type: "rect", a: P(-1, -1), b: P(1, 1), radius: 0.3, layer: "F.CrtYd", width: 0.05, fill: true, dash: "dash_dot" },
  {
    type: "polygon",
    pts: [P(0, 0), { ...P(4, 0), mid: P(2, -1) }, P(4, 4), P(0, 4)],
    holes: [[P(1, 1), P(2, 1), P(2, 2)]],
    layer: "F.Cu",
    width: 0,
    fill: true,
    net: "GND",
  },
  { type: "curve", p0: P(0, 0), c1: P(1, 3), c2: P(3, -3), p1: P(4, 0), layer: "Dwgs.User", width: 0.15, dash: "dash_dot_dot" },
  { type: "ellipse", c: P(0, 0), rx: 2, ry: 1, rot: 30, layer: "User.7", width: 0.1, fill: true },
  { type: "ellipse", c: P(0, 0), rx: 2, ry: 1, rot: 30, from: 10, to: 200, layer: "B.Cu", width: 0.1, net: "VCC" },
]

const pad1 = { pin: "1", shape: "rect", layer: "top", x: 0, y: 0, width: 1, height: 1 }
const land = (name: string, pads: unknown[], shapes?: unknown[]) => ({ name, pads, silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, ...(shapes ? { shapes } : {}) })
const drawn = (project: Record<string, unknown>) => ({ format: PROJECT_FILE_FORMAT, version: 3, project: { name: "drawn", description: "", components: [], wires: [], labels: [], ...project } as Record<string, unknown> })

describe("version 3, board and footprint drawings", () => {
  it("round-trips one of every shape on the board and in a land with every field kept", () => {
    const shapes = everyShape()
    const doc = drawn({
      graphics: shapes.map((s, i) => ({ ...s, id: `g${i}` })),
      footprints: [land("PADLESS", [], shapes), land("MIXED", [pad1], shapes)],
    })
    const read = parseProjectFile(doc, origin)
    expect(read.graphics).toEqual(doc.project.graphics)
    expect(read.footprints![0].shapes).toEqual(shapes)
    expect(read.footprints![1].shapes).toEqual(shapes)
    const again = parseProjectFile(serializeProject(read), origin)
    expect(again.graphics).toEqual(doc.project.graphics)
    expect(again.footprints).toEqual(read.footprints)
    expect(serializeProject(again)).toBe(serializeProject(read))
  })

  it("drops a damaged drawing and nothing else", () => {
    const good = { type: "line", a: P(0, 0), b: P(1, 0), layer: "F.SilkS", width: 0.1 }
    const doc = drawn({
      graphics: [
        { ...good, id: "ok" },
        { ...good, id: "layer", layer: "Nope.Layer" },
        { ...good, id: "edge", layer: "Edge.Cuts" },
        { ...good, id: "neg", width: -0.1 },
        { type: "line", a: P(0, 0), id: "point", layer: "F.SilkS", width: 0.1 },
        { ...good, id: "ok" },
        { ...good, id: "" },
        { ...good, layer: "F.Fab", id: "ok2" },
      ],
      footprints: [land("L", [pad1], [good, { ...good, layer: "bad" }, { ...good, width: -1 }, { type: "circle", c: P(0, 0), layer: "F.SilkS", width: 0.1 }, { ...good, layer: "F.Fab" }])],
    })
    const read = parseProjectFile(doc, origin)
    expect(read.graphics!.map((g) => g.id)).toEqual(["ok", "ok2"])
    expect(read.footprints![0].shapes).toEqual([good, { ...good, layer: "F.Fab" }])
    expect(read.footprints![0].pads).toEqual([pad1])
  })

  it("drops a flag that does not fit: a fill on an open shape, a dash that is not one", () => {
    const read = parseProjectFile(drawn({ graphics: [{ type: "line", a: P(0, 0), b: P(1, 0), layer: "F.SilkS", width: 0.1, fill: true, dash: "wavy", net: " " }].map((s) => ({ ...s, id: "g" })) }), origin)
    expect(read.graphics).toEqual([{ type: "line", a: P(0, 0), b: P(1, 0), layer: "F.SilkS", width: 0.1, id: "g" }])
  })

  it("keeps every valid land with no pads, with drawings, with none, or with drawings that were all damaged: its parts have text, and it has a courtyard", () => {
    const line = { type: "line", a: P(0, 0), b: P(1, 0), layer: "F.SilkS", width: 0.1 }
    const read = parseProjectFile(drawn({ footprints: [land("LOGO", [], [line]), land("EMPTY", []), land("ALLBAD", [], [{ ...line, layer: "x" }])] }), origin)
    expect(read.footprints!.map((f) => f.name)).toEqual(["LOGO", "EMPTY", "ALLBAD"])
    expect(read.footprints![0].shapes).toEqual([line])
    // what is damaged is not drawn wrong, and what is left of a land is still the land
    expect(read.footprints![2].shapes).toBeUndefined()
    // a land with no pad stays whole through a save and a load
    const again = parseProjectFile(serializeProject(read), origin)
    expect(again.footprints!.map((f) => f.name)).toEqual(["LOGO", "EMPTY", "ALLBAD"])
  })

  it("a project with no drawings writes none", () => {
    const written = JSON.parse(serializeProject(parseProjectFile(drawn({ footprints: [land("L", [pad1])] }), origin)))
    expect(written.project).not.toHaveProperty("graphics")
    expect(written.project.footprints[0]).not.toHaveProperty("shapes")
  })
})

describe("version 2, before symbols had units, mirrors, fields of their own and drawings kept in the project", () => {
  // Every shipped example, written as a version 2 file: what an account or a disk holds from before.
  const asV2 = (p: Project) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...doc } = p
    return JSON.parse(JSON.stringify({ format: PROJECT_FILE_FORMAT, version: 2, project: doc }))
  }

  it("reads as the same project, with none of what version 3 adds, and is written as the current version", () => {
    for (const ex of EXAMPLES) {
      const file = asV2(ex.project)
      const read = parseProjectFile(file, origin)
      expect(read.components.map((c) => [c.id, c.partId, c.ref, c.sch, c.unit, c.bodyStyle, c.fields, c.pinAlt])).toEqual(ex.project.components.map((c) => [c.id, c.partId, c.ref, c.sch, undefined, undefined, undefined, undefined]))
      expect(read.symbols).toBeUndefined()
      expect(read.wires).toEqual(ex.project.wires)
      expect(read.labels).toEqual(ex.project.labels)
      // nor what slice 3b-ii adds to the same step: the nets are named by the editor's rule, nothing else is on the sheet, no part has flags
      expect(read.netNames).toBeUndefined()
      expect(read.drawings).toBeUndefined()
      expect(read.components.some((c) => c.flags)).toBe(false)
      expect(read.blocks?.some((b) => b.locked) ?? false).toBe(false)
      expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
      // and reading what was written changes nothing
      expect(computeConnectivity(parseProjectFile(serializeProject(read), origin)).nets.map((n) => [n.name, n.pins.length])).toEqual(computeConnectivity(read).nets.map((n) => [n.name, n.pins.length]))
    }
  })

  it("is not refused, and a newer file is: a reader of this version does not guess at a newer one", () => {
    expect(() => migrateProjectFile({ format: PROJECT_FILE_FORMAT, version: 2, project: { name: "x", components: [] } })).not.toThrow()
    expect(problem(() => parseProjectFile({ format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION + 1, project: {} }, origin))).toBe("too_new")
  })
})

describe("version 3 with what slice 3b-ii adds: label kinds and shapes, KiCad's net names, drawings of the sheet, flags, wire looks, locked groups", () => {
  it("reads back what it writes, and drops what is malformed rather than failing", () => {
    const ex = EXAMPLES[0].project
    const c0 = ex.components[0]
    const project: Project = {
      ...ex,
      netNames: "kicad",
      components: [{ ...c0, fieldsAutoplaced: true, flags: { dnp: true, excludeFromBom: true } }, ...ex.components.slice(1)],
      wires: [{ ...ex.wires[0], look: { width: 0.04, dash: "dash", color: "#ff0000" } }, ...ex.wires.slice(1)],
      labels: [{ id: "l1", name: "A", x: 1, y: 1, rot: 0, kind: "global", shape: "input", look: { size: 0.12, bold: true } }],
      drawings: [
        { id: "n1", type: "text", text: "hi", x: 0, y: 0, size: 0.1, align: "center", valign: "middle", rot: 90, italic: true },
        { id: "n2", type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], stroke: {} },
        { id: "n3", type: "rect", x: 0, y: 0, width: 2, height: 1, stroke: { width: 0.02, dash: "dash", color: "#112233" }, paint: { kind: "background" } },
        { id: "n4", type: "junction", x: 3, y: 3, dotColor: "#00ff00" },
      ],
      blocks: [{ id: "b1", name: "G", components: [c0.id], locked: true }],
    }
    const read = parseProjectFile(serializeProject(project), origin)
    expect(read.netNames).toBe("kicad")
    expect(read.components[0].flags).toEqual({ dnp: true, excludeFromBom: true })
    expect(read.components[0].fieldsAutoplaced).toBe(true)
    expect(read.wires[0].look).toEqual({ width: 0.04, dash: "dash", color: "#ff0000" })
    expect(read.labels[0]).toMatchObject({ kind: "global", shape: "input", look: { size: 0.12, bold: true } })
    expect(read.drawings).toEqual(project.drawings)
    expect(read.blocks?.[0].locked).toBe(true)
    const damaged = parseProjectFile(
      {
        format: PROJECT_FILE_FORMAT,
        version: 3,
        project: { ...JSON.parse(serializeProject(project)).project, netNames: "other", drawings: [{ id: "x", type: "text" }, { id: "y", type: "rect", x: 1, y: 2 }, { id: "z", type: "circle", x: 1 }], labels: [{ id: "l", name: "A", x: 1, y: 1, rot: 45, kind: "weird", shape: "bad" }] },
      },
      origin,
    )
    expect(damaged.netNames).toBeUndefined()
    expect(damaged.drawings).toBeUndefined()
    expect(damaged.labels[0]).toMatchObject({ rot: 0 })
    expect(damaged.labels[0].kind).toBeUndefined()
  })
})

// What the schematic track's development build wrote: the flags as `inBom: false` and the rest, and `items` with a `kind`.
const devFile = (version: number) => ({
  format: PROJECT_FILE_FORMAT,
  version,
  project: {
    name: "dev",
    description: "",
    components: [
      { id: "r", partId: "resistor", ref: "R1", props: { resistance: "10k" }, footprint: "0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 5, y: -5, rot: 0, side: "top", placed: true }, flags: { dnp: true, inBom: false, onBoard: false, inPosFiles: false, excludeFromSim: true, fieldsAutoplaced: true } },
      { id: "c", partId: "capacitor", ref: "C1", props: { capacitance: "100nF" }, footprint: "0603", sch: { x: 2, y: 0, rot: 0 }, pcb: { x: 8, y: -5, rot: 0, side: "top", placed: true } },
    ],
    wires: [],
    labels: [],
    items: [
      { id: "n1", kind: "text", text: "Note", x: 1, y: 2, rot: 90, look: { size: 0.12, bold: true, h: "left", color: "#ff0000", thickness: 0.01 }, excludeFromSim: true },
      { id: "n2", kind: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], stroke: { width: 0.03 }, fill: { kind: "outline" } },
      { id: "n3", kind: "rectangle", a: { x: 3, y: 4 }, b: { x: 1, y: 1 }, radius: 0.1 },
      { id: "n4", kind: "circle", c: { x: 5, y: 5 }, r: 0.5 },
      { id: "n5", kind: "junction", x: 2, y: 2, diameter: 0.1, color: "#00ff00" },
    ],
    drawings: [{ id: "d1", type: "text", x: 0, y: 0, text: "Mine", size: 0.14 }],
  },
})

describe("the schematic track's own saved shape, read at version 2", () => {
  it("is migrated from 2: flags in the one set, fields autoplaced on the part, items as drawings after the drawings already there", () => {
    const read = parseProjectFile(devFile(2), origin)
    const r1 = read.components.find((c) => c.ref === "R1")!
    expect(r1.flags).toEqual({ dnp: true, excludeFromBom: true, notOnBoard: true, excludeFromPos: true, excludeFromSim: true })
    expect(r1.fieldsAutoplaced).toBe(true)
    expect(read.components.find((c) => c.ref === "C1")).not.toHaveProperty("flags")
    expect(read).not.toHaveProperty("items")
    expect(read.drawings?.map((d) => [d.id, d.type])).toEqual([["d1", "text"], ["n1", "text"], ["n2", "line"], ["n3", "rect"], ["n4", "circle"], ["n5", "junction"]])
    // the drawing the tools made is as it was
    expect(read.drawings![0]).toEqual({ id: "d1", type: "text", x: 0, y: 0, text: "Mine", size: 0.14 })
    // a text says its justification and look as the drawing's own fields
    expect(read.drawings![1]).toMatchObject({ x: 1, y: 2, text: "Note", size: 0.12, bold: true, align: "left", valign: "middle", rot: 90, excludeFromSim: true, stroke: { color: "#ff0000", width: 0.01 } })
    // a polyline is a line with its stroke and fill, a rectangle a box by its lower-left corner, a circle has its centre as x and y, a dot's colour is dotColor
    expect(read.drawings![2]).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], stroke: { width: 0.03 }, paint: { kind: "outline" } })
    expect(read.drawings![3]).toMatchObject({ x: 1, y: 1, width: 2, height: 3, radius: 0.1, stroke: {} })
    expect(read.drawings![4]).toMatchObject({ x: 5, y: 5, radius: 0.5 })
    expect(read.drawings![5]).toMatchObject({ x: 2, y: 2, diameter: 0.1, dotColor: "#00ff00" })
    // saved, it is the current version in the current shape, and reading that back changes nothing
    const written = JSON.parse(serializeProject(read))
    expect(written.version).toBe(PROJECT_FILE_VERSION)
    expect(written.project).not.toHaveProperty("items")
    expect(parseProjectFile(written, origin).drawings).toEqual(read.drawings)
  })

  it("a rectangle with no width or no height that KiCad drew survives the step and a save and a load; a tool's does not exist", () => {
    const doc = devFile(2)
    doc.project.items.push({ id: "z1", kind: "rectangle", a: { x: 6, y: 1 }, b: { x: 6, y: 3 } } as never, { id: "z2", kind: "rectangle", a: { x: 7, y: 1 }, b: { x: 9, y: 1 }, stroke: { width: 0.01 } } as never, { id: "z3", kind: "rectangle", a: { x: 8, y: 8 }, b: { x: 8, y: 8 }, fill: { kind: "outline" } } as never)
    doc.project.drawings.push({ id: "t0", type: "rect", x: 0, y: 0, width: 0, height: 2 } as never, { id: "t1", type: "rect", x: 0, y: 0, width: 2, height: 2 } as never)
    const read = parseProjectFile(doc, origin)
    const ids = read.drawings?.map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining(["z1", "z2", "z3", "t1"]))
    expect(ids).not.toContain("t0")
    expect(read.drawings?.find((d) => d.id === "z1")).toMatchObject({ type: "rect", width: 0, height: 2, stroke: {} })
    expect(read.drawings?.find((d) => d.id === "z2")).toMatchObject({ width: 2, height: 0 })
    expect(read.drawings?.find((d) => d.id === "z3")).toMatchObject({ width: 0, height: 0 })
    expect(parseProjectFile(JSON.parse(JSON.stringify(JSON.parse(serializeProject(read)))), origin).drawings).toEqual(read.drawings)
  })

  it("a file of the board track opens untouched by that step, with the drawings of the tools it may carry", () => {
    for (const version of [2]) {
      const doc = JSON.parse(JSON.stringify(v2))
      doc.version = version
      doc.project.components[0].flags = { mount: "smd", dnp: true, netTies: [["1", "2"]] }
      doc.project.drawings = [{ id: "d1", type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], color: "red", arrows: "end" }]
      const read = parseProjectFile(doc, origin)
      expect(read.components[0].flags).toEqual({ mount: "smd", dnp: true, netTies: [["1", "2"]] })
      expect(read.drawings).toEqual(doc.project.drawings)
      expect(migrateProjectFile(doc).drawings).toEqual(doc.project.drawings)
    }
  })

  it("the step reads a symbol's flags and its footprint's together, and the symbol's keep what the footprint's say", () => {
    const doc = devFile(2)
    doc.project.components[0].flags = { inBom: false, mount: "smd", netTies: [["1", "2"]], virtual: true } as never
    const read = parseProjectFile(doc, origin)
    expect(read.components[0].flags).toEqual({ mount: "smd", virtual: true, excludeFromBom: true, netTies: [["1", "2"]] })
  })
})

/** A version 2 project with the editor's own whole-board pours, no polygon zones. */
const v8 = {
  format: PROJECT_FILE_FORMAT,
  version: 2,
  project: {
    ...v2.project,
    name: "v8",
    zones: [{ id: "z", net: "GND", layer: "top" }, { id: "z2", net: "GND", layer: "bottom", clearance: 0.4 }],
  },
}

describe("whole-board pours, before polygon zones, rule areas and zone settings", () => {
  it("opens as it was written and is saved as the current version, the pours untouched", () => {
    expect(pageless(migrateProjectFile(v8))).toEqual({ ...v8.project, sheets: [{ id: "root" }] })
    const read = parseProjectFile(v8, origin)
    expect(read.zones).toEqual(v8.project.zones)
    const written = JSON.parse(serializeProject(read))
    expect(written.version).toBe(PROJECT_FILE_VERSION)
    expect(written.project.zones).toEqual(v8.project.zones)
  })

  it("a version 3 document with pours reads the same way", () => {
    for (const version of [3]) expect(parseProjectFile({ ...v8, version }, origin).zones).toEqual(v8.project.zones)
  })
})

describe("polygon zones", () => {
  const ring = (pts: number[][]) => ({ closed: true, segs: pts.map((a, i) => ({ kind: "line", a: P(a[0], a[1]), b: P(pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]) })) })
  const arcRing = {
    closed: true,
    segs: [
      { kind: "line", a: P(0, 0), b: P(4, 0) },
      { kind: "arc", start: P(4, 0), mid: P(5, 2), end: P(4, 4) },
      { kind: "line", a: P(4, 4), b: P(0, 4) },
      { kind: "line", a: P(0, 4), b: P(0, 0) },
    ],
  }
  const zones = [
    { id: "a", net: "GND", layer: "top", layers: ["top", "bottom"], outline: [ring([[0, 0], [10.123456789, 0], [10, 8], [0, 8]]), ring([[2, 2], [3, 2], [3, 3]])], priority: 2, name: "ground", clearance: 0.5, minWidth: 0.25, connect: "tht", thermalGap: 0.4, spokeWidth: 0.3, smoothing: { kind: "fillet", radius: 1 }, islands: 12.5, edgeGap: 0.6, holeGap: 0.25, locked: true },
    { id: "b", net: "", layer: "bottom", outline: [arcRing], keepout: { tracks: true, pour: true } },
    { id: "c", net: "VCC", layer: "top", outline: [ring([[0, 0], [1, 0], [1, 1]])], teardrop: "padvia", islands: "never", connect: "solid" },
  ]
  it("round-trips every field exactly, a straight ring as bare numbers and an arc ring in the outline form", () => {
    const doc = { ...v8, version: 3, project: { ...v8.project, zones } }
    const read = parseProjectFile(doc, origin)
    expect(read.zones).toEqual(zones)
    const written = JSON.parse(serializeProject(read))
    expect(written.project.zones[0].outline[0].slice(0, 3)).toEqual(["p", 0, 0])
    expect(written.project.zones[1].outline[0][0]).toBe("c")
    expect(written.project.zones[0]).not.toHaveProperty("ol")
    expect(parseProjectFile(serializeProject(read), origin).zones).toEqual(zones)
  })
  it("a polygon of 2,000 corners with millimetre coordinates to a micron is about 16 bytes a corner", () => {
    const pts = Array.from({ length: 2000 }, (_, i) => [Math.round(Math.cos(i / 318) * 40000) / 1000, Math.round(Math.sin(i / 318) * 40000) / 1000])
    const big = { id: "big", net: "GND", layer: "top", outline: [ring(pts)] }
    const text = serializeProject(parseProjectFile({ ...v8, version: 3, project: { ...v8.project, zones: [big] } }, origin))
    expect(text.length).toBeLessThan(2000 * 18 + 4000)
  })
  it("drops a zone with a damaged layer or a rule area with no polygon, and repairs what can be", () => {
    const bad = [
      { id: "x", net: "A", layer: "middle", priority: 1 },
      { id: "y", net: "", layer: "top", keepout: { vias: true } },
      { id: "w", net: "GND", layer: "top", priority: -3, minWidth: -1, connect: "sideways", smoothing: { kind: "round", radius: 1 }, outline: [ring([[0, 0], [1, 0], [1, 1]])] },
    ]
    const read = parseProjectFile({ ...v8, version: 3, project: { ...v8.project, zones: bad.map((z) => (z.outline ? { ...z, ol: [["p", 0, 0, 1, 0, 1, 1]], outline: undefined } : z)) } }, origin)
    expect(read.zones.map((z) => z.id)).toEqual(["w"])
    expect(read.zones[0]).toEqual({ id: "w", net: "GND", layer: "top", outline: [ring([[0, 0], [1, 0], [1, 1]])] })
  })
})

/** A version 2 project with polygon zones (X3) and a land whose pads have none of the pad model's fields (X7). */
const v9 = {
  format: PROJECT_FILE_FORMAT,
  version: 2,
  project: {
    ...v2.project,
    name: "v9",
    zones: [{ id: "z", net: "GND", layer: "top", ol: [["p", 0, 0, 10, 0, 10, 8, 0, 8]], priority: 1, connect: "thermal", thermalGap: 0.4 }],
    footprints: [{ name: "v9-land", silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, pads: [{ pin: "1", shape: "rect", x: -0.5, y: 0, width: 0.6, height: 0.6, layer: "top" }, { pin: "2", shape: "rect", x: 0.5, y: 0, width: 0.6, height: 0.6, layer: "top" }] }],
  },
}

describe("pads before the pad model (X7)", () => {
  it("opens as it was written, zones and pads untouched, and is saved as the current version", () => {
    expect(pageless(migrateProjectFile(v9))).toEqual({ ...v9.project, sheets: [{ id: "root" }] })
    const read = parseProjectFile(v9, origin)
    expect(read.zones).toHaveLength(1)
    expect(read.zones[0]).toMatchObject({ id: "z", net: "GND", priority: 1, connect: "thermal", thermalGap: 0.4 })
    expect(read.footprints?.[0].pads).toEqual(v9.project.footprints[0].pads)
    const written = JSON.parse(serializeProject(read))
    expect(written.version).toBe(PROJECT_FILE_VERSION)
    expect(written.project.footprints[0].pads).toEqual(v9.project.footprints[0].pads)
    expect(parseProjectFile(serializeProject(read), origin).zones).toEqual(read.zones)
  })

  it("a pad's X7 fields and a zone's polygon survive a save and a load together", () => {
    const read = parseProjectFile(v9, origin)
    const withPads = { ...read, footprints: [{ ...read.footprints![0], pads: read.footprints![0].pads.map((p, i) => (i === 0 ? { ...p, zoneConnect: "none" as const, thermalGap: 0.5, thermalWidth: 0.3, clearance: 0.4 } : p)) }] }
    const back = parseProjectFile(serializeProject(withPads), origin)
    expect(back.footprints?.[0].pads[0]).toMatchObject({ zoneConnect: "none", thermalGap: 0.5, thermalWidth: 0.3, clearance: 0.4 })
    expect(back.zones).toEqual(read.zones)
  })
})

// A version 2 document: a schematic of one sheet, as the editor wrote it before sheets (S1).
const v10 = {
  format: "cherryblossom.project",
  version: 2,
  project: {
    name: "v10",
    description: "",
    components: [{ id: "c1", partId: "resistor", ref: "R1", props: { value: "10k" }, footprint: "r_0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 1, y: 2, rot: 0, side: "top", placed: true } }],
    wires: [{ id: "w1", points: [{ x: 0, y: 0.3 }, { x: 1, y: 0.3 }] }],
    labels: [{ id: "l1", name: "SIG", x: 1, y: 0.3, rot: 0 }],
    traces: [],
    vias: [],
    zones: [],
    texts: [],
  },
}

describe("a one-sheet project, before sheets (S1)", () => {
  it("is a project of one sheet: the migration lists the root and changes nothing else, and it is saved as the current version", () => {
    expect(pageless(migrateProjectFile(v10))).toEqual({ ...v10.project, sheets: [{ id: "root" }] })
    const read = parseProjectFile(v10, origin)
    expect(read.sheetSymbols).toBeUndefined()
    expect(read.wires).toEqual(v10.project.wires)
    expect(read.labels).toEqual(v10.project.labels)
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
    expect(computeConnectivity(read).nets.map((n) => n.name)).toEqual(computeConnectivity(parseProjectFile({ ...v10, version: 3, project: v10.project }, origin)).nets.map((n) => n.name))
  })

  it("a project with sheets survives a save and a load, and a file that is newer than this reader is refused", () => {
    const { project } = imp()
    const back = parseProjectFile(serializeProject(project), origin)
    expect(back.sheets).toEqual(project.sheets)
    expect(back.sheetSymbols).toEqual(project.sheetSymbols)
    expect(back.components.map((c) => [c.ref, c.inst])).toEqual(project.components.map((c) => [c.ref, c.inst]))
    expect(back.scope).toBeUndefined()
    expect(problem(() => parseProjectFile({ ...JSON.parse(serializeProject(project)), version: PROJECT_FILE_VERSION + 1 }, origin))).toBe("too_new")
  })
})


// A version 3 document: a schematic as the editor wrote it before variants and KiCad's joining rules (S9, S11).
const v13 = {
  format: PROJECT_FILE_FORMAT,
  version: 3,
  project: {
    name: "v13",
    description: "",
    components: [
      { id: "c1", partId: "resistor", ref: "R1", props: { value: "10k" }, footprint: "0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false }, flags: { dnp: true } },
      { id: "c2", partId: "resistor", ref: "R2", props: { value: "1k" }, footprint: "0603", sch: { x: 2, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false } },
    ],
    wires: [{ id: "w1", points: [{ x: 0, y: 0.3 }, { x: 2, y: 0.3 }] }],
    labels: [],
    sheets: [{ id: "root", page: "2" }],
    traces: [],
    vias: [],
    zones: [],
    texts: [],
    board: { width: 40, height: 30 },
    rules: {},
  },
}

describe("before variants (S9) and KiCad's joining rules (S11)", () => {
  it("is carried across with nothing added, and saved as the current version", () => {
    const migrated = migrateProjectFile(v13)
    expect(pageless(migrated)).toEqual(v13.project)
    const read = parseProjectFile(v13, origin)
    expect(read.variants).toBeUndefined()
    expect(read.components.every((c) => c.variants === undefined)).toBe(true)
    // a page number stored then is read past
    expect(pageless(read).sheets).toEqual([{ id: "root" }])
    const written = JSON.parse(serializeProject(read))
    expect(written.version).toBe(PROJECT_FILE_VERSION)
    expect(written.project).not.toHaveProperty("variants")
    expect(pageless(written.project).sheets).toEqual([{ id: "root" }])
  })

  it("variants, a symbol's changes and a sheet's flag survive a save and a load exactly, and what is malformed is dropped", () => {
    const read = parseProjectFile(v13, origin)
    const project: Project = {
      ...read,
      sheets: [{ id: "root", kicadRules: true }],
      variants: { list: [{ name: "Lite", description: "no sensor" }, { name: "Full" }], active: "Lite" },
      components: read.components.map((c) => (c.ref === "R1" ? { ...c, variants: { Lite: { dnp: false, excludeFromBom: true, fields: { Value: "0R" } }, Full: { notOnBoard: true } } } : c)),
    }
    const back = parseProjectFile(serializeProject(project), origin)
    expect(back.variants).toEqual(project.variants)
    expect(back.components.find((c) => c.ref === "R1")!.variants).toEqual(project.components.find((c) => c.ref === "R1")!.variants)
    expect(back.sheets).toEqual(project.sheets)
    // a stored document with a damaged variant list and overrides: names are kept only when they are text, an active name only when listed, a variant only a symbol names is listed
    const damaged = JSON.parse(serializeProject(project))
    damaged.project.variants = { list: [{ name: "A" }, { name: 3 }, { name: "A" }, null], active: "Nope" }
    damaged.project.components[0].variants = { B: { dnp: "yes", excludeFromBom: true, fields: { X: 1, Y: "y" } }, "": { dnp: true } }
    const fixed = parseProjectFile(damaged, origin)
    expect(fixed.variants).toEqual({ list: [{ name: "A" }, { name: "B" }] })
    expect(fixed.components[0].variants).toEqual({ B: { excludeFromBom: true, fields: { Y: "y" } } })
  })

  it("a file newer than this reader is refused, so it cannot save over one with variants", () => {
    expect(problem(() => parseProjectFile({ ...v13, version: PROJECT_FILE_VERSION + 1 }, origin))).toBe("too_new")
  })
})

// A version 3 document: a schematic with a closed polygon and a net class, as the editor wrote it before directive labels and rule areas (S8).
const v11 = {
  format: "cherryblossom.project",
  version: 3,
  project: {
    name: "v11",
    description: "",
    components: [{ id: "c1", partId: "resistor", ref: "R1", props: { value: "10k" }, footprint: "r_0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 1, y: 2, rot: 0, side: "top", placed: true } }],
    wires: [{ id: "w1", points: [{ x: 0, y: 0.3 }, { x: 1, y: 0.3 }] }],
    labels: [{ id: "l1", name: "SIG", x: 1, y: 0.3, rot: 0 }],
    drawings: [{ id: "d1", type: "line", points: [{ x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }], closed: true, stroke: { dash: "dash" } }],
    rules: { netClasses: [{ name: "Power", nets: ["SIG"], traceWidth: 0.5 }] },
    traces: [],
    vias: [],
    zones: [],
    texts: [],
  },
}

describe("before directive labels and rule areas (S8)", () => {
  it("is read as it is: nothing is filled in, a closed line is not a rule area, and it is saved as the current version", () => {
    expect(pageless(migrateProjectFile(v11))).toEqual({ ...v11.project, sheets: [{ id: "root" }] })
    const read = parseProjectFile(v11, origin)
    expect(read.drawings).toEqual(v11.project.drawings)
    expect(read.rules.netClasses).toEqual([{ name: "Power", nets: ["SIG"], traceWidth: 0.5 }])
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
  })

  it("keeps a directive label, a rule area and the classes a label gives through a save and a load, and refuses a newer file", () => {
    const doc = {
      ...v11,
      project: {
        ...v11.project,
        drawings: [
          ...v11.project.drawings.map((d) => ({ ...d, ruleArea: { dnp: true } })),
          { id: "d2", type: "directive", text: "", x: 0.5, y: 0.3, rot: 90, shape: "diamond", length: 0.2, fields: [{ name: "Netclass", value: "Fast", place: { x: 0.05, y: 0.1, angle: 0, h: "left" } }], fieldsAutoplaced: true },
        ],
        rules: { netClasses: [{ name: "Fast", nets: [], labelNets: ["SIG"], implicit: true }] },
      },
    }
    const read = parseProjectFile(doc, origin)
    expect(read.drawings).toEqual(doc.project.drawings)
    expect(read.rules.netClasses).toEqual(doc.project.rules.netClasses)
    expect(parseProjectFile(serializeProject(read), origin).drawings).toEqual(read.drawings)
    expect(problem(() => parseProjectFile({ ...doc, version: PROJECT_FILE_VERSION + 1 }, origin))).toBe("too_new")
  })
})

describe("version 3 is the whole KiCad import", () => {
  // A project with content in every part the step from 2 touched, with its root sheet listed so every version reads to the same document.
  const rich = (): Project => {
    const p = parseProjectFile(serializeProject(EXAMPLES[0].project), origin)
    return { ...p, sheets: [{ id: "root" }] }
  }
  const body = (p: Project) => JSON.parse(serializeProject(p)).project

  it("a newly saved file says 6, three versions after it", () => {
    expect(PROJECT_FILE_VERSION).toBe(6)
    expect(JSON.parse(serializeProject(createProject("new"))).version).toBe(6)
    expect(JSON.parse(serializeProject(rich())).version).toBe(6)
  })

  it("reading a file of the current version changes nothing", () => {
    const file = JSON.parse(serializeProject(rich()))
    expect(migrateProjectFile(file)).toEqual(file.project)
    expect(body(parseProjectFile(file, origin))).toEqual(file.project)
    const plain = JSON.parse(serializeProject(createProject("plain")))
    expect(plain.project.sheets).toEqual([{ id: "root", paper: DEFAULT_PAPER }])
    expect(migrateProjectFile(plain)).toEqual(plain.project)
  })

  it("a version 2 file goes to 3 unchanged, with the root sheet listed", () => {
    expect(pageless(migrateProjectFile(v2))).toEqual({ ...v2.project, sheets: [{ id: "root" }] })
    const read = parseProjectFile(v2, origin)
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
    expect(pageless(read).sheets).toEqual([{ id: "root" }])
  })

  it("a file at 7, 14 or 15 is newer than this editor", () => {
    for (const version of [7, 14, 15, 16, 100]) expect(problem(() => parseProjectFile({ ...JSON.parse(serializeProject(createProject())), version }, origin))).toBe("too_new")
  })
})

describe("version 4: the library holds basic parts only, and a project keeps the chips it placed as its own", () => {
  // A version 3 document as the editor wrote it while the library listed chips: a 555 on its DIP land (the library's
  // second package for it) with a STEP model, wired to a resistor. "ne555" is the library's id, which `tests/chips.ts` still draws.
  const ne555 = RETIRED.ne555 as unknown as CustomPartSpec
  const v3 = () => {
    let p = createProject("555")
    p = addComponent(p, "ne555", { sch: { x: 0, y: 0 }, footprint: "dip8" }).project
    p = addComponent(p, "resistor", { sch: { x: 3, y: 0 } }).project
    p = connectPins(p, resolvePinSpec(p, "U1.OUT")!, resolvePinSpec(p, "R1.1")!)
    p = setModel(p, "ne555", "dip8", fileModel("c".repeat(64), "u1.step", "step"))
    return { before: p, file: { ...JSON.parse(serializeProject(p)), version: 3 } }
  }
  const nets = (p: Project) => computeConnectivity(p).nets.map((n) => [n.name, n.pins.map((q) => `${q.componentId}.${q.pin}`).sort()])

  it("gives the project the chip as a part of its own, drawn as the library drew it, on the land it had", () => {
    const { before, file } = v3()
    const read = parseProjectFile(file, origin)
    const u1 = read.components.find((c) => c.ref === "U1")!
    expect(u1).toMatchObject({ partId: ne555.id, footprint: "dip8" })
    expect(read.components.find((c) => c.ref === "R1")!.partId).toBe("resistor")
    expect(read.parts).toEqual([ne555])
    expect(read.parts![0].source).toEqual({ pins: "library", land: "library" })
    expect(read.models).toEqual([{ part: ne555.id, footprint: "dip8", model: before.models![0].model }])
    // Every pin where it was, so every wire still meets it.
    expect(schematicPins(u1).map((w) => [w.pin, w.pos])).toEqual(schematicPins(before.components[0]).map((w) => [w.pin, w.pos]))
    expect(nets(read)).toEqual(nets(before))
    // As unreported in Checks as it was in the library, on its other package too.
    expect(partFindings(read)).toEqual([])
    const saved = JSON.parse(serializeProject(read))
    expect(saved.version).toBe(PROJECT_FILE_VERSION)
    expect(migrateProjectFile(saved)).toEqual(saved.project)
  })

  it("adds a chip once, however many components and models name it, and leaves a project without one as it was", () => {
    const { file } = v3()
    const twice = { ...file, project: { ...file.project, components: [...file.project.components, { ...file.project.components[0], id: "c_copy", ref: "U2" }] } }
    expect(migrateProjectFile(twice).parts).toEqual([ne555])
    const plain = { ...file, project: { ...file.project, components: file.project.components.filter((c: { partId: string }) => c.partId === "resistor"), models: undefined } }
    expect(pageless(migrateProjectFile(plain))).toEqual(pageless(plain.project))
  })

  it("keeps every chip the library had as a part that builds, under an id that is the hash of its definition", () => {
    for (const spec of Object.values(RETIRED) as unknown as CustomPartSpec[]) {
      const { id, source: _source, ...body } = spec
      expect(customPartProblems(spec), spec.name).toEqual([])
      expect(customPartId(body)).toBe(id)
    }
  })
})

describe("version 5: a schematic picture in the file store", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEUlEQVR4nGP4z8DwHwwYYBQAvF8L9XE1oVgAAAAASUVORK5CYII="
  const FILE = "a".repeat(64)
  const doc = (version: number, picture: Record<string, unknown>) => ({
    format: PROJECT_FILE_FORMAT,
    version,
    project: { ...JSON.parse(serializeProject(createProject("pictures"))).project, drawings: [{ id: "d1", type: "image", x: 1, y: 2, scale: 1, ...picture }] },
  })

  it("a version 4 file's picture, held as base64, reads as it was and is saved as it was", () => {
    const read = parseProjectFile(doc(4, { data: PNG }), origin)
    expect(read.drawings).toEqual([{ id: "d1", type: "image", x: 1, y: 2, scale: 1, data: PNG }])
    expect(JSON.parse(serializeProject(read)).project.drawings).toEqual([{ id: "d1", type: "image", x: 1, y: 2, scale: 1, data: PNG }])
  })

  it("a picture in the file store keeps its file, its size and its resolution, and is laid out by them", () => {
    const read = parseProjectFile(doc(5, { file: FILE, px: 600, py: 300, ppi: 150 }), origin)
    expect(read.drawings).toEqual([{ id: "d1", type: "image", x: 1, y: 2, scale: 1, file: FILE, px: 600, py: 300, ppi: 150 }])
    // 600 px at 150 ppi is 4 in, 101.6 mm, 8 units of 12.7 mm
    expect(drawingBounds(read.drawings![0])).toEqual({ minX: -3, minY: 0, maxX: 5, maxY: 4 })
  })

  it("a picture with neither its data nor a file and size is dropped, not drawn as nothing", () => {
    expect(parseProjectFile(doc(5, { file: FILE }), origin).drawings ?? []).toEqual([])
    expect(parseProjectFile(doc(5, { file: "not-a-hash", px: 2, py: 3 }), origin).drawings ?? []).toEqual([])
  })

  it("a version 4 reader would refuse the file: the bump is what keeps a stored picture from being dropped", () => {
    expect(problem(() => parseProjectFile({ ...doc(5, { file: FILE, px: 2, py: 3 }), version: PROJECT_FILE_VERSION + 1 }, origin))).toBe("too_new")
    expect(pageless(migrateProjectFile(doc(4, { data: PNG })))).toEqual(pageless(doc(4, { data: PNG }).project))
  })
})

describe("version 6: every sheet is a page", () => {
  const part = (id: string, ref: string, x: number, y: number, inst?: string) => ({
    id,
    partId: "resistor",
    ref,
    props: { value: "10k" },
    footprint: "r_0603",
    sch: { x, y, rot: 0 },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
    ...(inst ? { inst } : {}),
  })
  const symbol = (id: string, child: string, x: number) => ({ id, sheet: "root", child, x, y: 0, w: 2, h: 1.2, name: child.toUpperCase(), pins: [] })
  /** Three sheets below the root, as version 5 wrote them: one empty, one drawn far from the origin, and one too wide for A4. */
  const v5 = {
    format: PROJECT_FILE_FORMAT,
    version: 5,
    project: {
      name: "pages",
      description: "",
      components: [part("c1", "R1", 100, -50, "/h2"), part("c2", "R2", 104, -52, "/h2"), part("c3", "R3", 0, 0, "/h3"), part("c4", "R4", 25, -8, "/h3")],
      wires: [{ id: "w1", sheet: "s3", points: [{ x: 0, y: 0.3 }, { x: 25, y: 0.3 }, { x: 25, y: -7.7 }] }],
      labels: [{ id: "l1", sheet: "s2", name: "FAR", x: 104, y: -51.7, rot: 0 }],
      sheets: [{ id: "root" }, { id: "s1" }, { id: "s2" }, { id: "s3" }],
      sheetSymbols: [symbol("h1", "s1", 0), symbol("h2", "s2", 3), symbol("h3", "s3", 6)],
      traces: [],
      vias: [],
      zones: [],
      texts: [],
    },
  }
  const onGrid = (v: number) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6
  /** Every use's drawing is on its page, and every page's corner is on the grid. */
  const allHeld = (p: Project, what = p.name) => {
    for (const use of sheetUses(p)) {
      const paper = paperOf(p, use.sheet)
      expect(p.sheets?.find((s) => s.id === use.sheet)?.paper, `${what} ${use.name} stores its page`).toEqual(paper)
      expect(onGrid(paper.x) && onGrid(paper.y), `${what} ${use.name} corner on the grid`).toBe(true)
      const box = sheetDrawingBox(sheetView(p, use.path))
      if (box) expect(holds(paper, box), `${what} ${use.name} holds ${JSON.stringify(box)} on ${JSON.stringify(paper)}`).toBe(true)
    }
  }

  it("gives each sheet the smallest landscape page that holds its drawing, around it", () => {
    const read = parseProjectFile(v5, origin)
    allHeld(read)
    const size = (id: string) => paperOf(read, id).size
    expect([size("root"), size("s1"), size("s2"), size("s3")]).toEqual(["A4", "A4", "A4", "A3"])
    // The empty sheet gets the page every new sheet has; the far one goes where its drawing is.
    expect(paperOf(read, "s1")).toEqual(DEFAULT_PAPER)
    expect(paperOf(read, "s2").x).toBeGreaterThan(80)
    expect(JSON.parse(serializeProject(read)).version).toBe(6)
  })

  it("puts the page of a project read from KiCad where KiCad has it, its corner at the origin", () => {
    const kicad = { ...v5, project: { ...v5.project, components: [part("c1", "R1", 5, -5)], wires: [], labels: [], sheets: [{ id: "root" }], sheetSymbols: undefined, properties: [{ key: "KiCad file version", value: "KiCad 9.0, file version 20250114" }] } }
    const read = parseProjectFile(kicad, origin)
    expect(paperOf(read)).toEqual({ size: "A4", x: 0, y: 0 })
    allHeld(read)
  })

  it("lists the root of a one-sheet project, with its page", () => {
    const one = { ...v5, project: { ...v5.project, components: [part("c1", "R1", 0, 0)], wires: [], labels: [], sheets: undefined, sheetSymbols: undefined } }
    const read = parseProjectFile(one, origin)
    expect(read.sheets).toEqual([{ id: "root", paper: { size: "A4", x: expect.any(Number), y: expect.any(Number) } }])
    allHeld(read)
  })

  it("holds every shipped example's drawing, read as version 5 with no pages", () => {
    for (const example of EXAMPLES) {
      const doc = JSON.parse(serializeProject(example.project))
      doc.version = 5
      for (const s of doc.project.sheets ?? []) delete s.paper
      allHeld(parseProjectFile(doc, origin), example.id)
    }
  })

  it("is refused by an older reader: the bump keeps a version 5 editor from dropping the pages", () => {
    const written = JSON.parse(serializeProject(parseProjectFile(v5, origin)))
    expect(written.version).toBeGreaterThan(5)
    expect(problem(() => parseProjectFile({ ...written, version: PROJECT_FILE_VERSION + 1 }, origin))).toBe("too_new")
  })

  it("draws a sheet whose stored page is malformed on the default one", () => {
    const file = JSON.parse(serializeProject(createProject("bad pages")))
    for (const paper of [{ size: "Z9", x: 0, y: 0 }, { size: "A3", x: "0", y: 0 }, { size: "User", x: 0, y: 0, width: 300 }, { size: "User", x: 0, y: 0, width: -1, height: 200 }, "A4"]) {
      const read = parseProjectFile({ ...file, project: { ...file.project, sheets: [{ id: "root", paper }] } }, origin)
      expect(read.sheets?.[0]).toEqual({ id: "root" })
      expect(paperOf(read)).toEqual(DEFAULT_PAPER)
    }
    const custom = parseProjectFile({ ...file, project: { ...file.project, sheets: [{ id: "root", paper: { size: "User", width: 300, height: 200, x: 1, y: 2 } }] } }, origin)
    expect(paperOf(custom)).toEqual({ size: "User", width: 300, height: 200, x: 1, y: 2 })
  })
})
