import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import { board, footprint, pad } from "./kicad-board-fixtures"

// The differences the KiCad-judged audit (`kicad-judge-corpus.test.ts`) found between a KiCad board and its export, each on a board small enough to read:
// the `connect` pad type, copper with no net, a footprint's `ki_*` properties, the old translated layer names, and the report lines for what the export cannot say.

const FP = footprint({
  ref: "J1",
  name: "Local:Edge",
  pads: [pad({ number: "1", type: "connect", shape: "circle", at: "-1 0", size: "1 1", net: '(net 1 "GND")' }), pad({ number: "2", at: "1 0", net: '(net 2 "SIG")' })],
  extra: '(property ki_fp_filters "Conn*")',
})

const PCB = board({
  version: 20241229,
  nets: ['(net 0 "")', '(net 1 "GND")', '(net 2 "SIG")'],
  body: [FP, '(segment (start -1 0) (end -1 3) (width 0.25) (layer "F.Cu") (net 0))', '(via (at -1 3) (size 0.8) (layers "F.Cu" "B.Cu") (net 0))'],
})

const run = async (pcb: string, version = 20241229) => {
  const files: ProjectFile[] = [{ path: "b.kicad_pcb", data: pcb.replace(/\(version \d+\)/, `(version ${version})`) }]
  const r = importKicadProject(files)
  if (r.status !== "imported") throw new Error("not imported")
  const out = await kicadFiles(r.project)
  return { r, pcb: out.files[Object.keys(out.files).find((n) => n.endsWith(".kicad_pcb"))!] }
}

describe("what the audit found in a board's export", () => {
  it("writes a connect pad as one, copper with no net with no net, and a footprint's ki_ property", async () => {
    const { pcb } = await run(PCB)
    expect(pcb).toMatch(/\(pad "1" connect circle/)
    expect(pcb).toMatch(/\(pad "2" smd rect/)
    // the track and the via touch the GND pad, and the file says they are on no net
    expect(pcb).toMatch(/\(segment[\s\S]*?\(net 0\)/)
    expect(pcb).toMatch(/\(via[\s\S]*?\(net 0\)/)
    expect(pcb).toContain('(property "ki_fp_filters" "Conn*"')
  })

  it("keeps an old board's translated layer names as the layers' own names", async () => {
    const old = board({
      version: 20171130,
      layers: `(layers (0 F.Cu signal) (31 B.Cu signal) (32 B.Adhes user) (33 Kleju_Gorna user) (44 Edge.Cuts user))`,
      nets: ['(net 0 "")', '(net 1 "GND")', '(net 2 "SIG")'],
      body: [FP],
    })
    const { pcb } = await run(old, 20171130)
    expect(pcb).toMatch(/\(\d+ "F\.Adhes" user "Kleju_Gorna"\)/)
  })

  it("says in the report what the file could not carry", () => {
    const old = board({
      version: 20171130,
      setup: "(setup (pad_to_mask_clearance 0) (pcbplotparams (layerselection 0x00010fc_ffffffff)))",
      body: ['(via (at 5 5) (size 0.8) (layers F.Cu B.Cu) (net 0))'],
    })
    const r = importKicadProject([{ path: "o.kicad_pcb", data: old }])
    if (r.status !== "imported") throw new Error("not imported")
    const codes = r.report.entries.map((e) => e.code)
    expect(codes).toContain("plot-layers-not-carried")
    expect(codes).toContain("via-default-drill")
  })
})

// ---------- the schematic side ----------

import { registerProjectParts } from "../src/model/customParts"
import type { Project } from "../src/model/types"
import { importSheet, place } from "./kicad-sch-parts"
import { LIB_R } from "./kicad-schematic-fixtures"

const FONT = "(effects (font (size 1.27 1.27)))"
/** A symbol that is no power symbol (no `(power)`), with a hidden power-input pin that names its net, as KiCad's old `VPP` of the PIC programmer demo. */
const LIB_VPP = `(symbol "Test:VPP" (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 0 0) ${FONT})
  (property "Value" "VPP" (at 0 3.81 0) ${FONT})
  (symbol "VPP_0_1" (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "VPP_1_1" (pin power_in line (at 0 0 90) (length 0) hide (name "VPP" ${FONT}) (number "1" ${FONT}))))`
const LIB_FLAG = `(symbol "power:PWR_FLAG" (power) (in_bom yes) (on_board yes)
  (property "Reference" "#FLG" (at 0 1.905 0) ${FONT})
  (property "Value" "PWR_FLAG" (at 0 3.81 0) ${FONT})
  (symbol "PWR_FLAG_0_1" (polyline (pts (xy 0 0) (xy 0 1.27)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "PWR_FLAG_1_1" (pin power_out line (at 0 0 90) (length 0) (name "pwr" ${FONT}) (number "1" ${FONT}))))`
const LIB_RST = `(symbol "Test:RST" (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 5.08 0) ${FONT})
  (property "Value" "RST" (at 0 -5.08 0) ${FONT})
  (property "MANUFACTURER" "Acme" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
  (symbol "RST_0_1" (rectangle (start -3.81 3.81) (end 3.81 -3.81) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "RST_1_1" (pin input line (at -6.35 0 0) (length 2.54) (name "~{RST}" ${FONT}) (number "1" ${FONT}))))`

/** The sheet with a footprint on every part (an imported schematic has none until it is linked to a board), so the parts are on the board. */
function withFootprint(p: Project, fp = "soic8"): Project {
  const parts = (p.parts ?? []).map((s) => ({ ...s, id: s.id + "-fp", footprint: s.refPrefix === "#" ? "" : fp }))
  const q = { ...p, parts }
  registerProjectParts(q)
  const had = new Set((p.parts ?? []).filter((s) => s.refPrefix !== "#").map((s) => s.id))
  return { ...q, components: q.components.map((c) => ({ ...c, partId: `${c.partId.replace("@sub", "")}-fp${c.partId.endsWith("@sub") ? "@sub" : ""}`, footprint: had.has(c.partId.replace("@sub", "")) && !c.partId.endsWith("@sub") ? fp : "" })) }
}

describe("what the audit found in a schematic's export", () => {
  it("writes a symbol with a hidden power pin as the power symbol of its net, and a power flag", async () => {
    const project = withFootprint(
      importSheet({
        libs: [LIB_R, LIB_VPP, LIB_FLAG, LIB_RST],
        symbols: [place("Test:RST", "100 100", "U1", { value: "RST" }), place("Test:VPP", "60 100", "#PWR01"), place("power:PWR_FLAG", "60 120", "#FLG01")],
        wires: ["60 100 93.65 100"],
      }),
    )
    const out = await kicadFiles(project)
    const sch = out.files[Object.keys(out.files).find((n) => n.endsWith(".kicad_sch"))!]
    // the VPP symbol is a power symbol of the net VPP
    expect(sch).toMatch(/\(property "Value" "VPP"/)
    expect(sch).toMatch(/"#PWR[^"]*"/)
    // the flag is written
    expect(sch).toMatch(/\(property "Reference" "#FLG/)
    // the pin is named as the library entry named it, and the field as the symbol spelled it
    expect(sch).toContain('(name "~{RST}"')
    expect(sch).toContain('(property "MANUFACTURER" "Acme"')
  })
})

describe("what the full audit found next", () => {
  it("writes a hidden power pin hidden, so that KiCad puts it on the net of its name", async () => {
    const LIB_HID = `(symbol "Test:HID" (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 5.08 0) ${FONT})
  (property "Value" "HID" (at 0 -5.08 0) ${FONT})
  (property "Field7" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
  (symbol "HID_0_1" (rectangle (start -3.81 3.81) (end 3.81 -3.81) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "HID_1_1" (pin input line (at -6.35 0 0) (length 2.54) (name "IN" ${FONT}) (number "1" ${FONT})) (pin power_in line (at 0 6.35 270) (length 0) hide (name "VCC" ${FONT}) (number "2" ${FONT}))))`
    const project = withFootprint(importSheet({ libs: [LIB_HID], symbols: [place("Test:HID", "100 100", "U1", { value: "HID" })] }))
    const out = await kicadFiles(project)
    const sch = out.files[Object.keys(out.files).find((n) => n.endsWith(".kicad_sch"))!]
    const pin = sch.slice(sch.indexOf('(name "VCC"') - 200, sch.indexOf('(name "VCC"') + 20)
    expect(pin).toContain("(hide yes)")
    // and a field the symbol had with nothing in it is still there
    expect(sch).toContain('(property "Field7" ""')
  })

  it("writes a footprint's property that has no place back", async () => {
    const FPP = footprint({ ref: "J1", name: "Local:Edge", pads: [pad({ number: "1", at: "0 0" })], extra: '(property "LCSC" "C15850")' })
    const { pcb } = await run(board({ version: 20241229, body: [FPP] }))
    expect(pcb).toMatch(/\(property "LCSC" "C15850"[^)]*?\(at 0 0 0\)[^]*?\(hide yes\)/)
  })
})
