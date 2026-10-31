import { fp } from "@tscircuit/footprinter"
import { emptyBox, expandBox, round } from "../lib/geometry"
import { LIBRARY_FOOTPRINTS, libraryFootprint } from "./footprintLibrary"
import { scoped } from "./scope"
import type { FootprintDef, PadDef, Project, Vec2 } from "./types"

/**
 * What the library and the footprinter draw for a name: the same for every project, so kept for the
 * process, and only those. Names come from projects, so the oldest goes past `DRAWN_LIMIT`.
 */
const drawn = new Map<string, FootprintDef>()
const DRAWN_LIMIT = 4096

function keep(def: FootprintDef): FootprintDef {
  drawn.set(def.name, def)
  if (drawn.size > DRAWN_LIMIT) drawn.delete(drawn.keys().next().value as string)
  return def
}

const LIBRARY = new Set(LIBRARY_FOOTPRINTS)

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

/**
 * Projects' own land patterns (`Project.footprints`), by name: the scope's (`model/scope.ts`), so on
 * a server one project's land never stands in for another's of the same name.
 */
const projectFootprints = scoped(() => new Map<string, FootprintDef>())
const ownFootprint = (name: string) => projectFootprints().get(name) ?? projectFootprints.base.get(name)

/** Whether a name is a project's own land pattern (registered), rather than a library or footprinter one. */
export const isProjectFootprint = (name: string) => ownFootprint(name) !== undefined

/** Make a project's own land patterns resolve by name, as `registerProjectParts` does its parts. */
export function registerProjectFootprints(project: Pick<Project, "footprints">) {
  const own = projectFootprints()
  for (const def of project.footprints ?? []) own.set(def.name, def)
}

/**
 * Footprint geometry from a library name, a project's own land pattern or a footprinter string such
 * as "0603" or "soic8", in that order.
 */
export function getFootprint(name: string): FootprintDef {
  if (LIBRARY.has(name)) return drawn.get(name) ?? keep(libraryFootprint(name)!)
  const own = ownFootprint(name)
  if (own) return own
  const hit = drawn.get(name)
  if (hit) return hit
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

  return keep({ name, pads, silk, courtyard })
}

// ---------- options the footprinter reads past ----------
//
// The footprinter takes any `_option` and drops the ones its family has no use for, without a word:
// `pinrow3_p6.35mm_zigzag9mm_id1.3mm_od2.8mm` draws three pads in a row, which an assistant that
// asked for a staggered connector found only by looking at the board. These find such options.

/** What every family reads, beside its own parameters. */
const COMMON_OPTIONS = new Set(["fn", "string", "num_pins", "norefdes", "invert", "faceup", "nosilkscreen", "rounded", "pin1location", "cathodepin", "anodepin", "origin"])
/** Families whose parameters come back as given rather than as read, with what they do read (`passive_def`). */
const PASSIVE_FAMILIES = new Set(["res", "cap", "led", "diode"])
const PASSIVE_OPTIONS = new Set(["tht", "p", "pw", "ph", "metric", "imperial", "w", "h", "cyw", "cyh", "nonpolarized", "textbottom", "array", "x"])

/** The parameter a token of a footprinter string sets, as the footprinter splits it; null for a token it drops. */
function optionKey(token: string): string | null {
  if (/^pin1location\(.*\)$/i.test(token)) return "pin1location"
  const m = token.match(/((?:(?:p\d+|pin1)[a-zA-Z]+(?=[(\d.+\-?]))|[a-zA-Z]+)([(\d.+\-?].*)?/)
  if (!m?.[1] || m[2]?.includes("?")) return null
  return m[1].toLowerCase()
}

/** A string's copper, to tell whether a token changed it; null when it draws nothing. */
function copperOf(name: string): string | null {
  try {
    const cj = fp.string(name).circuitJson() as unknown as CjElement[]
    const copper = cj.filter((e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole" || e.type === "pcb_hole")
    return copper.length ? JSON.stringify(copper) : null
  } catch {
    return null
  }
}

/**
 * The options of a footprinter string that the footprinter ignores (a parameter its family doesn't
 * take, or a token it can't read, that leaves the copper as it would be without it), and the sizes
 * the family does take. A pin count after the family that the family has anyway (`to220_3`) is not
 * ignored. Nothing for a library or project land, nor for a name that draws nothing (that is
 * `isValidFootprint`'s to refuse).
 */
export function footprintOptions(name: string): { ignored: string[]; takes: string[] } {
  const none = { ignored: [], takes: [] }
  const s = name.trim()
  if (!s || LIBRARY.has(s) || isProjectFootprint(s)) return none
  let params: Record<string, unknown>
  let read: Record<string, unknown>
  try {
    const built = fp.string(s)
    params = built.params()
    read = built.json() as unknown as Record<string, unknown>
  } catch {
    return none
  }
  const copper = copperOf(s)
  if (!copper) return none
  const family = String(params.fn)
  const passive = PASSIVE_FAMILIES.has(family)
  const known = (key: string) => COMMON_OPTIONS.has(key) || key === family || (passive ? PASSIVE_OPTIONS.has(key) : key in read)
  const tokens = s.split(/_(?!metric)/)
  const ignored: string[] = []
  tokens.forEach((token, i) => {
    if (i === 0) return
    const key = optionKey(token)
    if (key && known(key)) return
    // A parameter spelled other than it is read (`smtpad_circle_d1`), or a pin count the family reads from the string (`sot23_5`), changes the copper.
    if (copperOf([...tokens.slice(0, i), ...tokens.slice(i + 1)].join("_")) !== copper) return
    if (i === 1 && /^\d+$/.test(token) && Number(token) === (JSON.parse(copper) as unknown[]).length) return
    ignored.push(token)
  })
  // The sizes it takes, which is what a misspelt option usually meant: its parameters that are numbers or lengths.
  const takes = passive
    ? ["p", "pw", "ph", "w", "h"]
    : Object.entries(read)
        .filter(([k, v]) => !COMMON_OPTIONS.has(k) && k !== family && !/silkscreen|offset/.test(k) && (typeof v === "number" || (typeof v === "string" && /^-?[\d.]+(mm|mil|in)?$/.test(v))))
        .map(([k]) => k)
  return { ignored, takes }
}

export function isValidFootprint(name: string): boolean {
  if (!name.trim()) return false
  if (LIBRARY.has(name) || isProjectFootprint(name)) return true
  try {
    const cj = fp.string(name).circuitJson() as unknown as CjElement[]
    return cj.some((e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole")
  } catch {
    return false
  }
}
