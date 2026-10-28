// The per-node gap table of `docs/kicad-import.md`, printed to stdout, from the census and `decisions.mjs`.
//
//   node tests/kicad-census/gap-table.mjs <census-out> [--summary]
//
// Three tables: every node path the corpus has (a node is its whole path from the root), every
// value atom the corpus has in the lists `ATOMS` covers, and every token of KiCad's keyword file
// that no corpus board uses. Exits 1 when a node path, an atom or a keyword has no decision.
// `<census-out>/pcb.keywords` is KiCad's `common/pcb.keywords`.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ATOMS, TOKENS, decisionFor } from "./decisions.mjs"

const [, , dir, ...flags] = process.argv
const boards = JSON.parse(readFileSync(join(dir, "boards.json"), "utf8"))
const REAL = ["pcbench", "github", "kicad-demos"]
const real = boards.filter((b) => REAL.includes(b.group))
const N = real.length

const norm = (path) => path.replace(/^module(?=$|>)/, "footprint")

const rows = new Map()
for (const b of boards) {
  const seen = new Set()
  for (const k of Object.keys(b.nodes)) {
    const key = norm(k)
    if (seen.has(key)) continue
    seen.add(key)
    const e = rows.get(key) ?? { real: 0, all: 0, qaOnly: true, min: Infinity, max: -Infinity }
    e.all++
    if (b.group !== "kicad-qa") e.qaOnly = false
    if (REAL.includes(b.group)) e.real++
    if (typeof b.version === "number") {
      e.min = Math.min(e.min, b.version)
      e.max = Math.max(e.max, b.version)
    }
    rows.set(key, e)
  }
}

const unclassified = []
const out = []
const stamps = (e) => (e.min === Infinity ? "" : e.min === e.max ? String(e.min) : `${e.min} to ${e.max}`)
const pct = (n) => `${((100 * n) / N).toFixed(1)}%`

out.push("## Node paths\n")
out.push(`| path | boards (real, ${N}) | % | boards (all, ${boards.length}) | stamps seen | decision | ext | model today | note |`)
out.push("|---|---|---|---|---|---|---|---|---|")
const decisions = {}
for (const key of [...rows.keys()].sort()) {
  const e = rows.get(key)
  const d = decisionFor(key)
  if (!d) {
    unclassified.push(`node ${key}`)
    continue
  }
  decisions[key] = d.decision
  const flag = e.qaOnly ? " (KiCad's own tests only)" : ""
  out.push(`| \`${key}\` | ${e.real} | ${pct(e.real)} | ${e.all} | ${stamps(e)} | ${d.decision}${flag} | ${d.ext ?? ""} | ${d.today ?? ""} | ${(d.note ?? "").replace(/\|/g, "/")} |`)
}

// value atoms
const atomRows = new Map()
for (const b of boards) {
  for (const [path, m] of Object.entries(b.atoms ?? {})) {
    for (const [atom, n] of Object.entries(m)) {
      const key = `${norm(path)} :: ${atom}`
      const e = atomRows.get(key) ?? { real: 0, all: 0, total: 0, path: norm(path), rawPath: path, atom }
      e.all++
      if (REAL.includes(b.group)) e.real++
      e.total += n
      atomRows.set(key, e)
    }
  }
}
out.push("\n## Value atoms\n")
out.push("The bare words in the lists the reader checks. An atom not in the table is reported by the reader, never skipped.\n")
out.push("| list | atom | boards (real) | boards (all) | known |")
out.push("|---|---|---|---|---|")
for (const key of [...atomRows.keys()].sort()) {
  const e = atomRows.get(key)
  const entry = ATOMS.find((a) => a.path.test(e.rawPath))
  const known = !!entry && entry.values.has(e.atom)
  if (!known) unclassified.push(`atom ${key}`)
  out.push(`| \`${e.path}\` | \`${e.atom}\` | ${e.real} | ${e.all} | ${known ? "yes" : "NO"} |`)
}
const unseenAtoms = []
for (const a of ATOMS) {
  for (const v of a.values) {
    const used = [...atomRows.values()].some((e) => e.atom === v && a.path.test(e.rawPath))
    if (!used) unseenAtoms.push(`${a.path.source.replace(/^\^\(|\)\$$/g, "")} :: ${v}`)
  }
}
if (unseenAtoms.length) out.push(`\nAllowed by the reader but in no corpus board: ${unseenAtoms.map((u) => `\`${u}\``).join(", ")}.`)

// keywords nobody uses
const names = new Set()
for (const key of rows.keys()) for (const p of key.split(">")) names.add(p)
const atomNames = new Set([...atomRows.values()].map((e) => e.atom))
let keywords = []
try {
  keywords = readFileSync(join(dir, "pcb.keywords"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
} catch {
  console.error("no pcb.keywords in the census folder (copy common/pcb.keywords from KiCad's source): token table skipped")
}
const unused = keywords.filter((t) => !names.has(t) && !atomNames.has(t))
out.push(`\n## Keywords of KiCad's own list that no corpus board uses (${unused.length} of ${keywords.length})\n`)
out.push("| token | decision | ext | note |")
out.push("|---|---|---|---|")
for (const t of unused) {
  const e = TOKENS.find((x) => x.names.includes(t))
  if (!e) {
    unclassified.push(`keyword ${t}`)
    continue
  }
  out.push(`| \`${t}\` | ${e.decision} | ${e.ext} | ${e.note} |`)
}

if (flags.includes("--summary")) {
  const c = {}
  for (const v of Object.values(decisions)) c[v] = (c[v] ?? 0) + 1
  console.error(`node paths ${Object.keys(decisions).length}`, JSON.stringify(c), `atoms ${atomRows.size}`, `unused keywords ${unused.length} of ${keywords.length}`)
}
console.log(out.join("\n"))
if (unclassified.length) {
  console.error(`\nUNCLASSIFIED (${unclassified.length}):\n${unclassified.join("\n")}`)
  process.exit(1)
}
