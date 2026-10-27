import { round } from "../lib/geometry"
import { ROOT_SHEET, copyKey, sheetsOf, sheetUses, symbolsOnSheet, useAt, useOf, usesOfSheet, type SheetUse } from "../model/sheets"
import { activeVariant, variantSheetFlags } from "../model/variants"
import { colorNode } from "./kicadSheet"
import type { ExtraUnit } from "./circuitJson"
import type { ComponentInstance, FieldPlace, Project, SheetPin, SheetSymbol, TextLook, Vec2 } from "../model/types"

// S1 in the KiCad files: a project with sheets is written as a root schematic, a file for each other sheet (drawn once, whatever the
// number of its uses), a `(sheet ...)` on the sheet each symbol is drawn on, the pages, and for every symbol the reference it has in
// each use of its sheet (`(instances (project ...) (path "/<root>/<sheet symbol>" (reference ...)))`). The converter writes a sheet
// as one schematic with its symbols' instance data on the sheet's own id; `retarget` and `spreadInstances` put the hierarchy into
// what it wrote.

const MM = 12.7
const mm6 = (n: number) => String(round(n, 6) || 0)
const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`
/** KiCad escapes the characters a net name cannot hold: a `/` is `{slash}`. */
export const escapeNetName = (text: string) => text.replace(/\//g, "{slash}")

/** A uuid made from a text, the same every time: the ids of a project's sheets are short, KiCad's are uuids. */
export function uuidFrom(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  let c = 0x9747b28c
  let d = 0x85ebca6b
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    a = Math.imul(a ^ k, 0x01000193) >>> 0
    b = Math.imul(b ^ (k + i), 0x85ebca6b) >>> 0
    c = Math.imul(c ^ (k << 1), 0xc2b2ae35) >>> 0
    d = Math.imul(d + k, 0x27d4eb2f) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0")
  const h = hex(a) + hex(b) + hex(c) + hex(d)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** The uuid of the file a sheet is: the root's is the one the project came with, else made from the sheet's id. */
export const sheetUuid = (project: Project, sheet: string) => sheetsOf(project).find((s) => s.id === sheet)?.uuid ?? uuidFrom(`sheet:${project.id}:${sheet}`)
export const symbolUuid = (sym: SheetSymbol) => sym.uuid ?? uuidFrom(`sheet-symbol:${sym.id}`)

/** KiCad's instance path of a use: the root's uuid, then the uuid of each sheet symbol down to it. */
export function instancePath(project: Project, use: SheetUse): string {
  const chain: string[] = []
  let at: SheetUse | undefined = use
  const all = sheetUses(project)
  while (at && at.symbol) {
    chain.unshift(symbolUuid(at.symbol))
    at = all.find((u) => u.path === at!.parent)
  }
  return `/${[sheetUuid(project, ROOT_SHEET), ...chain].join("/")}`
}

/** A sub-sheet's own title block, from the entries it was read with (the root's is the project's, `titleBlock` in `kicadPost.ts`). */
export function sheetTitleBlock(project: Project, sheet: string): { title: string; date?: string; revision?: string; company?: string; comments: { index: number; text: string }[] } | null {
  const entries = sheetsOf(project).find((s) => s.id === sheet)?.titleBlock
  if (!entries?.length) return null
  const get = (key: string) => entries.find((e) => e.key === key)?.value
  const comments = entries.flatMap((e) => {
    const m = /^Comment(\d+)$/.exec(e.key)
    return m ? [{ index: Number(m[1]), text: e.value }] : []
  })
  return { title: get("Title") ?? "", ...(get("Date") ? { date: get("Date") } : {}), ...(get("Rev") ? { revision: get("Rev") } : {}), ...(get("Company") ? { company: get("Company") } : {}), comments }
}

/** The file name of each sheet: the root's is the project's, the others are named after the sheet (its first symbol's name); each is its own. */
export function sheetFileNames(project: Project, base: string): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>([`${base}.kicad_sch`.toLowerCase()])
  out.set(ROOT_SHEET, `${base}.kicad_sch`)
  for (const s of sheetsOf(project)) {
    if (s.id === ROOT_SHEET) continue
    const sym = (project.sheetSymbols ?? []).find((x) => x.child === s.id)
    const stem = (sym?.name.trim() || s.id).replace(/[\\/:*?"<>|]/g, "_")
    let name = `${stem}.kicad_sch`
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem}_${i}.kicad_sch`
    taken.add(name.toLowerCase())
    out.set(s.id, name)
  }
  return out
}

function effects(look: TextLook | undefined, place?: FieldPlace): string {
  const size = round((look?.size ?? place?.size ?? 0.1) * MM, 4)
  const font = [`(size ${mm6(size)} ${mm6(size)})`]
  const thickness = look?.thickness ?? place?.thickness
  if (thickness) font.push(`(thickness ${mm6(thickness * MM)})`)
  if (look?.bold ?? place?.bold) font.push("bold")
  if (look?.italic ?? place?.italic) font.push("italic")
  const color = look?.color ?? place?.color
  if (color) font.push(colorNode(color))
  const parts = [`(font ${font.join(" ")})`]
  const words = [look?.h ?? place?.h, look?.v ?? place?.v, look?.mirror ? "mirror" : undefined].filter(Boolean)
  if (words.length) parts.push(`(justify ${words.join(" ")})`)
  if (look?.href) parts.push(`(href ${quote(look.href)})`)
  if (look?.hidden || place?.hidden) parts.push("(hide yes)")
  return `(effects ${parts.join(" ")})`
}

const yn = (b: boolean) => (b ? "yes" : "no")

/** The flags a sheet symbol's node says: the active variant's on the first use of its parent sheet (KiCad 9), or its own, with the variants beside it (KiCad 10). */
export function sheetFlagsWritten(project: Project, sym: SheetSymbol, variants: "keep" | "apply"): SheetSymbol["flags"] {
  const flags = variants === "keep" ? sym.flags : variantSheetFlags(sym, usesOfSheet(project, sym.sheet)[0]?.path ?? "", activeVariant(project))
  return flags && Object.keys(flags).length ? flags : undefined
}

const FLAG_WORDS = [["dnp", "do not populate"], ["excludeFromBom", "out of the BOM"], ["notOnBoard", "not on the board"], ["excludeFromSim", "out of simulation"]] as const
const flagWords = (f: SheetSymbol["flags"] | ComponentInstance["flags"]) => FLAG_WORDS.filter(([k]) => f?.[k]).map(([, w]) => w)
const MOST_NOTES = 20

/**
 * What a sheet used more than once cannot say in KiCad 9: its symbols are one file, so a symbol has one set of flags and one value for every use, and the sheet
 * symbols drawn on it one set of flags for every use of the sheet they are on. The file says what the first use has; where another use differs (a variant that
 * changes one use's symbol, a rule area that covers a symbol on one use only) this names each part and use and what was written. A sheet symbol's flags are on
 * its node in the parent's file and never on the symbols below it, so they are not a difference between the symbols' uses. `symbolFlags` are the symbols as their
 * files say them (`ownFlagComponents`).
 */
export function sharedSheetNotes(project: Project, symbolFlags: ReadonlyMap<string, ComponentInstance>, variants: "keep" | "apply", files: Map<string, string>): string[] {
  const found: string[] = []
  const variant = activeVariant(project)
  const sheets = new Set(sheetUses(project).filter((u) => u.symbol).map((u) => u.sheet))
  const human = (path: string) => useAt(project, path).human
  for (const sheet of sheets) {
    const list = usesOfSheet(project, sheet)
    if (list.length < 2) continue
    const first = list[0]
    const file = files.get(sheet) ?? sheet
    const groups = new Map<string, ComponentInstance[]>()
    for (const c of project.components) if (list.some((u) => u.path === useOf(c))) (groups.get(copyKey(c)) ?? groups.set(copyKey(c), []).get(copyKey(c))!).push(c)
    for (const group of groups.values()) {
      const base = group.find((c) => useOf(c) === first.path)
      if (!base) continue
      const was = symbolFlags.get(base.id) ?? base
      for (const c of group) {
        if (c === base) continue
        const now = symbolFlags.get(c.id) ?? c
        const props = [...new Set([...Object.keys(now.props), ...Object.keys(was.props)])].filter((k) => now.props[k] !== was.props[k])
        const flags = flagWords(now.flags).join(",") !== flagWords(was.flags).join(",")
        if (!flags && !props.length) continue
        const say = (x: ComponentInstance) => [...flagWords(x.flags), ...props.map((k) => `${k} ${x.props[k] ?? "unset"}`)].join(", ") || "no flag"
        found.push(`${c.ref} on ${human(c.inst ?? "")} has ${say(now)}, but KiCad 9 keeps a sheet used more than once in one file (${file}) with no flags of its own for each use: it says what ${base.ref} on ${human(first.path)} has, ${say(was)}.`)
      }
    }
    if (variants === "keep") continue
    for (const sym of symbolsOnSheet(project, sheet)) {
      const was = variantSheetFlags(sym, first.path, variant)
      for (const u of list.slice(1)) {
        const now = variantSheetFlags(sym, u.path, variant)
        if (flagWords(now).join(",") === flagWords(was).join(",")) continue
        found.push(`The sheet symbol ${sym.name} is ${flagWords(now).join(", ") || "not flagged"} on ${human(u.path)} but ${flagWords(was).join(", ") || "not flagged"} on ${human(first.path)}: it is one node in ${file}, written as ${human(first.path)} has it.`)
      }
    }
  }
  return found.length > MOST_NOTES ? [...found.slice(0, MOST_NOTES), `${found.length - MOST_NOTES} more parts and sheet symbols differ between the uses of a sheet.`] : found
}

/** A sheet symbol as KiCad 9 writes it, with a pin for each of its pins and the page of each use of its parent. */
export function sheetSymbolNode(project: Project, sym: SheetSymbol, toPage: (p: Vec2) => Vec2, files: Map<string, string>, variants: "keep" | "apply" = "apply"): string {
  const top = toPage({ x: sym.x, y: sym.y + sym.h })
  const origin = toPage({ x: sym.x, y: sym.y })
  // S9: KiCad 9 has no variants, so a sheet symbol's flags are the active variant's on its first use; a project written as KiCad 10 files keeps the variants in each use.
  const flags = sheetFlagsWritten(project, sym, variants) ?? {}
  const stroke = sym.stroke
  const out: string[] = ["  (sheet", `    (at ${mm6(top.x)} ${mm6(top.y)})`, `    (size ${mm6(sym.w * MM)} ${mm6(sym.h * MM)})`]
  out.push(`    (exclude_from_sim ${yn(!!flags.excludeFromSim)})`, `    (in_bom ${yn(!flags.excludeFromBom)})`, `    (on_board ${yn(!flags.notOnBoard)})`, `    (dnp ${yn(!!flags.dnp)})`)
  if (sym.fieldsAutoplaced) out.push("    (fields_autoplaced yes)")
  out.push(`    (stroke (width ${mm6((stroke?.width ?? 0.012) * MM)}) (type ${stroke?.dash ?? "solid"})${stroke?.color ? ` ${colorNode(stroke.color)}` : ""})`)
  out.push(`    ${sym.fill ? (sym.fill.kind === "color" ? `(fill ${colorNode(sym.fill.color ?? "#000000")})` : `(fill (type ${sym.fill.kind}))`) : "(fill (color 0 0 0 0.0000))"}`)
  out.push(`    (uuid ${symbolUuid(sym)})`)
  const fields = sym.fields?.length ? sym.fields : [{ name: "Sheetname", value: sym.name, place: { x: 0, y: sym.h + 0.05, angle: 0 as const, h: "left" as const, v: "bottom" as const } }, { name: "Sheetfile", value: "", place: { x: 0, y: -0.05, angle: 0 as const, h: "left" as const, v: "top" as const } }]
  for (const f of fields) {
    const value = f.name === "Sheetname" ? sym.name : f.name === "Sheetfile" ? (files.get(sym.child) ?? "") : f.value
    const at = toPage({ x: sym.x + f.place.x, y: sym.y + f.place.y })
    void origin
    out.push(`    (property ${quote(f.name)} ${quote(value)}`, `      (at ${mm6(at.x)} ${mm6(at.y)} ${f.place.angle})`, ...(f.place.showName ? ["      (show_name yes)"] : []), ...(f.place.noAutoplace ? ["      (do_not_autoplace yes)"] : []), `      ${effects(undefined, f.place)}`, "    )")
  }
  for (const p of sym.pins) out.push(pinNode(p, toPage))
  const parents = usesOfSheet(project, sym.sheet)
  const uses = sheetUses(project)
  const entries = parents.map((u) => {
    const child = uses.find((x) => x.path === `${u.path}/${sym.id}`)
    const own = variants === "keep" ? Object.entries(sym.variants?.[u.path] ?? {}).map(([name, o]) => `\n          ${variantNode(name, o)}`).join("") : ""
    return `        (path ${quote(instancePath(project, u))}\n          (page ${quote(child?.page ?? "1")})${own})`
  })
  out.push("    (instances", '      (project ""', ...entries, "      )", "    )", "  )")
  return out.join("\n")
}

function pinNode(p: SheetPin, toPage: (p: Vec2) => Vec2): string {
  const at = toPage(p)
  return [`    (pin ${quote(escapeNetName(p.name))} ${p.shape}`, `      (at ${mm6(at.x)} ${mm6(at.y)} ${p.rot})`, `      (uuid ${p.uuid ?? uuidFrom(`sheet-pin:${p.id}:${p.name}`)})`, `      ${effects(p.look)}`, "    )"].join("\n")
}

/** The sheet's file with its own id (the converter writes a new one) and the sheet symbols drawn on it. */
export function retarget(text: string, uuid: string, symbols: string[], page?: string): string {
  let out = text.replace(/\(uuid [0-9a-f-]+\)/, `(uuid ${uuid})`)
  if (page && page !== "1") out = out.replace(/(\(sheet_instances\s*\(path "\/"\s*\(page )"1"/, `$1${quote(page)}`)
  if (symbols.length) {
    const at = out.indexOf("\n  (sheet_instances")
    out = at < 0 ? out : `${out.slice(0, at)}\n${symbols.join("\n")}${out.slice(at)}`
  }
  return out
}

/**
 * Every symbol's instance data for each use of the sheet: the converter wrote the first use's reference on the file's own id, and
 * each later use has its own reference (the symbol's copy in that use) and unit. Keyed by the first use's reference and unit.
 */
export function spreadInstances(text: string, project: Project, sheet: string, converterUuid: string): string {
  const uses = usesOfSheet(project, sheet)
  if (uses.length < 1) return text
  const first = uses[0]
  const byKey = new Map<string, ComponentInstance[]>()
  for (const c of project.components) {
    const u = c.inst ?? ""
    if (!uses.some((x) => x.path === u)) continue
    const k = copyKey(c)
    ;(byKey.get(k) ?? byKey.set(k, []).get(k)!).push(c)
  }
  const byRef = new Map<string, ComponentInstance[]>()
  for (const group of byKey.values()) {
    const base = group.find((c) => (c.inst ?? "") === first.path)
    if (base) byRef.set(`${base.ref}\u0000${base.unit ?? 1}`, group)
  }
  const paths = new Map(uses.map((u) => [u.path, instancePath(project, u)]))
  return text.replace(/\n {4}\(instances\n {6}\(project ""\n {8}\(path "\/[0-9a-f-]+"\n {10}\(reference "([^"]*)"\)\n {10}\(unit (\d+)\)\n {8}\)\n {6}\)\n {4}\)/g, (whole, ref: string, unit: string) => {
    const group = byRef.get(`${ref}\u0000${unit}`) ?? byRef.get(`${ref}\u00001`)
    const rows = (group ?? []).map((c) => `        (path ${quote(paths.get(c.inst ?? "") ?? `/${converterUuid}`)}\n          (reference ${quote(c.ref)})\n          (unit ${c.unit ?? 1})\n        )`)
    if (!rows.length) return whole
    return `\n    (instances\n      (project ""\n${rows.join("\n")}\n      )\n    )`
  })
}

/**
 * The units a use of the sheet takes of a symbol that the first use takes as another unit (a symbol is drawn once in the file, and each use says which unit of its
 * part it is: an op-amp's A in one use and its B in the other). The file's library symbol must have each of them, so each is returned, drawn where the first use's
 * symbol is, with the component of the first use it goes with.
 */
export function unitsOfOtherUses(project: Project, sheet: string): ExtraUnit[] {
  const uses = usesOfSheet(project, sheet)
  if (uses.length < 2) return []
  const first = uses[0].path
  const byKey = new Map<string, ComponentInstance[]>()
  for (const c of project.components) {
    if (!uses.some((u) => u.path === (c.inst ?? ""))) continue
    ;(byKey.get(copyKey(c)) ?? byKey.set(copyKey(c), []).get(copyKey(c))!).push(c)
  }
  const out: ExtraUnit[] = []
  for (const group of byKey.values()) {
    const base = group.find((c) => (c.inst ?? "") === first)
    if (!base) continue
    const seen = new Set([base.unit ?? 1])
    for (const c of group) {
      const unit = c.unit ?? 1
      if ((c.inst ?? "") === first || seen.has(unit)) continue
      seen.add(unit)
      out.push({ base: base.id, unit: { ...c, id: `${base.id}@unit${unit}`, inst: base.inst, sch: base.sch, ref: base.ref } })
    }
  }
  return out
}

/** What is written for a sheet: its symbols, which are the ones drawn on it. */
export const symbolsOf = (project: Project, sheet: string) => symbolsOnSheet(project, sheet)


/** The version stamp of a KiCad 10 file that keeps schematic variants: from it `in_bom` in a variant is the positive logic KiCad writes (`sch_io_kicad_sexpr_parser.cpp`, 10.0: `m_requiredVersion >= 20260306`). */
export const VARIANT_FILE_VERSION = 20260306

/** One variant of one symbol as KiCad 10 writes it (`sch_io_kicad_sexpr.cpp`, 10.0): only what differs from the symbol's own, then its field values. */
export function variantNode(name: string, o: NonNullable<ComponentInstance["variants"]>[string]): string {
  const parts = [`(name ${quote(name)})`]
  if (o.dnp !== undefined) parts.push(`(dnp ${yn(o.dnp)})`)
  if (o.excludeFromSim !== undefined) parts.push(`(exclude_from_sim ${yn(o.excludeFromSim)})`)
  if (o.excludeFromBom !== undefined) parts.push(`(in_bom ${yn(!o.excludeFromBom)})`)
  if (o.notOnBoard !== undefined) parts.push(`(on_board ${yn(!o.notOnBoard)})`)
  if (o.excludeFromPos !== undefined) parts.push(`(in_pos_files ${yn(!o.excludeFromPos)})`)
  for (const [field, value] of Object.entries(o.fields ?? {})) parts.push(`(field (name ${quote(field)}) (value ${quote(value)}))`)
  return `(variant ${parts.join(" ")})`
}

/**
 * The variants of the symbols of one sheet file, written into each symbol's instance data, and the file stamped so KiCad 10 reads them as they are.
 * `sheet` is the sheet's id in a hierarchical project (each use has its own instance path) and null for a project of one sheet.
 */
export function writeVariants(text: string, project: Project, sheet: string | null): string {
  const byKey = new Map<string, ComponentInstance>()
  if (sheet === null) {
    for (const c of project.components) if (c.variants) byKey.set(`${c.ref}|${c.unit ?? 1}`, c)
  } else {
    for (const u of usesOfSheet(project, sheet)) {
      const path = instancePath(project, u)
      for (const c of project.components) if (c.variants && (c.inst ?? "") === u.path) byKey.set(`${path}|${c.ref}|${c.unit ?? 1}`, c)
    }
  }
  const out = text.replace(/\(path "([^"]*)"(\s*)\(reference "([^"]*)"\)(\s*)\(unit (\d+)\)/g, (whole, path: string, _a: string, ref: string, _b: string, unit: string) => {
    const c = byKey.get(sheet === null ? `${ref}|${unit}` : `${path}|${ref}|${unit}`)
    if (!c?.variants) return whole
    return `${whole}${Object.entries(c.variants).map(([name, o]) => `
          ${variantNode(name, o)}`).join("")}`
  })
  return out.replace(/^(\(kicad_sch\s+\(version )(\d+)\)/, (_w, head: string, v: string) => `${head}${Math.max(Number(v), VARIANT_FILE_VERSION)})`)
}
