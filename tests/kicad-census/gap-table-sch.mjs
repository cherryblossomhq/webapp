// The schematic gap table of `docs/kicad-import-schematic.md`, from the sidecar census and
// `decisions-sch.mjs`.
//
//   node tests/kicad-census/gap-table-sch.mjs <census-out> [--summary]
//
// Tables: every node path of the corpus's `.kicad_sch` files, every value atom, the keywords of
// KiCad's `schematic.keywords` no file uses, and the KiCad 5 line types. Exits 1 when something
// has no decision. `<census-out>/schematic.keywords` is KiCad's `eeschema/schematic.keywords`.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ATOMS_SCH, LEGACY_SCH, TOKENS_SCH, decisionForSch } from "./decisions-sch.mjs"

const [, , dir, ...flags] = process.argv
const files = JSON.parse(readFileSync(join(dir, "sidecars.json"), "utf8")).filter((r) => r.kind === "kicad_sch")
const REAL = ["pcbench", "github", "kicad-demos"]
const real = files.filter((f) => REAL.includes(f.group))
const N = real.length
const pct = (n) => `${((100 * n) / N).toFixed(1)}%`

const rows = new Map()
for (const f of files) {
  for (const key of Object.keys(f.nodes)) {
    const e = rows.get(key) ?? { real: 0, all: 0, qaOnly: true, min: Infinity, max: -Infinity }
    e.all++
    if (f.group !== "kicad-qa") e.qaOnly = false
    if (REAL.includes(f.group)) e.real++
    if (typeof f.version === "number") {
      e.min = Math.min(e.min, f.version)
      e.max = Math.max(e.max, f.version)
    }
    rows.set(key, e)
  }
}
const stamps = (e) => (e.min === Infinity ? "" : e.min === e.max ? String(e.min) : `${e.min} to ${e.max}`)

const unclassified = []
const out = []
out.push("## Schematic node paths\n")
out.push(`| path | files (real, ${N}) | % | files (all, ${files.length}) | stamps seen | decision | ext | model today | note |`)
out.push("|---|---|---|---|---|---|---|---|---|")
const counts = {}
for (const key of [...rows.keys()].sort()) {
  const e = rows.get(key)
  const d = decisionForSch(key)
  if (!d) {
    unclassified.push(`node ${key}`)
    continue
  }
  counts[d.decision] = (counts[d.decision] ?? 0) + 1
  out.push(`| \`${key}\` | ${e.real} | ${pct(e.real)} | ${e.all} | ${stamps(e)} | ${d.decision}${e.qaOnly ? " (KiCad's own tests only)" : ""} | ${d.ext ?? ""} | ${d.today ?? ""} | ${(d.note ?? "").replace(/\|/g, "/")} |`)
}

const atomRows = new Map()
for (const f of files) {
  for (const [path, m] of Object.entries(f.atoms ?? {})) {
    for (const [atom, n] of Object.entries(m)) {
      const key = `${path} :: ${atom}`
      const e = atomRows.get(key) ?? { real: 0, all: 0, path, atom }
      e.all++
      if (REAL.includes(f.group)) e.real++
      atomRows.set(key, e)
      void n
    }
  }
}
out.push("\n## Schematic value atoms\n")
out.push("| list | atom | files (real) | files (all) | known |")
out.push("|---|---|---|---|---|")
for (const key of [...atomRows.keys()].sort()) {
  const e = atomRows.get(key)
  const entry = ATOMS_SCH.find((a) => a.path.test(e.path))
  const known = !!entry && entry.values.has(e.atom)
  if (!known) unclassified.push(`atom ${key}`)
  out.push(`| \`${e.path}\` | \`${e.atom}\` | ${e.real} | ${e.all} | ${known ? "yes" : "NO"} |`)
}

const names = new Set()
for (const key of rows.keys()) for (const p of key.split(">")) names.add(p)
const atomNames = new Set([...atomRows.values()].map((e) => e.atom))
let keywords = []
try {
  keywords = readFileSync(join(dir, "schematic.keywords"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
} catch {
  console.error("no schematic.keywords in the census folder: token table skipped")
}
const unused = keywords.filter((t) => !names.has(t) && !atomNames.has(t))
out.push(`\n## Keywords of KiCad's schematic list that no corpus file uses (${unused.length} of ${keywords.length})\n`)
out.push("| token | decision | ext | note |")
out.push("|---|---|---|---|")
for (const t of unused) {
  const e = TOKENS_SCH.find((x) => x.names.includes(t))
  if (!e) {
    unclassified.push(`keyword ${t}`)
    continue
  }
  out.push(`| \`${t}\` | ${e.decision} | ${e.ext} | ${e.note} |`)
}

out.push("\n## KiCad 4 and 5 schematic line types\n")
out.push("| line | decision | ext | note |")
out.push("|---|---|---|---|")
for (const l of LEGACY_SCH) out.push(`| \`${l.name}\` | ${l.decision} | ${l.ext} | ${l.note} |`)

if (flags.includes("--summary")) console.error(`paths ${rows.size}`, JSON.stringify(counts), `atoms ${atomRows.size}`, `unused keywords ${unused.length} of ${keywords.length}`)
console.log(out.join("\n"))
if (unclassified.length) {
  console.error(`\nUNCLASSIFIED (${unclassified.length}):\n${unclassified.join("\n")}`)
  process.exit(1)
}
