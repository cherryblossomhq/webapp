// A KiCad file read with the place of every part kept, so a piece of it can be copied out or cut out by its bytes
// and the rest left exactly as it was. `parseSexpr` (model/kicad/sexpr.ts) drops the spelling of numbers and the
// layout of the text; this keeps both, because the whole point of keeping a user's own file is that what the user
// did not change stays byte for byte.

/** A piece of the text: `end` is one past the last character. */
export interface Span {
  start: number
  end: number
}

/** A node of the file: a list `(head ...)` or an atom, with its place in the text. */
export interface SNode extends Span {
  /** The atom's text as written (with its quotes); undefined for a list. */
  raw?: string
  /** The atom's value (quotes taken off, escapes read); undefined for a list. */
  value?: string
  /** A list's children, atoms and lists, in order. The first is the head atom. */
  kids?: SNode[]
  /** The list's first atom's value (`pad` for `(pad "1" ...)`), or "" for an atom or an empty list. */
  head: string
}

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9
const isDelim = (c: number) => isSpace(c) || c === 40 || c === 41

/** The index one past the closing quote of the string that starts at `i` (a `"`). */
function stringEnd(text: string, i: number): number {
  const n = text.length
  let j = i + 1
  while (j < n) {
    const c = text.charCodeAt(j)
    if (c === 92) j += 2
    else if (c === 34) return j + 1
    else j++
  }
  throw new Error("Unterminated string")
}

function unquote(raw: string): string {
  if (raw.charCodeAt(0) !== 34) return raw
  const body = raw.slice(1, -1)
  if (!body.includes("\\")) return body
  // `[\s\S]`, not `.` with the `s` flag: the website compiles this package for ES2017, which has no `s`.
  return body.replace(/\\([\s\S])/g, (_m, e: string) => (e === "n" ? "\n" : e === "t" ? "\t" : e))
}

/** The index one past the `)` that closes the list opening at `start`. */
export function listEnd(text: string, start: number): number {
  const n = text.length
  let depth = 0
  let i = start
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 34) i = stringEnd(text, i)
    else {
      if (c === 40) depth++
      else if (c === 41 && --depth === 0) return i + 1
      i++
    }
  }
  throw new Error("Unbalanced parentheses: a list is not closed")
}

/**
 * The head of the list that starts at `start` and the places of its direct children (the head atom is not among them), without
 * reading below them: a board of 40 MB is thousands of children and millions of tokens, and most of them are never looked into.
 */
export function scanList(text: string, start: number): { start: number; end: number; head: string; kids: Span[] } {
  const n = text.length
  let i = start
  while (i < n && text.charCodeAt(i) !== 40) i++
  if (i >= n) throw new Error("There is no list in the file")
  const from = i
  i++
  const kids: Span[] = []
  let head = ""
  let first = true
  while (i < n) {
    const c = text.charCodeAt(i)
    if (isSpace(c)) i++
    else if (c === 40) {
      const end = listEnd(text, i)
      kids.push({ start: i, end })
      i = end
      first = false
    } else if (c === 41) {
      return { start: from, end: i + 1, head, kids }
    } else {
      const s = i
      if (c === 34) i = stringEnd(text, i)
      else while (i < n && !isDelim(text.charCodeAt(i))) i++
      if (first) {
        head = unquote(text.slice(s, i))
        first = false
      } else kids.push({ start: s, end: i })
    }
  }
  throw new Error("Unbalanced parentheses: the list is not closed")
}

/** Reads the node that starts at `start` (a list or an atom) with all it holds. */
export function parseAt(text: string, start: number, endHint?: number): SNode {
  const n = text.length
  const c0 = text.charCodeAt(start)
  if (c0 !== 40) {
    let j = start
    if (c0 === 34) j = stringEnd(text, start)
    else while (j < n && !isDelim(text.charCodeAt(j))) j++
    const raw = text.slice(start, j)
    return { start, end: j, raw, value: unquote(raw), head: "" }
  }
  const end = endHint ?? listEnd(text, start)
  const stack: SNode[] = []
  const root: SNode = { start, end, kids: [], head: "" }
  stack.push(root)
  let i = start + 1
  while (stack.length) {
    const top = stack[stack.length - 1]
    if (i >= n) throw new Error("Unbalanced parentheses: a list is not closed")
    const c = text.charCodeAt(i)
    if (isSpace(c)) i++
    else if (c === 40) {
      const node: SNode = { start: i, end: i, kids: [], head: "" }
      top.kids!.push(node)
      stack.push(node)
      i++
    } else if (c === 41) {
      top.end = ++i
      stack.pop()
      const kids = top.kids!
      top.head = kids.length && kids[0].raw !== undefined ? (kids[0].value ?? "") : ""
    } else {
      const s = i
      if (c === 34) i = stringEnd(text, i)
      else while (i < n && !isDelim(text.charCodeAt(i))) i++
      const raw = text.slice(s, i)
      top.kids!.push({ start: s, end: i, raw, value: unquote(raw), head: "" })
    }
  }
  return root
}

/** The list children of a node named `name`. */
export const listsNamed = (node: SNode, name: string): SNode[] => (node.kids ?? []).filter((k) => k.kids !== undefined && k.head === name)

/** The first list child named `name`. */
export const listNamed = (node: SNode, name: string): SNode | undefined => (node.kids ?? []).find((k) => k.kids !== undefined && k.head === name)

/** The value of the atom at `index` of a list (0 is the head), or undefined. */
export const atomAt = (node: SNode | undefined, index: number): string | undefined => node?.kids?.[index]?.value

/** The atoms (not lists) of a list after the head. */
export const atomKids = (node: SNode): SNode[] => (node.kids ?? []).slice(1).filter((k) => k.raw !== undefined)

/** True when a list holds another list. */
export const hasLists = (node: SNode): boolean => (node.kids ?? []).some((k) => k.kids !== undefined)

/** A number as a short key: rounded to a micrometre, so the spelling of a coordinate does not matter. */
export function roundKey(raw: string | undefined): string {
  if (raw === undefined) return "?"
  const x = Number(raw)
  if (!Number.isFinite(x)) return raw
  const r = Math.round(x * 1000) / 1000
  return Object.is(r, -0) ? "0" : String(r)
}

/** The `(version N)` of a KiCad file, read from its head, or null. */
export function fileVersion(text: string): number | null {
  const m = /^\s*\(\s*kicad_\w+\s+\(\s*version\s+(\d+)\s*\)/.exec(text.slice(0, 400))
  return m ? Number(m[1]) : null
}
