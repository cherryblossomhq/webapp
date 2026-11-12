/**
 * The alias table that resolves a legacy or foreign package name to KiCad's
 * current stock model (`STOCK_ALIASES` in `model/kicad/board/models.ts`).
 *
 * Two things are worth holding it to, and they pull against each other:
 * every target must be a file the library really has at
 * `KICAD_LIBRARY_RELEASE`, or the alias is a silent miss; and nothing may
 * resolve a *part* to a package it is not, which is how a board ends up drawn
 * with a body nobody chose.
 */
import { describe, expect, it } from "vitest"
import { aliasStockModel, KICAD_LIBRARY_RELEASE, STOCK_ALIAS_TARGETS } from "../src/model/kicad/board/models"
import { stockModelExists } from "../src/model/kicad/board/stockModels"

describe("stock model aliases", () => {
  it("every target is a file the library has at this release", () => {
    const missing = STOCK_ALIAS_TARGETS.filter((target) => {
      const [library, name] = target.split("/")
      return !stockModelExists(library, name)
    })
    expect(missing).toEqual([])
  })

  it("resolves the spellings the community boards actually use", () => {
    const cases: [string, string][] = [
      // KiCad 4's library name, from the Olimex iCE40HX8K board.
      ["Resistors_SMD/R_0603.wrl", "R_0603_1608Metric"],
      // An author's own folder, from the VESC.
      ["smd\\resistors\\R0603.wrl", "R_0603_1608Metric"],
      // A colour in the name is the part's, not the package's (Olimex).
      ["${KISYS3DMOD}/LED_0603_B.wrl", "LED_0603_1608Metric"],
      ["${KISYS3DMOD}/LED_0603_O.wrl", "LED_0603_1608Metric"],
      ["${KISYS3DMOD}/LED-5mm.STEP", "LED_D5.0mm"],
      // HackRF's own folder.
      ["smd/cms_sot23.wrl", "SOT-23"],
      ["smd/SOT223.wrl", "SOT-223"],
      ["walter/smd_dil/so-8.wrl", "SOIC-8_3.9x4.9mm_P1.27mm"],
      // `Diodes_SMD` was renamed, and the model lost its suffix.
      ["Diodes_SMD.3dshapes/SMA_Handsoldering.wrl", "D_SMA"],
    ]
    for (const [path, name] of cases) {
      const hit = aliasStockModel(path)
      expect(hit, path).not.toBeNull()
      expect(hit!.name, path).toBe(name)
      expect(hit!.id, path).toBe(`${KICAD_LIBRARY_RELEASE}/${hit!.id.split("/").slice(1).join("/")}`)
    }
  })

  it("leaves a package the library does not have alone, rather than drawing a near one", () => {
    // SOT-523 is a third the size of a SOT-23. The library has no model for it,
    // and the board must show bare pads rather than the larger body.
    expect(aliasStockModel("${KICAD6_3DMODEL_DIR}/Package_TO_SOT_SMD.3dshapes/SOT-523.wrl")).toBeNull()
    // The 0201 and 0402 diode bodies are not in the library either.
    expect(aliasStockModel("${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_0201_0603Metric.wrl")).toBeNull()
    expect(aliasStockModel("${KICAD10_3DMODEL_DIR}/Diode_SMD.3dshapes/D_0402_1005Metric.wrl")).toBeNull()
  })

  it("maps package names only, never a part number or a footprint", () => {
    // A part number that merely contains a package name resolves to nothing.
    expect(aliasStockModel("mylib/BC847_SOT23_special.wrl")).toBeNull()
    expect(aliasStockModel("mylib/R_0603_HighPrecision_0.01pct.wrl")).toBeNull()
    // An empty or extensionless path is not a lookup.
    expect(aliasStockModel("")).toBeNull()
    expect(aliasStockModel("some/folder/")).toBeNull()
  })

  it("ignores the folder a file sat in, and the case it was written in", () => {
    const a = aliasStockModel("a/b/c/R_0603.wrl")
    const b = aliasStockModel("R_0603.STEP")
    const c = aliasStockModel("${KIPRJMOD}/deep/path/r_0603.wrl")
    expect(a?.name).toBe("R_0603_1608Metric")
    expect(b?.name).toBe("R_0603_1608Metric")
    expect(c?.name).toBe("R_0603_1608Metric")
  })
})
