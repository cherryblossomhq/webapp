import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isDeepStrictEqual } from "node:util"
import { tidySchematic } from "../src/model/tidy"
import { BUILT_EXTENSIONS, EXTENSION_NAMES, importKicadBoard, readKicadBoard, type ImportReport } from "../src/model/kicad/board"
import { buildKicadProject, outlineOf } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { componentTexts, footprintId, shownOf, textBoxCorners, textInk, worldTexts } from "../src/model/texts"
import { placeDesignators } from "../src/model/silk"
import { computeConnectivity } from "../src/model/connectivity"
import { analyzePcb } from "../src/model/pcb"
import { createProject } from "../src/model/ops"
import { fabricationNotes } from "../src/export/notes"
import { applyProjectSettings } from "../src/export/kicadPost"
import type { Project } from "../src/model/types"
import { checkTexts, textsRoundTripOk } from "./kicad-texts-check"
import { roundTripOk } from "./kicad-graphics-check"
import { textOracle } from "./kicad-census/texts.mjs"
import { board, pad } from "./kicad-board-fixtures"

// Slice 1b-iii: text objects (X9), as the importer builds them, and the three carry-overs of the 1b-ii review: a land with
// nothing on it, a track or via on a net number the board does not list, and a filled drawing with a negative width.

const ALL = new Set(Object.keys(EXTENSION_NAMES))
const imp = (text: string, built: ReadonlySet<string> = ALL) => {
  const r = importKicadBoard(text, { built })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}
const forced = (text: string) => {
  const read = readKicadBoard(text)
  const report: ImportReport = { entries: [], account: null }
  const built = buildKicadProject(read.board, outlineOf(read.board), report, { allowLossy: true })
  return { ...built, report }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const fx = (size = "1 1", extra = "") => `(effects (font (size ${size}) (thickness 0.15)${extra}))`
const prop = (name: string, text: string, at: string, layer: string, extra = "", effects = fx()) => `(property "${name}" "${text}" (at ${at}) (layer "${layer}") ${extra} (effects ${effects.replace(/^\(effects /, "").replace(/\)$/, "")}))`
const gtext = (text: string, at: string, layer: string, effects: string, extra = "") => `(gr_text "${text}" (at ${at}) (layer ${layer}) ${extra} ${effects})`
const plainFp = (name: string, at: string, layer: string, texts: string, ref = "U1") =>
  `(footprint "${name}" (layer "${layer}") (at ${at}) ${prop("Reference", ref, "0 -2 0", layer === "B.Cu" ? "B.SilkS" : "F.SilkS")} ${prop("Value", "val", "0 2 0", layer === "B.Cu" ? "B.Fab" : "F.Fab")} ${texts} ${pad({ number: "1", at: "-1 0" })} ${pad({ number: "2", at: "1 0" })})`

describe("the gate after slice 1b-iii", () => {
  it("builds X9 with X8, X13 and X15, 2c-i X2 and X6, X10, the board objects slice's X11, X12 and X14, X3, the zones, and X7, the pad model", () => {
    expect([...BUILT_EXTENSIONS].sort()).toEqual(["X1", "X10", "X11", "X12", "X13", "X14", "X15", "X2", "X29", "X3", "X30", "X31", "X4", "X5", "X6", "X7", "X8", "X9"])
  })
  it("a board with a part and text imports through the real gate", () => {
    const r = importKicadBoard(board({ body: [plainFp("L:A", "10 5", "F.Cu", "")] }))
    expect(r.status).toBe("imported")
  })
  it("names the extensions text still needs: tables, barcodes, drill charts, text boxes in parts, expressions and variables the editor cannot fill in (X25), and another font or its outlines (X19)", () => {
    const needs = (body: string[]) => {
      const r = importKicadBoard(board({ body }))
      return r.status === "refused" ? r.needs.map((n) => n.ext) : []
    }
    expect(needs([gtext("x", "1 1", "F.SilkS", fx("1 1", ' (face "Arial")'))])).toEqual(["X19"])
    expect(needs([gtext("x", "1 1", "F.SilkS", fx("1 1", ' (face "KiCad Font")'))])).toEqual([])
    expect(needs(['(gr_text "x" (at 1 1) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))) (render_cache "x" 0 (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))))'])).toEqual(["X19"])
    expect(needs([gtext("${NET_NAME(1)}", "1 1", "F.SilkS", fx())])).toEqual(["X25"])
    expect(needs([gtext("@{1+1}", "1 1", "F.SilkS", fx())])).toEqual(["X25"])
    expect(needs([gtext("${CURRENT_DATE}", "1 1", "F.SilkS", fx())])).toEqual(["X25"])
    // `${LAYER}`, `${FOOTPRINT_NAME}`, `${FOOTPRINT_LIBRARY}` and `${FILENAME}` are the board's to answer
    expect(needs([gtext("${LAYER} ${FILENAME}", "1 1", "F.SilkS", fx())])).toEqual([])
    expect(needs([gtext("${FILEPATH}", "1 1", "F.SilkS", fx())])).toEqual(["X25"])
    expect(needs(['(table (column_count 1) (layer "F.SilkS") (cells))'])).toEqual(["X25"])
    expect(needs(['(barcode (at 1 1) (layer "F.SilkS") (text "x") (type qr))'])).toEqual(["X25"])
    expect(needs([plainFp("L:B", "10 5", "F.Cu", `(fp_text_box "hello" (start 0 0) (end 4 2) (layer "F.SilkS") ${fx()})`)])).toEqual(["X25"])
    expect(needs(['(gr_text_box "x" (pts (xy 0 0) (xy 4 0) (xy 4 2) (xy 0 2)) (layer "F.SilkS") (border yes) ' + fx() + ")"])).toEqual(["X25"])
    // text on an inner copper layer is text on a layer of the board when the board has it, and a refusal by the importer when its layer table does not list it
    expect(needs([gtext("x", "1 1", "In1.Cu", fx())])).toEqual([])
    const lacks = importKicadBoard(board({ body: [gtext("x", "1 1", "In1.Cu", fx())] }))
    expect(lacks.status === "refused" && lacks.message).toMatch(/In1\.Cu/)
    // a part's own field used as a variable
    expect(needs([`(footprint "L:C" (layer "F.Cu") (at 1 1) ${prop("Reference", "U1", "0 -2 0", "F.SilkS")} ${prop("Value", "v", "0 2 0", "F.Fab")} (property "Datasheet" "http://x" (at 0 0 0) (layer "F.Fab") (hide yes) ${fx()}) (fp_text user "\${Datasheet}" (at 0 0) (layer F.SilkS) ${fx()}) ${pad({ at: "0 0" })})`])).toEqual(["X25"])
  })
  it("the refusal for a font names it", () => {
    const r = importKicadBoard(board({ body: [gtext("x", "1 1", "F.SilkS", fx("1 1", ' (face "Ubuntu Sans")'))] }))
    expect(r.status === "refused" && r.report.entries.find((e) => e.code === "unsupported")?.why).toMatch(/Ubuntu Sans/)
  })
})

describe("carry-over 1: a land with no pads and no drawings (a footprint of text only)", () => {
  const logo = `(footprint "Logo:LOGO1" (layer "F.Cu") (at 10 5) ${prop("Reference", "LOGO1", "0 -3 0", "F.SilkS", "(hide yes)")} ${prop("Value", "Logo", "0 3 0", "F.Fab")} (fp_text user "ACME" (at 0 0 0) (layer F.SilkS) ${fx("2 2")}))`
  const text = board({ body: [logo] })
  it("comes in as a part with no pins on a land with no pad and no drawing, whose box is where its text is", () => {
    const r = imp(text)
    const land = r.project.footprints![0]
    expect(land.pads).toEqual([])
    expect(land.shapes).toBeUndefined()
    expect(land.noCourtyard).toBe(true)
    // the box of "ACME" at 2 mm (about 8 mm wide), not the default half-millimetre square
    expect(land.courtyard.maxX - land.courtyard.minX).toBeGreaterThan(4)
    expect(r.project.components[0].texts!.map((t) => [t.kind, t.hide ?? false])).toEqual([["reference", true], ["value", false], ["user", false]])
  })
  it("is kept by a save and a load, strictly: the land, the part and its text", () => {
    const { project } = imp(text)
    const back = parseProjectFile(serializeProject(project), { id: "x" })
    expect(back.footprints!.map((f) => f.name)).toEqual(project.footprints!.map((f) => f.name))
    expect(back.footprints).toEqual(project.footprints)
    expect(back.components[0].texts).toEqual(project.components[0].texts)
    expect(roundTripOk(project)).toBe(true)
    expect(textsRoundTripOk(project)).toBe(true)
  })
  it("is kept by Tidy, which sends the project through the worker as a file and back", () => {
    const { project } = imp(text)
    // the worker: read the file, tidy, write the file; the page reads the reply
    const inWorker = parseProjectFile(serializeProject(project), { id: "tidy", createdAt: 0, updatedAt: 0 })
    const tidied = tidySchematic(inWorker, {})
    const reply = parseProjectFile(serializeProject(tidied.project), { id: "x", createdAt: 0, updatedAt: 0 })
    expect(reply.footprints!.map((f) => f.name)).toEqual(project.footprints!.map((f) => f.name))
    expect(reply.components).toHaveLength(1)
    expect(reply.components[0].footprint).toBe(project.components[0].footprint)
    expect(reply.components[0].texts).toEqual(project.components[0].texts)
  })
  it("has a text that is drawn, and no designator of the editor's", () => {
    const { project } = imp(text)
    expect(placeDesignators(project).size).toBe(0)
    const wt = worldTexts(project).find((t) => t.kind === "user")!
    expect(shownOf(project, wt)).toBe("ACME")
    expect(textInk(project, wt).strokes.length).toBeGreaterThan(0)
  })
})

describe("carry-over 2: a track or via on a net number the net table does not list", () => {
  const withBad = board({
    nets: ['(net 0 "")', '(net 1 "GND")'],
    body: [
      '(segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 7))',
      '(segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net 1))',
      '(via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 9))',
    ],
  })
  it("is read, as KiCad loads it: on no net, with a changed entry that lists each", () => {
    const r = imp(withBad)
    expect(r.project.traces.map((t) => t.net)).toEqual([undefined, "GND"])
    expect(r.project.vias[0].routedNet).toBeUndefined()
    const e = r.report.entries.find((x) => x.code === "copper-net-unknown")!
    expect(e.severity).toBe("changed")
    expect(e.count).toBe(2)
    expect(e.items).toEqual(["a track at (0, 0): net 7", "a via at (5, 5): net 9"])
  })
  it("is not an unreadable file", () => {
    const r = importKicadBoard(withBad, { built: ALL })
    expect(r.report.entries.some((e) => e.code === "unreadable-value")).toBe(false)
    expect(r.status).toBe("imported")
  })
  it("a pad on an unknown net number is still refused as unreadable (KiCad orphans it; nothing is guessed)", () => {
    const r = importKicadBoard(board({ nets: ['(net 0 "")'], body: [plainFp("L:A", "10 5", "F.Cu", "").replace("(pad 1 smd rect (at -1 0) (size 1 1) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\"))", '(pad 1 smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net 4))')] }), { built: ALL })
    expect(r.status === "refused" && r.reason).toBe("unreadable")
  })
})

describe("carry-over 3: a filled drawing with a negative width", () => {
  const poly = (w: string, fill = "(fill solid)") => board({ body: [`(gr_poly (pts (xy 0 0) (xy 2 0) (xy 2 2)) (stroke (width ${w}) (type solid)) ${fill} (layer "F.SilkS"))`] })
  it("shrinks its fill in KiCad's plot, which no width of the model says: it is X24's, named, with the real gate", () => {
    const r = importKicadBoard(poly("-0.5"))
    expect(r.status).toBe("refused")
    if (r.status !== "refused") return
    expect(r.needs.map((n) => n.ext)).toEqual(["X24"])
    expect(r.report.entries.find((e) => e.code === "unsupported")?.why).toMatch(/filled drawing with a negative width/)
    expect(r.message).toMatch(/negative width/)
  })
  it("a nanometre of it, an unfilled drawing's, and a drawing on the board's edge are what they were", () => {
    expect(importKicadBoard(poly("-0.000001")).status).toBe("imported")
    expect(importKicadBoard(poly("-1518.4", "(fill none)")).status).toBe("imported")
    expect(importKicadBoard(board({ outline: false, body: ['(gr_poly (pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 0 10)) (stroke (width -0.5) (type solid)) (fill solid) (layer "Edge.Cuts"))'] })).status).toBe("imported")
  })
  it("a board whose other needs are built and whose only need is this one says X24 alone", () => {
    const r = importKicadBoard(board({ body: [plainFp("L:A", "10 5", "F.Cu", ""), `(gr_circle (center 5 5) (end 6 5) (stroke (width -0.4) (type solid)) (fill solid) (layer "F.Fab"))`] }))
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toEqual(["X24"])
  })
})

describe("board text", () => {
  it("keeps the layer, place (y up), angle, size (height first), thickness, justification, mirror, bold, italic and knockout", () => {
    const r = imp(board({ body: [gtext("Hi", "10 4 33.5", '"B.Cu" knockout', `(effects (font (size 2 1.5) (thickness 0.3) bold italic) (justify left bottom mirror))`)] }))
    const t = r.project.texts[0]
    expect(t).toMatchObject({ text: "Hi", x: 10, y: -4, rot: 33.5, size: 2, w: 1.5, layer: "B.Cu", side: "bottom", mirror: true, knockout: true, bold: true, italic: true, hj: "left", vj: "bottom" })
    // a bold text of a file older than 20260826 is stored with its width divided by 1.6, which drawing it again multiplies back
    expect(t.thickness).toBeCloseTo(0.1875, 6)
    const wt = worldTexts(r.project)[0]
    expect([wt.hj, wt.vj]).toEqual([-1, 1])
  })
  it("a bold text of a file from 20260826 on keeps the stored width as it is", () => {
    const r = imp(board({ version: 20260901, body: [gtext("Hi", "1 1", '"F.SilkS"', `(effects (font (size 1 1) (thickness 0.3) (bold yes)))`)] }))
    expect(r.project.texts[0].thickness).toBe(0.3)
  })
  it("has KiCad's defaults: 60 mils when no size is written, centred, not mirrored, thickness automatic", () => {
    const r = imp(board({ body: ['(gr_text "x" (at 1 1) (layer "F.SilkS") (effects (font (thickness 0.1))))', '(gr_text "y" (at 2 2) (layer "F.SilkS"))'] }))
    expect(r.project.texts.map((t) => [t.size, t.w, t.hj, t.vj, t.mirror])).toEqual([[1.524, undefined, undefined, undefined, undefined], [1.524, undefined, undefined, undefined, undefined]])
    expect(r.project.texts[1].thickness).toBeUndefined()
  })
  it("clamps a size to KiCad's range, 0.001 mm to 250 mm", () => {
    const r = imp(board({ body: [gtext("a", "1 1", '"F.SilkS"', fx("0 0")), gtext("b", "1 1", '"F.SilkS"', fx("900 900"))] }))
    expect(r.project.texts.map((t) => t.size)).toEqual([0.001, 250])
  })
  it("cannot be hidden: KiCad draws a board text whatever the file says", () => {
    const r = imp(board({ body: ['(gr_text "x" (at 1 1) (layer "F.SilkS") (effects (font (size 1 1)) (hide yes)))'] }))
    expect(worldTexts(r.project)[0].hidden).toBe(false)
  })
  it("turns %R and %V into variables, and the old overbar notation into the new", () => {
    const r = imp(board({ version: 20200101, body: [gtext("%R/%V ~RST~", "1 1", "F.SilkS", fx())] }))
    expect(r.project.texts[0].text).toBe("${REFERENCE}/${VALUE} ~{RST}")
  })
  it("reads a text on a layer of an old board by KiCad's own mapped name, and moves one on a layer it does not know to Cmts.User, as KiCad's rescue does", () => {
    const r = imp(board({ version: 20200101, body: [gtext("x", "1 1", "Serigrafia.Fronte", fx())] }))
    expect(r.project.texts[0].layer).toBe("F.SilkS")
    const u = imp(board({ body: [gtext("x", "1 1", "Nowhere", fx())] }))
    expect(u.project.texts.map((t) => t.layer)).toEqual(["Cmts.User"])
  })
  it("a text on Edge.Cuts is kept, and drawn in the outline file", () => {
    const r = imp(board({ body: [gtext("edge", "1 1", "Edge.Cuts", fx())] }))
    expect(r.project.texts[0].layer).toBe("Edge.Cuts")
  })
})

describe("a text box", () => {
  const box = (extra: string, effects = fx("1 1")) => `(gr_text_box "hello world" (start 2 2) (end 12 6) ${extra} (layer "F.SilkS") ${effects})`
  it("keeps its centre, border, margins and angle, and takes the box's own frame from the version's rule", () => {
    // a file of stamp 20241229 (KiCad 9) stores the rectangle as drawn: 10 wide and 4 high on the board, and the text turned a quarter runs along the 4
    const r = imp(board({ version: 20241229, body: [box('(stroke (width 0.2) (type solid)) (border yes) (margins 0.5 0.6 0.7 0.8) (angle 90)')] }))
    const t = r.project.texts[0]
    expect(t.box).toEqual({ w: 4, h: 10, border: 0.2, margins: [0.5, 0.6, 0.7, 0.8] })
    expect(t).toMatchObject({ x: 7, y: -4, rot: 90 })
    expect(textInk(r.project, worldTexts(r.project)[0]).border?.width).toBe(0.2)
  })
  it("is drawn where KiCad 10.0 draws `(start 2 2) (end 12 6) (angle 90)` of a 20241229 file: x 2 to 12, y -2 to -6, its first corner at the bottom left", () => {
    const r = imp(board({ version: 20241229, body: [box("(angle 90)")] }))
    const wt = worldTexts(r.project)[0]
    const corners = textBoxCorners(wt)
    // EDA_SHAPE::GetCornersInSequence( 90 ) of 10.0.0: (left, bottom), (left, top), (right, top), (right, bottom), y down; ours is y up
    expect(corners.map((p) => [p.x, p.y])).toEqual([[2, -6], [2, -2], [12, -2], [12, -6]])
    // the column is the corners' first side, 4 mm, less the top and bottom margins of a text turned a quarter (the legacy 0.75 each)
    const o = textOracle(board({ version: 20241229, body: [box("(angle 90)")] })).board[0]
    expect(Math.abs(wt.box!.w - Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y))).toBeLessThan(1e-9)
    expect(o.isBox).toBe(true)
  })
  it("a file from 20260616 on (lib-frame storage) stores the rectangle unturned, which the angle turns about its centre", () => {
    const r = imp(board({ version: 20260616, body: [box("(angle 90)")] }))
    expect(r.project.texts[0].box).toMatchObject({ w: 10, h: 4 })
    const corners = textBoxCorners(worldTexts(r.project)[0]).map((p) => [p.x, p.y])
    // rotated 90 degrees about (7, -4): the rectangle is 4 wide and 10 high
    expect(corners).toEqual([[5, -9], [5, 1], [9, 1], [9, -9]])
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([5, 9, -9, 1])
  })
  it("does not swap the sides at 0 and 180 degrees, and swaps them at 270", () => {
    for (const [angle, w, h] of [[0, 10, 4], [180, 10, 4], [270, 4, 10]] as const) {
      const r = imp(board({ version: 20241229, body: [box(`(angle ${angle})`)] }))
      expect([r.project.texts[0].box!.w, r.project.texts[0].box!.h]).toEqual([w, h])
    }
  })
  it("refuses an older file's rectangle turned by another angle, which KiCad does not draw", () => {
    const u = forced(board({ version: 20241229, body: [box("(angle 33)")] }))
    expect(u.lossy.join(" ")).toMatch(/turned by 33 degrees/)
    expect(u.project.texts).toHaveLength(0)
  })
  it("reads a box's knockout from its own node (KiCad 10), and not from its layer", () => {
    const k = imp(board({ version: 20250210, body: [box("(knockout yes)")] }))
    expect(k.project.texts[0].knockout).toBe(true)
    expect(worldTexts(k.project)[0].knockout).toBe(true)
    const n = imp(board({ version: 20250210, body: [box("(knockout no)")] }))
    expect(n.project.texts[0].knockout).toBeUndefined()
    const none = imp(board({ version: 20241229, body: [box("")] }))
    expect(none.project.texts[0].knockout).toBeUndefined()
  })
  // KiCad's own test board, in a local corpus (KICAD_CORPUS): skipped, not passed, without it.
  const kitchenSink = join(process.env.KICAD_CORPUS ?? "", "kicad-source/qa/data/pcbnew/api_kitchen_sink.kicad_pcb")
  it.skipIf(!process.env.KICAD_CORPUS || !existsSync(kitchenSink))("reads the box of KiCad's own API test board with its knockout", () => {
    const path = kitchenSink
    const text = readFileSync(path, "utf8")
    const o = textOracle(text)
    const boxes = [...o.board, ...o.footprints.flatMap((f) => f.texts)].filter((t) => t.isBox)
    expect(boxes.length).toBeGreaterThan(0)
    const r = readKicadBoard(text).board
    const mine = r.texts.filter((t) => t.box)
    expect(mine.map((t) => t.knockout)).toEqual(o.board.filter((t) => t.isBox).map((t) => t.knockout))
    expect(mine.some((t) => t.knockout)).toBe(true)
  })
  it("has KiCad's legacy margin when none is written: half the stroke and three quarters of the height", () => {
    const r = imp(board({ body: [box("(stroke (width 0.2) (type solid)) (border yes)")] }))
    expect(r.project.texts[0].box!.margins.every((m) => near(m, 0.1 + 0.75))).toBe(true)
    // no stroke: a nanometre less than three quarters of the height
    const s = imp(board({ body: [box("(border no)")] }))
    expect(s.project.texts[0].box!.margins.every((m) => near(m, 0.75 - 1e-6))).toBe(true)
    expect(s.project.texts[0].box!.border).toBeUndefined()
  })
  it("the border is there in an old file when the stroke has a width, and in a new one unless the file says no", () => {
    const old = imp(board({ version: 20221018, body: [box("(stroke (width 0.15) (type default))")] }))
    expect(old.project.texts[0].box!.border).toBe(0.15)
    const none = imp(board({ version: 20221018, body: [box("")] }))
    expect(none.project.texts[0].box!.border).toBeUndefined()
    const fresh = imp(board({ version: 20240108, body: [box("(stroke (width 0.15) (type default))")] }))
    expect(fresh.project.texts[0].box!.border).toBe(0.15)
  })
})

describe("a part's text, in the part's land and back on the board", () => {
  // each footprint at an angle, top and bottom, with a text off its middle at an angle of its own: every one lands where the oracle puts it, in every field
  const spots: [string, string][] = [
    ["top 0", "10 5 0"],
    ["top 90", "10 5 90"],
    ["top 180", "10 5 180"],
    ["top 270", "10 5 270"],
    ["top -90", "10 5 -90"],
  ]
  const textsFor = (layer: "F" | "B") => `(fp_text user "A~{B}" (at 1.5 -0.7 20) (layer ${layer}.SilkS) (effects (font (size 1.2 0.9) (thickness 0.2)) (justify left top${layer === "B" ? " mirror" : ""}))) (fp_text user "C" (at -2 1 135) (layer ${layer}.Fab) (effects (font (size 1 1) (thickness 0.1) italic) (justify right)) (hide yes))`
  for (const [name, at] of spots) {
    for (const side of ["F", "B"] as const) {
      it(`${name} ${side === "F" ? "front" : "back"}: every text equals the oracle's`, () => {
        const text = board({ body: [plainFp("L:A", at, side === "F" ? "F.Cu" : "B.Cu", textsFor(side))] })
        const { project } = imp(text)
        const c = checkTexts(text, project)
        expect(c.note).toBe("")
        expect(c.counts).toBe(true)
        expect(c.wrong).toBe(0)
        expect(c.file).toBe(4)
      })
    }
  }
  it("moves with the part: turning it turns the text about the part, and putting it on the bottom mirrors it", () => {
    const text = board({ body: [plainFp("L:A", "10 5 0", "F.Cu", `(fp_text user "X" (at 3 0 0) (layer F.SilkS) ${fx()})`)] })
    const { project } = imp(text)
    const c = project.components[0]
    const at = (p: Project) => {
      const t = worldTexts(p).find((x) => x.kind === "user")!
      return { x: Math.round(t.x * 1e6) / 1e6, y: Math.round(t.y * 1e6) / 1e6, rot: t.rot, layer: t.layer, mirror: t.mirror }
    }
    expect(at(project)).toEqual({ x: 13, y: -5, rot: 0, layer: "F.SilkS", mirror: false })
    const turned = { ...project, components: [{ ...c, pcb: { ...c.pcb, rot: 90 as const } }] }
    expect(at(turned)).toEqual({ x: 10, y: -2, rot: 90, layer: "F.SilkS", mirror: false })
    const flipped = { ...project, components: [{ ...c, pcb: { ...c.pcb, side: "bottom" as const } }] }
    expect(at(flipped)).toEqual({ x: 7, y: -5, rot: 0, layer: "B.SilkS", mirror: true })
  })
  it("a part KiCad names REF** is renamed, and its reference text still shows what the file says", () => {
    const text = board({ body: [`(footprint "L:Hole" (layer "F.Cu") (at 5 5) ${prop("Reference", "REF**", "0 -2 0", "F.SilkS")} ${prop("Value", "H", "0 2 0", "F.Fab")} ${pad({ at: "0 0" })})`] })
    const { project } = imp(text)
    expect(project.components[0].ref).not.toBe("REF**")
    const wt = componentTexts(project.components[0], 2).find((t) => t.kind === "reference")!
    expect(shownOf(project, wt)).toBe("REF**")
    expect(checkTexts(text, project).wrong).toBe(0)
  })
  it("a hidden text is kept, hidden, and costs the file nothing it did not have", () => {
    const text = board({ body: [plainFp("L:A", "10 5", "F.Cu", `(property "Datasheet" "x" (at 0 0 0) (layer "F.Fab") (hide yes) ${fx()})`)] })
    const { project } = imp(text)
    expect(project.components[0].texts!.map((t) => [t.kind, !!t.hide])).toEqual([["reference", false], ["value", false], ["user", true]])
  })
  it("a text that may turn upside down with its part keeps no upright, and one that keeps upright is drawn upright", () => {
    const text = board({ body: [`(footprint "L:A" (layer "F.Cu") (at 5 5 180) ${prop("Reference", "R1", "0 -2 180 unlocked", "F.SilkS")} ${prop("Value", "v", "0 2 180", "F.Fab")} ${pad({ at: "0 0" })})`] })
    const { project } = imp(text)
    const [r, v] = componentTexts(project.components[0], 2)
    expect([r.upright, v.upright]).toEqual([false, true])
    // 180 keeps upright draws at 0; unlocked draws at 180
    expect([r.drawRot, v.drawRot]).toEqual([180, 0])
  })
})

describe("variables", () => {
  const pcb = board({
    body: [
      '(title_block (title "Probe") (date "2026-10-24") (rev "B") (company "Acme") (comment 1 "one"))',
      '(property "Owner" "me")',
      plainFp("L:A", "10 5", "F.Cu", `(fp_text user "%R ${"${VALUE}"} ${"${TITLE}"} ${"${ISSUE_DATE}"} ${"${REVISION}"} ${"${COMPANY}"} ${"${COMMENT1}"} ${"${Owner}"} ${"${U9:VALUE}"}" (at 0 0) (layer F.SilkS) ${fx()})`, "U1"),
      gtext("${REFERENCE} ${TITLE} ${U1:REFERENCE}", "1 1", "F.SilkS", fx()),
    ],
  })
  it("fills in the part's reference and value, the title block, board properties and another part's reference", () => {
    const { project } = imp(pcb)
    const part = worldTexts(project).find((t) => t.kind === "user")!
    expect(shownOf(project, part)).toBe("U1 val Probe 2026-10-24 B Acme one me <Unresolved: U9:VALUE>")
    // the board's text has no part: ${REFERENCE} stays, ${U1:REFERENCE} is U1's
    const board1 = worldTexts(project).find((t) => t.kind === "board")!
    expect(shownOf(project, board1)).toBe("${REFERENCE} Probe U1")
  })
  it("leaves a variable the board file cannot resolve as written, and says so once", () => {
    const r = imp(board({ body: [gtext("${PROJECT_SPECIFIC} and ${VERSION}", "1 1", "F.SilkS", fx())] }))
    expect(worldTexts(r.project).map((t) => shownOf(r.project, t))).toEqual(["${PROJECT_SPECIFIC} and ${VERSION}"])
    const e = r.report.entries.find((x) => x.code === "text-variable-unresolved")!
    expect(e.severity).toBe("changed")
    expect(e.items).toEqual(["PROJECT_SPECIFIC", "VERSION"])
  })
  it("answers ${LAYER}, ${FOOTPRINT_NAME}, ${FOOTPRINT_LIBRARY} and ${FILENAME} from the board, as KiCad does", () => {
    const user = '(fp_text user "' + ["${LAYER}", "${FOOTPRINT_LIBRARY}", "${FOOTPRINT_NAME}", "${U2:LAYER}", "${U2:FOOTPRINT_NAME}"].join("|") + '" (at 0 2 0) (layer "F.Fab") ' + fx() + ")"
    const text = board({
      body: [gtext("on ${LAYER} in ${FILENAME}", "1 1", "F.SilkS", fx()), plainFp("Lib_Special:Part_0603", "10 5", "F.Cu", user, "U1"), plainFp("Other:Thing", "20 5", "B.Cu", "", "U2")],
    })
    const r = imp(text, ALL)
    const all = worldTexts(r.project)
    const board0 = all.find((t) => t.kind === "board")!
    expect(shownOf(r.project, board0)).toBe("on F.SilkS in " + r.project.name + ".kicad_pcb")
    const own = all.find((t) => t.kind === "user" && t.component?.ref === "U1")!
    expect(shownOf(r.project, own)).toBe("F.Fab|Lib_Special|Part_0603|B.Cu|Thing")
    // the oracle reads the same, except the file's name, which only the importer's project knows
    const o = textOracle(text)
    expect(o.footprints.find((f) => f.ref === "U1")!.texts.find((t) => t.kind === "user")!.shown).toBe("F.Fab|Lib_Special|Part_0603|B.Cu|Thing")
    expect(checkTexts(text, r.project).note).toBe("")
    // a part drawn in the editor has no library, and its footprint is its name
    expect(footprintId({ ...r.project.components[0], fpid: undefined, footprint: "0603" })).toEqual({ library: "", name: "0603" })
    expect(r.report.entries.some((e) => e.code === "text-variable-unresolved")).toBe(false)
  })
  it("an escaped \\${...} is the text, not a variable", () => {
    const r = imp(board({ body: [gtext("\\${REFERENCE}", "1 1", "F.SilkS", fx())] }))
    expect(shownOf(r.project, worldTexts(r.project)[0])).toBe("${REFERENCE}")
  })
})

describe("the report", () => {
  it("has no note about the letters: they are KiCad's own", () => {
    const r = imp(board({ body: [plainFp("L:A", "10 5", "F.Cu", "")] }))
    expect(r.report.entries.some((x) => x.code === "text-font")).toBe(false)
  })
  it("counts every node of the file as imported, and none of the text's is pending", () => {
    const r = imp(board({ body: [plainFp("L:A", "10 5", "F.Cu", `(fp_text user "x" (at 0 0 5 unlocked) (layer "F.SilkS" knockout) ${fx("1 1", " bold")})`), gtext("t", "1 1", "F.SilkS", fx())] }))
    const a = r.report.account!
    expect(a.pending.size).toBe(0)
    expect(a.unknownAtoms.size + a.unknownPaths.size).toBe(0)
    for (const path of ["footprint>property>at", "footprint>property>effects>font>size", "footprint>fp_text>layer", "gr_text>effects>font>thickness"]) expect(a.importedPaths.has(path), path).toBe(true)
  })
})

describe("the stored form", () => {
  const sample = () => {
    const body = [
      ...Array.from({ length: 40 }, (_, i) => plainFp("L:R_0603", `${5 + i * 3} 5 ${(i % 4) * 90}`, i % 5 === 0 ? "B.Cu" : "F.Cu", `(fp_text user "\${REFERENCE}" (at 0 1.5 0) (layer ${i % 5 === 0 ? "B.Fab" : "F.Fab"}) ${fx("0.8 0.8")})`, `R${i + 1}`)),
      gtext("hello", "3 3", '"F.SilkS"', fx()),
    ]
    return imp(board({ body, outline: '(gr_rect (start 0 0) (end 140 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' })).project
  }
  it("holds the texts as the objects the live sync edits, and the same project in memory after a load", () => {
    const p = sample()
    const stored = serializeProject(p)
    const doc = JSON.parse(stored).project
    expect(doc.components[0].texts).toHaveLength(3)
    expect(doc.texts).toHaveLength(1)
    expect(doc).not.toHaveProperty("kt")
    expect(doc).not.toHaveProperty("textStyles")
    const back = parseProjectFile(stored, { id: "x" })
    expect(back.texts).toEqual(p.texts)
    expect(isDeepStrictEqual(back.components.map((c) => c.texts), p.components.map((c) => c.texts))).toBe(true)
  })
})

describe("the order of the board's texts through the stored form", () => {
  it("keeps the editor's own texts and KiCad's where they were, whatever the order", () => {
    const base = imp(board({ body: [gtext("one", "1 1", '"F.SilkS"', fx()), gtext("two", "2 2", '"F.SilkS"', fx())] })).project
    const own = [
      { id: "own1", text: "A", x: 1, y: 1, size: 1, rot: 0, side: "top" as const },
      { id: "own2", text: "B", x: 2, y: 2, size: 1, rot: 0, side: "top" as const },
    ]
    const [k1, k2] = base.texts
    for (const order of [[own[0], k1, own[1], k2], [k1, own[0], k2, own[1]], [own[0], own[1], k1, k2], [k2, k1]]) {
      const p = { ...base, texts: order }
      const back = parseProjectFile(serializeProject(p), { id: "x" })
      expect(back.texts.map((t) => t.id)).toEqual(order.map((t) => t.id))
    }
    // The texts are one list in the stored file, in their order, which needs no field to say where KiCad's were.
    expect(serializeProject({ ...base, texts: [own[0], k1, own[1], k2] })).not.toContain('"kp"')
  })
})

describe("the smallest via, and the annular ring of a KiCad 4 or 5 board", () => {
  const withSetup = (setup: string, version = 20240108) => imp(board({ version, setup, body: [plainFp("L:A", "10 5", "F.Cu", "")] }))
  it("reads via_min_size as the rule's minimum via diameter, through the real gate", () => {
    const r = withSetup("(setup (via_min_size 0.45) (pad_to_mask_clearance 0))")
    expect(r.project.rules.minViaDiameter).toBe(0.45)
    expect(r.report.entries.some((e) => e.code === "refused")).toBe(false)
  })
  it("has no minimum when the file states none", () => {
    expect(withSetup("(setup (pad_to_mask_clearance 0))").project.rules.minViaDiameter).toBeUndefined()
  })
  it("turns the list of via sizes the user offers (user_via) into the rules' via sizes (X10, built)", () => {
    const r = imp(board({ setup: "(setup (user_via 0.6 0.3) (pad_to_mask_clearance 0))", body: [plainFp("L:A", "10 5", "F.Cu", "")] }))
    expect(r.project.rules.viaSizes).toEqual([{ diameter: 0.6, drill: 0.3 }])
  })
  it("a KiCad 5 board, which states no annular ring and was never checked for one, opens with none, and says so once", () => {
    const r = withSetup("(setup (via_min_size 0.4) (pad_to_mask_clearance 0))", 20171130)
    expect(r.project.rules.minAnnularRing).toBe(0)
    expect(r.report.entries.filter((e) => e.code === "annular-ring-none")).toHaveLength(1)
    // a via with a thin ring is not an error there
    const thin = { ...r.project, vias: [{ id: "v1", x: 5, y: 5, diameter: 0.45, drill: 0.4 }] }
    const found = analyzePcb(thin, computeConnectivity(thin)).violations.filter((v) => v.kind === "annular-ring")
    expect(found).toEqual([])
  })
  it("a KiCad 4 board is the same", () => {
    const r = withSetup("(setup (pad_to_mask_clearance 0))", 4)
    expect(r.project.rules.minAnnularRing).toBe(0)
  })
  it("a board that states its annular ring keeps it, and so does a KiCad 6 or later board that does not", () => {
    expect(withSetup("(setup (via_min_annulus 0.12) (pad_to_mask_clearance 0))", 20171130).project.rules.minAnnularRing).toBe(0.12)
    const six = withSetup("(setup (pad_to_mask_clearance 0))", 20211014)
    expect(six.project.rules.minAnnularRing).toBe(0.13)
    expect(six.report.entries.some((e) => e.code === "annular-ring-none")).toBe(false)
    expect(withSetup("(setup (pad_to_mask_clearance 0))").project.rules.minAnnularRing).toBe(0.13)
  })
  it("writes the minimum into the KiCad project, the fabrication notes and the stored file", () => {
    const r = withSetup("(setup (via_min_size 0.45) (pad_to_mask_clearance 0))")
    const pro = JSON.parse(applyProjectSettings("{}", r.project).text)
    expect(pro.board.design_settings.rules.min_via_diameter).toBe(0.45)
    expect(fabricationNotes(r.project, [], [])).toMatch(/Via diameter\s+0\.45 mm minimum/)
    const back = parseProjectFile(serializeProject(r.project), { id: "x" })
    expect(back.rules.minViaDiameter).toBe(0.45)
    // a board drawn here writes the formula it always did and no such line
    const own = createProject("own")
    expect(JSON.parse(applyProjectSettings("{}", own).text).board.design_settings.rules.min_via_diameter).toBe(0.46)
    expect(fabricationNotes(own, [], [])).not.toMatch(/Via diameter/)
    expect(serializeProject(own)).not.toContain("minViaDiameter")
  })
})
