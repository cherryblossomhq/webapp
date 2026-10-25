import { boxesOverlap, pointInBox, type Box } from "../../lib/geometry"
import { dimensionBox, imageBox, newDimension } from "../../model/boardObjects"
import type { BoardDimension, DimensionKind, Project, ReferenceImage, Vec2 } from "../../model/types"
import type { ShapeVisibility } from "./shapeEditing"

// The pure parts of placing dimensions and picking dimensions and images in the PCB view, kept out of the component so they can be tested without a browser.

/** The shortcut of the dimension tool. */
export const DIMENSION_TOOL_KEY = "M"

export const DIMENSION_KINDS: DimensionKind[] = ["aligned", "orthogonal", "leader", "center", "radial"]

export const DIMENSION_NAMES: Record<DimensionKind, string> = {
  aligned: "Aligned",
  orthogonal: "Orthogonal",
  leader: "Leader",
  center: "Centre mark",
  radial: "Radius",
}

/** The clicks a dimension takes: the two points it measures and where its crossbar goes, or the two points a mark, a radius or a leader takes. */
export const dimensionClicks = (kind: DimensionKind): number => (kind === "aligned" || kind === "orthogonal" ? 3 : 2)

/** What the next click of a dimension tool is for, by the clicks so far. */
export function dimensionHint(kind: DimensionKind, clicks: number): [string, string][] {
  const next: Record<DimensionKind, string[]> = {
    aligned: ["the first point", "the second point", "where the crossbar goes"],
    orthogonal: ["the first point", "the second point", "where the crossbar goes"],
    leader: ["what it points at", "where the line ends"],
    center: ["the centre", "the end of one arm"],
    radial: ["the centre", "a point on the circle"],
  }
  return clicks ? [["Click", next[kind][clicks]], ["Esc", "cancel"], ["Alt", "off the grid"]] : [["Click", next[kind][0]], ["Alt", "off the grid"]]
}

/**
 * The dimension the clicks so far make, with the cursor standing for the clicks to come, or null while the points are the same. An aligned dimension's crossbar goes
 * through the third click, an orthogonal one measures along x unless its points are further apart along y, and a radius puts its text beyond its leader.
 */
export function buildDimension(kind: DimensionKind, layer: string, clicks: Vec2[], cursor: Vec2): Omit<BoardDimension, "id"> | null {
  const a = clicks[0]
  const b = clicks[1] ?? cursor
  if (!a || (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6)) return null
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (kind === "aligned" || kind === "orthogonal") {
    const through = clicks.length >= 2 ? cursor : b
    let height: number
    let vertical = false
    if (kind === "aligned") {
      // KiCad's height is positive along (dy, -dx) in the editor's frame: the way round from the line that its extension lines point.
      const len = Math.hypot(dx, dy)
      height = ((through.x - a.x) * dy - (through.y - a.y) * dx) / len
    } else {
      vertical = Math.abs(dy) > Math.abs(dx)
      height = vertical ? through.x - a.x : -(through.y - a.y)
    }
    const text = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    return newDimension(kind, layer, a, b, { height: clicks.length >= 2 ? height : 0, vertical, text })
  }
  if (kind === "radial") {
    const len = Math.hypot(dx, dy)
    const text = { x: b.x + (dx / len) * (3.81 + 2), y: b.y + (dy / len) * (3.81 + 2) }
    return newDimension(kind, layer, a, b, { text })
  }
  if (kind === "leader") return { ...newDimension(kind, layer, a, b, { text: b }), hj: "left" as const }
  return newDimension(kind, layer, a, b, { text: a })
}

// ---------- images ----------

/** Whether an image is on screen: its layer is not hidden and the copper or silkscreen switch of its side is on. */
export function imageShown(m: ReferenceImage, vis: ShapeVisibility): boolean {
  if (vis.hidden[m.layer]) return false
  if (m.layer === "F.Cu") return vis.layers.top
  if (m.layer === "B.Cu") return vis.layers.bottom
  if (m.layer.endsWith(".SilkS")) return vis.layers.silk
  return true
}

/** The topmost image under a point (later images are on top), as a selection id. */
export function hitImage(project: Project, at: Vec2, vis: ShapeVisibility): string | null {
  const images = project.images ?? []
  for (let i = images.length - 1; i >= 0; i--) {
    if (imageShown(images[i], vis) && pointInBox(at, imageBox(images[i]))) return `i:${images[i].id}`
  }
  return null
}

/** The dimensions and images a marquee touches, as selection ids. */
export function marqueeBoardObjects(project: Project, box: Box, vis: ShapeVisibility): string[] {
  const out: string[] = []
  for (const d of project.dimensions ?? []) {
    if (vis.hidden[d.layer]) continue
    if (boxesOverlap(box, dimensionBox(d))) out.push(`m:${d.id}`)
  }
  for (const m of project.images ?? []) if (imageShown(m, vis) && boxesOverlap(box, imageBox(m))) out.push(`i:${m.id}`)
  return out
}
