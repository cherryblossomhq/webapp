import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { gerberCopper } from "../src/export/gerber"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { setCopperLayerCount } from "../src/model/layerOps"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X31: a pad that joins a pour on some copper layers and not others (KiCad's `zone_layer_connections` of a pad). With the pad's unused layers removed, it
// keeps its copper on the layers listed and on any other only where a track, a via or a pad touches it. The importer reads it, the project holds it (in the
// part's own frame), the checks and the plots drop the copper it does not keep, the project file stores it, and the writer says it back.

const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
const ORIGIN = { id: "p1", createdAt: 1, updatedAt: 1 }
const NETS = ['(net 0 "")', '(net 1 "A")']
const REMOVE = "(remove_unused_layers yes) (keep_end_layers no)"
const thru = (extra: string) => pad({ number: "1", type: "thru_hole", shape: "circle", at: "0 0", size: "1.6 1.6", layers: '"*.Cu" "*.Mask"', extra: `(drill 0.8) ${extra}` })
const fp = (extra: string, layer = "F.Cu") => footprint({ ref: "J1", layer, at: "10 5", pads: [thru(extra)] })

const imported = (text: string): Project => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.filter((e) => e.severity === "refused").map((e) => e.why).join("\n")}`)
  return r.project
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
const kept = (p: Project) => analyzePcb(p, computeConnectivity(p)).items.find((i) => i.kind === "pad")!.layers

describe("X31: the layers a pour joins a pad on", () => {
  it("is built, and a board with it is imported", () => {
    expect(BUILT_EXTENSIONS.has("X31")).toBe(true)
    expect(importKicadBoard(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu")`)] })).status).toBe("imported")
  })

  it("the pad keeps its copper on the layers listed, and drops the others where nothing touches it", () => {
    const without = imported(board({ layers: L4, nets: NETS, body: [fp(REMOVE)] }))
    expect(kept(without)).toEqual([])
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu" "B.Cu")`)] }))
    expect(p.footprints![0].pads[0].zoneLayers).toEqual(["in1", "bottom"])
    expect(kept(p)).toEqual(["in1", "bottom"])
  })

  it("the node with no layer is kept as the empty list, and a pad with none has none", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections)`)] }))
    expect(p.footprints![0].pads[0].zoneLayers).toEqual([])
    expect(await pcbOf(p)).toContain("(zone_layer_connections)")
    const plain = imported(board({ layers: L4, nets: NETS, body: [fp(REMOVE)] }))
    expect(plain.footprints![0].pads[0].zoneLayers).toBeUndefined()
    expect(await pcbOf(plain)).not.toContain("zone_layer_connections")
  })

  it("a layer a track touches the pad on is kept as well", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (net 1 "A") (zone_layer_connections "In1.Cu")`), '(segment (start 10 5) (end 14 5) (width 0.2) (layer "In2.Cu") (net 1))'] }))
    expect(kept(p)).toEqual(["in1", "in2"])
  })

  it("a part on the bottom has the layers turned over in its own frame, and they come back where the file had them", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu" "F.Cu")`, "B.Cu")] }))
    // the file's In1 is the part's In2 and the file's F.Cu is the part's far side
    expect(p.footprints![0].pads[0].zoneLayers).toEqual(["in2", "bottom"])
    expect(pcbPads(p.components[0], 4)[0].zoneLayers!.slice().sort()).toEqual(["in1", "top"])
    expect(kept(p).slice().sort()).toEqual(["in1", "top"])
    const text = await pcbOf(p)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project)).toEqual([])
    expect(unknownNodes(text)).toEqual([])
  })

  it("is written back and imports as the same project", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "F.Cu" "In2.Cu")`)] }))
    const text = await pcbOf(p)
    expect(text).toMatch(/\(zone_layer_connections "F\.Cu" "In2\.Cu"\)/)
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(p, again.project)).toEqual([])
  })

  it("survives a save and a load, the empty list as well", () => {
    for (const layers of ['"In1.Cu"', ""]) {
      const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections ${layers})`)] }))
      const back = parseProjectFile(serializeProject(p), ORIGIN)
      expect(back.footprints![0].pads[0].zoneLayers).toEqual(p.footprints![0].pads[0].zoneLayers)
    }
  })

  it("the Gerber of a layer has the pad's copper where it is kept and not where it is dropped", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu")`)] }))
    const a = analyzePcb(p, computeConnectivity(p))
    const flashes = (layer: "in1" | "in2") => (gerberCopper(p, layer, a.zoneFills, a.items).match(/D03\*/g) ?? []).length
    expect(flashes("in1")).toBe(1)
    expect(flashes("in2")).toBe(0)
  })

  it("taking away the layer a pad lists drops it from the list", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu" "In2.Cu")`)] }))
    const two = setCopperLayerCount(p, 2).project
    expect(two.footprints![0].pads[0].zoneLayers).toEqual([])
  })

  it("a stored pad whose list is not a list of layers is refused with its land, as any malformed pad", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp(`${REMOVE} (zone_layer_connections "In1.Cu")`)] }))
    const raw = JSON.parse(serializeProject(p))
    raw.project.footprints[0].pads[0].zoneLayers = "in1"
    expect(parseProjectFile(raw, ORIGIN).footprints ?? []).toHaveLength(0)
  })
})
