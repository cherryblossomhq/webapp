import { readLegacyPro, type LegacyPro } from "../../project/legacyPro"
import { LegacyParseError, decodeLegacy } from "./text"
import { readLegacyLibraryText, type LegacyLibrary, type LegacyPart } from "./lib"

// Where the symbols of a KiCad 5 schematic come from (docs/kicad-import-schematic.md, section 5), in
// KiCad 5's own order: the project's cache library (`name-cache.lib`, or `name.cache.lib` as the
// KiCad 4 demos have it), which holds the symbols as the schematic was last saved with them, then
// the project's other libraries in the order its `.pro` lists them. A symbol found nowhere is not
// guessed: the importer names it and refuses (S12).

/** The files of a project, looked up by path without regard to case (what `FileIndex` is). */
export interface FileLookup {
  find(path: string): { path: string; data: string | Uint8Array } | null
  paths(): string[]
}

export interface LegacySource {
  kind: "cache" | "library"
  /** The path of the library file among the project's files. */
  file: string
  /** The library's name as the project lists it (`power`), or the cache's file name. */
  name: string
}

export interface FoundSymbol {
  part: LegacyPart
  source: LegacySource
  /** The name it was found by, in the library. */
  name: string
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const stemOf = (path: string) => baseOf(path).replace(/\.[^.]*$/, "")
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
/** The last element of a library name, which a project may write as a path of the machine it was made on. */
const slashed = (name: string) => name.replace(/\\/g, "/")
const libBase = (name: string) => slashed(name).slice(slashed(name).lastIndexOf("/") + 1)

/** The libraries one project's symbols are searched in. */
export class LegacySources {
  /** The project file read beside the root schematic, or null. */
  pro: LegacyPro | null = null
  proFile: string | null = null
  /** A damaged project file: the message. The schematic is read without its library list, and the symbols it needs that are not in the cache are not found. */
  proError: string | null = null
  readonly list: LegacySource[] = []
  /** The libraries the project lists whose files are not among the files. */
  readonly missing: string[] = []
  /** The `.dcm` documentation files beside the libraries, which are not read. */
  readonly docFiles: string[] = []
  private parsed = new Map<string, { lib: LegacyLibrary; encoding: "utf-8" | "latin-1"; notes: string[] } | { error: string }>()

  constructor(
    readonly files: FileLookup,
    readonly rootPath: string,
  ) {
    const dir = dirOf(rootPath)
    const stem = stemOf(rootPath)
    // The project file: the root's own name, else the only `.pro` in its folder.
    let pro = files.find(join(dir, `${stem}.pro`))
    if (!pro) {
      const here = files.paths().filter((p) => dirOf(p) === dir && p.toLowerCase().endsWith(".pro"))
      if (here.length === 1) pro = files.find(here[0])
    }
    if (pro) {
      this.proFile = pro.path
      try {
        this.pro = readLegacyPro(pro.data).legacy
      } catch (e) {
        this.proError = e instanceof Error ? e.message : String(e)
      }
    }
    // The cache comes first: KiCad puts it ahead of every other library.
    for (const name of [`${stem}-cache.lib`, `${stem}.cache.lib`]) {
      const f = files.find(join(dir, name))
      if (f) this.list.push({ kind: "cache", file: f.path, name: baseOf(f.path) })
    }
    for (const name of this.pro?.libNames ?? []) {
      const file = this.resolveLibrary(name, dir)
      if (file) this.list.push({ kind: "library", file, name })
      else this.missing.push(name)
    }
    for (const s of this.list) {
      const doc = files.find(`${s.file.replace(/\.lib$/i, "")}.dcm`)
      if (doc) this.docFiles.push(doc.path)
    }
  }

  /** The file of a library the project lists: beside the schematic, in the folders of `LibDir`, then anywhere among the files by its name (the nearest to the schematic first). */
  private resolveLibrary(name: string, dir: string): string | null {
    // A name written with the path of the machine that made the project (`C:\KiCad\lib\Device`, `/home/x/lib/Device`) is found by its last element, as the fallback below does.
    const base = libBase(name)
    const absolute = /^([A-Za-z]:)?[\\/]/.test(name)
    const file = `${absolute ? base : slashed(name)}.lib`
    const here = this.files.find(join(dir, file))
    if (here) return here.path
    for (const d of this.pro?.libDirs ?? []) {
      const f = this.files.find(join(dir, join(d.replace(/\\/g, "/"), file)))
      if (f) return f.path
    }
    const lower = `${base}.lib`.toLowerCase()
    const all = this.files
      .paths()
      .filter((p) => baseOf(p).toLowerCase() === lower)
      .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))
    return all[0] ?? null
  }

  /** A library parsed once; a file that cannot be read is an error with its message. */
  open(source: LegacySource) {
    let got = this.parsed.get(source.file)
    if (!got) {
      try {
        const f = this.files.find(source.file)
        if (!f) throw new LegacyParseError("not-legacy", `${source.file} is not among the files.`)
        const d = typeof f.data === "string" ? { text: f.data, encoding: "utf-8" as const, notes: [] as string[] } : decodeLegacy(f.data)
        got = { lib: readLegacyLibraryText(d.text), encoding: d.encoding, notes: d.notes }
      } catch (e) {
        got = { error: e instanceof Error ? e.message : String(e) }
      }
      this.parsed.set(source.file, got)
    }
    return got
  }

  /** The libraries that were opened: for the report. */
  opened() {
    return this.list.flatMap((s) => {
      const got = this.parsed.get(s.file)
      return got && "lib" in got ? [{ source: s, ...got }] : []
    })
  }

  /** The libraries that were needed and could not be read. */
  broken() {
    return this.list.flatMap((s) => {
      const got = this.parsed.get(s.file)
      return got && "error" in got ? [{ source: s, error: got.error }] : []
    })
  }

  /**
   * The symbol for a name of an `L` line: the cache by `nickname_name` (KiCad replaces the colon of a library
   * identifier by an underscore for the cache), then the libraries in the project's order by the name, the
   * library of the nickname first.
   */
  find(nickname: string, item: string): FoundSymbol | null {
    // A cache written by a KiCad 5.99 development build names an entry `lib:name`, as the schematic does, not `lib_name`.
    const cacheKeys = nickname ? [`${nickname}_${item}`, `${nickname}:${item}`] : [item]
    for (const s of this.list) {
      if (s.kind !== "cache") continue
      const got = this.open(s)
      if ("lib" in got) {
        for (const key of cacheKeys) {
          const part = got.lib.byName.get(key)
          if (part) return { part, source: s, name: key }
        }
      }
    }
    const libs = this.list.filter((s) => s.kind === "library")
    const first = nickname ? libs.filter((s) => libBase(s.name).toLowerCase() === nickname.toLowerCase()) : []
    for (const s of [...first, ...libs.filter((x) => !first.includes(x))]) {
      const got = this.open(s)
      if ("lib" in got) {
        const part = got.lib.byName.get(item)
        if (part) return { part, source: s, name: item }
      }
    }
    return null
  }
}
