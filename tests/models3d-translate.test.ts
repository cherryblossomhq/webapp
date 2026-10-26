import { beforeAll, describe, expect, it } from "vitest"
import { ModelMaterials, pickModel, type ModelContext } from "../src/editor/three/models"
import { bodyOf, translatePackage } from "../src/editor/three/models/translate"
import { buildCustomPart } from "../src/model/customParts"
import { getFootprint, registerProjectFootprints } from "../src/model/footprints"
import { addDraftToProject, draftFromIndexPart } from "../src/model/indexPart"
import type { Imported } from "../src/model/kicad/library"
import { registerPart } from "../src/model/library"
import { createProject } from "../src/model/ops"
import { packageOf } from "../src/model/partPackage"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { ComponentInstance, CustomPartSpec } from "../src/model/types"
import { loadImported, storedPart } from "./index-part-support"

// The 3D view reads a body out of a package's own name (`translate.ts`), for the families a name
// settles. A name it doesn't understand, or one that only looks like a family, is null and the
// footprint's own rules draw the part as they always did.

describe("package names to model plans", () => {
  it("reads chips by their code and takes the role from the name's prefix, then the part", () => {
    expect(translatePackage("R_0603_1608Metric")).toMatchObject({ family: "chip", role: "resistor", l: 1.6, w: 0.8 })
    expect(translatePackage("C_0402_1005Metric")).toMatchObject({ family: "chip", role: "capacitor", l: 1, w: 0.5 })
    expect(translatePackage("L_0805_2012Metric")).toMatchObject({ family: "chip", role: "inductor", l: 2, w: 1.25 })
    expect(translatePackage("LED_0805_2012Metric")).toMatchObject({ family: "chip", role: "led", cathodeFirst: true })
    expect(translatePackage("D_0603_1608Metric")).toMatchObject({ family: "chip", role: "diode", cathodeFirst: true })
    expect(translatePackage("R_2512_6332Metric_Pad1.52x3.35mm_HandSolder")).toMatchObject({ l: 6.3, w: 3.2 })
    expect(translatePackage("Resistor_SMD:R_01005_0402Metric")).toMatchObject({ role: "resistor", l: 0.4, w: 0.2 })
    // A bare code is whatever the part says it is.
    expect(translatePackage("0603", { refPrefix: "L" })).toMatchObject({ role: "inductor" })
    expect(translatePackage("0603", { refPrefix: "D", text: "LED, Red" })).toMatchObject({ role: "led" })
    expect(translatePackage("0603", {})).toMatchObject({ role: "capacitor" })
    // An array has a chip's size in its name and is not a chip.
    expect(translatePackage("R_Array_Convex_4x0603")).toBeNull()
  })

  it("reads SOT, SOD and the moulded diodes, and tells a diode from an SMA connector", () => {
    expect(translatePackage("SOT-23")).toEqual({ family: "gullWing", style: "sot23" })
    expect(translatePackage("SOT-23-5")).toEqual({ family: "gullWing", style: "sot23" })
    expect(translatePackage("SOT-223-3_TabPin2")).toEqual({ family: "gullWing", style: "sot223" })
    expect(translatePackage("SOT-89-3")).toEqual({ family: "gullWing", style: "sot89" })
    expect(translatePackage("SOT-363_SC-70-6")).toEqual({ family: "gullWing", style: "sot323" })
    expect(translatePackage("D_SOD-123F")).toMatchObject({ family: "moldedDiode", style: "sod123f", cathodeFirst: true })
    expect(translatePackage("D_SOD-323")).toMatchObject({ family: "moldedDiode", style: "sod323" })
    expect(translatePackage("D_SMA")).toMatchObject({ family: "moldedDiode", style: "sma" })
    expect(translatePackage("D_SMB_Handsoldering")).toMatchObject({ family: "moldedDiode", style: "smb" })
    expect(translatePackage("D_SMC")).toMatchObject({ family: "moldedDiode", style: "smc" })
    expect(translatePackage("SMA(DO-214AC)")).toMatchObject({ family: "moldedDiode", style: "sma" })
    expect(translatePackage("SMA_Amphenol_901-144_Vertical")).toBeNull()
  })

  it("reads the leaded and leadless families, with the body the name states", () => {
    expect(translatePackage("SOIC-8_3.9x4.9mm_P1.27mm")).toEqual({ family: "gullWing", style: "soic", body: { w: 3.9, l: 4.9, xy: true } })
    expect(translatePackage("TSSOP-16-1EP_4.4x5mm_P0.65mm_EP3x3mm")).toMatchObject({ family: "gullWing", style: "tssop", body: { w: 4.4, l: 5 } })
    expect(translatePackage("SSOP-24_5.3x8.2mm_P0.65mm")).toMatchObject({ family: "gullWing", style: "ssop" })
    expect(translatePackage("MSOP-10_3x3mm_P0.5mm")).toMatchObject({ family: "gullWing", style: "msop" })
    expect(translatePackage("TQFP-32_7x7mm_P0.8mm")).toMatchObject({ family: "gullWing", style: "tqfp", body: { w: 7, l: 7 } })
    expect(translatePackage("LQFP-48_7x7mm_P0.5mm")).toMatchObject({ family: "gullWing", style: "lqfp" })
    expect(translatePackage("SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL")).toEqual({ family: "gullWing", style: "soic", body: { w: 3.9, l: 4.9 } })
    expect(translatePackage("Texas_RSA_VQFN-16-1EP_4x4mm_P0.65mm_EP2.7x2.7mm")).toEqual({ family: "noLead", body: { w: 4, l: 4, xy: true } })
    expect(translatePackage("QFN-24-1EP_4x4mm_P0.5mm_EP2.6x2.6mm")).toMatchObject({ family: "noLead", body: { w: 4, l: 4 } })
    expect(translatePackage("DFN-8-1EP_3x2mm_P0.5mm_EP1.75x1.45mm")).toMatchObject({ family: "noLead", body: { w: 3, l: 2 } })
    expect(translatePackage("WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm")).toMatchObject({ family: "noLead" })
    expect(translatePackage("BGA-256_17.0x17.0mm_Layout16x16_P1.0mm")).toEqual({ family: "gridPackage", balls: true, body: { w: 17, l: 17, xy: true } })
    expect(translatePackage("WLCSP-8_1.58x1.63x0.35mm_Layout3x5_P0.35x0.4mm")).toMatchObject({ family: "gridPackage", body: { w: 1.58, l: 1.63, h: 0.35 } })
    expect(translatePackage("Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering")).toMatchObject({ family: "gridPackage", balls: false })
  })

  it("reads the through-hole families", () => {
    expect(translatePackage("DIP-8_W7.62mm")).toEqual({ family: "dip" })
    expect(translatePackage("TO-220-3_Vertical")).toEqual({ family: "to220", isolated: false })
    expect(translatePackage("TO-92_Inline")).toEqual({ family: "to92" })
    expect(translatePackage("TO-252-2")).toEqual({ family: "gullWing", style: "to252" })
    expect(translatePackage("TO-263-5_TabPin3")).toEqual({ family: "gullWing", style: "to263" })
    expect(translatePackage("PinHeader_1x04_P2.54mm_Vertical")).toEqual({ family: "pinHeader", socket: false })
    expect(translatePackage("PinSocket_2x05_P2.54mm_Vertical")).toEqual({ family: "pinHeader", socket: true })
    expect(translatePackage("JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical")).toEqual({ family: "jst", series: "ph" })
    expect(translatePackage("JST_XH_B3B-XH-A_1x03_P2.50mm_Vertical")).toEqual({ family: "jst", series: "xh" })
  })

  it("leaves what it would draw wrong to the footprint's rules", () => {
    // Other TO packages are not a TO-220's body.
    for (const name of ["TO-247-3_Vertical", "TO-3P-3_Vertical", "TO-264-3_Vertical", "TO-39-3", "TO-220-3_Horizontal_TabDown"]) expect(translatePackage(name), name).toBeNull()
    // Headers lying down, surface-mount ones and other pitches are not the vertical through-hole header.
    for (const name of ["PinHeader_1x04_P2.54mm_Horizontal", "PinHeader_1x04_P2.54mm_Vertical_SMD_Pin1Left", "PinSocket_1x04_P2.54mm_Horizontal", "PinHeader_1x04_P1.27mm_Vertical"]) expect(translatePackage(name), name).toBeNull()
    expect(translatePackage("JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal")).toBeNull()
    expect(translatePackage("JST_GH_SM04B-GHS-TB_1x04-1MP_P1.25mm_Horizontal")).toBeNull()
    // A socket for a DIP is not a DIP, and USB connectors are not read at all.
    expect(translatePackage("DIP-8_W7.62mm_Socket")).toBeNull()
    expect(translatePackage("DIP-8_W7.62mm_Socket_LongPads")).toBeNull()
    expect(translatePackage("USB_C_Plug_JAE_DX07P024AJ1")).toBeNull()
    expect(translatePackage("USB_Micro-B_Molex_47346-0001")).toBeNull()
    // And a name nobody listed.
    for (const name of ["", "SomeUnknownThing_42", "MountingHole_3.2mm_M3", "ESP32-WROOM-32", "Crystal_SMD_3225-4Pin_3.2x2.5mm"]) expect(translatePackage(name), name).toBeNull()
  })

  it("takes sizes from the name where it has them", () => {
    expect(bodyOf("SOIC-8_3.9x4.9mm_P1.27mm")).toEqual({ w: 3.9, l: 4.9, xy: true })
    expect(bodyOf("QFN-24-1EP_4x4mm_P0.5mm_EP2.6x2.6mm")).toEqual({ w: 4, l: 4, xy: true })
    expect(bodyOf("HTSSOP-16-1EP_4.4x5mm_P0.65mm_EP3.4x5mm_Mask2.78x3.37mm")).toEqual({ w: 4.4, l: 5, xy: true })
    expect(bodyOf("SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL")).toEqual({ w: 3.9, l: 4.9 })
    expect(bodyOf("SOT-23-5")).toBeUndefined()
  })
})

// ---------- from a stored KiCad part to a model ----------

describe("bodies for KiCad parts", () => {
  let imported: Imported
  beforeAll(async () => {
    imported = await loadImported()
  })

  function placed(key: string) {
    const built = draftFromIndexPart(storedPart(imported, key))
    if ("error" in built) throw new Error(built.error)
    const added = addDraftToProject(createProject("x"), built)
    if ("error" in added) throw new Error(added.error)
    return { built, ...added }
  }

  /** What the 3D view is given for a stored part placed in a project, as `generatedModel` reads it. */
  function contextOf(key: string): ModelContext {
    const { built, spec } = placed(key)
    if (built.land) registerProjectFootprints({ footprints: [built.land] })
    const def = buildCustomPart(spec)
    registerPart(def)
    const fp = getFootprint(spec.footprint)
    const component: ComponentInstance = { id: "c1", partId: def.id, ref: "U1", props: { ...def.defaultProps }, footprint: spec.footprint, sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true } }
    return { component, part: def, footprint: spec.footprint, package: packageOf(fp, spec), pads: fp.pads.filter((p) => p.plated !== false), holes: fp.pads.filter((p) => p.plated === false), courtyard: fp.courtyard, boardThickness: 1.6, materials: new ModelMaterials() }
  }

  const picked = (key: string) => {
    const p = pickModel(contextOf(key))
    return `${p.family}:${p.source}`
  }

  /** The size of the plastic body: its extent in x and y, and its top. */
  function body(key: string) {
    const g = pickModel(contextOf(key)).builder.build().geoms.get("epoxy")!
    g.computeBoundingBox()
    const b = g.boundingBox!
    return { w: b.max.x - b.min.x, l: b.max.y - b.min.y, top: b.max.z }
  }

  it("keeps the KiCad footprint's name on the land, and reads it again for a part placed before that", () => {
    const { built, spec } = placed("Regulator_Linear:AMS1117-3.3")
    expect(built.land?.package).toBe("SOT-223-3_TabPin2")
    expect(contextOf("Regulator_Linear:AMS1117-3.3").package).toBe("SOT-223-3_TabPin2")
    // A land without it: the part's own source names the footprint.
    expect(packageOf({ name: spec.footprint }, spec)).toBe("SOT-223-3_TabPin2")
    // A supplier part from before lands kept a package: the family its land's name starts with.
    const supplier = { source: { pins: "supplier", land: "supplier" } } as CustomPartSpec
    expect(packageOf({ name: "qfn24_c1234-1a2b3c" }, supplier)).toBe("qfn24")
    expect(packageOf({ name: "land_c1234-1a2b3c" }, supplier)).toBeUndefined()
    // The library's lands name no package.
    expect(packageOf({ name: "qfn24" }, undefined)).toBeUndefined()
  })

  it("keeps the package name through a saved project file", () => {
    const { project } = placed("Regulator_Linear:AMS1117-3.3")
    const again = parseProjectFile(serializeProject(project), { id: "p", createdAt: 0, updatedAt: 0 })
    expect(again.footprints?.[0]?.package).toBe("SOT-223-3_TabPin2")
  })

  it("draws each part with the body of its package's name", () => {
    expect(picked("Regulator_Linear:AMS1117-3.3")).toBe("gullWing:name")
    expect(picked("Regulator_Linear:AP2112K-3.3")).toBe("gullWing:name")
    expect(picked("Diode:BAT54C")).toBe("gullWing:name")
    expect(picked("MCU_Microchip_ATmega:ATmega328P-A")).toBe("gullWing:name")
    expect(picked("MCU_ST_STM32F1:STM32F103C_8-B_Tx")).toBe("gullWing:name")
    expect(picked("Interface_USB:CH340G")).toBe("gullWing:name")
    expect(picked("Analog_ADC:ADS1015IDGS")).toBe("gullWing:name")
    expect(picked("MCU_Microchip_ATtiny:ATtiny25V-10P")).toBe("dip:name")
    expect(picked("MCU_RaspberryPi:RP2040")).toBe("noLead:name")
    expect(picked("Regulator_Switching:TPS61040DRV")).toBe("noLead:name")
    expect(picked("Sensor_Humidity:SHT31-DIS")).toBe("noLead:name")
    expect(picked("Sensor:BME280")).toBe("gridPackage:name")
  })

  it("takes the body's size from the name, with an exposed pad as a plate and not a lead", () => {
    const qfn = body("MCU_RaspberryPi:RP2040")
    expect(qfn.w).toBeCloseTo(7, 2)
    expect(qfn.l).toBeCloseTo(7, 2)
    const lga = body("Sensor:BME280")
    expect(lga.w).toBeCloseTo(2.5, 2)
    expect(lga.l).toBeCloseTo(2.5, 2)
    const tqfp = body("MCU_Microchip_ATmega:ATmega328P-A")
    expect(tqfp.w).toBeCloseTo(7, 2)
    expect(tqfp.l).toBeCloseTo(7, 2)
    const soic = body("Interface_USB:CH340G")
    expect(soic.w).toBeCloseTo(3.9, 2)
    expect(soic.l).toBeCloseTo(9.9, 2)
  })

  it("draws a wide SOIC about 2.65 mm tall, and a narrow one 1.45 mm", () => {
    const wide = body("Interface_CAN_LIN:MCP2515-xSO")
    expect(wide.w).toBeCloseTo(7.5, 2)
    expect(wide.l).toBeCloseTo(11.6, 2)
    expect(wide.top).toBeGreaterThan(2.6)
    expect(wide.top).toBeLessThan(2.9)
    const narrow = body("Amplifier_Operational:NCS2325D")
    expect(narrow.top).toBeGreaterThan(1.4)
    expect(narrow.top).toBeLessThan(1.7)
  })

  it("leaves a package it can't read to the footprint's rules, as before", () => {
    // An ESP32 module and a connector have no plan: they draw as they did without a package name.
    for (const key of ["RF_Module:ESP32-WROOM-32", "Connector:CUI_PD-30S"]) {
      const ctx = contextOf(key)
      expect(translatePackage(ctx.package ?? "")).toBeNull()
      const named = pickModel(ctx)
      const without = pickModel({ ...ctx, package: undefined })
      expect(named.source).toBe("footprint")
      expect([...named.builder.build().geoms.keys()]).toEqual([...without.builder.build().geoms.keys()])
    }
  })

  it("draws a plan the pads can't carry out as the footprint's rules would", () => {
    // A resistor's name on a many-pad land: the chip builder declines and nothing is half-drawn.
    const ctx = contextOf("MCU_RaspberryPi:RP2040")
    expect(pickModel({ ...ctx, package: "R_0603_1608Metric" }).source).toBe("footprint")
  })
})
