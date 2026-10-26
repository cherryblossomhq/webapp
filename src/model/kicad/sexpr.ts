// KiCad's file format is s-expressions: `(pad "1" smd rect (at 0 0) (size 1 1))`. This reads one
// into nested arrays of strings. Quoted strings and bare atoms are both strings: nothing in the
// symbol and footprint files needs the difference (`(hide yes)` and `(name "yes")` are told apart
// by where they are, not by quotes).

export type SNode = string | SNode[]

/** The top-level expressions of a KiCad file: for `(footprint ...)`, a list with one entry. */
export function parseSexpr(text: string): SNode[] {
  const root: SNode[] = []
  const stack: SNode[][] = [root]
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    // whitespace
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      i++
    } else if (c === 40) {
      // (
      const list: SNode[] = []
      stack[stack.length - 1].push(list)
      stack.push(list)
      i++
    } else if (c === 41) {
      // )
      if (stack.length === 1) throw new Error(`Unbalanced ")" at ${i}`)
      stack.pop()
      i++
    } else if (c === 34) {
      // "..."
      let out = ""
      let start = ++i
      while (i < n && text.charCodeAt(i) !== 34) {
        if (text.charCodeAt(i) === 92 && i + 1 < n) {
          out += text.slice(start, i)
          const e = text[i + 1]
          out += e === "n" ? "\n" : e === "t" ? "\t" : e
          i += 2
          start = i
        } else {
          i++
        }
      }
      if (i >= n) throw new Error("Unterminated string")
      out += text.slice(start, i)
      stack[stack.length - 1].push(out)
      i++
    } else {
      const start = i
      while (i < n) {
        const d = text.charCodeAt(i)
        if (d === 32 || d === 10 || d === 13 || d === 9 || d === 40 || d === 41) break
        i++
      }
      stack[stack.length - 1].push(text.slice(start, i))
    }
  }
  if (stack.length !== 1) throw new Error("Unbalanced parentheses: a list is not closed")
  return root
}

/** The expression's name: `pad` for `(pad "1" ...)`, or null for a bare atom or an empty list. */
export const nameOf = (node: SNode): string | null => (Array.isArray(node) && typeof node[0] === "string" ? node[0] : null)

/** The child lists named `name`, in order. */
export function all(node: SNode[], name: string): SNode[][] {
  const out: SNode[][] = []
  for (let i = 1; i < node.length; i++) {
    const child = node[i]
    if (Array.isArray(child) && child[0] === name) out.push(child)
  }
  return out
}

/** The first child list named `name`. */
export function first(node: SNode[], name: string): SNode[] | undefined {
  for (let i = 1; i < node.length; i++) {
    const child = node[i]
    if (Array.isArray(child) && child[0] === name) return child
  }
  return undefined
}

/** A string argument at `index` of a list, or undefined. */
export const str = (node: SNode[] | undefined, index: number): string | undefined => {
  const v = node?.[index]
  return typeof v === "string" ? v : undefined
}

/** A numeric argument at `index` of a list, or `fallback` when it's missing or not a number. */
export function num(node: SNode[] | undefined, index: number, fallback = 0): number {
  const v = str(node, index)
  if (v === undefined) return fallback
  const x = Number(v)
  return Number.isFinite(x) ? x : fallback
}

/** Whether a flag is set on a list: `(hide yes)`, a bare `hide` atom (older files) and `(hide)` all count; `(hide no)` doesn't. */
export function flag(node: SNode[], name: string): boolean {
  for (let i = 1; i < node.length; i++) {
    const child = node[i]
    if (child === name) return true
    if (Array.isArray(child) && child[0] === name) return child[1] === undefined || child[1] === "yes"
  }
  return false
}
