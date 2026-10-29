import { expandPinNumber } from "../model/pinNumbers"
import type { SymbolDrawing } from "../model/types"

// A symbol that came from a KiCad schematic keeps the library name it had (`Device:C`) and what its library entry said of itself (the reference prefix, the value,
// the footprint and datasheet it gave a new symbol, its description, `ki_keywords` and `ki_fp_filters`). The converter writes one library symbol per placed symbol under a name
// of its own (`Device:U_chip_schematic_component_12`) with its own words for those fields, so each placed symbol is renamed and the library symbols that come out the same are one.

const SYMBOL_BLOCK = /\n {2}\(symbol\n {4}\(lib_id "((?:[^"\\]|\\.)*)"\)[^\n]*\n[\s\S]*?\n {2}\)(?=\n)/g
const LIB_SYMBOL = /\n {4}\(symbol "([^"]+)"\n[\s\S]*?\n {4}\)(?=\n)/g
const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const shortName = (id: string) => id.slice(id.indexOf(":") + 1)

/** A property of a library symbol with the value given; added, hidden, when the symbol has none of that name. */
function setProperty(block: string, name: string, value: string): string {
  const re = new RegExp(`(\\n {6}\\(property ${escapeRe(quote(name))} )"(?:[^"\\\\]|\\\\.)*"`)
  if (re.test(block)) return block.replace(re, (_m, head: string) => `${head}${quote(value)}`)
  const ids = [...block.matchAll(/\n {8}\(id (\d+)\)/g)].map((m) => Number(m[1]))
  const id = (ids.length ? Math.max(...ids) : 4) + 1
  const added = [`      (property ${quote(name)} ${quote(value)}`, `        (id ${id})`, "        (at 0 0 0)", "        (effects", "          (font", "            (size 1.27 1.27)", "          )", "          (hide yes)", "        )", "      )"].join("\n")
  const firstSub = block.search(/\n {6}\(symbol "/)
  const at = firstSub === -1 ? block.lastIndexOf("\n    )") : firstSub
  return `${block.slice(0, at)}\n${added}${block.slice(at)}`
}

/** Each pin named as the library entry named it (`~{RESET}`, not the editor's `RESET#`): KiCad names the net of a lone pin after it, so the name is part of the net's. */
function restorePinNames(block: string, drawing: SymbolDrawing): string {
  const byNumber = new Map<string, string>()
  for (const p of drawing.pins) for (const n of expandPinNumber(p.number)) if (!byNumber.has(n)) byNumber.set(n, p.name)
  return block.replace(/(\(name )"(?:[^"\\]|\\.)*"([\s\S]*?\(number ")((?:[^"\\]|\\.)*)"/g, (all, head: string, mid: string, num: string) => {
    const raw = byNumber.get(num.replace(/\\(.)/g, "$1"))
    return raw === undefined ? all : `${head}${quote(raw)}${mid}${num}"`
  })
}

/** A property of a library symbol taken out. */
function removeProperty(block: string, name: string): string {
  return block.replace(new RegExp(`\\n {6}\\(property ${escapeRe(quote(name))}[\\s\\S]*?\\n {6}\\)(?=\\n)`), "")
}

/** The text with each placed symbol that came from a KiCad schematic given the library name and library fields it had, and library symbols that are the same made one. */
export function applyLibraryIdentity(sch: string, drawingOf: (reference: string) => SymbolDrawing | undefined): string {
  // the library name each placed symbol's current one is to become
  const want = new Map<string, SymbolDrawing>()
  for (const m of sch.matchAll(SYMBOL_BLOCK)) {
    const ref = m[0].match(/\n {4}\(property "Reference" "((?:[^"\\]|\\.)*)"/)?.[1]
    const drawing = ref === undefined ? undefined : drawingOf(ref.replace(/\\(.)/g, "$1"))
    if (drawing && !want.has(m[1])) want.set(m[1], drawing)
  }
  if (!want.size) return sch
  // each library symbol, renamed and given its fields; two that are alike under one name are one
  const made = new Map<string, string>()
  const rename = new Map<string, string>()
  const blocks = new Map<string, string>()
  for (const m of sch.matchAll(LIB_SYMBOL)) blocks.set(m[1], m[0])
  for (const [old, drawing] of want) {
    const block = blocks.get(old)
    if (!block) continue
    const target = drawing.name.includes(":") ? drawing.name : `Library:${drawing.name}`
    const oldShort = shortName(old)
    let text = block
    for (const f of drawing.fields) text = setProperty(text, f.name, f.value)
    for (const k of drawing.ki ?? []) text = setProperty(text, k.name, k.value)
    text = restorePinNames(text, drawing)
    // the converter's own words for what the library entry did not say
    for (const n of ["ki_keywords", "ki_fp_filters"]) if (!drawing.ki?.some((k) => k.name === n)) text = removeProperty(text, n)
    // the name, here and in each unit's own symbol
    const body = (name: string) => text.replace(`(symbol ${quote(old)}`, () => `(symbol ${quote(name)}`).replace(new RegExp(`\\(symbol "${escapeRe(oldShort)}_(\\d+)_(\\d+)"`, "g"), (_x, u: string, s: string) => `(symbol "${shortName(name)}_${u}_${s}"`)
    let name = target
    for (let k = 2; made.has(name) && made.get(name) !== body(name); k++) name = `${target}_${k}`
    made.set(name, body(name))
    rename.set(old, name)
  }
  // the library symbols, in the order they were, each name once
  let out = sch.replace(LIB_SYMBOL, (block, old: string) => {
    const name = rename.get(old)
    if (!name) return block
    const first = [...rename].find(([, n]) => n === name)?.[0]
    return first === old ? `\n${made.get(name)!.replace(/^\n/, "")}` : ""
  })
  for (const [old, name] of rename) out = out.split(`(lib_id ${quote(old)})`).join(`(lib_id ${quote(name)})`)
  return out
}
