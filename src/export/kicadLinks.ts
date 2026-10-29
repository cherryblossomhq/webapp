// The board's footprints linked to the schematic's symbols as KiCad links them: each footprint's `path` is the path of its symbol (the sheet symbols above it, then its own
// uuid) and `sheetfile` the file of the sheet it is on. "Update PCB from Schematic" finds a footprint by that path; without it KiCad takes every footprint of the board for one
// that has no symbol and adds the symbols' own again. The files are written as text, so the links are put into the board's text from the schematic's.

/** A placed symbol of a schematic file, at the file's own indent. */
const SYMBOL_BLOCK = /\n {2}\(symbol\n {4}\(lib_id [^\n]*\n[\s\S]*?\n {2}\)(?=\n)/g
const FOOTPRINT_BLOCK = /\n {2}\(footprint [\s\S]*?\n {2}\)(?=\n)/g
const unescape = (text: string) => text.replace(/\\(.)/g, "$1")

export interface SheetText {
  /** The sheet's file name, as the `sheetfile` of a footprint on it says. */
  file: string
  text: string
}

/** The reference each symbol has, by use of its sheet, to the path KiCad gives its footprint. The first unit of a part with several is the one a footprint is linked to. */
export function symbolLinks(sheets: SheetText[]): Map<string, { path: string; file: string; unit: number }> {
  const links = new Map<string, { path: string; file: string; unit: number }>()
  for (const { file, text } of sheets) {
    for (const block of text.match(SYMBOL_BLOCK) ?? []) {
      const uuid = block.match(/\n {4}\(uuid ([0-9a-f-]+)\)/)?.[1]
      if (!uuid) continue
      for (const m of block.matchAll(/\(path "(\/[^"]*)"\s*\(reference "((?:[^"\\]|\\.)*)"\)\s*\(unit (\d+)\)/g)) {
        // The root's own uuid is the first word of an instance path; a footprint's path starts below it.
        const path = `${m[1].replace(/^\/[0-9a-f-]+/, "")}/${uuid}`
        const ref = unescape(m[2])
        const unit = Number(m[3])
        const had = links.get(ref)
        if (!had || unit < had.unit) links.set(ref, { path, file, unit })
      }
    }
  }
  return links
}

/** The board's text with each footprint that has a symbol given its `path` and its `sheetfile`. */
export function applyFootprintLinks(pcb: string, sheets: SheetText[], withSheetfile: (reference: string) => boolean = () => true): string {
  const links = symbolLinks(sheets)
  if (!links.size) return pcb
  return pcb.replace(FOOTPRINT_BLOCK, (block) => {
    const ref = block.match(/\n {4}\(property "Reference" "((?:[^"\\]|\\.)*)"/)?.[1]
    const link = ref === undefined ? undefined : links.get(unescape(ref))
    if (!link || /\n {2}\(path "/.test(block)) return block
    const lines = [`  (path ${JSON.stringify(link.path)})`]
    if (!/\n {2}\(sheetfile /.test(block) && withSheetfile(unescape(ref!))) lines.push(`  (sheetfile ${JSON.stringify(link.file)})`)
    // after the footprint's name, place, texts and drawings and before its attributes and pads: KiCad reads these in any order
    const at = block.search(/\n {2}\((?:attr|net_tie_pad_groups|pad|embedded_files|model)\b/)
    const cut = at === -1 ? block.lastIndexOf("\n  )") : at
    return `${block.slice(0, cut)}\n${lines.join("\n")}${block.slice(cut)}`
  })
}

/**
 * The uuid of each placed symbol, which a footprint's `path` ends with. The converter makes each at random; a symbol that came from KiCad has the uuid it had (so the board and the schematic stay linked
 * as they were), and any other has one made from the part's id, so the same project writes the same files.
 */
export function applySymbolUuids(sch: string, uuidOf: (reference: string, unit: number) => string | undefined): string {
  return sch.replace(SYMBOL_BLOCK, (block) => {
    const ref = block.match(/\n {4}\(property "Reference" "((?:[^"\\]|\\.)*)"/)?.[1]
    const unit = Number(block.match(/\n {4}\(unit (\d+)\)/)?.[1] ?? 1)
    const uuid = ref === undefined ? undefined : uuidOf(unescape(ref), unit)
    return uuid ? block.replace(/(\n {4}\(uuid )[0-9a-fA-F-]+\)/, (_m, head: string) => `${head}${uuid})`) : block
  })
}
