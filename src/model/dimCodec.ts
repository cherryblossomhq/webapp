import { isTextLayer } from "./texts"
import type { BoardDimension, DimensionKind, PcbGroup, ReferenceImage } from "./types"

// How dimensions, groups and reference images are written in a stored project. A KiCad board has up to hundreds of dimensions and groups with
// hundreds of members, and as objects each costs far more than it needs to. Stored, what dimensions share (layer, line width, arrow, units, digits and
// the text's own size and flags) is written once in a table, and a dimension is a short array that names its style and holds what is its own:
//
//   "dimStyles": [ { "l": "Dwgs.User", "th": 0.15, "ar": 1.27, "eh": 0.586, "eo": 0, "un": 2, "fm": 1, "pr": 4, "s": 1.5, "tw": 0.3, "k": 1 } ],
//   board:  "dm": [ [0, "A", 138.43, 54.62, 138.43, 36.82, 4.9, 141.53, 45.72, 0, 0], [1, "L", 10, 10, 12, 14, 0, 12, 14, 0, 0, "text"] ]
//
// The kind letters are A aligned, O orthogonal along x, V orthogonal along y, L leader, C centre, R radial. After the style and the kind come the two points,
// one number that is the height (A, O, V), the leader length (R) or the text frame (L), the text's place and angle, the id (0 for `dm<place + 1>`), and, when the dimension has text that replaces the measured value, that text. Groups are `[id, name, flags, ...members]` (flags: 1 locked, 2 a
// design block's id follows the flags before the members; the id is 0 for `gp<place + 1>`, or `g<place>` in a part), and reference images
// `[id, x, y, layer, scale, file, format, px, py, ppi, locked]` (id 0 for `im<place + 1>`). Nothing is rounded here: every number is as the model has it, and reading gives back what was written.
// Only the stored form is compact; in memory they are the objects the editor and the outputs use.

type Entry = (string | number)[]

export interface DimensionStyleDef {
  l: string
  th: number
  ar: number
  eh: number
  eo: number
  in?: 1
  tm?: 1 | 2
  kp?: 1
  un: number
  fm: number
  pr: number
  zr?: 1
  pf?: string
  sf?: string
  s: number
  w?: number
  tw?: number
  b?: 1
  i?: 1
  m?: 1
  hj?: "l" | "r"
  vj?: "t" | "b"
  sp?: number
  lk?: 1
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const KINDS: Record<string, DimensionKind> = { A: "aligned", O: "orthogonal", V: "orthogonal", L: "leader", C: "center", R: "radial" }

/** The id a board dimension has when none is stored. */
export const defaultDimensionId = (place: number) => `dm${place + 1}`

const styleOf = (d: BoardDimension): DimensionStyleDef => ({
  l: d.layer,
  th: d.thickness,
  ar: d.arrow,
  eh: d.extHeight,
  eo: d.extOffset,
  ...(d.inward ? { in: 1 as const } : {}),
  ...(d.textMode ? { tm: d.textMode } : {}),
  ...(d.keep ? { kp: 1 as const } : {}),
  un: d.units,
  fm: d.format,
  pr: d.precision,
  ...(d.zeros ? { zr: 1 as const } : {}),
  ...(d.prefix !== undefined ? { pf: d.prefix } : {}),
  ...(d.suffix !== undefined ? { sf: d.suffix } : {}),
  s: d.size,
  ...(d.w !== undefined ? { w: d.w } : {}),
  ...(d.tw !== undefined ? { tw: d.tw } : {}),
  ...(d.bold ? { b: 1 as const } : {}),
  ...(d.italic ? { i: 1 as const } : {}),
  ...(d.mirror ? { m: 1 as const } : {}),
  ...(d.hj ? { hj: d.hj === "left" ? ("l" as const) : ("r" as const) } : {}),
  ...(d.vj ? { vj: d.vj === "top" ? ("t" as const) : ("b" as const) } : {}),
  ...(d.spacing !== undefined ? { sp: d.spacing } : {}),
  ...(d.locked ? { lk: 1 as const } : {}),
})

type Style = Omit<BoardDimension, "id" | "kind" | "a" | "b" | "height" | "vertical" | "leaderLength" | "frame" | "override" | "x" | "y" | "rot">

function readStyle(raw: unknown): Style | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const d = raw as Partial<DimensionStyleDef>
  if (typeof d.l !== "string" || !isTextLayer(d.l) || !num(d.th) || !(d.th >= 0) || !num(d.ar) || !num(d.eh) || !num(d.eo) || !num(d.un) || !num(d.fm) || !num(d.pr) || !num(d.s) || !(d.s > 0)) return null
  return {
    layer: d.l,
    thickness: d.th,
    arrow: d.ar,
    extHeight: d.eh,
    extOffset: d.eo,
    ...(d.in === 1 ? { inward: true as const } : {}),
    ...(d.tm === 1 || d.tm === 2 ? { textMode: d.tm } : {}),
    ...(d.kp === 1 ? { keep: true as const } : {}),
    units: d.un,
    format: d.fm,
    precision: d.pr,
    ...(d.zr === 1 ? { zeros: true as const } : {}),
    ...(typeof d.pf === "string" ? { prefix: d.pf } : {}),
    ...(typeof d.sf === "string" ? { suffix: d.sf } : {}),
    size: d.s,
    ...(num(d.w) && d.w > 0 ? { w: d.w } : {}),
    ...(num(d.tw) && d.tw >= 0 ? { tw: d.tw } : {}),
    ...(d.b === 1 ? { bold: true as const } : {}),
    ...(d.i === 1 ? { italic: true as const } : {}),
    ...(d.m === 1 ? { mirror: true as const } : {}),
    ...(d.hj === "l" ? { hj: "left" as const } : d.hj === "r" ? { hj: "right" as const } : {}),
    ...(d.vj === "t" ? { vj: "top" as const } : d.vj === "b" ? { vj: "bottom" as const } : {}),
    ...(num(d.sp) && d.sp > 0 ? { spacing: d.sp } : {}),
    ...(d.lk === 1 ? { locked: true as const } : {}),
  }
}

/** Builds the style table as dimensions are packed: one entry per distinct style, in the order first met. */
class Styles {
  readonly list: DimensionStyleDef[] = []
  private index = new Map<string, number>()
  of(d: BoardDimension): number {
    const def = styleOf(d)
    const key = JSON.stringify(def)
    let at = this.index.get(key)
    if (at === undefined) {
      at = this.list.length
      this.list.push(def)
      this.index.set(key, at)
    }
    return at
  }
}

const letterOf = (d: BoardDimension) => (d.kind === "aligned" ? "A" : d.kind === "orthogonal" ? (d.vertical ? "V" : "O") : d.kind === "leader" ? "L" : d.kind === "center" ? "C" : "R")
const ownOf = (d: BoardDimension) => (d.kind === "aligned" || d.kind === "orthogonal" ? (d.height ?? 0) : d.kind === "radial" ? (d.leaderLength ?? 0) : d.kind === "leader" ? (d.frame ?? 0) : 0)

function entryOf(styles: Styles, d: BoardDimension, defaultId: string): Entry {
  const head: Entry = [styles.of(d), letterOf(d), d.a.x, d.a.y, d.b.x, d.b.y, ownOf(d), d.x, d.y, d.rot, d.id === defaultId ? 0 : d.id]
  return d.override !== undefined ? [...head, d.override] : head
}

export interface PackedDimensions {
  dimStyles?: DimensionStyleDef[]
  dm?: Entry[]
}

/** The dimensions of a project as stored. The caller drops `dimensions` from the project. */
export function packDimensions(dimensions: BoardDimension[]): PackedDimensions {
  const styles = new Styles()
  const dm = dimensions.map((d, place) => entryOf(styles, d, defaultDimensionId(place)))
  return { ...(styles.list.length ? { dimStyles: styles.list } : {}), ...(dm.length ? { dm } : {}) }
}

function readEntry(styles: (Style | null)[], e: unknown, defaultId: (place: number) => string, place: number): BoardDimension | null {
  if (!Array.isArray(e) || typeof e[1] !== "string") return null
  const style = num(e[0]) ? styles[e[0]] : null
  const kind = KINDS[e[1]]
  if (!style || !kind || ![2, 3, 4, 5, 6, 7, 8, 9].every((i) => num(e[i]))) return null
  const [, , ax, ay, bx, by, own, x, y, rot] = e as number[]
  const id = typeof e[10] === "string" && e[10] ? e[10] : defaultId(place)
  const over = typeof e[11] === "string" ? e[11] : undefined
  const frame = kind === "leader" && (own === 1 || own === 2 || own === 3) ? (own as 1 | 2 | 3) : undefined
  return {
    ...style,
    id,
    kind,
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    ...((kind === "aligned" || kind === "orthogonal") && own !== 0 ? { height: own } : {}),
    ...(e[1] === "V" ? { vertical: true as const } : {}),
    ...(kind === "radial" ? { leaderLength: own } : {}),
    ...(frame ? { frame } : {}),
    ...(over !== undefined ? { override: over } : {}),
    x,
    y,
    rot,
  }
}

/** The dimensions from stored entries; one that does not read, or whose id is taken, is dropped. */
export function unpackDimensions(raw: unknown, styles: DimensionStyleDef[]): BoardDimension[] {
  if (!Array.isArray(raw)) return []
  const read = styles.map(readStyle)
  const seen = new Set<string>()
  const out: BoardDimension[] = []
  raw.forEach((e, place) => {
    const d = readEntry(read, e, defaultDimensionId, place)
    if (!d || seen.has(d.id)) return
    seen.add(d.id)
    out.push(d)
  })
  return out
}

// ---------- groups ----------

export const defaultGroupId = (place: number) => `gp${place + 1}`
export const defaultPartGroupId = (place: number) => `g${place}`

export function packGroups(groups: PcbGroup[], defaultId: (place: number) => string = defaultGroupId): Entry[] {
  return groups.map((g, place): Entry => [g.id === defaultId(place) ? 0 : g.id, g.name, g.locked ? 1 : 0, ...g.members])
}

/** Groups from stored entries; one that does not read, or whose id is taken, is dropped. */
export function unpackGroups(raw: unknown, defaultId: (place: number) => string = defaultGroupId): PcbGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: PcbGroup[] = []
  raw.forEach((e, place) => {
    if (!Array.isArray(e) || typeof e[1] !== "string" || !num(e[2]) || e.length < 3) return
    const flags = e[2]
    // Flag 2 was a design block's name before the members, which nothing reads now.
    const members = e.slice(flags & 2 ? 4 : 3)
    if (!members.every((m): m is string => typeof m === "string" && m !== "")) return
    const id = typeof e[0] === "string" && e[0] ? e[0] : defaultId(place)
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, name: e[1], members: members as string[], ...(flags & 1 ? { locked: true as const } : {}) })
  })
  return out
}

// ---------- reference images ----------

export const defaultImageId = (place: number) => `im${place + 1}`

export function packImages(images: ReferenceImage[]): Entry[] {
  return images.map((m, place): Entry => [m.id === defaultImageId(place) ? 0 : m.id, m.x, m.y, m.layer, m.scale, m.file, m.format, m.px, m.py, m.ppi, m.locked ? 1 : 0])
}

/** Images from stored entries; one that does not read, or whose id is taken, is dropped. */
export function unpackImages(raw: unknown): ReferenceImage[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: ReferenceImage[] = []
  raw.forEach((e, place) => {
    if (!Array.isArray(e) || e.length < 11) return
    const [id0, x, y, layer, scale, file, format, px, py, ppi, locked] = e
    if (!num(x) || !num(y) || typeof layer !== "string" || !isTextLayer(layer) || !num(scale) || !(scale > 0) || typeof file !== "string" || !/^[0-9a-f]{64}$/.test(file)) return
    if ((format !== "png" && format !== "jpg") || !num(px) || !(px > 0) || !num(py) || !(py > 0) || !num(ppi) || !(ppi > 0)) return
    const id = typeof id0 === "string" && id0 ? id0 : defaultImageId(place)
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, x, y, layer, scale, file, format, px, py, ppi, ...(locked === 1 ? { locked: true as const } : {}) })
  })
  return out
}
