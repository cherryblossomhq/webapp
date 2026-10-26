import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { gerberLayers } from "../src/export/gerber"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { kicadFiles } from "../src/export/kicad"
import { readKicadBoard } from "../src/model/kicad/board"
import { circuitJsonFile } from "../src/export/circuitJson"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { addVia } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { analyze, rectangle, twoResistors, withZone } from "./zones-fixtures"

const board = () => {
  let p = twoResistors()
  p = withZone(p, rectangle(-12, -8, 12, 4), { net: "GND", layers: ["top", "bottom"], priority: 2, clearance: 0.4, minWidth: 0.3, connect: "solid", thermalGap: 0.45, spokeWidth: 0.35, smoothing: { kind: "chamfer", radius: 1.5 }, islands: "never", name: "ground" } as never, "g")
  p = withZone(p, rectangle(-3, -7, 3, -4), { keepout: { tracks: true, vias: true, pour: true }, layers: ["top", "bottom"] }, "k")
  return { ...p, vias: [{ id: "s", x: 9, y: -6, diameter: 0.6, drill: 0.3, net: "GND" }] }
}

describe("Gerber copper of a polygon zone", () => {
  it("plots the fill as regions inside the polygon on each layer, and nothing for a keepout", () => {
    const p = board()
    const fills = analyze(p).zoneFills
    const gerber = gerberLayers(p, fills)
    expect(gerber.F_Cu).toContain("G36*")
    expect(gerber.B_Cu).toContain("G36*")
    // Coordinates are written in 4.6 format: no region reaches past the polygon.
    const xs = [...gerber.F_Cu.matchAll(/^X(-?\d+)Y(-?\d+)D0[12]\*/gm)].map((m) => Number(m[1]) / 1e6)
    expect(xs.length).toBeGreaterThan(8)
    // The keepout cuts a hole out of the fill: some region edge runs along its side at x = -3 less the pour's own clearance (none: a keepout has none).
    const edges = [...gerber.F_Cu.matchAll(/^X(-?\d+)Y(-?\d+)D0[12]\*/gm)].map((m) => Number(m[1]) / 1e6)
    expect(edges.some((x) => Math.abs(x + 3) < 0.01 || Math.abs(x - 3) < 0.01)).toBe(true)
  })
})

describe("Gerber exactness of a zone's copper", () => {
  it("every corner of every region is a corner of the fill, to the micron, and every corner of the fill is in a region", () => {
    const p = board()
    const fills = analyze(p).zoneFills
    for (const layer of ["top", "bottom"] as const) {
      const gerber = layer === "top" ? gerberLayers(p, fills).F_Cu : gerberLayers(p, fills).B_Cu
      const regions = [...gerber.matchAll(/G36\*([\s\S]*?)G37\*/g)].map((m) => m[1])
      const fromGerber = new Set(regions.flatMap((r) => [...r.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map((m) => `${m[1]},${m[2]}`)))
      const fromFill = new Set(
        fills
          .filter((f) => f.layer === layer)
          .flatMap((f) => f.polygons.flatMap((poly) => poly.flatMap((ring) => ring.map((q) => `${Math.round(q.x * 1e6)},${Math.round(q.y * 1e6)}`)))),
      )
      expect(fromFill.size).toBeGreaterThan(20)
      expect([...fromFill].every((k) => fromGerber.has(k))).toBe(true)
      // A hole of a polygon is joined to its outline by a bridge in a region (the same corners again), so the regions have no corner the fill lacks.
      expect([...fromGerber].every((k) => fromFill.has(k))).toBe(true)
    }
  })
})

describe("KiCad export of zones", () => {
  it("writes every zone as KiCad 9 writes it, and the file reads back with the same zones", async () => {
    const p = board()
    const { files, notes } = await kicadFiles(p)
    const text = Object.entries(files).find(([name]) => name.endsWith(".kicad_pcb"))![1]
    expect(text.match(/\(zone\b/g)).toHaveLength(2)
    expect(text).toContain('(net_name "GND")')
    // The zone's net number is the one the board's own net table gives that name.
    const gndNumber = /\n {2}\(net (\d+) "GND"\)/.exec(text)![1]
    expect(gndNumber).not.toBe("0")
    expect(text).toContain(`(zone\n    (net ${gndNumber})`)
    expect(text).toContain('(layers "F.Cu" "B.Cu")')
    expect(text).toContain("(priority 2)")
    expect(text).toContain("(connect_pads yes (clearance 0.4))")
    expect(text).toContain("(min_thickness 0.3)")
    expect(text).toContain('(name "ground")')
    expect(text).toContain("(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))")
    expect(text).toContain("(smoothing chamfer) (radius 1.5)")
    expect(text).toContain("(island_removal_mode 1) (island_area_min 10)")
    // The converter puts the editor's origin at (100, 100) of the page, as it does for the parts, and the file's y runs down: the corner (-12, -8) is written at (88, 108).
    expect(text).toMatch(/\(polygon \(pts \(xy 88 108\) \(xy 112 108\) \(xy 112 96\) \(xy 88 96\)\)\)/)
    expect(text).toMatch(/\(filled_polygon \(layer "F\.Cu"\) \(pts /)
    expect(text).toMatch(/\(filled_polygon \(layer "B\.Cu"\) \(pts /)
    expect(notes.join(" ")).toContain("Zones are written")
    const read = readKicadBoard(text).board
    expect(read.zones).toHaveLength(2)
    const [g, k] = read.zones
    expect(g).toMatchObject({ kind: "copper", net: "GND", priority: 2, clearance: 0.4, minThickness: 0.3, connect: "yes", thermalGap: 0.45, thermalBridge: 0.35, smoothing: "chamfer", radius: 1.5, islandMode: 1, name: "ground", strokedFill: false })
    expect(g.layers).toEqual(["F.Cu", "B.Cu"])
    expect(g.rings[0]).toHaveLength(4)
    expect(k).toMatchObject({ kind: "keepout", keepout: { tracks: true, vias: true, pads: false, copperpour: true, footprints: false } })
  })

  it("a project of whole-board pours alone is exported by the converter as before", async () => {
    const p: Project = { ...twoResistors(), zones: [{ id: "a", net: "GND", layer: "top" }] }
    const { files, notes } = await kicadFiles(p)
    const text = Object.entries(files).find(([name]) => name.endsWith(".kicad_pcb"))![1]
    expect(text).toContain("(zone")
    expect(notes.join(" ")).toContain("Pours arrive filled")
  })
})

describe("Circuit JSON of zones", () => {
  it("exports a keepout as a pcb_keepout outline and a pour as the copper it fills", () => {
    const p = board()
    const { elements, notes } = projectToCircuitJson(p)
    const keepouts = elements.filter((e) => e.type === "pcb_keepout")
    expect(keepouts).toHaveLength(1)
    expect(keepouts[0]).toMatchObject({ shape: "outline", layers: ["top", "bottom"] })
    expect((keepouts[0] as unknown as { outline: unknown[] }).outline).toHaveLength(4)
    expect(elements.filter((e) => e.type === "pcb_copper_pour").length).toBeGreaterThan(0)
    expect(notes.join(" ")).toContain("Copper pours are exported as the copper they fill")
    expect(circuitJsonFile(p).text).toContain("pcb_keepout")
    // The KiCad export writes zones itself, so the circuit it converts has neither.
    const forKicad = projectToCircuitJson(p, { forKicad: true }).elements
    expect(forKicad.some((e) => e.type === "pcb_keepout" || e.type === "pcb_copper_pour")).toBe(false)
  })
})

describe("Sakura and zones", () => {
  it("get_design lists zones by id only for a project that has polygon zones, and a plain pour leaves it as it was", () => {
    const plain = twoResistors()
    const withPour = { ...plain, zones: [{ id: "a", net: "GND", layer: "top" as const }] }
    expect(JSON.parse(runTool(withPour, "get_design", {}).result)).not.toHaveProperty("zones")
    const out = JSON.parse(runTool(board(), "get_design", {}).result)
    expect(out.zones).toEqual([
      { id: "g", net: "GND", layers: "top+bottom", priority: 2, polygon: [-12, -8, 12, -8, 12, 4, -12, 4] },
      { id: "k", layers: "top+bottom", keepout: "tracks+vias+pour", polygon: [-3, -7, 3, -7, 3, -4, -3, -4] },
    ])
  })

  it("set_pour adds a polygon pour or a keepout, changes one by id, and removes one by id", () => {
    let p = twoResistors()
    let out = runTool(p, "set_pour", { net: "GND", layer: "both", polygon: [-10, -8, 10, -8, 10, 3, -10, 3], priority: 1 })
    expect(out.isError).toBe(false)
    p = out.project
    expect(p.zones).toHaveLength(1)
    expect(p.zones[0]).toMatchObject({ net: "GND", layer: "top", layers: ["top", "bottom"], priority: 1 })
    expect(out.result).toContain(p.zones[0].id)
    const id = p.zones[0].id
    out = runTool(p, "set_pour", { layer: "top", id, net: "SIG", priority: 3 })
    expect(out.project.zones[0]).toMatchObject({ net: "SIG", priority: 3, layer: "top" })
    expect(out.project.zones[0].layers).toBeUndefined()
    out = runTool(p, "set_pour", { layer: "top", keepout: ["tracks", "parts"], polygon: [0, 0, 4, 0, 4, 4] })
    expect(out.project.zones[1]).toMatchObject({ net: "", keepout: { tracks: true, footprints: true } })
    p = out.project
    expect(runTool(p, "set_pour", { layer: "top", id: p.zones[1].id, remove: true }).project.zones).toHaveLength(1)
    // The pour of a whole board is untouched by a polygon zone of the same net.
    const both = runTool(p, "set_pour", { net: "GND", layer: "top" }).project
    expect(both.zones).toHaveLength(3)
    expect(runTool(both, "set_pour", { net: "GND", layer: "top", remove: true }).project.zones).toHaveLength(2)
  })

  it("removing a pour by net says that polygon zones on the net stay, and names their ids", () => {
    const poly = runTool(twoResistors(), "set_pour", { net: "GND", layer: "both", polygon: [-10, -8, 10, -8, 10, 3, -10, 3] }).project
    const id = poly.zones[0].id
    // Only polygon zones on the net: nothing is removed, and the answer says where they are.
    const none = runTool(poly, "set_pour", { net: "GND", layer: "top", remove: true })
    expect(none.isError).toBe(true)
    expect(none.result).toContain("whole-board")
    expect(none.result).toContain(`id ${id}`)
    expect(none.project.zones).toHaveLength(1)
    // A whole-board pour too: it goes, the polygon zone stays and the answer says so.
    const both = runTool(poly, "set_pour", { net: "GND", layer: "top" }).project
    const gone = runTool(both, "set_pour", { net: "GND", layer: "top", remove: true })
    expect(gone.isError).toBe(false)
    expect(gone.project.zones.map((z) => z.id)).toEqual([id])
    expect(gone.result).toContain(`id ${id}`)
    // A net with no polygon zone gets the answer it always got.
    expect(runTool(twoResistors(), "set_pour", { net: "GND", layer: "top", remove: true }).result).toBe("Error: There is no GND pour on top")
  })

  it("says why a polygon or a net does not work, and leaves the project alone", () => {
    const p = twoResistors()
    expect(runTool(p, "set_pour", { net: "GND", layer: "top", polygon: [0, 0, 1, 1] })).toMatchObject({ isError: true })
    expect(runTool(p, "set_pour", { net: "GND", layer: "top", polygon: [0, 0, 1, 1, 2, 2] })).toMatchObject({ isError: true })
    expect(runTool(p, "set_pour", { net: "NOPE", layer: "top", polygon: [0, 0, 4, 0, 4, 4] })).toMatchObject({ isError: true })
    expect(runTool(p, "set_pour", { layer: "top", id: "missing" })).toMatchObject({ isError: true })
    const locked = { ...board(), zones: board().zones.map((z) => ({ ...z, locked: true as const })) }
    expect(runTool(locked, "set_pour", { layer: "top", id: "g", remove: true })).toMatchObject({ isError: true })
  })
})

describe("saving and reading zones", () => {
  it("a project with zones, a rule area and a stitching via round-trips exactly", () => {
    const p = board()
    const read = parseProjectFile(serializeProject(p), { id: p.id })
    expect(read.zones).toEqual(p.zones)
    expect(analyze(read).zoneFills.map((f) => [f.zoneId, f.layer, f.polygons.length])).toEqual(analyze(p).zoneFills.map((f) => [f.zoneId, f.layer, f.polygons.length]))
  })

  it("a keepout that keeps vias out is respected by a via the user adds? it is reported, not refused", () => {
    const p = board()
    const out = addVia(p, { x: 0, y: -5 }).project
    expect(analyze(out).violations.some((v) => v.kind === "keepout")).toBe(true)
  })
})
