import { describe, expect, it } from "vitest"
import { buildKicadProject, BUILT_EXTENSIONS, importKicadBoard, type ImportReport, needsOf, outlineOf, readKicadBoard } from "../src/model/kicad/board"
import { countPaths } from "../src/model/kicad/board/account"
import { dimensionDrawing } from "../src/model/dimensions"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { sha256Hex } from "../src/lib/imageFacts"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { type Project } from "../src/model/types"
import { createHash } from "node:crypto"
import { importBody as imp, nearE5 as near, uuidD as U } from "./kicad-test-helpers"
import { kicadFiles } from "../src/export/kicad"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// The board objects slice: dimensions of both forms, groups (their ids, their members, nested ones, the groups inside a part), reference images, and what
// the gate says of what the editor still cannot hold (a dimension inside a footprint, a picture that is not a PNG or a JPEG).


const imported = (text: string, name?: string) => {
  const r = importKicadBoard(text, { name })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r
}

/** A PNG header with the size and, when given, pixels per metre: the header is all the importer reads. */
function png(px: number, py: number, perMetre?: number): Uint8Array {
  const b: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
  b.push(...chunk("IHDR", [...u32(px), ...u32(py), 8, 6, 0, 0, 0]))
  if (perMetre !== undefined) b.push(...chunk("pHYs", [...u32(perMetre), ...u32(perMetre), 1]))
  b.push(...chunk("IDAT", [0]), ...chunk("IEND", []))
  return new Uint8Array(b)
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
const image = (bytes: Uint8Array, extra = "(at 10 5) (layer \"User.1\")") => `(image ${extra} (data "${b64(bytes).slice(0, 40)}" "${b64(bytes).slice(40)}") (uuid "${U(900)}"))`

const aligned = (extra = "", id = 1) =>
  `(dimension (type aligned) (layer "Dwgs.User") (uuid "${U(id)}") (pts (xy 2 2) (xy 12 2)) (height 3) (gr_text "10.0000 mm" (at 7 4.15 0) (layer "Dwgs.User") (uuid "${U(id)}") (effects (font (size 1 1) (thickness 0.15)))) (format (prefix "") (suffix "") (units 2) (units_format 1) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0) keep_text_aligned)${extra})`

describe("a dimension of the typed format", () => {
  it("comes in whole, as KiCad holds it, and draws what KiCad draws", () => {
    const { project } = imported(board({ body: [aligned()] }))
    expect(project.dimensions).toHaveLength(1)
    const d = project.dimensions![0]
    expect(d).toMatchObject({ kind: "aligned", layer: "Dwgs.User", a: { x: 2, y: -2 }, b: { x: 12, y: -2 }, height: 3, thickness: 0.1, arrow: 1.27, extHeight: 0.58642, extOffset: 0, units: 2, format: 1, precision: 4, keep: true, size: 1, tw: 0.15 })
    expect(d.id).toBe("dm1")
    const draw = dimensionDrawing(d)
    expect(draw.lines).toHaveLength(7)
    expect(draw.measured).toBe(10_000_000)
    expect(draw.text!.content).toBe("10.0000 mm")
    // crossbar at 3 below the points in KiCad's frame, so at y = -5 here
    expect(draw.lines.some((l) => near(l.a.y, -5) && near(l.b.y, -5) && Math.abs(l.b.x - l.a.x) > 9)).toBe(true)
  })
  it("a bare keep_text_aligned in the style is the flag on, as KiCad's parser reads it; without it the text does not turn", () => {
    const keep = imported(board({ body: [aligned()] })).project.dimensions![0]
    expect(keep.keep).toBe(true)
    const without = aligned().replace(" keep_text_aligned", "")
    expect(imported(board({ body: [without] })).project.dimensions![0].keep).toBeUndefined()
    expect(imported(board({ body: [aligned().replace(" keep_text_aligned", " (keep_text_aligned yes)")] })).project.dimensions![0].keep).toBe(true)
    expect(imported(board({ body: [aligned().replace(" keep_text_aligned", " (keep_text_aligned no)")] })).project.dimensions![0].keep).toBeUndefined()
  })
  it("takes the constructor's settings for what the file leaves out, per kind: a leader says Leader, a radius starts with R, a centre mark has no text", () => {
    const leader = '(dimension (type leader) (layer "Dwgs.User") (pts (xy 2 2) (xy 6 4)) (gr_text "x" (at 8 4 0) (layer "Dwgs.User") (effects (font (size 1 1) (thickness 0.15)))) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (text_frame 1) (extension_offset 0)))'
    const radial = '(dimension (type radial) (layer "Dwgs.User") (pts (xy 5 5) (xy 8 5)) (gr_text "R 3" (at 10 5 0) (layer "Dwgs.User") (effects (font (size 1 1) (thickness 0.15)))))'
    const center = '(dimension (type center) (layer "Dwgs.User") (pts (xy 5 5) (xy 7 5)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_offset 0)))'
    const { project } = imported(board({ body: [leader, radial, center] }))
    const [l, r, c] = project.dimensions!
    expect(l).toMatchObject({ kind: "leader", override: "Leader", frame: 1, format: 0 })
    expect(r).toMatchObject({ kind: "radial", prefix: "R ", leaderLength: 3.81, keep: true, format: 0 })
    expect(dimensionDrawing(r).text!.content).toBe("R 0.1181")
    expect(c.kind).toBe("center")
    expect(dimensionDrawing(c).text).toBeNull()
    expect(c).not.toHaveProperty("override")
  })
  it("clamps what KiCad clamps: a text position of 3 is by hand, a units mode of 4 changes nothing, a unit format of 3 shows no unit", () => {
    const text = aligned().replace("(units 2) (units_format 1)", "(units 4) (units_format 3)").replace("(text_position_mode 0)", "(text_position_mode 3)")
    const d = imported(board({ body: [text] })).project.dimensions![0]
    expect(d.textMode).toBe(2)
    // the constructor's inches stay when the mode is not one KiCad knows
    expect(d.units).toBe(0)
    expect(d.format).toBe(3)
    expect(dimensionDrawing(d).text!.content).toBe("0.3937")
  })
  it("reads a lock in any spelling, on the dimension or its text", () => {
    const a = imported(board({ body: [aligned().replace("(type aligned)", "(type aligned) (locked yes)")] })).project.dimensions![0]
    expect(a.locked).toBe(true)
    const b = imported(board({ body: [aligned().replace("(dimension (type aligned)", "(dimension locked (type aligned)")] })).project.dimensions![0]
    expect(b.locked).toBe(true)
    const c = imported(board({ body: [aligned().replace("(uuid \"d0000000-0000-4000-8000-000000000001\") (effects", "(locked yes) (effects")] })).project.dimensions![0]
    expect(c).toBeDefined()
  })
  it("a precision of V_VVV (7) and the units a file chose are kept, and shown by KiCad's digits", () => {
    const text = aligned().replace("(units 2) (units_format 1) (precision 4)", "(units 0) (units_format 2) (precision 7)")
    const d = imported(board({ body: [text] })).project.dimensions![0]
    expect(d).toMatchObject({ units: 0, format: 2, precision: 7 })
    expect(dimensionDrawing(d).text!.content).toBe("0.394 (in)")
  })
  it("moves a dimension on a layer that is not KiCad's to Cmts.User, as KiCad's rescue does, and refuses one on an inner copper layer the board lacks", () => {
    const odd = importKicadBoard(board({ body: [aligned().replace(/"Dwgs.User"/g, '"Nonsense"')] }))
    expect(odd.status === "imported" && odd.project.dimensions?.[0].layer).toBe("Cmts.User")
    const inner = importKicadBoard(board({ body: [aligned().replace(/"Dwgs.User"/g, '"In1.Cu"')] }))
    expect(inner.status).toBe("refused")
  })
  it("a dimension inside a footprint is the board's dimension of the same points (X27), and the report says it no longer moves with the part", () => {
    const fp = footprint({ pads: [pad({ at: "0 0" })], extra: `(dimension (type aligned) (layer "F.Fab") (uuid "${U(7)}") (pts (xy -1 0) (xy 1 0)) (height 1) (gr_text "2" (at 0 1 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.1)))) (format (prefix "") (suffix "") (units 2) (units_format 1) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0)))` })
    const r = importKicadBoard(board({ body: [fp] }))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    // the same dimension drawn on the board itself is the same dimension (the points are the board's in every file the importer reads)
    const own = fp.match(/\(dimension [\s\S]*?\(extension_offset 0\)\)\)/)![0]
    const alone = importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "0 0" })] }), own] }))
    expect(alone.status === "imported" && alone.project.dimensions).toEqual(r.project.dimensions)
    expect(r.project.dimensions).toHaveLength(1)
    expect(r.report.entries.find((e) => e.code === "dimensions-flattened")).toMatchObject({ severity: "changed", count: 1 })
    expect(BUILT_EXTENSIONS.has("X27")).toBe(true)
    // a file of stamp 20260616 keeps a part's other drawings in the part's frame, but a dimension's points are the board's all the same (X27)
    const lib = importKicadBoard(board({ version: 20260616, body: [fp] }))
    expect(lib.status === "imported" && lib.project.dimensions).toEqual(r.project.dimensions)
  })
})

describe("a dimension's format as KiCad 6 and 7 write it", () => {
  // `suppress_zeroes` bare, as `keep_text_aligned` is in the style: the flag set (KiCad's `parseMaybeAbsentBool`)
  const kicad6 = `(dimension (type aligned) (layer "Dwgs.User") (tstamp ${U(7)}) (pts (xy 2 2) (xy 12 2)) (height 3) (gr_text "10 mm" (at 7 4.15 0) (layer "Dwgs.User") (tstamp ${U(8)}) (effects (font (size 1 1) (thickness 0.15)))) (format (units 3) (units_format 1) (precision 4) suppress_zeroes) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0.5) keep_text_aligned))`

  it("imports, with trailing zeros left off", () => {
    const r = imported(board({ version: 20211014, body: [kicad6] }))
    expect(r.project.dimensions).toHaveLength(1)
    expect(r.project.dimensions![0].zeros).toBe(true)
  })

  it("without the word keeps the zeros", () => {
    const r = imported(board({ version: 20211014, body: [kicad6.replace(" suppress_zeroes)", ")")] }))
    expect(r.project.dimensions![0].zeros).toBeUndefined()
  })
})

describe("a dimension of KiCad 5", () => {
  const legacy = (text: string, extra = "") =>
    `(dimension 10 (width 0.15) (layer Dwgs.User) (gr_text "${text}" (at 13.4 7 270) (layer Dwgs.User) (effects (font (size 1.5 1.5) (thickness 0.3)))) (feature1 (pts (xy 2 2) (xy 2 12))) (feature2 (pts (xy 12 2) (xy 12 12))) (crossbar (pts (xy 12 10) (xy 2 10))) (arrow1a (pts (xy 2 10) (xy 3.1265 10.5864))) (arrow1b (pts (xy 2 10) (xy 3.1265 9.4136))) (arrow2a (pts (xy 12 10) (xy 10.8735 10.5864))) (arrow2b (pts (xy 12 10) (xy 10.8735 9.4136)))${extra})`
  it("is an aligned dimension whose height is its crossbar's distance, signed by the way round, and whose units are its text's", () => {
    const { project } = imported(board({ version: 20171130, body: [legacy("10 mm")] }))
    const d = project.dimensions![0]
    expect(d).toMatchObject({ kind: "aligned", a: { x: 2, y: -2 }, b: { x: 12, y: -2 }, thickness: 0.15, units: 2, format: 1, precision: 4, keep: true, arrow: 1.27, size: 1.5, tw: 0.3 })
    // the crossbar is 8 below the points: positive when it is on the side of (-dy, dx)
    expect(Math.abs(d.height!)).toBe(8)
    // what KiCad draws now is its own: four digits, the text beside the crossbar, aligned with it
    const draw = dimensionDrawing(d)
    expect(draw.text!.content).toBe("10.0000 mm")
    expect(draw.text!.x).not.toBeCloseTo(13.4)
  })
  it("draws the arrows of its file, which are KiCad's own shape: each cached arrow line is a line drawn", () => {
    const d = imported(board({ version: 20171130, body: [legacy("10 mm")] })).project.dimensions![0]
    const lines = dimensionDrawing(d).lines
    const flip = (x1: number, y1: number, x2: number, y2: number) => lines.some((l) => (near(l.a.x, x1, 2e-4) && near(l.a.y, -y1, 2e-4) && near(l.b.x, x2, 2e-4) && near(l.b.y, -y2, 2e-4)) || (near(l.b.x, x1, 2e-4) && near(l.b.y, -y1, 2e-4) && near(l.a.x, x2, 2e-4) && near(l.a.y, -y2, 2e-4)))
    expect(flip(2, 10, 3.1265, 10.5864) || flip(2, 10, 3.1265, 9.4136)).toBe(true)
    expect(flip(12, 10, 10.8735, 10.5864) || flip(12, 10, 10.8735, 9.4136)).toBe(true)
  })
  it("takes inches from a text that says in, mils from mils, and automatic units (millimetres) from a text with none; another unit is refused by name", () => {
    expect(imported(board({ version: 20171130, body: [legacy('0.3937 in')] })).project.dimensions![0].units).toBe(0)
    expect(imported(board({ version: 20171130, body: [legacy('393.7 mils')] })).project.dimensions![0].units).toBe(1)
    const none = imported(board({ version: 20171130, body: [legacy("10")] }))
    expect(none.project.dimensions![0].units).toBe(3)
    expect(none.report.entries.find((e) => e.code === "dimension-units-automatic")?.count).toBe(1)
    const um = importKicadBoard(board({ version: 20171130, body: [legacy("10000 um")] }))
    expect(um.status === "refused" && um.message).toMatch(/unit other than inches, mils or millimetres/)
  })
  it("says in the report that KiCad redraws it", () => {
    const r = imported(board({ version: 20171130, body: [legacy("10 mm")] }))
    expect(r.report.entries.find((e) => e.code === "dimensions-redrawn")).toMatchObject({ severity: "changed", count: 1 })
    // its arrows are accounted for as derived, not carried
    expect(r.report.account!.unknownPaths.size).toBe(0)
    expect([...r.report.account!.notNeeded.keys()].some((k) => /KiCad does not read them and draws its own/.test(k))).toBe(true)
  })
})

// ---------- groups ----------

const seg = (x1: number, y1: number, x2: number, y2: number, id: number, net = "") => `(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.25) (layer "F.Cu") ${net} (uuid "${U(id)}"))`
const nets = ['(net 0 "")', '(net 1 "A")']
const group = (name: string, id: number, members: number[], extra = "") => `(group "${name}" (uuid "${U(id)}") ${extra} (members ${members.map((m) => `"${U(m)}"`).join(" ")}))`

describe("groups", () => {
  const items = (): string[] => [
    footprint({ ref: "R1", at: "5 5", pads: [pad({ at: "0 0", net: "(net 1 A)" })], extra: `(uuid "${U(10)}")` }).replace('(layer "F.Cu")', `(layer "F.Cu") (uuid "${U(10)}")`),
    seg(2, 8, 4, 8, 11, "(net 1)"),
    seg(4, 8, 6, 8, 12, "(net 1)"),
    `(via (at 6 8) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "${U(13)}"))`,
    `(gr_line (start 1 1) (end 4 1) (stroke (width 0.15) (type default)) (layer "F.SilkS") (uuid "${U(14)}"))`,
    `(gr_text "HI" (at 10 3) (layer "F.SilkS") (uuid "${U(15)}") (effects (font (size 1 1) (thickness 0.15))))`,
    `(target plus (at 15 5) (size 2) (width 0.1) (layer "F.SilkS") (uuid "${U(16)}"))`,
    aligned("", 17).replace(`(uuid "${U(17)}") (pts`, `(uuid "${U(17)}") (pts`),
  ]
  it("hold their members by the project's ids, in the file's order, and nest", () => {
    const { project } = imported(board({ nets, body: [...items(), group("inner", 20, [11, 12, 13]), group("outer", 21, [10, 14, 20, 15, 16, 17], "(locked yes)")] }))
    expect(project.groups).toHaveLength(2)
    const [inner, outer] = project.groups!
    expect(inner).toMatchObject({ id: "gp1", name: "inner" })
    expect(inner.locked).toBeUndefined()
    const trace = project.traces[0]
    expect(inner.members).toEqual([trace.id, project.vias[0].id])
    expect(outer).toMatchObject({ id: "gp2", name: "outer", locked: true })
    const part = project.components[0]
    // the target is three drawings, and every one is a member
    expect(outer.members).toEqual([part.id, project.graphics![0].id, "gp1", project.texts[0].id, project.graphics![1].id, project.graphics![2].id, project.graphics![3].id, project.dimensions![0].id])
    expect(project.graphics!.slice(1).map((g) => g.type).sort()).toEqual(["circle", "line", "line"])
  })
  it("do not join tracks across a group: two segments of one net in different groups are two traces, in one group one trace", () => {
    const apart = imported(board({ nets, body: [seg(2, 8, 4, 8, 11, "(net 1)"), seg(4, 8, 6, 8, 12, "(net 1)"), group("a", 20, [11]), group("b", 21, [12])] })).project
    expect(apart.traces).toHaveLength(2)
    expect(apart.groups!.map((g) => g.members.length)).toEqual([1, 1])
    const together = imported(board({ nets, body: [seg(2, 8, 4, 8, 11, "(net 1)"), seg(4, 8, 6, 8, 12, "(net 1)"), group("a", 20, [11, 12])] })).project
    expect(together.traces).toHaveLength(1)
    expect(together.groups![0].members).toEqual([together.traces[0].id])
    // one in a group and one in none: not joined either
    const half = imported(board({ nets, body: [seg(2, 8, 4, 8, 11, "(net 1)"), seg(4, 8, 6, 8, 12, "(net 1)"), group("a", 20, [11])] })).project
    expect(half.traces).toHaveLength(2)
    // a board with no group joins as it always did
    expect(imported(board({ nets, body: [seg(2, 8, 4, 8, 11, "(net 1)"), seg(4, 8, 6, 8, 12, "(net 1)")] })).project.traces).toHaveLength(1)
  })
  it("resolve as KiCad does: an item is in the last group that lists it, a group is never in itself or in a group inside it, ids that name nothing and empty groups are skipped", () => {
    const body = [
      ...items().slice(1, 5),
      group("a", 20, [14, 11, 99]),
      group("b", 21, [14, 21, 20]),
      group("c", 22, [20]),
      group("none", 23, [98]),
    ]
    const r = imported(board({ nets, body }))
    const g = r.project.groups!
    // b holds 14 (taken from a) and a (b is in a group a is not, so a goes into b); c holds a? a is already in b, so c takes it; b keeps 14 only
    expect(g.map((x) => x.name)).toEqual(["a", "b", "c"])
    const byName = (n: string) => g.find((x) => x.name === n)!
    expect(byName("b").members).toEqual([r.project.graphics![0].id])
    expect(byName("c").members).toEqual([byName("a").id])
    expect(byName("a").members).toEqual([r.project.traces[0].id])
    const entries = r.report.entries.map((e) => e.code)
    expect(entries).toContain("group-member-unresolved")
    expect(entries).toContain("group-member-moved")
    expect(entries).toContain("group-empty")
  })
  it("a group's lock comes from the bare word or the node, and a design block is kept", () => {
    const body = [items()[4], group("a", 20, [14], "locked"), `(group "b" (uuid "${U(21)}") (lib_id "Blocks:Power") (members "${U(14)}"))`]
    const g = imported(board({ nets, body })).project.groups!
    expect(g).toHaveLength(1)
    // the second group takes the item, with its design block
    expect(g[0].lib).toBe("Blocks:Power")
    const only = imported(board({ nets, body: [items()[4], group("a", 20, [14], "locked")] })).project.groups![0]
    expect(only.locked).toBe(true)
  })
  it("read the id the way the file's format spells it: id before KiCad 8, uuid after", () => {
    const old = `(group "a" (id "${U(20)}") (members "${U(14)}"))`
    const nested = `(group "n" (id "${U(21)}") (members "${U(20)}"))`
    const g = imported(board({ version: 20221018, nets, body: [items()[4].replace('(layer "F.SilkS")', `(layer "F.SilkS") (tstamp "${U(14)}")`).replace(`(uuid "${U(14)}")`, ""), old, nested] })).project.groups!
    expect(g.map((x) => x.name)).toEqual(["a", "n"])
    expect(g[1].members).toEqual(["gp1"])
  })
  it("a member that is something the project does not hold is counted, and the group keeps the rest", () => {
    const zone = `(zone (net 0) (net_name "") (layer "F.Cu") (uuid "${U(30)}") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 5 0) (xy 5 5) (xy 0 5))))`
    const text = board({ nets, body: [zone, items()[4], group("a", 20, [14, 30])] })
    const read = readKicadBoard(text)
    const report: ImportReport = { entries: [], account: null }
    const built = buildKicadProject(read.board, outlineOf(read.board), report, { allowLossy: true })
    expect(built.project.groups![0].members).toHaveLength(1)
    expect(report.entries.find((e) => e.code === "group-member-not-brought")?.count).toBe(1)
  })
  it("a group inside a part holds its pads, drawings and texts by place, and nests", () => {
    const fp = footprint({
      ref: "U1",
      at: "8 5",
      pads: [pad({ number: "1", at: "-1 0", extra: `(uuid "${U(41)}")` }), pad({ number: "2", at: "1 0", extra: `(uuid "${U(42)}")` })],
      extra: `(fp_line (start -2 -1) (end 2 -1) (stroke (width 0.12) (type default)) (layer "F.SilkS") (uuid "${U(43)}")) (fp_text user "note" (at 0 3) (layer "F.Fab") (uuid "${U(44)}") (effects (font (size 1 1) (thickness 0.15)))) (group "pads" (id "${U(50)}") (members "${U(41)}" "${U(42)}")) (group "all" (id "${U(51)}") (members "${U(50)}" "${U(43)}" "${U(44)}"))`,
    }).replace('(layer "F.Cu")', `(layer "F.Cu") (uuid "${U(40)}")`)
    const { project } = imported(board({ body: [fp] }))
    const c = project.components[0]
    expect(c.groups).toEqual([
      { id: "g0", name: "pads", members: ["p0", "p1"] },
      { id: "g1", name: "all", members: ["g0", "s0", "t2"] },
    ])
    // stored as the groups they are (the compact `gr` of before is still read), and exact
    const stored = JSON.parse(serializeProject(project)).project
    expect(stored.components[0].groups).toEqual(c.groups)
    expect(stored.components[0].gr).toBeUndefined()
    expect(parseProjectFile(serializeProject(project), { id: "x" }).components[0].groups).toEqual(c.groups)
  })
})

// ---------- images ----------

describe("reference images", () => {
  it("come in with their place, layer, scale and lock, their size and resolution from the picture, and the bytes kept by their SHA-256 outside the project", () => {
    const bytes = png(192, 96, 3780)
    const text = board({ version: 20260901, body: [image(bytes, '(at 10 5) (layer "User.1") (scale 0.5) (locked yes)')] })
    const r = imported(text)
    const m = r.project.images![0]
    expect(m).toMatchObject({ id: "im1", x: 10, y: -5, layer: "User.1", scale: 0.5, format: "png", px: 192, py: 96, ppi: 96, locked: true })
    expect(m.file).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(r.files).toHaveLength(1)
    expect(r.files[0].id).toBe(m.file)
    expect([...r.files[0].bytes]).toEqual([...bytes])
    // the project holds the file's id, not its bytes
    expect(serializeProject(r.project).length).toBeLessThan(2500)
    expect(serializeProject(r.project)).not.toContain(b64(bytes).slice(0, 30))
  })
  it("take the resolution of the KiCad that wrote the file: before stamp 20260623 pixels per centimetre are cut to a whole number first", () => {
    const bytes = png(10, 10, 3780)
    expect(imported(board({ version: 20240108, body: [image(bytes)] })).project.images![0].ppi).toBe(94)
    expect(imported(board({ version: 20260616, body: [image(bytes)] })).project.images![0].ppi).toBe(94)
    expect(imported(board({ version: 20260623, body: [image(bytes)] })).project.images![0].ppi).toBe(96)
    expect(imported(board({ version: 20240108, body: [image(png(10, 10))] })).project.images![0].ppi).toBe(300)
  })
  it("a scale that is zero or not a number is 1, as KiCad takes it", () => {
    expect(imported(board({ body: [image(png(4, 4), '(at 0 0) (layer "F.Cu") (scale 0)')] })).project.images![0].scale).toBe(1)
  })
  it("a picture that is neither a PNG nor a JPEG is refused by name (X28), and bytes that do not decode are an unreadable board", () => {
    const bmp = Uint8Array.from([0x42, 0x4d, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
    const r = importKicadBoard(board({ body: [image(bmp)] }))
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toEqual(["X28"])
    expect(r.status === "refused" && r.message).toMatch(/PNG or JPEG/)
    const bad = importKicadBoard(board({ body: ['(image (at 0 0) (layer "F.Cu") (data "***"))'] }))
    expect(bad.status).toBe("refused")
  })
  it("a footprint's picture (KiCad 8 and later) is kept on the board where KiCad draws it, its place written in the board's frame, and the report says so", () => {
    const bytes = png(4, 4, 3780)
    const fp = footprint({ ref: "SW2", at: "141 124 -90", pads: [pad({ at: "0 0" })], extra: image(bytes, '(at 143.57 124.17) (layer "F.SilkS")') })
    const r = imported(board({ version: 20241229, body: [fp] }))
    expect(r.project.images).toHaveLength(1)
    expect(r.project.images![0]).toMatchObject({ x: 143.57, y: -124.17, layer: "F.SilkS" })
    expect(r.report.entries.find((e) => e.code === "footprint-image-on-board")?.object).toBe("1 reference image inside footprints (SW2)")
  })
  it("two boards with the same picture keep one file, and a project saved and loaded is the same", () => {
    const bytes = png(8, 8, 3780)
    const r = imported(board({ body: [image(bytes), image(bytes, '(at 12 5) (layer "User.2")')] }))
    expect(r.project.images).toHaveLength(2)
    expect(r.files.map((f) => f.id)).toEqual([sha256Hex(bytes)])
    const back = parseProjectFile(serializeProject(r.project), { id: "x" })
    expect(back.images).toEqual(r.project.images)
  })
})

describe("what the gate lets in and what the project holds", () => {
  it("X11, X12, X14 and X27 are built, X28 is not", () => {
    for (const x of ["X11", "X12", "X14", "X27"]) expect(BUILT_EXTENSIONS.has(x)).toBe(true)
    expect(BUILT_EXTENSIONS.has("X28")).toBe(false)
  })
  it("a board with a dimension, a group and a picture needs nothing that is not built, and every node of it is accounted for", () => {
    const text = board({ nets, body: [seg(2, 8, 4, 8, 11, "(net 1)"), aligned("", 17), group("g", 20, [11, 17]), image(png(4, 4))] })
    const r = readKicadBoard(text)
    const needs = needsOf(r.board, { paths: countPaths(r.board.tree) }, outlineOf(r.board)).map((n) => n.ext)
    expect(needs).toEqual(expect.arrayContaining(["X11", "X12", "X14"]))
    const done = importKicadBoard(text)
    expect(done.status).toBe("imported")
    if (done.status === "imported") {
      expect(done.report.account!.unknownPaths.size).toBe(0)
      expect(done.report.account!.unknownAtoms.size).toBe(0)
      expect(done.report.account!.pending.size).toBe(0)
    }
  })
  it("a board without these is built exactly as before: no new field in the project", () => {
    const { project } = imported(board({ nets, body: [seg(2, 8, 4, 8, 11, "(net 1)")] }))
    for (const k of ["dimensions", "groups", "images"] as const) expect(project[k]).toBeUndefined()
    const p: Project = project
    expect(JSON.parse(serializeProject(p)).project).not.toHaveProperty("dm")
  })
})

// X27: a dimension drawn inside a footprint. KiCad keeps its points as the board's in every file, whichever way the part sits and whatever the stamp (`PCB_DIMENSION_BASE::GetStart` and `SetStart` apply the
// footprint's transform, and the writer writes the result), so it is the board's dimension of those points; the part's own pose is not applied to it, and it no longer moves with the part (the report says so).

const dim = (id: string, extra = "") =>
  `(dimension (type orthogonal) (layer "Dwgs.User") (uuid "${id}") (pts (xy 3 4) (xy 13 9)) (height 6) (orientation 1) (format (prefix "") (suffix "") (units 3) (units_format 0) (precision 4) (suppress_zeroes yes)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (arrow_direction outward) (extension_height 0.58642) (extension_offset 0.5) (keep_text_aligned yes)) (gr_text "10" (at 16 6.5 90) (layer "Dwgs.User") (uuid "${id}") (effects (font (size 1 1) (thickness 0.15)))) ${extra})`
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const part = (at: string, layer: string, inner: string) => footprint({ ref: "U1", at, layer, pads: [pad({ at: "0 0", layers: layer === "B.Cu" ? '"B.Cu" "B.Paste" "B.Mask"' : undefined })], extra: inner })
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

describe("a dimension inside a footprint", () => {
  const alone = imp([footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })] }), dim(ID(1))]).project.dimensions!

  it("is the board's dimension of the same points, whatever the part's place, turn and side", () => {
    for (const [at, layer] of [["10 5", "F.Cu"], ["10 5 90", "F.Cu"], ["30 40 33", "F.Cu"], ["10 5", "B.Cu"], ["10 5 180", "B.Cu"]] as const) {
      const r = imp([part(at, layer, dim(ID(1)))])
      expect(r.project.dimensions, `${at} ${layer}`).toEqual(alone)
    }
  })

  it("comes after the board's own, with ids in order, and the report counts the ones that left their part", () => {
    const r = imp([dim(ID(1)), part("10 5", "F.Cu", `${dim(ID(2))} ${dim(ID(3)).replace("orthogonal", "aligned")}`)])
    expect(r.project.dimensions!.map((d) => [d.id, d.kind])).toEqual([["dm1", "orthogonal"], ["dm2", "orthogonal"], ["dm3", "aligned"]])
    const e = r.report.entries.find((x) => x.code === "dimensions-flattened")!
    expect(e).toMatchObject({ severity: "changed", count: 2 })
    expect(e.items).toEqual(["U1: orthogonal", "U1: aligned"])
    // the part moves and its dimension stays where it was drawn
    expect(r.project.dimensions![1]).toMatchObject({ a: { x: 3, y: -4 }, b: { x: 13, y: -9 } })
  })

  it("is the same dimension in a file of stamp 20260616, whose part is placed by a transform with a scale: KiCad writes the board's points all the same", () => {
    for (const [transform, layer] of [["(translate 10 5) (rotate 0) (scale 1)", "F.Cu"], ["(translate 30 40) (rotate 33) (scale 1)", "F.Cu"], ["(translate 10 5) (rotate 90) (scale 1)", "B.Cu"]] as const) {
      const text = part("10 5", layer, dim(ID(1))).replace("(at 10 5)", `(transform ${transform})`)
      expect(text).toContain("(transform")
      const r = importKicadBoard(board({ version: 20260616, body: [text] }))
      expect(r.status, transform).toBe("imported")
      expect(r.status === "imported" && r.project.dimensions, transform).toEqual(alone)
    }
  })

  it("a part on the bottom, flipped, has its dimension on a back layer with its text mirrored, as the file says, and it is the board's the same", () => {
    const back = dim(ID(1)).replaceAll("Dwgs.User", "B.SilkS").replace("(thickness 0.15))", "(thickness 0.15)) (justify mirror)")
    const onBoard = imp([footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })] }), back]).project.dimensions!
    expect(onBoard[0]).toMatchObject({ layer: "B.SilkS", mirror: true })
    for (const at of ["10 5 180", "10 5", "30 40 33"]) expect(imp([part(at, "B.Cu", back)]).project.dimensions, at).toEqual(onBoard)
  })

  it("a radial, a leader and a center dimension inside a part are the board's the same way, the leader as a corpus board (RoyalBlue54L-NFC-Antenna) draws it", () => {
    const leader = `(dimension (type leader) (layer "Cmts.User") (uuid "${ID(4)}") (pts (xy 152.94971 67.310695) (xy 156.29971 63.960695)) (format (prefix "") (suffix "") (units 0) (units_format 0) (precision 4) (override_value "0.3mm Thickness")) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (text_frame 0) (extension_offset 0.5)) (gr_text "0.3mm Thickness" (at 168.99971 63.960695 0) (layer "Cmts.User") (uuid "${ID(4)}") (effects (font (size 1 1) (thickness 0.15)))))`
    const radial = `(dimension (type radial) (layer "Dwgs.User") (uuid "${ID(5)}") (pts (xy 5 5) (xy 8 5)) (gr_text "R 3" (at 10 5 0) (layer "Dwgs.User") (uuid "${ID(5)}") (effects (font (size 1 1) (thickness 0.15)))))`
    const center = `(dimension (type center) (layer "Dwgs.User") (uuid "${ID(6)}") (pts (xy 5 5) (xy 7 5)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_offset 0)))`
    for (const [kind, text] of [["leader", leader], ["radial", radial], ["center", center]] as const) {
      const onBoard = imp([footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })] }), text]).project.dimensions!
      expect(onBoard.map((d) => d.kind)).toEqual([kind])
      for (const [at, layer] of [["10 5", "F.Cu"], ["10 5 90", "F.Cu"], ["10 5 180", "B.Cu"]] as const) expect(imp([part(at, layer, text)]).project.dimensions, `${kind} ${at} ${layer}`).toEqual(onBoard)
    }
  })

  it("names its part by the project's reference, and fills the part's reference, value and fields into its text", () => {
    const text = dim(ID(1)).replace('(prefix "")', '(prefix "${REFERENCE} ")').replace('(suffix "")', '(suffix " ${VALUE} ${Datasheet} ${Colour}")')
    const field = `(property "Datasheet" "ds.pdf" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1) (thickness 0.15))))`
    const r = imp([footprint({ ref: "REF**", value: "47k", at: "10 5", pads: [pad({ at: "0 0" })], extra: `${field} ${text}` })])
    const ref = r.project.components[0].ref
    expect(ref).not.toBe("REF**")
    expect(r.project.dimensions![0]).toMatchObject({ prefix: `${ref} `, suffix: " 47k ds.pdf ${Colour}" })
    const e = r.report.entries.find((x) => x.code === "dimensions-flattened")!
    expect(e.items).toEqual([`${ref}: orthogonal`])
    // what it could not fill in stays as typed, and the report says so
    expect(e.why).toMatch(/uses \$\{Colour\}, which the editor cannot fill in/)
  })

  it("a dimension on one of the part's private layers is not brought in, like any drawing on one", () => {
    const r = imp([part("10 5", "F.Cu", `(private_layers "Dwgs.User") ${dim(ID(1))}`)])
    expect(r.project.dimensions ?? []).toHaveLength(0)
    expect(r.report.entries.find((x) => x.code === "private-layer-drawings")).toMatchObject({ severity: "not-brought", count: 1 })
    expect(r.report.entries.some((x) => x.code === "dimensions-flattened")).toBe(false)
  })

  it("a dimension inside a part that a group of the part names is one the group cannot hold: it is the board's now", () => {
    const g = `(group "" (uuid "${ID(9)}") (members "${ID(1)}"))`
    const r = imp([part("10 5", "F.Cu", `${dim(ID(1))} ${g}`)])
    expect(r.project.dimensions).toHaveLength(1)
    expect(r.project.components[0].groups ?? []).toHaveLength(0)
    expect(r.report.entries.find((e) => e.code === "group-member-not-brought")?.why).toMatch(/dimensions of a part \(the board's now/)
  })

  it("is written as KiCad 9 writes a dimension, and read back as the same project", async () => {
    const a = imp([part("10 5", "F.Cu", dim(ID(1)))])
    const text = await pcbOf(a.project)
    expect(unknownNodes(text)).toEqual([])
    const b = importKicadBoard(text)
    expect(b.status).toBe("imported")
    if (b.status === "imported") expect(diffProjects(a.project, b.project)).toEqual([])
  })

  it("is kept by a save and a load", () => {
    const a = imp([part("10 5", "F.Cu", dim(ID(1)))])
    expect(parseProjectFile(serializeProject(a.project), { id: "x" }).dimensions).toEqual(a.project.dimensions)
  })
})
