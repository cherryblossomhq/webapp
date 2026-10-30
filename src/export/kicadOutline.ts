import { round } from "../lib/geometry"
import { flattenPath, type PathSeg } from "../model/shapes"
import type { Project, Vec2 } from "../model/types"
import { KICAD_PAGE_ORIGIN } from "./kicadShapes"
import { stableUuid } from "./kicadUuid"

// A board with an outline of its own, written into the board file as KiCad's own Edge.Cuts items: a line is `gr_line`, an arc
// `gr_arc` (three points, as KiCad 9 has it), a cubic curve `gr_curve`, a circle two half circle arcs, an elliptical arc the
// lines it flattens to (KiCad 9 has no ellipse). The converter writes the outline as straight lines from Circuit JSON, which has no
// arcs, so its own Edge.Cuts items are taken out and these put in. A board with no outline of its own is not touched, unless its corners are rounded: the converter
// writes each corner as a short run of lines, and the board is written with a true arc at each.

const mm6 = (n: number) => String(round(n, 6) || 0)
const toBoard = (p: Vec2): Vec2 => ({ x: KICAD_PAGE_ORIGIN + p.x, y: KICAD_PAGE_ORIGIN - p.y })
const xy = (p: Vec2) => {
  const q = toBoard(p)
  return `${mm6(q.x)} ${mm6(q.y)}`
}

export interface KicadOutline {
  text: string
  notes: string[]
}

const WIDTH = 0.1

/** A board with rounded corners and no outline of its own, as its edge: four lines and four arcs, the arcs a quarter circle of the corner radius each. */
function roundedBoardPaths(b: Project["board"]): { closed: boolean; segs: PathSeg[] }[] | null {
  const r = b.cornerRadius
  if (!(r > 0) || b.outline?.paths.length) return null
  const x0 = b.x - b.width / 2
  const x1 = b.x + b.width / 2
  const y0 = b.y - b.height / 2
  const y1 = b.y + b.height / 2
  if (r * 2 > Math.min(b.width, b.height) + 1e-9) return null
  const k = Math.SQRT1_2 * r
  const line = (a: Vec2, c: Vec2): PathSeg => ({ kind: "line", a, b: c })
  const arc = (start: Vec2, mid: Vec2, end: Vec2): PathSeg => ({ kind: "arc", start, mid, end })
  return [
    {
      closed: true,
      segs: [
        line({ x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }),
        arc({ x: x1 - r, y: y0 }, { x: x1 - r + k, y: y0 + r - k }, { x: x1, y: y0 + r }),
        line({ x: x1, y: y0 + r }, { x: x1, y: y1 - r }),
        arc({ x: x1, y: y1 - r }, { x: x1 - r + k, y: y1 - r + k }, { x: x1 - r, y: y1 }),
        line({ x: x1 - r, y: y1 }, { x: x0 + r, y: y1 }),
        arc({ x: x0 + r, y: y1 }, { x: x0 + r - k, y: y1 - r + k }, { x: x0, y: y1 - r }),
        line({ x: x0, y: y1 - r }, { x: x0, y: y0 + r }),
        arc({ x: x0, y: y0 + r }, { x: x0 + r - k, y: y0 + r - k }, { x: x0 + r, y: y0 }),
      ],
    },
  ]
}

export function applyOutline(pcb: string, project: Project): KicadOutline {
  const paths = project.board.outline?.paths ?? roundedBoardPaths(project.board)
  if (!paths) return { text: pcb, notes: [] }
  let serial = 0
  const uuid = () => stableUuid("8000", ++serial)
  const tail = () => [`(stroke`, `  (width ${WIDTH})`, `  (type solid)`, `)`, `(layer "Edge.Cuts")`, `(uuid ${uuid()})`]
  const block = (name: string, body: string[]) => [`  (${name}`, ...[...body, ...tail()].map((l) => `    ${l}`), `  )`].join("\n")
  let flattened = false
  const seg = (s: PathSeg): string[] => {
    switch (s.kind) {
      case "line":
        return [block("gr_line", [`(start ${xy(s.a)})`, `(end ${xy(s.b)})`])]
      case "arc":
        return [block("gr_arc", [`(start ${xy(s.start)})`, `(mid ${xy(s.mid)})`, `(end ${xy(s.end)})`])]
      case "bezier":
        return [block("gr_curve", [`(pts (xy ${xy(s.p0)}) (xy ${xy(s.c1)}) (xy ${xy(s.c2)}) (xy ${xy(s.p1)}))`])]
      case "ellipse": {
        flattened = true
        const pts = flattenPath({ closed: false, segs: [s] }, 0.0005)
        return pts.slice(1).map((p, i) => block("gr_line", [`(start ${xy(pts[i])})`, `(end ${xy(p)})`]))
      }
    }
  }
  const items = paths.flatMap((p) => p.segs.flatMap(seg))
  // Out with what the converter wrote on Edge.Cuts: its blocks are the top-level `gr_*` items of that layer.
  let text = pcb.replace(/\n {2}\(gr_(?:line|arc|circle|rect|poly|curve)\b[\s\S]*?\n {2}\)/g, (b) => (/\(layer "?Edge\.Cuts"?\)/.test(b) ? "" : b))
  const end = text.lastIndexOf("\n)")
  if (items.length && end >= 0) text = `${text.slice(0, end)}\n${items.join("\n")}${text.slice(end)}`
  const notes = ["The board outline is written as KiCad's own Edge.Cuts lines, arcs and curves, exactly."]
  if (flattened) notes.push("KiCad 9 has no ellipse: an elliptical piece of the outline is written as lines within 0.5 micrometre of the true curve.")
  return { text, notes }
}
