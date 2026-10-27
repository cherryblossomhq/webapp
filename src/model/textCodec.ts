import { isTextLayer } from "./texts"
import type { BoardText, ComponentInstance, PartText, TextAttrs } from "./types"

// How text objects are written in a stored project. A KiCad board has up to tens of thousands of them (every
// part has a reference and a value, most have more), and as objects each costs 150 to 250 bytes. Stored, the
// style that texts share (layer, size, thickness, justification, flags) is written once in a table, and a text
// is a short array that names its style and holds what is its own:
//
//   "textStyles": [ { "l": "F.SilkS", "s": 1, "t": 0.15, "h": "l" } ],
//   a part:  "tx": [ [0, "R", 1.5, -2, 90], [1, "U", 0, 3, 0, "%R"], [1, "v", 0, 0, 0, "10k"] ]
//   board:   "kt": [ [2, "T", 10, 5, 0, "TEXT", 0] ]
//
// A part's own entries are on its component (`tx`, replacing the in-memory `texts`); board text is a list of its
// own at the top of the project (`kt`, beside `texts`, which keeps the editor's own silkscreen text as objects).
// The kind letter: R reference, V value, U text of its own, T board text; a lowercase R or V carries the text it
// shows when that is not the part's reference or value; a `+` after it says a text box follows the rest
// (width, height, border width or -1, margins left, top, right and bottom). A board text ends with its id, 0 when it
// is `kt<place + 1>`. Nothing is rounded here: every number is as the model has it, and reading gives back what was written.
// Only the stored form is compact; in memory a text is the object the editor and the outputs use.

export interface TextStyleDef {
  l: string
  s: number
  w?: number
  t?: number
  b?: 1
  i?: 1
  m?: 1
  k?: 1
  h?: "l" | "r"
  v?: "t" | "b"
  sp?: number
  u?: 0
  d?: 1
  c?: 1
}

type Entry = (string | number)[]

type Styled = TextAttrs & { layer: string; size: number }

const styleOf = (t: Styled): TextStyleDef => ({
  l: t.layer,
  s: t.size,
  ...(t.w !== undefined ? { w: t.w } : {}),
  ...(t.thickness !== undefined ? { t: t.thickness } : {}),
  ...(t.bold ? { b: 1 as const } : {}),
  ...(t.italic ? { i: 1 as const } : {}),
  ...(t.mirror ? { m: 1 as const } : {}),
  ...(t.knockout ? { k: 1 as const } : {}),
  ...(t.hj ? { h: t.hj === "left" ? ("l" as const) : ("r" as const) } : {}),
  ...(t.vj ? { v: t.vj === "top" ? ("t" as const) : ("b" as const) } : {}),
  ...(t.spacing !== undefined ? { sp: t.spacing } : {}),
  ...(t.upright === false ? { u: 0 as const } : {}),
  ...(t.hide ? { d: 1 as const } : {}),
  ...(t.locked ? { c: 1 as const } : {}),
})

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** A style as the attributes and size it stands for, or null when it does not read. */
function readStyle(raw: unknown): (TextAttrs & { layer: string; size: number }) | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const d = raw as Partial<TextStyleDef>
  if (typeof d.l !== "string" || !isTextLayer(d.l) || !num(d.s) || !(d.s > 0)) return null
  return {
    layer: d.l,
    size: d.s,
    ...(num(d.w) && d.w > 0 ? { w: d.w } : {}),
    ...(num(d.t) && d.t >= 0 ? { thickness: d.t } : {}),
    ...(d.b === 1 ? { bold: true as const } : {}),
    ...(d.i === 1 ? { italic: true as const } : {}),
    ...(d.m === 1 ? { mirror: true as const } : {}),
    ...(d.k === 1 ? { knockout: true as const } : {}),
    ...(d.h === "l" ? { hj: "left" as const } : d.h === "r" ? { hj: "right" as const } : {}),
    ...(d.v === "t" ? { vj: "top" as const } : d.v === "b" ? { vj: "bottom" as const } : {}),
    ...(num(d.sp) && d.sp > 0 ? { spacing: d.sp } : {}),
    ...(d.u === 0 ? { upright: false as const } : {}),
    ...(d.d === 1 ? { hide: true as const } : {}),
    ...(d.c === 1 ? { locked: true as const } : {}),
  }
}

/** Builds the style table as texts are packed: one entry per distinct style, in the order first met. */
class Styles {
  readonly list: TextStyleDef[] = []
  private index = new Map<string, number>()
  of(t: Styled): number {
    const def = styleOf(t)
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

const boxTail = (t: TextAttrs): (string | number)[] => (t.box ? [t.box.w, t.box.h, t.box.border ?? -1, ...t.box.margins] : [])

function partEntry(styles: Styles, t: PartText): Entry {
  const style = styles.of(t)
  const plus = t.box ? "+" : ""
  const tail = boxTail(t)
  if (t.kind === "user") return [style, `U${plus}`, t.x, t.y, t.rot, t.text ?? "", ...tail]
  const letter = t.kind === "reference" ? "R" : "V"
  return t.text !== undefined ? [style, `${letter.toLowerCase()}${plus}`, t.x, t.y, t.rot, t.text, ...tail] : [style, `${letter}${plus}`, t.x, t.y, t.rot, ...tail]
}

function boardEntry(styles: Styles, t: BoardText & { layer: string }, place: number): Entry {
  return [styles.of(t), `T${t.box ? "+" : ""}`, t.x, t.y, t.rot, t.text, t.id === defaultTextId(place) ? 0 : t.id, ...boxTail(t)]
}

/** The id a board text has when none is stored. */
export const defaultTextId = (place: number) => `kt${place + 1}`

export interface PackedTexts {
  textStyles?: TextStyleDef[]
  /** Board text of KiCad's kind. */
  kt?: Entry[]
  /** Where each of `kt` stood among all the board's texts, when they are not all after the editor's own (the order a load gives back). */
  kp?: number[]
  /** Per component id, the entries of its text. */
  tx?: Record<string, Entry[]>
}

/** The texts of a project as stored. The caller drops `texts` from components and the KiCad ones from the project's list. */
export function packTexts(texts: BoardText[], components: ComponentInstance[]): PackedTexts {
  const styles = new Styles()
  const board = texts.filter((t): t is BoardText & { layer: string } => t.layer !== undefined)
  const kt = board.map((t, place) => boardEntry(styles, t, place))
  const positions = texts.flatMap((t, i) => (t.layer !== undefined ? [i] : []))
  const own = texts.length - positions.length
  const tail = positions.every((p, i) => p === own + i)
  const tx: Record<string, Entry[]> = {}
  for (const c of components) if (c.texts) tx[c.id] = c.texts.map((t) => partEntry(styles, t))
  return {
    ...(styles.list.length ? { textStyles: styles.list } : {}),
    ...(kt.length ? { kt } : {}),
    ...(kt.length && !tail ? { kp: positions } : {}),
    ...(Object.keys(tx).length ? { tx } : {}),
  }
}

function readBox(e: Entry, at: number): TextAttrs["box"] | null {
  const v = e.slice(at, at + 7)
  if (v.length !== 7 || !v.every(num)) return null
  const [w, h, border, l, t, r, b] = v as number[]
  if (!(w > 0) || !(h > 0)) return null
  return { w, h, ...(border >= 0 ? { border } : {}), margins: [l, t, r, b] }
}

const sideOfLayer = (layer: string): "top" | "bottom" => (layer.startsWith("B.") ? "bottom" : "top")

/** A part's text from an entry, or null when it does not read. */
function readPartEntry(styles: (ReturnType<typeof readStyle>)[], e: unknown): PartText | null {
  if (!Array.isArray(e) || typeof e[1] !== "string") return null
  const style = num(e[0]) ? styles[e[0]] : null
  const letter = e[1][0]
  const plus = e[1].endsWith("+")
  if (!style || !"RVrvU".includes(letter) || !num(e[2]) || !num(e[3]) || !num(e[4])) return null
  const hasText = letter === "r" || letter === "v" || letter === "U"
  if (hasText && typeof e[5] !== "string") return null
  const box = plus ? readBox(e, hasText ? 6 : 5) : undefined
  if (box === null) return null
  const kind = letter === "U" ? "user" : letter.toUpperCase() === "R" ? "reference" : "value"
  return { ...style, kind, ...(hasText ? { text: e[5] as string } : {}), x: e[2], y: e[3], rot: e[4], ...(box ? { box } : {}) }
}

/** The texts of a part from the stored entries; one that does not read is dropped. Undefined when the field is not a list. */
export function unpackPartTexts(raw: unknown, styles: TextStyleDef[]): PartText[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const read = styles.map(readStyle)
  return raw.flatMap((e) => readPartEntry(read, e) ?? [])
}

/** A part's texts written as objects (a hand-written file): each that reads as one. */
export function normalizePartTexts(raw: unknown): PartText[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PartText[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const t = item as Record<string, unknown>
    if (!["reference", "value", "user"].includes(t.kind as string) || !num(t.x) || !num(t.y) || !num(t.rot) || (t.text !== undefined && typeof t.text !== "string")) continue
    const style = readStyle({ l: t.layer, s: t.size, w: t.w, t: t.thickness, b: t.bold ? 1 : 0, i: t.italic ? 1 : 0, m: t.mirror ? 1 : 0, k: t.knockout ? 1 : 0, h: t.hj === "left" ? "l" : t.hj === "right" ? "r" : undefined, v: t.vj === "top" ? "t" : t.vj === "bottom" ? "b" : undefined, sp: t.spacing, u: t.upright === false ? 0 : undefined, d: t.hide ? 1 : 0, c: t.locked ? 1 : 0 })
    if (!style) continue
    const b = t.box as { w?: unknown; h?: unknown; border?: unknown; margins?: unknown } | undefined
    const box = b ? readBox(["", "", b.w as number, b.h as number, num(b.border) ? b.border : -1, ...((Array.isArray(b.margins) ? b.margins : []) as number[])].slice(2) as Entry, 0) : undefined
    if (b && !box) continue
    out.push({ ...style, kind: t.kind as PartText["kind"], ...(t.text !== undefined ? { text: t.text as string } : {}), x: t.x, y: t.y, rot: t.rot, ...(box ? { box } : {}) })
  }
  return out
}

/** Board text from the stored entries, or objects of a hand-written file; each is a text once, with an id once. */
export function unpackBoardTexts(raw: unknown, styles: TextStyleDef[]): BoardText[] {
  if (!Array.isArray(raw)) return []
  const read = styles.map(readStyle)
  const out: BoardText[] = []
  const seen = new Set<string>()
  raw.forEach((e, place) => {
    if (!Array.isArray(e) || typeof e[1] !== "string") return
    const style = num(e[0]) ? read[e[0]] : null
    const plus = e[1].endsWith("+")
    if (!style || e[1][0] !== "T" || !num(e[2]) || !num(e[3]) || !num(e[4]) || typeof e[5] !== "string") return
    const box = plus ? readBox(e, 7) : undefined
    if (box === null) return
    const id = typeof e[6] === "string" && e[6] ? e[6] : defaultTextId(place)
    if (seen.has(id)) return
    seen.add(id)
    out.push({ ...style, id, text: e[5], x: e[2], y: e[3], rot: e[4], side: sideOfLayer(style.layer), ...(box ? { box } : {}) })
  })
  return out
}

/** Board text written as objects with a layer (a hand-written file): each that reads as one, with an id once. */
export function normalizeBoardTextObjects(raw: unknown[], taken: Set<string>): BoardText[] {
  const out: BoardText[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const t = item as Record<string, unknown>
    if (typeof t.id !== "string" || !t.id || taken.has(t.id) || typeof t.text !== "string" || !num(t.x) || !num(t.y) || !num(t.rot)) continue
    const [part] = normalizePartTexts([{ ...t, kind: "user" }]) ?? []
    if (!part) continue
    const { kind: _kind, text: _text, x: _x, y: _y, rot: _rot, ...attrs } = part
    // Board text cannot be hidden.
    const { hide: _hide, upright: _upright, ...rest } = attrs
    taken.add(t.id)
    out.push({ ...rest, id: t.id, text: t.text, x: t.x, y: t.y, rot: t.rot, side: sideOfLayer(attrs.layer) })
  }
  return out
}
