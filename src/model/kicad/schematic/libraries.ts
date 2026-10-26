import { KicadReadError, flagOf, kid, kids, parseSexpr, strAt, type List } from "../board/sexpr"
import { decodeLegacy } from "./legacy/text"
import { legacyPartToSymbolText, readLegacyLibraryText } from "./legacy/lib"
import { readKicadSchematic, readLibSymbol } from "./read"
import type { LibSymbol } from "./types"

// Symbols from a project's own libraries (S12, section 5 of docs/kicad-import-schematic.md). A schematic keeps a copy of every symbol it uses in its
// `lib_symbols`, which is where the importer looks first. A symbol that copy lacks (a file saved by a tool that writes none, a copy that was cut out
// by hand, an `extends` base that was dropped) is in a library of the project: the `sym-lib-table` beside the root sheet names each library by a
// nickname and a file (`(lib (name "Device") (type "KiCad") (uri "${KIPRJMOD}/libs/Device.kicad_sym"))`), and a symbol's `lib_id` is
// `nickname:name`. KiCad looks a nickname up in the project's table, then the user's, and the user's names the libraries installed with KiCad
// (`${KICAD9_SYMBOL_DIR}/Device.kicad_sym`), which the importer does not have: a path through a variable it cannot resolve is read by its file name
// among the files, and when it is not there the symbol is not found, and said so. The parts database is the last source (`databaseSymbols`).
// A library symbol may have been redrawn since the sheet was; `build.ts` checks that no wire ends where the library's pins are not.

/** The files of a project looked up by path without regard to case (what `FileIndex` is). */
export interface FileLookup {
  find(path: string): { path: string; data: string | Uint8Array } | null
  paths(): string[]
}

export interface LibraryEntry {
  nickname: string
  /** `KiCad` (a `.kicad_sym` file) or `Legacy` (a `.lib`); KiCad writes others (`Altium`, `Eagle`...) that the importer does not read. */
  type: string
  uri: string
  disabled: boolean
}

/** Where a symbol was found: for the report. */
export interface SymbolSource {
  kind: "project-library" | "database"
  /** The library's nickname, or `the parts database`. */
  library: string
  /** The file it was read from, among the files. */
  file: string | null
}

export interface FoundLibSymbol {
  symbol: LibSymbol
  /** Looks up another symbol of the same library by its name: the base an `extends` names. */
  lookup: (name: string) => LibSymbol | undefined
  source: SymbolSource
}

/** Why a symbol was not found: the libraries looked in, those the table lists that are not among the files, those that cannot be read, those at a path of another machine. */
export interface LibraryMiss {
  libId: string
  looked: string[]
  missing: string[]
  unreadable: { library: string; why: string }[]
  /** The table lists the library by a path through a variable of the machine it was made on, which no file stands for. */
  external: string[]
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const depth = (p: string) => p.split("/").length

/** The stamp the symbols of a legacy library are read with (legacy/read.ts). */
const LIB_STAMP = 20230221

/** `sym-lib-table`'s libraries, in order. Throws a message for a file that is not one. */
export function readSymLibTable(text: string): LibraryEntry[] {
  const root = parseSexpr(text).find((n): n is List => Array.isArray(n) && n[0] === "sym_lib_table")
  if (!root) throw new Error("it has no (sym_lib_table ...) list")
  return kids(root, "lib").map((l) => ({
    nickname: strAt(kid(l, "name"), 1) ?? "",
    type: strAt(kid(l, "type"), 1) ?? "KiCad",
    uri: strAt(kid(l, "uri"), 1) ?? "",
    disabled: flagOf(l, "disabled"),
  }))
}

interface Opened {
  symbols: Map<string, LibSymbol>
}

export interface SymbolLibraryOptions {
  /** Symbols of the parts database, by `lib_id`, as the text of the symbol's own `.kicad_sym` file: the last source. */
  databaseSymbols?: ReadonlyMap<string, string>
}

/** The libraries one project's symbols are searched in. */
export class SymbolLibraries {
  /** The project's own table, or null when it has none among the files. */
  tablePath: string | null = null
  readonly entries: LibraryEntry[] = []
  /** A table that could not be read: the message. */
  tableError: string | null = null
  private opened = new Map<string, Opened | { error: string }>()
  private database = new Map<string, LibSymbol | { error: string }>()

  constructor(
    private readonly files: FileLookup,
    readonly rootPath: string,
    private readonly options: SymbolLibraryOptions = {},
  ) {
    const dir = dirOf(rootPath)
    // The table of the project: beside the root sheet, else the nearest one among the files.
    const tables = files
      .paths()
      .filter((p) => baseOf(p).toLowerCase() === "sym-lib-table")
      .sort((a, b) => Math.abs(depth(dirOf(a)) - depth(dir)) - Math.abs(depth(dirOf(b)) - depth(dir)) || (a < b ? -1 : 1))
    const here = files.find(join(dir, "sym-lib-table")) ?? (tables[0] ? files.find(tables[0]) : null)
    if (here) {
      this.tablePath = here.path
      try {
        this.entries.push(...readSymLibTable(typeof here.data === "string" ? here.data : new TextDecoder().decode(here.data)))
      } catch (e) {
        this.tableError = e instanceof KicadReadError || e instanceof Error ? e.message : String(e)
      }
    }
  }

  /** Whether there is any source to look in: a table, a `.kicad_sym` file or a database. */
  get any(): boolean {
    return this.tablePath !== null || this.files.paths().some((p) => /\.kicad_sym$/i.test(p)) || (this.options.databaseSymbols?.size ?? 0) > 0
  }

  /** The file a table entry names, by KiCad's rules for a path (`${KIPRJMOD}` is the project's folder): its path among the files, or why there is none. */
  private resolve(e: LibraryEntry): { file: string } | { why: "missing" | "external" } {
    const dir = dirOf(this.tablePath ?? this.rootPath)
    let uri = e.uri.replace(/\\/g, "/")
    const own = /^\$[({]KIPRJMOD[)}]\/?/i
    const variable = /\$[({][A-Za-z0-9_]+[)}]/
    if (own.test(uri)) uri = join(dir, uri.replace(own, ""))
    else if (variable.test(uri) || /^([A-Za-z]:)?\//.test(uri)) {
      // A path through a variable of another machine, or an absolute path of one: only its file name can say which file it is.
      const found = this.byName(baseOf(uri))
      return found ? { file: found } : { why: variable.test(uri) ? "external" : "missing" }
    } else uri = join(dir, uri)
    const direct = this.files.find(uri)
    if (direct) return { file: direct.path }
    const found = this.byName(baseOf(uri))
    return found ? { file: found } : { why: "missing" }
  }

  /** A file among the files by its name, the nearest to the project first. */
  private byName(base: string): string | null {
    const lower = base.toLowerCase()
    const dir = dirOf(this.tablePath ?? this.rootPath)
    const all = this.files
      .paths()
      .filter((p) => baseOf(p).toLowerCase() === lower)
      .sort((a, b) => Math.abs(depth(dirOf(a)) - depth(dir)) - Math.abs(depth(dirOf(b)) - depth(dir)) || (a < b ? -1 : 1))
    return all[0] ?? null
  }

  private open(file: string, type: string): Opened | { error: string } {
    const hit = this.opened.get(file)
    if (hit) return hit
    let got: Opened | { error: string }
    try {
      const data = this.files.find(file)!.data
      if (type.toLowerCase() === "legacy" || /\.lib$/i.test(file)) {
        const text = typeof data === "string" ? data : decodeLegacy(data).text
        const lib = readLegacyLibraryText(text)
        const names = [...lib.byName.keys()]
        const sym = readKicadSchematic(`(kicad_sch (version ${LIB_STAMP}) (lib_symbols ${names.map((n) => legacyPartToSymbolText(lib.byName.get(n)!, n)).join(" ")}))`)
        got = { symbols: new Map(sym.schematic.libSymbols.map((s) => [s.name, s])) }
      } else {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data)
        const root = parseSexpr(text).find((n): n is List => Array.isArray(n) && n[0] === "kicad_symbol_lib")
        if (!root) throw new Error("it has no (kicad_symbol_lib ...) list, so it is not a KiCad symbol library")
        const version = Number(strAt(kid(root, "version"), 1))
        const stamp = Number.isFinite(version) ? version : null
        got = { symbols: new Map(kids(root, "symbol").map((s) => readLibSymbol(s, stamp)).map((s) => [s.name, s])) }
      }
    } catch (e) {
      got = { error: e instanceof Error ? e.message : String(e) }
    }
    this.opened.set(file, got)
    return got
  }

  /** The library a nickname names: its table entry's file, or (when the table does not list it) a `.kicad_sym` file of that name among the files. */
  private libraryOf(nickname: string): { file: string; type: string } | { why: "missing" | "external" | "unlisted" | "kind" } {
    const entry = this.entries.find((e) => e.nickname === nickname && !e.disabled)
    if (entry) {
      if (!["kicad", "legacy"].includes(entry.type.toLowerCase())) return { why: "kind" }
      const r = this.resolve(entry)
      return "file" in r ? { file: r.file, type: entry.type } : { why: r.why }
    }
    if (this.entries.some((e) => e.nickname === nickname)) return { why: "missing" }
    const byName = this.byName(`${nickname}.kicad_sym`)
    return byName ? { file: byName, type: "KiCad" } : { why: "unlisted" }
  }

  /** The symbol a `lib_id` names, from the project's libraries and then the database; or why none has it. */
  find(libId: string): FoundLibSymbol | LibraryMiss {
    const colon = libId.indexOf(":")
    const nickname = colon >= 0 ? libId.slice(0, colon) : ""
    const name = colon >= 0 ? libId.slice(colon + 1) : libId
    const miss: LibraryMiss = { libId, looked: [], missing: [], unreadable: [], external: [] }
    const candidates = nickname ? [nickname] : this.entries.filter((e) => !e.disabled).map((e) => e.nickname)
    for (const nick of candidates) {
      const lib = this.libraryOf(nick)
      if (!("file" in lib)) {
        if (lib.why === "missing") miss.missing.push(nick)
        else if (lib.why === "external") miss.external.push(nick)
        else if (lib.why === "kind") miss.unreadable.push({ library: nick, why: "it is a library of a kind the importer does not read" })
        continue
      }
      const o = this.open(lib.file, lib.type)
      if ("error" in o) {
        miss.unreadable.push({ library: nick, why: o.error })
        continue
      }
      miss.looked.push(nick)
      const symbol = o.symbols.get(name)
      if (symbol) return { symbol, lookup: (n) => o.symbols.get(n), source: { kind: "project-library", library: nick, file: lib.file } }
    }
    const db = this.fromDatabase(libId)
    if (db && "symbol" in db) return db
    if (db) miss.unreadable.push({ library: "the parts database", why: db.error })
    return miss
  }

  private fromDatabase(libId: string): FoundLibSymbol | { error: string } | null {
    const text = this.options.databaseSymbols?.get(libId)
    if (text === undefined) return null
    const cached = this.database.get(libId)
    if (cached) return "error" in cached ? cached : { symbol: cached, lookup: () => undefined, source: { kind: "database", library: "the parts database", file: null } }
    try {
      const root = parseSexpr(text).find((n): n is List => Array.isArray(n) && n[0] === "kicad_symbol_lib")
      if (!root) throw new Error("its text has no (kicad_symbol_lib ...) list")
      const version = Number(strAt(kid(root, "version"), 1))
      const symbols = kids(root, "symbol").map((s) => readLibSymbol(s, Number.isFinite(version) ? version : null))
      const name = libId.slice(libId.indexOf(":") + 1)
      const symbol = symbols.find((s) => s.name === name) ?? (symbols.length === 1 ? symbols[0] : undefined)
      if (!symbol) throw new Error(`its text has no symbol named ${name}`)
      this.database.set(libId, symbol)
      const by = new Map(symbols.map((s) => [s.name, s]))
      return { symbol, lookup: (n) => by.get(n), source: { kind: "database", library: "the parts database", file: null } }
    } catch (e) {
      const error = { error: e instanceof Error ? e.message : String(e) }
      this.database.set(libId, error)
      return error
    }
  }

  /** The libraries the table lists that are not among the files, for the report. */
  listedButAbsent(): string[] {
    return this.entries.filter((e) => !e.disabled && ["kicad", "legacy"].includes(e.type.toLowerCase()) && "why" in this.resolve(e)).map((e) => e.nickname)
  }
}

export const isMiss = (x: FoundLibSymbol | LibraryMiss): x is LibraryMiss => "libId" in x
