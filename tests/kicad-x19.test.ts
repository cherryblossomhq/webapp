import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { gerberSilkscreen } from "../src/export/gerber"
import { importKicadBoard } from "../src/model/kicad/board"
import { BUILT_EXTENSIONS, EXTENSION_NAMES } from "../src/model/kicad/board"
import { outlineRings, packRings, ringsToPolygons, unpackRings, UNNAMED_FONT, type Polygon } from "../src/model/textOutlines"
import { updateComponent } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { patchTexts } from "../src/model/textOps"
import { currentOutline, layerText, textFontState, textInk, worldTexts } from "../src/model/texts"
import { createProject } from "../src/model/ops"
import { fontNotes } from "../src/panels/textInspector"
import { rememberImage } from "../src/store/imageFiles"
import type { BoardText, Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"
import { importedBoard as imported } from "./kicad-test-helpers"

// X19: text drawn in a TrueType font. KiCad writes the outlines it drew such a text with (`render_cache`); the editor keeps them, draws and plots them, and
// writes them back. A text edited in content, size, weight, slant, justification, spacing or font loses them (KiCad throws its cache away on the same edits).

const ring = (pts: [number, number][]) => `(pts ${pts.map(([x, y]) => `(xy ${x} ${y})`).join(" ")})`
/** A letter-like shape: a 2 by 2 square with a 1 by 1 hole, the hole as a polygon of its own wound the other way (how KiCad stores a glyph's counter). */
const SQUARE = `(polygon ${ring([[9, 4], [11, 4], [11, 6], [9, 6]])}) (polygon ${ring([[9.5, 4.5], [9.5, 5.5], [10.5, 5.5], [10.5, 4.5]])})`

const text = (o: { at?: string; content?: string; face?: string | null; cache?: string | null; cacheText?: string; angle?: number; extra?: string; layer?: string } = {}) =>
  `(gr_text "${o.content ?? "Hi"}" (at ${o.at ?? "10 5 0"}) (layer "${o.layer ?? "F.SilkS"}") (uuid "d0000000-0000-4000-8000-000000000001") (effects (font ${o.face === null ? "" : `(face "${o.face ?? "Ubuntu Sans"}")`} (size 1 1) (thickness 0.15) ${o.extra ?? ""}))${o.cache === null ? "" : ` (render_cache "${o.cacheText ?? o.content ?? "Hi"}" ${o.angle ?? 0} ${o.cache ?? SQUARE})`})`

const withText = (t: string, extra: string[] = []) => board({ body: [footprint({ pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] }), t, ...extra] })
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

const area = (poly: { x: number; y: number }[][]) => {
  const a = (r: { x: number; y: number }[]) => Math.abs(r.reduce((s, p, i) => s + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0)) / 2
  return a(poly[0]) - poly.slice(1).reduce((s, h) => s + a(h), 0)
}

describe("the packed polygons", () => {
  it("give back what was packed, to the nanometre, for any sign and size", () => {
    const polygons: Polygon[] = [
      [[0, 0, 1000, 0, 1000, -1000], [-5, -5, 1_999_999_999, 7, 0, 123_456_789]],
      [[-141_570_717, 109_749_689, -141_629_446, 109_759_061, -141_680_725, 109_773_913]],
      [],
    ]
    expect(unpackRings(packRings(polygons))).toEqual(polygons)
    expect(unpackRings(packRings([]))).toEqual([])
  })

  it("refuse text that is not a packed list, and a list cut short", () => {
    expect(unpackRings("not base64!")).toBeNull()
    expect(unpackRings("")).toBeNull()
    const ok = packRings([[[1, 2, 3, 4, 5, 6]]])
    expect(unpackRings(ok.slice(0, ok.length - 4))).toBeNull()
  })

  it("are about eight characters a point in the project file, against the 25 or more the board file takes", () => {
    const pts: number[] = []
    for (let i = 0; i < 1000; i++) pts.push(Math.round(5e6 + 2e6 * Math.cos(i / 40)), Math.round(5e6 + 2e6 * Math.sin(i / 40)))
    expect(packRings([[pts]]).length / 1000).toBeLessThan(9)
  })
})

describe("the importer", () => {
  it("no longer names X19 anywhere: a board with outlines, a font's name and embedded fonts imports", () => {
    expect(BUILT_EXTENSIONS.has("X19")).toBe(true)
    const src = withText(text(), ["(embedded_fonts no)"])
    expect(EXTENSION_NAMES.X19).toBeUndefined()
    expect(imported(src).texts).toHaveLength(1)
  })

  it("keeps the font's name and the outlines, and draws and plots the outlines in place", () => {
    const p = imported(withText(text()))
    const t = p.texts[0]
    expect(t.face).toBe("Ubuntu Sans")
    expect(t.outline?.text).toBe("Hi")
    const [wt] = worldTexts(p)
    expect(textFontState(p, wt)).toBe("outline")
    const ink = textInk(p, wt)
    expect(ink.strokes).toEqual([])
    expect(ink.outlines).toHaveLength(1)
    // 2 by 2 less a 1 by 1 hole; the file's y runs down and the editor's up
    expect(area(ink.outlines![0])).toBeCloseTo(3, 9)
    expect(ink.box).toEqual({ minX: 9, maxX: 11, minY: -6, maxY: -4 })
    const lt = layerText(p, wt)!
    expect(lt.fills).toHaveLength(1)
    expect(lt.strokes).toEqual([])
    // the silkscreen Gerber holds the letter's polygon as a region
    expect(gerberSilkscreen(p, "top")).toMatch(/G36\*/)
  })

  it("a text that names a font and has no outlines is drawn in the stroke font and says so, in the report and on the text", () => {
    const r = importKicadBoard(withText(text({ cache: null })))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const [wt] = worldTexts(r.project)
    expect(textFontState(r.project, wt)).toBe("uncached")
    expect(textInk(r.project, wt).strokes.length).toBeGreaterThan(0)
    const e = r.report.entries.find((x) => x.code === "text-font-uncached")!
    expect(e.object).toMatch(/Ubuntu Sans/)
    expect(fontNotes(r.project, [wt])[0]).toMatch(/no outlines/)
  })

  it("outlines drawn for other text than the text shows are stale, as KiCad's own cache is", () => {
    const r = importKicadBoard(withText(text({ cacheText: "Ho" })))
    if (r.status !== "imported") throw new Error(r.message)
    expect(textFontState(r.project, worldTexts(r.project)[0])).toBe("edited")
    expect(r.report.entries.some((x) => x.code === "text-outlines-stale")).toBe(true)
  })

  it("a text in KiCad's own font is untouched: no face, no outline, no entry", () => {
    const r = importKicadBoard(withText(text({ face: null, cache: null })))
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.project.texts[0].face).toBeUndefined()
    expect(r.report.entries.filter((x) => /^text-(outlines|font)/.test(x.code))).toEqual([])
    const named = importKicadBoard(withText(text({ face: "KiCad Font", cache: null })))
    expect(named.status === "imported" && named.project.texts[0].face).toBeUndefined()
  })

  it("a part's text keeps its outlines on the part's pose, on the bottom side too", () => {
    const fp = (layer: "F" | "B") =>
      footprint({ pads: [pad({ number: "1", at: "-1 0" })], layer: `${layer}.Cu`, at: "20 10 30", extra: `(fp_text user "Hi" (at 1 2 30) (layer "${layer}.SilkS") (effects (font (face "Ubuntu Sans") (size 1 1) (thickness 0.15))) (render_cache "Hi" 30 ${SQUARE}))` })
    for (const layer of ["F", "B"] as const) {
      const p = imported(board({ body: [fp(layer)] }))
      const own = worldTexts(p).filter((t) => t.outline)
      expect(own).toHaveLength(1)
      expect(textFontState(p, own[0])).toBe("outline")
      expect(textInk(p, own[0]).box).toEqual({ minX: 9, maxX: 11, minY: -6, maxY: -4 })
    }
  })
})

describe("editing an outlined text", () => {
  const p0 = () => imported(withText(text({ at: "10 5 20" })))
  const state = (p: Project) => textFontState(p, worldTexts(p)[0])
  const edit = (p: Project, patch: Parameters<typeof patchTexts>[2]) => patchTexts(p, worldTexts(p), patch)

  it("moving, turning and mirroring carry the outlines along, exactly", () => {
    let p = p0()
    const ref = textInk(p, worldTexts(p)[0]).outlines![0]
    p = edit(p, { x: 15, y: -2 })
    expect(state(p)).toBe("outline")
    const moved = textInk(p, worldTexts(p)[0]).outlines![0]
    expect(moved[0][0].x - ref[0][0].x).toBeCloseTo(5, 6)
    expect(moved[0][0].y - ref[0][0].y).toBeCloseTo(-2 - -5, 6)
    expect(area(moved)).toBeCloseTo(3, 6)
    p = edit(p, { rot: 135 })
    expect(state(p)).toBe("outline")
    p = edit(p, { mirror: true })
    expect(state(p)).toBe("outline")
    expect(area(textInk(p, worldTexts(p)[0]).outlines![0])).toBeCloseTo(3, 6)
  })

  it("moving a text and moving it back gives the very rings that were stored", () => {
    let p = p0()
    const o = p.texts[0].outline!
    const stored = outlineRings(o, { x: p.texts[0].x, y: p.texts[0].y, rot: p.texts[0].rot, mirror: false })
    expect(stored).toBe(outlineRings(o, { x: p.texts[0].x, y: p.texts[0].y, rot: p.texts[0].rot, mirror: false }))
    p = edit(edit(p, { x: 30 }), { x: 10 })
    expect(textInk(p, worldTexts(p)[0]).box).toEqual(textInk(p0(), worldTexts(p0())[0]).box)
  })

  it.each([
    ["its content", { text: "Ho" }],
    ["its size", { size: 2 }],
    ["its width", { w: 3 }],
    ["bold", { bold: true }],
    ["italic", { italic: true }],
    ["its justification", { hj: "left" as const }],
    ["its line spacing", { spacing: 1.5 }],
  ])("changing %s leaves the stroke font, with the marker and the note", (_what, patch) => {
    const p = edit(p0(), patch)
    expect(state(p)).toBe("edited")
    const [wt] = worldTexts(p)
    expect(textInk(p, wt).outlines).toBeUndefined()
    expect(textInk(p, wt).strokes.length).toBeGreaterThan(0)
    expect(fontNotes(p, [wt])[0]).toMatch(/Edited, so the outlines KiCad drew in Ubuntu Sans are gone/)
  })

  it("changing it back brings the outlines back (nothing was thrown away)", () => {
    const back = edit(edit(p0(), { size: 2 }), { size: 1 })
    expect(state(back)).toBe("outline")
  })

  it("asking for KiCad's own font drops the font's name and the outlines", () => {
    const p = edit(p0(), { face: null })
    expect(p.texts[0].face).toBeUndefined()
    expect(p.texts[0].outline).toBeUndefined()
    expect(state(p)).toBeNull()
  })

  it("a hidden outline stays valid while the part's reference text still shows what it did", () => {
    const r = imported(
      board({ body: [footprint({ ref: "R1", pads: [pad({ number: "1", at: "-1 0" })], extra: "" }).replace(/\(property "Reference" "R1" \(at 0 -1.5 0\) \(layer "F.SilkS"\) \(effects \(font \(size 1 1\) \(thickness 0.15\)\)\)\)/, `(property "Reference" "R1" (at 0 -1.5 0) (layer "F.SilkS") (effects (font (face "Ubuntu Sans") (size 1 1) (thickness 0.15))) (render_cache "R1" 0 ${SQUARE}))`)] }),
    )
    const wt = worldTexts(r).find((t) => t.kind === "reference")!
    expect(currentOutline(r, wt)).not.toBeNull()
    const renamed = { ...r, components: r.components.map((c) => ({ ...c, ref: "R9" })) }
    expect(currentOutline(renamed, worldTexts(renamed).find((t) => t.kind === "reference")!)).toBeNull()
  })
})

describe("a part's text with outlines when the part is edited", () => {
  const part = (unlocked = "") => imported(board({ body: [footprint({ pads: [pad({ number: "1", at: "-1 0" })], layer: "F.Cu", at: "20 10 0", extra: `(fp_text user "Hi" (at 1 2 0 ${unlocked}) (layer "F.SilkS") (effects (font (face "Ubuntu Sans") (size 1 1) (thickness 0.15))) (render_cache "Hi" 0 ${SQUARE}))` })] }))
  const own = (p: Project) => worldTexts(p).find((t) => t.outline)!
  const move = (p: Project, pcb: Partial<Project["components"][number]["pcb"]>) => updateComponent(p, p.components[0].id, { pcb: { ...p.components[0].pcb, ...pcb } })

  it("moving the part carries the outlines along, and flipping it to the other side keeps them valid", () => {
    const p = part()
    const was = textInk(p, own(p)).box!
    const moved = move(p, { x: p.components[0].pcb.x + 7, y: p.components[0].pcb.y + 3 })
    expect(textFontState(moved, own(moved))).toBe("outline")
    const box = textInk(moved, own(moved)).box!
    expect(box.minX - was.minX).toBeCloseTo(7, 6)
    expect(box.minY - was.minY).toBeCloseTo(3, 6)
    const flipped = move(p, { side: "bottom" })
    expect(textFontState(flipped, own(flipped))).toBe("outline")
    expect(area(textInk(flipped, own(flipped)).outlines![0])).toBeCloseTo(3, 6)
  })

  it("turning the part through half a turn keeps the outlines, upright or not", () => {
    for (const extra of ["", "unlocked"]) {
      const p = part(extra)
      for (const rot of [80, 100, 170, 190, 260, 280]) {
        const turned = move(p, { rot })
        expect(textFontState(turned, own(turned)), `${extra} ${rot}`).toBe("outline")
        expect(area(textInk(turned, own(turned)).outlines![0]), `${extra} ${rot}`).toBeCloseTo(3, 4)
      }
    }
  })
})

describe("a knockout text with outlines", () => {
  it("keeps them, and is a box with the letters cut out of it", () => {
    const p = imported(withText(text().replace("(layer \"F.SilkS\")", '(layer "F.SilkS" knockout)')))
    const [wt] = worldTexts(p)
    expect(wt.knockout).toBe(true)
    expect(textFontState(p, wt)).toBe("outline")
    const ink = textInk(p, wt)
    expect(ink.hull).toBeDefined()
    expect(ink.outlines).toHaveLength(1)
    const lt = layerText(p, wt)!
    expect(lt.fills.length).toBeGreaterThan(0)
  })
})

describe("the project file", () => {
  it("saves and loads a text's font and outlines with no difference, edited or not", () => {
    const p = imported(withText(text()))
    const back = parseProjectFile(serializeProject(p), { id: p.id })
    expect(back.texts).toEqual(p.texts)
    const edited = patchTexts(p, worldTexts(p), { size: 2 })
    const again = parseProjectFile(serializeProject(edited), { id: p.id })
    expect(again.texts).toEqual(edited.texts)
    expect(again.texts[0].outline).toEqual(p.texts[0].outline)
  })

  it("does the same for a part's text, and a text box's", () => {
    const fp = footprint({ pads: [pad({ number: "1", at: "-1 0" })], extra: `(fp_text user "Hi" (at 1 2 0) (layer "F.SilkS") (effects (font (face "Ubuntu Sans") (size 1 1) (thickness 0.15))) (render_cache "Hi" 0 ${SQUARE}))` })
    const box = `(gr_text_box "Hi" (start 8 3) (end 12 7) (layer "F.SilkS") (uuid "d0000000-0000-4000-8000-000000000002") (effects (font (face "Verdana") (size 1 1) (thickness 0.15)) (justify top)) (border yes) (stroke (width 0.15) (type solid)) (render_cache "Hi" 0 ${SQUARE}))`
    const p = imported(board({ body: [fp, box] }))
    const back = parseProjectFile(serializeProject(p), { id: p.id })
    expect(back.components[0].texts).toEqual(p.components[0].texts)
    expect(back.texts).toEqual(p.texts)
    expect(p.components[0].texts!.some((t) => t.outline)).toBe(true)
    expect(p.texts[0].box).toBeDefined()
  })

  it("drops outlines that do not read, and keeps the font's name", () => {
    const p = imported(withText(text()))
    const file = JSON.parse(serializeProject(p))
    file.project.texts[0].outline = "!!!"
    const back = parseProjectFile(file, { id: "x" })
    expect(back.texts[0].face).toBe("Ubuntu Sans")
    expect(back.texts[0].outline).toBeUndefined()
  })
})

describe("the KiCad export", () => {
  it("writes the font's name and the outlines back, and reads back as the same project", async () => {
    const p = imported(withText(text({ at: "10 5 20" })))
    const out = await pcbOf(p)
    expect(unknownNodes(out)).toEqual([])
    expect(out).toMatch(/\(face "Ubuntu Sans"\)/)
    expect(out).toMatch(/\(render_cache "Hi" 0/)
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project)).toEqual([])
    expect(again.project.texts[0].outline?.rings).toBe(p.texts[0].outline?.rings)
  })

  it("writes the outlines moved with the text, and none for an edited one (KiCad draws that from the font)", async () => {
    const p = imported(withText(text({ at: "10 5 0" })))
    const moved = patchTexts(p, worldTexts(p), { x: 20 })
    const out = await pcbOf(moved)
    const m = /\(render_cache "Hi" 0([\s\S]*?)\n\s*\)\n\s*\)/.exec(out)
    expect(m).not.toBeNull()
    expect(out).toContain("(xy 19 4)")
    const edited = patchTexts(p, worldTexts(p), { text: "Ho" })
    const text2 = await pcbOf(edited)
    expect(text2).not.toMatch(/render_cache/)
    expect(text2).toMatch(/\(face "Ubuntu Sans"\)/)
  })

  it("the written angle of a cache follows the text's turn", async () => {
    const p = imported(withText(text({ at: "10 5 0" })))
    const turned = patchTexts(p, worldTexts(p), { rot: 135 })
    const out = await pcbOf(turned)
    const angle = Number(/\(render_cache "Hi" (-?[\d.]+)/.exec(out)![1])
    expect([135, 225]).toContain(((angle % 360) + 360) % 360)
    expect(out).toMatch(/\(at 10 5 (135|225)\)/)
    const at = Number(/\(at 10 5 ([\d.]+)\)/.exec(out)![1])
    expect(angle).toBeCloseTo(at, 6)
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(textFontState(again.project, worldTexts(again.project)[0])).toBe("outline")
  })

  it("a cache that names no font is kept, and the made-up name is never written as one", async () => {
    const p = imported(withText(text({ face: null })))
    expect(p.texts[0].face).toBe(UNNAMED_FONT)
    expect(p.texts[0].outline).toBeDefined()
    const out = await pcbOf(p)
    expect(out).not.toContain(UNNAMED_FONT)
    expect(out).not.toMatch(/\(face /)
    expect(out).toMatch(/\(render_cache "Hi"/)
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project)).toEqual([])
  })

  it("a part's text and a text box round trip too", async () => {
    const fp = footprint({ pads: [pad({ number: "1", at: "-1 0" })], at: "20 10 30", extra: `(fp_text user "Hi" (at 1 2 30) (layer "F.SilkS") (effects (font (face "Ubuntu Sans") (size 1 1) (thickness 0.15))) (render_cache "Hi" 30 ${SQUARE}))` })
    const box = `(gr_text_box "Hi" (start 8 3) (end 12 7) (layer "F.SilkS") (uuid "d0000000-0000-4000-8000-000000000002") (effects (font (face "Verdana") (size 1 1) (thickness 0.15)) (justify top)) (border yes) (stroke (width 0.15) (type solid)) (render_cache "Hi" 0 ${SQUARE}))`
    const p = imported(board({ body: [fp, box] }))
    const out = await pcbOf(p)
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project)).toEqual([])
  })
})

describe("embedded fonts", () => {
  // KiCad stores a font as zstd compressed bytes in base64 between two bars; the bytes are kept as they are.
  const bytes = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x60, 1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255, ...Array.from({ length: 200 }, (_, i) => (i * 7) % 256)])
  const b64 = Buffer.from(bytes).toString("base64")
  const data = `|${b64.slice(0, 40)}\n\t\t\t\t${b64.slice(40)}|`
  const fontFile = `(file (name "Roboto-Regular.ttf") (type font) (data ${data}) (checksum "D41D8CD98F00B204E9800998ECF8427E"))`
  const modelFile = `(file (name "R.step") (type model) (data |KLUv/WDa|) (checksum "ABC"))`
  const src = board({ body: [footprint({ pads: [pad({ number: "1", at: "-1 0" })] }), text(), `(embedded_files ${fontFile} ${modelFile})`, "(embedded_fonts yes)"] })

  it("are kept (name, size, hash, checksum, flag), and the model beside them is still named in the report", () => {
    const r = importKicadBoard(src)
    if (r.status !== "imported") throw new Error(r.message)
    const f = r.project.fonts!
    expect(f.board).toBe(true)
    expect(f.files).toHaveLength(1)
    expect(f.files[0]).toMatchObject({ name: "Roboto-Regular.ttf", size: bytes.length, checksum: "D41D8CD98F00B204E9800998ECF8427E" })
    expect(r.files!.find((k) => k.id === f.files[0].file)!.bytes).toEqual(bytes)
    expect(r.report.entries.find((e) => e.code === "embedded-file")!.object).toMatch(/R\.step/)
    expect(r.report.entries.some((e) => e.code === "embedded-file" && /Roboto/.test(e.object))).toBe(false)
    expect(r.report.entries.find((e) => e.code === "embedded-font")!.object).toMatch(/Roboto-Regular\.ttf/)
    // the project holds the hash, not the bytes
    expect(serializeProject(r.project).length).toBeLessThan(20_000)
    expect(serializeProject(r.project)).not.toContain(b64.slice(0, 30))
  })

  it("are written back as the file stored them, and read back as the same project", async () => {
    const r = importKicadBoard(src)
    if (r.status !== "imported") throw new Error(r.message)
    for (const k of r.files!) rememberImage(k.id, k.bytes.buffer.slice(k.bytes.byteOffset, k.bytes.byteOffset + k.bytes.byteLength) as ArrayBuffer)
    const out = await pcbOf(r.project)
    expect(unknownNodes(out)).toEqual([])
    expect(out).toMatch(/\(type font\)/)
    expect(out).toMatch(/\(embedded_fonts yes\)/)
    expect(out).not.toMatch(/R\.step/)
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(again.project.fonts!.files[0].file).toBe(r.project.fonts!.files[0].file)
    expect(diffProjects(r.project, again.project)).toEqual([])
  })

  it("that the account does not hold are left out of the export, and the export says so", async () => {
    const r = importKicadBoard(src.replace("Roboto-Regular.ttf", "Other.ttf").replace(b64.slice(0, 40), "KLUv/WDaAAAA".padEnd(40, "A")))
    if (r.status !== "imported") throw new Error(r.message)
    const files = await kicadFiles(r.project)
    expect(files.notes.join(" ")).toMatch(/embedded font file was left out/)
  })

  it("a font that does not decode is not brought in, and says so", () => {
    const r = importKicadBoard(board({ body: [footprint({ pads: [pad({ number: "1", at: "-1 0" })] }), `(embedded_files (file (name "x.ttf") (type font) (data |@@@|) (checksum "A")))`] }))
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.project.fonts).toBeUndefined()
    expect(r.report.entries.some((e) => e.code === "embedded-font" && e.severity === "not-brought")).toBe(true)
  })

  it("a footprint's own embedded fonts and flag are kept on its part", async () => {
    const fp = footprint({ ref: "U1", pads: [pad({ number: "1", at: "-1 0" })], extra: `(embedded_files ${fontFile}) (embedded_fonts yes)` })
    const r = importKicadBoard(board({ body: [fp] }))
    if (r.status !== "imported") throw new Error(r.message)
    const c = r.project.components[0]
    expect(r.project.fonts!.parts).toEqual([c.id])
    expect(r.project.fonts!.files[0].owner).toBe(c.id)
    for (const k of r.files!) rememberImage(k.id, k.bytes.buffer.slice(k.bytes.byteOffset, k.bytes.byteOffset + k.bytes.byteLength) as ArrayBuffer)
    const out = await pcbOf(r.project)
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(r.project, again.project)).toEqual([])
  })

  it("a stored `fonts` that does not read is dropped by what it says, and a good one is kept", () => {
    const p = importKicadBoard(src)
    if (p.status !== "imported") throw new Error(p.message)
    const raw = JSON.parse(serializeProject(p.project))
    const ORIGIN = { id: "p1", createdAt: 1, updatedAt: 1 }
    expect(parseProjectFile(JSON.parse(JSON.stringify(raw)), ORIGIN).fonts).toEqual(p.project.fonts)
    for (const bad of [{}, "x", [], { files: "no" }, { files: [null, 3, { name: 1 }, { name: "a", file: "short", size: 1 }] }]) {
      const copy = JSON.parse(JSON.stringify(raw))
      copy.project.fonts = bad
      expect(parseProjectFile(copy, ORIGIN).fonts).toBeUndefined()
    }
    const copy = JSON.parse(JSON.stringify(raw))
    copy.project.fonts.files.push({ name: "x.ttf", file: "nothex", size: 3 }, { name: "y.ttf", file: "a".repeat(64), size: 3, owner: "gone" })
    expect(parseProjectFile(copy, ORIGIN).fonts).toEqual(p.project.fonts)
  })

  it("a board that is over the size limit only for its outlines keeps its text without them, and says so", () => {
    const full = importKicadBoard(withText(text()))
    if (full.status !== "imported") throw new Error(full.message)
    const bare = { ...full.project, texts: full.project.texts.map(({ outline: _o, ...t }) => t) }
    const limit = serializeProject(bare).length
    expect(serializeProject(full.project).length).toBeGreaterThan(limit)
    const r = importKicadBoard(withText(text()), { limitBytes: limit })
    if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
    expect(r.project.texts[0].face).toBe("Ubuntu Sans")
    expect(r.project.texts[0].outline).toBeUndefined()
    expect(textFontState(r.project, worldTexts(r.project)[0])).toBe("uncached")
    expect(r.report.entries.some((e) => e.code === "text-outlines-dropped" && e.severity === "changed")).toBe(true)
    expect(r.report.entries.some((e) => e.code === "text-outlines")).toBe(false)
    expect(r.bytes).toBeLessThanOrEqual(limit)
    // a board that is over the limit without them too is still refused
    expect(importKicadBoard(withText(text()), { limitBytes: limit - 1 }).status).toBe("refused")
  })

  it("a board with no fonts has no `fonts` at all", () => {
    expect(imported(withText(text())).fonts).toBeUndefined()
  })
})

describe("what X19 does not touch", () => {
  it("text in the editor's own font is drawn and plotted as before", () => {
    const p = createProject("t", "")
    const t: BoardText = { id: "kt1", text: "abc", layer: "F.SilkS", x: 0, y: 0, size: 1, rot: 0, side: "top" }
    const q = { ...p, texts: [t] }
    const [wt] = worldTexts(q)
    expect(textFontState(q, wt)).toBeNull()
    expect(textInk(q, wt).strokes.length).toBeGreaterThan(0)
    expect(textInk(q, wt).outlines).toBeUndefined()
  })
})

describe("polygons from rings", () => {
  it("groups a hole with the outline it is in and leaves two letters apart", () => {
    const sq = (x: number, y: number, s: number, cw = false) => {
      const pts = [x, y, x + s, y, x + s, y + s, x, y + s]
      return (cw ? [pts[0], pts[1], pts[6], pts[7], pts[4], pts[5], pts[2], pts[3]] : pts).map((v) => v * 1e6)
    }
    const polys = ringsToPolygons([sq(0, 0, 4), sq(1, 1, 2, true), sq(10, 0, 2)])
    expect(polys).toHaveLength(2)
    expect(polys.map((g) => g.length).sort()).toEqual([1, 2])
  })
})

describe("a pose maps a text's shape as the layout does", () => {
  // The outlines are carried from the pose they were drawn at to the pose the text has now. This holds only if KiCad's layout of a text is the same shape under
  // any move, turn and mirror: the stroke layout (checked against KiCad's own in the corpus tests) is laid out at two poses, and the first mapped to the second.
  const pose = (x: number, y: number, rot: number, mirror: boolean, hj?: "left" | "right", vj?: "top" | "bottom"): BoardText => ({ id: "kt1", text: "Rb7 g\nQ", layer: "F.SilkS", x, y, size: 1.2, rot, side: "top", ...(mirror ? { mirror: true as const } : {}), ...(hj ? { hj } : {}), ...(vj ? { vj } : {}) })
  const strokes = (t: BoardText) => {
    const p = { ...createProject("t", ""), texts: [t] }
    return textInk(p, worldTexts(p)[0]).strokes
  }
  const cases: [BoardText, BoardText][] = [
    [pose(10, 5, 0, false), pose(14, -3, 0, false)],
    [pose(10, 5, 0, false), pose(10, 5, 37.5, false)],
    [pose(10, 5, 20, false, "left", "top"), pose(-3, 8, 200, false, "left", "top")],
    [pose(10, 5, 0, false, "right"), pose(10, 5, 0, true, "right")],
    [pose(10, 5, 30, false, "left", "bottom"), pose(2, 2, 100, true, "left", "bottom")],
    [pose(10, 5, 90, true), pose(10, 5, 270, false)],
  ]
  it.each(cases.map((c, i) => [i, ...c] as const))("case %i", (_i, a, b) => {
    const was = strokes(a)
    const now = strokes(b)
    // the first as rings, mapped by the pose, against the second
    const o = { text: "", angle: 0, sig: "", at: { x: a.x, y: a.y, rot: a.rot, ...(a.mirror ? { mirror: true as const } : {}) }, rings: packRings([was.map((l) => l.flatMap((p) => [Math.round(p.x * 1e6), Math.round(p.y * 1e6)]))]) }
    const mapped = outlineRings(o, { x: b.x, y: b.y, rot: b.rot, mirror: b.mirror === true })[0]
    expect(mapped).toHaveLength(now.length)
    mapped.forEach((ring, i) => {
      expect(ring).toHaveLength(now[i].length * 2)
      now[i].forEach((p, k) => {
        expect(Math.abs(ring[2 * k] / 1e6 - p.x)).toBeLessThan(4e-6)
        expect(Math.abs(ring[2 * k + 1] / 1e6 - p.y)).toBeLessThan(4e-6)
      })
    })
  })
})
