import { applyChanges } from "@cherryblossom/project-changes"
import { describe, expect, it } from "vitest"
import { packDimensions, packGroups } from "../src/model/dimCodec"
import { importKicadBoard } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { packTexts } from "../src/model/textCodec"
import type { BoardGraphic, BoardText, Project, Trace, Via } from "../src/model/types"
import { packVias } from "../src/model/viaCodec"
import { packRings } from "../src/model/zoneCodec"
import { PROJECT_SHAPE, projectChanges } from "../src/store/changes"
import { board, footprint, pad } from "./kicad-board-fixtures"

// Storage applies an edit to the stored file by the paths the live sync names (`store/changes.ts`), and the project is read from that file again. So every
// edit must land the same through the stored file as in memory. A list or a value written in another shape, or under another key, lost the edits made to
// it on the next read: a board drawing added to a board whose drawings were stored compact left only that drawing, and so on.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const NETS = ['(net 0 "")', '(net 1 "A")', '(net 2 "GND")']
const seg = (a: string, b: string, id: string) => `(segment (start ${a}) (end ${b}) (width 0.2) (layer "F.Cu") (net 1) (uuid "${id}"))`
const BOARD = board({
  version: 20260206,
  nets: NETS,
  // An outline that is not a rectangle, so the board has one (`board.outline`).
  outline: '(gr_poly (pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 2 10) (xy 0 8)) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts"))',
  body: [
    footprint({ ref: "R1", at: "3 3", pads: [pad({ number: "1", at: "-0.8 0", net: '(net 1 "A")' }), pad({ number: "2", at: "0.8 0", net: '(net 2 "GND")' })], extra: '(fp_line (start -1.5 -0.8) (end 1.5 -0.8) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))' }),
    `(zone (net 2) (net_name "GND") (layer "F.Cu") (uuid "${ID(50)}") (hatch edge 0.5) (connect_pads (clearance 0.4)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.45) (thermal_bridge_width 0.35)) (polygon (pts (xy 12 1) (xy 19 1) (xy 19 9) (xy 12 9))) (filled_polygon (layer "F.Cu") (pts (xy 12.5 1.5) (xy 18.5 1.5) (xy 18.5 8.5) (xy 12.5 8.5))))`,
    `(gr_line (start 1 8) (end 6 8) (stroke (width 0.15) (type solid)) (layer "F.SilkS") (uuid "${ID(60)}"))`,
    `(gr_text "HELLO" (at 3 9 0) (layer "F.SilkS") (uuid "${ID(61)}") (effects (font (size 1 1) (thickness 0.15))))`,
    `(dimension (type aligned) (layer "Dwgs.User") (uuid "${ID(62)}") (pts (xy 2 2) (xy 12 2)) (height 3) (gr_text "10.0000 mm" (at 7 4.15 0) (layer "Dwgs.User") (uuid "${ID(63)}") (effects (font (size 1 1) (thickness 0.15)))) (format (prefix "") (suffix "") (units 2) (units_format 1) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0) keep_text_aligned))`,
    `(group "Marks" (uuid "${ID(64)}") (members "${ID(60)}" "${ID(61)}"))`,
    `(via (at 8 5) (size 0.8) (drill 0.4) (capping yes) (filling no) (layers "F.Cu" "B.Cu") (net 1) (uuid "${ID(70)}"))`,
    `(via (at 9 5) (size 0.8) (drill 0.4) (capping yes) (filling no) (layers "F.Cu" "B.Cu") (net 1) (uuid "${ID(71)}"))`,
    seg("10 5", "11 5", ID(1)),
    seg("11 5", "11 6", ID(2)),
    seg("11 6", "14 6", ID(3)),
    `(generated (uuid "${ID(900)}") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu") (base_line (pts (xy 10 5) (xy 14 5))) (corner_radius_percent 100) (end (xy 14 5)) (initial_side "left") (is_time_domain no) (last_tuning "75.9800 mm (too short)") (max_amplitude 2) (min_spacing 0.6) (origin (xy 10 5)) (rounded yes) (target_length 100) (target_length_max 100.1) (target_length_min 99.9) (tuning_mode "single") (members "${ID(1)}" "${ID(2)}" "${ID(3)}"))`,
  ],
})

function base(): Project {
  const r = importKicadBoard(BOARD)
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  const p = r.project
  return {
    ...p,
    texts: [...p.texts, { id: "own1", text: "REV A", x: 2, y: -2, rot: 0 } as BoardText],
    images: [{ id: "im1", x: 1, y: 1, layer: "F.SilkS", scale: 1, file: "ab".repeat(32), format: "png", px: 10, py: 10, ppi: 300 }],
  }
}

const META = { id: "p", createdAt: 0, updatedAt: 0 }
const read = (text: string) => parseProjectFile(text, META)
/** The project as storage leaves it: `before` stored whole, the changes to `after` applied to the stored file, and the file read again. */
function throughStore(before: Project, after: Project): Project {
  const file = JSON.parse(serializeProject(before))
  file.project = applyChanges(file.project, projectChanges(before, after))
  return read(JSON.stringify(file))
}
/** The project as a whole write of it reads back. */
const rewritten = (p: Project) => read(serializeProject(p))
/** A project's stored document, with every object's keys in order. */
function canonical(p: Project): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v)
  return JSON.stringify(sort(JSON.parse(serializeProject(p)).project))
}

const EDITS: [string, (p: Project) => Project][] = [
  ["a board drawing added", (p) => ({ ...p, graphics: [...p.graphics!, { ...p.graphics![0], id: "gnew", a: { x: 1, y: -9 }, b: { x: 4, y: -9 } } as BoardGraphic] })],
  ["a board drawing moved", (p) => ({ ...p, graphics: p.graphics!.map((g, i) => (i === 0 ? ({ ...g, a: { x: 0.5, y: (g as { a: { y: number } }).a.y } } as BoardGraphic) : g)) })],
  ["a board drawing deleted", (p) => ({ ...p, graphics: p.graphics!.slice(1) })],
  ["KiCad's board text changed, and one of the editor's added", (p) => ({ ...p, texts: [...p.texts.map((t) => (t.layer !== undefined ? { ...t, text: "WORLD", x: t.x + 1 } : t)), { id: "own2", text: "v2", x: 5, y: -5, rot: 90 } as BoardText] })],
  ["a dimension added and one changed", (p) => ({ ...p, dimensions: [...p.dimensions!.map((d) => ({ ...d, height: 5 })), { ...p.dimensions![0], id: "dnew", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } }] })],
  ["a group renamed, and a track added before the tuning pattern's", (p) => ({ ...p, traces: [{ ...p.traces[0], id: "tfirst", points: [{ x: 0, y: -1 }, { x: 2, y: -1 }] } as Trace, ...p.traces], groups: p.groups!.map((g) => (g.gen ? g : { ...g, name: "Renamed" })) })],
  ["a tuning pattern's target changed, and a new group made", (p) => ({ ...p, groups: [...p.groups!.map((g) => (g.gen ? { ...g, gen: { ...g.gen, props: { ...g.gen.props, target_length: 90 } } } : g)), { id: "gnew2", name: "New", members: [p.vias[0].id] }] })],
  ["a via's protection cleared, a via added before it, and one deleted", (p) => ({ ...p, vias: [{ ...p.vias[0], id: "vfirst", x: 7, y: -5 } as Via, ...p.vias.slice(0, 1).map(({ protect: _protect, ...v }) => v as Via)] })],
  ["a picture moved, and one added", (p) => ({ ...p, images: [...p.images!.map((m) => ({ ...m, x: 3 })), { ...p.images![0], id: "im2", y: 4 }] })],
  ["a zone's polygon changed, and its kept fill dropped (a refill)", (p) => ({ ...p, zones: p.zones.map(({ kept: _kept, ...z }) => ({ ...z, outline: z.outline!.map((r) => ({ ...r, segs: r.segs.map((s, i) => (i === 0 && s.kind === "line" ? { ...s, a: { x: s.a.x - 1, y: s.a.y } } : s)) })) })) })],
  ["the board's outline changed", (p) => ({ ...p, board: { ...p.board, width: p.board.width + 1, outline: { ...p.board.outline!, paths: p.board.outline!.paths.map((r) => ({ ...r, segs: r.segs.map((s, i) => (i === 0 && s.kind === "line" ? { ...s, b: { x: s.b.x + 1, y: s.b.y } } : s)) })) } } })],
  ["a part's text moved", (p) => ({ ...p, components: p.components.map((c) => (c.texts ? { ...c, texts: c.texts.map((t, i) => (i === 0 ? { ...t, x: t.x + 0.5 } : t)) } : c)) })],
  ["a land's drawing changed", (p) => ({ ...p, footprints: p.footprints!.map((f) => (f.shapes ? { ...f, shapes: f.shapes.map((s) => ({ ...s, width: 0.2 })) } : f)) })],
]

describe("an edit applied to the stored file", () => {
  const p = base()

  it("starts from a project that has every kind of item the edits touch", () => {
    expect(p.graphics?.length).toBeGreaterThan(0)
    expect(p.texts.some((t) => t.layer !== undefined)).toBe(true)
    expect(p.dimensions?.length).toBe(1)
    expect(p.groups?.some((g) => g.gen)).toBe(true)
    expect(p.groups?.some((g) => !g.gen)).toBe(true)
    expect(p.vias.every((v) => v.protect)).toBe(true)
    expect(p.zones[0].kept).toBeDefined()
    expect(p.board.outline).toBeDefined()
    expect(p.components.some((c) => c.texts?.length)).toBe(true)
    expect(p.footprints?.some((f) => f.shapes?.length)).toBe(true)
  })

  for (const [name, edit] of EDITS) {
    it(`lands as in memory: ${name}`, () => {
      const after = edit(p)
      expect(canonical(after), "the edit changes the project").not.toBe(canonical(p))
      expect(canonical(throughStore(p, after))).toBe(canonical(rewritten(after)))
    })
  }

  it("finds every list the live sync edits item by item written as a list of its items", () => {
    const doc = JSON.parse(serializeProject(EDITS.reduce((q, [, edit]) => edit(q), p))).project as Record<string, unknown>
    for (const [name, key] of Object.entries(PROJECT_SHAPE.collections)) {
      const value = name.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), doc)
      if (value === undefined) continue
      expect(Array.isArray(value), name).toBe(true)
      for (const item of value as Record<string, unknown>[]) expect(typeof item[key], `${name} item's ${key}`).toBe("string")
    }
  })
})

describe("a file written in the compact forms of before", () => {
  it("reads what an edit since put beside them over the stored entries of the same ids, and beside them where it is new", () => {
    const p = base()
    // The file as the writer of before wrote it: KiCad's texts, the dimensions, the groups, the vias' protection, a zone's polygon and a part's text compact.
    const file = JSON.parse(serializeProject(p))
    const doc = file.project
    const texts = packTexts(p.texts, p.components)
    doc.texts = p.texts.filter((t) => t.layer === undefined)
    doc.kt = texts.kt
    doc.textStyles = texts.textStyles
    const dims = packDimensions(p.dimensions!)
    delete doc.dimensions
    Object.assign(doc, dims)
    delete doc.groups
    doc.grp = packGroups(p.groups!.filter((g) => !g.gen))
    const vias = packVias(p.vias)
    doc.vias = vias.vias
    doc.vx = vias.vx
    const { outline: _outline, ...zone } = doc.zones[0]
    doc.zones[0] = { ...zone, ol: packRings(p.zones[0].outline!) }
    const kicadText = p.texts.find((t) => t.layer !== undefined)!
    // Then edits, by the model's paths: KiCad's text put as an object, a dimension added, a group renamed by the objects' list, a via's own field, a zone's polygon.
    doc.texts.push({ ...kicadText, text: "EDITED" })
    doc.dimensions = [{ ...p.dimensions![0], id: "dnew" }]
    doc.groups = [{ ...p.groups!.find((g) => !g.gen)!, name: "Renamed" }]
    doc.vias[0] = { ...doc.vias[0], protect: { cap: false } }
    const moved = p.zones[0].outline!.map((r) => ({ ...r, segs: r.segs.map((s, i) => (i === 0 && s.kind === "line" ? { ...s, a: { x: s.a.x - 1, y: s.a.y } } : s)) }))
    doc.zones[0] = { ...doc.zones[0], outline: moved }

    const got = read(JSON.stringify(file))
    expect(got.texts.filter((t) => t.id === kicadText.id).map((t) => t.text)).toEqual(["EDITED"])
    expect(got.dimensions!.map((d) => d.id)).toEqual([p.dimensions![0].id, "dnew"])
    expect(got.groups!.find((g) => !g.gen)!.name).toBe("Renamed")
    expect(got.vias[0].protect).toEqual({ cap: false })
    expect(got.vias[1].protect).toEqual(p.vias[1].protect)
    expect(got.zones[0].outline).toEqual(rewritten({ ...p, zones: [{ ...p.zones[0], outline: moved }] }).zones[0].outline)
  })
})
