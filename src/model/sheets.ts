import { uid } from "../lib/id"
import type { ComponentInstance, NetLabel, Project, SchematicBlock, SchematicDrawing, SchematicSheet, SheetSymbol, Wire } from "./types"
import { activeVariant, markSettled, resolveVariant, variantSheetFlags } from "./variants"

// S1: hierarchical sheets.
//
// A project is a tree of sheets. The root sheet is `ROOT_SHEET`; every other sheet is drawn once and is used by one or more
// sheet symbols (`Project.sheetSymbols`), each a rectangle on a sheet above it. A project with no sheet symbols is one sheet,
// which is how a project drawn in the editor starts and stays unless the user adds a sheet.
//
// Every use of a sheet is a node of the tree with a path made of the ids of the sheet symbols from the root down: `` for the
// root, `/h1` for the sheet that symbol h1 stands for, `/h1/h4` for what a symbol h4 on that sheet stands for. This is what KiCad
// calls an instance path. A sheet used twice has two uses, which are two sets of symbols (each with its own reference and its
// own place on the board) and one set of wires, labels and drawings, which every use shares:
//
//   - a wire, label, drawing or sheet symbol belongs to a sheet (`sheet`, absent for the root), so every use of it draws it;
//   - a part's symbol belongs to a use (`inst`, absent for the root), and the symbols of the later uses of a sheet are copies
//     of the first use's (`tpl`), kept alike by `syncCopies`;
//   - a block holds the symbols of one use (`SchematicBlock.inst`).
//
// Everything that edits or reads one sheet at a time (the editor, Tidy, Clean up, Sakura's tools) works on a *view* of a use:
// the project with only that use's items in `components`, `wires`, `labels`, `drawings` and `blocks`, and `scope` set to its
// path. A view of the root of a project with one sheet is the project itself, so nothing changes for a project drawn in the editor.

/** What a sheet symbol is called: its name, or `Sheet` for one with none. */
export const sheetSymbolName = (sym: SheetSymbol): string => sym.name || "Sheet"

export const ROOT_SHEET = "root"

/** What the root sheet is called until it is named: the top sheet of the schematic, which every other sheet hangs from. */
export const MAIN_SHEET_NAME = "Main"

/** The most uses of sheets a project may have, and the deepest it may nest (the importer refuses more, as KiCad's own projects stay far below). */
export const MAX_SHEET_USES = 20000
export const MAX_SHEET_DEPTH = 64

/** One use of a sheet: a node of the sheet tree. */
export interface SheetUse {
  /** `` for the root, else `/h1/h4`: the ids of the sheet symbols from the root. */
  path: string
  /** The sheet this is a use of. */
  sheet: string
  /** The sheet symbol that makes this use; null for the root. */
  symbol: SheetSymbol | null
  /** The path of the use this one is on a sheet of; null for the root. */
  parent: string | null
  /** The name the tree shows: the symbol's `Sheetname`, or for the root its own name (`Main` until it has one). */
  name: string
  /** KiCad's human-readable path, which prefixes the names of local nets: `/` for the root, `/Power/Reg/` below it. */
  human: string
  depth: number
  /** Its page number, in the order of the tree from 1 for the root (what a KiCad export numbers its pages by). */
  page: string
}

/** The sheets of a project, the root first: the root is there whether or not the project lists it. */
export function sheetsOf(project: Pick<Project, "sheets">): SchematicSheet[] {
  const listed = project.sheets ?? []
  return listed.some((s) => s.id === ROOT_SHEET) ? listed : [{ id: ROOT_SHEET }, ...listed]
}

export const sheetIdOf = (item: { sheet?: string }) => item.sheet ?? ROOT_SHEET
export const useOf = (item: { inst?: string }) => item.inst ?? ""

/** Whether the project has more than one use of a sheet. A project that has not is one sheet, whatever the model keeps beside it. */
export const isHierarchical = (project: Pick<Project, "sheetSymbols">) => (project.sheetSymbols?.length ?? 0) > 0

interface Tree {
  uses: SheetUse[]
  byPath: Map<string, SheetUse>
  /** The sheets a symbol names that could not be used: one that holds itself, or that nests too deep. */
  refused: SheetSymbol[]
}

const treeCache = new WeakMap<object, WeakMap<object, Tree>>()
const NO_SHEETS: SchematicSheet[] = []
const NO_SYMBOLS: SheetSymbol[] = []

const rootOf = (project: Pick<Project, "sheets">) => sheetsOf(project).find((s) => s.id === ROOT_SHEET)

/** The root sheet's own name, `Main` until it is given one. It is a sheet like the others, never the project: the tree is the project's sheets. */
export const rootSheetName = (project: Pick<Project, "sheets">) => rootOf(project)?.name || MAIN_SHEET_NAME

const rootUse = (project: Pick<Project, "sheets">): SheetUse => ({
  path: "",
  sheet: ROOT_SHEET,
  symbol: null,
  parent: null,
  name: rootSheetName(project),
  human: "/",
  depth: 0,
  page: "1",
})

function walk(project: Pick<Project, "sheets" | "sheetSymbols">): Tree {
  const symbols = project.sheetSymbols ?? NO_SYMBOLS
  const bySheet = new Map<string, SheetSymbol[]>()
  for (const s of symbols) (bySheet.get(s.sheet) ?? bySheet.set(s.sheet, []).get(s.sheet)!).push(s)
  const root = rootUse(project)
  const uses: SheetUse[] = [root]
  const refused: SheetSymbol[] = []
  const ancestors: string[] = [ROOT_SHEET]
  const visit = (use: SheetUse) => {
    for (const sym of bySheet.get(use.sheet) ?? []) {
      // A sheet that holds itself, directly or through others, is a cycle; one nested too deep or too wide is not a project.
      if (ancestors.includes(sym.child) || ancestors.length >= MAX_SHEET_DEPTH || uses.length >= MAX_SHEET_USES) {
        refused.push(sym)
        continue
      }
      const path = `${use.path}/${sym.id}`
      const name = sheetSymbolName(sym)
      const child: SheetUse = { path, sheet: sym.child, symbol: sym, parent: use.path, name, human: `${use.human}${name}/`, depth: use.depth + 1, page: "" }
      uses.push(child)
      ancestors.push(sym.child)
      visit(child)
      ancestors.pop()
    }
  }
  visit(root)
  uses.forEach((u, i) => {
    u.page = String(i + 1)
  })
  return { uses, byPath: new Map(uses.map((u) => [u.path, u])), refused }
}

function treeOf(project: Pick<Project, "sheets" | "sheetSymbols">): Tree {
  const symbols = project.sheetSymbols ?? NO_SYMBOLS
  const sheets = project.sheets ?? NO_SHEETS
  let byShapes = treeCache.get(symbols)
  if (!byShapes) treeCache.set(symbols, (byShapes = new WeakMap()))
  let tree = byShapes.get(sheets)
  if (!tree) {
    tree = walk(project)
    byShapes.set(sheets, tree)
  }
  return tree
}

/** Every use of every sheet, root first, each sheet's uses after the one above them (depth first, in the order the symbols are listed). */
export const sheetUses = (project: Pick<Project, "sheets" | "sheetSymbols">): SheetUse[] => treeOf(project).uses

/** The use at a path, or the root when the project has none there (a path that went with a deleted symbol). */
export const useAt = (project: Pick<Project, "sheets" | "sheetSymbols">, path: string): SheetUse => treeOf(project).byPath.get(path) ?? treeOf(project).uses[0]

export const hasUse = (project: Pick<Project, "sheets" | "sheetSymbols">, path: string) => treeOf(project).byPath.has(path)

/** The symbols the tree could not follow: a sheet that holds itself, or that nests too deep. */
export const refusedSheetSymbols = (project: Pick<Project, "sheets" | "sheetSymbols">): SheetSymbol[] => treeOf(project).refused

/** The uses of one sheet, in tree order. */
export const usesOfSheet = (project: Pick<Project, "sheets" | "sheetSymbols">, sheet: string): SheetUse[] => sheetUses(project).filter((u) => u.sheet === sheet)

/** The uses on the sheet a use is (the children of a node of the tree), in order. */
export const childUses = (project: Pick<Project, "sheets" | "sheetSymbols">, path: string): SheetUse[] => sheetUses(project).filter((u) => u.parent === path)

/** The sheet symbols drawn on a sheet. */
export const symbolsOnSheet = (project: Pick<Project, "sheetSymbols">, sheet: string): SheetSymbol[] => (project.sheetSymbols ?? NO_SYMBOLS).filter((s) => s.sheet === sheet)

/** The use of a symbol on a given use of its parent sheet: the child use the symbol stands for there. */
export const useOfSymbol = (parentPath: string, symbol: Pick<SheetSymbol, "id">) => `${parentPath}/${symbol.id}`

/** The name a sheet goes by: its symbol's name where it has one, else the sheet's own, else its id. */
export function sheetName(project: Pick<Project, "sheets" | "sheetSymbols">, sheet: string): string {
  if (sheet === ROOT_SHEET) return rootSheetName(project)
  const sym = (project.sheetSymbols ?? NO_SYMBOLS).find((s) => s.child === sheet)
  return sym?.name || sheetsOf(project).find((s) => s.id === sheet)?.name || sheet
}

// ---------- views: one use of a sheet at a time ----------

const viewCache = new WeakMap<Project, Map<string, Project>>()

/**
 * The project as one use of a sheet shows it: only that use's symbols, and only that sheet's wires, labels, drawings and blocks.
 * Everything else is the project's, so an operation that edits one sheet (`moveSchematicItems`, `tidySchematic`) runs on a view as it
 * would on a project that has that sheet alone. A view of the root of a project with one sheet is the project itself. The same project
 * gives the same view for the same path, so what is cached on a project object works on views.
 */
export function sheetView(project: Project, path: string): Project {
  if (!isHierarchical(project) && path === "" && project.scope === undefined) return project
  if (project.scope !== undefined) {
    if (project.scope === path) return project
    throw new Error("a view of a sheet has no other sheet in it")
  }
  let views = viewCache.get(project)
  if (!views) viewCache.set(project, (views = new Map()))
  const hit = views.get(path)
  if (hit) return hit
  const use = useAt(project, path)
  const here = use.path
  const inUse = (c: { inst?: string }) => (c.inst ?? "") === here
  const onSheet = (i: { sheet?: string }) => (i.sheet ?? ROOT_SHEET) === use.sheet
  const view: Project = {
    ...project,
    components: project.components.filter(inUse),
    wires: project.wires.filter(onSheet),
    labels: project.labels.filter(onSheet),
    ...(project.drawings ? { drawings: project.drawings.filter(onSheet) } : {}),
    ...(project.blocks ? { blocks: project.blocks.filter(inUse) } : {}),
    scope: here,
  }
  views.set(path, view)
  return view
}

/** Whether a project is a view of one use of a sheet. */
export const isView = (project: Pick<Project, "scope">) => project.scope !== undefined

type Tagged = { id: string }

/** The items of `all` with those of a view replaced by what an operation made of them: kept where they were, removed ones gone, new ones after the last of the view's. */
function mergeList<T extends Tagged>(all: readonly T[], seen: readonly T[], made: readonly T[], tag: (item: T) => T): T[] {
  if (made === seen) return all as T[]
  const shown = new Set(seen.map((x) => x.id))
  const madeById = new Map(made.map((x) => [x.id, x]))
  const out: T[] = []
  let last = -1
  for (const item of all) {
    if (!shown.has(item.id)) {
      out.push(item)
      continue
    }
    const next = madeById.get(item.id)
    if (next) {
      out.push(next)
      last = out.length - 1
    }
  }
  const added = made.filter((x) => !shown.has(x.id)).map(tag)
  if (added.length) out.splice(last + 1 || out.length, 0, ...added)
  return out
}

/**
 * What an operation made on a view, put back in the project it is a view of: the view's own items replaced, new ones tagged with the
 * sheet and use they are on, and everything the operation changed outside the lists (the parts, the checks the user ignored) kept. A
 * new symbol whose reference is another sheet's gets the next free one. `inst` is the use the view shows.
 */
export function mergeSheetView(project: Project, view: Project, made: Project): Project {
  if (made === view) return project
  const path = view.scope ?? ""
  const use = useAt(project, path)
  const sheetTag = <T extends { sheet?: string }>(item: T): T => (use.sheet === ROOT_SHEET || item.sheet !== undefined ? item : { ...item, sheet: use.sheet })
  const instTag = <T extends { inst?: string }>(item: T): T => (path === "" || item.inst !== undefined ? item : { ...item, inst: path })
  const components = mergeList(project.components, view.components, made.components, instTag)
  const { scope: _scope, ...rest } = made
  void _scope
  const merged: Project = {
    ...rest,
    components: uniqueRefs(project, view, components),
    wires: mergeList<Wire>(project.wires, view.wires, made.wires, sheetTag),
    labels: mergeList<NetLabel>(project.labels, view.labels, made.labels, sheetTag),
  }
  if (project.drawings || made.drawings) {
    const drawings = mergeList<SchematicDrawing>(project.drawings ?? [], view.drawings ?? [], made.drawings ?? [], sheetTag)
    if (drawings.length) merged.drawings = drawings
    else delete merged.drawings
  }
  if (project.blocks || made.blocks) {
    const blocks = mergeList<SchematicBlock>(project.blocks ?? [], view.blocks ?? [], made.blocks ?? [], instTag)
    if (blocks.length) merged.blocks = blocks
    else delete merged.blocks
  }
  return merged
}

/** New symbols named as one of another sheet's are renamed to the next free number of their prefix, so two sheets never share a reference by accident. */
function uniqueRefs(project: Project, view: Project, components: ComponentInstance[]): ComponentInstance[] {
  const known = new Set(project.components.map((c) => c.id))
  const added = components.filter((c) => !known.has(c.id))
  if (!added.length) return components
  const viewIds = new Set(view.components.map((c) => c.id))
  const elsewhere = new Set(project.components.filter((c) => !viewIds.has(c.id)).map((c) => c.ref))
  const rename = new Map<string, string>()
  const taken = new Set(components.map((c) => c.ref))
  for (const c of added) {
    if (!elsewhere.has(c.ref) || /[#?*]/.test(c.ref) || rename.has(c.ref)) continue
    const m = /^(.*?)(\d+)$/.exec(c.ref)
    if (!m) continue
    let n = Number(m[2])
    let next = c.ref
    while (taken.has(next)) next = `${m[1]}${++n}`
    taken.add(next)
    rename.set(c.ref, next)
  }
  return rename.size ? components.map((c) => (!known.has(c.id) && rename.has(c.ref) ? { ...c, ref: rename.get(c.ref)! } : c)) : components
}

// ---------- the copies of a sheet used more than once ----------

/** The key every copy of a symbol shares: the first use's symbol's id. */
export const copyKey = (c: Pick<ComponentInstance, "id" | "tpl">) => c.tpl ?? c.id

/**
 * What a copy keeps of its own when the sheet is edited: its reference and unit (each use has its own), its place on the board, the footprint's own text and groups,
 * and its schematic variants (S9: what a variant changes on a symbol is said for one use, as KiCad 10 keeps it in that use's instance data).
 */
const OWN: ReadonlySet<string> = new Set(["id", "ref", "inst", "tpl", "unit", "pcb", "texts", "groups", "fpid", "variants"])

/** A new copy's reference: the symbol's own letters and the next number nobody has. */
function nextCopyRef(ref: string, taken: Set<string>): string {
  const m = /^(.*?)(\d*)$/.exec(ref)
  const prefix = m?.[1] ?? ref
  if (/[#?*]/.test(ref) || !prefix) return ref
  let n = 0
  for (const r of taken) {
    const x = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\#$]/g, "\\$&")}(\\d+)$`).exec(r)
    if (x) n = Math.max(n, Number(x[1]))
  }
  return `${prefix}${n + 1}`
}

/**
 * Keeps the uses of a sheet alike after an edit on one of them: every other use of the sheet gets the symbols the edited use has,
 * placed, turned and set as they are there, each keeping its own reference, unit and place on the board. A symbol added in the
 * edited use is copied to the others (with the next free reference), and one removed is removed from them. A project with no sheet
 * used twice is returned as it is.
 */
export function syncCopies(project: Project, path: string): Project {
  if (!isHierarchical(project)) return project
  const use = useAt(project, path)
  const others = usesOfSheet(project, use.sheet).filter((u) => u.path !== use.path)
  if (!others.length) return project
  const source = project.components.filter((c) => useOf(c) === use.path)
  const sourceKeys = new Set(source.map(copyKey))
  const taken = new Set(project.components.map((c) => c.ref))
  const otherPaths = new Set(others.map((u) => u.path))
  const have = new Map<string, ComponentInstance>()
  for (const c of project.components) if (otherPaths.has(useOf(c))) have.set(`${useOf(c)}\u0000${copyKey(c)}`, c)
  const out: ComponentInstance[] = []
  let changed = false
  const written = new Set<string>()
  for (const c of project.components) {
    const u = useOf(c)
    if (!otherPaths.has(u)) {
      out.push(c)
      continue
    }
    // A symbol the edited use no longer has goes from the other uses.
    if (!sourceKeys.has(copyKey(c))) {
      changed = true
      continue
    }
    const s = source.find((x) => copyKey(x) === copyKey(c))!
    const next = copyOf(s, c)
    if (!same(next, c)) changed = true
    written.add(`${u}\u0000${copyKey(c)}`)
    out.push(next)
  }
  for (const u of others) {
    for (const s of source) {
      if (written.has(`${u.path}\u0000${copyKey(s)}`) || have.has(`${u.path}\u0000${copyKey(s)}`)) continue
      const ref = nextCopyRef(s.ref, taken)
      taken.add(ref)
      out.push({ ...stripOwn(s), id: uid("c"), ref, inst: u.path || undefined, tpl: copyKey(s), pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false } } as ComponentInstance)
      changed = true
    }
  }
  if (!changed) return project
  // A symbol of the edited use that was copied before has no `tpl` of its own while a copy names it: the key is the first one's id.
  return { ...project, components: out }
}

/**
 * Gives every use of a reused sheet the symbols another use of it has and it lacks, and nothing else: it never removes or rewrites a symbol (that is `syncCopies`,
 * run where an edit is made). It is what two copies of a shared project both run on the same state, so it must give the same answer on both: the source of a
 * missing symbol is the first use (by path) that has it, the order is by path and key rather than the list's order, and a new copy's id is made from its template and
 * its use, so two copies that fill one gap write the same item and nothing is doubled.
 */
export function fillCopies(project: Project): Project {
  if (!isHierarchical(project)) return project
  const uses = sheetUses(project).filter((u) => u.path !== "")
  const bySheet = new Map<string, SheetUse[]>()
  for (const u of uses) (bySheet.get(u.sheet) ?? bySheet.set(u.sheet, []).get(u.sheet)!).push(u)
  const byUse = new Map<string, Map<string, ComponentInstance>>()
  for (const c of project.components) {
    const at = useOf(c)
    const m = byUse.get(at) ?? byUse.set(at, new Map()).get(at)!
    const k = copyKey(c)
    // Two symbols with one key in one use: the lower id is the one other uses copy.
    const was = m.get(k)
    if (!was || c.id < was.id) m.set(k, c)
  }
  const taken = new Set(project.components.map((c) => c.ref))
  const added: ComponentInstance[] = []
  const ids = new Set(project.components.map((c) => c.id))
  for (const list of bySheet.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const keys = new Set<string>()
    for (const u of sorted) for (const k of byUse.get(u.path)?.keys() ?? []) keys.add(k)
    for (const k of [...keys].sort()) {
      const source = sorted.map((u) => byUse.get(u.path)?.get(k)).find((c) => c)!
      for (const u of sorted) {
        if (byUse.get(u.path)?.has(k)) continue
        const id = `c_${k}_${u.path.replace(/\//g, "-")}`
        if (ids.has(id)) continue
        const ref = nextCopyRef(source.ref, taken)
        taken.add(ref)
        ids.add(id)
        added.push({ ...stripOwn(source), id, ref, inst: u.path, tpl: k, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false } } as ComponentInstance)
      }
    }
  }
  return added.length ? { ...project, components: [...project.components, ...added] } : project
}

const stripOwn = (c: ComponentInstance): ComponentInstance => {
  const out = { ...c } as Record<string, unknown>
  delete out.inst
  delete out.tpl
  // A new copy starts with no variants: those of the use it was copied from are that use's.
  delete out.variants
  return out as unknown as ComponentInstance
}

/** The symbol `s` as its copy `c` has it: everything of `s` but what each copy keeps of its own. */
function copyOf(s: ComponentInstance, c: ComponentInstance): ComponentInstance {
  const next: Record<string, unknown> = { id: c.id, ref: c.ref, pcb: c.pcb }
  if (c.inst !== undefined) next.inst = c.inst
  next.tpl = copyKey(s)
  for (const k of ["unit", "texts", "groups", "fpid", "variants"] as const) if (c[k] !== undefined) next[k] = c[k]
  for (const [k, v] of Object.entries(s)) if (!OWN.has(k)) next[k] = v
  // The footprint is the symbol's field, shared by every use; its KiCad name goes with it.
  return next as unknown as ComponentInstance
}

function same(a: ComponentInstance, b: ComponentInstance): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const x = a as unknown as Record<string, unknown>
  const y = b as unknown as Record<string, unknown>
  return ka.every((k) => x[k] === y[k] || JSON.stringify(x[k]) === JSON.stringify(y[k]))
}

/** The edit on one use of a sheet, put back into the project and made consistent with the sheet's other uses. */
export function commitOnUse(project: Project, path: string, fn: (view: Project) => Project): Project {
  if (!isHierarchical(project) && path === "") return fn(project)
  const view = sheetView(project, path)
  const made = fn(view)
  if (made === view) return project
  return syncCopies(mergeSheetView(project, view, made), path)
}

// ---------- the flags a sheet symbol gives what is inside it ----------

/**
 * The project with the flags of sheet symbols (do not populate, not in the BOM, not on the board, not simulated) put on the symbols of every
 * sheet below them, as KiCad has them mean (the flag of a sheet is the flag of everything on it). The project itself keeps the flag
 * on the sheet symbol only; a project with no flagged sheet symbol is returned as it is. The BOM, the position file and the exports read this.
 */
export function withSheetFlags(source: Project): Project {
  // S9: the active variant first: its changes to a symbol, and to a sheet symbol's flags on each use, are what the flags below are inherited from.
  return applySheetFlags(resolveVariant(source), activeVariant(source))
}

/**
 * The sheet symbols' flags put on the symbols below them, for a project the variant is already put on (`resolveVariant`): each use of a sheet asks the variant
 * for its own flags (`variantSheetFlags`). The flags are only put on, never cleared, so a variant that clears a symbol's own flag leaves one a sheet sets.
 */
export function applySheetFlags(project: Project, variant: string | undefined): Project {
  if (!project.sheetSymbols?.some((s) => (s.flags && Object.keys(s.flags).length) || (variant !== undefined && s.variants))) return project
  const uses = new Map(sheetUses(project).map((u) => [u.path, u]))
  const inherited = (path: string) => {
    const out: NonNullable<SheetSymbol["flags"]> = {}
    for (let at = uses.get(path); at?.symbol; at = uses.get(at.parent ?? "")) {
      const f = variantSheetFlags(at.symbol, at.parent ?? "", variant)
      if (f?.dnp) out.dnp = true
      if (f?.excludeFromBom) out.excludeFromBom = true
      if (f?.notOnBoard) out.notOnBoard = true
      if (f?.excludeFromSim) out.excludeFromSim = true
    }
    return out
  }
  let changed = false
  const components = project.components.map((c) => {
    const f = inherited(c.inst ?? "")
    if (!Object.keys(f).length) return c
    changed = true
    return markSettled({ ...c, flags: { ...c.flags, ...f } })
  })
  return changed ? { ...project, components } : project
}

/**
 * After an edit made on the whole project (Sakura's `update_component`, a part removed by its reference), the uses of a sheet used more than
 * once are made alike: the first use that has a symbol the edit changed, added or removed is the one the others follow. A project with no
 * sheet used twice, and an edit that touched none of them, are returned as they are.
 */
export function syncEdited(before: Project, after: Project): Project {
  if (before === after || !isHierarchical(after)) return after
  const shared = new Set(sheetUses(after).filter((u) => usesOfSheet(after, u.sheet).length > 1).map((u) => u.path))
  if (!shared.size) return after
  const was = new Map(before.components.map((c) => [c.id, c]))
  const now = new Set(after.components.map((c) => c.id))
  let out = after
  const done = new Set<string>()
  const touched = (path: string) => after.components.some((c) => useOf(c) === path && was.get(c.id) !== c) || before.components.some((c) => useOf(c) === path && !now.has(c.id))
  for (const u of sheetUses(after)) {
    if (!shared.has(u.path) || done.has(u.sheet) || !touched(u.path)) continue
    done.add(u.sheet)
    out = syncCopies(out, u.path)
  }
  return out
}
