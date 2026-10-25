import { newAccount } from "../schematic/account"
import { countPaths } from "../board/account"
import type { ImportReport, NodeAccount } from "../board/report"
import { decodeBytes, kid, kids, KicadReadError, parseSexpr, strAt, type List } from "../board/sexpr"

// The custom design rules (`.kicad_dru`, KiCad 6 and later): `(version 1)` and a `(rule "name" ...)`
// each with a condition, constraints, a severity and layers. They are read into typed objects that
// keep their lists, and every node is accounted for: mapping rules into the editor's model is board
// slice 1d (X10), so in 3a every rule is pending X10 and never dropped. KiCad lets a rules file hold
// `#` comments, which the s-expression parser does not know; they are cut out first.

export class KicadRulesFileError extends Error {
  constructor(
    readonly code: "not-sexpr" | "unbalanced" | "truncated" | "too-deep" | "empty" | "not-rules",
    message: string,
  ) {
    super(message)
  }
}

export interface KicadRule {
  name: string
  condition: string | null
  severity: string | null
  layers: string[]
  /** Each constraint's type (`clearance`, `track_width`...) with its min, opt and max as written. */
  constraints: { type: string; min?: string; opt?: string; max?: string; node: List }[]
  node: List
}

export interface KicadRules {
  version: number | null
  rules: KicadRule[]
  tree: List
}

/** The text with each `#` comment (from a `#` outside quotes to the end of the line) removed. */
export function stripComments(text: string): string {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\" && i + 1 < text.length) out += text[++i]
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else out += c
  }
  return out
}

export interface RulesReadResult {
  rules: KicadRules
  /** The text that was read, comments cut out. */
  text: string
  notes: string[]
}

/** Reads a `.kicad_dru`, as text or bytes. Throws `KicadRulesFileError` for a file that is not balanced s-expressions. */
export function readKicadRules(input: string | Uint8Array): RulesReadResult {
  let text: string
  let notes: string[] = []
  if (typeof input === "string") text = input
  else {
    const decoded = decodeBytes(input)
    text = decoded.text
    notes = decoded.notes
  }
  text = stripComments(text)
  let root: List
  try {
    root = parseSexpr(text)
  } catch (e) {
    if (e instanceof KicadReadError) throw new KicadRulesFileError(e.code === "unbalanced" || e.code === "truncated" || e.code === "too-deep" ? e.code : "not-sexpr", `The design rules file is damaged: ${e.message}`)
    throw e
  }
  const versionNode = root.find((n): n is List => Array.isArray(n) && n[0] === "version")
  const version = versionNode && Number.isFinite(Number(versionNode[1])) ? Number(versionNode[1]) : null
  const ruleNodes = root.filter((n): n is List => Array.isArray(n) && n[0] === "rule")
  const rules: KicadRule[] = ruleNodes.map((r) => ({
    name: strAt(r, 1) ?? "",
    condition: strAt(kid(r, "condition"), 1) ?? null,
    severity: strAt(kid(r, "severity"), 1) ?? null,
    layers: kids(r, "layer").map((l) => strAt(l, 1) ?? ""),
    constraints: kids(r, "constraint").map((c) => ({ type: strAt(c, 1) ?? "", min: strAt(kid(c, "min"), 1), opt: strAt(kid(c, "opt"), 1), max: strAt(kid(c, "max"), 1), node: c })),
    node: r,
  }))
  // A rules file has no root list: its lists stand side by side. They are given one, named as the file is, so the accounting reads them as it reads the others.
  return { rules: { version, rules, tree: ["kicad_dru", ...root] }, text, notes }
}

// ---------- the table ----------

/** The nodes of a rules file, by path from the root. Every rule is pending X10; the version says nothing. */
const KNOWN: [RegExp, "not-needed" | "pending", string][] = [
  [/^version$/, "not-needed", "the rules file's own version"],
  [/^rule$/, "pending", "a custom design rule"],
  [/^rule>(?:condition|constraint|severity|layer|priority)$/, "pending", "a custom design rule's condition, constraint, severity, layer or priority"],
  [/^rule>constraint>(?:min|max|opt|within_diff_pairs)$/, "pending", "a custom design rule's limits"],
]

/** Account for every node of a rules file: each rule and what is in it is pending X10, and a node the table does not know is unknown. */
export function accountRules(tree: List): NodeAccount {
  const paths = countPaths(tree)
  const account = newAccount()
  account.paths = paths
  for (const [path, count] of paths) {
    account.total += count
    const row = KNOWN.find(([re]) => re.test(path))
    if (!row) account.unknownPaths.set(path, count)
    else if (row[1] === "pending") account.pending.set("X10", (account.pending.get("X10") ?? 0) + count)
    else account.notNeeded.set(row[2], (account.notNeeded.get(row[2]) ?? 0) + count)
  }
  return account
}

/** Bare words of a constraint (`clearance`, `disallow track via`) are names of KiCad's own, so they are not checked one by one; the paths are. */
export function reportUnknownRules(account: NodeAccount, report: ImportReport, file: string) {
  for (const [path, count] of account.unknownPaths) {
    if (account.unknownPaths.has(path.slice(0, Math.max(0, path.lastIndexOf(">"))))) continue
    report.entries.push({ code: "unknown-node", severity: "refused", object: `the node "${path}" in ${file}`, why: "KiCad's design rules file has a node this importer does not know. Nothing is guessed: the project is not imported until the importer learns it.", count })
  }
}
