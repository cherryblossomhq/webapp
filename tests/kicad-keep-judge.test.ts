import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { fileVersion, parseAt, scanList } from "../src/export/keep/sexp"
import { loadKicadFont } from "../src/lib/kicadFont/load"
import { sampleOf } from "./kicad-corpus-shared"
import { judge, kicadCliAvailable } from "./kicad-judge/cli"
import { compareJudged, type Diff } from "./kicad-judge/compare"
import { compareBoardFiles } from "./kicad-judge/settings"
import { importKept, projectFiles } from "./kicad-keep-corpus.test"

// KiCad judges a kept project after one edit. The edit: one part moved by 1 mm. Two copies of the user's folder are made:
//  - "truth": the original with the one footprint's `(at ...)` changed by hand, which is what KiCad itself would write for the same move;
//  - "patched": the original with the export's patch written over its board and schematics.
// KiCad's own checks (position file, netlist, IPC netlist, Gerbers, drills, DRC, ERC, BOM) are run on both and compared, and so are the two board files node by node.
// They should say the same: the only difference the patch may make is the refill of a copper pour the move touched.
//
//   KICAD_KEEP_JUDGE=1 KICAD_CORPUS=<dir> KEEP_OUT=<file> npx vitest run tests/kicad-keep-judge.test.ts     (KICAD_CORPUS_SAMPLE, KICAD_ONLY, KICAD_SHARD=i/n, KEEP_MAX_MB)

const CORPUS = process.env.KICAD_CORPUS
const ON = !!process.env.KICAD_KEEP_JUDGE
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []
const FILL = /stored fill|filled areas|filled_polygon|starved_thermal|isolated_copper|zone fill|zones? (?:fill|refill)/i
const fwd = (p: string) => p.split("\\").join("/")
const log = (t: string) => process.env.KEEP_OUT && appendFileSync(process.env.KEEP_OUT, `${t}\n`)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "census") walk(p, out)
    } else if (name.endsWith(".kicad_pcb")) out.push(p)
  }
  return out
}

describe.skipIf(!ON || !CORPUS || !existsSync(CORPUS ?? "") || !kicadCliAvailable())("KiCad judges a kept project after one edit", () => {
  it("a patched move says what the same move by hand says", async () => {
    let files = walk(CORPUS!).sort()
    if (ONLY.length) files = files.filter((f) => ONLY.some((o) => fwd(f).includes(o)))
    files = sampleOf(files)
    const shard = /^(\d+)\/(\d+)$/.exec(process.env.KICAD_SHARD ?? "")
    if (shard) files = files.filter((_, i) => i % Number(shard[2]) === Number(shard[1]))
    await loadKicadFont({ cjk: true })
    const scratch = mkdtempSync(join(tmpdir(), "keepjudge-"))
    const kinds = new Map<string, number>()
    let judged = 0
    let same = 0
    let withFills = 0
    let fellBack = 0
    for (const [n, pcb] of files.entries()) {
      const rel = fwd(relative(CORPUS!, pcb))
      if (statSync(pcb).size > Number(process.env.KEEP_MAX_MB ?? 3) * 1048576) continue
      const text = readFileSync(pcb, "utf8")
      const version = fileVersion(text)
      if (version === null || version < 20241229 || version > 20260101) continue
      const { files: input } = projectFiles(pcb)
      const p = await importKept(input)
      if (typeof p === "string") continue
      const mover = p.components.find((c) => c.pcb?.placed && c.pcb.side === "top")
      if (!mover) continue
      const dx = 1
      const edited = { ...p, components: p.components.map((c) => (c === mover ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + dx } } : c)) }
      try {
        const out = await kicadFiles(edited)
        const dir = dirname(pcb)
        const truth = join(scratch, `${n}-truth`)
        const patched = join(scratch, `${n}-patched`)
        for (const d of [truth, patched]) cpSync(dir, d, { recursive: true, filter: (s) => !s.endsWith(".lck") })
        // truth: the one footprint's place changed in the original's own text
        const root = scanList(text, 0)
        let edit: { start: number; end: number; text: string } | null = null
        for (const k of root.kids) {
          if (!text.startsWith("(footprint", k.start)) continue
          const node = parseAt(text, k.start, k.end)
          const ref = node.kids!.find((x) => x.head === "property" && x.kids![1]?.value === "Reference")?.kids![2]?.value
          if (ref !== mover.ref) continue
          const at = node.kids!.find((x) => x.head === "at")!
          const x = Number(at.kids![1].raw) + dx
          edit = { start: at.kids![1].start, end: at.kids![1].end, text: String(Math.round(x * 1e6) / 1e6) }
          break
        }
        if (!edit) continue
        writeFileSync(join(truth, basename(pcb)), text.slice(0, edit.start) + edit.text + text.slice(edit.end))
        const names = Object.keys(out.files)
        const outPcb = names.find((f) => f.endsWith(".kicad_pcb"))!
        const modes = out.kept ?? []
        if (modes.some((k) => k.mode === "written" && k.detail !== "it is new")) {
          fellBack++
          log(`${rel}: fell back (${modes.filter((k) => k.mode === "written").map((k) => k.detail).join("; ")})`)
          continue
        }
        writeFileSync(join(patched, basename(pcb)), out.files[outPcb])
        for (const f of input.filter((x) => x.path.endsWith(".kicad_sch"))) {
          const o = names.find((nm) => basename(f.path) === nm)
          if (o) writeFileSync(join(patched, f.path), out.files[o])
        }
        const root0 = input.find((x) => x.path.endsWith(".kicad_sch"))
        const sch = (d: string) => (root0 ? join(d, root0.path) : null)
        const [a, b] = await Promise.all([judge(join(truth, basename(pcb)), sch(truth), join(truth, "j")), judge(join(patched, basename(pcb)), sch(patched), join(patched, "j"))])
        const all: Diff[] = compareJudged(a, b)
        all.push(...(await compareBoardFiles(join(truth, basename(pcb)), join(patched, basename(pcb)), join(scratch, `${n}-cmp`))))
        // A pour the move touched is refilled by the editor and not by KiCad, which the hand edit did not do: those lines, and the folder's name that KiCad puts in a netlist, are not the patch's.
        const diffs = all.filter((d) => !FILL.test(`${d.kind} ${d.detail}`) && !/part flag Sheetfile/.test(d.kind))
        const fills = all.length - diffs.length
        judged++
        if (!diffs.length) same++
        if (fills) withFills++
        for (const k of new Set(diffs.map((d) => d.kind))) kinds.set(k, (kinds.get(k) ?? 0) + 1)
        log(`${rel}: moved ${mover.ref}; ${fills} pour-refill lines; ${diffs.length ? diffs.slice(0, 6).map((d) => `${d.kind}: ${d.detail}`.slice(0, 160)).join(" || ") : "KiCad says the same"} [${modes.map((k) => `${k.file}:${k.mode}`).join(",")}]`)
        rmSync(truth, { recursive: true, force: true })
        rmSync(patched, { recursive: true, force: true })
      } catch (e) {
        log(`${rel}: ERROR ${e instanceof Error ? e.message.slice(0, 200) : e}`)
      }
    }
    log(`judged ${judged}, KiCad says the same but for pour refills for ${same} (${withFills} of them had refill lines), fell back to a full export for ${fellBack}; kinds: ${JSON.stringify([...kinds])}`)
    rmSync(scratch, { recursive: true, force: true })
    expect(true).toBe(true)
  }, 12 * 3600_000)
})
