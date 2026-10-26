import { round } from "../lib/geometry"
import { ROOT_SHEET, copyKey, sheetsOf, sheetUses, symbolsOnSheet, usesOfSheet, type SheetUse } from "../model/sheets"
import { colorNode } from "./kicadSheet"
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

/** The file name of each sheet: the root's is the project's, the others keep the name they had, or are named after the sheet; each is its own. */
export function sheetFileNames(project: Project, base: string): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>([`${base}.kicad_sch`.toLowerCase()])
  out.set(ROOT_SHEET, `${base}.kicad_sch`)
  for (const s of sheetsOf(project)) {
    if (s.id === ROOT_SHEET) continue
    const sym = (project.sheetSymbols ?? []).find((x) => x.child === s.id)
    const wanted = (s.file || sym?.file || sym?.name || s.id).replace(/[\\/:*?"<>|]/g, "_")
    const stem = wanted.replace(/\.kicad_sch$/i, "") || s.id
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

/** A sheet symbol as KiCad 9 writes it, with a pin for each of its pins and the page of each use of its parent. */
export function sheetSymbolNode(project: Project, sym: SheetSymbol, toPage: (p: Vec2) => Vec2, files: Map<string, string>): string {
  const top = toPage({ x: sym.x, y: sym.y + sym.h })
  const origin = toPage({ x: sym.x, y: sym.y })
  const flags = sym.flags ?? {}
  const stroke = sym.stroke
  const out: string[] = ["  (sheet", `    (at ${mm6(top.x)} ${mm6(top.y)})`, `    (size ${mm6(sym.w * MM)} ${mm6(sym.h * MM)})`]
  out.push(`    (exclude_from_sim ${yn(!!flags.excludeFromSim)})`, `    (in_bom ${yn(!flags.excludeFromBom)})`, `    (on_board ${yn(!flags.notOnBoard)})`, `    (dnp ${yn(!!flags.dnp)})`)
  if (sym.fieldsAutoplaced) out.push("    (fields_autoplaced yes)")
  out.push(`    (stroke (width ${mm6((stroke?.width ?? 0.012) * MM)}) (type ${stroke?.dash ?? "solid"})${stroke?.color ? ` ${colorNode(stroke.color)}` : ""})`)
  out.push(`    ${sym.fill ? (sym.fill.kind === "color" ? `(fill ${colorNode(sym.fill.color ?? "#000000")})` : `(fill (type ${sym.fill.kind}))`) : "(fill (color 0 0 0 0.0000))"}`)
  out.push(`    (uuid ${symbolUuid(sym)})`)
  const fields = sym.fields?.length ? sym.fields : [{ name: "Sheetname", value: sym.name, place: { x: 0, y: sym.h + 0.05, angle: 0 as const, h: "left" as const, v: "bottom" as const } }, { name: "Sheetfile", value: sym.file, place: { x: 0, y: -0.05, angle: 0 as const, h: "left" as const, v: "top" as const } }]
  for (const f of fields) {
    const value = f.name === "Sheetname" ? sym.name : f.name === "Sheetfile" ? (files.get(sym.child) ?? sym.file) : f.value
    const at = toPage({ x: sym.x + f.place.x, y: sym.y + f.place.y })
    void origin
    out.push(`    (property ${quote(f.name)} ${quote(value)}`, `      (at ${mm6(at.x)} ${mm6(at.y)} ${f.place.angle})`, ...(f.place.showName ? ["      (show_name yes)"] : []), ...(f.place.noAutoplace ? ["      (do_not_autoplace yes)"] : []), `      ${effects(undefined, f.place)}`, "    )")
  }
  for (const p of sym.pins) out.push(pinNode(p, toPage))
  const parents = usesOfSheet(project, sym.sheet)
  const uses = sheetUses(project)
  const entries = parents.map((u) => {
    const child = uses.find((x) => x.path === `${u.path}/${sym.id}`)
    return `        (path ${quote(instancePath(project, u))}\n          (page ${quote(child?.page ?? "1")}))`
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
    const rows = (group ?? []).map((c) => `        (path ${quote(paths.get(c.inst ?? "") ?? `/${converterUuid}`)}\n          (reference ${quote(c.ref)})\n          (unit ${c.unit ?? Number(unit)})\n        )`)
    if (!rows.length) return whole
    return `\n    (instances\n      (project ""\n${rows.join("\n")}\n      )\n    )`
  })
}

/** What is written for a sheet: its symbols, which are the ones drawn on it. */
export const symbolsOf = (project: Project, sheet: string) => symbolsOnSheet(project, sheet)
