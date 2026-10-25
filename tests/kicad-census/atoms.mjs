// Shared by the board and schematic censuses: the value atoms of the lists a decision table covers.

const bump = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n
}

/**
 * The bare atoms (not numbers, not quoted strings) of every list whose path `decisions.mjs` lists in
 * ATOMS, by path: `{ "module>pad": { smd: 4000, rect: 3500 } }`. The reader must know every one.
 */
export function collectAtoms(text, ATOMS, rootToken) {
  const out = {}
  const stack = [] // { path, index, checked }
  const n = text.length
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const entryCache = new Map()
  const entryFor = (path) => {
    if (!entryCache.has(path)) entryCache.set(path, ATOMS.find((e) => e.path.test(path)) ?? null)
    return entryCache.get(path)
  }
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      i++
    } else if (c === 40) {
      i++
      const parent = stack[stack.length - 1]
      stack.push({ path: null, index: 0, parentPath: parent?.path ?? "" })
      if (parent) parent.index++
    } else if (c === 41) {
      stack.pop()
      i++
    } else if (c === 34) {
      i++
      while (i < n && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1
      i++
      const top = stack[stack.length - 1]
      if (top) {
        if (top.path === null) top.path = top.parentPath ? `${top.parentPath}>?` : "?"
        top.index++
      }
    } else {
      const start = i
      while (i < n) {
        const d = text.charCodeAt(i)
        if (d === 32 || d === 10 || d === 13 || d === 9 || d === 40 || d === 41) break
        i++
      }
      const tok = text.slice(start, i)
      const top = stack[stack.length - 1]
      if (!top) continue
      if (top.path === null) {
        const name = /^\d+$/.test(tok) ? "<layer number>" : tok
        // the file's own root list, (kicad_pcb ...), is not part of any path
        top.path = stack.length === 1 && tok === rootToken ? "" : top.parentPath ? `${top.parentPath}>${name}` : name
        top.index = 1
        continue
      }
      const idx = top.index
      top.index++
      if (/^-?[\d.]+(e[+-]?\d+)?$/i.test(tok)) continue
      const entry = entryFor(top.path)
      if (!entry || entry.free || entry.skip?.includes(idx)) continue
      const bucket = (out[top.path] ??= {})
      bump(bucket, tok)
    }
  }
  return out
}

