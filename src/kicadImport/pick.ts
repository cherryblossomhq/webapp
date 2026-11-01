// Picking the KiCad project out of what a user gave: one file, several, a dropped folder or a zip.
// Pure: it works on `InputFile`s (a name and a way to read the bytes), so it runs the same in the
// import's worker, on the main thread and in the tests. Nothing here reads a board; it only says
// which files are the board, which sit beside it, and which are not wanted.

/** One file as the import sees it. `path` uses `/`, whatever the system the file came from. */
export interface InputFile {
  path: string
  /** In bytes; `null` when the source does not say (a zip entry without a size field). */
  size: number | null
  read(): Promise<Uint8Array>
}

export type FileKind = "board" | "legacy-board" | "schematic" | "legacy-schematic" | "project" | "legacy-project" | "rules" | "library" | "zip" | "other"

const KINDS: Record<string, FileKind> = {
  ".kicad_pcb": "board",
  ".brd": "legacy-board",
  ".kicad_sch": "schematic",
  ".sch": "legacy-schematic",
  ".kicad_pro": "project",
  ".pro": "legacy-project",
  ".kicad_dru": "rules",
  ".lib": "library",
  ".kicad_sym": "library",
  ".zip": "zip",
}

/** The extensions the import button offers. */
export const ACCEPTED_EXTENSIONS = [".kicad_pcb", ".kicad_sch", ".kicad_pro", ".kicad_dru", ".sch", ".lib", ".kicad_sym", ".pro", ".brd", ".zip"] as const

/**
 * The largest single file the import reads. A board of 40 MB is normal, and the import takes about
 * 26 MB of memory for every MB of board (a 115 MB board took 3 GB), so this is what a browser tab
 * can be asked to hold.
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
const mbOf = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

/** A file the import will not read, with the sentence for the user. Not a failure of the import: the file is too big. */
export class ImportInputError extends Error {}

const tooBig = (name: string, limit: number) => new ImportInputError(`${name} is larger than ${mbOf(limit)} once unpacked, and this import does not read files that big.`)
/** A zip that holds more files than this is not a project folder. */
export const MAX_ZIP_ENTRIES = 50_000

export const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "")
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)
export const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const stemOf = (path: string) => {
  const name = baseName(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

export function kindOf(path: string): FileKind {
  const name = baseName(path).toLowerCase()
  // The table that names a project's symbol libraries (S12) has no extension.
  if (name === "sym-lib-table") return "library"
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "other" : (KINDS[name.slice(dot)] ?? "other")
}

/** Files and folders that tools leave beside a project and that are not part of it. */
function junkReason(path: string): string | null {
  const parts = path.split("/")
  const name = parts[parts.length - 1]
  if (parts.includes("__MACOSX") || name.startsWith("._") || name === ".DS_Store") return "a file the computer made, not part of the project"
  if (parts.some((p) => /-backups$/i.test(p))) return "a KiCad backup copy"
  if (/^_autosave-/i.test(name) || /-bak$/i.test(name)) return "a KiCad autosave or backup copy"
  return null
}

export interface IgnoredFile {
  path: string
  why: string
}

export interface ExpandResult {
  files: InputFile[]
  ignored: IgnoredFile[]
  /** Zips that could not be opened, by name, with the reason in plain words. */
  badZips: { path: string; why: string }[]
}

/** The zip reader's own words for a file that is not a zip, in a sentence. */
const badZipWhy = (e: unknown) => (e instanceof Error && /end of central directory|corrupt|not a valid|Can't find|invalid/i.test(e.message) ? "It is not a zip file, or it is damaged." : "It could not be opened as a zip file; it may be damaged.")

/** The streaming part of a zip entry the reader needs, so a test can stand in for one. */
export interface EntryLike {
  internalStream(type: "uint8array"): {
    on(event: "data", cb: (chunk: Uint8Array) => void): unknown
    on(event: "error", cb: (e: Error) => void): unknown
    on(event: "end", cb: () => void): unknown
    pause(): unknown
    resume(): unknown
  }
}

/** Unpack one zip entry, counting its bytes as they come out and stopping at the limit, not after it. */
export function readEntry(entry: EntryLike, name: string, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let total = 0
    const stream = entry.internalStream("uint8array")
    stream.on("data", (chunk) => {
      total += chunk.length
      if (total > limit) {
        stream.pause()
        reject(tooBig(name, limit))
        return
      }
      chunks.push(chunk)
    })
    stream.on("error", reject)
    stream.on("end", () => {
      const out = new Uint8Array(total)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      resolve(out)
    })
    stream.resume()
  })
}

/**
 * Open the zips among the files; every other file passes through. A zip's files are named with the
 * zip's own path (without `.zip`) in front, so two zips with a board of one name stay two boards.
 * A zip that is a KiCad backup, or a zip inside a zip, is not opened.
 */
export async function expand(input: InputFile[], limit = MAX_FILE_BYTES): Promise<ExpandResult> {
  const out: ExpandResult = { files: [], ignored: [], badZips: [] }
  for (const raw of input) {
    const path = normalizePath(raw.path)
    if (kindOf(path) !== "zip") {
      out.files.push({ ...raw, path, read: raw.read })
      continue
    }
    // Before it is opened: KiCad keeps up to 25 backups of a board as zips in `<name>-backups/`.
    const junk = junkReason(path)
    if (junk) {
      out.ignored.push({ path, why: junk })
      continue
    }
    if (raw.size !== null && raw.size > limit) {
      out.badZips.push({ path, why: `It is larger than the ${mbOf(limit)} this import reads.` })
      continue
    }
    try {
      const { default: JSZip } = await import("jszip")
      const zip = await JSZip.loadAsync(await raw.read())
      const entries = Object.values(zip.files).filter((f) => !f.dir)
      if (entries.length > MAX_ZIP_ENTRIES) {
        out.badZips.push({ path, why: `It holds ${entries.length} files, which is too many for a project folder.` })
        continue
      }
      const folder = path.replace(/\.zip$/i, "")
      for (const f of entries) {
        const inner = normalizePath(f.name)
        const full = `${folder}/${inner}`
        if (kindOf(inner) === "zip") {
          out.ignored.push({ path: full, why: "a zip inside a zip, which is not opened" })
          continue
        }
        // The zip's own record of the size, which may be missing; what is unpacked is counted as it comes.
        const claimed = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
        const known = typeof claimed === "number" ? claimed : null
        out.files.push({
          path: full,
          size: known,
          read: async () => {
            if (known !== null && known > limit) throw tooBig(baseName(full), limit)
            return readEntry(f as unknown as EntryLike, baseName(full), limit)
          },
        })
      }
    } catch (e) {
      out.badZips.push({ path, why: badZipWhy(e) })
    }
  }
  return out
}

/** A board the user may pick, for the chooser; or, among schematics alone, the folder of a schematic. */
export interface BoardChoice {
  /** Its path, which is also what a choice is made by. */
  id: string
  path: string
  size: number | null
  legacy: boolean
  /** A schematic (the one that starts a folder's project) where there is no board to choose. */
  schematic?: true
}

/** The files that belong to one board, or to a schematic when there is no board. */
export interface ProjectFiles {
  /** The board; null for a schematic alone. */
  board: InputFile | null
  /** `.kicad_pro`, or KiCad 5's `.pro`, beside the board. */
  projectFile: InputFile | null
  schematics: InputFile[]
  rules: InputFile | null
  libraries: InputFile[]
}

export type PickResult =
  | { kind: "ready"; files: ProjectFiles; ignored: IgnoredFile[] }
  | { kind: "choose"; boards: BoardChoice[]; ignored: IgnoredFile[] }
  /** No board among the files: `why` says so in plain words, naming what was there instead. */
  | { kind: "none"; why: string; ignored: IgnoredFile[] }

const within = (dir: string, path: string) => dir === "" || path.startsWith(`${dir}/`)

/** Choose the board and what sits with it. Several boards give `choose`, unless `choice` names one. */
export function pick(expanded: ExpandResult, choice?: string): PickResult {
  const ignored = [...expanded.ignored, ...expanded.badZips.map((z) => ({ path: z.path, why: `a zip that could not be opened. ${z.why}` }))]
  const usable: InputFile[] = []
  for (const f of expanded.files) {
    const junk = junkReason(f.path)
    if (junk) ignored.push({ path: f.path, why: junk })
    else usable.push(f)
  }
  const boards = usable.filter((f) => ["board", "legacy-board"].includes(kindOf(f.path)))
  // A board wins over a legacy one in the same folder: the legacy `.brd` is KiCad's own old copy.
  const modern = boards.filter((f) => kindOf(f.path) === "board")
  const candidates = (modern.length ? boards.filter((f) => kindOf(f.path) === "board" || !modern.some((m) => dirName(m.path) === dirName(f.path))) : boards).sort((a, b) => a.path.localeCompare(b.path))

  // No board: a KiCad schematic alone is a project too, and imports as one.
  const sheets = usable.filter((f) => kindOf(f.path) === "schematic").sort((a, b) => a.path.localeCompare(b.path))
  if (candidates.length === 0 && sheets.length) {
    const dirs = [...new Set(sheets.map((f) => dirName(f.path)))]
    // A folder inside another that has a schematic holds sheets of that project, not a project of its own.
    const tops = dirs.filter((d) => !dirs.some((o) => o !== d && (o === "" || d.startsWith(`${o}/`))))
    const start = (dir: string) => {
      const here = sheets.filter((f) => dirName(f.path) === dir)
      const pros = usable.filter((f) => ["project", "legacy-project"].includes(kindOf(f.path)) && dirName(f.path) === dir)
      return here.find((f) => pros.some((p) => stemOf(p.path).toLowerCase() === stemOf(f.path).toLowerCase())) ?? here[0]
    }
    const roots = tops.map(start)
    let root: InputFile | undefined
    if (roots.length === 1) root = roots[0]
    else if (choice !== undefined) root = roots.find((r) => r.path === choice)
    if (!root) return { kind: "choose", boards: roots.map((r) => ({ id: r.path, path: r.path, size: r.size, legacy: false, schematic: true as const })), ignored }
    return readyBeside(usable, ignored, root, null)
  }

  if (candidates.length === 0) {
    const sch = usable.filter((f) => ["schematic", "legacy-schematic", "project", "legacy-project"].includes(kindOf(f.path)))
    const why = sch.length
      ? "There is no board and no schematic Cherry Blossom can read in these files. KiCad 5's .sch and .pro files are not read; save the project in KiCad 6 or later, or add the .kicad_pcb or .kicad_sch."
      : expanded.badZips.length
        ? `${baseName(expanded.badZips[0].path)} could not be opened. ${expanded.badZips[0].why}`
        : "There is no KiCad board in these files. Pick a .kicad_pcb file, or a zip of the project folder."
    return { kind: "none", why, ignored: [...ignored, ...usable.filter((f) => !sch.includes(f)).map((f) => ({ path: f.path, why: "not a KiCad design file" }))] }
  }

  let chosen: InputFile | undefined
  if (candidates.length === 1) chosen = candidates[0]
  else if (choice !== undefined) chosen = candidates.find((c) => c.path === choice)
  if (!chosen) {
    return { kind: "choose", boards: candidates.map((c) => ({ id: c.path, path: c.path, size: c.size, legacy: kindOf(c.path) === "legacy-board" })), ignored }
  }

  return readyBeside(usable, ignored, chosen, chosen)
}

/** A path with its `.` and `..` worked out, as the schematic's sheet tree resolves the file a sheet names (`model/kicad/schematic/tree.ts`). */
function resolvePath(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

const isSchematic = (path: string) => kindOf(path) === "schematic" || kindOf(path) === "legacy-schematic"

/**
 * The project's files with the sheets its schematics name outside the board's folder, among the files given: a project that keeps shared
 * sheets in `../modules/` names them by a relative path, and KiCad opens them there. Each schematic is read for the files its sheets name
 * (a KiCad 6 sheet's `Sheetfile`, a KiCad 5 sheet's `F1`), and a file of that path joins the project, with the sheets it names in turn;
 * it is no longer among the files set aside. Nothing is read when no schematic was given outside the folder.
 */
export async function withNamedSheets(files: ProjectFiles, given: InputFile[], ignored: IgnoredFile[]): Promise<ProjectFiles> {
  const have = new Set(files.schematics.map((f) => f.path.toLowerCase()))
  const elsewhere = new Map(given.filter((f) => isSchematic(f.path) && !have.has(f.path.toLowerCase())).map((f) => [f.path.toLowerCase(), f]))
  if (!files.schematics.length || !elsewhere.size) return files
  const added: InputFile[] = []
  const queue = [...files.schematics]
  while (queue.length) {
    const s = queue.shift()!
    if (s.size !== null && s.size > MAX_FILE_BYTES) continue
    const text = new TextDecoder().decode(await s.read())
    const re = kindOf(s.path) === "legacy-schematic" ? /^F1\s+"([^"]+)"/gm : /\(property\s+"(?:Sheetfile|Sheet file|File)"\s+"([^"]+)"/g
    for (const m of text.matchAll(re)) {
      const f = elsewhere.get(resolvePath(`${dirName(s.path)}/${m[1]}`).toLowerCase())
      if (!f) continue
      elsewhere.delete(f.path.toLowerCase())
      added.push(f)
      queue.push(f)
    }
  }
  if (!added.length) return files
  const paths = new Set(added.map((f) => f.path))
  for (let i = ignored.length - 1; i >= 0; i--) if (paths.has(ignored[i].path)) ignored.splice(i, 1)
  return { ...files, schematics: [...files.schematics, ...added] }
}

/**
 * The files that go with a board (or, with no board, with the schematic that starts the project): its project file and rules
 * in its folder, the schematics and libraries in or below it. Everything else is set aside with the reason; the sheets its
 * schematics name elsewhere are taken back by `withNamedSheets`, which reads them.
 */
function readyBeside(usable: InputFile[], ignored: IgnoredFile[], chosen: InputFile, board: InputFile | null): PickResult {
  const dir = dirName(chosen.path)
  const beside = usable.filter((f) => within(dir, f.path))
  const here = (kind: FileKind[]) => beside.filter((f) => kind.includes(kindOf(f.path)) && dirName(f.path) === dir)
  const stem = stemOf(chosen.path).toLowerCase()
  const pros = here(["project", "legacy-project"])
  const projectFile = pros.find((f) => stemOf(f.path).toLowerCase() === stem) ?? (pros.length === 1 ? pros[0] : null)
  const rules = here(["rules"]).find((f) => stemOf(f.path).toLowerCase() === stem) ?? here(["rules"])[0] ?? null
  const schematics = beside.filter((f) => ["schematic", "legacy-schematic"].includes(kindOf(f.path)))
  const libraries = beside.filter((f) => kindOf(f.path) === "library")
  const used = new Set<InputFile>([chosen, ...(projectFile ? [projectFile] : []), ...(rules ? [rules] : []), ...schematics, ...libraries])
  for (const f of usable) {
    if (used.has(f)) continue
    const kind = kindOf(f.path)
    ignored.push({
      path: f.path,
      why: kind === "board" || kind === "legacy-board" ? "another board, not the one chosen" : within(dir, f.path) ? "not a KiCad design file" : `outside the chosen ${board ? "board" : "schematic"}'s folder`,
    })
  }
  return { kind: "ready", files: { board, projectFile, schematics, rules, libraries }, ignored }
}
