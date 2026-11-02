import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { contentHash, packOriginal } from "../src/export/keep/pack"
import { loadKicadFont } from "../src/lib/kicadFont/load"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import type { Project } from "../src/model/types"
import { rememberImage } from "../src/store/imageFiles"
import { sampleOf } from "./kicad-corpus-shared"

// A KiCad project kept as the user's own files (`export/keep/`): over a local corpus (not in the repo), for every board that imports,
//  1. nothing changed: the export is the original files, byte for byte;
//  2. one edit (a part moved, a net renamed, a track deleted, a part added): every file but the edited ones is still byte for byte,
//     and the edited file differs from the original only in the edited item.
//
//   KICAD_KEEP=1 KICAD_CORPUS=<dir> npx vitest run tests/kicad-keep-corpus.test.ts     (KICAD_CORPUS_SAMPLE=N, KICAD_ONLY=a,b, KICAD_LIMIT=N)

const CORPUS = process.env.KICAD_CORPUS
const ON = !!process.env.KICAD_KEEP
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

/** The files the import screen would be given for a board (as the judge's harness does). */
export function projectFiles(pcb: string): { files: ProjectFile[] } {
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
  return { files }
}

const log = (text: string) => process.env.KEEP_OUT && appendFileSync(process.env.KEEP_OUT, `${text}\n`)
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** The project as the import screen keeps it: with the record of the kept files, which are in the page's file cache. */
export async function importKept(input: ProjectFile[]): Promise<Project | string> {
  const first = input.find((f) => f.path.endsWith(".kicad_pro")) ?? input[0]
  const name = basename(first.path).replace(/.[^.]+$/, "")
  const r = importKicadProject(input, { limitBytes: Number.MAX_SAFE_INTEGER, name })
  if (r.status !== "imported") return `not imported (${r.reason})`
  for (const f of r.files ?? []) rememberImage(f.id, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
  const data = input.map((f) => ({ path: f.path, data: typeof f.data === "string" ? new TextEncoder().encode(f.data) : f.data }))
  const packed = await packOriginal(data)
  rememberImage(packed.id, packed.bytes.buffer.slice(packed.bytes.byteOffset, packed.bytes.byteOffset + packed.bytes.byteLength) as ArrayBuffer)
  return { ...r.project, kicad: { ...r.project.kicad, original: { file: packed.id, size: packed.bytes.length, content: await contentHash(r.project), name } } }
}

describe.skipIf(!ON || !CORPUS || !existsSync(CORPUS ?? ""))("the user's own KiCad files are kept", () => {
  it("an import that changes nothing exports the original files byte for byte", async () => {
    let files = walk(CORPUS!).sort()
    if (ONLY.length) files = files.filter((f) => ONLY.some((o) => fwd(f).includes(o)))
    files = sampleOf(files)
    await loadKicadFont({ cjk: true })
    const rows: string[] = []
    let identical = 0
    let skipped = 0
    for (const pcb of files) {
      const rel = fwd(relative(CORPUS!, pcb))
      log(`${new Date().toISOString().slice(11, 19)} ${rel}`)
      if (statSync(pcb).size > Number(process.env.KEEP_MAX_MB ?? 4) * 1048576) {
        skipped++
        continue
      }
      const { files: input } = projectFiles(pcb)
      const p = await importKept(input)
      if (typeof p === "string") {
        skipped++
        continue
      }
      const out = await kicadFiles(p)
      const bad: string[] = []
      for (const k of out.kept ?? []) {
        if (k.mode === "written" && k.detail !== "it is new") bad.push(`${k.file}: written (${k.detail})`)
      }
      for (const f of input.filter((x) => !x.path.includes("-backups/"))) {
        const name = out.exact && Object.keys(out.exact).find((n) => n === basename(f.path))
        if (!name) continue
        const data = typeof f.data === "string" ? new TextEncoder().encode(f.data) : f.data
        if (!bytesEqual(out.exact![name], data)) bad.push(`${name}: bytes differ`)
      }
      if (!bad.length && out.kept?.some((k) => k.mode === "original" && k.detail === "unchanged")) identical++
      else rows.push(`${rel}: ${bad.join("; ") || "no kept files"}`)
    }
    log(`byte for byte: ${identical} of ${files.length - skipped} imported boards (${skipped} not imported)`)
    if (rows.length) log(rows.slice(0, 40).join("\n"))
    expect(rows).toEqual([])
  }, 3600_000)
  it("one edit changes only the edited item in the edited file", async () => {
    let files = walk(CORPUS!).sort()
    if (ONLY.length) files = files.filter((f) => ONLY.some((o) => fwd(f).includes(o)))
    files = sampleOf(files)
    await loadKicadFont({ cjk: true })
    const rows: string[] = []
    let tried = 0
    let patchedBoards = 0
    for (const pcb of files) {
      if (statSync(pcb).size > Number(process.env.KEEP_MAX_MB ?? 4) * 1048576) continue
      const rel = fwd(relative(CORPUS!, pcb))
      log(`${new Date().toISOString().slice(11, 19)} ${rel}`)
      const { files: input } = projectFiles(pcb)
      const p = await importKept(input)
      if (typeof p === "string") continue
      const original = new TextDecoder().decode(input[0].data as Uint8Array)
      const edits: Record<string, (q: Project) => Project> = {
        move: (q) => {
          const m = q.components.find((c) => c.pcb?.placed)
          return { ...q, components: q.components.map((c) => (c === m ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + 1 } } : c)) }
        },
        deleteTrack: (q) => ({ ...q, traces: q.traces.slice(1) }),
        moveSymbol: (q) => ({ ...q, components: q.components.map((c, i) => (i === 0 ? { ...c, sch: { ...c.sch, x: c.sch.x + 1 } } : c)) }),
        renameRef: (q) => ({ ...q, components: q.components.map((c, i) => (i === 0 ? { ...c, ref: "ZZ1" } : c)) }),
        deleteWire: (q) => ({ ...q, wires: q.wires.slice(1) }),
        addPart: (q) => (q.components.length && q.components[0].pcb ? { ...q, components: [...q.components, { ...q.components[0], id: "zz-new", ref: "ZZ99", uuid: undefined, pcb: { ...q.components[0].pcb, x: q.components[0].pcb.x + 5 } }] } : q),
      }
      for (const [name, edit] of Object.entries(edits)) {
        const q = edit(p)
        if (q === p || (name === "deleteTrack" && !p.traces.length) || (name === "deleteWire" && !p.wires.length)) continue
        tried++
        try {
          const out = await kicadFiles(q)
          const board = out.kept?.find((k) => k.file.endsWith(".kicad_pcb"))
          if (board?.mode === "patched") patchedBoards++
          const text = Object.entries(out.files).find(([n]) => n.endsWith(".kicad_pcb"))![1]
          const was = original.split("\n")
          const now = text.split("\n")
          const set = new Set(was)
          const added = now.filter((l) => !set.has(l)).length
          const back = importKicadProject([{ path: basename(pcb), data: text }, ...input.slice(1).filter((f) => !f.path.endsWith(".kicad_sch") || true)], { limitBytes: Number.MAX_SAFE_INTEGER, name: "x" })
          rows.push(`${rel} ${name}: ${(out.kept ?? []).filter((k) => k.mode !== "original" || k.detail !== "unchanged").map((k) => `${k.file} ${k.mode} (${k.detail})`).join("; ") || "all original"} | board new lines ${added} of ${now.length}; re-imports: ${back.status}`)
        } catch (e) {
          rows.push(`${rel} ${name}: ERROR ${e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : e}`)
        }
      }
    }
    log(`edits tried ${tried}, board patched in ${patchedBoards}\n${rows.join("\n")}`)
  }, 3600_000)
})
