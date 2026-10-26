import { fp } from "@tscircuit/footprinter"
import { emptyBox, expandBox, round } from "../lib/geometry"
import { libraryFootprint } from "./footprintLibrary"
import type { FootprintDef, PadDef, Project, Vec2 } from "./types"

const cache = new Map<string, FootprintDef>()

interface CjElement {
  type: string
  shape?: string
  x?: number
  y?: number
  width?: number
  height?: number
  radius?: number
  points?: Vec2[]
  port_hints?: string[]
  hole_diameter?: number
  outer_diameter?: number
  outer_width?: number
  outer_height?: number
  hole_width?: number
  rect_pad_width?: number
  rect_pad_height?: number
  route?: Vec2[]
  outline?: Vec2[]
  center?: Vec2
}

const pinFromHints = (hints?: string[]) => hints?.find((h) => /^\d+$/.test(h)) ?? null

function toPad(e: CjElement): PadDef | null {
  const pin = pinFromHints(e.port_hints)
  const x = e.x ?? 0
  const y = e.y ?? 0
  if (e.type === "pcb_smtpad") {
    if (e.shape === "circle") {
      const d = (e.radius ?? 0.5) * 2
      return { pin, shape: "circle", x, y, width: d, height: d, layer: "top" }
    }
    if (e.shape === "polygon" && e.points?.length) {
      const b = emptyBox()
      for (const p of e.points) expandBox(b, p)
      return {
        pin,
        shape: "polygon",
        x: round((b.minX + b.maxX) / 2),
        y: round((b.minY + b.maxY) / 2),
        width: round(b.maxX - b.minX),
        height: round(b.maxY - b.minY),
        points: e.points.map((p) => ({ x: round(p.x), y: round(p.y) })),
        layer: "top",
      }
    }
    return {
      pin,
      shape: e.shape === "pill" ? "pill" : "rect",
      x,
      y,
      width: e.width ?? 1,
      height: e.height ?? 1,
      layer: "top",
    }
  }
  if (e.type === "pcb_plated_hole") {
    if (e.shape === "circle") {
      const d = e.outer_diameter ?? 1.5
      return {
        pin,
        shape: "circle",
        x,
        y,
        width: d,
        height: d,
        holeDiameter: e.hole_diameter ?? 0.8,
        layer: "through",
      }
    }
    if (e.shape === "circular_hole_with_rect_pad") {
      return {
        pin,
        shape: "rect",
        x,
        y,
        width: e.rect_pad_width ?? 1.5,
        height: e.rect_pad_height ?? 1.5,
        holeDiameter: e.hole_diameter ?? 0.8,
        layer: "through",
      }
    }
    if (e.shape === "pill" || e.shape === "oval") {
      return {
        pin,
        shape: "pill",
        x,
        y,
        width: e.outer_width ?? 1.5,
        height: e.outer_height ?? 1.5,
        holeDiameter: e.hole_width ?? e.hole_diameter ?? 0.8,
        layer: "through",
      }
    }
  }
  return null
}

/** Projects' own land patterns (`Project.footprints`), by name. */
const projectFootprints = new Map<string, FootprintDef>()

/** Make a project's own land patterns resolve by name, as `registerProjectParts` does its parts. */
export function registerProjectFootprints(project: Pick<Project, "footprints">) {
  for (const def of project.footprints ?? []) {
    if (projectFootprints.get(def.name) === def) continue
    projectFootprints.set(def.name, def)
    cache.delete(def.name)
  }
}

/**
 * Build (and cache) footprint geometry from a library name, a project's own land pattern or a
 * footprinter string such as "0603" or "soic8".
 */
export function getFootprint(name: string): FootprintDef {
  const hit = cache.get(name)
  if (hit) return hit
  const own = libraryFootprint(name) ?? projectFootprints.get(name)
  if (own) {
    cache.set(name, own)
    return own
  }
  let elements: CjElement[] = []
  try {
    elements = fp.string(name).circuitJson() as unknown as CjElement[]
  } catch {
    elements = []
  }
  const pads: PadDef[] = []
  const silk: Vec2[][] = []
  const bounds = emptyBox()
  let courtyard: FootprintDef["courtyard"] | null = null

  const thermal: PadDef[] = []
  for (const e of elements) {
    const pad = toPad(e)
    if (pad) {
      pads.push(pad)
      if (!pad.pin && e.port_hints?.includes("thermalpad")) thermal.push(pad)
      expandBox(bounds, { x: pad.x - pad.width / 2, y: pad.y - pad.height / 2 })
      expandBox(bounds, { x: pad.x + pad.width / 2, y: pad.y + pad.height / 2 })
      continue
    }
    if (e.type === "pcb_silkscreen_path" && e.route?.length) {
      silk.push(e.route.map((p) => ({ x: round(p.x), y: round(p.y) })))
      for (const p of e.route) expandBox(bounds, p)
    } else if (e.type === "pcb_courtyard_rect" && e.center && e.width && e.height) {
      courtyard = {
        minX: round(e.center.x - e.width / 2),
        maxX: round(e.center.x + e.width / 2),
        minY: round(e.center.y - e.height / 2),
        maxY: round(e.center.y + e.height / 2),
      }
    } else if (e.type === "pcb_courtyard_outline" && e.outline?.length) {
      const b = emptyBox()
      for (const p of e.outline) expandBox(b, p)
      courtyard = { minX: round(b.minX), maxX: round(b.maxX), minY: round(b.minY), maxY: round(b.maxY) }
    }
  }

  // The footprinter hints a QFN's exposed pad "thermalpad" and numbers nothing; datasheets and
  // supplier lands number it one past the last lead, so a part can give it a pin (usually GND).
  const last = Math.max(0, ...pads.map((p) => Number(p.pin)).filter(Number.isInteger))
  thermal.forEach((pad, i) => {
    pad.pin = String(last + 1 + i)
    pad.exposed = true
  })

  if (!courtyard) {
    courtyard = Number.isFinite(bounds.minX)
      ? {
          minX: round(bounds.minX - 0.25),
          minY: round(bounds.minY - 0.25),
          maxX: round(bounds.maxX + 0.25),
          maxY: round(bounds.maxY + 0.25),
        }
      : { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }
  }

  const def: FootprintDef = { name, pads, silk, courtyard }
  cache.set(name, def)
  return def
}

export function isValidFootprint(name: string): boolean {
  if (!name.trim()) return false
  if (libraryFootprint(name) || projectFootprints.has(name)) return true
  try {
    const cj = fp.string(name).circuitJson() as unknown as CjElement[]
    return cj.some((e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole")
  } catch {
    return false
  }
}
