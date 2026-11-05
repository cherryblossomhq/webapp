import { describe, expect, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadProject } from "../src/model/kicad/project"
import { analyzePcb } from "../src/model/pcb"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// On a project from KiCad, Checks hold every hole to KiCad's hole clearance (`min_hole_clearance`) against copper of another net, and an
// unplated hole against copper of every net. The router keeps the same distance, or what it routes is an error the board did not have:
// on four open boards (Raspberry Pi's CM5 IO board, Antmicro's Scalenode, the Pico VGA board) kicad-cli found its tracks 0.15 to 0.21 mm
// from connector pegs and module holes held to 0.19 or 0.25 mm.

const NETS = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
const smd = (n: string, at: string, net: string) => pad({ number: n, at, size: "1 1", net: `(net ${net} ${net === "1" ? '"A"' : '"B"'})` })
const npth = (at: string, drill: number) => pad({ number: "", type: "np_thru_hole", shape: "circle", at, size: `${drill} ${drill}`, layers: '"*.Cu" "*.Mask"', extra: `(drill ${drill})` })
const pro = (holeClearance: number) => JSON.stringify({ meta: { filename: "demo.kicad_pro", version: 1 }, board: { design_settings: { rules: { min_hole_clearance: holeClearance, min_clearance: 0.2 } } } })

function project(holeClearance: number, extra: string[] = []): Project {
  const text = board({
    nets: NETS,
    body: [
      footprint({ ref: "R1", at: "3 5", pads: [smd("1", "-1 0", "1"), smd("2", "1 0", "2")] }),
      footprint({ ref: "R2", at: "17 5", pads: [smd("1", "-1 0", "1"), smd("2", "1 0", "2")] }),
      // a 1 mm peg hole right on the straight way between the parts
      footprint({ ref: "H1", name: "MountingHole:MountingHole_1mm", at: "10 5", pads: [npth("0 0", 1)] }),
      ...extra,
    ],
  })
  const r = importKicadProject([
    { path: "demo.kicad_pcb", data: text },
    { path: "demo.kicad_pro", data: pro(holeClearance) },
  ])
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}

const holeErrors = (p: Project) =>
  analyzePcb(p, computeConnectivity(p))
    .violations.filter((v) => v.severity === "error" && v.message.startsWith("Hole clearance"))
    .map((v) => v.message)

describe("the autorouter on a project from KiCad", () => {
  it("keeps KiCad's hole clearance from an unplated hole, which is wider than the copper clearance", () => {
    const before = project(0.6)
    expect(holeErrors(before)).toEqual([])
    const routed = autoroute(before)
    expect(routed.remaining).toBe(0)
    expect(holeErrors(routed.project)).toEqual([])
    // every new trace stays the hole clearance away from the hole's wall
    for (const t of routed.project.traces) {
      for (let k = 1; k < t.points.length; k++) {
        const a = t.points[k - 1]
        const b = t.points[k]
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        const s = Math.max(0, Math.min(1, ((10 - a.x) * (b.x - a.x) + (5 - a.y) * (b.y - a.y)) / (len * len)))
        const d = Math.hypot(a.x + s * (b.x - a.x) - 10, a.y + s * (b.y - a.y) - 5) - 0.5 - t.width / 2
        expect(d).toBeGreaterThanOrEqual(0.6 - 2e-3)
      }
    }
  })

  it("routes as before where KiCad's hole clearance asks no more than the copper clearance does", () => {
    const routed = autoroute(project(0))
    expect(routed.remaining).toBe(0)
    expect(holeErrors(routed.project)).toEqual([])
  })
})
