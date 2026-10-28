import { describe, expect, it } from "vitest"
import { backdrillSets, excellonDrill } from "../src/export/excellon"
import { buildFabricationFiles } from "../src/export/bundle"
import { fabricationNotes } from "../src/export/notes"
import { viaProtectionFiles } from "../src/export/viaProtection"
import { kicadFiles } from "../src/export/kicad"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { drillDepth, holeCuts, layerDistance, padInBoardFrame, padMachining, postKnockout, protectionWords, viaProtection } from "../src/model/machining"
import { patchProtectRule, updateLandPadMachining, updateViaMachining } from "../src/model/machiningOps"
import { setCopperLayerCount } from "../src/model/layerOps"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { analyzePcb, buildCopperItems } from "../src/model/pcb"
import { computeConnectivity } from "../src/model/connectivity"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffCanonical, diffProjects, BY_DESIGN } from "./kicad-roundtrip-check"
import { fillTester } from "../src/model/pour"
import { registerProjectFootprints } from "../src/model/footprints"
import { unknownNodes } from "./kicad9-nodes"
import { importedBoard as imported } from "./kicad-test-helpers"

// X22: via protection (IPC-4761), backdrills and post-machining of vias and pads, read from a KiCad 10 board exactly, kept through a save, drawn into the drill files, the Gerber protection files and the
// fabrication notes the way KiCad's writers do, and cut out of the pour. The writer does not write them (KiCad 9's parser refuses their words), so they stay in the project.

const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
const NETS = ['(net 0 "")', '(net 1 "A")']
const V10 = 20260206
const via = (at: string, extra: string, layers = '"F.Cu" "B.Cu"', kind = "") => `(via ${kind ? `${kind} ` : ""}(at ${at}) (size 0.8) (drill 0.4) ${extra} (layers ${layers}) (net 1))`
const four = (body: string[], setup = "(setup (pad_to_mask_clearance 0))") => board({ version: V10, layers: L4, nets: NETS, setup, body })
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

describe("X22 reader", () => {
  it("is built, and a board that uses it is imported", () => {
    expect(BUILT_EXTENSIONS.has("X22")).toBe(true)
    const r = importKicadBoard(four([via("5 5", "(capping yes)")]))
    expect(r.status).toBe("imported")
  })

  it("is named when it is not built", () => {
    const r = importKicadBoard(four([via("5 5", "(capping yes)")]), { built: new Set([...BUILT_EXTENSIONS].filter((x) => x !== "X22")) })
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.message).toMatch(/via protection, backdrill or post-machining/)
  })

  it("a via's protection is a choice for each part that the file makes: yes, no, and none for no choice", () => {
    const p = imported(four([via("5 5", "(capping yes) (filling no) (covering (front yes) (back none)) (plugging (front no))"), via("6 5", "(capping none) (filling none) (covering (front none) (back none)) (plugging (front none) (back none))")]))
    expect(p.vias[0].protect).toEqual({ cap: true, fill: false, cover: { front: true }, plug: { front: false } })
    expect(p.vias[1].protect).toBeUndefined()
  })

  it("the board's own protection is what its setup switches on", () => {
    const on = imported(four([], "(setup (covering (front yes) (back no)) (plugging (front no) (back no)) (capping yes) (filling no))"))
    expect(on.rules.viaProtect).toEqual({ cap: true, cover: { front: true } })
    const off = imported(four([], "(setup (covering (front no) (back no)) (plugging (front no) (back no)) (capping no) (filling no))"))
    expect(off.rules.viaProtect).toBeUndefined()
  })

  it("a via's own parts win over the board's, and a part it does not say is the board's", () => {
    const p = imported(four([via("5 5", "(filling no) (covering (back yes))")], "(setup (capping yes) (filling yes) (covering (front yes) (back no)) (plugging (front no) (back no)))"))
    const s = viaProtection(p.rules, p.vias[0], p.board)
    expect(s).toMatchObject({ cap: true, fill: false, coverFront: true, coverBack: true, plugFront: false })
    expect(protectionWords(s)).toEqual(["capped", "covered on both sides"])
  })

  it("a blind via has no cover or plug on a side that is an inner layer", () => {
    const p = imported(four([via("5 5", "(covering (front yes) (back yes))", '"F.Cu" "In1.Cu"', "blind")]))
    const s = viaProtection(p.rules, p.vias[0], p.board)
    expect(s.coverFront).toBe(true)
    expect(s.coverBack).toBe(false)
  })

  it("reads a backdrill and a tertiary drill between the layers the file names, and drops one that drills nothing", () => {
    const p = imported(four([via("5 5", '(backdrill (size 0.33) (layers "F.Cu" "In1.Cu")) (tertiary_drill (size 0.4) (layers "B.Cu" "In2.Cu"))'), via("6 5", '(backdrill (size 0) (layers "F.Cu" "In1.Cu"))')]))
    expect(p.vias[0].backdrill).toEqual({ size: 0.33, from: "top", to: "in1" })
    expect(p.vias[0].tertiary).toEqual({ size: 0.4, from: "bottom", to: "in2" })
    expect(p.vias[1].backdrill).toBeUndefined()
  })

  it("reads post-machining with its size, depth and angle (the angle to a tenth of a degree, as KiCad keeps it)", () => {
    const p = imported(four([via("5 5", "(front_post_machining counterbore (size 1) (depth 0.5)) (back_post_machining countersink (size 0.9) (angle 90.04))")]))
    expect(p.vias[0].post).toEqual({ front: { mode: "counterbore", size: 1, depth: 0.5 }, back: { mode: "countersink", size: 0.9, angle: 90 } })
  })

  it("a pad's backdrill, post-machining and package length are kept by the part's own side: a part on the bottom has its layers and sides turned over", () => {
    const extra = '(drill 0.5) (backdrill (size 0.6) (layers "F.Cu" "In1.Cu")) (front_post_machining counterbore (size 1) (depth 0.2)) (die_length 1.25) (die_delay 8)'
    const top = imported(four([footprint({ layer: "F.Cu", pads: [pad({ at: "0 0", type: "thru_hole", shape: "circle", layers: '"*.Cu" "*.Mask"', net: '(net 1 "A")', extra })] })]))
    const def = top.footprints![0].pads[0]
    expect(def.backdrill).toEqual({ size: 0.6, from: "top", to: "in1" })
    expect(def.post).toEqual({ front: { mode: "counterbore", size: 1, depth: 0.2 } })
    expect(def.dieLength).toBe(1.25)
    expect(def.dieDelay).toBe(8)
    const bottom = imported(four([footprint({ layer: "B.Cu", pads: [pad({ at: "0 0", type: "thru_hole", shape: "circle", layers: '"*.Cu" "*.Mask"', net: '(net 1 "A")', extra })] })]))
    const b = bottom.footprints![0].pads[0]
    // in the file the front is the board's front; the part sits on the back, so its own face is the board's back
    expect(b.backdrill).toEqual({ size: 0.6, from: "bottom", to: "in2" })
    expect(b.post).toEqual({ back: { mode: "counterbore", size: 1, depth: 0.2 } })
    // and on the board it is where the file had it
    const m = padMachining(bottom)
    expect(m).toHaveLength(1)
    expect(m[0].backdrill).toEqual({ size: 0.6, from: "top", to: "in1" })
    expect(m[0].front).toEqual({ mode: "counterbore", size: 1, depth: 0.2 })
  })

  it("a backdrill between layers the board lacks does nothing in KiCad and is a note here", () => {
    const r = importKicadBoard(board({ version: V10, nets: NETS, body: [via("5 5", '(backdrill (size 0.3) (layers "F.Cu" "In3.Cu"))')] }))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.vias[0].backdrill).toBeUndefined()
    expect(r.report.entries.some((e) => e.code === "drill-ignored")).toBe(true)
  })
})

describe("X22 stored form", () => {
  it("survives a save and a load exactly, and the vias that share a setting are written once", () => {
    const vias = Array.from({ length: 40 }, (_, i) => via(`${i} 5`, "(capping no) (filling no) (covering (front no) (back no)) (plugging (front no) (back no))"))
    const p = imported(four([...vias, via("60 5", '(backdrill (size 0.33) (layers "F.Cu" "In1.Cu"))')]))
    const text = serializeProject(p)
    const back = parseProjectFile(text, { id: "x", createdAt: 0, updatedAt: 0 })
    expect(back.vias.map((v) => [v.protect, v.backdrill, v.tertiary, v.post])).toEqual(p.vias.map((v) => [v.protect, v.backdrill, v.tertiary, v.post]))
    const doc = JSON.parse(text).project
    expect(doc.vx).toHaveLength(2)
    expect(doc.vias.every((v: Record<string, unknown>) => v.protect === undefined && v.backdrill === undefined)).toBe(true)
    // forty vias with the same four-part setting cost the setting once and their places
    expect(text.length).toBeLessThan(serializeProject({ ...p, vias: p.vias.map((v) => ({ ...v, protect: { ...v.protect!, cover: { front: false, back: false } } })) }).length + 400)
  })

  it("a project with none of it has no `vx`, and a via with a malformed field loses that field and keeps the via", () => {
    const p = imported(four([via("5 5", "")]))
    expect(JSON.parse(serializeProject(p)).project.vx).toBeUndefined()
    const doc = JSON.parse(serializeProject(p))
    doc.project.vias[0].backdrill = { size: -1, from: "top", to: "in1" }
    doc.project.vias[0].protect = { cap: "yes" }
    doc.project.vias[0].post = { front: { mode: "drill" } }
    const back = parseProjectFile(doc, { id: "x", createdAt: 0, updatedAt: 0 })
    expect(back.vias).toHaveLength(1)
    expect(back.vias[0].backdrill).toBeUndefined()
    expect(back.vias[0].protect).toBeUndefined()
    expect(back.vias[0].post).toBeUndefined()
  })

  it("a pad's fields and the board's rule are stored and read back", () => {
    const p = imported(four([footprint({ pads: [pad({ at: "0 0", type: "thru_hole", shape: "circle", layers: '"*.Cu" "*.Mask"', net: '(net 1 "A")', extra: '(drill 0.5) (tertiary_drill (size 0.6) (layers "B.Cu" "In2.Cu")) (back_post_machining countersink (size 1) (angle 90)) (die_length 2)' })] })], "(setup (capping yes))"))
    const back = parseProjectFile(serializeProject(p), { id: "x", createdAt: 0, updatedAt: 0 })
    expect(back.footprints![0].pads[0]).toEqual(p.footprints![0].pads[0])
    expect(back.rules.viaProtect).toEqual({ cap: true })
  })

  it("a layer count that drops a layer drops the backdrill that ends on it", () => {
    const p = imported(four([via("5 5", '(backdrill (size 0.33) (layers "F.Cu" "In2.Cu")) (tertiary_drill (size 0.3) (layers "B.Cu" "In1.Cu"))')]))
    const { project } = setCopperLayerCount(p, 3)
    expect(project.vias[0].backdrill).toBeUndefined()
    expect(project.vias[0].tertiary).toEqual({ size: 0.3, from: "bottom", to: "in1" })
  })
})

describe("X22 edits", () => {
  it("sets and clears a via's protection part by part, a null following the board", () => {
    const p = imported(four([via("5 5", "")]))
    const a = updateViaMachining(p, [p.vias[0].id], { protect: { fill: true, coverFront: false } })
    expect(a.vias[0].protect).toEqual({ fill: true, cover: { front: false } })
    const b = updateViaMachining(a, [p.vias[0].id], { protect: { fill: null, coverFront: null } })
    expect(b.vias[0].protect).toBeUndefined()
    expect(updateViaMachining(b, [p.vias[0].id], { protect: { fill: null } })).toBe(b)
  })

  it("sets a backdrill and a post-machining, and refuses numbers that make no drill", () => {
    const p = imported(four([via("5 5", "")]))
    const a = updateViaMachining(p, [p.vias[0].id], { backdrill: { size: 0.3, from: "top", to: "in1" }, post: { front: { mode: "countersink", size: 1, angle: 90 } } })
    expect(a.vias[0].backdrill).toEqual({ size: 0.3, from: "top", to: "in1" })
    expect(a.vias[0].post?.front).toEqual({ mode: "countersink", size: 1, angle: 90 })
    expect(updateViaMachining(a, [p.vias[0].id], { backdrill: { size: Number.NaN, from: "top", to: "in1" } })).toBe(a)
    expect(updateViaMachining(a, [p.vias[0].id], { backdrill: null }).vias[0].backdrill).toBeUndefined()
  })

  it("edits the board's rule and a land's pad", () => {
    const p = imported(four([footprint({ pads: [pad({ at: "0 0", type: "thru_hole", shape: "circle", layers: '"*.Cu" "*.Mask"', net: '(net 1 "A")', extra: "(drill 0.5)" })] })]))
    const rules = patchProtectRule(p.rules, { cap: true, coverFront: true })
    expect(rules.viaProtect).toEqual({ cap: true, cover: { front: true } })
    expect(patchProtectRule(rules, { cap: false, coverFront: false }).viaProtect).toBeUndefined()
    const land = p.footprints![0].name
    const q = updateLandPadMachining(p, land, 0, { dieLength: 1.5, backdrill: { size: 0.6, from: "top", to: "in1" } })
    expect(q.footprints![0].pads[0]).toMatchObject({ dieLength: 1.5, backdrill: { size: 0.6, from: "top", to: "in1" } })
    expect(updateLandPadMachining(q, land, 0, { dieLength: null }).footprints![0].pads[0].dieLength).toBeUndefined()
  })
})

describe("X22 numbers from KiCad's own rules", () => {
  const rows = [
    { name: "F.Cu", type: "copper", thickness: 0.035 },
    { name: "dielectric 1", type: "prepreg", thickness: 0.1 },
    { name: "In1.Cu", type: "copper", thickness: 0.035 },
    { name: "dielectric 2", type: "core", thickness: 1.065 },
    { name: "In2.Cu", type: "copper", thickness: 0.035 },
    { name: "dielectric 3", type: "prepreg", thickness: 0.1 },
    { name: "B.Cu", type: "copper", thickness: 0.035 },
  ]
  const b = { stack: { copper: [{}, {}, {}, {}], rows }, thickness: 1.4 }

  it("the stub of a backdrill is the stackup from the front to the end layer and half of the next row", () => {
    // F.Cu, dielectric 1, In1.Cu in full, then half of dielectric 2 (`GetDrillDepth`)
    expect(drillDepth(b, "top", "in1")).toBeCloseTo(0.035 + 0.1 + 0.035 + 1.065 / 2, 6)
    // a drill that ends on the back layer takes every row
    expect(drillDepth(b, "top", "bottom")).toBeCloseTo(1.405, 6)
  })

  it("the distance between two layers counts half of an inner copper layer at either end", () => {
    expect(layerDistance(b, "top", "in1")).toBeCloseTo(0.035 + 0.1 + 0.035 / 2, 6)
    expect(layerDistance(b, "top", "bottom")).toBeCloseTo(1.405, 6)
    expect(layerDistance(b, "in1", "in1")).toBe(0)
  })

  it("a counterbore cuts every layer within its depth, a countersink a cone that narrows with depth", () => {
    expect(postKnockout(b, { front: { mode: "counterbore", size: 1, depth: 0.2 } }, "in1")).toBe(1)
    expect(postKnockout(b, { front: { mode: "counterbore", size: 1, depth: 0.1 } }, "in1")).toBe(0)
    // a 90 degree countersink of 1 mm: 0.1525 mm down (to In1.Cu's middle) it has narrowed by twice that
    expect(postKnockout(b, { front: { mode: "countersink", size: 1, depth: 0.5, angle: 90 } }, "top")).toBe(1)
    expect(postKnockout(b, { front: { mode: "countersink", size: 1, depth: 0.5, angle: 90 } }, "in1")).toBeCloseTo(1 - 2 * 0.1525, 3)
    expect(postKnockout(b, { back: { mode: "counterbore", size: 0.8, depth: 0.2 } }, "bottom")).toBe(0.8)
  })

  it("holeCuts lists the layers a backdrill runs through with the largest hole there", () => {
    const cuts = holeCuts(b, { drill: 0.3, backdrill: { size: 0.4, from: "top", to: "in1" } }, ["top", "in1", "in2", "bottom"])
    expect(cuts).toEqual({ top: 0.4, in1: 0.4 })
    expect(holeCuts(b, { drill: 0.3 }, ["top"])).toBeUndefined()
    const turned = padInBoardFrame({ backdrill: { size: 0.4, from: "top", to: "in1" }, post: { front: { mode: "counterbore", size: 1 } } }, true, 4)
    expect(turned.backdrill).toEqual({ size: 0.4, from: "bottom", to: "in2" })
    expect(turned.post).toEqual({ back: { mode: "counterbore", size: 1 } })
  })
})

describe("X22 outputs", () => {
  const body = [
    via("5 5", '(backdrill (size 0.33) (layers "F.Cu" "In1.Cu")) (front_post_machining counterbore (size 0.8) (depth 0.2))'),
    via("10 5", '(backdrill (size 0.33) (layers "F.Cu" "In1.Cu")) (tertiary_drill (size 0.4) (layers "B.Cu" "In2.Cu"))'),
    via("15 5", "(capping yes) (filling yes) (covering (front yes) (back no)) (plugging (front no) (back yes))"),
  ]
  const stackup = `(setup (pad_to_mask_clearance 0) (stackup (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "prepreg") (thickness 0.1) (material "FR4")) (layer "In1.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 2" (type "core") (thickness 1.065) (material "FR4")) (layer "In2.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 3" (type "prepreg") (thickness 0.1) (material "FR4")) (layer "B.Cu" (type "copper") (thickness 0.035))))`
  const p = imported(four(body, stackup))

  it("each backdrill span has two drill files as KiCad's Excellon writer makes them", () => {
    const sets = backdrillSets(p)
    expect(sets.map((s) => `${s.start}>${s.end}`)).toEqual(["top>in1", "in2>bottom"].map((x) => (x === "in2>bottom" ? "bottom>in2" : x)))
    const files = buildFabricationFiles(p)
    expect(Object.keys(files).filter((f) => f.endsWith(".drl")).sort()).toEqual(
      ["imported-kicad-board-PTH.drl", "imported-kicad-board_Backdrills_Drill_1_2.drl", "imported-kicad-board_Backdrills_Drill_4_3.drl", "imported-kicad-board-front-in1-backdrill.drl", "imported-kicad-board-in2-back-backdrill.drl"].sort(),
    )
    const first = files["imported-kicad-board_Backdrills_Drill_1_2.drl"]
    expect(first).toContain("; #@! TF.FileFunction,NonPlated,1,2,Blind")
    expect(first).toContain("; #@! TA.AperFunction,NonPlated,BackDrill")
    expect(first).toContain("T1C0.330")
    expect(first).toMatch(/; Backdrill stub 0\.703mm \(0\.0277"\), post-machining/)
    expect(first).toContain("X5.000Y")
    expect(first).not.toContain("; backdrill\n")
    const tagged = files["imported-kicad-board-front-in1-backdrill.drl"]
    expect(tagged.match(/; backdrill\n/g)).toHaveLength(2)
    expect(files["imported-kicad-board-in2-back-backdrill.drl"]).toContain("NonPlated,3,4,Blind")
  })

  it("the plated drill file says which holes are post-machined, as KiCad does", () => {
    const text = excellonDrill(p)
    expect(text).toContain("; Post-machining\n")
    expect(text).toContain("; Post-machining front counterbore dia 0.800mm depth 0.200mm\nX5.000")
  })

  it("via protection is in Gerber files named as KiCad's, with the vias that have it", () => {
    const files = viaProtectionFiles(p)
    expect(files.map((f) => f.suffix).sort()).toEqual(["-capping-front-back", "-covering-front", "-filling-front-back", "-plugging-back"])
    const filling = files.find((f) => f.suffix === "-filling-front-back")!
    expect(filling.content).toContain("%TF.FileFunction,Other,Filling*%")
    expect(filling.content).toContain("X15000000Y-5000000D03*")
    expect(files.find((f) => f.suffix === "-covering-front")!.content).toContain("Other,Covering-Front")
  })

  it("the fabrication notes list the protection, the backdrills and the post-machining", () => {
    const notes = fabricationNotes(p, [], [])
    expect(notes).toContain("VIA PROTECTION")
    expect(notes).toMatch(/1 via\s+filled, capped, covered on the front, plugged on the back/)
    expect(notes).toContain("BACKDRILL AND POST-MACHINING")
    expect(notes).toMatch(/backdrill 0\.33 mm, F\.Cu to In1\.Cu/)
    expect(notes).toMatch(/tertiary drill 0\.4 mm, B\.Cu to In2\.Cu/)
    expect(notes).toMatch(/front counterbore dia 0\.800mm depth 0\.200mm/)
  })

  it("a board with none of it has none of these files and sections", () => {
    const plain = imported(four([via("5 5", "")]))
    const files = buildFabricationFiles(plain)
    expect(Object.keys(files).some((f) => /backdrill|capping|filling|covering|plugging/i.test(f))).toBe(false)
    expect(files["imported-kicad-board-fabrication.txt"]).not.toMatch(/VIA PROTECTION|BACKDRILL|TUNING/)
  })
})

describe("X22 and the KiCad writer", () => {
  it("writes no KiCad 10 word, so the file is one KiCad 9 reads, and the project keeps what it could not write", async () => {
    const p = imported(four([via("5 5", '(capping yes) (backdrill (size 0.33) (layers "F.Cu" "In1.Cu")) (front_post_machining counterbore (size 0.8) (depth 0.2))')], "(setup (filling yes))"))
    const text = await pcbOf(p)
    expect(unknownNodes(text)).toEqual([])
    expect(text).not.toMatch(/capping|backdrill|post_machining|tertiary_drill|\(filling|\(covering|\(plugging/)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    const kinds = new Set(diffProjects(p, again.project).map((d) => d.kind))
    expect([...kinds].every((k) => /^project\.vias\[\]\.(protect|backdrill|post)/.test(k) || /^project\.rules/.test(k))).toBe(true)
    expect((await kicadFiles(p)).notes.join(" ")).toBeDefined()
  })
})

describe("X22 in the pour", () => {
  it("copper of a via is cut where a backdrill runs through it: the item says so, on the layers it drills", () => {
    const p = imported(four([via("5 5", '(backdrill (size 0.5) (layers "F.Cu" "In1.Cu"))')]))
    const items = buildCopperItems(p, computeConnectivity(p))
    const v = items.find((i) => i.kind === "via")!
    expect(v.kind === "via" && v.cut).toEqual({ top: 0.5, in1: 0.5 })
  })
})

describe("X22 in the pour: a real fill", () => {
  // A 20 by 10 board of four layers, a pour on In1 and In2 on net A, a wall of net B at x = 14 that cuts the board in two, copper of net A on both sides: a plain via on the left, a backdrilled
  // via on the right, and a through pad on the left that is backdrilled from the top to In1. In1 is cut at both; In2 is not.
  const wall = (layer: string) => `(segment (start 14 0) (end 14 10) (width 0.2) (layer "${layer}") (net 2))`
  const zone = `(zone (net 1) (net_name "A") (layers "In1.Cu" "In2.Cu") (uuid "00000000-0000-4000-8000-000000000001") (hatch edge 0.5) (connect_pads yes (clearance 0.2)) (min_thickness 0.2) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 0 10))))`
  const thru = footprint({ ref: "J1", at: "5 5", pads: [pad({ number: "1", type: "thru_hole", shape: "circle", at: "0 0", size: "1.6 1.6", layers: '"*.Cu" "*.Mask"', net: '(net 1 "A")', extra: '(drill 0.8) (backdrill (size 1) (layers "F.Cu" "In1.Cu"))' })] })
  const text = board({ version: V10, layers: L4, nets: [...NETS, '(net 2 "B")'], body: [zone, thru, via("17 5", '(backdrill (size 1) (layers "F.Cu" "In1.Cu"))'), via("3 2", ""), wall("In1.Cu"), wall("In2.Cu")] })
  const fills = () => {
    const p = imported(text)
    const a = analyzePcb(p, computeConnectivity(p))
    return { filled: (layer: string, x: number, y: number) => a.zoneFills.filter((f) => f.layer === layer).some((f) => f.polygons.some((poly) => fillTester(poly)({ x, y }))) }
  }

  it("on a layer that is cut the pour does not join the pad or the via and keeps out of the hole that is cut; on the other it still joins", () => {
    const { filled } = fills()
    // y is up in the project: the file's y 5 is -5
    // In1: the pad (a hole 1 mm across, so 0.5 + the hole gap 0.25 from its centre) is a hole in the pour, and the pour comes back beyond the pad's own clearance
    expect(filled("in1", 5.6, -5)).toBe(false)
    expect(filled("in1", 5, -5)).toBe(false)
    expect(filled("in1", 6.4, -5)).toBe(true)
    // In2: nothing is cut, so the pour joins the pad (the centre is copper of the fill, solid connection)
    expect(filled("in2", 5.6, -5)).toBe(true)
    // In1: the via keeps the pour out as far as its hole cut and its own clearance
    expect(filled("in2", 17.6, -5)).toBe(true)
    expect(filled("in2", 17, -5)).toBe(true)
  })

  it("copper that is cut does not keep an island of the pour alive: the right half has only a cut via on In1 and goes, and on In2 the via holds it", () => {
    const { filled } = fills()
    expect(filled("in1", 19, -3)).toBe(false)
    expect(filled("in2", 19, -3)).toBe(true)
    // the left half has a plain via on both, so it stays
    expect(filled("in1", 1.5, -7)).toBe(true)
    expect(filled("in2", 1.5, -7)).toBe(true)
  })
})

describe("the round trip check excuses an unset tenting side and no other", () => {
  const first = (tent: unknown) => ({ vias: [{ tent }] })
  const second = { vias: [{ tent: { front: false } }] }
  const by = (d: { kind: string }) => BY_DESIGN.some((re) => re.test(d.kind))
  it("a side the first project leaves unset, that comes back not tented, is by design", () => {
    const d = diffCanonical(first({}), second)
    expect(d).toHaveLength(1)
    expect(by(d[0])).toBe(true)
  })
  it("a side that was tented and comes back changed is a finding", () => {
    const d = diffCanonical(first({ front: true }), second)
    expect(d).toHaveLength(1)
    expect(by(d[0])).toBe(false)
  })
})

describe("X22 on a pad of a part on the bottom", () => {
  const extra = '(drill 0.5) (backdrill (size 0.6) (layers "F.Cu" "In1.Cu"))'
  const part = (layer: string) => footprint({ layer, at: "10 5", pads: [pad({ at: "0 0", type: "thru_hole", shape: "circle", layers: '"*.Cu" "*.Mask"', net: '(net 1 "A")', extra })] })

  it("the copper a backdrill cuts is on the board's layers whichever side the part is on", () => {
    for (const side of ["F.Cu", "B.Cu"]) {
      const p = imported(four([part(side)]))
      const item = buildCopperItems(p, computeConnectivity(p)).find((i) => i.kind === "pad")!
      expect(item.kind === "pad" && item.cut, side).toEqual({ top: 0.6, in1: 0.6 })
    }
  })

  it("a layer count that changes keeps the backdrill where it is on the board: the part's own side is renamed", () => {
    const p = imported(four([part("B.Cu")]))
    const before = padMachining(p)[0].backdrill
    expect(before).toEqual({ size: 0.6, from: "top", to: "in1" })
    const six = setCopperLayerCount(p, 6).project
    // in the part's own frame In1 of the board is the fourth inner layer of six, and the board's view has not moved
    expect(six.footprints![0].pads[0].backdrill).toEqual({ size: 0.6, from: "bottom", to: "in4" })
    registerProjectFootprints(six)
    expect(padMachining(six)[0].backdrill).toEqual(before)
  })
})
