// The board reader's own s-expression parser. `model/kicad/sexpr.ts` reads library files and is
// kept as it is; a board needs more care: a byte order mark, a file that stops half way, a
// nesting deep enough to overflow a recursive reader, and a clear error for each, never a crash.
// Lists are arrays whose first entry is the node's name. Quoted and bare atoms are both strings:
// where it matters (a net named `blind`, say) the position says what it is.

export type Node = string | Node[]
export type List = Node[]

/** A file that cannot be read as a KiCad board at all, with the reason in plain words. */
export class KicadReadError extends Error {
  constructor(
    readonly code: "empty" | "not-sexpr" | "unbalanced" | "truncated" | "not-a-board" | "legacy-board" | "too-deep" | "encoding",
    message: string,
  ) {
    super(message)
  }
}

/** The deepest nesting a board may have. KiCad's own files stay under 12. */
export const MAX_DEPTH = 200

/** Bytes as text: UTF-8 (with or without its byte order mark) or UTF-16 with one; anything else is read as UTF-8 and the bad bytes are named. */
export function decodeBytes(bytes: Uint8Array): { text: string; notes: string[] } {
  const notes: string[] = []
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    const le = bytes[0] === 0xff
    const text = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes)
    notes.push("The file was UTF-16 text and was read as such.")
    return { text, notes }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), notes }
  } catch {
    notes.push("The file is not valid UTF-8; the bytes that are not were read as the replacement character.")
    return { text: new TextDecoder("utf-8").decode(bytes), notes }
  }
}

/** The root expressions of a file. Throws `KicadReadError` for text that is not balanced s-expressions. */
export function parseSexpr(input: string): List {
  const root: List = []
  const stack: List[] = [root]
  const n = input.length
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < n) {
    const c = input.charCodeAt(i)
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      i++
    } else if (c === 40) {
      if (stack.length > MAX_DEPTH) throw new KicadReadError("too-deep", `The file nests lists more than ${MAX_DEPTH} deep, which no KiCad file does.`)
      const list: List = []
      stack[stack.length - 1].push(list)
      stack.push(list)
      i++
    } else if (c === 41) {
      if (stack.length === 1) throw new KicadReadError("unbalanced", `The file has a closing bracket with no opening one (at character ${i}).`)
      stack.pop()
      i++
    } else if (c === 34) {
      let out = ""
      let start = ++i
      while (i < n && input.charCodeAt(i) !== 34) {
        if (input.charCodeAt(i) === 92 && i + 1 < n) {
          out += input.slice(start, i)
          const e = input[i + 1]
          out += e === "n" ? "\n" : e === "t" ? "\t" : e
          i += 2
          start = i
        } else i++
      }
      if (i >= n) throw new KicadReadError("truncated", "The file stops inside a quoted text; it looks cut short.")
      out += input.slice(start, i)
      stack[stack.length - 1].push(out)
      i++
    } else {
      const start = i
      while (i < n) {
        const d = input.charCodeAt(i)
        if (d === 32 || d === 10 || d === 13 || d === 9 || d === 40 || d === 41) break
        i++
      }
      stack[stack.length - 1].push(input.slice(start, i))
    }
  }
  if (stack.length !== 1) throw new KicadReadError("truncated", "The file stops before its brackets close; it looks cut short.")
  return root
}

export const nameOf = (node: Node | undefined): string | null => (Array.isArray(node) && typeof node[0] === "string" ? node[0] : null)

/** Child lists of a list, in order, named `name`. */
export function kids(node: List | undefined, name: string): List[] {
  const out: List[] = []
  if (!node) return out
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (Array.isArray(c) && c[0] === name) out.push(c)
  }
  return out
}

export function kid(node: List | undefined, name: string): List | undefined {
  if (!node) return undefined
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (Array.isArray(c) && c[0] === name) return c
  }
  return undefined
}

/** The string at `index` of a list. */
export const strAt = (node: List | undefined, index: number): string | undefined => {
  const v = node?.[index]
  return typeof v === "string" ? v : undefined
}

/** The number at `index` of a list, or `fallback` when it is missing or not a number. */
export function numAt(node: List | undefined, index: number, fallback = 0): number {
  const v = strAt(node, index)
  if (v === undefined) return fallback
  const x = Number(v)
  return Number.isFinite(x) ? x : fallback
}

/** The bare or quoted strings of a list after its name. */
export const atomsOf = (node: List | undefined): string[] => (node ? node.slice(1).filter((c): c is string => typeof c === "string") : [])

/**
 * A flag on a list, in every spelling KiCad has used: a bare word (`locked`, KiCad 5), `(locked)`,
 * `(locked yes)` (normalised from stamp 20230924), and `(locked no)` for off.
 */
export function flagOf(node: List | undefined, name: string): boolean {
  if (!node) return false
  for (let i = 1; i < node.length; i++) {
    const c = node[i]
    if (c === name) return true
    if (Array.isArray(c) && c[0] === name) return c[1] === undefined || c[1] === "yes" || c[1] === "true"
  }
  return false
}
