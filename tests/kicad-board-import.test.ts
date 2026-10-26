import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { pcbPads, slotEnds } from "../src/model/instances"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { EXTENSION_NAMES, formatSize, importKicadBoard, PROJECT_SIZE_LIMIT_BYTES, type KicadImportResult } from "../src/model/kicad/board"
import { rotK } from "../src/model/kicad/board/geometry"
import { board, footprint, pad } from "./kicad-board-fixtures"

// The importer end to end: the gate (what it refuses and how it says so), and the project it
// builds, with every extension treated as built so the build path can be exercised on boards that
// the real gate still refuses for their text and graphics. The project is checked against the
// file: every pad where the file has it, every pad on the net the file gives it.

const ALL = new Set(Object.keys(EXTENSION_NAMES))
const imported = (text: string, extra: object = {}) => {
  const r = importKicadBoard(text, { built: ALL, ...extra })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}
const netOf = (r: Extract<KicadImportResult, { status: "imported" }>, ref: string, pin: string) => {
  const c = r.project.components.find((x) => x.ref === ref)!
  return computeConnectivity(r.project).pinNet.get(pinKey(c.id, pin))
}

describe("the gate", () => {
  const simple = board({ nets: ['(net 0 "")', '(net 1 "GND")'], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "GND")' }), pad({ number: "2", at: "1 0" })] })] })

  // a via with protection (KiCad 10's capping, covering, plugging and filling) needs X22, which is not built
  const rounded = board({ body: [footprint({ pads: [pad({ at: "0 0" })] }), '(via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (capping yes) (net 0))'] })

  it("refuses a board that uses what the editor cannot hold yet, naming it, and imports nothing", () => {
    const r = importKicadBoard(rounded)
    expect(r.status).toBe("refused")
    if (r.status !== "refused") return
    expect(r.reason).toBe("unsupported")
    expect(r.message).toMatch(/^This board uses .+, which (is|are) not supported yet\.$/)
    expect(r.message).toMatch(/via protection/)
    expect(r.needs.map((n) => n.ext)).toEqual(["X22"])
    expect(r.report.entries.some((e) => e.code === "unsupported" && e.severity === "refused")).toBe(true)
  })

  it("names every extension a board needs in the one sentence", () => {
    const r = importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "0 0" })] }), '(via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (capping yes) (net 0))', '(segment (start 0 0) (end 5 0) (width 0.2) (layer "F.Cu") (net 0))', '(gr_text "x" (at 3 3) (layer "F.SilkS") (effects (font (face "Arial") (size 1 1) (thickness 0.15))))'] }))
    // X13 (nets on tracks and vias) and X9 (text) are built: a board's tracks and its text are no reason to refuse it; a font of the computer is
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toEqual(["X19", "X22"])
    if (r.status === "refused") expect(r.message).toMatch(/text in a font other than KiCad's own.+via protection.+, which are not supported yet\./)
  })

  it("a board that needs nothing the editor lacks is imported (every extension built, for the test)", () => {
    expect(imported(simple).status).toBe("imported")
  })

  it("a refusal lists nothing it did not find: a plain board with no footprint imports at once", () => {
    const r = importKicadBoard(board({}))
    expect(r.status).toBe("imported")
  })

  it("accounts for every node of the file: imported, not needed with its reason, pending, or reported", () => {
    const r = importKicadBoard(rounded)
    const a = r.report.account!
    expect(a.unknownPaths.size).toBe(0)
    expect(a.unknownAtoms.size).toBe(0)
    const sum = a.imported + [...a.notNeeded.values()].reduce((x, y) => x + y, 0) + [...a.pending.values()].reduce((x, y) => x + y, 0) + a.reported
    expect(sum).toBe(a.total)
    expect(a.pending.get("X22")).toBeGreaterThan(0)
    // text is built: its nodes are counted as imported, not left pending
    expect(a.pending.get("X9")).toBeUndefined()
  })
})

describe("the project", () => {
  const two = board({
    nets: ['(net 0 "")', '(net 1 "GND")', '(net 2 "Net-(R1-Pad2)")', '(net 3 "/Sheet1/SIG{slash}A")'],
    body: [
      footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "GND")' }), pad({ number: "2", at: "1 0", net: '(net 2 "Net-(R1-Pad2)")' })] }),
      footprint({ ref: "C1", name: "Capacitor_SMD:C_0603_1608Metric", at: "12 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 2 "Net-(R1-Pad2)")' }), pad({ number: "2", at: "1 0", net: '(net 3 "/Sheet1/SIG{slash}A")' })] }),
    ],
  })

  it("keeps every net's name, escaped ones and unnamed Net-(...) ones included, and puts every pin on its net", () => {
    const r = imported(two)
    expect(netOf(r, "R1", "1")).toBe("net:GND")
    expect(netOf(r, "R1", "2")).toBe("net:Net-(R1-Pad2)")
    expect(netOf(r, "C1", "1")).toBe("net:Net-(R1-Pad2)")
    expect(netOf(r, "C1", "2")).toBe("net:/Sheet1/SIG/A")
    expect(computeConnectivity(r.project).nets.map((n) => n.name).sort()).toEqual(["/Sheet1/SIG/A", "GND", "Net-(R1-Pad2)"])
  })

  it("a pad with no net has no label, and its pin is on no net", () => {
    const r = imported(board({ nets: ['(net 0 "")', '(net 1 "A")'], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "A")' }), pad({ number: "2", at: "1 0", net: '(net 0 "")' })] })] }))
    expect(netOf(r, "R1", "2")).toBeUndefined()
    expect(r.project.labels.map((l) => l.name)).toEqual(["A"])
  })

  it("two nets joined by nothing stay apart, and two pins of one net on different parts are joined", () => {
    const r = imported(two)
    const c = computeConnectivity(r.project)
    const nets = new Set([...c.pinNet.values()])
    expect(nets.size).toBe(3)
  })

  it("gives parts a land of their own, shared between footprints with the same pads", () => {
    const r = imported(board({ body: [footprint({ ref: "R1", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] }), footprint({ ref: "R2", at: "9 0", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] })] }))
    expect(r.project.footprints).toHaveLength(1)
    expect(r.project.components.map((c) => c.footprint)).toEqual([r.project.footprints![0].name, r.project.footprints![0].name])
    expect(r.project.parts).toHaveLength(1)
  })

  it("keeps a part's value, its place (y flipped), its side and its lock", () => {
    const r = imported(board({ body: [footprint({ ref: "R1", value: "4k7", at: "10 20 90", pads: [pad({ at: "0 0" })], extra: "locked" })] }))
    const c = r.project.components[0]
    expect(c.props.value).toBe("4k7")
    expect(c.pcb).toMatchObject({ x: 10, y: -20, rot: 90, side: "top", placed: true, locked: true })
  })

  it("renames what must be unique, and says so", () => {
    const r = imported(board({ body: [footprint({ ref: "R1", pads: [pad({ at: "0 0" })] }), footprint({ ref: "R1", at: "5 0", pads: [pad({ at: "0 0" })] }), footprint({ ref: "REF**", at: "10 0", pads: [pad({ at: "0 0" })] }), footprint({ ref: "", at: "15 0", pads: [pad({ at: "0 0" })] })] }))
    const refs = r.project.components.map((c) => c.ref)
    expect(new Set(refs).size).toBe(4)
    expect(refs).toContain("R1")
    expect(refs).toContain("R1_2")
    expect(r.report.entries.some((e) => e.code === "renamed-ref" && e.count === 3)).toBe(true)
  })

  it("a part with no pads comes in as a part with no pins on a land with no pads, and the report says so", () => {
    const r = importKicadBoard(board({ body: [footprint({ ref: "G1", name: "Symbol:Logo", pads: [], extra: '(fp_line (start -1 0) (end 1 0) (stroke (width 0.15) (type solid)) (layer "F.SilkS"))' })] }), { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.parts?.[0].pins).toEqual([])
    expect(r.project.footprints?.[0].pads).toEqual([])
    expect(r.project.footprints?.[0].shapes).toHaveLength(1)
    expect(r.report.entries.some((e) => e.code === "parts-without-pins")).toBe(true)
  })

  it("takes the board's size and corner radius from its outline, y flipped", () => {
    const r = imported(board({ outline: '(gr_rect (start 10 -4) (end 40 16) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' }))
    expect(r.project.board).toMatchObject({ width: 30, height: 20, x: 25, y: -6, cornerRadius: 0, thickness: 1.6 })
  })

  it("joins track segments of one net, layer and width into a polyline, and flips y", () => {
    const seg = (a: string, b: string, layer = "F.Cu", net = "(net 0)") => `(segment (start ${a}) (end ${b}) (width 0.25) (layer "${layer}") ${net})`
    const r = imported(board({ body: [seg("0 0", "5 0"), seg("5 0", "5 5"), seg("5 5", "9 5"), seg("0 8", "4 8", "B.Cu"), '(via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 0))'] }))
    expect(r.project.traces).toHaveLength(2)
    const top = r.project.traces.find((t) => t.layer === "top")!
    expect(top.points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: -5 }, { x: 9, y: -5 }])
    expect(r.project.traces.find((t) => t.layer === "bottom")!.points).toHaveLength(2)
    expect(r.project.vias[0]).toMatchObject({ x: 5, y: -5, diameter: 0.8, drill: 0.4 })
  })

  it("takes the design rules the file has: a KiCad 5 default net class, and setup values", () => {
    const r = imported(board({ version: 20171130, setup: "(setup (last_trace_width 0.3) (trace_min 0.15) (zone_clearance 0.4) (edge_clearance 0.2) (pad_to_mask_clearance 0.05) (via_min_drill 0.3))", body: ['(net_class Default "d" (clearance 0.25) (trace_width 0.3) (via_dia 0.9) (via_drill 0.5) (uvia_dia 0.3) (uvia_drill 0.1) (add_net GND))'] }))
    expect(r.project.rules).toMatchObject({ traceWidth: 0.3, minTraceWidth: 0.15, clearance: 0.25, viaDiameter: 0.9, viaDrill: 0.5, pourClearance: 0.4, edgeClearance: 0.2, maskExpansion: 0.05, minDrill: 0.3 })
  })

  it("survives the project file: serialised and read back it has the same parts and the same nets", () => {
    const r = imported(two)
    const back = parseProjectFile(serializeProject(r.project), { id: "x", createdAt: 0, updatedAt: 0 })
    expect(back.components.map((c) => c.ref)).toEqual(r.project.components.map((c) => c.ref))
    expect(computeConnectivity(back).nets.map((n) => [n.name, n.pins.length])).toEqual(computeConnectivity(r.project).nets.map((n) => [n.name, n.pins.length]))
  })

  it("brings a stock KiCad 3D model across as a model assignment and names any other", () => {
    const stock = '(model "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))'
    const own = '(model "${KIPRJMOD}/models/mine.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))'
    const r = imported(board({ body: [footprint({ ref: "R1", pads: [pad({ at: "0 0" })], extra: stock }), footprint({ ref: "U1", name: "My:Thing", at: "9 0", pads: [pad({ at: "0 0" })], extra: own })] }))
    expect(r.project.models).toHaveLength(1)
    expect(r.project.models![0].model).toMatchObject({ source: "kicad", id: "10.0.7/Resistor_SMD.3dshapes/R_0603_1608Metric.step", format: "step" })
    expect(r.report.entries.filter((e) => e.code === "model-not-brought").map((e) => e.object)).toEqual(["3D model ${KIPRJMOD}/models/mine.step of U1"])
  })
})

describe("the size limit", () => {
  it("is the storage limit, 900 KB", () => {
    expect(PROJECT_SIZE_LIMIT_BYTES).toBe(900 * 1024)
  })

  it("refuses a project over the limit before anything is saved, naming the size and the limit", () => {
    const body = Array.from({ length: 60 }, (_, i) => footprint({ ref: `R${i + 1}`, at: `${i * 3} 0`, pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] }))
    const r = importKicadBoard(board({ body }), { built: ALL, limitBytes: 5 * 1024 })
    expect(r.status).toBe("refused")
    if (r.status !== "refused") return
    expect(r.reason).toBe("too-large")
    expect(r.message).toMatch(/^This board needs \d+ KB and projects hold up to 5 KB\.$/)
    expect(r.report.entries.some((e) => e.code === "too-large")).toBe(true)
  })

  it("measures the size with serializeProject: what is refused is what would have been stored", () => {
    const text = board({ body: Array.from({ length: 20 }, (_, i) => footprint({ ref: `R${i + 1}`, at: `${i * 3} 0`, pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] })) })
    const ok = importKicadBoard(text, { built: ALL })
    expect(ok.status).toBe("imported")
    if (ok.status !== "imported") return
    expect(ok.bytes).toBe(new TextEncoder().encode(serializeProject(ok.project)).length)
    const edge = importKicadBoard(text, { built: ALL, limitBytes: ok.bytes })
    expect(edge.status).toBe("imported")
    const over = importKicadBoard(text, { built: ALL, limitBytes: ok.bytes - 1 })
    expect(over.status).toBe("refused")
  })

  it("says sizes in KB and MB", () => {
    expect(formatSize(900 * 1024)).toBe("900 KB")
    expect(formatSize(1.4 * 1024 * 1024)).toBe("1.4 MB")
  })
})

describe("orientation: an asymmetric pad on a turned footprint, top and bottom", () => {
  // A pad 2.0 by 0.5 whose centre is off the footprint's origin at (1.2, 0.6), at every footprint turn
  // and every pad angle the file can write, on each side. The expected place and size come from the
  // rule of docs/kicad-import.md 2.4 applied to the raw numbers: board = footprint + R(angle) * pad,
  // the pad's angle absolute, so its long side lies along the pad's angle in the board frame.
  const cases: { side: "top" | "bottom"; fa: number; pa: number }[] = []
  for (const side of ["top", "bottom"] as const) for (const fa of [0, 90, 180, 270]) for (const pa of [0, 90, 180, 270]) cases.push({ side, fa, pa })

  it.each(cases)("$side footprint at $fa, pad at $pa", ({ side, fa, pa }) => {
    const text = board({ body: [footprint({ ref: "U1", at: `30 20 ${fa}`, layer: side === "top" ? "F.Cu" : "B.Cu", pads: [pad({ number: "1", at: `1.2 0.6 ${pa}`, size: "2 0.5", layers: side === "top" ? '"F.Cu"' : '"B.Cu"' })] })] })
    const r = imported(text)
    const [world] = pcbPads(r.project.components[0])
    const off = rotK(1.2, 0.6, fa)
    expect(world.x).toBeCloseTo(30 + off.x, 3)
    expect(world.y).toBeCloseTo(-(20 + off.y), 3)
    const long = pa % 180 === 0 ? { width: 2, height: 0.5 } : { width: 0.5, height: 2 }
    expect(world.width).toBeCloseTo(long.width, 6)
    expect(world.height).toBeCloseTo(long.height, 6)
    expect(world.layers).toEqual([side])
  })

  it("a pad turned by other than a quarter turn is refused as X7, not imported at a quarter turn", () => {
    const r = importKicadBoard(board({ body: [footprint({ at: "30 20 90", pads: [pad({ at: "1 0 45", size: "2 0.5" })] })] }), { built: new Set(Object.keys(EXTENSION_NAMES).filter((x) => x !== "X7")) })
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toEqual(["X7"])
  })

  it("a hole drilled 0.3 mm off the pad's centre is refused as X7, and read exactly", () => {
    const text = board({ body: [footprint({ at: "30 20 90 ", layer: "B.Cu", pads: [pad({ number: "1", type: "thru_hole", shape: "rect", at: "1.2 0.6 90", size: "2 0.5", layers: "*.Cu *.Mask", extra: "(drill 0.4 (offset 0.3 0))" })] })] })
    const r = importKicadBoard(text, { built: new Set(Object.keys(EXTENSION_NAMES).filter((x) => x !== "X7")) })
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toEqual(["X7"])
    if (r.status === "refused") expect(r.board!.footprints[0].pads[0].drill).toEqual({ oval: false, w: 0.4, h: 0.4, offset: { x: 0.3, y: 0 } })
  })

  it("a trapezoid on a turned bottom footprint keeps its outline where the file has it", () => {
    for (const fa of [0, 90, 270]) {
      const text = board({ body: [footprint({ ref: "U1", at: `30 20 ${fa}`, layer: "B.Cu", pads: [pad({ number: "1", shape: "trapezoid", at: `1.2 0.6 ${fa}`, size: "2 1", layers: '"B.Cu"', extra: "(rect_delta 0 0.6)" })] })] })
      const r = imported(text)
      const [world] = pcbPads(r.project.components[0])
      // KiCad's trapezoid: corners (-dx - ddy, dy + ddx), (-dx + ddy, -dy - ddx), (dx - ddy, -dy + ddx), (dx + ddy, dy - ddx) in the pad's own frame, turned by its angle
      const dx = 1
      const dy = 0.5
      const ddy = 0.3
      const ddx = 0
      const corners = [
        [-dx - ddy, dy + ddx],
        [-dx + ddy, -dy - ddx],
        [dx - ddy, -dy + ddx],
        [dx + ddy, dy - ddx],
      ]
      const centre = rotK(1.2, 0.6, fa)
      const expected = corners.map(([x, y]) => {
        const t = rotK(x, y, fa)
        return { x: 30 + centre.x + t.x, y: -(20 + centre.y + t.y) }
      })
      const key = (p: { x: number; y: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`
      expect(world.points!.map(key).sort()).toEqual(expected.map(key).sort())
    }
  })
})

describe("speed", () => {
  it("imports a 2,000-pad board with tracks in reasonable time", () => {
    const parts: string[] = []
    const nets: string[] = ['(net 0 "")']
    const segs: string[] = []
    for (let i = 0; i < 500; i++) {
      const x = (i % 25) * 6
      const y = Math.floor(i / 25) * 6
      const n = (k: number) => `(net ${((i * 4 + k) % 700) + 1} "N${((i * 4 + k) % 700) + 1}")`
      parts.push(footprint({ ref: `U${i + 1}`, at: `${x} ${y}`, pads: [0, 1, 2, 3].map((k) => pad({ number: String(k + 1), at: `${k % 2 ? 1 : -1} ${k < 2 ? -1 : 1}`, net: n(k) })) }))
      segs.push(`(segment (start ${x} ${y}) (end ${x + 3} ${y}) (width 0.2) (layer "F.Cu") (net 1))`)
    }
    for (let k = 1; k <= 700; k++) nets.push(`(net ${k} "N${k}")`)
    const text = board({ nets, body: [...parts, ...segs], outline: '(gr_rect (start -5 -5) (end 160 90) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' })
    const t0 = performance.now()
    const r = imported(text, { limitBytes: 50 * 1024 * 1024 })
    const ms = performance.now() - t0
    process.stderr.write(`[2,000-pad import: ${ms.toFixed(0)} ms, ${(r.bytes / 1024).toFixed(0)} KB project]\n`)
    expect(r.project.components).toHaveLength(500)
    expect(ms).toBeLessThan(20_000)
  })
})

describe("slots and ovals on a turned footprint", () => {
  it("a slot along an oval pad's long side turns with the part", () => {
    for (const [fa, vertical] of [[0, false], [90, true], [180, false], [270, true]] as const) {
      // an oval through-hole pad 1.6 by 1.0 with a 1.2 by 0.6 slot along x, its angle the footprint's: written as KiCad writes it
      const text = board({ body: [footprint({ ref: "J1", at: `20 10 ${fa}`, pads: [pad({ number: "1", type: "thru_hole", shape: "oval", at: `0 0 ${fa}`, size: "1.6 1", layers: "*.Cu *.Mask", extra: "(drill oval 1.2 0.6)" })] })] })
      const [world] = pcbPads(imported(text).project.components[0])
      expect(world.shape).toBe("pill")
      expect(world.width).toBeCloseTo(vertical ? 1 : 1.6, 6)
      expect(world.height).toBeCloseTo(vertical ? 1.6 : 1, 6)
      expect(world.holeDiameter).toBeCloseTo(0.6, 6)
      expect(world.slotLength).toBeCloseTo(1.2, 6)
      const ends = slotEnds(world)!
      expect(Math.abs(ends[0].x - ends[1].x) < 1e-6).toBe(vertical)
    }
  })

  it("a slot across the pad's long side is held across it (X7), turning with the part", () => {
    for (const fa of [0, 90, 180, 270]) {
      const text = board({ body: [footprint({ at: `20 10 ${fa}`, pads: [pad({ number: "1", type: "thru_hole", shape: "oval", at: `0 0 ${fa}`, size: "1.6 1", layers: "*.Cu *.Mask", extra: "(drill oval 0.6 1.2)" })] })] })
      const [world] = pcbPads(imported(text).project.components[0])
      // the pad is 1.6 along the part's x and the slot 1.2 along its y: across the pad
      const ends = slotEnds(world)!
      const alongX = (fa / 90) % 2 === 0
      expect(Math.abs(ends[0].x - ends[1].x) < 1e-6).toBe(alongX)
      expect(Math.abs(ends[0].y - ends[1].y) < 1e-6).toBe(!alongX)
      expect(world.slotLength).toBeCloseTo(1.2, 6)
      expect(world.holeDiameter).toBeCloseTo(0.6, 6)
    }
  })

  it("a non-plated hole is a hole with no pin and no copper", () => {
    const hole = pad({ number: "", type: "np_thru_hole", shape: "circle", at: "0 0", size: "3.2 3.2", layers: "*.Cu *.Mask", extra: "(drill 3.2)" })
    const r = imported(board({ body: [footprint({ ref: "H1", name: "Module:WithAHole", at: "5 5", pads: [hole, pad({ number: "1", at: "5 0" })] })] }))
    const [world] = pcbPads(r.project.components[0])
    expect(world.plated).toBe(false)
    expect(world.pin).toBeNull()
    expect(world.holeDiameter).toBe(3.2)
  })
})

describe("parts with no pins", () => {
  it("a mounting hole, a footprint whose only pad is a non-plated hole, needs the graphics extension: a part has a pin or it is not drawn", () => {
    const text = board({ body: [footprint({ ref: "H1", name: "MountingHole:MountingHole_3.2mm_M3", at: "5 5", pads: [pad({ number: "", type: "np_thru_hole", shape: "circle", at: "0 0", size: "3.2 3.2", layers: "*.Cu *.Mask", extra: "(drill 3.2)" })] })] })
    const r = importKicadBoard(text, { built: new Set(Object.keys(EXTENSION_NAMES).filter((x) => x !== "X8")) })
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toEqual(["X8"])
  })
})

describe("files that are damaged never crash or hang", () => {
  const full = board({
    nets: ['(net 0 "")', '(net 1 "GND")'],
    body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "GND")' }), pad({ number: "2", at: "1 0" })] }), '(segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1))'],
  })

  it("every cut of a board gives a refusal or an import, not an exception", () => {
    for (let cut = 0; cut < full.length; cut += 17) {
      const r = importKicadBoard(full.slice(0, cut), { built: ALL })
      expect(["imported", "refused"]).toContain(r.status)
    }
  })

  it("odd bytes: a lone byte order mark, binary noise and a very long line", () => {
    for (const text of ["﻿", " (kicad_pcb", "(".repeat(100000), "x".repeat(2_000_000), '(kicad_pcb (version 20240108) (net 0 ""' + " (a)".repeat(100000)]) {
      const t0 = performance.now()
      const r = importKicadBoard(text)
      expect(r.status).toBe("refused")
      expect(performance.now() - t0).toBeLessThan(5000)
    }
    const noise = new Uint8Array(100000).map((_, i) => (i * 2654435761) >>> 24)
    expect(importKicadBoard(noise).status).toBe("refused")
  })

  it("a pad number repeated on two nets is X7 (its own pin and net on every pad), no refusal", () => {
    const text = board({ nets: ['(net 0 "")', '(net 1 "A")', '(net 2 "B")'], body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")' }), pad({ number: "1", at: "2 0", net: '(net 2 "B")' })] })] })
    const r = imported(text)
    expect(netOf(r, "U1", "1")).toBe("net:A")
    expect(netOf(r, "U1", "1.2")).toBe("net:B")
    // the land keeps the file's number on both, for the KiCad writer
    const land = r.project.footprints![0]
    expect(land.pads.map((p) => [p.pin, p.number])).toEqual([["1", undefined], ["1.2", "1"]])
    expect(pcbPads(r.project.components[0]).map((p) => p.padNumber)).toEqual(["1", "1"])
  })

  it("an unnumbered pad that carries a net has a pin of its own, and its net", () => {
    const text = board({ nets: ['(net 0 "")', '(net 1 "A")'], body: [footprint({ ref: "U1", pads: [pad({ number: "", at: "0 0", net: '(net 1 "A")' }), pad({ number: "1", at: "2 0" })] })] })
    const r = imported(text)
    expect(netOf(r, "U1", "_1")).toBe("net:A")
    expect(netOf(r, "U1", "1")).toBeUndefined()
    expect(r.project.footprints![0].pads.map((p) => [p.pin, p.number])).toEqual([["_1", ""], ["1", undefined]])
    expect(pcbPads(r.project.components[0])[0].padNumber).toBeNull()
  })
})
