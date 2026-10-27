import type { ComponentInstance, PartUnit, PcbPoint, Project, Vec2 } from "./types"

// X23: PCB points and footprint units (KiCad 10). A point is a reference mark: drawn as a circle with a cross, plotted nowhere. A part's points are in the footprint's own frame
// (as a pad is, in the file's y down, already flipped on a part on the bottom), so they move, turn and flip with the part; the board's own are in the board's frame.

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** PCB points as stored; an entry that is not a place of a size on a layer is dropped. */
export function normalizePoints(raw: unknown): PcbPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.flatMap((p): PcbPoint[] => (isObject(p) && num(p.x) && num(p.y) && num(p.size) && p.size >= 0 && typeof p.layer === "string" ? [{ x: p.x, y: p.y, size: p.size, layer: p.layer }] : []))
  return out.length ? out : undefined
}

/** A footprint's units as stored (a list of the name and the pad numbers, or an object of both in a file written by hand); an entry with no name is dropped. */
export function normalizeUnits(raw: unknown): PartUnit[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const strings = (v: unknown[]) => v.filter((n): n is string => typeof n === "string")
  const out = raw.flatMap((u): PartUnit[] => {
    if (Array.isArray(u)) return typeof u[0] === "string" ? [{ name: u[0], pins: strings(u.slice(1)) }] : []
    return isObject(u) && typeof u.name === "string" && Array.isArray(u.pins) ? [{ name: u.name, pins: strings(u.pins) }] : []
  })
  return out.length ? out : undefined
}

/** A point of a part where it is on the board (the board's frame, y up): the footprint's own frame turned by the file's angle of the part (a half turn less on the bottom) and moved to the part. */
export function partPointWorld(c: Pick<ComponentInstance, "pcb">, p: Pick<PcbPoint, "x" | "y">): Vec2 {
  const a = ((c.pcb.side === "bottom" ? c.pcb.rot - 180 : c.pcb.rot) * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return { x: c.pcb.x + p.x * cos + p.y * sin, y: c.pcb.y - (-p.x * sin + p.y * cos) }
}

/** The board's PCB points and those of the given parts, all in the board's frame. */
export function worldPoints(project: Pick<Project, "points">, parts: readonly ComponentInstance[]): PcbPoint[] {
  return [...(project.points ?? []), ...parts.flatMap((c) => (c.points ?? []).map((p) => ({ ...p, ...partPointWorld(c, p) })))]
}
