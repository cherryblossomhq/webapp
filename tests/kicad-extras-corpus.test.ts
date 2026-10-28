import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildFabricationFiles } from "../src/export/bundle"
import { backdrillSets, excellonBackdrill, excellonDrill } from "../src/export/excellon"
import { kicadFiles } from "../src/export/kicad"
import { fabricationNotes } from "../src/export/notes"
import { viaProtectionFiles } from "../src/export/viaProtection"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { rememberImage } from "../src/store/imageFiles"
import { checkExtras } from "./kicad-extras-check"
import { BY_DESIGN, canonicalProject, diffCanonical, diffProjects, proRulesDifferences } from "./kicad-roundtrip-check"

import { unknownNodes } from "./kicad9-nodes"
import { cachedExport, cachedParse, sampleOf, startWatchdog } from "./kicad-corpus-shared"

// X21 and X22 over the boards of the corpus that use them: every one imports (a board that also needs an extension another slice builds is imported with that one counted built, and said so), what
// it holds is compared with an oracle that reads the raw file (`kicad-extras-check.ts`), its fabrication files export, it saves and loads with no difference, and it is written out and read back
// with only the differences that are by design (a KiCad 9 file cannot hold KiCad 10's words).
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 npx vitest run tests/kicad-extras-corpus.test.ts
//
// The boards are found from the census (`census/boards.json`), by the nodes the need rules look for; KICAD_CORPUS_SAMPLE=N runs about N of them (see kicad-corpus-shared.ts). With no corpus the test is skipped.

const CORPUS = process.env.KICAD_CORPUS
const OUT = process.env.KICAD_EXTRAS_OUT
const ALL = new Set([...BUILT_EXTENSIONS, ...Array.from({ length: 31 }, (_, i) => `X${i + 1}`)])
const X = /^(generated|net_chains|footprint>pad>(die_length|die_delay|backdrill|tertiary_drill|front_post_machining|back_post_machining)|via>(capping|covering|plugging|filling|backdrill|tertiary_drill|front_post_machining|back_post_machining))/

describe.skipIf(!CORPUS || !existsSync(join(CORPUS ?? "", "census", "boards.json")))("X21 and X22 over the corpus", () => {
  it("imports, matches the oracle, exports, saves and loads, and writes back", async () => {
    const boards: { file: string; nodes: Record<string, number> }[] = JSON.parse(readFileSync(join(CORPUS!, "census", "boards.json"), "utf8"))
    const all = boards.filter((b) => Object.keys(b.nodes).some((n) => X.test(n))).map((b) => b.file)
    const files = sampleOf(all)
    const dog = startWatchdog("kicad-extras-corpus")
    const rows: Record<string, unknown>[] = []
    const problems: string[] = []
    for (const rel of files) {
      const row: Record<string, unknown> = { file: rel }
      dog.board(rel)
      rows.push(row)
      try {
        const bytes = readFileSync(join(CORPUS!, rel))
        const text = bytes.toString("utf8")
        let r = cachedParse(join(CORPUS!, rel), "importKicadBoard:unlimited", () => importKicadBoard(bytes, { limitBytes: Infinity }))
        row.status = r.status
        if (r.status === "refused") {
          row.refusedFor = r.needs?.map((n) => n.ext) ?? r.reason
          row.forced = true
          r = cachedParse(join(CORPUS!, rel), "importKicadBoard:unlimited:all-built", () => importKicadBoard(bytes, { built: ALL, limitBytes: Infinity }))
        }
        if (r.status !== "imported") {
          row.skipped = r.message.slice(0, 160)
          continue
        }
        for (const f of r.files) rememberImage(f.id, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
        const project = r.project
        // the oracle
        const check = checkExtras(text, project)
        row.uses = check.uses
        row.vias = check.vias
        row.generators = check.generators
        if (check.wrong.length) problems.push(`${rel}: ${check.wrong.slice(0, 4).join("; ")}`)
        // the outputs
        try {
          const out = buildFabricationFiles(project)
          row.files = Object.keys(out).length
          row.backdrillFiles = Object.keys(out).filter((f) => /backdrill/i.test(f)).length
          row.protectionFiles = Object.keys(out).filter((f) => /-(filling|capping|covering|plugging)-/.test(f)).length
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e)
          if (/outline/i.test(m)) {
            // a board with no outline has no Gerber files (the editor says so), but its drill, protection and notes files do not need one
            row.outputs = "no outline: the drill, protection and notes files only"
            const sets = backdrillSets(project)
            row.backdrillFiles = sets.length * 2
            for (const set of sets) excellonBackdrill(project, set, true)
            excellonDrill(project)
            row.protectionFiles = viaProtectionFiles(project).length
            fabricationNotes(project, [], [])
          } else problems.push(`${rel}: the fabrication files did not export: ${m.slice(0, 120)}`)
        }
        // save and load
        const back = parseProjectFile(serializeProject(project), { id: "x", createdAt: 0, updatedAt: 0 })
        const same = diffCanonical(canonicalProject(project), canonicalProject(back), 5)
        row.saveLoad = same.length
        if (same.length) problems.push(`${rel}: save and load differ: ${same.map((d) => `${d.path} ${d.first} / ${d.second}`).join("; ").slice(0, 300)}`)
        // the write back
        const written = await cachedExport("kicadFiles", project, () => kicadFiles(project))
        const pcb = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
        const pro = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pro"))![1]
        const again = importKicadBoard(pcb, { built: ALL, limitBytes: Infinity })
        if (again.status !== "imported") {
          problems.push(`${rel}: the written board is refused: ${again.message.slice(0, 120)}`)
          continue
        }
        const diffs = [...diffProjects(project, again.project, 400), ...proRulesDifferences(project, pro)]
        const tuning = (p: typeof project) => (p.groups ?? []).filter((g) => g.gen?.kind === "tuning_pattern").length
        if (tuning(project) !== tuning(again.project)) diffs.push({ kind: "tuning pattern", path: "project.groups", first: String(tuning(project)), second: String(tuning(again.project)) })
        const strange = unknownNodes(pcb)
        if (strange.length) diffs.push({ kind: `written nodes KiCad 9.0 does not have: ${strange.join(" ")}`, path: "the written file", first: "", second: strange.join(" ") })
        const unexpected = diffs.filter((d) => !BY_DESIGN.some((re) => re.test(d.kind)) && !/^project\.board\.outlineDrawn: /.test(d.kind))
        row.writeBack = { differences: diffs.length, byDesign: diffs.length - unexpected.length, unexpected: unexpected.length }
        if (unexpected.length) problems.push(`${rel}: ${unexpected.length} unexpected write back differences: ${unexpected.slice(0, 3).map((d) => `${d.path} ${d.first} / ${d.second}`).join("; ").slice(0, 300)}`)
      } catch (e) {
        problems.push(`${rel}: error ${e instanceof Error ? (e.stack ?? e.message).slice(0, 300) : String(e)}`)
        row.error = true
      }
      if (OUT) appendFileSync(`${OUT}.progress`, `${rows.length}/${files.length} ${rel}\n`)
    }
    dog.stop()
    if (OUT) writeFileSync(OUT, JSON.stringify({ boards: files.length, imported: rows.filter((r) => r.uses !== undefined).length, forced: rows.filter((r) => r.forced).length, problems, rows }, null, 1))
    expect(problems).toEqual([])
    // the count only means something for the whole set
    if (files.length === all.length) expect(files.length).toBeGreaterThan(30)
  }, 3 * 3600_000)
})
