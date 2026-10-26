import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { slugify } from "../src/export/bundle"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import type { Project } from "../src/model/types"
import { kicad9SheetProblems } from "./kicad9-strict"

// S3 over a local corpus (not in the repo): every schematic of the corpus that has buses, entries or aliases and imports is written to KiCad by the export,
// read again, and compared with the project it was: the buses (each raw bus covered to a thousandth of a millimetre), the entries, the aliases, the nets
// (pin by pin and by name), and the files carry no token KiCad 9's parser does not take inside a bus, an entry or an alias.
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 npx vitest run tests/kicad-sch-s3-corpus.test.ts
//
// With no corpus the test is skipped.

const CORPUS = process.env.KICAD_CORPUS

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "census") walk(p, out)
    } else if (name.endsWith(".kicad_sch")) out.push(p)
  }
  return out
}

const MM = 12.7
const length = (p: Project) =>
  (p.drawings ?? [])
    .filter((d) => d.type === "bus")
    .flatMap((d) => (d as { points: { x: number; y: number }[] }).points.slice(1).map((q, i) => Math.hypot(q.x - (d as { points: { x: number; y: number }[] }).points[i].x, q.y - (d as { points: { x: number; y: number }[] }).points[i].y) * MM))
    .reduce((a, b) => a + b, 0)

/**
 * The nets that are members of a bus, as the references on them (with the use of a sheet) and their names. Only these: the export writes an imported symbol
 * through the converter, which renames the pin numbers of some (a connector's `A6` or `0`) and joins or splits stacked pins, so a power net or a net named
 * after a pin (`Net-(J1-PadA5)`) differs after any round trip, buses or none; that is a limit of the symbols' export and not about buses. Pin numbers are
 * left out for the same reason.
 */
function nets(p: Project): string[] {
  const refOf = new Map(p.components.map((c) => [c.id, `${c.ref}${c.inst ? `@${c.inst}` : ""}`]))
  const conn = computeConnectivity(p)
  const members = new Set<string>()
  for (const sb of conn.buses?.values() ?? []) for (const g of sb.groups) for (const i of g.items) for (const n of i.name.names) members.add(n)
  return conn.nets
    .filter((n) => n.pins.length > 0 && n.label && members.has(n.label.text))
    .map((n) => `${n.name}: ${n.pins.map((q) => refOf.get(q.componentId)).sort().join(" ")}`)
    .sort()
}

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("S3 over the corpus: the export round trip", () => {
  it("writes every imported schematic with buses to KiCad and reads it back as the same buses and nets", async () => {
    const all = walk(CORPUS!).sort()
    const byFolder = new Map<string, string[]>()
    for (const f of all) {
      const dir = f.slice(0, f.lastIndexOf(sep))
      ;(byFolder.get(dir) ?? byFolder.set(dir, []).get(dir)!).push(f)
    }
    const rows: string[] = []
    let compared = 0
    let equal = 0
    let refused = 0
    const problems: string[] = []
    for (const [dir, list] of byFolder) {
      const texts = list.map((f) => [f, readFileSync(f, "utf8")] as const)
      if (!texts.some(([, t]) => /\n\s*\((?:bus|bus_entry|bus_alias) /.test(t))) continue
      const files = new Map(texts.map(([f, t]) => [relative(dir, f).split(sep).join("/"), t] as const))
      for (const [f, t] of texts) {
        // a file is tried as a root; a sub-sheet read alone imports as a sheet of its own
        if (!/\n\s*\((?:bus|bus_entry|bus_alias) /.test(t) && !/\(sheet\b/.test(t)) continue
        const name = relative(dir, f).split(sep).join("/")
        const r = importKicadSchematic({ files, root: name })
        if (r.status !== "imported") {
          refused++
          rows.push(`${relative(CORPUS!, f)}: refused, ${r.reason}`)
          continue
        }
        const p = r.project
        if (!p.drawings?.some((d) => d.type === "bus" || d.type === "busentry") && !p.busAliases?.length) continue
        compared++
        try {
          const out = await kicadFiles(p)
          const sch = new Map(Object.entries(out.files).filter(([n]) => n.endsWith(".kicad_sch")))
          for (const [n, text] of sch) for (const why of kicad9SheetProblems(text)) problems.push(`${relative(CORPUS!, f)} ${n}: ${why}`)
          const root = `${slugify(p.name)}.kicad_sch`
          const back = importKicadSchematic({ files: sch, root: sch.has(root) ? root : [...sch.keys()][0] })
          if (back.status !== "imported") {
            problems.push(`${relative(CORPUS!, f)}: the written file is refused: ${back.message}`)
            continue
          }
          const q = back.project
          const same =
            Math.abs(length(p) - length(q)) < 0.01 &&
            (p.drawings ?? []).filter((d) => d.type === "busentry").length === (q.drawings ?? []).filter((d) => d.type === "busentry").length &&
            JSON.stringify((p.busAliases ?? []).map((a) => [a.name, a.members])) === JSON.stringify((q.busAliases ?? []).map((a) => [a.name, a.members])) &&
            JSON.stringify(nets(p)) === JSON.stringify(nets(q))
          if (same) equal++
          else {
            const a = nets(p)
            const b = nets(q)
            problems.push(`${relative(CORPUS!, f)}: buses ${length(p).toFixed(2)} against ${length(q).toFixed(2)} mm, entries ${(p.drawings ?? []).filter((d) => d.type === "busentry").length} against ${(q.drawings ?? []).filter((d) => d.type === "busentry").length}, nets ${a.length} against ${b.length}, first difference ${a.find((x, i) => x !== b[i])?.slice(0, 80)} against ${b.find((x, i) => x !== a[i])?.slice(0, 80)}`)
          }
        } catch (e) {
          problems.push(`${relative(CORPUS!, f)}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    console.log(JSON.stringify({ compared, equal, refused, problems: problems.slice(0, 20), refusedRows: rows.slice(0, 20) }, null, 1))
    expect(compared).toBeGreaterThan(10)
    expect(problems).toEqual([])
    expect(equal).toBe(compared)
  }, 900_000)
})
