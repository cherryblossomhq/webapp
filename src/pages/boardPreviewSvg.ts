import { resolvedComponents } from "../model/ruleAreas"
import { DEFAULT_MASK_COLOR, boardColors, boardFinish, boardTextStrokes, boardTextStrokeWidth, finishMetal, mountingHoles, ownTexts } from "../model/board"
import type { SchematicConnectivity } from "../model/connectivity"
import { isNpth, pcbCourtyard, pcbPads, pcbSilk, slotEnds, type WorldPad } from "../model/instances"
import { onBoard } from "../model/partFlags"
import { analyzePcb } from "../model/pcb"
import type { ZoneFill } from "../model/pour"
import { pathsSvgPath } from "../model/shapes"
import type { Project } from "../model/types"

/**
 * The bare board as a fab would ship it, top view, as the text of an SVG file: copper under the mask
 * shows lighter, pads are plated, silkscreen on top, part bodies hinted with soft shadows.
 *
 * A string and not React elements so a worker can draw it (`preview.worker.ts`): a projects page shows a
 * preview per project, and building thousands of pads, traces and pour edges as live elements, with the
 * pour fill before them, held the page's thread for seconds on a list with a big board in it.
 * The page shows the string as an image, which the browser draws once.
 */

/** Parts, tracks and vias past which a board's preview fills none of its zones itself. */
const PREVIEW_FILL_ITEMS = 3000

/**
 * The pour fills a preview draws: on a small board every zone filled, as the editor fills them; on a big one only the fills kept already
 * (KiCad's own), filling no zone that has none. The 47 zones of a 2,970-part board took minutes to fill, and the worker draws one preview
 * at a time, so one such board would hold up every card after it; the editor fills them in its own worker once the project is open.
 */
export function previewFills(p: Project, connectivity: SchematicConnectivity): ZoneFill[] {
  const big = p.components.length + p.traces.length + p.vias.length > PREVIEW_FILL_ITEMS
  return analyzePcb(p, connectivity, { ...(big ? { reuseOnly: { stale: [] } } : {}), fillsOnly: true }).zoneFills
}

/** Mix two hex colours; t = 0 gives a, 1 gives b. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`
}

/** A colour from the project file, or the default when it isn't a plain hex colour (it is written into markup). */
const hex = (c: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : fallback)

/** Millimetres to a thousandth: enough for a thumbnail, and a third of the text. */
const n = (v: number) => String(Math.round(v * 1000) / 1000)
const pts = (ps: readonly { x: number; y: number }[]) => ps.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")

function padElement(pad: WorldPad, fill: string): string {
  if (pad.shape === "circle") return `<circle cx="${n(pad.x)}" cy="${n(pad.y)}" r="${n(pad.width / 2)}" fill="${fill}"/>`
  if (pad.rings && pad.rings.length > 1)
    return `<path d="${pad.rings.map((ring) => `M${ring.map((p) => `${n(p.x)},${n(p.y)}`).join("L")}Z`).join("")}" fill-rule="evenodd" fill="${fill}"/>`
  if (pad.shape === "polygon" && pad.points) return `<polygon points="${pts(pad.points)}" fill="${fill}"/>`
  const rx = pad.shape === "pill" ? Math.min(pad.width, pad.height) / 2 : pad.x7 ? (pad.corner ?? 0) : Math.min(pad.width, pad.height) * 0.12
  return `<rect x="${n(pad.x - pad.width / 2)}" y="${n(pad.y - pad.height / 2)}" width="${n(pad.width)}" height="${n(pad.height)}" rx="${n(rx)}" fill="${fill}"/>`
}

export function boardPreviewSvg(project: Project, fills: ZoneFill[]): string {
  const b = project.board
  const colors = boardColors(b)
  const mask = hex(colors.mask, DEFAULT_MASK_COLOR)
  const silk = hex(colors.silk, "#ffffff")
  const metal = { gold: "#e1bd62", tin: "#cfd2d6", copper: "#d99a6c" }[finishMetal(boardFinish(b))]
  const copperTone = mix(mask, "#e8b04a", 0.22)
  const drilled = "#141217"
  const parts = resolvedComponents(project).filter((c) => c.pcb.placed && onBoard(c))
  const topPads = parts.flatMap((c) => pcbPads(c).filter((p) => p.layers.includes("top")))
  const pourD = fills
    .filter((f) => f.layer === "top")
    .flatMap((f) => f.polygons.flatMap((poly) => poly.map((ring) => `M${ring.map((p) => `${n(p.x)},${n(p.y)}`).join("L")}Z`)))
    .join("")
  const outlineD = b.outline?.paths.length ? pathsSvgPath(b.outline.paths.filter((p) => p.closed)) : ""
  const minX = b.x - b.width / 2
  const minY = b.y - b.height / 2
  const pad = Math.max(b.width, b.height) * 0.06
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX - pad)} ${n(-(minY + b.height) - pad)} ${n(b.width + pad * 2)} ${n(b.height + pad * 2)}">`,
    `<defs><filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${n(Math.max(b.width, b.height) * 0.006)}"/></filter></defs>`,
    `<g transform="scale(1,-1)">`,
  )
  if (outlineD) {
    out.push(
      `<path d="${outlineD}" transform="translate(${n(pad * 0.12)} ${n(-pad * 0.18)})" fill="#000" fill-rule="evenodd" opacity="0.28" filter="url(#soft)"/>`,
      `<path d="${outlineD}" fill="${mask}" fill-rule="evenodd"/>`,
    )
  } else {
    out.push(
      `<rect x="${n(minX + pad * 0.12)}" y="${n(minY - pad * 0.18)}" width="${n(b.width)}" height="${n(b.height)}" rx="${n(b.cornerRadius)}" fill="#000" opacity="0.28" filter="url(#soft)"/>`,
      `<rect x="${n(minX)}" y="${n(minY)}" width="${n(b.width)}" height="${n(b.height)}" rx="${n(b.cornerRadius)}" fill="${mask}"/>`,
    )
  }
  if (pourD) out.push(`<path d="${pourD}" fill="${copperTone}" fill-rule="evenodd"/>`)
  out.push(`<g fill="none" stroke="${copperTone}" stroke-linecap="round" stroke-linejoin="round">`)
  for (const t of project.traces) if (t.layer === "top") out.push(`<polyline points="${pts(t.points)}" stroke-width="${n(t.width)}"/>`)
  out.push(`</g>`)
  for (const v of project.vias) out.push(`<circle cx="${n(v.x)}" cy="${n(v.y)}" r="${n(v.diameter / 2)}" fill="${copperTone}"/>`)
  // Soft footprint shadows hint at where parts sit.
  out.push(`<g filter="url(#soft)" opacity="0.3">`)
  for (const c of parts) {
    const cy = pcbCourtyard(c)
    if (!cy || c.pcb.side !== "top") continue
    const inset = Math.min(cy.maxX - cy.minX, cy.maxY - cy.minY) * 0.18
    out.push(`<rect x="${n(cy.minX + inset)}" y="${n(cy.minY + inset)}" width="${n(cy.maxX - cy.minX - inset * 2)}" height="${n(cy.maxY - cy.minY - inset * 2)}" fill="#000"/>`)
  }
  out.push(`</g>`)
  // Non-plated holes have no copper; they only show as drilled holes below.
  for (const p of topPads) if (!isNpth(p)) out.push(padElement(p, metal))
  const holes = mountingHoles(b)
  for (const h of holes) out.push(`<circle cx="${n(h.x)}" cy="${n(h.y)}" r="${n(h.diameter / 2)}" fill="${metal}"/>`)
  for (const p of topPads) {
    if (!p.holeDiameter) continue
    const ends = slotEnds(p)
    if (!ends) {
      const at = p.hole ?? p
      out.push(`<circle cx="${n(at.x)}" cy="${n(at.y)}" r="${n(p.holeDiameter / 2)}" fill="${drilled}"/>`)
    } else {
      const [a, z] = ends
      out.push(`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(z.x)}" y2="${n(z.y)}" stroke="${drilled}" stroke-width="${n(p.holeDiameter)}" stroke-linecap="round"/>`)
    }
  }
  for (const h of holes) out.push(`<circle cx="${n(h.x)}" cy="${n(h.y)}" r="${n(h.drill / 2)}" fill="${drilled}"/>`)
  const viaHole = mix(mask, "#000000", 0.45)
  for (const v of project.vias) out.push(`<circle cx="${n(v.x)}" cy="${n(v.y)}" r="${n(v.drill / 2)}" fill="${viaHole}"/>`)
  out.push(`<g fill="none" stroke="${silk}" stroke-linecap="round" stroke-linejoin="round" opacity="0.92">`)
  for (const c of parts) if (c.pcb.side === "top") for (const path of pcbSilk(c)) out.push(`<polyline points="${pts(path)}" stroke-width="0.15"/>`)
  for (const t of ownTexts(project)) {
    if (t.side !== "top") continue
    const w = n(boardTextStrokeWidth(t))
    for (const path of boardTextStrokes(t)) out.push(`<polyline points="${pts(path)}" stroke-width="${w}"/>`)
  }
  out.push(`</g></g></svg>`)
  return out.join("")
}
