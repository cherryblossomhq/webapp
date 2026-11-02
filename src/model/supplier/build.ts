import type { SupplierLand, SupplierPin } from "@cherryblossom/api-contract"
import { emptyBox, expandBox, round } from "../../lib/geometry"
import { digest } from "../customParts"
import { getFootprint, isValidFootprint } from "../footprints"
import type { CustomPartSpec, FootprintDef, PadDef, PinSide } from "../types"
import { compareLands, type LandPad } from "./land"
import { kindForRole } from "./roles"

// A part built from a supplier's record: its pins, numbered and named as the supplier draws them,
// and its land pattern as the supplier's own copper.

/**
 * The footprinter family a supplier package belongs to, as a footprint-name prefix. The 3D view
 * picks a body from that prefix (gull-wing for `soic`, no-lead for `qfn`), so a supplier land
 * named `sot563_c1852149-...` gets a SOT-563 body rather than a box.
 */
export function packageFamily(pkg: string | null | undefined): string {
  const s = String(pkg ?? "").toUpperCase()
  const chip = s.match(/^(?:[A-Z]{0,3})?(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/)
  if (chip) return chip[1]
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^SOT-?563/, () => "sot563"],
    [/^SOT-?363|^SC-?70-6/, () => "sot363"],
    [/^SOT-?323|^SC-?70\b/, () => "sot323"],
    [/^SOT-?223/, () => "sot223"],
    [/^SOT-?89/, () => "sot89"],
    [/^T?SOT-?23-?(\d)/, (m) => `sot23_${m[1]}`],
    [/^SOT-?23/, () => "sot23"],
    [/^(?:H?TSSOP)-?(\d+)/, (m) => `tssop${m[1]}`],
    [/^(?:Q?SSOP)-?(\d+)/, (m) => `ssop${m[1]}`],
    [/^(?:V?SSOP|MSOP|TSSOP)-?(\d+)/, (m) => `vssop${m[1]}`],
    [/^(?:E?SOP|SOIC|SO|HSOP)-?(\d+)/, (m) => `soic${m[1]}`],
    [/^(?:[A-Z0-9]*QFN|LFCSP)-?(\d+)/, (m) => `qfn${m[1]}`],
    [/^(?:[A-Z]*DFN|[A-Z]*SON)-?(\d+)/, (m) => `dfn${m[1]}`],
    [/^(?:[LT]?QFP)-?(\d+)/, (m) => `lqfp${m[1]}`],
    [/^DIP-?(\d+)/, (m) => `dip${m[1]}`],
    [/^(?:SOD-?(\d+))/, (m) => `sod${m[1]}`],
    [/^SM([ABC])(?![A-Z0-9])|^DO-?214/, (m) => `sm${(m[1] ?? "a").toLowerCase()}`],
  ]
  for (const [re, name] of rules) {
    const m = s.match(re)
    if (m) return name(m)
  }
  return "land"
}

/** Pads in the form `compareLands` reads. */
export const landPads = (pads: PadDef[]): LandPad[] =>
  pads.map((p) => ({ number: p.pin, x: p.x, y: p.y, width: p.width, height: p.height, through: p.layer === "through" }))

/**
 * What a land is built from: a supplier part, or a part the parts index stores. `lcsc` names the
 * land pattern (an LCSC number, or the stored part's own key), so two parts never share a land name.
 */
export interface LandedPart {
  land: SupplierLand | null
  package: string | null
  lcsc: string
}

export const supplierLandPads = (part: Pick<LandedPart, "land">): LandPad[] =>
  (part.land?.pads ?? []).map((p) => ({ number: p.number || null, x: p.x, y: p.y, width: p.width, height: p.height, through: p.layer === "through" }))

/** The supplier's land as a project land pattern; its name ends in a hash of the pattern. */
export function supplierFootprint(part: LandedPart): FootprintDef | null {
  const land = part.land
  if (!land?.pads.length) return null
  const pads: PadDef[] = land.pads.map((p) => {
    const through = p.layer === "through" || (p.holeDiameter ?? 0) > 0
    const shape: PadDef["shape"] = p.shape === "oval" ? "pill" : p.shape === "polygon" && p.points?.length ? "polygon" : p.shape === "circle" ? "circle" : "rect"
    return {
      pin: p.plated === false ? null : p.number || null,
      shape,
      x: round(p.x),
      y: round(p.y),
      width: round(p.width),
      height: round(p.height),
      ...(shape === "polygon" && p.points ? { points: p.points.map((q) => ({ x: round(q.x), y: round(q.y) })) } : {}),
      ...(through ? { holeDiameter: round(p.holeDiameter ?? Math.min(p.width, p.height) / 2) } : {}),
      ...(p.slotLength ? { slotLength: round(p.slotLength) } : {}),
      layer: through ? "through" : "top",
      ...(p.plated === false ? { plated: false as const } : {}),
      ...(p.exposed ? { exposed: true as const } : {}),
    }
  })
  const silk = land.silk.filter((l) => l.length >= 2).map((l) => l.map((q) => ({ x: round(q.x), y: round(q.y) })))
  const b = emptyBox()
  for (const p of pads) {
    expandBox(b, { x: p.x - p.width / 2, y: p.y - p.height / 2 })
    expandBox(b, { x: p.x + p.width / 2, y: p.y + p.height / 2 })
  }
  for (const line of silk) for (const q of line) expandBox(b, q)
  // The source's own courtyard when it draws one (KiCad does); else the copper's bounds and a margin.
  const courtyard = land.courtyard ?? { minX: round(b.minX - 0.25), minY: round(b.minY - 0.25), maxX: round(b.maxX + 0.25), maxY: round(b.maxY + 0.25) }
  const body = { pads, silk, courtyard }
  const name = `${packageFamily(part.package)}_${part.lcsc.toLowerCase()}-${digest(JSON.stringify(body))}`
  return { name, ...body }
}

/**
 * The land a supplier part goes on: the footprinter's chip footprint when it draws the supplier's
 * pads (a resistor-sized part keeps a real chip body in 3D and can be swapped like any 0603),
 * else the supplier's own copper.
 */
export function landForSupplierPart(part: LandedPart): { footprint: string; def: FootprintDef | null; matched: boolean } | null {
  const family = packageFamily(part.package)
  const vendor = supplierLandPads(part)
  if (/^(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)$/.test(family) && vendor.length === 2 && isValidFootprint(family)) {
    if (compareLands(landPads(getFootprint(family).pads), vendor).ok) return { footprint: family, def: null, matched: true }
  }
  const def = supplierFootprint(part)
  return def ? { footprint: def.name, def, matched: false } : null
}

type Hint = { number: string; name: string; kind?: CustomPartSpec["pins"][number]["kind"]; side?: PinSide }

/**
 * The supplier's pins as a project part's. Kinds come from each pin's role, so supplies sit on top
 * of the box and grounds below; a hint at the same number (the copilot's own pin list, when it
 * agreed) keeps its side and its input/output kind for signals.
 */
export function supplierPins(pins: SupplierPin[], hints: Hint[] = []): CustomPartSpec["pins"] {
  const hintAt = new Map(hints.map((h) => [h.number, h]))
  return pins.map((p) => {
    const hint = hintAt.get(p.number)
    const kind = kindForRole(p.role) ?? (hint?.kind && ["input", "output", "io", "passive"].includes(hint.kind) ? hint.kind : undefined)
    return { number: p.number, name: p.name, ...(kind && { kind }), ...(hint?.side && { side: hint.side }) }
  })
}
