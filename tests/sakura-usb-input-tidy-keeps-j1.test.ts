import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BLOCKS, firstRequest, netlist, netlistDiff } from "./sakura-session"
import { projectFromExport } from "./sakura-export"

// Problem 2 of the owner's Sakura session: "The USB INPUT tidy rotated J1 and dropped most of its
// connections", and "check J1.A8 (SBU1) is not tied to CC1".
//
// These pass today: they pin that the
// one-block tidy is not what broke J1. Needs sakura-session.ts, sakura-session-parts.json and
// sakura-export.ts beside it; the last test reads the owner's export (SAKURA_EXPORT) and is
// skipped without it.
//
// - Tidy keeps every pin's net: tidy/index.ts:383-392 compares the netlist pin for pin and refuses
//   a change. Replayed with J1 as added (turn 0) and turned 90, and in 80 random starting layouts,
//   no one-block tidy changed a single pin's net.
// - Tidy never turns a box part (tidy/shapes.ts:85-88 allowedTurns returns its own turn), and J1 is
//   one: J1's 90 degree turn on the exported sheet did not come from Tidy.
// - But the exported file does have J1.A8 (SBU1) on CC1, through a CC1 label on a stub off A8, and
//   J1's other pins carry the straight labels connect draws, which it only draws for a pin that is
//   not on the net already (model/attach.ts:268-273). So J1's pins were off their nets just before
//   Sakura reconnected them, and something outside the logged tools turned J1 and left A8 on CC1's
//   stub (see sakura-canvas-rotate-shorts.test.ts: the R key does exactly that kind of damage).

const EXPORT = process.env.SAKURA_EXPORT ?? ""

function beforeFixRequest(j1Rot: number) {
  const s = firstRequest({ j1Rot })
  s.run("tidy_schematic", { blocks: ["3.3V POWER"] })
  for (const b of [...(s.project.blocks ?? [])]) s.must("edit_block", { block: b.name, ungroup: true })
  s.must("tidy_schematic", { whole_sheet: true })
  s.request()
  for (const [block, refs] of BLOCKS("USB INPUT")) s.must("group_parts", { block, refs })
  return s
}

describe("tidy_schematic on USB INPUT alone", () => {
  for (const j1Rot of [0, 90]) {
    it(`keeps every pin's net and J1's turn (J1 added at ${j1Rot})`, () => {
      const s = beforeFixRequest(j1Rot)
      const before = netlist(s.project)
      const rot = s.ref("J1").sch.rot
      const out = s.must("tidy_schematic", { blocks: ["USB INPUT"] })
      expect(out.summary).toBe("Tidied USB INPUT.")
      expect(netlistDiff(before, netlist(s.project))).toEqual([])
      expect(s.ref("J1").sch.rot).toBe(rot)
      expect(netlist(s.project).get("J1.A8")).toBeNull()
    })
  }

  it("the reconnects Sakura made afterwards draw nothing on pins already on their net", () => {
    const s = beforeFixRequest(0)
    s.must("tidy_schematic", { blocks: ["USB INPUT"] })
    const labels = s.project.labels.length
    s.must("connect", { pins: ["J1.CC1", "R1.1"], net_name: "CC1" })
    s.must("connect", { pins: ["J1.A4", "J1.B4"], net_name: "VBUS" })
    expect(s.project.labels.length).toBe(labels)
  })
})

describe.skipIf(!existsSync(EXPORT))("the owner's exported file", () => {
  it("has J1.A8 (SBU1) on CC1, and J1 turned 90", () => {
    const p = projectFromExport(EXPORT)
    const nl = netlist(p)
    expect(nl.get("J1.A8")).toBe("CC1")
    expect(nl.get("J1.B8")).toBeNull()
    expect(p.components.find((c) => c.ref === "J1")!.sch.rot).toBe(90)
  })
})
