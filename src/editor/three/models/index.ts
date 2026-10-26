import * as THREE from "three"
import type { Box } from "../../../lib/geometry"
import type { ComponentInstance, PadDef, PartDef } from "../../../model/types"
import {
  barrelJack,
  buzzer,
  coinCell,
  dipSocket,
  generic,
  jst,
  jstSh,
  microSd,
  microUsbB,
  pinHeader,
  pluggableHeader,
  relay,
  screwTerminal,
  slideSwitch,
  socket,
  tactile,
  tl3342,
  usbC,
  ws2812b,
} from "./connectors"
import { isTransparentKey, markingTexture, material, type Builder, type MarkingSpec, type ModelSpec } from "./kit"
import { arduinoNano, esp32DevKit, esp32DevKitC, oled096, raspberryPiPico, smdWroom, wemosD1Mini, xiaoEsp32c3 } from "./modules"
import { buildPlan } from "./plan"
import { translatePackage, type PartHints } from "./translate"
import { chip, diodeSize, gullSpec, gullWing, isChip, moldedDiode, noLead, padLayout, smdElectrolytic, tantalum } from "./smd"
import { axial, ceramicDisc, dip, electrolytic, hc49, potentiometer, to220, to92 } from "./tht"

/**
 * Contract for procedural component models.
 *
 * Models are built in footprint-local millimetres: origin at the footprint origin, x/y as in
 * the footprint definition (y up, unrotated, unmirrored), z = 0 on the board's top surface
 * and +z away from the board. Through-hole leads may extend below z = 0 down to
 * -boardThickness - 1.5. The scene positions, rotates and flips the group for bottom-side parts.
 */
export interface ModelContext {
  component: ComponentInstance
  part: PartDef
  /** Footprinter string, e.g. "soic8", "0603", "pinrow4". */
  footprint: string
  /**
   * The package's own name where a source gave one (`SOIC-8_3.9x4.9mm_P1.27mm`) for the footprint
   * this component is on (`partPackage.ts` gives none once it is switched to another): the body it
   * names is drawn in preference to the footprint's rules. Library parts have none.
   */
  package?: string
  /** Footprint pads in local coordinates (pin = footprint pad number), non-plated holes excluded. */
  pads: PadDef[]
  /** Non-plated holes of the footprint, e.g. a module's mounting holes. */
  holes?: PadDef[]
  courtyard: Box
  boardThickness: number
  materials: ModelMaterials
}

/** Shared, cached materials and textures. Dispose once when the scene goes away. */
export class ModelMaterials {
  private cache = new Map<string, THREE.Material>()
  private textures = new Map<string, THREE.Texture>()

  get<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.cache.get(key)
    if (!m) {
      m = make()
      this.cache.set(key, m)
    }
    return m as T
  }

  texture(key: string, make: () => THREE.Texture): THREE.Texture {
    let t = this.textures.get(key)
    if (!t) {
      t = make()
      this.textures.set(key, t)
    }
    return t
  }

  dispose() {
    for (const m of this.cache.values()) m.dispose()
    for (const t of this.textures.values()) t.dispose()
    this.cache.clear()
    this.textures.clear()
  }
}

/** The footprint-name rules: the library's own footprints, and land names that start with a footprinter family. */
function byFootprint(ctx: ModelContext): Builder {
  const fp = ctx.footprint.toLowerCase()
  const id = ctx.part.id
  if (!ctx.pads.length) return generic(ctx)

  // Library footprints with a dedicated model.
  switch (fp) {
    case "esp32_devkit_v1":
      return esp32DevKit(ctx)
    case "oled096_i2c":
      return oled096(ctx)
    case "tl3342":
      return tl3342(ctx)
    case "eg1218":
      return slideSwitch(ctx)
    case "tantalum_3528":
      return tantalum(ctx)
    case "arduino_nano":
      return arduinoNano(ctx)
    case "esp32_devkitc":
      return esp32DevKitC(ctx)
    case "wemos_d1_mini":
      return wemosD1Mini(ctx)
    case "xiao_esp32c3":
      return xiaoEsp32c3(ctx)
    case "rpi_pico":
      return raspberryPiPico(ctx)
    case "esp32_wroom_32e":
      return smdWroom(ctx, "ESP32-WROOM-32E", 15.745)
    case "esp32_s3_wroom_1":
      return smdWroom(ctx, "ESP32-S3-WROOM-1", 12.75)
    case "usb_c_16p":
      return usbC(ctx)
    case "micro_usb_b":
      return microUsbB()
    case "barrel_jack_pj002a":
      return barrelJack(ctx)
    case "microsd_dm3at":
      return microSd(ctx)
    case "cr2032_holder":
      return coinCell()
    case "relay_srd":
      return relay(ctx)
    case "buzzer_12mm":
      return buzzer(ctx)
    case "ws2812b":
      return ws2812b(ctx)
    case "qwiic_jst_sh_4":
      return jstSh(ctx)
  }
  if (/^phoenix_(mc|mstba)_/.test(fp)) return pluggableHeader(ctx)
  if (id.startsWith("socket_dip")) return dipSocket(ctx)
  if (/^cap_elec_/.test(fp)) return smdElectrolytic(ctx)

  if (isChip(fp) && ctx.pads.length === 2) return chip(ctx)
  // Library diode land patterns (diode_sma, ...) share the footprinter packages' bodies.
  const diode = diodeSize(fp.replace(/^diode_/, ""))
  if (diode && ctx.pads.length === 2) return moldedDiode(ctx, diode)

  if (/^electrolytic/.test(fp)) {
    const m = fp.match(/_d(\d+(?:\.\d+)?)mm/)
    return electrolytic(ctx, m ? Number(m[1]) : undefined)
  }
  if (/^radial/.test(fp)) {
    if (id === "capacitor_polarized") return electrolytic(ctx, 5, 7)
    return ceramicDisc(ctx)
  }
  if (/^axial/.test(fp)) return axial(ctx)
  if (/^hc49/.test(fp)) return hc49(ctx)
  if (/^to220/.test(fp)) return to220(ctx)
  if (/^to92/.test(fp)) return to92(ctx)
  if (/^dip/.test(fp)) return dip(ctx) ?? generic(ctx)
  if (/^potentiometer/.test(fp) || id === "potentiometer") return potentiometer(ctx)
  if (/^pushbutton/.test(fp) || id === "pushbutton") return tactile(ctx)
  if (/^jst/.test(fp) || id === "battery") return jst(ctx)
  if (id.startsWith("screw_terminal") || /^terminal_block/.test(fp) || (/^pinrow/.test(fp) && /p5\.08/.test(fp))) return screwTerminal(ctx)
  if (/^pin_header/.test(fp)) return pinHeader(ctx)
  if (/^pinrow/.test(fp)) return /female/.test(fp) || id.endsWith("_f") ? socket(ctx) : pinHeader(ctx)

  const layout = padLayout(ctx.pads)
  if (layout) {
    if (/^(qfn|dfn|son|vson|quad)/.test(fp)) return noLead(ctx, layout)
    const spec = gullSpec(fp, layout)
    if (spec) return gullWing(ctx, layout, spec)
  }
  return generic(ctx)
}

/** The model chosen for a component: how it was chosen, the plan's family when a package name did, and the builder. */
export interface PickedModel {
  source: "name" | "footprint"
  family: string | null
  builder: Builder
}

const hintsOf = (ctx: ModelContext): PartHints => ({
  refPrefix: ctx.part.refPrefix,
  text: `${ctx.part.name} ${ctx.part.description} ${ctx.part.keywords?.join(" ") ?? ""} ${ctx.part.category}`,
})

/**
 * Choose the model for a component: the body its package's own name settles (`translate.ts`), when
 * the land came from a record and the name is one it knows and the part can carry out; else the
 * footprint's rules, which is how every part drew before packages were named and how the library's
 * parts (no package) still do.
 */
export function pickModel(ctx: ModelContext): PickedModel {
  if (ctx.pads.length && ctx.package) {
    const plan = translatePackage(ctx.package, hintsOf(ctx))
    if (plan) {
      try {
        const builder = buildPlan(ctx, plan)
        if (builder) return { source: "name", family: plan.family, builder }
      } catch {
        // A plan the pads can't carry out is declined like any other.
      }
    }
  }
  return { source: "footprint", family: null, builder: byFootprint(ctx) }
}

/** Pick a generator from the package's name, then the footprint string and the part. Exported for tests. */
export function makeBuilder(ctx: ModelContext): Builder {
  return pickModel(ctx).builder
}

// Geometry depends only on the footprint, part, its props and the board thickness, so it is
// built once per combination and cloned for each instance.
const specCache = new Map<string, ModelSpec>()
const SPEC_CACHE_LIMIT = 400

function specFor(ctx: ModelContext): ModelSpec {
  const props = Object.keys(ctx.component.props)
    .sort()
    .map((k) => `${k}=${ctx.component.props[k]}`)
    .join(",")
  const key = `${ctx.footprint}|${ctx.package ?? ""}|${ctx.part.id}|${ctx.boardThickness}|${props}`
  let spec = specCache.get(key)
  if (!spec) {
    let builder: Builder
    try {
      builder = makeBuilder(ctx)
    } catch {
      builder = generic(ctx)
    }
    spec = builder.build()
    if (specCache.size >= SPEC_CACHE_LIMIT) {
      for (const s of specCache.values()) for (const g of s.geoms.values()) g.dispose()
      specCache.clear()
    }
    specCache.set(key, spec)
  }
  return spec
}

function decal(m: MarkingSpec, mats: ModelMaterials): THREE.Mesh | null {
  const tex = markingTexture(mats, m.lines, m.width / m.height, m.color ?? "#a3a3a8", m.weight ?? 600)
  if (!tex) return null
  const mat = mats.get(`model:decal:${tex.uuid}`, () => {
    const material = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      roughness: 0.62,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    return material
  })
  const g = new THREE.PlaneGeometry(m.width, m.height)
  if (m.face === "front") g.rotateX(Math.PI / 2)
  if (m.rotZ) g.rotateZ(m.rotZ)
  g.translate(m.x, m.y, m.z)
  const mesh = new THREE.Mesh(g, mat)
  mesh.receiveShadow = true
  mesh.renderOrder = 1
  return mesh
}

/** Build the model for one component. Meshes cast and receive shadows. */
export function buildComponentModel(ctx: ModelContext): THREE.Group {
  const spec = specFor(ctx)
  const group = new THREE.Group()
  group.name = ctx.component.ref
  for (const [key, geom] of spec.geoms) {
    const mesh = new THREE.Mesh(geom.clone(), material(ctx.materials, key))
    mesh.castShadow = !isTransparentKey(key)
    mesh.receiveShadow = true
    if (isTransparentKey(key)) mesh.renderOrder = 2
    group.add(mesh)
  }
  for (const m of spec.markings) {
    const mesh = decal(m, ctx.materials)
    if (mesh) group.add(mesh)
  }
  return group
}
