import { transformPoint } from "../lib/geometry"
import { flipShapeLayer } from "./shapeLayers"
import { copperLayers } from "./stack"
import type { ComponentInstance, PartUnit, PcbPoint, Project } from "./types"

// X23: PCB points and footprint units (KiCad 10). A point is a reference mark: drawn as a circle with a cross, plotted nowhere. A part's points are in the footprint's own frame
// as a pad is (y up, laid out as for a part on the top, on the layer it has there), so they move, turn and flip with the part; the board's own are in the board's frame.

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** PCB points as stored; an entry that is not a place of a size on a layer is dropped. */
export function normalizePoints(raw: unknown): PcbPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.flatMap((p): PcbPoint[] => (isObject(p) && num(p.x) && num(p.y) && num(p.size) && p.size >= 0 && typeof p.layer === "string" ? [{ x: p.x, y: p.y, size: p.size, layer: p.layer }] : []))
  return out.length ? out : undefined
}

/**
 * A footprint's units as stored: a list of the name and the pad numbers joined by spaces (or, when a number has a space in it or is empty, a list of them), or an object of both
 * in a file written by hand. An entry with no name is dropped.
 */
export function normalizeUnits(raw: unknown): PartUnit[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const strings = (v: unknown[]) => v.filter((n): n is string => typeof n === "string")
  const out = raw.flatMap((u): PartUnit[] => {
    if (Array.isArray(u)) {
      if (typeof u[0] !== "string") return []
      const pins = Array.isArray(u[1]) ? strings(u[1]) : typeof u[1] === "string" && u[1] !== "" ? u[1].split(" ") : []
      return [{ name: u[0], pins }]
    }
    return isObject(u) && typeof u.name === "string" && Array.isArray(u.pins) ? [{ name: u.name, pins: strings(u.pins) }] : []
  })
  return out.length ? out : undefined
}

/** A point of a part where it is on the board (the board's frame, y up), and the layer it is drawn on: its place turned and mirrored as the part is (`transformPoint`, as a pad's), its layer flipped on the bottom. */
export function partPointWorld(c: Pick<ComponentInstance, "pcb">, p: PcbPoint, copper: number): PcbPoint {
  const bottom = c.pcb.side === "bottom"
  return { ...p, ...transformPoint(p, c.pcb, c.pcb.rot, bottom), layer: bottom ? flipShapeLayer(p.layer, copper) : p.layer }
}

/** The board's PCB points and those of the given parts, all in the board's frame, on the layers they are on there. */
export function worldPoints(project: Pick<Project, "points" | "board">, parts: readonly ComponentInstance[]): PcbPoint[] {
  const copper = copperLayers(project.board).length
  return [...(project.points ?? []), ...parts.flatMap((c) => (c.points ?? []).map((p) => partPointWorld(c, p, copper)))]
}
