import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { fabricationNotes } from "../src/export/notes"
import { computeConnectivity } from "../src/model/connectivity"
import { ungroup } from "../src/model/boardObjects"
import { moveObjects, rotateObjects } from "../src/model/groupMoves"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { lengthFindings, netLengths, padDieTimes, tuningPatterns } from "../src/model/netLengths"
import { pruneNetChains, renameChainNets } from "../src/model/netChains"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { packGroups, sharedGeneratorProps, unpackGroups } from "../src/model/dimCodec"
import { readGenerator } from "../src/model/generatorCodec"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"
import { importedBoard as imported } from "./kicad-test-helpers"

// X21: tuning patterns (and the other generated items) as groups that remember what made them, the length inside a package, net chains, and what each does to a net's length.

const NETS = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
const seg = (a: string, b: string, id: string, net = "(net 1)") => `(segment (start ${a}) (end ${b}) (width 0.2) (layer "F.Cu") ${net} (uuid "${id}"))`
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

const tuning = (members: string[], extra = "") => `(generated (uuid "${ID(900)}") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu") ${extra}
  (base_line (pts (xy 10 5) (xy 14 5)))
  (corner_radius_percent 100)
  (end (xy 14 5))
  (initial_side "left")
  (is_time_domain no)
  (last_tuning "75.9800 mm (too short)")
  (max_amplitude 2)
  (min_spacing 0.6)
  (origin (xy 10 5))
  (rounded yes)
  (target_length 100)
  (target_length_max 100.1)
  (target_length_min 99.9)
  (tuning_mode "single")
  (members ${members.map((m) => `"${m}"`).join(" ")}))`
const withPattern = (extra = "") => board({ version: 20260206, nets: NETS, body: [seg("10 5", "11 5", ID(1)), seg("11 5", "11 6", ID(2)), seg("11 6", "14 6", ID(3)), tuning([ID(1), ID(2), ID(3)], extra)] })

describe("X21 reader", () => {
  it("is built", () => {
    expect(BUILT_EXTENSIONS.has("X21")).toBe(true)
  })

  it("a tuning pattern is a group of its tracks with its parameters, points in the board's frame", () => {
    const p = imported(withPattern())
    expect(p.groups).toHaveLength(1)
    const g = p.groups![0]
    expect(g.name).toBe("Tuning Pattern")
    expect(g.members).toHaveLength(1)
    expect(p.traces).toHaveLength(1)
    expect(g.members[0]).toBe(p.traces[0].id)
    expect(g.gen).toMatchObject({ kind: "tuning_pattern", layer: "top" })
    expect(g.gen!.props.target_length).toBe(100)
    expect(g.gen!.props.origin).toEqual({ xy: [10, -5] })
    expect(g.gen!.props.base_line).toEqual({ pts: [[10, -5], [14, -5]] })
    expect(g.gen!.props.rounded).toBe(true)
    expect(g.gen!.props.is_time_domain).toBe(false)
    expect(g.gen!.props.last_tuning).toBe("75.9800 mm (too short)")
    expect(g.gen!.props.tuning_mode).toBe("single")
  })

  it("a locked generator is a locked group", () => {
    const p = imported(withPattern("(locked yes)"))
    expect(p.groups![0].locked).toBe(true)
  })

  it("a tuning pattern with no members is not kept, as KiCad drops it", () => {
    const p = imported(board({ version: 20260206, nets: NETS, body: [seg("10 5", "11 5", ID(1)), tuning([])] }))
    expect(p.groups).toBeUndefined()
  })

  it("a via stack and via stitching are groups of vias with their properties, templates and cells", () => {
    const v = (id: string, at: string) => `(via (at ${at}) (size 0.3) (drill 0.15) (layers "F.Cu" "B.Cu") (net 1) (uuid "${id}"))`
    const text = board({
      version: 20260831,
      nets: NETS,
      body: [
        v(ID(10), "5 5"),
        v(ID(11), "6 5"),
        `(generated (uuid "${ID(901)}") (type via_stitch) (name "Via Stitching") (layer "F.Cu") (layout 0) (net_name "A") (origin (xy 1 2)) (outline (pts (xy 0 0) (xy 10 0) (xy 10 4))) (pitch 1)
          (templates (template (name "via") (via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (free yes) (net "") (uuid "${ID(902)}")))) (members "${ID(10)}" "${ID(11)}"))`,
      ],
    })
    const p = imported(text)
    const g = p.groups![0]
    expect(g.gen!.kind).toBe("via_stitch")
    expect(g.members).toEqual([p.vias[0].id, p.vias[1].id])
    expect(g.gen!.props.outline).toEqual({ pts: [[0, 0], [10, 0], [10, -4]] })
    expect(g.gen!.props.net_name).toBe("A")
    expect(g.gen!.templates![0]).toMatchObject({ name: "via", via: { diameter: 0.6, drill: 0.3, free: true } })
  })

  it("keeps a generated item whose layer the board lacks out, as a plain track, with a report entry", () => {
    const r = importKicadBoard(board({ version: 20260206, nets: NETS, body: [seg("10 5", "11 5", ID(1)), tuning([ID(1)]).replace('(layer "F.Cu")', '(layer "In3.Cu")')] }))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.groups).toBeUndefined()
    expect(r.report.entries.some((e) => e.code === "generator-not-brought")).toBe(true)
  })

  it("the pad's length inside its package is read, a zero is none", () => {
    const p = imported(board({ version: 20241229, nets: NETS, body: [footprint({ pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")', extra: "(die_length 2.5)" }), pad({ number: "2", at: "2 0", net: '(net 2 "B")', extra: "(die_length 0)" })] })] }))
    expect(p.footprints![0].pads[0].dieLength).toBe(2.5)
    expect(p.footprints![0].pads[1].dieLength).toBeUndefined()
  })

  it("net chains are read by name, with their terminal pads, and a net the board lacks is left out", () => {
    const text = board({
      version: 20260831,
      nets: NETS,
      body: [footprint({ pads: [pad({ number: "1", at: "0 0", net: '(net "A")', extra: `(uuid "${ID(20)}")` })] }), `(net_chains (net_chain (name "CH") (members (net "A") (net "B") (net "NOPE")) (terminal_pad "${ID(20)}")))`],
    })
    const p = imported(text)
    expect(p.netChains).toEqual([{ name: "CH", nets: ["A", "B"], terminals: [{ component: p.components[0].id, pad: 0 }] }])
  })
})

describe("X21 reader: values and chains", () => {
  it("a property KiCad holds as text stays text when it looks like a number", () => {
    const p = imported(withPattern('(last_netname "5")').replace('"single"', '"10"').replace('"75.9800 mm (too short)"', '"7"').replace('"left"', '"1"'))
    const props = p.groups![0].gen!.props
    expect(props.last_netname).toBe("5")
    expect(props.tuning_mode).toBe("10")
    expect(props.last_tuning).toBe("7")
    expect(props.initial_side).toBe("1")
    // and a number is still a number
    expect(props.target_length).toBe(100)
  })

  it("the net class a chain names is reported as not brought in, and a word the chain never has is refused", () => {
    const chain = (inner: string) => board({ version: 20260831, nets: NETS, body: [`(net_chains (net_chain (name "CH") (members (net "A")) ${inner}))`] })
    const r = importKicadBoard(chain('(net_class "Fast")'))
    expect(r.status).toBe("imported")
    if (r.status === "imported") expect(r.report.entries.some((e) => e.severity === "not-brought" && /net_chains>net_chain>net_class/.test(e.object))).toBe(true)
    expect(importKicadBoard(chain("(mystery 1)")).status).toBe("refused")
  })
})

describe("X21 stored form", () => {
  it("the vias a stored generator lays out read as a board's vias do: a field that does not read is dropped", () => {
    const g = readGenerator({ kind: "via_stitch", layer: "top", props: {}, templates: [{ name: "v", via: { x: 0, y: 0, diameter: 0.8, drill: 0.4, kind: "blind", tent: { front: "yes", back: true } } }] })!
    const via = g.templates![0].via
    expect(via.kind).toBeUndefined()
    expect(via.tent).toEqual({ back: true })
  })

  it("members are stored by place and the shared properties once, and both the old and the new form read", () => {
    const traces = [{ id: "t-a" }, { id: "t-b" }, { id: "t-c" }]
    const vias = [{ id: "v-a" }]
    const ids = [...traces, ...vias].map((t) => t.id)
    const gen = (n: number) => ({ kind: "tuning_pattern", layer: "top" as const, props: { rounded: true, target_length: n, last_netname: "5" } })
    const groups = [
      { id: "g1", name: "P1", members: ["t-a", "v-a"], gen: gen(10) },
      { id: "g2", name: "P2", members: ["t-b", "t-c", "elsewhere"], gen: gen(20) },
      { id: "g3", name: "Plain", members: ["t-a"] },
    ]
    const shared = sharedGeneratorProps(groups)
    expect(shared).toEqual({ tuning_pattern: { rounded: true, last_netname: "5" } })
    const packed = packGroups(groups, undefined, { ids, shared })
    expect(packed[0].slice(4)).toEqual([0, 3])
    expect(packed[1].slice(4)).toEqual([1, 2, "elsewhere"])
    expect(packed[2].slice(3)).toEqual(["t-a"])
    expect(JSON.stringify(packed)).not.toContain("last_netname")
    expect(unpackGroups(JSON.parse(JSON.stringify(packed)), undefined, { ids, shared })).toEqual(groups)
    // the form before: names for members, every property written out
    expect(unpackGroups(JSON.parse(JSON.stringify(packGroups(groups))))).toEqual(groups)
    // a place that is not there takes the group with it
    expect(unpackGroups([[0, "P", 4, { kind: "tuning_pattern", layer: "top", props: {} }, 9]], undefined, { ids })).toEqual([])
  })

  it("sixty tuning patterns are written as the groups they are, about a kilobyte each, and read back the same", () => {
    const p = imported(withPattern())
    const gens = Array.from({ length: 60 }, (_, i) => ({ id: `gp${i + 1}`, name: "Tuning Pattern", members: [p.traces[0].id], gen: { ...p.groups![0].gen!, props: { ...p.groups![0].gen!.props, target_length: 10 + i } } }))
    const big = { ...p, groups: gens }
    const text = serializeProject(big)
    expect((text.length - serializeProject({ ...p, groups: [] }).length) / 60).toBeLessThan(1500)
    expect(parseProjectFile(text, { id: "x", createdAt: 0, updatedAt: 0 }).groups).toEqual(gens)
  })

  it("a generated item and the chains survive a save and load exactly", () => {
    const p = imported(withPattern())
    const back = parseProjectFile(serializeProject(p), { id: "x", createdAt: 0, updatedAt: 0 })
    expect(back.groups).toEqual(p.groups)
    const chained = { ...p, netChains: [{ name: "CH", nets: ["A"] }] }
    expect(parseProjectFile(serializeProject(chained), { id: "x", createdAt: 0, updatedAt: 0 }).netChains).toEqual(chained.netChains)
  })

  it("a generator that does not read takes its group with it, and the tracks stay", () => {
    const doc = JSON.parse(serializeProject(imported(withPattern())))
    doc.project.groups[0].gen = { kind: "tuning_pattern", layer: "top", props: { origin: { xy: ["x", 1] } } }
    const back = parseProjectFile(doc, { id: "x", createdAt: 0, updatedAt: 0 })
    expect(back.groups).toBeUndefined()
    expect(back.traces).toHaveLength(1)
  })
})

describe("X21 edits", () => {
  it("moving the group moves its pattern's points with it, turning turns them, and a member moved alone leaves them", () => {
    const p = imported(withPattern())
    const g = p.groups![0]
    const t = p.traces[0].id
    const moved = moveObjects(p, [`t:${t}`], 2, 3)
    expect(moved.groups![0].gen!.props.origin).toEqual({ xy: [12, -2] })
    expect(moved.groups![0].gen!.props.base_line).toEqual({ pts: [[12, -2], [16, -2]] })
    expect(moved.groups![0].gen!.props.target_length).toBe(100)
    // the same project when nothing moves
    expect(moveObjects(p, [`t:${t}`], 0, 0)).toBe(p)
    const turned = rotateObjects(p, [`t:${t}`])!.project
    const o = turned.groups![0].gen!.props.origin as { xy: [number, number] }
    // a quarter turn about the middle of the pattern's tracks: the point goes where the track's own corner went
    const corner = turned.traces[0].points.find((q) => Math.abs(q.x - o.xy[0]) < 1e-6 && Math.abs(q.y - o.xy[1]) < 1e-6)
    expect(corner).toBeDefined()
    expect(g.gen).toBeDefined()
  })

  it("a locked pattern does not move, and neither does its layout", () => {
    const p = imported(withPattern("(locked yes)"))
    const t = p.traces[0].id
    expect(moveObjects(p, [`t:${t}`], 2, 3)).toBe(p)
  })

  it("taking the group apart leaves plain tracks", () => {
    const p = imported(withPattern())
    const apart = ungroup(p, p.groups![0].id)
    expect(apart.groups).toBeUndefined()
    expect(apart.traces).toHaveLength(1)
  })

  it("net chains follow a net that is renamed and drop a terminal whose part is gone", () => {
    const p: Project = { ...imported(withPattern()), netChains: [{ name: "CH", nets: ["A", "B"], terminals: [{ component: "gone", pad: 0 }] }] }
    expect(renameChainNets(p, { A: "C" }).netChains![0].nets).toEqual(["C", "B"])
    expect(renameChainNets(p, { Z: "Y" })).toBe(p)
    expect(pruneNetChains(p).netChains).toEqual([{ name: "CH", nets: ["A", "B"] }])
    expect(pruneNetChains(pruneNetChains(p))).toEqual(pruneNetChains(p))
  })
})

describe("X21 and the KiCad writer", () => {
  it("a tuning pattern is written as KiCad 9 has it and reads back as the same project", async () => {
    const p = imported(withPattern())
    const text = await pcbOf(p)
    expect(unknownNodes(text)).toEqual([])
    expect(text).toContain("(type tuning_pattern)")
    expect(text).toMatch(/\(target_length 100\)/)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project).filter((d) => /groups|traces/.test(d.kind))).toEqual([])
    expect(again.project.groups![0].gen).toEqual(p.groups![0].gen)
  })

  it("the length inside a package is written (die_length), and KiCad 10's delay is kept in the project only", async () => {
    const p = imported(board({ version: 20260206, nets: NETS, body: [footprint({ pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")', extra: "(die_length 2.5) (die_delay 17)" })] })] }))
    const text = await pcbOf(p)
    expect(text).toContain("(die_length 2.5)")
    expect(text).not.toContain("die_delay")
    expect(unknownNodes(text)).toEqual([])
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(again.project.footprints![0].pads[0].dieLength).toBe(2.5)
  })

  it("a via stack is written as a plain group of its vias, with a note", async () => {
    const v = (id: string, at: string) => `(via (at ${at}) (size 0.3) (drill 0.15) (layers "F.Cu" "B.Cu") (net 1) (uuid "${id}"))`
    const p = imported(board({ version: 20260831, nets: NETS, body: [v(ID(10), "5 5"), `(generated (uuid "${ID(901)}") (type via_stack) (name "Stack") (layer "F.Cu") (pitch 0) (members "${ID(10)}"))`] }))
    const written = await kicadFiles(p)
    const text = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(text).not.toContain("generated")
    expect(text).toContain('(group "Stack"')
    expect(written.notes.join(" ")).toMatch(/via stack or via stitching/)
  })
})

describe("X21 lengths", () => {
  // two pads 20 mm apart on net A joined by a 20 mm track; each pad has 1.5 mm of wire in its package
  const text = (pattern: string) =>
    board({
      version: 20260206,
      nets: NETS,
      body: [
        footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")', extra: "(die_length 1.5)" })], at: "5 5" }),
        footprint({ ref: "U2", name: "Other:Pin", pads: [pad({ number: "1", at: "0 0", net: '(net 1 "A")', extra: "(die_length 1.5) (die_delay 10)" })], at: "25 5" }),
        seg("5 5", "25 5", ID(1)),
        pattern,
      ],
    })

  it("lists the pads that have a length in their package", () => {
    const p = imported(text(""))
    expect(padDieTimes(p).map((d) => [d.ref, d.length, d.delay])).toEqual([["U1", 1.5, undefined], ["U2", 1.5, 10]])
  })

  it("a net's length is its tracks, its vias and the lengths inside its pads' packages", () => {
    const p = imported(text(""))
    const sch = computeConnectivity(p)
    const pcb = analyzePcb(p, sch)
    const [a] = netLengths(p, sch, pcb.traceNet, pcb.viaNet)
    expect(a).toMatchObject({ net: "A", tracks: 20, package: 3, packageDelay: 10, total: 23, pads: 2, simple: true })
  })

  it("finds a tuning pattern's net no longer the length it was tuned to, counting the package, which Checks keeps out of a project from KiCad", () => {
    const pattern = (min: number, max: number) => `(generated (uuid "${ID(900)}") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu") (origin (xy 5 5)) (target_length ${max}) (target_length_max ${max}) (target_length_min ${min}) (is_time_domain no) (members "${ID(1)}"))`
    // 20 mm of track and 3 mm of package is 23 mm: inside 22.9 to 23.1
    const findings = (p: Project) => {
      const sch = computeConnectivity(p)
      const pcb = analyzePcb(p, sch)
      return lengthFindings(p, sch, pcb.traceNet, pcb.viaNet)
    }
    const ok = imported(text(pattern(22.9, 23.1)))
    expect(findings(ok)).toEqual([])
    // without the package it would be 20 mm; with it the net is over a pattern tuned to 19.9 to 20.1
    const over = imported(text(pattern(19.9, 20.1)))
    const found = findings(over)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ net: "A", total: 23, min: 19.9, max: 20.1, detail: "tracks 20.000 mm, packages 3.000 mm" })
    // KiCad's DRC judges a length by a rule's `length` constraint only, never by a tuning pattern's target: Checks of a project from KiCad say nothing.
    expect(analyzePcb(over, computeConnectivity(over)).violations.filter((v) => v.kind === "tuning")).toEqual([])
    expect(tuningPatterns(over)).toHaveLength(1)
  })

  it("the fabrication notes say what was tuned and which pads add length", () => {
    const pattern = `(generated (uuid "${ID(900)}") (type tuning_pattern) (name "Clock") (layer "F.Cu") (target_length 23) (target_length_max 23.1) (target_length_min 22.9) (last_tuning "23.0 mm (tuned)") (members "${ID(1)}"))`
    const notes = fabricationNotes(imported(text(pattern)), [], [])
    expect(notes).toContain("TUNING AND LENGTHS")
    expect(notes).toMatch(/Clock\s+F\.Cu, target 23 mm \(22\.9 mm to 23\.1 mm\), last tuned: 23\.0 mm \(tuned\)/)
    expect(notes).toMatch(/2 pads have a length inside the package \(die length and delay\)/)
  })
})
