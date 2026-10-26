import type { ModelContext } from "./index"
import { gridPackage } from "./extra"
import { jst, pinHeader, socket } from "./connectors"
import type { Builder } from "./kit"
import { acrossAlong, chip, chipSizeFor, diodeSize, gullSpec, gullWing, moldedDiode, noLead, padLayout, sizeOnXY, splitExposed, type GullSpec } from "./smd"
import { dip, to220, to92 } from "./tht"
import type { ModelPlan } from "./translate"

// Plans (what a package's name settles) to the builders that draw them. A plan the part can't
// carry out (a gull-wing plan on a part with two pads) is declined with null, and the caller goes
// on to the footprint's own rules.

/**
 * SOIC bodies by their width across the leads: 3.9 mm (150 mil, 1.75 mm tall at most), 5.3 mm
 * (208 mil, EIAJ: 2.16 at most) and 7.5 mm (300 mil, SOIC-16W and 28W: JEDEC MS-013's 2.65 at
 * most). The heights here are the whole package, standoff included.
 */
const WIDE_SOIC = 6.5
const MID_SOIC = 4.6

/**
 * The gull-wing spec for a plan: the style's own, with the sizes the name stated over it. The
 * layout is the leads' alone: an exposed pad is not a lead and must not turn two rows into four sides.
 */
function gullFor(plan: Extract<ModelPlan, { family: "gullWing" }>, layout: NonNullable<ReturnType<typeof padLayout>>, pins: number): GullSpec | null {
  const spec = gullSpec(plan.style, layout)
  if (!spec) return null
  const body = plan.body
  if (!body) {
    // A SOT-23 with five or more pins is 1.6 mm wide, not the 1.3 mm of the three-pin one.
    if (plan.style === "sot23" && pins >= 5 && layout.kind !== "quad") return { ...spec, B: 0.8, L: 1.45 }
    return wideSoic(plan, spec)
  }
  if (layout.kind === "quad") {
    const spanX = Math.max(...layout.sides.filter((s) => s.key.endsWith("y")).map((s) => s.rowHalf), 0)
    const spanY = Math.max(...layout.sides.filter((s) => s.key.endsWith("x")).map((s) => s.rowHalf), 0)
    const [sx, sy] = sizeOnXY(body, spanX >= spanY)
    return { ...spec, Q: [sx / 2, sy / 2] }
  }
  const { across, along } = acrossAlong(layout, body)
  return wideSoic(plan, { ...spec, B: across / 2, L: along / 2 })
}

function wideSoic(plan: Extract<ModelPlan, { family: "gullWing" }>, spec: GullSpec): GullSpec {
  if (plan.style !== "soic" || spec.B === undefined) return spec
  const width = spec.B * 2
  if (width > WIDE_SOIC) return { ...spec, H: 2.65 - spec.standoff }
  if (width > MID_SOIC) return { ...spec, H: 2.05 - spec.standoff }
  return spec
}

export function buildPlan(source: ModelContext, plan: ModelPlan): Builder | null {
  // A project part's `body3d` is its category's default (1.4 mm for a chip, 5 for a connector),
  // not a measured height, so the builders get none and draw the package's own.
  const ctx: ModelContext = { ...source, part: { ...source.part, body3d: undefined } }
  const pads = ctx.pads
  switch (plan.family) {
    case "chip":
      return pads.length === 2 ? chip(ctx, { size: chipSizeFor(plan.l, plan.w), role: plan.role, cathodeFirst: plan.cathodeFirst }) : null
    case "moldedDiode": {
      const size = diodeSize(plan.style)
      return size && pads.length >= 2 && pads.length <= 3 ? moldedDiode(ctx, size, plan.cathodeFirst) : null
    }
    case "gullWing": {
      const { leads, exposed } = splitExposed(pads)
      const layout = padLayout(leads)
      if (!layout) return null
      const spec = gullFor(plan, layout, leads.length)
      return spec ? gullWing({ ...ctx, pads: leads }, layout, spec, exposed) : null
    }
    case "noLead": {
      const { leads, exposed } = splitExposed(pads)
      const layout = padLayout(leads)
      return layout ? noLead({ ...ctx, pads: leads }, layout, plan.body, exposed) : null
    }
    case "gridPackage":
      return pads.length >= 4 ? gridPackage(ctx, plan.body, plan.balls) : null
    case "dip":
      return dip(ctx)
    case "to220":
      return pads.length >= 2 ? to220(ctx, plan.isolated) : null
    case "to92":
      return pads.length >= 2 ? to92(ctx) : null
    case "pinHeader":
      return plan.socket ? socket(ctx) : pinHeader(ctx)
    case "jst":
      return pads.length >= 2 ? jst(ctx, plan.series) : null
  }
}
