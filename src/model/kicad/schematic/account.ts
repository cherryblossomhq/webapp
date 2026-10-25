import { countPaths } from "../board/account"
import type { ImportReport, NodeAccount } from "../board/report"
import type { List } from "../board/sexpr"
import { ATOM_RULES, PATH_RULES, TOKEN_RULES, type PathRule } from "./decisions"

export { countPaths }

// The accounting walk of a schematic: every list of the file, by its path from the root, looked up
// in the decision table (`decisions.ts`, generated from `tests/kicad-census/decisions-sch.mjs`). A
// path with no row, and a bare word that no atom row of its list allows, are report entries and a
// refusal. This is what makes "nothing is silently dropped" a lookup and not a habit. A node counts
// as imported only where the builder writes it (`carried.ts`).
//
// One difference from the board's walk: a list with no atom row holds names, numbers and
// identities the file's author chose (`generator eeschema`, a bare `uuid`), so its words are not
// checked, as the census does not check them (`tests/kicad-census/atoms.mjs`).

const rules = PATH_RULES.map((r) => ({ ...r, re: new RegExp(r.source) }))
const atomRules = ATOM_RULES.map((a) => ({ ...a, re: new RegExp(a.source), set: new Set(a.values) }))
const tokenNames = new Map(TOKEN_RULES.flatMap((t) => t.names.map((n) => [n, t] as const)))

const cache = new Map<string, PathRule | null>()

/** The first rule that covers a whole path. */
export function ruleFor(path: string): PathRule | null {
  let r = cache.get(path)
  if (r === undefined) {
    r = rules.find((x) => x.re.test(path)) ?? null
    cache.set(path, r)
  }
  return r
}

/** The table's row for a keyword of KiCad's own list that no corpus file uses. */
export const tokenRule = (name: string) => tokenNames.get(name) ?? null

const resolved = new Map<string, PathRule | null>()

/**
 * The row for a path: the table's, or, for a node KiCad has a keyword for but no corpus file uses (a
 * placed symbol's `convert`, the KiCad 6 and 7 spelling of `body_style`), the keyword's row. A
 * keyword the table calls `native` is no fallback, since native means the builder writes a node whose
 * place it knows; anything else with no row stays unknown.
 */
export function resolveRule(path: string): PathRule | null {
  let r = resolved.get(path)
  if (r === undefined) {
    r = ruleFor(path)
    if (!r) {
      const token = tokenRule(path.slice(path.lastIndexOf(">") + 1))
      if (token && token.decision !== "native") r = { source: path, decision: token.decision, ...(token.ext ? { ext: token.ext } : {}), note: token.note }
    }
    resolved.set(path, r)
  }
  return r
}

const NUMBER = /^-?[\d.]+(e[+-]?\d+)?$/i

/**
 * The bare words (not numbers, not quoted text) of every list of the file that an atom row of the
 * table covers and does not allow, counted by path and word. It scans the text, since the parsed
 * tree does not tell a quoted `"input"` from a bare `input`.
 */
export function scanAtoms(text: string, rootToken = "kicad_sch"): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  const stack: { path: string | null; index: number; parentPath: string }[] = []
  const n = text.length
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const entries = new Map<string, (typeof atomRules)[number] | "exempt" | null>()
  const entryFor = (path: string) => {
    let e = entries.get(path)
    if (e === undefined) {
      const rule = resolveRule(path)
      // A node with no row is reported as an unknown path; one the table drops or reports as a whole needs no word-by-word account.
      e = !rule || rule.decision === "not-needed" || rule.decision === "report" ? "exempt" : (atomRules.find((a) => a.re.test(path)) ?? null)
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
        top.path = stack.length === 1 && tok === rootToken ? "" : top.parentPath ? `${top.parentPath}>${tok}` : tok
        top.index = 1
        continue
      }
      const idx = top.index
      top.index++
      if (NUMBER.test(tok)) continue
      const entry = entryFor(top.path)
      if (entry === "exempt" || entry === null || entry.skip.includes(idx) || entry.set.has(tok)) continue
      let bucket = out.get(top.path)
      if (!bucket) out.set(top.path, (bucket = new Map()))
      bucket.set(tok, (bucket.get(tok) ?? 0) + 1)
    }
  }
  return out
}

/**
 * What becomes of an `extend` node whose extension the schematic does not need: `built` when the
 * builder writes it into the project, `derived` when it says only what the editor works out for
 * itself (`reason` says what, and it is checked for every file), or null when it is neither,
 * which is a node that is imported only once its extension is.
 */
export type Settle = (path: string) => { how: "built" | "derived"; reason?: string } | null

export function newAccount(): NodeAccount {
  return { paths: new Map(), total: 0, imported: 0, importedPaths: new Map(), notNeeded: new Map(), pending: new Map(), reported: 0, unknownPaths: new Map(), unknownAtoms: new Map() }
}

/**
 * Account for every node of one file. `needed` is the set of extensions of the model that this
 * project's content needs and that are not built: an `extend` node is pending when its extension is
 * in it. Otherwise it is imported only if `settle` says the builder writes it, and not needed (with
 * the reason) if it says the editor derives it; a `native` node is one the builder writes.
 */
export function accountNodes(root: List, text: string, needed: ReadonlySet<string>, counted?: Map<string, number>, settle: Settle = () => null): NodeAccount {
  const paths = counted ?? countPaths(root)
  const account = newAccount()
  account.paths = paths
  for (const [path, count] of paths) {
    account.total += count
    const rule = resolveRule(path)
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

/** The sum of the accounts of several files. */
export function mergeAccounts(parts: NodeAccount[]): NodeAccount {
  const out = newAccount()
  const add = (to: Map<string, number>, from: Map<string, number>) => {
    for (const [k, v] of from) to.set(k, (to.get(k) ?? 0) + v)
  }
  for (const a of parts) {
    out.total += a.total
    out.imported += a.imported
    out.reported += a.reported
    add(out.paths, a.paths)
    add(out.importedPaths, a.importedPaths)
    add(out.notNeeded, a.notNeeded)
    add(out.pending, a.pending)
    add(out.unknownPaths, a.unknownPaths)
    add(out.unknownAtoms, a.unknownAtoms)
  }
  return out
}

/** Report entries for what the decision table does not know. */
export function reportUnknown(account: NodeAccount, report: ImportReport) {
  for (const [path, count] of account.unknownPaths) {
    // What is inside a node the table does not know is covered by the node's own entry.
    if (account.unknownPaths.has(path.slice(0, Math.max(0, path.lastIndexOf(">"))))) continue
    report.entries.push({
      code: "unknown-node",
      severity: "refused",
      object: `the node "${path}"`,
      why: "KiCad's file has a node this importer does not know. Nothing is guessed: the schematic is not imported until the importer learns it.",
      count,
    })
  }
  for (const [key, count] of account.unknownAtoms) {
    const cut = key.lastIndexOf(" ")
    report.entries.push({
      code: "unknown-value",
      severity: "refused",
      object: `the word "${key.slice(cut + 1)}" in "${key.slice(0, cut)}"`,
      why: "KiCad's file has a value this importer does not know. Nothing is guessed: the schematic is not imported until the importer learns it.",
      count,
    })
  }
}

/** The nodes the table says cannot be represented (KiCad 11 development features), one entry per path. */
export function reportedNodes(account: NodeAccount, report: ImportReport) {
  for (const [path, count] of account.paths) {
    const rule = resolveRule(path)
    if (rule?.decision !== "report") continue
    // A child of a reported node is covered by its parent's entry.
    const parent = path.slice(0, path.lastIndexOf(">"))
    if (parent && resolveRule(parent)?.decision === "report") continue
    // Embedded files are named one by one by the importer, which can see their names.
    if (/(^|>)embedded_files(>|$)/.test(path)) continue
    report.entries.push({ code: "not-representable", severity: "not-brought", object: `the node "${path}"`, why: rule.note ?? "It cannot be represented.", count })
  }
}
