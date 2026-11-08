// The step from version 5 to 6 (see `projectFile.ts`): every sheet is a page. Each sheet gets the smallest landscape A4 to A0 that holds
// its drawing, so a project opens with every drawing on its page; the first copy to open it writes it whole, so the page is stored once and
// never worked out again. Plain JSON in and out: the sizes and the border are copied here from `model/paper.ts` as they were when this
// shipped, and the drawing's box is estimated from the points the document stores.

type Json = Record<string, unknown>
type Box = { minX: number; minY: number; maxX: number; maxY: number }

/** A schematic unit in mm. */
const UNIT = 12.7
/** Landscape A4 to A0, in mm. */
const SIZES: [string, number, number][] = [
  ["A4", 297, 210],
  ["A3", 420, 297],
  ["A2", 594, 420],
  ["A1", 841, 594],
  ["A0", 1189, 841],
]
/** KiCad's default drawing sheet: the margin and strip to the inner frame, and the title block against its bottom-right corner, in mm. */
const FRAME = 12
const TITLE_W = 108
const TITLE_H = 32
/** A4 landscape about the origin: the page of a sheet with nothing on it. */
const DEFAULT_PAPER = { size: "A4", x: -11.7, y: 8.3 }

/**
 * How far a part's drawing can reach from where it is placed, in sheet units. The stored point is the symbol's origin, which for the
 * editor's own symbols is about their middle and for a KiCad one its anchor; 1.5 (19 mm) takes in a box symbol of some twenty pins a side
 * with its designator, value and pin names, and the frame and title of the block around it.
 */
const PART_REACH = 1.5
/** How far a label's or a text's words can reach past what is stored for it, beyond what their length gives. */
const TEXT_REACH = 0.3

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : [])
const grid = (v: number) => Math.round(Math.round(v / 0.1) * 0.1 * 10000) / 10000

function grow(b: Box, x: unknown, y: unknown, reach = 0) {
  if (!num(x) || !num(y)) return
  b.minX = Math.min(b.minX, x - reach)
  b.maxX = Math.max(b.maxX, x + reach)
  b.minY = Math.min(b.minY, y - reach)
  b.maxY = Math.max(b.maxY, y + reach)
}

function points(b: Box, pts: unknown, reach = 0) {
  for (const p of list(pts)) grow(b, p.x, p.y, reach)
}

/** What a drawing covers, near enough: its points, its box, and a text's words. */
function drawing(b: Box, d: Json) {
  const size = num(d.size) ? d.size : 0.14
  if (typeof d.text === "string" && num(d.x) && num(d.y)) {
    const lines = d.text.split("\n")
    const reach = Math.max(...lines.map((l) => l.length)) * size * 0.7 + TEXT_REACH
    grow(b, d.x, d.y, reach)
    grow(b, d.x, (d.y as number) - lines.length * size * 1.3, reach)
  }
  grow(b, d.x, d.y, TEXT_REACH)
  if (num(d.x) && num(d.y)) {
    // A rectangle from its lower-left corner; a KiCad text box from a corner its turn decides, so either way.
    if (num(d.width) && num(d.height)) grow(b, d.x + d.width, d.y + d.height, TEXT_REACH)
    if (num(d.w) && num(d.h)) {
      grow(b, d.x - d.w, d.y - d.h, TEXT_REACH)
      grow(b, d.x + d.w, d.y + d.h, TEXT_REACH)
    }
    if (num(d.radius)) grow(b, d.x, d.y, d.radius)
    // A picture about its middle: its pixels at its resolution, an inch being two units.
    if (num(d.px) && num(d.py)) {
      const half = (num(d.scale) ? d.scale : 1) / (num(d.ppi) && d.ppi > 0 ? d.ppi : 300)
      grow(b, d.x - d.px * half, d.y - d.py * half, TEXT_REACH)
      grow(b, d.x + d.px * half, d.y + d.py * half, TEXT_REACH)
    }
  }
  points(b, d.points, TEXT_REACH)
  for (const k of ["start", "mid", "end"]) if (d[k] && typeof d[k] === "object") grow(b, (d[k] as Json).x, (d[k] as Json).y, TEXT_REACH)
  for (const c of list(d.cells)) {
    grow(b, c.x, c.y, TEXT_REACH)
    if (num(c.x) && num(c.y) && num(c.w) && num(c.h)) grow(b, c.x + c.w, c.y - c.h, TEXT_REACH)
  }
}

const empty = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

/** A page of a size with its corner at (x, y), as the inner frame and the title block. */
function frames(w: number, h: number, x: number, y: number) {
  const inner = { minX: x + FRAME / UNIT, maxX: x + (w - FRAME) / UNIT, maxY: y - FRAME / UNIT, minY: y - (h - FRAME) / UNIT }
  const title = { minX: inner.maxX - TITLE_W / UNIT, maxY: inner.minY + TITLE_H / UNIT }
  return { inner, title }
}

const E = 1e-6

/** Inside the inner frame and clear of the title block (above it or left of it). */
function holds(w: number, h: number, x: number, y: number, b: Box): boolean {
  const { inner, title } = frames(w, h, x, y)
  if (b.minX < inner.minX - E || b.maxX > inner.maxX + E || b.minY < inner.minY - E || b.maxY > inner.maxY + E) return false
  return b.minY >= title.maxY - E || b.maxX <= title.minX + E
}

/** A page of a size placed with the box in the middle of the first free region it fits (above the title block, else left of it), or null. */
function around(w: number, h: number, b: Box): { x: number; y: number } | null {
  const { inner, title } = frames(w, h, 0, 0)
  const regions = [
    { ...inner, minY: title.maxY },
    { ...inner, maxX: title.minX },
  ]
  for (const r of regions) {
    if (b.maxX - b.minX > r.maxX - r.minX + E || b.maxY - b.minY > r.maxY - r.minY + E) continue
    const x = grid((b.minX + b.maxX) / 2 - (r.minX + r.maxX) / 2)
    const y = grid((b.minY + b.maxY) / 2 - (r.minY + r.maxY) / 2)
    if (holds(w, h, x, y, b)) return { x, y }
  }
  return null
}

function paperFor(b: Box, kicad: boolean): Json {
  if (!Number.isFinite(b.minX)) return { ...DEFAULT_PAPER }
  for (const [size, w, h] of SIZES) {
    if (kicad) {
      // A sheet read from KiCad has its page where KiCad has it: the top-left corner at the origin.
      if (holds(w, h, 0, 0, b)) return { size, x: 0, y: 0 }
      continue
    }
    const at = around(w, h, b)
    if (at) return { size, ...at }
  }
  const [size, w, h] = SIZES[SIZES.length - 1]
  return { size, x: grid((b.minX + b.maxX) / 2 - w / UNIT / 2), y: grid((b.minY + b.maxY) / 2 + h / UNIT / 2) }
}

export function sheetPaper(project: Json): Json {
  const sheets = list(project.sheets)
  const all = sheets.some((s) => s.id === "root") ? sheets : [{ id: "root" }, ...sheets]
  const boxes = new Map<string, Box>(all.map((s) => [String(s.id), empty()]))
  const at = (sheet: unknown) => boxes.get(typeof sheet === "string" ? sheet : "root")
  // A part is on the sheet its use is of: the last sheet symbol of the use's path stands for it.
  const childOf = new Map(list(project.sheetSymbols).map((s) => [String(s.id), String(s.child)]))
  for (const c of list(project.components)) {
    const inst = typeof c.inst === "string" ? c.inst : ""
    const sheet = inst ? childOf.get(inst.slice(inst.lastIndexOf("/") + 1)) : "root"
    const sch = c.sch as Json | undefined
    const b = at(sheet)
    if (b && sch) grow(b, sch.x, sch.y, PART_REACH)
  }
  for (const w of list(project.wires)) {
    const b = at(w.sheet)
    if (b) points(b, w.points)
  }
  for (const l of list(project.labels)) {
    const b = at(l.sheet)
    if (b) grow(b, l.x, l.y, (typeof l.name === "string" ? l.name.length * 0.06 : 0) + TEXT_REACH)
  }
  for (const s of list(project.sheetSymbols)) {
    const b = at(s.sheet)
    if (!b || !num(s.x) || !num(s.y) || !num(s.w) || !num(s.h)) continue
    grow(b, s.x, s.y, TEXT_REACH)
    grow(b, s.x + s.w, s.y + s.h, TEXT_REACH)
  }
  for (const d of list(project.drawings)) {
    const b = at(d.sheet)
    if (b) drawing(b, d)
  }
  const kicad = list(project.properties).some((p) => p.key === "KiCad file version")
  return { ...project, sheets: all.map((s) => ({ ...s, paper: paperFor(boxes.get(String(s.id))!, kicad) })) }
}
