import { afterAll, describe, expect, it } from "vitest"
import { readKicadBoard } from "../src/model/kicad/board"
import { pcbSvg } from "../src/ai/vision/pcbSvg"
import { measurePcb } from "../src/ai/vision/measure"
import { runTool } from "../src/ai/tools"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { paintBoardSides } from "../src/editor/three/boardTextures"
import { gerberLayers, type GerberLayerName } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { fabricationNotes } from "../src/export/notes"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical, pcbPads } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { analyzePcb } from "../src/model/pcb"
import { computeConnectivity } from "../src/model/connectivity"
import { addBoardText, addPartText, updateBoardTexts, withDesignatorText } from "../src/model/textOps"
import { layerText, textInk, textsOnLayer, worldTexts } from "../src/model/texts"
import { placeDesignators } from "../src/model/silk"
import { buildCopperItems } from "../src/model/pcb"
import { fillTester } from "../src/model/pour"
import type { BoardText, Project, Vec2 } from "../src/model/types"
import { textOracle } from "./kicad-census/texts.mjs"

// Text objects (X9) in every output: Gerber, the checks, pours, Sakura's picture, the 3D board, the KiCad export, Circuit JSON, the
// notes and get_design. A board with none says nothing new anywhere.

const blinker = () => structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project
const ALL: GerberLayerName[] = ["F_Cu", "B_Cu", "F_Mask", "B_Mask", "F_Silkscreen", "B_Silkscreen", "F_Paste", "B_Paste", "Edge_Cuts"]
const FILE_OF: Record<string, GerberLayerName> = { "F.Cu": "F_Cu", "B.Cu": "B_Cu", "F.Mask": "F_Mask", "B.Mask": "B_Mask", "F.Paste": "F_Paste", "B.Paste": "B_Paste", "F.SilkS": "F_Silkscreen", "B.SilkS": "B_Silkscreen", "Edge.Cuts": "Edge_Cuts" }

const withText = (base: Project, over: Partial<BoardText> & { layer: string; text: string }): Project => {
  registerProjectParts(base)
  return addBoardText(base, { x: 0, y: 0, rot: 0, size: 2, thickness: 0.3, ...over }).project
}

// ---------- a small Gerber reader (strokes and regions) ----------

interface Stroke {
  from: Vec2
  to: Vec2
  width: number
}
function parse(text: string) {
  const ap = new Map<string, number>()
  const strokes: Stroke[] = []
  const regions: Vec2[][] = []
  let aperture = 0
  let at: Vec2 = { x: 0, y: 0 }
  let region: Vec2[] | null = null
  let dark = true
  let clear = 0
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const def = line.match(/^%ADD(\d+)C,([\d.]+)\*%$/)
    if (def) ap.set(`D${def[1]}`, Number(def[2]))
    else if (line === "%LPC*%") (dark = false), clear++
    else if (line === "%LPD*%") dark = true
    else if (line === "G36*") region = []
    else if (line === "G37*") {
      if (region && dark) regions.push(region)
      region = null
    } else if (/^D\d+\*$/.test(line)) aperture = ap.get(line.slice(0, -1)) ?? 0
    else {
      const m = line.match(/^(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0([123])\*$/)
      if (!m) continue
      const to = { x: m[1] !== undefined ? Number(m[1]) / 1e6 : at.x, y: m[2] !== undefined ? Number(m[2]) / 1e6 : at.y }
      if (m[5] === "2") region?.push(to)
      else if (m[5] === "1") {
        if (region) region.push(to)
        else strokes.push({ from: at, to, width: aperture })
      }
      at = to
    }
  }
  return { strokes, regions, clear }
}
const area = (ring: Vec2[]) => {
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j].x * ring[i].y - ring[i].x * ring[j].y
  return twice / 2
}

describe("Gerber", () => {
  it("a board with no KiCad text plots as it did, with the field absent or empty", () => {
    for (const example of EXAMPLES) {
      const p = example.project
      registerProjectParts(p)
      const base = gerberLayers(p)
      expect(gerberLayers({ ...p, texts: [...(p.texts ?? [])] }), example.id).toEqual(base)
    }
  })

  for (const layer of Object.keys(FILE_OF)) {
    it(`a text on ${layer} is plotted in ${FILE_OF[layer]} with its pen, and in no other file`, () => {
      const base = blinker()
      registerProjectParts(base)
      const before = gerberLayers(base)
      const p = withText(base, { layer, text: "HI", x: 5, y: -4, thickness: 0.3, size: 2 })
      const after = gerberLayers(p)
      for (const name of ALL) {
        if (name !== FILE_OF[layer]) expect(after[name], name).toBe(before[name])
      }
      const strokes = parse(after[FILE_OF[layer]]).strokes.filter((s) => Math.abs(s.width - 0.3) < 1e-9)
      const ink = textInk(p, worldTexts(p)[0])
      // every segment of the text's strokes is a stroke of the file with the pen, at the same place
      const want = ink.strokes.flatMap((l) => l.slice(1).map((q, i) => [l[i], q] as const))
      expect(want.length).toBeGreaterThan(4)
      for (const [a, b] of want) expect(strokes.some((s) => Math.hypot(s.from.x - a.x, s.from.y - a.y) < 2e-6 && Math.hypot(s.to.x - b.x, s.to.y - b.y) < 2e-6), JSON.stringify([a, b])).toBe(true)
      expect(ink.pen).toBe(0.3)
    })
  }

  it("fabrication, courtyard, adhesive and user layers are not plotted", () => {
    const base = blinker()
    registerProjectParts(base)
    const before = gerberLayers(base)
    let p = base
    for (const layer of ["F.Fab", "B.Fab", "F.CrtYd", "F.Adhes", "Dwgs.User", "Cmts.User", "User.1"]) p = withText(p, { layer, text: "x", x: 1, y: 1 })
    expect(gerberLayers(p)).toEqual(before)
  })

  it("a hidden text, and the text of a part not placed on the board, are left out", () => {
    const base = blinker()
    registerProjectParts(base)
    const before = gerberLayers(base)
    const c = base.components.find((x) => isPhysical(findPart(x.partId)))!
    // a part with texts of its own has them and no designator of the editor's: its reference becomes the first of them
    const seeded = withDesignatorText(base, c.id)
    const added = addPartText(seeded, c.id, { text: "NOTE", at: { x: c.pcb.x, y: c.pcb.y }, layer: "F.SilkS" })
    const shown = gerberLayers(added.project)
    expect(shown.F_Silkscreen).not.toBe(before.F_Silkscreen)
    expect(shown.F_Silkscreen).not.toBe(gerberLayers(seeded).F_Silkscreen)
    // hidden: the text is left out, so the board plots as it does with the reference alone
    const hidden = { ...added.project, components: added.project.components.map((x) => (x.id === c.id ? { ...x, texts: x.texts!.map((t) => (t.kind === "user" ? { ...t, hide: true as const } : t)) } : x)) }
    expect(gerberLayers(hidden)).toEqual(gerberLayers(seeded))
    // not placed: the part's own drawings and text are left out of every output
    const unplaced = { ...added.project, components: added.project.components.map((x) => (x.id === c.id ? { ...x, pcb: { ...x.pcb, placed: false } } : x)) }
    expect(gerberLayers(unplaced).F_Silkscreen).not.toContain("NOTE")
    expect(textsOnLayer(unplaced, "F.SilkS")).toEqual([])
  })

  it("a knockout is a filled region with the letters left out: one outline, the letters' holes bridged, and no stroke of the text", () => {
    const base = blinker()
    registerProjectParts(base)
    const plainText = withText(base, { layer: "F.SilkS", text: "OB", x: 5, y: -4, size: 2, thickness: 0.3 })
    const ko = withText(base, { layer: "F.SilkS", text: "OB", x: 5, y: -4, size: 2, thickness: 0.3, knockout: true })
    const a = parse(gerberLayers(plainText).F_Silkscreen)
    const b = parse(gerberLayers(ko).F_Silkscreen)
    const bare = parse(gerberLayers(base).F_Silkscreen)
    expect(a.regions.length).toBe(bare.regions.length)
    expect(b.regions.length).toBeGreaterThan(bare.regions.length)
    // the knockout draws no stroke of the letters
    expect(b.strokes.length).toBe(bare.strokes.length)
    // its region is the hull (the ink's box grown by the margin) less the ink: bigger than the letters, smaller than the hull
    const wt = worldTexts(ko)[0]
    const ink = textInk(ko, wt)
    const lt = layerText(ko, wt)!
    expect(lt.fills.length).toBeGreaterThan(0)
    const hull = Math.abs(area(ink.hull!))
    const filled = lt.fills.reduce((s, poly) => s + Math.abs(area(poly[0])) - poly.slice(1).reduce((t, h) => t + Math.abs(area(h)), 0), 0)
    expect(filled).toBeLessThan(hull)
    expect(filled).toBeGreaterThan(hull * 0.4)
    // the hull is the ink's box (in the text's own turn) grown by the margin: max(half the pen, a ninth of the height)
    const margin = Math.max(0.15, 2 / 9)
    const inkBox = ink.box!
    expect(Math.abs(Math.abs(area(ink.hull!)) - (inkBox.maxX - inkBox.minX + 2 * margin) * (inkBox.maxY - inkBox.minY + 2 * margin))).toBeLessThan(1e-4)
  })

  it("a text box's border is a stroked outline with the border's width, drawn with the text", () => {
    const base = blinker()
    registerProjectParts(base)
    const p = withText(base, { layer: "F.SilkS", text: "box text", x: 6, y: -4, size: 0.8, thickness: 0.15, box: { w: 8, h: 4, border: 0.25, margins: [0.5, 0.5, 0.5, 0.5] } })
    const after = parse(gerberLayers(p).F_Silkscreen)
    const bare = parse(gerberLayers(base).F_Silkscreen)
    const border = after.strokes.filter((s) => Math.abs(s.width - 0.25) < 1e-9).filter((s) => !bare.strokes.some((q) => q.from.x === s.from.x && q.from.y === s.from.y && q.to.x === s.to.x))
    expect(border).toHaveLength(4)
    const xs = border.flatMap((s) => [s.from.x, s.to.x])
    const ys = border.flatMap((s) => [s.from.y, s.to.y])
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([2, 10, -6, -2])
  })

  it("a mirrored text is the reflection of the same text across its own vertical axis, turned with it", () => {
    const base = blinker()
    registerProjectParts(base)
    const top = withText(base, { layer: "F.SilkS", text: "AB", x: 5, y: -4, rot: 33, size: 2, thickness: 0.2 })
    const bottom = withText(base, { layer: "B.SilkS", text: "AB", x: 5, y: -4, rot: 33, size: 2, thickness: 0.2, mirror: true })
    const a = textInk(top, worldTexts(top).at(-1)!).strokes.flat()
    const b = textInk(bottom, worldTexts(bottom).at(-1)!).strokes.flat()
    expect(a.length).toBe(b.length)
    // the axis runs through the anchor along the text's up, turned 33 degrees counter-clockwise
    const th = (33 * Math.PI) / 180
    const u = { x: -Math.sin(th), y: Math.cos(th) }
    const P = { x: 5, y: -4 }
    a.forEach((p, i) => {
      const d = { x: p.x - P.x, y: p.y - P.y }
      const dot = d.x * u.x + d.y * u.y
      const r = { x: P.x + 2 * dot * u.x - d.x, y: P.y + 2 * dot * u.y - d.y }
      expect(Math.hypot(r.x - b[i].x, r.y - b[i].y)).toBeLessThan(2e-6)
    })
  })
})

describe("copper text is copper", () => {
  /** The blinker with a copper text laid across its first trace, on the trace's layer. */
  function crossing() {
    const base = blinker()
    registerProjectParts(base)
    const t = base.traces[0]
    const mid = { x: (t.points[0].x + t.points[1].x) / 2, y: (t.points[0].y + t.points[1].y) / 2 }
    const p = withText(base, { layer: t.layer === "top" ? "F.Cu" : "B.Cu", text: "COPPER", x: mid.x, y: mid.y, size: 1.5, thickness: 0.3 })
    return { base, p, trace: t, mid }
  }
  it("is an item of the board's copper that conducts nothing, and stays out of the nets", () => {
    const { p } = crossing()
    const c = computeConnectivity(p)
    const items = buildCopperItems(p, c)
    const text = items.filter((i) => i.kind === "shape" && i.what === "text")
    expect(text).toHaveLength(1)
    expect(text[0].kind === "shape" && text[0].conducts).toBe(false)
    expect(text[0].kind === "shape" && text[0].netId).toBeUndefined()
  })
  it("is checked for clearance against copper of a net, and the message calls it copper text", () => {
    const { base, p } = crossing()
    const before = analyzePcb(base, computeConnectivity(base)).violations.filter((v) => v.kind === "clearance").length
    const after = analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "clearance")
    expect(after.length).toBeGreaterThan(before)
    expect(after.some((v) => /copper text/.test(v.message))).toBe(true)
    // it does not short anything, and it makes no net
    expect(analyzePcb(p, computeConnectivity(p)).violations.some((v) => v.kind === "short")).toBe(analyzePcb(base, computeConnectivity(base)).violations.some((v) => v.kind === "short"))
  })
  it("a pour keeps clear of it", () => {
    const { base, trace } = crossing()
    const gnd = computeConnectivity(base).nets.find((n) => /gnd/i.test(n.name))!.name
    const poured: Project = { ...base, zones: [{ id: "z1", net: gnd, layer: trace.layer }] }
    const p = withText(poured, { layer: trace.layer === "top" ? "F.Cu" : "B.Cu", text: "KEEP", x: -2, y: 2, size: 2, thickness: 0.4 })
    const fills = analyzePcb(p, computeConnectivity(p)).zoneFills.filter((f) => f.layer === trace.layer)
    const ink = textInk(p, worldTexts(p)[0])
    const inside = fills.flatMap((f) => f.polygons.map((poly) => fillTester(poly)))
    // no point on a stroke of the text is inside the pour
    let hit = 0
    for (const line of ink.strokes) for (const pt of line) if (inside.some((f) => f(pt))) hit++
    expect(hit).toBe(0)
    // and the same pour with no text is there
    const bare = analyzePcb(poured, computeConnectivity(poured)).zoneFills.filter((f) => f.layer === trace.layer)
    const bareInside = bare.flatMap((f) => f.polygons.map((poly) => fillTester(poly)))
    const near = ink.strokes.flat().filter((q) => bareInside.some((f) => f(q))).length
    expect(near).toBeGreaterThan(0)
  })
  it("a text on silkscreen or any other layer is not copper", () => {
    const base = blinker()
    registerProjectParts(base)
    const p = withText(base, { layer: "F.SilkS", text: "x", x: 3, y: 3 })
    expect(buildCopperItems(p, computeConnectivity(p)).some((i) => i.kind === "shape")).toBe(false)
  })
})

describe("designators", () => {
  it("a KiCad silk text on the board is kept clear of by the editor's designators", () => {
    const base = blinker()
    registerProjectParts(base)
    const d0 = [...placeDesignators(base).values()][0]
    const p = withText(base, { layer: d0.side === "top" ? "F.SilkS" : "B.SilkS", text: "BIGTEXT", x: d0.x, y: d0.y, size: 3, thickness: 0.4 })
    const d1 = placeDesignators(p).get(d0.componentId)!
    const box = textsOnLayer(p, d0.side === "top" ? "F.SilkS" : "B.SilkS")[0].box
    const overlaps = d1.box.minX < box.maxX && d1.box.maxX > box.minX && d1.box.minY < box.maxY && d1.box.maxY > box.minY
    expect(overlaps).toBe(false)
  })
  it("the five shipped examples have no part text, so every designator is the editor's, as before", () => {
    for (const example of EXAMPLES) {
      expect(example.project.components.every((c) => c.texts === undefined), example.id).toBe(true)
      expect((example.project.texts ?? []).every((t) => t.layer === undefined), example.id).toBe(true)
      expect(worldTexts(example.project), example.id).toEqual([])
    }
  })
})

describe("Sakura's picture", () => {
  const svg = (p: Project, extras: string[] = ["silkscreen", "courtyards"], side: "top" | "bottom" | "both" = "both") => {
    const b = p.board
    const box = { minX: b.x - b.width / 2 - 2, maxX: b.x + b.width / 2 + 2, minY: b.y - b.height / 2 - 2, maxY: b.y + b.height / 2 + 2 }
    return pcbSvg(p, box, { width: 1000, height: 800 }, { side, extras: new Set(extras) as never }, measurePcb(p))
  }
  it("draws silkscreen text with the silkscreen, copper text in the layer's copper colour, and other layers' text only with courtyards", () => {
    const base = blinker()
    registerProjectParts(base)
    const before = svg(base)
    const silk = withText(base, { layer: "F.SilkS", text: "SILK", x: 3, y: 3 })
    expect(svg(silk)).not.toBe(before)
    expect(svg(silk, ["courtyards"])).toBe(svg(base, ["courtyards"]))
    const cu = withText(base, { layer: "F.Cu", text: "CU", x: 3, y: 3 })
    expect(svg(cu, [])).not.toBe(svg(base, []))
    const fab = withText(base, { layer: "F.Fab", text: "FAB", x: 3, y: 3 })
    expect(svg(fab, ["silkscreen"])).toBe(svg(base, ["silkscreen"]))
    expect(svg(fab, ["courtyards"])).not.toBe(svg(base, ["courtyards"]))
  })
  it("a board with no text draws as it did", () => {
    const base = blinker()
    registerProjectParts(base)
    expect(svg({ ...base, texts: [...base.texts] })).toBe(svg(base))
  })
})

describe("get_design", () => {
  const design = (p: Project) => JSON.parse(runTool(p, "get_design", {}).result) as { texts?: { count: number; by_layer: Record<string, number>; hidden: number; board: { layer: string; text: string }[]; parts_with_text: number } }
  it("says nothing of text for a board with none, and counts and lists it, compactly, for one that has", () => {
    const base = blinker()
    registerProjectParts(base)
    expect(design(base).texts).toBeUndefined()
    let p = base
    for (let i = 0; i < 30; i++) p = withText(p, { layer: i % 2 ? "F.SilkS" : "F.Fab", text: `T${i}`, x: i, y: 0 })
    const d = design(p).texts!
    expect(d.count).toBe(30)
    expect(d.by_layer).toEqual({ "F.SilkS": 15, "F.Fab": 15 })
    expect(d.board).toHaveLength(20)
    expect(d.board[0]).toMatchObject({ layer: "F.Fab", text: "T0" })
    expect(runTool(p, "get_design", {}).result).toContain("and 10 more board texts")
  })
})

describe("the 3D board", () => {
  type Entry = [string, ...unknown[]]
  let logs: Entry[][] = []
  const fake = (log: Entry[]): CanvasRenderingContext2D => {
    const state: Record<string, unknown> = {}
    return new Proxy({} as CanvasRenderingContext2D, {
      get(_t, key: string) {
        if (key in state) return state[key]
        // A canvas drawn onto another (the copper's, `buildSide`) is logged as one.
        return (...args: unknown[]) => void log.push([key, ...args.map((a) => (a && typeof a === "object" && "getContext" in a ? "canvas" : a))])
      },
      set(_t, key: string, value) {
        state[key] = value
        log.push(["set", key, value])
        return true
      },
    })
  }
  ;(globalThis as { document?: unknown }).document = { createElement: () => { const log: Entry[] = []; logs.push(log); return { width: 0, height: 0, getContext: () => fake(log) } } }
  afterAll(() => {
    delete (globalThis as { document?: unknown }).document
  })
  const draw = (p: Project) => {
    logs = []
    registerProjectParts(p)
    const placed = p.components.filter((c) => c.pcb.placed && isPhysical(findPart(c.partId)))
    paintBoardSides({ project: p, placed, padsByComponent: new Map(placed.map((c) => [c.id, pcbPads(c)])), fills: [] })
    return logs
  }
  it("asks the canvas for nothing more when there is no text", () => {
    const base = blinker()
    expect(draw({ ...base, texts: [...base.texts] })).toEqual(draw(base))
  })
  it("draws a top silkscreen text on the top albedo and surface canvases with its pen and the silkscreen's style", () => {
    const base = blinker()
    const before = draw(base)
    const p = withText(base, { layer: "F.SilkS", text: "3D", x: 5, y: 5, size: 2, thickness: 0.37 })
    const after = draw(p)
    // Each side has three canvases: its copper, its albedo and its surface.
    expect(after[1].length).toBeGreaterThan(before[1].length)
    expect(after[2].length).toBeGreaterThan(before[2].length)
    // the bottom side is the same
    expect(after.slice(3)).toEqual(before.slice(3))
    const widths = after[1].filter((e) => e[0] === "set" && e[1] === "lineWidth").map((e) => e[2])
    expect(widths).toContain(0.37)
  })
})

describe("the KiCad export", () => {
  async function exported(p: Project) {
    registerProjectParts(p)
    const { files, notes } = await kicadFiles(p)
    const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    return { pcb, notes }
  }
  /** A project with board text of every kind and a part with its own texts. */
  function rich() {
    let p = blinker()
    registerProjectParts(p)
    const c = p.components.find((x) => isPhysical(findPart(x.partId)) && x.pcb.placed)!
    p = withText(p, { layer: "F.SilkS", text: "Hello\nworld", x: 4, y: -3, rot: 33, size: 1.4, w: 1.1, thickness: 0.2, bold: true, italic: true, hj: "left", vj: "bottom" })
    p = withText(p, { layer: "B.Cu", text: "COPPER", x: 8, y: 2, size: 2, thickness: 0.3, mirror: true, knockout: true })
    p = withText(p, { layer: "Eco1.User", text: "~{OVER}bar", x: 1, y: 1, size: 1, hj: "right" })
    p = withText(p, { layer: "F.SilkS", text: "box wraps its words", x: 12, y: -2, size: 0.8, thickness: 0.12, box: { w: 6, h: 3, border: 0.2, margins: [0.3, 0.4, 0.5, 0.6] } })
    p = addPartText(p, c.id, { text: "${REFERENCE}!", at: { x: c.pcb.x + 2, y: c.pcb.y + 2 }, layer: "F.Fab" }).project
    return { p, c }
  }
  it("writes every text into the board file, and reading the file back finds each one with the same place, size, pen, angle, mirror, justification and flags", async () => {
    const { p } = rich()
    const { pcb } = await exported(p)
    const o = textOracle(pcb)
    const all = worldTexts(p)
    expect(all.length).toBeGreaterThanOrEqual(6)
    for (const t of all) {
      const shown = t.kind === "board" ? t.content : t.content
      const hit = [...o.board, ...o.footprints.flatMap((f) => f.texts)].find((x) => x.layerName === t.layer && x.raw === (t.kind === "reference" || t.kind === "value" ? x.raw : shown) && Math.abs(x.x - (100 + t.x)) < 1e-3 && Math.abs(x.y - (100 - t.y)) < 1e-3)
      expect(hit, `${t.kind} ${t.content} on ${t.layer}`).toBeTruthy()
      const h = hit!
      expect(Math.abs(((h.angle - t.rot) % 360 + 540) % 360 - 180)).toBeLessThan(1e-4)
      expect(h.mirror).toBe(t.mirror)
      expect([h.h, h.w]).toEqual([t.size, t.w])
      expect(Math.abs(h.thickness - t.thickness)).toBeLessThan(2e-6)
      expect([h.bold, h.italic, h.knockout]).toEqual([t.bold, t.italic, t.knockout])
      expect([h.hj, h.vj]).toEqual([t.hj, t.vj])
      expect(h.hide).toBe(t.hidden)
    }
    // the reader of this very importer takes the file whole
    const read = readKicadBoard(pcb).board
    // the board's texts and the editor's own two (the template's), which the converter writes as board text too
    expect(read.texts.length).toBe(all.filter((t) => t.kind === "board").length + (p.texts ?? []).filter((t) => t.layer === undefined).length)
  }, 120_000)
  it("a part with texts has its own reference and value, not the converter's, and a part with none keeps the converter's", async () => {
    const { p, c } = rich()
    const { pcb } = await exported(p)
    const block = (ref: string) => pcb.split(/\n {2}\(footprint\b/).slice(1).find((b) => b.includes(`(property "Reference" "${ref}"`))
    const own = block(c.ref)!
    expect((own.match(/\(property "Reference"/g) ?? []).length).toBe(1)
    expect(own).not.toMatch(/\(fp_text\s+reference/)
    // texts the part does not have are not invented: its value text is not there (it had only a reference and a text of its own)
    expect(own).toMatch(/\(fp_text user "\$\{REFERENCE\}!"/)
    const other = p.components.find((x) => x.id !== c.id && isPhysical(findPart(x.partId)))!
    expect(block(other.ref)).toMatch(/\(fp_text\s+reference/)
  }, 120_000)
  it("writes a text box as KiCad 9 stores it: the rectangle as drawn for a quarter turn, a polygon for another angle, and never knockout in its layer", async () => {
    let p = blinker()
    registerProjectParts(p)
    // 10 wide and 4 high in its own frame, centred on (7, 4); turned a quarter it is 4 wide and 10 high on the board
    p = withText(p, { layer: "F.SilkS", text: "turned", x: 7, y: 4, rot: 90, size: 1, thickness: 0.15, knockout: true, box: { w: 10, h: 4, border: 0.2, margins: [0.5, 0.5, 0.5, 0.5] } })
    p = withText(p, { layer: "F.SilkS", text: "slanted", x: 30, y: 4, rot: 33, size: 1, thickness: 0.15, box: { w: 10, h: 4, margins: [0.5, 0.5, 0.5, 0.5] } })
    const { pcb, notes } = await exported(p)
    const blocks = pcb.split(/\n {2}\(gr_text_box /).slice(1)
    expect(blocks).toHaveLength(2)
    const turned = blocks.find((b) => b.startsWith('"turned"'))!
    // page origin 100: x 100 + (7 - 2) to 100 + (7 + 2), y 100 - (4 + 5) to 100 - (4 - 5)
    expect(turned).toMatch(/\(start 105 91\)/)
    expect(turned).toMatch(/\(end 109 101\)/)
    expect(turned).toMatch(/\(angle 90\)/)
    expect(turned).toMatch(/\(layer "F\.SilkS"\)/)
    expect(turned).not.toMatch(/knockout/)
    expect(notes.join(" ")).toMatch(/text box has knockout, which KiCad 9 has no node for/)
    const slanted = blocks.find((b) => b.startsWith('"slanted"'))!
    expect(slanted).toMatch(/\(pts \(xy [-0-9.]+ [-0-9.]+\) \(xy [-0-9.]+ [-0-9.]+\) \(xy [-0-9.]+ [-0-9.]+\) \(xy [-0-9.]+ [-0-9.]+\)\)/)
    expect(slanted).not.toMatch(/\(start /)
    expect(slanted).toMatch(/\(angle 33\)/)
    // the file reads back through KiCad's rule for a 20241229 file: the oracle's own corners are the drawn rectangle's, turned a quarter
    const o = textOracle(pcb).board.find((t) => t.isBox && t.raw === "turned")!
    expect([o.box!.sx, o.box!.sy, o.box!.ex, o.box!.ey]).toEqual([105, 91, 109, 101])
    expect(o.knockout).toBe(false)
  }, 120_000)
  it("a board with no KiCad text writes the same file as before (the notes say nothing of text)", async () => {
    const base = blinker()
    const a = await exported(base)
    expect(a.notes.join(" ")).not.toMatch(/Text \(board text/)
    expect(a.pcb).not.toMatch(/\(gr_text /)
  }, 120_000)
})

describe("Circuit JSON", () => {
  it("has silkscreen, copper and fabrication text with their size, place, turn, mirror and knockout, and says what it left out", () => {
    const base = blinker()
    registerProjectParts(base)
    let p = withText(base, { layer: "F.SilkS", text: "SILK", x: 3, y: 3, rot: 90, size: 1.2, hj: "left", vj: "top" })
    p = withText(p, { layer: "B.Cu", text: "CU", x: 4, y: 4, knockout: true, mirror: true })
    p = withText(p, { layer: "F.Fab", text: "FAB", x: 5, y: 5 })
    p = withText(p, { layer: "Dwgs.User", text: "USER", x: 6, y: 6 })
    p = withText(p, { layer: "F.SilkS", text: "boxed", x: 7, y: 7, box: { w: 4, h: 2, border: 0.1, margins: [0.2, 0.2, 0.2, 0.2] } })
    const { elements, notes } = projectToCircuitJson(p)
    const find = (type: string, text: string) => elements.find((e) => e.type === type && (e as { text?: string }).text === text) as Record<string, unknown> | undefined
    expect(find("pcb_silkscreen_text", "SILK")).toMatchObject({ layer: "top", font_size: 1.2, ccw_rotation: 90, anchor_alignment: "top_left", anchor_position: { x: 3, y: 3 } })
    expect(find("pcb_copper_text", "CU")).toMatchObject({ layer: "bottom", is_knockout: true, is_mirrored: true })
    expect(find("pcb_fabrication_note_text", "FAB")).toMatchObject({ layer: "top" })
    expect(find("pcb_silkscreen_text", "USER")).toBeUndefined()
    expect(notes.join(" ")).toMatch(/Text left out, since Circuit JSON has no element for it: 1 on user layer/)
    expect(notes.join(" ")).toMatch(/1 text box is written as its text alone/)
  })
  it("a board with no text has none of them", () => {
    const base = blinker()
    registerProjectParts(base)
    const { elements, notes } = projectToCircuitJson(base)
    expect(elements.some((e) => e.type === "pcb_copper_text")).toBe(false)
    expect(notes.join(" ")).not.toMatch(/Text:/)
  })
})

describe("the fabrication notes", () => {
  it("count the texts by the file they are in, the knockouts, the hidden, the unplaced and what is not plotted", () => {
    const base = blinker()
    registerProjectParts(base)
    let p = withText(base, { layer: "F.SilkS", text: "A", x: 1, y: 1 })
    p = withText(p, { layer: "F.Cu", text: "B", x: 2, y: 2, knockout: true })
    p = withText(p, { layer: "F.Fab", text: "C", x: 3, y: 3 })
    const c = p.components.find((x) => isPhysical(findPart(x.partId)))!
    p = addPartText(p, c.id, { text: "D", at: { x: c.pcb.x, y: c.pcb.y } }).project
    const notes = fabricationNotes(p, [], buildCopperItems(p, computeConnectivity(p)))
    expect(notes).toMatch(/\nTEXT\n/)
    expect(notes).toMatch(/Top silkscreen\s+3: in the top silkscreen file/)
    expect(notes).toMatch(/Top copper\s+1: in the top copper file, as copper that belongs to no net/)
    expect(notes).toMatch(/Knockout\s+1/)
    expect(notes).toMatch(/Not plotted\s+fabrication 1/)
    expect(fabricationNotes(base, [], buildCopperItems(base, computeConnectivity(base)))).not.toMatch(/\nTEXT\n/)
  })
})

describe("editing a text keeps the board whole", () => {
  it("changing a text's layer, size or content changes what is plotted", () => {
    const base = blinker()
    registerProjectParts(base)
    const p = withText(base, { layer: "F.SilkS", text: "AAA", x: 2, y: 2 })
    const id = p.texts.at(-1)!.id
    const moved = updateBoardTexts(p, [id], { layer: "B.SilkS" })
    expect(gerberLayers(moved).F_Silkscreen).toBe(gerberLayers(base).F_Silkscreen)
    expect(gerberLayers(moved).B_Silkscreen).not.toBe(gerberLayers(base).B_Silkscreen)
    const bigger = updateBoardTexts(p, [id], { size: 4 })
    expect(gerberLayers(bigger).F_Silkscreen).not.toBe(gerberLayers(p).F_Silkscreen)
  })
})
