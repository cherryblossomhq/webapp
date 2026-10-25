// A small s-expression reader for the census, deliberately not `src/model/kicad/sexpr.ts`: the
// census is the oracle the importer is checked against, so it shares no code with it.
// Lists are arrays whose first entry is the node's name. Quoted and bare atoms are both strings.
// A UTF-8 byte order mark is skipped, `\"` and `\\` are unescaped, and the reader is iterative
// so a deeply nested file cannot overflow the stack.

export function parseSexpr(text) {
  const root = []
  const stack = [root]
  const n = text.length
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      i++
    } else if (c === 40) {
      const list = []
      stack[stack.length - 1].push(list)
      stack.push(list)
      i++
    } else if (c === 41) {
      if (stack.length === 1) throw new Error(`Unbalanced ")" at ${i}`)
      stack.pop()
      i++
    } else if (c === 34) {
      let out = ""
      let start = ++i
      while (i < n && text.charCodeAt(i) !== 34) {
        if (text.charCodeAt(i) === 92 && i + 1 < n) {
          out += text.slice(start, i)
          const e = text[i + 1]
          out += e === "n" ? "\n" : e === "t" ? "\t" : e
          i += 2
          start = i
        } else i++
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

export const nameOf = (node) => (Array.isArray(node) && typeof node[0] === "string" ? node[0] : null)
export const kids = (node, name) => (Array.isArray(node) ? node.filter((c, i) => i > 0 && Array.isArray(c) && c[0] === name) : [])
export const kid = (node, name) => (Array.isArray(node) ? node.find((c, i) => i > 0 && Array.isArray(c) && c[0] === name) : undefined)
export const atoms = (node) => (Array.isArray(node) ? node.slice(1).filter((c) => typeof c === "string") : [])
export const numAt = (node, i, d = 0) => {
  const v = node?.[i]
  const x = typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(x) ? x : d
}
export const hasAtom = (node, a) => Array.isArray(node) && node.some((c, i) => i > 0 && c === a)
