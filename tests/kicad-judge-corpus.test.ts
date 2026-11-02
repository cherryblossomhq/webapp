import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { loadKicadFont } from "../src/lib/kicadFont/load"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import { rememberImage } from "../src/store/imageFiles"
import { startWatchdog, sampleOf } from "./corpus/shared"
import { judge, kicadCliAvailable, type Judged } from "./kicad-judge/cli"
import { compareJudged, type Diff } from "./kicad-judge/compare"
import { compareSettings } from "./kicad-judge/settings"

// The KiCad-judged round trip over a local corpus (not in the repo). For every project: the original files are imported by the importer, written by the
// KiCad export, and then KiCad's own command line (`kicad-cli`) is run on BOTH the original and the export: position file, IPC-D-356 netlist, gerbers,
// drill files, DRC, and for a project with a schematic its netlist, BOM and ERC. KiCad is the judge; every difference is a line of the table.
//
//   KICAD_JUDGE=1 KICAD_CORPUS=<corpus dir> KICAD_JUDGE_OUT=<file.json> NODE_OPTIONS=--max-old-space-size=6144 \
//     npx vitest run --maxWorkers=1 --no-file-parallelism tests/kicad-judge-corpus.test.ts
//
// KICAD_CORPUS_SAMPLE=N, KICAD_ONLY (comma separated path fragments) and KICAD_LIMIT narrow the run; KICAD_JUDGE_KEEP=<dir> keeps the files of every board there;
// KICAD_SHARD=i/n runs the i-th of n slices of the chosen boards (0-based, every n-th board), so n processes with their own KICAD_JUDGE_OUT can split a run;
// each board's row is also appended to `<KICAD_JUDGE_OUT>.rows.jsonl` as it finishes, so a run that stops keeps what it did.
// KICAD_CLI points at another kicad-cli. Skipped without KICAD_JUDGE, a corpus and kicad-cli.

const CORPUS = process.env.KICAD_CORPUS
const ON = !!process.env.KICAD_JUDGE
const OUT = process.env.KICAD_JUDGE_OUT
const KEEP = process.env.KICAD_JUDGE_KEEP
const LIMIT = Number(process.env.KICAD_LIMIT ?? 0)
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []

const fwd = (p: string) => p.split("\\").join("/")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "census") walk(p, out)
    } else if (name.endsWith(".kicad_pcb")) out.push(p)
  }
  return out
}

/** The files the import screen would be given for a board: the board, and the project, rules and schematics beside it (a sheet may sit below the board's folder). */
function projectFiles(pcb: string): { files: ProjectFile[]; sch: string | null; pro: string | null } {
  const dir = dirname(pcb)
  const stem = basename(pcb, ".kicad_pcb")
  const files: ProjectFile[] = [{ path: basename(pcb), data: new Uint8Array(readFileSync(pcb)) }]
  const names = readdirSync(dir)
  const pros = names.filter((n) => n.endsWith(".kicad_pro"))
  const pro = pros.includes(`${stem}.kicad_pro`) ? `${stem}.kicad_pro` : pros.length === 1 ? pros[0] : null
  if (pro) files.push({ path: pro, data: new Uint8Array(readFileSync(join(dir, pro))) })
  const dru = names.includes(`${stem}.kicad_dru`) ? `${stem}.kicad_dru` : names.filter((n) => n.endsWith(".kicad_dru")).length === 1 ? names.find((n) => n.endsWith(".kicad_dru")) : null
  if (dru) files.push({ path: dru, data: new Uint8Array(readFileSync(join(dir, dru))) })
  const sub = (d: string, rel: string, depth: number) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) {
        if (depth < 3 && !n.startsWith(".")) sub(p, `${rel}${n}/`, depth + 1)
      } else if (n.endsWith(".kicad_sch")) files.push({ path: `${rel}${n}`, data: new Uint8Array(readFileSync(p)) })
    }
  }
  sub(dir, "", 0)
  // the root schematic KiCad pairs with the board: the project's name, else the board's
  const root = [pro ? pro.replace(/\.kicad_pro$/, "") : null, stem].find((s) => s && existsSync(join(dir, `${s}.kicad_sch`)))
  return { files, sch: root ? join(dir, `${root}.kicad_sch`) : null, pro: pro ? join(dir, pro) : null }
}

describe.skipIf(!ON || !CORPUS || !existsSync(CORPUS ?? "") || !kicadCliAvailable())("KiCad judges the round trip over the corpus", () => {
  it("what KiCad says of the original and of the export is the same", async () => {
    let files = walk(CORPUS!).sort()
    if (ONLY.length) files = files.filter((f) => ONLY.some((o) => fwd(f).includes(o)))
    files = sampleOf(files)
    const shard = /^(\d+)\/(\d+)$/.exec(process.env.KICAD_SHARD ?? "")
    if (shard) files = files.filter((_, i) => i % Number(shard[2]) === Number(shard[1]))
    if (LIMIT) files = files.slice(0, LIMIT)
    await loadKicadFont({ cjk: true })
    const scratch = mkdtempSync(join(KEEP ?? tmpdir(), "judge-"))
    const dog = startWatchdog("kicad-judge", Number(process.env.KICAD_BOARD_TIMEOUT_S ?? 900) * 1000)
    const rows: { file: string; status: string; diffs: Diff[]; ms: number; error?: string; kicadErrors?: string[] }[] = []
    const kinds = new Map<string, { boards: number; example: string; total: number }>()
    for (const [n, pcb] of files.entries()) {
      const rel = fwd(relative(CORPUS!, pcb))
      const t0 = Date.now()
      dog.board(rel)
      try {
        const { files: input, sch, pro } = projectFiles(pcb)
        const r = importKicadProject(input, { limitBytes: Number.MAX_SAFE_INTEGER })
        if (r.status !== "imported") {
          rows.push({ file: rel, status: `not imported (${r.reason})`, diffs: [], ms: Date.now() - t0 })
          if (OUT) appendFileSync(`${OUT}.rows.jsonl`, `${JSON.stringify(rows[rows.length - 1])}\n`)
          continue
        }
        for (const f of r.files ?? []) rememberImage(f.id, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
        const written = await kicadFiles(r.project)
        const dir = join(scratch, String(n))
        mkdirSync(dir, { recursive: true })
        for (const [name, text] of Object.entries(written.files)) {
          mkdirSync(dirname(join(dir, "export", name)), { recursive: true })
          writeFileSync(join(dir, "export", name), text)
        }
        const outPcb = Object.keys(written.files).find((k) => k.endsWith(".kicad_pcb"))!
        const outSch = Object.keys(written.files).find((k) => k.endsWith(".kicad_sch") && basename(k, ".kicad_sch") === basename(outPcb, ".kicad_pcb"))
        if (KEEP) writeFileSync(join(dir, "meta.json"), JSON.stringify({ pcb, sch, pro, outPcb, outPro: Object.keys(written.files).find((k) => k.endsWith(".kicad_pro")), hasSch: !!(sch && outSch) }))
        const [a, b]: Judged[] = await Promise.all([judge(pcb, sch, join(dir, "orig")), judge(join(dir, "export", outPcb), sch && outSch ? join(dir, "export", outSch) : null, join(dir, "back"))])
        const diffs = compareJudged(a, b)
        diffs.push(...await compareSettings(pcb, join(dir, "export", outPcb), dir, pro, join(dir, "export", Object.keys(written.files).find((k) => k.endsWith(".kicad_pro"))!)))
        rows.push({ file: rel, status: diffs.length ? "differs" : "same", diffs, ms: Date.now() - t0, ...(a.errors.length || b.errors.length ? { kicadErrors: [...a.errors.map((e) => `orig ${e}`), ...b.errors.map((e) => `export ${e}`)] } : {}) })
        for (const d of diffs) {
          const k = kinds.get(d.kind) ?? { boards: 0, example: `${rel}: ${d.detail}`.slice(0, 400), total: 0 }
          kinds.set(d.kind, k)
          k.total++
        }
        for (const k of new Set(diffs.map((d) => d.kind))) kinds.get(k)!.boards++
        if (!KEEP) rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        rows.push({ file: rel, status: "error", diffs: [], ms: Date.now() - t0, error: e instanceof Error ? e.stack?.slice(0, 500) : String(e) })
      }
      if (OUT) {
        appendFileSync(`${OUT}.progress`, `${rows.length}/${files.length} ${rows[rows.length - 1].status} ${rel}\n`)
        appendFileSync(`${OUT}.rows.jsonl`, `${JSON.stringify(rows[rows.length - 1])}\n`)
      }
    }
    dog.stop()
    const summary = {
      boards: rows.length,
      same: rows.filter((r) => r.status === "same").length,
      differs: rows.filter((r) => r.status === "differs").length,
      notImported: rows.filter((r) => r.status.startsWith("not imported")).length,
      errors: rows.filter((r) => r.status === "error").length,
      kicadErrors: rows.filter((r) => r.kicadErrors?.length).length,
      kinds: [...kinds].sort((x, y) => y[1].boards - x[1].boards).map(([kind, v]) => ({ kind, ...v })),
    }
    if (OUT) writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1))
    if (!KEEP) rmSync(scratch, { recursive: true, force: true })
    expect(summary.errors).toBe(0)
  }, 12 * 3600_000)
})
