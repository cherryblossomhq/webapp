import type { AnyCircuitElement, BRepShape } from "circuit-json"
import { mm } from "./circuitJsonUnits"
import { worldShapes, BOARD_SHAPE_OWNER } from "../model/shapeItems"
import { shapeLayerInfo } from "../model/shapeLayers"
import { dashShape, flattenPath, shapePaths, shapeRings, type DashPiece } from "../model/shapes"
import type { BoardShape, Vec2 } from "../model/types"

// The drawings as Circuit JSON, where the format has an element for them:
//   silkscreen    pcb_silkscreen_line, _circle, _rect, _path (flattened), _graphic (a fill as a brep)
//   fabrication   pcb_fabrication_note_rect, _path (flattened)
//   courtyard     pcb_courtyard_outline, pcb_courtyard_circle (closed shapes only)
//   copper        pcb_trace (a stroke), pcb_copper_pour (a fill), on the net's source trace or net
// Mask, paste, adhesive and the user layers have no element, and are left out.

const pt = (p: Vec2): Vec2 => ({ x: mm(p.x), y: mm(p.y) })

export interface DrawingContext {
  /** The pcb component id of each part, by component id. */
  pcbIds: Map<string, string>
  next: (prefix: string) => string
  /** The source net id and the source trace id of a net, by its name. */
  netOf: (name: string) => { net?: string; trace?: string }
}

export interface DrawingElements {
  elements: AnyCircuitElement[]
  /** What was left out, by layer kind and why. */
  left: Map<string, number>
  /** Shapes that are written flattened to points. */
  flattened: number
}

const sideOf = (layer: string): "top" | "bottom" => (layer.startsWith("B.") ? "bottom" : "top")

/** A closed ring or open path as route points (a closed ring repeats its first point). */
const routes = (shape: BoardShape): Vec2[][] =>
  shapePaths(shape).map((p) => {
    const pts = flattenPath(p)
    return p.closed && pts.length ? [...pts, pts[0]] : pts
  })

const pieceRoute = (p: DashPiece): Vec2[] => (p.kind === "poly" ? p.pts : p.kind === "line" ? [p.a, p.b] : [p.start, p.end])

/** The runs of points a stroke is drawn along: its dashes, or its whole path. Arc dashes are flattened here, since the route has no arcs. */
function strokeRuns(shape: BoardShape): Vec2[][] {
  if (!shape.dash) return routes(shape)
  return dashShape(shape).map((p) => (p.kind === "arc" ? flattenPath({ closed: false, segs: [p] }) : pieceRoute(p)))
}

const brep = (rings: Vec2[][]): BRepShape => ({ outer_ring: { vertices: rings[0].map(pt) }, inner_rings: rings.slice(1).map((r) => ({ vertices: r.map(pt) })) })

export function drawingElements(project: Parameters<typeof worldShapes>[0], ctx: DrawingContext): DrawingElements {
  const elements: AnyCircuitElement[] = []
  const left = new Map<string, number>()
  let flattened = 0
  const skip = (kind: string) => left.set(kind, (left.get(kind) ?? 0) + 1)
  const closed = (shape: BoardShape) => shapePaths(shape).every((p) => p.closed)

  for (const { owner, shape, placed } of worldShapes(project)) {
    if (!placed) continue
    const info = shapeLayerInfo(shape.layer)
    const kind = info?.kind ?? "user"
    const part = owner === BOARD_SHAPE_OWNER ? "" : (ctx.pcbIds.get(owner) ?? "")
    const side = sideOf(shape.layer)
    const filled = shape.fill === true
    const width = mm(shape.width)

    if (kind === "silk") {
      const plain = !shape.dash
      if (plain && shape.type === "line") {
        elements.push({ type: "pcb_silkscreen_line", pcb_silkscreen_line_id: ctx.next("pcb_silkscreen_line"), pcb_component_id: part, stroke_width: width, x1: mm(shape.a.x), y1: mm(shape.a.y), x2: mm(shape.b.x), y2: mm(shape.b.y), layer: side })
        continue
      }
      if (plain && shape.type === "circle") {
        elements.push({ type: "pcb_silkscreen_circle", pcb_silkscreen_circle_id: ctx.next("pcb_silkscreen_circle"), pcb_component_id: part, center: pt(shape.c), radius: mm(shape.r), layer: side, stroke_width: width, ...(filled ? { is_filled: true } : {}) })
        continue
      }
      if (shape.type === "rect") {
        const cx = (shape.a.x + shape.b.x) / 2
        const cy = (shape.a.y + shape.b.y) / 2
        elements.push({
          type: "pcb_silkscreen_rect",
          pcb_silkscreen_rect_id: ctx.next("pcb_silkscreen_rect"),
          pcb_component_id: part,
          center: pt({ x: cx, y: cy }),
          width: mm(Math.abs(shape.b.x - shape.a.x)),
          height: mm(Math.abs(shape.b.y - shape.a.y)),
          layer: side,
          stroke_width: width,
          ...(shape.radius ? { corner_radius: mm(shape.radius) } : {}),
          ...(filled ? { is_filled: true } : {}),
          has_stroke: shape.width > 0,
          ...(shape.dash ? { is_stroke_dashed: true } : {}),
        })
        continue
      }
      if (filled) {
        const rings = shapeRings(shape)
        if (rings.length) {
          elements.push({ type: "pcb_silkscreen_graphic", pcb_silkscreen_graphic_id: ctx.next("pcb_silkscreen_graphic"), pcb_component_id: part, layer: side, shape: "brep", brep_shape: brep(rings) })
          flattened++
        }
      }
      if (shape.width > 0) {
        for (const route of strokeRuns(shape)) if (route.length >= 2) elements.push({ type: "pcb_silkscreen_path", pcb_silkscreen_path_id: ctx.next("pcb_silkscreen_path"), pcb_component_id: part, layer: side, route: route.map(pt), stroke_width: width })
        if (shape.type !== "line") flattened++
      }
      continue
    }

    if (kind === "fab") {
      if (!shape.dash && shape.type === "rect" && !shape.radius) {
        elements.push({
          type: "pcb_fabrication_note_rect",
          pcb_fabrication_note_rect_id: ctx.next("pcb_fabrication_note_rect"),
          pcb_component_id: part,
          center: pt({ x: (shape.a.x + shape.b.x) / 2, y: (shape.a.y + shape.b.y) / 2 }),
          width: mm(Math.abs(shape.b.x - shape.a.x)),
          height: mm(Math.abs(shape.b.y - shape.a.y)),
          layer: side,
          stroke_width: width,
          ...(filled ? { is_filled: true } : {}),
          has_stroke: shape.width > 0,
        })
        continue
      }
      const holes = shapePaths(shape).length > 1
      for (const route of strokeRuns(shape)) {
        if (route.length < 2) continue
        elements.push({
          type: "pcb_fabrication_note_path",
          pcb_fabrication_note_path_id: ctx.next("pcb_fabrication_note_path"),
          pcb_component_id: part,
          layer: side,
          route: route.map(pt),
          stroke_width: width,
          ...(filled && !holes && !shape.dash ? { is_filled: true } : {}),
          ...(shape.width > 0 ? {} : { has_stroke: false }),
        })
      }
      if (shape.type !== "line") flattened++
      continue
    }

    if (kind === "courtyard") {
      if (shape.type === "circle") {
        elements.push({ type: "pcb_courtyard_circle", pcb_courtyard_circle_id: ctx.next("pcb_courtyard_circle"), pcb_component_id: part, center: pt(shape.c), radius: mm(shape.r), layer: side })
        continue
      }
      if (closed(shape)) {
        const [ring] = shapeRings(shape)
        if (ring) {
          elements.push({ type: "pcb_courtyard_outline", pcb_courtyard_outline_id: ctx.next("pcb_courtyard_outline"), pcb_component_id: part, layer: side, outline: ring.map(pt) })
          continue
        }
      }
      skip("an open courtyard drawing")
      continue
    }

    if (kind === "copper") {
      const net = shape.net ? ctx.netOf(shape.net) : {}
      const layer = sideOf(shape.layer)
      if (filled) {
        const rings = shapeRings(shape)
        if (rings.length) {
          elements.push({ type: "pcb_copper_pour", pcb_copper_pour_id: ctx.next("pcb_copper_pour"), layer, shape: "brep", brep_shape: brep(rings), covered_with_solder_mask: true, ...(net.net ? { source_net_id: net.net } : {}) })
          flattened++
        }
      }
      if (shape.width > 0) {
        for (const route of strokeRuns(shape)) {
          if (route.length < 2) continue
          elements.push({
            type: "pcb_trace",
            pcb_trace_id: ctx.next("pcb_trace"),
            ...(net.trace ? { source_trace_id: net.trace } : {}),
            route: route.map((p) => ({ route_type: "wire" as const, x: mm(p.x), y: mm(p.y), width: shape.width, layer })),
          })
        }
        if (shape.type !== "line") flattened++
      }
      continue
    }

    skip(kind === "user" ? "a drawing on a user layer" : `a drawing on a ${kind} layer`)
  }
  return { elements, left, flattened }
}
