// What every KiCad corpus test shares (no corpus is in the repo; the tests skip without KICAD_CORPUS):
//
//  - `sampleOf(files)`: KICAD_CORPUS_SAMPLE=N keeps about N boards, every k-th of the sorted list, the same ones on every run and in every test file.
//    Unset, the whole corpus runs. A sample is for fast iteration only; the full run is the one that counts.
//  - `cachedParse(path, kind, compute)`: the parse or import of a corpus file, kept on disk (.corpus-cache, not in git) under a key made of the
//    file's path, size and mtime and of a hash of every source file of the editor, so a change to the importer or the parser throws every entry away.
//    A hit returns a fresh copy (structured clone), so a test may change what it gets. It is OFF unless KICAD_CORPUS_CACHE=1: a warm hit still changes the extras test (see AGENTS.md).
//  - `cachedExport(kind, value, compute)`: the same for something computed from a project (the KiCad export of an imported board is most of the time of the round trip), keyed by a
//    hash of the value itself and the source hash, so it is shared by every test that exports the same project.
//  - `startWatchdog(label, ms)`: a worker thread that sees a board that has run for more than `ms` (KICAD_BOARD_TIMEOUT_S, 300 s by default) even when the main
//    thread is stuck in a loop, names it on stderr and ends the process, so a hang is a message with a board and not a silent stall.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { kicadCjkLoaded, kicadFontLoaded } from "../../src/lib/kicadFont/load"
import { registerProjectParts } from "../../src/model/customParts"
import { deserialize, serialize } from "node:v8"
import { gunzipSync, gzipSync } from "node:zlib"

const HERE = dirname(fileURLToPath(import.meta.url))
const EDITOR = join(HERE, "..", "..")

/** Where the local corpus is (`KICAD_CORPUS`); undefined when it is not set, and every test in this folder then skips. */
export const CORPUS = process.env.KICAD_CORPUS

/** Every file under `dir` that `keep` accepts (all of them when it is left out), in directory order, leaving out the `census` folder (the census's own output). */
export function walkCorpus(dir: string, keep: (name: string) => boolean = () => true, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "census") walkCorpus(p, keep, out)
    } else if (keep(name)) out.push(p)
  }
  return out
}
/** The `.kicad_pcb` files of the corpus. */
export const walkPcb = (dir: string) => walkCorpus(dir, (n) => n.endsWith(".kicad_pcb"))
/** The `.kicad_pcb` and legacy `.brd` boards of the corpus. */
export const walkBoards = (dir: string) => walkCorpus(dir, (n) => n.endsWith(".kicad_pcb") || n.endsWith(".brd"))
/** The `.kicad_sch` files of the corpus. */
export const walkSch = (dir: string) => walkCorpus(dir, (n) => n.endsWith(".kicad_sch"))

/** Writes a report file into `dir` (made if it is not there). */
export function writeReport(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
}

/** Every k-th file of the (sorted) list so that about KICAD_CORPUS_SAMPLE remain; all of them when it is unset or 0. */
export function sampleOf<T>(files: T[]): T[] {
  const n = Number(process.env.KICAD_CORPUS_SAMPLE ?? 0)
  if (!n || n >= files.length) return files
  const k = Math.ceil(files.length / n)
  return files.filter((_, i) => i % k === 0)
}

let srcHash: string | undefined
function sourceHash(): string {
  if (srcHash) return srcHash
  const h = createHash("sha1")
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) visit(p)
      else if (/\.(ts|tsx|mjs|js|json)$/.test(name)) h.update(p).update(readFileSync(p))
    }
  }
  visit(join(EDITOR, "src"))
  h.update(readFileSync(join(EDITOR, "package.json")))
  return (srcHash = h.digest("hex").slice(0, 16))
}

/** A hash of some helper files or folders of the tests (a result computed by test code is only as good as that code). */
const helperHashes = new Map<string, string>()
export function helperHash(...paths: string[]): string {
  const key = paths.join("|")
  const known = helperHashes.get(key)
  if (known) return known
  const h = createHash("sha1")
  const visit = (p: string) => {
    if (statSync(p).isDirectory()) for (const name of readdirSync(p).sort()) visit(join(p, name))
    else h.update(p).update(readFileSync(p))
  }
  for (const p of paths) visit(join(EDITOR, p))
  const out = h.digest("hex").slice(0, 16)
  helperHashes.set(key, out)
  return out
}

/**
 * What an import or an export reads that is not its input: whether KiCad's stroke font is loaded decides how the text of a footprint that is only text is laid out
 * (a courtyard 1.3 mm wider without it), and some tests load it (x19, the board test) while others do not. A result is only reused in the state it was made in.
 */
const globalState = () => `font=${kicadFontLoaded()}/${kicadCjkLoaded()}`

const CACHE_DIR = join(EDITOR, ".corpus-cache")

/**
 * An import registers the board's own parts and land patterns in the editor's registries (`registerProjectParts`, by name: the last board to register a name is the one a later
 * export or re-import of that name resolves), and later steps of a test read them. A result taken from the cache must leave the registries as the import would have, so it does it here.
 */
function replayRegistration<T>(value: T): T {
  const r = value as { status?: string; project?: Parameters<typeof registerProjectParts>[0] } | null
  if (r && r.status === "imported" && r.project) registerProjectParts(r.project)
  return value
}

/** `compute()` is the import of the file at `path` under the name `kind` (it must depend on nothing but the file's bytes, the editor's source and the font state). */
export function cachedParse<T>(path: string, kind: string, compute: () => T): T {
  if (!process.env.KICAD_CORPUS_CACHE) return compute()
  let file = ""
  try {
    const st = statSync(path)
    file = join(CACHE_DIR, `${createHash("sha1").update(`${kind}|${path}|${st.size}|${st.mtimeMs}|${sourceHash()}|${globalState()}`).digest("hex")}.v8z`)
    if (existsSync(file)) return replayRegistration(deserialize(gunzipSync(readFileSync(file))) as T)
  } catch {
    // an unreadable entry is a miss
  }
  const value = compute()
  try {
    if (file) {
      mkdirSync(CACHE_DIR, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, gzipSync(serialize(value), { level: 1 }))
      renameSync(tmp, file)
    }
  } catch {
    // a value that cannot be stored (a function in it) is simply not cached
  }
  return value
}

/** `compute()` is a function of `value` alone, of the editor's source and of the test files named in `helpers` (paths from the repository root); its result is kept under a hash of the value. */
export async function cachedExport<T>(kind: string, value: unknown, compute: () => Promise<T> | T, helpers: string[] = []): Promise<T> {
  if (!process.env.KICAD_CORPUS_CACHE) return compute()
  let file = ""
  try {
    file = join(CACHE_DIR, `${createHash("sha1").update(`${kind}|${sourceHash()}|${globalState()}|${helpers.length ? helperHash(...helpers) : ""}|`).update(serialize(value)).digest("hex")}.v8z`)
    if (existsSync(file)) return deserialize(gunzipSync(readFileSync(file))) as T
  } catch {
    // an unreadable entry, or a value that cannot be hashed, is a miss
  }
  const result = await compute()
  try {
    if (file) {
      mkdirSync(CACHE_DIR, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, gzipSync(serialize(result), { level: 1 }))
      renameSync(tmp, file)
    }
  } catch {
    // a result that cannot be stored is simply not cached
  }
  return result
}

export interface Watchdog {
  /** Call at the start of each board: the beat tells the worker the run is alive, and `name` is what it names if the board hangs. */
  board(name: string): void
  stop(): void
}

export function startWatchdog(label: string, limitMs = Number(process.env.KICAD_BOARD_TIMEOUT_S ?? 300) * 1000): Watchdog {
  const cells = new SharedArrayBuffer(12)
  const view = new Int32Array(cells)
  mkdirSync(CACHE_DIR, { recursive: true })
  const currentFile = join(CACHE_DIR, `${label}.${process.pid}.current`)
  const worker = new Worker(join(HERE, "watchdog-worker.cjs"), { workerData: { label, limitMs, cells, currentFile, pid: process.pid } })
  worker.unref()
  return {
    board(name) {
      writeFileSync(currentFile, name)
      Atomics.add(view, 0, 1)
    },
    stop() {
      Atomics.store(view, 1, 1)
      void worker.terminate()
      try {
        unlinkSync(currentFile)
      } catch {
        // already gone
      }
    },
  }
}
