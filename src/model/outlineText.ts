import { dist, round } from "../lib/geometry"
import { outlineGeometry } from "./outline"
import { circlePath, slotPath } from "./outlineOps"
import { arcCircle, flattenSeg, segEnd, segStart, type PathSeg, type ShapePath } from "./shapes"
import type { BoardDef, Vec2 } from "./types"

// A board outline as a short text, for Sakura to read in `get_design` and to write in `set_board`. Each shape starts with `M x y`
// and goes on with `L x y` (a straight edge), `A mx my x y` (an arc through the middle point to the end) or
// `C c1x c1y c2x c2y x y` (a curve); `Z` closes it. `O cx cy r` is a circle and `S x1 y1 x2 y2 w` a slot of width w between two
// centres, each a shape of its own. Millimetres, y up, as the board is.

const MAX_SEGMENTS = 4000
const MAX_COORD = 5000

const f = (n: number) => String(round(n, 3))
const p = (v: Vec2) => `${f(v.x)} ${f(v.y)}`

/** The text for some paths: closed ones end in `Z`, open ones are left as they are. Elliptical pieces are written as short straight ones. */
export function outlineToText(paths: ShapePath[]): string {
  return paths
    .map((path) => {
      const parts = [`M${p(segStart(path.segs[0]))}`]
      for (const s of path.segs) {
        if (s.kind === "line") parts.push(`L${p(s.b)}`)
        else if (s.kind === "arc") parts.push(`A${p(s.mid)} ${p(s.end)}`)
        else if (s.kind === "bezier") parts.push(`C${p(s.c1)} ${p(s.c2)} ${p(s.p1)}`)
        else for (const q of flattenSeg(s, 0.01).slice(1)) parts.push(`L${p(q)}`)
      }
      if (path.closed) {
        // The last piece ends where the first began: say so with Z rather than a repeated point.
        const last = parts[parts.length - 1]
        if (last.startsWith("L") && last.slice(1) === parts[0].slice(1)) parts.pop()
        parts.push("Z")
      }
      return parts.join(" ")
    })
    .join(" ")
}

export interface ParsedOutline {
  paths: ShapePath[]
}

/** The paths a text describes, or the sentence that says what is wrong with it. */
export function parseOutlineText(text: string): ParsedOutline | { error: string } {
  const tokens = text.match(/[MLACSOZmlacsoz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
  if (!tokens || !tokens.length) return { error: "The outline text is empty" }
  const paths: ShapePath[] = []
  let segs: PathSeg[] = []
  let start: Vec2 | null = null
  let cur: Vec2 | null = null
  let total = 0
  let i = 0
  const finish = (closed: boolean): string | null => {
    if (!segs.length) {
      start = cur = null
      return null
    }
    if (closed) {
      if (cur && start && (cur.x !== start.x || cur.y !== start.y)) {
        // A shape closed with Z ends with the straight edge back to where it began, unless its last piece already does.
        if (dist(cur, start) < 1e-9) segs[segs.length - 1] = { ...segs[segs.length - 1], ...(segs[segs.length - 1].kind === "line" ? { b: start } : {}) } as PathSeg
        else segs.push({ kind: "line", a: cur, b: start })
      }
      if (segs.length < 2 && !(segs[0].kind === "arc" && dist(segs[0].start, segs[0].end) < 1e-9)) return "A closed shape needs at least three corners"
      const area = new Set(segs.map((s) => `${f(segStart(s).x)},${f(segStart(s).y)}`)).size
      if (area < 3 && !segs.some((s) => s.kind !== "line")) return "A closed shape needs at least three different corners"
    }
    paths.push({ closed, segs })
    segs = []
    start = cur = null
    return null
  }
  const nums = (n: number): number[] | null => {
    const out: number[] = []
    for (let k = 0; k < n; k++) {
      const t = tokens[i + 1 + k]
      if (t === undefined || /^[a-z]$/i.test(t)) return null
      const v = Number(t)
      if (!Number.isFinite(v) || Math.abs(v) > MAX_COORD) return null
      out.push(v)
    }
    i += n
    return out
  }
  for (i = 0; i < tokens.length; i++) {
    const cmd = tokens[i].toUpperCase()
    if (!/^[MLACSOZ]$/.test(cmd)) return { error: `Unexpected "${tokens[i]}" in the outline text: each number belongs to a command M, L, A, C, S, O or Z` }
    if (++total > MAX_SEGMENTS) return { error: `The outline text has more than ${MAX_SEGMENTS} pieces` }
    if (cmd === "Z") {
      if (!start) return { error: "Z closes a shape that has been started with M" }
      const e = finish(true)
      if (e) return { error: e }
      continue
    }
    if (cmd === "M") {
      const e = finish(false)
      if (e) return { error: e }
      const v = nums(2)
      if (!v) return { error: "M needs two numbers: M x y" }
      start = cur = { x: v[0], y: v[1] }
      continue
    }
    if (cmd === "O" || cmd === "S") {
      const e = finish(false)
      if (e) return { error: e }
      const v = nums(cmd === "O" ? 3 : 5)
      if (!v) return { error: cmd === "O" ? "O needs three numbers: O cx cy r" : "S needs five numbers: S x1 y1 x2 y2 width" }
      if (cmd === "O") {
        if (!(v[2] > 0)) return { error: "A circle's radius must be above 0" }
        paths.push(circlePath({ x: v[0], y: v[1] }, v[2]))
      } else {
        if (!(v[4] > 0)) return { error: "A slot's width must be above 0" }
        paths.push(slotPath({ x: v[0], y: v[1] }, { x: v[2], y: v[3] }, v[4]))
      }
      continue
    }
    if (!cur) return { error: `${cmd} needs a shape started with M` }
    const n = cmd === "L" ? 2 : cmd === "A" ? 4 : 6
    const v = nums(n)
    if (!v) return { error: `${cmd} needs ${n} numbers` }
    if (cmd === "L") {
      const b = { x: v[0], y: v[1] }
      if (dist(cur, b) > 0) segs.push({ kind: "line", a: cur, b })
      cur = b
    } else if (cmd === "A") {
      const mid = { x: v[0], y: v[1] }
      const end = { x: v[2], y: v[3] }
      if (!arcCircle(cur, mid, end)) return { error: "An arc's three points must not lie on one line" }
      segs.push({ kind: "arc", start: cur, mid, end })
      cur = end
    } else {
      const end = { x: v[4], y: v[5] }
      segs.push({ kind: "bezier", p0: cur, c1: { x: v[0], y: v[1] }, c2: { x: v[2], y: v[3] }, p1: end })
      cur = end
    }
  }
  const e = finish(false)
  if (e) return { error: e }
  // A path whose end meets its start is a loop even without Z.
  const closedUp = paths.map((path): ShapePath => {
    if (path.closed || path.segs.length < 2) return path
    const a = segStart(path.segs[0])
    const b = segEnd(path.segs[path.segs.length - 1])
    return dist(a, b) < 1e-9 ? { closed: true, segs: path.segs } : path
  })
  if (!closedUp.length) return { error: "The outline text has no shape" }
  return { paths: closedUp }
}

/** The cutouts of a board as text, one per cutout, in the order `remove_cutouts` counts them. */
export function cutoutTexts(b: Pick<BoardDef, "outline">): { path: number; text: string }[] {
  const g = outlineGeometry(b)
  if (!g || !b.outline) return []
  return g.rings.filter((r) => r.hole).map((r) => ({ path: r.path, text: outlineToText([b.outline!.paths[r.path]]) }))
}

/** The board's edge as text without its cutouts: the pieces of board and any open edges. */
export function edgeText(b: Pick<BoardDef, "outline">): string {
  if (!b.outline) return ""
  const g = outlineGeometry(b)
  const holes = new Set(g?.rings.filter((r) => r.hole).map((r) => r.path) ?? [])
  return outlineToText(b.outline.paths.filter((_, i) => !holes.has(i)))
}
