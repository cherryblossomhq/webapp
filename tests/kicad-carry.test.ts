import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import { board, footprint, pad } from "./kicad-board-fixtures"

// What a KiCad import keeps for the export that nothing in the editor edits (`KicadCarry`, `ComponentInstance.loneNets`...), and writes back: the page, the origins, the plot settings,
// a layer's name, the project file, a footprint's description, tags, field names, pad pin names and 3D models of its own folder, a net of one pad, and a net name with a slash in it.
// KiCad is the judge in `kicad-judge-corpus.test.ts`; this is the same checks on a board small enough to read.

const FP = footprint({
  ref: "R1",
  name: "Local:R_Mine",
  pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "VPP{slash}MCLR")', extra: '(pinfunction "IN") (pintype "passive")' }), pad({ number: "2", at: "1 0", net: '(net 2 "unconnected-(R1-Pad2)")' })],
  extra: `(descr "A resistor, mine") (tags "res, mine, 0603") (property "LCSC Part" "C25804" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1) (thickness 0.15)))) (model "\${KIPRJMOD}/libs/mine.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))`,
})

const PCB = board({
  version: 20240108,
  layers: `(layers (0 "F.Cu" signal "Top") (31 "B.Cu" signal) (44 "Edge.Cuts" user) (39 "User.1" user "Notes"))`,
  setup: `(setup (pad_to_mask_clearance 0) (aux_axis_origin 5 6) (grid_origin 1 2) (pcbplotparams (layerselection 0x00010fc_ffffffff) (outputdirectory "plots/")))`,
  nets: ['(net 0 "")', '(net 1 "VPP{slash}MCLR")', '(net 2 "unconnected-(R1-Pad2)")'],
  body: [FP],
  outline: `(gr_rect (start 0 0) (end 20 10) (stroke (width 0.15) (type default)) (fill none) (layer "Edge.Cuts"))`,
}).replace('(paper "A4")', '(paper "A3")')

const PRO = JSON.stringify({ board: { design_settings: { rules: { min_text_height: 0.8 }, rule_severities: { silk_edge_clearance: "ignore" } } }, net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.8, via_drill: 0.4, wire_width: 6 }] } })
const DRU = '(version 1)\n(rule "keep out" (constraint clearance (min 0.3)) (condition "A.NetClass == \'Power\'"))\n'

const files = (): ProjectFile[] => [
  { path: "b.kicad_pcb", data: PCB },
  { path: "b.kicad_pro", data: PRO },
  { path: "b.kicad_dru", data: DRU },
]

describe("what a KiCad import keeps for the export", () => {
  it("brings the board in and keeps the settings of the board and the project", () => {
    const r = importKicadProject(files())
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const k = r.project.kicad!
    expect(k.paper).toBe('"A3"')
    expect(k.auxOrigin).toEqual({ x: 5, y: 6 })
    expect(k.gridOrigin).toEqual({ x: 1, y: 2 })
    expect(k.plot).toContain("(layerselection 0x00010fc_ffffffff)")
    expect(k.plot).toContain('(outputdirectory "plots/")')
    expect(k.edgeWidth).toBe(0.15)
    expect(k.layers?.find((l) => l.name === "User.1")?.user).toBe("Notes")
    expect(JSON.parse(k.pro!).board.design_settings.rules.min_text_height).toBe(0.8)
    expect(k.dru).toContain("keep out")
    const c = r.project.components[0]
    expect(c.modelRefs?.[0]).toContain("${KIPRJMOD}/libs/mine.step")
    expect(r.project.footprints?.[0].descr).toBe("A resistor, mine")
    expect(r.project.footprints?.[0].tags).toBe("res, mine, 0603")
    expect(c.texts?.some((t) => t.name === "LCSC Part")).toBe(true)
  })

  it("writes them back", async () => {
    const r = importKicadProject(files())
    if (r.status !== "imported") throw new Error("not imported")
    const out = await kicadFiles(r.project)
    const names = Object.keys(out.files)
    const pcb = out.files[names.find((n) => n.endsWith(".kicad_pcb"))!]
    expect(pcb).toContain('(paper "A3")')
    expect(pcb).toContain("(aux_axis_origin 5 6)")
    expect(pcb).toContain("(grid_origin 1 2)")
    expect(pcb).toContain("(layerselection 0x00010fc_ffffffff)")
    expect(pcb).toMatch(/\(39 "User\.1" user "Notes"\)/)
    expect(pcb).toMatch(/\(width 0\.15\)/)
    expect(pcb).toContain('(descr "A resistor, mine")')
    expect(pcb).toContain('(tags "res, mine, 0603")')
    expect(pcb).toContain('(property "LCSC Part" "C25804"')
    expect(pcb).toContain('(pinfunction "IN")')
    expect(pcb).toContain('(pintype "passive")')
    expect(pcb).toContain('"unconnected-(R1-Pad2)"')
    expect(pcb).toContain('"VPP{slash}MCLR"')
    expect(pcb).toContain('(model "${KIPRJMOD}/libs/mine.step"')
    const pro = JSON.parse(out.files[names.find((n) => n.endsWith(".kicad_pro"))!])
    expect(pro.board.design_settings.rules.min_text_height).toBe(0.8)
    expect(pro.board.design_settings.rule_severities.silk_edge_clearance).toBe("ignore")
    expect(pro.net_settings.classes[0].wire_width).toBe(6)
    expect(out.files[names.find((n) => n.endsWith(".kicad_dru"))!]).toContain("keep out")
  })
})
