import { describe, expect, it } from "vitest"
import { customPartProblems } from "../src/model/customParts"
import { getFootprint } from "../src/model/footprints"
import { landForSupplierPart, landPads, packageFamily, supplierFootprint, supplierLandPads } from "../src/model/supplier/build"
import { footprintNameProblem } from "../src/model/supplier/footprintGuard"
import { compareLands, summarizeLand } from "../src/model/supplier/land"
import type { CustomPartSpec } from "../src/model/types"
import { recordedPart } from "./fixtures/supplier/source"

const fp = (name: string) => landPads(getFootprint(name).pads)

describe("comparing a footprint with the supplier's land", () => {
  it("passes footprinter lands that put copper under the supplier's leads", () => {
    expect(compareLands(fp("sot23_6"), supplierLandPads(recordedPart("C351410"))).ok).toBe(true)
    expect(compareLands(fp("sot563"), supplierLandPads(recordedPart("C919459"))).ok).toBe(true)
    expect(compareLands(fp("0603"), supplierLandPads(recordedPart("C80165"))).ok).toBe(true)
  })

  it("refuses a DFN drawn on a SOIC land, with its pitch, row spacing and the worst pad in millimetres", () => {
    const c = compareLands(fp("dfn8"), supplierLandPads(recordedPart("C453460")))
    expect(c.ok).toBe(false)
    expect(c.problems[0]).toMatch(/^It has no pad 9, the supplier's exposed pad \(1\.8 x 1\.1 mm\): 8 pads, 1\.27 mm pitch, rows 4\.3 mm apart/)
    expect(c.problems[1]).toBe("8 of 8 pads miss the supplier's leads (pitch 1.27 mm against the supplier's 0.5 mm, rows 4.3 mm apart against 2.4 mm); worst is pad 8, 1.5 mm out.")
  })

  it("refuses the TPS61023 on SOT-23-6 copper: 0.95 mm pitch against SOT-563's 0.5 mm", () => {
    const c = compareLands(fp("sot23_6"), supplierLandPads(recordedPart("C919459")))
    expect(c.problems.join(" ")).toContain("pitch 0.95 mm against the supplier's 0.5 mm, rows 2.6 mm apart against 1.5 mm")
  })

  it("finds the footprinter's msop10 numbered backwards: right pads, wrong leads", () => {
    const c = compareLands(fp("msop10"), supplierLandPads(recordedPart("C2868291")))
    expect(c.ok).toBe(false)
    expect(c.problems[0]).toContain("4 of 10 pads miss the supplier's leads")
    // vssop10 is the same land numbered the right way round.
    expect(compareLands(fp("vssop10"), supplierLandPads(recordedPart("C2868291"))).problems.join(" ")).not.toContain("numbered the other way")
  })

  it("refuses 0402 pads under a 0.6 x 0.3 mm diode, which lands the leads but not the pads", () => {
    const c = compareLands(fp("0402"), supplierLandPads(recordedPart("C535144")))
    expect(c.ok).toBe(false)
    expect(c.problems[0]).toBe("2 of 2 pads miss the supplier's leads (rows 1.02 mm apart against 0.42 mm); worst is pad 1, 0.3 mm out.")
  })

  it("names the exposed pad a footprint leaves out: TP4056 on soic8", () => {
    const c = compareLands(fp("soic8"), supplierLandPads(recordedPart("C22470410")))
    expect(c.problems[0]).toMatch(/^It has no pad 9, the supplier's exposed pad \(3\.3 x 2\.4 mm\)/)
  })

  it("summarises a land in the numbers a refusal quotes", () => {
    expect(summarizeLand(supplierLandPads(recordedPart("C578694")))).toEqual({
      pads: 17,
      exposed: 1,
      pitch: 0.65,
      span: 3.9,
      extent: { x: 4.8, y: 4.8 },
    })
  })
})

describe("footprint names that draw another package", () => {
  it("refuses them with what they draw and the spelling that draws the real one", () => {
    expect(footprintNameProblem("dfn8")).toBe(
      "dfn8 draws 8 pads, 1.27 mm pitch, rows 4.3 mm apart, 5.3 x 4.41 mm of copper. A DFN needs its body size, pitch and pad size, e.g. dfn8_w2.5_h2.5_p0.5mm_pl0.5mm_pw0.25mm; better, take the supplier's land (pass lcsc).",
    )
    expect(footprintNameProblem("ssop24")).toContain("draws 24 pads, 1.27 mm pitch")
    expect(footprintNameProblem("ssop24")).toContain("write ssop24_p0.65mm")
    expect(footprintNameProblem("tssop8")).toContain("0.5 mm pitch")
    expect(footprintNameProblem("tssop20")).toContain("write tssop20_p0.65mm")
    expect(footprintNameProblem("msop10")).toContain("pin 6 sits opposite pin 1, where pin 10 belongs: write vssop10")
    expect(footprintNameProblem("qfn16")).toContain("give the body and pitch")
    for (const ok of ["soic8", "tssop8_p0.65mm", "ssop24_p0.65mm", "vssop10", "sot563", "qfn16_w4_h4_p0.65mm", "0201", "dfn8_w2.5_h2.5_p0.5mm_pl0.5mm_pw0.25mm"]) {
      expect(footprintNameProblem(ok), ok).toBeNull()
    }
  })
})

describe("exposed pads", () => {
  it("numbers the footprinter's thermal pad one past the last lead", () => {
    const pads = getFootprint("qfn16_w4_h4_p0.65mm_thermalpad").pads
    expect(pads.filter((p) => p.exposed).map((p) => p.pin)).toEqual(["17"])
  })

  const qfn = (pins: CustomPartSpec["pins"]): CustomPartSpec => ({
    id: "q-1",
    name: "Q",
    description: "",
    category: "ICs",
    refPrefix: "U",
    footprint: "qfn16_w4_h4_p0.65mm_thermalpad",
    pins,
    props: {},
  })
  const leads = Array.from({ length: 16 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}` }))

  it("lets a part give its exposed pad a pin, or leave it unconnected as before", () => {
    expect(customPartProblems(qfn([...leads, { number: "17", name: "EP", kind: "ground" }]))).toEqual([])
    expect(customPartProblems(qfn(leads))).toEqual([])
    expect(customPartProblems(qfn([...leads, { number: "EP", name: "EP" }]))).toEqual([
      "footprint qfn16_w4_h4_p0.65mm_thermalpad has 17 numbered pads, but pin(s) EP have no pad; the exposed pad is pad 17, so number pin EP 17",
    ])
  })
})

describe("building a land from the supplier's", () => {
  it("keeps the supplier's copper, named for its package so the 3D view picks a body", () => {
    const tp = recordedPart("C22470410")
    const land = supplierFootprint(tp)!
    expect(land.name).toMatch(/^soic8_c22470410-[0-9a-z]{6}$/)
    expect(land.pads.map((p) => p.pin)).toEqual(tp.land!.pads.map((p) => p.number))
    expect(land.silk.length).toBeGreaterThan(0)
    expect(packageFamily("SOT-563-6_L1.6-W1.2")).toBe("sot563")
    expect(packageFamily("LFCSP-16_L4.0-W4.0-P0.65")).toBe("qfn16")
    expect(packageFamily("VSSOP-10_L3.0-W3.0")).toBe("vssop10")
    expect(packageFamily("SMB_L4.3-W3.6")).toBe("smb")
  })

  it("uses the footprinter's chip land for a chip-sized part whose pads it matches", () => {
    expect(landForSupplierPart(recordedPart("C80165"))).toEqual({ footprint: "0603", def: null, matched: true })
    expect(landForSupplierPart(recordedPart("C535144"))?.matched).toBe(false)
  })
})
