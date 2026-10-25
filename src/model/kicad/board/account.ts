import { PATH_RULES, ATOM_RULES, TOKEN_RULES, type PathRule } from "./decisions"
import { planModels } from "./models"
import type { ImportReport, NodeAccount } from "./report"
import type { List } from "./sexpr"
import type { KicadBoard } from "./types"

// The accounting walk: every list of the file, by its path from the root, looked up in the
// decision table. A path with no row, and a bare word that no row of the table allows at its place
// (every list is scanned, not only the ones the table has atoms for), are report entries. This is
// what makes "nothing is silently dropped" a lookup and not a habit. A node counts as imported
// only where the project builder writes it (`carried.ts`), and a test builds a board and checks it.

const rules = PATH_RULES.map((r) => ({ ...r, re: new RegExp(r.source) }))
const atomRules = ATOM_RULES.map((a) => ({ ...a, re: new RegExp(a.source), set: new Set(a.values) }))
const tokenNames = new Map(TOKEN_RULES.flatMap((t) => t.names.map((n) => [n, t] as const)))

/** The first rule that covers a whole path. `module` is `footprint`, which is how KiCad 5 spells it. */
export function ruleFor(path: string): PathRule | null {
  const p = path.replace(/^module(?=$|>)/, "footprint")
  for (const r of rules) if (r.re.test(p)) return r
  return null
}

/** The table's row for a keyword of KiCad's own list that no corpus board uses. */
export const tokenRule = (name: string) => tokenNames.get(name) ?? null

const cache = new Map<string, PathRule | null>()
const cachedRule = (path: string) => {
  let r = cache.get(path)
  if (r === undefined) {
    r = ruleFor(path)
    cache.set(path, r)
  }
  return r
}

/** The path of every list under `root` with its count. A layer row `(0 F.Cu signal)` is `<layer number>`. */
export function countPaths(root: List): Map<string, number> {
  const out = new Map<string, number>()
  const stack: [List, string][] = [[root, ""]]
  while (stack.length) {
    const [list, path] = stack.pop()!
    for (let i = 1; i < list.length; i++) {
      const c = list[i]
      if (Array.isArray(c) && typeof c[0] === "string") {
        const name = /^\d+$/.test(c[0]) ? "<layer number>" : c[0]
        const next = path ? `${path}>${name}` : name
        out.set(next, (out.get(next) ?? 0) + 1)
        stack.push([c, next])
      }
    }
  }
  return out
}

const NUMBER = /^-?[\d.]+(e[+-]?\d+)?$/i

/**
 * The bare words (not numbers, not quoted text) of every list of the file that no row of the table
 * allows, counted by path and word. A word is allowed by an atom row of its list's path (its value
 * set, or a position that holds a name, or a list whose words are all names), or because the
 * table says the whole node is not needed or is reported. A list with no atom row allows none.
 * It scans the text, since the parsed tree does not tell a quoted `"Front"` from a bare `signal`.
 */
export function scanAtoms(text: string, rootToken = "kicad_pcb"): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  const stack: { path: string | null; index: number; parentPath: string }[] = []
  const n = text.length
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const entries = new Map<string, (typeof atomRules)[number] | "exempt" | null>()
  const entryFor = (path: string) => {
    let e = entries.get(path)
    if (e === undefined) {
      const p = path.replace(/^module(?=$|>)/, "footprint")
      const rule = cachedRule(p)
      // A node with no row is reported as an unknown path; one the table drops or reports as a whole needs no word-by-word account.
      e = !rule || rule.decision === "not-needed" || rule.decision === "report" ? "exempt" : (atomRules.find((a) => a.re.test(p)) ?? null)
      entries.set(path, e)
    }
    return e
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
        top.path = stack.length === 1 && tok === rootToken ? "" : top.parentPath ? `${top.parentPath}>${name}` : name
        top.index = 1
        continue
      }
      const idx = top.index
      top.index++
      if (NUMBER.test(tok)) continue
      const entry = entryFor(top.path)
      if (entry === "exempt" || (entry && (entry.free || entry.skip.includes(idx) || entry.set.has(tok)))) continue
      let bucket = out.get(top.path)
      if (!bucket) out.set(top.path, (bucket = new Map()))
      bucket.set(tok, (bucket.get(tok) ?? 0) + 1)
    }
  }
  return out
}

/**
 * What becomes of an `extend` node whose extension the board does not need: `built` when the
 * project builder writes it into the project, `derived` when it says only what the editor works
 * out for itself (`reason` says what, and it is checked for every board), or null when it is
 * neither, which is a node that is imported only once its extension is.
 */
export type Settle = (path: string) => { how: "built" | "derived"; reason?: string } | null

/**
 * Account for every node of a board. `needed` is the set of extensions of the model this board's
 * content needs and that are not built: an `extend` node is pending when its extension is in it.
 * Otherwise it is imported only if `settle` says the builder writes it, and not needed (with the
 * reason) if it says the editor derives it; a `native` node is one the builder writes.
 */
export function accountNodes(root: List, text: string, needed: ReadonlySet<string>, counted?: Map<string, number>, settle: Settle = () => null): NodeAccount {
  const paths = counted ?? countPaths(root)
  const account: NodeAccount = {
    paths,
    total: 0,
    imported: 0,
    importedPaths: new Map(),
    notNeeded: new Map(),
    pending: new Map(),
    reported: 0,
    unknownPaths: new Map(),
    unknownAtoms: new Map(),
  }
  for (const [path, count] of paths) {
    account.total += count
    const rule = cachedRule(path)
    if (!rule) {
      account.unknownPaths.set(path, count)
      continue
    }
    const imported = () => {
      account.imported += count
      account.importedPaths.set(path, count)
    }
    const notNeeded = (reason: string) => account.notNeeded.set(reason, (account.notNeeded.get(reason) ?? 0) + count)
    if (rule.decision === "native") imported()
    else if (rule.decision === "not-needed") notNeeded(rule.note ?? path)
    else if (rule.decision === "report") account.reported += count
    else if (rule.ext && needed.has(rule.ext)) account.pending.set(rule.ext, (account.pending.get(rule.ext) ?? 0) + count)
    else {
      const how = settle(path)
      if (how?.how === "derived") notNeeded(how.reason ?? rule.note ?? path)
      else imported()
    }
  }
  for (const [path, words] of scanAtoms(text)) {
    for (const [word, count] of words) account.unknownAtoms.set(`${path} ${word}`, count)
  }
  return account
}

/** Report entries for what the decision table does not know. Nodes it says cannot be represented are reported by `reportedNodes`. */
export function reportUnknown(account: NodeAccount, report: ImportReport) {
  for (const [path, count] of account.unknownPaths) {
    report.entries.push({
      code: "unknown-node",
      severity: "refused",
      object: `the node "${path}"`,
      why: "KiCad's file has a node this importer does not know. Nothing is guessed: the board is not imported until the importer learns it.",
      count,
    })
  }
  for (const [key, count] of account.unknownAtoms) {
    const cut = key.lastIndexOf(" ")
    report.entries.push({
      code: "unknown-value",
      severity: "refused",
      object: `the word "${key.slice(cut + 1)}" in "${key.slice(0, cut)}"`,
      why: "KiCad's file has a value this importer does not know. Nothing is guessed: the board is not imported until the importer learns it.",
      count,
    })
  }
}

/**
 * The nodes of the models the project does not hold (hidden, scaled, a second one, not in the
 * stock library) are not imported, whatever the table says of a model node: they move from
 * imported to reported, and `build.ts` names each model in the report.
 */
export function reportDroppedModels(account: NodeAccount, board: KicadBoard) {
  for (const fp of board.footprints) {
    for (const d of planModels(fp).dropped) {
      const walk = (node: List, path: string) => {
        const had = account.importedPaths.get(path)
        if (had !== undefined) {
          if (had <= 1) account.importedPaths.delete(path)
          else account.importedPaths.set(path, had - 1)
          account.imported--
          account.reported++
        }
        for (let i = 1; i < node.length; i++) {
          const c = node[i]
          if (Array.isArray(c) && typeof c[0] === "string") walk(c, `${path}>${c[0]}`)
        }
      }
      walk(d.model.node, `${fp.node[0]}>model`)
    }
  }
}

/** The nodes the table says cannot be represented (KiCad 11 development features), one entry per path. */
export function reportedNodes(account: NodeAccount, report: ImportReport) {
  for (const [path, count] of account.paths) {
    const rule = cachedRule(path)
    if (rule?.decision !== "report") continue
    // A child of a reported node is covered by its parent's entry.
    const parent = path.slice(0, path.lastIndexOf(">"))
    if (parent && cachedRule(parent)?.decision === "report") continue
    // Embedded files are named one by one by the reader (`readBoard`), which can see their names.
    if (/(^|>)embedded_files(>|$)/.test(path)) continue
    report.entries.push({
      code: "not-representable",
      severity: "not-brought",
      object: `the node "${path}"`,
      why: rule.note ?? "It cannot be represented.",
      count,
    })
  }
}
