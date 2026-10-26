import * as THREE from "three"
import { beforeAll, describe, expect, it } from "vitest"
import { generatedModel } from "../src/editor/three/buildBoard"
import { ModelMaterials, pickModel, type ModelContext } from "../src/editor/three/models"
import { translatePackage } from "../src/editor/three/models/translate"
import { buildCustomPart } from "../src/model/customParts"
import { getFootprint, registerProjectFootprints } from "../src/model/footprints"
import { addDraftToProject, draftFromIndexPart } from "../src/model/indexPart"
import type { Imported } from "../src/model/kicad/library"
import { registerPart } from "../src/model/library"
import { modelAssignment, normalizeModels, setModel } from "../src/model/models3d"
import { createProject } from "../src/model/ops"
import { packageOf } from "../src/model/partPackage"
import { KICAD_MODEL_ID, KICAD_MODEL_PATH } from "../src/model/supplier"
import type { ComponentInstance, CustomPartSpec, PadDef, PartCategory } from "../src/model/types"
import { loadImported, storedPart } from "./index-part-support"

// Review findings on the generated bodies read from package names: what they draw for a part
// switched to another footprint, a project part's real sizes, a land turned on its side, SOIC and
// QFP heights, and the nits around them. Each is pinned through what the 3D view is given.

const MATS = new ModelMaterials()

let n = 0
/** What the 3D view is given for a project part (`customParts.ts`, so with its category's default `body3d`) on a footprint. */
function ctxOn(footprint: string, pkg: string | undefined, over: { category?: PartCategory; refPrefix?: string; description?: string; pads?: PadDef[] } = {}): ModelContext {
  const fp = getFootprint(footprint)
  const spec: CustomPartSpec = {
    id: `review_${n++}`,
    name: "TEST",
    category: over.category ?? "ICs",
    description: over.description ?? "A test part",
    refPrefix: over.refPrefix ?? "U",
    footprint,
    pins: fp.pads.map((p) => ({ number: p.pin ?? "1", name: `P${p.pin}` })),
    props: { mpn: "TEST1" },
    valueProp: "mpn",
  }
  const part = buildCustomPart(spec)
  const component: ComponentInstance = { id: "c1", partId: part.id, ref: "U1", props: { ...part.defaultProps }, footprint, sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true } }
  return { component, part, footprint, package: pkg, pads: over.pads ?? fp.pads.filter((p) => p.plated !== false), courtyard: fp.courtyard, boardThickness: 1.6, materials: MATS }
}

function box(g: THREE.BufferGeometry) {
  g.computeBoundingBox()
  return g.boundingBox!
}

/** One material's piece of a model: its extent on x and y and its top. */
function piece(ctx: ModelContext, key: string) {
  const g = pickModel(ctx).builder.build().geoms.get(key)
  if (!g) throw new Error(`no ${key} piece`)
  const b = box(g)
  return { w: b.max.x - b.min.x, l: b.max.y - b.min.y, top: b.max.z, bottom: b.min.z }
}

const keysOf = (ctx: ModelContext) => [...pickModel(ctx).builder.build().geoms.keys()]

describe("a KiCad part switched to another footprint", () => {
  let imported: Imported
  beforeAll(async () => {
    imported = await loadImported()
  })

  it("keeps the old package's body off the new pads, in the view", () => {
    const built = draftFromIndexPart(storedPart(imported, "Amplifier_Operational:NCS2325D"))
    if ("error" in built) throw new Error(built.error)
    const added = addDraftToProject(createProject("x"), built)
    if ("error" in added) throw new Error(added.error)
    const { project, spec } = added
    registerPart(buildCustomPart(spec))
    const at = (footprint: string): ComponentInstance => ({ id: "c1", partId: spec.id, ref: "U1", props: {}, footprint, sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true } })
    const top = (footprint: string) => new THREE.Box3().setFromObject(generatedModel(project, at(footprint), MATS)!).max.z
    // On its own land: the SOIC's body, 1.5 mm tall.
    expect(top(spec.footprint)).toBeLessThan(1.8)
    // On a DIP-8: the footprint rules' DIP, 3 mm or more.
    expect(packageOf(getFootprint("dip8"), spec)).toBeUndefined()
    expect(top("dip8")).toBeGreaterThan(3)
  })
})

describe("project parts have no measured body height", () => {
  it("draws a pin socket 8.5 mm tall whatever category the part is in", () => {
    for (const category of ["ICs", "Connectors", "Power"] as const) {
      const ctx = ctxOn("pinrow4", "PinSocket_1x04_P2.54mm_Vertical", { category, refPrefix: "J" })
      expect(piece(ctx, "plasticBlack").top).toBeCloseTo(8.5, 1)
    }
  })

  it("draws a pin header's plastic 2.5 mm and a JST XH 7.0 mm", () => {
    const header = ctxOn("pinrow4", "PinHeader_1x04_P2.54mm_Vertical", { category: "Connectors", refPrefix: "J" })
    expect(piece(header, "plasticBlack").top).toBeCloseTo(2.5, 1)
    const xh = ctxOn("pinrow2", "JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical", { category: "Connectors", refPrefix: "J" })
    expect(piece(xh, "cream").top).toBeCloseTo(7, 1)
  })

  it("gives a chip LED the LED's own colour, not its category's near black", () => {
    const keys = keysOf(ctxOn("0805", "LED_0805_2012Metric", { category: "Diodes", refPrefix: "D" }))
    expect(keys).toContain("glow:#ff3b30")
    expect(keys.some((k) => k.includes("#1c1c1f"))).toBe(false)
  })
})

describe("through-hole transistors and regulators", () => {
  it("leaves a horizontal TO-92 to the footprint rules, which are not a standing body", () => {
    expect(translatePackage("TO-92_Horizontal1")).toBeNull()
    expect(translatePackage("TO-92_Inline_Horizontal2")).toBeNull()
    expect(translatePackage("TO-92_Inline")).toEqual({ family: "to92" })
  })

  it("draws a TO-220F with no metal tab", () => {
    expect(translatePackage("TO-220F-3_Vertical")).toEqual({ family: "to220", isolated: true })
    expect(keysOf(ctxOn("to220", "TO-220F-3_Vertical"))).not.toContain("brushed")
    expect(keysOf(ctxOn("to220", "TO-220-3_Vertical"))).toContain("brushed")
  })

  it("turns the body to a row of pads along y, so it never crosses the row", () => {
    for (const [footprint, pkg] of [["to220", "TO-220-3_Vertical"], ["to92", "TO-92_Inline"]] as const) {
      const flat = ctxOn(footprint, pkg)
      // The same land turned a quarter: the row now runs along y.
      const turned = { ...flat, pads: flat.pads.map((p) => ({ ...p, x: -p.y, y: p.x })), courtyard: { minX: -4, maxX: 4, minY: -4, maxY: 4 } }
      const a = piece(flat, "epoxy")
      const b = piece(turned, "epoxy")
      const row = (ctx: ModelContext, axis: "x" | "y") => Math.max(...ctx.pads.map((p) => p[axis])) - Math.min(...ctx.pads.map((p) => p[axis]))
      expect(row(flat, "x")).toBeGreaterThan(row(flat, "y"))
      expect(row(turned, "y")).toBeGreaterThan(row(turned, "x"))
      // What was wide along the row is long along y now.
      expect(b.w).toBeCloseTo(a.l, 1)
      expect(b.l).toBeCloseTo(a.w, 1)
    }
  })
})

describe("SOIC and QFP heights", () => {
  it("draws the 7.5 mm SOIC at JEDEC MS-013's 2.65 mm, standoff included", () => {
    expect(piece(ctxOn("soic16", "SOIC-16W_7.5x10.3mm_P1.27mm"), "epoxy").top).toBeCloseTo(2.65, 2)
  })

  it("draws a 5.3 mm (208 mil) SOIC no taller than its 2.16 mm, and the 3.9 mm one as before", () => {
    for (const name of ["SOIC-8_5.3x5.3mm_P1.27mm", "SOP-8_5.28x5.23mm_P1.27mm", "SOIC-16W_5.3x10.2mm_P1.27mm"]) {
      const top = piece(ctxOn(name.startsWith("SOIC-16") ? "soic16" : "soic8", name), "epoxy").top
      expect(top).toBeGreaterThan(1.8)
      expect(top).toBeLessThanOrEqual(2.16)
    }
    expect(piece(ctxOn("soic8", "SOIC-8_3.9x4.9mm_P1.27mm"), "epoxy").top).toBeLessThan(1.7)
  })

  it("gives a plain, plastic or metric QFP its own height, taller than a TQFP or LQFP", () => {
    expect(translatePackage("TQFP-44_10x10mm_P0.8mm")).toMatchObject({ style: "tqfp" })
    expect(translatePackage("LQFP-48_7x7mm_P0.5mm")).toMatchObject({ style: "lqfp" })
    for (const name of ["QFP-44_10x10mm_P0.8mm", "PQFP-44_10x10mm_P0.8mm", "MQFP-44_10x10mm_P0.8mm"]) expect(translatePackage(name)).toMatchObject({ style: "pqfp" })
    const top = (name: string) => piece(ctxOn("tqfp44", name), "epoxy").top
    expect(top("TQFP-44_10x10mm_P0.8mm")).toBeLessThan(1.3)
    expect(top("PQFP-44_10x10mm_P0.8mm")).toBeGreaterThanOrEqual(2)
  })
})

describe("packages that look like a family and are not", () => {
  it("leaves PowerPAK's SO-8 and SC-70 to the footprint rules", () => {
    expect(translatePackage("PowerPAK_SO-8_Single")).toBeNull()
    expect(translatePackage("PowerPAK_SC70-6_Single")).toBeNull()
    expect(translatePackage("SOIC-8_3.9x4.9mm_P1.27mm")).toMatchObject({ family: "gullWing", style: "soic" })
  })

  it("draws SOT-416, -523 and -723 0.8 mm wide, narrower than an SC-70", () => {
    for (const name of ["SOT-416", "SOT-523", "SOT-723"]) expect(translatePackage(name)).toMatchObject({ style: "sot523" })
    const across = (name: string) => {
      const p = piece(ctxOn("sot323", name), "epoxy")
      return Math.min(p.w, p.l)
    }
    expect(across("SOT-523")).toBeCloseTo(0.8, 1)
    expect(across("SC-70-6")).toBeGreaterThan(1.1)
  })

  it("draws a JST EH housing shallower than an XH's", () => {
    expect(translatePackage("JST_EH_B2B-EH-A_1x02_P2.50mm_Vertical")).toEqual({ family: "jst", series: "eh" })
    const depth = (name: string) => piece(ctxOn("pinrow2", name, { category: "Connectors", refPrefix: "J" }), "cream").l
    expect(depth("JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical") - depth("JST_EH_B2B-EH-A_1x02_P2.50mm_Vertical")).toBeGreaterThan(1.5)
  })

  it("reads a bare chip code's role from the part's category or description, not as a capacitor", () => {
    expect(translatePackage("0603", { refPrefix: "X", text: "100k Ohm 1% 0603 Chip Resistor Passives" })).toMatchObject({ role: "resistor" })
    expect(translatePackage("0603", { refPrefix: "X", text: "Ferrite bead 0603 Passives" })).toMatchObject({ role: "inductor" })
    expect(translatePackage("0603", { refPrefix: "X", text: "SS14 Schottky 0603 Diodes" })).toMatchObject({ role: "diode" })
    expect(translatePackage("0603", { refPrefix: "C" })).toMatchObject({ role: "capacitor" })
    expect(translatePackage("0603", { refPrefix: "X", text: "10uF 0603 Passives" })).toMatchObject({ role: "capacitor" })
  })

  it("reads a grid package's size as KiCad gives it, x then y, whichever way the pads spread", () => {
    // Eight columns of pads by four rows: wider than tall, in a name that says 6 x 8.
    const pads: PadDef[] = []
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) pads.push({ pin: `${j * 8 + i + 1}`, x: (i - 3.5) * 0.5, y: (j - 1.5) * 0.5, width: 0.3, height: 0.3, shape: "circle", layer: "top" })
    const ctx = { ...ctxOn("0603", "BGA-32_6x8mm_Layout8x4_P0.5mm"), pads }
    const body = piece(ctx, "epoxy")
    expect(body.w).toBeCloseTo(6, 2)
    expect(body.l).toBeCloseTo(8, 2)
  })
})

describe("old supplier land names through the 3D view's own path", () => {
  for (const [family, top] of [["sot89", 1.6], ["to252", 2.4], ["to263", 4.55]] as const) {
    it(`${family}_c...: the package's name draws a gull-wing body of its height`, () => {
      const fp = getFootprint(family)
      expect(fp.pads.length).toBeGreaterThan(0)
      const land = { ...fp, name: `${family}_c1234-1a2b3c` }
      registerProjectFootprints({ footprints: [land] })
      const spec = { source: { pins: "supplier", land: "supplier" }, footprint: land.name } as CustomPartSpec
      expect(packageOf(getFootprint(land.name), spec)).toBe(family)
      const ctx = { ...ctxOn(family, family), footprint: land.name, pads: land.pads }
      const picked = pickModel(ctx)
      expect(picked.source).toBe("name")
      const built = picked.builder.build()
      expect(box(built.geoms.get("epoxy")!).max.z).toBeCloseTo(top, 0)
      expect(built.geoms.has("tin")).toBe(true)
    })
  }
})

describe("choosing the generated body again", () => {
  let imported: Imported
  beforeAll(async () => {
    imported = await loadImported()
  })

  it("is not undone by placing the same database part again", () => {
    const stored = storedPart(imported, "Regulator_Linear:AMS1117-3.3")
    stored.model3d = { source: "kicad", id: "10.0.7/Package_TO_SOT_SMD.3dshapes/SOT-223.step", name: "SOT-223", offset: { x: 0, y: 0, z: 0 }, rotate: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    const built = draftFromIndexPart(stored)
    if ("error" in built) throw new Error(built.error)
    const first = addDraftToProject(createProject("x"), built)
    if ("error" in first) throw new Error(first.error)
    expect(first.added).toBe(true)
    expect(modelAssignment(first.project, first.spec.id, first.spec.footprint)).not.toBeNull()
    // "Use the generated body".
    const chosen = setModel(first.project, first.spec.id, first.spec.footprint, null)
    expect(modelAssignment(chosen, first.spec.id, first.spec.footprint)).toBeNull()
    const again = addDraftToProject(chosen, built)
    if ("error" in again) throw new Error(again.error)
    expect(again.added).toBe(false)
    expect(modelAssignment(again.project, first.spec.id, first.spec.footprint)).toBeNull()
  })
})

describe("one rule for a KiCad model's name", () => {
  const release = "10.0.7"
  const ids = [
    `${release}/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step`,
    `${release}/TerminalBlock_Phoenix.3dshapes/TerminalBlock_Phoenix_MKDS-1,5-2-5.08_1x02_P5.08mm_Horizontal.step`,
    `${release}/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.STEP`,
    `${release}/Package_SO.3dshapes/a.stp`,
  ]
  const refused = [
    `${release}/Package_SO.3dshapes/a b.step`,
    `${release}/Package_SO.3dshapes/../x.step`,
    `${release}/.3dshapes/a.step`,
    `${release}/A.3dshapes/sub/a.step`,
    `${release}/A.3dshapes/a.wrl`,
    `${release}/Package_SO.3dshapes/.hidden.step`,
  ]
  const pathOf = (id: string) => id.slice(id.indexOf("/") + 1)

  it("accepts and refuses the same ids in the editor's reading and the route's path check", () => {
    for (const id of ids) {
      expect(KICAD_MODEL_ID.test(id), id).toBe(true)
      expect(KICAD_MODEL_PATH.test(pathOf(id)), id).toBe(true)
    }
    for (const id of refused) {
      expect(KICAD_MODEL_ID.test(id), id).toBe(false)
      expect(KICAD_MODEL_PATH.test(pathOf(id)), id).toBe(false)
    }
    expect(KICAD_MODEL_ID.test("10.0/A.3dshapes/a.step")).toBe(false)
  })

  it("keeps an assignment whose name has a comma or an upper-case extension, and drops a refused one", () => {
    const model = (id: string) => ({ source: "kicad", id, name: "x", format: "step", origin: "model", offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } })
    for (const id of [ids[1], ids[2]]) expect(normalizeModels([{ part: "p", footprint: "f", model: model(id) }])).toHaveLength(1)
    expect(normalizeModels([{ part: "p", footprint: "f", model: model(refused[0]) }])).toHaveLength(0)
  })
})
