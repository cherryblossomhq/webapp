import { cosSin, round } from "../lib/geometry"
import { findPart } from "../model/library"
import { isPhysical } from "../model/instances"
import { shapeLayerInfo } from "../model/shapeLayers"
import { dashShape, flattenPath, mapShape, segStart, shapePaths, shapeRings, type PathSeg, type ShapePath } from "../model/shapes"
import { worldShapes, BOARD_SHAPE_OWNER } from "../model/shapeItems"
import type { BoardShape, ComponentInstance, Project, Vec2 } from "../model/types"
import { fractureRings } from "./fracture"

// The board's drawings and each footprint's drawings, written into the board file the converter
// made (`gr_line`, `gr_arc`, `gr_circle`, `gr_rect`, `gr_poly`, `gr_curve` on the board; `fp_*` inside
// the footprint). They go in as text after the converter has run, so the converter's own output stays
// byte for byte what it was for a board with none.
//
// A footprint's drawings are written in its own frame, the way the converter writes its pads: the
// drawing's place on the board less the footprint's, y negated (KiCad is y down), turned back by the
// footprint's angle. A part on the bottom needs no more than that: KiCad stores a flipped footprint's
// items where they are, and the drawings arrive here already mirrored with their layers swapped
// (`pcbShapes`), just as the converter's pads for such a part are board positions in the same frame.

/** Where the converter puts the editor's origin on KiCad's page (`CircuitJsonToKicadPcbConverter`). */
export const KICAD_PAGE_ORIGIN = 100

const FLATTEN = 0.0005

const mm6 = (n: number) => String(round(n, 6) || 0)
const xy = (p: Vec2) => `${mm6(p.x)} ${mm6(p.y)}`
const quote = (text: string) => `"${text.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const STROKE_TYPE = { dash: "dash", dot: "dot", dash_dot: "dash_dot", dash_dot_dot: "dash_dot_dot" } as const

/** KiCad's numbers for the user layers it has to be told about: `User.1` is 50 and `User.9` is 58, `User.10` is 60 (59 is the rescue layer). */
export const userLayerNumber = (name: string): number | null => {
  const m = name.match(/^User\.(\d+)$/)
  if (!m) return null
  const n = Number(m[1])
  return n <= 9 ? 49 + n : 50 + n
}

export interface KicadDrawings {
  text: string
  /** What did not come across as it is, in words for whoever exported it. */
  notes: string[]
  /** The ids the items were written with, by what the editor selects each drawing by (`g:<id>` on the board, `s:<part>:<place>` in a part's land): a group names its members by them. */
  uuids: Map<string, string[]>
}

interface Out {
  uuid: () => string
  flattened: Set<string>
  netCode: (name: string) => number
}

/** A ring's points in KiCad's `pts` order: a corner is `xy`, an arc corner is `arc`; the ring starts where the edge into it is straight, so it needs no closing arc. */
function ringItems(path: ShapePath): string[] {
  let segs: PathSeg[] = path.segs
  const lastLine = (() => {
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].kind === "line") return i
    return -1
  })()
  if (segs.length && segs[segs.length - 1].kind !== "line" && lastLine >= 0) segs = [...segs.slice(lastLine + 1), ...segs.slice(0, lastLine + 1)]
  const items: string[] = [`(xy ${xy(segStart(segs[0]))})`]
  segs.forEach((s, i) => {
    if (s.kind === "line") {
      // The last straight edge closes the ring on its own.
      if (!(path.closed && i === segs.length - 1)) items.push(`(xy ${xy(s.b)})`)
    } else if (s.kind === "arc") items.push(`(arc (start ${xy(s.start)}) (mid ${xy(s.mid)}) (end ${xy(s.end)}))`)
    else for (const p of flattenPath({ closed: false, segs: [s] }, FLATTEN).slice(1)) items.push(`(xy ${xy(p)})`)
  })
  return items
}

const pointItems = (ring: Vec2[]) => ring.map((p) => `(xy ${xy(p)})`)

/** The blocks (each a list of lines) one drawing is written as. */
function drawing(shape: BoardShape, fp: boolean, out: Out): string[][] {
  const tag = (kind: string) => `${fp ? "fp" : "gr"}_${kind}`
  const type = shape.dash ? STROKE_TYPE[shape.dash] : "solid"
  const net = shape.net && shapeLayerInfo(shape.layer)?.kind === "copper" ? out.netCode(shape.net) : 0
  const tail = (): string[] => [`(layer ${quote(shape.layer)})`, ...(net > 0 ? [`(net ${net})`] : []), ...(shape.locked ? ["(locked yes)"] : []), `(uuid ${out.uuid()})`]
  const stroke = (width = shape.width, kind: string = type) => [`(stroke`, `  (width ${mm6(width)})`, `  (type ${kind})`, `)`]
  const block = (name: string, body: string[]) => [`(${tag(name)}`, ...body.map((l) => `  ${l}`), `)`]
  const polyBlock = (items: string[], width: number, solid: boolean, kind: string = type) => block("poly", [`(pts`, ...items.map((i) => `  ${i}`), `)`, ...stroke(width, kind), `(fill ${solid ? "solid" : "none"})`, ...tail()])
  const filled = shape.fill === true

  switch (shape.type) {
    case "line":
      return [block("line", [`(start ${xy(shape.a)})`, `(end ${xy(shape.b)})`, ...stroke(), ...tail()])]
    case "arc": {
      const path = shapePaths(shape)[0].segs[0]
      if (path.kind !== "arc") return [block("line", [`(start ${xy(shape.start)})`, `(end ${xy(shape.end)})`, ...stroke(), ...tail()])]
      return [block("arc", [`(start ${xy(shape.start)})`, `(mid ${xy(shape.mid)})`, `(end ${xy(shape.end)})`, ...stroke(), ...tail()])]
    }
    case "circle":
      return [block("circle", [`(center ${xy(shape.c)})`, `(end ${xy({ x: shape.c.x + shape.r, y: shape.c.y })})`, ...stroke(), `(fill ${filled ? "solid" : "none"})`, ...tail()])]
    case "curve":
      return [block("curve", [`(pts`, ...pointItems([shape.p0, shape.c1, shape.c2, shape.p1]).map((i) => `  ${i}`), `)`, ...stroke(), ...tail()])]
    case "rect": {
      if (!shape.radius || shape.radius <= 0) return [block("rect", [`(start ${xy(shape.a)})`, `(end ${xy(shape.b)})`, ...stroke(), `(fill ${filled ? "solid" : "none"})`, ...tail()])]
      // KiCad 9's rectangle has no corner radius: a rounded one is a polygon with arc corners.
      return [polyBlock(ringItems(shapePaths(shape)[0]), shape.width, filled)]
    }
    case "polygon": {
      const paths = shapePaths(shape)
      if (paths.length === 1) return [polyBlock(ringItems(paths[0]), shape.width, filled)]
      // KiCad's polygon has no holes: the fill is one outline joined to its holes by bridges, which cover no area, and the edge is each ring on its own.
      const blocks: string[][] = []
      const rings = shapeRings(shape, FLATTEN)
      if (filled && rings.length) {
        blocks.push(polyBlock(pointItems(fractureRings(rings[0], rings.slice(1))), 0, true, "solid"))
        out.flattened.add("hole")
      }
      if (shape.width > 0 || !filled) for (const path of paths) blocks.push(polyBlock(ringItems(path), shape.width, false))
      return blocks
    }
    case "ellipse": {
      // KiCad 9 has no ellipse: written as the polygon or the lines it flattens to, within half a micrometre.
      out.flattened.add("ellipse")
      const [path] = shapePaths(shape)
      if (path.closed) return [polyBlock(pointItems(flattenPath(path, FLATTEN)), shape.width, filled)]
      const lineBlock = (a: Vec2, b: Vec2) => block("line", [`(start ${xy(a)})`, `(end ${xy(b)})`, ...stroke(shape.width, "solid"), ...tail()])
      const runs = shape.dash
        ? dashShape(shape).map((p) => (p.kind === "poly" ? p.pts : p.kind === "line" ? [p.a, p.b] : [p.start, p.end]))
        : [flattenPath(path, FLATTEN)]
      return runs.flatMap((run) => run.slice(1).map((p, i) => lineBlock(run[i], p)))
    }
  }
}

const indent = (lines: string[], by: string) => lines.map((l) => `${by}${l}`).join("\n")

/** A footprint's own frame: a point of the board to the footprint's local coordinates, as the converter writes the pads. */
export function localFrame(c: ComponentInstance) {
  const { cs, sn } = cosSin(c.pcb.rot)
  return (p: Vec2): Vec2 => {
    const dx = p.x - c.pcb.x
    const dy = -(p.y - c.pcb.y)
    return { x: cs * dx - sn * dy, y: sn * dx + cs * dy }
  }
}

/** Whether the project has any drawing that is written out: a board drawing, or one of a part placed on the board (a dimension's lines are written with the dimension). */
export const hasDrawings = (project: Project) => worldShapes(project).some((s) => s.placed && !s.dim)

/**
 * The board file with the project's drawings added: the board's own as top-level `gr_*` items and
 * each part's inside its footprint (found by reference) as `fp_*`; the user layers they are on in the
 * layer table, and the nets of copper drawings in the net table.
 */
export function applyDrawings(pcb: string, project: Project): KicadDrawings {
  const shapes = worldShapes(project).filter((s) => s.placed && !s.dim)
  const uuids = new Map<string, string[]>()
  if (!shapes.length) return { text: pcb, notes: [], uuids }
  let serial = 0
  const uuidAt = (n: number) => `00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}`
  const uuid = () => uuidAt(++serial)
  const nets = new Map<string, number>()
  for (const m of pcb.matchAll(/\n {2}\(net (\d+) "((?:[^"\\]|\\.)*)"\)/g)) nets.set(m[2].replace(/\\(.)/g, "$1"), Number(m[1]))
  const added: string[] = []
  let next = Math.max(0, ...nets.values()) + 1
  const out: Out = {
    uuid,
    flattened: new Set(),
    netCode(name) {
      let code = nets.get(name)
      if (code === undefined) {
        code = next++
        nets.set(name, code)
        added.push(`\n  (net ${code} ${quote(name)})`)
      }
      return code
    },
  }

  const board: string[] = []
  const byRef = new Map<string, string[]>()
  const refOf = new Map<string, string>()
  for (const c of project.components) if (isPhysical(findPart(c.partId))) refOf.set(c.id, c.ref)
  const componentOf = new Map(project.components.map((c) => [c.id, c]))
  const layers = new Set<string>()
  const toBoard = (p: Vec2): Vec2 => ({ x: KICAD_PAGE_ORIGIN + p.x, y: KICAD_PAGE_ORIGIN - p.y })
  for (const { id, owner, shape } of shapes) {
    layers.add(shape.layer)
    const from = serial
    const issued = () => Array.from({ length: serial - from }, (_, i) => uuidAt(from + i + 1))
    if (owner === BOARD_SHAPE_OWNER) {
      for (const b of drawing(mapShape(shape, toBoard), false, out)) board.push(indent(b, "  "))
      uuids.set(id, issued())
      continue
    }
    const c = componentOf.get(owner)
    const ref = refOf.get(owner)
    if (!c || ref === undefined) continue
    const list = byRef.get(ref) ?? []
    for (const b of drawing(mapShape(shape, localFrame(c)), true, out)) list.push(indent(b, "    "))
    byRef.set(ref, list)
    uuids.set(id, issued())
  }

  let text = pcb
  if (byRef.size) {
    text = text.replace(/\n {2}\(footprint\b[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g, (block) => {
      const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
      const items = ref === undefined ? undefined : byRef.get(ref)
      if (!items?.length) return block
      return block.replace(/\n {2}\)$/, () => `\n${items.join("\n")}\n  )`)
    })
  }
  if (board.length) {
    const end = text.lastIndexOf("\n)")
    if (end >= 0) text = `${text.slice(0, end)}\n${board.join("\n")}${text.slice(end)}`
  }
  // The layer table lists the user layers a drawing is on; the ones KiCad always has are there already.
  const extra = [...layers].flatMap((name) => {
    const n = userLayerNumber(name)
    return n === null ? [] : [{ n, name }]
  }).sort((a, b) => a.n - b.n)
  if (extra.length) text = text.replace(/(\n {4}\(49 "F\.Fab" user\))/, (m) => `${m}${extra.map((e) => `\n    (${e.n} "${e.name}" user)`).join("")}`)
  if (added.length) {
    const nets2 = [...text.matchAll(/\n {2}\(net \d+ "(?:[^"\\]|\\.)*"\)/g)]
    const last = nets2[nets2.length - 1]
    if (last) text = `${text.slice(0, last.index + last[0].length)}${added.join("")}${text.slice(last.index + last[0].length)}`
  }

  const notes = ["Drawings (lines, arcs, circles, rectangles, polygons and curves on the board and in each part) are written as KiCad's own graphic items on their layers, with their stroke, dash and fill."]
  if (out.flattened.has("ellipse")) notes.push("KiCad 9 has no ellipse: ellipses and elliptical arcs are written as polygons and lines within 0.5 micrometre of the true curve.")
  if (out.flattened.has("hole")) notes.push("KiCad 9's polygon has no holes: a filled polygon with holes is written as one outline joined to its holes by zero-width bridges, with its edges drawn on top.")
  return { text, notes, uuids }
}
