import { describe, expect, it } from "vitest"
import { getFootprint } from "../src/model/footprints"
import { stockModelExists } from "../src/model/kicad/board/stockModels"
import { LIBRARY_MODEL_SOURCES } from "../src/model/libraryModelSources"
import { libraryModel } from "../src/model/libraryModels"
import TABLE from "../src/model/libraryModels.json"
import { KICAD_MODEL_ID } from "../src/model/supplier/kicadModel"
import PADS from "./library-model-pads.json"

// The built-in parts' KiCad models (`libraryModels.json`), kept in step with our footprints without
// fetching anything: `library-models.generate.test.ts` wrote where KiCad's pads land on each
// footprint, and every one of them must still find a pad of ours there. A footprint that changes
// under its model fails here, and the table is written again (npm run library-models).

const TOLERANCE = 0.35
const key = (part: string, footprint: string) => `${part}\n${footprint}`
const sources = new Map(LIBRARY_MODEL_SOURCES.map((s) => [key(s.part, s.footprint), s]))

describe("the built-in parts' 3D models", () => {
  it("has one for every source, and only for those", () => {
    expect(TABLE.models.map((m) => key(m.part, m.footprint)).sort()).toEqual([...sources.keys()].sort())
  })

  it("names a STEP file KiCad's 3D library has at the release the parts index serves", () => {
    for (const { model } of TABLE.models) {
      expect(model.id, model.id).toMatch(KICAD_MODEL_ID)
      const [release, library, file] = model.id.split("/")
      expect(release).toBe(TABLE.release)
      expect(stockModelExists(library, file.replace(/\.step$/, "")), model.id).toBe(true)
    }
  })

  it.each(PADS.map((p) => [p.part, p.footprint, p.pads] as const))("%s on %s still sits on KiCad's pads", (part, footprint, pads) => {
    const source = sources.get(key(part, footprint))!
    const ours = getFootprint(footprint)
      .pads.filter((p) => p.pin && p.plated !== false && !source.ignore?.includes(p.pin))
      .map((p) => ({ x: p.x, y: p.y }))
    const theirs = pads.map(([, x, y]) => ({ x: Number(x), y: Number(y) }))
    const worst = (a: typeof ours, b: typeof ours) => Math.max(...a.map((p) => Math.min(...b.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))))
    expect(ours.length).toBeGreaterThan(0)
    expect(Math.max(worst(theirs, ours), worst(ours, theirs))).toBeLessThanOrEqual(source.tolerance ?? TOLERANCE)
  })

  it("is a built-in part's own, else the package's whatever part is in it, else none", () => {
    expect(libraryModel("resistor", "0603")?.id).toBe("10.0.7/Resistor_SMD.3dshapes/R_0603_1608Metric.step")
    expect(libraryModel("capacitor", "0603")?.id).toBe("10.0.7/Capacitor_SMD.3dshapes/C_0603_1608Metric.step")
    expect(libraryModel("ne555", "soic8")?.id).toBe("10.0.7/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step")
    expect(libraryModel("socket_dip8", "dip8")?.id).toBe("10.0.7/Package_DIP.3dshapes/DIP-8_W7.62mm_Socket.step")
    expect(libraryModel("attiny85", "dip8")?.id).toBe("10.0.7/Package_DIP.3dshapes/DIP-8_W7.62mm.step")
    // A chip footprint says nothing about what part is on it: an 0603 of no known kind has no model.
    expect(libraryModel("fuse", "0603")).toBeNull()
    // No made-up bodies: a screw terminal of no particular maker, a switch or a dev board KiCad has no model of.
    expect(libraryModel("screw_terminal_2", "pinrow2_p5.08mm")).toBeNull()
    expect(libraryModel("slide_switch", "eg1218")).toBeNull()
    expect(libraryModel("esp32_devkit_v1", "esp32_devkit_v1")).toBeNull()
  })

  it("turns a diode's model so its band is on our cathode, which is pin 2 where KiCad's is pad 1", () => {
    for (const [part, footprint] of [
      ["diode", "sod123"],
      ["led", "0603"],
      ["schottky", "diode_smc"],
    ]) {
      expect(libraryModel(part, footprint)?.rotation.z, `${part} on ${footprint}`).toBe(180)
    }
    // Polarized capacitors are numbered + first, as KiCad's are.
    expect(libraryModel("capacitor_tantalum", "tantalum_3528")?.rotation.z).toBe(0)
  })
})
