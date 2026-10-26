import type { SchematicTree } from "./tree"
import type { PlacedSymbol } from "./types"

// Linking a footprint on the board to its symbol on the schematic (section 4 of
// docs/kicad-import-schematic.md), in this order:
//
//   1. path       the footprint's `(path "/<sheet uuids>/<symbol uuid>")` against each symbol's
//                 instance paths. From KiCad 7 an instance path starts with the root sheet's uuid
//                 and a board path does not, so the first segment is dropped; KiCad 6's root list
//                 writes paths as boards do. A symbol on a reused sheet has several paths, and
//                 one symbol links several footprints.
//   2. timestamp  KiCad 5 writes `(path /5A1B2C3D)` and KiCad 6 re-encodes a timestamp as the uuid
//                 `00000000-0000-0000-0000-00005a1b2c3d`: both sides are read as timestamps.
//   3. reference  the reference designator, from the instance of the sheet the symbol is on.
//                 Several symbols with one reference are units of one part.
//   4. nothing    a footprint with no match stays a part with no symbol (mounting holes, logos,
//                 a board that has moved on from its schematic).

export interface SymbolRecord {
  file: string
  symbol: PlacedSymbol
  reference: string
  unit: number
  /** The value and footprint this use gives the symbol, where the instance data has them (KiCad 6's root list always does): they stand in place of the symbol's own fields. */
  value: string | null
  footprint: string | null
  /** The path of this use of the symbol as a board writes it: `/<sheet uuids>/<symbol uuid>`. */
  path: string
  /** The path of the sheet it is on, in the same form: `/` for the root sheet. */
  sheetPath: string
  /** The instance data came from the symbol itself, the root list, or was made up from the sheet's place (a file with no instance data). */
  from: "symbol" | "root-list" | "none"
}

const referenceOf = (s: PlacedSymbol) => s.props.find((p) => p.name === "Reference")?.value ?? ""

const recordCache = new WeakMap<SchematicTree, SymbolRecord[]>()

/** Every use of every symbol of the tree: one record per instance path. The same tree gives the same records, so a map keyed by one works for the link and the build. */
export function symbolRecords(tree: SchematicTree): SymbolRecord[] {
  const hit = recordCache.get(tree)
  if (hit) return hit
  const made = recordsOf(tree)
  recordCache.set(tree, made)
  return made
}

function recordsOf(tree: SchematicTree): SymbolRecord[] {
  const out: SymbolRecord[] = []
  const rootFile = tree.files.get(tree.root)
  const rootUuid = rootFile?.schematic.uuid ?? ""
  const boardForm = (instancePath: string) => (rootUuid && (instancePath === `/${rootUuid}` || instancePath.startsWith(`/${rootUuid}/`)) ? instancePath.slice(rootUuid.length + 1) || "/" : null)
  // The chain of sheet uuids of each use of a file, in the board's form.
  const sheetPathsOf = new Map<string, string[]>()
  for (const inst of tree.instances) {
    const list = sheetPathsOf.get(inst.file) ?? []
    list.push(inst.chain.length ? `/${inst.chain.join("/")}` : "/")
    sheetPathsOf.set(inst.file, list)
  }
  // KiCad 6: the root list names every symbol of every sheet by its path.
  const listed = new Map<string, { reference: string; unit: number; value: string | null; footprint: string | null; sheetPath: string; path: string }[]>()
  for (const i of rootFile?.schematic.rootInstances ?? []) {
    const cut = i.path.lastIndexOf("/")
    const uuid = i.path.slice(cut + 1)
    const sheetPath = i.path.slice(0, cut) || "/"
    const l = listed.get(uuid) ?? []
    l.push({ reference: i.reference, unit: i.unit, value: i.value, footprint: i.footprint, sheetPath, path: i.path })
    listed.set(uuid, l)
  }
  for (const file of tree.files.values()) {
    const sheetPaths = sheetPathsOf.get(file.path)
    if (!sheetPaths) continue
    for (const sym of file.schematic.symbols) {
      const before = out.length
      // KiCad 7 and later.
      for (const i of sym.instances) {
        const sheetPath = boardForm(i.path)
        if (sheetPath === null) continue
        out.push({ file: file.path, symbol: sym, reference: i.reference, unit: i.unit, value: i.value, footprint: i.footprint, path: `${sheetPath === "/" ? "" : sheetPath}/${sym.uuid}`, sheetPath, from: "symbol" })
      }
      // KiCad 6.
      for (const i of listed.get(sym.uuid) ?? []) out.push({ file: file.path, symbol: sym, reference: i.reference, unit: i.unit, value: i.value, footprint: i.footprint, path: i.path, sheetPath: i.sheetPath, from: "root-list" })
      if (out.length === before) {
        // No instance data at all: the symbol's own reference stands at every place its sheet is used.
        for (const sheetPath of sheetPaths) out.push({ file: file.path, symbol: sym, reference: referenceOf(sym), unit: sym.unit, value: null, footprint: null, path: `${sheetPath === "/" ? "" : sheetPath}/${sym.uuid}`, sheetPath, from: "none" })
      }
    }
  }
  return out
}

const TIMESTAMP_UUID = /^0{8}-0{4}-0{4}-0{4}-([0-9a-f]{12})$/i

/** A path with each segment that is a re-encoded KiCad 5 timestamp written as the timestamp: `00000000-0000-0000-0000-00005a1b2c3d` is `5A1B2C3D`. */
export function timestampForm(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      const m = TIMESTAMP_UUID.exec(seg)
      return m ? m[1].replace(/^0+(?=.)/, "").toUpperCase() : seg.toUpperCase()
    })
    .join("/")
}

export interface FootprintToLink {
  ref: string
  path: string
}

export type LinkHow = "path" | "timestamp" | "reference"

export interface FootprintLink {
  /** Index into the footprints that were given. */
  footprint: number
  ref: string
  how: LinkHow | null
  /** The use of the symbol it links to; null when nothing matched. */
  record: SymbolRecord | null
  /** The symbols that are units of the same part: the linked one first, then the others on the same sheet use with the same reference. */
  units: SymbolRecord[]
  /** More than one use had the footprint's path: the first with its reference was taken. */
  ambiguous: boolean
}

export interface LinkResult {
  links: FootprintLink[]
  /** Footprints by how they linked. `excluded` is the footprints whose reference holds `*` (`REF**`): none was ever annotated. */
  counts: { footprints: number; path: number; timestamp: number; reference: number; none: number; excluded: number; noneNoPath: number; noneWithPath: number }
  /** Symbols (by object) linked to more than one footprint: a reused sheet. */
  symbolsOnSeveralFootprints: number
  /** References with more than one symbol: multi-unit parts. */
  multiUnitReferences: number
  /** Symbol uses with a footprint field that no footprint linked to, and the rest that have none. */
  records: number
}

/** Links footprints to the symbols of a tree. */
export function linkFootprints(tree: SchematicTree, footprints: FootprintToLink[]): LinkResult {
  const records = symbolRecords(tree)
  const byPath = new Map<string, SymbolRecord[]>()
  const byTimestamp = new Map<string, SymbolRecord[]>()
  const byRef = new Map<string, SymbolRecord[]>()
  const push = (m: Map<string, SymbolRecord[]>, k: string, r: SymbolRecord) => {
    const l = m.get(k)
    if (l) l.push(r)
    else m.set(k, [r])
  }
  const bySheetRef = new Map<string, SymbolRecord[]>()
  for (const r of records) {
    push(byPath, r.path, r)
    push(byTimestamp, timestampForm(r.path), r)
    if (r.reference) {
      push(byRef, r.reference, r)
      push(bySheetRef, `${r.sheetPath}\n${r.reference}`, r)
    }
  }
  const counts = { footprints: 0, path: 0, timestamp: 0, reference: 0, none: 0, excluded: 0, noneNoPath: 0, noneWithPath: 0 }
  const links: FootprintLink[] = []
  const used = new Map<PlacedSymbol, number>()
  footprints.forEach((fp, index) => {
    const none: FootprintLink = { footprint: index, ref: fp.ref, how: null, record: null, units: [], ambiguous: false }
    if (/\*/.test(fp.ref)) {
      counts.excluded++
      links.push(none)
      return
    }
    counts.footprints++
    const choose = (list: SymbolRecord[] | undefined): { record: SymbolRecord; ambiguous: boolean } | null => {
      if (!list?.length) return null
      if (list.length === 1) return { record: list[0], ambiguous: false }
      return { record: list.find((r) => r.reference === fp.ref) ?? list[0], ambiguous: true }
    }
    let how: LinkHow | null = null
    let hit: { record: SymbolRecord; ambiguous: boolean } | null = null
    if (fp.path) {
      hit = choose(byPath.get(fp.path))
      if (hit) how = "path"
      else {
        hit = choose(byTimestamp.get(timestampForm(fp.path)))
        if (hit) how = "timestamp"
      }
    }
    if (!hit && fp.ref) {
      hit = choose(byRef.get(fp.ref))
      if (hit) how = "reference"
    }
    if (!hit || !how) {
      counts.none++
      if (fp.path) counts.noneWithPath++
      else counts.noneNoPath++
      links.push(none)
      return
    }
    counts[how]++
    const record = hit.record
    // Units of one part: the other symbols with this reference on the same sheet use.
    // The other units of a part may be on another sheet: a reference is the project's, unless no annotation gave it. Each unit once.
    const mates = record.reference ? (/[?*]$/.test(record.reference) ? (bySheetRef.get(`${record.sheetPath}\n${record.reference}`) ?? []) : (byRef.get(record.reference) ?? [])) : [record]
    const units = [record]
    for (const m of mates) if (m !== record && (m.sheetPath === record.sheetPath || !units.some((x) => x.unit === m.unit))) units.push(m)
    used.set(record.symbol, (used.get(record.symbol) ?? 0) + 1)
    links.push({ footprint: index, ref: fp.ref, how, record, units, ambiguous: hit.ambiguous })
  })
  const refSymbols = new Map<string, Set<PlacedSymbol>>()
  for (const r of records) {
    if (!r.reference) continue
    const s = refSymbols.get(r.reference) ?? new Set()
    s.add(r.symbol)
    refSymbols.set(r.reference, s)
  }
  return {
    links,
    counts,
    symbolsOnSeveralFootprints: [...used.values()].filter((n) => n > 1).length,
    multiUnitReferences: [...refSymbols.values()].filter((s) => s.size > 1).length,
    records: records.length,
  }
}
