import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard } from "../src/model/kicad/board"
import { rememberImage } from "../src/store/imageFiles"
import { diffProjects, proRulesDifferences } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// The round trip over a local corpus (not in the repo): every board that imports is written out by the KiCad export, read again, and the two
// projects are compared item for item (`kicad-roundtrip-check.ts`). The table says how many have no difference and counts every kind of difference.
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 \
//     KICAD_ROUNDTRIP_OUT=<file> npx vitest run tests/kicad-roundtrip-corpus.test.ts
//
// KICAD_LIMIT / KICAD_ONLY (comma separated path fragments) narrow the run. With no corpus the test is skipped.

const CORPUS = process.env.KICAD_CORPUS
const OUT = process.env.KICAD_ROUNDTRIP_OUT
const LIMIT = Number(process.env.KICAD_LIMIT ?? 0)
/** Every Nth board only (KICAD_EVERY), for a quick sample. */
const EVERY = Number(process.env.KICAD_EVERY ?? 1)
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []

/**
 * What differs on purpose, because a KiCad 9 file cannot say it: a zone of a board of KiCad 5 or earlier has no uuid and is not ordered by one (a file of
 * KiCad 9 gives every zone a uuid, which orders zones of equal priority), and its fill keeps that release's distances to the edge and to a hole; KiCad 9 has no
 * `virtual` attribute (it reads it as "not in the BOM" and "not in the position file"), and jumper pad groups and a text's hyperlink are KiCad 10's, which the 9.0
 * parser refuses (they stay in the project and are not written). Everything else that differs is a finding.
 */
export const BY_DESIGN = [
  /^project\.zones\[\]\.(edgeGap|holeGap|unordered|uuid)$/,
  /^project\.components\[\]\.flags\.(virtual|excludeFromBom|excludeFromPos)$/,
  /^project\.components\[\]\.flags\.(jumperDuplicates|jumperGroups)$/,
  /^project\.(texts|components\[\]\.texts)\[\]\.href$/,
]

/** The outline repair of the importer runs again on the outline the writer wrote, and moves a piece it had joined by its tolerance (never more than 0.1 mm; `diffProjects` names it). */
export const REPAIRED = [/^project\.board\.outlineDrawn: /]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "census") walk(p, out)
    } else if (name.endsWith(".kicad_pcb")) out.push(p)
  }
  return out
}

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("board round trip over the corpus", () => {
  it("writes every imported board out and reads it back as the same project", async () => {
    let files = walk(CORPUS!).sort()
    if (ONLY.length) files = files.filter((f) => ONLY.some((o) => f.split(String.fromCharCode(92)).join("/").includes(o)))
    if (EVERY > 1) files = files.filter((_, i) => i % EVERY === 0)
    if (LIMIT) files = files.slice(0, LIMIT)
    const kinds = new Map<string, { boards: number; example: string; byDesign: boolean }>()
    const rows: { file: string; status: string; differences: number; unexpected?: number; kinds: string[]; ms: number; error?: string }[] = []
    for (const file of files) {
      const rel = relative(CORPUS!, file).split(String.fromCharCode(92)).join("/")
      const t0 = Date.now()
      try {
        const a = importKicadBoard(readFileSync(file))
        if (a.status !== "imported") {
          rows.push({ file: rel, status: `not imported (${a.reason})`, differences: 0, kinds: [], ms: Date.now() - t0 })
          continue
        }
        // The host keeps a reference image's bytes; here the page already has them, as it does right after an import.
        for (const f of a.files) rememberImage(f.id, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
        const written = await kicadFiles(a.project)
        const pcb = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
        const b = importKicadBoard(pcb)
        if (b.status !== "imported") {
          rows.push({ file: rel, status: `written file refused: ${b.message.slice(0, 160)}`, differences: -1, kinds: [], ms: Date.now() - t0 })
          continue
        }
        const pro = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pro"))![1]
        const diffs = [...diffProjects(a.project, b.project, 400), ...proRulesDifferences(a.project, pro)]
        // KiCad 9.0's parser aborts on a node it does not have, so no file may be written with one.
        const strange = unknownNodes(pcb)
        if (strange.length) diffs.push({ kind: `written nodes KiCad 9.0 does not have: ${strange.join(" ")}`, path: "the written file", first: "", second: strange.join(" ") })
        const ks = [...new Set(diffs.map((d) => d.kind))]
        for (const d of diffs) {
          if (!kinds.has(d.kind)) kinds.set(d.kind, { boards: 0, example: `${rel} ${d.path}: ${d.first} / ${d.second}`, byDesign: [...BY_DESIGN, ...REPAIRED].some((re) => re.test(d.kind)) })
        }
        for (const k of ks) kinds.get(k)!.boards++
        const unexpected = diffs.filter((d) => ![...BY_DESIGN, ...REPAIRED].some((re) => re.test(d.kind))).length
        const repaired = diffs.some((d) => REPAIRED.some((re) => re.test(d.kind)))
        rows.push({ file: rel, status: !diffs.length ? "same" : unexpected ? "differs" : repaired ? "differs by design and outline repair only" : "differs by design only", differences: diffs.length, unexpected, kinds: ks, ms: Date.now() - t0 })
      } catch (e) {
        rows.push({ file: rel, status: "error", differences: -1, kinds: [], ms: Date.now() - t0, error: e instanceof Error ? e.stack?.slice(0, 400) : String(e) })
      }
      if (OUT) appendFileSync(OUT + ".progress", `${rows.length}/${files.length} ${rows[rows.length - 1].status} ${rel}\n`)
    }
    const imported = rows.filter((r) => ["same", "differs", "written file refused", "error"].some((s) => r.status.startsWith(s)))
    const summary = {
      boards: rows.length,
      imported: imported.length,
      same: rows.filter((r) => r.status === "same").length,
      differsByDesignOnly: rows.filter((r) => r.status === "differs by design only").length,
      differsByDesignAndRepairOnly: rows.filter((r) => r.status === "differs by design and outline repair only").length,
      differs: rows.filter((r) => r.status === "differs").length,
      refusedWritten: rows.filter((r) => r.status.startsWith("written file refused")).length,
      errors: rows.filter((r) => r.status === "error").length,
      kinds: [...kinds].sort((x, y) => y[1].boards - x[1].boards).map(([k, v]) => ({ kind: k, ...v })),
    }
    if (OUT) writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1))
    expect(summary.errors).toBe(0)
  }, 6 * 3600_000)
})
