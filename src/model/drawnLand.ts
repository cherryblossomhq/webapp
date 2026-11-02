import { emptyBox, expandBox, round } from "../lib/geometry"
import { digest } from "./customParts"
import { packageFamily } from "./supplier/build"
import type { FootprintDef, PadDef } from "./types"

// A land pattern written out pad by pad, as create_part's `land` takes it: for a package no
// footprinter string draws and no supplier or parts database has. An assistant asked for a Phoenix
// 1777558 (three pins, the middle one 9 mm behind the others) had no way to say so: footprint strings
// draw rows and grids, and the option it tried was dropped without a word. A datasheet's drilling
// diagram is a list of pads, so that is what this takes.
//
// Millimetres, seen from the top of the board, x to the right and y up, as every land here is. Nothing
// is moved: the origin is wherever the pads put it (pin 1, or the body's middle). Whatever can't be
// drawn as given is refused with the pad it is about, never dropped.

export interface DrawnPad {
  /** The pin it belongs to; pads with the same number are one pin. None for a pad that is no pin. */
  number?: string
  x: number
  y: number
  shape?: "rect" | "roundrect" | "circle" | "oval"
  w?: number
  h?: number
  d?: number
  /** The hole's diameter, or a slot's width: a pad with one is through-hole. */
  drill?: number
  /** A slotted hole's overall length, along the pad's longer side. */
  slot_length?: number
  /** False for a bare hole with no copper (a mounting peg). */
  plated?: boolean
  /** Degrees counter-clockwise. */
  rotation?: number
  corner_ratio?: number
  paste?: boolean
  paste_margin?: number
  paste_ratio?: number
  mask_margin?: number
}

export interface DrawnLandInput {
  pads?: DrawnPad[]
  /** The body's outline, two opposite corners: drawn on the silkscreen and kept inside the courtyard. */
  body?: { x1: number; y1: number; x2: number; y2: number }
  courtyard_margin?: number
  /** The package's name (`TO-220-3`, `SOIC-8`): the land is named after its family. */
  package?: string
}

/** Further than any land reaches: a number past it is in other units, or a typo. */
const MAX_COORD = 250
const MAX_SIZE = 60
const DEFAULT_CORNER = 0.25
const DEFAULT_COURTYARD = 0.25

const mm = (n: number) => `${round(n, 3)} mm`

/** A turn in degrees counter-clockwise: a quarter turn is the size turned (`swap`); any other angle is the pad's own (`rot`). */
function turnOf(rotation = 0): { swap: boolean; rot?: number } {
  const turn = ((rotation % 360) + 360) % 360
  const quarter = Math.abs(turn / 90 - Math.round(turn / 90)) < 1e-6
  return quarter ? { swap: Math.round(turn / 90) % 2 === 1 } : { swap: false, rot: round(turn, 3) }
}

/** One pad as the land has it, or why it can't be. */
function drawnPad(p: DrawnPad, label: string): PadDef | string {
  const number = String(p.number ?? "").trim()
  if (Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD) return `${label} is at (${p.x}, ${p.y}), over ${MAX_COORD} mm out: coordinates are millimetres`
  const drill = p.drill
  const slot = p.slot_length
  const pasted = p.paste !== undefined || p.paste_margin !== undefined || p.paste_ratio !== undefined
  if (drill !== undefined && !(drill > 0 && drill <= MAX_SIZE)) return `${label}: drill must be a diameter in mm, over 0`
  if (slot !== undefined && drill === undefined) return `${label}: slot_length needs drill, the slot's width`
  if (slot !== undefined && !(slot > drill!)) return `${label}: slot_length (${mm(slot)}) must be longer than drill (${mm(drill!)}), which is the slot's width`

  if (p.plated === false) {
    // A bare hole: no copper, so no pin and no size of its own but the hole's.
    if (number) return `${label}: a non-plated hole is no pin, so it has no number`
    if (drill === undefined) return `${label}: a non-plated hole needs drill`
    if (pasted || p.mask_margin !== undefined || p.corner_ratio !== undefined) return `${label}: a non-plated hole has no copper, so no paste, mask or corner settings`
    if (p.shape !== undefined || p.w !== undefined || p.h !== undefined || p.d !== undefined) {
      return `${label}: a non-plated hole has no copper, so its size is drill (and slot_length, along x unless turned by rotation); leave out shape, w, h and d`
    }
    const x = round(p.x)
    const y = round(p.y)
    if (slot === undefined) return { pin: null, shape: "circle", x, y, width: round(drill), height: round(drill), holeDiameter: round(drill), layer: "through", plated: false }
    // A slot runs along x, turned like any pad.
    const { swap, rot } = turnOf(p.rotation)
    return {
      pin: null,
      shape: "pill",
      x,
      y,
      width: round(swap ? drill : slot),
      height: round(swap ? slot : drill),
      holeDiameter: round(drill),
      slotLength: round(slot),
      layer: "through",
      plated: false,
      ...(rot !== undefined ? { rot } : {}),
    }
  }

  const shape = p.shape ?? (p.d !== undefined ? "circle" : "rect")
  let w: number
  let h: number
  if (shape === "circle") {
    const d = p.d ?? p.w
    if (d === undefined) return `${label}: a circle pad needs d, its diameter`
    if ((p.w !== undefined && p.w !== d) || (p.h !== undefined && p.h !== d)) return `${label}: a circle has one size, d; a pad longer one way is shape oval with w and h`
    w = h = d
  } else {
    if (p.d !== undefined) return `${label}: d is a circle's diameter; a ${shape} pad takes w and h`
    if (p.w === undefined || p.h === undefined) return `${label}: a ${shape} pad needs w and h`
    w = p.w
    h = p.h
  }
  if (!(w > 0 && h > 0) || w > MAX_SIZE || h > MAX_SIZE) return `${label}: its size must be over 0 and at most ${MAX_SIZE} mm`
  if (drill !== undefined && drill >= Math.min(w, h)) return `${label}: its ${mm(drill)} hole leaves no copper round it on a ${mm(w)} x ${mm(h)} pad`
  if (slot !== undefined) {
    if (w === h) return `${label}: a slot runs along a pad's longer side, so its pad must be longer one way (shape oval, or rect, with w and h)`
    if (slot >= Math.max(w, h)) return `${label}: its ${mm(slot)} slot is as long as the pad`
  }
  if (p.corner_ratio !== undefined && shape !== "roundrect") return `${label}: corner_ratio is for shape roundrect`
  const corner = shape === "roundrect" ? (p.corner_ratio ?? DEFAULT_CORNER) : undefined
  if (corner !== undefined && !(corner > 0 && corner <= 0.5)) return `${label}: corner_ratio is from 0 to 0.5 of the shorter side`
  if (drill !== undefined && pasted) return `${label}: paste settings are for surface-mount pads; a through-hole pad has no paste`
  if (p.paste === false && (p.paste_margin !== undefined || p.paste_ratio !== undefined)) return `${label}: paste false has no paste opening to size`
  if (p.paste_ratio !== undefined && !(p.paste_ratio > -1 && p.paste_ratio <= 1)) return `${label}: paste_ratio is a fraction of the pad's size, e.g. -0.2 to shrink the paste opening by a fifth`
  for (const [key, v] of [["paste_margin", p.paste_margin], ["mask_margin", p.mask_margin]] as const) {
    if (v !== undefined && Math.abs(v) > 5) return `${label}: ${key} is ${mm(v)}, more than 5 mm: it is a margin round the pad, in mm`
  }

  const turned = turnOf(p.rotation)
  if (turned.swap) [w, h] = [h, w]
  const rot = shape === "circle" ? undefined : turned.rot

  const through = drill !== undefined
  return {
    pin: number || null,
    shape: shape === "circle" ? "circle" : shape === "oval" ? "pill" : "rect",
    x: round(p.x),
    y: round(p.y),
    width: round(w),
    height: round(h),
    ...(through ? { holeDiameter: round(drill) } : {}),
    ...(slot !== undefined ? { slotLength: round(slot) } : {}),
    layer: through ? "through" : "top",
    ...(rot !== undefined ? { rot } : {}),
    ...(corner !== undefined ? { round: corner } : {}),
    ...(p.paste === false ? { layers: { paste: "none" as const } } : {}),
    ...(p.paste_margin !== undefined ? { pasteMargin: p.paste_margin } : {}),
    ...(p.paste_ratio !== undefined ? { pasteRatio: p.paste_ratio } : {}),
    ...(p.mask_margin !== undefined ? { maskMargin: p.mask_margin } : {}),
  }
}

/** Two pads of different pins whose copper meets: a short drawn into the land. Pads turned by an odd angle are left out. */
function shorted(pads: PadDef[]): [PadDef, PadDef] | null {
  const copper = pads.filter((p) => p.plated !== false && p.pin && p.rot === undefined)
  for (let i = 0; i < copper.length; i++) {
    for (let j = i + 1; j < copper.length; j++) {
      const a = copper[i]
      const b = copper[j]
      if (a.pin === b.pin) continue
      const dx = Math.abs(a.x - b.x)
      const dy = Math.abs(a.y - b.y)
      const meets =
        a.shape === "circle" && b.shape === "circle"
          ? Math.hypot(dx, dy) < (a.width + b.width) / 2 - 1e-6
          : dx < (a.width + b.width) / 2 - 1e-6 && dy < (a.height + b.height) / 2 - 1e-6
      if (meets) return [a, b]
    }
  }
  return null
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "part"

/**
 * The land a pad list draws, as a project land pattern named after the package family and the part
 * (`land_1777558-1a2b3c`, its name ending in a hash of the pattern as every project land's does), or
 * why it can't be drawn, naming the pads.
 */
export function drawnLand(input: DrawnLandInput, partName: string): { land: FootprintDef } | { problem: string } {
  const given = input.pads ?? []
  if (!given.length) return { problem: "land needs pads" }
  const pads: PadDef[] = []
  const problems: string[] = []
  given.forEach((p, i) => {
    const pad = drawnPad(p, p.number?.trim() ? `pad ${p.number.trim()}` : `pads[${i}]`)
    if (typeof pad === "string") problems.push(pad)
    else pads.push(pad)
  })
  if (problems.length) return { problem: `${problems.slice(0, 6).join("; ")}${problems.length > 6 ? `; and ${problems.length - 6} more` : ""}` }
  if (!pads.some((p) => p.pin)) return { problem: "land has no numbered pad, so no pin could sit on it" }
  const short = shorted(pads)
  if (short) {
    const [a, b] = short
    return { problem: `pads ${a.pin} at (${a.x}, ${a.y}) and ${b.pin} at (${b.x}, ${b.y}) overlap, which shorts them: check the coordinates are millimetres from one origin` }
  }

  const margin = input.courtyard_margin ?? DEFAULT_COURTYARD
  if (!(margin >= 0 && margin <= 5)) return { problem: "courtyard_margin is the clearance round the part in mm, from 0 to 5" }
  const silk: FootprintDef["silk"] = []
  const box = emptyBox()
  for (const p of pads) {
    // A pad turned by an odd angle reaches as far as its diagonal.
    const rx = p.rot !== undefined ? Math.hypot(p.width, p.height) / 2 : p.width / 2
    const ry = p.rot !== undefined ? Math.hypot(p.width, p.height) / 2 : p.height / 2
    expandBox(box, { x: p.x - rx, y: p.y - ry })
    expandBox(box, { x: p.x + rx, y: p.y + ry })
  }
  if (input.body) {
    const { x1, y1, x2, y2 } = input.body
    if (x1 === x2 || y1 === y2) return { problem: "body is two opposite corners of the outline, x1 y1 and x2 y2, which differ in both x and y" }
    if ([x1, y1, x2, y2].some((v) => Math.abs(v) > MAX_COORD)) return { problem: `body reaches over ${MAX_COORD} mm out: coordinates are millimetres` }
    const [lx, hx] = [Math.min(x1, x2), Math.max(x1, x2)].map((v) => round(v))
    const [ly, hy] = [Math.min(y1, y2), Math.max(y1, y2)].map((v) => round(v))
    silk.push([
      { x: lx, y: ly },
      { x: hx, y: ly },
      { x: hx, y: hy },
      { x: lx, y: hy },
      { x: lx, y: ly },
    ])
    expandBox(box, { x: lx, y: ly })
    expandBox(box, { x: hx, y: hy })
  }
  const courtyard = { minX: round(box.minX - margin), minY: round(box.minY - margin), maxX: round(box.maxX + margin), maxY: round(box.maxY + margin) }
  const body = { pads, silk, courtyard }
  const pkg = input.package?.trim()
  return {
    land: {
      name: `${packageFamily(pkg)}_${slug(partName)}-${digest(JSON.stringify(body))}`,
      ...body,
    },
  }
}
