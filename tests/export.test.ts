import { describe, expect, it } from "vitest"
import { bomCsv } from "../src/export/bom"
import { buildFabricationFiles, buildFabricationZip, projectFileName } from "../src/export/bundle"
import { drillHoles, excellonDrill, npthHoles } from "../src/export/excellon"
import { gerberCopper, gerberLayers } from "../src/export/gerber"
import { pnpCsv } from "../src/export/pnp"
import { strokeText } from "../src/lib/strokeFont"
import { pcbPads } from "../src/model/instances"
import { addComponent, addTrace, addVia, connectPins, createProject } from "../src/model/ops"
import type { ZoneFill } from "../src/model/pour"
import type { Project, Vec2 } from "../src/model/types"

const gerberCoord = (mm: number) => String(Math.round(mm * 1e6))

function sampleProject() {
  let p = createProject("Test Board")
  let r1, r2
  ;({ project: p, component: r1 } = addComponent(p, "resistor", { sch: { x: 0, y: 0 }, pcb: { x: -5, y: 0, placed: true } }))
  ;({ project: p, component: r2 } = addComponent(p, "resistor", { sch: { x: 3, y: 0 }, pcb: { x: 5, y: 0, placed: true } }))
  p = addComponent(p, "header_1x4", { sch: { x: 6, y: 0 }, pcb: { x: 0, y: -10, placed: true } }).project
  p = addComponent(p, "ground", { sch: { x: 0, y: -3 } }).project
  p = connectPins(p, { componentId: r1.id, pin: "2" }, { componentId: r2.id, pin: "1" })
  const find = (id: string, pin: string) =>
    pcbPads(p.components.find((c) => c.id === id)!).find((pad) => pad.pin === pin)!
  const padA = find(r1.id, "2")
  const padB = find(r2.id, "1")
  p = addTrace(p, { layer: "top", width: 0.25, points: [padA, { x: padA.x, y: 2 }, { x: padB.x, y: 2 }, padB] }).project
  p = addVia(p, { x: 0, y: 5 }).project
  return p
}

function checkGerber(name: string, text: string) {
  const lines = text.trimEnd().split("\n")
  const commands = lines.filter((l) => !l.startsWith("G04"))
  expect(commands[0], name).toBe("%FSLAX46Y46*%")
  expect(commands[1], name).toBe("%MOMM*%")
  expect(lines[lines.length - 1], name).toBe("M02*")
  const defined = new Set<number>()
  for (const line of lines) {
    const def = line.match(/^%ADD(\d+)/)
    if (def) defined.add(Number(def[1]))
    const use = line.match(/^D(\d+)\*$/)
    if (use) expect(defined.has(Number(use[1])), `${name} uses D${use[1]} before defining it`).toBe(true)
    for (const c of line.matchAll(/[XYIJ](-?\d+)/g)) expect(Number.isInteger(Number(c[1])), `${name}: ${line}`).toBe(true)
  }
}

describe("gerber", () => {
  const p = sampleProject()
  const layers = gerberLayers(p)

  it.each(Object.entries(layers))("%s is well formed", (name, text) => checkGerber(name, text))

  it("draws a pour island after the hole it sits in, so clearing the hole can't erase it", () => {
    const square = (cx: number, cy: number, r: number): Vec2[] => [
      { x: cx - r, y: cy - r },
      { x: cx + r, y: cy - r },
      { x: cx + r, y: cy + r },
      { x: cx - r, y: cy + r },
    ]
    const island = square(0, 0, 1)
    const fill = (zoneId: string, polygons: Vec2[][][]): ZoneFill => ({ zoneId, netId: null, netName: "GND", layer: "top", polygons })
    // The island comes first, as the pour's polytree flattening emits it, then the ring around it.
    const text = gerberCopper(createProject(), "top", [fill("a", [[island]]), fill("b", [[square(0, 0, 10), square(0, 0, 3)]])])
    const islandAt = text.indexOf(`X${gerberCoord(-1)}Y${gerberCoord(-1)}D02*`)
    expect(islandAt).toBeGreaterThan(text.indexOf("%LPC*%"))
  })

  it("draws the trace and flashes pads on top copper only", () => {
    const end = p.traces[0].points[p.traces[0].points.length - 1]
    const draw = `X${gerberCoord(end.x)}Y${gerberCoord(end.y)}D01*`
    expect(layers.F_Cu).toContain(draw)
    expect(layers.B_Cu).not.toContain(draw)
    expect(layers.F_Cu).toMatch(/D03\*/)
    expect(layers.F_Cu).toContain("%ADD10")
  })

  it("puts the via on both copper layers but tents it in the mask", () => {
    const via = `X${gerberCoord(0)}Y${gerberCoord(5)}D03*`
    expect(layers.F_Cu).toContain(via)
    expect(layers.B_Cu).toContain(via)
    expect(layers.F_Mask).not.toContain(via)
  })

  it("keeps SMD pads out of the bottom paste layer and through-hole pads out of paste", () => {
    expect(layers.B_Paste).not.toMatch(/D03\*/)
    const headerPad = pcbPads(p.components.find((c) => c.partId === "header_1x4")!)[0]
    expect(layers.F_Paste).not.toContain(`X${gerberCoord(headerPad.x)}Y${gerberCoord(headerPad.y)}D03*`)
    expect(layers.B_Cu).toContain(`X${gerberCoord(headerPad.x)}Y${gerberCoord(headerPad.y)}D03*`)
  })

  it("draws a rounded board outline with arcs", () => {
    expect(layers.Edge_Cuts.match(/G03\*/g)).toHaveLength(4)
    expect(layers.Edge_Cuts).toContain("Profile,NP")
  })

  it("mirrors bottom-side SMD pads onto B_Cu", () => {
    let q: Project = createProject("b")
    q = addComponent(q, "resistor", { pcb: { x: 0, y: 0, side: "bottom", placed: true } }).project
    const out = gerberLayers(q)
    expect(out.B_Cu).toMatch(/D03\*/)
    expect(out.F_Cu).not.toMatch(/D03\*/)
    expect(out.B_Paste).toMatch(/D03\*/)
  })
})

describe("excellon", () => {
  it("lists every through-hole pad and via", () => {
    const p = sampleProject()
    const drill = excellonDrill(p)
    expect(drillHoles(p)).toHaveLength(5)
    expect(drill.split("\n").filter((l) => /^X/.test(l))).toHaveLength(5)
    expect(drill).toMatch(/^M48\n/)
    expect(drill).toMatch(/T1C0\.\d{3}/)
    expect(drill.trimEnd().endsWith("M30")).toBe(true)
  })

  it("drills slotted holes as G85 slots that turn with the part", () => {
    let p = createProject("Slots")
    p = addComponent(p, "usb_c", { sch: { x: 0, y: 0 }, pcb: { x: 10, y: 5, rot: 90, placed: true } }).project
    const slots = drillHoles(p).filter((h) => h.slot)
    expect(slots).toHaveLength(4)
    for (const h of slots) {
      const [a, b] = h.slot!
      // Turned 90°, the footprint's vertical slots run along x; 1.7 / 1.4 mm long, 0.6 mm wide.
      expect(a.y).toBeCloseTo(b.y, 6)
      expect([1.1, 0.8]).toContainEqual(Number(Math.abs(b.x - a.x).toFixed(3)))
      expect(h.diameter).toBe(0.6)
    }
    const lines = excellonDrill(p).split("\n").filter((l) => l.includes("G85"))
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^X-?\d+\.\d{3}Y-?\d+\.\d{3}G85X-?\d+\.\d{3}Y-?\d+\.\d{3}$/)
    // The USB-C locating pegs are bare holes in the non-plated file.
    expect(npthHoles(p)).toHaveLength(2)
  })
})

describe("non-plated holes", () => {
  function moduleBoard() {
    let p = createProject("Module Board")
    p = { ...p, board: { ...p.board, width: 40, height: 60 } }
    return addComponent(p, "esp32_devkit_v1", { sch: { x: 0, y: 0 }, pcb: { x: 0, y: 0, placed: true } }).project
  }

  it("go in their own NPTH drill file", () => {
    const p = moduleBoard()
    expect(npthHoles(p)).toHaveLength(4)
    expect(drillHoles(p)).toHaveLength(30)
    const npth = excellonDrill(p, { plated: false })
    expect(npth).toContain("TF.FileFunction,NonPlated,1,2,NPTH")
    expect(npth).toContain("T1C3.000")
    expect(npth).toContain("X-12.250Y-21.210")
    expect(npth.split("\n").filter((l) => /^X/.test(l))).toHaveLength(4)
    const pth = excellonDrill(p)
    expect(pth).toContain("TF.FileFunction,Plated,1,2,PTH")
    expect(pth).not.toContain("X-12.250Y-21.210")
    const files = buildFabricationFiles(p)
    expect(files["module-board-NPTH.drl"]).toBe(npth)
    expect(files["module-board-PTH.drl"]).toBe(pth)
  })

  it("open the mask but get no copper or paste", () => {
    const layers = gerberLayers(moduleBoard())
    for (const x of [-12.25, 12.25]) {
      const flash = `X${gerberCoord(x)}Y${gerberCoord(-21.21)}D03*`
      expect(layers.F_Cu).not.toContain(flash)
      expect(layers.B_Cu).not.toContain(flash)
      expect(layers.F_Paste).not.toContain(flash)
      expect(layers.F_Mask).toContain(flash)
      expect(layers.B_Mask).toContain(flash)
    }
  })
})

describe("bom and pnp", () => {
  it("groups identical parts", () => {
    const csv = bomCsv(sampleProject())
    const lines = csv.trimEnd().split("\n")
    expect(lines[0]).toBe("Designators,Quantity,Value,Footprint,Properties,MPN,Description")
    expect(lines).toContain('"R1, R2",2,10k,0603,,,Fixed resistor')
    expect(csv).not.toContain("#GND")
  })

  it("keeps parts apart when any property differs", () => {
    let p = createProject("caps")
    p = addComponent(p, "capacitor_polarized", { props: { capacitance: "10uF", voltage: "16V" } }).project
    p = addComponent(p, "capacitor_polarized", { props: { capacitance: "10uF", voltage: "50V" } }).project
    p = addComponent(p, "resistor", { props: { resistance: "10k", mpn: "A" } }).project
    p = addComponent(p, "resistor", { props: { resistance: "10k", mpn: "B" } }).project
    const lines = bomCsv(p).trimEnd().split("\n").slice(1)
    expect(lines).toHaveLength(4)
    expect(lines.some((l) => l.includes("voltage=16V"))).toBe(true)
    expect(lines.some((l) => l.includes("voltage=50V"))).toBe(true)
  })

  it("quotes fields containing commas and quotes", () => {
    let p = createProject("q")
    p = addComponent(p, "resistor", { props: { resistance: '4.7k "1%", thin film' } }).project
    expect(bomCsv(p)).toContain('"4.7k ""1%"", thin film"')
  })

  it("excludes power symbols from pick and place", () => {
    const csv = pnpCsv(sampleProject())
    const lines = csv.trimEnd().split("\n")
    expect(lines[0]).toBe("Designator,Value,Footprint,Mid X,Mid Y,Rotation,Layer")
    expect(lines).toHaveLength(4)
    expect(csv).not.toContain("#GND")
    expect(lines[1]).toBe("J1,,pinrow4,0.0000,-10.0000,0,top")
  })
})

describe("stroke font", () => {
  it("renders designators as polylines centred on the anchor", () => {
    const strokes = strokeText("R12", { x: 10, y: 5, size: 1 })
    expect(strokes.length).toBeGreaterThan(0)
    const xs = strokes.flat().map((p) => p.x)
    const ys = strokes.flat().map((p) => p.y)
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(10, 1)
    expect(Math.min(...ys)).toBeCloseTo(4.5)
    expect(Math.max(...ys)).toBeCloseTo(5.5)
  })

  it("mirrors and rotates around the anchor", () => {
    const plain = strokeText("L", { x: 0, y: 0, size: 6, anchor: "left" })
    const mirrored = strokeText("L", { x: 0, y: 0, size: 6, anchor: "left", mirror: true })
    expect(mirrored[0].map((p) => p.x)).toEqual(plain[0].map((p) => -p.x + 0))
    const rotated = strokeText("L", { x: 0, y: 0, size: 6, anchor: "left", rotation: 90 })
    expect(rotated[0][0]).toEqual({ x: -plain[0][0].y + 0, y: plain[0][0].x })
  })

  it("draws unknown characters as a placeholder and skips spaces", () => {
    expect(strokeText(" ", { x: 0, y: 0, size: 1 })).toHaveLength(0)
    expect(strokeText("@", { x: 0, y: 0, size: 1 }).length).toBeGreaterThan(0)
    expect(strokeText("abc", { x: 0, y: 0, size: 1 })).not.toEqual(strokeText("ABC", { x: 0, y: 0, size: 1 }))
  })
})

describe("bundle", () => {
  it("names every fabrication file", () => {
    const p = sampleProject()
    expect(Object.keys(buildFabricationFiles(p)).sort()).toEqual(
      [
        "test-board-F_Cu.gtl",
        "test-board-B_Cu.gbl",
        "test-board-F_Mask.gts",
        "test-board-B_Mask.gbs",
        "test-board-F_Silkscreen.gto",
        "test-board-B_Silkscreen.gbo",
        "test-board-F_Paste.gtp",
        "test-board-B_Paste.gbp",
        "test-board-Edge_Cuts.gm1",
        "test-board-PTH.drl",
        "bom.csv",
        "pnp.csv",
        "test-board-fabrication.txt",
      ].sort(),
    )
    expect(projectFileName(p, ".json")).toBe("test-board.json")
    expect(projectFileName({ ...p, name: "  ###  " }, "zip")).toBe("cherryblossom.zip")
  })

  it("zips the fabrication files", async () => {
    const blob = await buildFabricationZip(sampleProject())
    expect(blob.size).toBeGreaterThan(500)
  })
})

describe("fabrication notes", () => {
  it("states the board spec, the smallest features and the project's properties", () => {
    const p = {
      ...sampleProject(),
      properties: [{ key: "Revision", value: "B" }],
      board: { ...sampleProject().board, maskColor: "#16161a", finish: "lf-hasl" as const, copperWeight: 2 as const },
    }
    const files = buildFabricationFiles(p)
    const notes = files["test-board-fabrication.txt"]
    expect(notes).toContain("Revision: B")
    expect(notes).toContain("Thickness         1.6 mm")
    expect(notes).toContain("Copper            2 oz (70 µm) outer layers")
    expect(notes).toContain("Surface finish    Lead-free HASL")
    expect(notes).toContain("Solder mask       Black (#16161a), both sides")
    expect(notes).toContain("Silkscreen        White (#f4f4f0), both sides")
    expect(notes).toContain("Trace width       0.25 mm")
    expect(notes).toContain("Vias              1, tented")
    expect(notes).toContain("  test-board-F_Cu.gtl")
  })
})
