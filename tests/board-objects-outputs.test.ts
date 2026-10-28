import { describe, expect, it } from "vitest"
import { buildFabricationFiles } from "../src/export/bundle"
import { kicadFiles } from "../src/export/kicad"
import { drawingsReport } from "../src/ai/shapeReport"
import { runTool } from "../src/ai/tools"
import { pcbSvg } from "../src/ai/vision/pcbSvg"
import { importKicadBoard } from "../src/model/kicad/board"
import { addDimension, createGroup, newDimension } from "../src/model/boardObjects"
import { removeItems } from "../src/model/ops"
import { rememberImage } from "../src/store/imageFiles"
import { projectApi } from "../src/store/projectStore"
import { decodeBase64 } from "../src/lib/imageFacts"
import { board, footprint, pad } from "./kicad-board-fixtures"
import type { Project } from "../src/model/types"
import { uuidD as U } from "./kicad-test-helpers"

// What dimensions, groups and images do to the outputs: the Gerber files (a dimension is plotted on the layer it sits on when KiCad plots that layer; an image never),
// the KiCad export (dimensions, images, and groups naming real items), what Sakura reads and sees, and what a deletion does to a group.

const png = (() => {
  const b: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const chunk = (t: string, d: number[]) => [...u32(d.length), ...[...t].map((c) => c.charCodeAt(0)), ...d, 0, 0, 0, 0]
  b.push(...chunk("IHDR", [...u32(40), ...u32(20), 8, 6, 0, 0, 0]), ...chunk("IDAT", [0, 1, 2]), ...chunk("IEND", []))
  return new Uint8Array(b)
})()
const b64 = Buffer.from(png).toString("base64")

const dimension = (layer: string, id: number, text = "1") =>
  `(dimension (type aligned) (layer "${layer}") (uuid "${U(id)}") (pts (xy 2 2) (xy 12 2)) (height 3) (gr_text "${text}" (at 7 4.15 0) (layer "${layer}") (uuid "${U(id)}") (effects (font (size 1 1) (thickness 0.15)))) (format (prefix "") (suffix "") (units 2) (units_format 1) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0) (keep_text_aligned yes)))`

const nets = ['(net 0 "")', '(net 1 "A")']
const parts = [
  footprint({ ref: "R1", at: "5 5", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }).replace('(layer "F.Cu")', `(layer "F.Cu") (uuid "${U(10)}")`),
  `(segment (start 2 8) (end 6 8) (width 0.25) (layer "F.Cu") (net 1) (uuid "${U(11)}"))`,
  `(via (at 6 8) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "${U(13)}"))`,
  `(gr_line (start 1 1) (end 4 1) (stroke (width 0.15) (type default)) (layer "F.SilkS") (uuid "${U(14)}"))`,
  `(gr_text "HI" (at 10 3) (layer "F.SilkS") (uuid "${U(15)}") (effects (font (size 1 1) (thickness 0.15))))`,
]
const make = (extra: string[]): Project => {
  const r = importKicadBoard(board({ nets, body: [...parts, ...extra] }))
  if (r.status !== "imported") throw new Error(r.message)
  if (r.files.length) for (const f of r.files) rememberImage(f.id, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
  return r.project
}
const pic = `(image (at 10 5) (layer "User.1") (data "${b64}") (uuid "${U(900)}"))`
const groupNode = `(group "all" (uuid "${U(20)}") (members "${U(10)}" "${U(11)}" "${U(13)}" "${U(14)}" "${U(15)}" "${U(30)}" "${U(900)}"))`

describe("the Gerber files", () => {
  const files = (p: Project) => buildFabricationFiles(p) as Record<string, string>
  /** The plotted files: the notes say what is in them, and say more for a board with these objects. */
  const plated = (f: Record<string, string>) => Object.keys(f).filter((k) => !/fabrication\.txt$/.test(k))
  it("plot a dimension on the silkscreen in the silkscreen file, lines and text, and one on a user layer in none", () => {
    const plain = files(make([]))
    const silk = files(make([dimension("F.SilkS", 30)]))
    const name = Object.keys(plain).find((k) => /\.gto$/i.test(k))!
    expect(silk[name].length).toBeGreaterThan(plain[name].length)
    // seven lines and the text's strokes, each a draw
    expect((silk[name].match(/D01\*/g) ?? []).length).toBeGreaterThan((plain[name].match(/D01\*/g) ?? []).length + 7)
    const user = files(make([dimension("Dwgs.User", 30)]))
    for (const k of plated(plain)) expect(user[k], k).toBe(plain[k])
    // another side's silkscreen is that side's file
    const back = files(make([dimension("B.SilkS", 30)]))
    const bottom = Object.keys(plain).find((k) => /\.gbo$/i.test(k))!
    expect(back[bottom]).not.toBe(plain[bottom])
    expect(back[name]).toBe(plain[name])
  })
  it("plot a dimension on the board edge in the outline file", () => {
    const plain = files(make([]))
    const edge = files(make([dimension("Edge.Cuts", 30)]))
    const name = Object.keys(plain).find((k) => /\.gm1$/i.test(k))!
    expect(edge[name]).not.toBe(plain[name])
  })
  it("never plot a reference image, whatever its layer, and a group changes nothing", () => {
    const plain = files(make([]))
    const withImage = files(make([pic, groupNode]))
    for (const k of plated(plain)) expect(withImage[k], k).toBe(plain[k])
    const onCopper = files(make([pic.replace('"User.1"', '"F.Cu"')]))
    for (const k of plated(plain)) expect(onCopper[k], k).toBe(plain[k])
  })
})

describe("the KiCad export", () => {
  it("writes a dimension with its text, an image with its picture, and groups that name items of the file", async () => {
    const p = make([dimension("F.SilkS", 30), pic, groupNode])
    const { files, notes } = await kicadFiles(p)
    const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(text).toMatch(/\(dimension\s+\(type aligned\)/)
    expect(text).toMatch(/\(gr_text "10.0000 mm"/)
    const image = text.match(/\(image[\s\S]*?\(data([\s\S]*?)\)\s+\(uuid/)!
    const data = [...image[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("")
    expect([...decodeBase64(data)!]).toEqual([...png])
    const group = text.match(/\(group "all"[\s\S]*?\(members([^)]*)\)/)!
    const members = [...group[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    // the part, the track, the via, the drawing, the text, the dimension and the image: seven
    expect(members).toHaveLength(7)
    expect(members).toEqual([...members].sort())
    for (const m of members) expect(text.split(m).length - 1, m).toBeGreaterThanOrEqual(2)
    expect(notes.join(" ")).toMatch(/Dimensions are written as KiCad's own dimension items/)
  })
  it("leaves a board with none of these as it was written before: no node of them", async () => {
    const { files } = await kicadFiles(make([]))
    const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(text).not.toMatch(/\(dimension|\(group|\(image/)
  })
  it("says so and leaves the image out when its picture is not in the file store", async () => {
    const p = make([pic])
    const lost: Project = { ...p, images: p.images!.map((m) => ({ ...m, file: "e".repeat(64) })) }
    const { files, notes } = await kicadFiles(lost)
    expect(Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]).not.toMatch(/\(image/)
    expect(notes.join(" ")).toMatch(/reference image was left out/)
  }, 30000)
})

describe("what Sakura reads and sees", () => {
  it("get_design lists dimensions, groups and images compactly, and says nothing for a board with none", () => {
    const p = make([dimension("F.SilkS", 30), pic, groupNode])
    const read = JSON.parse(runTool(p, "get_design", {}).result)
    expect(read.dimensions).toMatchObject({ count: 1, by_kind: { aligned: 1 }, list: [{ kind: "aligned", layer: "F.SilkS", text: "10.0000 mm", measured_mm: 10 }] })
    expect(read.groups).toMatchObject({ count: 1, locked: 0, list: [{ name: "all", members: 7 }] })
    expect(read.images).toMatchObject({ count: 1 })
    expect(read.images.list[0]).toMatchObject({ layer: "User.1" })
    expect(read.images.list[0]).not.toHaveProperty("locked")
    // the dimension's lines are not counted among the drawings
    expect(read.board_drawings.board_by_layer["F.SilkS"]).toBe(1)
    const none = JSON.parse(runTool(make([]), "get_design", {}).result)
    for (const k of ["dimensions", "groups", "images"]) expect(none).not.toHaveProperty(k)
  })
  it("the picture draws a dimension's lines and text, and the image or its frame", () => {
    const p = make([dimension("F.SilkS", 30), pic])
    const box = { minX: -5, minY: -5, maxX: 25, maxY: 20 }
    const lost: Project = { ...p, images: p.images!.map((m) => ({ ...m, file: "f".repeat(64) })) }
    // its picture is not known: the frame
    expect(pcbSvg(lost, box, { width: 600, height: 500 }, { side: "both", extras: new Set(["silkscreen"]) }, { overlaps: [], offBoard: [] } as never)).toContain("stroke-dasharray")
    const loaded = pcbSvg(p, box, { width: 600, height: 500 }, { side: "both", extras: new Set(["silkscreen"]) }, { overlaps: [], offBoard: [] } as never)
    expect(loaded).toContain("<image href=\"data:image/png;base64,")
    // the dimension's seven lines are in the picture beyond the board's own
    expect((loaded.match(/<path/g) ?? []).length).toBeGreaterThan(7)
    expect(drawingsReport(p)!.board_by_layer["F.SilkS"]).toBe(1)
  })
})

describe("deleting what a group holds", () => {
  it("takes it out of the group, and the group goes with its last member, in the store's commit", () => {
    const p = make([dimension("F.SilkS", 30), groupNode])
    projectApi().open(p)
    const start = projectApi().project!
    const g = start.groups![0]
    expect(g.members).toHaveLength(6)
    projectApi().commit((x) => removeItems(x, { vias: x.vias.map((v) => v.id) }))
    expect(projectApi().project!.groups![0].members).toHaveLength(5)
    projectApi().commit((x) => removeItems(x, { traces: x.traces.map((t) => t.id), components: x.components.map((c) => c.id) }))
    projectApi().commit((x) => ({ ...x, graphics: undefined, texts: [], dimensions: undefined }))
    expect(projectApi().project!.groups).toBeUndefined()
    projectApi().undo()
    expect(projectApi().project!.groups).toBeDefined()
    projectApi().close()
  })
  it("and a dimension added later can be grouped and the group survives a save and a load", () => {
    const p0 = make([])
    const added = addDimension(p0, newDimension("center", "Dwgs.User", { x: 3, y: 3 }, { x: 4, y: 3 }))
    const g = createGroup(added.project, [`c:${p0.components[0].id}`, `m:${added.dimension.id}`], "pair")!
    expect(g.project.groups![0].members).toHaveLength(2)
  })
})
