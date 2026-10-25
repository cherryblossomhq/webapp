import type { ImportOptions, KicadImportResult } from "../model/kicad/board/import"
import { baseName, expand, ImportInputError, kindOf, MAX_FILE_BYTES, pick, type InputFile, type ProjectFiles } from "./pick"
import type { StartRequest, WorkerEvent } from "./protocol"
import { emptyContext, stoppedSummary, summarize, type FileContext } from "./summary"

// One import job, start to finish: open the zips, pick the board, read it, run the importer and
// summarize. It runs in the worker (`worker.ts`) and, where the browser has no workers, on the page.
// It never throws: a file that cannot be imported is a summary with its reason, and anything that
// breaks unexpectedly is one with a sentence for the user and no stack.

export interface BoardImporter {
  importKicadBoard(input: Uint8Array, options?: ImportOptions): KicadImportResult
}

/** The files a project import is given, read: the board and what sits beside it. */
export interface ProjectBytes {
  board: Uint8Array
  projectFile: { name: string; bytes: Uint8Array } | null
  schematics: { name: string; bytes: Uint8Array }[]
  rules: { name: string; bytes: Uint8Array } | null
  libraries: { name: string; bytes: Uint8Array }[]
}

/** The schematic and project importer (`importKicadProject`), which gives the same result as the board importer. */
export type ProjectImporter = (files: ProjectBytes, options: ImportOptions) => KicadImportResult | Promise<KicadImportResult>

/**
 * The importers are loaded when a job starts, not before, so their code (the board reader and the
 * 279 KB table of KiCad's stock 3D models) is in a chunk of its own and not in the page's bundle.
 */
const loadBoardImporter = (): Promise<BoardImporter> => import("../model/kicad/board")

/** KiCad's stroke font, and its CJK glyphs when the file has a character from them (a UTF-8 lead byte of U+3000 and up, or a UTF-16 file). */
async function loadKicadFontFor(bytes: Uint8Array) {
  const { loadKicadFont } = await import("../lib/kicadFont/load")
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  await loadKicadFont({ cjk: utf16 || bytes.some((b) => b >= 0xe3 && b <= 0xef) })
}

/**
 * Where the schematic and project importer plugs in. While `null`, a project's schematic and
 * project files are named in the report as not read yet and the board is imported alone. To plug it
 * in, replace `null` with:
 *   () => import("../model/kicad/project").then((m) => m.importKicadProject)
 */
const loadProjectImporter: (() => Promise<ProjectImporter>) | null = null

export interface EngineOptions {
  loadBoardImporter?: () => Promise<BoardImporter>
  loadProjectImporter?: (() => Promise<ProjectImporter>) | null
  /** Passed to the importer: tests raise the built extensions with it. */
  importOptions?: ImportOptions
  /** The largest file read; tests lower it. */
  readLimit?: number
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

const wrap = (e: StartRequest["files"][number]): InputFile => ({ path: e.path || e.file.name, size: e.file.size, read: async () => new Uint8Array(await e.file.arrayBuffer()) })

/** A name for the new project: the KiCad project's, or the board's. */
export function projectName(files: ProjectFiles): string {
  const stem = (f: InputFile) => baseName(f.path).replace(/\.[^.]+$/, "")
  return (files.projectFile ? stem(files.projectFile) : stem(files.board)) || "Imported KiCad board"
}

export async function runImport(req: StartRequest, post: (e: WorkerEvent) => void, options: EngineOptions = {}): Promise<void> {
  const { id } = req
  const done = (outcome: Extract<WorkerEvent, { type: "done" }>["outcome"]) => post({ type: "done", id, outcome })
  try {
    post({ type: "progress", id, phase: "reading" })
    const expanded = await expand(req.files.map(wrap), options.readLimit)
    const picked = pick(expanded, req.choice)
    const ignored = picked.ignored
    if (picked.kind === "none") {
      const bad = expanded.badZips.length > 0 && expanded.files.length === 0
      return done({ project: null, summary: stoppedSummary(bad ? "bad-input" : "no-board", picked.why, { ...emptyContext(), ignored }) })
    }
    if (picked.kind === "choose") return post({ type: "choose", id, boards: picked.boards })

    const { files } = picked
    const context: FileContext = { used: [baseName(files.board.path)], notRead: [], ignored, boardBytes: 0 }
    if (files.board.size !== null && files.board.size > MAX_FILE_BYTES) {
      return done({ project: null, summary: stoppedSummary("bad-input", `${baseName(files.board.path)} is ${mb(files.board.size)}, and this import reads files up to ${mb(MAX_FILE_BYTES)}.`, context) })
    }
    const bytes = await files.board.read()
    context.boardBytes = bytes.length
    const head = (n: number) => new TextDecoder().decode(bytes.subarray(0, n))
    if (kindOf(files.board.path) === "legacy-board" && !/^\s*PCBNEW-BOARD/i.test(head(200))) {
      // A `.brd` is KiCad's own only when it says so; EAGLE and other programs use the extension too.
      const eagle = /<eagle|<\?xml/i.test(head(400))
      return done({ project: null, summary: stoppedSummary("unreadable", eagle ? "This is an EAGLE board. EAGLE boards are not supported yet." : "This .brd file is not a KiCad board, so it cannot be imported.", context) })
    }

    // A schematic or a project file means the schematic import, once it exists.
    const hasProject = !!files.projectFile || files.schematics.length > 0
    const load = options.loadProjectImporter === undefined ? loadProjectImporter : options.loadProjectImporter
    const projectImporter = hasProject && load ? await load() : null
    post({ type: "progress", id, phase: "building" })
    const importOptions: ImportOptions = { ...options.importOptions, name: projectName(files) }
    let result: KicadImportResult
    if (projectImporter) {
      const read = async (f: InputFile) => ({ name: baseName(f.path), bytes: await f.read() })
      const project: ProjectBytes = {
        board: bytes,
        projectFile: files.projectFile ? await read(files.projectFile) : null,
        schematics: await Promise.all(files.schematics.map(read)),
        rules: files.rules ? await read(files.rules) : null,
        libraries: await Promise.all(files.libraries.map(read)),
      }
      result = await projectImporter(project, importOptions)
      context.used.push(...[project.projectFile, ...project.schematics, project.rules, ...project.libraries].flatMap((f) => (f ? [f.name] : [])))
    } else {
      const importer = await (options.loadBoardImporter ?? loadBoardImporter)()
      // A footprint that is nothing but text is given the box of its ink, which takes KiCad's glyphs: they are loaded for the board's text first.
      await loadKicadFontFor(bytes)
      result = importer.importKicadBoard(bytes, importOptions)
      context.notRead = notReadBeside(files)
    }
    done({ summary: summarize(result, context), project: result.status === "imported" ? result.project : null })
  } catch (e) {
    // A file that unpacks past the limit (its size field said less, or nothing) is said in plain words.
    if (e instanceof ImportInputError) return done({ project: null, summary: stoppedSummary("bad-input", e.message) })
    // The first line of the error's message only, never a stack, and only in the download: the
    // user gets a plain sentence and a next step.
    const why = (e instanceof Error ? e.message.split("\n")[0].trim().slice(0, 200) : "") || "an unknown error"
    done({ project: null, summary: stoppedSummary("failed", "The import stopped before it finished. Nothing was saved. Reload the page and try again; if it keeps happening, download this report and contact us at trycherryblossom.com/contact.", emptyContext(), why) })
  }
}

/** The files beside the board that are not read until the schematic import is in, each with its reason. */
function notReadBeside(files: ProjectFiles): { file: string; why: string }[] {
  const out: { file: string; why: string }[] = []
  for (const f of [files.projectFile, ...files.schematics]) {
    if (!f) continue
    const project = kindOf(f.path).includes("project")
    out.push({ file: baseName(f.path), why: project ? "the schematic import is coming; the project file's rules and settings are not read yet" : "the schematic import is coming; the board was imported without its schematic" })
  }
  if (files.rules) out.push({ file: baseName(files.rules.path), why: "custom design rules are not read yet" })
  for (const f of files.libraries) out.push({ file: baseName(f.path), why: "the schematic import is coming; symbol libraries are not read yet" })
  return out
}
