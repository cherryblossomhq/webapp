import { findPart } from "./library"
import type { ComponentInstance, PartFlags, Project, ProjectVariants, SheetSymbol, VariantOverride } from "./types"

// S9: schematic variants (KiCad 10). A project lists its variants by name (`Project.variants`); each symbol says what a variant changes on it
// (`ComponentInstance.variants`: only what differs from the symbol's own, as KiCad 10 writes it), each sheet symbol the same for its flags.
// One variant is active at a time. The symbols themselves are never rewritten by it: this file is the one resolver that turns "the symbols and the
// active variant" into what the BOM, the position file, the do not populate marks and the board side use (`resolveVariant`, `variantComponents`).

const FLAG_KEYS = ["dnp", "excludeFromBom", "notOnBoard", "excludeFromSim", "excludeFromPos"] as const
export type VariantFlag = (typeof FLAG_KEYS)[number]
export const VARIANT_FLAGS: readonly VariantFlag[] = FLAG_KEYS

/** The names of a project's variants, in the order the project lists them. */
export const variantNames = (project: Pick<Project, "variants">): string[] => project.variants?.list.map((v) => v.name) ?? []

/** The variant that is active, when the project lists it. */
export function activeVariant(project: Pick<Project, "variants">): string | undefined {
  const a = project.variants?.active
  return a !== undefined && project.variants?.list.some((v) => v.name === a) ? a : undefined
}

/** Flags with a variant's changes put on: a `true` sets the flag, a `false` clears one the symbol has, an absent key keeps what the symbol says. */
export function overlayFlags<F extends Partial<Record<VariantFlag, true>>>(flags: F | undefined, o: VariantOverride | undefined): F | undefined {
  if (!o) return flags
  let out: Record<string, unknown> | undefined
  for (const k of FLAG_KEYS) {
    const v = o[k]
    if (v === undefined) continue
    if (v === !!flags?.[k]) continue
    out ??= { ...flags }
    if (v) out[k] = true
    else delete out[k]
  }
  if (!out) return flags
  return (Object.keys(out).length ? out : undefined) as F | undefined
}

/** The component as the active variant makes it: flags and field values changed, nothing else. The same object when the variant changes nothing on it. */
export function variantComponent(c: ComponentInstance, name: string | undefined): ComponentInstance {
  const o = name === undefined ? undefined : c.variants?.[name]
  if (!o) return c
  const flags = overlayFlags<PartFlags>(c.flags, o)
  let props = c.props
  for (const [field, value] of Object.entries(o.fields ?? {})) {
    const key = field === "Value" ? (findPart(c.partId)?.valueProp ?? "value") : field
    if (props[key] === value) continue
    if (props === c.props) props = { ...c.props }
    props[key] = value
  }
  if (flags === c.flags && props === c.props) return c
  const { flags: _flags, ...rest } = c
  void _flags
  return { ...rest, ...(flags ? { flags } : {}), props }
}

const resolved = new WeakMap<Project, { name: string | undefined; project: Project }>()

/**
 * The project with the active variant applied: the same object when no variant is active or the variant changes no symbol. Cached per project object, so
 * every reader in one render shares one resolved project. A view of one sheet (`scope`) resolves like the project it is a view of.
 */
export function resolveVariant(project: Project): Project {
  const name = activeVariant(project)
  if (name === undefined) return project
  const hit = resolved.get(project)
  if (hit && hit.name === name) return hit.project
  let changed = false
  const components = project.components.map((c) => {
    const next = variantComponent(c, name)
    if (next !== c) changed = true
    return next
  })
  const out = changed ? { ...project, components } : project
  resolved.set(project, { name, project: out })
  return out
}

/** The components as the active variant makes them (the same array when none is active). The board side, the marks and the exports read this. */
export const variantComponents = (project: Project): ComponentInstance[] => resolveVariant(project).components

/** What a sheet symbol's flags are on one use of its parent sheet under the active variant. */
export function variantSheetFlags(sym: Pick<SheetSymbol, "flags" | "variants">, parentUse: string, name: string | undefined): SheetSymbol["flags"] {
  return overlayFlags(sym.flags, name === undefined ? undefined : sym.variants?.[parentUse]?.[name])
}

/**
 * What an export says about the variants: a format with no variants (Circuit JSON, KiCad 9) is written from the symbols as the active variant makes them,
 * and the variants themselves are not in the files. Empty when the project has none.
 */
export function variantExportNotes(project: Pick<Project, "variants">, format: string, o: { sheets?: boolean } = {}): string[] {
  const names = variantNames(project)
  if (!names.length) return []
  const active = activeVariant(project)
  const others = names.length - (active === undefined ? 0 : 1)
  return [
    active === undefined
      ? `${format} has no schematic variants: the symbols are written as they are, with no variant active, and the project's ${names.length} variant${names.length > 1 ? "s are" : " is"} not in the files.`
      : `${format} has no schematic variants: the symbols are written as the active variant "${active}" makes them (its do not populate, BOM, position and board flags and its field values are on the symbols${o.sheets ? "; those it gives a sheet symbol are on the sheet symbol, not on the symbols below it" : ""})${others ? `, and the other ${others} variant${others > 1 ? "s are" : " is"} not in the files` : ""}.`,
  ]
}

// ---------- editing ----------

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })
const clean = (s: string) => s.trim()

/** Adds a variant. A name that is empty or already there is refused (null). */
export function addVariant(project: Project, name: string, description?: string): Project | null {
  const n = clean(name)
  if (!n || variantNames(project).includes(n)) return null
  const list = [...(project.variants?.list ?? []), { name: n, ...(description?.trim() ? { description: description.trim() } : {}) }]
  return touch({ ...project, variants: { ...project.variants, list } })
}

/** Chooses the variant the project follows; `undefined` goes back to the symbols as they are. An unknown name changes nothing. */
export function setActiveVariant(project: Project, name: string | undefined): Project {
  if (name !== undefined && !variantNames(project).includes(name)) return project
  if (project.variants?.active === name) return project
  if (!project.variants) return project
  const { active: _active, ...rest } = project.variants
  void _active
  return touch({ ...project, variants: name === undefined ? rest : { ...rest, active: name } })
}

const mapKeys = <T>(rec: Record<string, T> | undefined, fn: (key: string, value: T) => [string, T] | null): Record<string, T> | undefined => {
  if (!rec) return rec
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(rec)) {
    const kept = fn(k, v)
    if (kept) out[kept[0]] = kept[1]
  }
  return Object.keys(out).length ? out : undefined
}

/** Everything keyed by a variant's name, rewritten by `fn` (a name to its new name, or null to drop it). Components and sheet symbols that have nothing left lose the field. */
function rekey(project: Project, fn: (name: string) => string | null): Project {
  const components = project.components.map((c) => {
    if (!c.variants) return c
    const variants = mapKeys(c.variants, (k, v) => {
      const to = fn(k)
      return to === null ? null : [to, v]
    })
    const { variants: _v, ...rest } = c
    void _v
    return variants ? { ...rest, variants } : rest
  })
  const sheetSymbols = project.sheetSymbols?.map((s) => {
    if (!s.variants) return s
    const byUse = mapKeys(s.variants, (use, perName) => {
      const inner = mapKeys(perName, (k, v) => {
        const to = fn(k)
        return to === null ? null : [to, v]
      })
      return inner ? [use, inner] : null
    })
    const { variants: _v, ...rest } = s
    void _v
    return byUse ? { ...rest, variants: byUse } : rest
  })
  return { ...project, components, ...(sheetSymbols ? { sheetSymbols } : {}) }
}

/** Renames a variant everywhere it is named. A new name that is empty or taken is refused (null). */
export function renameVariant(project: Project, from: string, to: string): Project | null {
  const n = clean(to)
  const names = variantNames(project)
  if (!names.includes(from) || !n) return null
  if (n === from) return project
  if (names.includes(n)) return null
  const v = project.variants!
  const list = v.list.map((x) => (x.name === from ? { ...x, name: n } : x))
  const next = rekey(project, (k) => (k === from ? n : k))
  return touch({ ...next, variants: { ...v, list, ...(v.active === from ? { active: n } : {}) } })
}

/** Removes a variant and everything it changed. */
export function removeVariant(project: Project, name: string): Project {
  if (!variantNames(project).includes(name)) return project
  const v = project.variants!
  const list = v.list.filter((x) => x.name !== name)
  const next = rekey(project, (k) => (k === name ? null : k))
  const { active, ...rest } = v
  const keep = active !== undefined && active !== name ? { active } : {}
  return touch({ ...next, ...(list.length ? { variants: { ...rest, list, ...keep } } : { variants: undefined }) })
}

/** An override with nothing in it says nothing: it is not kept. */
export function isEmptyOverride(o: VariantOverride | undefined): boolean {
  return !o || (FLAG_KEYS.every((k) => o[k] === undefined) && (!o.fields || Object.keys(o.fields).length === 0))
}

/**
 * Sets what a variant changes on a symbol. `patch` keys are merged into what is there; a flag set to `null` and a field set to `null` go back to the symbol's
 * own. A variant the project does not list is added. An override left empty is removed.
 */
export function setVariantOverride(
  project: Project,
  componentId: string,
  variant: string,
  patch: { [K in VariantFlag]?: boolean | null } & { fields?: Record<string, string | null> },
): Project {
  const n = clean(variant)
  if (!n) return project
  const c = project.components.find((x) => x.id === componentId)
  if (!c) return project
  const cur: VariantOverride = { ...(c.variants?.[n] ?? {}) }
  for (const k of FLAG_KEYS) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (v === null || v === undefined) delete cur[k]
    else cur[k] = v
  }
  if (patch.fields) {
    const fields = { ...(cur.fields ?? {}) }
    for (const [f, v] of Object.entries(patch.fields)) {
      if (v === null) delete fields[f]
      else fields[f] = v
    }
    if (Object.keys(fields).length) cur.fields = fields
    else delete cur.fields
  }
  const variants = { ...(c.variants ?? {}) }
  if (isEmptyOverride(cur)) delete variants[n]
  else variants[n] = cur
  const { variants: _old, ...rest } = c
  void _old
  const next: ComponentInstance = Object.keys(variants).length ? { ...rest, variants } : rest
  let out: Project = { ...project, components: project.components.map((x) => (x === c ? next : x)) }
  if (!isEmptyOverride(cur) && !variantNames(out).includes(n)) out = { ...out, variants: { ...out.variants, list: [...(out.variants?.list ?? []), { name: n }] } as ProjectVariants }
  return touch(out)
}

// ---------- reading a stored project ----------

const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined)

/** A variant's changes as stored: only flags that are booleans and fields that are text; anything else is dropped. */
export function normalizeOverride(raw: unknown): VariantOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: VariantOverride = {}
  for (const k of FLAG_KEYS) {
    const v = bool(r[k])
    if (v !== undefined) out[k] = v
  }
  if (r.fields && typeof r.fields === "object" && !Array.isArray(r.fields)) {
    const fields = Object.fromEntries(Object.entries(r.fields as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
    if (Object.keys(fields).length) out.fields = fields
  }
  return isEmptyOverride(out) ? null : out
}

/** The per-variant changes of a symbol as stored. */
export function normalizeOverrides(raw: unknown): Record<string, VariantOverride> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, VariantOverride> = {}
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const o = normalizeOverride(v)
    if (name.trim() && o) out[name] = o
  }
  return Object.keys(out).length ? out : undefined
}

/** The per-use, per-variant changes of a sheet symbol as stored. */
export function normalizeSheetOverrides(raw: unknown): Record<string, Record<string, VariantOverride>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, Record<string, VariantOverride>> = {}
  for (const [use, perName] of Object.entries(raw as Record<string, unknown>)) {
    const inner = normalizeOverrides(perName)
    if (inner) out[use] = inner
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The project's variant list as stored: unique names, with a name that only a symbol mentions added at the end, so no symbol keeps a change under a variant
 * the project does not list. The active name is kept only when it is listed.
 */
export function normalizeProjectVariants(raw: unknown, components: readonly ComponentInstance[], sheetSymbols: readonly SheetSymbol[] | undefined): ProjectVariants | undefined {
  const list: ProjectVariants["list"] = []
  const seen = new Set<string>()
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  if (Array.isArray(r.list)) {
    for (const v of r.list) {
      if (!v || typeof v !== "object") continue
      const name = (v as { name?: unknown }).name
      const description = (v as { description?: unknown }).description
      if (typeof name !== "string" || !name.trim() || seen.has(name)) continue
      seen.add(name)
      list.push({ name, ...(typeof description === "string" && description ? { description } : {}) })
    }
  }
  const mention = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    list.push({ name })
  }
  for (const c of components) for (const k of Object.keys(c.variants ?? {})) mention(k)
  for (const s of sheetSymbols ?? []) for (const perName of Object.values(s.variants ?? {})) for (const k of Object.keys(perName)) mention(k)
  if (!list.length) return undefined
  const active = typeof r.active === "string" && seen.has(r.active) ? r.active : undefined
  return { list, ...(active !== undefined ? { active } : {}) }
}
