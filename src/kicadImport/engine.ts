import type { ImportOptions, KicadImportResult } from "../model/kicad/board/import"
import type { KicadProjectResult } from "../model/kicad/project/import"
import type { SchematicImportResult } from "../model/kicad/schematic/import"
import { baseName, expand, ImportInputError, kindOf, MAX_FILE_BYTES, pick, type InputFile, type ProjectFiles } from "./pick"
import type { StartRequest, WorkerEvent } from "./protocol"
import { emptyContext, generatorLabel, stoppedSummary, summarize, type FileContext, type ImportResult } from "./summary"

// One import job, start to finish: open the zips, pick the board, read it, run the importer and
// summarize. It runs in the worker (`worker.ts`) and, where the browser has no workers, on the page.
// It never throws: a file that cannot be imported is a summary with its reason, and anything that
// breaks unexpectedly is one with a sentence for the user and no stack.

export interface BoardImporter {
  importKicadBoard(input: Uint8Array, options?: ImportOptions): KicadImportResult
}

/** A file read: its name, its path in what the user gave (which sheets of a hierarchy are found by), and its bytes. */
export interface ReadFile {
  name: string
  path: string
  bytes: Uint8Array
}

/** The files a project import is given, read: the board and what sits beside it, or a schematic and the sheets beside it when there is no board. */
export interface ProjectBytes {
  /** The board's bytes; null when only a schematic was given. */
  board: Uint8Array | null
  boardPath: string | null
  projectFile: ReadFile | null
  schematics: ReadFile[]
  rules: ReadFile | null
  libraries: ReadFile[]
}

/** The schematic and project importer: a board with its schematic, a board alone, or a schematic alone, in the shape the report screen reads. */
export type ProjectImporter = (files: ProjectBytes, options: ImportOptions) => ImportResult | Promise<ImportResult>

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

/** The project importer's result as the report screen reads it: a board with its schematic is a project; a board with no schematic among the files is the board's. */
export function fromProjectResult(r: KicadProjectResult): ImportResult {
  if (r.status === "imported") return { status: "imported", project: r.project, report: r.report, bytes: r.bytes, board: r.board, kind: r.tree ? "project" : "board", ...(r.files?.length ? { files: r.files } : {}) }
  return { status: "refused", reason: r.reason, message: r.message, report: r.report, needs: r.needs, board: null, kind: "project" }
}

/** The schematic importer's result as the report screen reads it; there is no board, so the file's own stamp and release are said. */
export function fromSchematicResult(r: SchematicImportResult): ImportResult {
  const root = r.tree?.files.get(r.tree.root)?.schematic
  const file = { stamp: root?.version ?? null, era: root?.era ?? null, generator: root ? generatorLabel(root.generator, root.generatorVersion) : null }
  if (r.status === "imported") return { status: "imported", project: r.project, report: r.report, bytes: r.bytes, file, kind: "schematic" }
  return { status: "refused", reason: r.reason, message: r.message, report: r.report, needs: r.needs, file, kind: "schematic" }
}

/** Runs the real importers on the files: a board and its schematic through the project importer, a schematic alone through the schematic importer. */
async function importFiles(f: ProjectBytes, options: ImportOptions): Promise<ImportResult> {
  const [project, schematic] = await Promise.all([import("../model/kicad/project"), import("../model/kicad/schematic")])
  const beside = [f.projectFile, ...f.schematics, f.rules, ...f.libraries].flatMap((x) => (x ? [{ path: x.path, data: x.bytes }] : []))
  if (f.board && f.boardPath) {
    // A footprint that is nothing but text is given the box of its ink, which takes KiCad's glyphs: they are loaded for the board's text first.
    await loadKicadFontFor(f.board)
    return fromProjectResult(project.importKicadProject([{ path: f.boardPath, data: f.board }, ...beside], options))
  }
  const picked = project.pickProjectFiles(beside)
  if (!picked.root) return fromSchematicResult(schematic.importKicadSchematic({ files: new Map(), root: "schematic.kicad_sch" }, options))
  return fromSchematicResult(schematic.importKicadSchematic({ files: picked.sheets, root: picked.root.path }, options))
}

/**
 * Where the schematic and project importer plugs in: the importers (and with them the schematic reader and the 279 KB table
 * of stock 3D models) are loaded when a job that has a schematic or a project file starts.
 */
const loadProjectImporter: (() => Promise<ProjectImporter>) | null = async () => importFiles

/** The files that are KiCad 5's: the importers read KiCad 6 and later. */
const legacy = (f: InputFile) => ["legacy-schematic", "legacy-project"].includes(kindOf(f.path))

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
  const first = files.projectFile ?? files.board ?? files.schematics[0]
  return (first ? stem(first) : "") || (files.board ? "Imported KiCad board" : "Imported KiCad schematic")
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
    const context: FileContext = { used: files.board ? [baseName(files.board.path)] : [], notRead: [], ignored, boardBytes: 0 }
    const size = (f: InputFile) => f.size !== null && f.size > MAX_FILE_BYTES
    const tooBig = [files.board, ...files.schematics].find((f) => f && size(f))
    if (tooBig) {
      return done({ project: null, summary: stoppedSummary("bad-input", `${baseName(tooBig.path)} is ${mb(tooBig.size!)}, and this import reads files up to ${mb(MAX_FILE_BYTES)}.`, context) })
    }
    const bytes = files.board ? await files.board.read() : null
    context.boardBytes = bytes?.length ?? 0
    if (files.board && bytes) {
      const head = (n: number) => new TextDecoder().decode(bytes.subarray(0, n))
      if (kindOf(files.board.path) === "legacy-board" && !/^\s*PCBNEW-BOARD/i.test(head(200))) {
        // A `.brd` is KiCad's own only when it says so; EAGLE and other programs use the extension too.
        const eagle = /<eagle|<\?xml/i.test(head(400))
        return done({ project: null, summary: stoppedSummary("unreadable", eagle ? "This is an EAGLE board. EAGLE boards are not supported yet." : "This .brd file is not a KiCad board, so it cannot be imported.", context) })
      }
    }

    // KiCad 5's schematic and project files (`.sch`, `.pro`) are not read; KiCad 6 and later's are. A rules file, a project file or a schematic means the project import.
    const projectFile = files.projectFile && !legacy(files.projectFile) ? files.projectFile : null
    const schematics = files.schematics.filter((f) => !legacy(f))
    const rules = files.rules
    for (const f of [files.projectFile, ...files.schematics].filter((x): x is InputFile => !!x && legacy(x))) {
      context.notRead.push({ file: baseName(f.path), why: "this is KiCad 5's own format, which is not read; open the project in KiCad 6 or later and save it, then import it again" })
    }
    const hasProject = !!(projectFile || schematics.length || rules)
    const load = options.loadProjectImporter === undefined ? loadProjectImporter : options.loadProjectImporter
    const projectImporter = (hasProject || !files.board) && load ? await load() : null
    post({ type: "progress", id, phase: "building" })
    const importOptions: ImportOptions = { ...options.importOptions, name: projectName(files) }
    let result: ImportResult
    if (projectImporter) {
      const read = async (f: InputFile): Promise<ReadFile> => ({ name: baseName(f.path), path: f.path, bytes: await f.read() })
      const project: ProjectBytes = {
        board: bytes,
        boardPath: files.board?.path ?? null,
        projectFile: projectFile ? await read(projectFile) : null,
        schematics: await Promise.all(schematics.map(read)),
        rules: rules ? await read(rules) : null,
        libraries: await Promise.all(files.libraries.map(read)),
      }
      result = await projectImporter(project, importOptions)
      context.used.push(...[project.projectFile, ...project.schematics, project.rules].flatMap((f) => (f ? [f.name] : [])))
      // S12: a library is read only for a symbol the schematic's own cache lacks, which is the report's to say; the files are used.
      context.used.push(...project.libraries.map((f) => f.name))
      if (!files.board && project.projectFile) context.notRead.push({ file: project.projectFile.name, why: "its net classes and rules belong to the board; they are read when the board comes with it" })
      if (!files.board && project.rules) context.notRead.push({ file: project.rules.name, why: "its rules belong to the board; they are read when the board comes with it" })
    } else if (!bytes) {
      return done({ project: null, summary: stoppedSummary("no-board", "A schematic alone cannot be imported here: the schematic importer is not available.", context) })
    } else {
      const importer = await (options.loadBoardImporter ?? loadBoardImporter)()
      // A footprint that is nothing but text is given the box of its ink, which takes KiCad's glyphs: they are loaded for the board's text first.
      await loadKicadFontFor(bytes)
      result = importer.importKicadBoard(bytes, importOptions)
      context.notRead.push(...notReadBeside(files))
    }
    done({ summary: summarize(result, context), project: result.status === "imported" ? result.project : null, ...(result.status === "imported" && result.files?.length ? { files: result.files } : {}) })
  } catch (e) {
    // A file that unpacks past the limit (its size field said less, or nothing) is said in plain words.
    if (e instanceof ImportInputError) return done({ project: null, summary: stoppedSummary("bad-input", e.message) })
    // The first line of the error's message only, never a stack, and only in the download: the
    // user gets a plain sentence and a next step.
    const why = (e instanceof Error ? e.message.split("\n")[0].trim().slice(0, 200) : "") || "an unknown error"
    done({ project: null, summary: stoppedSummary("failed", "The import stopped before it finished. Nothing was saved. Reload the page and try again; if it keeps happening, download this report and contact us at trycherryblossom.com/contact.", emptyContext(), why) })
  }
}

/** The files beside a board that the board importer alone does not read, each with its reason: it runs when there is no schematic or project file to read, or no project importer. */
function notReadBeside(files: ProjectFiles): { file: string; why: string }[] {
  const out: { file: string; why: string }[] = []
  for (const f of [files.projectFile, ...files.schematics]) {
    if (!f || legacy(f)) continue
    const project = kindOf(f.path).includes("project")
    out.push({ file: baseName(f.path), why: project ? "the project file's rules and settings are not read here" : "the board was imported without its schematic" })
  }
  if (files.rules) out.push({ file: baseName(files.rules.path), why: "custom design rules are not read here" })
  for (const f of files.libraries) out.push({ file: baseName(f.path), why: "symbol libraries are not read without a schematic" })
  return out
}
