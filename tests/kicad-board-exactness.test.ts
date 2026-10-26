import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { partHolder } from "../src/editor/three/buildBoard"
import { placementMatrix } from "../src/editor/three/files/placement"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { componentTexts } from "../src/model/texts"
import { buildKicadProject, EXTENSION_NAMES, importKicadBoard, outlineOf, readKicadBoard, type ImportReport } from "../src/model/kicad/board"
import { accountNodes, countPaths, scanAtoms } from "../src/model/kicad/board/account"
import { settleFor } from "../src/model/kicad/board/carried"
import { rotK } from "../src/model/kicad/board/geometry"
import { needsOf, unbuilt } from "../src/model/kicad/board/needs"
import { stockModelId } from "../src/model/kicad/board/models"
import { board, footprint, pad } from "./kicad-board-fixtures"

// The round-1 fixes of slice 1a, each with the board that needed it: pad layer sets, nets by their
// raw names, the accounting of every word, concave corners, the bottom side's land and models.

const ALL = new Set(Object.keys(EXTENSION_NAMES))
const WITHOUT = (...x: string[]) => new Set([...ALL].filter((e) => !x.includes(e)))
const needsOf1 = (text: string, built: ReadonlySet<string> = new Set()) => {
  const r = importKicadBoard(text, { built })
  return r.status === "refused" ? r.needs.map((n) => n.ext) : []
}
const x7 = (text: string) => needsOf1(text, WITHOUT("X7")).includes("X7")
const layersOf = (layers: string, type = "smd", extra: Partial<Parameters<typeof pad>[0]> = {}, fp: Partial<Parameters<typeof footprint>[0]> = {}) =>
  board({ body: [footprint({ ...fp, pads: [pad({ at: "0 0", type, layers, size: "1 1", ...(type === "thru_hole" ? { extra: "(drill 0.5)" } : type === "np_thru_hole" ? { extra: "(drill 1)" } : {}), ...extra })] })] })

describe("B1: a pad's copper, mask and paste against what the editor draws for its type and side", () => {
  it("a plain surface-mount pad, a through-hole pad and a plain non-plated hole need nothing of X7", () => {
    expect(x7(layersOf('"F.Cu" "F.Paste" "F.Mask"'))).toBe(false)
    expect(x7(layersOf('"*.Cu" "*.Mask"', "thru_hole"))).toBe(false)
    expect(x7(layersOf('"*.Cu" "*.Mask"', "np_thru_hole"))).toBe(false)
  })
  it("pcbench filament_extruder_sensor: (layers F.Cu) alone has no mask opening", () => {
    expect(x7(layersOf('"F.Cu"'))).toBe(true)
  })
  it("pcbench tiny-8088_Computer: (layers F.Cu F.Mask) has no paste", () => {
    expect(x7(layersOf('"F.Cu" "F.Mask"'))).toBe(true)
  })
  it("minima-hardware FrontPanel: a connect pad (layers B.Cu F.Mask) on a top part is checked like a surface-mount pad", () => {
    expect(x7(layersOf('"B.Cu" "F.Mask"', "connect", { shape: "trapezoid", extra: "(rect_delta 0 0.2)" }))).toBe(true)
    // a connect pad with the layers the editor draws is fine, and one without paste is not (the editor pastes every surface-mount pad)
    expect(x7(layersOf('"F.Cu" "F.Paste" "F.Mask"', "connect"))).toBe(false)
    expect(x7(layersOf('"F.Cu" "F.Mask"', "connect"))).toBe(true)
  })
  it("a bottom part's surface-mount pads are on the bottom; front layers on it are the other side", () => {
    expect(x7(layersOf('"B.Cu" "B.Paste" "B.Mask"', "smd", {}, { layer: "B.Cu" }))).toBe(false)
    expect(x7(layersOf('"F.Cu" "F.Paste" "F.Mask"', "smd", {}, { layer: "B.Cu" }))).toBe(true)
  })
  it("a through-hole pad with copper on one side only, or no mask, is X7", () => {
    expect(x7(layersOf('"F.Cu" "*.Mask"', "thru_hole"))).toBe(true)
    expect(x7(layersOf('"*.Cu"', "thru_hole"))).toBe(true)
  })
  it("a non-plated hole with no mask, or mask on one side, is X7 (the editor opens the mask on both)", () => {
    expect(x7(layersOf("", "np_thru_hole"))).toBe(true)
    expect(x7(layersOf('"F.Mask"', "np_thru_hole"))).toBe(true)
    expect(x7(layersOf('"*.Mask"', "np_thru_hole"))).toBe(false)
  })
  it("a pad on a drawing layer is X7, and a pad that lists the silkscreen is X7 only when the board plots pads on it", () => {
    expect(x7(layersOf('"F.Cu" "F.Paste" "F.Mask" "Dwgs.User"'))).toBe(true)
    const silk = (padsonsilk: string) => board({ setup: `(setup (pad_to_mask_clearance 0) (pcbplotparams (padsonsilk ${padsonsilk})))`, body: [footprint({ pads: [pad({ at: "0 0", type: "thru_hole", layers: '"*.Cu" "*.Mask" "F.SilkS"', extra: "(drill 0.5)" })] })] })
    expect(x7(silk("false"))).toBe(false)
    expect(x7(silk("true"))).toBe(true)
  })
  it("names the reason in the refusal", () => {
    const r = importKicadBoard(layersOf('"F.Cu"'), { built: WITHOUT("X7") })
    expect(r.status === "refused" && r.report.entries.find((e) => e.code === "unsupported")?.why).toMatch(/solder mask/)
  })
})

describe("B2 and M2: nets are the file's, by raw name, pad by pad", () => {
  const BP1 = board({
    nets: ['(net 0 "")', '(net 1 "GND")'],
    body: [footprint({ ref: "BP1", pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "GND")' }), pad({ number: "1", at: "1 0" }), pad({ number: "2", at: "3 0" })] })],
  })
  it("a pad number with a net and the same number with none is X7 (a pin each), imported with the netless one marked no connect", () => {
    const r = importKicadBoard(BP1)
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const c = r.project.components[0]
    const { pinNet } = computeConnectivity(r.project)
    expect(pinNet.get(pinKey(c.id, "1"))).toBe("net:GND")
    expect(pinNet.get(pinKey(c.id, "1.2"))).toBeUndefined()
    expect(c.nc).toEqual(["1.2", "2"])
    expect(r.report.entries.some((e) => e.code === "pad-number-two-nets" || e.code === "net-mismatch")).toBe(false)
  })
  it("two nets on one number is the same need", () => {
    const text = board({ nets: ['(net 0 "")', '(net 1 "A")', '(net 2 "B")'], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "A")' }), pad({ number: "1", at: "1 0", net: '(net 2 "B")' })] })] })
    expect(needsOf1(text)).toContain("X7")
  })
  it("the netless pad does not join the net: it has a pin of its own, and the build is exact", () => {
    const read = readKicadBoard(BP1)
    const report: ImportReport = { entries: [], account: null }
    const built = buildKicadProject(read.board, outlineOf(read.board), report, { allowLossy: true })
    expect(built.lossy).toEqual([])
    expect(report.entries.some((e) => e.code === "net-mismatch")).toBe(false)
    expect(built.project.footprints![0].pads.map((p) => p.pin)).toEqual(["1", "1.2", "2"])
  })
  it("/A/B and /A{slash}B are two nets with two labels, and a single /A{slash}B is labelled /A/B", () => {
    const two = board({ nets: ['(net 0 "")', '(net 1 "/A/B")', '(net 2 "/A{slash}B")'], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "/A/B")' }), pad({ number: "2", at: "1 0", net: '(net 2 "/A{slash}B")' })] })] })
    const r = importKicadBoard(two, { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const c = r.project.components[0]
    const { pinNet } = computeConnectivity(r.project)
    const a = pinNet.get(pinKey(c.id, "1"))
    const b = pinNet.get(pinKey(c.id, "2"))
    expect(a).toBe("net:/A/B")
    expect(b).toBe("net:/A{slash}B")
    expect(r.report.entries.find((e) => e.code === "renamed-net")?.object).toMatch(/\/A\{slash\}B as \/A\{slash\}B/)
    const one = board({ nets: ['(net 0 "")', '(net 1 "/A{slash}B")'], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "/A{slash}B")' })] })] })
    const r1 = importKicadBoard(one, { built: ALL })
    expect(r1.status === "imported" && computeConnectivity(r1.project).pinNet.get(pinKey(r1.project.components[0].id, "1"))).toBe("net:/A/B")
  })
  it("a netless pad stays netless, and a pad with a net is on it", () => {
    const text = board({ nets: ['(net 0 "")', '(net 1 "GND")'], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "GND")' }), pad({ number: "2", at: "1 0" })] })] })
    const r = importKicadBoard(text, { built: ALL })
    expect(r.status === "imported" && [...computeConnectivity(r.project).pinNet.entries()].map(([k, v]) => `${k}=${v}`)).toHaveLength(1)
  })
})

describe("B3: every word of the file is accounted for", () => {
  const unknown = (body: string) => {
    const r = importKicadBoard(board({ body: [body] }))
    return [...r.report.account!.unknownAtoms.keys()]
  }
  it("a word nothing allows is unknown, in a list the table had no atoms for", () => {
    expect(unknown('(gr_text "x" (at 0 0) (layer "F.SilkS" frobnicate) (effects (font (size 1 1) (thickness 0.15))))')).toEqual(["gr_text>layer frobnicate"])
    expect(unknown(footprint({ pads: [pad({ at: "0 0", extra: "(zone_connect frobnicate)" })] }))).toEqual(["footprint>pad>zone_connect frobnicate"])
    expect(unknown(footprint({ pads: [pad({ at: "0 0", type: "thru_hole", extra: "(drill 0.4 frobnicate)" })] }))).toEqual(["footprint>pad>drill frobnicate"])
  })
  it("a layer's name, a net's name and a pad's number are names, not words to know", () => {
    expect(unknown(footprint({ pads: [pad({ number: "A1", at: "0 0", net: "(net 1 SomeNet)" })] }))).toEqual([])
  })
  it("unlocked, knockout, keep_text_aligned and a bare hide on a property are known; the text and the dimension are carried", () => {
    const text = board({
      body: [
        `(footprint "K" (layer "F.Cu") (at 0 0) (property "Reference" "K1" (at 0 0 0 unlocked) (layer "F.SilkS" knockout) hide) ${pad({ at: "0 0" })})`,
        '(dimension (type aligned) (layer "Dwgs.User") (pts (xy 0 0) (xy 10 0)) (height 3) (style (thickness 0.1) keep_text_aligned))',
      ],
    })
    const r = importKicadBoard(text)
    expect(r.report.account!.unknownAtoms.size).toBe(0)
    // text and dimensions are built, so nothing keeps the board out
    expect(r.status).toBe("imported")
    if (r.status === "imported") expect(r.project.dimensions).toHaveLength(1)
  })
  it("the words inside a node the table drops whole are not asked about", () => {
    const text = board({ setup: "(setup (pad_to_mask_clearance 0) (pcbplotparams (layerselection 0x00010fc_ffffffff) (outputdirectory gerbers/)))" })
    expect(importKicadBoard(text).report.account!.unknownAtoms.size).toBe(0)
  })
  it("scanAtoms reports each place once with its count", () => {
    const found = scanAtoms('(kicad_pcb (version 20240108) (gr_text "x" (at 0 0) (layer "F.SilkS" wobble)) (gr_text "y" (at 0 0) (layer "F.SilkS" wobble)))')
    expect(found.get("gr_text>layer")?.get("wobble")).toBe(2)
  })
})

/** Boards whose imported nodes are checked against the built project. */
describe("B3: a node counted as imported is in the built project", () => {
  const fixture = board({
    version: 20240108,
    nets: ['(net 0 "")', '(net 1 "GND")', '(net 2 "VCC")'],
    setup: "(setup (trace_min 0.15) (pad_to_mask_clearance 0.05) (pad_to_paste_clearance -0.02) (hole_to_hole_min 0.3) (via_min_annulus 0.12) (via_min_size 0.45) (through_hole_min 0.25) (zone_clearance 0.4) (edge_clearance 0.3) (user_trace_width 0.3) (user_trace_width 0.5) (tenting front back))",
    body: [
      '(title_block (title "Probe") (date "2026-10-24") (rev "B") (company "Acme") (comment 1 "one"))',
      '(property "Owner" "me")',
      `(footprint "Lib:R_0603" (layer "F.Cu") (locked) (descr "A resistor") (tags "resistor smd") (at 10 5 90) (path "/abc") (sheetname "Root") (sheetfile "x.kicad_sch") (attr smd)
        (property "Reference" "R1" (at 0 -1 90) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (property "Value" "1k" (at 0 1 90) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
        ${pad({ number: "1", at: "-0.8 0", size: "0.9 1", net: '(net 1 "GND")', extra: '(pinfunction "A") (pintype "passive")' })}
        ${pad({ number: "2", at: "0.8 0", size: "0.9 1", net: '(net 2 "VCC")', extra: '(pinfunction "~{B}") (pintype "input")' })}
        (model "\${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0.1 0.2 0.3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90))))`,
      '(segment (start 1 1) (end 5 1) (width 0.25) (layer "F.Cu") (net 1))',
      '(via (at 6 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))',
    ],
  })
  it("every imported path has a check, and every check holds", () => {
    const read = readKicadBoard(fixture)
    const b = read.board
    const outline = outlineOf(b)
    const paths = countPaths(b.tree)
    const needs = needsOf(b, { paths }, outline)
    // what is built: an extension node that is imported is imported only because the builder writes it
    const account = accountNodes(b.tree, read.text, new Set(unbuilt(needs).map((n) => n.ext)), paths, settleFor(b))
    const report: ImportReport = { entries: [], account }
    const built = buildKicadProject(b, outline, report, { allowLossy: true })
    const p = built.project
    const part = p.parts![0]
    const rules = p.rules
    const comp = p.components[0]
    const pads = pcbPads(comp)
    // the part's texts where they are on the board: the reference at (0, -1) and the value at (0, 1) of a part turned 90 degrees at (10, 5)
    const tw = componentTexts(comp, 2)
    const prop = (key: string) => p.properties?.find((q) => q.key === key)?.value
    const checks: [RegExp, () => boolean][] = [
      [/^version$/, () => /file version 20240108/.test(prop("KiCad file version") ?? "")],
      [/^generator_version$/, () => /KiCad 8\.0/.test(prop("KiCad file version") ?? "")],
      [/^general(>thickness)?$/, () => p.board.thickness === 1.6],
      [/^title_block$/, () => p.name === "Probe"],
      [/^title_block>title$/, () => p.name === "Probe"],
      [/^title_block>date$/, () => prop("Date") === "2026-10-24"],
      [/^title_block>rev$/, () => prop("Rev") === "B"],
      [/^title_block>company$/, () => prop("Company") === "Acme"],
      [/^title_block>comment$/, () => prop("Comment 1") === "one"],
      [/^property$/, () => prop("Owner") === "me"],
      [/^net$/, () => p.labels.some((l) => l.name === "GND") && p.labels.some((l) => l.name === "VCC")],
      [/^segment(>start|>end|>width|>layer)?$/, () => p.traces.length === 1 && p.traces[0].width === 0.25 && p.traces[0].layer === "top" && p.traces[0].points.length === 2],
      [/^segment>net$/, () => p.traces[0].net === "GND"],
      [/^via(>at|>size|>drill|>layers)?$/, () => p.vias.length === 1 && p.vias[0].diameter === 0.8 && p.vias[0].drill === 0.4 && p.vias[0].x === 6 && p.vias[0].y === -1],
      [/^via>net$/, () => p.vias[0].routedNet === "GND" && p.vias[0].net === undefined],
      [/^footprint>attr$/, () => comp.flags?.mount === "smd"],
      [/^footprint$/, () => p.components.length === 1],
      [/^footprint>at$/, () => comp.pcb.x === 10 && comp.pcb.y === -5 && comp.pcb.rot === 90],
      [/^footprint>layer$/, () => comp.pcb.side === "top"],
      [/^footprint>locked$/, () => comp.pcb.locked === true],
      [/^footprint>descr$/, () => part.description === "A resistor"],
      [/^footprint>tags$/, () => part.keywords?.join(" ") === "resistor smd"],
      [/^footprint>pad(>at|>size)?$/, () => pads.length === 2 && Math.abs(pads[0].x - 10) < 1e-9 && Math.abs(pads[0].y - -(5 + rotK(-0.8, 0, 90).y)) < 1e-9 && pads[0].width === 0.9 && pads[0].height === 1],
      [/^footprint>pad>net$/, () => computeConnectivity(p).pinNet.get(pinKey(comp.id, "1")) === "net:GND" && computeConnectivity(p).pinNet.get(pinKey(comp.id, "2")) === "net:VCC"],
      [/^footprint>pad>pinfunction$/, () => part.pins.map((q) => q.name).join(",") === "A,B#"],
      [/^footprint>pad>pintype$/, () => part.pins.map((q) => q.kind).join(",") === "passive,input"],
      [/^footprint>property$/, () => comp.texts?.map((t) => t.kind).join(",") === "reference,value"],
      [/^footprint>property>at$/, () => Math.abs(tw[0].x - 9) < 1e-9 && Math.abs(tw[0].y + 5) < 1e-9 && Math.abs(tw[1].x - 11) < 1e-9 && Math.abs(tw[1].y + 5) < 1e-9 && tw[0].rot === 90 && tw[1].rot === 90],
      [/^footprint>property>layer$/, () => tw[0].layer === "F.SilkS" && tw[1].layer === "F.Fab"],
      [/^footprint>property>effects(>font)?$/, () => tw.length === 2],
      [/^footprint>property>effects>font>size$/, () => tw[0].size === 1 && tw[0].w === 1],
      [/^footprint>property>effects>font>thickness$/, () => tw[0].thickness === 0.15 && tw[1].thickness === 0.15],
      [/^footprint>model$/, () => p.models?.length === 1],
      [/^footprint>model>(offset|offset>xyz)$/, () => JSON.stringify(p.models![0].model.offset) === JSON.stringify({ x: 0.1, y: 0.2, z: 0.3 })],
      [/^footprint>model>(rotate|rotate>xyz)$/, () => p.models![0].model.rotation.z === -90],
      [/^footprint>model>(scale|scale>xyz)$/, () => p.models![0].model.scale === undefined],
      [/^setup$/, () => true],
      [/^setup>trace_min$/, () => rules.minTraceWidth === 0.15],
      [/^setup>pad_to_mask_clearance$/, () => rules.maskExpansion === 0.05],
      [/^setup>pad_to_paste_clearance$/, () => rules.pasteExpansion === -0.02],
      [/^setup>hole_to_hole_min$/, () => rules.holeClearance === 0.3],
      [/^setup>via_min_annulus$/, () => rules.minAnnularRing === 0.12],
      [/^setup>via_min_size$/, () => rules.minViaDiameter === 0.45],
      [/^setup>through_hole_min$/, () => rules.minDrill === 0.25],
      [/^setup>zone_clearance$/, () => rules.pourClearance === 0.4],
      [/^setup>edge_clearance$/, () => rules.edgeClearance === 0.3],
      [/^setup>user_trace_width$/, () => rules.preferredWidths.includes(0.3) && rules.preferredWidths.includes(0.5)],
      [/^gr_rect(>start|>end|>layer)?$/, () => p.board.width === 20 && p.board.height === 10],
    ]
    const imported = [...account.importedPaths.keys()].map((k) => k.replace(/^module(?=$|>)/, "footprint"))
    expect(imported.length).toBeGreaterThan(20)
    const unchecked = imported.filter((path) => !checks.some(([re]) => re.test(path)))
    expect(unchecked).toEqual([])
    const failed = imported.filter((path) => checks.filter(([re]) => re.test(path)).some(([, check]) => !check()))
    expect(failed).toEqual([])
  })
  it("a KiCad 5 default net class: its four values are the rules and imported; its name, description, members and micro via size, and the toolbar's last selections, are not needed", () => {
    const text = board({
      version: 20171130,
      header: "(host pcbnew 5.1.12)",
      nets: ['(net 0 "")', "(net 1 GND)"],
      setup: "(setup (last_trace_width 0.3) (trace_min 0.15) (trace_clearance 0.25) (via_size 0.9) (via_drill 0.5) (pad_to_mask_clearance 0))",
      body: ['(net_class Default "This is the default net class." (clearance 0.25) (trace_width 0.3) (via_dia 0.9) (via_drill 0.5) (uvia_dia 0.3) (uvia_drill 0.1) (add_net GND))'],
    })
    const read = readKicadBoard(text)
    const b = read.board
    const outline = outlineOf(b)
    const paths = countPaths(b.tree)
    const needs = needsOf(b, { paths }, outline)
    expect(needs.map((n) => n.ext)).not.toContain("X10")
    const account = accountNodes(b.tree, read.text, new Set(needs.map((n) => n.ext)), paths, settleFor(b))
    const built = buildKicadProject(b, outline, { entries: [], account }, { allowLossy: true })
    expect(built.project.rules).toMatchObject({ clearance: 0.25, traceWidth: 0.3, viaDiameter: 0.9, viaDrill: 0.5, minTraceWidth: 0.15 })
    for (const path of ["net_class>clearance", "net_class>trace_width", "net_class>via_dia", "net_class>via_drill"]) expect(account.importedPaths.has(path), path).toBe(true)
    for (const path of ["net_class", "net_class>add_net", "net_class>uvia_dia", "net_class>uvia_drill", "setup>last_trace_width", "setup>via_size", "setup>via_drill", "setup>trace_clearance"]) expect(account.importedPaths.has(path), path).toBe(false)
    const reasons = [...account.notNeeded.keys()].join("\n")
    expect(reasons).toMatch(/Default net class with nothing of its own: its name and description are KiCad's own/)
    expect(reasons).toMatch(/micro via size that is KiCad's own default for the Default class/)
    expect(reasons).toMatch(/track width last selected in the toolbar/)
    expect(reasons).toMatch(/via size, via drill and clearance a second time/)
  })
  it("a node of the file that the builder does not write is never counted as imported", () => {
    // what the editor works out for itself, and the link to a schematic symbol, are "not needed" with their reasons, and are not imported;
    // a node of an extension that is not built is pending, not imported
    const read = readKicadBoard(fixture)
    const account = accountNodes(read.board.tree, read.text, new Set(["X9", "X13", "X7"]), countPaths(read.board.tree), settleFor(read.board))
    for (const path of ["footprint>path", "footprint>sheetname", "segment>net", "via>net", "layers"]) expect(account.importedPaths.has(path), path).toBe(false)
    const reasons = [...account.notNeeded.keys()].join("\n")
    expect(reasons).toMatch(/link from a footprint to its symbol/)
    expect(reasons).toMatch(/editor's layers are fixed/)
    expect(account.pending.get("X13")).toBe(2)
  })
})

describe("B3 after X2 and X6: the nodes of a turned footprint and of an outline of any shape are imported only because the builder writes them", () => {
  const imp = (text: string) => {
    const read = readKicadBoard(text)
    const b = read.board
    const outline = outlineOf(b)
    const paths = countPaths(b.tree)
    const needs = needsOf(b, { paths }, outline)
    const account = accountNodes(b.tree, read.text, new Set(unbuilt(needs).map((n) => n.ext)), paths, settleFor(b))
    const built = buildKicadProject(b, outline, { entries: [], account }, {})
    return { account, built, needs }
  }

  it("a footprint placed by (transform (translate) (rotate) (scale 1)) is a part at the file's own angle, and its nodes are imported", () => {
    const text = board({
      version: 20260616,
      body: [`(footprint "L:A" (layer "F.Cu") (transform (translate 12 7) (rotate 33.5) (scale 1)) (property "Reference" "U1" (at 0 -1 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) ${pad({ number: "1", at: "1 0 33.5" })})`],
    })
    const { account, built, needs } = imp(text)
    expect(unbuilt(needs).map((n) => n.ext)).not.toContain("X6")
    for (const path of ["footprint>transform", "footprint>transform>translate", "footprint>transform>rotate", "footprint>transform>scale"]) expect(account.importedPaths.has(path), path).toBe(true)
    expect(built.project.components[0].pcb).toMatchObject({ x: 12, y: -7, rot: 33.5, side: "top" })
    const w = pcbPads(built.project.components[0])[0]
    expect(w.x).toBeCloseTo(12 + Math.cos((33.5 * Math.PI) / 180), 3)
    expect(w.y).toBeCloseTo(-(7 - Math.sin((33.5 * Math.PI) / 180)), 3)
  })

  it("an outline of a polygon, a circle cutout and an arc is held as those shapes exactly, and the nodes it is drawn with are imported", () => {
    const edge = [
      '(gr_poly (pts (xy 0 0) (xy 30 0) (xy 30 20) (xy 0 20)) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_circle (center 10 10) (end 13 10) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_arc (start 24 6) (mid 27 9) (end 24 12) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))',
      '(gr_line (start 24 12) (end 24 6) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))',
    ].join(" ")
    const { account, built } = imp(board({ outline: edge }))
    for (const path of ["gr_poly", "gr_poly>pts", "gr_poly>pts>xy", "gr_circle", "gr_circle>center", "gr_circle>end", "gr_arc", "gr_arc>mid", "gr_line>start"]) expect(account.importedPaths.has(path), path).toBe(true)
    const paths = built.project.board.outline!.paths
    expect(paths).toHaveLength(3)
    // the circle: its centre and radius as the file has them (KiCad's y down becomes y up)
    const circle = paths.find((q) => q.segs.length === 2 && q.segs.every((g) => g.kind === "arc"))!
    expect(circle.segs[0]).toMatchObject({ kind: "arc", start: { x: 13, y: -10 } })
    expect(built.project.board.width).toBe(30)
    expect(built.project.board.height).toBe(20)
  })
})

describe("B4 and m3: an outline is a rectangle only if it is one to 0.001 mm, and a corner bends the right way", () => {
  const arc = (s: string, m: string, e: string) => `(gr_arc (start ${s}) (mid ${m}) (end ${e}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))`
  const line = (a: string, b: string) => `(gr_line (start ${a}) (end ${b}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))`
  const K = Math.SQRT1_2
  /** A 40 by 20 outline with a corner of radius r at each corner; `inward` bends them the wrong way. `dr` adds to the radius of the first arc, `dx` shifts one line end. */
  const outline = (r: number, opts: { inward?: boolean; dr?: number; dxEnd?: number; side?: number } = {}) => {
    const w = 40
    const h = 20
    const r0 = r + (opts.dr ?? 0)
    // a convex corner is a circle tucked into the corner, a concave one a circle centred on it
    const c = (cx: number, cy: number, sx: number, sy: number, rr: number) =>
      [`${cx + sx * rr} ${cy}`, opts.inward ? `${cx + sx * rr * K} ${cy + sy * rr * K}` : `${cx + sx * rr - sx * rr * K} ${cy + sy * rr - sy * rr * K}`, `${cx} ${cy + sy * rr}`] as const
    // top left, top right, bottom right, bottom left; each arc from its x side to its y side
    const tl = c(0, 0, 1, 1, r0)
    const tr = c(w, 0, -1, 1, r)
    const br = c(w, h, -1, -1, r)
    const bl = c(0, h, 1, -1, r)
    return [
      arc(...tl),
      line(`${r0} 0`, `${w - r + (opts.dxEnd ?? 0)} 0`),
      arc(...tr),
      line(`${w} ${r}`, `${w} ${h - r}`),
      arc(...br),
      line(`${w - r} ${h}`, `${r} ${h}`),
      arc(...bl),
      line(`0 ${h - r}`, `0 ${r0}`),
    ].join("\n")
  }
  const shape = (body: string) => {
    const read = readKicadBoard(board({ outline: body }))
    return outlineOf(read.board)
  }
  it("four convex corners of one radius are a rounded rectangle, with that radius", () => {
    const o = shape(outline(3))
    expect(o.shape).toBe("roundrect")
    expect(o.representable).toBe(true)
    expect(o.cornerRadius).toBeCloseTo(3, 3)
    expect(o.box).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 20 })
  })
  it("four quarter arcs that bend the wrong way (BirthdayCakeKeyboard, galopago rak4200) are arcs, not a rounded rectangle", () => {
    const o = shape(outline(3, { inward: true }))
    expect(o.shape).toBe("arcs")
    expect(o.representable).toBe(false)
    const r = importKicadBoard(board({ outline: outline(3, { inward: true }) }), { built: WITHOUT("X2") })
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toContain("X2")
  })
  it("radii that differ by more than 0.001 mm are a rounded rectangle of unequal radii, which the model cannot hold", () => {
    expect(shape(outline(3, { dr: 0.117 })).shape).toBe("roundrect-unequal")
    expect(shape(outline(3, { dr: 0.117 })).representable).toBe(false)
    // within 0.001 mm it is one
    expect(shape(outline(3, { dr: 0.0004 })).representable).toBe(true)
  })
  it("a side that stops 0.05 mm short of its corner is not exact", () => {
    expect(shape(outline(3, { dxEnd: -0.05 })).representable).toBe(false)
  })
  it("a plain rectangle is exact only when its sides are: 0.5 % slack on a 100 mm side is 0.5 mm", () => {
    const rect = (dy: number) => [line("0 0", "100 0"), line("100 0", `100 ${50 + dy}`), line(`100 ${50 + dy}`, "0 50"), line("0 50", "0 0")].join("\n")
    expect(shape(rect(0)).representable).toBe(true)
    expect(shape(rect(0.0005)).representable).toBe(true)
    expect(shape(rect(0.5)).shape).toBe("polygon")
    expect(shape(rect(0.5)).representable).toBe(false)
  })
  it("a rectangle drawn as a four-point polygon needs its points on the corners", () => {
    const poly = (x: number) => `(gr_poly (pts (xy 0 0) (xy 20 0) (xy ${x} 10) (xy 0 10)) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))`
    expect(shape(poly(20)).shape).toBe("rect")
    expect(shape(poly(20.05)).shape).toBe("polygon")
  })
  it("m2: a line of no length on Edge.Cuts is counted in the repair note", () => {
    const text = board({ outline: ['(gr_rect (start 0 0) (end 20 10) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))', line("5 5", "5 5"), line("6 6", "6 6")].join("\n") })
    const read = readKicadBoard(text)
    expect(outlineOf(read.board).repair.zeroLength).toBe(2)
    const r = importKicadBoard(text, { built: ALL })
    expect(r.report.entries.find((e) => e.code === "outline-repaired")?.why).toMatch(/lines of no length were dropped \(2\)/)
  })
})

describe("B6: a footprint has one land, whichever side the board puts it on", () => {
  // The library footprint: three pads off its origin, asymmetric, with a model. KiCad flips it about the x axis: each pad's y is
  // negated in the footprint's frame, the part is on B.Cu, and its angle is negated; the file stores that state.
  const lib = [
    { n: "1", x: -1.1, y: 0.4, w: 0.9, h: 1.4 },
    { n: "2", x: 1.1, y: 0.4, w: 0.9, h: 1.4 },
    { n: "3", x: 0.3, y: -1.2, w: 0.6, h: 0.5 },
  ]
  const model = '(model "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0.2 -0.1 0.3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))'
  const fp = (side: "top" | "bottom", at: string, ref: string, angle: number) =>
    footprint({
      ref,
      name: "Lib:R",
      layer: side === "top" ? "F.Cu" : "B.Cu",
      at,
      extra: model,
      pads: lib.map((p) =>
        pad({
          number: p.n,
          at: `${p.x} ${side === "top" ? p.y : -p.y} ${angle}`,
          size: `${p.w} ${p.h}`,
          layers: side === "top" ? '"F.Cu" "F.Paste" "F.Mask"' : '"B.Cu" "B.Paste" "B.Mask"',
        }),
      ),
    })
  const KIND = [
    ["top", 0],
    ["top", 90],
    ["bottom", 0],
    ["bottom", 90],
    ["bottom", 180],
    ["bottom", 270],
  ] as const
  const text = board({ body: KIND.map(([side, a], i) => fp(side, `${30 + i * 10} 20 ${a}`, `R${i + 1}`, a)) })
  const r = importKicadBoard(text, { built: ALL })
  it("every instance shares the one land and one model, top and bottom", () => {
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(new Set(r.project.components.map((c) => c.footprint)).size).toBe(1)
    expect(new Set(r.project.components.map((c) => c.partId)).size).toBe(1)
    expect(r.project.footprints).toHaveLength(1)
    expect(r.project.models).toHaveLength(1)
  })
  it("the land is the library's: pads as the library draws them, y flipped for the editor", () => {
    if (r.status !== "imported") throw new Error("not imported")
    const land = r.project.footprints![0].pads
    for (const p of lib) {
      const q = land.find((x) => x.pin === p.n)!
      expect([q.x, q.y]).toEqual([p.x, -p.y])
    }
  })
  it("every pad is where KiCad puts it, to 0.001 mm: the stored place turned by the footprint's angle", () => {
    if (r.status !== "imported") throw new Error("not imported")
    r.project.components.forEach((c, i) => {
      const [side, a] = KIND[i]
      for (const w of pcbPads(c)) {
        const p = lib.find((q) => q.n === w.pin)!
        const stored = { x: p.x, y: side === "top" ? p.y : -p.y }
        const off = rotK(stored.x, stored.y, a)
        expect(w.x, `${c.ref} pad ${w.pin}`).toBeCloseTo(30 + i * 10 + off.x, 3)
        expect(w.y, `${c.ref} pad ${w.pin}`).toBeCloseTo(-(20 + off.y), 3)
        const swapped = a % 180 !== 0
        expect(w.width).toBeCloseTo(swapped ? p.h : p.w, 6)
      }
    })
  })
  it("the placement is the editor's own for a bottom part: the footprint's angle plus half a turn", () => {
    if (r.status !== "imported") throw new Error("not imported")
    r.project.components.forEach((c, i) => {
      const [side, a] = KIND[i]
      expect(c.pcb.side).toBe(side)
      expect(c.pcb.rot).toBe((((a + (side === "bottom" ? 180 : 0)) % 360) + 360) % 360)
    })
  })
  it("the model sits on the part as KiCad's 3D viewer puts it, top and bottom (board_adapter.cpp GetFootprintMatrix, 3d_math.cpp CalcModelMatrix)", () => {
    if (r.status !== "imported") throw new Error("not imported")
    const assigned = r.project.models![0].model
    const probes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 2, 0), new THREE.Vector3(0.3, -1.1, 2.2)]
    r.project.components.forEach((c, i) => {
      const [side, a] = KIND[i]
      const t = r.project.board.thickness
      // KiCad: T(x, -y, face) * Rz(angle) * [flipped: Ry(pi) * Rz(pi)] * T(offset) * Rz(-rz) Ry(-ry) Rx(-rx), the model's own offset and rotation as the file writes them
      const kicad = new THREE.Matrix4().makeTranslation(30 + i * 10, -20, side === "top" ? t / 2 : -t / 2).multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(a)))
      if (side === "bottom") kicad.multiply(new THREE.Matrix4().makeRotationY(Math.PI)).multiply(new THREE.Matrix4().makeRotationZ(Math.PI))
      kicad.multiply(new THREE.Matrix4().makeTranslation(0.2, -0.1, 0.3)).multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(-90)))
      // the editor's: the part's holder (turned by rot, flipped about y on the bottom) and the model's placement
      const { holder, content } = partHolder(r.project, c)
      const object = new THREE.Object3D()
      content.add(object)
      holder.updateMatrixWorld(true)
      const editor = object.matrixWorld.clone().multiply(placementMatrix(assigned, object))
      for (const v of probes) expect(v.clone().applyMatrix4(editor).distanceTo(v.clone().applyMatrix4(kicad)), `${c.ref} ${side} ${a}`).toBeLessThan(1e-9)
    })
  })
})

describe("B6: every model is kept or named, never dropped", () => {
  const fp = (ref: string, models: string[], name = "Lib:D") => footprint({ ref, name, extra: models.join(" "), pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] })
  const m = (path: string, extra = "") => `(model "${path}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)) ${extra})`
  const SMA = "${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_SMA.step"
  const SMB = "${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_SMB.step"
  it("two footprints with one name and pads and different models get their own model each (D_SMA is not shown as D_SMB)", () => {
    const r = importKicadBoard(board({ body: [fp("D1", [m(SMA)]), fp("D2", [m(SMB)])] }), { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const model = (ref: string) => {
      const c = r.project.components.find((x) => x.ref === ref)!
      return r.project.models!.find((a) => a.part === c.partId && a.footprint === c.footprint)!.model.id
    }
    expect(model("D1")).toBe("10.0.7/Diode_SMD.3dshapes/D_SMA.step")
    expect(model("D2")).toBe("10.0.7/Diode_SMD.3dshapes/D_SMB.step")
    expect(r.project.models).toHaveLength(2)
  })
  it("a second model is named in the report with why", () => {
    const r = importKicadBoard(board({ body: [fp("D1", [m(SMA), m(SMB)])] }), { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.models).toHaveLength(1)
    const e = r.report.entries.filter((x) => x.code === "model-not-brought")
    expect(e).toHaveLength(1)
    expect(e[0].object).toContain("D_SMB.step")
    expect(e[0].why).toMatch(/one 3D model per part and land/)
  })
  it("a hidden model is never shown: it is named in the report instead", () => {
    for (const hide of ["hide", "(hide yes)"]) {
      const r = importKicadBoard(board({ body: [fp("D1", [m(SMA, hide)])] }), { built: ALL })
      expect(r.status).toBe("imported")
      if (r.status !== "imported") return
      expect(r.project.models).toBeUndefined()
      expect(r.report.entries.find((x) => x.code === "model-not-brought")?.why).toMatch(/hidden in KiCad/)
    }
    // a hidden model first, a visible one second: the visible one is held
    const r = importKicadBoard(board({ body: [fp("D1", [m(SMA, "hide"), m(SMB)])] }), { built: ALL })
    expect(r.status === "imported" && r.project.models![0].model.id).toBe("10.0.7/Diode_SMD.3dshapes/D_SMB.step")
  })
  it("M3: a name the parts index cannot serve is named with its path, not drawn as a generated body in silence", () => {
    expect(stockModelId("${KISYS3DMOD}/Capacitors_SMD.3dshapes/C_0603.wrl")).toBeNull()
    expect(stockModelId("Capacitors_SMD.3dshapes/C_0603.wrl")).toBeNull()
    expect(stockModelId("${KISYS3DMOD}/Capacitor_SMD.3dshapes/C_0603_1608Metric.wrl")).toBe("10.0.7/Capacitor_SMD.3dshapes/C_0603_1608Metric.step")
    expect(stockModelId("${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step")).toBe("10.0.7/Resistor_SMD.3dshapes/R_0603_1608Metric.step")
    const r = importKicadBoard(board({ body: [fp("C1", [m("${KISYS3DMOD}/Capacitors_SMD.3dshapes/C_0603.wrl")]), fp("C2", [m("Capacitors_SMD.3dshapes/C_0603.wrl")])] }), { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const e = r.report.entries.filter((x) => x.code === "model-not-brought")
    expect(e.map((x) => x.object).sort()).toEqual(["3D model Capacitors_SMD.3dshapes/C_0603.wrl of C2", "3D model ${KISYS3DMOD}/Capacitors_SMD.3dshapes/C_0603.wrl of C1"].sort())
    expect(e.every((x) => /has no Capacitors_SMD.3dshapes\/C_0603.step/.test(x.why))).toBe(true)
  })
  it("the nodes of a model that is not held are not counted as imported", () => {
    const r = importKicadBoard(board({ body: [fp("D1", [m(SMA), m(SMB)])] }), { built: ALL })
    const a = r.report.account!
    expect(a.importedPaths.get("footprint>model")).toBe(1)
    expect(a.importedPaths.get("footprint>model>offset")).toBe(1)
    expect(a.reported).toBeGreaterThanOrEqual(5)
  })
})

describe("M1: needs rules", () => {
  const x = (setup: string, body: string[] = []) => needsOf1(board({ setup, body }))
  it("zone_45_only is a drawing constraint with nothing to hold: not needed", () => {
    expect(x("(setup (zone_45_only yes))")).not.toContain("X10")
  })
  it("uvias_allowed and blind_buried_vias_allowed yes on a board with no such vias are not needed, and with one the via is X5", () => {
    expect(x("(setup (uvias_allowed yes) (blind_buried_vias_allowed yes))")).not.toContain("X5")
    expect(x("(setup (uvias_allowed yes))", ['(via micro (at 1 1) (size 0.3) (drill 0.1) (layers "F.Cu" "B.Cu"))'])).toContain("X5")
  })
  it("a non-zero solder_mask_min_width, a paste ratio, a max_error of its own and a minimum via size are X10", () => {
    expect(x("(setup (solder_mask_min_width 0.1))")).toContain("X10")
    expect(x("(setup (pad_to_paste_clearance_ratio -0.1))")).toContain("X10")
    expect(x("(setup (max_error 0.01))")).toContain("X10")
    // the smallest via diameter is a rule of the model (slice 1b-iii); the list of via sizes the user offers is not
    expect(x("(setup (via_min_size 0.4))")).not.toContain("X10")
    expect(x("(setup (user_via 0.8 0.4))")).toContain("X10")
    expect(x("(setup (solder_mask_min_width 0) (pad_to_paste_clearance_ratio 0) (max_error 0.005))")).not.toContain("X10")
  })
  it("a differential pair rule in the default class is X10", () => {
    const kicad5 = (extra: string) => board({ version: 20171130, header: "(host pcbnew 5.1.12)", body: [`(net_class Default "This is the default net class." (clearance 0.2) (trace_width 0.25) (via_dia 0.8) (via_drill 0.4) (uvia_dia 0.3) (uvia_drill 0.1) ${extra})`] })
    expect(needsOf1(kicad5(""))).not.toContain("X10")
    expect(needsOf1(kicad5("(diff_pair_width 0.2) (diff_pair_gap 0.25)"))).toContain("X10")
  })
  it("a net class description of its own is X10; micro via sizes on a board with no micro via are not", () => {
    const kicad5 = (description: string) => board({ version: 20171130, header: "(host pcbnew 5.1.12)", body: [`(net_class Default "${description}" (clearance 0.2) (trace_width 0.25) (via_dia 0.8) (via_drill 0.4) (uvia_dia 0.3) (uvia_drill 0.1))`] })
    expect(needsOf1(kicad5("This is the default net class."))).not.toContain("X10")
    expect(needsOf1(kicad5("Mine"))).toContain("X10")
  })
})

describe("M4: an active-low pin is named as the editor names one", () => {
  it("a pad function ~{RESET} is the pin RESET#, V_{IN} is VIN, and the pin type is the editor's kind", () => {
    const text = board({
      body: [
        footprint({
          pads: [
            pad({ number: "1", at: "-2 0", extra: '(pinfunction "~{RESET}") (pintype "input")' }),
            pad({ number: "2", at: "0 0", extra: '(pinfunction "V_{IN}") (pintype "power_in")' }),
            pad({ number: "3", at: "2 0", extra: '(pinfunction "GND") (pintype "power_in")' }),
            pad({ number: "4", at: "4 0", extra: '(pinfunction "IO") (pintype "bidirectional")' }),
            pad({ number: "5", at: "6 0", extra: '(pinfunction "NC") (pintype "passive+no_connect")' }),
          ],
        }),
      ],
    })
    const r = importKicadBoard(text, { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.parts![0].pins).toEqual([
      { number: "1", name: "RESET#", kind: "input" },
      { number: "2", name: "VIN", kind: "power" },
      { number: "3", name: "GND", kind: "ground" },
      { number: "4", name: "IO", kind: "io" },
      { number: "5", name: "NC", kind: "nc" },
    ])
  })
  it("a pin type that is not one of KiCad's is not guessed", () => {
    const r = importKicadBoard(board({ body: [footprint({ pads: [pad({ number: "1", at: "0 0", extra: '(pintype "wobbly")' })] })] }), { built: ALL })
    expect(r.status).toBe("refused")
  })
})

describe("m1 after X6: a part's angle is the file's own, not the quarter turn beside it", () => {
  const withAngle = (angle: string, padX: number) => board({ body: [footprint({ at: `10 10 ${angle}`, pads: [pad({ number: "1", at: `${padX} 0`, size: "1 1" }), pad({ number: "2", at: `${-padX} 0`, size: "1 1" })] })] })
  it("90.01 degrees is a part at 90.01, whatever its size: the pads are where the file has them, not 0.009 mm off", () => {
    const r = importKicadBoard(withAngle("90.01", 50), { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.components[0].pcb.rot).toBe(90.01)
    expect(needsOf1(withAngle("90.01", 50), WITHOUT("X6"))).not.toContain("X6")
  })
  it("an angle within a millionth of a degree of a quarter turn is the quarter turn", () => {
    const r = importKicadBoard(withAngle("90.0000001", 50), { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.components[0].pcb.rot).toBe(90)
  })
})

describe("m9: a KiCad 6 or later board says its rules live in the project file", () => {
  it("20240108 has the note, a KiCad 5 board does not", () => {
    const modern = importKicadBoard(board({}))
    expect(modern.report.entries.find((e) => e.code === "rules-in-project-file")?.why).toMatch(/\.kicad_pro/)
    const old = importKicadBoard(board({ version: 20171130, header: "(host pcbnew 5.1.12)" }))
    expect(old.report.entries.some((e) => e.code === "rules-in-project-file")).toBe(false)
  })
})

describe("a circle's diameter is its size x, whatever its turn (pad.cpp:1482, LoraWAN-Stick's header pads)", () => {
  it("a circle pad sized 1.5 by 3 is 1.5 across on a footprint turned a quarter against it", () => {
    const text = board({ body: [footprint({ at: "10 10 90", pads: [pad({ number: "1", shape: "circle", type: "thru_hole", at: "0 0 0", size: "1.5 3", layers: '"*.Cu" "*.Mask"', extra: "(drill 0.8)" })] })] })
    const r = importKicadBoard(text, { built: ALL })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const [w] = pcbPads(r.project.components[0])
    expect([w.width, w.height]).toEqual([1.5, 1.5])
  })
})
