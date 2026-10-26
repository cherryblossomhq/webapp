import { newReport, type ImportReport } from "../board/report"
import { isLegacySchematic, readLegacySchematic } from "./legacy/read"
import { LegacySources } from "./legacy/sources"
import { KicadSchematicReadError, readKicadSchematic } from "./read"
import type { KicadSchematic, SchSheet, SheetFile } from "./types"

// A schematic is a tree of files: the root sheet, and the sheet files its sheet symbols name, down
// to any depth. The same file may be used by several sheet symbols (a reused sheet, drawn once and
// instanced several times), so a file has one or more instance paths. The tree is read whole even
// though hierarchy itself is an extension (S1) that may not be built: the accounting and the
// footprint link need every sheet, and a refusal should name what is in the project, not guess.
//
// Nothing here throws for a sub-sheet: a missing, corrupt or truncated file, a sheet that contains
// itself, and a hierarchy too deep or too wide to expand are `SheetError`s with the file named.

/** Project files by path, `/` separated, relative to the folder the user dropped. */
export type KicadFiles = ReadonlyMap<string, string | Uint8Array>

/** How deep sheets may nest, and how many instances a hierarchy may expand to. KiCad's own projects stay far below. */
export const MAX_SHEET_DEPTH = 64
export const MAX_SHEET_INSTANCES = 20000

export interface SheetError {
  code: "missing" | "unreadable" | "cycle" | "too-deep" | "too-many"
  /** The file the sheet symbol names, as the symbol writes it. */
  file: string
  /** The sheet symbol's name, when it has one. */
  sheet: string | null
  /** The file that holds the sheet symbol. */
  parent: string
  message: string
}

export interface SheetUse {
  /** The file that holds the sheet symbol. */
  parent: string
  sheet: SchSheet
  /** The resolved path of the sheet's file, or the path it names when it was not found. */
  file: string
  found: boolean
}

export interface SheetInstancePath {
  /** The instance path in KiCad 7's form: `/<root uuid>/<sheet uuid>/<sheet uuid>`. */
  path: string
  /** The resolved path of the file this instance draws. */
  file: string
  /** The uuids of the sheet symbols from the root down; empty for the root sheet. */
  chain: string[]
  /** The sheet symbols themselves, from the root down (a uuid can be written twice in a project that was copied by hand). */
  symbols: SchSheet[]
  /** The sheet symbol (null for the root). */
  sheet: SchSheet | null
}

export interface SchematicTree {
  root: string
  files: Map<string, SheetFile>
  uses: SheetUse[]
  errors: SheetError[]
  instances: SheetInstancePath[]
  report: ImportReport
  /** The libraries a KiCad 5 schematic's symbols are searched in, when the project has legacy sheets. */
  legacy: LegacySources | null
}

/** `a\b/./c/../d` as `a/b/d`; a path that climbs out of the folder keeps its `..`. */
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")

/** A file set indexed for lookup by exact path, then without regard to case (files written on Windows). */
export class FileIndex {
  private exact = new Map<string, string | Uint8Array>()
  private folded = new Map<string, string>()
  constructor(files: KicadFiles) {
    for (const [path, data] of files) {
      const p = normalizePath(path)
      this.exact.set(p, data)
      if (!this.folded.has(p.toLowerCase())) this.folded.set(p.toLowerCase(), p)
    }
  }
  /** The stored path and data for a path, or null. */
  find(path: string): { path: string; data: string | Uint8Array } | null {
    const p = normalizePath(path)
    const hit = this.exact.get(p)
    if (hit !== undefined) return { path: p, data: hit }
    const folded = this.folded.get(p.toLowerCase())
    return folded === undefined ? null : { path: folded, data: this.exact.get(folded)! }
  }
  paths(): string[] {
    return [...this.exact.keys()]
  }
}

const describe = (name: string | null, file: string) => `${name ? `the sheet "${name}"` : "a sheet"} (${file})`

/** Reads a root schematic and every sheet below it. Throws `KicadSchematicReadError` for a root that cannot be read; a sub-sheet that cannot be is a `SheetError`. */
export function readSchematicTree(files: KicadFiles, rootPath: string): SchematicTree {
  const index = new FileIndex(files)
  const rootFound = index.find(rootPath)
  if (!rootFound) throw new KicadSchematicReadError("missing-root", `The schematic ${rootPath} is not among the files.`)
  const tree: SchematicTree = { root: rootFound.path, files: new Map(), uses: [], errors: [], instances: [], report: newReport(), legacy: null }
  const tried = new Map<string, "ok" | "bad">()

  const load = (path: string, data: string | Uint8Array): KicadSchematic => {
    // A KiCad 5 or older sheet (a `.sch`) is read with the libraries of the project the root sheet is in; a `.kicad_sch` that holds one is not a file KiCad wrote, and the KiCad 6 reader says so.
    const read = !path.toLowerCase().endsWith(".kicad_sch") && isLegacySchematic(data) ? readLegacySchematic(data, (tree.legacy ??= new LegacySources(index, rootFound.path))) : readKicadSchematic(data)
    for (const e of read.report.entries) tree.report.entries.push({ ...e, object: `${path}: ${e.object}` })
    tree.files.set(path, { path, schematic: read.schematic, text: read.text })
    return read.schematic
  }
  load(rootFound.path, rootFound.data)
  tried.set(rootFound.path, "ok")

  const root = tree.files.get(rootFound.path)!.schematic
  tree.instances.push({ path: `/${root.uuid}`, file: rootFound.path, chain: [], symbols: [], sheet: null })

  // Depth first, one instance at a time: a file that is its own ancestor is a cycle. A hierarchy too wide to expand is said once and not walked further.
  let stop = false
  // Sets, not scans of the lists: a hostile file can name tens of thousands of sheets.
  const errorKeys = new Set<string>()
  const usedSheets = new Set<SchSheet>()
  const expand = (file: string, instancePath: string, chain: string[], chainSymbols: SchSheet[], ancestors: string[]) => {
    const schematic = tree.files.get(file)!.schematic
    for (const sheet of schematic.sheets) {
      if (stop) return
      const named = sheet.file ?? ""
      const resolved = normalizePath(`${dirOf(file)}/${named}`)
      const fail = (code: SheetError["code"], message: string) => {
        // The same sheet reached through several uses of its parent is one error.
        const key = `${code}|${file}|${named}`
        if (!errorKeys.has(key)) {
          errorKeys.add(key)
          tree.errors.push({ code, file: named, sheet: sheet.name, parent: file, message })
        }
      }
      if (!named.trim()) {
        fail("missing", `${describe(sheet.name, "no file named")} has no file name, so its pages cannot be read.`)
        continue
      }
      const found = index.find(resolved)
      const use: SheetUse = { parent: file, sheet, file: found?.path ?? resolved, found: !!found }
      if (!usedSheets.has(sheet)) {
        usedSheets.add(sheet)
        tree.uses.push(use)
      }
      if (!found) {
        fail("missing", `${describe(sheet.name, named)} is not among the files, so its pages are missing.`)
        continue
      }
      if (ancestors.includes(found.path) || found.path === file) {
        fail("cycle", `${describe(sheet.name, named)} contains itself, directly or through other sheets.`)
        continue
      }
      if (ancestors.length + 1 >= MAX_SHEET_DEPTH) {
        fail("too-deep", `Sheets nest more than ${MAX_SHEET_DEPTH} deep at ${describe(sheet.name, named)}, which no KiCad project does.`)
        continue
      }
      if (tree.instances.length >= MAX_SHEET_INSTANCES) {
        fail("too-many", `The sheets expand to more than ${MAX_SHEET_INSTANCES} uses, which no KiCad project does.`)
        stop = true
        return
      }
      if (!tried.has(found.path)) {
        try {
          load(found.path, found.data)
          tried.set(found.path, "ok")
        } catch (e) {
          tried.set(found.path, "bad")
          fail("unreadable", `${describe(sheet.name, named)} could not be read: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
      } else if (tried.get(found.path) === "bad") {
        continue
      }
      const childChain = [...chain, sheet.uuid]
      const childSymbols = [...chainSymbols, sheet]
      const childPath = `${instancePath}/${sheet.uuid}`
      tree.instances.push({ path: childPath, file: found.path, chain: childChain, symbols: childSymbols, sheet })
      expand(found.path, childPath, childChain, childSymbols, [...ancestors, file])
    }
  }
  expand(rootFound.path, `/${root.uuid}`, [], [], [])
  return tree
}

/** The sheet files of a tree in the order they were first reached, root first. */
export const sheetFiles = (tree: SchematicTree): SheetFile[] => [...tree.files.values()]
