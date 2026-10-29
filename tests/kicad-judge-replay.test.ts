import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readJudged } from "./kicad-judge/cli"
import { compareJudged, type Diff } from "./kicad-judge/compare"
import { compareSettings } from "./kicad-judge/settings"

// Runs the comparisons of the KiCad-judged audit again over the files a run kept (KICAD_JUDGE_KEEP of `kicad-judge-corpus.test.ts`), without importing, exporting
// or running KiCad: for working on the comparisons. KICAD_JUDGE_REPLAY=<the keep folder> KICAD_JUDGE_OUT=<file>.

const DIR = process.env.KICAD_JUDGE_REPLAY
const OUT = process.env.KICAD_JUDGE_OUT

describe.skipIf(!DIR || !existsSync(DIR ?? ""))("replay of the kept files of a KiCad-judged run", () => {
  it("compares again", async () => {
    const kinds = new Map<string, { boards: number; example: string; total: number }>()
    const rows: { file: string; diffs: Diff[] }[] = []
    for (const run of readdirSync(DIR!)) {
      for (const n of readdirSync(join(DIR!, run))) {
        const dir = join(DIR!, run, n)
        if (!existsSync(join(dir, "meta.json"))) continue
        const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { pcb: string; sch: string | null; pro: string | null; outPcb: string; outPro: string; hasSch: boolean }
        const diffs = compareJudged(readJudged(join(dir, "orig"), !!meta.sch), readJudged(join(dir, "back"), meta.hasSch))
        diffs.push(...(await compareSettings(meta.pcb, join(dir, "export", meta.outPcb), dir, meta.pro, join(dir, "export", meta.outPro))))
        rows.push({ file: meta.pcb, diffs })
        for (const d of diffs) {
          const k = kinds.get(d.kind) ?? { boards: 0, example: `${meta.pcb}: ${d.detail}`.slice(0, 400), total: 0 }
          kinds.set(d.kind, k)
          k.total++
        }
        for (const k of new Set(diffs.map((d) => d.kind))) kinds.get(k)!.boards++
      }
    }
    const summary = { boards: rows.length, same: rows.filter((r) => !r.diffs.length).length, kinds: [...kinds].sort((x, y) => y[1].boards - x[1].boards).map(([kind, v]) => ({ kind, ...v })) }
    if (OUT) writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1))
    expect(rows.length).toBeGreaterThan(0)
  }, 3600_000)
})
